// Home-screen icon generation (#78). Canvas output is checked in the browser
// regression; here a recording OffscreenCanvas checks sizes, the maskable
// safe zone and colours.
import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToBase64Url,
  firstGrapheme,
  INSTALL_ICON_SIZES,
  letterColors,
  letterIcons,
  MAX_INSTALL_ICON_BYTES,
  pngSize,
  uploadIcons,
} from "./install-icons.js";
import { APPEARANCE_PRESETS, contrastRatio } from "./palette.js";

test("the first grapheme handles emoji, combining marks, CJK and case", () => {
  assert.equal(firstGrapheme("nichols home"), "N");
  assert.equal(firstGrapheme("  élan"), "É");
  assert.equal(firstGrapheme("école"), "É", "a combining mark stays with its letter");
  assert.equal(firstGrapheme("👩‍👩‍👧‍👦 Family"), "👩‍👩‍👧‍👦");
  assert.equal(firstGrapheme("🇨🇦 Cabin"), "🇨🇦");
  assert.equal(firstGrapheme("山の家"), "山");
  assert.equal(firstGrapheme("ßtraße"), "ß", "an uppercase form of two letters is not used");
  assert.equal(firstGrapheme("ǆungla"), "Ǆ");
  assert.equal(firstGrapheme(""), "K");
});

test("letter colours always contrast with their background", () => {
  for (const { seed } of APPEARANCE_PRESETS) {
    const { background, foreground } = letterColors(seed);
    assert.ok(contrastRatio(background, foreground) >= 4.5, `${seed}: ${background} on ${foreground}`);
  }
  assert.deepEqual(letterColors(undefined), letterColors("#984D38"));
});

test("PNG sizes are read from the header only", () => {
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 180, 0, 0, 0, 180]);
  assert.deepEqual(pngSize(header), { width: 180, height: 180 });
  assert.equal(pngSize(new Uint8Array(10)), null);
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255, 0])), "-_8A");
});

// A recording canvas: fills, text and images are remembered; the "PNG" is a
// header with the canvas size followed by `padding` bytes.
function installCanvas({ padding = 32 } = {}) {
  const drawn = [];
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; this.ops = []; drawn.push(this); }
    getContext() {
      const ops = this.ops;
      return {
        set fillStyle(value) { ops.push(["fillStyle", value]); },
        set font(value) { ops.push(["font", value]); },
        set textAlign(value) {}, set textBaseline(value) {}, set imageSmoothingQuality(value) {},
        fillRect: (...args) => ops.push(["fillRect", ...args]),
        fillText: (...args) => ops.push(["fillText", ...args]),
        drawImage: (...args) => ops.push(["drawImage", ...args.slice(1)]),
        measureText: () => ({ actualBoundingBoxAscent: 40, actualBoundingBoxDescent: 0 }),
      };
    }
    async convertToBlob({ type }) {
      assert.equal(type, "image/png");
      const bytes = new Uint8Array(24 + padding);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(bytes.buffer).setUint32(16, this.width);
      new DataView(bytes.buffer).setUint32(20, this.height);
      return { size: bytes.length, arrayBuffer: async () => bytes.buffer };
    }
  };
  return drawn;
}

test("letter icons come in all four sizes with the letter on the household colour", async () => {
  const drawn = installCanvas();
  const icons = await letterIcons({ name: "willow house", seed: "#397052" });
  assert.deepEqual(Object.keys(icons), Object.keys(INSTALL_ICON_SIZES));
  for (const [key, size] of Object.entries(INSTALL_ICON_SIZES)) assert.deepEqual(pngSize(icons[key]), { width: size, height: size }, key);
  const { background } = letterColors("#397052");
  for (const canvas of drawn) {
    assert.deepEqual(canvas.ops.slice(0, 2), [["fillStyle", background], ["fillRect", 0, 0, canvas.width, canvas.width]]);
    assert.equal(canvas.ops.find(([op]) => op === "fillText")[1], "W");
  }
  const fontSize = (canvas) => Number(/(\d+)px/.exec(canvas.ops.find(([op]) => op === "font")[1])[1]);
  assert.ok(fontSize(drawn[2]) < fontSize(drawn[1]), "the maskable letter is smaller, inside the safe zone");
});

test("uploaded icons are centre-cropped, with the maskable copy inside the safe circle", async () => {
  const drawn = installCanvas();
  const closed = [];
  globalThis.createImageBitmap = async () => ({ width: 400, height: 300, close() { closed.push(true); } });
  const file = { size: 10, type: "image/png" };
  const icons = await uploadIcons(file, { seed: "#256A91" });
  assert.equal(closed.length, 1, "the decoded bitmap is released");
  assert.deepEqual(pngSize(icons.apple180), { width: 180, height: 180 });
  const image = (canvas) => canvas.ops.find(([op]) => op === "drawImage").slice(1);
  assert.deepEqual(image(drawn[1]), [50, 0, 300, 300, 0, 0, 512, 512]);
  // The square fits inside the maskable safe circle (radius 40%): side 0.56.
  assert.deepEqual(image(drawn[2]).map((value) => Math.round(value * 10) / 10), [50, 0, 300, 300, 112.6, 112.6, 286.7, 286.7]);
  const [, , , , x, , side] = image(drawn[2]);
  assert.ok(Math.hypot(x - 256, x - 256) <= 0.4 * 512 + 0.01, "the image's corners stay inside the safe circle");
  assert.ok(side > 0);
  await assert.rejects(uploadIcons({ size: 10, type: "image/svg+xml" }, {}), /JPEG, PNG, or WebP/);
  globalThis.createImageBitmap = async () => ({ width: 10_000, height: 10_000, close() {} });
  await assert.rejects(uploadIcons(file, {}), /32 megapixels/);
  installCanvas({ padding: MAX_INSTALL_ICON_BYTES });
  globalThis.createImageBitmap = async () => ({ width: 50, height: 50, close() {} });
  await assert.rejects(uploadIcons(file, {}), /simpler image/);
});
