import assert from "node:assert/strict";

export async function routineRegressions() {
  const app = document.querySelector("kin-app");
  const ui = app.routines;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const idle = async () => {
    for (
      let i = 0;
      (app.busy || app.refreshing || app.pendingRefresh) && i < 300;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing, "Routine work returns idle");
  };
  const rows = () => app.store.loadEvents();
  const originalNow = Date.now;
  let now = new Date(2026, 9, 2, 12).getTime();
  Date.now = () => now;
  try {
    ui.input.value = "<b>Starter 🥛</b>";
    ui.cadence.value = "daily";
    ui.input.focus();
    ui.querySelector("form").requestSubmit();
    await idle();
    let routine = app.state.routines.at(-1);
    const dailyId = routine.routineId;
    check(
      routine.occurrenceKey === 20261002 && routine.occurrenceStatus === "open",
      "Rust derives daily occurrence",
    );
    check(
      !ui.querySelector("b") && ui.textContent.includes("<b>Starter 🥛</b>"),
      "Routine text stays inert",
    );
    check(
      ui.input.value === "" && document.activeElement === ui.input,
      "matching draft cleared and focus returned",
    );
    let button = ui.querySelector(
      '[data-action="complete-routine-occurrence"]',
    );
    button.focus();
    button.click();
    await idle();
    routine = app.state.routines.find((r) => r.routineId === dailyId);
    check(
      routine.occurrenceStatus === "completed" &&
        ui.textContent.includes("Done today"),
      "canonical completion and wording",
    );
    check(
      document.activeElement.dataset.action === "reopen-routine-occurrence",
      "focus follows new row action",
    );
    const before = await rows(),
      contextBefore = await app.store.ensureContext();
    const summary = JSON.stringify(app.state.summary);
    now = new Date(2026, 9, 3, 0, 0, 1).getTime();
    await app.onTimeWake();
    await idle();
    routine = app.state.routines.find((r) => r.routineId === dailyId);
    check(
      routine.occurrenceKey === 20261003 && routine.occurrenceStatus === "open",
      "midnight reprojection selects next day",
    );
    check(
      (await rows()).length === before.length &&
        (await app.store.ensureContext()).next_logical_time ===
          contextBefore.next_logical_time,
      "timer creates no fact or counter change",
    );
    check(
      JSON.stringify(app.state.summary) === summary,
      "time advance creates no summary entry",
    );
    await app.saveRoutine({
      type: "complete-routine-occurrence",
      routineId: dailyId,
      occurrenceKey: 20261002,
    });
    await idle();
    check(
      (await rows()).length === before.length && app.retryAction === null,
      "stale key rejected and obsolete retry retired",
    );
    check(
      app.status.textContent.includes("period changed"),
      "stale action has feedback",
    );

    // The candidate transaction samples its context once. A clock crossing
    // midnight while the transaction is open cannot retarget the frozen key.
    const originalEngineApply = app.engine.applyEvents;
    let sampled = false;
    app.engine.applyEvents = (...args) => {
      if (!sampled && args[0].length > 0) {
        sampled = true;
        now = new Date(2026, 9, 4, 0, 0, 1).getTime();
      }
      return originalEngineApply(...args);
    };
    const delayedCount = (await rows()).length;
    try {
      await app.saveRoutine({
        type: "complete-routine-occurrence",
        routineId: dailyId,
        occurrenceKey: 20261003,
      });
    } finally {
      app.engine.applyEvents = originalEngineApply;
    }
    check(
      (await rows()).length === delayedCount + 1,
      "transaction keeps one sampled context across a clock boundary",
    );
    routine = app.state.routines.find((r) => r.routineId === dailyId);
    check(
      routine.occurrenceKey === 20261003 &&
        routine.occurrenceStatus === "completed",
      "sampled context commits the intended occurrence",
    );
    now = new Date(2026, 9, 3, 12).getTime();
    await app.refreshFromEvents();

    await app.saveRoutine({
      type: "create-routine",
      text: "Weekly kitchen",
      cadence: "weekly",
    });
    const weeklyId = app.state.routines.at(-1).routineId;
    await app.saveRoutine({
      type: "complete-routine-occurrence",
      routineId: weeklyId,
      occurrenceKey: 20260928,
    });
    now = new Date(2026, 9, 4, 23, 59).getTime();
    await app.refreshFromEvents();
    check(
      app.state.routines.find((r) => r.routineId === weeklyId)
        .occurrenceStatus === "completed",
      "Sunday retains Monday completion",
    );
    now = new Date(2026, 9, 19, 12).getTime();
    document.dispatchEvent(new Event("visibilitychange"));
    for (let i = 0; app.state.routines.find(r => r.routineId === weeklyId).occurrenceKey !== 20261019 && i < 300; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    await idle();
    check(
      app.state.routines.find((r) => r.routineId === weeklyId).occurrenceKey ===
        20261019,
      "multiweek suspension skips directly to active week",
    );
    check(
      app.state.routines.find((r) => r.routineId === weeklyId)
        .occurrenceStatus === "open",
      "old completion does not carry over",
    );
    now = new Date(2026, 9, 3, 12).getTime();
    app.onWindowFocus();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await idle();
    check(
      app.state.routines.find((r) => r.routineId === weeklyId)
        .occurrenceStatus === "completed",
      "clock rollback replays original period",
    );

    const originalAdd = IDBObjectStore.prototype.add;
    const target = {
      type: "complete-routine-occurrence",
      routineId: dailyId,
      occurrenceKey: 20261003,
    };
    await app.saveRoutine({ ...target, type: "reopen-routine-occurrence" });
    for (const mode of ["quota", "abort"]) {
      const count = (await rows()).length;
      const counter = (await app.store.ensureContext()).next_logical_time;
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === "events" && mode === "quota")
          throw new DOMException("Synthetic quota", "QuotaExceededError");
        const request = originalAdd.apply(this, args);
        if (this.name === "events")
          request.addEventListener("success", () => this.transaction.abort());
        return request;
      };
      try {
        await app.saveRoutine(target);
      } finally {
        IDBObjectStore.prototype.add = originalAdd;
      }
      check(
        (await rows()).length === count &&
          (await app.store.ensureContext()).next_logical_time === counter,
        "failed Routine transaction rolls back event and counter",
      );
      check(
        !app.alert.hidden && typeof app.retryAction === "function",
        "failed Routine action offers retry",
      );
      await app.retryAction();
      await idle();
      check(
        (await rows()).length === count + 1,
        "retry commits exactly one fact",
      );
      await app.saveRoutine({ ...target, type: "reopen-routine-occurrence" });
    }

    // Preserve the frozen key through refresh failures, then retire it at a new boundary.
    const originalAppend = app.store.append.bind(app.store);
    app.store.append = async () => {
      throw new Error("Synthetic write");
    };
    try {
      await app.saveRoutine(target);
    } finally {
      app.store.append = originalAppend;
    }
    const originalRead = app.store.getCatchUpState.bind(app.store);
    app.store.getCatchUpState = async () => {
      throw new Error("Synthetic read");
    };
    try {
      await app.refreshFromEvents();
      await app.refreshFromEvents();
      check(
        app.suspendedRetry?.intent.occurrenceKey === 20261003,
        "failed refresh retains original occurrence key",
      );
    } finally {
      app.store.getCatchUpState = originalRead;
    }
    now = new Date(2026, 9, 5, 12).getTime();
    await app.refreshFromEvents();
    check(
      app.retryAction === null && app.suspendedRetry === null,
      "new period retires stale suspended retry",
    );

    ui.input.value = "Draft retained";
    ui.cadence.value = "weekly";
    ui.saveDraft();
    await app.refreshFromEvents();
    check(
      ui.input.value === "Draft retained" && ui.cadence.value === "weekly",
      "refresh preserves Routine draft",
    );
    const originalRender = app.renderState.bind(app);
    const beforeCommittedFailure = (await rows()).length;
    app.renderState = () => {
      throw new Error("Synthetic render after commit");
    };
    try {
      await app.saveRoutine({
        type: "complete-routine-occurrence",
        routineId: dailyId,
        occurrenceKey: 20261005,
      });
    } finally {
      app.renderState = originalRender;
    }
    check(
      (await rows()).length === beforeCommittedFailure + 1 &&
        app.retryAction === app.retryRefresh,
      "committed write offers refresh-only retry",
    );
    await app.retryAction();
    check(
      (await rows()).length === beforeCommittedFailure + 1 &&
        app.state.routines.find((r) => r.routineId === dailyId)
          .occurrenceStatus === "completed",
      "refresh retry never repeats committed write",
    );
    await app.saveRoutine({ type: "archive-routine", routineId: dailyId });
    check(
      !ui.querySelector(`[data-routine-id="${dailyId}"]`),
      "archive hides tombstone",
    );
    const count = (await rows()).length;
    await app.saveRoutine({ ...target, occurrenceKey: 20261005 });
    await idle();
    check(
      (await rows()).length === count,
      "archived occurrence action does not append",
    );
    await app.saveRoutine({ type: "archive-routine", routineId: weeklyId });
    ui.input.value = "";
    ui.saveDraft();
  } finally {
    Date.now = originalNow;
    await app.refreshFromEvents();
  }
  await app.saveRoutine({
    type: "create-routine",
    text: "Routine keyboard fixture",
    cadence: "daily",
  });
  check(
    app.pulseTimer !== null,
    "routine-only state schedules advisory refresh",
  );
  return "PASS Routine capture/lifecycle, calendar boundaries, suspend/rollback, stale keys, summary invariance, quota/abort retry, repeated refresh recovery, focus and inert text";
}

