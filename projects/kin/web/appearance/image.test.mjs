import test from "node:test";
import assert from "node:assert/strict";
import { backgroundFileProblem, dominantColorFromPixels, processBackground } from "./image.js";

test("background validation rejects unsupported, empty, and oversized input", () => {
  assert.match(backgroundFileProblem({ size: 1, type: "image/svg+xml" }), /JPEG/);
  assert.match(backgroundFileProblem({ size: 0, type: "image/png" }), /non-empty/);
  assert.match(backgroundFileProblem({ size: 13 * 1024 * 1024, type: "image/jpeg" }), /12 MiB/);
  assert.equal(backgroundFileProblem({ size: 20, type: "image/webp" }), null);
});

test("dominant extraction ignores transparency, quantizes, and breaks ties stably", () => {
  const pixels = new Uint8ClampedArray([
    250, 10, 10, 255, 245, 12, 8, 255, 4, 4, 250, 255, 255, 255, 255, 0,
  ]);
  assert.equal(dominantColorFromPixels(pixels), "#F80B09");
  assert.equal(dominantColorFromPixels(new Uint8ClampedArray([0, 0, 0, 0])), null);
  assert.equal(dominantColorFromPixels(new Uint8ClampedArray([1, 1, 241, 255, 241, 1, 1, 255])), "#0101F1");
});

test("normalization preserves alpha and derives color from the final WebP canvas", async (context) => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalCanvas = globalThis.OffscreenCanvas;
  const draws = [];
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; this.kind = width === 32 ? "sample" : "normalized"; }
    getContext(_type, options) {
      if (this.kind === "normalized") assert.equal(options.alpha, true);
      return {
        drawImage: (source) => draws.push([this.kind, source.kind ?? "bitmap"]),
        getImageData: () => ({ data: new Uint8ClampedArray([16, 32, 48, 128]) }),
      };
    }
    async convertToBlob({ type }) { return new Blob([new Uint8Array([1, 2, 3])], { type }); }
  }
  globalThis.createImageBitmap = async () => ({ kind: "bitmap", width: 2, height: 2, close() {} });
  globalThis.OffscreenCanvas = Canvas;
  context.after(() => { globalThis.createImageBitmap = originalBitmap; globalThis.OffscreenCanvas = originalCanvas; });
  for (const type of ["image/png", "image/webp"]) {
    draws.length = 0;
    const result = await processBackground({ size: 20, type });
    assert.equal(result.type, "image/webp");
    assert.equal(result.seed, "#102030");
    assert.deepEqual(draws, [["normalized", "bitmap"], ["sample", "normalized"]]);
  }
});

test("oversized normalized WebP uses an explicit opaque JPEG surface before sampling", async (context) => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalCanvas = globalThis.OffscreenCanvas;
  const calls = [];
  class Canvas {
    constructor(width, height) { this.kind = width === 32 ? "sample" : calls.filter(([name]) => name === "canvas").length ? "flattened" : "normalized"; calls.push(["canvas", this.kind]); }
    getContext(_type, options) { return {
      set fillStyle(value) { calls.push(["fillStyle", value]); },
      fillRect: () => calls.push(["fillRect"]),
      drawImage: (source) => calls.push(["draw", this.kind, source.kind ?? "bitmap"]),
      getImageData: () => ({ data: new Uint8ClampedArray([243, 241, 233, 255]) }),
    }; }
    async convertToBlob({ type }) { return new Blob([new Uint8Array(type === "image/webp" ? 3 * 1024 * 1024 + 1 : 2)], { type }); }
  }
  globalThis.createImageBitmap = async () => ({ kind: "bitmap", width: 2, height: 2, close() {} });
  globalThis.OffscreenCanvas = Canvas;
  context.after(() => { globalThis.createImageBitmap = originalBitmap; globalThis.OffscreenCanvas = originalCanvas; });
  const result = await processBackground({ size: 20, type: "image/png" });
  assert.equal(result.type, "image/jpeg");
  assert.equal(result.seed, "#F3F1E9");
  assert.ok(calls.some((entry) => entry[0] === "fillStyle" && entry[1] === "#F3F1E9"));
  assert.ok(calls.some((entry) => entry[0] === "draw" && entry[1] === "sample" && entry[2] === "flattened"));
});
