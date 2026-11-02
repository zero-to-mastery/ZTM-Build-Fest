// The chore chart (#676) through the real engine: points, rewards and
// joining round-trip as event kinds 77–79, and kin_chore_chart credits a
// parent's tick to the child who owns the chore. Needs the built
// kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";
import { choreWeek } from "./kin-chores.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const civilDate = 20261003;
const asOf = new Date(2026, 9, 3, 12).getTime();
const PARENT = id(0xbb), MIA = id(0x02), LEO = id(0x03);

function household() {
  const records = [];
  let sequence = 0;
  const run = (command, actorId = PARENT) => {
    sequence += 1;
    const result = engine.executeCommand(command, {
      eventId: id(sequence), householdId: id(0xaa), actorId, deviceId: id(0xcc),
      timestamp: asOf + sequence, logicalTime: BigInt(sequence),
    }, records, asOf, null, civilDate);
    records.push(result.encodedEvent);
    return result;
  };
  return { records, run };
}

test("the chore chart round-trips through Rust", () => {
  const home = household();
  const members = [{ memberId: MIA, kind: "child" }, { memberId: LEO, kind: "child" }, { memberId: PARENT, kind: "adult" }];
  const read = (adultsAllowed = false) => engine.choreChart({ ...choreWeek(civilDate), adultsAllowed, members }, home.records, asOf, civilDate);
  assert.deepEqual(read().members.map((member) => [member.memberId, member.points, member.chores.length]), [[MIA, 0, 0], [LEO, 0, 0]]);

  home.run({ type: "create-routine", routineId: id(0x30), text: "Feed the cat", cadence: "daily", createdOn: civilDate });
  home.run({ type: "change-responsibility", targetKind: "routine", id: id(0x30), memberId: MIA });
  assert.equal(home.run({ type: "set-chore-points", routineId: id(0x30), points: 3 }).metadata.kind, "CHORE_POINTS_SET");
  assert.equal(home.run({ type: "set-chore-reward", memberId: MIA, goal: 20, text: " Movie night " }).metadata.kind, "CHORE_REWARD_SET");
  const chart = read();
  assert.deepEqual(chart.points, new Map([[id(0x30), 3]]));
  const mia = chart.members[0];
  assert.deepEqual(mia.reward, { goal: 20, text: "Movie night" });
  const today = mia.chores.find((chore) => chore.today);
  assert.deepEqual({ ...today, id: undefined }, { kind: "routine", id: undefined, date: civilDate, occurrenceKey: civilDate, done: false, today: true, points: 3 });

  // The parent ticks it; Mia gets the points.
  home.run({ type: "complete-routine-occurrence", routineId: id(0x30), occurrenceKey: civilDate });
  assert.equal(read().members[0].points, 3);
  assert.equal(read().members[0].chores.find((chore) => chore.today).done, true);

  // Adults: only when allowed, and only themselves.
  assert.throws(() => home.run({ type: "set-chore-chart-joined", memberId: MIA, joined: true }), (error) => error.code === 4, "not for someone else");
  assert.equal(home.run({ type: "set-chore-chart-joined", memberId: PARENT, joined: true }).metadata.kind, "CHORE_CHART_JOINED");
  assert.equal(read(false).members.length, 2);
  assert.deepEqual(read(true).members.map((member) => [member.memberId, member.adult]), [[MIA, false], [LEO, false], [PARENT, true]]);
  assert.throws(() => home.run({ type: "set-chore-points", routineId: id(0x30), points: 3 }), (error) => error.code === 4, "unchanged");
  assert.throws(() => home.run({ type: "set-chore-points", routineId: id(0x30), points: 11 }), (error) => error.code === 2);
});
