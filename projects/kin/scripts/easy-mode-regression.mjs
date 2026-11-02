// Easy mode and Help on every screen (#616, #619, #620, #622, ADR 0021) in
// the real app, on the shared single-tab test household:
// - the first week's tips on Today, one at a time, never repeated;
// - Help on every page and in Quick add: the right topic, "Show me", "Still
//   stuck?" (message an admin; report a problem only when something listens);
// - easy mode from Identity & appearance: the page scales, words beside
//   icons, 56px targets, the navigation trimmed to what is used, the Undo
//   line after an action; at 320px, desktop and 200%, in dark mode, forced
//   colours and reduced motion; then off again, leaving Kin as it was.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";

// Every page and tab Help covers (help/help-content.js has a topic for each).
export const ROUTES = [
  "today", "week/week", "week/day", "week/month", "chores", "search", "journal",
  "lists/todo", "lists/shopping", "lists/staples", "lists/meals", "lists/mine",
  "routines/all", "routines/checklists", "updates/handoffs", "updates/chat",
  "household/hub", "household/fridge", "household/notes", "household/sitter", "household/areas",
  "household/people", "household/privacy", "household/appearance", "household/features",
];

export async function easyModeRegressions(client, { until }) {
  const page = (expression) => client.evaluate(expression);
  const frames = () => page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`);
  const go = async (hash) => {
    await page(`document.querySelector("kin-app").ctx.navigation.navigate(${JSON.stringify(hash)})`);
    await frames();
  };
  const idle = () => until(() => page(`(() => { const app = document.querySelector("kin-app"); return !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending; })()`), { attempts: 300 });
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // --- The first week's tips (#617, #622) --------------------------------
  await go("#today");
  const tips = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    localStorage.removeItem("kin.tips-done");
    app.ctx.help.tipDealtWith = false;
    app.ctx.help.renderTip();
    const tip = app.todayTip;
    const first = { tip: tip.dataset.tip, shown: !tip.hidden && tip.getClientRects().length > 0, heading: tip.querySelector("h2")?.textContent,
      buttons: [...tip.querySelectorAll("button")].map((button) => button.textContent) };
    tip.querySelector(".today-tip-dismiss").click();
    const dismissed = { hidden: tip.hidden, focus: document.activeElement === app.pages.get("today").querySelector("h1"),
      done: JSON.parse(localStorage.getItem("kin.tips-done") ?? "[]") };
    // One per unlock: the next one waits for the next unlock.
    app.ctx.help.renderTip();
    const waits = tip.hidden;
    app.ctx.help.tipDealtWith = false;
    app.ctx.help.renderTip();
    const second = { tip: tip.dataset.tip, buttons: [...tip.querySelectorAll("button")].map((button) => button.textContent) };
    tip.querySelector(".today-tip-action").click();
    for (let i = 0; i < 5; i++) await frame();
    const helpButton = app.pages.get("today").querySelector(".page-intro .help-button");
    const shown = { focus: document.activeElement === helpButton, highlighted: helpButton.classList.contains("help-highlight") };
    app.ctx.help.clearHighlight();
    app.ctx.help.tipDealtWith = false;
    app.ctx.help.renderTip();
    return { first, dismissed, waits, second, shown, never: tip.hidden };
  })()`);
  assert.deepEqual(tips.first, { tip: "easy-mode", shown: true, heading: "Would bigger text help?", buttons: ["Turn on easy mode", "No thanks"] }, "the easy mode offer comes first");
  assert.deepEqual(tips.dismissed, { hidden: true, focus: true, done: ["easy-mode"] }, "No thanks puts it away for good; focus goes to Today's heading");
  assert.ok(tips.waits, "one tip per unlock");
  assert.deepEqual(tips.second, { tip: "help", buttons: ["Show me", "Got it"] }, "then the pointer to Help");
  assert.deepEqual(tips.shown, { focus: true, highlighted: true }, "Show me highlights Today's Help button");
  assert.ok(tips.never, "and neither tip comes back");

  // --- Help on every page (#621) ----------------------------------------
  // A thing to do, so "Show me" has a Complete button to point at.
  const itemId = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await app.ctx.append.appendCommand({ type: "add", id, text: "Easy regression water the plants", classification: "need" });
    app.ctx.render.renderState();
    return id;
  })()`);
  await idle();
  const reportCalls = [];
  for (const key of ROUTES) {
    await go(`#${key}`);
    const result = await page(`(async () => {
      const app = document.querySelector("kin-app");
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const section = app.pages.get(app.route.page);
      const button = section.querySelector(".page-intro .help-button");
      if (!button) return { key: app.route.canonical, missing: true };
      // Layout size: the page's arrival animation may still be running.
      const box = { width: button.offsetWidth, height: button.offsetHeight };
      button.click();
      await frame();
      const panel = app.helpPanel;
      const dialog = panel.querySelector("dialog");
      const result = {
        key: app.route.canonical, open: dialog.open, topic: panel.dataset.topic, title: dialog.querySelector("h2").textContent,
        actions: dialog.querySelectorAll(".help-actions li").length, who: Boolean(dialog.querySelector(".help-who")?.textContent),
        admin: Boolean(dialog.querySelector(".help-message-admin")),
        // Shown exactly when something in Kin takes reports.
        report: Boolean(dialog.querySelector(".help-report")) === app.ctx.help.reportAvailable(),
        visible: box.width > 0 && box.height >= 48, focus: document.activeElement === dialog.querySelector("h2"),
      };
      dialog.querySelector(".help-close").click();
      await frame();
      result.closed = !dialog.open;
      result.returned = document.activeElement === button;
      return result;
    })()`);
    assert.deepEqual(result, {
      key, open: true, topic: key, title: result.title, actions: result.actions, who: true, admin: true, report: true,
      visible: true, focus: true, closed: true, returned: true,
    }, `Help on ${key}: ${JSON.stringify(result)}`);
    assert.match(result.title, /^Help: \S/, key);
    assert.ok(result.actions >= 1 && result.actions <= 3, `${key}: one to three things to do`);
  }

  // "Show me" outlines the control and gives it the focus; "Report a
  // problem" shows only when something takes it.
  await go("#lists/todo");
  const showMe = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const calls = [];
    // With Kin's own report dialog (#630) the button always shows and opens
    // it; without it, a stand-in listener answers the probe.
    const own = typeof app.ctx.report?.open === "function";
    const listener = (event) => { event.preventDefault(); calls.push({ probe: event.detail?.probe === true, route: event.detail?.route ?? null }); };
    if (!own) app.addEventListener("kin:report-problem", listener);
    app.pages.get("lists").querySelector(".page-intro .help-button").click();
    await frame();
    const dialog = app.helpPanel.querySelector("dialog");
    const shows = [...dialog.querySelectorAll(".help-show-me")].map((button) => button.dataset.show);
    const report = dialog.querySelector(".help-report");
    if (!own) report?.click();
    await frame();
    app.removeEventListener("kin:report-problem", listener);
    app.pages.get("lists").querySelector(".page-intro .help-button").click();
    await frame();
    const complete = [...dialog.querySelectorAll(".help-show-me")].find((button) => button.dataset.show === ".complete-control");
    complete.click();
    for (let i = 0; i < 5; i++) await frame();
    const target = document.activeElement;
    const result = { shows: shows.length, report: Boolean(report), calls, own, closed: !dialog.open,
      focus: target?.classList.contains("complete-control") ?? false, highlighted: target?.classList.contains("help-highlight") ?? false,
      outline: getComputedStyle(target).outlineStyle };
    app.ctx.help.clearHighlight();
    result.cleared = !target.classList.contains("help-highlight");
    return result;
  })()`);
  assert.deepEqual(showMe, { shows: showMe.shows, report: true, calls: showMe.own ? [] : [{ probe: true, route: null }, { probe: false, route: "lists/todo" }], own: showMe.own, closed: true, focus: true, highlighted: true, outline: "solid", cleared: true },
    `Show me and Report a problem: ${JSON.stringify(showMe)}`);
  assert.ok(showMe.shows >= 2, "To do's Help shows where to add and where to complete");

  // "Message a household admin": Chat with an admin when Chat is on; this
  // household has no chat room, so Handoffs, ready to write.
  const message = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    app.pages.get("lists").querySelector(".page-intro .help-button").click();
    await frame();
    app.helpPanel.querySelector(".help-message-admin").click();
    for (let i = 0; i < 5; i++) await frame();
    return { route: app.route.canonical, focus: document.activeElement?.id ?? null, status: app.status.textContent };
  })()`);
  assert.deepEqual(message, { route: "updates/handoffs", focus: "handoff-text", status: "Write your question for a household admin, then press Add handoff." });

  // Help in a dialog: Quick add's own topic, and Show me inside the dialog.
  await go("#today");
  const dialogHelp = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    app.quickAdd.open({ opener: null });
    await frame();
    app.quickAdd.querySelector(".quick-add-dialog .help-button").click();
    await frame();
    const panel = app.helpPanel;
    const topic = panel.dataset.topic;
    panel.querySelector('.help-show-me[data-show="#quick-add-title-input"]').click();
    for (let i = 0; i < 3; i++) await frame();
    const result = { topic, focus: document.activeElement?.id, quickAddOpen: app.quickAdd.querySelector("dialog").open, helpOpen: panel.querySelector("dialog").open };
    app.ctx.help.clearHighlight();
    app.quickAdd.querySelector("dialog").close();
    await frame();
    return result;
  })()`);
  assert.deepEqual(dialogHelp, { topic: "dialog:quick-add", focus: "quick-add-title-input", quickAddOpen: true, helpOpen: false }, "Quick add has its own Help");

  // --- Easy mode (#617) ---------------------------------------------------
  await go("#household/appearance");
  const turnedOn = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    localStorage.removeItem("kin.easy-recent");
    const input = app.personalSettings.querySelector(".easy-mode-setting input");
    const label = app.personalSettings.querySelector(".easy-mode-setting label").textContent;
    input.click();
    for (let i = 0; i < 3; i++) await frame();
    return { label, checked: input.checked, root: document.documentElement.dataset.kinEasy ?? null, app: app.hasAttribute("data-easy"),
      kept: localStorage.getItem("kin.easy-mode"), said: app.personalSettings.querySelector(".appearance-feedback").textContent,
      zoom: getComputedStyle(document.body).zoom };
  })()`);
  assert.deepEqual(turnedOn, { label: "Easy mode: bigger text and buttons, fewer things on screen", checked: true, root: "on", app: true, kept: "on", said: "Easy mode is on.", zoom: "1.25" },
    `turning easy mode on: ${JSON.stringify(turnedOn)}`);

  // Only the everyday places, plus what the person opens.
  await go("#today");
  const navigation = () => page(`(() => {
    const app = document.querySelector("kin-app");
    const shown = (node) => node.getClientRects().length > 0;
    return {
      nav: [...app.navLinks.values()].filter(shown).map((link) => link.dataset.page),
      lists: [...app.segmentNavs.get("lists").querySelectorAll(".segment-link")].filter(shown).map((link) => link.dataset.segment),
      household: [...app.segmentNavs.get("household").querySelectorAll(".segment-link")].filter(shown).map((link) => link.dataset.segment),
      routinesOnHub: shown(app.pages.get("household").querySelector('.easy-only a[href="#routines"]')),
    };
  })()`);
  let nav = await navigation();
  assert.deepEqual(nav.nav, ["today", "lists", "updates", "household"], `easy navigation: ${JSON.stringify(nav)}`);
  await go("#lists/todo");
  nav = await navigation();
  assert.deepEqual(nav.lists, ["todo", "shopping"], "Lists keeps To do and Shopping");
  await go("#household");
  nav = await navigation();
  assert.deepEqual(nav.household, ["hub", "photos"], "Household keeps its overview and Family photos (#673)");
  assert.ok(nav.routinesOnHub, "Routines is one tap away on the overview");
  await go("#routines");
  await go("#lists/staples");
  await go("#today");
  nav = await navigation();
  assert.deepEqual(nav.nav, ["today", "lists", "routines", "updates", "household"], "a place the person opened stays");
  await go("#lists/todo");
  nav = await navigation();
  assert.deepEqual(nav.lists, ["todo", "shopping", "staples"], "and so does a tab");

  // Sizes, words beside icons and the Undo line, at desktop and at 320px.
  const measure = () => page(`(() => {
    const app = document.querySelector("kin-app");
    const section = app.pages.get(app.route.page);
    const shown = (node) => node.getClientRects().length > 0 && !node.closest("[hidden]");
    const probe = document.createElement("span");
    probe.textContent = "M";
    probe.style.display = "inline-block";
    probe.style.lineHeight = "1";
    section.append(probe);
    const text = probe.getBoundingClientRect().height;
    probe.remove();
    const controls = [...section.querySelectorAll("button, .segment-link"), ...app.navLinks.values()].filter(shown);
    const small = controls.filter((node) => node.getBoundingClientRect().height < 56)
      .map((node) => (node.className || node.tagName) + ":" + Math.round(node.getBoundingClientRect().height));
    const row = [...section.querySelectorAll("kin-item")].find((node) => node.record?.itemId === ${JSON.stringify(itemId)});
    const word = row?.querySelector(".complete-control .control-word");
    return {
      text: Math.round(text * 10) / 10, small,
      word: word && shown(word) ? word.textContent : null,
      headerWords: [app.searchLink, app.lockButton].every((node) => { const span = node.querySelector("span"); return span.getBoundingClientRect().width > 8; }),
      sideways: document.documentElement.scrollWidth - innerWidth,
      help: shown(section.querySelector(".page-intro .help-button")),
    };
  })()`);
  for (const [label, metrics] of [
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
    ["320px", { width: 320, height: 640, deviceScaleFactor: 2, mobile: true }],
    ["200% text", { width: 640, height: 400, deviceScaleFactor: 2, mobile: false }],
  ]) {
    await setViewport(client, metrics);
    for (const hash of ["#lists/todo", "#today", "#household/appearance", "#updates/handoffs"]) {
      await go(hash);
      const view = await measure();
      const why = `${label} ${hash}: ${JSON.stringify(view)}`;
      assert.ok(view.text >= 19.5, `base text is at least 20px (${why})`);
      assert.deepEqual(view.small, [], `every control is at least 56px tall (${why})`);
      assert.ok(view.sideways <= 0, `nothing scrolls sideways (${why})`);
      assert.ok(view.headerWords, `Search and Lock show their words (${why})`);
      assert.ok(view.help, `Help is on the page (${why})`);
      if (hash === "#lists/todo") assert.equal(view.word, "Complete", `the tick has its word (${why})`);
    }
  }

  // The Undo line after an action, at 320px.
  await setViewport(client, { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  await go("#lists/todo");
  await page(`(() => { const app = document.querySelector("kin-app");
    const row = [...app.needs.querySelectorAll("kin-item")].find((node) => node.record?.itemId === ${JSON.stringify(itemId)});
    row.querySelector(".complete-control").click(); return true; })()`);
  await until(() => page(`(() => { const app = document.querySelector("kin-app"); return !app.busy && !app.ctx.undo.toast.hidden; })()`), { attempts: 300 });
  const undoLine = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const toast = app.ctx.undo.toast;
    const action = toast.querySelector(".undo-toast-action");
    const box = action.getBoundingClientRect();
    // How much of Undo is on screen, as the browser itself sees it.
    const ratio = await new Promise((resolve) => {
      const observer = new IntersectionObserver((entries) => { observer.disconnect(); resolve(entries[0].intersectionRatio); });
      observer.observe(action);
    });
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const dismiss = getComputedStyle(toast.querySelector(".undo-toast-dismiss"), "::after").content;
    return { text: toast.querySelector(".undo-toast-text").textContent, action: action.textContent, height: Math.round(box.height),
      ratio: Math.round(ratio * 100) / 100, onTop: action.contains(hit), box: [Math.round(box.top), Math.round(box.bottom), innerHeight].join("/"), dismiss,
      // What placed it, should it be off screen.
      where: { scrollY: Math.round(scrollY), feedback: [...Object.values(app.feedback.getBoundingClientRect().toJSON())].map(Math.round).join(","),
        nav: [...Object.values(app.nav.getBoundingClientRect().toJSON())].map(Math.round).join(","),
        position: getComputedStyle(app.feedback).position, bottom: getComputedStyle(app.feedback).bottom, zoom: getComputedStyle(document.body).zoom,
        hit: hit?.tagName + "." + (hit?.className ?? "") } };
  })()`);
  assert.ok(undoLine.text.length > 0 && undoLine.action === "Undo" && undoLine.height >= 56 && undoLine.ratio >= 0.99 && undoLine.onTop, `the Undo line: ${JSON.stringify(undoLine)}`);
  assert.match(undoLine.dismiss, /Dismiss/, "Dismiss has its word");
  await page(`document.querySelector("kin-app").ctx.undo.toast.querySelector(".undo-toast-action").click()`);
  await until(() => page(`(() => { const app = document.querySelector("kin-app"); return !app.busy && app.state.items.find((item) => item.itemId === ${JSON.stringify(itemId)})?.status === "active"; })()`), { attempts: 300 });

  // The Help panel fits a 320px screen.
  const narrowHelp = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    app.pages.get("lists").querySelector(".page-intro .help-button").click();
    await frame();
    const dialog = app.helpPanel.querySelector("dialog");
    const box = dialog.getBoundingClientRect();
    const result = { open: dialog.open, fits: box.left >= 0 && box.right <= innerWidth + 1, sideways: dialog.scrollWidth - dialog.clientWidth };
    dialog.querySelector(".help-close").click();
    return result;
  })()`);
  assert.deepEqual(narrowHelp, { open: true, fits: true, sideways: 0 }, "Help fits at 320px");

  // Dark mode, forced colours and reduced motion: Show me still outlines
  // the control, without moving.
  for (const [label, features] of [
    ["dark", [{ name: "prefers-color-scheme", value: "dark" }]],
    ["forced colours, reduced motion", [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }]],
  ]) {
    await setMedia(client, features);
    const look = await page(`(async () => {
      const app = document.querySelector("kin-app");
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      app.pages.get("lists").querySelector(".page-intro .help-button").click();
      await frame();
      app.helpPanel.querySelector('.help-show-me[data-show=".complete-control"]').click();
      for (let i = 0; i < 3; i++) await frame();
      const target = document.activeElement;
      const style = getComputedStyle(target);
      const result = { outline: style.outlineStyle, width: parseFloat(style.outlineWidth), animation: style.animationName,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, sideways: document.documentElement.scrollWidth - innerWidth };
      app.ctx.help.clearHighlight();
      return result;
    })()`);
    assert.ok(look.outline !== "none" && look.width >= 3, `${label}: the highlight shows (${JSON.stringify(look)})`);
    if (look.reduced) assert.equal(look.animation, "none", `${label}: no pulsing`);
    assert.ok(look.sideways <= 0, `${label}: nothing scrolls sideways`);
  }
  await setMedia(client);

  // Off again: everything comes back.
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await go("#household/appearance");
  const turnedOff = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    app.personalSettings.querySelector(".easy-mode-setting input").click();
    for (let i = 0; i < 3; i++) await frame();
    app.ctx.navigation.navigate("#lists/todo");
    await frame();
    const shown = (node) => node.getClientRects().length > 0;
    return { root: document.documentElement.dataset.kinEasy ?? null, app: app.hasAttribute("data-easy"), kept: localStorage.getItem("kin.easy-mode"),
      zoom: getComputedStyle(document.body).zoom, nav: [...app.navLinks.values()].filter(shown).length,
      lists: [...app.segmentNavs.get("lists").querySelectorAll(".segment-link")].filter(shown).length };
  })()`);
  assert.deepEqual(turnedOff, { root: null, app: false, kept: null, zoom: "1", nav: 5, lists: 5 }, `turning easy mode off: ${JSON.stringify(turnedOff)}`);
  await page(`(async () => {
    const app = document.querySelector("kin-app");
    localStorage.removeItem("kin.easy-recent");
    await app.ctx.items.handleItemAction("archive", ${JSON.stringify(itemId)});
    app.ctx.navigation.navigate("#today");
    return true;
  })()`);
  await idle();
  await client.send("Emulation.clearDeviceMetricsOverride");
  return "PASS easy mode and Help: first-week tips, Help with Show me and Still stuck on every page and in Quick add, easy mode sizes, words, trimmed navigation and the Undo line at desktop, 320px and 200%, dark, forced colours and reduced motion (#616, #620)";
}
