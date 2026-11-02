// #793: a wake counts as busy from its first wait until its refresh starts
// or it decides not to refresh, so nothing mistakes the gap for idle.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

globalThis.window = {};
globalThis.document = { visibilityState: "visible" };
const { installWakeHandlers } = await import("./wake.js");
const { RefreshController } = await import("./refresh.js");

/** An element with just what the wake reads, and a security-epoch check the test settles. */
function wakingApp() {
  const calls = [];
  const checks = [];
  const vault = { locked: false };
  const app = {
    vault,
    store: {},
    securityGeneration: 1,
    autoLockMinutes: 0,
    lastActivityAt: null,
    refreshing: false,
    ctx: {
      session: { lockHousehold: (...args) => { calls.push(["lock", ...args]); app.securityGeneration += 1; } },
      status: { setStatus: (message) => calls.push(["status", message]) },
      refresh: { refreshFromEvents: () => { calls.push(["refresh", app.wakePending]); app.refreshing = true; } },
      sync: { checkHouseholdAuthorization: async () => calls.push(["authorization"]) },
    },
  };
  installWakeHandlers(app, (checked) => {
    assert.equal(checked, vault);
    return new Promise((resolve, reject) => checks.push({ resolve, reject }));
  });
  return { app, calls, checks };
}

test("a wake is pending during the security-epoch check and hands over to the refresh", async () => {
  const { app, calls, checks } = wakingApp();
  assert.equal(app.wakePending, false);
  const wake = app.onTimeWake();
  assert.equal(app.wakePending, true, "pending from the first await");
  assert.equal(app.refreshing, false);
  checks[0].resolve();
  await wake;
  assert.equal(app.wakePending, false);
  assert.equal(app.refreshing, true, "the refresh is busy before the wake lets go");
  assert.deepEqual(calls, [["refresh", true], ["authorization"]]);
});

test("a wake whose check finds another tab locked stops being pending", async () => {
  const { app, calls, checks } = wakingApp();
  const wake = app.onTimeWake();
  assert.equal(app.wakePending, true);
  checks[0].reject(new Error("security epoch moved"));
  await wake;
  assert.equal(app.wakePending, false);
  assert.deepEqual(calls, [["lock", false]]);
});

test("a wake that outlives its session decides not to refresh and stops being pending", async () => {
  const { app, calls, checks } = wakingApp();
  const wake = app.onTimeWake();
  app.securityGeneration += 1;
  checks[0].resolve();
  await wake;
  assert.equal(app.wakePending, false);
  assert.deepEqual(calls, []);
});

test("a wake that returns before any wait is never pending", async () => {
  const hidden = wakingApp();
  globalThis.document.visibilityState = "hidden";
  try {
    await hidden.app.onTimeWake();
  } finally {
    globalThis.document.visibilityState = "visible";
  }
  const locked = wakingApp();
  locked.app.vault.locked = true;
  await locked.app.onTimeWake();
  const away = wakingApp();
  away.app.autoLockMinutes = 1;
  away.app.lastActivityAt = Date.now() - 120_000;
  await away.app.onTimeWake();
  for (const { app, checks } of [hidden, locked, away]) {
    assert.equal(app.wakePending, false);
    assert.equal(app.pendingWakes, 0);
    assert.equal(checks.length, 0);
  }
  assert.equal(away.calls[0][0], "lock");
});

test("overlapping wakes stay pending until the last one lets go", async () => {
  const { app, checks } = wakingApp();
  const first = app.onTimeWake();
  const second = app.onTimeWake();
  checks[0].resolve();
  await first;
  assert.equal(app.wakePending, true, "the second wake is still checking");
  checks[1].resolve();
  await second;
  assert.equal(app.wakePending, false);
  assert.equal(app.pendingWakes, 0);
});

test("a focus wake is pending from the focus event, with no gap before its check", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { app, checks } = wakingApp();
  app.onWindowFocus();
  app.onWindowFocus();
  assert.equal(app.wakePending, true, "pending while the activating click finishes");
  assert.equal(app.pendingWakes, 1, "a second focus restarts the same wake");
  mock.timers.tick(150);
  assert.equal(app.wakePending, true, "the epoch check took over");
  assert.equal(app.pendingWakes, 1);
  checks[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.wakePending, false);
  assert.equal(app.refreshing, true);
});

test("locking drops a focus wake that has not run", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { app, checks } = wakingApp();
  app.onWindowFocus();
  app.cancelFocusWake();
  assert.equal(app.wakePending, false);
  app.cancelFocusWake();
  assert.equal(app.pendingWakes, 0, "cancelling twice changes nothing");
  mock.timers.tick(150);
  assert.equal(checks.length, 0);
});

// wake.js lets go of wakePending as soon as refreshFromEvents() returns, so
// the real controller must set refreshing (or pendingRefresh) before its
// first await; the stub above cannot catch an await added ahead of it.
/** The real refresh controller, its history read held open by the test. */
function refreshingApp() {
  let release;
  const read = new Promise((resolve, reject) => { release = () => reject(Object.assign(new Error("stop"), { code: "locked" })); });
  const store = { getCatchUpState: () => read };
  const app = {
    vault: { locked: false }, store, engine: {}, busy: false, refreshing: false, pendingRefresh: false,
    alert: { textContent: "" }, contains: () => false,
  };
  app.ctx = {
    app,
    session: { captureSession: () => ({ store }), isCurrentSession: () => true },
    status: { setBusy: (busy) => { app.busy = busy; }, clearAlert() {}, setStatus() {} },
    peers: { flushPeerRefresh() {} },
  };
  return { app, refresh: new RefreshController(app.ctx), release };
}

test("the real refresh is busy before its first await, so a wake can let go", async () => {
  const idle = refreshingApp();
  const running = idle.refresh.refreshFromEvents();
  assert.equal(idle.app.refreshing, true, "refreshing is set before refreshFromEvents returns");
  idle.release();
  await running;
  assert.equal(idle.app.refreshing, false);

  const busy = refreshingApp();
  busy.app.busy = true;
  const deferred = busy.refresh.refreshFromEvents();
  assert.equal(busy.app.pendingRefresh, true, "a refresh asked for while busy is deferred, not dropped");
  await deferred;
});
