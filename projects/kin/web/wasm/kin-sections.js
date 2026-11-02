// Store sections (#411, ADR 0015) codecs, matching rust/src/store_sections.rs:
// - "set-shopping-sections" (KCMD action 66, SHOPPING_SECTIONS_SET):
//   { sections: [{ sectionId (hex), name }] }, the whole ordered list (0–30).
//   Payload: count u16, reserved u16, then each section ID [16] and name
//   (u16 length + UTF-8).
// - "set-item-section" (KCMD action 67, ITEM_SECTION_SET): { itemId,
//   sectionId (hex, or null to clear) }. Payload: item ID [16], section ID
//   [16] (all zero clears).
// - KSHS v1: { sections: [{ sectionId, name }], itemSections: Map itemId ->
//   sectionId }.
//
// Commands carry the event's exact canonical payload, so names are trimmed
// here exactly as Rust's `str::trim` does (Unicode White_Space, which is not
// JavaScript's `\s`). Rust decides the rest: unique IDs, unique names
// ignoring case, a change that changes something, the item and the section.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_ID = /^[a-f0-9]{32}$/;
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
const CONTROL = /\p{Cc}/u;

export const SECTION_COMMANDS = Object.freeze(["set-shopping-sections", "set-item-section"]);
export const SECTION_EVENT_KINDS = Object.freeze(["SHOPPING_SECTIONS_SET", "ITEM_SECTION_SET"]);
export const SHOPPING_SECTIONS_KIND = 66;
export const ITEM_SECTION_KIND = 67;
export const MAX_SECTIONS = 30;
export const MAX_SECTION_NAME_BYTES = 40;

export class SectionFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "SectionFormatError";
  }
}

const idBytes = (value, what) => {
  if (value instanceof Uint8Array && value.length === 16 && value.some(Boolean)) return value;
  if (typeof value !== "string" || !HEX_ID.test(value) || /^0+$/.test(value)) throw new SectionFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
};
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A section name as Rust stores it: trimmed, 1–40 UTF-8 bytes, plain text. */
export function normalizeSectionName(name) {
  const value = String(name ?? "").replace(EDGE_SPACE, "");
  if (!value) throw new SectionFormatError("A section needs a name.");
  if (encoder.encode(value).length > MAX_SECTION_NAME_BYTES) throw new SectionFormatError("A section name is too long.");
  if (CONTROL.test(value)) throw new SectionFormatError("A section name can only hold plain text.");
  return value;
}

/** The canonical kind-66 payload for { sections }. */
export function encodeShoppingSectionsPayload({ sections }) {
  if (!Array.isArray(sections) || sections.length > MAX_SECTIONS)
    throw new SectionFormatError(`A shop can have at most ${MAX_SECTIONS} sections.`);
  const entries = sections.map((section) => [idBytes(section?.sectionId, "section"), encoder.encode(normalizeSectionName(section?.name))]);
  const out = new Uint8Array(4 + entries.reduce((sum, [, name]) => sum + 18 + name.length, 0));
  out[0] = entries.length;
  let at = 4;
  for (const [id, name] of entries) {
    out.set(id, at);
    out[at + 16] = name.length;
    out.set(name, at + 18);
    at += 18 + name.length;
  }
  return out;
}

/** The canonical kind-67 payload for { itemId, sectionId } (null clears). */
export function encodeItemSectionPayload({ itemId, sectionId = null }) {
  const out = new Uint8Array(32);
  out.set(idBytes(itemId, "item"), 0);
  if (sectionId != null) out.set(idBytes(sectionId, "section"), 16);
  return out;
}

/** A KCMD packet for a store-sections command: the 128-byte header
 * (identity and logical time as for every command) with the payload as its
 * text. */
export function encodeSectionIntent(command, identity) {
  const kind = command?.type === "set-shopping-sections" ? SHOPPING_SECTIONS_KIND
    : command?.type === "set-item-section" ? ITEM_SECTION_KIND : 0;
  if (!kind) throw new SectionFormatError("Kin received an invalid section change.");
  const payload = kind === SHOPPING_SECTIONS_KIND ? encodeShoppingSectionsPayload(command) : encodeItemSectionPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, kind, true);
  packet.set(idBytes(identity.eventId, "event"), 12);
  packet.set(idBytes(identity.householdId, "household"), 28);
  packet.set(idBytes(identity.actorId, "member"), 44);
  packet.set(idBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new SectionFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new SectionFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** KSHS v1 as { sections: [{ sectionId, name }] in the household's order,
 * itemSections: Map itemId -> sectionId } (only listed sections, only items
 * that exist and aren't archived). */
export function decodeShoppingSections(bytes) {
  const invalid = () => new SectionFormatError("Kin received invalid store sections.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (count) => { if (at + count > bytes.length) throw invalid(); };
  const u32 = () => { need(4); const value = view.getUint32(at, true); at += 4; return value; };
  const id = () => { need(16); const value = toHex(bytes.subarray(at, at + 16)); at += 16; return value; };
  need(8);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "KSHS" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw invalid();
  at = 8;
  const sections = [];
  const listed = new Set();
  for (let count = u32(), index = 0; index < count; index += 1) {
    const sectionId = id();
    need(2);
    const length = view.getUint16(at, true);
    at += 2;
    need(length);
    const name = decoder.decode(bytes.subarray(at, at + length));
    at += length;
    if (!length || listed.has(sectionId)) throw invalid();
    listed.add(sectionId);
    sections.push({ sectionId, name });
  }
  const itemSections = new Map();
  for (let count = u32(), index = 0; index < count; index += 1) {
    const itemId = id();
    const sectionId = id();
    if (!listed.has(sectionId) || itemSections.has(itemId)) throw invalid();
    itemSections.set(itemId, sectionId);
  }
  if (at !== bytes.length) throw invalid();
  return { sections, itemSections };
}
