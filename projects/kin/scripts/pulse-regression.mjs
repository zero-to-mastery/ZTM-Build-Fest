import assert from "node:assert/strict";

// Runs only against the regression runner's isolated synthetic database.
export async function pulseRegressions() {
  const app = document.querySelector("kin-app"),
    pulse = app.pulse;
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const idle = async () => {
    for (let i = 0; app.busy && i < 300; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy, "Pulse must settle");
  };
  const count = async () => (await app.store.loadEvents()).length;
  const initial = await count();
  const others = JSON.stringify([
    app.state.items,
    app.state.handoffs,
    app.state.talks,
  ]);
  check(pulse.durationSelect.value === "4", "default duration");
  check(
    [...pulse.valueSelect.options].map((o) => o.text).join("|") ===
      "Good|Okay|Drained|Rough day|Need quiet",
    "fixed named values",
  );
  check(pulse.querySelector("h2").textContent === "Pulse", "Pulse heading");
  pulse.valueSelect.value = "drained";
  pulse.form.requestSubmit();
  await idle();
  let current = app.state.pulses[0];
  check(
    current.value === "drained" && current.status === "active",
    "SET active",
  );
  check(
    current.expiresAt - current.setAt === 4 * 3600000,
    "one timestamp snapshot",
  );
  check(
    pulse.current.textContent === "Drained" &&
      pulse.until.textContent.startsWith("Until "),
    "current presentation",
  );
  check(document.activeElement === pulse.changeButton, "set focus");
  pulse.changeButton.click();
  check(
    pulse.valueSelect.value === "drained",
    "Change starts from current capacity",
  );
  pulse.valueSelect.value = "need-quiet";
  pulse.durationSelect.value = "1";
  pulse.form.requestSubmit();
  await idle();
  check(
    app.state.pulses.length === 1 && app.state.pulses[0].value === "need-quiet",
    "replacement",
  );
  check(
    JSON.stringify([app.state.items, app.state.handoffs, app.state.talks]) ===
      others,
    "Pulse cannot change other features",
  );
  await app.refreshFromEvents();
  check(app.state.pulses[0].value === "need-quiet", "canonical reload");
  pulse.clearButton.click();
  await idle();
  await app.savePulse({ type: "clear-pulse" });
  check(
    app.state.pulses.length === 0 &&
      pulse.current.textContent === "No current pulse.",
    "repeated clear",
  );
  check((await count()) === initial + 4, "only intent events");

  const originalAdd = IDBObjectStore.prototype.add;
  const timestamp = Date.now();
  const command = {
    type: "set-pulse",
    value: "rough-day",
    timestamp,
    expiresAt: timestamp + 3600000,
  };
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === "events")
      throw new DOMException("Synthetic quota", "QuotaExceededError");
    return originalAdd.apply(this, args);
  };
  try {
    await app.savePulse(command);
  } finally {
    IDBObjectStore.prototype.add = originalAdd;
  }
  check(
    !app.retryButton.hidden && app.state.pulses.length === 0,
    "SET failure retains prior state and retry",
  );
  pulse.valueSelect.value = "good";
  const retry = app.retryAction,
    load = app.store.getCatchUpState.bind(app.store);
  app.store.getCatchUpState = async () => {
    throw new Error("Synthetic refresh");
  };
  try {
    await app.refreshFromEvents();
    await app.refreshFromEvents();
  } finally {
    app.store.getCatchUpState = load;
  }
  await app.retryAction();
  check(
    app.retryAction === retry && (await count()) === initial + 4,
    "refresh recovers original retry without append",
  );
  app.retryButton.click();
  app.retryButton.click();
  await idle();
  current = app.state.pulses[0];
  check(
    current.value === "rough-day" &&
      current.expiresAt === command.expiresAt &&
      current.setAt === timestamp,
    "original SET retry",
  );
  check((await count()) === initial + 5, "rapid retry appends once");
  await app.savePulse({ type: "clear-pulse" });

  // Advisory timer calls Rust; no expiry event is appended.
  const now = Date.now();
  await app.savePulse({
    type: "set-pulse",
    value: "okay",
    timestamp: now,
    expiresAt: now + 180,
  });
  const beforeExpiry = await count();
  for (let i = 0; app.state.pulses[0].status !== "expired" && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  await idle();
  check(
    app.state.pulses[0].status === "expired" &&
      pulse.current.textContent === "No current pulse.",
    "timer reprojects expiry",
  );
  check((await count()) === beforeExpiry, "expiry appends nothing");
  await app.savePulse({ type: "clear-pulse" });
  check(
    app.store.database.version === 3,
    "sync stores are additive to the event schema",
  );
  return "PASS Pulse fixed values, actor projection, set/replace/clear, timer expiry, original retry and repeated refresh recovery";
}

