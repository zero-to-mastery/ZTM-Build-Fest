import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine, encodeAddedRecord, encodeCompletedRecord, encodeRoutineCreatedRecord, encodeRoutineActionRecord, idToHex } from "../wasm/kin-engine.js";
import { reconcileRemoteEvents } from "./event-store.js";
import { nextQuarantine, quarantineRetryItems } from "./quarantine.js";

const wasm = await readFile(new URL("../wasm/kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => new Uint8Array(16).fill(byte);
const context = (device, sequence, logicalTime) => ({
  eventId: id(device * 16 + sequence), householdId: id(0xaa),
  actorId: id(0xa0 + device), deviceId: id(device), timestamp: 1_791_475_200_000 + sequence,
  logicalTime: BigInt(logicalTime),
});

test("remote replay quarantines malformed and dependency-invalid events, advances to later valid history", () => {
  const offlineItem = encodeAddedRecord({ ...context(2, 1, 1), itemId: id(0x22), text: "Offline-only", classification: "need" });
  const poison = engine.executeCommand({
    type: "change-responsibility", targetKind: "item", targetId: [...id(0x22)].map((v) => v.toString(16).padStart(2, "0")).join(""), memberId: "ee".repeat(16),
  }, context(2, 2, 2), [offlineItem], 1_791_475_200_000, null, 20261009).encodedEvent;
  const valid = encodeAddedRecord({ ...context(3, 1, 1), itemId: id(0x33), text: "Buy milk", classification: "need" });
  const contextRow = { last_looked_event_id: null };
  const result = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: new Uint8Array([1, 2, 3]) }, { encodedEvent: poison }, { encodedEvent: valid }],
    engine, context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(result.quarantined, 2);
  assert.equal(result.additions.length, 1);
  assert.equal(engine.applyEvents(result.candidates, 1_791_475_200_000, null, 20261009).items[0].text, "Buy milk");
  const reordered = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: valid }, { encodedEvent: poison }, { encodedEvent: new Uint8Array([1, 2, 3]) }],
    engine, context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(reordered.quarantined, result.quarantined);
  assert.deepEqual(reordered.additions.map((row) => [...row.event_id]), result.additions.map((row) => [...row.event_id]));
  const duplicate = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: valid }, { encodedEvent: valid }], engine,
    context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(duplicate.quarantined, 0);
  assert.equal(duplicate.additions.length, 1);
});

test("an engine that cannot read a remote event stops the batch instead of quarantining it", () => {
  // A protocol mismatch (3) or an unreadable event (2) is not a household
  // conflict. Quarantining it would advance the sync cursor past history this
  // engine never applied; rethrowing leaves the cursor for an upgraded client.
  const valid = encodeAddedRecord({ ...context(3, 1, 1), itemId: id(0x33), text: "Buy milk", classification: "need" });
  for (const code of [2, 3]) {
    const refusing = { applyEvents() { throw Object.assign(new Error("needs a compatible household engine"), { code }); } };
    assert.throws(() => reconcileRemoteEvents({
      rows: [], received: [{ encodedEvent: valid }], engine: refusing,
      context: { last_looked_event_id: null }, asOf: 1_791_475_200_000, civilDate: 20261009,
    }), (error) => error.code === code);
  }
});

test("a kept event replayed from the quarantine never stops the batch (#153)", () => {
  // After an engine update a kept event might fail with another code. Only a
  // page event may stop a batch; a retried one is refused and stays counted.
  const valid = encodeAddedRecord({ ...context(3, 1, 1), itemId: id(0x33), text: "Buy milk", classification: "need" });
  const refusing = { applyEvents() { throw Object.assign(new Error("needs a compatible household engine"), { code: 3 }); } };
  const result = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: valid, retry: true }], engine: refusing,
    context: { last_looked_event_id: null }, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(result.additions.length, 0);
  assert.deepEqual(result.quarantinedItems.map((item) => item.reason), ["unsupported"]);
});

