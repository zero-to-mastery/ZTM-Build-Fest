// The reader's private interpretation history (ADR 0244, docs/specs/reader-annotations.md).
//
// A reflection is a snapshot of how the reader read a work or one section of it
// at one time: the reader's own words, a label they chose, the revision of the
// page they read, and a link to the earlier snapshot it revises. Snapshots live
// in the reader-annotation document (ADR 0237) beside highlights and notes, so
// they share its storage, size limits, validation, export and erase. They are
// never public. A snapshot's words never change after it is made; a new reading
// is a new snapshot. Whether the target still matches the page is derived each
// time, never stored (ADR 0238).
//
// Sending a reflection is a separate, explicit act. `prepareSubmissionCopy`
// builds a bounded copy in the Third Perspective form (ADR 0113) from the
// snapshot and the reader's own consent, and returns it; the snapshot is not
// changed, converted or marked by it. `markSubmitted` records, after the reader
// sent the copy, that they did: the local original stays local.
//
// Pure functions: no DOM, no storage, no network.

import { assessAnnotations, readDocument, workKey, REFLECTION_PROVENANCE, MAX_REFLECTIONS, MAX_SUBMISSIONS, SUBMISSION_CHANNELS } from "./reader-annotations.js";
import { newId, timestamp } from "./reader-annotations-store.js";
import { readThirdPerspectiveSubmissionJson, thirdPerspectiveSubmissionValue } from "./third-perspective.js";

export { REFLECTION_PROVENANCE, MAX_REFLECTIONS, MAX_SUBMISSIONS, SUBMISSION_CHANNELS };

const clone = (value) => JSON.parse(JSON.stringify(value));

const missing = () => ({ ok: false, problem: { code: "missing", object: "document", message: "that reflection is no longer saved" } });

// Whatever a change produces is checked by the contract before anyone keeps it.
function checked(value) {
  const read = readDocument(value);
  return read.ok ? { ok: true, document: read.document } : { ok: false, problem: read.problems[0] };
}

const sameWork = (a, b) => a.site === b.site && a.path === b.path;

/**
 * Keep a new reflection: a snapshot of the reader's reading of a work (target kind work) or one of its sections.
 * `revision` is the revision of the page the reader read. `label` is optional and the reader's own. `revises`
 * names the earlier snapshot this one follows. Returns { ok: true, document, id } or { ok: false, problem }.
 */
export function addReflection(document, { work, revision, target, text, label, revises, now = timestamp(), random }) {
  const id = newId(document, "refl", random);
  const record = { id, kind: "reflection", work, revision, target };
  if (label !== undefined) record.label = label;
  record.text = text;
  record.provenance = "written";
  if (revises !== undefined) record.revises = revises;
  record.createdAt = now;
  record.updatedAt = now;
  const next = clone(document);
  next.reflections.push(record);
  const result = checked(next);
  return result.ok ? { ...result, id } : result;
}

/**
 * Keep a later reading as a new snapshot that follows `earlierId`, on the same work. The earlier snapshot is not
 * touched. A target left out is the earlier one's. Returns { ok: true, document, id } or
 * { ok: false, problem } (code "alreadyRevised" when a later reading already follows it).
 */
export function reviseReflection(document, earlierId, { revision, target, text, label, now = timestamp(), random }) {
  const earlier = document.reflections.find((each) => each.id === earlierId);
  if (!earlier) return missing();
  if (document.reflections.some((each) => each.revises === earlierId)) {
    return { ok: false, problem: { code: "alreadyRevised", object: "document", message: "a later reading already follows that one; revise the latest" } };
  }
  return addReflection(document, { work: earlier.work, revision, target: target ?? earlier.target, text, label, revises: earlierId, now, random });
}

/** Set, change or (with no label) remove a snapshot's label. Its words, revision and target stay. */
export function relabelReflection(document, id, label, now = timestamp()) {
  const next = clone(document);
  const record = next.reflections.find((each) => each.id === id);
  if (!record) return missing();
  if (label === undefined) delete record.label;
  else record.label = label;
  record.updatedAt = now < record.createdAt ? record.createdAt : now;
  return checked(next);
}

/**
 * Delete one snapshot. A snapshot that followed it now follows what it followed, so a history stays one line.
 * Copies already sent are not touched, since they are not in this document.
 */
export function deleteReflection(document, id) {
  const next = clone(document);
  const doomed = next.reflections.find((each) => each.id === id);
  if (!doomed) return missing();
  for (const each of next.reflections) {
    if (each.revises === id) {
      if (doomed.revises === undefined) delete each.revises;
      else each.revises = doomed.revises;
    }
  }
  next.reflections = next.reflections.filter((each) => each.id !== id);
  return checked(next);
}

