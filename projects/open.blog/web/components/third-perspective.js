// Third Perspectives (ADRs 0109 to 0114): the browser and hosted-function half of the contract in
// crates/openblog-core/src/third_perspective.rs. Both read
// tests/fixtures/third-perspective-submissions.json and must agree on every code and record.
//
// A Third Perspective is a reader's own reflection on a published work, about the whole work or
// one section, with an optional prompt category (never a score or a side) and the reader's explicit
// consent: to publish it once a moderator approves it, whether to show their name, and whether they
// may be asked to clarify it. It is offered for publication; a reader who does not agree to publish
// keeps it, and can copy it to send privately instead.
//
// Everything here is a pure function: nothing is fetched, stored or sent, and a failure is a value
// with a code and a message that names the field and never repeats what the reader wrote.

import { normalizePassageText, readTargetSource } from "./passage-target.js";

export const THIRD_PERSPECTIVE_KIND = "third-perspective";
export const THIRD_PERSPECTIVE_LABEL = "Third Perspective";
export const THIRD_PERSPECTIVE_VERSION = 1;
export const MAX_BODY_CHARS = 4000;
export const MAX_READER_NAME_CHARS = 80;
export const MAX_WORK_PATH_CHARS = 500;
export const MAX_JSON_BYTES = 32 * 1024;
export const MAX_DETAILS_BYTES = 16 * 1024;
export const MAX_CONSENT_RECORDS = 50;
export const NARROWING_RESERVE = 3;
const CONSENT_RESERVE_BYTES = (NARROWING_RESERVE + 1) * 256;
// The build's JSON reader refuses documents nested deeper than this.
const MAX_JSON_DEPTH = 127;

/**
 * The optional prompt categories, in the order a form offers them. A category describes what kind
 * of thought a reflection is, never how good it is or which author it sides with.
 */
export const RESPONSE_CATEGORIES = Object.freeze([
  Object.freeze({ id: "another-reading", label: "Another reading", prompt: "How do you read this, in your own way?" }),
  Object.freeze({ id: "connection", label: "A connection", prompt: "What does this bring to mind: another work, idea or source?" }),
  Object.freeze({ id: "experience", label: "From experience", prompt: "What in your own experience speaks to this?" }),
  Object.freeze({ id: "question", label: "A question", prompt: "What question does this leave you with?" }),
  Object.freeze({ id: "application", label: "Putting it to use", prompt: "How might you apply or try this?" }),
]);
const CATEGORY_IDS = new Set(RESPONSE_CATEGORIES.map((category) => category.id));

const WHITE_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITE_SPACE_CHAR = new RegExp(`^[${WHITE_SPACE}]$`, "u");
const TRIM = new RegExp(`^[${WHITE_SPACE}]+|[${WHITE_SPACE}]+$`, "gu");
const isWhiteSpace = (character) => WHITE_SPACE_CHAR.test(character);
const codePoint = (character) => character.codePointAt(0);
const isControl = (character) => codePoint(character) <= 0x1f || (codePoint(character) >= 0x7f && codePoint(character) <= 0x9f);
const isBidiControl = (character) => {
  const point = codePoint(character);
  return (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
};
export const utf8Length = (text) => new TextEncoder().encode(text).length;
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isLoneSurrogate = (character) => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff;
export const hasLoneSurrogate = (value) => {
  if (typeof value === "string") return Array.from(value).some(isLoneSurrogate);
  if (value && typeof value === "object") return Object.entries(value).some(([key, inner]) => hasLoneSurrogate(key) || hasLoneSurrogate(inner));
  return false;
};

const failure = (code, message) => ({ ok: false, error: { code, message } });
const malformed = (message) => failure("malformed", message);

/**
 * The raw source of each top-level value of valid JSON text (the last one wins for a repeated key,
 * as in JSON.parse), the deepest nesting, and whether a number is too large to hold.
 */
export function scan(text) {
  const spans = new Map();
  let depth = 0;
  let deepest = 0;
  let expectKey = false;
  let key = null;
  let valueStart = -1;
  let overflow = false;
  const close = (end) => {
    if (key !== null && valueStart >= 0) spans.set(key, text.slice(valueStart, end).trim());
    key = null;
    valueStart = -1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey) {
        key = JSON.parse(text.slice(i, end + 1));
        expectKey = false;
      }
      i = end;
    } else if (character === ":" && depth === 1 && key !== null && valueStart < 0) {
      valueStart = i + 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      deepest = Math.max(deepest, depth);
      if (depth === 1) expectKey = character === "{";
    } else if (character === "}" || character === "]") {
      if (depth === 1) close(i);
      depth -= 1;
    } else if (character === "," && depth === 1) {
      close(i);
      expectKey = true;
    } else if (character === "-" || (character >= "0" && character <= "9")) {
      const token = /-?[0-9][0-9.eE+-]*/y;
      token.lastIndex = i;
      const number = token.exec(text)[0];
      if (!Number.isFinite(Number(number))) overflow = true;
      i += number.length - 1;
    }
  }
  return { spans, deepest, overflow };
}

