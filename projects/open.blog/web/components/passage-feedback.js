// Typed scholarly feedback (ADRs 0079 to 0081): the browser and hosted-function
// half of the contract in crates/openblog-core/src/scholarly_feedback.rs. Both
// read tests/fixtures/scholarly-feedback.json and must agree on every code and
// record.
//
// A reader asks a question, suggests a source, suggests a correction or offers
// another interpretation of a passage. A submission names its kind, the work,
// the passage revision the reader saw, a passage target (passage-target.js),
// the text, the kind's details and the reader's attribution choice. The
// receiver (the hosted function, or the author entering a copied submission)
// stamps when it arrived. A kind is the reader's stated intent, never a
// verdict: a suggested correction is not a correction until an author decides.
//
// Everything here is a pure function: nothing is fetched, stored or sent, and
// a failure is a value for the one submission that caused it, with a code and
// a message that names the field and never repeats what the reader wrote.
//
// Evidence submissions (ADR 0116) are format version 2: a suggested source or
// a suggested correction with an `evidence` block naming the published claim,
// evidence link, citation or source it concerns, by the site's public ids.
// readEvidenceSubmissionJson is the half of
// crates/openblog-core/src/evidence_submission.rs that the browser and the
// hosted function share, read against tests/fixtures/evidence-corrections.json.
// The block is the reader's statement: nothing here checks that an id exists,
// so a guess never confirms anything private.

import { normalizePassageText, readTargetSource } from "./passage-target.js";

export const FEEDBACK_SUBMISSION_VERSION = 1;
export const MAX_FEEDBACK_BODY_CHARS = 4000;
export const MAX_SUGGESTED_TEXT_CHARS = 2000;
export const MAX_SOURCE_URL_BYTES = 2048;
export const MAX_SUBMISSION_JSON_BYTES = 32 * 1024;
export const MAX_READER_NAME_CHARS = 80;
export const MAX_WORK_PATH_CHARS = 500;
// The build's JSON reader refuses documents nested deeper than this.
const MAX_JSON_DEPTH = 127;

export const EVIDENCE_SUBMISSION_VERSION = 2;
export const MAX_OFFERED_LOCATORS = 8;
export const MAX_LOCATOR_VALUE_CHARS = 64;
/** The kinds whose submissions may carry an evidence block (ADR 0116). */
export const EVIDENCE_KINDS = Object.freeze(["source-suggestion", "correction-suggestion"]);
/** How a reader says the evidence they offer bears on the passage: A4's relation ids. */
export const EVIDENCE_STANCES = Object.freeze(["supports", "contradicts", "contextualizes"]);
/** The notebook's locator kinds; an `x-` kind is also accepted. */
export const LOCATOR_KINDS = Object.freeze(["page", "folio", "line", "section", "chapter", "canonical", "timestamp"]);

const kind = (label, workTarget, sourceUrl, suggestedText) => Object.freeze({ label, workTarget, sourceUrl, suggestedText });

/**
 * The kinds this version accepts. `workTarget` says whether the kind may be
 * about the whole post; `sourceUrl` and `suggestedText` are "required",
 * "optional" or "notUsed". New kinds (a Third Perspective, a future question)
 * are added here and in the Rust model; storage needs no change.
 */
export const FEEDBACK_KINDS = Object.freeze({
  question: kind("Question", true, "optional", "notUsed"),
  "source-suggestion": kind("Suggested source", true, "required", "notUsed"),
  "correction-suggestion": kind("Suggested correction", false, "optional", "optional"),
  "alternative-interpretation": kind("Another interpretation", true, "optional", "notUsed"),
});