/** Delete every snapshot on one work. */
export function deleteWorkReflections(document, work) {
  const next = clone(document);
  const before = next.reflections.length;
  next.reflections = next.reflections.filter((each) => !sameWork(each.work, work));
  if (next.reflections.length === before) return missing();
  return checked(next);
}

/** The snapshots of one work, in the order the reader made them. */
export const reflectionsOf = (document, work) => document.reflections.filter((record) => sameWork(record.work, work));

/**
 * The histories on one work: each a line of snapshots from the earliest to the latest reading, a history per
 * snapshot that follows none. Lines start in the order their first snapshots were made.
 */
export function reflectionHistories(document, work) {
  const all = reflectionsOf(document, work);
  const next = new Map(all.filter((record) => record.revises !== undefined).map((record) => [record.revises, record]));
  return all
    .filter((record) => record.revises === undefined || !all.some((each) => each.id === record.revises))
    .map((root) => {
      const line = [root];
      for (let follower = next.get(root.id); follower; follower = next.get(follower.id)) line.push(follower);
      return line;
    });
}

/**
 * Where each snapshot stands against the works' published text, as `assessAnnotations` does for a highlight
 * (current, reanchored or stale, with the reason), plus `articleChanged`: true when the page's revision is no longer
 * the one the reader read, false when it is, and null when the work cannot be loaded. A snapshot of a work that
 * changed is never rewritten; this is only told to the reader beside it. Nothing is stored.
 */
export function assessReflections(document, works) {
  const states = assessAnnotations({ annotations: document.reflections }, works);
  return states.map((state, index) => {
    const published = works[workKey(document.reflections[index].work)];
    return { ...state, articleChanged: published ? published.revision !== document.reflections[index].revision : null };
  });
}

/**
 * Record that the reader sent a copy of a snapshot, by `channel` ("hosted" or "copy-and-send"). Call it only after
 * the reader sent the copy. It adds a line to the snapshot's list of submissions and nothing else: the words, label
 * and everything private stay, and the snapshot is not public. Returns { ok: true, document } or { ok: false, problem }.
 */
export function markSubmitted(document, id, { channel, now = timestamp() }) {
  const next = clone(document);
  const record = next.reflections.find((each) => each.id === id);
  if (!record) return missing();
  record.submissions = [...(record.submissions ?? []), { at: now < record.createdAt ? record.createdAt : now, channel }];
  record.updatedAt = record.submissions.at(-1).at > record.updatedAt ? record.submissions.at(-1).at : record.updatedAt;
  return checked(next);
}

/**
 * Prepare, without sending or storing anything, a bounded copy of one snapshot as a Third Perspective submission
 * (ADR 0113), for the page it was written on (`site`). The copy holds the work's path, the revision the reader read,
 * the target, the words, and what the reader says here: an optional response `category`, an optional `name` and
 * whether it may be shown, and `consent`, which must say `publish: true` because the copy is offered for public
 * consideration (it stays pending until a moderator approves that exact text). Not in the copy: the snapshot's id,
 * label, provenance, history, submissions, dates, or any other snapshot or note. A snapshot on another site, a
 * quotation target, or a body over the limit is refused with the same code the submission reader gives.
 * Returns { ok: true, submission, value, text } or { ok: false, error: { code, message } }.
 */
export function prepareSubmissionCopy(document, id, { site, category, name, publishName, consent } = {}) {
  const record = document.reflections.find((each) => each.id === id);
  if (!record) return { ok: false, error: { code: "missing", message: "that reflection is no longer saved" } };
  if (record.work.site !== site) {
    return { ok: false, error: { code: "otherSite", message: "a reflection can only be submitted to the site it was written on" } };
  }
  if (!consent || consent.publish !== true) {
    return { ok: false, error: { code: "publicationConsentRequired", message: "submitting offers a copy for publication; the reader must agree to that" } };
  }
  const draft = {
    version: 1,
    kind: "third-perspective",
    work: record.work.path,
    revision: record.revision,
    target: clone(record.target),
    body: record.text,
    consent: { publish: true, clarification: consent.clarification === true, feature: consent.feature === true },
  };
  if (category !== undefined && category !== null) draft.category = category;
  if (name !== undefined || publishName !== undefined) draft.attribution = { ...(name === undefined ? {} : { name }), publishName: publishName === true };
  const read = readThirdPerspectiveSubmissionJson(JSON.stringify(draft));
  if (!read.ok) return read;
  const value = thirdPerspectiveSubmissionValue(read.submission);
  return { ok: true, submission: read.submission, value, text: JSON.stringify(value) };
}