test("two devices changing one repeating task's schedule offline keep both replacements", () => {
  // A schedule change is create-replacement + archive-original. The second
  // archive of the original, from another device, is a recorded no-op.
  const routine = (device, sequence, logicalTime, routineId, cadence) => encodeRoutineCreatedRecord({
    ...context(device, sequence, logicalTime), routineId: id(routineId), text: "Pack lunches", cadence, createdOn: 20261012 });
  const archive = (device, sequence, logicalTime) => encodeRoutineActionRecord({
    ...context(device, sequence, logicalTime), routineId: id(0x50), action: "archive", occurrenceKey: 20261012 });
  const original = routine(1, 1, 1, 0x50, "daily");
  const deviceA = [routine(1, 2, 2, 0x60, "weekly"), archive(1, 3, 3)];
  const replay = (received) => reconcileRemoteEvents({
    rows: [], received: received.map((encodedEvent) => ({ encodedEvent })), engine,
    context: { last_looked_event_id: null }, asOf: 1_791_475_200_000, civilDate: 20261014,
  });
  const active = (result) => engine.applyEvents(result.candidates, 1_791_475_200_000, null, 20261014)
    .routines.filter((record) => record.status !== "archived").map((record) => record.cadence).sort();

  const sameClock = [original, ...deviceA, routine(2, 2, 2, 0x70, "weekdays"), archive(2, 3, 3)];
  for (const order of [sameClock, [...sameClock].reverse()]) {
    const result = replay(order);
    assert.equal(result.quarantined, 0, "no encrypted history is dropped");
    assert.deepEqual(active(result), ["weekdays", "weekly"], "both replacements stay active, deterministically");
  }

  const laterClock = [original, ...deviceA, routine(2, 2, 4, 0x70, "weekdays"), archive(2, 3, 5)];
  for (const order of [laterClock, [...laterClock].reverse()]) {
    const result = replay(order);
    assert.equal(result.quarantined, 0, "the later archive from the other device is kept as a no-op");
    assert.deepEqual(active(result), ["weekdays", "weekly"], "both replacements stay active");
  }
});

test("a completion delivered one page before its item is kept, then applied once the item arrives (#153)", () => {
  const added = encodeAddedRecord({ ...context(4, 1, 1), itemId: id(0x44), text: "Return library books", classification: "need" });
  const completed = encodeCompletedRecord({ ...context(4, 2, 2), itemId: id(0x44) });
  const page = (rows, received, previous) => {
    const retried = received.length > 0 && previous.length > 0;
    const result = reconcileRemoteEvents({
      rows, received: retried ? [...quarantineRetryItems(previous), ...received] : received,
      engine, context: { last_looked_event_id: null }, asOf: 1_791_475_200_000, civilDate: 20261009,
    });
    return { result, ...nextQuarantine(previous, result.quarantinedItems, { now: 1, retried }) };
  };

  const first = page([], [{ encodedEvent: completed }], []);
  assert.equal(first.result.additions.length, 0);
  assert.equal(first.added, 1);
  assert.equal(first.quarantine.length, 1);
  assert.equal(first.quarantine[0].eventId, idToHex(id(4 * 16 + 2)));
  assert.equal(first.quarantine[0].reason, "not-applicable");
  assert.deepEqual([...first.quarantine[0].encoded], [...completed], "the canonical bytes are kept");

  // A page that brings something unrelated retries and still refuses it.
  const other = encodeAddedRecord({ ...context(5, 1, 1), itemId: id(0x55), text: "Milk", classification: "need" });
  const second = page([], [{ encodedEvent: other }], first.quarantine);
  assert.equal(second.added, 0, "refused again, not new");
  assert.equal(second.quarantine[0].attempts, 2);
  const rows = second.result.additions;

  const third = page(rows, [{ encodedEvent: added }], second.quarantine);
  assert.equal(third.result.additions.length, 2, "the item and its completion are both applied");
  assert.deepEqual(third.quarantine, [], "no quarantine remains");
  const state = engine.applyEvents(third.result.candidates, 1_791_475_200_000, null, 20261009);
  assert.equal(state.items.find((item) => item.text === "Return library books").status, "completed");
});
