// Reminders and settings that follow a member (#520) on the browser side:
// the private kinds 120 (REMINDER_SET), 121 (REMINDER_CLEARED) and 130
// (SETTING_SET), the KCMD packets kin_private_execute takes for them, and
// KPRV sections 12 (reminders) and 13 (settings). Rust
// (rust/src/private_prefs.rs) owns the records, their rules and replay;
// this module only lays out bytes and reads what Rust returns.

/** Event kinds by code (kin-private.js merges them with the others). */
export const PREFS_KIND_CODES = Object.freeze({ REMINDER_SET: 120, REMINDER_CLEARED: 121, SETTING_SET: 130 });
/** The intents kin_private_execute takes for them. */
export const PREFS_COMMANDS = Object.freeze(["set-reminder", "clear-reminder", "set-setting"]);
export const SECTION_REMINDERS = 12;
export const SECTION_SETTINGS = 13;
export const MAX_TIME_ZONE_BYTES = 64;
export const MAX_SETTING_VALUE_BYTES = 32;

/** The settings Kin knows, by name (private_prefs.rs `SETTING_*`). Key 7
 * is reserved for the "Just for me" list's "my private things on Today";
 * key 8 is easy mode (#617, ADR 0021). */
export const SETTING_KEYS = Object.freeze({
  "theme-mode": 1,
  "theme-color": 2,
  "text-size": 3,
  motion: 4,
  "reminder-alerts": 5,
  "app-badge": 6,
  "private-on-today": 7,
  "easy-mode": 8,
});
const SETTING_NAMES = new Map(Object.entries(SETTING_KEYS).map(([name, key]) => [key, name]));
const TARGET_KINDS = Object.freeze({ item: 1, routine: 2 });
const TARGET_NAMES = ["", "item", "routine"];
const CLEAR_REASONS = Object.freeze({ canceled: 1, done: 2, dismissed: 3 });

export class PrefsFormatError extends Error {
  constructor(message = "Kin received an invalid reminder or setting.") {
    super(message);
    this.name = "PrefsFormatError";
  }
}

const ascii = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexBytes(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value) || /^0+$/.test(value)) throw new PrefsFormatError();
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

/** "item:<hex>" or "routine:<hex>" — the reminder IDs the views use — as
 * { kind, id }, or null. */
export function parseReminderId(reminderId) {
  const match = /^(item|routine):([a-f0-9]{32})$/.exec(reminderId ?? "");
  return match && !/^0+$/.test(match[2]) ? { kind: match[1], id: match[2] } : null;
}

export const reminderIdOf = (target) => `${target.kind}:${target.id}`;

function targetBytes(reminderId) {
  const target = parseReminderId(reminderId);
  if (!target) throw new PrefsFormatError("Kin can only remind about an item or a routine.");
  return { kind: TARGET_KINDS[target.kind], id: hexBytes(target.id) };
}

