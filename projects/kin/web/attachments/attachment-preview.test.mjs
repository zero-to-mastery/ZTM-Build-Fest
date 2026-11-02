import test from "node:test";
import assert from "node:assert/strict";
import {
  AttachmentPreviewCache,
  attachmentKindLabel,
  createThumbnail,
  formatAttachmentSize,
  isImageAttachment,
} from "./attachment-preview.js";

test("image detection prefers the validated MIME type and falls back to the name", () => {
  assert.equal(isImageAttachment({ type: "image/png", name: "x.bin" }), true);
  assert.equal(isImageAttachment({ type: "application/pdf", name: "photo.png" }), false);
  assert.equal(isImageAttachment({ name: "receipt.JPG" }), true);
  assert.equal(isImageAttachment({ name: "notes.pdf" }), false);
  assert.equal(isImageAttachment(null), false);
});

test("tile labels and sizes are human readable", () => {
  assert.equal(attachmentKindLabel({ type: "image/webp", name: "a" }), "Photo");
  assert.equal(attachmentKindLabel({ type: "application/pdf", name: "a.pdf" }), "PDF");
  assert.equal(attachmentKindLabel({ name: "unknown" }), "File");
  assert.equal(formatAttachmentSize(512), "512 B");
  assert.equal(formatAttachmentSize(20 * 1024), "20 KB");
  assert.equal(formatAttachmentSize(3 * 1024 * 1024 + 200 * 1024), "3.2 MB");
  assert.equal(formatAttachmentSize(null), "");
});

test("thumbnail creation refuses non-images and falls back to an owned object URL without bitmap support", async () => {
  await assert.rejects(createThumbnail(new Blob(["%PDF"], { type: "application/pdf" })), /not-an-image/);
  const preview = await createThumbnail(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  assert.ok(preview.url.startsWith("blob:"));
  assert.equal(preview.resized, false);
  URL.revokeObjectURL(preview.url);
});

test("the preview cache dedupes in-flight work, revokes on forget and clear, and never caches across clear", async () => {
  const revoked = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => { revoked.push(url); return originalRevoke.call(URL, url); };
  let loads = 0;
  const cache = new AttachmentPreviewCache(async () => { loads++; await new Promise((resolve) => setTimeout(resolve, 5)); return new Blob([new Uint8Array([9])], { type: "image/jpeg" }); });
  try {
    const record = { attachmentId: "a".repeat(32), type: "image/jpeg", name: "a.jpg" };
    const [first, second] = await Promise.all([cache.get(record), cache.get(record)]);
    assert.equal(loads, 1);
    assert.equal(first, second);
    assert.equal(cache.peek(record.attachmentId), first);
    cache.forget(record.attachmentId);
    assert.deepEqual(revoked, [first.url]);
    assert.equal(cache.peek(record.attachmentId), null);
    const pending = cache.get(record);
    cache.clear();
    assert.equal(await pending, null, "a preview finishing after clear is discarded");
    assert.equal(cache.peek(record.attachmentId), null);
    assert.equal(revoked.length, 1, "a load abandoned before thumbnailing creates no URL to leak");
    const late = await cache.get(record);
    assert.ok(late?.url.startsWith("blob:"));
    cache.clear();
    assert.deepEqual(revoked.at(-1), late.url, "clear revokes every cached preview");
    const failing = new AttachmentPreviewCache(async () => { throw new Error("locked"); });
    assert.equal(await failing.get(record), null);
    assert.equal(failing.peek(record.attachmentId), null);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});

test("a stale request cannot replace or clear a newer request for the same attachment", async () => {
  const revoked = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => { revoked.push(url); return originalRevoke.call(URL, url); };
  let resolveOld;
  let loads = 0;
  const cache = new AttachmentPreviewCache(async () => {
    loads++;
    if (loads === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return new Blob(["new"], { type: "image/jpeg" });
  });
  const record = { attachmentId: "b".repeat(32), type: "image/jpeg", name: "b.jpg" };
  try {
    const oldRequest = cache.get(record);
    cache.forget(record.attachmentId);
    const newRequest = cache.get(record);
    const current = await newRequest;
    resolveOld(new Blob(["old"], { type: "image/jpeg" }));
    assert.equal(await oldRequest, null);
    assert.equal(cache.peek(record.attachmentId), current);
    assert.deepEqual(revoked, [], "the rejected stale request had not created a preview URL");
    cache.clear();
    assert.deepEqual(revoked, [current.url]);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});
