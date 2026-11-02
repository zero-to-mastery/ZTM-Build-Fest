// Importing a calendar file (#660 with #666, ADR 0022 §3): what saving an
// .ics file's events would do, worked out before anything is saved, so the
// person sees a count first. Pure: no DOM, no storage.
//
// The engine parses the file on this device (`parseICalendar`, KICS). Each
// event is then an ordinary household change:
// - an event (a "master") is saved as kind 71 with its source UID; an
//   earlier import of the same UID gets the same event ID, so importing
//   the file again updates rather than duplicates, and an unchanged event
//   isn't saved at all (Rust refuses a save that changes nothing);
// - its EXDATEs cancel those occurrences (kind 72);
// - an override (RECURRENCE-ID) is saved as its own event linked to its
//   master's occurrence, which is cancelled (the engine's "change one
//   occurrence");
// - an event the file marks cancelled cancels an earlier import of it, and
//   is otherwise left out;
// - an earlier import the household cancelled as a whole comes back:
//   importing the file again is asking for it.
// Cancels the engine may refuse (an EXDATE that isn't a real occurrence,
// one already cancelled elsewhere) are optional steps: skipped, not fatal.
//
// The plan also carries the steps that undo and redo the import as a whole
// (web/undo.js "calendar" entries).
import { decodeCalendarEventPayload, encodeCalendarEventPayload } from "../wasm/kin-calendar.js";

const masterKey = (uid) => `m\u0000${uid}`;
const overrideKey = (uid, original) => `o\u0000${uid}\u0000${original.date}:${original.minute}`;

/** An event as saved, without KCAL's cancellation fields. */
export function savedEvent(event) {
  const { cancelled, cancelledThroughSeries, cancelledStarts, ...rest } = event;
  return rest;
}

/** Whether two events would save as the same bytes. */
export function sameEvent(left, right) {
  try {
    const a = encodeCalendarEventPayload(savedEvent(left)), b = encodeCalendarEventPayload(savedEvent(right));
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  } catch {
    return false;
  }
}

/** Round-trips an event through its canonical bytes (text trimmed as Rust
 * keeps it), so comparisons see what Rust would. */
function canonical(event) {
  return decodeCalendarEventPayload(encodeCalendarEventPayload(event));
}

const same = (a, b) => a.date === b.date && a.minute === b.minute;

/**
 * The plan for importing `parsed` (decodeICalendar) into a household whose
 * events are `existing` (KCAL with allEvents: events with cancelled and
 * cancelledStarts). `newId()` makes a new event ID (32 hex).
 *
 * Returns { steps, undo, redo, eventIds, summary } where each step is
 * { command, optional } and summary is { name, total, added, updated,
 * unchanged, cancelled, restored, skipped, approximate }.
 */
