// The household chat in an encrypted export (#136): which blobs fit, the blob
// segment layout, the stream round trip with damage, and the checks a restore
// makes before anything is written. The engine is a stand-in (these run
// without the WASM build); the real engine runs the same code in the
// archive tests (web/security/archive.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import { readArchive, writeArchive, segmentCount } from "../security/archive-stream.js";
import { sealChatBlob, blobRef } from "./chat-blob-crypto.js";
import {
  appendChatBlob, appendChatEvents, blobSegment, blobSegmentLength, chatBlobBudget, chatEventsView, chatNotes, chooseChatBlobs,
  discardChatSection, importChatSection, openChatSection, parseBlobSegment, validateChatSection,
} from "./chat-archive.js";
import { ChatBlobStore } from "./chat-blob-store.js";
import { ChatLogStore } from "./chat-log-store.js";
import { ChatRecords } from "./chat-records.js";
import { fakeIndexedDB, fakeKeyRange } from "./fake-indexeddb.test-support.mjs";

const HOUSEHOLD = "ab".repeat(16);
const ME = "11".repeat(16);
const hex = (n) => n.toString(16).padStart(32, "0");
const bytesOfHex = (text) => Uint8Array.from(text.match(/../g), (pair) => Number.parseInt(pair, 16));
const encoder = new TextEncoder();

// The container header the WASM engine frames: here two u32 lengths.
const stubEngine = {
  archiveHeader(metadataLength, region) {
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, metadataLength, true);
    view.setUint32(4, region, true);
    return header;
  },
  archiveLayout(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return { metadataLength: view.getUint32(0, true), ciphertextLength: view.getUint32(4, true) };
  },
};

async function blobOf(text, parts = null) {
  const sealed = await sealChatBlob(encoder.encode(text));
  return { ref: sealed.ref, ciphertext: sealed.ciphertext, size: sealed.ciphertext.length, parts };
}

function recordsOf(count) {
  const records = new ChatRecords();
  for (let n = 1; n <= count; n += 1) records.append(encoder.encode(JSON.stringify({ eventId: hex(n), n })));
  return records;
}

const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const PREFIX = new Uint8Array(8).fill(3);
const history = { length: 0, recordLength: () => 0, record: () => new Uint8Array(), localSequence: () => 1 };

async function write(chat, extra = {}) {
  return writeArchive({
    engine: stubEngine, metadata: encoder.encode("meta"), key, noncePrefix: PREFIX, vaultId: HOUSEHOLD,
    context: { key: "installation" }, attachments: [], view: history, chat, check: async () => {}, ...extra,
  });
}

async function read(bytes, { chatEventCount, chatBlobCount }) {
  const { metadataLength, ciphertextLength } = stubEngine.archiveLayout(bytes);
  const section = openChatSection();
  await readArchive({
    bytes, offset: 16 + metadataLength, length: ciphertextLength, key, noncePrefix: PREFIX, vaultId: HOUSEHOLD,
    attachmentCount: 0, eventCount: 0, chatPresent: true, chatEventCount, chatBlobCount,
    onContext() {}, onAttachment() {}, onEvents() {},
    onChatNotes: (value) => { section.notes = value; },
    onChatEvents: (sequences, records) => appendChatEvents(section, sequences, records),
    onChatBlob: (blob) => appendChatBlob(section, blob),
    check: async () => {},
  });
  return section;
}

async function chatArchive(events, blobs) {
  const records = recordsOf(events);
  const bytes = await write({
    notes: chatNotes({ memberId: ME, hidden: [hex(9), hex(2)] }), view: chatEventsView(records.view()), blobs,
    loadBlob: (blob) => blob.ciphertext, blobSegmentLength, blobSegment,
  });
  return { bytes, records };
}

test("blobs are chosen newest first within the budget, and the rest are counted as left out", () => {
  const blob = (ref, size, storedAt) => ({ ref: ref.repeat(64), size, storedAt, parts: null });
  const inventory = [blob("a", 1000, 1), blob("b", 1000, 3), blob("c", 1000, 2), blob("d", 5000, 4)];
  const choice = chooseChatBlobs(inventory, 2 * (blobSegmentLength(inventory[0]) + 20));
  assert.deepEqual(choice.chosen.map((entry) => entry.ref[0]), ["b", "c"], "the newest that fit, listed by reference");
  assert.equal(choice.skipped, 2);
  assert.equal(choice.skippedBytes, 6000);
  assert.equal(chooseChatBlobs(inventory, 0).chosen.length, 0);
  assert.equal(chatBlobBudget(100 * 1024 * 1024, 150 * 1024 * 1024), 0, "a household that fills the limit leaves no room for chat");
});

