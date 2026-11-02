// The sitter page's pure parts (#441): tap-to-call numbers and joining the
// page's entries with the projection. No DOM, no storage.

// A value that is a phone number: digits with the usual separators.
const PHONE = /^\+?[\d\s().-]{6,24}$/;

/** A `tel:` href for a phone-like value, or null. */
export function phoneHref(value) {
  const text = String(value ?? "").trim();
  if (!PHONE.test(text) || (text.match(/\d/g)?.length ?? 0) < 6) return null;
  return `tel:${text.replace(/[^\d+]/g, "")}`;
}

/** The page's entries joined with the projection: `[{ kind, id, record }]`
 * for records that still exist and aren't archived. */
export function resolveEntries(page, state) {
  const sources = {
    note: new Map((state?.notes ?? []).filter((note) => !note.archived).map((note) => [note.noteId, note])),
    "reference-record": new Map((state?.referenceRecords ?? []).filter((record) => !record.archived).map((record) => [record.recordId, record])),
    routine: new Map((state?.routines ?? []).filter((routine) => routine.status !== "archived").map((routine) => [routine.routineId, routine])),
  };
  return (page?.entries ?? []).map((entry) => ({ ...entry, record: sources[entry.kind]?.get(entry.id) ?? null })).filter((entry) => entry.record);
}