export async function routinePeerRegressions(first, second, until) {
  const idle = (client) =>
    until(() => client.evaluate("(()=>{const a=document.querySelector('kin-app');return !a.busy&&!a.refreshing&&!a.pendingRefresh;})()"));
  const append = (client, command) =>
    client.evaluate(
      `(async()=>{try{await document.querySelector('kin-app').store.append(${JSON.stringify(command)},document.querySelector('kin-app').engine);return {ok:true}}catch(error){return {ok:false,code:error.code}}})()`,
    );
  await Promise.all([idle(first), idle(second)]);
  await first.evaluate(
    `document.querySelector('kin-app').saveRoutine({type:'create-routine',text:'Peer routine',cadence:'daily'})`,
  );
  await idle(first);
  await second.evaluate(
    "document.querySelector('kin-app').refreshFromEvents()",
  );
  await until(() => second.evaluate("document.querySelector('kin-app').state.routines.some(r=>r.text==='Peer routine')"));
  await Promise.all([idle(first), idle(second)]);
  const command = await first.evaluate(
    `(()=>{const r=document.querySelector('kin-app').state.routines.at(-1);return {type:'complete-routine-occurrence',routineId:r.routineId,occurrenceKey:r.occurrenceKey};})()`,
  );
  for (const client of [first, second])
    assert.equal(
      await client.evaluate(
        `document.querySelector('kin-app').state.routines.find(r=>r.routineId==='${command.routineId}').occurrenceStatus`,
      ),
      "open",
    );
  const count = await first.evaluate(
    "document.querySelector('kin-app').store.loadEvents().then(rows=>rows.length)",
  );
  assert.deepEqual(await append(first, command), { ok: true });
  assert.deepEqual(await append(second, command), { ok: false, code: 4 });
  await Promise.all(
    [first, second].map((client) =>
      client.evaluate("document.querySelector('kin-app').refreshFromEvents()"),
    ),
  );
  await Promise.all([idle(first), idle(second)]);
  assert.equal(
    await first.evaluate(
      "document.querySelector('kin-app').store.loadEvents().then(rows=>rows.length)",
    ),
    count + 1,
  );
  for (const client of [first, second])
    assert.equal(
      await client.evaluate(
        `document.querySelector('kin-app').state.routines.find(r=>r.routineId==='${command.routineId}').occurrenceStatus`,
      ),
      "completed",
    );
  const reopen = { ...command, type: "reopen-routine-occurrence" };
  const completedCount = await first.evaluate(
    "document.querySelector('kin-app').store.loadEvents().then(rows=>rows.length)",
  );
  assert.deepEqual(await append(first, reopen), { ok: true });
  assert.deepEqual(await append(second, reopen), { ok: false, code: 4 });
  await Promise.all(
    [first, second].map((client) =>
      client.evaluate("document.querySelector('kin-app').refreshFromEvents()"),
    ),
  );
  await Promise.all([idle(first), idle(second)]);
  assert.equal(
    await first.evaluate(
      "document.querySelector('kin-app').store.loadEvents().then(rows=>rows.length)",
    ),
    completedCount + 1,
  );
  for (const client of [first, second])
    assert.equal(
      await client.evaluate(
        `document.querySelector('kin-app').state.routines.find(r=>r.routineId==='${command.routineId}').occurrenceStatus`,
      ),
      "open",
    );
  await first.evaluate(
    `document.querySelector('kin-app').saveRoutine({type:'archive-routine',routineId:'${command.routineId}'})`,
  );
  await idle(first);
  await second.evaluate(
    `document.querySelector('kin-app').saveRoutine(${JSON.stringify(command)})`,
  );
  await idle(second);
  assert.equal(
    await second.evaluate(
      `document.querySelector('kin-app').state.routines.find(r=>r.routineId==='${command.routineId}').status`,
    ),
    "archived",
  );
  console.log(
    "PASS Routine two-tab stale completion/reopen rejection, serialized persistence, peer archive and stale action convergence",
  );
}