export function planImport(parsed, existing, { newId }) {
  const byKey = new Map();
  for (const event of existing ?? []) {
    if (!event.sourceUid) continue;
    const key = event.series ? overrideKey(event.sourceUid, event.series.original) : masterKey(event.sourceUid);
    if (!byKey.has(key)) byKey.set(key, event);
  }
  const steps = [], undo = [], redo = [], eventIds = new Set();
  const summary = { name: parsed?.name ?? "", total: 0, added: 0, updated: 0, unchanged: 0, cancelled: 0, restored: 0, skipped: parsed?.skipped ?? 0, approximate: 0 };
  const ids = new Array(parsed?.events?.length ?? 0).fill(null);
  const seen = new Set();
  // Cancels of a master's occurrences, after every master is saved.
  const cancels = [];
  const cancelOccurrence = (eventId, occurrence, known) => {
    if (known?.cancelledStarts?.some((start) => same(start, occurrence))) return;
    cancels.push({ eventId, occurrence });
  };

  const handle = (entry, index, key, series) => {
    const prior = byKey.get(key) ?? null;
    if (seen.has(key)) { summary.skipped += 1; return null; }
    seen.add(key);
    if (entry.flags.cancelled) {
      if (prior && !prior.cancelled) {
        steps.push({ command: { type: "cancel-calendar-event", eventId: prior.eventId, occurrence: null }, optional: true });
        undo.push({ command: { type: "restore-calendar-event", eventId: prior.eventId, occurrence: null }, optional: true });
        redo.push({ command: { type: "cancel-calendar-event", eventId: prior.eventId, occurrence: null }, optional: true });
        eventIds.add(prior.eventId);
        summary.cancelled += 1;
      } else summary.skipped += 1;
      return null;
    }
    const eventId = prior?.eventId ?? newId();
    let event;
    try { event = canonical({ ...entry.event, eventId, series }); } catch { summary.skipped += 1; return null; }
    summary.total += 1;
    if (Object.values(entry.flags).some(Boolean)) summary.approximate += 1;
    eventIds.add(eventId);
    const save = { command: { type: "save-calendar-event", event }, optional: Boolean(series) };
    if (!prior) {
      summary.added += 1;
      steps.push(save);
      undo.push({ command: { type: "cancel-calendar-event", eventId, occurrence: null }, optional: true });
      redo.push({ command: { type: "restore-calendar-event", eventId, occurrence: null }, optional: true });
      return { eventId, prior };
    }
    const changed = !sameEvent(prior, event);
    if (prior.cancelled) {
      summary.restored += 1;
      const restore = { command: { type: "restore-calendar-event", eventId, occurrence: null }, optional: true };
      steps.push(restore);
      redo.push(restore);
      // `undo` is reversed at the end: undoing saves the old version back
      // while the event shows, then cancels it again.
      undo.push({ command: { type: "cancel-calendar-event", eventId, occurrence: null }, optional: true });
      if (changed) {
        steps.push(save);
        redo.push(save);
        undo.push({ command: { type: "save-calendar-event", event: savedEvent(prior) }, optional: true });
      }
      return { eventId, prior };
    }
    if (!changed) { summary.unchanged += 1; return { eventId, prior }; }
    summary.updated += 1;
    steps.push(save);
    redo.push(save);
    undo.push({ command: { type: "save-calendar-event", event: savedEvent(prior) }, optional: true });
    return { eventId, prior };
  };

  // Masters first: an override links to its master's ID.
  (parsed?.events ?? []).forEach((entry, index) => {
    if (entry.master !== null) return;
    const done = handle(entry, index, masterKey(entry.event.sourceUid || `#${index}`), null);
    if (!done) return;
    ids[index] = done.eventId;
    for (const occurrence of entry.exdates) cancelOccurrence(done.eventId, occurrence, done.prior);
  });
  (parsed?.events ?? []).forEach((entry, index) => {
    if (entry.master === null) return;
    const seriesId = ids[entry.master];
    if (!seriesId) { summary.skipped += 1; return; }
    const uid = entry.event.sourceUid || parsed.events[entry.master].event.sourceUid || `#${entry.master}`;
    const done = handle(entry, index, overrideKey(uid, entry.original), { seriesId, original: entry.original });
    if (!done) return;
    ids[index] = done.eventId;
    const master = byKey.get(masterKey(uid));
    cancelOccurrence(seriesId, entry.original, master);
  });
  for (const { eventId, occurrence } of cancels) {
    const cancel = { command: { type: "cancel-calendar-event", eventId, occurrence }, optional: true };
    steps.push(cancel);
    redo.push(cancel);
    undo.push({ command: { type: "restore-calendar-event", eventId, occurrence }, optional: true });
  }
  return { steps, undo: undo.reverse(), redo, eventIds: [...eventIds], summary };
}

/** The preview line before saving: "12 events from Kids: 10 new, 2
 * changed." */
export function importSummaryText(summary) {
  const parts = [];
  if (summary.added) parts.push(`${summary.added} new`);
  if (summary.updated) parts.push(`${summary.updated} changed`);
  if (summary.restored) parts.push(`${summary.restored} brought back`);
  if (summary.unchanged) parts.push(`${summary.unchanged} already in Kin`);
  if (summary.cancelled) parts.push(`${summary.cancelled} cancelled`);
  const count = summary.total + summary.cancelled;
  const from = summary.name ? ` from ${summary.name}` : "";
  const head = count === 1 ? `1 event${from}` : `${count} events${from}`;
  let text = parts.length ? `${head}: ${parts.join(", ")}.` : `No events${from} to import.`;
  if (summary.skipped) text += summary.skipped === 1 ? " 1 entry can't be imported and is left out." : ` ${summary.skipped} entries can't be imported and are left out.`;
  if (summary.approximate) text += summary.approximate === 1 ? " 1 event is simplified to fit Kin." : ` ${summary.approximate} events are simplified to fit Kin.`;
  return text;
}

/** The status line after importing: "Imported 12 events from Kids." */
export function importDoneText(summary) {
  const count = summary.added + summary.updated + summary.restored + summary.cancelled;
  const from = summary.name ? ` from ${summary.name}` : "";
  return count === 1 ? `Imported 1 event${from}.` : `Imported ${count} events${from}.`;
}

/** How many household changes the plan saves. */
export function changeCount(plan) {
  return plan.steps.length;
}
