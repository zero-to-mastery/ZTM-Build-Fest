import test from "node:test";
import assert from "node:assert/strict";
import {
  decodePrivate, encodeCivilDate, encodeJournalPayload, encodePrivateIntent, encodePrivateItemPayload, FIRST_JOURNAL_KIND,
  FIRST_PRIVATE_ITEM_KIND, FIRST_PRIVATE_KIND, isPrivateKind, JOURNAL_EVENT_KINDS, journalTextProblem, MAX_PRIVATE_ITEM_NOTE_BYTES,
  MAX_PRIVATE_ITEM_TEXT_BYTES, normalizeJournalBody, normalizeJournalTitle, PRIVATE_EVENT_KINDS, PRIVATE_ITEM_COMMANDS,
  PRIVATE_ITEM_EVENT_KINDS, privateCommandKind, PrivateFormatError, PREFS_EVENT_KINDS,
} from "./kin-private.js";

const encoder = new TextEncoder();

/** KPRV as rust/src/private.rs writes it (private_tests.rs has the same layout). */
function kprv({ member = new Uint8Array(16), count = 0, notes = [], extra = [] } = {}) {
  const section = (code, body) => {
    const bytes = new Uint8Array(8 + body.length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, code, true);
    view.setUint32(4, body.length, true);
    bytes.set(body, 8);
    return bytes;
  };
  const noteBytes = [];
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, notes.length, true);
  noteBytes.push(head);
  for (const note of notes) {
    const text = encoder.encode(note.text);
    const row = new Uint8Array(44 + text.length);
    const view = new DataView(row.buffer);
    row.fill(note.id, 0, 16);
    view.setBigUint64(16, note.logicalTime, true);
    row.fill(0x11, 24, 40);
    view.setUint32(40, text.length, true);
    row.set(text, 44);
    noteBytes.push(row);
  }
  const notesBody = new Uint8Array(noteBytes.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of noteBytes) { notesBody.set(part, offset); offset += part.length; }
  const sections = [section(1, notesBody), ...extra.map(([code, body]) => section(code, body))];
  const total = 32 + sections.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("KPRV"), 0);
  view.setUint16(4, 1, true);
  bytes.set(member, 8);
  view.setUint32(24, count, true);
  view.setUint16(28, sections.length, true);
  offset = 32;
  for (const part of sections) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

test("an empty private log reads as no member and no notes", () => {
  assert.deepEqual(decodePrivate(kprv()), { memberId: null, recordCount: 0, notes: [], items: [], onToday: true, reminders: [], settings: {}, journal: [] });
});

test("notes read in the order Rust wrote them", () => {
  const value = decodePrivate(kprv({
    member: new Uint8Array(16).fill(1), count: 3,
    notes: [{ id: 1, logicalTime: 2n, text: "one" }, { id: 2, logicalTime: 5n, text: "two\nlines" }],
  }));
  assert.equal(value.memberId, "01".repeat(16));
  assert.equal(value.recordCount, 3);
  assert.deepEqual(value.notes.map((note) => [note.id, note.logicalTime, note.deviceId, note.text]), [
    ["01".repeat(16), 2n, "11".repeat(16), "one"],
    ["02".repeat(16), 5n, "11".repeat(16), "two\nlines"],
  ]);
});

test("a section a later engine adds is skipped, not refused", () => {
  const value = decodePrivate(kprv({ notes: [{ id: 3, logicalTime: 1n, text: "kept" }], extra: [[7, new Uint8Array([1, 2, 3])]] }));
  assert.equal(value.notes[0].text, "kept");
});

test("damaged projections are refused", () => {
  const good = kprv({ notes: [{ id: 1, logicalTime: 1n, text: "x" }] });
  assert.throws(() => decodePrivate(good.subarray(0, 31)), PrivateFormatError);
  const magic = good.slice(); magic[0] = 0x41;
  assert.throws(() => decodePrivate(magic), PrivateFormatError);
  const version = good.slice(); version[4] = 2;
  assert.throws(() => decodePrivate(version), PrivateFormatError);
  assert.throws(() => decodePrivate(new Uint8Array([...good, 0])), PrivateFormatError, "trailing bytes");
  const short = good.slice(); new DataView(short.buffer).setUint32(36, 999, true);
  assert.throws(() => decodePrivate(short), PrivateFormatError, "a section longer than the projection");
  const repeated = kprv({ extra: [[1, new Uint8Array([0, 0, 0, 0])]] });
  assert.throws(() => decodePrivate(repeated), PrivateFormatError, "sections ascend, each once");
});

