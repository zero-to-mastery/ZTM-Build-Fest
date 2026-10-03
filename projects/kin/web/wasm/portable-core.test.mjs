import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine, encodeAddedRecord, idToHex } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const url = `data:application/wasm;base64,${wasm.toString("base64")}`;
const id = (value) => new Uint8Array(16).fill(value);
const context = (sequence) => ({
  eventId: id(sequence),
  householdId: id(0xaa),
  actorId: id(0xbb),
  deviceId: id(0xcc),
  timestamp: 1234,
  logicalTime: BigInt(sequence),
  entityId: id(0x11),
});
const day = 20261003;

test("coarse Rust commands produce canonical bytes metadata and an identical projection", async () => {
  const engine = await loadKinEngine(url);
  let records = [];
  const commands = [
    { type: "add", text: "Milk 🥛", classification: "need" },
    { type: "complete", itemId: idToHex(id(0x11)) },
    { type: "reopen", itemId: idToHex(id(0x11)) },
    { type: "archive", itemId: idToHex(id(0x11)) },
    { type: "add-handoff", text: "Household context" },
    { type: "acknowledge-handoff", handoffId: idToHex(id(0x11)) },
    { type: "archive-handoff", handoffId: idToHex(id(0x11)) },
    { type: "add-talk", text: "Talk later" },
    { type: "resolve-talk", talkId: idToHex(id(0x11)) },
    { type: "reopen-talk", talkId: idToHex(id(0x11)) },
    { type: "archive-talk", talkId: idToHex(id(0x11)) },
    { type: "set-pulse", value: "need-quiet", expiresAt: 6000 },
    { type: "clear-pulse" },
    { type: "create-routine", text: "Water plants", cadence: "daily" },
    {
      type: "complete-routine-occurrence",
      routineId: idToHex(id(0x11)),
      occurrenceKey: day,
    },
    {
      type: "reopen-routine-occurrence",
      routineId: idToHex(id(0x11)),
      occurrenceKey: day,
    },
    { type: "archive-routine", routineId: idToHex(id(0x11)) },
  ];
  for (const [index, command] of commands.entries()) {
    const result = engine.executeCommand(
      command,
      context(index + 1),
      records,
      1234,
      null,
      day,
    );
    records = [...records, result.encodedEvent];
    assert.deepEqual(
      result.metadata,
      engine.eventMetadata(result.encodedEvent),
    );
    assert.equal(result.metadata.logicalTime, BigInt(index + 1));
    assert.deepEqual(
      result.state,
      engine.applyEvents(records, 1234, null, day),
    );
  }
  assert.equal(engine.planImport(records, 1234, null, day).eventCount, 17);
  engine.dispose();
});

test("Rust rejects stale occurrence commands and malformed canonical records", async () => {
  const engine = await loadKinEngine(url);
  const created = engine.executeCommand(
    { type: "create-routine", text: "Water", cadence: "daily" },
    context(1),
    [],
    1234,
    null,
    day,
  );
  const command = {
    type: "complete-routine-occurrence",
    routineId: idToHex(id(0x11)),
    occurrenceKey: day,
  };
  const completed = engine.executeCommand(
    command,
    context(2),
    [created.encodedEvent],
    1234,
    null,
    day,
  );
  const records = [created.encodedEvent, completed.encodedEvent];
  assert.throws(
    () => engine.executeCommand(command, context(3), records, 1234, null, day),
    (error) => error.code === 4,
  );
  assert.throws(
    () =>
      engine.executeCommand(
        { ...command, occurrenceKey: 20261002 },
        context(3),
        records,
        1234,
        null,
        day,
      ),
    (error) => error.code === 4,
  );
  for (let end = 0; end < created.encodedEvent.length; end++) {
    assert.throws(() =>
      engine.eventMetadata(created.encodedEvent.subarray(0, end)),
    );
  }
  const newer = created.encodedEvent.slice();
  newer[0] = 255;
  assert.throws(
    () => engine.eventMetadata(newer),
    (error) => error.code === 3,
  );
  engine.dispose();
});

test("archive framing preserves opaque encrypted material and fails closed", async () => {
  const engine = await loadKinEngine(url);
  const metadata = new TextEncoder().encode('{"wrapper":"synthetic"}');
  const ciphertext = new Uint8Array(256).fill(0x91);
  const archive = engine.encodeArchive(metadata, ciphertext);
  assert.deepEqual(engine.decodeArchive(archive), {
    version: 1,
    metadata,
    ciphertext,
  });
  for (let end = 0; end < archive.length; end++)
    assert.throws(() => engine.decodeArchive(archive.subarray(0, end)));
  assert.throws(() => engine.decodeArchive(Uint8Array.from([...archive, 0])));
  const newer = archive.slice();
  newer[4] = 2;
  assert.throws(
    () => engine.decodeArchive(newer),
    (error) => error.code === 3,
  );
  const corruptLength = archive.slice();
  corruptLength.fill(255, 8, 12);
  assert.throws(
    () => engine.decodeArchive(corruptLength),
    (error) => error.code === 5,
  );
  assert.throws(() => engine.encodeArchive(new Uint8Array(), ciphertext));
  // Framing does not claim authentication: the host must reject altered AEAD data.
  const altered = archive.slice();
  altered[altered.length - 1] ^= 1;
  assert.notDeepEqual(engine.decodeArchive(altered).ciphertext, ciphertext);
  engine.dispose();
});

