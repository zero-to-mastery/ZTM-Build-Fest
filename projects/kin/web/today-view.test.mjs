import assert from "node:assert/strict";
import test from "node:test";
import { composeToday, describePlanningDate, formatCivilDate, nextCivilDate, ROUTINE_PERIOD_LABELS } from "./today-view.js";

const TODAY = 20261013;
const item = (overrides) => ({ itemId: Math.random().toString(16).slice(2), text: "x", classification: "need", status: "active", planningDate: null, steps: [], ...overrides });
const routine = (overrides) => ({ routineId: Math.random().toString(16).slice(2), text: "r", cadence: "daily", status: "active", occurrenceStatus: "open", occurrenceKey: TODAY, ...overrides });

test("rule A: active items planned for today keep their identity and appear once", () => {
  const task = item({ text: "Call dentist", planningDate: TODAY });
  const shopping = item({ text: "Eggs", classification: "shopping", planningDate: TODAY });
  const staple = item({ text: "Milk", classification: "staple", planningDate: TODAY });
  const view = composeToday({ items: [task, shopping, staple], civilDate: TODAY });
  assert.deepEqual(view.today.map((entry) => entry.text), ["Call dentist", "Eggs"]);
  assert.equal(view.today[1].classification, "shopping", "a shopping item stays a shopping item on Today");
  assert.equal(view.isEmpty, false);
});

test("rule B: undated legacy Today items remain on Today; an explicit date takes precedence", () => {
  const legacy = item({ text: "Legacy", classification: "today" });
  const legacyTomorrow = item({ text: "Legacy later", classification: "today", planningDate: nextCivilDate(TODAY) });
  const legacyEarlier = item({ text: "Legacy earlier", classification: "today", planningDate: 20261001 });
  const view = composeToday({ items: [legacy, legacyTomorrow, legacyEarlier], civilDate: TODAY });
  assert.deepEqual(view.today.map((entry) => entry.text), ["Legacy"]);
  assert.deepEqual(view.earlier.map((entry) => entry.text), ["Legacy earlier"]);
});

test("rule C: earlier unfinished plans are grouped oldest first and future plans are not today's work", () => {
  const old = item({ text: "Old", planningDate: 20261001 });
  const older = item({ text: "Older", planningDate: 20260930 });
  const future = item({ text: "Future", planningDate: 20261020 });
  const completedOld = item({ text: "Done old", planningDate: 20261001, status: "completed" });
  const view = composeToday({ items: [old, older, future, completedOld], civilDate: TODAY });
  assert.deepEqual(view.earlier.map((entry) => entry.text), ["Older", "Old"]);
  assert.equal(view.today.length, 0);
  assert.equal(view.completed.length, 0, "a completed earlier plan is not today's completed work");
});

test("rule D: routines use the Rust occurrence state and are grouped by period", () => {
  const daily = routine({ text: "Dishes" });
  const weekly = routine({ text: "Bins", cadence: "weekly" });
  const monthly = routine({ text: "Filters", cadence: "monthly", occurrenceStatus: "completed" });
  const unavailable = routine({ text: "Odd", cadence: "biweekly", occurrenceStatus: "unavailable" });
  const archived = routine({ text: "Gone", status: "archived" });
  const view = composeToday({ items: [], routines: [daily, weekly, monthly, unavailable, archived], civilDate: TODAY });
  assert.deepEqual(view.routineGroups.map((group) => [group.label, group.routines.map((entry) => entry.text)]), [["Today", ["Dishes"]], ["This week", ["Bins"]]]);
  assert.deepEqual(view.completedRoutines.map((entry) => entry.text), ["Filters"]);
  assert.equal(view.routinesPaused, false);
  assert.equal(ROUTINE_PERIOD_LABELS.biweekly, "This two-week period");
});

