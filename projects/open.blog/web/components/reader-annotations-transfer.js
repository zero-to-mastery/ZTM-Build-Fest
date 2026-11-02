// Export and import of the reader's local annotation document (ADRs 0237-0243).
//
// Pure functions: no DOM, no storage, no network. An export is the document of
// reader-annotations.js, notes left out unless asked for, and nothing else: no
// site settings, no page text beyond the quoted passages the reader chose. An
// import is read by the same validator as everything else, compared with what is
// saved, and planned before anything is written: the plan says what would be
// added, what is already there, what disagrees and what no longer matches its
// post. Nothing here repairs a file or repeats reader text in a message.

import {
  MAX_DOCUMENT_BYTES,
  assessAnnotations,
  exportDocument,
  readDocument,
  readDocumentJson,
  serializeDocument,
  workKey,
} from "./reader-annotations.js";

const clone = (value) => JSON.parse(JSON.stringify(value));

// Key order independent, so two records that say the same thing compare equal.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Size, in bytes, of the text the way the contract counts it. */
export const byteLength = (text) => new TextEncoder().encode(text).length;

/** The file name of an export: dated, plain, safe on every system. */
export const exportFileName = (date = new Date()) => `openblog-reading-trail-${date.toISOString().slice(0, 10)}.json`;

/** What a document holds, for telling the reader what will be (or is) kept or leave the browser. */
export function summarize(document) {
  const notes = document.annotations.filter((record) => record.kind === "note").length;
  return {
    highlights: document.annotations.length - notes,
    notes,
    sources: document.sources.length,
    trails: document.trails.length,
    reflections: document.reflections.length,
    steps: document.trails.reduce((total, trail) => total + trail.steps.length, 0),
    works: new Set(document.annotations.map((record) => workKey(record.work))).size,
  };
}

/**
 * The export file for a saved document. `notes` is false unless the reader asked for their own words to be
 * included. Returns { text, bytes, fileName, notes, omittedNotes, counts }. `omittedNotes` is how many notes
 * on a section or the whole post could not be kept as highlights and are therefore not in the file at all.
 */
export function buildExport(document, { notes = false, date = new Date() } = {}) {
  const made = exportDocument(document, { notes });
  const text = serializeDocument(made.document);
  return {
    text,
    bytes: byteLength(text),
    fileName: exportFileName(date),
    notes,
    omittedNotes: made.omittedNotes.length,
    omittedReflections: made.omittedReflections.length,
    counts: summarize(made.document),
  };
}

const PROBLEM_LIMIT = 8;

// The contract's problems, trimmed to what a reader can act on: a code and the record it names.
function problemsOf(list) {
  return {
    problems: list.slice(0, PROBLEM_LIMIT).map(({ code, object }) => ({ code, object })),
    moreProblems: Math.max(0, list.length - PROBLEM_LIMIT),
  };
}

const equivalent = (a, b) => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "source") {
    return (a.url !== undefined && a.url === b.url) || (a.work !== undefined && b.work !== undefined && workKey(a.work) === workKey(b.work));
  }
  if (a.kind === "trail") return false;
  if (a.kind === "reflection") {
    return workKey(a.work) === workKey(b.work) && a.createdAt === b.createdAt && a.text === b.text && a.revision === b.revision && stable(a.target) === stable(b.target);
  }
  return workKey(a.work) === workKey(b.work) && stable(a.target) === stable(b.target) && (a.text ?? null) === (b.text ?? null);
};

// What makes a record "the same record" apart from its dates.
const sameRecord = (a, b) => {
  // Where a reflection came from is about this device, not about the record, so it never makes two copies differ.
  const { createdAt: _c1, updatedAt: _u1, provenance: _p1, ...x } = a;
  const { createdAt: _c2, updatedAt: _u2, provenance: _p2, ...y } = b;
  return stable(x) === stable(y);
};

// A file that leaves notes out says nothing about the words the reader saved. For such a file a saved note
// and its highlight form are one record, and a missing `text` or a step to a record the file cannot hold is
// not a difference. `ids` are the ids the file holds.
const plain = (record, ids) => {
  const { createdAt: _c, updatedAt: _u, text: _t, ...rest } = record;
  if (rest.kind === "note") rest.kind = "highlight";
  if (rest.kind === "trail") rest.steps = rest.steps.filter((step) => ids.has(step.ref));
  return rest;
};
const sameWithoutNotes = (a, b, ids) => stable(plain(a, ids)) === stable(plain(b, ids));
const family = (kind) => (kind === "note" ? "highlight" : kind);

// The file's version of a record, with the reader's saved words carried over.
function keepSavedWords(existing, record, ids) {
  const out = clone(record);
  if (existing.text !== undefined) out.text = existing.text;
  if (existing.kind === "note" && record.kind === "highlight") out.kind = "note";
  if (record.kind === "trail") {
    const have = new Set(record.steps.map((step) => step.ref));
    const kept = existing.steps.filter((step) => have.has(step.ref) || !ids.has(step.ref));
    const keptRefs = new Set(kept.map((step) => step.ref));
    out.steps = [...kept, ...record.steps.filter((step) => !keptRefs.has(step.ref))].map((step) => clone(step));
  }
  return out;
}

const bucketOf = (record) =>
  record.kind === "source" ? "sources" : record.kind === "trail" ? "trails" : record.kind === "reflection" ? "reflections" : "annotations";

