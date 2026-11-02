// The chore chart's rules on the single command append path (#676, ADR 0022
// §6): points and rewards are for Adults; joining is for an Adult while a
// household admin allows adults; leaving always works. Refused commands
// reach neither the store nor Rust.
import assert from "node:assert/strict";
import test from "node:test";
import { AppendCommands } from "./append.js";
import { ChoresController } from "../chores.js";
import { CHORES_FORBIDDEN, JOIN_FORBIDDEN } from "../../../wasm/kin-chores.js";

const ME = "01".repeat(16);

function appendWith({ memberKind, synced = true, allowed = false, joined = false }) {
  const appended = [];
  const app = { householdStatus: memberKind === undefined ? null : { memberKind }, hasLocalSyncBinding: synced, syncCoordinator: synced ? { syncNow: async () => {} } : null };
  const session = { store: { append: async (command) => { appended.push(command); return { state: {}, snapshotBoundary: null }; } } };
  const ctx = {
    app,
    session: { captureSession: () => session, assertCurrentSession() {} },
    undo: { beforeChange() {} },
    detail: { responsibilityContext: () => ({ memberId: ME, memberIds: [ME], names: null }) },
  };
  ctx.chores = new ChoresController(ctx);
  if (allowed) ctx.chores.receiveSetting({ adults: true, revision: 1, admin: false });
  if (joined) ctx.chores.chart = { members: [{ memberId: ME }] };
  return { append: new AppendCommands(ctx), appended };
}

const points = { type: "set-chore-points", routineId: "30".repeat(16), points: 3 };
const reward = { type: "set-chore-reward", memberId: "02".repeat(16), goal: 20, text: "Movie night" };
const join = { type: "set-chore-chart-joined", memberId: ME, joined: true };
const leave = { type: "set-chore-chart-joined", memberId: ME, joined: false };

test("Adults set points and rewards; nobody else does", async () => {
  for (const command of [points, reward]) {
    for (const options of [{ memberKind: "adult" }, { memberKind: undefined, synced: false }]) {
      const { append, appended } = appendWith(options);
      await append.appendCommand(command);
      assert.deepEqual(appended, [command]);
    }
    for (const memberKind of ["limited", "temporary", undefined]) {
      const { append, appended } = appendWith({ memberKind });
      await assert.rejects(append.appendCommand(command), (error) => error.code === "forbidden" && error.userMessage === CHORES_FORBIDDEN);
      assert.deepEqual(appended, []);
    }
  }
});

test("an Adult joins only while adults are allowed, and can always leave", async () => {
  const refused = appendWith({ memberKind: "adult" });
  await assert.rejects(refused.append.appendCommand(join), (error) => error.userMessage === JOIN_FORBIDDEN);
  assert.deepEqual(refused.appended, []);
  const allowed = appendWith({ memberKind: "adult", allowed: true });
  await allowed.append.appendCommand(join);
  assert.deepEqual(allowed.appended, [join]);
  const leaving = appendWith({ memberKind: "adult", joined: true });
  await leaving.append.appendCommand(leave);
  assert.deepEqual(leaving.appended, [leave], "even after an admin turned adults off");
  const child = appendWith({ memberKind: "limited", allowed: true });
  await assert.rejects(child.append.appendCommand(join), (error) => error.code === "forbidden");
  const local = appendWith({ memberKind: undefined, synced: false });
  await local.append.appendCommand(join);
  assert.equal(local.appended.length, 1, "a household that doesn't sync has nothing to allow");
});

test("ticking a chore is an ordinary command anyone may send", async () => {
  const { append, appended } = appendWith({ memberKind: "limited" });
  await append.appendCommand({ type: "complete", itemId: "40".repeat(16) });
  assert.equal(appended.length, 1);
});
