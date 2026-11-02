// The per-device sliding windows behind chat's rate limits (#125).
import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_UPLOAD_BYTES_PER_TEN_MINUTES, DeviceWindow } from "./chat-limits.mjs";

test("a window spends weights per device and frees them as time passes", () => {
  let now = 1000;
  const window = new DeviceWindow({ limit: 10, windowMs: 60_000, now: () => now });
  assert.equal(window.spend("a", 6), true);
  assert.equal(window.spend("a", 4), true);
  assert.equal(window.spend("a", 1), false, "full");
  assert.equal(window.spend("b", 10), true, "another device has its own allowance");
  now += 30_000;
  assert.equal(window.spend("a", 1), false);
  now += 31_000;
  assert.equal(window.spend("a", 10), true, "everything aged out");
  assert.equal(window.spend("a", 11), false, "more than the whole limit never fits");
});

test("a refused spend costs nothing, and quiet devices are forgotten", () => {
  let now = 0;
  const window = new DeviceWindow({ limit: 3, windowMs: 1000, now: () => now, maxDevices: 2 });
  window.spend("a", 3);
  assert.equal(window.spend("a", 1), false);
  now += 1001;
  assert.equal(window.spend("a", 3), true);
  window.spend("b");
  window.spend("c");
  assert.equal(window.spends.size <= 2, true, "the table stays bounded");
});

test("the byte window is sized for several large photos, not for a flood", () => {
  assert.equal(CHAT_UPLOAD_BYTES_PER_TEN_MINUTES, 256 * 1024 * 1024);
  const window = new DeviceWindow({ limit: CHAT_UPLOAD_BYTES_PER_TEN_MINUTES, windowMs: 600_000, now: () => 0 });
  for (let part = 0; part < 64; part += 1) assert.equal(window.spend("a", 4 * 1024 * 1024), true);
  assert.equal(window.spend("a", 1), false);
});

test("allows() peeks at the window without spending", () => {
  const window = new DeviceWindow({ limit: 5, windowMs: 60_000, now: () => 1000 });
  assert.equal(window.allows("a", 5), true);
  assert.equal(window.allows("a", 5), true, "peeking costs nothing");
  assert.equal(window.spend("a", 3), true);
  assert.equal(window.allows("a", 3), false);
  assert.equal(window.allows("a", 2), true);
});
