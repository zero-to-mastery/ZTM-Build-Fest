// The first week's tips (#617, #622).
import test from "node:test";
import assert from "node:assert/strict";
import { FIRST_SEEN_KEY, FIRST_WEEK_MS, TIPS_DONE_KEY, firstSeen, markTipDone, nextTip, readTipsDone } from "./tips.js";

const NOW = 1_800_000_000_000;

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
}

test("one tip at a time in the first week: easy mode first, then Help", () => {
  assert.equal(nextTip({ firstSeen: NOW, now: NOW }), "easy-mode");
  assert.equal(nextTip({ firstSeen: NOW, now: NOW, done: new Set(["easy-mode"]) }), "help");
  assert.equal(nextTip({ firstSeen: NOW, now: NOW, easyMode: true }), "help", "no offer of what is already on");
  assert.equal(nextTip({ firstSeen: NOW, now: NOW, done: new Set(["easy-mode", "help"]) }), null, "never repeated");
  assert.equal(nextTip({ firstSeen: NOW, now: NOW + FIRST_WEEK_MS }), null, "only the first week");
  assert.equal(nextTip({ firstSeen: NOW, now: NOW, simpleView: true }), null, "not in Simple view");
  assert.equal(nextTip({ firstSeen: null, now: NOW }), null);
  assert.equal(nextTip({ firstSeen: NOW, now: NOW - 1 }), null, "a clock set back shows nothing");
});

test("the first visit is remembered once; done tips stay done", () => {
  const storage = memoryStorage();
  assert.equal(firstSeen(NOW, storage), NOW);
  assert.equal(firstSeen(NOW + 5000, storage), NOW);
  assert.equal(storage.values.get(FIRST_SEEN_KEY), String(NOW));
  assert.deepEqual([...readTipsDone(storage)], []);
  assert.equal(markTipDone("easy-mode", storage), true);
  assert.equal(markTipDone("help", storage), true);
  assert.deepEqual([...readTipsDone(storage)], ["easy-mode", "help"]);
  storage.setItem(TIPS_DONE_KEY, '["help","nonsense"]');
  assert.deepEqual([...readTipsDone(storage)], ["help"]);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(firstSeen(NOW, blocked), null, "unreadable storage: no tips");
  assert.equal(markTipDone("help", blocked), false);
});
