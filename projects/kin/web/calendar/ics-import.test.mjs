// Importing a calendar file (#660): the plan before saving, re-imports by
// source UID, EXDATEs, overrides, cancelled events, and Undo's steps.
import test from "node:test";
import assert from "node:assert/strict";
import { importDoneText, importSummaryText, planImport } from "./ics-import.js";

const ZERO = "00".repeat(16);
const noFlags = { ruleUnsupported: false, zoneUnknown: false, cancelled: false, override: false, textShortened: false, spanShortened: false, exdatesDropped: false, noTitle: false };
const entry = (uid, title, date, extra = {}, flags = {}) => ({
  flags: { ...noFlags, ...flags }, master: null, original: null, exdates: [],
  event: {
    eventId: ZERO, title, place: "", notes: "", attendees: [], countdown: false, sourceUid: uid, allDay: true,
    start: { date, minute: 0 }, end: { date, minute: 0 }, zone: "", repeat: null, series: null,
  },
  ...extra,
});
const ids = () => { let next = 0; return () => (++next).toString(16).padStart(32, "0"); };
const types = (steps) => steps.map(({ command }) => `${command.type}${command.occurrence ? `@${command.occurrence.date}` : ""}${command.event ? `:${command.event.title}` : ""}`);

const file = {
  name: "Kids", skipped: 1, truncated: false,
  events: [
    entry("bins", "Bins", 20261005, { exdates: [{ date: 20261012, minute: 0 }] }),
    entry("bins", "Bins (Tuesday)", 20261020, { master: 0, original: { date: 20261019, minute: 0 } }, { override: true }),
    entry("party", "Party", 20261107),
    entry("old", "Old", 20261101, {}, { cancelled: true }),
  ],
};
file.events[0].event.repeat = { frequency: "weekly", interval: 1, weekdays: [0], weekStart: 0 };

test("a first import saves masters, cancels EXDATEs, links overrides and skips cancelled ones", () => {
  const plan = planImport(file, [], { newId: ids() });
  assert.deepEqual(types(plan.steps), [
    "save-calendar-event:Bins", "save-calendar-event:Party", "save-calendar-event:Bins (Tuesday)",
    "cancel-calendar-event@20261012", "cancel-calendar-event@20261019",
  ]);
  const override = plan.steps[2].command.event;
  assert.deepEqual(override.series, { seriesId: plan.steps[0].command.event.eventId, original: { date: 20261019, minute: 0 } });
  assert.equal(override.sourceUid, "bins");
  assert.deepEqual(plan.summary, { name: "Kids", total: 3, added: 3, updated: 0, unchanged: 0, cancelled: 0, restored: 0, skipped: 2, approximate: 1 });
  assert.equal(importSummaryText(plan.summary), "3 events from Kids: 3 new. 2 entries can't be imported and are left out. 1 event is simplified to fit Kin.");
  assert.equal(importDoneText(plan.summary), "Imported 3 events from Kids.");
  // Undo restores the cancels, then cancels the events; redo brings them back.
  assert.deepEqual(types(plan.undo), [
    "restore-calendar-event@20261019", "restore-calendar-event@20261012",
    "cancel-calendar-event", "cancel-calendar-event", "cancel-calendar-event",
  ]);
  assert.deepEqual(types(plan.redo).slice(0, 3), ["restore-calendar-event", "restore-calendar-event", "restore-calendar-event"]);
  assert.ok(plan.steps.slice(3).every((step) => step.optional), "cancels are optional");
});

test("importing again updates by source UID and never duplicates", () => {
  const first = planImport(file, [], { newId: ids() });
  const saved = first.steps.filter(({ command }) => command.type === "save-calendar-event").map(({ command }) => ({
    ...command.event, cancelled: false, cancelledThroughSeries: false,
    cancelledStarts: command.event.title === "Bins" ? [{ date: 20261012, minute: 0 }, { date: 20261019, minute: 0 }] : [],
  }));
  const again = planImport(file, saved, { newId: () => assert.fail("no new IDs") });
  assert.deepEqual(again.steps, [], "nothing changed, nothing to save");
  assert.equal(again.summary.unchanged, 3);
  assert.equal(importSummaryText(again.summary), "3 events from Kids: 3 already in Kin. 2 entries can't be imported and are left out. 1 event is simplified to fit Kin.");

  // The party moved; the old one is cancelled by the file now; one import
  // the family cancelled comes back.
  const changed = structuredClone(file);
  changed.events[2].event.start = { date: 20261108, minute: 0 };
  changed.events[2].event.end = { date: 20261108, minute: 0 };
  changed.events[3].flags.cancelled = true;
  const existing = [...saved, { ...saved[0], eventId: "ab".repeat(16), title: "Old", sourceUid: "old", repeat: null, cancelledStarts: [] }];
  existing[0] = { ...existing[0], cancelled: true };
  const plan = planImport(changed, existing, { newId: () => assert.fail("no new IDs") });
  assert.deepEqual(types(plan.steps), ["restore-calendar-event", "save-calendar-event:Party", "cancel-calendar-event"]);
  assert.equal(plan.steps[2].command.eventId, "ab".repeat(16));
  assert.deepEqual([plan.summary.restored, plan.summary.updated, plan.summary.cancelled, plan.summary.unchanged], [1, 1, 1, 1]);
  assert.deepEqual(types(plan.undo), ["restore-calendar-event", "save-calendar-event:Party", "cancel-calendar-event"]);
});
