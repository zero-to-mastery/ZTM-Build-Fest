import assert from "node:assert/strict";
import test from "node:test";
import { DAILY_UX_CIVIL_DATE, DAILY_UX_FIXTURES } from "./daily-ux-fixtures.js";
import { composeToday } from "./today-view.js";

test("daily UX fixtures cover empty, overdue, due-today, upcoming, and completed projections", () => {
  const project = (name) => composeToday({
    items: DAILY_UX_FIXTURES[name],
    civilDate: DAILY_UX_CIVIL_DATE,
  });

  assert.equal(project("empty").isEmpty, true);
  assert.deepEqual(project("overdue").earlier.map(({ text }) => text), ["Return library books"]);
  assert.deepEqual(project("dueToday").today.map(({ text }) => text), ["Call the dentist"]);
  assert.deepEqual(project("completed").completed.map(({ text }) => text), ["Pack lunches"]);
  assert.deepEqual(project("upcoming").upcoming.map(({ text }) => text), ["Renew car registration"]);
  assert.deepEqual(project("upcoming").counts, { earlier: 0, today: 0, upcoming: 1, completed: 0 });
});

test("daily UX fixtures are immutable and use deterministic canonical ids", () => {
  assert.equal(new Set(Object.values(DAILY_UX_FIXTURES).flat().map(({ itemId }) => itemId)).size, 4);
  assert.ok(Object.values(DAILY_UX_FIXTURES).every(Object.isFrozen));
  assert.ok(Object.values(DAILY_UX_FIXTURES).flat().every(Object.isFrozen));
});