test("private kinds start at 100", () => {
  assert.equal(FIRST_PRIVATE_KIND, 100);
  assert.deepEqual(PRIVATE_EVENT_KINDS, ["PRIVATE_NOTE_SET"]);
  assert.equal(FIRST_JOURNAL_KIND, 101);
  assert.deepEqual(JOURNAL_EVENT_KINDS, ["JOURNAL_ENTRY_CREATED", "JOURNAL_ENTRY_EDITED", "JOURNAL_ENTRY_DELETED", "JOURNAL_ENTRY_RESTORED"]);
  assert.ok(isPrivateKind("JOURNAL_ENTRY_RESTORED"));
  assert.ok(isPrivateKind("PRIVATE_NOTE_SET"));
  assert.deepEqual(PREFS_EVENT_KINDS, ["REMINDER_SET", "REMINDER_CLEARED", "SETTING_SET"]);
  assert.ok(isPrivateKind("PRIVATE_NOTE_SET") && isPrivateKind("SETTING_SET") && isPrivateKind("REMINDER_CLEARED"));
  assert.ok(!isPrivateKind("BOARD_STROKE_ADDED"));
});

// --- The journal (#496) -----------------------------------------------------

const hex = (byte, length) => byte.toString(16).padStart(2, "0").repeat(length);
const photo = (n, type = "image/jpeg", size = 52_000) => ({
  type, size, ref: hex(n, 32), key: hex(n + 1, 32), thumbnail: hex(n + 2, 32), thumbnailKey: hex(n + 3, 32),
});

test("a journal entry's payload matches test vector 068", () => {
  const payload = encodeJournalPayload({
    type: "create-journal-entry", entryId: hex(0x5a, 16), date: "2026-10-03", title: "Park", body: "Swings.\nThen cocoa.", photos: [photo(0x21)],
  });
  assert.equal(payload.length, 28 + 4 + 19 + 136);
  assert.deepEqual([...payload.subarray(0, 16)], new Array(16).fill(0x5a));
  assert.deepEqual([...payload.subarray(16, 28)], [0x8b, 0x28, 0x35, 0x01, 4, 0, 1, 0, 19, 0, 0, 0]);
  assert.equal(new TextDecoder().decode(payload.subarray(28, 51)), "ParkSwings.\nThen cocoa.");
  const at = 51;
  assert.deepEqual([...payload.subarray(at, at + 8)], [1, 0, 0, 0, 0x20, 0xcb, 0, 0]);
  assert.deepEqual([...payload.subarray(at + 8, at + 40)], new Array(32).fill(0x21));
  assert.deepEqual([...payload.subarray(at + 104, at + 136)], new Array(32).fill(0x24));
  // Delete and restore carry the ID alone.
  assert.deepEqual([...encodeJournalPayload({ type: "delete-journal-entry", entryId: hex(0x5a, 16) })], new Array(16).fill(0x5a));
  assert.equal(encodeJournalPayload({ type: "restore-journal-entry", entryId: hex(1, 16) }).length, 16);
});

test("a journal command is a KCMD with the kind and identity", () => {
  const identity = { eventId: hex(1, 16), householdId: hex(0xaa, 16), actorId: hex(2, 16), deviceId: hex(3, 16), timestamp: 1_791_475_200_000, logicalTime: 7n };
  const packet = encodePrivateIntent({ type: "edit-journal-entry", entryId: hex(9, 16), date: "2026-10-03", title: "", body: "x", photos: [] }, identity);
  const view = new DataView(packet.buffer);
  assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
  assert.equal(view.getUint16(8, true), 102);
  assert.equal(packet[28], 0xaa);
  assert.equal(view.getBigUint64(84, true), 7n);
  assert.equal(view.getUint32(124, true), 29);
  assert.ok(packet.subarray(92, 124).every((byte) => byte === 0));
  assert.throws(() => encodePrivateIntent({ type: "set-note" }, identity), PrivateFormatError);
  assert.throws(() => encodePrivateIntent({ type: "delete-journal-entry", entryId: hex(9, 16) }, { ...identity, logicalTime: 0n }), PrivateFormatError);
});

