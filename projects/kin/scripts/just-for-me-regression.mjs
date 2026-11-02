// Just for me (#510, #511, #514, #517) in a real browser against the
// production Kin server, the real way: a household created with a username
// and password (#557), so the device keeps the account vault key and the
// sync coordinator opens the member's private log through it. Nothing is
// stubbed: the engine, member key (created on the first private change),
// private envelopes, private log store, relay stream and views are the real
// ones.
//
// Covered: without the private log, one calm sentence pointing to account
// setup; add (with a date, and with a single Enter), complete and reopen, a
// short note, delete with Undo; the changes reach the service's private
// stream, sealed; dated items on Today and This week marked "Private" and
// named "Private: …", off with the setting and never in Simple view or
// household search; "Share with the household…" with a confirmation naming
// who will see it, and a retry after a partial failure that adds nothing
// twice; "Make private" with Undo, and its retry.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/just-for-me-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, captureFailure, waitForOrigin } from "./cdp-page.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

const POLL_MS = 100;
const MEMBER = { name: "Robin", household: "The Lees", username: "lee.private", password: "kettle lantern meadow" };

async function eventually(check, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Just for me regression timed out: ${label}`);
    await delay(POLL_MS);
  }
}

/** A CDP client for one page target: send() and evaluate(). */
async function pageClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const number = ++id;
    const timer = setTimeout(() => fail(new Error(`CDP timeout: ${method}`)), 240_000);
    pending.set(number, { resolve: (value) => { clearTimeout(timer); done(value); }, reject: (error) => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id: number, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 2000));
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

// ---- In-page steps (stringified and run in the browser) ---------------------

/** Creates a household with a password (the #557 first run) and waits
 * until the coordinator has opened the member's private log. */
async function signUp(member) {
  const wait = async (condition, label, ms = 60_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    const app = document.querySelector("kin-app");
    throw new Error(`Wait timed out: ${label}; step=${app?.security?.dataset.firstRunStep} alert=${app?.security?.alert?.textContent} private=${app?.ctx?.privateItems?.log?.reason}`);
  };
  await wait(() => document.querySelector("kin-app")?.security?.heading && !document.querySelector("kin-app").starting, "first screen");
  const app = document.querySelector("kin-app");
  const security = app.security;
  const type = (name, value) => {
    const input = security.querySelector(`input[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  [...security.querySelectorAll("button")].find((element) => element.textContent === "Start a new household").click();
  type("name", member.name);
  type("household", member.household);
  security.querySelector("form").requestSubmit();
  await wait(() => security.dataset.firstRunStep === "account", "the account screen");
  type("username", member.username);
  type("password", member.password);
  security.querySelector("form").requestSubmit();
  await wait(() => app.store && app.household?.identity && !app.firstRun && !app.busy, "Today after sign-up");
  await wait(() => app.syncCoordinator && app.ctx.privateItems.log, "the private log opens with the vault key");
  const { householdId, memberId, deviceId } = app.syncCoordinator.identity;
  return { householdId, memberId, deviceId };
}

async function justForMeFlow() {
  const app = document.querySelector("kin-app");
  let checks = 0;
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    checks += 1;
  };
  // Polls on timers, not animation frames: this page is a background target
  // in its own browser context, where frames may be throttled or paused.
  // `detail()`, when given, says what the page showed if the wait times out.
  const until = async (test, message, detail = null) => {
    const step = 25;
    for (let index = 0; index < 1200; index++) { if (test()) return; await new Promise((resolve) => setTimeout(resolve, step)); }
    check(false, message, detail?.());
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "the work settles");
  // Asks for sync passes until nothing private waits to send (or 15 s).
  const sent = async (step = 250) => {
    for (let tries = 0; tries < 60 && app.ctx.privateItems.log?.waiting; tries++) {
      await app.syncCoordinator.syncNow();
      await new Promise((done) => setTimeout(done, step));
    }
  };
  const tag = crypto.randomUUID().slice(0, 6);
  const view = () => app.justForMe;
  // A change shows from the private log's notify before perform() has
  // finished, and Just for me ignores a click while it runs; wait for the
  // change itself to finish before the next click or check that follows it.
  const settled = () => until(() => !view().running, "the private change finishes");
  const row = (text, root = view()) => [...root.querySelectorAll(".private-row")].find((node) => node.querySelector(".private-text")?.textContent === text) ?? null;
  const items = () => app.ctx.privateItems.view.items;
  const privateItem = (text) => items().find((item) => item.text === text) ?? null;
  const today = app.ctx.navigation.currentCivilDate();
  const dateInput = (date) => `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6, 8)}`;

  const segment = app.segmentNavs.get("lists").querySelector('.segment-link[data-segment="mine"]');
  check(segment?.textContent === "Just for me" && segment.getAttribute("href") === "#lists/mine", "Lists has a Just for me segment", segment?.outerHTML);
  app.ctx.navigation.navigate("#lists/mine");
  await until(() => !app.pages.get("lists").hidden && !view().hidden, "Just for me shows");

  // Without the private log (a device with no account vault key), one calm
  // sentence pointing to account setup. Detached for a moment, then back.
  const log = app.ctx.privateItems.log;
  app.ctx.privateItems.attach(null);
  const unavailable = view().querySelector(".just-for-me-unavailable");
  check(!unavailable.hidden && /needs your Kin account/.test(unavailable.textContent), "it says it needs an account", unavailable.textContent);
  check(unavailable.querySelector('a[href="#household/privacy"]'), "and points to account setup");
  check(view().querySelector(".just-for-me-add").hidden, "nothing can be added without private storage");
  app.ctx.privateItems.attach(log);

  // The coordinator's own log: no member key until something private is used.
  check(log.reason === "no_member_key" || log.reason === "ready", "the log opened through the vault key", log.reason);
  await until(() => !view().querySelector(".just-for-me-add").hidden, "Just for me opens");
  check(view().querySelector(".private-badge")?.textContent.includes("Only you can see this."), "it is clearly marked as only yours");

  // Add with a date, and with Enter alone (fast capture).
  const dentist = `Dentist ${tag}`;
  const gift = `Gift idea ${tag}`;
  const input = view().querySelector(".just-for-me-add input[type=text]");
  input.value = dentist;
  view().querySelector(".just-for-me-add input[type=date]").value = dateInput(today);
  view().querySelector(".just-for-me-add").requestSubmit();
  await until(() => row(dentist), "the dated item is listed");
  await settled();
  check(log.ring.available && log.reason === "ready", "the first private change created the member key");
  check(document.activeElement === input && input.value === "", "the field is ready for the next one");
  input.value = gift;
  view().querySelector(".just-for-me-add").requestSubmit();
  await until(() => row(gift), "an undated item is listed");
  await settled();
  check(privateItem(dentist)?.date === today && privateItem(gift)?.date === null, "dates are kept", items());
  check(!app.state.items.some((item) => item.text.includes(tag)), "nothing private is in the household");
  // They count at once and go out on the private stream with the next pass.
  await sent();
  check(!log.waiting, "the private changes reached the service");

  // Complete and reopen.
  row(gift).querySelector("input[type=checkbox]").click();
  await until(() => privateItem(gift)?.completed && row(gift, view().querySelector(".completed-disclosure")), "completing moves it to Completed");
  await settled();
  row(gift).querySelector("input[type=checkbox]").click();
  await until(() => privateItem(gift) && !privateItem(gift).completed, "reopening brings it back");
  await settled();

  // A short note.
  const more = () => row(gift).querySelector(".private-more");
  more().open = true;
  more().querySelector("textarea").value = "Second-hand is fine\nunder 20";
  more().querySelector('button[aria-label^="Save the note"]').click();
  await until(() => privateItem(gift)?.note === "Second-hand is fine\nunder 20", "the note is saved");
  await until(() => row(gift)?.querySelector(".private-note")?.textContent === "Second-hand is fine\nunder 20", "and shown");
  await settled();

  // Delete, with Undo that stays until the next change.
  more().open = true;
  more().querySelector(".danger-action").click();
  await until(() => !privateItem(gift) && !row(gift), "deleting removes it");
  await settled();
  const undo = view().querySelector(".just-for-me-feedback button");
  check(!undo.hidden && document.activeElement === undo, "Undo is offered and focused", undo.outerHTML);
  undo.click();
  await until(() => privateItem(gift)?.note === "Second-hand is fine\nunder 20", "Undo restores it with its note");

  // My Today and This week (#514): dated private items, marked and named.
  app.ctx.navigation.navigate("#today");
  await until(() => !app.pages.get("today").hidden, "Today shows");
  const todayRow = () => row(dentist, app.today.querySelector('[data-section="today"]') ?? app.today);
  await until(() => todayRow(), "the dated private item is on Today");
  const todayBox = todayRow().querySelector("input[type=checkbox]");
  check(todayBox.getAttribute("aria-label") === `Private: ${dentist}`, "its accessible name says Private", todayBox.getAttribute("aria-label"));
  check(todayRow().querySelector(".private-marker")?.textContent.trim() === "Private", "and it is marked Private");
  check(!row(gift, app.today), "undated items stay in Just for me");
  todayBox.click();
  await until(() => privateItem(dentist)?.completed, "it completes from Today");
  await until(() => row(dentist, app.today.querySelector('[data-section="completed"]')), "and shows under Completed");
  row(dentist, app.today).querySelector("input[type=checkbox]").click();
  await until(() => privateItem(dentist) && !privateItem(dentist).completed, "and reopens");
  app.ctx.navigation.navigate("#week");
  await app.ctx.week.refresh();
  await until(() => app.week.querySelector(`.week-day[data-date="${today}"]`) && row(dentist, app.week.querySelector(`.week-day[data-date="${today}"]`)), "it is on This week, today");
  check(row(dentist, app.week).querySelector("input").getAttribute("aria-label") === `Private: ${dentist}`, "named Private there too");

  // Never in Simple view, household search or the household's records.
  app.simpleView = true;
  check(app.ctx.privateItems.todayItems().length === 0, "Simple view (a shared kitchen screen) gets none");
  app.simpleView = false;
  check(!JSON.stringify(app.search.household ?? {}).includes(tag), "household search never holds them");

  // The setting turns it off, and back on.
  app.ctx.navigation.navigate("#lists/mine");
  await until(() => !view().hidden, "back to Just for me");
  const setting = view().querySelector(".just-for-me-setting input[type=checkbox]");
  check(setting.checked, "the setting is on by default");
  setting.click();
  await until(() => app.ctx.privateItems.view.onToday === false, "the setting is saved privately");
  await settled();
  app.ctx.navigation.navigate("#today");
  await until(() => !app.pages.get("today").hidden && !row(dentist, app.today), "Today leaves it out with the setting off");
  app.ctx.navigation.navigate("#lists/mine");
  await until(() => !view().hidden, "back again");
  view().querySelector(".just-for-me-setting input[type=checkbox]").click();
  await until(() => app.ctx.privateItems.view.onToday === true, "and back on");
  await settled();

  // Share with the household… (#517): a confirmation naming who sees it;
  // keeping it private changes nothing.
  const shareFrom = (text) => {
    const details = row(text).querySelector(".private-more");
    details.open = true;
    details.querySelector(".private-share").click();
  };
  const dialog = view().querySelector(".private-share-dialog");
  shareFrom(dentist);
  await until(() => dialog.open, "sharing asks first");
  check(/will move to To do, where .+ will see it/.test(dialog.textContent), "naming who will see it", dialog.textContent);
  check(document.activeElement?.textContent === "Keep it private", "keeping it private is the default");
  dialog.querySelector("button").click();
  await until(() => !dialog.open, "the dialog closes");
  await idle();
  check(privateItem(dentist) && !app.state.items.some((item) => item.text === dentist), "kept private: nothing moved");

  // A failure part-way (the private delete), then the retry: no duplicate.
  const run = app.ctx.privateItems.run;
  let failOnce = true;
  app.ctx.privateItems.run = function (command) {
    if (command.type === "delete-private-item" && failOnce) { failOnce = false; return Promise.reject(Object.assign(new Error("lost"), { code: "private_unavailable", userMessage: "Lost." })); }
    return run.call(this, command);
  };
  shareFrom(dentist);
  await until(() => dialog.open, "the dialog opens again");
  dialog.querySelector(".primary-action").click();
  await until(() => app.state.items.some((item) => item.text === dentist) && /won't be added twice/.test(app.alert?.textContent ?? ""), "the household copy exists and a retry is offered",
    () => ({ alert: app.alert?.textContent, status: app.status?.textContent, feedback: view().querySelector(".just-for-me-feedback")?.textContent, shared: app.state.items.filter((entry) => entry.text === dentist).length }));
  check(privateItem(dentist), "the private one is still there after the failure");
  await idle();
  const item = privateItem(dentist);
  await app.ctx.privateItems.share(item);
  await idle();
  app.ctx.privateItems.run = run;
  const shared = app.state.items.filter((entry) => entry.text === dentist);
  check(shared.length === 1 && shared[0].status === "active" && shared[0].classification === "need" && shared[0].planningDate === today, "one household item, in To do, with the date", shared);
  check(!privateItem(dentist), "and it left Just for me");

  // Make private, from a household item this member added; Undo.
  const flights = `Book flights ${tag}`;
  await app.ctx.items.handleAddItem({ detail: { text: flights, classification: "need" } });
  await idle();
  const household = app.state.items.find((entry) => entry.text === flights);
  app.ctx.detail.openItemDetail(household.itemId, { opener: null });
  await until(() => app.detail.querySelector(".make-private-button"), "Make private is offered on the member's own item");
  app.detail.querySelector(".make-private-button").click();
  await idle();
  await until(() => privateItem(flights), "it is copied into Just for me");
  await until(() => app.state.items.find((entry) => entry.itemId === household.itemId)?.status === "archived" && !app.busy, "the household item is archived");
  await until(() => !app.ctx.undo.toast.hidden && app.ctx.undo.toastAction.textContent === "Undo", "with Undo");
  app.ctx.undo.toastAction.click();
  await idle();
  await until(() => !privateItem(flights), "Undo removes the private copy");
  const back = app.state.items.filter((entry) => entry.text === flights && entry.status === "active");
  check(back.length === 1, "and brings the household item back", back);
  app.ctx.detail.closeItemDetail({ restoreFocus: false });

  // Make private failing part-way (the archive), then the retry.
  const append = app.ctx.append.appendCommand;
  let archiveFails = true;
  app.ctx.append.appendCommand = function (command) {
    if (command.type === "archive" && archiveFails) { archiveFails = false; return Promise.reject(Object.assign(new Error("lost"), { code: "storage" })); }
    return append.call(this, command);
  };
  await app.ctx.privateItems.makePrivate(back[0].itemId);
  await idle();
  check(privateItem(flights) && app.state.items.find((entry) => entry.itemId === back[0].itemId).status === "active", "copied, not yet archived");
  await app.ctx.privateItems.makePrivate(back[0].itemId);
  await idle();
  app.ctx.append.appendCommand = append;
  check(items().filter((entry) => entry.text === flights).length === 1, "the retry copies nothing twice");
  check(app.state.items.find((entry) => entry.itemId === back[0].itemId).status === "archived", "and archives it");
  check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");

  // Everything private reached the service's private stream.
  await sent();
  check(!log.waiting, "every private change was sent");
  app.ctx.undo.clear();
  app.ctx.navigation.navigate("#today");
  return { checks, texts: [dentist, gift, flights, "Second-hand is fine"] };
}

