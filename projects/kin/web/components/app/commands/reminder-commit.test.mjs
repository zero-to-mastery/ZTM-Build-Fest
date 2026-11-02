import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
globalThis.document = { activeElement: null };

const { ItemCommands } = await import("./items.js");
const { RoutineCommands } = await import("./routines.js");

function commonContext(appendCommand) {
  const cancellations = [];
  const app = {
    busy: false,
    store: {},
    engine: {},
    state: { items: [], routines: [] },
    localReminders: { cancel: (id) => cancellations.push(id) },
  };
  const ctx = {
    app,
    append: { appendCommand, showDetailActionError() {} },
    session: {
      captureSession: () => ({ generation: 1 }),
      assertCurrentSession() {},
      isCurrentSession: () => true,
    },
    status: {
      setBusy(value) { app.busy = value; },
      clearAlert() {},
      setStatus() {},
      showAlert() {},
    },
    render: { renderState() {} },
    peers: { broadcastEventChange() {}, flushPeerRefresh() {} },
    navigation: { currentCivilDate: () => 20261016 },
    // app/private-prefs.js endReminder: this device's timer stops at once
    // (and, with private storage, the member's other devices follow).
    privatePrefs: { endReminder: (id) => { app.localReminders.cancel(id); return Promise.resolve(false); } },
  };
  return { app, ctx, cancellations };
}

function itemHarness(appendCommand) {
  const harness = commonContext(appendCommand);
  const emptyList = { contains: () => false };
  Object.assign(harness.app, {
    today: emptyList,
    needs: emptyList,
    shopping: emptyList,
    staples: emptyList,
    detail: { contains: () => false, querySelector: () => null },
    compose: { focusInput() {} },
  });
  harness.ctx.items = new ItemCommands(harness.ctx);
  return harness;
}

function routineHarness(appendCommand) {
  const harness = commonContext(appendCommand);
  Object.assign(harness.app, {
    today: { contains: () => false },
    routines: {
      captureFocus: () => null,
      restoreFocus() {},
      focusInput() {},
      closeSchedule() {},
      clearIfMatches() {},
    },
  });
  harness.ctx.routines = new RoutineCommands(harness.ctx);
  return harness;
}

test("busy handlers leave local reminders untouched", async () => {
  let appends = 0;
  const items = itemHarness(async () => { appends++; });
  items.app.busy = true;
  await items.ctx.items.handleCompleteItem({ detail: { itemId: "item-1" } });
  await items.ctx.items.handleArchiveItem({ detail: { itemId: "item-1" } });
  await items.ctx.items.saveItemPlanningDate({ itemId: "item-1", planningDate: 20261017 }, null);

  const routines = routineHarness(async () => { appends++; });
  routines.app.busy = true;
  await routines.ctx.routines.saveRoutine({ type: "complete-routine-occurrence", routineId: "routine-1" });

  assert.equal(appends, 0);
  assert.deepEqual(items.cancellations, []);
  assert.deepEqual(routines.cancellations, []);
});

test("failed Item and Routine mutations preserve their reminders", async () => {
  const failure = async () => { throw new Error("storage failed"); };
  for (const type of ["complete", "archive"]) {
    const { ctx, cancellations } = itemHarness(failure);
    await ctx.items.handleItemAction(type, "item-1");
    assert.deepEqual(cancellations, [], `${type} failure keeps the Item reminder`);
  }

  const planning = itemHarness(failure);
  await planning.ctx.items.saveItemPlanningDate({ itemId: "item-1", planningDate: 20261017 }, null);
  assert.deepEqual(planning.cancellations, [], "planning failure keeps the Item reminder");

  for (const type of ["complete-routine-occurrence", "archive-routine"]) {
    const { ctx, cancellations } = routineHarness(failure);
    await ctx.routines.saveRoutine({ type, routineId: "routine-1" });
    assert.deepEqual(cancellations, [], `${type} failure keeps the Routine reminder`);
  }
});

test("successful mutations cancel reminders only after the durable append", async () => {
  for (const type of ["complete", "archive"]) {
    const order = [];
    const harness = itemHarness(async () => { order.push("append"); });
    harness.app.localReminders.cancel = (id) => { order.push(`cancel:${id}`); };
    await harness.ctx.items.handleItemAction(type, "item-1");
    assert.deepEqual(order, ["append", "cancel:item:item-1"]);
  }

  const planningOrder = [];
  const planning = itemHarness(async () => { planningOrder.push("append"); });
  planning.app.localReminders.cancel = (id) => { planningOrder.push(`cancel:${id}`); };
  await planning.ctx.items.saveItemPlanningDate({ itemId: "item-1", planningDate: 20261017 }, null);
  assert.deepEqual(planningOrder, ["append", "cancel:item:item-1"]);

  for (const type of ["complete-routine-occurrence", "archive-routine"]) {
    const order = [];
    const harness = routineHarness(async () => { order.push("append"); });
    harness.app.localReminders.cancel = (id) => { order.push(`cancel:${id}`); };
    await harness.ctx.routines.saveRoutine({ type, routineId: "routine-1" });
    assert.deepEqual(order, ["append", "cancel:routine:routine-1"]);
  }
});
