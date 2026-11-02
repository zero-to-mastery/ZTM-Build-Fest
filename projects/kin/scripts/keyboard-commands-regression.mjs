import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import assert from "node:assert/strict";

// Keyboard shortcuts and the command palette, driven by real CDP key events in
// the unlocked workspace. Synthetic events are used only where a browser
// cannot produce the state from a key press (IME composition on a
// non-editable target, an open shadow root built for the test).
export async function keyboardCommandRegressions(client, { visit, ready }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  const check = (condition, message, detail = null) => { assert.ok(condition, `${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`); passed.push(message); };
  const until = async (fn, label, ...args) => {
    for (let index = 0; index < 200; index++) {
      const value = await page(fn, ...args);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Keyboard commands timed out: ${label}`);
  };
  const settle = () => page(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  const idle = () => until(() => { const app = document.querySelector("kin-app"); return Boolean(app?.state) && !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending; }, "idle");
  const KEYS = {
    k: { key: "k", code: "KeyK", windowsVirtualKeyCode: 75 },
    n: { key: "n", code: "KeyN", windowsVirtualKeyCode: 78, text: "n" },
    slash: { key: "/", code: "Slash", windowsVirtualKeyCode: 191, text: "/" },
    question: { key: "?", code: "Slash", windowsVirtualKeyCode: 191, text: "?", modifiers: 8 },
    escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  };
  const press = async (spec, extra = {}) => {
    const { text, ...rest } = { ...spec, ...extra };
    await client.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...rest, ...(text ? { text, unmodifiedText: text } : {}) });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...rest });
    await settle();
  };
  const ctrlK = () => press(KEYS.k, { modifiers: 2 });
  const cmdK = () => press(KEYS.k, { modifiers: 4 });
  const type = async (text) => { await client.send("Input.insertText", { text }); await settle(); };
  const viewport = async (width, height, mobile) => {
    await setViewport(client, { width, height, deviceScaleFactor: 1, mobile });
    await settle();
  };
  // Focus a stable, non-editable starting point: the current page heading.
  const focusHeading = () => page(() => {
    const heading = document.querySelector("kin-app").main.querySelector(".app-view:not([hidden]) h1");
    heading.focus();
    return document.activeElement === heading;
  });
  const snapshot = () => page(() => {
    const app = document.querySelector("kin-app");
    const palette = app.commandPalette;
    const active = document.activeElement;
    return {
      hash: location.hash,
      paletteOpen: palette.palette.open,
      helpOpen: palette.help.open,
      quickAddOpen: app.quickAdd.dialog.open,
      openDialogs: document.querySelectorAll("dialog[open]").length,
      focus: active?.id || active?.className || active?.tagName,
      focusText: active?.textContent?.trim().slice(0, 40) ?? "",
      inPalette: palette.palette.contains(active),
      query: palette.input.value,
      options: [...palette.list.querySelectorAll("[role='option']")].map((option) => option.dataset.command),
      selected: palette.list.querySelector("[aria-selected='true']")?.dataset.command ?? null,
      activeDescendant: palette.input.getAttribute("aria-activedescendant"),
      status: palette.count.textContent,
    };
  });
  const closeAll = () => page(() => {
    const app = document.querySelector("kin-app");
    app.commandPalette.dismiss();
    if (app.quickAdd.dialog.open) app.quickAdd.reset();
    app.ctx.detail.closeItemDetail({ restoreFocus: false });
  });

  try {
    await viewport(1280, 900, false);
    await visit("today");
    await idle();
    check(await focusHeading(), "setup: Today heading takes focus");

    // --- Ctrl/Cmd+K -------------------------------------------------------
    await ctrlK();
    let state = await snapshot();
    const semantics = await page(() => {
      const palette = document.querySelector("kin-app").commandPalette;
      const dialog = palette.palette;
      const input = palette.input;
      return {
        modal: dialog.matches(":modal"),
        title: document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent,
        role: input.getAttribute("role"),
        label: input.labels?.[0]?.textContent,
        controls: input.getAttribute("aria-controls") === palette.list.id,
        expanded: input.getAttribute("aria-expanded"),
        listRole: palette.list.getAttribute("role"),
        listLabel: palette.list.getAttribute("aria-label"),
        optionRoles: [...palette.list.children].every((option) => option.getAttribute("role") === "option" && option.tabIndex < 0),
        hint: document.getElementById(input.getAttribute("aria-describedby"))?.textContent,
      };
    });
    check(state.paletteOpen && state.inPalette && state.focus === "command-palette-input" && state.options.length === 6 &&
      state.selected === "today" && state.activeDescendant === "command-option-today",
    "Ctrl+K opens the palette with focus in its search field and the first command active", state);
    check(semantics.modal && semantics.title === "Commands" && semantics.role === "combobox" && semantics.label === "Search commands" &&
      semantics.controls && semantics.expanded === "true" && semantics.listRole === "listbox" && semantics.listLabel === "Commands" &&
      semantics.optionRoles && semantics.hint.includes("Escape"),
    "palette is a labelled modal dialog with a combobox controlling a listbox of non-tabbable options", semantics);
    await ctrlK();
    state = await snapshot();
    check(state.paletteOpen && state.openDialogs === 1 && state.inPalette, "repeated Ctrl+K never stacks a second overlay", state);
    await press(KEYS.escape);
    state = await snapshot();
    check(!state.paletteOpen && state.openDialogs === 0 && state.focus === "today-title", "Escape closes the palette and restores focus to the original trigger", state);

    await cmdK();
    state = await snapshot();
    check(state.paletteOpen && state.inPalette, "Cmd+K opens the palette", state);
    await press(KEYS.escape);

    // --- Filtering and keyboard selection --------------------------------
    await ctrlK();
    await type("shop");
    state = await snapshot();
    check(state.options.join() === "shopping" && state.selected === "shopping" && state.status === "1 command available.",
      "typing filters commands and announces the result count", state);
    await type("zzz");
    const empty = await page(() => {
      const palette = document.querySelector("kin-app").commandPalette;
      return { emptyVisible: !palette.empty.hidden && palette.empty.getClientRects().length > 0, text: palette.empty.textContent,
        listHidden: palette.list.hidden, expanded: palette.input.getAttribute("aria-expanded"), status: palette.count.textContent,
        statusRole: palette.count.getAttribute("role") };
    });
    state = await snapshot();
    check(empty.emptyVisible && empty.text.startsWith("No commands match") && empty.listHidden && empty.expanded === "false" &&
      empty.status === "No commands match." && empty.statusRole === "status" && state.activeDescendant === null,
    "an empty result is visible and announced, with no active descendant", { ...empty, state });
    await press(KEYS.enter);
    await press(KEYS.down);
    state = await snapshot();
    check(state.paletteOpen && state.hash === "#today", "Enter and arrows do nothing when no command matches", state);
    await page(() => { const input = document.querySelector("kin-app").commandPalette.input; input.value = ""; input.dispatchEvent(new Event("input")); });
    await press(KEYS.down);
    check((await snapshot()).selected === "todo", "Arrow Down moves to the next command");
    await press(KEYS.up);
    await press(KEYS.up);
    state = await snapshot();
    check(state.selected === "shortcuts" && state.activeDescendant === "command-option-shortcuts", "Arrow Up wraps to the last command", state);
    await press(KEYS.down);
    await press(KEYS.down);
    await press(KEYS.down);
    check((await snapshot()).selected === "shopping", "Arrow Down wraps back to the start");
    const visuals = await page(() => {
      const palette = document.querySelector("kin-app").commandPalette;
      const option = palette.list.querySelector("[aria-selected='true']");
      const style = getComputedStyle(option);
      return { outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2, inputFocusVisible: palette.input.matches(":focus-visible"),
        inputOutline: getComputedStyle(palette.input).outlineStyle !== "none" };
    });
    check(visuals.outline && visuals.inputFocusVisible && visuals.inputOutline, "the field shows a focus ring and the active option its own outline", visuals);
    await press(KEYS.tab, { modifiers: 8 });
    const shiftTab = await page(() => document.activeElement?.className);
    await press(KEYS.tab);
    state = await snapshot();
    check(shiftTab === "command-dialog-close" && state.focus === "command-palette-input",
      "Tab and Shift+Tab stay within the modal palette's own controls", { shiftTab, state });
    await press(KEYS.enter);
    await settle();
    state = await snapshot();
    const shoppingFocus = await page(() => ({ segment: document.activeElement?.dataset.segment, current: document.activeElement?.getAttribute("aria-current") }));
    check(!state.paletteOpen && state.hash === "#lists/shopping" && shoppingFocus.segment === "shopping" && shoppingFocus.current === "true",
      "Enter runs the active command: Shopping opens and focus moves to its current list link", { state, shoppingFocus });

    await ctrlK();
    await type("today");
    await press(KEYS.enter);
    state = await snapshot();
    check(state.hash === "#today" && state.focus === "today-title", "Go to Today navigates and focuses the Today heading", state);
    await ctrlK();
    await type("to do");
    await press(KEYS.enter);
    state = await snapshot();
    check(state.hash === "#lists/todo" && state.focusText === "To do", "Go to To do navigates and focuses the To do list link", state);
    await ctrlK();
    await type("search");
    await press(KEYS.enter);
    state = await snapshot();
    check(state.hash === "#search" && state.focus === "household-search-query", "Search household navigates and focuses the search field", state);
    await ctrlK();
    await page(() => document.querySelector("kin-app").commandPalette.list.querySelector("[data-command='today']").click());
    await settle();
    state = await snapshot();
    check(state.hash === "#today" && !state.paletteOpen && state.focus === "today-title", "pointer selection runs the same command", state);

    // Rapid double activation runs one command.
    const doubled = await page(async () => {
      const app = document.querySelector("kin-app");
      let runs = 0;
      const original = app.ctx.append.runWorkspaceCommand;
      app.ctx.append.runWorkspaceCommand = function (...args) { runs++; return original.apply(this, args); };
      app.commandPalette.openPalette({ opener: document.getElementById("today-title") });
      app.commandGeneration = app.securityGeneration;
      app.commandPalette.activate(0);
      app.commandPalette.activate(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      app.ctx.append.runWorkspaceCommand = original;
      return { runs, open: document.querySelectorAll("dialog[open]").length };
    });
    check(doubled.runs === 1 && doubled.open === 0, "repeated activation runs a command once and leaves no overlay", doubled);

    // --- Single-key shortcuts --------------------------------------------
    await visit("today");
    await focusHeading();
    await press(KEYS.slash);
    state = await snapshot();
    const searchValue = await page(() => document.getElementById("household-search-query").value);
    check(state.hash === "#search" && state.focus === "household-search-query" && searchValue === "", "/ opens Search with focus in an empty search field", { state, searchValue });

    const stamp = (await page(() => crypto.randomUUID())).slice(0, 6);
    const findable = `Keyboard findable ${stamp}`;
    await page(async (text) => {
      const app = document.querySelector("kin-app");
      await app.ctx.append.appendCommand({ type: "add", text, classification: "need" });
      app.ctx.render.renderState();
    }, findable);
    await idle();
    await page(() => document.getElementById("household-search-query").focus());
    await type(`findable ${stamp}`);
    await press(KEYS.n);
    state = await snapshot();
    const typed = await page(() => document.getElementById("household-search-query").value);
    check(!state.quickAddOpen && typed.endsWith("n") && state.hash === "#search", "N typed into the search field stays text, not a shortcut", { state, typed });
    await page(() => { const input = document.getElementById("household-search-query"); input.value = input.value.slice(0, -1); input.dispatchEvent(new Event("input")); });
    check(await page(() => document.querySelector("kin-app").search.querySelectorAll("[data-result-id]").length) === 1,
      "existing Search still finds household text after keyboard entry");
    await ctrlK();
    state = await snapshot();
    check(state.paletteOpen, "Ctrl+K opens the palette from inside the search field", state);
    await press(KEYS.escape);
    state = await snapshot();
    check(!state.paletteOpen && state.focus === "household-search-query", "closing the palette returns focus to the search field", state);

    await visit("today");
    await focusHeading();
    await press(KEYS.n);
    state = await snapshot();
    const quickValue = await page(() => document.querySelector("kin-app").quickAdd.input.value);
    check(state.quickAddOpen && state.focus === "quick-add-title-input" && quickValue === "", "N opens Quick add with focus in an empty title field", { state, quickValue });
    await ctrlK();
    state = await snapshot();
    check(state.quickAddOpen && !state.paletteOpen && state.openDialogs === 1 && state.focus === "quick-add-title-input",
      "Ctrl+K leaves an open Quick add and its draft in charge", state);
    await press(KEYS.question);
    state = await snapshot();
    check(!state.helpOpen && await page(() => document.querySelector("kin-app").quickAdd.input.value) === "?", "? typed in Quick add stays text", state);
    await press(KEYS.escape);
    state = await snapshot();
    check(!state.quickAddOpen && state.focus === "today-title", "Escape closes Quick add and focus returns to where N was pressed", state);

    // Quick add still saves through its own Enter handling.
    const quickTitle = `Keyboard quick add ${stamp}`;
    await press(KEYS.n);
    await type(quickTitle);
    await press(KEYS.enter);
    await idle();
    const saved = await page((text) => {
      const app = document.querySelector("kin-app");
      return { count: app.state.items.filter((item) => item.text === text).length, open: app.quickAdd.dialog.open, planned: app.state.items.find((item) => item.text === text)?.planningDate === app.ctx.navigation.currentCivilDate() };
    }, quickTitle);
    check(saved.count === 1 && !saved.open && saved.planned, "Quick add opened with N saves exactly one task for Today with Enter", saved);

    await focusHeading();
    await press(KEYS.question);
    state = await snapshot();
    const help = await page(() => {
      const palette = document.querySelector("kin-app").commandPalette;
      const dialog = palette.help;
      return {
        modal: dialog.matches(":modal"),
        title: document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent,
        focusTitle: document.activeElement === dialog.querySelector("h2"),
        rows: dialog.querySelectorAll(".shortcut-row").length,
        text: dialog.textContent,
        platforms: [...dialog.querySelectorAll(".shortcut-platform")].map((node) => node.textContent),
      };
    });
    check(state.helpOpen && help.modal && help.title === "Keyboard shortcuts" && help.focusTitle && help.rows === 9 &&
      ["Ctrl", "Cmd", "Esc", "Quick add a task", "Search household", "Open the command palette", "Undo your last change", "Redo what you undid"].every((text) => help.text.includes(text)) &&
      [...new Set(help.platforms)].join("|") === "Windows and Linux|Mac",
    "? opens a labelled shortcut help listing every shortcut with Windows/Linux and Mac modifiers", { state, help });
    await press(KEYS.escape);
    state = await snapshot();
    check(!state.helpOpen && state.focus === "today-title", "Escape closes the help and restores focus", state);

    await ctrlK();
    await type("keyboard");
    await press(KEYS.enter);
    state = await snapshot();
    check(state.helpOpen && !state.paletteOpen && state.openDialogs === 1, "the palette opens the shortcut help in its place", state);
    await ctrlK();
    state = await snapshot();
    check(state.paletteOpen && !state.helpOpen && state.openDialogs === 1, "Ctrl+K from the help swaps back to the palette", state);
    await press(KEYS.escape);
    state = await snapshot();
    check(state.openDialogs === 0 && state.focus === "today-title", "after swapping overlays, Escape still returns to the original trigger", state);

    await ctrlK();
    await type("quick");
    await press(KEYS.enter);
    state = await snapshot();
    check(state.quickAddOpen && !state.paletteOpen && state.focus === "quick-add-title-input", "the palette closes before Quick add opens", state);
    await press(KEYS.escape);
    state = await snapshot();
    check(!state.quickAddOpen && state.focus === "today-title", "Quick add opened from the palette returns focus to the original trigger", state);

    // --- Typing contexts, IME, repeat -------------------------------------
    const nested = await page(() => {
      const outer = document.createElement("div");
      outer.id = "shortcut-shadow-test";
      const outerRoot = outer.attachShadow({ mode: "open" });
      const inner = document.createElement("span");
      outerRoot.append(inner);
      const innerRoot = inner.attachShadow({ mode: "open" });
      const field = document.createElement("input");
      field.type = "text";
      innerRoot.append(field);
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.textContent = "";
      editor.id = "shortcut-editable-test";
      document.querySelector("kin-app").pages.get("today").append(outer, editor);
      field.focus();
      return document.activeElement === outer;
    });
    check(nested, "setup: a field two shadow roots deep has focus");
    await press(KEYS.n);
    await press(KEYS.slash);
    state = await snapshot();
    const deepValue = await page(() => document.getElementById("shortcut-shadow-test").shadowRoot.querySelector("span").shadowRoot.querySelector("input").value);
    check(!state.quickAddOpen && state.hash === "#today" && deepValue === "n/", "single-key shortcuts stay text inside nested Shadow DOM fields", { state, deepValue });
    await page(() => document.getElementById("shortcut-editable-test").focus());
    await press(KEYS.question);
    state = await snapshot();
    const editableText = await page(() => document.getElementById("shortcut-editable-test").textContent);
    check(!state.helpOpen && editableText === "?", "single-key shortcuts stay text in contenteditable regions", { state, editableText });
    await page(() => { document.getElementById("shortcut-shadow-test").remove(); document.getElementById("shortcut-editable-test").remove(); });

    await focusHeading();
    const ime = await page(() => {
      const target = document.getElementById("today-title");
      const fire = (init) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, ...init }));
      const results = [
        fire({ key: "n", isComposing: true }),
        fire({ key: "Process", keyCode: 229 }),
        fire({ key: "k", ctrlKey: true, isComposing: true }),
        fire({ key: "?", shiftKey: true, isComposing: true }),
      ];
      const app = document.querySelector("kin-app");
      return { notPrevented: results.every(Boolean), open: document.querySelectorAll("dialog[open]").length, quick: app.quickAdd.dialog.open };
    });
    check(ime.notPrevented && ime.open === 0 && !ime.quick, "IME composition keydowns trigger nothing and are not intercepted", ime);
    await press(KEYS.n, { autoRepeat: true });
    state = await snapshot();
    check(!state.quickAddOpen && state.openDialogs === 0, "an auto-repeated N does not open Quick add", state);
    const paletteIme = await page(async () => {
      const app = document.querySelector("kin-app");
      app.commandGeneration = app.securityGeneration;
      app.commandPalette.openPalette({ opener: document.getElementById("today-title") });
      app.commandPalette.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = { open: app.commandPalette.palette.open, hash: location.hash };
      return result;
    });
    check(paletteIme.open && paletteIme.hash === "#today", "Enter that confirms IME composition does not run a palette command", paletteIme);
    await press(KEYS.escape);

    const busy = await page(() => {
      const app = document.querySelector("kin-app");
      app.quickAdd.disabled = true;
      document.getElementById("today-title").focus();
      return true;
    });
    check(busy, "setup: Quick add is temporarily unavailable");
    await press(KEYS.n);
    state = await snapshot();
    const busyStatus = await page(() => { const app = document.querySelector("kin-app"); app.quickAdd.disabled = app.busy || !app.store; return app.status.textContent; });
    check(!state.quickAddOpen && state.focus === "today-title" && busyStatus.includes("Quick add is available again"),
      "N while Quick add is unavailable explains why and keeps focus", { state, busyStatus });

    // --- Item details and overlays ---------------------------------------
    await visit("lists/todo");
    await idle();
    const detail = await page((text) => {
      const app = document.querySelector("kin-app");
      const item = app.state.items.find((entry) => entry.text === text);
      const opener = [...app.needs.querySelectorAll("kin-item")].find((row) => row.record?.itemId === item.itemId)?.querySelector(".item-details-button");
      opener.click();
      return { itemId: item.itemId, mode: app.detailMode, selected: app.selection?.itemId === item.itemId };
    }, findable);
    await settle();
    check(detail.selected && detail.mode !== "sheet", "setup: desktop item details are open beside the list", detail);
    const detailFocus = await page(() => { document.activeElement?.blur?.(); const target = document.querySelector("kin-app").detail.querySelector("h2, h3, [tabindex='-1']"); target?.focus(); return document.activeElement === target; });
    await ctrlK();
    state = await snapshot();
    check(detailFocus && state.paletteOpen, "Ctrl+K opens the palette over non-modal item details", state);
    await press(KEYS.escape);
    const afterEscape = await page(() => { const app = document.querySelector("kin-app"); return { selected: app.selection?.itemId ?? null, inDetail: app.detail.contains(document.activeElement), palette: app.commandPalette.isOpen }; });
    check(afterEscape.selected === detail.itemId && afterEscape.inDetail && !afterEscape.palette,
      "Escape closes only the palette; item details stay open with focus restored inside them", afterEscape);
    await press(KEYS.escape);
    const detailClosed = await page(() => document.querySelector("kin-app").selection === null);
    check(detailClosed, "a second Escape closes the item details as before");

    // Search origin survives a palette round trip.
    await visit("search");
    await page(() => document.getElementById("household-search-query").focus());
    const origin = await page(async () => {
      const app = document.querySelector("kin-app");
      const result = app.search.querySelector("[data-result-id]");
      result.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { origin: app.selection?.origin, close: app.detail.backLabel };
    });
    await ctrlK();
    await press(KEYS.escape);
    const originAfter = await page(() => { const app = document.querySelector("kin-app"); return { origin: app.selection?.origin, close: app.detail.backLabel }; });
    check(origin.origin === "search" && originAfter.origin === "search" && originAfter.close === "Back to search",
      "item details opened from Search keep their Back to search origin across the palette", { origin, originAfter });
    await closeAll();

    // A modal item sheet on phones keeps Ctrl+K and single keys out.
    await viewport(390, 760, true);
    await visit("lists/todo");
    await page((itemId) => { const app = document.querySelector("kin-app"); app.ctx.detail.openItemDetail(itemId, {}); }, detail.itemId);
    await settle();
    const sheet = await page(() => document.querySelector("kin-app").detailSheet.open);
    await ctrlK();
    await press(KEYS.question);
    state = await snapshot();
    check(sheet && !state.paletteOpen && !state.helpOpen && state.openDialogs === 1, "the modal item sheet keeps its keyboard: no palette or help opens over it", state);
    await closeAll();

    // Navigation while a save is still in flight.
    await viewport(1280, 900, false);
    await visit("today");
    await idle();
    const inflight = `Saved during navigation ${stamp}`;
    const during = await page(async (text) => {
      const app = document.querySelector("kin-app");
      const save = app.ctx.items.handleAddItem({ detail: { text, classification: "need" } });
      const wasBusy = app.busy;
      app.ctx.append.runWorkspaceCommand("todo", {});
      await save;
      for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      return { wasBusy, hash: location.hash, count: app.state.items.filter((item) => item.text === text).length };
    }, inflight);
    check(during.wasBusy && during.hash === "#lists/todo" && during.count === 1, "navigating by command during a save keeps the save exactly once", during);

    // --- Responsive and appearance ---------------------------------------
    await viewport(320, 700, true);
    await visit("today");
    await focusHeading();
    await ctrlK();
    const narrow = await page(() => {
      const palette = document.querySelector("kin-app").commandPalette;
      const box = palette.palette.getBoundingClientRect();
      const options = [...palette.list.children].map((option) => option.getBoundingClientRect());
      return {
        inside: box.left >= 0 && box.right <= innerWidth,
        dialogOverflow: palette.palette.scrollWidth > palette.palette.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        optionTargets: options.every((rect) => rect.height >= 48 && rect.right <= box.right),
        closeTarget: palette.palette.querySelector(".command-dialog-close").getBoundingClientRect().height >= 48,
      };
    });
    check(narrow.inside && !narrow.dialogOverflow && !narrow.pageOverflow && narrow.optionTargets && narrow.closeTarget,
      "320px: the palette fits without horizontal overflow and keeps 48px targets", narrow);
    await press(KEYS.escape);
    await press(KEYS.question);
    const narrowHelp = await page(() => {
      const help = document.querySelector("kin-app").commandPalette.help;
      const box = help.getBoundingClientRect();
      const row = help.querySelector(".shortcut-row");
      return { inside: box.left >= 0 && box.right <= innerWidth, dialogOverflow: help.scrollWidth > help.clientWidth,
        stacked: getComputedStyle(row).gridTemplateColumns.split(" ").length === 1 };
    });
    check(narrowHelp.inside && !narrowHelp.dialogOverflow && narrowHelp.stacked, "320px: the shortcut help reflows to one column without overflow", narrowHelp);
    await press(KEYS.escape);

    await viewport(1280, 900, false);
    await setMedia(client, [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }]);
    await focusHeading();
    await ctrlK();
    const forced = await page(() => {
      const palette = document.querySelector("kin-app").commandPalette;
      const dialog = getComputedStyle(palette.palette);
      const option = getComputedStyle(palette.list.querySelector("[aria-selected='true']"));
      return {
        forced: matchMedia("(forced-colors: active)").matches,
        border: dialog.borderTopStyle !== "none" && parseFloat(dialog.borderTopWidth) > 0,
        outline: option.outlineStyle !== "none" && parseFloat(option.outlineWidth) >= 3,
        motion: matchMedia("(prefers-reduced-motion: reduce)").matches && parseFloat(dialog.animationDuration) <= 0.0001,
      };
    });
    check(forced.forced && forced.border && forced.outline && forced.motion,
      "forced colours keep the palette boundary and active option visible; reduced motion removes its animation", forced);
    await press(KEYS.escape);
    await setMedia(client);

    const hints = await page(() => {
      const app = document.querySelector("kin-app");
      return { quick: app.quickAdd.trigger.getAttribute("aria-keyshortcuts"), search: app.searchLink.getAttribute("aria-keyshortcuts") };
    });
    check(hints.quick === "N" && hints.search === "/", "the visible Quick add and Search controls expose their shortcuts", hints);

    // --- Lock, logout, and lifecycle -------------------------------------
    await focusHeading();
    await ctrlK();
    const lockedOpen = await page(async () => {
      const app = document.querySelector("kin-app");
      app.ctx.session.lockHousehold();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { open: document.querySelectorAll("dialog[open]").length, inMain: app.main.contains(document.activeElement), mainHidden: app.main.hidden, generation: app.commandGeneration };
    });
    check(lockedOpen.open === 0 && !lockedOpen.inMain && lockedOpen.mainHidden && lockedOpen.generation === null,
      "locking closes the palette without restoring focus into the hidden workspace", lockedOpen);
    const lockedHash = await page(() => location.hash);
    await ctrlK();
    await press(KEYS.n);
    await press(KEYS.slash);
    await press(KEYS.question);
    state = await snapshot();
    check(state.openDialogs === 0 && !state.quickAddOpen && state.hash === lockedHash, "a locked session ignores every workspace shortcut", state);
    const lockedCommand = await page(() => { const app = document.querySelector("kin-app"); app.ctx.append.runWorkspaceCommand("shopping"); return location.hash; });
    check(lockedCommand === lockedHash, "workspace commands do nothing while locked", { lockedCommand, lockedHash });
    await ready(client);
    await visit("today");
    await idle();

    // A command chosen just before a lock never runs afterwards.
    const stale = await page(async () => {
      const app = document.querySelector("kin-app");
      document.getElementById("today-title").focus();
      app.commandGeneration = app.securityGeneration;
      app.commandPalette.openPalette({ opener: document.getElementById("today-title") });
      app.commandPalette.input.value = "shopping";
      app.commandPalette.input.dispatchEvent(new Event("input"));
      app.commandPalette.activate(0);
      app.ctx.session.lockHousehold();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { hash: location.hash, open: document.querySelectorAll("dialog[open]").length };
    });
    check(stale.hash === "#today" && stale.open === 0, "a command chosen just before lock is dropped, not run after it", stale);
    await ready(client);
    await visit("today");
    await idle();

    const detached = await page(async () => {
      const app = document.querySelector("kin-app");
      const palette = app.commandPalette;
      palette.openPalette({ opener: document.getElementById("today-title") });
      palette.remove();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = { open: palette.isOpen, ready: app.ctx.navigation.workspaceReady() };
      app.append(palette);
      result.reconnected = app.ctx.navigation.workspaceReady();
      return result;
    });
    check(!detached.open && !detached.ready && detached.reconnected, "disconnection closes the palette and disables commands until it returns", detached);
    await focusHeading();
    await ctrlK();
    state = await snapshot();
    check(state.paletteOpen && state.inPalette, "the palette works again after reconnection and unlock", state);
    await press(KEYS.escape);
  } finally {
    await setMedia(client).catch(() => {});
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await closeAll().catch(() => {});
    await page(() => window.scrollTo(0, 0)).catch(() => {});
  }
  return `PASS keyboard commands (${passed.length} checks): Ctrl/Cmd+K palette, N, /, ?, Escape, filtering, arrow selection, focus restoration, typing/IME/Shadow DOM guards, item-detail overlays, lock lifecycle, 320px, forced colours, reduced motion`;
}