/** The canonical payload of one intent (private_prefs.rs `encode_payload`). */
export function encodePrefsPayload(command) {
  if (command?.type === "set-reminder") {
    const { kind, id } = targetBytes(command.reminderId);
    const zone = command.timeZone ?? "";
    if (!Number.isSafeInteger(command.at) || !Number.isInteger(command.utcOffsetMinutes) ||
        command.utcOffsetMinutes < -720 || command.utcOffsetMinutes > 840 ||
        typeof zone !== "string" || zone.length > MAX_TIME_ZONE_BYTES || !/^[A-Za-z0-9/_+-]*$/.test(zone))
      throw new PrefsFormatError("Kin couldn't read that reminder time.");
    const bytes = new Uint8Array(32 + zone.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = kind;
    bytes.set(id, 4);
    view.setBigInt64(20, BigInt(command.at), true);
    view.setInt16(28, command.utcOffsetMinutes, true);
    bytes[30] = zone.length;
    bytes.set(ascii.encode(zone), 32);
    return { code: PREFS_KIND_CODES.REMINDER_SET, bytes };
  }
  if (command?.type === "clear-reminder") {
    const { kind, id } = targetBytes(command.reminderId);
    const reason = CLEAR_REASONS[command.reason];
    if (!reason || !Number.isSafeInteger(command.at)) throw new PrefsFormatError();
    const bytes = new Uint8Array(28);
    bytes[0] = kind;
    bytes[1] = reason;
    bytes.set(id, 4);
    new DataView(bytes.buffer).setBigInt64(20, BigInt(command.at), true);
    return { code: PREFS_KIND_CODES.REMINDER_CLEARED, bytes };
  }
  if (command?.type === "set-setting") {
    const key = typeof command.key === "number" ? command.key : SETTING_KEYS[command.key];
    const value = command.value ?? "";
    if (!Number.isInteger(key) || key < 1 || key > 255 || typeof value !== "string" ||
        value.length > MAX_SETTING_VALUE_BYTES || !/^[a-z0-9-]*$/.test(value))
      throw new PrefsFormatError("Kin couldn't read that setting.");
    const bytes = new Uint8Array(4 + value.length);
    new DataView(bytes.buffer).setUint16(0, key, true);
    bytes[2] = value.length;
    bytes.set(ascii.encode(value), 4);
    return { code: PREFS_KIND_CODES.SETTING_SET, bytes };
  }
  throw new PrefsFormatError("Kin received an invalid private change.");
}

/** KCMD for one intent: the action is the kind code and the text is the
 * event's exact payload; no entity ID, option, date or expiry. `identity`
 * carries eventId, householdId, actorId, deviceId (hex), timestamp and
 * logicalTime. */
export function encodePrefsIntent(command, identity) {
  const { code, bytes: payload } = encodePrefsPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, code, true);
  const id = (value) => {
    if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new PrefsFormatError("Kin received an invalid identity.");
    return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
  };
  packet.set(id(identity.eventId), 12);
  packet.set(id(identity.householdId), 28);
  packet.set(id(identity.actorId), 44);
  packet.set(id(identity.deviceId), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new PrefsFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new PrefsFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** KPRV section 12: [{ reminderId, kind, targetId, at, utcOffsetMinutes,
 * timeZone, logicalTime, deviceId }] in target order. */
export function decodeReminders(bytes) {
  const invalid = () => new PrefsFormatError();
  if (bytes.length < 4) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const reminders = [];
  let at = 4;
  for (let index = 0; index < count; index += 1) {
    if (at + 56 > bytes.length) throw invalid();
    const kind = TARGET_NAMES[bytes[at]];
    const length = bytes[at + 30];
    if (!kind || bytes[at + 1] || bytes[at + 2] || bytes[at + 3] || bytes[at + 31] ||
        length > MAX_TIME_ZONE_BYTES || at + 56 + length > bytes.length) throw invalid();
    const due = Number(view.getBigInt64(at + 20, true));
    if (!Number.isSafeInteger(due)) throw invalid();
    let timeZone;
    try { timeZone = strict.decode(bytes.subarray(at + 56, at + 56 + length)); } catch { throw invalid(); }
    const targetId = toHex(bytes.subarray(at + 4, at + 20));
    reminders.push({
      reminderId: `${kind}:${targetId}`, kind, targetId, at: due,
      utcOffsetMinutes: view.getInt16(at + 28, true), timeZone,
      logicalTime: view.getBigUint64(at + 32, true),
      deviceId: toHex(bytes.subarray(at + 40, at + 56)),
    });
    at += 56 + length;
  }
  if (at !== bytes.length) throw invalid();
  return reminders;
}

/** KPRV section 13: { [name or key]: { value, logicalTime, deviceId } }.
 * Keys this release doesn't name stay under their number. */
export function decodeSettings(bytes) {
  const invalid = () => new PrefsFormatError();
  if (bytes.length < 4) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const settings = {};
  let at = 4;
  for (let index = 0; index < count; index += 1) {
    if (at + 28 > bytes.length) throw invalid();
    const key = view.getUint16(at, true);
    const length = bytes[at + 2];
    if (!key || bytes[at + 3] || length > MAX_SETTING_VALUE_BYTES || at + 28 + length > bytes.length) throw invalid();
    let value;
    try { value = strict.decode(bytes.subarray(at + 28, at + 28 + length)); } catch { throw invalid(); }
    settings[SETTING_NAMES.get(key) ?? String(key)] = {
      value, logicalTime: view.getBigUint64(at + 4, true), deviceId: toHex(bytes.subarray(at + 12, at + 28)),
    };
    at += 28 + length;
  }
  if (at !== bytes.length) throw invalid();
  return settings;
}
