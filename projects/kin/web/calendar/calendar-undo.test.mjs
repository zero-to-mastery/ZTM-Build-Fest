// Undo and redo of calendar changes (#662; web/undo.js "calendar" entries).
import test from "node:test";
import assert from "node:assert/strict";
import { UndoHistory, calendarEntry, calendarEventMark, calendarInverse, calendarMarks, calendarReversalStatus, describeReversal } from "../undo.js";

const event = (title, extra = {}) => ({ eventId: "aa".repeat(16), title, repeat: null, cancelled: false, cancelledThroughSeries: false, cancelledStarts: [], ...extra });
const range = (events, colours = []) => ({ events, colours: new Map(colours) });

test("marks change with the event, its cancels and colours", () => {
  const swim = event("Swim");
  assert.equal(calendarEventMark(null), null);
  assert.notEqual(calendarEventMark(swim), calendarEventMark(event("Swim later")));
  assert.notEqual(calendarEventMark(swim), calendarEventMark(event("Swim", { cancelledStarts: [{ date: 20261006, minute: 0 }] })));
  assert.equal(calendarEventMark(event("Swim", { cancelledStarts: [{ date: 2, minute: 0 }, { date: 1, minute: 0 }] })),
    calendarEventMark(event("Swim", { cancelledStarts: [{ date: 1, minute: 0 }, { date: 2, minute: 0 }] })), "cancel order doesn't matter");
  const marks = calendarMarks(range([swim], [["bb".repeat(16), 4]]));
  assert.equal(marks.get(`colour:${"bb".repeat(16)}`), "4");
});

test("an entry runs while nothing changed since, and its inverse swaps the steps", () => {
  const swim = event("Swim");
  const steps = { undo: [{ command: { type: "cancel-calendar-event", eventId: swim.eventId, occurrence: null }, optional: true }],
    redo: [{ command: { type: "restore-calendar-event", eventId: swim.eventId, occurrence: null }, optional: true }] };
  const entry = calendarEntry({ label: "add “Swim”", ...steps, keys: [swim.eventId], marks: calendarMarks(range([swim])) });
  assert.equal(calendarReversalStatus(entry, calendarMarks(range([swim]))), "ready");
  assert.equal(calendarReversalStatus(entry, calendarMarks(range([event("Swim at 6")]))), "conflict", "changed on another device");
  assert.equal(calendarReversalStatus(entry, calendarMarks(range([]))), "gone");
  const cancelled = event("Swim", { cancelled: true });
  const inverse = calendarInverse(entry, calendarMarks(range([cancelled])));
  assert.deepEqual(inverse.steps, steps.redo);
  assert.deepEqual(inverse.back, steps.undo);
  assert.equal(calendarReversalStatus(inverse, calendarMarks(range([cancelled]))), "ready");
  assert.equal(describeReversal(entry, "undo", "done"), "Undone: add “Swim”.");
  // A run that stopped part-way resumes without checking again.
  entry.next = 1;
  assert.equal(calendarReversalStatus(entry, calendarMarks(range([event("Other")]))), "ready");
  const history = new UndoHistory();
  history.record(entry);
  assert.equal(history.take("undo"), entry);
});

test("a colour back at Kin's choice matches an entry that expects none", () => {
  const me = "cc".repeat(16);
  const entry = calendarEntry({ label: "change your calendar colour", undo: [], redo: [], keys: [`colour:${me}`], marks: new Map() });
  assert.equal(calendarReversalStatus(entry, calendarMarks(range([]))), "ready");
  assert.equal(calendarReversalStatus(entry, calendarMarks(range([], [[me, 3]]))), "conflict");
});