test("malformed journal commands are refused before they reach Rust", () => {
  const base = { type: "create-journal-entry", entryId: hex(1, 16), date: "2026-10-03", title: "", body: "x", photos: [] };
  for (const wrong of [
    { entryId: hex(0, 16) }, { entryId: "nope" }, { date: "2026-02-30" }, { date: "03/10/2026" }, { title: "a".repeat(201) },
    { body: "b".repeat(20_001) }, { body: "\ud800" }, { photos: new Array(11).fill(photo(1)) }, { photos: [photo(1, "image/gif")] },
    { photos: [photo(1, "image/jpeg", 28)] }, { photos: [{ ...photo(1), key: hex(0, 32) }] },
  ]) assert.throws(() => encodeJournalPayload({ ...base, ...wrong }), PrivateFormatError, JSON.stringify(wrong).slice(0, 40));
});

test("civil dates are checked as dates", () => {
  assert.equal(encodeCivilDate("2026-10-03"), 20261003);
  assert.equal(encodeCivilDate("2024-02-29"), 20240229);
  for (const wrong of ["2025-02-29", "2026-13-01", "0000-01-01", "2026-1-1", null]) assert.equal(encodeCivilDate(wrong), null);
});

test("journal text is normalized the way Rust keeps it", () => {
  assert.equal(normalizeJournalTitle("  A\tday\nat the  park \u2028 "), "A day at the park");
  assert.equal(normalizeJournalBody("\n  Line one\r\nline\ttwo\rthree\u0007\u0085four  \n"), "Line one\nline two\nthree\nfour");
  assert.equal(journalTextProblem({ title: "", body: "", photos: [] }), "Write something or add a photo first.");
  assert.equal(journalTextProblem({ title: "", body: "", photos: [{}] }), null);
  assert.match(journalTextProblem({ title: "é".repeat(101) }), /title is too long/);
  assert.match(journalTextProblem({ body: "x".repeat(20_001) }), /too long/);
});

