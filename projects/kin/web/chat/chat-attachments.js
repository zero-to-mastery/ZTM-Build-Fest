// Photos and files in chat (#114, #115, #116).
//
// An attachment message's content blob (the one the chat event names) is a
// sealed manifest: the caption and, per file, its name, type, size, an
// optional thumbnail and the list of its parts. Each part is a separate chat
// blob (chat-blobs.js), sealed under its own random key, of at most
// ATTACHMENT_PART_BYTES of the file. The keys travel only inside the manifest,
// which is sealed like any message; the service sees part sizes and hashes,
// never names, types or content.
//
// Manifest format 1 (JSON, UTF-8):
//   { "version": 1, "text": caption,
//     "files": [{ "name", "type", "size",
//                 "thumbnail": { "ref", "key", "size" } | null,
//                 "parts": [{ "ref", "key", "size" }, ...],
//                 "voice": { "durationMs", "peaks": [64 integers 0-255] } }, ...] }
// A voice message (#134) is an attachment message of exactly one audio file
// that carries `voice`: its length and the 64 waveform peaks the engine
// reduced it to, so the waveform can be drawn before the audio arrives. The
// field is optional; a client that doesn't know it shows a plain audio file.
// where ref is a 64-character lowercase SHA-256 and key 64 hex characters.
// Every part but a file's last is ATTACHMENT_PART_BYTES long, and a file's
// parts add up to its size.
//
// Photos (JPEG, PNG, WebP) are drawn again on a canvas before they are
// sealed: that drops EXIF, GPS, camera and other metadata, and normalizes the
// orientation. A browser that can't do that refuses the photo rather than
// send it with its details. Other files go as they are.

export const MAX_ATTACHMENT_FILES = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_PART_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_MANIFEST_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 200;
export const MAX_PHOTO_PIXELS = 40_000_000;
export const THUMBNAIL_EDGE = 320;
export const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** What a voice message can be recorded as (the base type, without codecs). */
export const VOICE_TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg"]);
export const MAX_VOICE_MS = 5 * 60 * 1000;
export const VOICE_PEAKS = 64;

const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX64 = /^[a-f0-9]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i;

export class ChatAttachmentError extends Error {
  constructor(message, code = "chat_attachment_invalid") {
    super(message);
    this.name = "ChatAttachmentError";
    this.code = code;
  }
}

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Explains why a set of chosen files can't be sent, or returns null. */
export function attachmentProblem(files) {
  if (!Array.isArray(files) || !files.length) return "Choose a photo or file to attach.";
  if (files.length > MAX_ATTACHMENT_FILES) return `You can attach up to ${MAX_ATTACHMENT_FILES} files to a message.`;
  for (const file of files) {
    if (!(file instanceof Blob)) return "Choose a photo or file to attach.";
    const name = safeAttachmentName(file.name);
    if (file.size < 1) return `${name} is empty. Choose a file that has content.`;
    if (file.size > MAX_ATTACHMENT_BYTES) return `${name} is ${megabytes(file.size)}. Files can be 25 MB or smaller.`;
    if (typeof file.type === "string" && file.type.startsWith("image/") && !PHOTO_TYPES.has(file.type))
      return `${name} can't be sent as a photo. Kin sends JPEG, PNG and WebP photos, with their location and camera details removed. Export it as JPEG and try again.`;
  }
  return null;
}

/** A display name that is plain text: no folders, no control characters. */
export function safeAttachmentName(name) {
  const base = typeof name === "string" ? name.split(/[\\/]/).pop() : "";
  const clean = (base ?? "").replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return "Attachment";
  return [...clean].slice(0, MAX_ATTACHMENT_NAME_CHARS).join("");
}

/** The image type a file's first bytes show (JPEG, PNG or WebP), or null.
 * Decides whether a file is redrawn as a photo, whatever it claims to be. */
export async function sniffPhotoType(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const at = (offset, bytes) => bytes.every((byte, index) => head[offset + index] === byte);
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/** The MIME type to store and show: a photo keeps its (re-encoded) type; any
 * other file keeps a well-formed type, else a generic one. */
export function safeAttachmentType(type) {
  return typeof type === "string" && type.length <= 127 && MIME.test(type) ? type.toLowerCase() : "application/octet-stream";
}

/**
 * Draws a photo again: the pixels only, so no metadata survives. Returns
 * { blob, thumbnail }, where thumbnail is a small JPEG. The browser's canvas
 * and bitmap decoders are injectable for tests.
 */
export async function preparePhoto(file, {
  decode = (blob) => createImageBitmap(blob, { imageOrientation: "from-image" }),
  makeCanvas = (width, height) => new OffscreenCanvas(width, height),
} = {}) {
  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    throw new ChatAttachmentError(`Kin couldn't read ${safeAttachmentName(file.name)}. Choose a valid JPEG, PNG or WebP photo.`);
  }
  try {
    const { width, height } = bitmap;
    if (!width || !height || width * height > MAX_PHOTO_PIXELS)
      throw new ChatAttachmentError(`${safeAttachmentName(file.name)} is too large to send. Choose a photo under 40 megapixels.`);
    const full = makeCanvas(width, height);
    full.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await full.convertToBlob({ type: file.type, quality: file.type === "image/jpeg" ? 0.92 : undefined });
    if (blob.type !== file.type)
      throw new ChatAttachmentError("This browser can't prepare that photo for sending. Try a JPEG.");
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height));
    const small = makeCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const context = small.getContext("2d");
    // JPEG has no transparency: flatten onto white rather than black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, small.width, small.height);
    context.drawImage(bitmap, 0, 0, small.width, small.height);
    const thumbnail = await small.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    return { blob, thumbnail };
  } finally {
    bitmap.close?.();
  }
}

