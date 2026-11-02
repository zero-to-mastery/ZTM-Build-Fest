// Simple view (#344, ADR 0013) codecs, matching rust/src/simple.rs:
// - "set-item-emoji" (KCMD action 64, ITEM_EMOJI_SET): item ID [16], a flag
//   word (1 or 0, then three zero bytes) and, when set, the emoji (u16 length
//   + UTF-8). Rust validates the emoji (one grapheme, as a chat reaction).
// - KIEM v1: every shown item's emoji, as a Map itemId -> emoji.
// - KMTQ v1 / KMTD v1: a member's things today.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_ID = /^[a-f0-9]{32}$/;

export const SIMPLE_COMMANDS = Object.freeze(["set-item-emoji"]);
export const SIMPLE_EVENT_KINDS = Object.freeze(["ITEM_EMOJI_SET"]);
export const ITEM_EMOJI_KIND = 64;
/** A picture emoji is one grapheme; Rust's limit on its UTF-8 bytes. */
export const MAX_EMOJI_BYTES = 32;

export class SimpleFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "SimpleFormatError";
  }
}

const idBytes = (value, what) => {
  if (value instanceof Uint8Array && value.length === 16 && value.some(Boolean)) return value;
  if (typeof value !== "string" || !HEX_ID.test(value) || /^0+$/.test(value)) throw new SimpleFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
};
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The canonical kind-64 payload for { itemId, emoji } (emoji null clears). */
export function encodeItemEmojiPayload({ itemId, emoji = null }) {
  const id = idBytes(itemId, "item");
  if (emoji == null) {
    const out = new Uint8Array(20);
    out.set(id, 0);
    return out;
  }
  const text = encoder.encode(String(emoji));
  if (!text.length || text.length > MAX_EMOJI_BYTES) throw new SimpleFormatError("Choose one emoji.");
  const out = new Uint8Array(22 + text.length);
  out.set(id, 0);
  out[16] = 1;
  out[20] = text.length & 0xff;
  out[21] = text.length >> 8;
  out.set(text, 22);
  return out;
}

/** A KCMD packet for "set-item-emoji": the 128-byte header (identity and
 * logical time as for every command) with the payload as its text. */
export function encodeItemEmojiIntent(command, identity) {
  if (command?.type !== "set-item-emoji") throw new SimpleFormatError("Kin received an invalid picture change.");
  const payload = encodeItemEmojiPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, ITEM_EMOJI_KIND, true);
  packet.set(idBytes(identity.eventId, "event"), 12);
  packet.set(idBytes(identity.householdId, "household"), 28);
  packet.set(idBytes(identity.actorId, "member"), 44);
  packet.set(idBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new SimpleFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new SimpleFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

class Reader {
  constructor(bytes, magic) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.need(12);
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== magic || this.view.getUint16(4, true) !== 1 || this.view.getUint16(6, true) !== 0)
      throw new SimpleFormatError("Kin received invalid Simple view data.");
    this.at = 8;
  }
  need(count) { if ((this.at ?? 0) + count > this.bytes.length) throw new SimpleFormatError("Kin received invalid Simple view data."); }
  u8() { this.need(1); return this.bytes[this.at++]; }
  u16() { this.need(2); const value = this.view.getUint16(this.at, true); this.at += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.at, true); this.at += 4; return value; }
  id() { this.need(16); const value = toHex(this.bytes.subarray(this.at, this.at + 16)); this.at += 16; return value; }
  text() { const length = this.u16(); this.need(length); const value = decoder.decode(this.bytes.subarray(this.at, this.at + length)); this.at += length; return value; }
  end() { if (this.at !== this.bytes.length) throw new SimpleFormatError("Kin received invalid Simple view data."); }
}

/** KIEM v1 as a Map itemId -> emoji. */
export function decodeItemEmojis(bytes) {
  const read = new Reader(bytes, "KIEM");
  const count = read.u32();
  const emojis = new Map();
  for (let index = 0; index < count; index += 1) {
    const itemId = read.id();
    emojis.set(itemId, read.text());
  }
  read.end();
  return emojis;
}

/** KMTQ v1 for `memberId`: 24 bytes; the KINE context follows it. */
export function encodeMyThingsQuery(memberId) {
  const out = new Uint8Array(24);
  out.set([75, 77, 84, 81, 1, 0, 0, 0]);
  out.set(idBytes(memberId, "member"), 8);
  return out;
}

/** KMTD v1 as [{ kind: "item", itemId } | { kind: "routine", routineId,
 * occurrenceKey (YYYYMMDD, as routine commands take it), done }], in Rust's
 * order. */
export function decodeMyThings(bytes) {
  const read = new Reader(bytes, "KMTD");
  const count = read.u32();
  const things = [];
  for (let index = 0; index < count; index += 1) {
    const kind = read.u8(), done = read.u8();
    if (read.u16() !== 0 || done > 1) throw new SimpleFormatError("Kin received invalid Simple view data.");
    const id = read.id();
    const date = read.u32();
    if (kind === 1 && !done && date === 0) things.push({ kind: "item", itemId: id });
    else if (kind === 2 && date !== 0) things.push({ kind: "routine", routineId: id, occurrenceKey: date, done: done === 1 });
    else throw new SimpleFormatError("Kin received invalid Simple view data.");
  }
  read.end();
  return things;
}