export async function routineKeyboardRegressions(client, until) {
  const key = async (name) => {
    for (const type of ["keyDown", "keyUp"])
      await client.send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: name === "Tab" ? 9 : 13,
        ...(type === "keyDown" && name === "Enter" ? { text: "\r" } : {}),
      });
  };
  const idle = () =>
    until(() => client.evaluate("(()=>{const a=document.querySelector('kin-app');return !a.busy&&!a.refreshing&&!a.pendingRefresh;})()"));
  await client.evaluate(
    `(()=>{const ui=document.querySelector('kin-app').routines;ui.input.value='Keyboard routine';ui.input.focus();})()`,
  );
  await key("Tab");
  assert.equal(
    await client.evaluate("document.activeElement.id"),
    "routine-cadence",
  );
  await key("Tab");
  await key("Enter");
  await idle();
  assert.equal(
    await client.evaluate("document.activeElement.id"),
    "routine-text",
  );
  await client.evaluate(
    `(()=>{const ui=document.querySelector('kin-app').routines;[...ui.list.querySelectorAll('.complete-button')].at(-1).focus();})()`,
  );
  await key("Enter");
  await idle();
  assert.equal(
    await client.evaluate("document.activeElement.dataset.action"),
    "reopen-routine-occurrence",
  );
  await key("Enter");
  await idle();
  assert.equal(
    await client.evaluate("document.activeElement.dataset.action"),
    "complete-routine-occurrence",
  );
  await key("Tab");
  await key("Enter");
  await idle();
  assert.equal(
    await client.evaluate("document.activeElement.id"),
    "routine-text",
  );
  console.log(
    "PASS Routine native keyboard create/complete/reopen/archive, tab order and focus restoration",
  );
}
