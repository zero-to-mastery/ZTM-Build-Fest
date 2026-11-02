// Taking turns (#429) through the real engine: a rotation and a turn
// round-trip as event kinds 68 and 69, completing passes the turn and Undo
// brings it back, and the owner and "my things" follow it. Needs the built
// kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const asOf = 1_791_475_200_000;
const civilDate = 20261003;
const ALEX = id(0x01), SAM = id(0x02), JO = id(0x03), BINS = id(0x20);

function household() {
  const records = [];
  let sequence = 0;
  const run = (command) => {
    sequence += 1;
    const result = engine.executeCommand(command, {
      eventId: id(0x80 + sequence), householdId: id(0xaa), actorId: ALEX, deviceId: id(0xcc),
      timestamp: asOf + sequence, logicalTime: BigInt(sequence),
    }, records, asOf, null, civilDate);
    records.push(result.encodedEvent);
    return result;
  };
  return { records, run };
}

test("turns round-trip through Rust", () => {
  const home = household();
  const read = () => engine.routineRotations(home.records, asOf, civilDate);
  const mine = (member) => engine.myThings(member, home.records, asOf, civilDate).map((thing) => thing.routineId);
  assert.deepEqual(read(), []);
  home.run({ type: "create-routine", routineId: BINS, text: "Bins out", cadence: "daily", createdOn: civilDate });
  const result = home.run({ type: "set-routine-rotation", routineId: BINS, memberIds: [ALEX, SAM, JO], currentIndex: 1 });
  assert.equal(result.metadata.kind, "ROUTINE_ROTATION_SET");
  assert.deepEqual(read(), [{ routineId: BINS, memberIds: [ALEX, SAM, JO], current: SAM, next: JO }]);
  assert.deepEqual(mine(SAM), [BINS]);
  home.run({ type: "complete-routine-occurrence", routineId: BINS, occurrenceKey: civilDate });
  assert.equal(read()[0].current, JO);
  assert.deepEqual(mine(JO), [BINS]);
  home.run({ type: "reopen-routine-occurrence", routineId: BINS, occurrenceKey: civilDate });
  assert.equal(read()[0].current, SAM, "Undo gives it back");
  assert.equal(home.run({ type: "set-routine-turn", routineId: BINS, memberId: ALEX }).metadata.kind, "ROUTINE_TURN_SET");
  assert.equal(read()[0].current, ALEX);
  const refused = (command) => assert.throws(() => home.run(command), (error) => error.code === 4);
  refused({ type: "set-routine-turn", routineId: BINS, memberId: ALEX });
  refused({ type: "set-routine-turn", routineId: BINS, memberId: id(0x09) });
  refused({ type: "change-responsibility", targetKind: "routine", id: BINS, memberId: SAM });
  home.run({ type: "set-routine-rotation", routineId: BINS, memberIds: [], currentIndex: 0 });
  assert.deepEqual(read(), []);
  assert.deepEqual(mine(ALEX), [BINS], "the last turn stays the owner");
});
