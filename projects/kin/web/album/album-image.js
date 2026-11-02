// Album photos are made smaller before they are encrypted (#673): a family
// photo frame needs a good screen-sized picture, not a 12-megapixel original,
// and the household's album has a quota of its own on the service
// (MAX_HOUSEHOLD_ALBUM_BYTES). Done in the browser, on the decoded image;
// the original never leaves the device.
//
// The picture is redrawn at most ALBUM_IMAGE_EDGE pixels on its longer side
// as a JPEG, trying lower qualities and then smaller sizes until it fits in
// ALBUM_IMAGE_TARGET_BYTES. Transparent parts of a PNG become white. A
// browser that can't decode or redraw the image keeps the original if it is
// already a supported photo within the attachment limit.
import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_PLAINTEXT_BYTES } from "../attachments/attachment-crypto.js";

export const ALBUM_IMAGE_EDGE = 2048;
export const ALBUM_IMAGE_TARGET_BYTES = 600 * 1024;
const QUALITIES = Object.freeze([0.86, 0.78, 0.68]);
const SMALLER_EDGES = Object.freeze([1600, 1280, 1024]);

/** The size to draw an image of `width` × `height` at so its longer side is
 * at most `edge` (never larger than it is). */
export function fitWithin(width, height, edge = ALBUM_IMAGE_EDGE) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether `file` is a photo Kin can put in the album. */
export function isAlbumImage(file) {
  return file instanceof Blob && file.size > 0 && ["image/jpeg", "image/png", "image/webp"].includes(file.type);
}

/** The JPEG name for a photo called `name`. */
export function albumImageName(name) {
  const base = String(name || "Photo").replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 200) || "Photo";
  return `${base}.jpg`;
}

/**
 * A screen-sized JPEG of `file` as a File, or the original when it can't be
 * redrawn but already fits. Throws an Error with `userMessage` when the
 * photo can't be used.
 */
export async function prepareAlbumImage(file, { createBitmap = globalThis.createImageBitmap, makeCanvas = defaultCanvas } = {}) {
  if (!isAlbumImage(file)) throw Object.assign(new Error("not-a-photo"), { userMessage: "Choose a JPEG, PNG or WebP photo." });
  const original = () => {
    if (file.size <= MAX_ATTACHMENT_PLAINTEXT_BYTES && ALLOWED_ATTACHMENT_TYPES.has(file.type)) return file;
    throw Object.assign(new Error("too-large"), { userMessage: "This photo is too large for Kin to make smaller on this device." });
  };
  if (typeof createBitmap !== "function") return original();
  let bitmap;
  try {
    bitmap = await createBitmap(file);
  } catch {
    return original();
  }
  try {
    for (const edge of [ALBUM_IMAGE_EDGE, ...SMALLER_EDGES]) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, edge);
      const canvas = makeCanvas(width, height);
      const context = canvas?.getContext?.("2d");
      if (!context) return original();
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of QUALITIES) {
        const blob = await toJpeg(canvas, quality);
        if (blob && blob.size <= ALBUM_IMAGE_TARGET_BYTES)
          return new File([blob], albumImageName(file.name), { type: "image/jpeg" });
      }
    }
    // Still large at the smallest size and quality: keep that if it fits.
    const { width, height } = fitWithin(bitmap.width, bitmap.height, SMALLER_EDGES.at(-1));
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await toJpeg(canvas, QUALITIES.at(-1));
    if (blob && blob.size <= MAX_ATTACHMENT_PLAINTEXT_BYTES) return new File([blob], albumImageName(file.name), { type: "image/jpeg" });
    return original();
  } catch (error) {
    if (error?.userMessage) throw error;
    return original();
  } finally {
    bitmap?.close?.();
  }
}

function defaultCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement("canvas"), { width, height });
}

function toJpeg(canvas, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}
