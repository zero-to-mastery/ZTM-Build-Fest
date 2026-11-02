// A member's private log on the browser side (#489, ADR 0019). Rust
// (rust/src/private.rs) owns the records and their replay; this module only
// names the kinds and reads the KPRV projection Rust returns.
//
// Kinds 100–199 are reserved for private records: the placeholder
// PRIVATE_NOTE_SET (100); "Just for me" (#510) owns 110–119 and KPRV section
// 11 (rust/src/private_items.rs); reminders and settings that follow a member
// (#520) own 120–139 and KPRV sections 12 and 13 (kin-prefs.js); the journal
// (#496) owns 101–109 and KPRV section 101 (rust/src/journal.rs).
import { decodeReminders, decodeSettings, PREFS_KIND_CODES, SECTION_REMINDERS, SECTION_SETTINGS } from "./kin-prefs.js";

export const FIRST_PRIVATE_KIND = 100;
export const LAST_PRIVATE_KIND = 199;
export const MAX_PRIVATE_EVENT_COUNT = 50_000;
export const MAX_PRIVATE_NOTE_BYTES = 2048;
/** Event kinds from 100, in order. */
export const PRIVATE_EVENT_KINDS = Object.freeze(["PRIVATE_NOTE_SET"]);
/** "Just for me" (#510): event kinds from 110, in order (119 reserved). */
export const FIRST_PRIVATE_ITEM_KIND = 110;
export const PRIVATE_ITEM_EVENT_KINDS = Object.freeze([
  "PRIVATE_ITEM_ADDED",
  "PRIVATE_ITEM_EDITED",
  "PRIVATE_ITEM_COMPLETED",
  "PRIVATE_ITEM_REOPENED",
  "PRIVATE_ITEM_DATED",
  "PRIVATE_ITEM_DELETED",
  "PRIVATE_ITEM_RESTORED",
  "PRIVATE_ITEM_NOTE_SET",
  "PRIVATE_ITEMS_ON_TODAY_SET",
]);
/** Private item commands, one per kind from 110, in the same order. */
export const PRIVATE_ITEM_COMMANDS = Object.freeze([
  "add-private-item",
  "edit-private-item",
  "complete-private-item",
  "reopen-private-item",
  "date-private-item",
  "delete-private-item",
  "restore-private-item",
  "set-private-item-note",
  "set-private-items-on-today",
]);
export const MAX_PRIVATE_ITEMS = 2000;
export const MAX_PRIVATE_ITEM_TEXT_BYTES = 4096;
export const MAX_PRIVATE_ITEM_NOTE_BYTES = 2048;
/** Reminders and settings (#520): kinds 120, 121 and 130 (kin-prefs.js). */
export const PREFS_EVENT_KINDS = Object.freeze(Object.keys(PREFS_KIND_CODES));
/** The journal (#496): event kinds from 101, in order (105–109 reserved). */
export const FIRST_JOURNAL_KIND = 101;
export const JOURNAL_EVENT_KINDS = Object.freeze([
  "JOURNAL_ENTRY_CREATED", "JOURNAL_ENTRY_EDITED", "JOURNAL_ENTRY_DELETED", "JOURNAL_ENTRY_RESTORED",
]);
export const MAX_JOURNAL_TITLE_BYTES = 200;
export const MAX_JOURNAL_BODY_BYTES = 20_000;
export const MAX_JOURNAL_PHOTOS = 10;
export const MIN_JOURNAL_PHOTO_BYTES = 29;
export const MAX_JOURNAL_PHOTO_BYTES = 4 * 1024 * 1024 + 4096;
/** KCMD actions for the journal, with the kind each makes. */
export const JOURNAL_COMMANDS = Object.freeze({
  "create-journal-entry": 101,
  "edit-journal-entry": 102,
  "delete-journal-entry": 103,
  "restore-journal-entry": 104,
});
/** Photo types by their code in a journal record. */
export const JOURNAL_PHOTO_TYPES = Object.freeze(["", "image/jpeg", "image/png", "image/webp"]);
const PHOTO_BYTES = 136;


