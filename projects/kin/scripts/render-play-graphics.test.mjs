// The Google Play feature graphic (#540): Play's size, no alpha channel, and
// the committed PNG is exactly what scripts/render-play-graphics.mjs renders.
// Also the PNG reader handles every row filter, as a browser's screenshots
// use them (scripts/play-screenshots.mjs re-encodes those without alpha).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { crc32, decodePng, encodePng } from "./render-icons.mjs";
import { FEATURE_FILE, FEATURE_HEIGHT, FEATURE_WIDTH, playRoot, renderFeatureGraphic } from "./render-play-graphics.mjs";

// Rendering takes a few seconds; both tests use one render.
let rendered = null;
const render = () => (rendered ??= renderFeatureGraphic());

test("the committed feature graphic is 1024 × 500, 24-bit with no alpha, and matches the renderer", () => {
  const bytes = readFileSync(join(playRoot, FEATURE_FILE));
  assert.equal(bytes[25], 2, "colour type 2 (RGB): Play refuses a feature graphic with alpha");
  const committed = decodePng(bytes);
  assert.deepEqual([committed.width, committed.height, committed.channels], [FEATURE_WIDTH, FEATURE_HEIGHT, 3]);
  assert.ok(bytes.length < 1024 * 1024, "well under Play's 15 MB limit");
  assert.ok(Buffer.from(committed.pixels).equals(Buffer.from(render())), "differs: run node scripts/render-play-graphics.mjs");
});

test("the graphic keeps its content away from the edges, on Kin's page colour", () => {
  const rgb = render();
  const at = (x, y) => [...rgb.subarray((y * FEATURE_WIDTH + x) * 3, (y * FEATURE_WIDTH + x) * 3 + 3)];
  for (let x = 0; x < FEATURE_WIDTH; x++) for (const y of [0, 60, FEATURE_HEIGHT - 61, FEATURE_HEIGHT - 1]) assert.deepEqual(at(x, y), [0xf3, 0xf1, 0xe9], `(${x}, ${y}) is background`);
  for (let y = 0; y < FEATURE_HEIGHT; y++) for (const x of [0, 60, FEATURE_WIDTH - 61, FEATURE_WIDTH - 1]) assert.deepEqual(at(x, y), [0xf3, 0xf1, 0xe9], `(${x}, ${y}) is background`);
  assert.deepEqual(at(182, 180), [0x8a, 0x5b, 0x4b], "the app icon's tile");
});

test("RGB PNGs round-trip, and every PNG row filter decodes", () => {
  const rgb = new Uint8Array(4 * 3 * 3).map((_, index) => (index * 53 + 7) % 256);
  const png = encodePng(4, 3, rgb, { channels: 3 });
  assert.equal(png[25], 2);
  const decoded = decodePng(png);
  assert.equal(decoded.channels, 3);
  assert.equal(decoded.rgba, undefined);
  assert.deepEqual([...decoded.pixels], [...rgb]);
  assert.throws(() => encodePng(4, 3, rgb, { channels: 2 }), /channels/);

  // A 3 × 5 RGBA image whose rows use filters 0–4, filtered by hand.
  const width = 3, height = 5, channels = 4, stride = width * channels;
  const pixels = new Uint8Array(stride * height).map((_, index) => (index * 97 + 13) % 256);
  const raw = Buffer.alloc((stride + 1) * height);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = y;
    for (let x = 0; x < stride; x++) {
      const value = pixels[y * stride + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][y];
      raw[y * (stride + 1) + 1 + x] = (value - predicted) & 0xff;
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const filtered = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual([...decodePng(filtered).rgba], [...pixels]);
});
