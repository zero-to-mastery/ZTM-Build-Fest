import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine, encodeRoutineCreatedRecord, encodeRoutineActionRecord } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const url = `data:application/wasm;base64,${wasm.toString("base64")}`;
await loadKinEngine(url);
const id = value => new Uint8Array(16).fill(value);
const identity = sequence => ({ eventId: id(sequence), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc), timestamp: 1234, logicalTime: sequence });
const create = (cadence = "daily", text = "Starter", createdOn = 20261002) => encodeRoutineCreatedRecord({ ...identity(1), routineId: id(0x11), text, cadence, createdOn });
const action = (sequence, action, occurrenceKey = 20261002) => encodeRoutineActionRecord({ ...identity(sequence), routineId: id(0x11), action, occurrenceKey });

test("v7 Routine writers have exact field offsets and reject invalid input", async () => {
  await loadKinEngine(url);
  const row = create("weekly", "x");
  const view = new DataView(row.buffer);
  assert.equal(view.getUint16(0, true), 1);
  assert.equal(view.getUint16(2, true), 14);
  assert.equal(view.getUint32(84, true), 29);
  assert.deepEqual(row.slice(88, 104), id(0x11));
  assert.deepEqual(row.slice(104, 108), Uint8Array.of(1, 0, 0, 0));
  assert.equal(view.getUint32(108, true), 20261002);
  assert.equal(view.getUint32(112, true), 1);
  assert.equal(row[116], 120);
  for (const [name, kind, size] of [["complete", 15, 108], ["reopen", 16, 108], ["archive", 17, 104]]) {
    const bytes = action(2, name);
    assert.equal(bytes[2], kind); assert.equal(bytes.length, size);
  }
  for (const value of [0, 101, 20260229, 20261301, 20260100, 20260132, 100000101, NaN, Infinity, 20261002.5]) assert.throws(() => create("daily", "x", value));
  for (const value of [10101, 20000229, 99991231]) assert.doesNotThrow(() => create("daily", "x", value));
  for (const text of ["", "x".repeat(4097), "\ud800"]) assert.throws(() => create("daily", text));
  assert.equal(create("daily", "🥛".repeat(1024)).length, 88 + 28 + 4096);
  assert.throws(() => create("monthly"));
});

test("v7 real Wasm daily/weekly lifecycle, rollback and summary", async () => {
  const engine = await loadKinEngine(url);
  const project = (rows, day) => engine.applyEvents(rows, 1234, null, day);
  assert.throws(() => engine.applyEvents([], 1234), /civil date/);
  for (const [cadence, key, following] of [["daily", 20261002, 20261003], ["weekly", 20260928, 20261005]]) {
    const rows = [create(cadence)];
    assert.equal(project(rows, 20261001).routines[0].occurrenceKey, null);
    assert.equal(project(rows, 20261002).routines[0].occurrenceKey, key);
    rows.push(action(2, "complete", key));
    const completed = project(rows, 20261002);
    assert.equal(completed.routines[0].occurrenceStatus, "completed");
    assert.equal(project(rows, following).routines[0].occurrenceStatus, "open");
    assert.deepEqual(project(rows, following).summary, completed.summary);
    assert.deepEqual(project(rows, 20261002), completed);
    rows.push(action(3, "reopen", key));
    assert.equal(project(rows, 20261002).routines[0].occurrenceStatus, "open");
    rows.push(action(4, "archive"));
    const archived = project(rows, 20261002);
    assert.equal(archived.routines[0].status, "archived");
    assert.equal(archived.routines[0].occurrenceKey, null);
    assert.deepEqual(archived.summary.entries.map(e => [e.kind, e.entityKind, e.classification]), [
      ["routine-created", "routine", null], ["routine-occurrence-completed", "routine", null],
      ["routine-occurrence-reopened", "routine", null], ["routine-archived", "routine", null],
    ]);
    assert.throws(() => project([...rows, action(5, "complete", key)], 20261002), e => e.code === 4);
    assert.deepEqual(project([...rows, rows[3]], 20261002), archived);
  }
});

test("v7 projection requires matching explicit timestamp/date context and handles DST-shaped civil days", async () => {
  const engine = await loadKinEngine(url);
  const daily = [create("daily", "DST", 20260301)];
  const weekly = [create("weekly", "DST week", 20260301)];
  assert.equal(engine.applyEvents(daily, 1, null, 20260308).routines[0].occurrenceKey, 20260308);
  assert.equal(engine.applyEvents(daily, 1, null, 20260309).routines[0].occurrenceKey, 20260309);
  // The same civil date remains the same period even when its local day is
  // 23 or 25 elapsed hours around a browser DST transition.
  assert.equal(engine.applyEvents(daily, 1, null, 20261101).routines[0].occurrenceKey, 20261101);
  assert.equal(engine.applyEvents(weekly, 1, null, 20260308).routines[0].occurrenceKey, 20260302);
  assert.equal(engine.applyEvents(weekly, 1, null, 20260309).routines[0].occurrenceKey, 20260309);
  for (const civilDate of [0, 20260229, 20261301, 20260100, 20260132, 100000101]) {
    assert.throws(() => engine.applyEvents([], 1, null, civilDate), error => error.code === 2);
  }
  assert.throws(() => engine.applyEvents([], 8640000000000001, null, 20260308), error => error.code === 2);
});