const SECTION_NOTES = 1;
const SECTION_ITEMS = 11;
const SECTION_JOURNAL = 101;
const FLAG_OFF_TODAY = 1;
const ID = /^[a-f0-9]{32}$/;
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export class PrivateFormatError extends Error {
  constructor(message = "Kin received an invalid private projection.") {
    super(message);
    this.name = "PrivateFormatError";
  }
}

/** Whether a kind name (KMET `kind`) is a private kind. */
export function isPrivateKind(kind) {
  return PRIVATE_EVENT_KINDS.includes(kind) || PRIVATE_ITEM_EVENT_KINDS.includes(kind) || PREFS_EVENT_KINDS.includes(kind) ||
    JOURNAL_EVENT_KINDS.includes(kind);
}

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Reads KPRV v1 (private.rs `encode_private`): `{ memberId, recordCount,
 * notes: [{ id, logicalTime, deviceId, text }], items, onToday }`.
 * `memberId` is null while the log is empty. `items` is the "Just for me"
 * list (section 11, #510): `[{ id, addedAt, changedAt, date, completed,
 * text, note }]` in ID order, with `date` a civil date (YYYYMMDD) or null;
 * `onToday` is whether dated items show on Today and This week (on until the
 * member turns it off). `reminders` (section 12) and `settings` (section 13,
 * #520) are kin-prefs.js decodeReminders and decodeSettings. `journal` is the
 * journal (section 101, #496), newest first as Rust ordered it. Sections this
 * release doesn't know are skipped, so a later engine's additions never break
 * an older reader.
 */
export function decodePrivate(bytes) {
  const invalid = () => new PrivateFormatError();
  if (!(bytes instanceof Uint8Array) || bytes.length < 32) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "KPRV" || view.getUint16(4, true) !== 1 ||
      view.getUint16(6, true) !== 0 || view.getUint16(30, true) !== 0)
    throw invalid();
  const member = bytes.subarray(8, 24);
  const result = {
    memberId: member.every((byte) => byte === 0) ? null : toHex(member),
    recordCount: view.getUint32(24, true),
    notes: [],
    items: [],
    onToday: true,
    reminders: [],
    settings: {},
    journal: [],
  };
  const sections = view.getUint16(28, true);
  let at = 32, previous = 0;
  for (let index = 0; index < sections; index += 1) {
    if (at + 8 > bytes.length) throw invalid();
    const code = view.getUint16(at, true);
    const length = view.getUint32(at + 4, true);
    if (code <= previous || view.getUint16(at + 2, true) !== 0 || at + 8 + length > bytes.length) throw invalid();
    previous = code;
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (code === SECTION_NOTES) result.notes = decodeNotes(body);
    if (code === SECTION_ITEMS) Object.assign(result, decodeItems(body));
    if (code === SECTION_JOURNAL) result.journal = decodeJournal(body);
    try {
      if (code === SECTION_REMINDERS) result.reminders = decodeReminders(body);
      if (code === SECTION_SETTINGS) result.settings = decodeSettings(body);
    } catch { throw invalid(); }
    at += 8 + length;
  }
  if (at !== bytes.length) throw invalid();
  return result;
}

function decodeNotes(bytes) {
  const invalid = () => new PrivateFormatError();
  if (bytes.length < 4) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > MAX_PRIVATE_EVENT_COUNT) throw invalid();
  const notes = [];
  let at = 4;
  for (let index = 0; index < count; index += 1) {
    if (at + 44 > bytes.length) throw invalid();
    const length = view.getUint32(at + 40, true);
    if (length > MAX_PRIVATE_NOTE_BYTES || at + 44 + length > bytes.length) throw invalid();
    let text;
    try { text = strictDecoder.decode(bytes.subarray(at + 44, at + 44 + length)); } catch { throw invalid(); }
    notes.push({
      id: toHex(bytes.subarray(at, at + 16)),
      logicalTime: view.getBigUint64(at + 16, true),
      deviceId: toHex(bytes.subarray(at + 24, at + 40)),
      text,
    });
    at += 44 + length;
  }
  if (at !== bytes.length) throw invalid();
  return notes;
}

/** KPRV section 11 (private_items.rs `encode_section`). */
function decodeItems(bytes) {
  const invalid = () => new PrivateFormatError();
  if (bytes.length < 8) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  if ((flags & ~FLAG_OFF_TODAY) !== 0 || count > MAX_PRIVATE_ITEMS) throw invalid();
  const items = [];
  let at = 8;
  for (let index = 0; index < count; index += 1) {
    if (at + 48 > bytes.length) throw invalid();
    const status = bytes[at + 36];
    const date = view.getUint32(at + 32, true);
    const textLength = view.getUint32(at + 40, true);
    const noteLength = view.getUint32(at + 44, true);
    const addedAt = Number(view.getBigInt64(at + 16, true));
    if (status > 1 || bytes[at + 37] || bytes[at + 38] || bytes[at + 39] || textLength < 1 ||
        textLength > MAX_PRIVATE_ITEM_TEXT_BYTES || noteLength > MAX_PRIVATE_ITEM_NOTE_BYTES ||
        at + 48 + textLength + noteLength > bytes.length || !Number.isSafeInteger(addedAt))
      throw invalid();
    let text, note;
    try {
      text = strictDecoder.decode(bytes.subarray(at + 48, at + 48 + textLength));
      note = strictDecoder.decode(bytes.subarray(at + 48 + textLength, at + 48 + textLength + noteLength));
    } catch { throw invalid(); }
    items.push({
      id: toHex(bytes.subarray(at, at + 16)),
      addedAt,
      changedAt: view.getBigUint64(at + 24, true),
      date: date === 0 ? null : date,
      completed: status === 1,
      text,
      note,
    });
    at += 48 + textLength + noteLength;
  }
  if (at !== bytes.length) throw invalid();
  return { items, onToday: (flags & FLAG_OFF_TODAY) === 0 };
}

function hexBytes(value, what) {
  if (!ID.test(value ?? "")) throw new PrivateFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

function civilDateField(value) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 10101 || value > 99991231)
    throw new PrivateFormatError("Kin received an invalid date.");
  return value;
}

/** Text as the engine wants it; Rust checks the rest (controls, trimming). */
function textBytes(text, { max, optional = false }) {
  if (typeof text !== "string") throw new PrivateFormatError("Kin received invalid text.");
  const bytes = encoder.encode(text);
  if (!optional && bytes.length === 0) throw new PrivateFormatError("Write a few words first.");
  if (bytes.length > max) throw new PrivateFormatError("That's too long to keep. Shorten it a little.");
  return bytes;
}

const u32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

/**
 * The exact payload of a private item command (rust/src/private_items.rs):
 * `{ type, itemId, text?, date?, note?, on? }` with `itemId` as 32 hex
 * digits and `date` a civil date (YYYYMMDD) or null.
 */
export function encodePrivateItemPayload(command) {
  if (!PRIVATE_ITEM_COMMANDS.includes(command?.type)) throw new PrivateFormatError("Kin received an invalid private change.");
  if (command.type === "set-private-items-on-today") return Uint8Array.of(command.on ? 1 : 0, 0, 0, 0);
  const parts = [hexBytes(command.itemId, "private item")];
  const withLength = (bytes) => parts.push(u32(bytes.length), bytes);
  switch (command.type) {
    case "add-private-item":
      parts.push(u32(civilDateField(command.date ?? null)));
      withLength(textBytes(command.text, { max: MAX_PRIVATE_ITEM_TEXT_BYTES }));
      break;
    case "edit-private-item":
      withLength(textBytes(command.text, { max: MAX_PRIVATE_ITEM_TEXT_BYTES }));
      break;
    case "date-private-item":
      parts.push(u32(civilDateField(command.date ?? null)));
      break;
    case "set-private-item-note":
      withLength(textBytes(command.note ?? "", { max: MAX_PRIVATE_ITEM_NOTE_BYTES, optional: true }));
      break;
    default:
      break;
  }
  const payload = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { payload.set(part, offset); offset += part.length; }
  return payload;
}

function fromHex(value, length, what) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length * 2}}$`).test(value) || /^0+$/.test(value))
    throw new PrivateFormatError(`Kin received an invalid journal ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

/** "YYYY-MM-DD" to the engine's YYYYMMDD number, or null. */
export function encodeCivilDate(value) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return year * 10_000 + month * 100 + day;
}

function decodeCivilDate(value) {
  return `${String(Math.floor(value / 10_000)).padStart(4, "0")}-${String(Math.floor(value / 100) % 100).padStart(2, "0")}-${String(value % 100).padStart(2, "0")}`;
}

/**
 * A title as the journal keeps it: one line, white space collapsed, trimmed.
 * Never cut: a title that is too long is refused where it is typed.
 */
export function normalizeJournalTitle(value) {
  return String(value ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
}

/**
 * A body as the journal keeps it: plain text with line feeds, any other
 * line break made a line feed, tabs made spaces, other control characters
 * dropped, trimmed at both ends.
 */
export function normalizeJournalBody(value) {
  return String(value ?? "")
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[^\P{Cc}\n]/gu, "")
    .trim();
}

/** Why a title or body can't be saved, or null. */
export function journalTextProblem({ title = "", body = "", photos = [] } = {}) {
  if (encoder.encode(title).length > MAX_JOURNAL_TITLE_BYTES) return "That title is too long. Keep it under about 200 characters.";
  if (encoder.encode(body).length > MAX_JOURNAL_BODY_BYTES) return "That entry is too long to save as one. Split it into two entries.";
  if (!title && !body && !photos.length) return "Write something or add a photo first.";
  return null;
}

function photoBytes(photo) {
  const type = JOURNAL_PHOTO_TYPES.indexOf(photo?.type);
  if (type < 1 || !Number.isSafeInteger(photo.size) || photo.size < MIN_JOURNAL_PHOTO_BYTES || photo.size > MAX_JOURNAL_PHOTO_BYTES)
    throw new PrivateFormatError("Kin received an invalid journal photo.");
  const bytes = new Uint8Array(PHOTO_BYTES);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(4, photo.size, true);
  bytes.set(fromHex(photo.ref, 32, "photo"), 8);
  bytes.set(fromHex(photo.key, 32, "photo key"), 40);
  bytes.set(fromHex(photo.thumbnail, 32, "thumbnail"), 72);
  bytes.set(fromHex(photo.thumbnailKey, 32, "thumbnail key"), 104);
  return bytes;
}

/**
 * The exact payload of a journal command (journal.rs layouts). A create or
 * edit carries `{ entryId, date: "YYYY-MM-DD", title, body, photos }`, whose
 * text is already normalized (Rust refuses it otherwise); a delete or
 * restore carries `{ entryId }`.
 */
export function encodeJournalPayload(command) {
  const kind = JOURNAL_COMMANDS[command?.type];
  if (!kind) throw new PrivateFormatError("Kin received an invalid journal change.");
  const id = fromHex(command.entryId, 16, "entry");
  if (kind === 103 || kind === 104) return id;
  const date = encodeCivilDate(command.date);
  const title = typeof command.title === "string" && command.title.isWellFormed() ? encoder.encode(command.title) : null;
  const body = typeof command.body === "string" && command.body.isWellFormed() ? encoder.encode(command.body) : null;
  const photos = Array.isArray(command.photos) ? command.photos : null;
  if (date === null || !title || !body || !photos || title.length > MAX_JOURNAL_TITLE_BYTES ||
      body.length > MAX_JOURNAL_BODY_BYTES || photos.length > MAX_JOURNAL_PHOTOS)
    throw new PrivateFormatError("Kin received an invalid journal entry.");
  const payload = new Uint8Array(28 + title.length + body.length + PHOTO_BYTES * photos.length);
  const view = new DataView(payload.buffer);
  payload.set(id, 0);
  view.setUint32(16, date, true);
  view.setUint16(20, title.length, true);
  payload[22] = photos.length;
  view.setUint32(24, body.length, true);
  payload.set(title, 28);
  payload.set(body, 28 + title.length);
  photos.forEach((photo, index) => payload.set(photoBytes(photo), 28 + title.length + body.length + PHOTO_BYTES * index));
  return payload;
}

/** A private command's kind code (`kin_private_execute` takes 100–199). */
export function privateCommandKind(command) {
  if (JOURNAL_COMMANDS[command?.type]) return JOURNAL_COMMANDS[command.type];
  const action = PRIVATE_ITEM_COMMANDS.indexOf(command?.type);
  if (action < 0) throw new PrivateFormatError("Kin received an invalid private change.");
  return FIRST_PRIVATE_ITEM_KIND + action;
}

/**
 * A KCMD packet for a private command: the 128-byte header (identity and
 * logical time as for every command; no entity ID, date, option or expiry)
 * and the event's exact payload as its text. `identity` is `{ eventId,
 * householdId, actorId, deviceId, timestamp, logicalTime }` with hex IDs.
 */
export function encodePrivateIntent(command, identity) {
  const kind = privateCommandKind(command);
  const payload = JOURNAL_COMMANDS[command.type] ? encodeJournalPayload(command) : encodePrivateItemPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, kind, true);
  packet.set(hexBytes(identity?.eventId, "event"), 12);
  packet.set(hexBytes(identity.householdId, "household"), 28);
  packet.set(hexBytes(identity.actorId, "member"), 44);
  packet.set(hexBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new PrivateFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new PrivateFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** Section 101 (journal.rs `encode_section`). */
function decodeJournal(bytes) {
  const invalid = () => new PrivateFormatError();
  if (bytes.length < 4) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > MAX_PRIVATE_EVENT_COUNT) throw invalid();
  const entries = [];
  let at = 4;
  const text = (from, length) => {
    try { return strictDecoder.decode(bytes.subarray(from, from + length)); } catch { throw invalid(); }
  };
  for (let index = 0; index < count; index += 1) {
    if (at + 60 > bytes.length) throw invalid();
    const date = view.getUint32(at + 48, true);
    const titleLength = view.getUint16(at + 52, true);
    const photoCount = bytes[at + 54];
    const bodyLength = view.getUint32(at + 56, true);
    const end = at + 60 + titleLength + bodyLength + PHOTO_BYTES * photoCount;
    if (bytes[at + 55] !== 0 || titleLength > MAX_JOURNAL_TITLE_BYTES || bodyLength > MAX_JOURNAL_BODY_BYTES ||
        photoCount > MAX_JOURNAL_PHOTOS || end > bytes.length || encodeCivilDate(decodeCivilDate(date)) !== date)
      throw invalid();
    const photos = [];
    for (let photo = 0; photo < photoCount; photo += 1) {
      const from = at + 60 + titleLength + bodyLength + PHOTO_BYTES * photo;
      const type = JOURNAL_PHOTO_TYPES[bytes[from]];
      if (!type) throw invalid();
      photos.push({
        type,
        size: view.getUint32(from + 4, true),
        ref: toHex(bytes.subarray(from + 8, from + 40)),
        key: toHex(bytes.subarray(from + 40, from + 72)),
        thumbnail: toHex(bytes.subarray(from + 72, from + 104)),
        thumbnailKey: toHex(bytes.subarray(from + 104, from + 136)),
      });
    }
    entries.push({
      id: toHex(bytes.subarray(at, at + 16)),
      created: view.getBigUint64(at + 16, true),
      updated: view.getBigUint64(at + 24, true),
      deviceId: toHex(bytes.subarray(at + 32, at + 48)),
      date: decodeCivilDate(date),
      title: text(at + 60, titleLength),
      body: text(at + 60 + titleLength, bodyLength),
      photos,
    });
    at = end;
  }
  if (at !== bytes.length) throw invalid();
  return entries;
}
