// Browser-only presentation helpers for encrypted attachments. Previews are
// derived from decrypted bytes in memory and exposed only as revocable object
// URLs; nothing here persists plaintext or touches storage.

export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const THUMBNAIL_EDGE = 192;

export function isImageAttachment(record) {
  if (!record) return false;
  if (typeof record.type === "string") return IMAGE_TYPES.has(record.type);
  return /\.(jpe?g|png|webp)$/i.test(record.name ?? "");
}

export function attachmentKindLabel(record) {
  if (isImageAttachment(record)) return "Photo";
  if (record?.type === "application/pdf" || /\.pdf$/i.test(record?.name ?? "")) return "PDF";
  return "File";
}

export function formatAttachmentSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// Decode once at a bounded size so long lists never hold full-resolution
// bitmaps. Falls back to the original blob when resizing is unavailable; the
// caller treats either result as an owned object URL to revoke.
export async function createThumbnail(blob, { edge = THUMBNAIL_EDGE } = {}) {
  if (!(blob instanceof Blob) || !IMAGE_TYPES.has(blob.type)) throw new Error("not-an-image");
  if (typeof createImageBitmap !== "function") return { url: URL.createObjectURL(blob), width: null, height: null, resized: false };
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d");
    if (!context) return { url: URL.createObjectURL(blob), width: bitmap.width, height: bitmap.height, resized: false };
    context.drawImage(bitmap, 0, 0, width, height);
    const thumbnail = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("thumbnail")), "image/png"));
    return { url: URL.createObjectURL(thumbnail), width, height, resized: true };
  } catch {
    return { url: URL.createObjectURL(blob), width: bitmap?.width ?? null, height: bitmap?.height ?? null, resized: false };
  } finally {
    bitmap?.close?.();
  }
}

// Session-scoped cache of thumbnail object URLs. The owner revokes everything
// on lock so no decrypted preview outlives the unlocked session.
export class AttachmentPreviewCache {
  constructor(loadBlob) {
    this.loadBlob = loadBlob;
    this.entries = new Map();
    this.pending = new Map();
  }

  peek(attachmentId) {
    return this.entries.get(attachmentId) ?? null;
  }

  async get(record) {
    const id = record?.attachmentId;
    if (!id) return null;
    if (this.entries.has(id)) return this.entries.get(id);
    if (this.pending.has(id)) return this.pending.get(id);
    const work = (async () => {
      try {
        const blob = await this.loadBlob(record);
        if (this.pending.get(id) !== work) return null;
        const preview = await createThumbnail(blob);
        if (this.pending.get(id) !== work) { URL.revokeObjectURL(preview.url); return null; }
        this.entries.set(id, preview);
        return preview;
      } catch {
        if (this.pending.get(id) === work) this.entries.set(id, null);
        return null;
      } finally {
        if (this.pending.get(id) === work) this.pending.delete(id);
      }
    })();
    this.pending.set(id, work);
    return work;
  }

  forget(attachmentId) {
    const entry = this.entries.get(attachmentId);
    if (entry?.url) URL.revokeObjectURL(entry.url);
    this.entries.delete(attachmentId);
    this.pending.delete(attachmentId);
  }

  clear() {
    for (const entry of this.entries.values()) if (entry?.url) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.pending.clear();
  }
}
