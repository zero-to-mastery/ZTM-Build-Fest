// The reader's own annotation document in the reader's own browser (ADRs 0237-0243).
//
// Pure functions over the validated document of reader-annotations.js, and a
// storage seam that never throws. Reading a post never needs storage: when the
// browser denies it, is full, or holds something this code cannot read, the
// store says so and the page keeps working with what is in memory. A saved
// document that cannot be read is never overwritten, so a failure leaves the
// browser's data exactly as it was.

import { MAX_DOCUMENT_BYTES, MAX_TITLE_CHARS, createDocument, readDocument, readDocumentJson, serializeDocument } from "./reader-annotations.js";

export const STORAGE_KEY = "openblog.reader-annotations";

/**
 * Fired on `window` by every component that changes the saved document, with `detail.from` the element
 * that changed it, so the others read it again. (Another tab's change arrives as the browser's `storage` event.)
 */
export const CHANGED_EVENT = "openblog:reader-data-changed";

/**
 * Read the saved document. Returns { status, document } where status is
 * "empty" (nothing saved, a new document), "ok", "unreadable" (something is
 * saved and is not a valid document; it is left alone) or "blocked" (the
 * browser gives no storage). `storage` is a function returning a Storage, so
 * a denied property access is caught here.
 */
export function readStore(storage) {
  let text;
  try {
    text = storage()?.getItem(STORAGE_KEY);
  } catch {
    return { status: "blocked", document: createDocument() };
  }
  if (text === undefined) return { status: "blocked", document: createDocument() };
  if (text === null) return { status: "empty", document: createDocument() };
  const read = readDocumentJson(text);
  return read.ok ? { status: "ok", document: read.document } : { status: "unreadable", document: createDocument(), problems: read.problems };
}

/**
 * Save a valid document. Returns { ok: true } or { ok: false, reason } where reason is "blocked" (storage
 * denied) or "full" (the browser's quota, or the document's own size limit). Nothing is changed on failure.
 */
export function writeStore(storage, document) {
  const text = serializeDocument(document);
  if (new TextEncoder().encode(text).length > MAX_DOCUMENT_BYTES) return { ok: false, reason: "full" };
  let area;
  try {
    area = storage();
  } catch {
    return { ok: false, reason: "blocked" };
  }
  if (!area) return { ok: false, reason: "blocked" };
  try {
    area.setItem(STORAGE_KEY, text);
    return { ok: true };
  } catch (error) {
    const quota = error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014);
    return { ok: false, reason: quota ? "full" : "blocked" };
  }
}

