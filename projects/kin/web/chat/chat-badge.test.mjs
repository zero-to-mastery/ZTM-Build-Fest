import assert from "node:assert/strict";
import test from "node:test";
import { setAppBadge } from "./chat-badge.js";

test("the app badge shows the unread count and clears at zero", () => {
  const calls = [];
  const nav = { setAppBadge: (n) => { calls.push(["set", n]); return Promise.resolve(); }, clearAppBadge: () => { calls.push(["clear"]); return Promise.resolve(); } };
  assert.equal(setAppBadge(3, nav), true);
  assert.equal(setAppBadge(0, nav), true);
  assert.equal(setAppBadge(-2, nav), true);
  assert.equal(setAppBadge(Number.NaN, nav), true);
  assert.deepEqual(calls, [["set", 3], ["clear"], ["clear"], ["clear"]]);
});

test("no Badging API, or a refusal, is not an error", async () => {
  assert.equal(setAppBadge(2, {}), false);
  assert.equal(setAppBadge(2, undefined), false);
  assert.equal(setAppBadge(2, { setAppBadge: () => { throw new Error("not installed"); } }), false);
  assert.equal(setAppBadge(2, { setAppBadge: () => Promise.reject(new Error("denied")) }), true);
  await new Promise((resolve) => setImmediate(resolve));
});