/** The manifest for a message: its caption and sealed files. Checked as it
 * is built, so an oversized or malformed one never reaches the service. */
export function encodeManifest({ text = "", files }) {
  const manifest = {
    version: VERSION,
    text,
    files: files.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      thumbnail: file.thumbnail ?? null,
      parts: file.parts,
      ...(file.voice ? { voice: file.voice } : {}),
    })),
  };
  const bytes = encoder.encode(JSON.stringify(manifest));
  if (bytes.length > MAX_ATTACHMENT_MANIFEST_BYTES) throw new ChatAttachmentError("These files are too many or too detailed to send together.");
  return bytes;
}

const invalid = () => new ChatAttachmentError("This message's attachments couldn't be opened.", "chat_attachment_invalid");
const isPart = (value, maxSize) => value && typeof value === "object" && HEX64.test(value.ref) && HEX64.test(value.key) &&
  Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= maxSize;

/** Explains what is wrong with a voice message's details, or returns null. */
export function voiceProblem(voice) {
  if (!voice || typeof voice !== "object" || Array.isArray(voice)) return "This voice message has no details.";
  // A little over five minutes: the clock that stops the recording is not exact.
  if (!Number.isSafeInteger(voice.durationMs) || voice.durationMs < 1 || voice.durationMs > MAX_VOICE_MS + 1000)
    return "A voice message can be up to 5 minutes long.";
  if (!Array.isArray(voice.peaks) || voice.peaks.length !== VOICE_PEAKS ||
    voice.peaks.some((peak) => !Number.isInteger(peak) || peak < 0 || peak > 255)) return "This voice message's waveform is not valid.";
  return null;
}

/** Checks a decrypted manifest's shape and sizes; returns it normalized. */
export function decodeManifest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ATTACHMENT_MANIFEST_BYTES) throw invalid();
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== "object" || value.version !== VERSION || typeof value.text !== "string" ||
    [...value.text].length > 4000 || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_ATTACHMENT_FILES) throw invalid();
  const files = value.files.map((file) => {
    if (!file || typeof file !== "object" || typeof file.name !== "string" || !file.name || [...file.name].length > MAX_ATTACHMENT_NAME_CHARS ||
      typeof file.type !== "string" || file.type.length > 127 || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES ||
      !Array.isArray(file.parts) || file.parts.length !== Math.ceil(file.size / ATTACHMENT_PART_BYTES)) throw invalid();
    if (file.thumbnail !== null && (!isPart(file.thumbnail, ATTACHMENT_PART_BYTES) || !PHOTO_TYPES.has(file.type))) throw invalid();
    // Voice details belong to a message of one audio file and nothing else.
    if (file.voice !== undefined && file.voice !== null &&
      (value.files.length !== 1 || !VOICE_TYPES.has(file.type) || file.thumbnail !== null || voiceProblem(file.voice))) throw invalid();
    let total = 0;
    file.parts.forEach((part, index) => {
      const last = index === file.parts.length - 1;
      if (!isPart(part, ATTACHMENT_PART_BYTES) || (!last && part.size !== ATTACHMENT_PART_BYTES)) throw invalid();
      total += part.size;
    });
    if (total !== file.size) throw invalid();
    return {
      name: safeAttachmentName(file.name), type: safeAttachmentType(file.type), size: file.size,
      thumbnail: file.thumbnail === null ? null : { ref: file.thumbnail.ref, key: file.thumbnail.key, size: file.thumbnail.size },
      parts: file.parts.map((part) => ({ ref: part.ref, key: part.key, size: part.size })),
      voice: file.voice ? { durationMs: file.voice.durationMs, peaks: [...file.voice.peaks] } : null,
    };
  });
  return { version: VERSION, text: value.text, files };
}

/** Every blob reference a manifest names: its parts and thumbnails. */
export function manifestRefs(manifest) {
  return manifest.files.flatMap((file) => [...file.parts.map((part) => part.ref), ...(file.thumbnail ? [file.thumbnail.ref] : [])]);
}
