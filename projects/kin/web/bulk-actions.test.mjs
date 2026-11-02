import assert from "node:assert/strict";
import test from "node:test";
import { BULK_ACTIONS, describeBulkOutcome, isBulkEligible, planBulk, reconcileSelection, undoCommand, undoStatus } from "./bulk-actions.js";

const item = (itemId, status, classification = "need", lastChangedAt = 100) => ({ itemId, status, classification, lastChangedAt });
const items = [
  item("a", "active"), item("b", "active"), item("c", "completed"),
  item("d", "archived"), item("e", "active", "staple"), item("f", "completed", "shopping"), item("g", "active", "today"),
];

test("only open or completed To do, legacy Today, and Shopping items are selectable", () => {
  assert.deepEqual(items.filter(isBulkEligible).map((entry) => entry.itemId), ["a", "b", "c", "f", "g"]);
  assert.equal(isBulkEligible(null), false);
});

test("complete targets only open items and reports the rest", () => {
  assert.deepEqual(planBulk("complete", ["a", "c", "d", "e", "missing", "g", "a"], items), {
    action: "complete", targets: ["a", "g"], skipped: ["c", "d", "e", "missing"],
  });
});

test("reopen targets only completed items", () => {
  assert.deepEqual(planBulk("reopen", ["a", "c", "f"], items), { action: "reopen", targets: ["c", "f"], skipped: ["a"] });
  assert.throws(() => planBulk("archive", ["a"], items));
});

test("selection reconciliation drops removed, archived, and moved items", () => {
  const selected = new Set(["a", "c", "d", "missing", "f"]);
  const todo = (record) => record.classification === "need" || record.classification === "today";
  assert.deepEqual([...reconcileSelection(selected, items, todo)], ["a", "c"]);
  assert.deepEqual([...reconcileSelection(selected, [], todo)], []);
});

test("undo compensates only an unchanged item with the inverse command", () => {
  const change = { itemId: "c", to: "completed", changedAt: 100 };
  assert.equal(undoStatus(change, items), "ready");
  assert.equal(undoCommand(change), "reopen");
  assert.equal(undoCommand({ itemId: "a", to: "active", changedAt: 100 }), "complete");
});

test("undo refuses an item someone changed afterwards", () => {
  const change = { itemId: "c", to: "completed", changedAt: 100 };
  // Reopened by someone else.
  assert.equal(undoStatus(change, [item("c", "active", "need", 200)]), "conflict");
  // Reopened and completed again: same status, newer change.
  assert.equal(undoStatus(change, [item("c", "completed", "need", 300)]), "conflict");
  assert.equal(undoStatus(change, [item("c", "archived", "need", 300)]), "gone");
  assert.equal(undoStatus(change, []), "gone");
});

test("outcome messages count successes, failures, and skips separately", () => {
  assert.equal(describeBulkOutcome("complete", { succeeded: 3, failed: 2 }), "3 items completed. 2 could not be completed.");
  assert.equal(describeBulkOutcome("complete", { succeeded: 1 }), "1 item completed.");
  assert.equal(describeBulkOutcome("reopen", { succeeded: 2, skipped: 1 }), "2 items reopened. 1 item was already open or no longer available.");
  assert.equal(describeBulkOutcome("complete", { failed: 4 }), "4 could not be completed.");
  assert.equal(describeBulkOutcome("complete", {}), "Nothing to complete.");
  assert.equal(describeBulkOutcome("complete", { succeeded: 2, conflicts: 1, failed: 1, undo: true }),
    "Undid 2 items. 1 item changed since then, so it was left as it is. 1 item could not be undone.");
  assert.equal(describeBulkOutcome("reopen", { conflicts: 2, undo: true }), "2 items changed since then, so they were left as they are.");
  assert.equal(describeBulkOutcome("reopen", { undo: true }), "Nothing needed undoing.");
  // Local durability is never described as sync.
  for (const action of Object.keys(BULK_ACTIONS)) assert.doesNotMatch(describeBulkOutcome(action, { succeeded: 2 }), /sync/i);
});

test("repeating tasks are never bulk targets, so a bulk action cannot touch any occurrence", () => {
  const routine = { routineId: "r".repeat(32), text: "Pack lunches", cadence: "daily", status: "active", occurrenceStatus: "open", occurrenceKey: 20261014 };
  assert.equal(isBulkEligible(routine), false);
  const task = { itemId: "i".repeat(32), classification: "need", status: "active" };
  // Even if a routine id reached the selection, it is skipped, not submitted.
  assert.deepEqual(planBulk("complete", [routine.routineId, task.itemId], [task]), { action: "complete", targets: [task.itemId], skipped: [routine.routineId] });
  assert.deepEqual([...reconcileSelection(new Set([routine.routineId, task.itemId]), [task])], [task.itemId]);
});