const WHITE_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITE_SPACE_CHAR = new RegExp(`^[${WHITE_SPACE}]$`, "u");
const isWhiteSpace = (character) => WHITE_SPACE_CHAR.test(character);
const TRIM = new RegExp(`^[${WHITE_SPACE}]+|[${WHITE_SPACE}]+$`, "gu");
const codePoint = (character) => character.codePointAt(0);
const isControl = (character) => codePoint(character) <= 0x1f || (codePoint(character) >= 0x7f && codePoint(character) <= 0x9f);
const isBidiControl = (character) => {
  const point = codePoint(character);
  return (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
};
const isUrlBidiControl = (character) => isBidiControl(character) || [0x061c, 0x200e, 0x200f].includes(codePoint(character));
const utf8Length = (text) => new TextEncoder().encode(text).length;
const isLoneSurrogate = (character) => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff;

const failure = (code, message, target) => ({ ok: false, error: target ? { code, message, target } : { code, message } });
const malformed = (message) => failure("malformed", message);

/** A site-relative path to a published page, as the build checks it. */
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

/**
 * A canonical UTC time, `2026-10-26T10:00:00Z`, in years 0001 to 9999: the
 * range storage (a Postgres timestamptz) holds, so an accepted time never
 * fails at the database after a quota slot is spent.
 */
export function isCanonicalTime(value) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/.exec(String(value));
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month) && hour <= 23 && minute <= 59 && second <= 59;
}

/** A time as the canonical form, from a Date or a timestamp a database returns. */
export function canonicalTime(value) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.[0-9]{3}Z$/, "Z");
}

/** Trimmed reader text of 1 to `max` characters, or null. */
function readerText(value, max) {
  const text = value.replace(TRIM, "");
  const chars = Array.from(text);
  const forbidden = chars.some((c) => (isControl(c) && c !== "\t" && c !== "\n" && c !== "\r") || isBidiControl(c));
  return chars.length >= 1 && chars.length <= max && !forbidden ? text : null;
}

/**
 * A source link: an absolute HTTP(S) address without credentials, written
 * without surrounding or inner whitespace, control or text-direction
 * characters, normalized by the WHATWG URL rules, and ASCII once normalized.
 * Returns the normalized link or null.
 */
export function normalizeSourceUrl(value) {
  if (typeof value !== "string" || value === "" || utf8Length(value) > MAX_SOURCE_URL_BYTES) return null;
  if (Array.from(value).some((c) => isControl(c) || isWhiteSpace(c) || isUrlBidiControl(c))) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.hostname === "") return null;
  const href = url.href;
  return /^[\x00-\x7f]*$/.test(href) && href.length <= MAX_SOURCE_URL_BYTES ? href : null;
}

/**
 * The raw source of each top-level value of valid JSON text (the last one
 * wins for a repeated key, as in JSON.parse), the deepest nesting, and
 * whether a number is too large to hold, which the build's reader refuses.
 */
function scan(text) {
  const spans = new Map();
  let depth = 0;
  let deepest = 0;
  let expectKey = false;
  let key = null;
  let valueStart = -1;
  let overflow = false;
  const close = (end) => {
    if (key !== null && valueStart >= 0) spans.set(key, text.slice(valueStart, end));
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

const hasLoneSurrogate = (value) => {
  if (typeof value === "string") return Array.from(value).some(isLoneSurrogate);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, inner]) => hasLoneSurrogate(key) || hasLoneSurrogate(inner));
  }
  return false;
};