/** A KPRV journal section as journal.rs `encode_section` writes it. */
function journalSection(entries) {
  const encoder = new TextEncoder();
  const parts = [new Uint8Array(4)];
  new DataView(parts[0].buffer).setUint32(0, entries.length, true);
  for (const entry of entries) {
    const title = encoder.encode(entry.title), body = encoder.encode(entry.body);
    const photos = entry.photos ?? [];
    const row = new Uint8Array(60 + title.length + body.length + 136 * photos.length);
    const view = new DataView(row.buffer);
    row.fill(entry.id, 0, 16);
    view.setBigUint64(16, entry.created, true);
    view.setBigUint64(24, entry.updated, true);
    row.fill(0x11, 32, 48);
    view.setUint32(48, entry.date, true);
    view.setUint16(52, title.length, true);
    row[54] = photos.length;
    view.setUint32(56, body.length, true);
    row.set(title, 60);
    row.set(body, 60 + title.length);
    photos.forEach((bytes, index) => row.set(bytes, 60 + title.length + body.length + 136 * index));
    parts.push(row);
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

test("the journal section reads entries in Rust's order with their photos", () => {
  const photoBytes = new Uint8Array(136);
  photoBytes[0] = 3;
  new DataView(photoBytes.buffer).setUint32(4, 4000, true);
  for (let field = 0; field < 4; field += 1) photoBytes.fill(0x21 + field, 8 + 32 * field, 40 + 32 * field);
  const value = decodePrivate(kprv({
    member: new Uint8Array(16).fill(1), count: 4,
    extra: [[101, journalSection([
      { id: 3, created: 3n, updated: 3n, date: 20261003, title: "", body: "Newest" },
      { id: 1, created: 1n, updated: 6n, date: 20261001, title: "Park", body: "oldest day", photos: [photoBytes] },
    ])]],
  }));
  assert.deepEqual(value.journal.map((entry) => [entry.id.slice(0, 2), entry.date, entry.title, entry.body]), [
    ["03", "2026-10-03", "", "Newest"],
    ["01", "2026-10-01", "Park", "oldest day"],
  ]);
  assert.equal(value.journal[1].updated, 6n);
  assert.equal(value.journal[1].deviceId, "11".repeat(16));
  assert.deepEqual(value.journal[1].photos, [{ type: "image/webp", size: 4000, ref: hex(0x21, 32), key: hex(0x22, 32), thumbnail: hex(0x23, 32), thumbnailKey: hex(0x24, 32) }]);
  // A damaged section is refused.
  const damaged = journalSection([{ id: 1, created: 1n, updated: 1n, date: 20261301, title: "", body: "x" }]);
  assert.throws(() => decodePrivate(kprv({ extra: [[101, damaged]] })), PrivateFormatError);
  const truncated = journalSection([{ id: 1, created: 1n, updated: 1n, date: 20261001, title: "", body: "x" }]).subarray(0, 40);
  assert.throws(() => decodePrivate(kprv({ extra: [[101, truncated]] })), PrivateFormatError);
});

// --- "Just for me" (#510): KPRV section 11 and private item commands -----

/** One section-11 item as private_items.rs writes it. */
function itemRow({ id, addedAt = 1_791_475_200_002n, changedAt = 3n, date = 0, completed = false, text, note = "" }) {
  const textBytes = encoder.encode(text), noteBytes = encoder.encode(note);
  const row = new Uint8Array(48 + textBytes.length + noteBytes.length);
  const view = new DataView(row.buffer);
  row.fill(id, 0, 16);
  view.setBigInt64(16, addedAt, true);
  view.setBigUint64(24, changedAt, true);
  view.setUint32(32, date, true);
  row[36] = completed ? 1 : 0;
  view.setUint32(40, textBytes.length, true);
  view.setUint32(44, noteBytes.length, true);
  row.set(textBytes, 48);
  row.set(noteBytes, 48 + textBytes.length);
  return row;
}

function itemsSection(rows, flags = 0, count = rows.length) {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, flags, true);
  new DataView(head.buffer).setUint32(4, count, true);
  const body = new Uint8Array(8 + rows.reduce((total, row) => total + row.length, 0));
  body.set(head, 0);
  let offset = 8;
  for (const row of rows) { body.set(row, offset); offset += row.length; }
  return body;
}

test("section 11 reads as the Just for me list and its Today setting (TEST-VECTORS 092)", () => {
  const value = decodePrivate(kprv({
    member: new Uint8Array(16).fill(1), count: 6,
    extra: [[11, itemsSection([itemRow({ id: 1, text: "one", note: "n" }), itemRow({ id: 2, changedAt: 4n, date: 20261003, completed: true, text: "two" })])]],
  }));
  assert.equal(value.onToday, true);
  assert.deepEqual(value.items, [
    { id: "01".repeat(16), addedAt: 1_791_475_200_002, changedAt: 3n, date: null, completed: false, text: "one", note: "n" },
    { id: "02".repeat(16), addedAt: 1_791_475_200_002, changedAt: 4n, date: 20261003, completed: true, text: "two", note: "" },
  ]);
  const off = decodePrivate(kprv({ extra: [[11, itemsSection([], 1)]] }));
  assert.equal(off.onToday, false);
  assert.deepEqual(off.items, []);
});

test("a damaged section 11 is refused", () => {
  const good = [itemRow({ id: 1, text: "one" })];
  const bad = (section) => assert.throws(() => decodePrivate(kprv({ extra: [[11, section]] })), PrivateFormatError);
  bad(itemsSection(good, 2), "an unknown flag");
  bad(itemsSection(good, 0, 2), "more items than bytes");
  const status = itemsSection(good); status[8 + 36] = 2; bad(status);
  const reserved = itemsSection(good); reserved[8 + 37] = 1; bad(reserved);
  bad(itemsSection([itemRow({ id: 1, text: "" })]), "empty text");
  bad(new Uint8Array([...itemsSection(good), 0]), "trailing bytes");
});

const identity = {
  eventId: "0a".repeat(16), householdId: "aa".repeat(16), actorId: "01".repeat(16), deviceId: "11".repeat(16),
  timestamp: 1_791_475_200_001, logicalTime: 1n,
};

test("a private item command is a KCMD packet carrying the exact payload (TEST-VECTORS 093)", () => {
  const packet = encodePrivateIntent({ type: "add-private-item", itemId: "5b".repeat(16), text: "Dentist", date: 20261005 }, identity);
  const view = new DataView(packet.buffer);
  assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
  assert.equal(view.getUint16(4, true), 1);
  assert.equal(view.getUint16(8, true), 110);
  assert.deepEqual([...packet.subarray(12, 28)], Array(16).fill(0x0a));
  assert.deepEqual([...packet.subarray(92, 124)], Array(32).fill(0), "no entity, date, option or expiry");
  assert.equal(view.getBigUint64(84, true), 1n);
  assert.equal(view.getUint32(124, true), 31);
  assert.equal(view.getUint32(128 + 16, true), 20261005);
  assert.equal(view.getUint32(128 + 20, true), 7);
  assert.equal(new TextDecoder().decode(packet.subarray(152)), "Dentist");
  assert.equal(packet.length, 128 + 31);
});

test("each private item command has its kind and payload", () => {
  const itemId = "07".repeat(16);
  assert.equal(FIRST_PRIVATE_ITEM_KIND, 110);
  assert.equal(PRIVATE_ITEM_COMMANDS.length, PRIVATE_ITEM_EVENT_KINDS.length);
  const expected = {
    "add-private-item": [110, 16 + 4 + 4 + 1],
    "edit-private-item": [111, 16 + 4 + 1],
    "complete-private-item": [112, 16],
    "reopen-private-item": [113, 16],
    "date-private-item": [114, 20],
    "delete-private-item": [115, 16],
    "restore-private-item": [116, 16],
    "set-private-item-note": [117, 16 + 4 + 1],
    "set-private-items-on-today": [118, 4],
  };
  for (const [type, [kind, length]] of Object.entries(expected)) {
    const command = { type, itemId, text: "x", note: "n", date: null, on: false };
    assert.equal(privateCommandKind(command), kind, type);
    assert.equal(encodePrivateItemPayload(command).length, length, type);
    assert.ok(isPrivateKind(PRIVATE_ITEM_EVENT_KINDS[kind - 110]));
  }
  assert.deepEqual([...encodePrivateItemPayload({ type: "set-private-items-on-today", on: true })], [1, 0, 0, 0]);
  assert.deepEqual([...encodePrivateItemPayload({ type: "set-private-item-note", itemId, note: "" }).subarray(16)], [0, 0, 0, 0], "an empty note clears it");
  assert.throws(() => encodePrivateItemPayload({ type: "add-private-item", itemId, text: "" }), PrivateFormatError);
  assert.throws(() => encodePrivateItemPayload({ type: "add-private-item", itemId, text: "x".repeat(MAX_PRIVATE_ITEM_TEXT_BYTES + 1) }), PrivateFormatError);
  assert.throws(() => encodePrivateItemPayload({ type: "set-private-item-note", itemId, note: "x".repeat(MAX_PRIVATE_ITEM_NOTE_BYTES + 1) }), PrivateFormatError);
  assert.throws(() => encodePrivateItemPayload({ type: "complete-private-item", itemId: "nope" }), PrivateFormatError);
  assert.throws(() => encodePrivateItemPayload({ type: "date-private-item", itemId, date: 1.5 }), PrivateFormatError);
  assert.throws(() => encodePrivateItemPayload({ type: "archive", itemId }), PrivateFormatError);
  assert.throws(() => encodePrivateIntent({ type: "complete-private-item", itemId }, { ...identity, logicalTime: 0n }), PrivateFormatError);
});