test("rule D: every-day and every-weekday tasks share one Today group; a weekend weekday task is absent", () => {
  const daily = routine({ text: "Dishes" });
  const weekdays = routine({ text: "Lunches", cadence: "weekdays" });
  const weekend = routine({ text: "School run", cadence: "weekdays", occurrenceStatus: "unavailable", occurrenceKey: null });
  const view = composeToday({ items: [], routines: [daily, weekdays, weekend], civilDate: TODAY });
  assert.deepEqual(view.routineGroups.map((group) => [group.label, group.routines.map((entry) => entry.text)]), [["Today", ["Dishes", "Lunches"]]]);
  assert.equal(view.routineGroups.filter((group) => group.label === "Today").length, 1);
  assert.equal(ROUTINE_PERIOD_LABELS.weekdays, "Today");
  // Each repeating task appears once, never once per future occurrence.
  assert.equal(view.routineGroups.flatMap((group) => group.routines).length, 2);
  assert.equal(view.hasRoutines, true);
});

test("rule D: a non-Normal mode pauses every occurrence without hiding that routines exist", () => {
  const view = composeToday({ items: [], routines: [routine()], mode: "vacation", civilDate: TODAY });
  assert.equal(view.routineGroups.length, 0);
  assert.equal(view.completedRoutines.length, 0);
  assert.equal(view.routinesPaused, true);
  assert.equal(view.hasRoutines, true);
  assert.equal(view.isEmpty, false);
});

test("rule E: quick access is separate and may repeat an item; waiting handoffs are counted", () => {
  const pinned = item({ text: "Pinned", planningDate: TODAY });
  const archivedPin = item({ text: "Archived", status: "archived" });
  const view = composeToday({
    items: [pinned, archivedPin],
    pins: [{ targetKind: "item", targetId: pinned.itemId }, { targetKind: "item", targetId: archivedPin.itemId }, { targetKind: "note", targetId: "n" }],
    handoffs: [{ status: "unacknowledged" }, { status: "acknowledged" }, { status: "archived" }, { status: "unacknowledged" }],
    civilDate: TODAY,
  });
  assert.deepEqual(view.quickAccess.map((entry) => entry.text), ["Pinned"]);
  assert.deepEqual(view.today.map((entry) => entry.text), ["Pinned"]);
  assert.equal(view.waitingHandoffs, 2);
});

test("completed content is collected separately and archived records never appear", () => {
  const doneToday = item({ text: "Done", planningDate: TODAY, status: "completed" });
  const doneLegacy = item({ text: "Done legacy", classification: "today", status: "completed" });
  const archived = item({ text: "Archived", planningDate: TODAY, status: "archived" });
  const view = composeToday({ items: [doneToday, doneLegacy, archived], civilDate: TODAY });
  assert.deepEqual(view.completed.map((entry) => entry.text), ["Done", "Done legacy"]);
  assert.equal(view.today.length, 0);
  assert.equal(view.isEmpty, true);
});

test("the composition requires an explicit civil date", () => {
  assert.throws(() => composeToday({ items: [] }), TypeError);
});

test("planning date descriptions are calm and relative", () => {
  assert.equal(describePlanningDate(null, TODAY), null);
  assert.equal(describePlanningDate(TODAY, TODAY), "Planned for today");
  assert.equal(describePlanningDate(nextCivilDate(TODAY), TODAY), "Planned for tomorrow");
  assert.match(describePlanningDate(20261001, TODAY), /^Planned for .*, still open$/);
  assert.match(describePlanningDate(20261120, TODAY), /^Planned for /);
  assert.doesNotMatch(describePlanningDate(20261001, TODAY), /overdue|late/i);
  assert.equal(nextCivilDate(20261231), 20270101);
  assert.equal(typeof formatCivilDate(TODAY), "string");
});

test("upcoming plans are later active items, nearest first, and never today's or earlier work", () => {
  const nextWeek = item({ text: "Next week", planningDate: 20261020 });
  const tomorrow = item({ text: "Tomorrow", planningDate: nextCivilDate(TODAY) });
  const doneLater = item({ text: "Done later", planningDate: 20261020, status: "completed" });
  const stapleLater = item({ text: "Staple later", classification: "staple", planningDate: 20261020 });
  const archivedLater = item({ text: "Archived later", planningDate: 20261020, status: "archived" });
  const view = composeToday({ items: [nextWeek, tomorrow, doneLater, stapleLater, archivedLater], civilDate: TODAY });
  assert.deepEqual(view.upcoming.map((entry) => entry.text), ["Tomorrow", "Next week"]);
  assert.equal(view.today.length + view.earlier.length + view.completed.length, 0, "a later plan, done or not, is not today's work");
  assert.equal(view.isEmpty, false, "only-upcoming households are not described as empty");
});