test("a blob segment keeps its reference, parts and bytes, and refuses damage", async () => {
  const part = "cd".repeat(32);
  const blob = await blobOf("a photo manifest", [part]);
  const segment = blobSegment(blob, blob.ciphertext);
  assert.equal(segment.length, blobSegmentLength({ ...blob, size: blob.ciphertext.length }));
  const parsed = parseBlobSegment(segment);
  assert.equal(parsed.ref, blob.ref);
  assert.deepEqual(parsed.parts, [part]);
  assert.deepEqual(parsed.ciphertext, blob.ciphertext);
  assert.equal(parseBlobSegment(blobSegment({ ref: blob.ref, parts: null }, blob.ciphertext)).parts, null);
  assert.throws(() => parseBlobSegment(segment.subarray(0, 20)), /damaged/);
  assert.throws(() => parseBlobSegment(segment.subarray(0, 40)), /damaged/, "too little left for a blob");
  assert.throws(() => blobSegment({ ref: "xyz", parts: null }, blob.ciphertext));
});

test("chat events, notes and blobs round trip through the stream, across chunk boundaries", async () => {
  const blobs = [await blobOf("one"), await blobOf("two", ["ef".repeat(32)])];
  for (const events of [1, 255, 256, 257, 600]) {
    const { bytes, records } = await chatArchive(events, blobs);
    const section = await read(bytes, { chatEventCount: events, chatBlobCount: blobs.length });
    assert.equal(section.records.length, events, `${events} events`);
    assert.deepEqual(section.records.view().record(events - 1), records.view().record(events - 1));
    assert.deepEqual(section.notes, { version: 1, memberId: ME, hidden: [hex(2), hex(9)] }, "sorted");
    assert.deepEqual(section.blobs.map((entry) => entry.ref), blobs.map((entry) => entry.ref));
    assert.equal(segmentCount(0, 0, { eventCount: events, blobCount: 2 }), 1 + 1 + Math.ceil(events / 256) + 2);
  }
});

test("an archive with no chat is the archive it always was", async () => {
  const without = await write(null);
  const { ciphertextLength } = stubEngine.archiveLayout(without);
  assert.equal(segmentCount(0, 0), 1);
  assert.ok(ciphertextLength > 0);
  await assert.rejects(read(without, { chatEventCount: 1, chatBlobCount: 0 }), /damaged/, "a chat that the file doesn't have");
});

test("a dropped, reordered, repeated or extra chat segment fails to open", async () => {
  const blobs = [await blobOf("one"), await blobOf("two")];
  const { bytes } = await chatArchive(300, blobs);
  const { metadataLength } = stubEngine.archiveLayout(bytes);
  const data = new DataView(bytes.buffer, bytes.byteOffset);
  const frames = [];
  for (let offset = 16 + metadataLength; offset < bytes.length;) {
    const end = offset + 4 + data.getUint32(offset, true);
    frames.push(bytes.slice(offset, end));
    offset = end;
  }
  const rebuild = (list) => {
    const region = list.reduce((total, frame) => total + frame.length, 0);
    const out = new Uint8Array(16 + metadataLength + region);
    out.set(bytes.subarray(0, 16 + metadataLength));
    out.set(stubEngine.archiveHeader(metadataLength, region));
    let at = 16 + metadataLength;
    for (const frame of list) { out.set(frame, at); at += frame.length; }
    return out;
  };
  const counts = { chatEventCount: 300, chatBlobCount: 2 };
  assert.equal((await read(rebuild(frames), counts)).blobs.length, 2, "the untouched archive opens");
  const last = frames.length - 1;
  await assert.rejects(read(rebuild(frames.slice(0, last)), counts), /damaged/, "the last blob dropped");
  await assert.rejects(read(rebuild([...frames.slice(0, last - 1), frames[last], frames[last - 1]]), counts), /damaged/, "two blobs swapped");
  await assert.rejects(read(rebuild([...frames, frames[last]]), counts), /damaged/, "a blob repeated");
  await assert.rejects(read(rebuild(frames.filter((_, index) => index !== 2)), counts), /damaged/, "an event chunk dropped");
  const flipped = bytes.slice();
  flipped[flipped.length - 30] ^= 1;
  await assert.rejects(read(flipped, counts), /damaged/, "a changed byte");
});

