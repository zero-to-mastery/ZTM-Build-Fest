import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
globalThis.document = { activeElement: null };

const { ItemCommands } = await import("./items.js");
const { SyncController } = await import("../sync.js");

function harness(appendCommand = async () => {}) {
  const order = [];
  const alerts = [];
  const app = {
    busy: false,
    reconcilingResponsibility: false,
    pendingRefresh: false,
    store: {},
    engine: {},
    syncCoordinator: { syncNow() { order.push("sync"); } },
  };
  const ctx = {
    app,
    append: {
      async appendCommand(command) {
        order.push("append");
        await appendCommand(command, app);
      },
    },
    session: {
      captureSession: () => ({ generation: 1 }),
      assertCurrentSession() { order.push("assert"); },
      isCurrentSession: () => true,
    },
    status: {
      setBusy(value) { app.busy = value; order.push(`busy:${value}`); },
      clearAlert() {},
      showAlert(message) { alerts.push(message); },
    },
    render: { renderState() { order.push("render"); } },
    refresh: {
      captureRefreshFocus() { order.push("capture-focus"); return { control: "focused" }; },
      restoreRefreshFocus(focus) { order.push(`restore-focus:${focus.control}`); },
    },
    peers: {
      broadcastEventChange() { order.push("broadcast"); },
      flushPeerRefresh() { order.push(`flush:${app.pendingRefresh}`); app.pendingRefresh = false; },
    },
  };
  ctx.items = new ItemCommands(ctx);
  ctx.sync = new SyncController(ctx);
  return { alerts, app, ctx, order };
}

function change(ctx) {
  return ctx.items.handleChangeResponsibility({
    detail: { targetKind: "item", targetId: "item-1", memberId: "member-1" },
  });
}

test("a responsibility change renders its committed projection and flushes deferred refresh", async () => {
  const { app, ctx, order } = harness(async (_command, currentApp) => {
    currentApp.pendingRefresh = true;
  });

  await change(ctx);

  assert.equal(app.busy, false);
  assert.equal(app.pendingRefresh, false);
  assert.deepEqual(order, [
    "busy:true", "append", "assert", "render", "broadcast", "busy:false", "flush:true",
  ]);
});

test("a stale responsibility command requests and flushes an authoritative refresh", async () => {
  const conflict = Object.assign(new Error("stale responsibility"), { code: 4, userMessage: "That responsibility changed." });
  const { alerts, app, ctx, order } = harness(async () => { throw conflict; });

  await change(ctx);

  assert.equal(app.busy, false);
  assert.equal(app.pendingRefresh, false);
  assert.deepEqual(alerts, ["That responsibility changed."]);
  assert.deepEqual(order, ["busy:true", "append", "busy:false", "flush:true"]);
});

test("an unavailable workspace refuses a responsibility command", async () => {
  const { app, ctx, order } = harness();
  app.busy = true;

  await change(ctx);

  assert.deepEqual(order, []);
});

test("a responsibility change waits for member reconciliation", async () => {
  const { app, ctx, order } = harness();
  app.reconcilingResponsibility = true;

  await change(ctx);

  assert.deepEqual(order, []);
});

test("member reconciliation renders a cleared owner and flushes peer refresh", async () => {
  const { app, ctx, order } = harness(async (_command, currentApp) => {
    currentApp.pendingRefresh = true;
  });
  app.activeMemberIds = ["member-current"];
  app.syncCoordinator.identity = { memberId: "member-current" };
  app.state = {
    items: [{ itemId: "item-1", status: "open" }],
    responsibilities: [{ targetKind: "item", targetId: "item-1", memberId: "member-removed" }],
  };

  await ctx.sync.reconcileResponsibilityMembers();

  assert.equal(app.busy, false);
  assert.equal(app.pendingRefresh, false);
  assert.deepEqual(order, [
    "append", "assert", "assert", "capture-focus", "render", "restore-focus:focused", "broadcast", "flush:true",
  ]);
});

test("member reconciliation never claims the app-wide busy state", async () => {
  const { app, ctx, order } = harness();
  app.activeMemberIds = ["member-current"];
  app.syncCoordinator.identity = { memberId: "member-current" };
  app.state = {
    items: [{ itemId: "item-1", status: "open" }],
    responsibilities: [{ targetKind: "item", targetId: "item-1", memberId: "member-removed" }],
  };

  await ctx.sync.reconcileResponsibilityMembers();

  assert.equal(order.some((entry) => entry.startsWith("busy:")), false);
});

test("a failed background reconciliation defers refresh without showing an alert", async () => {
  const failure = Object.assign(new Error("write failed"), { userMessage: "Do not show this." });
  const { alerts, app, ctx, order } = harness(async () => { throw failure; });
  app.activeMemberIds = ["member-current"];
  app.syncCoordinator.identity = { memberId: "member-current" };
  app.state = {
    items: [{ itemId: "item-1", status: "open" }],
    responsibilities: [{ targetKind: "item", targetId: "item-1", memberId: "member-removed" }],
  };

  await ctx.sync.reconcileResponsibilityMembers();

  assert.equal(app.pendingRefresh, true);
  assert.equal(app.reconcilingResponsibility, false);
  assert.deepEqual(alerts, []);
  assert.deepEqual(order, ["append"]);
});

test("a lock during responsibility reconciliation leaves the replacement session untouched", async () => {
  const { alerts, app, ctx, order } = harness(async (_command, currentApp) => {
    currentApp.busy = false;
    ctx.session.isCurrentSession = () => false;
    throw Object.assign(new Error("locked"), { code: "locked" });
  });
  app.activeMemberIds = ["member-current"];
  app.syncCoordinator.identity = { memberId: "member-current" };
  app.state = {
    items: [{ itemId: "item-1", status: "open" }],
    responsibilities: [{ targetKind: "item", targetId: "item-1", memberId: "member-removed" }],
  };

  await ctx.sync.reconcileResponsibilityMembers();

  assert.equal(app.busy, false);
  assert.equal(app.reconcilingResponsibility, false);
  assert.deepEqual(alerts, []);
  assert.deepEqual(order, ["append"]);
});

test("member reconciliation does not start during a user responsibility change", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { app, ctx, order } = harness(() => waiting);
  app.activeMemberIds = ["member-current"];
  app.syncCoordinator.identity = { memberId: "member-current" };
  app.state = {
    items: [{ itemId: "item-1", status: "open" }],
    responsibilities: [{ targetKind: "item", targetId: "item-1", memberId: "member-removed" }],
  };

  const changing = change(ctx);
  await Promise.resolve();
  await ctx.sync.reconcileResponsibilityMembers();
  release();
  await changing;

  assert.equal(order.filter((entry) => entry === "append").length, 1);
});
