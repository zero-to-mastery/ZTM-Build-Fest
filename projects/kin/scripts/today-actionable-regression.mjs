import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Actionable Today dashboard (docs/WORKSPACE-UX.md §3). The first export runs
// inside the page against the real components, encrypted store and WASM
// replay; the second drives the browser over CDP for offline/reload,
// keyboard, viewport and media checks.
export async function todayActionableRegressions(recovery) {
  const app = document.querySelector("kin-app");
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && index < 400; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "Today work returns idle");
  };
  const wait = async (condition, label) => {
    for (let index = 0; index < 400; index++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Today wait timed out: ${label}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const stamp = crypto.randomUUID().slice(0, 6);
  const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const rowIn = (view, itemId) => [...view.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId) ?? null;
  const sectionOf = (itemId, view = app.today) => rowIn(view, itemId)?.closest("[data-section]")?.dataset.section ?? null;
  const summary = (view = app.today) => Object.fromEntries([...view.querySelectorAll(".today-summary-list li")]
    .map((entry) => [entry.dataset.count, Number(entry.querySelector(".today-summary-count").textContent)]));
  const rendered = (view = app.today) => Object.fromEntries(["earlier", "today", "upcoming", "completed"]
    .map((kind) => [kind, view.querySelectorAll(`[data-section="${kind}"] kin-item`).length]));
  // Independent oracle over the Rust projection, used only to check the UI.
  const expected = () => {
    const today = app.ctx.navigation.currentCivilDate();
    const live = app.state.items.filter((item) => item.status !== "archived" && item.classification !== "staple");
    const isToday = (item) => item.planningDate === today || (item.classification === "today" && item.planningDate == null);
    return {
      earlier: live.filter((item) => item.status === "active" && item.planningDate != null && item.planningDate < today).length,
      today: live.filter((item) => item.status === "active" && isToday(item)).length,
      upcoming: live.filter((item) => item.status === "active" && item.planningDate != null && item.planningDate > today).length,
      completed: live.filter((item) => item.status === "completed" && isToday(item)).length,
    };
  };
  const consistent = () => {
    const shown = summary(), rows = rendered(), truth = expected();
    const state = { shown, rows, truth };
    const same = ["earlier", "today", "upcoming", "completed"].every((kind) =>
      (shown[kind] ?? 0) === truth[kind] && rows[kind] === truth[kind]);
    return same ? true : JSON.stringify(state);
  };
  const add = async (text, planningDate) => {
    await app.ctx.append.appendCommand({ type: "add", text, classification: "need" });
    const item = app.state.items.find((entry) => entry.text === text);
    if (planningDate != null) await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId: item.itemId, planningDate });
    app.ctx.render.renderState();
    await idle();
    return app.state.items.find((entry) => entry.itemId === item.itemId);
  };
  const statusOf = (itemId) => app.state?.items.find((item) => item.itemId === itemId)?.status ?? null;
  const gateComplete = (store, itemId) => {
    const original = store.append;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    store.append = async (command, engine) => {
      if (command.type === "complete" && command.itemId === itemId) await gate;
      return original.call(store, command, engine);
    };
    return () => { store.append = original; release(); };
  };

  // A. Component states over stable projection-shaped records.
  const DAY = 20261014;
  const record = (itemId, text, planningDate, status = "active") => ({ itemId, text, planningDate, status, classification: "need", areaId: null, steps: [] });
  const fixtures = {
    earlier: record("d0000000000000000000000000000001", "Return library books", 20261013),
    today: record("d0000000000000000000000000000002", "Call the dentist", DAY),
    upcoming: record("d0000000000000000000000000000004", "Renew car registration", 20261016),
    completed: record("d0000000000000000000000000000003", "Pack lunches", DAY, "completed"),
  };
  const mount = (props) => {
    const view = document.createElement("kin-today");
    view.display = "today";
    view.update(props);
    app.append(view);
    return view;
  };

  const pending = mount({});
  check(pending.querySelector('[data-section="today"] h2')?.textContent === "Today" && /aren't available yet/.test(pending.textContent) &&
    !/deleted|lost|removed/i.test(pending.textContent),
  "A. before the first local projection Today says tasks are not available yet, without implying loss");
  pending.remove();

  const empty = mount({ today: DAY, items: [] });
  check(!empty.querySelector(".today-summary") && /Nothing to do yet/.test(empty.querySelector('[data-section="today"]').textContent) &&
    empty.querySelector(".today-quick-add")?.textContent === "Add a task for today" &&
    empty.querySelector(".today-shopping-link")?.getAttribute("href") === "#lists/shopping" &&
    !empty.querySelector('[data-section="upcoming"], [data-section="earlier"]'),
  "A. an empty household offers native Quick add and Shopping paths with no counts");
  empty.remove();

  const allDone = mount({ today: DAY, items: [fixtures.completed] });
  check(/Everything planned for today is done/.test(allDone.textContent) && JSON.stringify(summary(allDone)) === JSON.stringify({ today: 0, upcoming: 0, completed: 1 }) &&
    allDone.querySelector(".completed-disclosure") && !allDone.querySelector('[data-count="earlier"]'),
  "A. all of today's work done is distinct from nothing planned, and completed tasks do not count as pending");
  allDone.remove();

  const full = mount({ today: DAY, items: [fixtures.upcoming, fixtures.completed, fixtures.today, fixtures.earlier] });
  const order = [...full.children].map((node) => node.dataset.section);
  check(JSON.stringify(order.slice(0, 4)) === JSON.stringify(["summary", "earlier", "today", "upcoming"]) &&
    ["earlier", "today", "upcoming"].every((kind) => full.querySelector(`[data-section="${kind}"]`).tagName === "SECTION" && full.querySelector(`[data-section="${kind}"] > h2`)),
  `A. sections are semantic, headed and ordered earlier → today → coming up (${order.join(",")})`);
  check(sectionOf(fixtures.earlier.itemId, full) === "earlier" && sectionOf(fixtures.today.itemId, full) === "today" &&
    sectionOf(fixtures.upcoming.itemId, full) === "upcoming" && sectionOf(fixtures.completed.itemId, full) === "completed",
  "A. each fixture record lands in exactly its section");
  const entries = [...full.querySelectorAll(".today-summary-entry")].map((node) => node.textContent);
  check(JSON.stringify(entries) === JSON.stringify(["1 item still open from earlier", "1 item planned for today", "1 item coming up", "1 item completed from today's plans"]) &&
    full.querySelector(".today-summary h2")?.textContent === "Item summary" && !/overdue|late|behind/i.test(full.textContent),
  `A. summary counts read as complete phrases for screen readers in calm language (${JSON.stringify(entries)})`);
  check(full.querySelector(`[data-item-id="${fixtures.today.itemId}"][data-item-action="complete"]`)?.getAttribute("aria-label") === "Complete Call the dentist" &&
    full.querySelector(`[data-item-id="${fixtures.completed.itemId}"][data-item-action="reopen"]`)?.getAttribute("aria-label") === "Reopen Pack lunches" &&
    !full.querySelector('[role="button"], [onclick], [tabindex]:not([tabindex="-1"])'),
  "A. completion uses labelled native buttons and no clickable non-semantic containers");
  full.querySelector('[data-summary="upcoming"]').click();
  check(document.activeElement === full.querySelector('[data-section="upcoming"] h2'), "A. a count moves focus to its section heading");
  full.querySelector('[data-summary="completed"]').click();
  check(full.querySelector(".completed-disclosure").open && document.activeElement === full.querySelector(".completed-disclosure summary"),
    "A. the completed count opens the Completed disclosure and focuses it");
  full.disabled = true;
  check([...full.querySelectorAll("[data-summary]")].every((node) => node.disabled) && full.querySelector(".complete-button").disabled,
    "A. while saving, summary and task controls are disabled like every other workspace control");
  full.disabled = false;
  check([...full.querySelectorAll("[data-summary]")].every((node) => !node.disabled), "A. summary controls re-enable once saving ends");
  full.remove();

  // Today mixes record types, so the summary says "items" and pluralises.
  const shoppingToday = { ...record("d0000000000000000000000000000005", "Buy eggs", DAY), classification: "shopping" };
  const mixed = mount({ today: DAY, items: [fixtures.today, shoppingToday, fixtures.completed] });
  const mixedEntries = [...mixed.querySelectorAll(".today-summary-entry")].map((node) => node.textContent);
  check(JSON.stringify(mixedEntries) === JSON.stringify(["2 items planned for today", "0 items coming up", "1 item completed from today's plans"]) &&
    !/\btasks?\b/.test(mixed.querySelector(".today-summary").textContent),
  `A. a task and a shopping item are summarised as items with correct plurals (${JSON.stringify(mixedEntries)})`);
  mixed.remove();

  const noUpcoming = mount({ today: DAY, items: [fixtures.today] });
  check(/Nothing is planned for the coming days/.test(noUpcoming.querySelector('[data-section="upcoming"]').textContent) &&
    noUpcoming.querySelector('[data-count="upcoming"] span.today-summary-entry') && !noUpcoming.querySelector('[data-summary="upcoming"]'),
  "A. no upcoming tasks has its own empty state and a zero count is plain text, not a dead button");
  noUpcoming.remove();

  // A. Quick add from an empty state reuses the universal composer.
  app.ctx.navigation.navigate("#today");
  const quick = app.quickAdd;
  const host = mount({ today: app.ctx.navigation.currentCivilDate(), items: [] });
  const opener = host.querySelector(".today-quick-add");
  opener.focus();
  opener.click();
  check(quick.dialog.open && document.activeElement === quick.input && quick.destination.textContent === "Adds to Today.",
    "A. the empty-state action opens the existing Quick add for Today with focus in its title");
  const quickText = `Empty-state quick add ${stamp}`;
  quick.input.value = quickText;
  quick.input.dispatchEvent(new Event("input", { bubbles: true }));
  quick.form.requestSubmit();
  quick.form.requestSubmit();
  await idle();
  const quickItem = app.state.items.filter((item) => item.text === quickText);
  check(quickItem.length === 1 && quickItem[0].planningDate === app.ctx.navigation.currentCivilDate() && !quick.dialog.open && document.activeElement === opener &&
    sectionOf(quickItem[0].itemId) === "today",
  "A. Quick add from an empty state creates one task for today, shows it on Today and returns focus to the action");
  opener.click();
  host.remove();
  quick.cancelButton.click();
  // The removed opener must return focus to a meaningful heading, not the page body.
  // Depending on the route-level fallback, this is the Today section or page heading.
  const fallbackHeadings = () => [app.today.querySelector('[data-section="today"] h2'), app.main.querySelector(".app-view:not([hidden]) h1")].filter(Boolean);
  for (let attempt = 0; attempt < 80 && !(!quick.dialog.open && fallbackHeadings().includes(document.activeElement)); attempt++)
    await frame();
  // What happened instead, for triage (#469): a refresh that re-rendered
  // Today after the dialog closed would show here as busy/refreshing or a
  // heading that is no longer the one focused.
  const focusFacts = () => JSON.stringify({ open: quick.dialog.open, active: document.activeElement?.outerHTML?.slice(0, 120) ?? null,
    headings: fallbackHeadings().map((node) => node.textContent.slice(0, 40)), busy: app.busy, refreshing: app.refreshing,
    pendingRefresh: app.pendingRefresh, wakePending: app.wakePending, route: location.hash });
  check(!quick.dialog.open && fallbackHeadings().includes(document.activeElement),
    `A. when the empty-state action disappears, focus returns to a visible Today or page heading, not the body (${focusFacts()})`);

  // B. Live Today over the real store and WASM projection.
  const earlierA = await add(`Earlier A ${stamp}`, shift(-3));
  const earlierB = await add(`Earlier B ${stamp}`, shift(-2));
  const dueToday = await add(`Due today ${stamp}`, app.ctx.navigation.currentCivilDate());
  const dueTodayTwo = await add(`Due today two ${stamp}`, app.ctx.navigation.currentCivilDate());
  const later = await add(`Coming soon ${stamp}`, shift(4));
  const laterTwo = await add(`Coming next ${stamp}`, shift(6));
  app.ctx.navigation.navigate("#today");
  check(sectionOf(earlierA.itemId) === "earlier" && sectionOf(dueToday.itemId) === "today" && sectionOf(later.itemId) === "upcoming",
    "B. real records are grouped into earlier, today and coming up");
  let result = consistent();
  check(result === true, `B. summary counts equal the rendered rows and the Rust projection (${result})`);

  const before = summary();
  const completeButton = rowIn(app.today, dueToday.itemId).querySelector(".complete-button");
  completeButton.focus();
  const started = performance.now();
  completeButton.click();
  await idle();
  const completeMs = performance.now() - started;
  check(statusOf(dueToday.itemId) === "completed" && /^Marked “.+” done\./.test(app.status.textContent) && sectionOf(dueToday.itemId) === "completed" &&
    document.activeElement === rowIn(app.today, dueToday.itemId)?.querySelector(".reopen-button"),
  "B. one click completes a task through the canonical command and focus moves to its Reopen action");
  const after = summary();
  result = consistent();
  check(after.today === before.today - 1 && after.completed === before.completed + 1 && result === true,
    `B. counts update from the new projection: pending -1, done +1 (${JSON.stringify({ before, after, result })})`);

  const eventsBeforeRapid = (await app.store.loadEvents()).length;
  const earlierRows = () => [...app.today.querySelectorAll('[data-section="earlier"] kin-item')];
  const rapidIndex = earlierRows().indexOf(rowIn(app.today, earlierA.itemId));
  const rapid = rowIn(app.today, earlierA.itemId).querySelector(".complete-button");
  rapid.focus();
  rapid.click(); rapid.click(); rapid.click();
  await idle();
  await frame();
  check((await app.store.loadEvents()).length === eventsBeforeRapid + 1 && statusOf(earlierA.itemId) === "completed",
    "B. repeated rapid clicks append exactly one completion event");
  const nextRow = earlierRows()[Math.min(rapidIndex, earlierRows().length - 1)];
  check(rapidIndex >= 0 && !rowIn(app.today, earlierA.itemId) && nextRow && document.activeElement === nextRow.querySelector(".complete-button"),
    `B. completing an earlier plan keeps focus in its section on the row that took its place (${document.activeElement?.outerHTML?.slice(0, 120)})`);

  const eventsBeforeFailure = (await app.store.loadEvents()).length;
  const realAppend = app.store.append;
  let failures = 1;
  app.store.append = async function (command, engine) {
    if (command.type === "complete" && command.itemId === later.itemId && failures-- > 0) {
      const error = new Error("Synthetic storage failure"); error.code = 5; error.userMessage = "Kin could not save that change locally."; throw error;
    }
    return realAppend.call(this, command, engine);
  };
  rowIn(app.today, later.itemId).querySelector(".complete-button").click();
  await idle();
  check(statusOf(later.itemId) === "active" && sectionOf(later.itemId) === "upcoming" && !app.alert.hidden &&
    app.alert.textContent === "Kin could not save that change locally." && !app.retryButton.hidden && !/^Marked “/.test(app.status.textContent) &&
    (await app.store.loadEvents()).length === eventsBeforeFailure && consistent() === true,
  "B. a local save failure reports the error, claims nothing, keeps the task pending and leaves counts unchanged");
  app.retryButton.click();
  await idle();
  app.store.append = realAppend;
  check(statusOf(later.itemId) === "completed" && app.alert.hidden && (await app.store.loadEvents()).length === eventsBeforeFailure + 1 && consistent() === true,
    "B. retry completes the same task exactly once");

  // A write from another tab lands in the shared encrypted store; Today only
  // changes once the app replays it, and then the counts match exactly.
  const peerText = `Peer task ${stamp}`;
  const peerAdd = await app.store.append({ type: "add", text: peerText, classification: "need" }, app.engine);
  const peerId = peerAdd.state.items.find((item) => item.text === peerText).itemId;
  await app.store.append({ type: "set-item-planning-date", itemId: peerId, planningDate: app.ctx.navigation.currentCivilDate() }, app.engine);
  await app.ctx.refresh.refreshFromEvents();
  await idle();
  result = consistent();
  check(sectionOf(peerId) === "today" && result === true, `B. a replayed peer change appears on Today with no stale counts (${result})`);

  // A newer change arriving while a completion is pending is applied after it.
  const releaseRemote = gateComplete(app.store, dueTodayTwo.itemId);
  rowIn(app.today, dueTodayTwo.itemId).querySelector(".complete-button").click();
  check(app.busy, "B. the completion is pending");
  const peerTwoText = `Peer during save ${stamp}`;
  const peerTwo = await realAppend.call(app.store, { type: "add", text: peerTwoText, classification: "need" }, app.engine);
  const peerTwoId = peerTwo.state.items.find((item) => item.text === peerTwoText).itemId;
  await realAppend.call(app.store, { type: "set-item-planning-date", itemId: peerTwoId, planningDate: app.ctx.navigation.currentCivilDate() }, app.engine);
  void app.ctx.refresh.refreshFromEvents();
  check(app.pendingRefresh, "B. a refresh requested mid-save is deferred, not interleaved");
  releaseRemote();
  await idle();
  result = consistent();
  check(statusOf(dueTodayTwo.itemId) === "completed" && sectionOf(peerTwoId) === "today" && app.state.items.filter((item) => item.text === peerTwoText).length === 1 && result === true,
    `B. both the local completion and the newer change are shown once, with matching counts (${result})`);

  // Navigating away mid-save neither loses the save nor pulls focus back.
  const navigateTask = await add(`Navigate mid-save ${stamp}`, app.ctx.navigation.currentCivilDate());
  const releaseNavigate = gateComplete(app.store, navigateTask.itemId);
  rowIn(app.today, navigateTask.itemId).querySelector(".complete-button").click();
  app.ctx.navigation.navigate("#lists/todo");
  releaseNavigate();
  await idle();
  check(statusOf(navigateTask.itemId) === "completed" && !app.today.contains(document.activeElement) && app.dataset.route === "lists/todo",
    "B. navigating during a pending completion keeps the result and does not pull focus back to Today");
  app.ctx.navigation.navigate("#today");
  check(consistent() === true, "B. Today is current when the person returns");

  // Details opened from Today keep their own origin and return focus there.
  const detailsButton = rowIn(app.today, earlierB.itemId).querySelector(".item-details-button");
  detailsButton.click();
  await frame();
  check(app.selection?.itemId === earlierB.itemId && app.selection.page === "today" && app.selection.origin === null &&
    app.detail.querySelector(".item-detail-close").textContent !== "Back to search",
  "B. details opened from Today belong to Today");
  app.detail.querySelector(".item-detail-close").click();
  await frame(); await frame();
  check(app.selection === null && document.activeElement === rowIn(app.today, earlierB.itemId)?.querySelector(".item-details-button"),
    "B. closing details returns focus to the same Today row");
  app.ctx.navigation.navigate("#search");
  app.search.queryInput.value = stamp;
  app.search.queryInput.dispatchEvent(new Event("input"));
  [...app.search.resultsList.querySelectorAll("[data-result-id]")].find((node) => node.dataset.resultId === laterTwo.itemId).click();
  await frame();
  check(app.selection?.origin === "search", "B. a Search result opens with a Search origin");
  app.ctx.navigation.navigate("#today");
  rowIn(app.today, laterTwo.itemId).querySelector(".item-details-button").click();
  await frame();
  check(app.selection?.itemId === laterTwo.itemId && app.selection.origin === null && app.detail.querySelector(".item-detail-close").textContent !== "Back to search",
    "B. reopening from Today does not inherit the earlier Search origin");
  app.detail.querySelector(".item-detail-close").click();
  await frame(); await frame();

  // Render cost of one Today update with the whole household (diagnostic).
  const renderStarted = performance.now();
  app.today.update({ items: app.state.items });
  const renderMs = performance.now() - renderStarted;

  // C. Lifecycle: lock or a household re-open during a pending completion.
  const lockTask = await add(`Lock mid-save ${stamp}`, app.ctx.navigation.currentCivilDate());
  const releaseLock = gateComplete(app.store, lockTask.itemId);
  rowIn(app.today, lockTask.itemId).querySelector(".complete-button").click();
  check(app.busy, "C. the completion is pending before lock");
  const todayBeforeLock = app.today;
  app.ctx.session.lockHousehold();
  await app.lockBarrier;
  releaseLock();
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(app.vault === null && app.state === null && app.main.hidden && !todayBeforeLock.isConnected && app.alert.hidden &&
    !/^Marked “/.test(app.status.textContent) && !document.body.textContent.includes(lockTask.text),
  "C. a completion settling after lock cannot update or reveal the locked interface");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  await wait(() => app.store && app.state && !app.busy && !app.security.busy, "unlock after pending completion");
  app.ctx.navigation.navigate("#today");
  const lockSection = sectionOf(lockTask.itemId);
  result = consistent();
  check(app.today !== todayBeforeLock && app.alert.hidden && result === true &&
    (statusOf(lockTask.itemId) === "completed" ? lockSection === "completed" : lockSection === "today"),
  `C. after unlocking, Today shows exactly what the encrypted store holds (${JSON.stringify({ status: statusOf(lockTask.itemId), lockSection, result })})`);

  const reopenTask = await add(`Reopen mid-save ${stamp}`, app.ctx.navigation.currentCivilDate());
  const oldStore = app.store;
  const releaseReopen = gateComplete(oldStore, reopenTask.itemId);
  rowIn(app.today, reopenTask.itemId).querySelector(".complete-button").click();
  const reopened = app.ctx.session.openUnlockedHousehold(app.vault);
  releaseReopen();
  await reopened;
  await idle();
  await wait(() => app.state && !app.busy, "household re-open");
  app.ctx.navigation.navigate("#today");
  const reopenSection = sectionOf(reopenTask.itemId);
  result = consistent();
  check(app.store !== oldStore && app.alert.hidden && result === true &&
    (statusOf(reopenTask.itemId) === "completed" ? reopenSection === "completed" : reopenSection === "today"),
  `C. re-opening the household during a pending completion drops the stale callback and shows the store's truth (${JSON.stringify({ status: statusOf(reopenTask.itemId), reopenSection, result })})`);

  console.log(`METRIC today-actionable ${JSON.stringify({ completeMs: Number(completeMs.toFixed(2)), renderMs: Number(renderMs.toFixed(2)), items: app.state.items.length, completeInteractions: 1 })}`);
  return `PASS actionable Today (${passed.length} checks; complete ${completeMs.toFixed(2)} ms; full Today render ${renderMs.toFixed(2)} ms): sections, counts, empty/all-done states, Quick add, one-click completion, rapid repeats, failure and retry, peer updates, navigation, details origin, lock and household re-open`;
}

