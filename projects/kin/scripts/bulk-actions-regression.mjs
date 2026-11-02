import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import assert from "node:assert/strict";

// Bulk selection, complete/reopen, and undo through the real encrypted store
// and WASM engine, driven with real CDP keys where a person would type.
export async function bulkActionRegressions(client, { visit, ready }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  const metrics = [];
  const check = (condition, message, detail = null) => { assert.ok(condition, `${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`); passed.push(message); };
  const until = async (fn, label, ...args) => {
    for (let index = 0; index < 300; index++) {
      const value = await page(fn, ...args);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Bulk actions timed out: ${label}`);
  };
  const settle = () => page(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  const idle = () => until(() => { const app = document.querySelector("kin-app"); return Boolean(app?.state) && !app.busy && !app.bulkRunning && !app.refreshing && !app.pendingRefresh && !app.wakePending; }, "idle");
  const KEYS = {
    space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
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
  const stamp = (await page(() => crypto.randomUUID())).slice(0, 6);
  const create = (texts, classification = "need") => page(async (texts, classification) => {
    const app = document.querySelector("kin-app");
    const ids = [];
    for (const text of texts) {
      await app.ctx.append.appendCommand({ type: "add", text, classification });
      ids.push(app.state.items.find((item) => item.text === text).itemId);
    }
    app.ctx.render.renderState();
    return ids;
  }, texts, classification);
  const eventCount = () => page(async () => (await document.querySelector("kin-app").store.getCatchUpState()).events.length);
  const statusOf = (ids) => page((ids) => { const items = document.querySelector("kin-app").state.items; return ids.map((id) => items.find((item) => item.itemId === id)?.status ?? "missing"); }, ids);
  const bar = () => page(() => {
    const app = document.querySelector("kin-app");
    const list = app.needs.isConnected && !app.needs.closest("[hidden]") ? app.needs : app.shopping;
    const b = list.bulkBar;
    const shown = (node) => Boolean(node) && !node.hidden && !node.closest("[hidden]");
    return {
      mode: list.selectionMode,
      count: b?.count.textContent,
      selected: list.selectedItemIds.length,
      complete: shown(b?.complete) ? b.complete.textContent : null,
      reopen: shown(b?.reopen) ? b.reopen.textContent : null,
      result: shown(b?.result) ? b.message.textContent : null,
      undo: shown(b?.undo),
      retry: shown(b?.retry),
      focus: document.activeElement?.dataset?.action ?? document.activeElement?.dataset?.itemAction ?? document.activeElement?.tagName,
      focusItem: document.activeElement?.dataset?.itemId ?? null,
    };
  });
  // Selection helpers act on the real checkboxes in the To do list.
  const tick = (ids) => page((ids) => {
    const app = document.querySelector("kin-app");
    for (const id of ids) {
      const box = app.needs.querySelector(`.select-control[data-item-id="${id}"]`) ?? app.shopping.querySelector(`.select-control[data-item-id="${id}"]`);
      if (!box.checked) box.click();
    }
  }, ids);
  const runAction = async (action) => {
    await page((action) => { const app = document.querySelector("kin-app"); const list = app.needs.closest("[hidden]") ? app.shopping : app.needs; list.bulkBar[action].click(); }, action);
    await idle();
    await settle();
  };
  const mode = (on, list = "needs") => page((on, list) => { document.querySelector("kin-app")[list].setSelectionMode(on); }, on, list);
  const gateAppends = () => page(() => {
    const app = document.querySelector("kin-app");
    const original = app.ctx.append.appendCommand;
    window.__bulkGate = { original, waiting: [] };
    app.ctx.append.appendCommand = function (command) {
      return new Promise((resolve, reject) => window.__bulkGate.waiting.push(() => original.call(this, command).then(resolve, reject)));
    };
  });
  const releaseOne = () => page(() => window.__bulkGate.waiting.shift()?.());
  const ungate = () => page(() => {
    const gate = window.__bulkGate;
    if (!gate) return;
    document.querySelector("kin-app").ctx.append.appendCommand = gate.original;
    for (const run of gate.waiting.splice(0)) run();
    delete window.__bulkGate;
  });
  // Holds authoritative reads of the encrypted log until rejected with a
  // non-lock storage error, and counts every command append meanwhile.
  const holdReads = () => page(() => {
    const app = document.querySelector("kin-app");
    window.__readGate = { read: app.ctx.refresh.readAuthoritativeState, append: app.ctx.append.appendCommand, waiting: [], appends: [] };
    app.ctx.refresh.readAuthoritativeState = () => new Promise((resolve, reject) => window.__readGate.waiting.push(reject));
    app.ctx.append.appendCommand = function (command) {
      window.__readGate.appends.push(command);
      return window.__readGate.append.call(this, command);
    };
  });
  const rejectReads = () => page(() => {
    for (const reject of window.__readGate.waiting.splice(0)) reject(Object.assign(new Error("forced storage read failure"), { code: "storage" }));
  });
  const restoreReads = () => page(() => {
    const gate = window.__readGate;
    if (!gate) return [];
    const app = document.querySelector("kin-app");
    app.ctx.refresh.readAuthoritativeState = gate.read;
    app.ctx.append.appendCommand = gate.append;
    delete window.__readGate;
    return gate.appends;
  });
  const undoFeedback = () => page(() => {
    const app = document.querySelector("kin-app");
    const bar = app.needs.bulkBar;
    return {
      error: bar.result.classList.contains("bulk-result-error"),
      live: bar.message.getAttribute("role") === "status" && bar.message.getAttribute("aria-live") === "polite",
      kept: app.bulkUndo?.changes.map((change) => change.itemId) ?? null,
      label: bar.undo.textContent,
    };
  });
  const UNVERIFIED = "Unable to verify the latest item state. No changes were undone. Try again.";

  try {
    await viewport(1280, 900, false);
    await visit("lists/todo");
    await idle();
    const ids = await create(["A", "B", "C", "D", "E", "F"].map((letter) => `Bulk ${letter} ${stamp}`));
    const [a, b, c, d, e, f] = ids;
    await idle();

    // --- Selection mode, keyboard-only --------------------------------------
    await page(() => document.querySelector("kin-app").needs.bulkBar.selectMode.focus());
    await press(KEYS.enter);
    let state = await bar();
    const rows = await page((id) => {
      const app = document.querySelector("kin-app");
      const box = app.needs.querySelector(`.select-control[data-item-id="${id}"]`);
      return {
        type: box?.type, name: box?.labels?.[0]?.textContent, pressed: app.needs.bulkBar.selectMode.getAttribute("aria-pressed"),
        completeControls: app.needs.querySelectorAll(".list-view > .item-list .complete-control").length,
        group: app.needs.bulkBar.toolbar.getAttribute("role"), groupLabel: app.needs.bulkBar.toolbar.getAttribute("aria-label"),
        countLive: app.needs.bulkBar.count.getAttribute("aria-live"), staplesSelect: !app.staples.bulkBar,
        target: box?.closest("label").getBoundingClientRect().height,
      };
    }, a);
    check(state.mode && state.count === "No items selected" && state.focus === "select-mode" && rows.type === "checkbox" && rows.name.startsWith("Select Bulk A") &&
      rows.pressed === "true" && rows.completeControls === 0 && rows.group === "group" && rows.groupLabel === "Selected To do items" && rows.countLive === "polite" &&
      rows.staplesSelect && rows.target >= 48,
    "Enter on Select turns on selection mode: labelled native checkboxes replace completion, with a polite count", { state, rows });
    await page((id) => document.querySelector(`kin-app .select-control[data-item-id="${id}"]`).focus(), a);
    await press(KEYS.space);
    await page((id) => document.querySelector(`kin-app .select-control[data-item-id="${id}"]`).focus(), b);
    await press(KEYS.space);
    state = await bar();
    check(state.selected === 2 && state.count === "2 items selected" && state.complete === "Complete 2" && state.reopen === null,
      "Space on native checkboxes selects items and shows only the applicable action", state);
    await press(KEYS.space);
    state = await bar();
    check(state.selected === 1 && state.count === "1 item selected" && state.focusItem === b, "Space again deselects, keeping focus on the checkbox", state);

    await runAction("selectAll");
    state = await bar();
    const activeCount = await page(() => document.querySelector("kin-app").needs.listRecords().filter((record) => record.status === "active").length);
    check(state.selected === activeCount && state.count === `${activeCount} items selected`, "Select all selects every open item that is visible", { state, activeCount });
    await page(() => document.querySelector("kin-app").needs.bulkBar.clear.focus());
    await press(KEYS.enter);
    state = await bar();
    check(state.selected === 0 && state.count === "No items selected" && state.focus === "select-all", "Clear selection empties it and moves focus to a control that is still shown", state);

    // --- Bulk complete and undo, keyboard ------------------------------------
    await tick([a, b, c]);
    let before = await eventCount();
    await page(() => document.querySelector("kin-app").needs.bulkBar.complete.focus());
    await press(KEYS.enter);
    await idle();
    await settle();
    state = await bar();
    let after = await eventCount();
    const metric = await page(() => document.querySelector("kin-app").lastBulkMetric);
    check(state.result === "3 items completed." && state.focus === "bulk-undo" && state.undo && !state.retry && state.selected === 0 &&
      (await statusOf([a, b, c])).every((status) => status === "completed") && after - before === 3,
    "Enter on Complete appends one completion per item, reports it, and moves focus to Undo", { state, delta: after - before });
    const live = await page(() => { const message = document.querySelector("kin-app").needs.bulkBar.message; return message.getAttribute("role") === "status" && message.getAttribute("aria-live") === "polite"; });
    check(live, "the outcome is a polite live status");
    before = after;
    await press(KEYS.enter);
    await idle();
    state = await bar();
    after = await eventCount();
    check(state.result === "Undid 3 items." && !state.undo && (await statusOf([a, b, c])).every((status) => status === "active") && after - before === 3,
      "Undo appends three new reopen events instead of removing history", { state, delta: after - before });
    await press(KEYS.enter);
    await idle();
    check(await eventCount() === after, "Undo cannot run twice: after it runs, Enter does nothing more");

    // --- Rapid repeats -------------------------------------------------------
    await tick([d, e]);
    before = await eventCount();
    await page(() => {
      const app = document.querySelector("kin-app");
      const button = app.needs.bulkBar.complete;
      button.click(); button.click();
      app.needs.bulkAction("bulk-item-action", { action: "complete", itemIds: app.needs.selectedItemIds });
    });
    await idle();
    after = await eventCount();
    check(after - before === 2 && (await statusOf([d, e])).every((status) => status === "completed"), "rapid repeated activation completes each item once", { delta: after - before });
    await runAction("undo");

    // --- Partial failure, retry, undo of carried successes -----------------
    await tick([a, b, c, d]);
    await page((failing) => {
      const app = document.querySelector("kin-app");
      window.__original = app.ctx.append.appendCommand;
      app.ctx.append.appendCommand = function (command) {
        if (failing.includes(command.itemId)) return Promise.reject(Object.assign(new Error("forced local failure"), { userMessage: "Couldn't save." }));
        return window.__original.call(this, command);
      };
    }, [b, d]);
    await runAction("complete");
    state = await bar();
    check(state.result === "2 items completed. 2 could not be completed." && state.retry && state.undo && state.selected === 2 &&
      JSON.stringify(await statusOf([a, b, c, d])) === JSON.stringify(["completed", "active", "completed", "active"]),
    "a partial failure reports both counts, keeps failed items selected, and offers Retry and Undo", state);
    const undoSet = await page(() => document.querySelector("kin-app").bulkUndo.changes.map((change) => change.itemId));
    check(undoSet.length === 2 && undoSet.includes(a) && undoSet.includes(c), "only successful items enter the undo set", undoSet);
    await page(() => { const app = document.querySelector("kin-app"); app.ctx.append.appendCommand = window.__original; });
    await runAction("retry");
    state = await bar();
    const carried = await page(() => document.querySelector("kin-app").bulkUndo.changes.length);
    check(state.result === "2 items completed." && !state.retry && carried === 4 && (await statusOf([b, d])).every((status) => status === "completed"),
      "Try failed items again completes only the failed items and keeps every success undoable", { state, carried });

    // Partial undo failure, then try again.
    await page((failing) => {
      const app = document.querySelector("kin-app");
      window.__original = app.ctx.append.appendCommand;
      app.ctx.append.appendCommand = function (command) {
        if (command.itemId === failing && command.type === "reopen") return Promise.reject(new Error("forced undo failure"));
        return window.__original.call(this, command);
      };
    }, c);
    await runAction("undo");
    state = await bar();
    check(state.result === "Undid 3 items. 1 item could not be undone." && state.undo && (await statusOf([c]))[0] === "completed",
      "a partial undo failure is reported and the failed item stays undoable", state);
    await page(() => { document.querySelector("kin-app").ctx.append.appendCommand = window.__original; });
    await runAction("undo");
    state = await bar();
    check(state.result === "Undid 1 item." && (await statusOf([a, b, c, d])).every((status) => status === "active"), "Try undo again finishes the remaining item", state);

    // --- Undo never overwrites a later change --------------------------------
    await tick([e, f]);
    await runAction("complete");
    // Another change lands only in the encrypted log (as a synced event
    // would), leaving the rendered projection stale: reopen and re-complete.
    await page(async (id) => {
      const app = document.querySelector("kin-app");
      await app.store.append({ type: "reopen", itemId: id }, app.engine);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await app.store.append({ type: "complete", itemId: id }, app.engine);
    }, e);
    const staleView = await page((id) => document.querySelector("kin-app").state.items.find((item) => item.itemId === id).status, e);
    before = await eventCount();
    await runAction("undo");
    state = await bar();
    after = await eventCount();
    check(staleView === "completed" && state.result === "Undid 1 item. 1 item changed since then, so it was left as it is." &&
      JSON.stringify(await statusOf([e, f])) === JSON.stringify(["completed", "active"]) && after - before === 1,
    "undo re-reads the encrypted log and leaves an item someone changed afterwards as it is", { staleView, state });

    // Rust rejects a stale compensating command atomically.
    const rejected = await page(async (id) => {
      const app = document.querySelector("kin-app");
      try { await app.ctx.append.appendCommand({ type: "complete", itemId: id }); return "appended"; } catch (error) { return error.code; }
    }, e);
    check(rejected === 4, "Rust refuses a completion that would not change the item's status", { rejected });
    await idle();

    // --- Undo fails closed when the encrypted log cannot be read -------------
    await tick([a]);
    await runAction("complete");
    state = await bar();
    check(state.result === "1 item completed." && state.undo && (await statusOf([a]))[0] === "completed", "a bulk completion is offered for undo", state);
    await holdReads();
    before = await eventCount();
    // Repeated activation while the read is pending starts one undo only.
    await page(() => { const app = document.querySelector("kin-app"); app.needs.bulkBar.undo.click(); app.needs.bulkBar.undo.click(); app.needs.bulkAction("bulk-undo"); });
    await until(() => window.__readGate.waiting.length === 1, "held authoritative read");
    const pendingReads = await page(() => window.__readGate.waiting.length);
    await rejectReads();
    await idle();
    await settle();
    state = await bar();
    after = await eventCount();
    let feedback = await undoFeedback();
    let appends = await page(() => window.__readGate.appends.length);
    check(pendingReads === 1 && appends === 0 && after === before && (await statusOf([a]))[0] === "completed" && state.result === UNVERIFIED &&
      feedback.error && feedback.live && state.undo && state.focus === "bulk-undo" && JSON.stringify(feedback.kept) === JSON.stringify([a]),
    "a failed authoritative read issues no compensating command, never falls back to the rendered state, and keeps undo for retry", { pendingReads, appends, delta: after - before, state, feedback });
    appends = (await restoreReads()).length;
    await runAction("undo");
    state = await bar();
    check(appends === 0 && state.result === "Undid 1 item." && !state.undo && (await statusOf([a]))[0] === "active" && (await eventCount()) - before === 1,
      "once storage is readable again, Try undo again reopens the item exactly once", { state, delta: (await eventCount()) - before });

    // The hazard itself: a newer change sits only in the encrypted log while
    // the rendered projection still matches what undo expects.
    await tick([a]);
    await runAction("complete");
    await page(async (id) => {
      const app = document.querySelector("kin-app");
      await app.store.append({ type: "reopen", itemId: id }, app.engine);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await app.store.append({ type: "complete", itemId: id }, app.engine);
    }, a);
    await holdReads();
    before = await eventCount();
    await page(() => document.querySelector("kin-app").needs.bulkBar.undo.click());
    await until(() => window.__readGate.waiting.length === 1, "held read over a hidden change");
    await rejectReads();
    await idle();
    state = await bar();
    after = await eventCount();
    appends = (await restoreReads()).length;
    check(appends === 0 && after === before && state.result === UNVERIFIED && state.undo,
      "an unreadable log never lets undo overwrite a newer change the rendered state has not seen", { appends, delta: after - before, state });
    await runAction("undo");
    state = await bar();
    check(state.result === "1 item changed since then, so it was left as it is." && (await eventCount()) === before,
      "the retry re-reads the log and still detects the newer change", state);
    await page(async (id) => { const app = document.querySelector("kin-app"); await app.ctx.refresh.refreshFromEvents(); await app.ctx.append.appendCommand({ type: "reopen", itemId: id }); app.ctx.render.renderState(); }, a);
    await idle();

    // --- Mixed selection ----------------------------------------------------
    await page(() => { const details = document.querySelector("kin-app").needs.querySelector(".completed-disclosure"); details.open = true; details.dispatchEvent(new Event("toggle")); });
    await tick([a, b, e]);
    state = await bar();
    check(state.complete === "Complete 2" && state.reopen === "Reopen 1", "a mixed selection offers Complete and Reopen with their own counts", state);
    await runAction("reopen");
    state = await bar();
    check(state.result === "1 item reopened." && JSON.stringify(await statusOf([a, b, e])) === JSON.stringify(["active", "active", "active"]) && state.selected === 2,
      "Reopen acts only on the completed item and leaves the others selected", state);
    await page(() => document.querySelector("kin-app").needs.clearSelection());
    await runAction("selectAll");
    const allVisible = await page(() => {
      const list = document.querySelector("kin-app").needs;
      return list.selectedItemIds.length === list.listRecords().length;
    });
    check(allVisible, "with Completed open, Select all includes the visible completed items");
    await page(() => { const list = document.querySelector("kin-app").needs; list.clearSelection(); const details = list.querySelector(".completed-disclosure"); if (details) { details.open = false; details.dispatchEvent(new Event("toggle")); } });

    // --- Ineligible ids never reach the store --------------------------------
    const [archived] = await create([`Bulk archived ${stamp}`]);
    const [staple] = await create([`Bulk staple ${stamp}`], "staple");
    await page(async (id) => { const app = document.querySelector("kin-app"); await app.ctx.append.appendCommand({ type: "archive", itemId: id }); app.ctx.render.renderState(); }, archived);
    await idle();
    before = await eventCount();
    await page((ids) => document.querySelector("kin-app").needs.bulkAction("bulk-item-action", { action: "complete", itemIds: ids }), [archived, staple, "00000000000000000000000000000000", a]);
    await idle();
    state = await bar();
    after = await eventCount();
    check(after - before === 1 && state.result === "1 item completed. 3 items were already done or no longer available." && (await statusOf([staple]))[0] === "active",
      "archived, staple, and unknown ids are skipped and reported, never submitted", { state, delta: after - before });
    const stapleUi = await page(() => document.querySelector("kin-app").staples.querySelector(".bulk-select-mode") === null);
    check(stapleUi, "Staples offer no selection mode");
    await runAction("undo");

    // --- Reconciliation with remote changes ----------------------------------
    await tick([b, c]);
    await page(async (id) => {
      const app = document.querySelector("kin-app");
      await app.store.append({ type: "archive", itemId: id }, app.engine);
      app.ctx.peers.broadcastEventChange();
      await app.ctx.refresh.refreshFromEvents();
    }, c);
    await idle();
    state = await bar();
    check(state.selected === 1 && state.count === "1 item selected", "an item archived elsewhere drops out of the selection on refresh", state);
    await page(() => document.querySelector("kin-app").needs.clearSelection());

    // --- Other features still work in selection mode ------------------------
    await page((id) => document.querySelector(`kin-app .select-control[data-item-id="${id}"]`).focus(), a);
    await press(KEYS.n);
    let quick = await page(() => document.querySelector("kin-app").quickAdd.dialog.open);
    await press(KEYS.escape);
    await press(KEYS.k);
    const palette = await page(() => document.querySelector("kin-app").commandPalette.isOpen);
    await press(KEYS.escape);
    check(quick && palette, "N opens Quick add and Ctrl+K the palette from a selection checkbox");
    const detailOrigin = await page(async (id) => {
      const app = document.querySelector("kin-app");
      [...app.needs.querySelectorAll(".item-details-button")].find((node) => node.dataset.itemId === id).click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const opened = app.selection?.itemId === id && app.selection.page === "lists";
      app.ctx.detail.closeItemDetail({ restoreFocus: true });
      return { opened, stillSelecting: app.needs.selectionMode, focus: document.activeElement?.dataset.itemId === id };
    }, a);
    check(detailOrigin.opened && detailOrigin.stillSelecting && detailOrigin.focus, "Details still opens from a row in selection mode and returns to it", detailOrigin);

    // --- Navigation during a batch ------------------------------------------
    await tick([a, b]);
    await gateAppends();
    await page(() => document.querySelector("kin-app").needs.bulkBar.complete.click());
    await until(() => window.__bulkGate.waiting.length === 1, "first gated append");
    const progress = await page(() => document.querySelector("kin-app").needs.bulkBar.progress.textContent);
    await visit("today");
    await releaseOne();
    await until(() => window.__bulkGate.waiting.length === 1, "second gated append");
    await releaseOne();
    await ungate();
    await idle();
    await visit("lists/todo");
    state = await bar();
    check(progress === "Completing 1 of 2…" && state.result === "2 items completed." && (await statusOf([a, b])).every((status) => status === "completed"),
      "a batch shows progress and finishes correctly when the person navigates away mid-batch", { progress, state });
    await runAction("undo");

    // --- Shopping -------------------------------------------------------------
    const shoppingIds = await create([`Bulk milk ${stamp}`, `Bulk bread ${stamp}`], "shopping");
    await visit("lists/shopping");
    await idle();
    await mode(true, "shopping");
    await tick(shoppingIds);
    await runAction("complete");
    state = await bar();
    check(state.result === "2 items completed." && (await statusOf(shoppingIds)).every((status) => status === "completed"), "Shopping items complete in bulk through the same commands", state);
    await mode(false, "shopping");

    // --- Performance sample ---------------------------------------------------
    await visit("lists/todo");
    const many = await create(Array.from({ length: 25 }, (_, index) => `Bulk load ${index} ${stamp}`));
    await idle();
    await tick(many);
    await runAction("complete");
    const sample = await page(() => document.querySelector("kin-app").lastBulkMetric);
    metrics.push(`METRIC bulk-complete items=${sample.count} total=${sample.ms.toFixed(1)}ms per-item=${(sample.ms / sample.count).toFixed(1)}ms first=${metric.count}/${metric.ms.toFixed(1)}ms`);
    check(sample.count === 25 && (await statusOf(many)).every((status) => status === "completed"), "a 25-item batch completes every item", sample);
    await runAction("undo");
    await idle();

    // --- 320px, forced colours, reduced motion -----------------------------
    await viewport(320, 720, true);
    await visit("lists/todo");
    await tick([a, b]);
    await page((id) => { const details = document.querySelector("kin-app").needs.querySelector(".completed-disclosure"); if (details) details.open = true; }, a);
    const narrow = await page(() => {
      const list = document.querySelector("kin-app").needs;
      const bar = list.bulkBar;
      const controls = [...bar.querySelectorAll("button, label.select-target")].filter((node) => node.getClientRects().length);
      const rowBoxes = [...list.querySelectorAll(".select-target")].map((node) => node.getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        toolbarFits: bar.toolbar.scrollWidth <= bar.toolbar.clientWidth && bar.toolbar.getBoundingClientRect().right <= innerWidth,
        // Compared in whole CSS pixels: after the runner's earlier zoom and
        // page-scale emulation, a 48px min-height can lay out at 47.99x.
        targets: controls.every((node) => Math.round(node.getBoundingClientRect().height) >= 48) &&
          rowBoxes.every((box) => Math.round(box.height) >= 48 && Math.round(box.width) >= 48),
        small: [...controls, ...list.querySelectorAll(".select-target")].map((node) => ({ node, box: node.getBoundingClientRect() }))
          .filter(({ box }) => box.height < 48 || (box.width < 48 && box.width > 0)).slice(0, 4)
          .map(({ node, box }) => `${node.className || node.tagName}:${node.textContent.slice(0, 30)}:${box.width.toFixed(3)}x${box.height.toFixed(3)}`),
      };
    });
    check(!narrow.overflow && narrow.toolbarFits && narrow.targets, "320px: the toolbar wraps without overflow and targets stay 48px", narrow);
    if (narrow.small.length) metrics.push(`NOTE bulk 320px subpixel targets: ${narrow.small.join(", ")}`);
    await setMedia(client, [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }]);
    const forced = await page(() => {
      const list = document.querySelector("kin-app").needs;
      const toolbar = getComputedStyle(list.bulkBar.toolbar);
      const row = getComputedStyle(list.querySelector(".select-control:checked").closest(".item-row"));
      return { forced: matchMedia("(forced-colors: active)").matches, border: toolbar.borderTopStyle !== "none", outline: row.outlineStyle !== "none",
        motion: matchMedia("(prefers-reduced-motion: reduce)").matches && parseFloat(row.transitionDuration || "0") <= 0.0001 };
    });
    check(forced.forced && forced.border && forced.outline && forced.motion, "forced colours keep the toolbar and checked rows visible; reduced motion adds no animation", forced);
    await setMedia(client);
    await viewport(1280, 900, false);
    await page(() => document.querySelector("kin-app").needs.clearSelection());

    // --- Offline, reload, and persistence ------------------------------------
    await client.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await page(() => window.dispatchEvent(new Event("offline")));
    await tick([a, b]);
    await runAction("complete");
    state = await bar();
    check(state.result === "2 items completed." && !/sync/i.test(state.result), "offline bulk completion saves locally and does not claim sync", state);
    before = await eventCount();
    await runAction("undo");
    state = await bar();
    check(state.result === "Undid 2 items." && (await statusOf([a, b])).every((status) => status === "active") && (await eventCount()) - before === 2,
      "offline undo verifies against the local encrypted log and reopens both items", state);
    await tick([a, b]);
    await runAction("complete");
    await client.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page(() => window.dispatchEvent(new Event("online")));
    const storage = await page((text) => JSON.stringify({ ...localStorage }).includes(text) || JSON.stringify({ ...sessionStorage }).includes(text), `Bulk A ${stamp}`);
    check(!storage, "no task text or undo payload reaches localStorage or sessionStorage");
    await client.send("Page.reload");
    await until(() => Boolean(document.querySelector("kin-app")?.security?.heading), "reloaded shell");
    await ready(client);
    await visit("lists/todo");
    await idle();
    const reloaded = await page(() => { const app = document.querySelector("kin-app"); return { undo: app.bulkUndo, mode: app.needs.selectionMode }; });
    check(JSON.stringify(await statusOf([a, b])) === JSON.stringify(["completed", "completed"]) && reloaded.undo === null && !reloaded.mode,
      "after reload the encrypted log replays the bulk change; undo and selection are not persisted", reloaded);
    await page((ids) => { const app = document.querySelector("kin-app"); return Promise.all([]).then(async () => { for (const id of ids) await app.ctx.append.appendCommand({ type: "reopen", itemId: id }); app.ctx.render.renderState(); }); }, [a, b]);
    await idle();

    // --- Lock during a batch, lock clears selection and undo ----------------
    await mode(true);
    await tick([a, b, d]);
    await gateAppends();
    await page(() => document.querySelector("kin-app").needs.bulkBar.complete.click());
    await until(() => window.__bulkGate.waiting.length === 1, "gated append before lock");
    await releaseOne();
    await until(() => window.__bulkGate.waiting.length === 1, "second gated append before lock");
    await page(() => document.querySelector("kin-app").ctx.session.lockHousehold());
    await ungate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lockedState = await page(() => { const app = document.querySelector("kin-app"); return { undo: app.bulkUndo, retry: app.bulkRetry, running: app.bulkRunning, locked: !app.vault }; });
    await ready(client);
    await visit("lists/todo");
    await idle();
    const afterLock = await page((ids) => {
      const app = document.querySelector("kin-app");
      const list = app.needs;
      return {
        mode: list.selectionMode, selected: list.selectedItemIds.length, result: list.bulkResult, undo: app.bulkUndo,
        statuses: ids.map((id) => app.state.items.find((item) => item.itemId === id)?.status),
      };
    }, [a, b, d]);
    check(lockedState.locked && lockedState.undo === null && lockedState.retry === null && !lockedState.running,
      "lock during a batch stops it and discards the undo and retry sets", lockedState);
    check(!afterLock.mode && afterLock.selected === 0 && afterLock.result === null && afterLock.undo === null && afterLock.statuses[0] === "completed" && afterLock.statuses[2] === "active",
      "after unlock the selection and undo are gone; the change committed before the lock stays committed, unsent ones never ran", afterLock);
    const staleUndo = await page(async () => {
      const app = document.querySelector("kin-app");
      const before = (await app.store.getCatchUpState()).events.length;
      app.bulkUndo = { list: app.needs, action: "complete", changes: [{ itemId: "x", to: "completed", changedAt: 1 }], generation: app.securityGeneration - 1 };
      app.needs.bulkAction("bulk-undo");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const after = (await app.store.getCatchUpState()).events.length;
      app.bulkUndo = null;
      return after === before;
    });
    check(staleUndo, "an undo from a previous session (lock, logout, or household switch) is refused");

    // The session ends while undo is reading the log: whether the read fails
    // as locked or with a storage error, nothing reaches the next session.
    for (const code of ["locked", "storage"]) {
      await mode(true);
      await tick([b]);
      await runAction("complete");
      before = await eventCount();
      await page((code) => {
        const app = document.querySelector("kin-app");
        window.__readOriginal = app.ctx.refresh.readAuthoritativeState;
        app.ctx.refresh.readAuthoritativeState = async function () {
          app.ctx.session.lockHousehold();
          throw Object.assign(new Error("read ended by lock"), { code });
        };
        app.needs.bulkBar.undo.click();
      }, code);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const duringLock = await page(() => {
        const app = document.querySelector("kin-app");
        app.ctx.refresh.readAuthoritativeState = window.__readOriginal;
        delete window.__readOriginal;
        return { locked: !app.vault, undo: app.bulkUndo, running: app.bulkRunning, result: app.needs.bulkResult };
      });
      await ready(client);
      await visit("lists/todo");
      await idle();
      const afterUnlock = await page((id) => {
        const app = document.querySelector("kin-app");
        return { undo: app.bulkUndo, result: app.needs.bulkResult, status: app.state.items.find((item) => item.itemId === id)?.status };
      }, b);
      check(duringLock.locked && duringLock.undo === null && !duringLock.running && duringLock.result === null &&
        afterUnlock.undo === null && afterUnlock.result === null && afterUnlock.status === "completed" && (await eventCount()) === before,
      `a ${code} read failure across a lock cancels undo without updating the next session`, { duringLock, afterUnlock });
      await page(async (id) => { const app = document.querySelector("kin-app"); await app.ctx.append.appendCommand({ type: "reopen", itemId: id }); app.ctx.render.renderState(); }, b);
      await idle();
    }
    await page((ids) => Promise.resolve().then(async () => { const app = document.querySelector("kin-app"); for (const id of ids) if (app.state.items.find((item) => item.itemId === id)?.status === "completed") await app.ctx.append.appendCommand({ type: "reopen", itemId: id }); app.ctx.render.renderState(); }), [a, b, d]);
    await idle();
  } finally {
    await ungate().catch(() => {});
    await restoreReads().catch(() => {});
    await client.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await setMedia(client).catch(() => {});
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await page(() => { const app = document.querySelector("kin-app"); for (const list of [app?.needs, app?.shopping]) list?.setSelectionMode?.(false); app?.clearBulkOutcome?.(); window.scrollTo(0, 0); }).catch(() => {});
  }
  for (const line of metrics) console.log(line);
  return `PASS bulk actions (${passed.length} checks): keyboard selection, select all/clear, bulk complete/reopen, rapid repeats, partial failure and retry, undo and partial undo, remote-conflict undo, fail-closed undo on unreadable log, ineligible ids, reconciliation, Quick add/palette/details, navigation mid-batch, Shopping, 320px, forced colours, offline undo, reload, lock mid-batch and mid-undo`;
}