export async function pulsePeerRegressions(first, second, until, unlockReady) {
  await first.evaluate(
    `(async()=>{const a=document.querySelector('kin-app');const timestamp=Date.now();await a.savePulse({type:'set-pulse',value:'drained',timestamp,expiresAt:timestamp+3600000});})()`,
  );
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.pulses[0]?.value==='drained'`,
    ),
  );
  await second.send("Page.reload");
  await unlockReady(second);
  await until(() =>
    second.evaluate(
      `!!document.querySelector('kin-app')?.store && !document.querySelector('kin-app').busy`,
    ),
  );
  assert.equal(
    await second.evaluate(
      `document.querySelector('kin-app').pulse.current.textContent`,
    ),
    "Drained",
  );
  await first.evaluate(
    `document.querySelector('kin-app').savePulse({type:'clear-pulse'})`,
  );
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.pulses.length===0`,
    ),
  );
  assert.equal(
    await second.evaluate(
      `document.querySelector('kin-app').pulse.current.textContent`,
    ),
    "No current pulse.",
  );
  await second.evaluate(`document.querySelector('kin-app').closePeerChannel()`);
  await first.evaluate(
    `(async()=>{const a=document.querySelector('kin-app');const timestamp=Date.now();await a.savePulse({type:'set-pulse',value:'need-quiet',timestamp,expiresAt:timestamp+3600000});})()`,
  );
  assert.equal(
    await second.evaluate(
      `document.querySelector('kin-app').state.pulses.length`,
    ),
    0,
    "missed invalidation leaves old view until lifecycle refresh",
  );
  await second.send("Page.bringToFront");
  await second.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.pulses[0]?.value==='need-quiet'`,
    ),
  );
  await first.evaluate(
    `document.querySelector('kin-app').savePulse({type:'clear-pulse'})`,
  );
  await second.evaluate(
    `document.dispatchEvent(new Event('visibilitychange'))`,
  );
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.pulses.length===0`,
    ),
  );
  await second.evaluate(`document.querySelector('kin-app').openPeerChannel()`);
  console.log(
    "PASS Pulse cross-tab SET/CLEAR, reload and missed invalidation recovered by focus/visibility",
  );
}

