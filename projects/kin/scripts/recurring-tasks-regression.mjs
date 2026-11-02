import { setViewport } from "./cdp-viewport.mjs";
import assert from "node:assert/strict";

// Repeating tasks (canonically Routines) through Quick add, Today, the
// Routines schedule editor, bulk actions and a reload, using the real
// encrypted store and WASM engine. Real CDP keys drive the keyboard paths.
// The page clock is pinned so weekday/weekend behavior is deterministic.
export async function recurringTaskRegressions(client, { visit, ready }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  const check = (condition, message, detail = null) => { assert.ok(condition, `${message}${detail !== null ? ` ${JSON.stringify(detail)}` : ""}`); passed.push(message); };
  const until = async (fn, label, ...args) => {
    for (let index = 0; index < 300; index++) {
      const value = await page(fn, ...args);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Repeating tasks timed out: ${label}`);
  };
  const settle = () => page(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  const idle = () => until(() => { const app = document.querySelector("kin-app"); return Boolean(app?.state) && !app.busy && !app.bulkRunning && !app.refreshing && !app.pendingRefresh && !app.wakePending; }, "idle");
  const KEYS = {
    tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    n: { key: "n", code: "KeyN", windowsVirtualKeyCode: 78, text: "n" },
  };
  const press = async (spec) => {
    const { text, ...rest } = spec;
    await client.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...rest, ...(text ? { text, unmodifiedText: text } : {}) });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...rest });
    await settle();
  };
  // A wake refresh disables every control while it runs (the app's busy
  // guard), and a disabled field drops typed text. Type only while idle, so
  // the text is never sent into a refresh (#801). Headless Edge also
  // occasionally drops an insert sent in the same frame a modal dialog
  // focused its field; retry only when the field is still unchanged.
  const type = async (text) => {
    await idle();
    const before = await page(() => document.activeElement?.value ?? null);
    for (let attempt = 0; attempt < 3; attempt++) {
      await client.send("Input.insertText", { text });
      await settle();
      if ((await page(() => document.activeElement?.value ?? null)) !== before) break;
    }
    const typed = await page(() => ({ value: document.activeElement?.value ?? null, focus: document.activeElement?.id || document.activeElement?.tagName }));
    assert.ok(typed.value?.endsWith(text), `Repeating tasks: the typed text "${text}" is not in the field ${JSON.stringify(typed)}`);
  };
  const viewport = async (width, height, mobile) => {
    await setViewport(client, { width, height, deviceScaleFactor: 1, mobile });
    await settle();
  };
  // Local noon, so a civil date never depends on the machine's time zone.
  // While the clock is pinned the app's own wake timer is paused; the suite
  // reprojects explicitly instead, so no background refresh lands on a key.
  const setClock = async (year, month, day) => {
    await page((year, month, day) => {
      const app = document.querySelector("kin-app");
      const at = new Date(year, month - 1, day, 12).getTime();
      if (!window.__kinRealNow) window.__kinRealNow = Date.now;
      Date.now = () => at;
      if (!Object.hasOwn(app.ctx.refresh, "schedulePulseRefresh")) app.ctx.refresh.schedulePulseRefresh = () => clearTimeout(app.pulseTimer);
      clearTimeout(app.pulseTimer);
    }, year, month, day);
    await page(() => document.querySelector("kin-app").ctx.refresh.refreshFromEvents());
    await idle();
  };
  const restoreClock = () => page(() => {
    const app = document.querySelector("kin-app");
    if (window.__kinRealNow) { Date.now = window.__kinRealNow; delete window.__kinRealNow; }
    if (Object.hasOwn(app.ctx.refresh, "schedulePulseRefresh")) delete app.ctx.refresh.schedulePulseRefresh;
  });
  // A clock-driven wake refresh can briefly disable controls (the app's own
  // busy guard), swallowing a key press. Act only while idle, and act again
  // only if nothing was saved, so a press is never applied twice.
  const actUntilSaved = async (act, before, label) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await idle();
      await act();
      await idle();
      if ((await eventCount()) > before) return;
    }
    const state = await page(() => {
      const app = document.querySelector("kin-app"), q = app.quickAdd;
      return { busy: app.busy, refreshing: app.refreshing, status: app.status.textContent, alert: app.alert.textContent, dialog: q.dialog.open, value: q.input.value, disabled: q.input.disabled, pending: q.pending, error: q.error.textContent, focus: document.activeElement?.id || document.activeElement?.tagName, hash: location.hash };
    });
    throw new Error(`Repeating tasks: ${label} saved nothing ${JSON.stringify(state)}`);
  };
  const eventCount = () => page(async () => (await document.querySelector("kin-app").store.getCatchUpState()).events.length);
  const routineByText = (text) => page((text) => document.querySelector("kin-app").state.routines.filter((routine) => routine.text === text), text);
  // Every polite status message since the last mark. A clock-driven wake
  // refresh may clear the live region right after an announcement, so the
  // suite asserts what was announced rather than what is still displayed.
  const recordStatus = () => page(() => {
    const app = document.querySelector("kin-app");
    window.__statusLog = [];
    if (Object.hasOwn(app.ctx.status, "setStatus")) return;
    app.ctx.status.setStatus = function (message) { window.__statusLog.push(message); return Object.getPrototypeOf(this).setStatus.call(this, message); };
  });
  const announced = () => page(() => { const log = window.__statusLog ?? []; window.__statusLog = []; return log; });
  const focused = () => page(() => {
    const active = document.activeElement;
    return { tag: active?.tagName, id: active?.id ?? "", action: active?.dataset?.action ?? null, text: active?.textContent?.slice(0, 80) ?? "" };
  });
  const stamp = (await page(() => crypto.randomUUID())).slice(0, 6);
  const title = `Pack lunches ${stamp}`;

  try {
    await page(async () => {
      const app = document.querySelector("kin-app");
      if ((app.state.mode ?? "normal") !== "normal") await app.ctx.append.appendCommand({ type: "set-household-mode", mode: "normal" });
    });
    await viewport(1280, 900, false);
    await setClock(2026, 10, 9); // Friday
    await visit("today");
    await recordStatus();

    // 1. Quick add stays a one-off task by default and as fast as before.
    const oneOff = `One-off ${stamp}`;
    await page(() => document.activeElement?.blur());
    await press(KEYS.n);
    let quick = await page(() => {
      const q = document.querySelector("kin-app").quickAdd;
      return { open: q.dialog.open, focus: document.activeElement === q.input, repeatOpen: q.repeat.open, hidden: q.repeat.hidden, summary: q.repeatSummary.textContent, destination: q.destination.textContent };
    });
    check(quick.open && quick.focus && !quick.repeatOpen && !quick.hidden && quick.summary === "Repeat: Does not repeat" && quick.destination === "Adds to Today.",
      "Quick add opens on the title with repeating collapsed and defaulting to Does not repeat", quick);
    const beforeRoutines = await page(() => document.querySelector("kin-app").state.routines.length);
    await type(oneOff);
    await actUntilSaved(async () => {
      await page(() => document.querySelector("kin-app").quickAdd.input.focus());
      await press(KEYS.enter);
    }, await eventCount(), "one-off Quick add");
    const oneOffState = await page((text) => {
      const app = document.querySelector("kin-app");
      return { items: app.state.items.filter((item) => item.text === text).map((item) => item.planningDate), routines: app.state.routines.length, today: app.ctx.navigation.currentCivilDate(), open: app.quickAdd.dialog.open };
    }, oneOff);
    check(oneOffState.items.length === 1 && oneOffState.items[0] === oneOffState.today && oneOffState.routines === beforeRoutines && !oneOffState.open,
      "title + Enter still creates exactly one one-off task for Today and no repeating task", oneOffState);

    // 2. Keyboard-only repeating capture: Tab to Repeat, open it, choose Every weekday.
    // A wake refresh can make the app busy right after the save and swallow N;
    // press it again only while idle until Quick add opens.
    for (let attempt = 0; attempt < 5; attempt++) {
      await idle();
      await press(KEYS.n);
      if (await page(() => document.querySelector("kin-app").quickAdd.dialog.open)) break;
    }
    await until(() => { const q = document.querySelector("kin-app").quickAdd; return q.dialog.open && document.activeElement === q.input; }, "Quick add input focus");
    await type(title);
    check(await page((title) => { const q = document.querySelector("kin-app").quickAdd; return q.dialog.open && q.input.value === title; }, title), "N opens Quick add and the title is typed into it",
      await page(() => { const q = document.querySelector("kin-app").quickAdd; return { open: q.dialog.open, value: q.input.value, focus: document.activeElement?.id || document.activeElement?.tagName }; }));
    await press(KEYS.tab);
    let focus = await focused();
    check(focus.tag === "SUMMARY" && focus.text === "Repeat: Does not repeat", "Tab from the title reaches the Repeat disclosure", focus);
    await press(KEYS.enter);
    await press(KEYS.tab);
    focus = await focused();
    check(focus.tag === "SELECT" && focus.id === "quick-add-repeat-select", "the opened disclosure exposes a labeled schedule select", focus);
    await press(KEYS.down);
    await press(KEYS.down);
    quick = await page(() => {
      const q = document.querySelector("kin-app").quickAdd;
      return { value: q.repeatSelect.value, summary: q.repeatSummary.textContent, destination: q.destination.textContent, hint: q.repeatHint.textContent, label: q.repeatSelect.labels[0]?.textContent, describedBy: q.input.getAttribute("aria-describedby") };
    });
    check(quick.value === "weekdays" && quick.summary === "Repeat: Every weekday" && quick.label === "How often" &&
      quick.destination.includes("repeating task (every weekday)") && quick.hint.includes("Nothing is due on weekends") && quick.describedBy.includes("quick-add-destination"),
      "the chosen schedule is visible and announced with the title before saving", quick);
    const createCount = await eventCount();
    await idle();
    await announced();
    await actUntilSaved(async () => {
      await page(() => document.querySelector("kin-app").quickAdd.input.focus());
      await press(KEYS.enter);
    }, createCount, "repeating Quick add");
    let [routine] = await routineByText(title);
    const created = await page((text) => {
      const app = document.querySelector("kin-app");
      return { items: app.state.items.filter((item) => item.text === text).length, open: app.quickAdd.dialog.open, reset: app.quickAdd.repeatSelect.value === "" && !app.quickAdd.repeat.open, error: app.quickAdd.error.textContent, status: app.status.textContent, value: app.quickAdd.input.value };
    }, title);
    check(routine && routine.cadence === "weekdays" && routine.createdOn === 20261009 && routine.occurrenceKey === 20261009 &&
      routine.occurrenceStatus === "open" && routine.nextOn === 20261012 && created.items === 0 && !created.open && created.reset &&
      (await eventCount()) === createCount + 1,
      "a repeating capture is one Rust-validated Routine, not an Item, and the draft resets to one-off", { routine, created });
    let messages = await announced();
    check(messages.some((message) => message.startsWith("Added. Repeats every weekday; it's on Today now.")), "capture feedback says it repeats and is due now", messages);

    // 3. Today shows the current occurrence once, with its schedule and next date.
    const today = await page((id) => {
      const app = document.querySelector("kin-app");
      const rows = [...app.today.querySelectorAll(`[data-routine-id="${id}"].routine-row`)];
      const row = rows[0];
      return {
        rows: rows.length,
        meta: row?.querySelector(".item-meta")?.textContent,
        section: row?.closest("[data-section]")?.dataset.section,
        label: row?.closest(".today-routines")?.querySelector(".routine-period")?.textContent,
        schedule: row?.querySelector('[data-action="open-routine-schedule"]')?.getAttribute("aria-label"),
        toggle: row?.querySelector(".complete-button")?.getAttribute("aria-label"),
        selectable: document.querySelectorAll(`.select-control[data-routine-id="${id}"], .select-control[data-item-id="${id}"]`).length,
      };
    }, routine.routineId);
    check(today.rows === 1 && today.section === "routines" && today.label === "Today" && /^Repeats every weekday · Next: /.test(today.meta) &&
      today.schedule === `Schedule for ${title}` && today.toggle?.startsWith(`Complete ${title}`) && today.selectable === 0,
      "Today shows one row for the current occurrence with its schedule, next date and no bulk checkbox", today);

    // 4. Bulk complete + undo in To do never touches the repeating occurrence.
    await visit("lists/todo");
    const bulkText = `Bulk beside routine ${stamp}`;
    await page(async (text) => { const app = document.querySelector("kin-app"); await app.ctx.append.appendCommand({ type: "add", text, classification: "need" }); app.ctx.render.renderState(); }, bulkText);
    await idle();
    const bulkId = await page((text) => document.querySelector("kin-app").state.items.find((item) => item.text === text).itemId, bulkText);
    const bulkBefore = await eventCount();
    await page((id) => {
      const app = document.querySelector("kin-app");
      app.needs.setSelectionMode(true);
      app.needs.querySelector(`.select-control[data-item-id="${id}"]`).click();
      app.needs.bulkBar.complete.click();
    }, bulkId);
    await idle();
    await page(() => document.querySelector("kin-app").needs.bulkBar.undo.click());
    await idle();
    [routine] = await routineByText(title);
    check(routine.occurrenceStatus === "open" && (await eventCount()) === bulkBefore + 2 &&
      (await page(() => document.querySelectorAll(".select-control[data-routine-id]").length)) === 0,
      "bulk completion and its undo change only the selected task, never a repeating occurrence", routine);
    await page(() => document.querySelector("kin-app").needs.setSelectionMode(false));

    // 5. Complete the current occurrence from Today with the keyboard.
    await visit("today");
    const completeCount = await eventCount();
    await idle();
    await announced();
    await actUntilSaved(async () => {
      await page((id) => document.querySelector("kin-app").today.querySelector(`.today-routines [data-routine-id="${id}"] .complete-button`).focus(), routine.routineId);
      await press(KEYS.space);
    }, completeCount, "Space completion");
    [routine] = await routineByText(title);
    const done = await page((id) => {
      const app = document.querySelector("kin-app");
      const rows = [...app.today.querySelectorAll(`[data-routine-id="${id}"].routine-row`)];
      return { rows: rows.length, inCompleted: Boolean(rows[0]?.closest('[data-section="completed"]')), meta: rows[0]?.querySelector(".item-meta")?.textContent, focus: document.activeElement?.dataset?.action ?? null };
    }, routine.routineId);
    check(routine.occurrenceStatus === "completed" && (await eventCount()) === completeCount + 1 && done.rows === 1 && done.inCompleted &&
      /^Done today · Next: /.test(done.meta),
      "Space completes only the current occurrence; it moves to Completed with its next date", { routine, done });
    messages = await announced();
    check(messages.some((message) => /^Done for this period\. Next: /.test(message)), "completion is announced with the next occurrence", messages);

    // 6. A stale completion of the same occurrence is refused and explained.
    const staleCount = await eventCount();
    await page((id) => document.querySelector("kin-app").ctx.routines.saveRoutine({ type: "complete-routine-occurrence", routineId: id, occurrenceKey: 20261009 }), routine.routineId);
    await idle();
    check((await eventCount()) === staleCount && (await routineByText(title))[0].occurrenceStatus === "completed",
      "a repeated completion of a done occurrence records nothing", await announced());

    // 7. Weekend: nothing is due; Monday opens a fresh, independent occurrence.
    await setClock(2026, 10, 10);
    [routine] = await routineByText(title);
    const weekend = await page((id) => {
      const app = document.querySelector("kin-app");
      return {
        today: app.today.querySelectorAll(`[data-routine-id="${id}"].routine-row`).length,
        routinesRow: app.routines.querySelector(`[data-routine-id="${id}"] .routine-status`)?.textContent,
        complete: app.routines.querySelectorAll(`[data-routine-id="${id}"] [data-action="complete-routine-occurrence"]`).length,
      };
    }, routine.routineId);
    check(routine.occurrenceKey === null && routine.occurrenceStatus === "unavailable" && routine.nextOn === 20261012 && weekend.today === 0 &&
      weekend.complete === 0 && /^Weekdays · Nothing due at the weekend · Next: /.test(weekend.routinesRow),
      "a weekday task is absent from Today at the weekend and shows when it is next due", { routine, weekend });
    await setClock(2026, 10, 12);
    [routine] = await routineByText(title);
    check(routine.occurrenceKey === 20261012 && routine.occurrenceStatus === "open" && routine.nextOn === 20261013,
      "Monday opens a new occurrence; Friday's completion stays in history only", routine);

    // 8. Reload: the encrypted local history replays the same repeating task.
    const beforeReload = await eventCount();
    await client.send("Page.reload");
    await ready(client);
    await idle();
    await recordStatus();
    await setClock(2026, 10, 12);
    [routine] = await routineByText(title);
    check((await eventCount()) === beforeReload && routine?.cadence === "weekdays" && routine.occurrenceStatus === "open" && routine.nextOn === 20261013,
      "after reload and unlock the repeating task and its occurrence state replay from encrypted storage", routine);
    await setClock(2026, 10, 9);
    check((await routineByText(title))[0].occurrenceStatus === "completed", "Friday's completion survived the reload");
    await setClock(2026, 10, 12);

    // 9. Today's Schedule button opens the editor on Routines; keyboard change to Every week.
    await visit("today");
    await page((id) => document.querySelector("kin-app").today.querySelector(`[data-routine-id="${id}"] [data-action="open-routine-schedule"]`).focus(), routine.routineId);
    await press(KEYS.enter);
    await settle();
    let editor = await page((id) => {
      const app = document.querySelector("kin-app");
      const row = app.routines.querySelector(`[data-routine-id="${id}"]`);
      const details = row?.querySelector(".routine-schedule");
      const form = details?.querySelector("form");
      return {
        page: !app.pages.get("routines").hidden,
        open: details?.open,
        focus: document.activeElement === details?.querySelector("select"),
        current: form?.querySelector("p")?.textContent,
        value: details?.querySelector("select")?.value,
        saveDisabled: details?.querySelector('[data-action="change-routine-schedule"]')?.disabled,
        stop: row?.querySelector('.item-action [data-action="archive-routine"]')?.textContent,
      };
    }, routine.routineId);
    check(editor.page && editor.open && editor.focus && editor.value === "weekdays" && /^Repeats every weekday\. Next: /.test(editor.current) &&
      editor.saveDisabled === true && editor.stop === "Delete routine",
      "Schedule opens the row's editor with the current schedule and focuses the select", editor);
    await press(KEYS.down);
    editor = await page((id) => {
      const row = document.querySelector("kin-app").routines.querySelector(`[data-routine-id="${id}"]`);
      const select = row.querySelector(".routine-schedule select");
      return { value: select.value, scope: document.getElementById(select.getAttribute("aria-describedby")).textContent, saveDisabled: row.querySelector('[data-action="change-routine-schedule"]').disabled };
    }, routine.routineId);
    check(editor.value === "weekly" && !editor.saveDisabled && editor.scope.includes("The new schedule starts today") && editor.scope.includes("Past completions stay"),
      "the editor states that a change starts today and leaves past completions alone", editor);

    // 10. A partial save keeps both facts honest, and the retry finishes without a duplicate.
    const changeCount = await eventCount();
    await page(() => {
      const app = document.querySelector("kin-app");
      const original = app.ctx.append.appendCommand;
      app.ctx.append.appendCommand = async function (command) {
        if (command.type === "archive-routine") { app.ctx.append.appendCommand = original; throw Object.assign(new Error("Simulated storage failure"), { userMessage: "Simulated storage failure" }); }
        return original.call(this, command);
      };
    });
    await actUntilSaved(async () => {
      await page((id) => document.querySelector("kin-app").routines.querySelector(`[data-routine-id="${id}"] [data-action="change-routine-schedule"]`).focus(), routine.routineId);
      await press(KEYS.enter);
    }, changeCount, "Change schedule");
    let versions = await routineByText(title);
    // A wake refresh clears and then restores a pending alert; read it settled.
    const partial = await until(() => { const app = document.querySelector("kin-app"); return !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && app.alert.textContent.includes("still repeating") && app.alert.textContent; }, "partial-save alert");
    check(versions.length === 2 && versions.filter((entry) => entry.status === "active").length === 2 && partial.includes("still repeating") &&
      (await eventCount()) === changeCount + 1,
      "a failure after the new schedule is saved says the old one is still repeating", { partial, versions });
    await announced();
    await actUntilSaved(() => page(() => { const app = document.querySelector("kin-app"); if (!app.retryButton.hidden && !app.retryButton.disabled) app.retryButton.click(); }), changeCount + 1, "Try again");
    versions = await routineByText(title);
    const replacement = versions.find((entry) => entry.status === "active");
    check(versions.length === 2 && versions.find((entry) => entry.routineId === routine.routineId)?.status === "archived" &&
      replacement?.cadence === "weekly" && replacement.createdOn === 20261012 && replacement.occurrenceKey === 20261012 && replacement.nextOn === 20261019 &&
      (await eventCount()) === changeCount + 2,
      "retry resumes with the same replacement: one new weekly task, the old one stopped", versions);
    messages = await announced();
    check(messages.some((message) => message.startsWith("Schedule changed: repeats every week, starting today. Past completions are kept.")),
      "schedule change feedback is announced", messages);
    await setClock(2026, 10, 9);
    check((await page(async (id) => (await document.querySelector("kin-app").store.loadEvents()).length > 0 &&
      document.querySelector("kin-app").state.routines.find((entry) => entry.routineId === id)?.status === "archived", routine.routineId)),
      "the stopped schedule's history replays unchanged");
    await setClock(2026, 10, 12);

    // 11. A stale request against the stopped schedule changes nothing.
    const staleChange = await eventCount();
    await announced();
    await page((id) => document.querySelector("kin-app").ctx.routines.changeRoutineSchedule({ routineId: id, cadence: "monthly" }), routine.routineId);
    await idle();
    messages = await announced();
    check((await eventCount()) === staleChange && messages.some((message) => message.includes("already stopped repeating")),
      "a schedule change from a stale view is refused with an explanation", messages);

    // 12. Mobile: the controls stay large enough to tap and nothing scrolls sideways.
    await viewport(320, 640, true);
    await visit("routines");
    await page((id) => document.querySelector("kin-app").routines.openSchedule(id), replacement.routineId);
    await settle();
    let mobile = await page((id) => {
      const row = document.querySelector("kin-app").routines.querySelector(`[data-routine-id="${id}"]`);
      const sizes = [...row.querySelectorAll(".routine-schedule summary, .routine-schedule select, .routine-schedule button")].map((node) => Math.round(node.getBoundingClientRect().height));
      return { sizes, overflow: document.documentElement.scrollWidth - innerWidth };
    }, replacement.routineId);
    check(mobile.sizes.length === 3 && mobile.sizes.every((height) => height >= 44) && mobile.overflow <= 0,
      "the schedule editor keeps 44px+ targets at 320px without horizontal overflow", mobile);
    await visit("today");
    await page(() => document.querySelector("kin-app").quickAdd.trigger.click());
    await page(() => { const q = document.querySelector("kin-app").quickAdd; q.repeat.open = true; });
    await settle();
    mobile = await page(() => {
      const q = document.querySelector("kin-app").quickAdd;
      const box = q.dialog.getBoundingClientRect();
      return { summary: q.repeatSummary.getBoundingClientRect().height, select: q.repeatSelect.getBoundingClientRect().height, fits: box.width <= innerWidth && box.left >= 0, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    check(mobile.summary >= 44 && mobile.select >= 44 && mobile.fits && mobile.overflow <= 0, "Quick add's Repeat controls fit and stay tappable at 320px", mobile);
    await page(() => { const q = document.querySelector("kin-app").quickAdd; q.clearDraft(); q.dialog.close(); });
    await viewport(1280, 900, false);

    // 13. Delete routine (#314) keeps history and removes the task from Today.
    await visit("routines");
    await page((id) => document.querySelector("kin-app").routines.openSchedule(id), replacement.routineId);
    await idle();
    await announced();
    await page((id) => document.querySelector("kin-app").routines.querySelector(`[data-routine-id="${id}"] [data-action="archive-routine"]`).click(), replacement.routineId);
    await idle();
    versions = await routineByText(title);
    const stopped = await page((id) => document.querySelector("kin-app").today.querySelectorAll(`[data-routine-id="${id}"]`).length, replacement.routineId);
    check(versions.every((entry) => entry.status === "archived" && entry.nextOn === null) && stopped === 0 &&
      (await announced()).includes("Routine deleted. Past completions are kept."),
      "Delete routine ends future occurrences, keeps history and is announced", versions);
  } finally {
    await page(() => { const app = document.querySelector("kin-app"); if (Object.hasOwn(app.ctx.status, "setStatus")) delete app.ctx.status.setStatus; delete window.__statusLog; });
    await restoreClock();
    await page(() => document.querySelector("kin-app").ctx.refresh.refreshFromEvents());
    await idle();
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  return `PASS repeating tasks (${passed.length} checks): ${passed.join("; ")}`;
}
