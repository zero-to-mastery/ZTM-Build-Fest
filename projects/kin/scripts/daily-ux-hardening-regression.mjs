import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import assert from "node:assert/strict";

// Daily UX hardening (PR 07): session-lifecycle, offline, accessibility and
// responsive regressions that cut across Quick add, Today, the palette, bulk
// actions and repeating tasks, plus repeated performance samples. Runs on
// the real encrypted store and WASM engine; see docs/DAILY-UX-HARDENING.md.
export async function dailyUxHardeningRegressions(client, { visit, ready, tab: openTab }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  const metrics = [];
  const check = (condition, message, detail = null) => { assert.ok(condition, `${message}${detail !== null ? ` ${JSON.stringify(detail)}` : ""}`); passed.push(message); };
  const until = async (fn, label, ...args) => {
    for (let index = 0; index < 400; index++) {
      const value = await page(fn, ...args);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Daily UX hardening timed out: ${label}`);
  };
  const settle = () => page(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  const idle = () => until(() => { const app = document.querySelector("kin-app"); return Boolean(app?.state) && !app.busy && !app.bulkRunning && !app.refreshing && !app.pendingRefresh && !app.wakePending; }, "idle");
  const KEYS = {
    escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    n: { key: "n", code: "KeyN", windowsVirtualKeyCode: 78, text: "n" },
    k: { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 },
  };
  const press = async (spec) => {
    const { text, ...rest } = spec;
    await client.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...rest, ...(text ? { text, unmodifiedText: text } : {}) });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...rest });
    await settle();
  };
  const viewport = async (width, height, mobile) => {
    await setViewport(client, { width, height, deviceScaleFactor: 1, mobile });
    await settle();
  };
  const network = async (offline) => {
    await client.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page((offline) => window.dispatchEvent(new Event(offline ? "offline" : "online")), offline);
  };
  // Quick add through its own dialog and form, as a user would submit it.
  const quickAdd = (title) => page((title) => {
    const app = document.querySelector("kin-app"), q = app.quickAdd;
    if (!q.dialog.open) q.trigger.click();
    q.input.value = title;
    q.input.dispatchEvent(new Event("input", { bubbles: true }));
    q.form.requestSubmit();
    return q.dialog.open || app.busy;
  }, title);
  const copies = (title) => page((title) => document.querySelector("kin-app").state.items.filter((item) => item.text === title).length, title);
  const lockAndSettle = () => page(async () => {
    const app = document.querySelector("kin-app");
    app.ctx.session.lockHousehold();
    await app.lockBarrier;
  });
  const unlock = async () => { await ready(client); await idle(); };
  // Every IndexedDB record, Web Storage entry and Cache Storage response the
  // origin holds, searched for a decrypted title as text or UTF-8 bytes.
  const plaintextAtRest = (needle) => page(async (needle) => {
    const bytes = new TextEncoder().encode(needle);
    const hasBytes = (view) => {
      outer: for (let i = 0; i + bytes.length <= view.length; i++) {
        for (let j = 0; j < bytes.length; j++) if (view[i + j] !== bytes[j]) continue outer;
        return true;
      }
      return false;
    };
    const seen = new Set();
    const scan = (value) => {
      if (value == null || seen.has(value)) return false;
      if (typeof value === "string") return value.includes(needle);
      if (typeof value !== "object") return false;
      seen.add(value);
      if (value instanceof ArrayBuffer) return hasBytes(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return hasBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      if (value instanceof Blob) return false;
      return Object.values(value).some(scan) || (value instanceof Map && [...value.values()].some(scan));
    };
    const found = [];
    for (const { name } of await indexedDB.databases()) {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        for (const store of database.objectStoreNames) {
          const rows = await new Promise((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          if (scan(rows)) found.push(`idb:${name}/${store}`);
        }
      } finally { database.close(); }
    }
    for (const [label, storage] of [["local", localStorage], ["session", sessionStorage]])
      for (let i = 0; i < storage.length; i++) if (scan(storage.getItem(storage.key(i)))) found.push(`${label}:${storage.key(i)}`);
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith("/api/")) found.push(`cache-api:${request.url}`);
        if ((await (await cache.match(request)).text()).includes(needle)) found.push(`cache:${request.url}`);
      }
    }
    return found;
  }, needle);
  const stats = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    return { n: sorted.length, median: Number(at(0.5).toFixed(2)), p95: Number(at(0.95).toFixed(2)), max: Number(sorted.at(-1).toFixed(2)) };
  };
  const stamp = (await page(() => crypto.randomUUID())).slice(0, 6);

  try {
    await page(async () => {
      const app = document.querySelector("kin-app");
      if ((app.state.mode ?? "normal") !== "normal") await app.ctx.append.appendCommand({ type: "set-household-mode", mode: "normal" });
    });
    await viewport(1280, 900, false);
    await visit("today");
    await idle();

    // --- Example 1: offline Quick add survives a reload exactly once -------
    const offlineTitle = `Offline capture ${stamp}`;
    await network(true);
    await quickAdd(offlineTitle);
    await idle();
    check(await copies(offlineTitle) === 1, "offline Quick add commits exactly one task to the local encrypted store");
    check((await plaintextAtRest(offlineTitle)).length === 0, "the offline task's title is not readable in IndexedDB, Web Storage or Cache Storage, and no API response is cached", await plaintextAtRest(offlineTitle));
    // Reload through the shell, then unlock and replay with the network off
    // (offline shell delivery itself is covered by the security UI suite).
    await network(false);
    await client.send("Page.reload");
    await until(() => Boolean(document.querySelector("kin-app")?.security?.heading), "reloaded shell");
    await network(true);
    await unlock();
    await visit("today");
    const afterReload = await page((title) => {
      const app = document.querySelector("kin-app");
      const item = app.state.items.find((entry) => entry.text === title);
      return { copies: app.state.items.filter((entry) => entry.text === title).length, today: item?.planningDate === app.ctx.navigation.currentCivilDate(), shown: [...app.today.querySelectorAll("kin-item")].filter((node) => node.record?.text === title).length };
    }, offlineTitle);
    check(afterReload.copies === 1 && afterReload.today && afterReload.shown === 1,
      "after an offline reload and local unlock the task replays once, still planned for today, with one Today row", afterReload);
    await network(false);

    // --- Example 3: lock while Quick add's local write is pending ----------
    const pendingTitle = `Locked mid-save ${stamp}`;
    await page((title) => {
      const app = document.querySelector("kin-app"), store = app.store, original = store.append;
      window.__gate = { reached: false };
      const gate = new Promise((resolve) => { window.__gate.release = resolve; });
      store.append = async (command, engine) => {
        if (command.type !== "add" || command.text !== title) return original.call(store, command, engine);
        window.__gate.reached = true;
        await gate;
        try { return await original.call(store, command, engine); } finally { window.__gate.settled = true; }
      };
    }, pendingTitle);
    await quickAdd(pendingTitle);
    await until(() => window.__gate.reached, "quick add write pending");
    await lockAndSettle();
    await page(() => window.__gate.release());
    await until(() => window.__gate.settled, "held Quick add write settled");
    await settle();
    const lockedView = await page((title) => {
      const app = document.querySelector("kin-app");
      return {
        leaked: document.body.innerText.includes(title) || document.title.includes(title),
        status: app.status.textContent, alert: app.alert.textContent,
        quickAddOpen: app.quickAdd.dialog.open, draft: app.quickAdd.input.value,
        openDialogs: document.querySelectorAll("dialog[open]").length,
      };
    }, pendingTitle);
    check(!lockedView.leaked && lockedView.status === "Household locked." && !lockedView.alert && !lockedView.quickAddOpen && !lockedView.draft && lockedView.openDialogs === 0,
      "a Quick add write settling after lock cannot reveal its title, announce success, raise an alert or reopen the dialog", lockedView);
    await unlock();
    const afterPending = await page(async (title) => {
      const app = document.querySelector("kin-app");
      const stored = (await app.store.loadEvents()).length;
      return { copies: app.state.items.filter((item) => item.text === title).length, stored, recovery: app.quickAdd.recoveryVisible, pending: app.pendingCapture };
    }, pendingTitle);
    check(afterPending.copies <= 1 && !afterPending.recovery && afterPending.pending === null,
      "unlocking rebuilds from the encrypted store: the interrupted task exists at most once and no stale recovery prompt appears", afterPending);

    // --- Schedule change interrupted by lock, finished after unlock --------
    const routineTitle = `Water plants ${stamp}`;
    const originalId = await page(async (text) => {
      const app = document.querySelector("kin-app");
      const routineId = crypto.randomUUID().replaceAll("-", "");
      await app.ctx.append.appendCommand({ type: "create-routine", routineId, text, cadence: "daily" });
      await app.ctx.refresh.refreshFromEvents();
      return routineId;
    }, routineTitle);
    await idle();
    await page((routineId) => {
      const app = document.querySelector("kin-app"), store = app.store, original = store.append;
      window.__gate = { reached: false };
      const gate = new Promise((resolve) => { window.__gate.release = resolve; });
      // The archive step is held, then lost to the lock: the replacement is
      // durable but the original still repeats.
      store.append = async (command, engine) => {
        if (command.type === "archive-routine" && command.routineId === routineId) {
          window.__gate.reached = true;
          await gate;
          window.__gate.settled = true;
          throw Object.assign(new Error("Kin was locked or reopened during the operation."), { code: "locked" });
        }
        return original.call(store, command, engine);
      };
      void app.ctx.routines.changeRoutineSchedule({ routineId, cadence: "weekly" });
    }, originalId);
    await until(() => window.__gate.reached, "schedule change archive pending");
    await lockAndSettle();
    await page(() => window.__gate.release());
    await until(() => window.__gate.settled, "held archive step settled");
    await settle();
    await unlock();
    const interrupted = await page((text) => document.querySelector("kin-app").state.routines.filter((routine) => routine.text === text).map((routine) => ({ id: routine.routineId, cadence: routine.cadence, status: routine.status })), routineTitle);
    check(interrupted.length === 2 && interrupted.filter((routine) => routine.status !== "archived").length === 2,
      "a lock between the schedule-change steps leaves the durable replacement and the still-repeating original", interrupted);
    await page((routineId) => document.querySelector("kin-app").ctx.routines.changeRoutineSchedule({ routineId, cadence: "weekly" }), originalId);
    await idle();
    const resumed = await page((text) => document.querySelector("kin-app").state.routines.filter((routine) => routine.text === text).map((routine) => ({ id: routine.routineId, cadence: routine.cadence, status: routine.status })), routineTitle);
    const active = resumed.filter((routine) => routine.status !== "archived");
    check(resumed.length === 2 && active.length === 1 && active[0].cadence === "weekly" && resumed.find((routine) => routine.id === originalId)?.status === "archived",
      "retrying the same schedule after unlock resumes the half-saved change: one weekly replacement, the original stopped, no second replacement", resumed);
    const replacementId = active[0].id;

    // --- Local reminders: a lock suspends them, unlocking resumes them -----
    // Notifications go to a recording fake. A lock keeps only { id, at,
    // vaultId }; unlocking the same vault re-arms each reminder from the fresh
    // record's title. Logout and a different vault end them.
    await page(() => {
      const app = document.querySelector("kin-app");
      window.__notifications = [];
      window.__permission = { value: "granted", resolvers: [] };
      class FakeNotification {
        constructor(title) { window.__notifications.push({ title, at: Date.now() }); }
        static get permission() { return window.__permission.value; }
        static requestPermission() { return new Promise((resolve) => { window.__permission.resolvers.push(resolve); }); }
      }
      window.__realNotification = app.localReminders.notification;
      app.localReminders.notification = FakeNotification;
    });
    const remind = (id, title, inMs) => page(async (id, title, inMs) => {
      const at = Date.now() + inMs;
      await document.querySelector("kin-app").ctx.records.handleLocalReminder({ id, title, at });
      return at;
    }, id, title, inMs);
    const reminders = (id, title) => page((id, title) => {
      const app = document.querySelector("kin-app"), local = app.localReminders;
      const suspended = [...(local.suspended?.values() ?? [])];
      return {
        fired: window.__notifications.length, live: local.entries.get(id)?.at ?? null,
        listed: app.routines.reminderMap?.get(id)?.at ?? null, shown: app.routines.reminderControls?.get(id)?.current?.at ?? null,
        rowText: app.routines.reminderControls?.get(id)?.textContent.includes("Reminds") ?? false, suspended,
        titleHeld: JSON.stringify(suspended).includes(title) || suspended.some((entry) => Object.keys(entry).sort().join() !== "at,id,vaultId"),
        vaultId: app.vault?.vaultId ?? null,
      };
    }, id, title);
    const clockPast = (at) => until((at) => Date.now() > at, "clock past due time", at);
    const routineReminder = `routine:${replacementId}`;

    await remind(routineReminder, routineTitle, 150);
    await until(() => window.__notifications.length === 1, "unlocked routine reminder fires");
    check(true, "control: an unlocked routine reminder notifies once");

    // A future reminder survives lock and unlock and fires at its time.
    // The reminder's timers are held until the re-arm check has read it
    // (#469): lock, unlock and two visits can outlast its 3 s on a slow
    // runner, and a timer that fires first deletes the entry the check reads.
    // Held timers run on release, and tick() re-arms any that are not yet
    // due, so the reminder still fires no earlier than its time.
    const holdReminderTimers = (hold) => page((hold) => {
      const local = document.querySelector("kin-app").localReminders;
      if (hold) {
        window.__heldReminders = { setTimer: local.setTimer, queued: [] };
        local.setTimer = (fn) => { window.__heldReminders.queued.push(fn); return null; };
        return;
      }
      const { setTimer, queued } = window.__heldReminders;
      local.setTimer = setTimer;
      delete window.__heldReminders;
      for (const fn of queued) setTimer(fn, 0);
    }, hold);
    const vaultBefore = await page(() => document.querySelector("kin-app").vault.vaultId);
    await holdReminderTimers(true);
    let due = await remind(routineReminder, routineTitle, 3000);
    await visit("routines");
    const beforeLock = await reminders(routineReminder, routineTitle);
    check(beforeLock.shown === due && beforeLock.rowText, "before the lock, the routine's row shows its reminder", beforeLock);
    await lockAndSettle();
    let state = await reminders(routineReminder, routineTitle);
    check(state.live === null && state.suspended.length === 1 && state.suspended[0].at === due && state.suspended[0].vaultId === vaultBefore && !state.titleHeld && state.fired === 1,
      "a lock suspends the reminder as { id, at, vaultId } only: no timer, no title, no closure", state);
    await unlock();
    await visit("routines");
    state = await reminders(routineReminder, routineTitle);
    check(state.live === due && state.listed === due && state.shown === beforeLock.shown && state.rowText && state.suspended.length === 0,
      "unlocking the same vault re-arms the reminder and its Routines row shows it again at its original time", state);
    await holdReminderTimers(false);
    await until(() => window.__notifications.length === 2, "resumed reminder fires");
    const resumedFire = await page(() => window.__notifications.at(-1));
    check(resumedFire.title === routineTitle && resumedFire.at >= due, "the resumed reminder fires at its time with the current title", { resumedFire, due });

    // A reminder that comes due while locked stays silent, then fires once.
    due = await remind(routineReminder, routineTitle, 300);
    await lockAndSettle();
    await clockPast(due + 200);
    state = await reminders(routineReminder, routineTitle);
    check(state.fired === 2 && state.suspended.length === 1 && !state.titleHeld, "no notification fires while locked, even after the reminder's time passes", state);
    await unlock();
    await until(() => window.__notifications.length === 3, "overdue reminder fires after unlock");
    await settle();
    state = await reminders(routineReminder, routineTitle);
    check(state.fired === 3 && state.live === null && state.suspended.length === 0, "a reminder that came due while locked fires exactly once after unlock", state);

    // The auto-lock path suspends in the same way.
    due = await remind(routineReminder, routineTitle, 2500);
    const autoLocked = await page(async () => {
      const app = document.querySelector("kin-app"), minutes = app.autoLockMinutes;
      app.autoLockMinutes = 5;
      app.lastActivityAt = Date.now() - 5 * 60_000 - 1000;
      await app.onTimeWake();
      app.autoLockMinutes = minutes;
      await app.lockBarrier;
      return { locked: !app.vault, status: app.status.textContent };
    });
    state = await reminders(routineReminder, routineTitle);
    check(autoLocked.locked && autoLocked.status.startsWith("Kin locked after inactivity") && state.suspended.length === 1 && state.live === null && !state.titleHeld,
      "auto-lock after inactivity suspends reminders without keeping titles", { autoLocked, state });
    await unlock();
    await visit("routines");
    state = await reminders(routineReminder, routineTitle);
    check(state.live === due && state.listed === due && state.shown === due, "unlocking after auto-lock restores the reminder and its row shows it", state);
    await until(() => window.__notifications.length === 4, "reminder fires after auto-lock and unlock");

    // Archived from another tab while this one is locked: nothing fires.
    const archivedTitle = `Remind then archive ${stamp}`;
    const archivedId = await page(async (text) => {
      const app = document.querySelector("kin-app"), id = crypto.randomUUID().replaceAll("-", "");
      await app.ctx.append.appendCommand({ type: "add", id, text, classification: "need" });
      await app.ctx.refresh.refreshFromEvents();
      return id;
    }, archivedTitle);
    await idle();
    due = await remind(`item:${archivedId}`, archivedTitle, 1500);
    await lockAndSettle();
    const other = await openTab();
    const archivedStatus = await other.evaluate(`(async () => {
      const app = document.querySelector("kin-app");
      await app.ctx.items.handleItemAction("archive", ${JSON.stringify(archivedId)});
      return app.state.items.find((item) => item.itemId === ${JSON.stringify(archivedId)})?.status;
    })()`);
    check(archivedStatus === "archived", "another tab archives the item while this tab is locked", archivedStatus);
    await other.send("Page.close").catch(() => {});
    other.close();
    await unlock();
    await clockPast(due + 200);
    state = await reminders(`item:${archivedId}`, archivedTitle);
    check(state.live === null && state.suspended.length === 0 && state.fired === 4,
      "after unlock a reminder whose item was archived elsewhere is dropped and never notifies", state);

    // A different vault: entries tagged for another vault are never restored.
    // (One origin holds one vault, so a replaced vault is simulated by tagging.)
    due = await remind(routineReminder, routineTitle, 1500);
    await lockAndSettle();
    await page(() => { for (const entry of document.querySelector("kin-app").localReminders.suspended?.values() ?? []) entry.vaultId = "replaced-vault"; });
    await unlock();
    await clockPast(due + 200);
    state = await reminders(routineReminder, routineTitle);
    check(state.live === null && state.listed === null && !state.shown && state.suspended.length === 0 && state.fired === 4 && state.vaultId !== "replaced-vault",
      "reminders suspended for another vault are discarded on unlock: nothing is listed or fired", state);

    // Logout ends reminders for good.
    due = await remind(routineReminder, routineTitle, 1500);
    await page(async () => {
      const app = document.querySelector("kin-app");
      app.household.dispatchEvent(new CustomEvent("kin:lock", { bubbles: true, composed: true, detail: { endSession: true } }));
      await app.lockBarrier;
    });
    state = await reminders(routineReminder, routineTitle);
    check(state.live === null && state.suspended.length === 0, "logout clears live and suspended reminders", state);
    await unlock();
    await clockPast(due + 200);
    state = await reminders(routineReminder, routineTitle);
    check(state.live === null && state.listed === null && !state.shown && state.suspended.length === 0 && state.fired === 4, "after logout and unlock nothing is restored or fired", state);

    // A permission prompt answered after lock registers and announces nothing.
    await page(() => {
      const app = document.querySelector("kin-app");
      window.__permission.value = "default";
      const item = app.state.items.find((entry) => entry.status === "active");
      window.__late = app.ctx.records.handleLocalReminder({ id: `item:${item.itemId}`, title: item.text, at: Date.now() + 300 });
    });
    await until(() => window.__permission.resolvers.length === 1, "permission prompt open");
    await lockAndSettle();
    await page(async () => { window.__permission.value = "granted"; window.__permission.resolvers.shift()("granted"); await window.__late; });
    const lateGrant = await page(() => {
      const app = document.querySelector("kin-app");
      return { fired: window.__notifications.length, live: app.localReminders.entries.size, suspended: app.localReminders.suspended?.size ?? 0, status: app.status.textContent, alert: app.alert.textContent };
    });
    check(lateGrant.fired === 4 && lateGrant.live === 0 && lateGrant.suspended === 0 && lateGrant.status === "Household locked." && !lateGrant.alert,
      "a permission prompt answered after lock registers no reminder and announces nothing into the locked view", lateGrant);
    await unlock();

    // The stale attempt's cancel cannot remove a newer reminder for the same item.
    const staleTarget = await page(() => {
      const app = document.querySelector("kin-app");
      window.__permission.value = "default";
      const item = app.state.items.find((entry) => entry.status === "active");
      window.__late = app.ctx.records.handleLocalReminder({ id: `item:${item.itemId}`, title: item.text, at: Date.now() + 60_000 });
      return { id: `item:${item.itemId}`, title: item.text };
    });
    await until(() => window.__permission.resolvers.length === 1, "stale permission prompt open");
    await lockAndSettle();
    await unlock();
    await page(() => { window.__permission.value = "granted"; });
    due = await remind(staleTarget.id, staleTarget.title, 2000);
    await page(async () => { window.__permission.resolvers.shift()("granted"); await window.__late; });
    state = await reminders(staleTarget.id, staleTarget.title);
    check(state.live === due, "a permission answer from an expired session leaves the new session's reminder for the same item intact", { state, due });
    await until(() => window.__notifications.length === 5, "new session's reminder fires");
    await page(() => {
      const app = document.querySelector("kin-app");
      app.localReminders.notification = window.__realNotification;
      window.__permission.value = "granted";
    });

    // --- Household appearance refresh settling after lock ------------------
    for (const outcome of ["resolve", "reject"]) {
      await page(() => {
        const app = document.querySelector("kin-app");
        window.__settings = {};
        const pending = new Promise((resolve, reject) => { window.__settings.resolve = resolve; window.__settings.reject = reject; });
        window.__realCoordinator = app.syncCoordinator;
        app.syncCoordinator = { loadHouseholdSettings: () => pending, stop() {} };
        window.__refresh = app.ctx.appearance.refreshHouseholdDefaults();
      });
      await lockAndSettle();
      await page(async (outcome) => {
        if (outcome === "resolve") window.__settings.resolve({ admin: false, adminRecorded: false, value: { name: "Secret Household Name", revision: 1_000_000 } });
        else window.__settings.reject(new Error("Device sync was stopped."));
        await window.__refresh.catch(() => {});
      }, outcome);
      const header = await page(() => {
        const app = document.querySelector("kin-app");
        return { brand: app.brandTitle?.textContent, title: document.title, status: app.status.textContent, leaked: document.body.innerText.includes("Secret Household Name") };
      });
      check(header.brand === "Kin" && !header.title.includes("Secret") && header.status === "Household locked." && !header.leaked,
        `a household settings load that ${outcome}s after lock leaves the locked header and status untouched`, header);
      await unlock();
    }

    // --- Household settings refresh while editing ------------------------
    const draftRefresh = await page(async () => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      const realCoordinator = app.syncCoordinator;
      const baseline = app.householdSettings ?? { version: 1, revision: 0, name: "Our Home", appearance: { mode: "system", colorSource: "manual", seed: "#684033", owner: "household" } };
      editor.initialize({ admin: true, adminRecorded: true, value: baseline });
      editor.nameInput.value = "The Draft House";
      editor.nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      app.syncCoordinator = { loadHouseholdSettings: async () => ({ admin: true, adminRecorded: true, value: structuredClone(baseline) }), stop() {} };
      await app.ctx.appearance.refreshHouseholdDefaults();
      const result = { input: editor.nameInput.value, brand: app.brandTitle.textContent, dirty: editor.dirty };
      editor.restore();
      app.syncCoordinator = realCoordinator;
      return result;
    });
    check(draftRefresh.input === "The Draft House" && draftRefresh.brand === "The Draft House" && draftRefresh.dirty,
      "a sync refresh preserves the household name being edited and its live header preview", draftRefresh);

    const colorDraftRefresh = await page(async () => {
      const app = document.querySelector("kin-app"), editor = app.appearance;
      const realCoordinator = app.syncCoordinator;
      const baseline = app.householdSettings ?? { version: 1, revision: 0, name: "Our Home", appearance: { mode: "system", colorSource: "manual", seed: "#684033", owner: "household" } };
      const forest = editor.presetControls.get("forest");
      forest.checked = true;
      forest.dispatchEvent(new Event("change", { bubbles: true }));
      app.syncCoordinator = { loadHouseholdSettings: async () => ({ admin: true, adminRecorded: true, value: structuredClone(baseline) }), stop() {} };
      await app.ctx.appearance.refreshHouseholdDefaults();
      const result = { draft: editor.draft.seed, applied: app.currentAppearance.seed, dirty: editor.dirty };
      editor.restoreSaved("Changes canceled.");
      app.syncCoordinator = realCoordinator;
      return result;
    });
    check(colorDraftRefresh.draft === "#397052" && colorDraftRefresh.applied === "#397052" && colorDraftRefresh.dirty,
      "a sync refresh preserves an unsaved personal color and its live appearance preview", colorDraftRefresh);

    const partialHexRefresh = await page(async () => {
      const app = document.querySelector("kin-app"), editor = app.appearance;
      const realCoordinator = app.syncCoordinator;
      const baseline = app.householdSettings ?? { version: 1, revision: 0, name: "Our Home", appearance: { mode: "system", colorSource: "manual", seed: "#684033", owner: "household" } };
      editor.hex.focus();
      editor.hex.value = "#3A7";
      editor.hex.dispatchEvent(new Event("input", { bubbles: true }));
      app.syncCoordinator = { loadHouseholdSettings: async () => ({ admin: true, adminRecorded: true, value: structuredClone(baseline) }), stop() {} };
      await app.ctx.appearance.refreshHouseholdDefaults();
      const result = { input: editor.hex.value, invalid: editor.hex.getAttribute("aria-invalid"), dirty: editor.dirty };
      editor.restoreSaved("Changes canceled.");
      app.syncCoordinator = realCoordinator;
      return result;
    });
    check(partialHexRefresh.input === "#3A7" && partialHexRefresh.invalid === "true" && partialHexRefresh.dirty,
      "a sync refresh preserves a partially typed personal hex color", partialHexRefresh);

    const colorKeepsSharedBackground = await page(async () => {
      const app = document.querySelector("kin-app"), editor = app.appearance;
      const originalPersonal = structuredClone(app.personalAppearance);
      const originalHousehold = structuredClone(app.householdSettings);
      const owner = originalPersonal.owner;
      const image = { seed: "#684033", type: "image/webp", width: 24, height: 24, bytes: new Uint8Array([1, 2, 3, 4]) };
      const sharedAppearance = { version: 1, owner: "household", mode: "system", colorSource: "background", seed: image.seed, manual: null, image };
      app.householdSettings = { version: 1, revision: 1, name: "Background Home", appearance: sharedAppearance };
      app.personalAppearance = { version: 2, owner, mode: undefined, colorSource: undefined, seed: undefined, manual: undefined, image: undefined };
      editor.initialize({ ...structuredClone(sharedAppearance), owner });
      const ocean = editor.presetControls.get("ocean");
      ocean.checked = true;
      ocean.dispatchEvent(new Event("change", { bubbles: true }));
      const expectedColor = editor.draft.seed;
      const previewKeptImage = app.currentAppearance.image?.bytes?.length === image.bytes.length;
      editor.form.requestSubmit();
      for (let index = 0; editor.save.disabled && index < 300; index++) await new Promise((resolve) => setTimeout(resolve, 10));
      const result = {
        previewKeptImage,
        storedImageInherited: app.personalAppearance.image === undefined,
        savedColor: app.personalAppearance.seed,
        expectedColor,
        appliedImage: app.currentAppearance.image?.bytes?.length === image.bytes.length,
      };
      app.householdSettings = originalHousehold;
      await app.ctx.appearance.handleUseHouseholdAppearance({ detail: { value: originalPersonal } });
      return result;
    });
    check(colorKeepsSharedBackground.previewKeptImage && colorKeepsSharedBackground.storedImageInherited &&
      colorKeepsSharedBackground.savedColor === colorKeepsSharedBackground.expectedColor && colorKeepsSharedBackground.appliedImage,
    "choosing a personal color keeps the inherited household background in preview and saved state", colorKeepsSharedBackground);

    const resetPinsKinDefaults = await page(async () => {
      const app = document.querySelector("kin-app"), editor = app.appearance;
      const originalPersonal = structuredClone(app.personalAppearance);
      const originalHousehold = structuredClone(app.householdSettings);
      const owner = originalPersonal.owner;
      const kinDefaults = { version: 1, owner, mode: "system", colorSource: "default", seed: "#984D38", manual: null, image: null };
      app.householdSettings = { version: 1, revision: 1, name: "Default Home", appearance: { ...kinDefaults, owner: "household" } };
      app.personalAppearance = { version: 2, owner, mode: undefined, colorSource: undefined, seed: undefined, manual: undefined, image: undefined };
      editor.initialize(kinDefaults);
      editor.reset.click();
      editor.form.requestSubmit();
      for (let index = 0; editor.save.disabled && index < 300; index++) await new Promise((resolve) => setTimeout(resolve, 10));
      const stored = structuredClone(app.personalAppearance);
      app.householdSettings = {
        version: 1, revision: 2, name: "Changed Home",
        appearance: {
          version: 1, owner: "household", mode: "dark", colorSource: "preset", seed: "#397052",
          manual: { source: "preset", name: "Forest", seed: "#397052" },
          image: { seed: "#684033", type: "image/webp", width: 24, height: 24, bytes: new Uint8Array([1, 2, 3, 4]) },
        },
      };
      app.ctx.appearance.applyEffectiveAppearance();
      const result = {
        storedMode: stored.mode, storedColor: stored.colorSource, storedSeed: stored.seed, storedImage: stored.image,
        appliedMode: app.currentAppearance.mode, appliedColor: app.currentAppearance.colorSource,
        appliedSeed: app.currentAppearance.seed, appliedImage: app.currentAppearance.image,
      };
      app.householdSettings = originalHousehold;
      await app.ctx.appearance.handleUseHouseholdAppearance({ detail: { value: originalPersonal } });
      return result;
    });
    check(resetPinsKinDefaults.storedMode === "system" && resetPinsKinDefaults.storedColor === "default" &&
      resetPinsKinDefaults.storedSeed === "#984D38" && resetPinsKinDefaults.storedImage === null &&
      resetPinsKinDefaults.appliedMode === "system" && resetPinsKinDefaults.appliedColor === "default" &&
      resetPinsKinDefaults.appliedSeed === "#984D38" && resetPinsKinDefaults.appliedImage === null,
    "Reset to Kin default stores explicit personal defaults that ignore later household appearance changes", resetPinsKinDefaults);

    const orderedSettings = await page(async () => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      const realCoordinator = app.syncCoordinator;
      const baseline = app.householdSettings ?? { version: 1, revision: 0, name: "Our Home", appearance: { mode: "system", colorSource: "manual", seed: "#684033", owner: "household" } };
      app.householdSettings = baseline;
      editor.initialize({ admin: true, adminRecorded: true, value: baseline });
      const requests = [];
      app.syncCoordinator = { loadHouseholdSettings: () => new Promise((resolve, reject) => requests.push({ resolve, reject })), stop() {} };
      const first = app.ctx.appearance.refreshHouseholdDefaults();
      const second = app.ctx.appearance.refreshHouseholdDefaults();
      const newer = { ...structuredClone(baseline), revision: baseline.revision + 2, name: "Newest Household" };
      requests[1].resolve({ admin: false, adminRecorded: true, value: newer });
      await second;
      requests[0].resolve({ admin: true, adminRecorded: true, value: { ...structuredClone(baseline), revision: baseline.revision + 1, name: "Stale Household" } });
      await first;
      const result = { revision: app.householdSettings.revision, name: app.householdSettings.name, hidden: editor.hidden, admin: editor.admin };
      app.householdSettings = baseline;
      editor.initialize({ admin: true, adminRecorded: true, value: baseline });
      app.ctx.appearance.applyEffectiveAppearance();
      app.syncCoordinator = realCoordinator;
      return result;
    });
    check(orderedSettings.revision >= 2 && orderedSettings.name === "Newest Household" && orderedSettings.hidden && !orderedSettings.admin,
      "an older household-settings response cannot replace newer settings or authority state", orderedSettings);

    // --- Household settings save settling after lock or re-open -----------
    // The real editor and its Save button; the coordinator's save is a
    // deferred promise. Every completion the editor receives is recorded. Lock
    // rebuilds the editor, but a household re-open keeps it, so a stale
    // completion there lands in the new session's editor.
    const SECRET = "Secret Saved Household";
    await page(() => { window.__settingsCoordinator = document.querySelector("kin-app").syncCoordinator ?? null; });
    const startSave = () => page(() => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      window.__save = { calls: [] };
      window.__save.promise = new Promise((resolve, reject) => { window.__save.resolve = resolve; window.__save.reject = reject; });
      app.syncCoordinator = { saveHouseholdSettings: (value) => { window.__save.value = value; return window.__save.promise; }, stop() {} };
      if (!editor.__recording) {
        editor.__recording = true;
        editor.addEventListener("kin:save-household-defaults", (event) => {
          const complete = event.detail.complete;
          event.detail.complete = (saved, error) => { window.__save.calls.push({ saved: saved?.name ?? null, error: error?.message ?? null }); complete(saved, error); };
        });
      }
      if (!editor.admin) editor.initialize({ admin: true, adminRecorded: true, value: null });
      editor.feedback.textContent = "";
      [...editor.querySelectorAll("button")].find((button) => button.textContent === "Save household settings").click();
      return Boolean(window.__save.value);
    });
    // Settles the deferred save, then crosses one task boundary so the app's
    // continuation (and any completion) has run.
    const settleSave = (outcome) => page(async (outcome, secret) => {
      if (outcome === "resolve") window.__save.resolve({ ...window.__save.value, name: secret, revision: window.__save.value.revision + 1 });
      else window.__save.reject(new Error("Shared settings could not be saved."));
      await window.__save.promise.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }, outcome, SECRET);
    const editorView = () => page((secret) => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      return { calls: window.__save.calls, feedback: editor.feedback.textContent, name: editor.nameInput.value, brand: app.brandTitle?.textContent,
        status: app.status.textContent, leaked: document.body.innerText.includes(secret) || editor.nameInput.value === secret || app.householdSettings?.name === secret };
    }, SECRET);

    for (const outcome of ["reject", "resolve"]) {
      check(await startSave(), `settings save (${outcome} after lock) is pending`);
      await lockAndSettle();
      await settleSave(outcome);
      const locked = await editorView();
      check(locked.calls.length === 0 && !locked.feedback && locked.brand === "Kin" && locked.status === "Household locked." && !locked.leaked,
        `a household settings save that ${outcome}s after lock never calls the old editor's completion or changes the locked view`, locked);
      await unlock();
      const reopened = await editorView();
      check(reopened.calls.length === 0 && !reopened.feedback && !reopened.leaked,
        `after unlocking, nothing from the save that settled (${outcome}) after lock reaches the editor`, reopened);
    }

    check(await startSave(), "settings save during a household re-open is pending");
    await page(async () => { const app = document.querySelector("kin-app"); await app.ctx.session.openUnlockedHousehold(app.vault); });
    await idle();
    await settleSave("resolve");
    const replaced = await editorView();
    check(replaced.calls.length === 0 && !replaced.feedback && !replaced.leaked,
      "a save started before the household was re-opened cannot complete into the same editor serving the new session", replaced);

    check(await startSave(), "settings save in a valid session is pending");
    await settleSave("reject");
    const failed = await page(() => {
      const editor = document.querySelector("kin-app").householdDefaults;
      const save = [...editor.querySelectorAll("button")].find((button) => button.textContent === "Save household settings");
      return { calls: window.__save.calls, feedback: editor.feedback.textContent, live: editor.feedback.getAttribute("role"), retry: Boolean(save) && !save.disabled && save.isConnected };
    });
    check(failed.calls.length === 1 && failed.calls[0].error === "Shared settings could not be saved." && failed.feedback === "Shared settings could not be saved." && failed.live === "status" && failed.retry,
      "a save failing in the current session reports its error through the editor's live status and leaves Save available to retry", failed);
    check(await startSave(), "retry dispatches a new save");
    await settleSave("resolve");
    const succeeded = await editorView();
    check(succeeded.calls.length === 1 && succeeded.calls[0].saved === SECRET && succeeded.name === SECRET && succeeded.brand === SECRET &&
      succeeded.feedback.startsWith("Household settings saved."),
      "the retried save succeeds in the current session: completion runs once and the saved name is applied", succeeded);
    await page(() => {
      const editor = document.querySelector("kin-app").householdDefaults;
      editor.nameInput.value = "Pending Local Household";
      editor.nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    check(await startSave(), "settings save before a newer refresh is pending");
    const NEWER = "Newer Remote Household";
    await page((name) => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      const newer = { ...structuredClone(window.__save.value), name, revision: window.__save.value.revision + 2 };
      app.householdSettings = newer;
      editor.initialize({ admin: true, adminRecorded: true, value: newer });
      app.ctx.appearance.applyEffectiveAppearance();
    }, NEWER);
    await settleSave("resolve");
    const reordered = await page(() => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      return { input: editor.nameInput.value, savedRevision: editor.saved.revision, appName: app.householdSettings.name,
        appRevision: app.householdSettings.revision, brand: app.brandTitle.textContent, feedback: editor.feedback.textContent };
    });
    check(reordered.input === NEWER && reordered.appName === NEWER && reordered.brand === NEWER && reordered.savedRevision === reordered.appRevision &&
      reordered.feedback.includes("newer household settings arrived"),
    "a delayed successful save response cannot replace newer household settings received while it was in flight", reordered);
    await page(() => {
      const app = document.querySelector("kin-app");
      app.syncCoordinator = window.__settingsCoordinator;
      delete window.__settingsCoordinator;
      app.householdSettings = null;
      app.ctx.appearance.applyEffectiveAppearance();
      app.householdDefaults.initialize({ admin: false, adminRecorded: false, value: null });
      app.householdDefaults.feedback.textContent = "";
    });

    // --- Accessibility -----------------------------------------------------
    await client.send("Accessibility.enable");
    const axName = async (expression) => {
      const { result } = await client.send("Runtime.evaluate", { expression });
      const { node } = await client.send("DOM.describeNode", { objectId: result.objectId });
      const { nodes } = await client.send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
      return nodes.find((entry) => !entry.ignored)?.name?.value ?? null;
    };
    await viewport(375, 740, true);
    await visit("today");
    const trigger = await page(() => {
      const button = document.querySelector("kin-app").quickAdd.trigger;
      return { visible: getComputedStyle(button, "::before").content !== "none", fontSize: getComputedStyle(button).fontSize };
    });
    const triggerName = await axName(`document.querySelector("kin-app").quickAdd.trigger`);
    check(triggerName === "Quick add" && trigger.visible,
      "at phone width the Quick add trigger shows a short visible label but keeps the accessible name \"Quick add\"", { triggerName, trigger });
    await viewport(1280, 900, false);

    const chevrons = async () => page(() => {
      const app = document.querySelector("kin-app");
      const marker = (summary) => {
        if (!summary) return null;
        const style = getComputedStyle(summary, "::before");
        return { content: style.content, border: style.borderRightStyle, width: style.borderRightWidth };
      };
      return {
        schedule: marker(app.routines.querySelector(".routine-schedule > summary")),
        repeat: marker(app.quickAdd.querySelector(".quick-add-repeat > summary")),
      };
    });
    await visit("routines");
    await idle();
    for (const forced of ["none", "active"]) {
      await setMedia(client, [{ name: "forced-colors", value: forced }]);
      const markers = await chevrons();
      const shown = (marker) => marker && marker.content !== "none" && marker.border === "solid" && marker.width !== "0px";
      check(shown(markers.schedule) && shown(markers.repeat),
        `the repeating-task Schedule and Repeat disclosures show an open/closed marker by shape, not color alone (forced colors ${forced})`, markers);
    }
    await setMedia(client);

    await visit("lists/todo");
    const bulkDescribed = await page(() => {
      const app = document.querySelector("kin-app");
      const bar = app.needs.bulkBar;
      const message = bar?.message?.isConnected ? bar.message : null;
      return { id: message?.id ?? null, unique: message ? document.querySelectorAll(`[id="${message.id}"]`).length === 1 : false,
        buttons: [bar?.undo, bar?.retry, bar?.dismiss].map((button) => button?.getAttribute("aria-describedby")) };
    });
    check(bulkDescribed.id && bulkDescribed.unique && bulkDescribed.buttons.every((value) => value === bulkDescribed.id),
      "Undo, Try again and Dismiss are described by the bulk outcome, so moving focus to them still conveys the result", bulkDescribed);
    await visit("today");

    // Palette opened from a control that disappears before Escape.
    await page(() => {
      const app = document.querySelector("kin-app");
      const button = document.createElement("button");
      button.type = "button";
      button.id = "hardening-transient-opener";
      button.textContent = "Transient";
      app.pages.get("today").prepend(button);
      button.focus();
    });
    await idle();
    await press(KEYS.k);
    await until(() => document.querySelector("kin-app").commandPalette.isOpen, "palette open");
    await page(() => document.getElementById("hardening-transient-opener").remove());
    await press(KEYS.escape);
    const restored = await page(() => {
      const active = document.activeElement;
      return { open: document.querySelectorAll("dialog[open]").length, connected: active?.isConnected, body: active === document.body,
        visible: Boolean(active?.getClientRects().length), inert: Boolean(active?.closest("[hidden],[inert]")), tag: active?.tagName };
    });
    check(restored.open === 0 && restored.connected && !restored.body && restored.visible && !restored.inert,
      "when the palette's opener is removed, Escape closes it and focus falls back to a connected, visible heading", restored);
    // A focus/visibility wake refresh (for example after the second tab
    // closed) briefly sets busy and swallows a shortcut; press only while
    // idle, and again only if Quick add did not open.
    let afterPalette;
    for (let attempt = 0; attempt < 3; attempt++) {
      await idle();
      await press(KEYS.n);
      afterPalette = await page(() => { const q = document.querySelector("kin-app").quickAdd; return { open: q.dialog.open, focus: document.activeElement === q.input }; });
      if (afterPalette.open) break;
    }
    // Quick add moves focus to its title after it opens; on a slow runner the
    // read above can come first (#164). Wait for it, bounded, before checking.
    if (afterPalette.open && !afterPalette.focus) {
      for (let wait = 0; wait < 80 && !afterPalette.focus; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        afterPalette = await page(() => { const q = document.querySelector("kin-app").quickAdd; return { open: q.dialog.open, focus: document.activeElement === q.input }; });
      }
    }
    check(afterPalette.open && afterPalette.focus, "keyboard commands keep working after the palette fallback", afterPalette);
    await press(KEYS.escape);

    // --- Responsive sweep with an unbroken long title ----------------------
    const longTitle = `Hardening${"Unbrokenhouseholdtaskname".repeat(5)}${stamp}`;
    await page(async (text) => {
      const app = document.querySelector("kin-app");
      const itemId = crypto.randomUUID().replaceAll("-", "");
      await app.ctx.append.appendCommand({ type: "add", id: itemId, text, classification: "need" });
      await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId, planningDate: app.ctx.navigation.currentCivilDate() });
      await app.ctx.refresh.refreshFromEvents();
    }, longTitle);
    await idle();
    for (const [width, height] of [[320, 640], [375, 740], [768, 1024], [1280, 900]]) {
      await viewport(width, height, width < 768);
      const layout = {};
      for (const route of ["today", "routines"]) {
        await visit(route);
        layout[route] = await page((text) => {
          const app = document.querySelector("kin-app");
          const row = [...app.today.querySelectorAll("kin-item")].find((node) => node.record?.text === text)?.querySelector(".item-row");
          const rect = row?.getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, rowFits: !row || (rect.left >= 0 && rect.right <= innerWidth) };
        }, longTitle);
      }
      await press(KEYS.n);
      layout.quickAdd = await page(() => {
        const dialog = document.querySelector("kin-app").quickAdd.dialog, rect = dialog.getBoundingClientRect();
        const targets = [...dialog.querySelectorAll("button, select, input, summary")].filter((node) => node.getClientRects().length);
        return { open: dialog.open, fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, targets: targets.every((node) => node.getBoundingClientRect().height >= 44) };
      });
      await press(KEYS.escape);
      await press(KEYS.k);
      layout.palette = await page(() => {
        const palette = document.querySelector("kin-app").commandPalette, dialog = palette.querySelector("dialog[open]");
        const rect = dialog?.getBoundingClientRect();
        return { open: Boolean(dialog), fits: Boolean(rect) && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
      });
      await press(KEYS.escape);
      check(!layout.today.overflow && layout.today.rowFits && !layout.routines.overflow && layout.quickAdd.open && layout.quickAdd.fits && layout.quickAdd.targets && layout.palette.open && layout.palette.fits,
        `at ${width}px Today and Routines do not scroll sideways, a long unbroken title wraps inside its row, and Quick add and the palette fit with 44px+ targets`, layout);
    }
    await viewport(1280, 900, false);
    await visit("today");
    await idle();

    // --- Performance samples ----------------------------------------------
    await client.send("HeapProfiler.enable");
    await client.send("HeapProfiler.collectGarbage");
    const heapBefore = await page(() => performance.memory?.usedJSHeapSize ?? null);
    const objectUrls = await page(() => {
      window.__urls = { created: 0, revoked: 0 };
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = (...args) => { window.__urls.created++; return create.apply(URL, args); };
      URL.revokeObjectURL = (...args) => { window.__urls.revoked++; return revoke.apply(URL, args); };
      return true;
    });

    const create = [];
    for (let index = 0; index < 15; index++) {
      const title = `Perf capture ${stamp} ${index}`;
      await idle();
      const started = await page(() => performance.now());
      await quickAdd(title);
      const ended = await until((title) => { const app = document.querySelector("kin-app"); return !app.busy && app.state.items.some((item) => item.text === title) && performance.now(); }, "perf capture", title);
      create.push(ended - started);
    }
    metrics.push(["quick-add-commit", stats(create)]);
    await press(KEYS.escape);

    const render = await page(() => {
      const app = document.querySelector("kin-app"), samples = [];
      for (let index = 0; index < 25; index++) {
        const started = performance.now();
        app.today.update({ items: app.state.items });
        samples.push(performance.now() - started);
      }
      return samples;
    });
    metrics.push(["today-render", { ...stats(render), items: await page(() => document.querySelector("kin-app").state.items.length) }]);

    const projection = [];
    for (let index = 0; index < 15; index++) {
      await idle();
      projection.push(await page(async () => {
        const started = performance.now();
        await document.querySelector("kin-app").ctx.refresh.refreshFromEvents();
        return performance.now() - started;
      }));
    }
    metrics.push(["replay-and-render (incl. recurrence)", { ...stats(projection), routines: await page(() => document.querySelector("kin-app").state.routines.length) }]);

    const palette = await page(async () => {
      const app = document.querySelector("kin-app"), cp = app.commandPalette, samples = [];
      for (let index = 0; index < 15; index++) {
        const started = performance.now();
        cp.openPalette({ opener: app.main.querySelector(".app-view:not([hidden]) h1") });
        cp.input.value = "sho";
        cp.input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(performance.now() - started);
        cp.dismiss();
      }
      return samples;
    });
    metrics.push(["palette-open-filter (to next frame)", stats(palette)]);

    for (const [count, runs] of [[10, 3], [50, 2]]) {
      const samples = [];
      for (let run = 0; run < runs; run++) {
        const ids = await page(async (count, label) => {
          const app = document.querySelector("kin-app"), ids = [];
          for (let index = 0; index < count; index++) {
            const itemId = crypto.randomUUID().replaceAll("-", "");
            await app.ctx.append.appendCommand({ type: "add", id: itemId, text: `${label} ${index}`, classification: "need" });
            ids.push(itemId);
          }
          await app.ctx.refresh.refreshFromEvents();
          return ids;
        }, count, `Bulk ${count}/${run} ${stamp}`);
        await idle();
        await visit("lists/todo");
        const ms = await page(async (ids) => {
          const app = document.querySelector("kin-app");
          const started = performance.now();
          app.needs.bulkAction("bulk-item-action", { action: "complete", itemIds: ids });
          for (const deadline = performance.now() + 30_000; app.bulkRunning || app.busy;) {
            if (performance.now() > deadline) return -1;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          const done = ids.every((id) => app.state.items.find((item) => item.itemId === id)?.status === "completed");
          return done ? performance.now() - started : -1;
        }, ids);
        check(ms > 0, `bulk completion of ${count} items finishes every target`);
        samples.push(ms);
        await page(() => document.querySelector("kin-app").ctx.bulk.clearBulkOutcome());
      }
      metrics.push([`bulk-complete-${count}`, { ...stats(samples), perItem: Number((stats(samples).median / count).toFixed(2)) }]);
    }

    const urls = await page(() => window.__urls);
    await client.send("HeapProfiler.collectGarbage");
    const heapAfter = await page(() => performance.memory?.usedJSHeapSize ?? null);
    check(objectUrls && urls.created === urls.revoked, "daily flows leave no object URL unrevoked", urls);
    metrics.push(["memory", { heapBeforeMB: heapBefore && Number((heapBefore / 1048576).toFixed(1)), heapAfterMB: heapAfter && Number((heapAfter / 1048576).toFixed(1)), objectUrls: urls }]);

    const started = Date.now();
    await client.send("Page.reload");
    await until(() => Boolean(document.querySelector("kin-app")?.security?.heading), "reloaded shell");
    const shellMs = Date.now() - started;
    await unlock();
    metrics.push(["startup (single sample)", { shellMs, readyMs: Date.now() - started, note: "ready includes recovery-secret key derivation" }]);
    await visit("today");
  } finally {
    await client.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await setMedia(client).catch(() => {});
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  for (const [name, value] of metrics) console.log(`METRIC daily-ux-hardening ${name} ${JSON.stringify(value)}`);
  return `PASS daily UX hardening (${passed.length} checks): offline Quick add reload and at-rest encryption, lock during a pending Quick add write, schedule change interrupted by lock and resumed, reminders and permission prompts across lock, household settings settling after lock, Quick add trigger name, disclosure markers in forced colors, bulk outcome descriptions, palette opener fallback, 320/375/768/1280 reflow, performance samples`;
}
