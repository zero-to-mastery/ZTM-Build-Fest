// The family fridge in a real browser (#317): the real WASM engine and real
// IndexedDB behind a board room that stays offline (this harness has no sync
// service), real pointer input through the DevTools protocol, and the door's
// layout on a phone, a tablet and a desktop.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";

const MEMBER = "a1".repeat(16);
const HOUSEHOLD = "f1".repeat(16);

export async function fridgeRegressions(client, until) {
  const page = (expression) => client.evaluate(expression);
  const strokes = () => page(`window.__fridgeRoom.board().strokes.length`);

  // Without sync there's no room: no tools that look usable, and the line
  // under the board says how to turn sync on (#372).
  const unsynced = await page(`(async () => {
    const app = document.querySelector("kin-app");
    if (app.fridge.room) return null;
    location.hash = "#household/fridge";
    app.ctx.navigation.showPageFromLocation();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const fridge = app.fridge;
    return { tools: fridge.querySelector(".fridge-tools").hidden, link: fridge.querySelector(".fridge-summary a")?.getAttribute("href") ?? null };
  })()`);
  if (unsynced) assert.deepEqual(unsynced, { tools: true, link: "#household/people" }, "an unsynced fridge hides its tools and links to sync: " + JSON.stringify(unsynced));

  // A board room with this page's engine, a fresh household key and device
  // keys, and a request that always reports being offline.
  await page(`(async () => {
    const app = document.querySelector("kin-app");
    const { BoardRoom } = await import("/board/board-room.js");
    const { generateHouseholdKey, generateDeviceKeys } = await import("/sync/crypto.js");
    const householdKey = await generateHouseholdKey();
    const keys = await generateDeviceKeys();
    const offline = async () => { throw Object.assign(new Error("Household sync could not be reached."), { code: "connection_unavailable" }); };
    window.__fridgeOptions = {
      identity: { householdId: "${HOUSEHOLD}", memberId: "${MEMBER}", deviceId: "${"d1".repeat(16)}" },
      keyStore: { vault: { assertUnlocked() {} }, getEpoch: async (_, epoch) => epoch === 1 ? { keyEpoch: 1, householdKey } : null, listEpochs: async () => [{ keyEpoch: 1, householdKey }] },
      deviceKeys: { keys }, request: offline,
    };
    const room = await BoardRoom.open({ ...window.__fridgeOptions, engine: app.engine });
    window.__fridgeRoom = room;
    app.fridge.memberId = "${MEMBER}";
    app.fridge.room = room;
    location.hash = "#household/fridge";
    app.ctx.navigation.showPageFromLocation();
    return true;
  })()`);

  // A new size takes effect in steps: layout, then the fridge's media-query
  // listener choosing the side rail or not (an asynchronous "change" event).
  // Measuring before that has settled found the door where it used to be
  // (#327), so every resize waits for both.
  const resize = async (metrics) => {
    await setViewport(client, metrics);
    await until(() => page(`(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const { KITCHEN_QUERY } = await import("/board/fridge-view.js");
      const fridge = document.querySelector("kin-fridge");
      const rail = matchMedia(KITCHEN_QUERY).matches ||
        (document.fullscreenElement === fridge && matchMedia("(orientation: landscape)").matches);
      return (fridge.dataset.layout === "rail") === rail;
    })()`));
  };

  // The tap targets matching `selector` that are under 44px tall, measured
  // once the fridge has stopped moving (#754). A size change, a view arriving
  // or a button's hover or press settling all animate a transform, and
  // getBoundingClientRect measures through it: a 44px tool came back under
  // 44 on the tablet. So: fonts loaded, the fridge's (and its ancestors')
  // animations and transitions finished, and two frames in a row that agree,
  // within a time limit. Each small target is reported with what it measured,
  // so a failure says which tool, how tall, and why.
  const smallTargets = (selector) => page(`(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const deadline = performance.now() + 2000;
    await document.fonts?.ready;
    const fridge = document.querySelector("kin-fridge");
    const touches = (animation) => {
      const target = animation.effect?.target;
      return Boolean(target) && (fridge.contains(target) || target.contains(fridge));
    };
    const moving = () => document.getAnimations().filter((animation) => animation.playState === "running" && touches(animation));
    while (moving().length && performance.now() < deadline) await frame();
    const targets = () => [...document.querySelectorAll(${JSON.stringify(selector)})].filter((b) => !b.hidden && b.getClientRects().length);
    const heights = () => targets().map((b) => b.getBoundingClientRect().height).join();
    let before = heights();
    for (;;) {
      await frame();
      const after = heights();
      if (after === before || performance.now() >= deadline) break;
      before = after;
    }
    // A transformed box's rect is mapped in floating point; a hundredth of
    // a pixel under 44 is rounding, not a smaller target.
    return targets().filter((b) => b.getBoundingClientRect().height < 43.99).map((b) => {
      const style = getComputedStyle(b);
      return {
        tool: b.textContent || b.getAttribute("aria-label"),
        height: b.getBoundingClientRect().height,
        layoutHeight: b.offsetHeight,
        minHeight: style.minHeight,
        transform: style.transform,
        hover: b.matches(":hover"),
        active: b.matches(":active"),
        moving: moving().map((animation) => (animation.animationName ?? animation.transitionProperty ?? "animation") + " on " + (animation.effect.target.className || animation.effect.target.localName)),
        layout: fridge.dataset.layout ?? "stacked",
      };
    });
  })()`);

  const door = () => page(`(() => {
    const rect = document.querySelector("kin-fridge .fridge-door").getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right };
  })()`);
  const at = (rect, fx, fy) => ({ x: Math.round(rect.left + rect.width * fx), y: Math.round(rect.top + rect.height * fy) });

  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  // ---- Layout on a phone, a tablet and a desktop ---------------------------
  for (const [label, metrics] of [
    ["phone", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }],
    ["tablet", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
  ]) {
    await resize(metrics);
    await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
    const rect = await door();
    const layout = await page(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth })`);
    const small = await smallTargets("kin-fridge .fridge-tools button");
    assert.ok(Math.abs(rect.width / rect.height - 0.75) < 0.01, `${label}: the door keeps its 3:4 shape (${rect.width}×${rect.height})`);
    assert.ok(rect.width >= 240 && rect.right <= layout.innerWidth, `${label}: the door fits the screen`);
    assert.ok(layout.scrollWidth <= layout.innerWidth, `${label}: no horizontal scroll`);
    assert.deepEqual(small, [], `${label}: every visible tool is at least 44px tall; under 44px: ${JSON.stringify(small)}`);
  }

  // ---- Kitchen-screen mode (#324) ------------------------------------------
  const kitchen = () => page(`(() => {
    const fridge = document.querySelector("kin-fridge");
    const door = fridge.querySelector(".fridge-door").getBoundingClientRect();
    const tools = fridge.querySelector(".fridge-tools").getBoundingClientRect();
    const note = fridge.querySelector(".fridge-kitchen-note");
    return { rail: fridge.dataset.layout === "rail", doorLeft: door.left, doorTop: door.top, doorHeight: door.height, doorBottom: door.bottom,
      ratio: door.width / door.height, toolsRight: tools.right, toolsTop: tools.top,
      note: note.hidden ? "" : note.textContent, innerHeight, innerWidth, scrollWidth: document.documentElement.scrollWidth,
      fullscreen: document.fullscreenElement === fridge, status: fridge.querySelector(".fridge-status").textContent };
  })()`);
  for (const [label, metrics] of [
    ["tablet landscape", { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true }],
    ["large tablet landscape", { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true }],
  ]) {
    await resize(metrics);
    await page(`document.querySelector("kin-fridge").scrollIntoView({ block: "start" })`);
    const view = await kitchen();
    assert.ok(view.rail, `${label}: a coarse-pointer landscape screen gets the side rail`);
    assert.ok(view.toolsRight <= view.doorLeft, `${label}: the tools sit beside the door, not above it`);
    assert.ok(Math.abs(view.ratio - 0.75) < 0.01, `${label}: the door keeps its 3:4 shape`);
    // Beside the app's navigation the door can be width-bound; it still
    // takes most of the height, far more than the stacked layout gives.
    assert.ok(view.doorHeight >= view.innerHeight * 0.75, `${label}: the door takes the height (${view.doorHeight} of ${view.innerHeight})`);
    assert.ok(view.scrollWidth <= view.innerWidth, `${label}: no horizontal scroll`);
    assert.match(view.note, /lock/i, `${label}: the screen says how it locks`);
  }
  await resize({ width: 768, height: 1024, deviceScaleFactor: 2, mobile: true });
  assert.equal((await kitchen()).rail, false, "a portrait tablet keeps the stacked layout");

  // Full screen shows the fridge alone; locking leaves it. The page's
  // full-screen API is stood in for: a real full-screen window outlives this
  // check and can stall tabs the regression opens later (#327).
  await resize({ width: 1024, height: 768, deviceScaleFactor: 2, mobile: true });
  const full = await page(`(async () => {
    const fridge = document.querySelector("kin-fridge");
    let element = null;
    const change = () => document.dispatchEvent(new Event("fullscreenchange"));
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
    fridge.requestFullscreen = async () => { element = fridge; change(); };
    const exit = document.exitFullscreen;
    document.exitFullscreen = async () => { element = null; change(); };
    fridge.querySelector(".fridge-fullscreen").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const inside = { fullscreen: document.fullscreenElement === fridge, label: fridge.querySelector(".fridge-fullscreen").textContent,
      rail: fridge.dataset.layout === "rail", note: fridge.querySelector(".fridge-kitchen-note").hidden ? "" : fridge.querySelector(".fridge-kitchen-note").textContent };
    const app = document.querySelector("kin-app");
    app.fridge.room = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterLock = document.fullscreenElement === fridge;
    app.fridge.room = window.__fridgeRoom;
    delete fridge.requestFullscreen;
    document.exitFullscreen = exit;
    delete document.fullscreenElement;
    return { ...inside, afterLock, label2: fridge.querySelector(".fridge-fullscreen").textContent };
  })()`);
  assert.deepEqual([full.fullscreen, full.label, full.rail], [true, "Leave full screen", true], "full screen in landscape uses the rail");
  assert.match(full.note, /lock/i, "full screen says how it locks");
  assert.equal(full.afterLock, false, "locking leaves full screen");
  assert.equal(full.label2, "Full screen");

  // ---- Drawing with a finger (phone) -------------------------------------
  await resize({ width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
  let rect = await door();
  const touch = (type, points) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ ...p, id })) });
  const start = at(rect, 0.2, 0.2);
  await touch("touchStart", [start]);
  for (let step = 1; step <= 10; step += 1) await touch("touchMove", [{ x: start.x + step * 8, y: start.y + step * 5 }]);
  await touch("touchEnd", []);
  await until(async () => (await strokes()) === 1);
  const inked = await page(`(() => {
    const canvas = document.querySelector("kin-fridge .fridge-ink");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
    return false;
  })()`);
  assert.equal(inked, true, "the stroke is drawn on the door");
  assert.match(await page(`document.querySelector("kin-fridge .fridge-summary").textContent`), /^1 drawing by you\. Waiting to send\./);

  // A second finger turns the stroke into a gesture: nothing is drawn.
  const second = at(rect, 0.5, 0.5);
  await touch("touchStart", [second]);
  await touch("touchMove", [{ x: second.x + 20, y: second.y + 20 }]);
  await touch("touchStart", [{ x: second.x + 20, y: second.y + 20 }, { x: second.x + 80, y: second.y }]);
  await touch("touchMove", [{ x: second.x + 30, y: second.y + 30 }, { x: second.x + 90, y: second.y + 10 }]);
  await touch("touchEnd", []);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await strokes(), 1, "a second finger cancels the stroke");

  // ---- A pen with a palm resting on the screen ----------------------------
  await resize({ width: 1024, height: 768, deviceScaleFactor: 2, mobile: true });
  await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
  rect = await door();
  const pen = (type, point, buttons = 1) => client.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons, clickCount: 1, pointerType: "pen" });
  const penAt = at(rect, 0.3, 0.6);
  await pen("mousePressed", penAt);
  const palm = at(rect, 0.8, 0.9);
  await touch("touchStart", [palm]);
  for (let step = 1; step <= 6; step += 1) {
    await pen("mouseMoved", { x: penAt.x + step * 10, y: penAt.y });
    await touch("touchMove", [{ x: palm.x - step * 3, y: palm.y }]);
  }
  await touch("touchEnd", []);
  await pen("mouseReleased", { x: penAt.x + 60, y: penAt.y }, 0);
  await until(async () => (await strokes()) === 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await strokes(), 2, "the pen draws; the palm does not");

  // ---- Eraser, undo and redo (desktop mouse) -------------------------------
  await resize({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
  rect = await door();
  const mouse = (type, point, buttons = 1) => client.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons, clickCount: 1 });
  await page(`document.querySelector("kin-fridge .fridge-eraser").click()`);
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-eraser").getAttribute("aria-pressed")`), "true");
  // Rub straight across the middle of the pen stroke, wherever it was stored.
  const target = await page(`(() => {
    const board = window.__fridgeRoom.board();
    const stroke = board.strokes.at(-1);
    const middle = Math.floor(stroke.points.length / 4) * 2;
    const rect = document.querySelector("kin-fridge .fridge-door").getBoundingClientRect();
    return { id: stroke.id, x: Math.round(rect.left + (stroke.points[middle] / 4096) * rect.width), y: Math.round(rect.top + (stroke.points[middle + 1] / 5461) * rect.height) };
  })()`);
  await mouse("mousePressed", { x: target.x, y: target.y - 24 });
  for (let step = 1; step <= 8; step += 1) await mouse("mouseMoved", { x: target.x, y: target.y - 24 + step * 6 });
  await mouse("mouseReleased", { x: target.x, y: target.y + 24 }, 0);
  try {
    await until(async () => (await strokes()) === 1);
  } catch (error) {
    // Once (#469) the board came back empty, not with one stroke: say whether
    // the room was swapped or reset, or the events it read hide the strokes.
    // Asked first, as a closed room makes the board itself throw.
    const room = await page(`(() => {
      const app = document.querySelector("kin-app");
      const room = window.__fridgeRoom;
      const view = room.records.view();
      let kinds = null;
      try { kinds = room.engine.eventMetadataBatch(Array.from({ length: view.length }, (_, index) => view.record(index))).map((event) => event.kind); } catch (error) { kinds = String(error?.message ?? error); }
      return { shown: app.fridge.room === room, synced: app.syncCoordinator?.board === room, closed: room.closed, records: view.length, epoch: view.epoch,
        loadedOrder: room.loadedOrder, pending: room.pending.size, refused: room.refused.length, syncError: room.syncError?.code ?? null, kinds,
        sync: { state: app.syncState?.state ?? null, code: app.syncState?.code ?? null, coordinator: Boolean(app.syncCoordinator) } };
    })()`).catch((reason) => String(reason?.message ?? reason));
    const state = await page(`(() => {
      const fridge = document.querySelector("kin-fridge");
      return { tool: fridge.tool, stroke: fridge.stroke ? { pointerType: fridge.stroke.pointerType, erasing: Boolean(fridge.stroke.erasing) } : null, penDown: fridge.penDown,
        status: fridge.querySelector(".fridge-status").textContent, strokes: window.__fridgeRoom.board().strokes.map((s) => ({ id: s.id.slice(0, 6), points: [...s.points].slice(0, 8) })) };
    })()`).catch((reason) => String(reason?.message ?? reason));
    error.message += ` — eraser at ${JSON.stringify(target)}; fridge ${JSON.stringify(state)}; room ${JSON.stringify(room)}`;
    throw error;
  }
  await page(`document.querySelector("kin-fridge .fridge-history button:first-child").click()`);
  await until(async () => (await strokes()) === 2);
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-status").textContent`), "Erase undone.");
  await page(`document.querySelector("kin-fridge .fridge-history button:last-child").click()`);
  await until(async () => (await strokes()) === 1);
  await page(`document.querySelector("kin-fridge .fridge-colour").click()`);
  const tools = await page(`[...document.querySelectorAll("kin-fridge .fridge-tools button")].every((button) => button.tagName === "BUTTON" && button.getAttribute("aria-label") || button.textContent)`);
  assert.equal(tools, true, "every tool is a named button");

  // ---- Magnets (#322) ----------------------------------------------------
  const magnets = () => page(`window.__fridgeRoom.board().magnets.map((m) => ({ id: m.id, kind: m.kind, text: m.text, number: m.number, x: m.x, y: m.y }))`);
  const key = async (keyName, modifiers = 0) => {
    const code = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Delete: 46, Escape: 27 }[keyName];
    // Enter activates a button through its key press, so it carries text.
    const text = keyName === "Enter" ? { type: "keyDown", text: "\r", unmodifiedText: "\r" } : { type: "rawKeyDown" };
    await client.send("Input.dispatchKeyEvent", { ...text, key: keyName, code: keyName, windowsVirtualKeyCode: code, modifiers });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code: keyName, windowsVirtualKeyCode: code, modifiers });
  };
  // A note, put up at the top right through the dialog.
  await page(`(() => {
    document.querySelector("kin-fridge .fridge-add-magnet").click();
    const dialog = document.querySelector("kin-fridge .fridge-magnet-dialog");
    dialog.querySelector('input[name="fridge-magnet-kind"][value="note"]').click();
    const note = [...dialog.querySelectorAll('input[type="text"]')].find((input) => input.maxLength === 60);
    note.value = "  Milk please ";
    dialog.querySelector("select").value = "top-right";
    dialog.querySelector('button[type="submit"]').click();
    return true;
  })()`);
  await until(async () => (await magnets()).length === 1);
  const [note] = await magnets();
  assert.deepEqual({ kind: note.kind, text: note.text }, { kind: "note", text: "Milk please" }, "the note is trimmed and put up");
  assert.ok(note.x > 3000 && note.y < 1500, "at the top right");
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-magnet").getAttribute("aria-label")`), "Note: Milk please, put up by you");
  assert.equal(await page(`document.activeElement?.dataset.magnetId ?? null`), note.id, "focus goes to the new magnet");
  // Arrow keys move it 1% at a time and save once they settle.
  await key("ArrowLeft");
  await key("ArrowLeft");
  await key("ArrowDown", 8);
  await until(async () => (await magnets())[0].x < note.x);
  const moved = (await magnets())[0];
  assert.equal(moved.x, note.x - 82, "two 1% steps left");
  assert.equal(moved.y, note.y + 546, "one 10% step down with Shift");
  // Enter opens its menu; Move to puts it in a named place.
  await key("Enter");
  await until(() => page(`Boolean(document.querySelector("kin-fridge .fridge-magnet-menu select"))`));
  await page(`(() => { const select = document.querySelector("kin-fridge .fridge-magnet-menu select"); select.value = "bottom-left"; select.dispatchEvent(new Event("change")); return true; })()`);
  assert.equal(await page(`Boolean(document.querySelector("kin-fridge .fridge-magnet-menu"))`), true, "choosing a place alone doesn't move the magnet");
  await page(`document.querySelector("kin-fridge .fridge-magnet-move").click(), true`);
  await until(async () => (await magnets())[0].y > 4000);
  assert.ok((await magnets())[0].x < 1000, "moved to the bottom left");
  // A Kin-drawn magnet in the middle, then dragged with a mouse.
  await page(`(() => {
    document.querySelector("kin-fridge .fridge-add-magnet").click();
    const dialog = document.querySelector("kin-fridge .fridge-magnet-dialog");
    dialog.querySelector('input[name="fridge-magnet-kind"][value="kin"]').click();
    dialog.querySelector('input[name="fridge-kin-magnet"][value="2"]').click();
    dialog.querySelector("select").value = "middle";
    dialog.querySelector('button[type="submit"]').click();
    return true;
  })()`);
  await until(async () => (await magnets()).length === 2);
  const star = (await magnets()).find((magnet) => magnet.kind === "kin");
  assert.equal(star.number, 2);
  rect = await door();
  const from = await page(`(() => { const r = document.querySelector('kin-fridge [data-magnet-id="${star.id}"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await mouse("mousePressed", from);
  for (let step = 1; step <= 8; step += 1) await mouse("mouseMoved", { x: from.x + step * 10, y: from.y - step * 10 });
  await mouse("mouseReleased", { x: from.x + 80, y: from.y - 80 }, 0);
  await until(async () => (await magnets()).find((magnet) => magnet.id === star.id).x > star.x);
  assert.ok((await magnets()).find((magnet) => magnet.id === star.id).y < star.y, "dragged up and right");
  assert.equal(await strokes(), 1, "dragging a magnet draws nothing");
  // Delete takes the focused magnet down; Undo puts it back.
  await page(`document.querySelector('kin-fridge [data-magnet-id="${star.id}"]').focus()`);
  await key("Delete");
  await until(async () => (await magnets()).length === 1);
  await page(`document.querySelector("kin-fridge .fridge-history button:first-child").click()`);
  await until(async () => (await magnets()).length === 2);

  // ---- Clearing (#323) ---------------------------------------------------
  await page(`document.querySelector("kin-fridge .fridge-clear").click()`);
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-clear-dialog").open`), true, "clearing asks first");
  assert.equal(await page(`document.activeElement?.textContent`), "Keep it", "the safe choice has focus");
  await page(`document.querySelector("kin-fridge .fridge-clear-dialog .danger-action").click()`);
  await until(async () => (await strokes()) === 0 && (await magnets()).length === 0);
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-restore").hidden`), false, "anyone can bring it back");
  await page(`document.querySelector("kin-fridge .fridge-restore").click()`);
  await until(async () => (await strokes()) === 1 && (await magnets()).length === 2);
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-restore").hidden`), true);

  // After a lock, the stored log decrypts and replays to the same fridge.
  const reopened = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const before = window.__fridgeRoom.board().strokes.map((stroke) => stroke.id).join();
    window.__fridgeRoom.close();
    const { BoardRoom } = await import("/board/board-room.js");
    const room = await BoardRoom.open({ ...window.__fridgeOptions, engine: app.engine });
    window.__fridgeRoom = room;
    app.fridge.room = room;
    return { before, after: room.board().strokes.map((stroke) => stroke.id).join(), waiting: room.waiting };
  })()`);
  assert.equal(reopened.after, reopened.before, "the reopened fridge matches");
  assert.equal(reopened.waiting, true, "unsent changes are still waiting");

  // ---- Acceptance (#325): more screens, 200% zoom, dark and forced colours --
  await page(`(async () => {
    const { newBoardId } = await import("/board/board-room.js");
    await window.__fridgeRoom.change({ type: "add-stroke", strokeId: newBoardId(), colour: 5, width: 2, points: [[400, 400], [1600, 1400], [2600, 900]] });
    return true;
  })()`);
  for (const [label, metrics] of [
    ["320×568", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }],
    ["phone landscape", { width: 844, height: 390, deviceScaleFactor: 3, mobile: true }],
    ["820×1180", { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true }],
    ["1024×768", { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true }],
    // 200% browser zoom on a 1280×800 desktop: half the CSS pixels.
    ["desktop at 200%", { width: 640, height: 400, deviceScaleFactor: 2, mobile: false }],
  ]) {
    await resize(metrics);
    // Let the new size lay out before measuring.
    await page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
    const rect = await door();
    const layout = await page(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth })`);
    const small = await smallTargets("kin-fridge .fridge-tools button, kin-fridge > .fridge-fullscreen");
    assert.ok(Math.abs(rect.width / rect.height - 0.75) < 0.01, `${label}: the door keeps its 3:4 shape (${rect.width}×${rect.height})`);
    assert.ok(rect.width >= 240 && rect.right <= layout.innerWidth, `${label}: the door fits the screen (${JSON.stringify(rect)} in ${layout.innerWidth})`);
    assert.ok(layout.scrollWidth <= layout.innerWidth, `${label}: no horizontal scroll`);
    assert.deepEqual(small, [], `${label}: every visible control is at least 44px tall; under 44px: ${JSON.stringify(small)}`);
  }
  const inkCheck = () => page(`(async () => {
    // Two frames, so a changed appearance has been styled and painted.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fridge = document.querySelector("kin-fridge");
    fridge.drawInk();
    const canvas = fridge.querySelector(".fridge-ink");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let inked = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) inked += 1;
    // Reduced motion shortens every animation and transition to 0.01 ms
    // (app.css); count only motion that lasts long enough to be seen.
    const moving = document.getAnimations().filter((animation) => fridge.contains(animation.effect?.target ?? null) &&
      (animation.effect?.getComputedTiming?.().activeDuration ?? 0) > 1).length;
    return { inked, palette: fridge.palette(), door: getComputedStyle(fridge.querySelector(".fridge-door")).getPropertyValue("--fridge-door").trim(), moving };
  })()`);
  await resize({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // Measured against light, not the machine's own appearance (#795).
  await setMedia(client);
  const light = await inkCheck();
  // Kin's own dark appearance (the page may have pinned light), then back.
  const appearance = await page(`document.documentElement.dataset.kinAppearance ?? null`);
  await page(`(document.documentElement.dataset.kinAppearance = "dark", true)`);
  const dark = await inkCheck();
  const darkFacts = await page(`(() => {
    const fridges = document.querySelectorAll("kin-fridge");
    const fridge = fridges[0];
    let rule = "none";
    for (const sheet of document.styleSheets) {
      try { for (const entry of sheet.cssRules) if (entry.selectorText === ':root[data-kin-appearance="dark"] kin-fridge') rule = sheet.href ?? "inline"; } catch { rule = "unreadable"; }
    }
    return { attribute: document.documentElement.getAttribute("data-kin-appearance"), fridges: fridges.length,
      matches: fridge.matches(':root[data-kin-appearance="dark"] kin-fridge'), door: getComputedStyle(fridge).getPropertyValue("--fridge-door"),
      rule, sheets: [...document.styleSheets].map((sheet) => sheet.href ?? "inline").join(" "), adopted: document.adoptedStyleSheets.length };
  })()`);
  await page(`(${JSON.stringify(appearance)} === null ? delete document.documentElement.dataset.kinAppearance : document.documentElement.dataset.kinAppearance = ${JSON.stringify(appearance)}, true)`);
  // The door's own colour variable (its background is var(--fridge-door));
  // headless Edge has reported a stale computed background here.
  assert.notEqual(dark.door, light.door, `dark mode darkens the door (${JSON.stringify(darkFacts)}; was ${JSON.stringify(appearance)})`);
  assert.notDeepEqual(dark.palette, light.palette, "dark mode remaps the ink colours");
  assert.ok(dark.inked > 0, "drawings stay visible in dark mode");
  // Going back to light fades the fridge's buttons back (#795); let those
  // fades end, so the next check counts only motion under reduced motion.
  await page(`Promise.all(document.getAnimations().filter((animation) => document.querySelector("kin-fridge").contains(animation.effect?.target ?? null))
    .map((animation) => animation.finished.catch(() => {}))).then(() => true)`);
  await setMedia(client, [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }]);
  const forced = await inkCheck();
  assert.ok(forced.palette.every((colour) => colour === "CanvasText"), "forced colours draw every ink in the system text colour");
  assert.ok(forced.inked > 0, "drawings stay visible in forced colours");
  assert.equal(forced.moving, 0, "nothing on the fridge moves with reduced motion");
  await setMedia(client);

  // Clean up: no room, no fridge database left behind for later checks.
  await page(`(async () => {
    const app = document.querySelector("kin-app");
    app.fridge.room = null;
    window.__fridgeRoom?.close();
    delete window.__fridgeRoom;
    delete window.__fridgeOptions;
    await new Promise((resolve) => { const request = indexedDB.deleteDatabase("kin-board-log:${HOUSEHOLD}"); request.onsuccess = request.onerror = request.onblocked = resolve; });
    location.hash = "#today";
    app.ctx.navigation.showPageFromLocation();
    return true;
  })()`);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await client.send("Emulation.clearDeviceMetricsOverride");
  return "PASS fridge: 3:4 door fits phone, tablet and desktop; finger, pen and mouse drawing; second-finger cancel; palm rejection; eraser, undo and redo; magnets by dialog, keyboard, menu and drag; clear and bring back; kitchen-screen rail, full screen and its lock note; 320×568 to desktop, 200% zoom, dark mode, forced colours and reduced motion, through the real engine (#317, #324, #325)";
}