test("v7 result decoder rejects truncation, fields, duplicates and trailing bytes", async context => {
  const instantiate = WebAssembly.instantiate;
  let mutate = () => {}, reportedLength, actualLength;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const { instance } = await instantiate(...args); const abi = instance.exports;
    return { instance: { exports: { ...abi,
      kin_apply_events(pointer, length) {
        const status = abi.kin_apply_events(pointer, length);
        if (!status) { actualLength = abi.kin_result_len(); mutate(new Uint8Array(abi.memory.buffer, abi.kin_result_ptr(), actualLength)); }
        return status;
      },
      kin_result_len: () => reportedLength ?? abi.kin_result_len(),
    } } };
  });
  const engine = await loadKinEngine(url);
  const rows = [create()];
  const run = () => engine.applyEvents(rows, 1234, null, 20261002);
  const valid = run(); const totalLength = actualLength;
  const write32 = (offset, value) => bytes => new DataView(bytes.buffer, bytes.byteOffset).setUint32(offset, value, true);
  const mutations = [write32(52, 10001), write32(96, 20260229), write32(100, 20261001), write32(100, 0),
    ...[104, 105, 106].map(offset => bytes => bytes[offset] = 255), bytes => bytes[107] = 1,
    write32(108, 0), write32(108, 4097), write32(108, 0xffffffff), bytes => bytes[112] = 255,
    bytes => bytes[105] = 1, bytes => bytes[106] = 0,
    bytes => { bytes[104] = 1; }, // Friday cannot be a weekly key
    bytes => new DataView(bytes.buffer, bytes.byteOffset).setBigInt64(88, 8640000000000001n, true),
  ];
  for (mutate of mutations) assert.throws(run, error => error.code === 6);
  mutate = () => {};
  for (reportedLength = 0; reportedLength < totalLength; reportedLength++) assert.throws(run, error => error.code === 6);
  reportedLength = totalLength + 1; assert.throws(run, error => error.code === 6);
  reportedLength = undefined;
  assert.deepEqual(run(), valid);
  rows.push(encodeRoutineCreatedRecord({ ...identity(2), routineId: id(0x22), text: "Other", cadence: "daily", createdOn: 20261002 }));
  // Second record starts after 56 + 56 + "Starter" (7).
  mutate = bytes => bytes.copyWithin(119, 56, 72);
  assert.throws(run, error => error.code === 6);
});

test("v7 maximum replay grows real memory and copies results across calls", async context => {
  const instantiate = WebAssembly.instantiate;
  let abi;
  context.mock.method(WebAssembly, "instantiate", async (...args) => {
    const result = await instantiate(...args); abi = result.instance.exports; return result;
  });
  const engine = await loadKinEngine(url);
  const initialBuffer = abi.memory.buffer;
  const rows = Array.from({ length: 10000 }, (_, i) => {
    const eventId = new Uint8Array(16); new DataView(eventId.buffer).setUint32(0, i + 1, true);
    return encodeRoutineCreatedRecord({ ...identity(1), eventId, logicalTime: i + 1, routineId: eventId, text: i < 1000 ? "x".repeat(4096) : "x", cadence: i % 2 ? "weekly" : "daily", createdOn: 20261002 });
  });
  const state = engine.applyEvents(rows, 1234, null, 20261002);
  assert.notEqual(abi.memory.buffer, initialBuffer);
  assert.equal(state.routines.length, 10000); assert.equal(state.summary.totalCount, 10000);
  const copy = structuredClone(state);
  const bytes = new Uint8Array(abi.memory.buffer, abi.kin_result_ptr(), abi.kin_result_len()).slice();
  const byteCopy = bytes.slice();
  assert.throws(() => engine.applyEvents([...rows, rows[0]], 1234, null, 20261002), e => e.code === 5);
  const bad = create(); bad[104] = 255;
  assert.throws(() => engine.applyEvents([bad], 1234, null, 20261002), e => e.code === 2);
  assert.equal(engine.applyEvents([], 1234, null, 20261002).routines.length, 0);
  assert.deepEqual(state, copy); assert.deepEqual(bytes, byteCopy);
});