export async function pulseResilienceRegressions() {
  const app = document.querySelector("kin-app"),
    pulse = app.pulse;
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const idle = async () => {
    for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh) && i < 300; i++) await pause(10);
    check(!app.busy, "Pulse operation settled");
  };
  const count = async () => (await app.store.loadEvents()).length;
  const originalNow = Date.now;
  const base = originalNow();
  let clock = base;
  Date.now = () => clock;
  try {
    await app.savePulse({
      type: "set-pulse",
      value: "good",
      timestamp: base,
      expiresAt: base + 1000,
    });
    const events = await count();
    clearTimeout(app.pulseTimer); // Simulate a sleeping tab missing its scheduled wake.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    clock = base + 2000;
    document.dispatchEvent(new Event("visibilitychange"));
    await pause(20);
    check(
      app.state.pulses[0].status === "active",
      "hidden timer is advisory, no JS expiry mutation",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    for (let i = 0; app.state.pulses[0].status !== "expired" && i < 300; i++) await pause(10);
    await idle();
    check(
      app.state.pulses[0].status === "expired",
      "visibility return catches late expiry",
    );
    clock = base;
    window.dispatchEvent(new Event("focus"));
    await pause(180);
    await idle();
    check(
      app.state.pulses[0].status === "active",
      "focus with backward wall clock reprojects",
    );
    pulse.changeButton.focus();
    clock = base + 3000;
    await app.onTimeWake();
    await idle();
    check(
      document.activeElement === pulse.valueSelect,
      "expiry restores focus from hidden active control",
    );
    check(
      app.state.pulses[0].status === "expired",
      "late timer reprojects forward clock",
    );
    check(
      (await count()) === events,
      "clock and lifecycle changes never append",
    );
  } finally {
    Date.now = originalNow;
    delete document.visibilityState;
  }
  await app.savePulse({ type: "clear-pulse" });

  const originalAdd = IDBObjectStore.prototype.add;
  for (const type of ["set-pulse", "clear-pulse"])
    for (const mode of ["quota", "abort"]) {
      if (type === "clear-pulse") {
        const timestamp = Date.now();
        await app.savePulse({
          type: "set-pulse",
          value: "okay",
          timestamp,
          expiresAt: timestamp + 3600000,
        });
      }
      const before = await count(),
        counter = (await app.store.ensureContext()).next_logical_time;
      const beforeState = JSON.stringify(app.state.pulses),
        timestamp = Date.now();
      const command =
        type === "set-pulse"
          ? {
              type,
              value: "drained",
              timestamp,
              expiresAt: timestamp + 3600000,
            }
          : { type };
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name !== "events") return originalAdd.apply(this, args);
        if (mode === "quota")
          throw new DOMException("Synthetic quota", "QuotaExceededError");
        const request = originalAdd.apply(this, args);
        request.addEventListener("success", () => this.transaction.abort());
        return request;
      };
      try {
        await app.savePulse(command);
      } finally {
        IDBObjectStore.prototype.add = originalAdd;
      }
      check(
        (await count()) === before &&
          (await app.store.ensureContext()).next_logical_time === counter,
        "Pulse rollback event and counter",
      );
      check(
        JSON.stringify(app.state.pulses) === beforeState,
        "failed Pulse preserves projection",
      );
      check(
        !app.alert.hidden && app.alert.getAttribute("role") === "alert",
        "assertive failure",
      );
      const originalRetry = app.retryAction,
        load = app.store.getCatchUpState.bind(app.store);
      app.store.getCatchUpState = async () => {
        throw new Error("Synthetic refresh");
      };
      try {
        await app.refreshFromEvents();
        await app.refreshFromEvents();
      } finally {
        app.store.getCatchUpState = load;
      }
      await app.retryAction();
      check(
        app.retryAction === originalRetry,
        "original SET/CLEAR retry survives refresh failures",
      );
      app.retryButton.click();
      app.retryButton.click();
      await idle();
      check(
        (await count()) === before + 1 &&
          (await app.store.ensureContext()).next_logical_time === counter + 1n,
        "retry exactly once",
      );
      if (type === "set-pulse")
        check(
          app.state.pulses[0].expiresAt === command.expiresAt,
          "retry cannot extend original expiry",
        );
    }
  // A deliberate newer SET supersedes a suspended failed SET.
  const timestamp = Date.now(),
    old = {
      type: "set-pulse",
      value: "rough-day",
      timestamp,
      expiresAt: timestamp + 3600000,
    };
  const append = app.store.append.bind(app.store);
  app.store.append = async () => {
    throw new Error("Synthetic append");
  };
  try {
    await app.savePulse(old);
  } finally {
    app.store.append = append;
  }
  const load = app.store.getCatchUpState.bind(app.store);
  app.store.getCatchUpState = async () => {
    throw new Error("Synthetic refresh");
  };
  try {
    await app.refreshFromEvents();
  } finally {
    app.store.getCatchUpState = load;
  }
  await app.savePulse({ ...old, value: "need-quiet" });
  check(
    app.retryAction === null &&
      app.suspendedRetry === null &&
      app.state.pulses[0].value === "need-quiet",
    "new SET supersedes suspended retry",
  );
  await app.savePulse({ type: "clear-pulse" });

  // Pending persistence remains busy through timer and repeated intents.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  app.store.append = async (...args) => {
    await gate;
    return append(...args);
  };
  const before = await count();
  const pending = app.savePulse({ ...old, value: "good" });
  check(
    app.busy &&
      [...pulse.querySelectorAll("button,select")].every((c) => c.disabled),
    "all Pulse controls busy",
  );
  check(app.busy, "pending save remains busy");
  await app.onTimeWake();
  await app.savePulse({ ...old, value: "drained" });
  await app.savePulse({ type: "clear-pulse" });
  release();
  await pending;
  app.store.append = append;
  await idle();
  check(
    (await count()) === before + 1 && app.state.pulses[0].value === "good",
    "rapid intents append once while busy",
  );
  pulse.changeButton.click();
  pulse.valueSelect.value = "rough-day";
  pulse.durationSelect.value = "8";
  pulse.valueSelect.focus();
  await app.refreshFromEvents();
  check(
    pulse.valueSelect.value === "rough-day" &&
      pulse.durationSelect.value === "8",
    "refresh preserves selections",
  );
  check(
    document.activeElement === pulse.valueSelect,
    "refresh preserves Pulse focus",
  );
  check(app.status.getAttribute("aria-live") === "polite", "polite success");
  await app.savePulse({ type: "clear-pulse" });
  return "PASS Pulse sleep/wake, focus, forward/backward clock, late timer, SET/CLEAR quota/abort recovery, supersession, rapid intents and busy isolation";
}

