// Keeping the screen on while shopping (#408), against a fake Wake Lock API.
import assert from "node:assert/strict";
import test from "node:test";
import { ScreenWake } from "./wake-lock.js";

function fakes({ refuse = false } = {}) {
  const sentinels = [];
  const api = {
    async request(type) {
      assert.equal(type, "screen");
      if (refuse) throw new Error("NotAllowedError");
      const listeners = [];
      const sentinel = { released: false, addEventListener: (name, fn) => listeners.push(fn), async release() { sentinel.released = true; listeners.forEach((fn) => fn()); } };
      sentinels.push(sentinel);
      return sentinel;
    },
  };
  const handlers = new Map();
  const doc = { visibilityState: "visible", addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name) => handlers.delete(name) };
  return { api, doc, sentinels, handlers };
}

test("keeps the screen on, and asks again when the page comes back", async () => {
  const { api, doc, sentinels, handlers } = fakes();
  const wake = new ScreenWake({ wakeLock: api, doc });
  assert.equal(wake.supported, true);
  assert.equal(await wake.keepOn(), true);
  assert.equal(wake.active, true);
  // Hiding the page releases the lock (the browser does this).
  await sentinels[0].release();
  assert.equal(wake.active, false);
  handlers.get("visibilitychange")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wake.active, true, "re-acquired on return");
  await wake.release();
  assert.equal(wake.active, false);
  assert.equal(handlers.has("visibilitychange"), false, "stops listening");
});

test("a refusal or a missing API leaves things as they are", async () => {
  const refused = new ScreenWake({ ...fakes({ refuse: true }), wakeLock: fakes({ refuse: true }).api });
  assert.equal(await refused.keepOn(), false);
  assert.equal(refused.active, false);
  const none = new ScreenWake({ wakeLock: null, doc: null });
  assert.equal(none.supported, false);
  assert.equal(await none.keepOn(), false);
  await none.release();
});
