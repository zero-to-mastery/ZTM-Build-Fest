import assert from "node:assert/strict";
import test from "node:test";
import {
  REPEAT_OPTIONS, REPEAT_HINTS, describeNextOccurrence, describeRecurringCapture, describeRepeat,
  describeScheduleChanged, isCadence, planScheduleChange, remainingRecurringSteps, repeatLabel, SCHEDULE_MESSAGES,
} from "./recurrence.js";

const OLD = "a".repeat(32), NEW = "b".repeat(32), MEMBER = "c".repeat(32);
const routine = (overrides = {}) => ({ routineId: OLD, text: "Pack lunches", cadence: "daily", status: "active", occurrenceStatus: "open", occurrenceKey: 20261014, nextOn: 20261015, ...overrides });

test("repeat options default to not repeating and name only the Rust wire cadences", () => {
  assert.equal(REPEAT_OPTIONS[0].value, "");
  assert.equal(REPEAT_OPTIONS[0].label, "Does not repeat");
  assert.deepEqual(REPEAT_OPTIONS.slice(1).map((option) => option.value).sort(), ["biweekly", "daily", "monthly", "weekdays", "weekly"]);
  for (const option of REPEAT_OPTIONS.slice(1)) {
    assert.ok(isCadence(option.value));
    assert.ok(REPEAT_HINTS[option.value]);
  }
  for (const value of ["", "yearly", "Daily", null, undefined, 3, "__proto__", "toString"]) assert.equal(isCadence(value), false, String(value));
  assert.equal(repeatLabel("weekdays"), "Every weekday");
  assert.equal(describeRepeat("weekly"), "Repeats every week");
  assert.equal(describeRepeat("bogus"), "Repeats");
});

test("next occurrence wording formats the Rust date without computing one", () => {
  assert.equal(describeNextOccurrence(20261015, 20261014), "Next: tomorrow");
  assert.equal(describeNextOccurrence(20261101, 20261031), "Next: tomorrow");
  assert.match(describeNextOccurrence(20261019, 20261014), /^Next: \S+/);
  assert.notEqual(describeNextOccurrence(20261019, 20261014), "Next: tomorrow");
  assert.equal(describeNextOccurrence(null, 20261014), null);
  assert.equal(describeNextOccurrence(20261015, null), null);
});

test("capture feedback says whether the new task is due now or when it first opens", () => {
  assert.equal(describeRecurringCapture(routine({ cadence: "weekdays" }), 20261014), "Added. Repeats every weekday; it's on Today now.");
  const weekend = describeRecurringCapture(routine({ cadence: "weekdays", occurrenceStatus: "unavailable", occurrenceKey: null, nextOn: 20261019 }), 20261017);
  assert.match(weekend, /^Added\. Repeats every weekday\. First one \S/);
  assert.equal(describeRecurringCapture(routine({ occurrenceStatus: "unavailable", nextOn: null }), 20261014), "Added. Repeats every day.");
});

test("a recurring capture is one create command keyed by its client id, and a retry never duplicates it", () => {
  const draft = { id: NEW, text: "Pack lunches", cadence: "weekdays" };
  assert.deepEqual(remainingRecurringSteps({ routines: [] }, draft), [{ type: "create-routine", routineId: NEW, text: "Pack lunches", cadence: "weekdays" }]);
  assert.deepEqual(remainingRecurringSteps({ routines: [routine({ routineId: NEW })] }, draft), []);
  assert.throws(() => remainingRecurringSteps({}, { ...draft, id: null }), TypeError);
  assert.throws(() => remainingRecurringSteps({}, { ...draft, cadence: "yearly" }), TypeError);
});

test("a schedule change starts a new schedule, carries the owner, then stops the old one", () => {
  const state = { routines: [routine()], responsibilities: [{ targetKind: "routine", targetId: OLD, memberId: MEMBER }] };
  assert.deepEqual(planScheduleChange(state, { routineId: OLD, replacementId: NEW, cadence: "weekly" }), {
    status: "ready",
    steps: [
      { type: "create-routine", routineId: NEW, text: "Pack lunches", cadence: "weekly" },
      { type: "change-responsibility", targetKind: "routine", targetId: NEW, memberId: MEMBER },
      { type: "archive-routine", routineId: OLD },
    ],
  });
  // Unowned: no responsibility step.
  assert.deepEqual(planScheduleChange({ routines: [routine()] }, { routineId: OLD, replacementId: NEW, cadence: "weekly" }).steps.map((step) => step.type), ["create-routine", "archive-routine"]);
});

test("a schedule change resumes after a partial save instead of duplicating", () => {
  const created = { routines: [routine(), routine({ routineId: NEW, cadence: "weekly" })], responsibilities: [{ targetKind: "routine", targetId: OLD, memberId: MEMBER }] };
  assert.deepEqual(planScheduleChange(created, { routineId: OLD, replacementId: NEW, cadence: "weekly" }).steps.map((step) => step.type), ["change-responsibility", "archive-routine"]);
  created.responsibilities.push({ targetKind: "routine", targetId: NEW, memberId: MEMBER });
  assert.deepEqual(planScheduleChange(created, { routineId: OLD, replacementId: NEW, cadence: "weekly" }).steps, [{ type: "archive-routine", routineId: OLD }]);
  const finished = { routines: [routine({ status: "archived", occurrenceKey: null, occurrenceStatus: "unavailable", nextOn: null }), routine({ routineId: NEW, cadence: "weekly" })] };
  assert.deepEqual(planScheduleChange(finished, { routineId: OLD, replacementId: NEW, cadence: "weekly" }), { status: "ready", steps: [] });
});

test("a schedule change is refused rather than guessed when it would be stale, empty or invalid", () => {
  const archived = { routines: [routine({ status: "archived" })] };
  assert.equal(planScheduleChange(archived, { routineId: OLD, replacementId: NEW, cadence: "weekly" }).status, "stopped");
  assert.equal(planScheduleChange({ routines: [] }, { routineId: OLD, replacementId: NEW, cadence: "weekly" }).status, "gone");
  assert.equal(planScheduleChange({ routines: [routine()] }, { routineId: OLD, replacementId: NEW, cadence: "daily" }).status, "unchanged");
  for (const cadence of ["", "yearly", undefined]) assert.equal(planScheduleChange({ routines: [routine()] }, { routineId: OLD, replacementId: NEW, cadence }).status, "invalid");
  for (const status of ["invalid", "gone", "stopped", "unchanged", "partial", "pending"]) assert.ok(SCHEDULE_MESSAGES[status]);
  // A partly saved change to weekly blocks a different choice until it finishes.
  const partial = { routines: [routine(), routine({ routineId: NEW, cadence: "weekly" })] };
  const pending = { routineId: OLD, replacementId: NEW, cadence: "weekly" };
  assert.equal(planScheduleChange(partial, { routineId: OLD, replacementId: "d".repeat(32), cadence: "monthly" }, pending).status, "pending");
  assert.deepEqual(planScheduleChange(partial, pending, pending).steps, [{ type: "archive-routine", routineId: OLD }]);
  assert.equal(describeScheduleChanged("weekdays"), "Schedule changed: repeats every weekday, starting today. Past completions are kept.");
});