/** The time in the contract's one form: UTC, whole seconds. */
export const timestamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh id, a lowercase slug no record of the document uses. */
export function newId(document, prefix, random = Math.random) {
  const taken = new Set([...document.annotations, ...document.sources, ...document.trails, ...document.reflections].map((record) => record.id));
  for (;;) {
    let body = "";
    for (let i = 0; i < 10; i += 1) body += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
    const id = `${prefix}-${body}`;
    if (!taken.has(id)) return id;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// Whatever a change produces is checked by the contract before anyone keeps it.
function checked(value) {
  const read = readDocument(value);
  return read.ok ? { ok: true, document: read.document } : { ok: false, problem: read.problems[0] };
}

/**
 * Add a highlight (no `text`) or a note (`text`) on a work. `target` is a valid passage target, `revision` the
 * revision of the page the reader read. Returns { ok: true, document, id } or { ok: false, problem }.
 */
export function addAnnotation(document, { work, revision, target, text, now = timestamp(), random }) {
  const id = newId(document, text === undefined ? "hl" : "note", random);
  const record = { id, kind: text === undefined ? "highlight" : "note", work, revision, target };
  if (text !== undefined) record.text = text;
  record.createdAt = now;
  record.updatedAt = now;
  const next = clone(document);
  next.annotations.push(record);
  const result = checked(next);
  return result.ok ? { ...result, id } : result;
}

/**
 * Set the note on a highlight (it becomes a note) or replace a note's text. The record keeps its id, work, target,
 * revision and creation time. Returns { ok: true, document } or { ok: false, problem }.
 */
export function setNoteText(document, id, text, now = timestamp()) {
  const next = clone(document);
  const record = next.annotations.find((each) => each.id === id);
  if (!record) return { ok: false, problem: { code: "missing", object: "document", message: "that annotation is no longer saved" } };
  record.kind = "note";
  record.text = text;
  record.updatedAt = now < record.createdAt ? record.createdAt : now;
  return checked(next);
}

/** Delete every annotation on one work and the trail steps that named them. */
export function deleteWorkAnnotations(document, work) {
  const gone = new Set(annotationsOf(document, work).map((record) => record.id));
  if (gone.size === 0) return { ok: false, problem: { code: "missing", object: "document", message: "nothing is saved on that work" } };
  const next = clone(document);
  next.annotations = next.annotations.filter((record) => !gone.has(record.id));
  for (const trail of next.trails) trail.steps = trail.steps.filter((step) => !gone.has(step.ref));
  return checked(next);
}

/** Delete an annotation and the trail steps that named it. */
export function deleteAnnotation(document, id) {
  const next = clone(document);
  if (!next.annotations.some((each) => each.id === id)) {
    return { ok: false, problem: { code: "missing", object: "document", message: "that annotation is no longer saved" } };
  }
  next.annotations = next.annotations.filter((each) => each.id !== id);
  for (const trail of next.trails) trail.steps = trail.steps.filter((step) => step.ref !== id);
  return checked(next);
}

/** The annotations of one work, in the order the reader made them. */
export const annotationsOf = (document, work) =>
  document.annotations.filter((record) => record.work.site === work.site && record.work.path === work.path);

// ---------------------------------------------------------------------------
// Saved sources and reading trails (ADR 0242). The same rules as above: a change is
// built from a copy, checked by the contract, and only then kept.
// ---------------------------------------------------------------------------

const missing = (what) => ({ ok: false, problem: { code: "missing", object: "document", message: `that ${what} is no longer saved` } });
const touched = (record, now) => {
  record.updatedAt = now < record.createdAt ? record.createdAt : now;
};

// Control and text-direction characters, the ones the contract refuses in a title.
const unfit = (character) => {
  const point = character.codePointAt(0);
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f) || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
};

/**
 * Text made fit for a title: control and text-direction characters become spaces, runs of white space one
 * space, and anything past the contract's length is cut with an ellipsis. A title is only ever a page's own
 * words, so this changes how long and how plain they are, never what they say.
 */
export function fitTitle(text, max = MAX_TITLE_CHARS) {
  const raw = String(text ?? "");
  const well = typeof raw.toWellFormed === "function" ? raw.toWellFormed() : raw;
  const plain = Array.from(well, (character) => (unfit(character) ? " " : character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const list = Array.from(plain);
  return list.length > max ? `${list.slice(0, max - 1).join("").trimEnd()}…` : plain;
}

const sameWork = (a, b) => a !== undefined && b !== undefined && a.site === b.site && a.path === b.path;

/** The saved source for a link or a work, if there is one. */
export const findSource = (document, { url, work }) =>
  document.sources.find((source) => (url !== undefined && source.url === url) || (work !== undefined && sameWork(source.work, work))) ?? null;

/**
 * Save a source: a title and exactly one of `url` (an outside link) or `work` (a published post), with an optional
 * `from`, the work the reader found a linked source in. A source already saved is not saved twice. Returns
 * { ok: true, document, id } or { ok: false, problem } (code "alreadySaved" carries the existing id).
 */
export function saveSource(document, { title, url, work, from, text, now = timestamp(), random }) {
  const existing = findSource(document, { url, work });
  if (existing) return { ok: false, problem: { code: "alreadySaved", object: "document", message: "that source is already saved", id: existing.id } };
  const id = newId(document, "src", random);
  const record = { id, kind: "source", title };
  if (url !== undefined) record.url = url;
  if (work !== undefined) record.work = work;
  if (from !== undefined) record.from = from;
  if (text !== undefined) record.text = text;
  record.createdAt = now;
  record.updatedAt = now;
  const next = clone(document);
  next.sources.push(record);
  const result = checked(next);
  return result.ok ? { ...result, id } : result;
}

/** Delete a saved source and the trail steps that named it. */
export function deleteSource(document, id) {
  if (!document.sources.some((each) => each.id === id)) return missing("source");
  const next = clone(document);
  next.sources = next.sources.filter((each) => each.id !== id);
  for (const trail of next.trails) trail.steps = trail.steps.filter((step) => step.ref !== id);
  return checked(next);
}

/** Start a trail with no steps. Returns { ok: true, document, id } or { ok: false, problem }. */
export function createTrail(document, { title, now = timestamp(), random }) {
  const id = newId(document, "trail", random);
  const next = clone(document);
  next.trails.push({ id, kind: "trail", title, steps: [], createdAt: now, updatedAt: now });
  const result = checked(next);
  return result.ok ? { ...result, id } : result;
}

/** Delete a trail. The annotations and sources it named are kept. */
export function deleteTrail(document, id) {
  if (!document.trails.some((each) => each.id === id)) return missing("trail");
  const next = clone(document);
  next.trails = next.trails.filter((each) => each.id !== id);
  return checked(next);
}

/** Add an annotation or saved source to the end of a trail. A record is in a trail once ("duplicateStep"). */
export function addTrailStep(document, trailId, ref, now = timestamp()) {
  const next = clone(document);
  const trail = next.trails.find((each) => each.id === trailId);
  if (!trail) return missing("trail");
  trail.steps.push({ ref });
  touched(trail, now);
  return checked(next);
}

/** Take one step out of a trail, keeping the record it named. */
export function removeTrailStep(document, trailId, ref, now = timestamp()) {
  const next = clone(document);
  const trail = next.trails.find((each) => each.id === trailId);
  if (!trail || !trail.steps.some((step) => step.ref === ref)) return missing("trail step");
  trail.steps = trail.steps.filter((step) => step.ref !== ref);
  touched(trail, now);
  return checked(next);
}

/** Move a step one place earlier (`by` below 0) or later. A step at an end stays where it is. */
export function moveTrailStep(document, trailId, ref, by, now = timestamp()) {
  const next = clone(document);
  const trail = next.trails.find((each) => each.id === trailId);
  const from = trail ? trail.steps.findIndex((step) => step.ref === ref) : -1;
  if (from < 0) return missing("trail step");
  const to = from + (by < 0 ? -1 : 1);
  if (to < 0 || to >= trail.steps.length) return checked(next);
  [trail.steps[from], trail.steps[to]] = [trail.steps[to], trail.steps[from]];
  touched(trail, now);
  return checked(next);
}

/** Any record of the document by id, or null. */
export const recordById = (document, id) =>
  [...document.annotations, ...document.sources, ...document.trails, ...document.reflections].find((record) => record.id === id) ?? null;

const newestFirst = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.order - a.order);

/** Trails most recently changed first; equal times put the one made later first. */
export const recentTrails = (document) =>
  document.trails
    .map((trail, order) => ({ trail, order, at: trail.updatedAt }))
    .sort(newestFirst)
    .map(({ trail }) => trail);

/**
 * The works the reader has annotated, most recently annotated first:
 * [{ work, highlights, notes, updatedAt }]. A work is its site and path (ADR 0238).
 */
export function annotatedWorks(document) {
  const byWork = new Map();
  document.annotations.forEach((record, order) => {
    const key = `${record.work.site}${record.work.path}`;
    const entry = byWork.get(key) ?? { work: record.work, highlights: 0, notes: 0, at: record.updatedAt, order };
    if (record.kind === "note") entry.notes += 1;
    else entry.highlights += 1;
    if (record.updatedAt > entry.at) entry.at = record.updatedAt;
    entry.order = order;
    byWork.set(key, entry);
  });
  return Array.from(byWork.values())
    .sort(newestFirst)
    .map(({ work, highlights, notes, at }) => ({ work, highlights, notes, updatedAt: at }));
}

/**
 * Apply `change` (a function from the freshest saved document to a result of the functions above) and keep it.
 * Unlike the page's own annotations, the organizer keeps nothing in memory only: if the change cannot be
 * saved, nothing changed anywhere. Returns { ok: true, document, ...rest } or
 * { ok: false, reason: "blocked" | "unreadable" | "full" | "problem", problem? }.
 * Unreadable saved data is never overwritten.
 */
export function commitStore(storage, change) {
  const read = readStore(storage);
  if (read.status === "blocked") return { ok: false, reason: "blocked" };
  if (read.status === "unreadable") return { ok: false, reason: "unreadable" };
  const result = change(read.document);
  if (!result.ok) return { ok: false, reason: "problem", problem: result.problem };
  const written = writeStore(storage, result.document);
  return written.ok ? result : { ok: false, reason: written.reason };
}

/**
 * Remove everything saved under the key: every annotation, source and trail, readable or not. Returns
 * { ok: true } or { ok: false, reason: "blocked" }.
 */
export function clearStore(storage) {
  try {
    const area = storage();
    if (!area) return { ok: false, reason: "blocked" };
    area.removeItem(STORAGE_KEY);
    // A store that quietly keeps its data has not been cleared.
    return area.getItem(STORAGE_KEY) === null ? { ok: true } : { ok: false, reason: "blocked" };
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

// ---------------------------------------------------------------------------
// Turning the feature off, and showing what is saved (ADR 0243).
// ---------------------------------------------------------------------------

/** The one other key this feature writes: present when the reader turned highlights, notes and trails off here. */
export const DISABLED_KEY = "openblog.reader-annotations.off";

/** True when the reader turned the feature off in this browser. Unreadable storage counts as not off. */
export function isDisabled(storage) {
  try {
    return storage()?.getItem(DISABLED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Turn the feature off or on. Saved data is not touched. Returns { ok: true } or { ok: false, reason: "blocked" }. */
export function setDisabled(storage, off) {
  try {
    const area = storage();
    if (!area) return { ok: false, reason: "blocked" };
    if (off) area.setItem(DISABLED_KEY, "1");
    else area.removeItem(DISABLED_KEY);
    return isDisabled(storage) === Boolean(off) ? { ok: true } : { ok: false, reason: "blocked" };
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

/**
 * Every key this feature has in the browser's storage (the document and the off switch), so a reader and a
 * test can check an erase really emptied it. Returns null when storage cannot be listed.
 */
export function savedKeys(storage) {
  try {
    const area = storage();
    if (!area) return null;
    const found = [];
    for (let i = 0; i < area.length; i += 1) {
      const key = area.key(i);
      if (key === STORAGE_KEY || key === DISABLED_KEY || (typeof key === "string" && key.startsWith(`${STORAGE_KEY}.`))) found.push(key);
    }
    return found.sort();
  } catch {
    return null;
  }
}
