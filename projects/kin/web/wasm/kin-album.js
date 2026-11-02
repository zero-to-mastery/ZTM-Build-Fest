// The family album (#673, ADR 0022 §5) codecs, matching rust/src/album.rs:
// - "add-album-photo" (KCMD action 75, ALBUM_PHOTO_ADDED): { photoId,
//   attachmentId, caption }. Payload: photo ID [16], attachment ID [16], then
//   the caption (u16 length + UTF-8). The attachment is an album attachment:
//   its ID starts with "a1b0" (`ALBUM_ATTACHMENT_PREFIX`).
// - "remove-album-photo" (KCMD action 76, ALBUM_PHOTO_REMOVED): { photoId }.
//   Payload: photo ID [16].
// - KALB v1: { photos: [{ photoId, attachmentId, addedBy, addedAt, caption
//   }] newest first, removed: [{ photoId, attachmentId, removedAt }] newest
//   first }.
//
// Commands carry the event's exact canonical payload, so the caption is
// trimmed here exactly as Rust's `str::trim` does (Unicode White_Space, which
// is not JavaScript's `\s`). Rust decides the rest: a new photo ID, an
// attachment no live photo uses, at most 500 photos, and removing only a
// photo that is in the album.
//
// Who may remove a photo is an owner decision: whoever added it, or a
// household admin. Rust knows who added it but not who is an admin; the host
// does, so the single command append path (components/app/commands/append.js)
// refuses the command for anyone else with `canRemoveAlbumPhoto`, as for the
// sitter page.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_ID = /^[a-f0-9]{32}$/;
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
const CONTROL = /[\0-\x1f\x7f-\x9f]/u;

export const ALBUM_COMMANDS = Object.freeze(["add-album-photo", "remove-album-photo"]);
export const ALBUM_EVENT_KINDS = Object.freeze(["ALBUM_PHOTO_ADDED", "ALBUM_PHOTO_REMOVED"]);
export const FIRST_ALBUM_KIND = 75;
export const MAX_ALBUM_PHOTOS = 500;
export const MAX_ALBUM_CAPTION_BYTES = 200;
/** How many removals KALB lists at most. */
export const ALBUM_RECENT_REMOVALS = 64;
/** Every album attachment ID starts with these two bytes (hex). */
export const ALBUM_ATTACHMENT_PREFIX = "a1b0";
export const ALBUM_REMOVE_FORBIDDEN = "Only the person who added this photo or a household admin can remove it.";

export class AlbumFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlbumFormatError";
  }
}

/** Whether `id` (hex) names an album attachment. */
export function isAlbumAttachmentId(id) {
  return typeof id === "string" && HEX_ID.test(id) && id.startsWith(ALBUM_ATTACHMENT_PREFIX) && !/^0+$/.test(id.slice(4));
}

/** A new random album attachment ID: the prefix, then 112 random bits. */
export function newAlbumAttachmentId(random = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(14));
  if (bytes.every((byte) => byte === 0)) bytes[13] = 1;
  return ALBUM_ATTACHMENT_PREFIX + toHex(bytes);
}

/**
 * Whether the member may remove `photo`: who added it, or a household admin.
 * `memberId` is this member (null on a device with no server membership,
 * which is its own admin: a local-only household). Anything unknown is
 * refused.
 */
export function canRemoveAlbumPhoto(photo, { memberId = null, admin = false, local = false } = {}) {
  if (!photo) return false;
  if (local || admin === true) return true;
  return typeof memberId === "string" && memberId === photo.addedBy;
}

const idBytes = (value, what) => {
  if (value instanceof Uint8Array && value.length === 16 && value.some(Boolean)) return value;
  if (typeof value !== "string" || !HEX_ID.test(value) || /^0+$/.test(value)) throw new AlbumFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
};
function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The caption as Rust stores it: trimmed, at most 200 UTF-8 bytes, one line
 * with no control characters. Empty means none. */
