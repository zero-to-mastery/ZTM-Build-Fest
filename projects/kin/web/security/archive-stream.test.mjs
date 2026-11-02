// Package format 3 segments: exact round trips at chunk boundaries, and every
// kind of damage a stream of sealed segments must refuse.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createEngine, encodeAddedRecord, eventMetadata } from "../wasm/kin-engine.js";
import { EventArena } from "../storage/event-arena.js";
import { CHUNK_EVENTS, readArchive, readEventChunk, segmentCount, writeArchive } from "./archive-stream.js";
import { LocalVault, serializeProtectedValue } from "./local-vault.js";
import { appendChatBlob, appendChatEvents, blobSegment, blobSegmentLength, chatEventsView, chatNotes, openChatSection } from "../chat/chat-archive.js";
import { sealChatBlob } from "../chat/chat-blob-crypto.js";
import { ChatRecords } from "../chat/chat-records.js";
import { appendBoardEvents, boardEventsView, openBoardSection, validateBoardSection } from "../board/board-archive.js";

const wasm = await readFile(new URL("../wasm/kin_engine.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const engine = createEngine(instance.exports);
const VAULT_ID = "ab".repeat(16);
const PREFIX = new Uint8Array(8).fill(7);

function arenaWith(count) {
  const arena = new EventArena();
  arena.reset(null);
  for (let n = 1; n <= count; n += 1) {
    const id = (tag) => { const value = new Uint8Array(16).fill(tag); new DataView(value.buffer).setUint32(0, n, true); return value; };
    const bytes = encodeAddedRecord({ eventId: id(1), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
      timestamp: 1_000 + n, logicalTime: n, itemId: id(2), text: `Item ${n}`, classification: "need" });
    arena.append(n * 3, bytes, eventMetadata(bytes)); // sequences need not be dense
  }
  return arena;
}

const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const metadata = new TextEncoder().encode("authenticated metadata");
const context = { key: "installation", next_logical_time: 10n, household_id: new Uint8Array(16).fill(9) };
const attachments = [{ attachment_id: "f".repeat(32), digest: "d", ciphertext: new Uint8Array([1, 2, 3]) }];

async function write(view, extra = {}) {
  return writeArchive({ engine, metadata, key, noncePrefix: PREFIX, vaultId: VAULT_ID, context, attachments, view,
    check: async () => {}, ...extra });
}

// The archive's ciphertext region split into its segment frames.
function frames(bytes) {
  const { metadataLength } = engine.archiveLayout(bytes);
  const data = new DataView(bytes.buffer, bytes.byteOffset);
  const list = [];
  for (let offset = 16 + metadataLength; offset < bytes.length;) {
    const end = offset + 4 + data.getUint32(offset, true);
    list.push(bytes.slice(offset, end));
    offset = end;
  }
  return { head: bytes.slice(0, 16 + metadataLength), list };
}

function rebuild(head, list) {
  const region = list.reduce((total, frame) => total + frame.length, 0);
  const bytes = new Uint8Array(head.length + region);
  bytes.set(head);
  bytes.set(engine.archiveHeader(head.length - 16, region));
  let offset = head.length;
  for (const frame of list) { bytes.set(frame, offset); offset += frame.length; }
  return bytes;
}

async function read(bytes, counts = {}) {
  const { metadataLength, ciphertextLength } = engine.archiveLayout(bytes);
  const result = { contexts: [], attachments: [], sequences: [], records: [], progress: [] };
  await readArchive({
    bytes, offset: 16 + metadataLength, length: ciphertextLength, key, noncePrefix: PREFIX, vaultId: VAULT_ID,
    attachmentCount: counts.attachmentCount ?? attachments.length, eventCount: counts.eventCount,
    onContext: (value) => result.contexts.push(value),
    onAttachment: (value) => result.attachments.push(value),
    onEvents: (sequences, records) => { result.sequences.push(...sequences); result.records.push(...records.map((record) => record.slice())); },
    check: async () => {}, onProgress: (step) => result.progress.push(step),
  });
  return result;
}

for (const count of [0, 1, CHUNK_EVENTS, CHUNK_EVENTS + 1, 2 * CHUNK_EVENTS + 5]) {
  test(`${count} events round-trip exactly`, async () => {
    const arena = arenaWith(count);
    const view = arena.view();
    const progress = [];
    const bytes = await write(view, { onProgress: (step) => progress.push(step) });
    assert.equal(frames(bytes).list.length, segmentCount(attachments.length, count));
    assert.deepEqual(progress.at(-1) ?? null, count ? { done: count, total: count } : null);
    const result = await read(bytes, { eventCount: count });
    assert.deepEqual(result.contexts, [context]);
    assert.deepEqual(result.attachments, attachments);
    assert.deepEqual(result.sequences, Array.from({ length: count }, (_, index) => (index + 1) * 3));
    assert.deepEqual(result.records, view.records().map((record) => record.slice()));
    assert.equal(result.progress.length, Math.ceil(count / CHUNK_EVENTS));
  });
}

test("damage, truncation, reordering, repetition and wrong counts are refused", async () => {
  const count = 2 * CHUNK_EVENTS + 5;
  const bytes = await write(arenaWith(count).view());
  const { head, list } = frames(bytes);
  const refuses = async (candidate, label, counts = {}) =>
    assert.rejects(read(candidate, { eventCount: count, ...counts }), /damaged or incomplete/, label);

  for (let index = 0; index < list.length; index += 1) {
    const flipped = list.map((frame) => frame.slice());
    flipped[index][flipped[index].length - 1] ^= 1;
    await refuses(rebuild(head, flipped), `a changed byte in segment ${index}`);
  }
  await refuses(rebuild(head, list.slice(0, -1)), "the final segment dropped");
  await refuses(rebuild(head, [list[0], list[1], list[3], list[2], list[4]]), "two segments swapped");
  await refuses(rebuild(head, [...list, list.at(-1)]), "the final segment repeated");
  await refuses(rebuild(head, [list[0], list[1], list[2], list[2], list[3], list[4]]), "a middle segment repeated");
  await refuses(bytes, "a smaller event count", { eventCount: count - 1 });
  await refuses(bytes, "a larger event count", { eventCount: count + CHUNK_EVENTS });
  await refuses(bytes, "a different attachment count", { attachmentCount: 0 });

  const frame = list[2].slice();
  new DataView(frame.buffer).setUint32(0, 8, true);
  await refuses(rebuild(head, [list[0], list[1], frame, list[3], list[4]]), "a length shorter than a tag");
});

test("event chunks reject inconsistent framing", () => {
  const chunk = new Uint8Array(4 + 12 + 3);
  const data = new DataView(chunk.buffer);
  data.setUint32(0, 1, true);
  data.setFloat64(4, 5, true);
  data.setUint32(12, 3, true);
  assert.deepEqual(readEventChunk(chunk).sequences, [5]);
  data.setUint32(12, 4, true);
  assert.throws(() => readEventChunk(chunk), /damaged/, "record past the end");
  data.setUint32(12, 2, true);
  assert.throws(() => readEventChunk(chunk), /damaged/, "trailing bytes");
  data.setUint32(12, 3, true);
  data.setFloat64(4, 0.5, true);
  assert.throws(() => readEventChunk(chunk), /damaged/, "a fractional sequence");
  data.setFloat64(4, 5, true);
  data.setUint32(0, CHUNK_EVENTS + 1, true);
  assert.throws(() => readEventChunk(chunk), /damaged/, "more than a chunk");
});

test("the archive key is bound to its vault root, salt and metadata", async () => {
  const { vault } = await LocalVault.create();
  try {
    const salt = new Uint8Array(32).fill(3);
    const sealWith = async (archiveKey) => writeArchive({ engine, metadata, key: archiveKey, noncePrefix: PREFIX,
      vaultId: VAULT_ID, context, attachments: [], view: arenaWith(1).view(), check: async () => {} });
    const opens = async (bytes, archiveKey) => {
      const { metadataLength, ciphertextLength } = engine.archiveLayout(bytes);
      await readArchive({ bytes, offset: 16 + metadataLength, length: ciphertextLength, key: archiveKey, noncePrefix: PREFIX,
        vaultId: VAULT_ID, attachmentCount: 0, eventCount: 1, onContext() {}, onAttachment() {}, onEvents() {}, check: async () => {} });
    };
    const bound = serializeProtectedValue({ archiveVersion: 3 });
    const bytes = await sealWith(await vault.archiveStreamKey(salt, bound));
    await opens(bytes, await vault.archiveStreamKey(salt, bound));
    await assert.rejects(opens(bytes, await vault.archiveStreamKey(salt, serializeProtectedValue({ archiveVersion: 4 }))), /damaged/);
    await assert.rejects(opens(bytes, await vault.archiveStreamKey(new Uint8Array(32).fill(4), bound)), /damaged/);
    const other = await LocalVault.create();
    try { await assert.rejects(opens(bytes, await other.vault.archiveStreamKey(salt, bound)), /damaged/); }
    finally { other.vault.lock(); }
    await assert.rejects(vault.archiveStreamKey(new Uint8Array(31), bound), /context is invalid/);
  } finally { vault.lock(); }
  const { vault: locked } = await LocalVault.create();
  locked.lock();
  await assert.rejects(locked.archiveStreamKey(new Uint8Array(32), metadata), /locked/i);
});

test("the household chat rides after the history, in the real container (#136)", async () => {
  const chatRecords = new ChatRecords();
  for (let n = 1; n <= 300; n += 1) chatRecords.append(new TextEncoder().encode(`chat event ${n}`));
  const sealed = await sealChatBlob(new TextEncoder().encode("hello"));
  const blob = { ref: sealed.ref, size: sealed.ciphertext.length, parts: null };
  const notes = chatNotes({ memberId: "11".repeat(16), hidden: [] });
  const bytes = await write(arenaWith(3).view(), {
    chat: { notes, view: chatEventsView(chatRecords.view()), blobs: [blob], loadBlob: () => sealed.ciphertext, blobSegmentLength, blobSegment },
  });
  const { metadataLength, ciphertextLength } = engine.archiveLayout(bytes);
  const section = openChatSection();
  const history = [];
  await readArchive({
    bytes, offset: 16 + metadataLength, length: ciphertextLength, key, noncePrefix: PREFIX, vaultId: VAULT_ID,
    attachmentCount: 1, eventCount: 3, chatPresent: true, chatEventCount: 300, chatBlobCount: 1,
    onContext() {}, onAttachment() {}, onEvents: (sequences) => history.push(...sequences),
    onChatNotes: (value) => { section.notes = value; },
    onChatEvents: (sequences, records) => appendChatEvents(section, sequences, records),
    onChatBlob: (segment) => appendChatBlob(section, segment),
    check: async () => {},
  });
  assert.equal(history.length, 3);
  assert.equal(section.records.length, 300);
  assert.deepEqual(section.notes, notes);
  assert.deepEqual(section.blobs[0].ciphertext, sealed.ciphertext);
  // Without the chat counts the same bytes are not a valid household archive.
  await assert.rejects(readArchive({
    bytes, offset: 16 + metadataLength, length: ciphertextLength, key, noncePrefix: PREFIX, vaultId: VAULT_ID,
    attachmentCount: 1, eventCount: 3, onContext() {}, onAttachment() {}, onEvents() {}, check: async () => {},
  }), /damaged/);
});

// ---- The family fridge (#363) -------------------------------------------------

/** Board events made by the real engine: three strokes and a magnet. */
function boardRecords(count = 3) {
  const records = new ChatRecords();
  const hex = (byte, n) => byte.toString(16).padStart(2, "0").repeat(12) + n.toString(16).padStart(8, "0");
  const identity = (n) => ({ eventId: hex(0x51, n), householdId: "aa".repeat(16), actorId: "bb".repeat(16), deviceId: "cc".repeat(16), timestamp: 1_791_475_200_000 + n, logicalTime: n });
  for (let n = 1; n <= count; n += 1) {
    const command = n === count
      ? { type: "place-magnet", magnetId: hex(0x61, n), x: 100, y: 200, content: { kind: "note", text: "Milk please" } }
      : { type: "add-stroke", strokeId: hex(0x71, n), colour: n % 8, width: 1, points: [[n, n], [n + 40, n + 20]] };
    const { encodedEvent } = engine.executeBoardCommand(command, identity(n), records.view(), 1_791_475_300_000, 20261019);
    records.append(encodedEvent);
  }
  return records;
}

test("a fridge section rides last and round-trips exactly", async () => {
  const arena = arenaWith(3);
  const board = boardRecords(CHUNK_EVENTS + 2);
  const view = boardEventsView(board.view());
  const bytes = await write(arena.view(), { board: { view } });
  assert.equal(frames(bytes).list.length, segmentCount(attachments.length, 3, null, view.length));
  const { metadataLength, ciphertextLength } = engine.archiveLayout(bytes);
  const section = openBoardSection();
  const household = [];
  await readArchive({
    bytes, offset: 16 + metadataLength, length: ciphertextLength, key, noncePrefix: PREFIX, vaultId: VAULT_ID,
    attachmentCount: attachments.length, eventCount: 3, boardEventCount: view.length,
    onContext: () => {}, onAttachment: () => {},
    onEvents: (_, records) => household.push(...records.map((record) => record.slice())),
    onBoardEvents: (sequences, records) => appendBoardEvents(section, sequences, records),
    check: async () => {},
  });
  assert.equal(household.length, 3);
  assert.equal(section.records.length, view.length);
  for (let index = 0; index < view.length; index += 1) assert.deepEqual(section.records.view().record(index), view.record(index));
  // The engine replays it, and it names this household's board kinds only.
  assert.deepEqual(validateBoardSection(section, { engine, eventCount: view.length, householdId: "aa".repeat(16) }), { eventCount: view.length });
  assert.throws(() => validateBoardSection(section, { engine, eventCount: view.length, householdId: "ab".repeat(16) }), /damaged/);
  assert.throws(() => validateBoardSection(section, { engine, eventCount: view.length + 1, householdId: "aa".repeat(16) }), /damaged/);
  // A household event in the board section is refused.
  const mixed = openBoardSection();
  appendBoardEvents(mixed, [1, 2], [section.records.view().record(0), arena.view().record(0)]);
  assert.throws(() => validateBoardSection(mixed, { engine, eventCount: 2, householdId: "aa".repeat(16) }), /damaged/);
  // A reader that doesn't expect the fridge refuses the extra segments.
  await assert.rejects(read(bytes, { eventCount: 3 }), /damaged or incomplete/);
  // Sequences must count up from 1.
  assert.throws(() => appendBoardEvents(openBoardSection(), [2], [section.records.view().record(0)]), /damaged/);
});