test("each actionable item lands in exactly one section and counts are the section lengths", () => {
  const records = [
    item({ text: "Earlier", planningDate: 20261001 }),
    item({ text: "Today", planningDate: TODAY }),
    item({ text: "Legacy", classification: "today" }),
    item({ text: "Later", planningDate: 20261101 }),
    item({ text: "Undated need" }),
    item({ text: "Done today", planningDate: TODAY, status: "completed" }),
    item({ text: "Done earlier", planningDate: 20261001, status: "completed" }),
  ];
  const view = composeToday({ items: records, civilDate: TODAY });
  const placed = [...view.earlier, ...view.today, ...view.upcoming].map((entry) => entry.itemId);
  assert.equal(new Set(placed).size, placed.length, "no item is listed in two actionable sections");
  assert.deepEqual(view.counts, { earlier: 1, today: 2, upcoming: 1, completed: 1 });
  assert.deepEqual(view.counts, { earlier: view.earlier.length, today: view.today.length, upcoming: view.upcoming.length, completed: view.completed.length });
  assert.equal(view.allDone, false);
  assert.equal(view.hasItems, true);
});

test("completing a task moves it from its pending count to the done count without inflating either", () => {
  const task = item({ text: "Call", planningDate: TODAY });
  const before = composeToday({ items: [task], civilDate: TODAY });
  const after = composeToday({ items: [{ ...task, status: "completed" }], civilDate: TODAY });
  assert.deepEqual(before.counts, { earlier: 0, today: 1, upcoming: 0, completed: 0 });
  assert.deepEqual(after.counts, { earlier: 0, today: 0, upcoming: 0, completed: 1 });
  assert.equal(after.allDone, true, "all of today's work being done is distinguishable from nothing planned");
  assert.equal(composeToday({ items: [], civilDate: TODAY }).allDone, false);
});

test("an empty projection has zero counts and no items; staples and archived records do not count as tasks", () => {
  const empty = composeToday({ items: [], civilDate: TODAY });
  assert.deepEqual(empty.counts, { earlier: 0, today: 0, upcoming: 0, completed: 0 });
  assert.equal(empty.hasItems, false);
  const onlyStaplesAndArchived = composeToday({ items: [item({ classification: "staple" }), item({ status: "archived", planningDate: TODAY })], civilDate: TODAY });
  assert.equal(onlyStaplesAndArchived.hasItems, false);
});

test("month and year boundaries compare civil dates, not clock times", () => {
  const view = composeToday({
    items: [
      item({ text: "Dec 31", planningDate: 20261231 }),
      item({ text: "Jan 1", planningDate: 20270101 }),
      item({ text: "Jan 2", planningDate: 20270102 }),
    ],
    civilDate: 20270101,
  });
  assert.deepEqual(view.earlier.map((entry) => entry.text), ["Dec 31"]);
  assert.deepEqual(view.today.map((entry) => entry.text), ["Jan 1"]);
  assert.deepEqual(view.upcoming.map((entry) => entry.text), ["Jan 2"]);
  // DST change days are ordinary civil dates: the same record is "today" all day.
  const dst = composeToday({ items: [item({ text: "Clocks change", planningDate: 20261101 })], civilDate: 20261101 });
  assert.deepEqual(dst.today.map((entry) => entry.text), ["Clocks change"]);
  assert.equal(nextCivilDate(20261031), 20261101);
  assert.equal(nextCivilDate(20260308), 20260309);
});

test("ordering is deterministic: equal dates keep the Rust projection order", () => {
  const records = [
    item({ itemId: "b", text: "B", planningDate: 20261020 }),
    item({ itemId: "a", text: "A", planningDate: 20261020 }),
    item({ itemId: "c", text: "C", planningDate: 20261018 }),
  ];
  const first = composeToday({ items: records, civilDate: TODAY });
  const second = composeToday({ items: records.map((record) => ({ ...record })), civilDate: TODAY });
  assert.deepEqual(first.upcoming.map((entry) => entry.itemId), ["c", "b", "a"]);
  assert.deepEqual(second.upcoming.map((entry) => entry.itemId), first.upcoming.map((entry) => entry.itemId));
  assert.deepEqual(records.map((record) => record.itemId), ["b", "a", "c"], "composition never reorders its input");
});