export function normalizeAlbumCaption(caption) {
  const value = String(caption ?? "").replace(/[\r\n]+/g, " ").replace(EDGE_SPACE, "");
  if (encoder.encode(value).length > MAX_ALBUM_CAPTION_BYTES) throw new AlbumFormatError("A caption can be up to 200 characters.");
  if (CONTROL.test(value)) throw new AlbumFormatError("A caption can only hold plain text.");
  return value;
}

/** The canonical payload of an album command. */
export function encodeAlbumPayload(command) {
  if (command?.type === "add-album-photo") {
    if (!isAlbumAttachmentId(command.attachmentId)) throw new AlbumFormatError("Kin received an invalid photo.");
    const caption = encoder.encode(normalizeAlbumCaption(command.caption));
    const out = new Uint8Array(34 + caption.length);
    out.set(idBytes(command.photoId, "photo"), 0);
    out.set(idBytes(command.attachmentId, "photo"), 16);
    new DataView(out.buffer).setUint16(32, caption.length, true);
    out.set(caption, 34);
    return out;
  }
  if (command?.type === "remove-album-photo") return Uint8Array.from(idBytes(command.photoId, "photo"));
  throw new AlbumFormatError("Kin received an invalid album change.");
}

/** A KCMD packet for an album command: the 128-byte header (identity and
 * logical time as for every command) with the payload as its text. */
export function encodeAlbumIntent(command, identity) {
  const index = ALBUM_COMMANDS.indexOf(command?.type);
  if (index < 0) throw new AlbumFormatError("Kin received an invalid album change.");
  const payload = encodeAlbumPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, FIRST_ALBUM_KIND + index, true);
  packet.set(idBytes(identity.eventId, "event"), 12);
  packet.set(idBytes(identity.householdId, "household"), 28);
  packet.set(idBytes(identity.actorId, "member"), 44);
  packet.set(idBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new AlbumFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new AlbumFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** KALB v1 as { photos, removed }, both newest first. */
export function decodeAlbum(bytes) {
  const invalid = () => new AlbumFormatError("Kin received an invalid family album.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 4)) !== "KALB" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  const count = view.getUint32(8, true);
  const removedCount = view.getUint32(12, true);
  if (count > MAX_ALBUM_PHOTOS || removedCount > ALBUM_RECENT_REMOVALS) throw invalid();
  const photos = [];
  const seen = new Set();
  let at = 16;
  for (let index = 0; index < count; index += 1) {
    if (at + 58 > bytes.length) throw invalid();
    const photoId = toHex(bytes.subarray(at, at + 16));
    const attachmentId = toHex(bytes.subarray(at + 16, at + 32));
    const addedBy = toHex(bytes.subarray(at + 32, at + 48));
    const addedAt = Number(view.getBigInt64(at + 48, true));
    const length = view.getUint16(at + 56, true);
    const end = at + 58 + length;
    if (length > MAX_ALBUM_CAPTION_BYTES || end > bytes.length || seen.has(photoId) || !isAlbumAttachmentId(attachmentId) || !Number.isSafeInteger(addedAt)) throw invalid();
    let caption;
    try { caption = decoder.decode(bytes.subarray(at + 58, end)); } catch { throw invalid(); }
    seen.add(photoId);
    photos.push({ photoId, attachmentId, addedBy, addedAt, caption });
    at = end;
  }
  const removed = [];
  for (let index = 0; index < removedCount; index += 1, at += 40) {
    if (at + 40 > bytes.length) throw invalid();
    const removedAt = Number(view.getBigInt64(at + 32, true));
    if (!Number.isSafeInteger(removedAt)) throw invalid();
    removed.push({ photoId: toHex(bytes.subarray(at, at + 16)), attachmentId: toHex(bytes.subarray(at + 16, at + 32)), removedAt });
  }
  if (at !== bytes.length) throw invalid();
  return { photos, removed };
}