export async function todayLifecycleRegressions(client, { visit, ready }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  const check = (condition, message, detail = null) => { assert.ok(condition, `${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`); passed.push(message); };
  const until = async (fn, label, ...args) => {
    for (let index = 0; index < 200; index++) {
      const value = await page(fn, ...args);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Today lifecycle timed out: ${label}`);
  };
  const idle = () => until(() => { const app = document.querySelector("kin-app"); return Boolean(app?.state) && !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending; }, "idle");
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "../target/ux-screenshots");
  await mkdir(outDir, { recursive: true });
  const shot = async (name) => {
    const { data } = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(outDir, `regression-today-${name}.png`), Buffer.from(data, "base64"));
  };
  const viewport = async (width, height, mobile) => {
    await setViewport(client, { width, height, deviceScaleFactor: 1, mobile });
    await page(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const press = async (key, code, keyCode, text) => {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  };
  const create = (text, offset) => page(async (text, offset) => {
    const app = document.querySelector("kin-app");
    const d = new Date(); d.setDate(d.getDate() + offset);
    await app.ctx.append.appendCommand({ type: "add", text, classification: "need" });
    const item = app.state.items.find((entry) => entry.text === text);
    await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId: item.itemId, planningDate: d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() });
    app.ctx.render.renderState();
    return item.itemId;
  }, text, offset);
  const stamp = (await page(() => crypto.randomUUID())).slice(0, 6);
  const offline = (value) => client.send("Network.emulateNetworkConditions", value
    ? { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  try {
    await visit("today");
    const offlineText = `Offline keyboard ${stamp}`;
    const offlineId = await create(offlineText, 0);
    const keepText = `Still open after reload ${stamp}`;
    const keepId = await create(keepText, 0);
    await idle();

    // Complete with a real keyboard press while the network is offline.
    await offline(true);
    await page(() => window.dispatchEvent(new Event("offline")));
    await until(() => document.querySelector("kin-app").syncChip.state === "offline", "offline chip");
    await page((id) => document.querySelector(`kin-today [data-item-id="${id}"][data-item-action="complete"]`).focus(), offlineId);
    await press("Enter", "Enter", 13, "\r");
    await until((id) => { const app = document.querySelector("kin-app"); return !app.busy && app.state.items.find((item) => item.itemId === id)?.status === "completed"; }, "offline keyboard completion", offlineId);
    let state = await page((id) => {
      const app = document.querySelector("kin-app");
      return {
        status: app.status.textContent,
        chip: app.syncChip.querySelector(".sync-label")?.textContent,
        chipDescription: app.syncChip.querySelector(".visually-hidden")?.textContent,
        focus: document.activeElement?.dataset.itemId === id && document.activeElement.dataset.itemAction === "reopen",
      };
    }, offlineId);
    check(/^Marked “.+” done\./.test(state.status) && state.chip === "Offline — saved here" && state.chipDescription.includes("saved on this device") && state.focus,
      "offline: Enter completes the focused task locally, focus moves to Reopen, and status distinguishes local saving from sync", state);

    // Reload, then unlock locally while offline and render Today from the
    // encrypted store without a server.
    await offline(false);
    await page(() => window.dispatchEvent(new Event("online")));
    await client.send("Page.reload");
    await until(() => Boolean(document.querySelector("kin-app")?.security?.heading), "reloaded shell");
    await offline(true);
    await page(() => window.dispatchEvent(new Event("offline")));
    await ready(client);
    await visit("today");
    await idle();
    state = await page((offlineId, keepId, offlineText) => {
      const app = document.querySelector("kin-app");
      const section = (id) => [...app.today.querySelectorAll("kin-item")].find((node) => node.record?.itemId === id)?.closest("[data-section]")?.dataset.section ?? null;
      const shown = Object.fromEntries([...app.today.querySelectorAll(".today-summary-list li")].map((entry) => [entry.dataset.count, Number(entry.querySelector(".today-summary-count").textContent)]));
      const rows = (kind) => app.today.querySelectorAll(`[data-section="${kind}"] kin-item`).length;
      return {
        status: app.state.items.find((item) => item.itemId === offlineId)?.status,
        copies: app.state.items.filter((item) => item.text === offlineText).length,
        offlineSection: section(offlineId),
        keepSection: section(keepId),
        countsMatch: shown.today === rows("today") && shown.completed === rows("completed") && shown.upcoming === rows("upcoming") && (shown.earlier ?? 0) === rows("earlier"),
        chip: app.syncChip.state,
      };
    }, offlineId, keepId, offlineText);
    check(state.status === "completed" && state.copies === 1 && state.offlineSection === "completed" && state.keepSection === "today" && state.countsMatch && state.chip === "offline",
      "offline: after reload and an offline local unlock, Today renders the persisted completion from encrypted storage", state);

    // Complete again offline after the reload, then reconnect.
    await page((id) => document.querySelector(`kin-today [data-item-id="${id}"][data-item-action="complete"]`).click(), keepId);
    await until((id) => { const app = document.querySelector("kin-app"); return !app.busy && app.state.items.find((item) => item.itemId === id)?.status === "completed"; }, "second offline completion", keepId);
    await offline(false);
    await page(() => window.dispatchEvent(new Event("online")));
    await until(() => document.querySelector("kin-app").syncChip.state !== "offline", "online chip");
    await idle();
    state = await page((keepId, keepText) => {
      const app = document.querySelector("kin-app");
      return {
        status: app.state.items.find((item) => item.itemId === keepId)?.status,
        copies: app.state.items.filter((item) => item.text === keepText).length,
        chip: app.syncChip.state,
        alert: app.alert.hidden,
      };
    }, keepId, keepText);
    check(state.status === "completed" && state.copies === 1 && state.chip !== "offline" && state.alert,
      "online: reconnecting keeps one completed record and hands over to the existing sync status", state);

    // Layout at 320px and desktop.
    const later = await create(`Layout coming ${stamp}`, 3);
    await create(`Layout earlier ${stamp}`, -1);
    const todayRow = await create(`Layout today ${stamp}`, 0);
    await idle();
    const layout = () => page(() => {
      const app = document.querySelector("kin-app");
      const box = (selector) => app.today.querySelector(selector)?.getBoundingClientRect() ?? null;
      const entries = [...app.today.querySelectorAll(".today-summary-entry")];
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        summaryVisible: entries.length >= 3 && entries.every((node) => node.getClientRects().length > 0),
        summaryTargets: entries.filter((node) => node.tagName === "BUTTON").every((node) => node.getBoundingClientRect().height >= 44),
        summaryFits: entries.every((node) => node.getBoundingClientRect().right <= innerWidth + 0.5),
        summaryTop: box(".today-summary")?.top ?? null,
        composeTop: app.compose.getBoundingClientRect().top,
        earlierTop: box('[data-section="earlier"]')?.top ?? null,
        todayTop: box('[data-section="today"]')?.top ?? null,
        upcomingTop: box('[data-section="upcoming"]')?.top ?? null,
        columns: getComputedStyle(app.today.querySelector(".today-summary-list")).gridTemplateColumns.split(" ").length,
      };
    });
    await viewport(320, 720, true);
    await visit("today");
    await page(() => window.scrollTo(0, 0));
    let geometry = await layout();
    check(!geometry.overflow && geometry.summaryVisible && geometry.summaryTargets && geometry.summaryFits && geometry.columns === 1 &&
      geometry.composeTop < geometry.summaryTop && geometry.summaryTop < geometry.earlierTop && geometry.earlierTop < geometry.todayTop && geometry.todayTop < geometry.upcomingTop,
    "320px: counts stack in one column of 44px+ targets with no horizontal scroll; sections keep their order", geometry);
    await shot("320");
    await page(() => document.querySelector("kin-app").today.querySelector(".today-summary").scrollIntoView({ block: "start" }));
    await shot("320-summary");
    await viewport(1280, 900, false);
    await visit("today");
    await page(() => window.scrollTo(0, 0));
    geometry = await layout();
    check(!geometry.overflow && geometry.summaryVisible && geometry.columns > 1 && geometry.composeTop < geometry.summaryTop &&
      geometry.summaryTop < geometry.earlierTop && geometry.earlierTop < geometry.todayTop && geometry.todayTop < geometry.upcomingTop,
    "desktop: counts sit in one row heading the task sections, matching reading and focus order", geometry);
    await shot("desktop");

    // An open editor draft for one task survives completing another task.
    state = await page(async (draftId, otherId) => {
      const app = document.querySelector("kin-app");
      const row = (id) => [...app.today.querySelectorAll("kin-item")].find((node) => node.record?.itemId === id);
      row(draftId).querySelector(".item-details-button").click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      app.detail.stepInput.value = "unsent step draft";
      row(otherId).querySelector(".complete-button").click();
      for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const result = {
        selection: app.selection?.itemId === draftId,
        draft: app.detail.stepInput.value,
        completed: app.state.items.find((item) => item.itemId === otherId)?.status,
        mode: app.detailMode,
      };
      app.ctx.detail.closeItemDetail({ restoreFocus: false });
      return result;
    }, later, todayRow);
    check(state.selection && state.draft === "unsent step draft" && state.completed === "completed",
      "desktop: completing a task from Today never overwrites an unrelated open editor draft", state);

    // Forced colours and reduced motion.
    await setMedia(client, [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }]);
    state = await page(() => {
      const app = document.querySelector("kin-app");
      const entry = app.today.querySelector(".today-summary-entry");
      const style = getComputedStyle(entry);
      return {
        forced: matchMedia("(forced-colors: active)").matches,
        border: style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0,
        motion: matchMedia("(prefers-reduced-motion: reduce)").matches && parseFloat(style.transitionDuration) <= 0.0001 && style.animationName === "none",
        completeVisible: [...app.today.querySelectorAll('[data-section="today"] .complete-button')].every((node) => node.getClientRects().length > 0),
      };
    });
    check(state.forced && state.border && state.motion && state.completeVisible,
      "forced colours keep summary boundaries and completion controls visible; reduced motion adds no animation", state);
  } finally {
    await offline(false).catch(() => {});
    await setMedia(client).catch(() => {});
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await page(() => { const app = document.querySelector("kin-app"); app?.closeItemDetail?.({ restoreFocus: false }); window.scrollTo(0, 0); }).catch(() => {});
  }
  return `PASS Today lifecycle (${passed.length} checks): offline keyboard completion, reload and offline unlock, reconnect, 320px and desktop layout, unrelated drafts, forced colours and reduced motion`;
}
