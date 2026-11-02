// The Play screenshot script's browserless parts (#540): every device size
// gives the pixels Play accepts, and a browser's RGBA PNG becomes a 24-bit
// one of the right size. The capture itself runs in CI (play-screenshots job).
import assert from "node:assert/strict";
import test from "node:test";
import { decodePng, encodePng } from "./render-icons.mjs";
import { DEVICES, SCREENS, playPng } from "./play-screenshots.mjs";

test("phone and 7- and 10-inch tablet sizes are 9:16 or 16:9 within Play's limits", () => {
  assert.deepEqual(DEVICES.map((device) => device.name), ["phone", "tablet7", "tablet10"]);
  for (const { name, width, height, deviceScaleFactor, pixels: [x, y] } of DEVICES) {
    assert.equal(width * deviceScaleFactor, x, `${name} width`);
    assert.equal(height * deviceScaleFactor, y, `${name} height`);
    assert.equal(Math.max(x, y) * 9, Math.min(x, y) * 16, `${name} is 16:9 or 9:16`);
    assert.ok(Math.min(x, y) >= (name === "tablet10" ? 1080 : 320) && Math.max(x, y) <= 3840, `${name} is within Play's limits`);
  }
  assert.ok(DEVICES.find((device) => device.name === "tablet7").width >= 720, "the 7-inch tablet gets the side navigation layout");
  assert.deepEqual(SCREENS.map((screen) => screen.name), ["today", "shopping", "week", "chat", "journal"]);
});

test("a browser screenshot is re-encoded as 24-bit RGB, transparency over white", () => {
  const rgba = new Uint8Array([10, 20, 30, 255, 200, 100, 0, 0, 0, 0, 0, 128, 255, 255, 255, 255]);
  const png = playPng(encodePng(2, 2, rgba), [2, 2]);
  assert.equal(png[25], 2, "colour type 2");
  assert.deepEqual([...decodePng(png).pixels], [10, 20, 30, 255, 255, 255, 127, 127, 127, 255, 255, 255]);
  assert.throws(() => playPng(encodePng(2, 2, rgba), [1080, 1920]), /not 1080 × 1920/);
  const rgb = encodePng(1, 1, new Uint8Array([1, 2, 3]), { channels: 3 });
  assert.deepEqual([...decodePng(playPng(rgb, [1, 1])).pixels], [1, 2, 3]);
});
