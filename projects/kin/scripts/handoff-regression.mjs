import assert from "node:assert/strict";

// Serialized into the isolated browser; all fixtures are synthetic.
export async function handoffRegressions() {
  const app = document.querySelector("kin-app");
  const capture = app.handoffs;
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const idle = async (waitWhile = () => false) => {
    // Controller methods below are invoked directly so failures can be
    // injected. This observes a quiet point but does not reserve it: a peer
    // message can still arrive after idle() resolves. Direct saves therefore
    // use startHandoffSave(), which fails loudly if the busy guard drops one.
    // `waitWhile` also keeps waiting, up to the same limit, for state that a
    // refresh idle() can't see yet is still settling.
    for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending || waitWhile()) && i < 300; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "Handoff operation must settle");
  };
  // A peer message or refresh can take the busy guard between idle() and the
  // save, which then returns without saving (#164). Retry only that case:
  // nothing started, so nothing can be saved twice. Resolves once the save
  // has started, with `done` settling when it finishes.
  const startHandoffSave = async (command) => {
    for (let attempt = 1; ; attempt++) {
      const done = app.ctx.conversations.saveHandoff(command);
      if (app.busy && app.status.textContent === "Saving…") return { done };
      await done;
      check(attempt < 5, `direct Handoff save started (${command.type})`);
      await idle();
    }
  };
  const count = async () => (await app.store.loadEvents()).length;
  const edit = (text) => {
    capture.input.value = text;
    capture.saveDraft();
  };
  // The same race for the form (#327): a refresh that takes the busy guard
  // between idle() and requestSubmit() makes the save return without saving
  // or failing, so neither the result nor Retry appears. The draft is still in
  // the field, so submitting again cannot save anything twice. Each submit
  // waits for a quiet point and resubmits until the save has really started.
  const submitStarted = async () => {
    for (let attempt = 1; ; attempt++) {
      await idle();
      capture.querySelector("form").requestSubmit();
      if (app.busy && app.status.textContent === "Saving…") return;
      check(attempt < 5, "the Handoff form's save started");
    }
  };
  const submit = async () => {
    await submitStarted();
    await idle();
  };
  const text = '<script>alert("handoff")</script> 🥛';
  const before = await count();
  edit(text);
  await submit();
  const record = app.state.handoffs.at(-1);
  check(
    record.text === text && record.status === "unacknowledged",
    "new handoff projection",
  );
  check(
    !app.state.items.some((item) => item.itemId === record.handoffId),
    "independent random Handoff ID",
  );
  check(
    capture.querySelector(".item-text").textContent === text &&
      !capture.querySelector("script"),
    "inert handoff text",
  );
  check(
    capture.input.value === "" && !sessionStorage.getItem("kin.handoff.draft"),
    "own draft clears",
  );
  check(document.activeElement === capture.input, "handoff add focus");
  capture.querySelector(".complete-button").click();
  await idle();
  check(app.state.handoffs[0].status === "acknowledged", "acknowledgement");
  check(
    capture.querySelector(".completed-label").textContent === "Seen",
    "neutral receipt label",
  );
  capture.querySelector(".archive-button").click();
  await idle();
  check(
    app.state.handoffs[0].status === "archived" && !capture.querySelector("li"),
    "hidden tombstone",
  );
  check((await count()) === before + 3, "archival retains events");
  for (const handoffId of [record.handoffId, "ff".repeat(16)]) {
    for (const type of ["acknowledge-handoff", "archive-handoff"]) {
      let code;
      try {
        await app.store.append({ type, handoffId }, app.engine);
      } catch (error) {
        code = error.code;
      }
      check(
        code === 4 && (await count()) === before + 3,
        "invalid reference must not append",
      );
    }
  }
  const originalAdd = IDBObjectStore.prototype.add;
  edit("Original handoff");
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === "events")
      throw new DOMException("Synthetic quota", "QuotaExceededError");
    return originalAdd.apply(this, args);
  };
  try {
    await submit();
  } finally {
    IDBObjectStore.prototype.add = originalAdd;
  }
  for (let i = 0; i < 500 && (app.busy || app.retryButton.hidden || capture.input.value !== "Original handoff"); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  check(
    !app.retryButton.hidden && capture.input.value === "Original handoff",
    `failed add retains draft/retry (${JSON.stringify({ hidden: app.retryButton.hidden, value: capture.input.value, busy: app.busy, alert: app.alert.textContent, retryAction: !!app.retryAction })})`,
  );
  edit("Newer handoff draft");
  const originalRetry = app.retryAction;
  const originalMessage = app.alert.textContent;
  const getCatchUpState = app.store.getCatchUpState.bind(app.store);
  app.store.getCatchUpState = async () => {
    throw new Error("Synthetic refresh failure");
  };
  try {
    await app.ctx.refresh.refreshFromEvents();
    await app.ctx.refresh.refreshFromEvents();
    check(
      app.retryAction === app.retryRefresh,
      "failed refresh offers refresh recovery first",
    );
  } finally {
    app.store.getCatchUpState = getCatchUpState;
  }
  await app.retryAction();
  for (let i = 0; i < 500 && (app.busy || app.refreshing || app.pendingRefresh || app.wakePending || app.retryAction !== originalRetry || app.alert.textContent !== originalMessage); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  check(
    app.retryAction === originalRetry &&
      app.alert.textContent === originalMessage,
    `recovered refresh restores original failed Handoff command (${JSON.stringify({ retryRestored: app.retryAction === originalRetry, alert: app.alert.textContent, originalMessage, suspended: !!app.suspendedRetry, busy: app.busy, stateCount: app.state.handoffs.length })})`,
  );
  check(
    (await count()) === before + 3,
    "refresh recovery must not append automatically",
  );
  const retryState = { busyBefore: app.busy, refreshing: app.refreshing, pending: app.pendingRefresh, disabled: app.retryButton.disabled, hidden: app.retryButton.hidden, hasRetry: typeof app.retryAction === "function" };
  // A background refresh (window focus, timers) can start between the wait
  // above and the click and swallow it; the retry is still exactly-once
  // because the second click lands while the first save is busy.
  for (let attempt = 0; attempt < 3 && (await count()) !== before + 4; attempt++) {
    for (let i = 0; i < 300 && (app.busy || app.refreshing || app.pendingRefresh || app.wakePending || typeof app.retryAction !== "function"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    app.retryButton.click();
    app.retryButton.click();
    await idle();
  }
  check(
    (await count()) === before + 4 &&
      app.state.handoffs.at(-1).text === "Original handoff",
    `retry original exactly once (${JSON.stringify({ ...retryState, count: await count(), expected: before + 4, last: app.state.handoffs.at(-1)?.text, alert: app.alert.textContent, status: app.status.textContent, busy: app.busy })})`,
  );
  check(
    capture.input.value === "Newer handoff draft",
    "older retry preserves newer text",
  );
  for (const mode of ["quota", "abort"]) {
    await idle();
    const eventCount = await count();
    const counter = (await app.store.ensureContext()).next_logical_time;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name !== "events") return originalAdd.apply(this, args);
      if (mode === "quota")
        throw new DOMException("Synthetic quota", "QuotaExceededError");
      const request = originalAdd.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    };
    try {
      await (await startHandoffSave({ type: "add-handoff", text: "Atomic handoff " + mode })).done;
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }
    check(
      (await count()) === eventCount &&
        (await app.store.ensureContext()).next_logical_time === counter,
      "Handoff event/counter rollback",
    );
    for (let i = 0; i < 500 && (app.busy || app.retryButton.hidden || app.retryAction === app.retryRefresh); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    app.retryButton.click();
    app.retryButton.click();
    for (let i = 0; i < 500 && (app.busy || !app.state.handoffs.some((row) => row.text === "Atomic handoff " + mode)); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const retryCount = await count();
    const retryCounter = (await app.store.ensureContext()).next_logical_time;
    check(
      retryCount === eventCount + 1 && retryCounter === counter + 1n,
      `Handoff event/counter exactly once (events ${eventCount} → ${retryCount}; logical ${counter} → ${retryCounter}; retry ${Boolean(app.retryAction)})`,
    );
  }
  const saved = (await app.store.loadEvents()).find(
    (row) => row.kind === "HANDOFF_ADDED",
  );
  const canonical = [...new Uint8Array(saved.encoded_event)];
  const writeRow = (row) =>
    new Promise((resolve, reject) => {
      const tx = app.store.database.transaction("events", "readwrite");
      tx.objectStore("events").put(row);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  await writeRow({ ...saved, actor_id: new Uint8Array(16) });
  // The session arena already holds this row; corruption written outside Kin's
  // write paths is detected at the next full read (THREAT-MODEL.md), forced here.
  app.store.arena.reset(null);
  let rejected = false;
  try {
    await app.store.loadEvents();
  } catch {
    rejected = true;
  }
  check(rejected, "malformed Handoff metadata fails safely");
  const raw = await new Promise((resolve) => {
    const tx = app.store.database.transaction("events", "readonly");
    const request = tx.objectStore("events").get(saved.local_sequence);
    request.onsuccess = () => resolve(request.result);
  });
  check(
    JSON.stringify([...new Uint8Array(raw.encoded_event)]) ===
      JSON.stringify(canonical),
    "canonical Handoff bytes preserved",
  );
  await writeRow(saved);
  const append = app.store.append.bind(app.store);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  app.store.append = async (...args) => {
    await gate;
    return append(...args);
  };
  await idle();
  edit("Delayed handoff");
  const { done: pending } = await startHandoffSave({ type: "add-handoff", text: capture.input.value });
  check(
    [...app.main.querySelectorAll("input,select,button")]
      .filter((control) => !control.closest("kin-security"))
      .every((control) => control.matches(":disabled")),
    "all controls disabled during Handoff save",
  );
  check(app.busy, "Handoff pending save retains busy state");
  edit("Newer handoff draft");
  app.ctx.peers.handlePeerMessage({ data: { type: "events-changed" } });
  check(app.pendingRefresh, "peer refresh waits for pending Handoff save");
  release();
  await pending;
  await idle();
  app.store.append = append;
  check(
    capture.input.value === "Newer handoff draft",
    "delayed Handoff keeps newer draft",
  );
  check(
    app.state.handoffs.at(-1).text === "Delayed handoff",
    "delayed original text persisted",
  );
  const target = app.state.handoffs.at(-1).handoffId;
  for (const [type, mode, status] of [
    ["acknowledge-handoff", "quota", "acknowledged"],
    ["archive-handoff", "abort", "archived"],
  ]) {
    await idle();
    const beforeAction = await count();
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name !== "events") return originalAdd.apply(this, args);
      if (mode === "quota")
        throw new DOMException("Synthetic quota", "QuotaExceededError");
      const request = originalAdd.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    };
    try {
      await idle();
      await (await startHandoffSave({ type, handoffId: target })).done;
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }
    // The failed save's finally runs a waiting peer refresh, which takes the
    // alert while it reads and offers the same Retry again when it finishes
    // (refresh.js). Checking in between saw no Retry (#327): wait for it.
    // A wake refresh reads the security epoch before idle() can see it, then
    // hides Retry while it reads (#469), so wait until Retry is offered and
    // read it before the awaited count() gives such a refresh room to start.
    await idle(() => app.retryButton.hidden);
    const actionState = { hidden: app.retryButton.hidden, busy: app.busy, refreshing: app.refreshing, pendingRefresh: app.pendingRefresh, wakePending: app.wakePending, alert: app.alert.textContent };
    actionState.count = await count();
    check(
      actionState.count === beforeAction && !actionState.hidden,
      `failed Handoff action keeps retry ${JSON.stringify({ ...actionState, beforeAction })}`,
    );
    check(
      document.activeElement === capture.input &&
        app.alert.getAttribute("role") === "alert",
      "action error focus/announcement",
    );
    const actionRetry = app.retryAction;
    // A wake refresh (window focus, visibility, the Pulse timer: onTimeWake
    // in context.js) reads the security epoch before it marks the app
    // refreshing, so idle() can't see it coming. If one lands while a refresh
    // below runs, refreshFromEvents only defers (pendingRefresh) and the
    // deferred run can end after the stub is restored, so the Retry checked
    // below was the refresh's, or none (#469). Settle after each refresh,
    // while the failure is still injected, so every refresh that starts in
    // this window fails as intended.
    await idle();
    app.store.getCatchUpState = async () => {
      throw new Error("Synthetic action refresh failure");
    };
    try {
      await app.ctx.refresh.refreshFromEvents();
      await idle();
      await app.ctx.refresh.refreshFromEvents();
      await idle();
    } finally {
      app.store.getCatchUpState = getCatchUpState;
    }
    check(
      app.retryAction === app.retryRefresh,
      "a failed refresh offers its own Retry while the Handoff action waits",
    );
    await app.retryAction();
    await idle();
    check(
      app.retryAction === actionRetry,
      "refresh recovery retains Handoff action retry",
    );
    app.retryButton.click();
    app.retryButton.click();
    app.retryButton.click();
    await idle();
    check(
      (await count()) === beforeAction + 1 &&
        app.state.handoffs.find((row) => row.handoffId === target).status ===
          status,
      "rapid action retries persist once",
    );
  }
  const originalSet = Storage.prototype.setItem;
  const originalRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = Storage.prototype.removeItem = () => {
    throw new DOMException("Blocked", "SecurityError");
  };
  try {
    edit("Handoff storage unavailable");
    await submit();
    check(
      capture.input.value === "",
      "session storage denial permits Handoff capture",
    );
  } finally {
    Storage.prototype.setItem = originalSet;
    Storage.prototype.removeItem = originalRemove;
  }
  const realAppend = app.store.append;
  app.store.append = async () => {
    throw new Error("Synthetic save failure");
  };
  try {
    await idle();
    await (await startHandoffSave({ type: "add-handoff", text: "Superseded retry" })).done;
  } finally {
    app.store.append = realAppend;
  }
  app.store.getCatchUpState = async () => {
    throw new Error("Synthetic refresh failure");
  };
  try {
    await app.ctx.refresh.refreshFromEvents();
  } finally {
    app.store.getCatchUpState = getCatchUpState;
  }
  await idle();
  await (await startHandoffSave({ type: "add-handoff", text: "New command after refresh failure" })).done;
  await app.ctx.refresh.refreshFromEvents();
  check(
    app.retryAction === null &&
      app.suspendedRetry === null &&
      !app.state.handoffs.some((row) => row.text === "Superseded retry"),
    "new command supersedes suspended retry",
  );
  edit("Newer handoff draft");
  const events = (await app.store.loadEvents()).map((row) => row.encoded_event);
  check(
    JSON.stringify(app.engine.applyEvents(events, 0, null, 20261002)) ===
      JSON.stringify(app.state),
    "mixed deterministic replay",
  );
  check(
    app.store.database.version === 5,
    "encrypted stores retain canonical event compatibility",
  );
  // Reproduces the race: a save submitted while a refresh holds the guard
  // starts once it is released, and is not lost.
  {
    const quiet = await count();
    edit("Race handoff");
    app.ctx.status.setBusy(true);
    capture.querySelector("form").requestSubmit();
    check((await count()) === quiet && capture.input.value === "Race handoff", "a submit during a refresh saves nothing and keeps the draft");
    setTimeout(() => app.ctx.status.setBusy(false), 30);
    await submit();
    check((await count()) === quiet + 1 && app.state.handoffs.at(-1)?.text === "Race handoff", "the next quiet submit saves it once");
    // Tidy up through the guarded path, so the next suite starts clean.
    await (await startHandoffSave({ type: "archive-handoff", handoffId: app.state.handoffs.at(-1).handoffId })).done;
    await idle();
  }
  return "PASS Handoff add/acknowledge/archive, tombstones, invalid references, inert Unicode, retry draft ownership and mixed replay";
}

export async function handoffPeerRegressions(first, second, until) {
  await first.evaluate(
    `document.querySelector('kin-app').ctx.conversations.handleAddHandoff({detail:{text:'Peer Handoff'}})`,
  );
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.handoffs.some(row=>row.text==='Peer Handoff')`,
    ),
  );
  assert.equal(
    await second.evaluate(
      'JSON.stringify(document.querySelector("kin-app").state)',
    ),
    await first.evaluate(
      'JSON.stringify(document.querySelector("kin-app").state)',
    ),
  );
  assert.ok(
    (await second.evaluate("window.peerMessages")).every(
      (message) => JSON.stringify(message) === '{"type":"events-changed"}',
    ),
  );
  await second.evaluate(`(async()=>{
    const app=document.querySelector('kin-app');
    const record=app.state.handoffs.find(row=>row.text==='Peer Handoff');
    const original=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(...args){
      if(this.name==='events') throw new DOMException('Synthetic quota','QuotaExceededError');
      return original.apply(this,args);
    };
    try { await app.ctx.conversations.handleHandoffAction('acknowledge-handoff',record.handoffId); }
    finally { IDBObjectStore.prototype.add=original; }
  })()`);
  assert.equal(
    await second.evaluate(
      'document.querySelector("kin-app").retryButton.hidden',
    ),
    false,
  );
  await first.evaluate(`(()=>{
    const app=document.querySelector('kin-app');
    return app.ctx.conversations.handleHandoffAction('archive-handoff',app.state.handoffs.find(row=>row.text==='Peer Handoff').handoffId);
  })()`);
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.handoffs.find(row=>row.text==='Peer Handoff')?.status==='archived' && document.querySelector('kin-app').retryButton.hidden`,
    ),
  );
  for (const action of ["acknowledge-handoff", "archive-handoff"]) {
    const id = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      await app.ctx.conversations.handleAddHandoff({detail:{text:'Missed Handoff invalidation'}});
      return app.state.handoffs.at(-1).handoffId;
    })()`);
    await until(() =>
      second.evaluate(
        `document.querySelector('kin-app').state.handoffs.some(row=>row.handoffId==='${id}')`,
      ),
    );
    await second.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      app.channel.removeEventListener('message',app.onPeerMessage);
      const original=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){
        if(this.name==='events') throw new DOMException('Synthetic quota','QuotaExceededError');
        return original.apply(this,args);
      };
      try { await app.ctx.conversations.handleHandoffAction('${action}','${id}'); }
      finally { IDBObjectStore.prototype.add=original; }
    })()`);
    await second.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      const load=app.store.getCatchUpState.bind(app.store);
      app.store.getCatchUpState=async()=>{throw new Error('Synthetic refresh failure');};
      try { await app.ctx.refresh.refreshFromEvents(); await app.ctx.refresh.refreshFromEvents(); }
      finally { app.store.getCatchUpState=load; }
    })()`);
    const count = await first.evaluate(
      '(async()=>(await document.querySelector("kin-app").store.loadEvents()).length)()',
    );
    await first.evaluate(
      `document.querySelector('kin-app').ctx.conversations.handleHandoffAction('archive-handoff','${id}')`,
    );
    await second.evaluate(
      'document.querySelector("kin-app").retryButton.click()',
    );
    await until(() =>
      second.evaluate(
        `!document.querySelector('kin-app').busy && document.querySelector('kin-app').retryButton.hidden && document.querySelector('kin-app').state.handoffs.find(row=>row.handoffId==='${id}')?.status==='archived'`,
      ),
    );
    assert.equal(
      await second.evaluate(
        '(async()=>(await document.querySelector("kin-app").store.loadEvents()).length)()',
      ),
      count + 1,
    );
    await second.evaluate(
      `{const app=document.querySelector('kin-app');app.channel.addEventListener('message',app.onPeerMessage);}`,
    );
  }
  await second.evaluate(
    'document.querySelector("kin-handoff-list .archive-button").focus()',
  );
  await first.evaluate(
    "document.querySelector('kin-app').ctx.conversations.handleAddHandoff({detail:{text:'Focus refresh Handoff'}})",
  );
  await until(() =>
    second.evaluate(
      "document.querySelector('kin-app').state.handoffs.some(row=>row.text==='Focus refresh Handoff')",
    ),
  );
  assert.equal(
    await second.evaluate(
      'document.activeElement===document.querySelector("#handoff-text")',
    ),
    true,
  );
  console.log(
    "PASS Handoff cross-tab canonical convergence, content-free invalidation, stale acknowledgement/archive retries after refresh failures with and without notification, peer focus",
  );
}