const SUBMISSION_FIELDS = new Set(["version", "kind", "work", "revision", "target", "body", "details", "seenAt", "attribution"]);
const DETAIL_FIELDS = new Set(["sourceUrl", "suggestedText"]);
const ATTRIBUTION_FIELDS = new Set(["name", "publishName"]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const absent = (value) => value === undefined || value === null;
const optionalString = (value) => absent(value) || typeof value === "string";
const onlyFields = (value, fields) => Object.keys(value).every((key) => fields.has(key));
const U64_LIMIT = 2n ** 64n;

/**
 * Valid JSON text of at most MAX_SUBMISSION_JSON_BYTES as { value, spans }, or a failure: what
 * both readers check before the version.
 */
function parseSubmission(text) {
  const source = String(text);
  if (utf8Length(source) > MAX_SUBMISSION_JSON_BYTES) {
    return failure("tooLarge", `a feedback submission is larger than ${MAX_SUBMISSION_JSON_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return malformed("a feedback submission is not valid JSON");
  }
  const { spans, deepest, overflow } = scan(source);
  if (deepest > MAX_JSON_DEPTH || overflow || hasLoneSurrogate(value)) {
    return malformed("a feedback submission is not valid JSON");
  }
  return { ok: true, value, spans };
}

/** The `version` member exactly as written, as a BigInt, or null when it is not a whole number. */
function versionOf(value, spans) {
  if (!isObject(value)) return null;
  const token = spans.get("version")?.trim();
  return token !== undefined && /^(?:0|[1-9][0-9]*)$/.test(token) && BigInt(token) < U64_LIMIT ? BigInt(token) : null;
}

/**
 * Read a submission from JSON text of at most MAX_SUBMISSION_JSON_BYTES.
 * Returns { ok: true, submission } with a new, frozen submission (text
 * trimmed, the name collapsed to single spaces, the link normalized), or
 * { ok: false, error: { code, message, target? } }. The checks run in the
 * same order as the build's, so both report the same first problem.
 */
export function readFeedbackSubmissionJson(text) {
  const parsed = parseSubmission(text);
  if (!parsed.ok) return parsed;
  const { value, spans } = parsed;
  if (!isObject(value)) return malformed("a feedback submission needs `version` 1");
  const version = versionOf(value, spans);
  if (version === null) return malformed("a feedback submission needs `version` 1");
  if (version > BigInt(FEEDBACK_SUBMISSION_VERSION)) {
    return failure("unsupportedVersion", `this feedback submission is version ${version}, newer than the version ${FEEDBACK_SUBMISSION_VERSION} this open.blog reads`);
  }
  if (version !== BigInt(FEEDBACK_SUBMISSION_VERSION)) return malformed("a feedback submission needs `version` 1");
  return checkFeedback(value, spans);
}

/** Every B5 rule after the version, in the build's order. */
function checkFeedback(value, spans) {
  const wrongShape = malformed("a feedback submission has a field this version does not define, or a field of the wrong type");
  const { details = null, attribution = null } = value;
  const shaped =
    onlyFields(value, SUBMISSION_FIELDS) &&
    ["kind", "work", "revision", "body"].every((key) => typeof value[key] === "string") &&
    Object.hasOwn(value, "target") &&
    optionalString(value.seenAt) &&
    (absent(details) || (isObject(details) && onlyFields(details, DETAIL_FIELDS) && optionalString(details.sourceUrl) && optionalString(details.suggestedText))) &&
    (absent(attribution) ||
      (isObject(attribution) && onlyFields(attribution, ATTRIBUTION_FIELDS) && optionalString(attribution.name) && (attribution.publishName === undefined || typeof attribution.publishName === "boolean")));
  if (!shaped) return wrongShape;

  if (!Object.hasOwn(FEEDBACK_KINDS, value.kind)) return failure("unknownKind", "`kind` is not a kind of feedback this site accepts");
  const rules = FEEDBACK_KINDS[value.kind];
  if (!isWorkPath(value.work)) {
    return failure("invalidWork", "`work` must be the site-relative path of a published page, such as /posts/tides/");
  }
  if (!isPassageRevision(value.revision)) {
    return failure("invalidRevision", "`revision` must be a passage revision such as p1: and 32 hexadecimal digits");
  }
  const read = readTargetSource(value.target, spans.get("target") ?? "");
  if (!read.ok) return failure("invalidTarget", `\`target\`: ${read.error.message}`, read.error.code);
  const target = read.target;
  if (!rules.workTarget && target.kind === "work") {
    return failure("targetNotAllowed", `a ${value.kind} must point at a section or a quotation`);
  }
  const body = readerText(value.body, MAX_FEEDBACK_BODY_CHARS);
  if (body === null) return failure("invalidBody", `\`body\` must be 1 to ${MAX_FEEDBACK_BODY_CHARS} characters of plain text`);

  const sourceUrl = absent(details?.sourceUrl) ? undefined : details.sourceUrl;
  const suggestedText = absent(details?.suggestedText) ? undefined : details.suggestedText;
  if (sourceUrl !== undefined && rules.sourceUrl === "notUsed") return failure("detailNotAllowed", `a ${value.kind} has no \`details.sourceUrl\``);
  if (suggestedText !== undefined && rules.suggestedText === "notUsed") return failure("detailNotAllowed", `a ${value.kind} has no \`details.suggestedText\``);
  if (sourceUrl === undefined && rules.sourceUrl === "required") return failure("missingSource", `a ${value.kind} needs \`details.sourceUrl\``);
  const outDetails = {};
  if (sourceUrl !== undefined) {
    const normalized = normalizeSourceUrl(sourceUrl);
    if (normalized === null) return failure("invalidSourceUrl", "`details.sourceUrl` must be an absolute HTTP(S) link without credentials");
    outDetails.sourceUrl = normalized;
  }
  if (suggestedText !== undefined) {
    const text = readerText(suggestedText, MAX_SUGGESTED_TEXT_CHARS);
    if (text === null) return failure("invalidSuggestedText", `\`details.suggestedText\` must be 1 to ${MAX_SUGGESTED_TEXT_CHARS} characters of plain text`);
    outDetails.suggestedText = text;
  }

  if (!absent(value.seenAt) && !isCanonicalTime(value.seenAt)) {
    return failure("invalidTime", "`seenAt` must be a UTC time written like 2026-10-26T10:00:00Z");
  }
  const name = absent(attribution?.name) ? "" : normalizePassageText(attribution.name);
  const publishName = attribution?.publishName === true;
  if (name !== "") {
    const chars = Array.from(name);
    if (chars.length > MAX_READER_NAME_CHARS || chars.some((c) => isControl(c) || isBidiControl(c))) {
      return failure("invalidName", `\`attribution.name\` must be 1 to ${MAX_READER_NAME_CHARS} characters of plain text`);
    }
  } else if (publishName) {
    return failure("consentWithoutName", "`attribution.publishName` needs a name to publish");
  }

  const submission = {
    version: FEEDBACK_SUBMISSION_VERSION,
    kind: value.kind,
    work: value.work,
    revision: value.revision,
    target,
    body,
    details: Object.freeze(outDetails),
    attribution: Object.freeze(name === "" ? { publishName } : { name, publishName }),
  };
  if (!absent(value.seenAt)) submission.seenAt = value.seenAt;
  return { ok: true, submission: Object.freeze(submission) };
}

const EVIDENCE_FIELDS = new Set(["claim", "evidenceLink", "citation", "source", "locators", "stance"]);
const LOCATOR_FIELDS = new Set(["kind", "value", "to"]);

/** A lowercase slug of at most 64 bytes: the shape of A4 claim and link ids and source ids. */
export function isPublicId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** A locator kind the notebook knows: a named kind, or `x-` and a registry key. */
export function isLocatorKind(value) {
  return typeof value === "string" && (LOCATOR_KINDS.includes(value) || (value.length > 2 && value.length <= 64 && value.startsWith("x-") && isPublicId(value)));
}

const locatorText = (value) => {
  const text = readerText(value, MAX_LOCATOR_VALUE_CHARS);
  return text !== null && !/[\n\r\t]/.test(text) ? text : null;
};

const evidenceFailure = (code, message) => failure(code, message);

/**
 * Read an evidence block for a submission whose details do (or do not) carry a source link, in the
 * build's order: shape, references, link needs claim, locators, stance, emptiness. Returns
 * { ok: true, evidence } with a new, frozen block in canonical form, or a failure.
 */
function readEvidence(block, hasSourceUrl) {
  const wrongShape = malformed("`evidence` has a field this version does not define, or a field of the wrong type");
  if (!isObject(block)) return malformed("`evidence` must be an object");
  const optional = (key) => absent(block[key]) || typeof block[key] === "string";
  const locatorShaped = (locator) =>
    isObject(locator) && onlyFields(locator, LOCATOR_FIELDS) && typeof locator.kind === "string" && typeof locator.value === "string" && (absent(locator.to) || typeof locator.to === "string");
  const shaped =
    onlyFields(block, EVIDENCE_FIELDS) &&
    ["claim", "evidenceLink", "citation", "source", "stance"].every(optional) &&
    (absent(block.locators) || (Array.isArray(block.locators) && block.locators.every(locatorShaped)));
  if (!shaped) return wrongShape;
  const value = (key) => (absent(block[key]) ? undefined : block[key]);
  for (const field of ["claim", "evidenceLink", "citation", "source"]) {
    if (value(field) !== undefined && !isPublicId(value(field))) {
      return evidenceFailure("invalidReference", `\`evidence.${field}\` must be an id the site publishes: a lowercase slug of at most 64 bytes`);
    }
  }
  if (value("evidenceLink") !== undefined && value("claim") === undefined) {
    return evidenceFailure("linkWithoutClaim", "`evidence.evidenceLink` needs the `evidence.claim` it belongs to");
  }
  const locators = absent(block.locators) ? [] : block.locators;
  if (locators.length > 0 && value("source") === undefined) {
    return evidenceFailure("locatorsWithoutSource", "`evidence.locators` need the `evidence.source` they are in");
  }
  if (locators.length > MAX_OFFERED_LOCATORS) {
    return evidenceFailure("tooManyLocators", `\`evidence.locators\` holds at most ${MAX_OFFERED_LOCATORS} locators`);
  }
  const outLocators = [];
  for (const [index, locator] of locators.entries()) {
    const invalid = evidenceFailure(
      "invalidLocator",
      `\`evidence.locators[${index}]\` needs a known kind (page, folio, line, section, chapter, canonical, timestamp or x-…) and a value of 1 to ${MAX_LOCATOR_VALUE_CHARS} characters`,
    );
    if (!isLocatorKind(locator.kind)) return invalid;
    const text = locatorText(locator.value);
    if (text === null) return invalid;
    const out = { kind: locator.kind, value: text };
    if (!absent(locator.to)) {
      const to = locatorText(locator.to);
      if (to === null) return invalid;
      out.to = to;
    }
    outLocators.push(Object.freeze(out));
  }
  const stance = value("stance");
  if (stance !== undefined && !EVIDENCE_STANCES.includes(stance)) return malformed("`evidence.stance` must be supports, contradicts or contextualizes");
  if (stance !== undefined && value("source") === undefined && !hasSourceUrl) {
    return evidenceFailure("stanceWithoutEvidence", "`evidence.stance` describes offered evidence: give `evidence.source` or `details.sourceUrl`");
  }
  const evidence = {};
  for (const field of ["claim", "evidenceLink", "citation", "source"]) if (value(field) !== undefined) evidence[field] = value(field);
  if (outLocators.length) evidence.locators = Object.freeze(outLocators);
  if (stance !== undefined) evidence.stance = stance;
  if (Object.keys(evidence).length === 0) {
    return evidenceFailure("emptyEvidence", "`evidence` must name a claim, an evidence link, a citation, a source or a stance");
  }
  if (storedSize(evidence) > MAX_EVIDENCE_STORED_BYTES) {
    return evidenceFailure("evidenceTooLarge", `\`evidence\` is larger than ${MAX_EVIDENCE_STORED_BYTES} bytes once written out`);
  }
  return { ok: true, evidence: Object.freeze(evidence) };
}

/**
 * The most octets a stored evidence block takes, as Postgres writes a `jsonb` value as text: the
 * bound supabase/feedback.sql checks. Every block either reader accepts fits it.
 */
export const MAX_EVIDENCE_STORED_BYTES = 4096;
/** The octets `value` takes as jsonb text, which puts a space after every `:` and `,`. */
function storedSize(value) {
  if (Array.isArray(value)) return 2 + value.reduce((total, item) => total + storedSize(item), 0) + 2 * Math.max(0, value.length - 1);
  if (isObject(value)) {
    const entries = Object.entries(value);
    return 2 + entries.reduce((total, [key, item]) => total + utf8Length(JSON.stringify(key)) + 2 + storedSize(item), 0) + 2 * Math.max(0, entries.length - 1);
  }
  return utf8Length(JSON.stringify(value));
}

/**
 * Read an evidence submission (ADR 0116) from JSON text, as the build's
 * EvidenceSubmission does: version 1 is B5's submission of an evidence kind,
 * without a block; version 2 carries `evidence`. Returns { ok: true,
 * submission } with the B5 submission's fields and, for version 2, a frozen
 * `evidence`, or { ok: false, error: { code, message, feedbackCode?,
 * target? } }, where a B5 rule's refusal has the code `feedback` and B5's own
 * code as `feedbackCode`. Checks run in the build's order: size, JSON,
 * version, every B5 rule, the kind is an evidence kind, then the block.
 */
export function readEvidenceSubmissionJson(text) {
  const parsed = parseSubmission(text);
  if (!parsed.ok) return parsed;
  const { value, spans } = parsed;
  const version = versionOf(value, spans);
  const latest = BigInt(EVIDENCE_SUBMISSION_VERSION);
  if (version !== null && version > latest) {
    return failure("unsupportedVersion", `this feedback submission is version ${version}, newer than the version ${EVIDENCE_SUBMISSION_VERSION} this open.blog reads`);
  }
  if (version !== 1n && version !== latest) return malformed("a feedback submission needs `version` 1 or 2");
  const hasEvidence = Object.hasOwn(value, "evidence");
  if (version === 1n && hasEvidence) return malformed("a version 1 feedback submission has no `evidence`; evidence needs version 2");
  if (version === latest && !hasEvidence) {
    return failure("missingEvidence", "a version 2 feedback submission needs `evidence`; write it as version 1 without one");
  }
  const { evidence: block, ...rest } = value;
  const read = checkFeedback({ ...rest, version: FEEDBACK_SUBMISSION_VERSION }, spans);
  if (!read.ok) {
    const { code, message, target } = read.error;
    return { ok: false, error: target ? { code: "feedback", feedbackCode: code, message, target } : { code: "feedback", feedbackCode: code, message } };
  }
  if (!EVIDENCE_KINDS.includes(read.submission.kind)) {
    return failure("notEvidenceKind", `a ${read.submission.kind} is not an evidence submission; only a source-suggestion or a correction-suggestion offers evidence`);
  }
  if (!hasEvidence) return read;
  const evidence = readEvidence(block, read.submission.details.sourceUrl !== undefined);
  if (!evidence.ok) return evidence;
  return { ok: true, submission: Object.freeze({ ...read.submission, version: EVIDENCE_SUBMISSION_VERSION, evidence: evidence.evidence }) };
}

/**
 * Read any submission a site accepts: with `evidence` on (the hosted service
 * stores evidence blocks), a version 2 or newer document is read as an
 * evidence submission and everything else as B5's; without it, as B5's,
 * which refuses version 2. A refused evidence submission's B5 code is
 * reported as its own `code`, so every caller reads one set of codes.
 */
export function readSubmissionJson(text, { evidence = false } = {}) {
  if (evidence) {
    const parsed = parseSubmission(text);
    const version = parsed.ok ? versionOf(parsed.value, parsed.spans) : null;
    if (version !== null && version >= BigInt(EVIDENCE_SUBMISSION_VERSION)) {
      const read = readEvidenceSubmissionJson(text);
      if (read.ok || read.error.code !== "feedback") return read;
      const { feedbackCode, message, target } = read.error;
      return failure(feedbackCode, message, target);
    }
  }
  return readFeedbackSubmissionJson(text);
}

/**
 * The record a receiver keeps, as the build writes it:
 * { version, kind, body, details, provenance } with the ADR 0078 provenance.
 * `receivedAt` is the receiver's own canonical time, never the reader's; a
 * `seenAt` later than it (a reader's clock running ahead) is dropped.
 */
export function receiveFeedback(submission, receivedAt, channel = "hosted") {
  if (!isCanonicalTime(receivedAt)) throw new TypeError("receivedAt must be a canonical UTC time");
  if (channel !== "hosted" && channel !== "manual") throw new TypeError("channel must be hosted or manual");
  const provenance = { version: 1, work: submission.work, revision: submission.revision, target: submission.target };
  if (submission.seenAt !== undefined && submission.seenAt <= receivedAt) provenance.seenAt = submission.seenAt;
  Object.assign(provenance, { receivedAt, channel, attribution: { ...submission.attribution } });
  const record = {
    version: FEEDBACK_SUBMISSION_VERSION,
    kind: submission.kind,
    body: submission.body,
    details: { ...submission.details },
    provenance,
  };
  // An evidence submission's record is version 2 with the block beside B5's fields (ADR 0116).
  if (submission.evidence !== undefined) {
    record.version = EVIDENCE_SUBMISSION_VERSION;
    record.evidence = evidenceValue(submission.evidence);
  }
  return record;
}

/** A plain copy of an evidence block in canonical form. */
function evidenceValue(evidence) {
  const value = { ...evidence };
  if (evidence.locators) value.locators = evidence.locators.map((locator) => ({ ...locator }));
  return value;
}

/** The canonical JSON value of a submission, as a browser sends it. */
export function submissionValue(submission) {
  const value = {
    version: submission.evidence === undefined ? FEEDBACK_SUBMISSION_VERSION : EVIDENCE_SUBMISSION_VERSION,
    kind: submission.kind,
    work: submission.work,
    revision: submission.revision,
    target: submission.target,
    body: submission.body,
  };
  if (Object.keys(submission.details).length > 0) value.details = submission.details;
  if (submission.seenAt !== undefined) value.seenAt = submission.seenAt;
  if (submission.attribution.name !== undefined || submission.attribution.publishName) value.attribution = submission.attribution;
  if (submission.evidence !== undefined) value.evidence = evidenceValue(submission.evidence);
  return value;
}

const STANCE_WORDS = Object.freeze({ supports: "supports the passage", contradicts: "contradicts the passage", contextualizes: "gives context to the passage" });

/** The evidence block in words, one line each, for the copy fallback and reviewers. */
export function evidenceLines(evidence) {
  if (!evidence) return [];
  const lines = [];
  if (evidence.claim) lines.push(`Claim: ${evidence.claim}`);
  if (evidence.evidenceLink) lines.push(`Evidence link questioned: ${evidence.evidenceLink}`);
  if (evidence.citation) lines.push(`Cited source questioned: ${evidence.citation}`);
  if (evidence.source) {
    const where = (evidence.locators || []).map((locator) => `${locator.kind} ${locator.value}${locator.to ? `–${locator.to}` : ""}`).join(", ");
    lines.push(`Source offered: ${evidence.source}${where ? ` (${where})` : ""}`);
  }
  if (evidence.stance) lines.push(`The reader says it ${STANCE_WORDS[evidence.stance]}.`);
  return lines;
}

const describeTarget = (target) => {
  if (target.kind === "work") return "The whole post";
  const section = target.section === undefined ? "the opening, before the first heading" : `section #${target.section}`;
  return target.kind === "quote" ? `“${target.exact}” in ${section}` : `All of ${section}`;
};

/**
 * The copy-and-send fallback when no hosted endpoint is available (or it is
 * down): plain text a reader can copy into a message to the author. Its last
 * line is the submission's canonical JSON, which the author can enter as
 * manual feedback, producing the same record the hosted path would. Nothing
 * is sent anywhere.
 */
export function feedbackCopyText(submission, canonicalUrl = "") {
  const lines = [
    `${FEEDBACK_KINDS[submission.kind].label} about ${canonicalUrl || submission.work}`,
    `Passage: ${describeTarget(submission.target)}`,
    `Revision seen: ${submission.revision}`,
    "",
    submission.body,
    "",
  ];
  if (submission.details.sourceUrl) lines.push(`Source: ${submission.details.sourceUrl}`);
  if (submission.details.suggestedText) lines.push(`Suggested wording: ${submission.details.suggestedText}`);
  lines.push(...evidenceLines(submission.evidence));
  if (submission.attribution.name !== undefined) {
    lines.push(`Name: ${submission.attribution.name} (${submission.attribution.publishName ? "may be shown with published feedback" : "not for publication"})`);
  }
  lines.push("", "open.blog feedback record (for the author; keep it on one line):", JSON.stringify(submissionValue(submission)));
  return lines.join("\n");
}