/**
 * Plan an import without changing anything. `text` is the file's text, `current` the saved document,
 * `choice` how to settle a record that has the same id but different content: "keep" (the default; what is
 * saved stays) or "file" (the file's version replaces it). `works` is the optional map of
 * work key to { revision, sections } the page can check passages against (only this post's own text is
 * known in the browser; the rest are reported as not yet checked).
 *
 * Returns { ok: false, problems, moreProblems } for a file that cannot be read, or
 *   { ok: true, document, text, counts, added, same, duplicates, conflicts, stale, unchecked, notes, changes }
 * where `document` is what would be saved, `text` its canonical form and `changes` is false when the
 * import would change nothing. A merge that would break a limit or rule is `ok: false` with the problem.
 */
export function planImport(current, text, { choice = "keep", works = {} } = {}) {
  const read = readDocumentJson(text);
  if (!read.ok) return { ok: false, ...problemsOf(read.problems) };
  const incoming = read.document;
  const omitted = incoming.privacy.notes === "omitted";
  const ids = new Set([...incoming.annotations, ...incoming.sources, ...incoming.trails, ...incoming.reflections].map((record) => record.id));

  const merged = clone(current);
  const byId = new Map();
  for (const record of [...merged.annotations, ...merged.sources, ...merged.trails, ...merged.reflections]) byId.set(record.id, record);
  const added = { annotations: 0, sources: 0, trails: 0, reflections: 0 };
  const same = { annotations: 0, sources: 0, trails: 0, reflections: 0 };
  const duplicates = [];
  const conflicts = [];
  const added_ = [];
  const remap = new Map();

  const settle = (record) => {
    const bucket = bucketOf(record);
    const existing = byId.get(record.id);
    if (existing) {
      if (omitted ? family(existing.kind) !== family(record.kind) : existing.kind !== record.kind) {
        // The same id names a different kind of record: nothing sensible merges them.
        conflicts.push({ id: record.id, kind: record.kind, differentKind: true });
        remap.set(record.id, null);
      } else if (omitted ? sameWithoutNotes(existing, record, ids) : sameRecord(existing, record)) {
        same[bucket] += 1;
        remap.set(record.id, record.id);
      } else {
        conflicts.push({ id: record.id, kind: record.kind });
        if (choice === "file") {
          const next = omitted ? keepSavedWords(existing, record, ids) : clone(record);
          if (next.kind === "reflection") next.provenance = "imported";
          merged[bucket][merged[bucket].indexOf(existing)] = next;
          byId.set(record.id, next);
          added_.push(next);
        }
        remap.set(record.id, record.id);
      }
      return;
    }
    const twin = [...byId.values()].find((each) => equivalent(each, record));
    if (twin) {
      duplicates.push({ id: record.id, kind: record.kind, of: twin.id });
      remap.set(record.id, twin.id);
      return;
    }
    // A reflection that arrives in a file says so, whatever the file said about where it came from.
    const fresh = record.kind === "reflection" ? { ...clone(record), provenance: "imported" } : clone(record);
    merged[bucket].push(fresh);
    byId.set(record.id, fresh);
    added[bucket] += 1;
    added_.push(fresh);
    remap.set(record.id, record.id);
  };

  for (const record of incoming.annotations) settle(record);
  for (const record of incoming.sources) settle(record);
  // A reflection follows an earlier one in the terms of the records it can now reach; earliest first so the earlier is settled.
  const inOrder = incoming.reflections.map((record, order) => ({ record, order })).sort((a, b) => (a.record.createdAt < b.record.createdAt ? -1 : a.record.createdAt > b.record.createdAt ? 1 : a.order - b.order));
  for (const { record } of inOrder) {
    const { revises, ...rest } = record;
    const follows = revises === undefined ? undefined : remap.get(revises);
    settle(follows ? { ...rest, revises: follows } : rest);
  }
  // A trail's steps are written in terms of the records it can now reach.
  for (const trail of incoming.trails) {
    const steps = [];
    for (const step of trail.steps) {
      const ref = remap.get(step.ref);
      if (ref && !steps.some((each) => each.ref === ref)) steps.push({ ref });
    }
    settle({ ...trail, steps });
  }
  merged.privacy = { scope: "reader-private", notes: "included" };

  const checked = readDocument(merged);
  if (!checked.ok) return { ok: false, ...problemsOf(checked.problems) };

  const touching = added_.filter((record) => record.kind === "highlight" || record.kind === "note" || record.kind === "reflection");
  const known = touching.filter((record) => works[workKey(record.work)]);
  const states = assessAnnotations({ annotations: known }, works);
  const stale = states.filter((each) => each.state === "stale").map(({ id, reason }) => ({ id, reason }));
  const reanchored = states.filter((each) => each.state === "reanchored").length;

  const out = serializeDocument(checked.document);
  const changes = out !== serializeDocument(current);
  return {
    ok: true,
    document: checked.document,
    text: out,
    bytes: byteLength(out),
    counts: summarize(checked.document),
    added,
    same,
    duplicates,
    conflicts,
    stale,
    reanchored,
    unchecked: touching.length - known.length,
    notes: incoming.privacy.notes,
    changes,
  };
}

/** The size, in bytes, the importer will read. A bigger file is refused before it is read. */
export const MAX_IMPORT_BYTES = MAX_DOCUMENT_BYTES;
