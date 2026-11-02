// The reader-annotation contract (ADRs 0237-0240, docs/specs/reader-annotations.md).
//
// A reader's highlights, private notes, saved sources and reading trails live in
// one versioned document kept in that reader's own browser. This module defines
// the document, validates it and exports it. It is dependency-free, never
// touches the DOM, storage or the network, and every function is pure: inputs are
// never changed, results are frozen, and a failure is returned as a value that
// names the object at fault and never repeats the reader's text.
//
// Annotations are reader-owned. They share nothing with the author's research
// notebook (ADR 0034): other id space, other file, other format name. A highlight
// points at published text with a passage target (ADR 0076) and resolves as
// current, reanchored or stale (ADR 0077); this module never re-derives passage
// text, revisions or digests, which the build publishes.

import { readTarget, resolveTarget } from "./passage-target.js";

export const FORMAT = "openblog.reader-annotations";
export const READER_ANNOTATIONS_VERSION = 2;
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ANNOTATIONS = 2000;
export const MAX_SOURCES = 500;
export const MAX_TRAILS = 50;
export const MAX_TRAIL_STEPS = 200;
export const MAX_REFLECTIONS = 500;
export const MAX_SUBMISSIONS = 20;
export const MAX_NOTE_CHARS = 10_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_URL_CHARS = 2048;
export const MAX_PATH_CHARS = 512;
export const MAX_ID_CHARS = 64;

const DOCUMENT_FIELDS = new Set(["format", "version", "privacy", "annotations", "sources", "trails", "reflections"]);
const REFLECTION_FIELDS = new Set(["id", "kind", "work", "revision", "target", "label", "text", "provenance", "revises", "submissions", "createdAt", "updatedAt"]);
const SUBMISSION_FIELDS = new Set(["at", "channel"]);
const PRIVACY_FIELDS = new Set(["scope", "notes"]);
const ANNOTATION_FIELDS = new Set(["id", "kind", "work", "revision", "target", "text", "createdAt", "updatedAt"]);
const WORK_FIELDS = new Set(["site", "path"]);
const SOURCE_FIELDS = new Set(["id", "kind", "title", "url", "work", "from", "text", "createdAt", "updatedAt"]);
const TRAIL_FIELDS = new Set(["id", "kind", "title", "text", "steps", "createdAt", "updatedAt"]);
const STEP_FIELDS = new Set(["ref"]);

export const ANNOTATION_KINDS = Object.freeze(["highlight", "note"]);
/** How a reflection snapshot came to be on this device (ADR 0244). */
export const REFLECTION_PROVENANCE = Object.freeze(["written", "imported"]);
/** How a reader sent a copy: to the site's service, or by copying the text to send themselves (ADR 0113). */
export const SUBMISSION_CHANNELS = Object.freeze(["hosted", "copy-and-send"]);

const failure = (code, object, message) => ({ ok: false, error: { code, object, message } });
const problem = (code, object, message) => ({ code, object, message });

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const chars = (text) => Array.from(text);

const isControl = (character) => {
  const point = character.codePointAt(0);
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
};
const isBidi = (character) => {
  const point = character.codePointAt(0);
  return (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
};
const hasLoneSurrogate = (text) =>
  chars(text).some((character) => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);

const unknownField = (value, allowed, object) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return problem("unknownField", object, "an unknown field is present");
  }
  return null;
};

// Free text a reader typed: kept exactly (no trimming or normalization), but
// never with control characters other than newline and tab, never with a
// bidirectional override that would make it display differently from what it
// says, never with a lone surrogate.
function checkFreeText(object, field, value, max, { required }) {
  if (typeof value !== "string") return problem("malformed", object, `\`${field}\` must be text`);
  const list = chars(value);
  if (required && list.length === 0) return problem("emptyText", object, `\`${field}\` must not be empty`);
  if (list.length > max) return problem("textTooLong", object, `\`${field}\` is longer than ${max} characters`);
  if (hasLoneSurrogate(value) || list.some((c) => isBidi(c) || (isControl(c) && c !== "\n" && c !== "\t"))) {
    return problem("forbiddenCharacter", object, `\`${field}\` holds a control or text-direction character`);
  }
  return null;
}

