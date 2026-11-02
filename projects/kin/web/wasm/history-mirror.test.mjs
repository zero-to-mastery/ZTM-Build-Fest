// The engine keeps its WASM instance's history equal to the history it is
// asked to replay, sending only what changed (history-mirror.js).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createEngine, encodeAddedRecord, eventMetadata } from "./kin-engine.js";
import { EventArena, historyWith } from "../storage/event-arena.js";
import { APPEND_BATCH_BYTES } from "./history-mirror.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const id = (value) => new Uint8Array(16).fill(value);
const record = (n) => encodeAddedRecord({ eventId: id(n), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
  timestamp: 1_000 + n, logicalTime: n, itemId: id(0x80 + n), text: `Item ${n}`, classification: "need" });

// An engine over the real WASM, counting the records each append sends.
async function countingEngine() {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const abi = instance.exports;
  const calls = [];
  const exports = {
    ...abi,
    kin_history_reset: () => { calls.push("reset"); return abi.kin_history_reset(); },
    kin_history_truncate: (count) => { calls.push(`truncate ${count}`); return abi.kin_history_truncate(count); },
    kin_history_append: (pointer, length) => {
      calls.push(`append ${new DataView(abi.memory.buffer).getUint32(pointer, true)}`);
      return abi.kin_history_append(pointer, length);
    },
  };
  return { engine: createEngine(exports), calls };
}

async function freshItems(records) {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  return createEngine(instance.exports).applyEvents(records, 5_000, null, 20261014).items;
}

function arenaWith(count) {
  const arena = new EventArena();
  arena.reset(0);
  for (let n = 1; n <= count; n += 1) {
    const bytes = record(n);
    arena.append(n, bytes, eventMetadata(bytes));
  }
  return arena;
}

const replay = (engine, source) => engine.applyEvents(source, 5_000, null, 20261014);

test("a growing view of one arena sends only the new records", async () => {
  const { engine, calls } = await countingEngine();
  const arena = arenaWith(3);
  assert.equal(replay(engine, arena.view()).items.length, 3);
  assert.deepEqual(calls, ["reset", "append 3"]);
  calls.length = 0;
  assert.equal(replay(engine, arena.view()).items.length, 3);
  assert.deepEqual(calls, [], "nothing changed, nothing sent");
  const bytes = record(4);
  arena.append(4, bytes, eventMetadata(bytes));
  const items = replay(engine, arena.view()).items;
  assert.deepEqual(calls, ["append 1"]);
  assert.deepEqual(items, await freshItems(arena.view().records()));
});

test("a shorter view truncates, and extras are rolled back after one replay", async () => {
  const { engine, calls } = await countingEngine();
  const arena = arenaWith(4);
  replay(engine, arena.view());
  calls.length = 0;
  assert.equal(replay(engine, arena.view(2)).items.length, 2);
  assert.deepEqual(calls, ["truncate 2"]);
  calls.length = 0;
  const withExtras = replay(engine, historyWith(arena.view(2), [record(9)]));
  assert.equal(withExtras.items.length, 3);
  assert.deepEqual(calls, ["append 1", "truncate 2"]);
  assert.deepEqual(withExtras.items, await freshItems([...arena.view(2).records(), record(9)]));
  calls.length = 0;
  replay(engine, arena.view());
  assert.deepEqual(calls, ["append 2"], "only the records the shorter view lacked");
});

test("a new epoch, another arena or a plain array sends the history whole", async () => {
  const { engine, calls } = await countingEngine();
  const arena = arenaWith(2);
  replay(engine, arena.view());
  calls.length = 0;
  arena.reset(1);
  const bytes = record(7);
  arena.append(1, bytes, eventMetadata(bytes));
  assert.deepEqual(replay(engine, arena.view()).items, await freshItems([bytes]));
  assert.deepEqual(calls, ["reset", "append 1"]);
  calls.length = 0;
  replay(engine, arenaWith(2).view());
  assert.deepEqual(calls, ["reset", "append 2"], "another arena");
  calls.length = 0;
  replay(engine, [record(1)]);
  replay(engine, [record(1)]);
  assert.deepEqual(calls, ["reset", "append 1", "reset", "append 1"], "arrays are never tracked");
});

test("a rejected record leaves the engine consistent for the next replay", async () => {
  const { engine } = await countingEngine();
  const arena = arenaWith(2);
  replay(engine, arena.view());
  const bad = record(3);
  bad[2] = 99; // unknown kind
  // An unknown kind is reported as unsupported (code 3), as a whole request was.
  assert.throws(() => replay(engine, historyWith(arena.view(), [bad])), (error) => error.code === 3);
  assert.deepEqual(replay(engine, arena.view()).items, await freshItems(arena.view().records()));
});

test("a whole history goes in bounded batches", async () => {
  const { engine, calls } = await countingEngine();
  const arena = new EventArena();
  arena.reset(0);
  const records = [];
  for (let n = 1; n <= 1_100; n += 1) {
    const unique = (tag) => { const value = id(tag); new DataView(value.buffer).setUint32(0, n, true); return value; };
    const bytes = encodeAddedRecord({ eventId: unique(1), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
      timestamp: 1_000 + n, logicalTime: n, itemId: unique(2), text: "x".repeat(4_096), classification: "need" });
    arena.append(n, bytes, eventMetadata(bytes));
    records.push(bytes);
  }
  const sent = (list) => list.filter((call) => call.startsWith("append")).map((call) => Number(call.split(" ")[1]));
  const items = replay(engine, arena.view()).items;
  const batches = sent(calls);
  assert.ok(batches.length > 1, "more than one append");
  assert.equal(batches.reduce((total, count) => total + count, 0), 1_100);
  assert.ok(batches.every((count) => count * 4_200 <= APPEND_BATCH_BYTES + 4_200));
  assert.deepEqual(items, await freshItems(records));
});
