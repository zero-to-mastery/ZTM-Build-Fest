// #267: item actions name what changed and say truthfully how far it went.
import assert from "node:assert/strict";
import test from "node:test";
import { itemActionFeedback, pendingActionShare, quotedName, syncProgress } from "./feedback.js";

test("actions name the item and never claim more than this device knows", () => {
  assert.equal(itemActionFeedback({ type: "complete", text: "Milk" }), "Marked “Milk” done.");
  assert.equal(itemActionFeedback({ type: "reopen", text: "Milk", syncing: true }), "Reopened “Milk”. Waiting to sync.");
  assert.equal(itemActionFeedback({ type: "archive", text: "Milk", syncing: true, offline: true }), "Archived “Milk”. It will sync when you're connected.");
  assert.doesNotMatch(itemActionFeedback({ type: "complete", text: "Milk", syncing: true }), /sent|shared|seen|read/i);
});

test("an unknown item or action falls back to plain wording", () => {
  assert.equal(itemActionFeedback({ type: "complete" }), "Marked complete.");
  assert.equal(itemActionFeedback({ type: "archive", text: "   " }), "Archived.");
  assert.equal(itemActionFeedback({ type: "mystery", text: "Milk" }), "Saved.");
});

test("long or multi-line names are shortened without splitting characters", () => {
  assert.equal(quotedName("Milk\nand eggs"), "Milk");
  const long = "🏠".repeat(60);
  assert.equal([...quotedName(long)].length, 40);
  assert.ok(quotedName(long).endsWith("…"));
  assert.equal(quotedName("a".repeat(40)), "a".repeat(40));
});

test("without sync nothing is promised; offline says when it will sync", () => {
  assert.equal(syncProgress({}), "");
  assert.equal(syncProgress({ offline: true }), "");
  assert.equal(syncProgress({ syncing: true }), " Waiting to sync.");
});

test("an action's pending share settles exactly once", () => {
  const share = pendingActionShare();
  assert.equal(share.markShared(), true);
  assert.equal(share.markShared(), false);
});
