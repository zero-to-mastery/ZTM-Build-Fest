// Read-only occurrences from outside the household history (#668, ADR 0022
// §3): the seam between whatever supplies them (today, synced calendars,
// web/calendar/feed-refresh.js) and the Calendar's views (#660), which draw
// them beside the household's own events.
//
// A supplier calls `setExternalOccurrences(sourceId, occurrences, meta)`
// with every occurrence of one source in the window it covers
// (`externalWindow(today)`: a month back and a year ahead), replacing what
// that source had; `removeExternalOccurrences(sourceId)` when the source
// goes; `clearExternalOccurrences()` on lock. Each occurrence is
// { sourceId, key, title, place, notes, allDay, start: { date, minute },
// end: { date, minute }, zone, label, readOnly: true }, with dates as
// YYYYMMDD in the event's own zone (feed-expand.js), like the household's
// own occurrences from kin-calendar.js decodeCalendarRange.
//
// A view reads `externalOccurrences(from, to)` and listens with
// `onExternalOccurrences(listener)` to redraw when a source changes. It
// shows `label` ("From Google") beside each one and offers no editing:
// these never enter the household history, so there is nothing to change.
//
// Everything here is decrypted content held in memory only, for the
// unlocked session; it is cleared when Kin locks.
import { civilFromDay } from "./feed-expand.js";
import { dayNumber, isCalendarDate } from "../wasm/kin-calendar.js";

/** Days back and ahead of today that a supplier covers. Together at most
 * 400 days, the longest calendar read (kin-calendar.js MAX_RANGE_DAYS). */
export const EXTERNAL_DAYS_BACK = 31;
export const EXTERNAL_DAYS_AHEAD = 366;

const sources = new Map();
const listeners = new Set();

/** The civil dates a supplier covers around `today` (YYYYMMDD). */
export function externalWindow(today) {
  const day = dayNumber(today);
  return { from: civilFromDay(day - EXTERNAL_DAYS_BACK), to: civilFromDay(day + EXTERNAL_DAYS_AHEAD) };
}

function changed(sourceId) {
  for (const listener of [...listeners]) {
    try { listener({ sourceId }); } catch { /* one view's failure doesn't stop the others */ }
  }
}

/** Replaces `sourceId`'s occurrences. `meta`: { label, name, window,
 * fetchedAt, stale } for the views and the settings page. */
export function setExternalOccurrences(sourceId, occurrences, meta = {}) {
  if (typeof sourceId !== "string" || !sourceId) throw new TypeError("An external source needs an ID.");
  const list = Array.isArray(occurrences) ? occurrences.filter((occurrence) => occurrence && isCalendarDate(occurrence.start?.date)) : [];
  sources.set(sourceId, { occurrences: Object.freeze(list.map((occurrence) => Object.freeze({ ...occurrence, sourceId, readOnly: true }))), meta: Object.freeze({ ...meta }) });
  changed(sourceId);
}

export function removeExternalOccurrences(sourceId) {
  if (sources.delete(sourceId)) changed(sourceId);
}

export function clearExternalOccurrences() {
  const had = [...sources.keys()];
  sources.clear();
  for (const sourceId of had) changed(sourceId);
}

/** Every source's occurrences overlapping `from`..`to`, sorted by start. */
export function externalOccurrences(from, to) {
  if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) return [];
  const out = [];
  for (const { occurrences } of sources.values())
    for (const occurrence of occurrences) if (occurrence.start.date <= to && occurrence.end.date >= from) out.push(occurrence);
  return out.sort((a, b) => a.start.date - b.start.date || a.start.minute - b.start.minute);
}

/** [{ sourceId, count, ...meta }] for each source. */
export function externalSources() {
  return [...sources].map(([sourceId, { occurrences, meta }]) => ({ ...meta, sourceId, count: occurrences.length }));
}

/** Calls `listener({ sourceId })` whenever a source changes; returns the
 * function that stops it. */
export function onExternalOccurrences(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The same functions as one object, for a view that takes a `calendar`
 * dependency: `calendar.setExternalOccurrences(sourceId, list)`. */
export const externalCalendar = Object.freeze({
  setExternalOccurrences, removeExternalOccurrences, clearExternalOccurrences, externalOccurrences, externalSources,
  onExternalOccurrences, externalWindow,
});
