// The dependency-free icon renderer (#473): its CRC-32 and PNG encoding are
// correct, and the committed PNGs are exactly what it renders.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32, decodePng, encodePng, iconSpecs, rasterize, roundRect } from "./render-icons.mjs";

const web = new URL("../web/", import.meta.url);

test("CRC-32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("IEND")), 0xae426082, "the CRC every PNG's IEND chunk carries");
});

test("an encoded PNG has a valid structure and decodes to the same pixels", () => {
  const rgba = new Uint8Array(3 * 2 * 4).map((_, index) => (index * 37) % 256);
  const png = encodePng(3, 2, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.toString("ascii", png.length - 8, png.length - 4), "IEND");
  const decoded = decodePng(png);
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 3, height: 2 });
  assert.deepEqual([...decoded.rgba], [...rgba]);
  assert.throws(() => encodePng(2, 2, new Uint8Array(3)), /wrong size/);
  const corrupt = Buffer.from(png);
  corrupt[20] ^= 0xff;
  assert.throws(() => decodePng(corrupt), /bad CRC/);
});

test("edges are anti-aliased and corners outside the tile stay transparent", () => {
  const rgba = rasterize(16, [{ shape: roundRect(0, 0, 192, 192, 40), color: [0x8a, 0x5b, 0x4b] }]);
  assert.equal(rgba[3], 0, "the corner pixel is transparent");
  const centre = (8 * 16 + 8) * 4;
  assert.deepEqual([...rgba.subarray(centre, centre + 4)], [0x8a, 0x5b, 0x4b, 255]);
  const alphas = new Set(Array.from({ length: 16 * 16 }, (_, index) => rgba[index * 4 + 3]));
  assert.ok([...alphas].some((alpha) => alpha > 0 && alpha < 255), "the rounded corner has partial coverage");
});

test("the committed icons match the renderer", () => {
  const specs = iconSpecs();
  assert.ok(specs.some((spec) => spec.file === "icons/icon-maskable-512.png"));
  for (const { file, size, layers } of specs) {
    const committed = decodePng(readFileSync(new URL(file, web)));
    assert.equal(committed.width, size, file);
    assert.equal(committed.height, size, file);
    assert.ok(Buffer.from(committed.rgba).equals(Buffer.from(rasterize(size, layers))), `${file} differs: run node scripts/render-icons.mjs`);
  }
});

test("the manifest lists PNG app icons and a 96 and 192 px PNG for every shortcut", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", web), "utf8"));
  const files = new Set(iconSpecs().map((spec) => `/${spec.file}`));
  const png = manifest.icons.filter((icon) => icon.type === "image/png");
  assert.deepEqual(png.map((icon) => `${icon.sizes} ${icon.purpose}`), ["192x192 any", "512x512 any", "512x512 maskable"]);
  for (const icon of png) assert.ok(files.has(icon.src), icon.src);
  for (const shortcut of manifest.shortcuts) {
    assert.deepEqual(shortcut.icons.map((icon) => icon.sizes), ["96x96", "192x192"], shortcut.name);
    for (const icon of shortcut.icons) {
      assert.equal(icon.type, "image/png");
      assert.ok(files.has(icon.src), icon.src);
    }
  }
});
