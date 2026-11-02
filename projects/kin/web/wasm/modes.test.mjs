import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  encodeHouseholdModeRecord,
  loadKinEngine,
} from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const url = `data:application/wasm;base64,${wasm.toString("base64")}`;
const id = (value) => new Uint8Array(16).fill(value);
const identity = (device, sequence) => ({
  eventId: id(device * 16 + sequence),
  householdId: id(0xaa),
  actorId: id(0xbb),
  deviceId: id(device),
  timestamp: 1_760_000_000_000,
  logicalTime: sequence,
});
const change = (device, sequence, mode) =>
  encodeHouseholdModeRecord({
    ...identity(device, sequence),
    mode,
  });

test("protocol 15 encodes stable mode values and validates mode commands", async () => {
  await loadKinEngine(url);
  for (const [mode, value] of [
    ["normal", 0],
    ["vacation", 1],
    ["guests", 2],
    ["rest", 3],
  ]) {
    const record = change(1, value + 1, mode);
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    assert.equal(view.getUint16(2, true), 29);
    assert.equal(view.getUint32(84, true), 1);
    assert.equal(record[88], value);
  }
  assert.throws(() => encodeHouseholdModeRecord({
    ...identity(1, 1),
    mode: "unrecognized",
  }), /valid household mode/);
});

test("mode replay is deterministic across offline device conflicts and duplicates", async () => {
  const engine = await loadKinEngine(url);
  const vacation = change(1, 1, "vacation");
  const guests = change(2, 1, "guests");
  const project = (events) => engine.applyEvents(events, 1_760_000_000_000, null, 20261009);
  assert.equal(project([vacation]).mode, "vacation");
  assert.equal(project([vacation, vacation]).mode, "vacation");
  assert.equal(project([vacation, guests]).mode, "guests");
  assert.equal(project([guests, vacation]).mode, "guests");
  assert.equal(project([]).mode ?? "normal", "normal");
  assert.throws(
    () => engine.executeCommand(
      { type: "set-household-mode", mode: "guests" },
      { ...identity(1, 2), entityId: id(99) },
      [guests],
      1_760_000_000_000,
      null,
      20261009,
    ),
    (error) => error.code === 4,
  );
});
