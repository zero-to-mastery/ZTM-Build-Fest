// An author's answer to a Third Perspective about their own section (#223, ADRs 0131 to 0135): the
// hosted-function half of the contract in crates/openblog-core/src/author_response.rs. Both read
// tests/fixtures/author-responses.json and must agree on every code and row.
//
// Admin decides who may answer (it checks the private shared-publication record, which the hosted
// function never holds) and sends one request. This module only reads that request strictly, builds
// the row to store, and checks that the answer still belongs under its parent. Everything here is a
// pure function: nothing is fetched, stored or sent, and a failure is a value with a code and a
// message that names the field and never repeats what anyone wrote.

import { normalizePassageText } from "../../web/components/passage-target.js";
import { isWorkPath, normalizeReflection, readAttributedTarget } from "../../web/components/third-perspective.js";

export const AUTHOR_RESPONSE_KIND = "author-response";
export const AUTHOR_RESPONSE_VERSION = 1;
export const MAX_JSON_BYTES = 16 * 1024;
export const MAX_AUTHOR_NAME_CHARS = 80;
export const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_ADMIN_USERNAME_BYTES = 32;

// The reasons an answer does not belong under its parent: the codes the build uses too.
export const PARENT_UNAVAILABLE = "parentUnavailable";
export const PARENT_NOT_ATTRIBUTED = "notAttributed";
export const PARENT_RESPONDER_MISMATCH = "responderMismatch";
export const PARENT_WRONG_WORK = "wrongWork";

const STALE_REASONS = new Set(["section-changed-or-removed", "author-absent", "ambiguous"]);
const REQUEST_FIELDS = ["version", "kind", "work", "parent", "body", "responder", "binding", "actor"];