// A stand-in for the engine's decoding of events (the records are JSON here).
function checkingEngine({ household = HOUSEHOLD, kind = "CHAT_MESSAGE_POSTED", failReplay = false } = {}) {
  return {
    eventMetadataBatch: (records) => records.map((record) => ({
      eventId: bytesOfHex(JSON.parse(new TextDecoder().decode(record)).eventId), householdId: bytesOfHex(household), kind,
    })),
    chatPage() { if (failReplay) throw new Error("bad chat"); return { messages: [] }; },
  };
}

async function sectionOf(events, blobs, notes = chatNotes({ memberId: ME, hidden: [hex(5)] })) {
  const section = openChatSection();
  section.notes = notes;
  recordsOf(events).view().record(0);
  const source = recordsOf(events).view();
  for (let index = 0; index < events; index += 1) appendChatEvents(section, [index + 1], [source.record(index)]);
  for (const blob of blobs) appendChatBlob(section, blobSegment(blob, blob.ciphertext));
  return section;
}

test("restore checks the events, the household and every blob before anything is written", async () => {
  const blobs = [await blobOf("one"), await blobOf("two")];
  const counts = { eventCount: 3, blobCount: 2 };
  const good = await sectionOf(3, blobs);
  const summary = await validateChatSection(good, { engine: checkingEngine(), counts, householdId: HOUSEHOLD, memberId: ME });
  assert.deepEqual([summary.eventCount, summary.blobCount, summary.hidden], [3, 2, [hex(5)]]);
  assert.equal(good.eventIds.length, 3);

  const other = await validateChatSection(await sectionOf(3, blobs), { engine: checkingEngine(), counts, householdId: HOUSEHOLD, memberId: "22".repeat(16) });
  assert.deepEqual(other.hidden, [], "another member's deleted-for-me list is not kept");

  const reject = async (section, engine = checkingEngine(), expected = counts, household = HOUSEHOLD) =>
    assert.rejects(validateChatSection(section, { engine, counts: expected, householdId: household, memberId: ME }), /damaged/);
  await reject(await sectionOf(3, blobs), checkingEngine({ household: "cd".repeat(16) }));
  await reject(await sectionOf(3, blobs), checkingEngine({ kind: "ITEM_ADDED" }));
  await reject(await sectionOf(3, blobs), checkingEngine({ failReplay: true }));
  await reject(await sectionOf(3, blobs), checkingEngine(), { eventCount: 4, blobCount: 2 });
  await reject(await sectionOf(3, blobs), checkingEngine(), { eventCount: 3, blobCount: 1 });
  await reject(await sectionOf(3, blobs, { version: 1, memberId: ME, hidden: [hex(5), hex(5)] }));
  await reject(await sectionOf(3, blobs, { version: 2, memberId: ME, hidden: [] }));
  await reject(await sectionOf(3, blobs, null));
  const tampered = await sectionOf(3, blobs);
  tampered.blobs[1].ciphertext[10] ^= 1;
  await reject(tampered);
  const duplicate = await sectionOf(3, [blobs[0], blobs[0]]);
  await reject(duplicate);

  const twice = openChatSection();
  twice.notes = chatNotes({ memberId: ME, hidden: [] });
  const event = encoder.encode(JSON.stringify({ eventId: hex(1) }));
  appendChatEvents(twice, [1, 2], [event, event]);
  await reject(twice, checkingEngine(), { eventCount: 2, blobCount: 0 });
  assert.throws(() => appendChatEvents(openChatSection(), [2], [event]), /damaged/, "sequences count up from 1");
  discardChatSection(good);
  assert.equal(good.records.length, 0);
});

const vault = {
  async seal(value, { store, id }) { return { sealed: Array.from(value), store, id }; },
  async open(envelope, { store, id }) {
    if (envelope.store !== store || envelope.id !== id) throw new Error("wrong context");
    return Uint8Array.from(envelope.sealed);
  },
};