// ---- The suite -------------------------------------------------------------------

/**
 * Runs the Just for me checks with an existing browser, against its own
 * production Kin server in an isolated browser context (like
 * first-run-regression.mjs). `endpoint` is the browser's DevTools HTTP
 * address and `browserClient` a CDP client for the browser target.
 */
export async function justForMeRegressions({ endpoint, browserClient }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  let client = null, browserContextId = null;
  try {
    ({ browserContextId } = await browserClient.send("Target.createBrowserContext", { disposeOnDetach: true }));
    const { targetId } = await browserClient.send("Target.createTarget", { url: "about:blank", browserContextId });
    const target = await eventually(async () => (await (await fetch(`${endpoint}/json/list`)).json()).find((entry) => entry.id === targetId), "new target listed", 10_000);
    client = await pageClient(target.webSocketDebuggerUrl);
    await applyRegressionDefaults(client.send);
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: origin });
    await waitForOrigin(client.evaluate, origin, { navigate: () => client.send("Page.navigate", { url: origin }) });
    const identity = await client.evaluate(`(${signUp.toString()})(${JSON.stringify(MEMBER)})`);
    const outcome = await client.evaluate(`(${justForMeFlow.toString()})()`);
    // The service holds this member's private stream as sealed envelopes
    // and never the text.
    const relayed = kin.privateRelayService.pull({ member: { id: identity.memberId }, household: { id: identity.householdId }, device: { id: identity.deviceId } }, "", "200");
    assert.ok(relayed.events.length >= 10, `the private stream holds the changes (${relayed.events.length})`);
    const serialized = JSON.stringify(relayed.events);
    for (const text of outcome.texts) assert.ok(!serialized.includes(text), "no private text reaches the service");
    return `PASS ${outcome.checks + 2} just for me checks: password sign-up opens private storage; private list with Undo, on my Today and This week, share and make private with retries (#510)`;
  } finally {
    client?.close();
    if (browserContextId) await browserClient.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    kin.server.closeAllConnections?.();
    await new Promise((done) => kin.server.close(done));
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/just-for-me-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-just-for-me-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await justForMeRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("just for me regression");
    throw error;
  } finally {
    browserClient?.close();
    browser.kill();
    await delay(POLL_MS * 3);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  process.exit(0);
}
