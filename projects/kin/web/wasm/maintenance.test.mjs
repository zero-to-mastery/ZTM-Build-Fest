import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const hex = (n) => n.toString(16).padStart(2, "0").repeat(16);
const context = (n, device = 3, logicalTime = n) => ({ eventId: hex(n), householdId: hex(1), actorId: hex(2), deviceId: hex(device), timestamp: 1_791_475_200_000 + n, logicalTime: BigInt(logicalTime) });

test("maintenance events save, correct next dates, archive, and replay offline", () => {
  const records = [];
  const recordId = hex(20), maintenanceId = hex(30);
  const run = (command, n, device = 3, logicalTime = n, history = records) => engine.executeCommand(command, context(n, device, logicalTime), history, 1_791_475_200_000, null, 20261009);
  const reference = run({ type: "save-reference-record", id: recordId, recordId, title: "Furnace", fields: [{ fieldId: hex(21), label: "Model", value: "A1" }] }, 1);
  records.push(reference.encodedEvent);
  const first = run({ type: "save-maintenance-event", id: maintenanceId, maintenanceId, recordId, performedOn: 20260918, summary: "Filter changed", nextOn: 20261218, routineId: null }, 2);
  records.push(first.encodedEvent);
  assert.deepEqual(first.state.maintenanceEvents.map(({ summary, nextOn }) => [summary, nextOn]), [["Filter changed", 20261218]]);
  const corrected = run({ type: "save-maintenance-event", id: maintenanceId, maintenanceId, recordId, performedOn: 20260918, summary: "Filter changed", nextOn: 20270118, routineId: null }, 3);
  records.push(corrected.encodedEvent);
  assert.equal(corrected.state.maintenanceEvents[0].nextOn, 20270118);
  const concurrentA = run({ type: "save-maintenance-event", id: hex(40), maintenanceId: hex(40), recordId, performedOn: 20260801, summary: "Oil changed", nextOn: null, routineId: null }, 4, 4, 4, records.slice(0, 1));
  const concurrentB = run({ type: "save-maintenance-event", id: hex(41), maintenanceId: hex(41), recordId, performedOn: 20260802, summary: "Tire rotation", nextOn: null, routineId: null }, 5, 5, 4, records.slice(0, 1));
  const merged = engine.applyEvents([...records, concurrentB.encodedEvent, concurrentA.encodedEvent], 1_791_475_200_010, null, 20261009);
  assert.deepEqual(merged.maintenanceEvents.filter((event) => !event.archived).map((event) => event.performedOn), [20260918, 20260801, 20260802]);
  const archived = run({ type: "archive-maintenance-event", id: maintenanceId, maintenanceId }, 6);
  records.push(archived.encodedEvent);
  assert.equal(archived.state.maintenanceEvents[0].archived, true);
  assert.throws(() => run({ type: "save-maintenance-event", id: maintenanceId, maintenanceId, recordId, performedOn: 20260918, summary: "Changed again", nextOn: null, routineId: null }, 7), (error) => error.code === 4);
});