const utf8Length = (text) => new TextEncoder().encode(text).length;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyFields = (value, fields) => Object.keys(value).every((key) => fields.includes(key)) && fields.every((key) => Object.hasOwn(value, key));
const failure = (code, message) => ({ ok: false, error: { code, message } });
const malformed = (message) => failure("malformed", message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isControl = (character) => {
  const point = character.codePointAt(0);
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
};
const isBidiControl = (character) => {
  const point = character.codePointAt(0);
  return (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
};

/** A contributor registry key: lowercase letters, digits and single hyphens inside. */
const isContributorId = (value) => typeof value === "string" && utf8Length(value) <= MAX_IDENTIFIER_BYTES && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
/** An opaque participant id: letters, digits, `-`, `_` and `.` only inside, never a dot segment. */
const isParticipantId = (value) =>
  typeof value === "string" && utf8Length(value) <= MAX_IDENTIFIER_BYTES && /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(value) && !value.includes("..");
/** An Admin account name as the CLI creates one. */
const isAdminUsername = (value) => typeof value === "string" && value.length >= 1 && utf8Length(value) <= MAX_ADMIN_USERNAME_BYTES && /^[a-z0-9_.-]+$/.test(value);
/** A published name as B5 checks one: collapsed whitespace, 1 to 80 plain characters. */
const isAuthorName = (name) => {
  if (typeof name !== "string") return false;
  const chars = Array.from(name);
  return chars.length >= 1 && chars.length <= MAX_AUTHOR_NAME_CHARS && !chars.some((c) => isControl(c) || isBidiControl(c)) && normalizePassageText(name) === name;
};

/** The standing a stored answer keeps: `{ state: "current", moved }` or `{ state: "stale", reason }`. */
export function readStanding(value) {
  if (!isObject(value) || Object.keys(value).length !== 2) return null;
  if (value.state === "current" && typeof value.moved === "boolean") return { state: "current", moved: value.moved };
  if (value.state === "stale" && STALE_REASONS.has(value.reason)) return { state: "stale", reason: value.reason };
  return null;
}

/**
 * Read an answer request from JSON text of at most MAX_JSON_BYTES:
 * `{version, kind, work, parent: {id, version}, body, responder: {contributor, author, standing},
 * binding: {participant}, actor}`. Returns { ok: true, request } (the text normalized) or
 * { ok: false, error: { code, message } }. The checks run in the build's order, so both report the
 * same first problem.
 */
export function readAuthorResponseRequest(text) {
  const source = String(text);
  if (utf8Length(source) > MAX_JSON_BYTES) return failure("tooLarge", `an author response is larger than ${MAX_JSON_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return malformed("an author response is not valid JSON");
  }
  if (isObject(value) && Number.isInteger(value.version) && value.version > AUTHOR_RESPONSE_VERSION) {
    return failure("unsupportedVersion", `this author response is version ${value.version}, newer than the version ${AUTHOR_RESPONSE_VERSION} this open.blog reads`);
  }
  if (!isObject(value) || value.version !== AUTHOR_RESPONSE_VERSION) return malformed("an author response needs `version` 1");
  const { parent, responder, binding } = value;
  const shaped =
    onlyFields(value, REQUEST_FIELDS) &&
    ["kind", "work", "body", "actor"].every((key) => typeof value[key] === "string") &&
    isObject(parent) && onlyFields(parent, ["id", "version"]) && typeof parent.id === "string" &&
    isObject(responder) && onlyFields(responder, ["contributor", "author", "standing"]) && typeof responder.contributor === "string" && typeof responder.author === "string" &&
    isObject(binding) && onlyFields(binding, ["participant"]) && typeof binding.participant === "string";
  if (!shaped) return malformed("an author response has a field this version does not define, or a field of the wrong type");
  if (value.kind !== AUTHOR_RESPONSE_KIND) return failure("wrongKind", "`kind` must be `author-response`");
  if (!isWorkPath(value.work)) return failure("invalidWork", "`work` must be the site-relative path of a published page, such as /posts/tides/");
  if (!UUID.test(parent.id) || !Number.isInteger(parent.version) || parent.version < 1 || parent.version > 2147483647) {
    return failure("invalidParent", "`parent` must name a Third Perspective by its id and version");
  }
  const body = normalizeReflection(value.body);
  if (body === null) return failure("invalidBody", "`body` must be 1 to 4000 characters of plain text");
  const standing = readStanding(responder.standing);
  if (standing === null) return failure("invalidResponder", "`responder.standing` must say current or stale with a known reason");
  if (!isContributorId(responder.contributor)) return failure("invalidResponder", "`responder.contributor` must be a contributor registry key");
  if (!isAuthorName(responder.author)) return failure("invalidResponder", "`responder.author` must be 1 to 80 characters of plain text");
  if (!isParticipantId(binding.participant)) return failure("invalidResponder", "`binding.participant` must be a participant id");
  if (!isAdminUsername(value.actor)) return failure("invalidActor", "`actor` must be an Admin account name");
  return {
    ok: true,
    request: Object.freeze({
      work: value.work,
      parent: Object.freeze({ id: parent.id.toLowerCase(), version: parent.version }),
      body,
      responder: Object.freeze({ contributor: responder.contributor, author: responder.author, standing, participant: binding.participant, account: value.actor }),
    }),
  };
}

/** The row's `details`: the public responder under `responder`, the private binding under `binding`. */
export const authorResponseDetails = (request) => ({
  parent: request.parent.id,
  responder: { contributor: request.responder.contributor, author: request.responder.author, standing: request.responder.standing },
  binding: { participant: request.responder.participant, account: request.responder.account },
});

/**
 * What a receiver keeps: the `openblog_feedback` row's columns. The passage revision and target are
 * the parent row's own, never the request's. Always pending; no reader name, no consent.
 */
export function receiveAuthorResponse(request, parent, receivedAt) {
  const details = authorResponseDetails(request);
  if (utf8Length(JSON.stringify(details)) > MAX_DETAILS_BYTES) throw new RangeError("an author response's details are too large");
  return {
    format_version: AUTHOR_RESPONSE_VERSION,
    kind: AUTHOR_RESPONSE_KIND,
    work: request.work,
    revision: parent.revision,
    target: parent.target,
    body: request.body,
    details,
    seen_at: null,
    received_at: receivedAt,
    channel: "hosted",
    reader_name: null,
    publish_name: false,
    clarification_consent: false,
  };
}

/**
 * The facts of a stored Third Perspective row an answer depends on (the build's `ParentFacts`), in
 * the camelCase shape the fixture uses. `row` is an `openblog_feedback` row.
 */
export function parentFactsOfRow(row) {
  const consents = Array.isArray(row?.details?.consents) ? row.details.consents : [];
  const approved = consents.find((record) => isObject(record) && record.number === row.approved_consent);
  return {
    kind: row.kind,
    work: row.work,
    state: row.status,
    revision: row.item_revision ?? 1,
    approvedRevision: row.approved_revision ?? null,
    clarificationAsked: row.clarification_asked ?? null,
    approvedConsentPublishes: approved?.publish === true,
    currentConsentPublishes: consents.at(-1)?.publish === true,
    retained: !row.purged_at,
    target: row.target,
  };
}

/** Whether a Third Perspective is shown to readers now: approved at its current text, kept, and both consents agree. */
export const parentIsShown = (facts) =>
  facts.retained === true &&
  facts.state === "approved" &&
  facts.approvedRevision === facts.revision &&
  facts.clarificationAsked !== facts.revision &&
  facts.approvedConsentPublishes === true &&
  facts.currentConsentPublishes === true;

/**
 * Whether an answer by `contributor` on `work` belongs under the perspective: it is a Third
 * Perspective of that work, shown now, about an attributed section of that very contributor.
 * Returns null when it does, or the code of the first reason it does not.
 */
export function checkAnswerParent(facts, work, contributor) {
  if (facts.kind !== "third-perspective" || !parentIsShown(facts)) return PARENT_UNAVAILABLE;
  if (facts.work !== work) return PARENT_WRONG_WORK;
  const attributed = readAttributedTarget(facts.target);
  if (attributed?.ok === true) return attributed.contributor === contributor ? null : PARENT_RESPONDER_MISMATCH;
  return PARENT_NOT_ATTRIBUTED;
}

/**
 * Whether `decider` may take `action` on an answer written by `account`: nobody approves their own
 * answer (ADR 0128). Taking one's own words down stays allowed.
 */
export const mayDecideResponse = (account, decider, action) => !(action === "approve" && typeof account === "string" && account === decider);
