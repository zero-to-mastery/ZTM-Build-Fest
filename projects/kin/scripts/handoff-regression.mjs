import assert from "node:assert/strict";

// Serialized into the isolated browser; all fixtures are synthetic.
export async function handoffRegressions() {
  const app = document.querySelector("kin-app");
  const capture = app.handoffs;
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const idle = async () => {
    for (let i = 0; app.busy && i < 300; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy, "Handoff operation must settle");
  };
  const count = async () => (await app.store.loadEvents()).length;
  const edit = (text) => {
    capture.input.value = text;
    capture.saveDraft();
  };
  const submit = async () => {
    capture.querySelector("form").requestSubmit();
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
    capture.querySelector(".completed-label").textContent === "Acknowledged",
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
  check(
    !app.retryButton.hidden && capture.input.value === "Original handoff",
    "failed add retains draft/retry",
  );
  edit("Newer handoff draft");
  const originalRetry = app.retryAction;
  const originalMessage = app.alert.textContent;
  const getCatchUpState = app.store.getCatchUpState.bind(app.store);
  app.store.getCatchUpState = async () => {
    throw new Error("Synthetic refresh failure");
  };
  try {
    await app.refreshFromEvents();
    await app.refreshFromEvents();
    check(
      app.retryAction === app.retryRefresh,
      "failed refresh offers refresh recovery first",
    );
  } finally {
    app.store.getCatchUpState = getCatchUpState;
  }
  await app.retryAction();
  check(
    app.retryAction === originalRetry &&
      app.alert.textContent === originalMessage,
    "recovered refresh restores original failed Handoff command",
  );
  check(
    (await count()) === before + 3,
    "refresh recovery must not append automatically",
  );
  app.retryButton.click();
  app.retryButton.click();
  await idle();
  check(
    (await count()) === before + 4 &&
      app.state.handoffs.at(-1).text === "Original handoff",
    "retry original exactly once",
  );
  check(
    capture.input.value === "Newer handoff draft",
    "older retry preserves newer text",
  );
  for (const mode of ["quota", "abort"]) {
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
      await app.handleAddHandoff({
        detail: { text: "Atomic handoff " + mode },
      });
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }
    check(
      (await count()) === eventCount &&
        (await app.store.ensureContext()).next_logical_time === counter,
      "Handoff event/counter rollback",
    );
    app.retryButton.click();
    app.retryButton.click();
    await idle();
    check(
      (await count()) === eventCount + 1 &&
        (await app.store.ensureContext()).next_logical_time === counter + 1n,
      "Handoff event/counter exactly once",
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
  edit("Delayed handoff");
  const pending = app.handleAddHandoff({
    detail: { text: capture.input.value },
  });
  check(
    [...app.main.querySelectorAll("input,select,button")].every(
      (control) => control.disabled,
    ),
    "all controls disabled during Handoff save",
  );
  check(app.busy, "Handoff pending save retains busy state");
  edit("Newer handoff draft");
  app.handlePeerMessage({ data: { type: "events-changed" } });
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
      await app.handleHandoffAction(type, target);
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }
    check(
      (await count()) === beforeAction && !app.retryButton.hidden,
      "failed Handoff action keeps retry",
    );
    check(
      document.activeElement === capture.input &&
        app.alert.getAttribute("role") === "alert",
      "action error focus/announcement",
    );
    const actionRetry = app.retryAction;
    app.store.getCatchUpState = async () => {
      throw new Error("Synthetic action refresh failure");
    };
    try {
      await app.refreshFromEvents();
      await app.refreshFromEvents();
    } finally {
      app.store.getCatchUpState = getCatchUpState;
    }
    await app.retryAction();
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
    await app.handleAddHandoff({ detail: { text: "Superseded retry" } });
  } finally {
    app.store.append = realAppend;
  }
  app.store.getCatchUpState = async () => {
    throw new Error("Synthetic refresh failure");
  };
  try {
    await app.refreshFromEvents();
  } finally {
    app.store.getCatchUpState = getCatchUpState;
  }
  await app.handleAddHandoff({
    detail: { text: "New command after refresh failure" },
  });
  await app.refreshFromEvents();
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
    app.store.database.version === 3,
    "encrypted stores retain canonical event compatibility",
  );
  return "PASS Handoff add/acknowledge/archive, tombstones, invalid references, inert Unicode, retry draft ownership and mixed replay";
}

export async function handoffPeerRegressions(first, second, until) {
  await first.evaluate(
    `document.querySelector('kin-app').handleAddHandoff({detail:{text:'Peer Handoff'}})`,
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
    try { await app.handleHandoffAction('acknowledge-handoff',record.handoffId); }
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
    return app.handleHandoffAction('archive-handoff',app.state.handoffs.find(row=>row.text==='Peer Handoff').handoffId);
  })()`);
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.handoffs.find(row=>row.text==='Peer Handoff')?.status==='archived' && document.querySelector('kin-app').retryButton.hidden`,
    ),
  );
  for (const action of ["acknowledge-handoff", "archive-handoff"]) {
    const id = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      await app.handleAddHandoff({detail:{text:'Missed Handoff invalidation'}});
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
      try { await app.handleHandoffAction('${action}','${id}'); }
      finally { IDBObjectStore.prototype.add=original; }
    })()`);
    await second.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      const load=app.store.getCatchUpState.bind(app.store);
      app.store.getCatchUpState=async()=>{throw new Error('Synthetic refresh failure');};
      try { await app.refreshFromEvents(); await app.refreshFromEvents(); }
      finally { app.store.getCatchUpState=load; }
    })()`);
    const count = await first.evaluate(
      '(async()=>(await document.querySelector("kin-app").store.loadEvents()).length)()',
    );
    await first.evaluate(
      `document.querySelector('kin-app').handleHandoffAction('archive-handoff','${id}')`,
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
    "document.querySelector('kin-app').handleAddHandoff({detail:{text:'Focus refresh Handoff'}})",
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
