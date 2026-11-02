// Album photos are made screen-sized before they are encrypted (#673).
import assert from "node:assert/strict";
import test from "node:test";
import { ALBUM_IMAGE_EDGE, ALBUM_IMAGE_TARGET_BYTES, albumImageName, fitWithin, isAlbumImage, prepareAlbumImage } from "./album-image.js";

test("the longer side is brought within the edge, never enlarged", () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 2048, height: 1536 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1536, height: 2048 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(10_000, 10, 1024), { width: 1024, height: 1 });
  assert.deepEqual(fitWithin(0, 10), { width: 0, height: 0 });
  assert.equal(ALBUM_IMAGE_EDGE, 2048);
});

test("names become .jpg; only photos qualify", () => {
  assert.equal(albumImageName("IMG_0001.HEIC"), "IMG_0001.jpg");
  assert.equal(albumImageName("beach.png"), "beach.jpg");
  assert.equal(albumImageName(""), "Photo.jpg");
  assert.equal(isAlbumImage(new File(["x"], "a.png", { type: "image/png" })), true);
  assert.equal(isAlbumImage(new File(["x"], "a.pdf", { type: "application/pdf" })), false);
  assert.equal(isAlbumImage(new File([], "a.jpg", { type: "image/jpeg" })), false, "empty");
});

function fakes({ sizes }) {
  const drawn = [];
  let call = 0;
  return {
    drawn,
    createBitmap: async () => ({ width: 4000, height: 3000, close() {} }),
    makeCanvas: (width, height) => ({
      width, height,
      getContext: () => ({ fillRect() {}, drawImage: (_, x, y, w, h) => drawn.push([w, h]), set fillStyle(_) {} }),
      convertToBlob: async ({ type, quality }) => new Blob([new Uint8Array(sizes[Math.min(call++, sizes.length - 1)])], { type, quality }),
    }),
  };
}

test("a large photo is redrawn as a JPEG that fits the target", async () => {
  const source = new File([new Uint8Array(5 * 1024 * 1024)], "big.png", { type: "image/png" });
  const { drawn, createBitmap, makeCanvas } = fakes({ sizes: [ALBUM_IMAGE_TARGET_BYTES + 1, 300 * 1024] });
  const out = await prepareAlbumImage(source, { createBitmap, makeCanvas });
  assert.equal(out.type, "image/jpeg");
  assert.equal(out.name, "big.jpg");
  assert.equal(out.size, 300 * 1024, "the second quality fit");
  assert.deepEqual(drawn[0], [2048, 1536]);
});

test("a browser that can't decode it keeps a photo that already fits, and refuses one that doesn't", async () => {
  const small = new File([new Uint8Array(1000)], "s.webp", { type: "image/webp" });
  assert.equal(await prepareAlbumImage(small, { createBitmap: null }), small);
  assert.equal(await prepareAlbumImage(small, { createBitmap: async () => { throw new Error("decode"); } }), small);
  const huge = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "h.jpg", { type: "image/jpeg" });
  await assert.rejects(prepareAlbumImage(huge, { createBitmap: null }), (error) => /too large/.test(error.userMessage));
  await assert.rejects(prepareAlbumImage(new File(["x"], "a.txt", { type: "text/plain" })), (error) => /JPEG, PNG or WebP/.test(error.userMessage));
});
