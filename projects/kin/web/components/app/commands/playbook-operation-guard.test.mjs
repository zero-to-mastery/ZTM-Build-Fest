import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
globalThis.document = { activeElement: null };

const { RoutineCommands } = await import("./routines.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(appendCommand = async () => {}) {
  const calls = { appends: [], captures: 0, clears: 0, renders: 0, broadcasts: 0, alerts: [] };
  const app = {
    busy: false,
    store: {},
    engine: {},
    state: { items: [], playbooks: [{ playbookId: "playbook-1", title: "Ready", entries: ["Step"], archived: false }] },
    routines: {
      clearPlaybookEditor() { calls.clears++; },
    },
  };
  const ctx = {
    app,
    append: {
      async appendCommand(command) {
        calls.appends.push(command);
        await appendCommand(command);
      },
    },
    session: {
      captureSession() { calls.captures++; return { generation: 1 }; },
      assertCurrentSession() {},
      isCurrentSession: () => true,
    },
    status: {
      setBusy(value) { app.busy = value; },
      clearAlert() {},
      setStatus() {},
      showAlert(message, retry) { calls.alerts.push({ message, retry }); },
    },
    render: { renderState() { calls.renders++; } },
    peers: { broadcastEventChange() { calls.broadcasts++; }, flushPeerRefresh() {} },
  };
  ctx.routines = new RoutineCommands(ctx);
  return { app, calls, ctx };
}

function event(type, detail) {
  return { type: `kin:${type}`, detail };
}

test("Playbook intents refuse work while the workspace is unavailable", async () => {
  for (const unavailable of ["busy", "store", "engine"]) {
    const { app, calls, ctx } = harness();
    if (unavailable === "busy") app.busy = true;
    else app[unavailable] = null;
    const detail = { playbookId: null, title: "Draft", entries: ["Step"] };

    await ctx.routines.handlePlaybookIntent(event("save-playbook", detail));

    assert.deepEqual(calls.appends, [], `${unavailable} guard prevents the append`);
    assert.equal(calls.captures, 0, `${unavailable} guard prevents an operation session`);
    assert.equal(calls.clears, 0, `${unavailable} guard preserves the editor`);
    assert.equal(detail.playbookId, null, `${unavailable} guard does not mutate the draft intent`);
  }
});

test("Playbook instantiate is refused at the handler boundary while busy", async () => {
  const { app, ctx } = harness();
  let instantiations = 0;
  app.busy = true;
  ctx.routines.instantiatePlaybook = async () => { instantiations++; };

  await ctx.routines.handlePlaybookIntent(event("instantiate-playbook", { playbookId: "playbook-1" }));

  assert.equal(instantiations, 0);
});

test("a pending Playbook save refuses an overlapping archive", async () => {
  const pending = deferred();
  const { app, calls, ctx } = harness(() => pending.promise);
  const save = ctx.routines.handlePlaybookIntent(event("save-playbook", {
    playbookId: "playbook-1",
    title: "Updated",
    entries: ["Step"],
  }));
  assert.equal(app.busy, true);

  await ctx.routines.handlePlaybookIntent(event("archive-playbook", { playbookId: "playbook-1" }));
  assert.equal(calls.appends.length, 1);
  assert.equal(calls.appends[0].type, "save-playbook");

  pending.resolve();
  await save;
  assert.equal(app.busy, false);
  assert.equal(calls.clears, 1);
  assert.equal(calls.renders, 1);
  assert.equal(calls.broadcasts, 1);
});

test("a partial checklist commit renders, broadcasts and retries the same batch", async () => {
  let attempt = 0;
  let app;
  const harnessed = harness(async (command) => {
    attempt++;
    if (attempt === 3) throw Object.assign(new Error("storage failed"), { userMessage: "Kin could not save that change locally." });
    if (command.type === "add") {
      app.state.items.push({ itemId: command.id, text: command.text, status: "active", steps: [] });
      return;
    }
    const item = app.state.items.find(record => record.itemId === command.itemId);
    item.steps.push({ stepId: command.stepId, text: command.text, status: "active" });
  });
  app = harnessed.app;
  const { calls, ctx } = harnessed;
  const batch = {
    itemId: "item-1",
    title: "Departure",
    steps: [
      { stepId: "step-1", text: "Lock doors" },
      { stepId: "step-2", text: "Turn off lights" },
    ],
  };

  await ctx.routines.instantiatePlaybook(batch);

  assert.deepEqual(app.state.items[0].steps.map(step => step.stepId), ["step-1"]);
  assert.equal(calls.renders, 1);
  assert.equal(calls.broadcasts, 1);
  assert.equal(calls.alerts[0].message, "Checklist partly created. Retry to add the remaining steps.");
  assert.equal(typeof calls.alerts[0].retry, "function");

  await calls.alerts[0].retry();

  assert.equal(calls.appends.filter(command => command.type === "add").length, 1);
  assert.deepEqual(app.state.items[0].steps.map(step => step.stepId), ["step-1", "step-2"]);
  assert.equal(calls.renders, 2);
  assert.equal(calls.broadcasts, 2);
});

test("a checklist failure before any commit keeps the original error and does not redraw", async () => {
  const { calls, ctx } = harness(async () => {
    throw Object.assign(new Error("storage failed"), { userMessage: "Specific storage failure." });
  });

  await ctx.routines.instantiatePlaybook({
    itemId: "item-1",
    title: "Departure",
    steps: [{ stepId: "step-1", text: "Lock doors" }],
  });

  assert.equal(calls.alerts[0].message, "Specific storage failure.");
  assert.equal(calls.renders, 0);
  assert.equal(calls.broadcasts, 0);
});
