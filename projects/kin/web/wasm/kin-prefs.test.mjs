// Reminders and settings on the browser side (#520): the payloads and KCMD
// packets kin_private_execute takes (byte for byte the records
// rust/src/private_prefs_tests.rs writes out by hand, docs/TEST-VECTORS.md
// 100–102), and KPRV sections 12 and 13.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeReminders, decodeSettings, encodePrefsIntent, encodePrefsPayload, parseReminderId, PrefsFormatError, PREFS_KIND_CODES, SETTING_KEYS } from "./kin-prefs.js";
import { decodePrivate } from "./kin-private.js";

const ITEM = "5a".repeat(16);
const NINE_NEW_YORK = 1_792_501_200_000;
const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

test("a reminder set encodes as the 100 payload", () => {
  const { code, bytes } = encodePrefsPayload({
    type: "set-reminder", reminderId: `item:${ITEM}`, at: NINE_NEW_YORK, utcOffsetMinutes: -240, timeZone: "America/New_York",
  });
  assert.equal(code, 120);
  assert.equal(bytes.length, 48);
  assert.deepEqual([...bytes.subarray(0, 4)], [1, 0, 0, 0]);
  assert.equal(hex(bytes.subarray(4, 20)), ITEM);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getBigInt64(20, true), BigInt(NINE_NEW_YORK));
  assert.equal(view.getInt16(28, true), -240);
  assert.deepEqual([...bytes.subarray(30, 32)], [16, 0]);
  assert.equal(new TextDecoder().decode(bytes.subarray(32)), "America/New_York");
});

test("a dismissal and a setting encode as the 101 and 102 payloads", () => {
  const cleared = encodePrefsPayload({ type: "clear-reminder", reminderId: `item:${ITEM}`, reason: "dismissed", at: NINE_NEW_YORK });
  assert.equal(cleared.code, 121);
  assert.equal(cleared.bytes.length, 28);
  assert.deepEqual([...cleared.bytes.subarray(0, 4)], [1, 3, 0, 0]);
  const setting = encodePrefsPayload({ type: "set-setting", key: "theme-mode", value: "dark" });
  assert.equal(setting.code, 130);
  assert.deepEqual([...setting.bytes], [1, 0, 4, 0, ...encoder.encode("dark")]);
  // A key by number (one a later release names) and an unset.
  assert.deepEqual([...encodePrefsPayload({ type: "set-setting", key: 42, value: "" }).bytes], [42, 0, 0, 0]);
  assert.equal(SETTING_KEYS["private-on-today"], 7, "reserved for the Just for me list");
  assert.equal(SETTING_KEYS["easy-mode"], 8, "easy mode (#617)");
  assert.deepEqual([...encodePrefsPayload({ type: "set-setting", key: "easy-mode", value: "on" }).bytes], [8, 0, 2, 0, ...encoder.encode("on")]);
});

test("intents are refused before they reach the engine when malformed", () => {
  const bad = (command) => assert.throws(() => encodePrefsPayload(command), PrefsFormatError);
  bad({ type: "set-reminder", reminderId: `note:${ITEM}`, at: 1, utcOffsetMinutes: 0 });
  bad({ type: "set-reminder", reminderId: `item:${"0".repeat(32)}`, at: 1, utcOffsetMinutes: 0 });
  bad({ type: "set-reminder", reminderId: `item:${ITEM}`, at: 1.5, utcOffsetMinutes: 0 });
  bad({ type: "set-reminder", reminderId: `item:${ITEM}`, at: 1, utcOffsetMinutes: 900 });
  bad({ type: "set-reminder", reminderId: `item:${ITEM}`, at: 1, utcOffsetMinutes: 0, timeZone: "Bad Zone" });
  bad({ type: "clear-reminder", reminderId: `item:${ITEM}`, reason: "forgotten", at: 1 });
  bad({ type: "set-setting", key: "theme-mode", value: "Dark" });
  bad({ type: "set-setting", key: "nothing-like-it", value: "on" });
  bad({ type: "set-setting", key: 0, value: "on" });
  bad({ type: "add", text: "Milk" });
  assert.equal(parseReminderId(`routine:${ITEM}`).kind, "routine");
  assert.equal(parseReminderId("routine:abc"), null);
});