function checkTitle(object, value, { required }) {
  if (typeof value !== "string") return problem("malformed", object, "`title` must be text");
  const list = chars(value);
  if (required && list.length === 0) return problem("emptyText", object, "`title` must not be empty");
  if (list.length > MAX_TITLE_CHARS) return problem("textTooLong", object, `\`title\` is longer than ${MAX_TITLE_CHARS} characters`);
  if (hasLoneSurrogate(value) || list.some((c) => isBidi(c) || isControl(c))) {
    return problem("forbiddenCharacter", object, "`title` holds a control or text-direction character");
  }
  return null;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function checkId(object, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS || !ID_PATTERN.test(value)) {
    return problem("invalidId", object, `\`id\` must be a lowercase slug of 1 to ${MAX_ID_CHARS} characters`);
  }
  return null;
}

// RFC 3339 in UTC with whole seconds: the one form, so dates sort as text and
// round trip byte for byte.
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
function checkTimestamp(object, field, value) {
  const match = typeof value === "string" ? TIMESTAMP.exec(value) : null;
  if (!match) return problem("invalidTimestamp", object, `\`${field}\` must be a UTC time like 2026-10-27T09:30:00Z`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const exact =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
  return exact ? null : problem("invalidTimestamp", object, `\`${field}\` is not a real date and time`);
}

function checkTimes(object, value) {
  return (
    checkTimestamp(object, "createdAt", value.createdAt) ||
    checkTimestamp(object, "updatedAt", value.updatedAt) ||
    (value.updatedAt < value.createdAt ? problem("timeOrder", object, "`updatedAt` is before `createdAt`") : null)
  );
}

const REVISION = /^p[0-9]+:[0-9a-f]{32}$/;

/**
 * The site identity: an http(s) origin with no credentials, path, query or
 * fragment, written the way the URL parser writes it. Returns the canonical
 * origin or null.
 */
export function canonicalSite(value) {
  if (typeof value !== "string" || value.length > MAX_URL_CHARS) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin === value ? url.origin : null;
}

// A work's path on its site: absolute, already canonical, no query or fragment,
// no dot segments, no encoded separators or traversal.
function pathProblem(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return "must start with a single /";
  if (chars(path).length > MAX_PATH_CHARS) return `is longer than ${MAX_PATH_CHARS} characters`;
  if (/[?#\\\s]/u.test(path) || chars(path).some((c) => isControl(c) || isBidi(c))) return "holds a character a path may not";
  if (/%(?:2e|2f|5c|00)/i.test(path)) return "holds an encoded separator or dot";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return "holds a dot segment";
  try {
    if (new URL(path, "https://example.invalid").pathname !== path) return "is not written in canonical form";
  } catch {
    return "is not a path";
  }
  return null;
}

function checkWork(object, value) {
  if (!isPlainObject(value)) return problem("malformed", object, "`work` must be an object");
  const unknown = unknownField(value, WORK_FIELDS, object);
  if (unknown) return unknown;
  if (canonicalSite(value.site) === null) {
    return problem("invalidSite", object, "`work.site` must be an http(s) origin such as https://example.com");
  }
  const bad = pathProblem(value.path);
  return bad ? problem("invalidPath", object, `\`work.path\` ${bad}`) : null;
}

/** The identity of a work across sites and revisions: its site origin plus its path. */
export const workKey = (work) => `${work.site}${work.path}`;

// A saved source's link: http(s) only, no credentials, canonical as written.
function checkUrl(object, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) {
    return problem("invalidUrl", object, `\`url\` must be an http(s) link of at most ${MAX_URL_CHARS} characters`);
  }
  if (chars(value).some((c) => isControl(c) || isBidi(c) || c === " ")) {
    return problem("invalidUrl", object, "`url` holds a space, control or text-direction character");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return problem("invalidUrl", object, "`url` is not a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return problem("unsafeScheme", object, "`url` must use http or https");
  }
  if (url.username || url.password) return problem("invalidUrl", object, "`url` must not carry credentials");
  if (url.href !== value) return problem("invalidUrl", object, "`url` is not written in canonical form");
  return null;
}

function checkAnnotation(value, index) {
  const object = `annotations[${index}]`;
  if (!isPlainObject(value)) return problem("malformed", object, "an annotation must be an object");
  const unknown = unknownField(value, ANNOTATION_FIELDS, object);
  if (unknown) return unknown;
  const idProblem = checkId(object, value.id);
  if (idProblem) return idProblem;
  const named = `annotations[${index}] (${value.id})`;
  if (!ANNOTATION_KINDS.includes(value.kind)) return problem("unknownKind", named, "`kind` must be highlight or note");
  const workProblem = checkWork(named, value.work);
  if (workProblem) return workProblem;
  if (typeof value.revision !== "string" || !REVISION.test(value.revision)) {
    return problem("invalidRevision", named, "`revision` must be the passage revision the reader saw, like p1:<32 hex digits>");
  }
  const read = readTarget(value.target);
  if (!read.ok) return problem(read.error.code, named, `\`target\` is not a passage target: ${read.error.message}`);
  if (value.kind === "highlight") {
    if (read.target.kind !== "quote") return problem("wrongTarget", named, "a highlight must quote text");
    if (value.text !== undefined) return problem("unexpectedText", named, "a highlight has no `text`; a note does");
  } else {
    const textProblem = checkFreeText(named, "text", value.text, MAX_NOTE_CHARS, { required: true });
    if (textProblem) return textProblem;
  }
  return checkTimes(named, value);
}

function checkReflection(value, index) {
  const object = `reflections[${index}]`;
  if (!isPlainObject(value)) return problem("malformed", object, "a reflection must be an object");
  const unknown = unknownField(value, REFLECTION_FIELDS, object);
  if (unknown) return unknown;
  const idProblem = checkId(object, value.id);
  if (idProblem) return idProblem;
  const named = `reflections[${index}] (${value.id})`;
  if (value.kind !== "reflection") return problem("unknownKind", named, "`kind` must be reflection");
  const workProblem = checkWork(named, value.work);
  if (workProblem) return workProblem;
  if (typeof value.revision !== "string" || !REVISION.test(value.revision)) {
    return problem("invalidRevision", named, "`revision` must be the passage revision the reader saw, like p1:<32 hex digits>");
  }
  const read = readTarget(value.target);
  if (!read.ok) return problem(read.error.code, named, `\`target\` is not a passage target: ${read.error.message}`);
  if (value.label !== undefined) {
    const labelProblem = checkTitle(named, value.label, { required: true });
    if (labelProblem) return { ...labelProblem, message: labelProblem.message.replace("`title`", "`label`") };
  }
  const textProblem = checkFreeText(named, "text", value.text, MAX_NOTE_CHARS, { required: true });
  if (textProblem) return textProblem;
  if (!REFLECTION_PROVENANCE.includes(value.provenance)) return problem("invalidProvenance", named, "`provenance` must be written or imported");
  if (value.revises !== undefined) {
    const revisesProblem = checkId(named, value.revises);
    if (revisesProblem) return revisesProblem;
    if (value.revises === value.id) return problem("invalidRevises", named, "a reflection cannot revise itself");
  }
  if (value.submissions !== undefined) {
    if (!Array.isArray(value.submissions)) return problem("malformed", named, "`submissions` must be a list");
    if (value.submissions.length === 0) return problem("malformed", named, "`submissions` is left out when nothing was submitted");
    if (value.submissions.length > MAX_SUBMISSIONS) return problem("tooMany", named, `a reflection records at most ${MAX_SUBMISSIONS} submissions`);
    for (const [position, each] of value.submissions.entries()) {
      const at = `${named}.submissions[${position}]`;
      if (!isPlainObject(each)) return problem("malformed", at, "a submission record must be an object");
      const eachUnknown = unknownField(each, SUBMISSION_FIELDS, at);
      if (eachUnknown) return eachUnknown;
      if (!SUBMISSION_CHANNELS.includes(each.channel)) return problem("invalidChannel", at, "`channel` must be hosted or copy-and-send");
      const stamp = checkTimestamp(at, "at", each.at);
      if (stamp) return stamp;
      if (each.at < value.createdAt) return problem("timeOrder", at, "a submission is recorded before the reflection was made");
    }
  }
  return checkTimes(named, value);
}

// Every `revises` names an earlier reflection on the same work, and each reflection is revised at most once: a history is a line.
function checkHistories(reflections) {
  const problems = [];
  const byId = new Map(reflections.map((record) => [record.id, record]));
  const revised = new Set();
  for (const [index, record] of reflections.entries()) {
    if (record.revises === undefined) continue;
    const named = `reflections[${index}] (${record.id})`;
    const earlier = byId.get(record.revises);
    if (!earlier) {
      problems.push(problem("danglingRef", named, "`revises` names a reflection that is not in this document"));
      continue;
    }
    if (workKey(earlier.work) !== workKey(record.work)) problems.push(problem("invalidRevises", named, "a reflection can only revise one about the same work"));
    else if (earlier.createdAt > record.createdAt) problems.push(problem("timeOrder", named, "a reflection cannot revise one made after it"));
    if (revised.has(record.revises)) problems.push(problem("branchedHistory", named, "an earlier reflection is already revised by another; a history is one line"));
    else revised.add(record.revises);
  }
  return problems;
}

function checkSource(value, index) {
  const object = `sources[${index}]`;
  if (!isPlainObject(value)) return problem("malformed", object, "a saved source must be an object");
  const unknown = unknownField(value, SOURCE_FIELDS, object);
  if (unknown) return unknown;
  const idProblem = checkId(object, value.id);
  if (idProblem) return idProblem;
  const named = `sources[${index}] (${value.id})`;
  if (value.kind !== "source") return problem("unknownKind", named, "`kind` must be source");
  const titleProblem = checkTitle(named, value.title, { required: true });
  if (titleProblem) return titleProblem;
  if ((value.url === undefined) === (value.work === undefined)) {
    return problem("invalidSource", named, "a saved source names exactly one of `url` or `work`");
  }
  const where = value.url !== undefined ? checkUrl(named, value.url) : checkWork(named, value.work);
  if (where) return where;
  // Where the reader found a linked source: the work that cited it. A source that is itself a work needs none.
  if (value.from !== undefined) {
    if (value.url === undefined) return problem("invalidSource", named, "`from` belongs to a source with a `url`; a source that is a `work` has no other origin");
    const fromProblem = checkWork(named, value.from);
    if (fromProblem) return fromProblem;
  }
  if (value.text !== undefined) {
    const textProblem = checkFreeText(named, "text", value.text, MAX_NOTE_CHARS, { required: false });
    if (textProblem) return textProblem;
  }
  return checkTimes(named, value);
}

function checkTrail(value, index, known) {
  const object = `trails[${index}]`;
  if (!isPlainObject(value)) return problem("malformed", object, "a trail must be an object");
  const unknown = unknownField(value, TRAIL_FIELDS, object);
  if (unknown) return unknown;
  const idProblem = checkId(object, value.id);
  if (idProblem) return idProblem;
  const named = `trails[${index}] (${value.id})`;
  if (value.kind !== "trail") return problem("unknownKind", named, "`kind` must be trail");
  const titleProblem = checkTitle(named, value.title, { required: true });
  if (titleProblem) return titleProblem;
  if (value.text !== undefined) {
    const textProblem = checkFreeText(named, "text", value.text, MAX_NOTE_CHARS, { required: false });
    if (textProblem) return textProblem;
  }
  if (!Array.isArray(value.steps)) return problem("malformed", named, "`steps` must be a list");
  if (value.steps.length > MAX_TRAIL_STEPS) return problem("tooMany", named, `a trail has at most ${MAX_TRAIL_STEPS} steps`);
  const seen = new Set();
  for (const [position, step] of value.steps.entries()) {
    const at = `${named}.steps[${position}]`;
    if (!isPlainObject(step)) return problem("malformed", at, "a step must be an object");
    const stepUnknown = unknownField(step, STEP_FIELDS, at);
    if (stepUnknown) return stepUnknown;
    if (typeof step.ref !== "string" || !known.has(step.ref)) return problem("danglingRef", at, "a step names a record that is not in this document");
    if (seen.has(step.ref)) return problem("duplicateStep", at, "a record appears twice in one trail");
    seen.add(step.ref);
  }
  return checkTimes(named, value);
}

function checkPrivacy(value) {
  if (!isPlainObject(value)) return problem("malformed", "privacy", "`privacy` must be an object");
  const unknown = unknownField(value, PRIVACY_FIELDS, "privacy");
  if (unknown) return unknown;
  if (value.scope !== "reader-private") {
    return problem("invalidPrivacy", "privacy", "`privacy.scope` must be reader-private: annotations are never public");
  }
  if (value.notes !== "included" && value.notes !== "omitted") {
    return problem("invalidPrivacy", "privacy", "`privacy.notes` must be included or omitted");
  }
  return null;
}

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Check a parsed document. Returns { ok: true, document, problems: [] } with a
 * new frozen copy, or { ok: false, problems } listing every problem, each as
 * { code, object, message } where `object` names the record at fault (such as
 * "annotations[2] (quote-1)"). The value passed in is never changed and nothing
 * is repaired; a caller that finds problems keeps what it had.
 */
export function readDocument(value) {
  if (!isPlainObject(value)) return { ok: false, problems: [problem("malformed", "document", "the document must be an object")] };
  if (value.format !== FORMAT) {
    return { ok: false, problems: [problem("wrongFormat", "document", `\`format\` must be ${FORMAT}; this is not a reader-annotation document`)] };
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    return { ok: false, problems: [problem("malformed", "document", "`version` must be a whole number from 1")] };
  }
  if (value.version > READER_ANNOTATIONS_VERSION) {
    return { ok: false, problems: [problem("unsupportedVersion", "document", "this document is newer than this site understands")] };
  }
  // Version 1 had no reflections; it is read as version 2 with none (migration, ADR 0244).
  const legacy = value.version < READER_ANNOTATIONS_VERSION;
  const unknown = unknownField(value, DOCUMENT_FIELDS, "document");
  if (unknown) return { ok: false, problems: [unknown] };
  if (legacy && Object.hasOwn(value, "reflections")) {
    return { ok: false, problems: [problem("unknownField", "document", "an unknown field is present")] };
  }
  if (legacy) value = { ...value, version: READER_ANNOTATIONS_VERSION, reflections: [] };
  for (const field of ["annotations", "sources", "trails", "reflections"]) {
    if (!Array.isArray(value[field])) return { ok: false, problems: [problem("malformed", "document", `\`${field}\` must be a list`)] };
  }
  const limits = [
    ["annotations", MAX_ANNOTATIONS],
    ["sources", MAX_SOURCES],
    ["trails", MAX_TRAILS],
    ["reflections", MAX_REFLECTIONS],
  ];
  for (const [field, max] of limits) {
    if (value[field].length > max) return { ok: false, problems: [problem("tooMany", "document", `\`${field}\` holds more than ${max} records`)] };
  }
  const problems = [];
  const privacy = checkPrivacy(value.privacy);
  if (privacy) problems.push(privacy);

  const ids = new Map();
  const claim = (record, object) => {
    if (isPlainObject(record) && typeof record.id === "string") {
      if (ids.has(record.id)) problems.push(problem("duplicateId", object, "this id is already used by another record"));
      else ids.set(record.id, object);
    }
  };
  value.annotations.forEach((record, index) => claim(record, `annotations[${index}]`));
  value.sources.forEach((record, index) => claim(record, `sources[${index}]`));
  value.trails.forEach((record, index) => claim(record, `trails[${index}]`));
  value.reflections.forEach((record, index) => claim(record, `reflections[${index}]`));

  value.annotations.forEach((record, index) => {
    const found = checkAnnotation(record, index);
    if (found) problems.push(found);
  });
  value.sources.forEach((record, index) => {
    const found = checkSource(record, index);
    if (found) problems.push(found);
  });
  value.reflections.forEach((record, index) => {
    const found = checkReflection(record, index);
    if (found) problems.push(found);
  });
  // Histories are only checked once every reflection is well formed.
  if (problems.length === 0) problems.push(...checkHistories(value.reflections));
  // A trail may name annotations and sources, never another trail.
  const stepTargets = new Set([...value.annotations, ...value.sources].map((record) => isPlainObject(record) && record.id).filter(Boolean));
  value.trails.forEach((record, index) => {
    const found = checkTrail(record, index, stepTargets);
    if (found) problems.push(found);
  });
  if (value.privacy && value.privacy.notes === "omitted") {
    const holdsText =
      value.reflections.length > 0 ||
      [...value.annotations, ...value.sources, ...value.trails].some((record) => isPlainObject(record) && record.text !== undefined);
    if (holdsText) problems.push(problem("privacyMismatch", "privacy", "`privacy.notes` says notes are omitted but note text is present"));
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, document: deepFreeze(clone(value)), problems: [] };
}

/**
 * Read a document from JSON text. The size is counted in UTF-8 bytes before
 * the text is parsed.
 */
export function readDocumentJson(text) {
  if (typeof text !== "string") return { ok: false, problems: [problem("malformed", "document", "the document must be text")] };
  if (new TextEncoder().encode(text).length > MAX_DOCUMENT_BYTES) {
    return { ok: false, problems: [problem("tooLarge", "document", `the document is larger than ${MAX_DOCUMENT_BYTES} bytes`)] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problems: [problem("malformed", "document", "the document is not valid JSON")] };
  }
  return readDocument(parsed);
}

/**
 * Bring a document of any supported version to the current one. Version 1 is
 * the only version, so this is a validation that returns the same result as
 * readDocument; a later version adds its step here and fixtures for it.
 */
export function migrateDocument(value) {
  return readDocument(value);
}

/** A new, empty document. */
export function createDocument() {
  return deepFreeze({
    format: FORMAT,
    version: READER_ANNOTATIONS_VERSION,
    privacy: { scope: "reader-private", notes: "included" },
    annotations: [],
    sources: [],
    trails: [],
    reflections: [],
  });
}

/** Canonical JSON for a valid document: stable field order, two-space indent, trailing newline. */
export function serializeDocument(document) {
  const ordered = (record, order) => Object.fromEntries(order.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
  const work = (record) => (record === undefined ? undefined : ordered(record, ["site", "path"]));
  const body = {
    format: document.format,
    version: document.version,
    privacy: ordered(document.privacy, ["scope", "notes"]),
    annotations: document.annotations.map((a) => ({
      ...ordered(a, ["id", "kind", "work", "revision", "target", "text", "createdAt", "updatedAt"]),
      work: work(a.work),
    })),
    sources: document.sources.map((s) => ({
      ...ordered(s, ["id", "kind", "title", "url", "work", "from", "text", "createdAt", "updatedAt"]),
      ...(s.work === undefined ? {} : { work: work(s.work) }),
      ...(s.from === undefined ? {} : { from: work(s.from) }),
    })),
    trails: document.trails.map((t) => ordered(t, ["id", "kind", "title", "text", "steps", "createdAt", "updatedAt"])),
    reflections: document.reflections.map((r) => ({
      ...ordered(r, ["id", "kind", "work", "revision", "target", "label", "text", "provenance", "revises", "submissions", "createdAt", "updatedAt"]),
      work: work(r.work),
      ...(r.submissions === undefined ? {} : { submissions: r.submissions.map((each) => ordered(each, ["at", "channel"])) }),
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Build an export from a valid document, as { document, omittedNotes }. The default leaves out every note's
 * text, a saved source's note and a trail's note; { notes: true } keeps them.
 * The result says which, in `privacy.notes`, so a file shows its own scope. It
 * always holds the quoted text of highlights, so it is private reader data
 * (`privacy.scope`) in every form; open.blog never publishes it. Highlights stay
 * as highlights; a note with its text left out is kept as a highlight of its
 * target only when that target quotes text, otherwise it is dropped and counted.
 */
export function exportDocument(document, { notes = false } = {}) {
  if (notes) {
    return deepFreeze({ document: { ...clone(document), privacy: { scope: "reader-private", notes: "included" } }, omittedNotes: [], omittedReflections: [] });
  }
  const dropped = [];
  const annotations = [];
  for (const record of document.annotations) {
    if (record.kind === "highlight") {
      annotations.push(clone(record));
    } else if (record.target.kind === "quote") {
      const { text, ...rest } = clone(record);
      annotations.push({ ...rest, kind: "highlight" });
    } else {
      dropped.push(record.id);
    }
  }
  const keep = new Set([...annotations, ...document.sources].map((record) => record.id));
  const strip = ({ text, ...rest }) => rest;
  const sources = document.sources.map((record) => strip(clone(record)));
  const trails = document.trails.map((record) => ({
    ...strip(clone(record)),
    steps: record.steps.filter((step) => keep.has(step.ref)),
  }));
  return deepFreeze({
    document: {
      format: FORMAT,
      version: document.version,
      privacy: { scope: "reader-private", notes: "omitted" },
      annotations,
      sources,
      trails,
      // A reflection is nothing but the reader's own words, so the default export holds none (ADR 0244).
      reflections: [],
    },
    omittedNotes: dropped,
    omittedReflections: document.reflections.map((record) => record.id),
  });
}

/**
 * Where each annotation stands against one work's published passage text:
 * current, reanchored or stale, with the reason (ADR 0077). `works` maps a
 * work key (site origin plus path) to { revision, sections } as the build
 * publishes it; a work that is not in the map is reported stale with the
 * reason "workUnavailable", never dropped. Nothing is stored or changed:
 * state is derived each time, so it can never be out of date.
 */
export function assessAnnotations(document, works) {
  return document.annotations.map((record) => {
    const published = works[workKey(record.work)];
    if (!published) return { id: record.id, state: "stale", reason: "workUnavailable", sectionPresent: false };
    const read = readTarget(record.target);
    if (!read.ok) return { id: record.id, state: "stale", reason: "targetInvalid", sectionPresent: false };
    return { id: record.id, ...resolveTarget(read.target, published, record.revision) };
  });
}