test("importing writes sealed events and the blobs, keeps relay events, and can be run again", async () => {
  const indexedDB = fakeIndexedDB();
  const blobs = [await blobOf("one"), await blobOf("two", ["ef".repeat(32)])];
  const section = await sectionOf(3, blobs);
  await validateChatSection(section, { engine: checkingEngine(), counts: { eventCount: 3, blobCount: 2 }, householdId: HOUSEHOLD, memberId: ME });

  // The relay already gave this device the second event.
  const log = await ChatLogStore.open(HOUSEHOLD, { indexedDB, keyRange: fakeKeyRange });
  await log.addReceived([{ eventId: section.eventIds[1], keyEpoch: 1 }], "cursor");
  log.close();

  const first = await importChatSection(section, { householdId: HOUSEHOLD, vault, hidden: [hex(5)], indexedDB, keyRange: fakeKeyRange });
  assert.deepEqual(first, { events: 2, blobs: 2 });
  const reopened = await ChatLogStore.open(HOUSEHOLD, { indexedDB, keyRange: fakeKeyRange });
  const rows = await reopened.eventsFrom(1);
  assert.deepEqual(rows.map((row) => row.eventId), [section.eventIds[1], section.eventIds[0], section.eventIds[2]], "the relay's event keeps its place and stays an envelope");
  assert.ok(rows[0].envelope && !rows[0].imported);
  assert.ok(rows[1].imported && !rows[1].envelope);
  assert.deepEqual(Array.from(await vault.open(rows[1].imported, { store: "chat-import", id: rows[1].eventId })), Array.from(section.records.view().record(0)));
  assert.deepEqual((await reopened.state()).hidden, [hex(5)]);
  assert.equal((await reopened.state()).hiddenDirty, true, "the deleted-for-me list is due to reach the member's other devices");
  assert.equal((await reopened.state()).cursor, "cursor", "the relay position is untouched");
  reopened.close();

  const store = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  assert.deepEqual(await store.get(blobs[0].ref), blobs[0].ciphertext);
  assert.deepEqual((await store.partsOf([blobs[1].ref])).get(blobs[1].ref), ["ef".repeat(32)]);
  store.close();

  // Again, under a vault whose root changed: the rows an import made are
  // written again in place; nothing is added.
  const rotated = { ...vault, async seal(value, context) { return { ...(await vault.seal(value, context)), root: 2 }; } };
  const second = await importChatSection(section, { householdId: HOUSEHOLD, vault: rotated, hidden: [], indexedDB, keyRange: fakeKeyRange });
  assert.deepEqual(second, { events: 0, blobs: 2 });
  const again = await ChatLogStore.open(HOUSEHOLD, { indexedDB, keyRange: fakeKeyRange });
  const after = await again.eventsFrom(1);
  assert.equal(after.length, 3);
  assert.equal(after[1].imported.root, 2);
  assert.ok(after[0].envelope, "a relay event is never replaced");
  again.close();
});

test("a blob a device deleted is not brought back by an import", async () => {
  const indexedDB = fakeIndexedDB();
  const blob = await blobOf("deleted since");
  const store = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  await store.retire([blob.ref]);
  store.close();
  const section = await sectionOf(1, [blob]);
  await validateChatSection(section, { engine: checkingEngine(), counts: { eventCount: 1, blobCount: 1 }, householdId: HOUSEHOLD, memberId: ME });
  assert.equal((await importChatSection(section, { householdId: HOUSEHOLD, vault, hidden: [], indexedDB, keyRange: fakeKeyRange })).blobs, 0);
  const again = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  assert.equal(await again.get(blob.ref), null);
  again.close();
  assert.equal(await blobRef(blob.ciphertext), blob.ref);
});

test("the relay's signed copy replaces an imported event, so it is authenticated and readable by keys", async () => {
  const indexedDB = fakeIndexedDB();
  const section = await sectionOf(2, []);
  await validateChatSection(section, { engine: checkingEngine(), counts: { eventCount: 2, blobCount: 0 }, householdId: HOUSEHOLD, memberId: ME });
  await importChatSection(section, { householdId: HOUSEHOLD, vault, hidden: [], indexedDB, keyRange: fakeKeyRange });
  const log = await ChatLogStore.open(HOUSEHOLD, { indexedDB, keyRange: fakeKeyRange });
  assert.equal(await log.addReceived([{ eventId: section.eventIds[0], keyEpoch: 1 }], "c1"), 0, "nothing new");
  const rows = await log.eventsFrom(1);
  assert.deepEqual(rows.map((row) => Boolean(row.envelope)), [true, false]);
  assert.deepEqual(rows.map((row) => row.order), [1, 2], "in the same place");
  log.close();
});

test("a member-less restore keeps nobody's deleted-for-me list", async () => {
  const section = await sectionOf(1, []);
  const summary = await validateChatSection(section, { engine: checkingEngine(), counts: { eventCount: 1, blobCount: 0 }, householdId: HOUSEHOLD, memberId: null });
  assert.deepEqual(summary.hidden, []);
});
