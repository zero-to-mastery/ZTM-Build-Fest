// Issue #161 (C2): opened attachment URLs stop resolving on lock.
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import test from "node:test";
import { ObjectUrlRegistry } from "./object-urls.js";

const blob = () => new Blob(["private receipt"], { type: "text/plain" });

test("revokeAll makes every opened URL unresolvable at once", () => {
  const registry = new ObjectUrlRegistry();
  const urls = [registry.create(blob()), registry.create(blob())];
  for (const url of urls) assert.ok(resolveObjectURL(url), "resolves while unlocked");
  registry.revokeAll();
  for (const url of urls) assert.equal(resolveObjectURL(url), undefined, "gone after lock");
  assert.equal(registry.size, 0);
});

test("a URL still expires on its own timer, and the timer is cancelled by revokeAll", () => {
  const timers = new Map();
  let next = 0;
  const registry = new ObjectUrlRegistry({
    setTimer: (callback, ms) => { timers.set(++next, { callback, ms }); return next; },
    clearTimer: (id) => timers.delete(id),
  });
  const expiring = registry.create(blob());
  assert.equal([...timers.values()][0].ms, 60_000);
  [...timers.values()][0].callback();
  assert.equal(resolveObjectURL(expiring), undefined);
  assert.equal(registry.size, 0);

  assert.equal(timers.size, 0, "an expired URL's timer is cleared");
  registry.create(blob());
  assert.equal(timers.size, 1);
  registry.revokeAll();
  assert.equal(timers.size, 0, "revokeAll cancels the pending timer");
});