test("compact archive framing preserves the original full-buffer ABI and detached ownership", async () => {
  const engine = await loadKinEngine(url);
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const exports = instance.exports;
  const invoke = (operation, bytes) => {
    const pointer = exports.kin_alloc(bytes.length);
    try {
      new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
      assert.equal(exports[operation](pointer, bytes.length), 0);
      return new Uint8Array(exports.memory.buffer, exports.kin_result_ptr(), exports.kin_result_len()).slice();
    } finally { assert.equal(exports.kin_free(pointer, bytes.length), 0); }
  };
  const metadata = new TextEncoder().encode("published opaque metadata");
  const ciphertext = new Uint8Array(1024 * 1024).fill(83);
  const originalRequest = new Uint8Array(4 + metadata.length + ciphertext.length);
  new DataView(originalRequest.buffer).setUint32(0, metadata.length, true);
  originalRequest.set(metadata, 4); originalRequest.set(ciphertext, 4 + metadata.length);
  const archived = engine.encodeArchive(metadata, ciphertext);
  assert.deepEqual(archived, invoke("kin_encode_archive", originalRequest));
  assert.deepEqual(invoke("kin_decode_archive", archived), originalRequest);
  const restored = engine.decodeArchive(archived);
  archived.fill(0); metadata.fill(0); ciphertext.fill(0);
  assert.equal(restored.ciphertext[0], 83);
  assert.equal(new TextDecoder().decode(restored.metadata), "published opaque metadata");
  const maximumLengths = new Uint8Array(8);
  new DataView(maximumLengths.buffer).setUint32(0, 1024 * 1024, true);
  new DataView(maximumLengths.buffer).setUint32(4, 64 * 1024 * 1024 - 1024 * 1024 - 16, true);
  const header = invoke("kin_archive_header", maximumLengths);
  assert.equal(header.length, 16);
  const request = new Uint8Array(20); request.set(header);
  new DataView(request.buffer).setUint32(16, 64 * 1024 * 1024, true);
  assert.deepEqual(invoke("kin_archive_layout", request), maximumLengths);
  engine.dispose(); exports.kin_clear();
});

test("import planning validates the complete corpus and rejects duplicate identity", async () => {
  const engine = await loadKinEngine(url);
  const bytes = encodeAddedRecord({
    ...context(1),
    itemId: id(0x11),
    text: "Protected",
    classification: "today",
  });
  const plan = engine.planImport([bytes], 1234, null, day);
  assert.equal(plan.eventCount, 1);
  assert.equal(plan.nextLogicalTime, 2n);
  assert.equal(plan.state.items[0].text, "Protected");
  assert.throws(
    () => engine.planImport([bytes, bytes], 1234, null, day),
    (error) => error.code === 4,
  );
  const conflict = bytes.slice();
  conflict[conflict.length - 1] ^= 1;
  assert.throws(() => engine.planImport([bytes, conflict], 1234, null, day));
  assert.throws(() =>
    engine.planImport([bytes.subarray(0, bytes.length - 1)], 1234, null, day),
  );
  engine.dispose();
});

test("disposing the unlocked engine removes replay command and shared codec capability", async () => {
  const engine = await loadKinEngine(url);
  engine.executeCommand(
    { type: "add", text: "Private" },
    context(1),
    [],
    1234,
    null,
    day,
  );
  engine.dispose();
  engine.dispose();
  assert.throws(() => engine.applyEvents([], 1234, null, day), /Unlock/);
  assert.throws(
    () =>
      engine.executeCommand(
        { type: "add", text: "Private" },
        context(2),
        [],
        1234,
        null,
        day,
      ),
    /Unlock/,
  );
  assert.throws(
    () =>
      encodeAddedRecord({ ...context(2), itemId: id(0x11), text: "Private" }),
    /Unlock/,
  );
  assert.throws(
    () => engine.encodeArchive(Uint8Array.of(1), new Uint8Array(16)),
    /Unlock/,
  );
  const unlocked = await loadKinEngine(url);
  assert.equal(unlocked.applyEvents([], 1234, null, day).items.length, 0);
  unlocked.dispose();
});

test("batch metadata matches individual extraction and rejects a corrupt batch", async () => {
  const engine = await loadKinEngine(url);
  const records = Array.from({ length: 10000 }, (_, index) => {
    const identifier = new Uint8Array(16);
    new DataView(identifier.buffer).setUint32(12, index + 1, true);
    return encodeAddedRecord({
      ...context(1),
      eventId: identifier,
      itemId: identifier,
      logicalTime: BigInt(index + 1),
      text: "Synthetic",
    });
  });
  const metadata = engine.eventMetadataBatch(records);
  assert.equal(metadata.length, 10000);
  assert.deepEqual(metadata[0], engine.eventMetadata(records[0]));
  assert.deepEqual(metadata.at(-1), engine.eventMetadata(records.at(-1)));
  assert.deepEqual(engine.eventMetadataBatch([]), []);
  assert.throws(
    () => engine.eventMetadataBatch([...records, records[0]]),
    (error) => error.code === 5,
  );
  assert.throws(() =>
    engine.eventMetadataBatch([records[0], new Uint8Array(3)]),
  );
  engine.dispose();
});