/** Whether a top-level `version` token is the canonical unsigned integer `wanted`. */
const versionIs = (token, wanted) => token !== undefined && /^(?:0|[1-9][0-9]*)$/.test(token) && BigInt(token) === BigInt(wanted);
/** The version a token names when it is a canonical unsigned 64-bit integer, or null. */
export const versionOf = (token) => (token !== undefined && /^(?:0|[1-9][0-9]*)$/.test(token) && BigInt(token) < 2n ** 64n ? BigInt(token) : null);

/** A site-relative path to a published page, as B5 checks it. */
export function isWorkPath(path) {
  if (typeof path !== "string") return false;
  const chars = Array.from(path);
  return (
    chars.length >= 2 &&
    chars.length <= MAX_WORK_PATH_CHARS &&
    path.startsWith("/") &&
    path.endsWith("/") &&
    !path.includes("//") &&
    !chars.some((c) => c === "\\" || c === "?" || c === "#" || isControl(c) || isWhiteSpace(c)) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/** A passage revision: `p`, a model number and 32 lowercase hex digits. */
export const isPassageRevision = (value) => typeof value === "string" && /^p[1-9][0-9]{0,3}:[0-9a-f]{32}$/.test(value);

const daysIn = (year, month) => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/** A canonical UTC time, `2026-10-26T10:00:00Z`, in years 0001 to 9999. */
export function isCanonicalTime(value) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/.exec(String(value));
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month) && hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * A reflection as stored: line breaks as `\n`, trimmed, 1 to MAX_BODY_CHARS characters of plain
 * text without control (other than tab and line break) or text-direction characters; or null.
 */
export function normalizeReflection(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(TRIM, "");
  const chars = Array.from(text);
  const forbidden = chars.some((c) => (isControl(c) && c !== "\t" && c !== "\n") || isBidiControl(c));
  return chars.length >= 1 && chars.length <= MAX_BODY_CHARS && !forbidden ? text : null;
}

/** B5's name rule for a name already collapsed: 1 to 80 characters of plain text. */
const nameIsPlain = (name) => {
  const chars = Array.from(name);
  return chars.length >= 1 && chars.length <= MAX_READER_NAME_CHARS && !chars.some((c) => isControl(c) || isBidiControl(c)) && normalizePassageText(name) === name;
};

const SUBMISSION_FIELDS = new Set(["version", "kind", "work", "revision", "target", "category", "body", "seenAt", "attribution", "consent"]);
const ATTRIBUTION_FIELDS = new Set(["name", "publishName"]);
const CONSENT_FIELDS = new Set(["publish", "clarification", "feature"]);
const onlyFields = (value, fields) => Object.keys(value).every((key) => fields.has(key));
const optionalString = (value) => value === undefined || value === null || typeof value === "string";
const optionalBoolean = (value) => value === undefined || typeof value === "boolean";

/** The kind a submission names, when its text is a JSON object; used to route one request. */
export function submissionKind(text) {
  try {
    const value = JSON.parse(String(text));
    return isObject(value) && typeof value.kind === "string" ? value.kind : null;
  } catch {
    return null;
  }
}

// Attributed sections (ADRs 0126 and 0127): one author's section of a published shared reflection is
// the ordinary section target whose anchor is `ob-by-{contributor}-{nth}`, with its digest. The
// contributor is the public registry key the post's committed credits name. This mirrors
// crates/openblog-core/src/attributed_perspective.rs, held to the same fixture.
export const ATTRIBUTED_ANCHOR_PREFIX = "ob-by-";
export const MAX_ATTRIBUTED_SECTIONS = 1000;
const MAX_IDENTIFIER_BYTES = 128;
const REGISTRY_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The anchor of the `nth` section (zero-based) written by `contributor`. */
export const attributedAnchor = (contributor, nth) => `${ATTRIBUTED_ANCHOR_PREFIX}${contributor}-${nth}`;

/**
 * Read an anchor: `null` when it is an ordinary heading id (it does not start with the reserved
 * prefix); `{ ok: false }` when it does but is not written exactly as `attributedAnchor` writes
 * one (so a look-alike is never half-read); otherwise `{ ok: true, contributor, nth }`.
 */
export function readAttributedAnchor(anchor) {
  if (typeof anchor !== "string" || !anchor.startsWith(ATTRIBUTED_ANCHOR_PREFIX)) return null;
  const rest = anchor.slice(ATTRIBUTED_ANCHOR_PREFIX.length);
  const at = rest.lastIndexOf("-");
  if (at < 0) return { ok: false };
  const contributor = rest.slice(0, at);
  const place = rest.slice(at + 1);
  const canonical = place.length >= 1 && place.length <= 3 && /^[0-9]+$/.test(place) && (place === "0" || !place.startsWith("0"));
  if (!canonical || !REGISTRY_KEY.test(contributor) || utf8Length(contributor) > MAX_IDENTIFIER_BYTES) return { ok: false };
  const nth = Number(place);
  return nth < MAX_ATTRIBUTED_SECTIONS ? { ok: true, contributor, nth } : { ok: false };
}

/**
 * The attributed reading of a checked section target (`{ kind, section?, digest? }`): `null` for the
 * whole work and any ordinary heading id; `{ ok: false }` for a reserved anchor that is not exact or
 * has no digest; otherwise `{ ok: true, contributor, nth, digest }`.
 */
export function readAttributedTarget(target) {
  if (!isObject(target) || typeof target.section !== "string") return null;
  const anchor = readAttributedAnchor(target.section);
  if (anchor === null) return null;
  if (!anchor.ok || target.kind !== "section" || typeof target.digest !== "string") return { ok: false };
  return { ok: true, contributor: anchor.contributor, nth: anchor.nth, digest: target.digest };
}

/** Read a target as a Third Perspective reads it: B5's rules, and never a quotation. */
function readPerspectiveTarget(value, source) {
  if (isObject(value) && value.kind === "quote" && versionIs(scan(source).spans.get("version"), 1)) {
    return failure("targetNotAllowed", "a Third Perspective is about the whole work or a section, not a quotation");
  }
  const read = readTargetSource(value, source);
  if (!read.ok) return failure(read.error.code === "unsupportedVersion" ? "unsupportedVersion" : "invalidTarget", `\`target\`: ${read.error.message}`);
  if (read.target.kind === "quote") return failure("targetNotAllowed", "a Third Perspective is about the whole work or a section, not a quotation");
  // The reserved attributed-section anchor space is written exactly, with its digest, or refused.
  if (readAttributedTarget(read.target)?.ok === false) return failure("invalidTarget", "`target`: not a valid attributed section target");
  return { ok: true, target: read.target };
}

/**
 * Read a submission from JSON text of at most MAX_JSON_BYTES:
 * `{version, kind, work, revision, target, category?, body, seenAt?, attribution?, consent:
 * {publish, clarification?, feature?}}`. Returns { ok: true, submission } with a new, frozen
 * submission (the text normalized, the name collapsed), or { ok: false, error: { code, message } }.
 * The checks run in the build's order, so both report the same first problem; a reader who did not
 * agree to publish is refused with `publicationConsentRequired`.
 */
export function readThirdPerspectiveSubmissionJson(text) {
  const source = String(text);
  if (utf8Length(source) > MAX_JSON_BYTES) return failure("tooLarge", `a Third Perspective submission is larger than ${MAX_JSON_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return malformed("a Third Perspective submission is not valid JSON");
  }
  const { spans, deepest, overflow } = scan(source);
  if (deepest > MAX_JSON_DEPTH || overflow || hasLoneSurrogate(value)) return malformed("a Third Perspective submission is not valid JSON");
  const version = isObject(value) ? versionOf(spans.get("version")) : null;
  if (version === null) return malformed("a Third Perspective submission needs `version` 1");
  if (version > BigInt(THIRD_PERSPECTIVE_VERSION)) {
    return failure("unsupportedVersion", `this Third Perspective submission is version ${version}, newer than the version ${THIRD_PERSPECTIVE_VERSION} this open.blog reads`);
  }
  if (version !== BigInt(THIRD_PERSPECTIVE_VERSION)) return malformed("a Third Perspective submission needs `version` 1");

  const { attribution, consent } = value;
  const shaped =
    onlyFields(value, SUBMISSION_FIELDS) &&
    ["kind", "work", "revision", "body"].every((key) => typeof value[key] === "string") &&
    Object.hasOwn(value, "target") &&
    optionalString(value.category) &&
    optionalString(value.seenAt) &&
    (attribution === undefined || (isObject(attribution) && onlyFields(attribution, ATTRIBUTION_FIELDS) && optionalString(attribution.name) && optionalBoolean(attribution.publishName))) &&
    isObject(consent) && onlyFields(consent, CONSENT_FIELDS) && typeof consent.publish === "boolean" && optionalBoolean(consent.clarification) && optionalBoolean(consent.feature);
  if (!shaped) return malformed("a Third Perspective submission has a field this version does not define, or a field of the wrong type");
  if (value.kind !== THIRD_PERSPECTIVE_KIND) return failure("wrongKind", `\`kind\` must be \`${THIRD_PERSPECTIVE_KIND}\``);
  const target = readPerspectiveTarget(value.target, spans.get("target") ?? "");
  if (!target.ok) return target;
  const category = value.category ?? null;
  if (category !== null && !CATEGORY_IDS.has(category)) return failure("unknownCategory", "`category` must be one of the response categories, or left out");
  const seenAt = value.seenAt ?? null;
  if (seenAt !== null && !isCanonicalTime(seenAt)) return failure("invalidTime", "`seenAt` must be a UTC time written like 2026-10-26T10:00:00Z");

  if (!consent.publish) return failure("publicationConsentRequired", "a Third Perspective is submitted for publication; `consent.publish` must be true");
  const body = normalizeReflection(value.body);
  if (body === null) return failure("invalidBody", `\`body\` must be 1 to ${MAX_BODY_CHARS} characters of plain text`);
  if (!isWorkPath(value.work)) return failure("invalidWork", "`work` must be the site-relative path of a published page, such as /posts/tides/");
  if (!isPassageRevision(value.revision)) return failure("invalidRevision", "`revision` must be a passage revision such as p1: and 32 hexadecimal digits");
  const name = typeof attribution?.name === "string" ? normalizePassageText(attribution.name) : "";
  const publishName = attribution?.publishName === true;
  if (name !== "" && !nameIsPlain(name)) return failure("invalidName", `\`attribution.name\` must be 1 to ${MAX_READER_NAME_CHARS} characters of plain text`);
  if (name === "" && publishName) return failure("consentWithoutName", "`attribution.publishName` needs a name to publish");

  const submission = {
    version: THIRD_PERSPECTIVE_VERSION,
    kind: THIRD_PERSPECTIVE_KIND,
    work: value.work,
    revision: value.revision,
    target: target.target,
    body,
    attribution: Object.freeze(name === "" ? { publishName } : { name, publishName }),
    consent: Object.freeze({ publish: true, clarification: consent.clarification === true, feature: consent.feature === true }),
  };
  if (category !== null) submission.category = category;
  if (seenAt !== null) submission.seenAt = seenAt;
  return { ok: true, submission: Object.freeze(submission) };
}

/** The canonical JSON value of a submission, as a browser sends it. */
export function thirdPerspectiveSubmissionValue(submission) {
  const value = {
    version: THIRD_PERSPECTIVE_VERSION,
    kind: THIRD_PERSPECTIVE_KIND,
    work: submission.work,
    revision: submission.revision,
    target: submission.target,
  };
  if (submission.category !== undefined) value.category = submission.category;
  value.body = submission.body;
  if (submission.seenAt !== undefined) value.seenAt = submission.seenAt;
  if (submission.attribution.name !== undefined || submission.attribution.publishName) value.attribution = { ...submission.attribution };
  value.consent = { ...submission.consent };
  return value;
}

/**
 * What a receiver keeps of a hosted submission (ADR 0113): the canonical record, exactly as the
 * build writes it, and the `openblog_feedback` row's columns, with `details` holding the category,
 * the intake (the digest of the reader's receipt) and consent record 1. `receivedAt` is the
 * receiver's own canonical time; a `seenAt` later than it is dropped.
 */
export function receiveThirdPerspective(submission, receivedAt, receiptDigest) {
  if (!isCanonicalTime(receivedAt)) throw new TypeError("receivedAt must be a canonical UTC time");
  if (typeof receiptDigest !== "string" || !/^[0-9a-f]{64}$/.test(receiptDigest)) throw new TypeError("a hosted Third Perspective needs its receipt's digest");
  const provenance = { version: 1, work: submission.work, revision: submission.revision, target: { ...submission.target } };
  if (submission.seenAt !== undefined && submission.seenAt <= receivedAt) provenance.seenAt = submission.seenAt;
  Object.assign(provenance, { receivedAt, channel: "hosted", attribution: { ...submission.attribution } });
  const first = { number: 1, givenAt: receivedAt, publish: true, attribution: { publishName: submission.attribution.publishName }, clarification: submission.consent.clarification };
  if (submission.consent.feature) first.featureRevision = 1;
  const details = {};
  if (submission.category !== undefined) details.category = submission.category;
  details.intake = { receiptDigest };
  details.consents = [first];
  const record = {
    version: THIRD_PERSPECTIVE_VERSION,
    kind: THIRD_PERSPECTIVE_KIND,
    ...(submission.category !== undefined ? { category: submission.category } : {}),
    body: submission.body,
    revision: 1,
    provenance,
    intake: details.intake,
    consents: details.consents,
  };
  return {
    record,
    details,
    row: {
      format_version: THIRD_PERSPECTIVE_VERSION,
      kind: THIRD_PERSPECTIVE_KIND,
      work: provenance.work,
      revision: provenance.revision,
      target: provenance.target,
      body: submission.body,
      details,
      seen_at: provenance.seenAt ?? null,
      received_at: receivedAt,
      channel: "hosted",
      reader_name: submission.attribution.name ?? null,
      publish_name: submission.attribution.publishName,
      clarification_consent: submission.consent.clarification,
    },
  };
}

/** The consent record in effect in stored `details`, or null when there is none to read. */
export function consentInEffect(details) {
  const consents = isObject(details) && Array.isArray(details.consents) ? details.consents : [];
  const last = consents.at(-1);
  return isObject(last) && Number.isInteger(last.number) && typeof last.publish === "boolean" ? last : null;
}

/**
 * Whether a moderator may approve a stored copy now, as `SubmittedCopy::check_approval` decides it
 * after RD12's policy: still pending, its text kept, the reader still agreeing to publish, and the
 * text revision and consent record the moderator saw still the ones in effect. Returns
 * { ok: true, consent } with the consent number the approval binds, or { ok: false, code }.
 */
export function checkThirdPerspectiveApproval(row, seenRevision, seenConsent) {
  if (row?.purged_at) return { ok: false, code: "contentPurged" };
  if (row?.status !== "pending") return { ok: false, code: "notPending" };
  const consent = consentInEffect(row.details);
  if (!consent || !consent.publish) return { ok: false, code: "publicationNotConsented" };
  if (seenRevision !== (row.item_revision ?? 1)) return { ok: false, code: "staleRevision" };
  if (seenConsent !== consent.number) return { ok: false, code: "staleConsent" };
  return { ok: true, consent: consent.number };
}

/**
 * A reader's change to their consent, made through their receipt, as `SubmittedCopy::revise_consent`
 * records it: a new consent record appended to the stored `details`. `copy` is `{ body, revision,
 * provenance, details, state, approvedRevision, retained }`; `at` is the receiver's canonical time.
 * `change` is `{ clarification, feature }` where `feature` is the reader's own choice about feature
 * consent (ADR 0177) and never a flag: `"keep"` (or left out) carries the agreement forward bound to
 * the revision it was, `"decline"` takes it back, and `{ agree: n }` agrees for revision `n`, which
 * must be the revision the reader saw (the approved one, or before a decision the current one).
 * Only an explicit agreement binds a revision, so changing what the reader may be asked can never
 * renew feature consent for text that was edited. Returns { ok: true, details } or { ok: false, code }
 * with the code the build gives.
 */
export function reviseConsent(copy, change, at) {
  const clarification = change.clarification;
  const choice = change.feature ?? "keep";
  if (!copy.retained) return { ok: false, code: "contentPurged" };
  const consents = Array.isArray(copy.details?.consents) ? copy.details.consents : [];
  const current = consentInEffect(copy.details);
  if (!current || !current.publish || copy.state === "withdrawn") return { ok: false, code: "closed" };
  if (!isCanonicalTime(at) || at < current.givenAt) return { ok: false, code: "invalidTime" };
  const undecided = copy.state === "pending" || copy.state === "clarification";
  const kept = current.featureRevision ?? null;
  let featureRevision = null;
  if (choice === "keep") featureRevision = kept;
  else if (choice !== "decline") {
    const seen = isObject(choice) && Number.isInteger(choice.agree) ? choice.agree : null;
    const bindable = undecided ? copy.revision : copy.state === "approved" ? copy.approvedRevision ?? null : null;
    if (seen === null) return { ok: false, code: "invalid" };
    if (bindable === null) return { ok: false, code: "featureNotAvailable" };
    if (bindable !== seen) return { ok: false, code: "staleRevision" };
    featureRevision = bindable;
  }
  const before = kept;
  if (clarification === current.clarification && featureRevision === before) return { ok: false, code: "unchanged" };
  const narrows = (!clarification || current.clarification) && (featureRevision === null || featureRevision === before);
  const record = { number: current.number + 1, givenAt: at, publish: true, attribution: { publishName: current.attribution?.publishName === true }, clarification };
  if (featureRevision !== null) record.featureRevision = featureRevision;
  const details = { ...copy.details, consents: [...consents, record] };
  const slots = narrows ? MAX_CONSENT_RECORDS - 1 : MAX_CONSENT_RECORDS - 1 - NARROWING_RESERVE;
  const reserve = narrows ? 256 : CONSENT_RESERVE_BYTES;
  const recordBytes = utf8Length(JSON.stringify({
    version: THIRD_PERSPECTIVE_VERSION, kind: THIRD_PERSPECTIVE_KIND, ...(details.category ? { category: details.category } : {}), body: copy.body, revision: copy.revision,
    ...(details.revisedAt ? { revisedAt: details.revisedAt } : {}), provenance: copy.provenance, intake: details.intake, consents: details.consents,
  }));
  if (details.consents.length > slots || utf8Length(JSON.stringify(details)) + reserve > MAX_DETAILS_BYTES || recordBytes + reserve > MAX_JSON_BYTES) {
    return { ok: false, code: "consentLimit" };
  }
  return { ok: true, details };
}

/** A reader's change to whether they may be asked to clarify, with every other part of the consent kept. */
export function reviseClarificationConsent(copy, clarification, at) {
  return reviseConsent(copy, { clarification, feature: "keep" }, at);
}

const describeTarget = (target) => {
  if (target.kind === "work") return "The whole work";
  const attributed = readAttributedTarget(target);
  if (attributed?.ok) return `One author’s section: by ${attributed.contributor}, section ${attributed.nth + 1}`;
  return target.section === undefined ? "The opening, before the first heading" : `Section #${target.section}`;
};

/**
 * The copy-and-send path when no hosted service takes the reflection (or the reader chose not to
 * publish it): plain text a reader can copy into a message to the author. When the reader agreed to
 * publish, its last line is the submission's canonical JSON, which the author can enter by hand.
 * Nothing is sent anywhere.
 */
export function thirdPerspectiveCopyText(submission, canonicalUrl = "") {
  const category = RESPONSE_CATEGORIES.find((entry) => entry.id === submission.category);
  const lines = [
    `${THIRD_PERSPECTIVE_LABEL} on ${canonicalUrl || submission.work}`,
    `About: ${describeTarget(submission.target)}`,
    ...(category ? [`Prompt: ${category.label}`] : []),
    `Revision read: ${submission.revision}`,
    "",
    submission.body,
    "",
  ];
  if (submission.attribution.name !== undefined) {
    lines.push(`Name: ${submission.attribution.name} (${submission.attribution.publishName ? "may be shown if published" : "not to be shown"})`);
  }
  if (submission.consent.publish) {
    lines.push(`May be published once approved; may be asked to clarify: ${submission.consent.clarification ? "yes" : "no"}; may be featured in a community section: ${submission.consent.feature ? "yes, this text only" : "no"}.`);
    lines.push("", "open.blog Third Perspective record (for the author; keep it on one line):", JSON.stringify(thirdPerspectiveSubmissionValue(submission)));
  } else {
    lines.push("Not for publication: for the author only.");
  }
  return lines.join("\n");
}
