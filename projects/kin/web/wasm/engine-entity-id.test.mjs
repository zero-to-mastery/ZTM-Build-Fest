// Issue #171, through the real engine: notes and references in an area, and
// maintenance linked to a routine, keep their own identities. Before the fix
// each took the area's or routine's ID, so the second save failed replay and
// an update could edit the wrong entity.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const hex = (n) => n.toString(16).padStart(2, "0").repeat(16);
const DAY = 20261009;
const AS_OF = 1_791_475_200_000;
const context = (n) => ({ eventId: hex(n), householdId: hex(1), actorId: hex(2), deviceId: hex(3), timestamp: AS_OF + n, logicalTime: BigInt(n) });

function household() {
  const records = [];
  let sequence = 100;
  const run = (command) => {
    const result = engine.executeCommand(command, context(++sequence), records, AS_OF + 1_000, null, DAY);
    records.push(result.encodedEvent);
    return result.state;
  };
  return run;
}

test("two notes in one area save as two notes, and an update edits only its own note", () => {
  const run = household();
  const area = hex(10), first = hex(11), second = hex(12);
  run({ type: "create-area", areaId: area, name: "Kitchen" });
  run({ type: "create-note", noteId: first, id: first, title: "Wi-Fi", body: "hall", areaId: area });
  run({ type: "create-note", noteId: second, id: second, title: "Spare key", body: "hook", areaId: area });
  const state = run({ type: "update-note", noteId: second, id: second, title: "Spare key", body: "drawer", areaId: area });
  const notes = Object.fromEntries(state.notes.map((note) => [note.noteId, note]));
  assert.deepEqual(Object.keys(notes).sort(), [first, second]);
  assert.equal(notes[first].body, "hall");
  assert.equal(notes[second].body, "drawer");
  assert.equal(notes[first].areaId, area);
  assert.equal(notes[second].areaId, area);
  assert.equal(state.notes.some((note) => note.noteId === area), false);
});

test("two reference records in one area stay distinct, and an update edits only its own record", () => {
  const run = household();
  const area = hex(20), furnace = hex(21), boiler = hex(22);
  const save = (recordId, title, fieldId, value) => run({ type: "save-reference-record", recordId, id: recordId, title, areaId: area, fields: [{ fieldId, label: "Model", value }] });
  run({ type: "create-area", areaId: area, name: "Basement" });
  save(furnace, "Furnace", hex(23), "A1");
  save(boiler, "Boiler", hex(24), "B2");
  const state = save(boiler, "Boiler (new)", hex(24), "B3");
  const rows = (records) => records.map(({ recordId, title, areaId, fields }) => [recordId, title, areaId, fields[0].value]).sort();
  assert.deepEqual(rows(state.referenceRecords), [
    [furnace, "Furnace", area, "A1"],
    [boiler, "Boiler (new)", area, "B3"],
  ].sort());
});

test("two maintenance entries linked to one routine stay distinct, and an update edits only its own entry", () => {
  const run = household();
  const routine = hex(30), record = hex(31), first = hex(32), second = hex(33);
  const save = (maintenanceId, performedOn, summary) => run({ type: "save-maintenance-event", maintenanceId, id: maintenanceId, recordId: record, performedOn, summary, nextOn: null, routineId: routine });
  run({ type: "create-routine", routineId: routine, text: "Change filter", cadence: "daily" });
  run({ type: "save-reference-record", recordId: record, id: record, title: "Furnace", fields: [{ fieldId: hex(34), label: "Filter", value: "16x25" }] });
  save(first, 20260901, "Filter changed");
  save(second, 20261001, "Filter changed again");
  const state = save(second, 20261001, "Filter and belt changed");
  assert.deepEqual(state.maintenanceEvents.map(({ maintenanceId, summary, routineId }) => [maintenanceId, summary, routineId]), [
    [first, "Filter changed", routine],
    [second, "Filter and belt changed", routine],
  ]);
});
