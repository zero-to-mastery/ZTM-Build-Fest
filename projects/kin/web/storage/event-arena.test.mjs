import assert from "node:assert/strict";
import test from "node:test";

import { EventArena, StaleHistoryError, historyWith } from "./event-arena.js";

const id = (tag, n) => {
  const bytes = new Uint8Array(16).fill(tag);
  new DataView(bytes.buffer).setUint32(0, n, true);
  return bytes;
};
const metadata = (n) => ({
  eventId: id(0xe1, n), householdId: id(0xa1, 1), actorId: id(0xb1, n % 3), deviceId: id(0xc1, n % 2),
  timestamp: 1_760_000_000_000 + n, logicalTime: BigInt(n), kind: n % 2 ? "ITEM_ADDED" : "ITEM_COMPLETED",
  eventVersion: n % 2 ? 2 : 1,
});
const record = (n, size = 90 + (n % 7)) => Uint8Array.from({ length: size }, (_, index) => (n + index) & 0xff);

function filled(count, start = 1) {
  const arena = new EventArena();
  arena.reset(0);
  for (let n = start; n < start + count; n += 1) assert.equal(arena.append(n * 2, record(n), metadata(n)), true);
  return arena;
}

test("appends grow past every initial capacity and keep exact bytes in order", () => {
  const arena = filled(2_500);
  const view = arena.view();
  assert.equal(view.length, 2_500);
  assert.equal(view.tail, 5_000);
  let expectedBytes = 0;
  for (let n = 1; n <= 2_500; n += 1) {
    assert.deepEqual(view.record(n - 1), record(n));
    expectedBytes += record(n).length;
    assert.equal(view.localSequence(n - 1), n * 2);
    assert.equal(view.logicalTime(n - 1), BigInt(n));
    assert.deepEqual(view.id(n - 1, "event_id"), id(0xe1, n));
    assert.deepEqual(view.id(n - 1, "device_id"), id(0xc1, n % 2));
  }
  assert.equal(view.byteLength, expectedBytes);
  assert.equal(view.maxLogicalTime(), 2_500n);
});

test("records are subarray views into one buffer, never copies", () => {
  const arena = filled(10);
  const view = arena.view();
  const first = view.record(0), second = view.record(1);
  assert.equal(first.buffer, second.buffer);
  assert.equal(second.byteOffset, first.byteOffset + first.length);
  assert.equal(view.records().every((entry) => entry.buffer === first.buffer), true);
});

test("copyTo writes the contiguous prefix in one operation", () => {
  const arena = filled(40);
  const view = arena.view(25);
  const target = new Uint8Array(view.byteLength + 8);
  view.copyTo(target, 8);
  let offset = 8;
  for (let index = 0; index < 25; index += 1) {
    assert.deepEqual(target.subarray(offset, offset + view.record(index).length), view.record(index));
    offset += view.record(index).length;
  }
  assert.equal(offset, target.length);
});

test("a prefix view is unaffected by later appends and growth", () => {
  const arena = filled(3);
  const view = arena.view();
  const before = view.records().map((entry) => entry.slice());
  for (let n = 4; n < 400; n += 1) arena.append(n * 2, record(n, 500), metadata(n));
  assert.equal(view.length, 3);
  assert.deepEqual(view.records(), before);
  assert.equal(view.indexOfSequence(8), -1, "lookups stay inside the prefix");
  assert.equal(view.indexOfEventId(id(0xe1, 10)), -1);
  assert.equal(arena.view().indexOfEventId(id(0xe1, 10)), 9);
});

test("appending an existing or earlier sequence is a no-op", () => {
  const arena = filled(5);
  assert.equal(arena.append(10, record(99), metadata(99)), false);
  assert.equal(arena.append(4, record(99), metadata(99)), false);
  assert.equal(arena.length, 5);
  assert.throws(() => arena.append(0, record(1), metadata(1)));
  assert.throws(() => arena.append(1.5, record(1), metadata(1)));
});

test("sequence and event-id lookups find every record and reject absent ones", () => {
  const arena = filled(1_000);
  const view = arena.view();
  for (let n = 1; n <= 1_000; n += 1) {
    assert.equal(view.indexOfSequence(n * 2), n - 1);
    assert.equal(view.indexOfEventId(id(0xe1, n)), n - 1);
  }
  assert.equal(view.indexOfSequence(3), -1);
  assert.equal(view.indexOfEventId(id(0xe1, 1_001)), -1);
  assert.equal(view.indexOfEventId(id(0x00, 1)), -1);
});

test("rows are detached copies in the historical row shape", () => {
  const arena = filled(3);
  const row = arena.view().row(1);
  assert.deepEqual(Object.keys(row).sort(), ["actor_id", "device_id", "encoded_event", "event_id",
    "event_version", "household_id", "kind", "local_sequence", "logical_time", "timestamp"]);
  assert.equal(row.kind, "ITEM_COMPLETED");
  assert.equal(row.event_version, 1);
  row.encoded_event.fill(0);
  assert.deepEqual(arena.view().record(1), record(2));
  assert.equal(arena.view().at(-1).local_sequence, 6);
  assert.equal(arena.view().at(3), undefined);
});

test("reset and wipe make outstanding views stale", () => {
  const arena = filled(4);
  const view = arena.view();
  arena.reset(1);
  assert.throws(() => view.record(0), StaleHistoryError);
  assert.throws(() => view.byteLength, StaleHistoryError);
  assert.equal(arena.generation, 1);
  assert.equal(arena.length, 0);
  const second = filled(4);
  const secondView = second.view();
  second.wipe();
  assert.throws(() => secondView.copyTo(new Uint8Array(1_000), 0), StaleHistoryError);
  assert.equal(second.generation, null);
  assert.throws(() => second.view(1), StaleHistoryError);
});

test("wipe zero-fills every buffer it held", () => {
  const arena = filled(200);
  const held = [arena.bytes, arena.spans, arena.sequences, arena.stamps, arena.ids, arena.kinds, arena.versions, arena.lookup];
  const logical = arena.logical;
  arena.wipe();
  for (const buffer of held) assert.equal(buffer.every((value) => value === 0), true);
  assert.equal(logical.every((value) => value === 0n), true);
  assert.equal(arena.length, 0);
  assert.equal(arena.byteLength, 0);
});

test("growth zero-fills the buffers it replaces", () => {
  const arena = new EventArena();
  arena.reset(0);
  arena.append(1, record(1, 1_000), metadata(1));
  const smallBytes = arena.bytes, smallIds = arena.ids;
  for (let n = 2; n < 200; n += 1) arena.append(n, record(n, 1_000), metadata(n));
  assert.notEqual(arena.bytes, smallBytes);
  assert.equal(smallBytes.every((value) => value === 0), true);
  assert.equal(smallIds.every((value) => value === 0), true);
});

test("a wiped arena can be reset and reused", () => {
  const arena = filled(10);
  arena.wipe();
  arena.reset(7);
  assert.equal(arena.append(1, record(1), metadata(1)), true);
  assert.deepEqual(arena.view().record(0), record(1));
});

test("historyWith replays a view plus extra records without combining arrays", () => {
  const arena = filled(5);
  const view = arena.view();
  const extra = [record(50, 10), record(51, 12)];
  const source = historyWith(view, extra);
  assert.equal(source.length, 7);
  assert.equal(source.byteLength, view.byteLength + 22);
  const target = new Uint8Array(source.byteLength);
  source.copyTo(target, 0);
  assert.deepEqual(target.subarray(view.byteLength, view.byteLength + 10), extra[0]);
  assert.deepEqual(target.subarray(view.byteLength + 10), extra[1]);
});
