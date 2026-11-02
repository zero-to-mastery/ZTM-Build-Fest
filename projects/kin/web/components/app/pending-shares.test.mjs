// #267: "sent" is only claimed once nothing unaccepted is left in the outbox.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.navigator ??= { onLine: true };
const { SyncController } = await import("./sync.js");

function controller({ unsent = [], current = true } = {}) {
  const statuses = [];
  const store = { getPendingOutbox: async (limit) => unsent.slice(0, limit) };
  const app = { pendingShares: new Set() };
  const ctx = {
    session: { captureSession: () => ({ store }), isCurrentSession: () => current },
    status: { setStatus: (message) => statuses.push(message) },
  };
  const sync = Object.create(SyncController.prototype);
  Object.assign(sync, { app, ctx });
  return { sync, app, statuses };
}
const waitingComposer = () => {
  const composer = { shared: false, markShared() { if (this.shared) return false; this.shared = true; return true; } };
  return composer;
};

test("an empty outbox upgrades every waiting capture once and says so", async () => {
  const { sync, app, statuses } = controller();
  const first = waitingComposer(), second = waitingComposer();
  app.pendingShares.add(first).add(second);
  assert.equal(await sync.settlePendingShares(), true);
  assert.deepEqual([first.shared, second.shared], [true, true]);
  assert.equal(app.pendingShares.size, 0);
  assert.deepEqual(statuses, ["Sent to your household."]);
  assert.equal(await sync.settlePendingShares(), false, "nothing left to settle");
});

test("anything still unaccepted keeps every capture waiting", async () => {
  const { sync, app, statuses } = controller({ unsent: [{ deviceSequence: 4 }] });
  const composer = waitingComposer();
  app.pendingShares.add(composer);
  assert.equal(await sync.settlePendingShares(), false);
  assert.equal(composer.shared, false);
  assert.equal(app.pendingShares.size, 1, "a later ready cycle checks again");
  assert.deepEqual(statuses, []);
});

test("a session that ended meanwhile settles nothing", async () => {
  const { sync, app } = controller({ current: false });
  const composer = waitingComposer();
  app.pendingShares.add(composer);
  assert.equal(await sync.settlePendingShares(), false);
  assert.equal(composer.shared, false);
});