test("the KCMD carries the kind as its action and the payload as its text", () => {
  const identity = {
    eventId: "01".repeat(16), householdId: "aa".repeat(16), actorId: "02".repeat(16), deviceId: "11".repeat(16),
    timestamp: 1_791_475_200_001, logicalTime: 7n,
  };
  const packet = encodePrefsIntent({ type: "set-setting", key: "text-size", value: "large" }, identity);
  const view = new DataView(packet.buffer);
  assert.equal(new TextDecoder().decode(packet.subarray(0, 4)), "KCMD");
  assert.equal(view.getUint16(4, true), 1);
  assert.equal(view.getUint16(8, true), PREFS_KIND_CODES.SETTING_SET);
  assert.equal(hex(packet.subarray(12, 28)), identity.eventId);
  assert.equal(hex(packet.subarray(60, 76)), identity.deviceId);
  assert.equal(view.getBigUint64(84, true), 7n);
  assert.ok(packet.subarray(92, 124).every((byte) => byte === 0), "no entity, date, option or expiry");
  assert.equal(view.getUint32(124, true), 9);
  assert.deepEqual([...packet.subarray(128)], [3, 0, 5, 0, ...encoder.encode("large")]);
  assert.throws(() => encodePrefsIntent({ type: "set-setting", key: "motion", value: "reduce" }, { ...identity, logicalTime: 0n }), PrefsFormatError);
});

/** Section 12 and 13 bodies as private_prefs.rs writes them. */
function remindersSection(entries) {
  const parts = [Uint32Array.of(entries.length)];
  for (const entry of entries) {
    const zone = encoder.encode(entry.zone);
    const row = new Uint8Array(56 + zone.length);
    const view = new DataView(row.buffer);
    row[0] = entry.kind;
    row.fill(entry.id, 4, 20);
    view.setBigInt64(20, BigInt(entry.at), true);
    view.setInt16(28, entry.offset, true);
    row[30] = zone.length;
    view.setBigUint64(32, BigInt(entry.logicalTime), true);
    row.fill(0x12, 40, 56);
    row.set(zone, 56);
    parts.push(row);
  }
  return join(parts);
}

function settingsSection(entries) {
  const parts = [Uint32Array.of(entries.length)];
  for (const [key, value, logicalTime] of entries) {
    const text = encoder.encode(value);
    const row = new Uint8Array(28 + text.length);
    const view = new DataView(row.buffer);
    view.setUint16(0, key, true);
    row[2] = text.length;
    view.setBigUint64(4, BigInt(logicalTime), true);
    row.fill(0x11, 12, 28);
    row.set(text, 28);
    parts.push(row);
  }
  return join(parts);
}

function join(parts) {
  const bytes = parts.map((part) => new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  const out = new Uint8Array(bytes.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of bytes) { out.set(part, at); at += part.length; }
  return out;
}

function kprv(sections) {
  const header = new Uint8Array(32);
  header.set(encoder.encode("KPRV"));
  new DataView(header.buffer).setUint16(4, 1, true);
  header.fill(1, 8, 24);
  new DataView(header.buffer).setUint16(28, sections.length, true);
  const parts = [header];
  for (const [code, body] of sections) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint16(0, code, true);
    new DataView(head.buffer).setUint32(4, body.length, true);
    parts.push(head, body);
  }
  return join(parts);
}

test("KPRV sections 12 and 13 read as reminders and settings", () => {
  const value = decodePrivate(kprv([
    [1, Uint8Array.of(0, 0, 0, 0)],
    [12, remindersSection([
      { kind: 1, id: 0x5a, at: NINE_NEW_YORK, offset: -240, zone: "America/New_York", logicalTime: 2 },
      { kind: 2, id: 0x5b, at: NINE_NEW_YORK + 1, offset: 60, zone: "", logicalTime: 1 },
    ])],
    [13, settingsSection([[1, "dark", 4], [3, "large", 3], [42, "later", 5]])],
  ]));
  assert.deepEqual(value.reminders.map((reminder) => [reminder.reminderId, reminder.at, reminder.utcOffsetMinutes, reminder.timeZone, reminder.logicalTime, reminder.deviceId]), [
    [`item:${ITEM}`, NINE_NEW_YORK, -240, "America/New_York", 2n, "12".repeat(16)],
    [`routine:${"5b".repeat(16)}`, NINE_NEW_YORK + 1, 60, "", 1n, "12".repeat(16)],
  ]);
  assert.equal(value.settings["theme-mode"].value, "dark");
  assert.equal(value.settings["text-size"].value, "large");
  assert.equal(value.settings["42"].value, "later", "a key a later release names is kept by number");
  assert.equal(value.settings["theme-mode"].deviceId, "11".repeat(16));
});

test("damaged reminder and setting sections are refused", () => {
  const good = remindersSection([{ kind: 1, id: 0x5a, at: 1, offset: 0, zone: "UTC", logicalTime: 1 }]);
  assert.throws(() => decodeReminders(good.subarray(0, good.length - 1)), PrefsFormatError);
  const kind = good.slice(); kind[4] = 3;
  assert.throws(() => decodeReminders(kind), PrefsFormatError);
  assert.throws(() => decodeReminders(join([good, Uint8Array.of(0)])), PrefsFormatError);
  const settings = settingsSection([[1, "dark", 1]]);
  const reserved = settings.slice(); reserved[7] = 1;
  assert.throws(() => decodeSettings(reserved), PrefsFormatError);
  // Inside KPRV a damaged section is a damaged projection.
  assert.throws(() => decodePrivate(kprv([[12, kind]])));
});