export async function pulseKeyboardRegressions(client, until) {
  const key = async (key, code, number, text) => {
    for (const type of ["keyDown", "keyUp"])
      await client.send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: number,
        ...(type === "keyDown" && text ? { text } : {}),
      });
  };
  const idle = () =>
    until(() => client.evaluate(`!document.querySelector('kin-app').busy`));
  await client.evaluate(
    `(()=>{const p=document.querySelector('kin-app').pulse;p.valueSelect.focus();p.scrollIntoView();})()`,
  );
  await key("ArrowDown", "ArrowDown", 40);
  await key("Tab", "Tab", 9);
  assert.equal(
    await client.evaluate(
      `document.activeElement===document.querySelector('kin-app').pulse.durationSelect`,
    ),
    true,
  );
  await key("Tab", "Tab", 9);
  assert.equal(
    await client.evaluate(
      `document.activeElement===document.querySelector('kin-app').pulse.setButton`,
    ),
    true,
  );
  await key("Enter", "Enter", 13, "\r");
  await idle();
  assert.equal(
    await client.evaluate(
      `document.activeElement===document.querySelector('kin-app').pulse.changeButton`,
    ),
    true,
  );
  await key("Enter", "Enter", 13, "\r");
  assert.equal(
    await client.evaluate(
      `document.activeElement===document.querySelector('kin-app').pulse.valueSelect`,
    ),
    true,
  );
  // Native Tab order through duration, Set and Clear while changing.
  for (let i = 0; i < 3; i++) await key("Tab", "Tab", 9);
  assert.equal(
    await client.evaluate(
      `document.activeElement===document.querySelector('kin-app').pulse.clearButton`,
    ),
    true,
  );
  await key("Enter", "Enter", 13, "\r");
  await idle();
  assert.equal(
    await client.evaluate(
      `document.querySelector('kin-app').state.pulses.length`,
    ),
    0,
  );
  assert.equal(
    await client.evaluate(
      `document.activeElement===document.querySelector('kin-app').pulse.valueSelect`,
    ),
    true,
  );
  console.log("PASS Pulse native keyboard set/change/clear and focus order");
}
