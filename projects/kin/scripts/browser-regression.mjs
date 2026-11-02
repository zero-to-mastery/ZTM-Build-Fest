// Node 22+ and a Chromium-family executable; no npm packages required.
// Uses a fresh temporary profile and loopback server, never an existing Kin DB.
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import { applyRegressionDefaults, captureFailure, createLoadTrace, printAbortedModules, printLoadTrace as printTrace, KIN_START_TIMEOUT_MS, waitForOrigin } from "./cdp-page.mjs";
import {
  pulseRegressions,
  pulsePeerRegressions,
  pulseResilienceRegressions,
  pulseKeyboardRegressions,
} from "./pulse-regression.mjs";
import { talkRegressions, talkPeerRegressions } from "./talk-regression.mjs";
import { chatRegressions } from "./chat-regression.mjs";
import { chatLayoutRegressions } from "./chat-layout-regression.mjs";
import assert from "node:assert/strict";
import {
  routineRegressions,
  routinePeerRegressions,
  routineKeyboardRegressions,
} from "./routine-regression.mjs";
import { shoppingRegressions } from "./shopping-regression.mjs";
import { mealsRegressions } from "./meals-regression.mjs";
import { mealsAcceptanceRegressions } from "./meals-acceptance-regression.mjs";
import { mealPlanRegressions } from "./meal-plan-regression.mjs";
import { simpleRegressions } from "./simple-regression.mjs";
import { easyModeRegressions } from "./easy-mode-regression.mjs";
import { easySweepRegressions } from "./easy-sweep-regression.mjs";
import { setupForSomeoneRegressions } from "./setup-for-someone-regression.mjs";
import { planningDateRegressions } from "./planning-date-regression.mjs";
import { mobileUxRegressions } from "./mobile-ux-regression.mjs";
import { fridgeRegressions } from "./fridge-regression.mjs";
import { attachmentUploadRegressions } from "./attachment-upload-regression.mjs";
import { syncMotionRegressions, workspaceUxRegressions, workspaceViewportRegressions } from "./workspace-ux-regression.mjs";
import { quickAddRegressions } from "./quick-add-regression.mjs";
import { qrRegressions, writeQrCamera } from "./qr-regression.mjs";
import { todayActionableRegressions, todayLifecycleRegressions } from "./today-actionable-regression.mjs";
import { keyboardCommandRegressions } from "./keyboard-commands-regression.mjs";
import { bulkActionRegressions } from "./bulk-actions-regression.mjs";
import { undoRegressions } from "./undo-regression.mjs";
import { shareRegressions } from "./share-regression.mjs";
import { shortcutsBadgeRegressions } from "./shortcuts-badge-regression.mjs";
import { shoppingModeRegressions } from "./shopping-mode-regression.mjs";
import { weekRegressions } from "./week-regression.mjs";
import { calendarRegressions } from "./calendar-regression.mjs";
import { importRegressions } from "./import-regression.mjs";
import { sitterRegressions } from "./sitter-regression.mjs";
import { photoAlbumRegressions } from "./photo-album-regression.mjs";
import { householdFeaturesRegressions } from "./household-features-regression.mjs";
import { CALENDAR_HARNESS_HOUSEHOLD, calendarSyncHarness, calendarSyncRegressions, expectedCalendarRefusal } from "./calendar-sync-regression.mjs";
import { rotationsRegressions } from "./rotations-regression.mjs";
import { choreChartRegressions } from "./chore-chart-regression.mjs";
import { kitchenDisplayRegressions } from "./kitchen-display-regression.mjs";
import { storeSectionsRegressions } from "./store-sections-regression.mjs";
import { recurringTaskRegressions } from "./recurring-tasks-regression.mjs";
import { dailyUxHardeningRegressions } from "./daily-ux-hardening-regression.mjs";
import {
  handoffRegressions,
  handoffPeerRegressions,
} from "./handoff-regression.mjs";
import {
  catchUpRegressions,
  catchUpPeerRegressions,
} from "./catch-up-regression.mjs";
import { syncStorageRegressions } from "./sync-storage-regression.mjs";
import { eventArenaPeerRegressions } from "./event-arena-regression.mjs";
import { incrementalRenderPeerRegressions } from "./incremental-render-regression.mjs";
import { firstRunRegressions } from "./first-run-regression.mjs";
import { newDeviceRegressions } from "./new-device-regression.mjs";
import { accountSecurityRegressions } from "./account-security-regression.mjs";
import { justForMeRegressions } from "./just-for-me-regression.mjs";
import { syncedPrefsRegressions } from "./synced-prefs-regression.mjs";
import { journalRegressions } from "./journal-regression.mjs";
import { accountMigrationRegressions } from "./account-migration-regression.mjs";
import { reportProblemRegressions } from "./report-problem-regression.mjs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const recoverySecret = randomBytes(32).toString("hex");
const executable = process.argv[2];
assert.ok(
  executable,
  "Usage: node scripts/browser-regression.mjs <browser executable>",
);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const profile = await mkdtemp(join(tmpdir(), "kin-regression-"));
// Outside calendars (#668): the real calendar service behind /api/calendar/,
// fetching from a fake HTTPS calendar server (calendar-sync-regression.mjs).
const calendarHarness = await calendarSyncHarness();
const server = createServer(async (request, response) => {
  if (await calendarHarness.handle(request, response)) return;
  if (new URL(request.url, "http://localhost").pathname === "/api/status") {
    response.setHeader("Content-Type", "application/json");
    response.end('{"identity":null,"claim":null}');
    return;
  }
  const path = resolve(
    webRoot,
    `.${new URL(request.url, "http://localhost").pathname.replace(/\/$/, "/index.html")}`,
  );
  if (!path.startsWith(webRoot + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
      }[extname(path)] ?? "application/octet-stream",
    );
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
// The browser's camera plays a file with a foreign QR code, then this Kin's
// pairing link (qr-regression.mjs). No other suite uses the camera.
const qrExpected = { reject: "https://elsewhere.example/pair#code=QR-CAMERA", accept: `${origin}/pair#code=QR-CAMERA` };
const qrCamera = join(profile, "qr-camera.y4m");
await writeQrCamera(qrCamera, qrExpected);
const browser = spawn(
  executable,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${qrCamera}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  BROWSER_STDIO,
);
let launchError;
browser.on("error", (error) => {
  launchError = error;
});
const clients = [];
const problems = [];
// Document loads that lost a module request (#594), by load: the start-up
// guard (web/boot-guard.js) should have loaded each again.
const abortedModuleLoads = new Map();
const requests = [];
const REGRESSION_PART = process.env.KIN_REGRESSION_PART ?? "";
if (!["", "1", "2"].includes(REGRESSION_PART)) throw new Error(`KIN_REGRESSION_PART must be 1 or 2, not ${REGRESSION_PART}`);
let browserClient;

async function until(check, { attempts = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (launchError) throw launchError;
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  // Name the condition, so a CI annotation says which wait ran out (#469).
  const condition = String(check.label ?? check).replace(/\s+/g, " ").slice(0, 240);
  throw new Error(`Timed out waiting for browser state: ${condition}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    socket.onopen = done;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const eventListeners = new Map();
  // Requests the page has started and not finished, so a stalled load can
  // say what it waits for (#469).
  const inFlight = new Map();
  const failedRequests = [];
  // The tab's load trace (#594), shared with the other suites through
  // cdp-page.mjs; every tab adds its lost module requests to one map.
  const loadTrace = createLoadTrace({ aborted: abortedModuleLoads });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) loadTrace.observe(message);
    if (message.method)
      for (const listener of [...(eventListeners.get(message.method) ?? [])]) listener(message.params);
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      problems.push(message.params.exceptionDetails);
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params.entry;
      if (entry.level === "error" && !entry.url?.endsWith("/favicon.ico"))
        problems.push(entry);
    } else if (message.method === "Network.requestWillBeSent") {
      requests.push(message.params.request.url);
      inFlight.set(message.params.requestId, { url: message.params.request.url, type: message.params.type ?? null, at: Date.now() });
    }
    if (message.method === "Network.responseReceived") {
      const request = inFlight.get(message.params.requestId);
      if (request) Object.assign(request, { status: message.params.response.status, sw: Boolean(message.params.response.fromServiceWorker) });
    } else if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") {
      const request = inFlight.get(message.params.requestId);
      if (message.method === "Network.loadingFailed" && request)
        failedRequests.push({ path: request.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 120), type: request.type,
          error: message.params.errorText, canceled: Boolean(message.params.canceled), at: Date.now() });
      if (failedRequests.length > 20) failedRequests.shift();
      inFlight.delete(message.params.requestId);
    }
  };
  const client = {
    send(method, params = {}, { timeoutMs = 30000, describeTargets = true } = {}) {
      return new Promise((resolve, reject) => {
        const number = ++id;
        const timeout = setTimeout(async () => {
          // Timed out is final: a reply arriving while the browser is asked
          // below is dropped, as it was before the asking.
          pending.set(number, { resolve() {}, reject() {} });
          const error = new Error(`CDP timeout: ${method}${params.expression ? ` (${params.expression.slice(0, 160)})` : ""}`);
          // Once (#469) Target.createBrowserContext got no reply right after a
          // suite disposed its context: say what browser contexts and targets
          // the browser still held, asked briefly so the failure isn't held up.
          if (method.startsWith("Target.") && describeTargets) {
            const brief = { timeoutMs: 2000, describeTargets: false };
            const [contexts, targets] = await Promise.all([
              client.send("Target.getBrowserContexts", {}, brief)
                .then((result) => JSON.stringify(result.browserContextIds), (reason) => reason.message),
              client.send("Target.getTargets", {}, brief)
                .then((result) => JSON.stringify(result.targetInfos.map(({ type, browserContextId, attached, url }) => ({ type, context: browserContextId, attached, url: url.slice(0, 80) }))), (reason) => reason.message),
            ]);
            error.message += ` — browser contexts ${contexts}; targets ${targets}`.slice(0, 1500);
          }
          reject(error);
        }, timeoutMs);
        pending.set(number, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id: number, method, params }));
      });
    },
    async evaluate(expression) {
      const source = typeof expression === "function"
        ? `(${expression.toString()})()`
        : expression;
      const result = await this.send("Runtime.evaluate", {
        expression: source,
        awaitPromise: true,
        returnByValue: true,
      });
      assert.equal(
        result.exceptionDetails,
        undefined,
        JSON.stringify(result.exceptionDetails),
      );
      return result.result.value;
    },
    on(method, listener) {
      if (!eventListeners.has(method)) eventListeners.set(method, new Set());
      eventListeners.get(method).add(listener);
      return () => eventListeners.get(method)?.delete(listener);
    },
    // Resolves with the next event of this kind, or rejects after the timeout.
    once(method, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
        const stop = this.on(method, (params) => { clearTimeout(timer); stop(); resolve(params); });
      });
    },
    // The oldest unfinished requests, for diagnostics.
    unfinished(limit = 8) {
      const now = Date.now();
      return [...inFlight.values()].sort((a, b) => a.at - b.at).slice(0, limit)
        .map(({ url, type, status, sw, at }) => ({ path: url.replace(/^https?:\/\/[^/]+/, "").slice(0, 120), type, status, sw, ageMs: now - at }));
    },
    // The most recent requests that failed (cancelled ones included).
    failed(limit = 6) {
      const now = Date.now();
      return failedRequests.slice(-limit).map(({ at, ...rest }) => ({ ...rest, ageMs: now - at }));
    },
    loadTrace,
    close: () => socket.close(),
  };
  clients.push(client);
  return client;
}

// Runs inside the browser against real DOM, storage, and Rust/WASM replay.
async function regressions() {
  const app = document.querySelector("kin-app");
  const compose = app.compose;
  const key = "kin.compose.draft";
  const classificationKey = "kin.compose.classification";
  const passed = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const edit = (text, classification = "need") => {
    compose.input.value = text;
    compose.input.dispatchEvent(new Event("input", { bubbles: true }));
    compose.classification.value = classification;
    compose.classification.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    // These checks count events one by one, so capture without a planning date.
    compose.plan.value = "none";
  };
  // Row-level controls are deliberately few; everything else lives in the
  // shared detail view, opened here by canonical id.
  const details = (itemId) => { app.ctx.detail.openItemDetail(itemId); return app.detail; };
  const detailsFor = (text) => details(app.state.items.find((item) => item.text === text).itemId);
  const idle = async () => {
    for (let i = 0; app.busy && i < 200; i++)
      await new Promise((r) => setTimeout(r, 10));
    check(
      !app.busy && app.main.getAttribute("aria-busy") === "false",
      "busy must clear",
    );
  };
  const count = async () => (await app.store.loadEvents()).length;
  const submit = async () => {
    compose.form.requestSubmit();
    await idle();
  };
  const draft = (expected, classification = "need") => {
    check(compose.input.value === expected, "visible draft mismatch");
    check(
      sessionStorage.getItem(key) === null,
      "plaintext drafts must never persist",
    );
    check(
      compose.classification.value === classification,
      "visible classification mismatch",
    );
    check(
      sessionStorage.getItem(classificationKey) === null,
      "draft classification must remain ephemeral",
    );
  };
  check(app.status.textContent === "Ready.", "startup");
  check(
    [...app.nav.querySelectorAll("a")].map((link) => link.textContent.trim()).join(",") ===
      "Today,Lists,Routines,Updates,Household" && app.nav.querySelectorAll("a").length === 5 &&
      app.nav.querySelectorAll('[aria-current="page"]').length === 1 &&
      app.nav.querySelector('[aria-current="page"]').dataset.page === "today",
    "the unlocked shell exposes five primary destinations and marks Today as current",
  );
  check(
    getComputedStyle(app.shell).display === "grid" &&
      getComputedStyle(app.nav).position === "sticky" &&
      app.nav.getBoundingClientRect().left < app.main.getBoundingClientRect().left &&
      app.pages.get("today").getBoundingClientRect().width <= 1080 &&
      !app.siteTools.hidden && app.searchLink.getAttribute("href") === "#search" && app.lockButton.textContent.trim() === "Lock",
    "wide screens use a persistent left navigation, a readable content column, and header search/lock",
  );
  check(
    getComputedStyle(app.household).display === "block" &&
      getComputedStyle(app.areas).display === "block" &&
      getComputedStyle(app.security).display === "block",
    "Areas, household, and security custom elements retain block card flow under Household",
  );
  app.nav.querySelector('a[href="#lists/todo"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    location.hash === "#lists/todo" && !app.pages.get("lists").hidden &&
      app.nav.querySelector('[aria-current="page"]').dataset.page === "lists" &&
      app.pages.get("today").hidden && app.routeAnnouncement.textContent === "Lists view" &&
      document.title === "Our Home — Kin" && app.dataset.route === "lists/todo",
    "navigation changes the URL, current destination, and visible page together",
  );
  app.nav.querySelector('a[href="#today"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    app.today.display === "today" && app.needs.display === "need" &&
      app.pages.get("household").contains(app.household) &&
      app.pages.get("household").contains(app.security),
    "Today and Lists remain views over existing records and Household owns household/security controls",
  );
  const search = app.search;
  app.nav.querySelector('a[href="#household"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.pages.get("household").querySelector('a[href="#search"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    !app.pages.get("search").hidden &&
      app.nav.querySelectorAll('[aria-current="page"]').length === 0 &&
      app.routeAnnouncement.textContent === "Search view",
    "Search remains reachable from Household and the header with its route announcement and no primary destination current",
  );
  search.household = {
    items: [
      {
        itemId: "search-need",
        text: "Pack a snack",
        classification: "need",
        status: "active",
        areaId: "search-kitchen",
        steps: [{ stepId: "search-step", text: "Add apple slices", archived: false }],
      },
      {
        itemId: "search-shopping",
        text: "Buy oat milk",
        classification: "shopping",
        status: "active",
        areaId: "search-kitchen",
        steps: [{ stepId: "search-archived-step", text: "Archived milk step", archived: true }],
      },
      {
        itemId: "search-archived",
        text: "Archived milk item",
        classification: "shopping",
        status: "archived",
        areaId: "search-kitchen",
        steps: [],
      },
    ],
    handoffs: [
      { handoffId: "search-handoff", text: "Milk is in the fridge", status: "acknowledged" },
      { handoffId: "search-archived-handoff", text: "Archived milk handoff", status: "archived" },
    ],
    talks: [
      { talkId: "search-talk", text: "Discuss oat milk", status: "open" },
      { talkId: "search-archived-talk", text: "Archived milk topic", status: "archived" },
    ],
    notes: [
      { noteId: "search-note", title: "Milk preference", body: "Oat milk", archived: false },
      { noteId: "search-archived-note", title: "Archived milk note", body: "Old details", archived: true },
    ],
    areas: [{ areaId: "search-kitchen", name: "Kitchen", archived: false }],
  };
  check(
    search.queryInput.labels[0]?.textContent === "Search household text" &&
      search.resultStatus.getAttribute("aria-live") === "polite" &&
      search.queryInput.spellcheck === false,
    "search exposes a labeled local search field and an accessible live result count",
  );
  search.queryInput.focus();
  search.queryInput.value = "apple";
  search.queryInput.dispatchEvent(new Event("input", { bubbles: true }));
  check(
    document.activeElement === search.queryInput &&
      search.resultStatus.textContent === "1 match." &&
      search.resultsList.textContent.includes("Add apple slices"),
    "typing keeps focus and finds active checklist Step text",
  );
  search.queryInput.value = "milk";
  search.queryInput.dispatchEvent(new Event("input", { bubbles: true }));
  search.classificationSelect.value = "shopping";
  search.classificationSelect.dispatchEvent(new Event("change", { bubbles: true }));
  search.statusSelect.value = "active";
  search.statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
  search.areaSelect.value = "search-kitchen";
  search.areaSelect.dispatchEvent(new Event("change", { bubbles: true }));
  check(
    search.resultStatus.textContent === "4 matches." &&
      [...search.resultsList.querySelectorAll(".search-result strong")].map((entry) => entry.textContent).join(",") ===
        "Item,Handoff,Talk,Note" &&
      !search.resultsList.textContent.includes("Archived"),
    "Item filters combine while preserving matching unarchived Handoff, Talk, and Note results",
  );
  search.queryInput.value = "no household record contains this";
  search.queryInput.dispatchEvent(new Event("input", { bubbles: true }));
  check(
    search.resultStatus.textContent === "No matching unarchived household text." &&
      search.resultsList.childElementCount === 0,
    "a query with no matches shows a clear empty state",
  );
  search.clearButton.click();
  check(
    document.activeElement === search.queryInput &&
      search.queryInput.value === "" &&
      search.classificationSelect.value === "" &&
      search.statusSelect.value === "" &&
      search.areaSelect.value === "" &&
      search.resultStatus.textContent === "Enter text above to search.",
    "clear search restores defaults and returns keyboard focus to the query",
  );
  app.nav.querySelector('a[href="#today"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    !app.pages.get("today").hidden &&
      app.nav.querySelector('[aria-current="page"]').dataset.page === "today",
    "navigation returns from Search to Today",
  );
  passed.push("local household search, archive exclusion, Item filters, result cap, accessibility and focus");
  const initialCatchUp = await app.store.getCatchUpState();
  check(
    initialCatchUp.events.length === 0 &&
      initialCatchUp.cursor.eventId === null &&
      initialCatchUp.cursor.localSequence === 0 &&
      app.state.summary.totalCount === 0,
    "empty first install starts caught up without synthetic history",
  );
  edit("Normal success");
  await submit();
  check((await count()) === 1, "normal add exactly once");
  check(app.state.items.at(-1).classification === "need", "default is Needs");
  check(
    app.needs
      .querySelector("kin-item .item-text")?.textContent === "Normal success",
    "default item appears in Needs",
  );
  draft("");
  check(document.activeElement === compose.input, "add focus");
  passed.push(
    "startup, normal add, own draft clearing, sessionStorage removal, focus, busy",
  );

  // An undated Item with the Today classification, which earlier captures
  // used; later checks keep it on Today and under To do.
  const legacyText = "Legacy Today item";
  await app.store.append({ type: "add", text: legacyText, classification: "today" }, app.engine);
  await app.ctx.refresh.refreshFromEvents();
  check(
    app.state.items.find((item) => item.text === legacyText).classification === "today",
    "a Today-classified Item replays as Today",
  );
  passed.push("Today-classified Item replay");

  const replayRecords = (await app.store.loadEvents()).map(
    (event) => event.encoded_event,
  );
  const replayBeforeFailure = app.engine.applyEvents(
    replayRecords,
    0,
    null,
    20261002,
  );
  const malformedRecord = new Uint8Array(replayRecords.at(-1));
  new DataView(malformedRecord.buffer).setUint16(0, 3, true);
  let replayFailureCode;
  try {
    app.engine.applyEvents(
      [...replayRecords.slice(0, -1), malformedRecord],
      0,
      null,
      20261002,
    );
  } catch (error) {
    replayFailureCode = error.code;
  }
  check(
    replayFailureCode === 3,
    "unsupported replay exposes stable error code",
  );
  check(
    app.engine.applyEvents([], 0, null, 20261002).items.length === 0,
    "empty replay replaces previous result",
  );
  check(
    JSON.stringify(app.engine.applyEvents(replayRecords, 0, null, 20261002)) ===
      JSON.stringify(replayBeforeFailure),
    "success/failure/empty/repeated WASM calls do not retain stale output",
  );
  passed.push(
    "repeated WASM calls clear stale output after failure and empty replay",
  );
  const { encodeAddedRecord } = await import(
    new URL("./wasm/kin-engine.js", location.href)
  );
  const workloadContext = await app.store.ensureContext();
  const workloadId = (value) => {
    const id = new Uint8Array(16);
    new DataView(id.buffer).setUint32(12, value, true);
    return id;
  };
  const workloadRecords = Array.from({ length: 10_000 }, (_, index) =>
    encodeAddedRecord({
      eventId: workloadId(index + 10_001),
      householdId: workloadContext.household_id,
      actorId: workloadContext.actor_id,
      deviceId: workloadContext.device_id,
      timestamp: 1_760_000_000_000 + index,
      logicalTime: BigInt(index + 1),
      itemId: workloadId(index + 1),
      text: "x",
      classification: index % 2 === 0 ? "need" : "today",
    }),
  );
  const workloadState = app.engine.applyEvents(
    workloadRecords,
    0,
    null,
    20261002,
  );
  check(
    workloadState.items.length === 10_000,
    "WASM replays maximum event count",
  );
  check(
    workloadState.items.filter((item) => item.classification === "need")
      .length === 5_000,
    "maximum replay retains classification across large result",
  );
  passed.push("10,000-event real-WASM replay and bounded classified result");

  // Fail an actual IndexedDB transaction after a successful add request.
  // Quota injection separately verifies the actionable storage-full path.
  async function failOnce(mode, operation = submit, focused = () => document.activeElement === compose.input) {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name !== "events") return original.apply(this, args);
      if (mode === "quota")
        throw new DOMException("Synthetic quota failure", "QuotaExceededError");
      if (mode === "async-quota") {
        // Trigger a real request error/transaction abort, substituting only
        // its error category so no real disk exhaustion is necessary.
        const request = original.call(this, { ...args[0], local_sequence: 1 });
        request.addEventListener("error", () =>
          Object.defineProperty(request, "error", {
            value: new DOMException(
              "Synthetic quota failure",
              "QuotaExceededError",
            ),
          }),
        );
        return request;
      }
      const request = original.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    };
    try {
      await operation();
    } finally {
      IDBObjectStore.prototype.add = original;
    }
    check(
      !app.retryButton.hidden && !app.alert.hidden,
      "failure exposes retry",
    );
    check(focused(), "failure focus");
    if (mode.includes("quota"))
      check(
        app.alert.textContent.includes("storage is full"),
        "quota guidance",
      );
  }

  for (const changed of [false, true]) {
    const before = await count();
    const logicalTimeBefore = (await app.store.ensureContext())
      .next_logical_time;
    edit("Buy milk");
    await failOnce(changed ? "async-quota" : "quota");
    draft("Buy milk");
    check((await count()) === before, "failed add must not persist");
    check(
      (await app.store.ensureContext()).next_logical_time === logicalTimeBefore,
      "failed append must not advance logical time",
    );
    if (changed) edit("Buy bread", "shopping");
    if (changed) {
      const retry = app.retryAction;
      const load = app.store.getCatchUpState.bind(app.store);
      app.store.getCatchUpState = async () => {
        throw new Error("Synthetic item refresh failure");
      };
      try {
        await app.ctx.refresh.refreshFromEvents();
        await app.ctx.refresh.refreshFromEvents();
      } finally {
        app.store.getCatchUpState = load;
      }
      await app.retryAction();
      check(
        app.retryAction === retry,
        "Item retry survives repeated refresh failure",
      );
      app.ctx.peers.handlePeerMessage({ data: { type: "events-changed" } });
      await idle();
      check(
        !app.retryButton.hidden,
        "peer refresh must retain failed-command retry",
      );
      draft("Buy bread", "shopping");
    }
    app.retryButton.click();
    app.retryButton.click();
    app.retryButton.click();
    await idle();
    check(
      (await count()) === before + 1,
      "repeated retry persists exactly once",
    );
    check(
      (await app.store.ensureContext()).next_logical_time ===
        logicalTimeBefore + 1n,
      "event and logical counter commit once together",
    );
    check(
      app.state.items.at(-1).text === "Buy milk",
      "retry exact original command",
    );
    check(
      app.state.items.at(-1).classification === "need",
      "retry preserves original classification",
    );
    draft(changed ? "Buy bread" : "", changed ? "shopping" : "need");
    check(
      app.retryAction === null && app.retryButton.hidden,
      "retry lifecycle",
    );
    app.retryButton.click();
    await idle();
    check((await count()) === before + 1, "stale retry button must do nothing");
    passed.push(
      `quota failure, ${changed ? "edited" : "unchanged"} draft, repeated retry exactly once`,
    );
  }

  const beforeAbort = await count();
  const logicalTimeBeforeAbort = (await app.store.ensureContext())
    .next_logical_time;
  edit("Aborted write");
  await failOnce("abort");
  check(
    (await count()) === beforeAbort,
    "abort after request success must roll back",
  );
  check(
    (await app.store.ensureContext()).next_logical_time ===
      logicalTimeBeforeAbort,
    "aborted write must roll back logical counter",
  );
  draft("Aborted write");
  app.retryButton.click();
  await idle();
  check((await count()) === beforeAbort + 1, "abort retry once");
  check(
    (await app.store.ensureContext()).next_logical_time ===
      logicalTimeBeforeAbort + 1n,
    "successful retry commits event and counter once",
  );
  draft("");
  passed.push("transaction abort after request success, recovery");

  const append = app.store.append.bind(app.store);
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  app.store.append = async (...args) => {
    await gate;
    return append(...args);
  };
  edit("Pending original", "shopping");
  const event = {
    detail: { text: "Pending original", classification: "shopping" },
  };
  const operation = app.ctx.items.handleAddItem(event);
  check(app.busy, "pending operation is busy");
  check(app.busy, "the pending operation keeps controls busy");
  edit("Newer pending draft", "need");
  event.detail.text = "Mutated event detail";
  release();
  await operation;
  await idle();
  app.store.append = append;
  check(
    app.state.items.at(-1).text === "Pending original",
    "submission snapshot",
  );
  check(
    app.state.items.at(-1).classification === "shopping",
    "classification submission snapshot",
  );
  draft("Newer pending draft");
  passed.push(
    "delayed add preserves newer text/classification in-memory draft",
  );

  const findItem = (text) =>
    [...app.querySelectorAll("kin-item")].find(
      (item) => item.querySelector(".item-text")?.textContent === text,
    );
  const actionText = "Action retry";
  edit(actionText);
  await submit();
  let actionItem = findItem(actionText);
  let actionEventCount = await count();
  await failOnce("quota", async () => {
    actionItem.querySelector(".complete-button").click();
    await idle();
  });
  check(
    app.state.items.find((item) => item.text === actionText).status ===
      "active",
    "failed completion leaves item active",
  );
  check(
    (await count()) === actionEventCount,
    "failed completion does not append",
  );
  app.retryButton.click();
  await idle();
  check(
    app.state.items.find((item) => item.text === actionText).status ===
      "completed",
    "completion retry applies once",
  );
  check(
    (await count()) === actionEventCount + 1,
    "completion retry appends once",
  );

  actionItem = findItem(actionText);
  actionEventCount = await count();
  await failOnce("abort", async () => {
    actionItem.querySelector(".reopen-button").click();
    await idle();
  });
  check(
    app.state.items.find((item) => item.text === actionText).status ===
      "completed",
    "aborted reopen leaves item completed",
  );
  check((await count()) === actionEventCount, "aborted reopen does not append");
  let releaseRetry;
  const retryGate = new Promise((done) => {
    releaseRetry = done;
  });
  let appendCalls = 0;
  app.store.append = async (...args) => {
    appendCalls++;
    await retryGate;
    return append(...args);
  };
  app.retryButton.click();
  check(app.busy, "retry remains busy while append is pending");
  const checkControls = (disabled) => {
    for (const selector of [
      ".complete-button",
      ".reopen-button",
      ".item-details-button",
      ".item-attach-button",
    ]) {
      const buttons = [...app.querySelectorAll(`kin-item ${selector}`)];
      check(buttons.length > 0, `fixture must expose ${selector}`);
      check(
        buttons.every((button) => button.matches(":disabled") === disabled),
        `${selector} disabled state`,
      );
    }
    for (const control of [
      compose.input,
      compose.classification,
      compose.button,
      app.retryButton,
    ]) {
      check(control.matches(":disabled") === disabled, `${control.tagName} disabled state`);
    }
  };
  checkControls(true);
  check(app.controlFieldset.disabled, "busy workspace uses native fieldset disabling");
  check(
    [app.status, app.alert, app.stateNotice, app.routeAnnouncement].every(
      (region) => !app.controlFieldset.contains(region),
    ),
    "live status regions remain outside the disabled workspace",
  );
  // Native disabled buttons must suppress activation, including retry clicks.
  let activations = 0;
  const recordActivation = () => {
    activations++;
  };
  app.addEventListener("click", recordActivation);
  for (const button of [
    ...[...app.main.querySelectorAll("button")].filter(
      (control) => !control.closest("kin-security"),
    ),
    app.retryButton,
  ]) button.click();
  app.removeEventListener("click", recordActivation);
  check(activations === 0, "busy controls must not dispatch clicks");
  check((await count()) === actionEventCount, "pending retry has not appended");
  releaseRetry();
  await idle();
  app.store.append = append;
  check(appendCalls === 1, "busy clicks must not start additional writes");
  check(
    [...app.querySelectorAll("kin-item button")].every(
      (button) => !button.matches(":disabled"),
    ) &&
      !compose.input.matches(":disabled") &&
      !compose.classification.matches(":disabled") &&
      !compose.button.matches(":disabled") &&
      !app.retryButton.matches(":disabled"),
    "all appropriate controls become usable after retry",
  );
  check(
    document.activeElement === compose.input,
    "pending retry restores compose focus",
  );
  passed.push(
    "pending retry disables Complete, Reopen, every Details and Add photo, compose input/select/Add and retry; controls and focus recover",
  );
  const deferredListFocus = app.today.querySelector("button:not(:disabled)");
  check(Boolean(deferredListFocus), "focus fixture has a list control");
  app.today.deferredFocus = deferredListFocus;
  app.ctx.status.setBusy(true);
  app.searchLink.focus();
  check(document.activeElement === app.searchLink, "header search can receive focus while the workspace is busy");
  app.ctx.status.setBusy(false);
  check(document.activeElement === app.searchLink, "ending busy preserves focus the user moved to header search");
  passed.push("busy focus recovery does not override a deliberate move to header search");
  compose.focusInput();
  check(
    app.state.items.find((item) => item.text === actionText).status ===
      "active",
    "reopen retry applies once",
  );
  check((await count()) === actionEventCount + 1, "reopen retry appends once");

  actionItem = findItem(actionText);
  actionEventCount = await count();
  await failOnce("quota", async () => {
    details(app.state.items.find((item) => item.text === actionText).itemId).querySelector(".archive-button").click();
    await idle();
  }, () => app.detail.contains(document.activeElement));
  check(
    app.state.items.find((item) => item.text === actionText).status ===
      "active",
    "failed archive leaves item active",
  );
  check((await count()) === actionEventCount, "failed archive does not append");
  app.retryButton.click();
  await idle();
  check(
    app.state.items.find((item) => item.text === actionText).status ===
      "archived",
    "archive retry applies once",
  );
  check((await count()) === actionEventCount + 1, "archive retry appends once");
  check(
    !findItem(actionText),
    "archived action control disappears after state transition",
  );
  check(app.detail.contains(document.activeElement) && app.detail.textContent.includes("archived") && !app.detail.querySelector(".archive-button"),
    "after the archive retry the detail explains the archived record and keeps focus nearby");
  app.ctx.detail.closeItemDetail({ restoreFocus: true });
  check(document.activeElement?.matches("h1, h2") && !document.activeElement.closest("[hidden]"), "closing details for a record that is gone falls back to the visible heading");
  compose.focusInput();
  check(document.activeElement === compose.input, "lifecycle retry focus");
  passed.push(
    "complete/reopen/archive write failures, abort retry, exactly-once action transitions, focus",
  );

  const unicode =
    "\uFEFFMilk 🥛 café 家 <script>window.kinInjected=true</script>";
  edit(unicode);
  await submit();
  check(app.state.items.at(-1).text === unicode, "Unicode replay");
  check(
    [...app.querySelectorAll(".item-text")].some(
      (el) => el.textContent === unicode,
    ),
    "literal DOM text",
  );
  check(
    !window.kinInjected && !app.querySelector("script"),
    "inert script-like text",
  );
  const unicodeItem = [...app.querySelectorAll("kin-item")].find(
    (item) => item.querySelector(".item-text")?.textContent === unicode,
  );
  unicodeItem.querySelector(".complete-button").click();
  await idle();
  check(
    app.state.items.find((item) => item.text === unicode).status ===
      "completed",
    "completion",
  );
  check(document.activeElement === compose.input, "completion focus");
  draft("");
  const completedItem = [...app.querySelectorAll("kin-item")].find(
    (item) => item.querySelector(".item-text")?.textContent === unicode,
  );
  completedItem.querySelector(".reopen-button").click();
  await idle();
  check(
    app.state.items.find((item) => item.text === unicode).status === "active",
    "reopen",
  );
  const reopenedItem = [...app.querySelectorAll("kin-item")].find(
    (item) => item.querySelector(".item-text")?.textContent === unicode,
  );
  const beforeArchive = await count();
  detailsFor(unicode).querySelector(".archive-button").click();
  await idle();
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  compose.focusInput();
  check(
    app.state.items.find((item) => item.text === unicode).status === "archived",
    "archive tombstone",
  );
  check(
    ![...app.querySelectorAll("kin-item")].some(
      (item) => item.querySelector(".item-text")?.textContent === unicode,
    ),
    "archived item hidden from normal views",
  );
  check(
    (await count()) === beforeArchive + 1,
    "archive remains an appended event",
  );
  check(document.activeElement === compose.input, "archive focus destination");
  const checklistInitialCount = await count();
  edit("Checklist item", "need");
  await submit();
  let checklistRow = [...app.querySelectorAll("kin-item")].find(
    (item) => item.querySelector(".item-text")?.textContent === "Checklist item",
  );
  check(checklistRow && !checklistRow.querySelector(".step-summary"), "checklist parent Item is created and a row shows no step count before steps exist");
  // Steps live in the shared detail view; the detail re-renders in place.
  let checklistItem = detailsFor("Checklist item");
  const addStep = async (text) => {
    const form = checklistItem.querySelector(".step-compose");
    const input = form.querySelector("input");
    input.value = text;
    input.focus();
    form.requestSubmit();
    await idle();
    checklistItem = app.detail;
  };
  await addStep("Clear counters");
  await addStep("Wipe stove");
  let checklist = app.state.items.find((item) => item.text === "Checklist item");
  const rowSummary = () => [...app.querySelectorAll("kin-item")].find((item) => item.querySelector(".item-text")?.textContent === "Checklist item")?.querySelector(".step-summary")?.textContent;
  check(
    checklist.status === "active" &&
      checklist.steps.map((step) => step.text).join(",") === "Clear counters,Wipe stove" &&
      rowSummary() === "0 of 2 steps" &&
      document.activeElement === checklistItem.querySelector(".step-compose input"),
    "steps append in stable order without changing or losing the parent Item, and the row shows progress only once steps exist",
  );
  const stepArchiveNames = [
    ...checklistItem.querySelectorAll(".step-archive-button"),
  ].map((button) => button.getAttribute("aria-label"));
  check(
    stepArchiveNames.join("|") ===
      "Archive step Clear counters|Archive step Wipe stove" &&
      new Set(stepArchiveNames).size === 2,
    "each Step archive control has a distinct accessible name",
  );
  const stepCheckbox = (index) =>
    checklistItem.querySelectorAll('.step-row input[type="checkbox"]')[index];
  stepCheckbox(0).click();
  await idle();
  checklistItem = app.detail;
  stepCheckbox(1).click();
  await idle();
  checklist = app.state.items.find((item) => item.text === "Checklist item");
  checklistItem = app.detail;
  check(
    checklist.status === "active" &&
      checklist.steps.every((step) => step.completed) &&
      rowSummary() === "2 of 2 steps",
    "completing every Step does not complete the parent Item",
  );
  stepCheckbox(0).click();
  await idle();
  checklistItem = app.detail;
  checklistItem.querySelector(".step-archive-button").click();
  await idle();
  checklist = app.state.items.find((item) => item.text === "Checklist item");
  checklistItem = app.detail;
  check(
    checklist.status === "active" &&
      checklist.steps[0].archived &&
      checklist.steps[1].completed &&
      checklistItem.querySelectorAll(".step-row").length === 1 &&
      rowSummary() === "1 of 1 steps",
    "reopen and terminal Step archive preserve history and update the visible summary",
  );
  checklistItem.querySelector(".complete-button").click();
  await idle();
  checklistItem = app.detail;
  check(
    checklistItem.querySelector('.step-row input[type="checkbox"]').disabled &&
      checklistItem.querySelector(".step-compose input").disabled,
    "completed parent Items disable Step mutations",
  );
  checklistItem.querySelector(".reopen-button").click();
  await idle();
  checklistItem = app.detail;
  check(
    !checklistItem.querySelector('.step-row input[type="checkbox"]').disabled &&
      !checklistItem.querySelector(".step-compose input").disabled &&
      (await count()) === checklistInitialCount + 9,
    "reopening the parent restores Step controls",
  );
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  passed.push(
    "checklist Step add/order/complete/reopen/archive, parent independence, lifecycle gating and focus",
  );
  const todayItem = [...app.querySelectorAll("kin-item")].find(
    (item) => item.querySelector(".item-text")?.textContent === legacyText,
  );
  todayItem.querySelector(".complete-button").click();
  await idle();
  check(
    app.state.items.find((item) => item.text === legacyText).status ===
      "completed",
    "completion works in Today",
  );
  check(
    app.today.querySelector(`.item-text[data-item-id="${app.state.items.find((item) => item.text === legacyText).itemId}"]`) &&
      app.needs.querySelector(`.item-text[data-item-id="${app.state.items.find((item) => item.text === legacyText).itemId}"]`),
    "an undated legacy Today item stays on Today and is also listed under To do",
  );
  detailsFor(legacyText).querySelector(".archive-button").click();
  await idle();
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  check(
    app.state.items.find((item) => item.text === legacyText).status ===
      "archived",
    "completed Today item can be archived",
  );
  const beforeInvalidMutation = await count();
  let rejectedArchivedMutation = false;
  try {
    await app.store.append(
      {
        type: "reopen",
        itemId: app.state.items.find((item) => item.text === unicode).itemId,
      },
      app.engine,
    );
  } catch {
    rejectedArchivedMutation = true;
  }
  check(rejectedArchivedMutation, "archived mutation is rejected");
  check(
    (await count()) === beforeInvalidMutation,
    "invalid archived mutation does not append",
  );
  sessionStorage.setItem(
    "kin.test.archivedTexts",
    JSON.stringify([unicode, legacyText]),
  );
  passed.push(
    "Needs and Today completion, reopen, archive, invalid-transition non-append, focus, Unicode, inert rendering",
  );

  const originalSet = Storage.prototype.setItem;
  const originalRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = Storage.prototype.removeItem = () => {
    throw new DOMException("Blocked", "SecurityError");
  };
  try {
    edit("Storage unavailable");
    await submit();
    check(compose.input.value === "", "blocked storage must not prevent add");
  } finally {
    Storage.prototype.setItem = originalSet;
    Storage.prototype.removeItem = originalRemove;
  }
  edit("Restored after reload");
  sessionStorage.removeItem(classificationKey);
  sessionStorage.setItem("kin.test.expectedState", JSON.stringify(app.state));
  passed.push("sessionStorage denial does not prevent persistence");

  // An invitation link carries its code in the fragment (#97); a code in the
  // query is no longer used (it has already reached the server).
  history.replaceState(null, "", "/pair#code=F7KM-Q2DX");
  const household = document.createElement("kin-household");
  document.body.append(household);
  // connectedCallback takes the code out of the address synchronously.
  check(
    location.pathname === "/pair" && location.search === "" && location.hash === "",
    "invitation code must be removed from browser history immediately",
  );
  // The join form is drawn only when the element's first status load
  // (`household.loaded`) settles: three security-epoch reads from IndexedDB
  // and a /api/status round trip. A fixed ~1 s poll for the input lost that
  // race on the Windows Edge runner, where those reads can queue behind the
  // app's own IndexedDB writes (#469). Wait for the load itself, bounded.
  const prefillStarted = performance.now();
  const prefillLoad = await Promise.race([
    household.loaded,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 30_000)),
  ]);
  const prefillFacts = () => JSON.stringify({
    load: prefillLoad,
    ms: Math.round(performance.now() - prefillStarted),
    path: location.pathname + location.search + location.hash,
    input: Boolean(household.querySelector('input[name="code"]')),
    value: household.querySelector('input[name="code"]')?.value ?? null,
    message: household.querySelector(".household-message")?.textContent ?? null,
  });
  check(
    household.querySelector('input[name="code"]')?.value === "F7KM-Q2DX",
    `invitation code must prefill after URL cleanup (${prefillFacts()})`,
  );

  for (const [state, expected] of [
    ["Expired", "expired"],
    ["Revoked", "revoked"],
    ["Rejected", "rejected"],
  ]) {
    household.claim = { state };
    household.render();
    check(
      household.claim === null,
      `${state} claim must be cleared from component state`,
    );
    check(
      household.querySelector('input[name="code"]'),
      `${state} claim must allow a new code`,
    );
    check(
      household
        .querySelector(".household-message")
        ?.textContent.toLowerCase()
        .includes(expected),
      `${state} claim must explain why entry is available again`,
    );
  }
  household.querySelector('input[name="code"]').value = "ABCD-Q2DX";
  check(
    household.querySelector('input[name="code"]').value === "ABCD-Q2DX",
    "new code entry must remain editable after a terminal claim",
  );
  history.replaceState(null, "", "/");
  household.render();
  check(
    [...household.querySelectorAll("button")].some(
      (button) => button.textContent === "Sign in with my passkey",
    ),
    "existing members need a login action after logout",
  );
  household.remove();
  passed.push(
    "pairing URL secret cleanup, terminal claim recovery, and passkey login entry",
  );
  return passed;
}

try {
  const port = await waitForDevTools(browser, profile);
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  console.log(
    `Browser: ${version.Browser}; Node: ${process.version}; ${process.platform}/${process.arch}`,
  );
  browserClient = await connect(version.webSocketDebuggerUrl);
  async function tab() {
    const target = await (
      await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })
    ).json();
    const client = await connect(target.webSocketDebuggerUrl);
    for (const domain of ["Runtime", "Page", "Log", "Network"])
      await client.send(`${domain}.enable`);
    // Worker starts, stops and version changes go into the load trace (#594).
    await client.send("ServiceWorker.enable").catch(() => {});
    await applyRegressionDefaults((method, params) => client.send(method, params));
    await client.send("Page.navigate", { url: origin });
    // A new tab on the Windows runner sometimes never runs Kin's modules
    // (kin-app stays undefined, no error; #327). The start-up guard
    // (web/boot-guard.js) loads such a start again itself, so the tab waits
    // for it: a reload from here would cancel the guard's own (#469). Only
    // when the guard has given up and says Kin didn't finish loading does the
    // tab press its Try again, once.
    const evaluate = (expression) => client.evaluate(expression);
    await waitForOrigin(evaluate, origin, {
      timeoutMs: KIN_START_TIMEOUT_MS,
      navigate: () => client.send("Page.navigate", { url: origin }),
      ready: 'Boolean(customElements.get("kin-app") || document.querySelector("[data-kin-boot-failed] button"))',
      readyText: " or start Kin (or give up)",
    });
    if (!(await evaluate('Boolean(customElements.get("kin-app"))').catch(() => false))) {
      console.log(`NOTE new tab had not defined kin-app after the start-up guard's reloads (${JSON.stringify(await tabFacts(client))}); trying again (#327)`);
      printLoadTrace(client);
      await evaluate('document.querySelector("[data-kin-boot-failed] button").click()').catch(() => {});
    }
    await ready(client);
    return client;
  }
  // The tab's load trace (#594). In GitHub Actions each line is a warning
  // annotation, so it is readable even when the retry passes.
  function printLoadTrace(client) {
    printTrace(client.loadTrace);
  }
  // What a tab was doing, so a slow start can be told from a stuck one (#327).
  function tabFacts(client) {
    return client.evaluate(`({
      href: location.href, readyState: document.readyState, app: Boolean(document.querySelector("kin-app")),
      defined: Boolean(customElements.get("kin-app")), controlled: Boolean(navigator.serviceWorker?.controller),
      worker: navigator.serviceWorker?.controller?.state ?? null,
      modules: performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith(".js")).length,
      lastModules: performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith(".js")).slice(-3).map((entry) => new URL(entry.name).pathname),
      navigation: performance.getEntriesByType("navigation")[0]?.type ?? null,
      security: Boolean(document.querySelector("kin-app")?.security), phase: document.querySelector("kin-app")?.security?.phase ?? null,
      starting: Boolean(document.querySelector("kin-app")?.starting), busy: document.querySelector("kin-app")?.busy ?? null,
      status: document.querySelector("kin-app")?.status?.textContent ?? null, body: document.body?.innerText?.slice(0, 200) ?? null,
    })`).catch((reason) => ({ unreadable: String(reason?.message ?? reason) }));
  }
  async function ready(client) {
    // 30 s: a new tab's first start can exceed 10 s on the Windows runner (#164).
    try {
      await until(() => client.evaluate('Boolean(document.querySelector("kin-app")?.security?.heading)'), { attempts: 600 });
    } catch (error) {
      const state = await tabFacts(client);
      printLoadTrace(client);
      error.message += ` — tab state ${JSON.stringify(state)}; unfinished requests ${JSON.stringify(client.unfinished())}; failed requests ${JSON.stringify(client.failed())}; recent problems ${JSON.stringify(problems.slice(-5)).slice(0, 2000)}`;
      throw error;
    }
    const locked = await client.evaluate('document.querySelector("kin-app").security.phase !== "unlocked"');
    if (locked) await client.evaluate(`(async () => {
      const security = document.querySelector("kin-app").security;
      if (security.manifest) await security.unlockRecovery(${JSON.stringify(recoverySecret)});
      else await security.establishProtection(${JSON.stringify(recoverySecret)});
    })()`);
    await until(() => client.evaluate('Boolean(document.querySelector("kin-app")?.store && !document.querySelector("kin-app").busy)'), { attempts: 600 });
  }
  async function householdState(client, predicate) {
    try {
      // Up to 30 s: a household round trip between two tabs can take longer
      // than until()'s default 10 s on the Windows runner (#164).
      await until(() => client.evaluate(`(()=>{const app=document.querySelector('kin-app');return !!app&&!app.busy&&!app.refreshing&&!app.pendingRefresh&&!app.wakePending&&(${predicate})})()`), { attempts: 600 });
    } catch (error) {
      const state = await client.evaluate(`(()=>{const app=document.querySelector('kin-app');return {busy:app?.busy,refreshing:app?.refreshing,pendingRefresh:app?.pendingRefresh,wakePending:app?.wakePending,status:app?.status?.textContent,alert:app?.alert?.textContent,focus:document.activeElement?.outerHTML?.slice(0,160),handoffs:app?.state?.handoffs?.map(row=>({text:row.text,status:row.status}))}})()`);
      throw new Error(`${error.message} for ${predicate.slice(0, 200)}; household state: ${JSON.stringify(state)}`);
    }
  }
  // Presses Enter on the focused control until `done` holds. On the Windows
  // runner a keystroke can land while a background refresh briefly disables
  // the control and be dropped (#164). Enter is pressed again only while
  // `pending` shows nothing happened: same focused, enabled control, no
  // result, so it can never submit twice.
  async function pressEnterUntil(client, done, pending) {
    for (let press = 1; press <= 3; press++) {
      for (const type of ["keyDown", "keyUp"])
        await client.send("Input.dispatchKeyEvent", {
          type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
          ...(type === "keyDown" ? { text: "\r" } : {}),
        });
      try {
        await until(() => client.evaluate(`(()=>{const app=document.querySelector('kin-app');return !!app&&!app.busy&&!app.refreshing&&!app.pendingRefresh&&!app.wakePending&&(${done})})()`), { attempts: 100 });
        return;
      } catch (error) {
        const dropped = press < 3 && await client.evaluate(`(()=>{const app=document.querySelector('kin-app');return !!app&&(${pending})})()`);
        if (!dropped) break;
      }
    }
    await householdState(client, done);
  }
  const first = await tab();
  async function visit(client, id) {
    const hash = `#${id}`;
    const page = id.split("/")[0];
    await client.evaluate(`location.hash=${JSON.stringify(hash)}`);
    await until(() =>
      client.evaluate(
        `location.hash===${JSON.stringify(hash)}&&!document.querySelector('kin-app').pages.get(${JSON.stringify(page)}).hidden`,
      ),
    );
  }
  if (process.env.KIN_VISUAL_CHECK === "1") {
    await until(() => first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      return app.household?.childElementCount && app.security?.childElementCount;
    })()`));
    for (const [mode, width, height, mobile] of [
      ["desktop", 1440, 960, false], ["mobile", 320, 720, true],
    ]) {
      await setViewport(first, {
        width, height, deviceScaleFactor: 1, mobile,
      });
      for (const id of ["today", "lists", "routines", "updates", "household"]) {
        await visit(first, id);
        await first.evaluate("window.scrollTo(0,0)");
        await delay(80);
        if (id === "routines" && mode === "mobile")
          console.log("Routine form layout:", await first.evaluate(`(()=>{
            const form=document.querySelector('#routines .routine-form');
            const input=form.querySelector('input');
            return {viewport:innerWidth,form:form.getBoundingClientRect().width,
              input:input.getBoundingClientRect().width,
              columns:getComputedStyle(form).gridTemplateColumns,
              inputColumn:getComputedStyle(input).gridColumn};
          })()`));
        await writeFile(
          resolve(webRoot, `../target/design-${mode}-${id}.png`),
          Buffer.from(
            (await first.send("Page.captureScreenshot", { format: "png" })).data,
            "base64",
          ),
        );
      }
      await visit(first, "updates/chat");
      await first.evaluate("window.scrollTo(0,0)");
      await delay(80);
      await writeFile(
        resolve(webRoot, `../target/design-${mode}-talk.png`),
        Buffer.from(
          (await first.send("Page.captureScreenshot", { format: "png" })).data,
          "base64",
        ),
      );
    }
    await setViewport(first, {
      width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
    });
    await visit(first, "today");
  }
  await first.evaluate(`(async()=>{
    const app=document.querySelector('kin-app');
    app.ctx.session.lockHousehold(false);
    await app.security.unlockRecovery(${JSON.stringify(recoverySecret)});
    return true;
  })()`);
  await until(() => first.evaluate('Boolean(document.querySelector("kin-app")?.store && !document.querySelector("kin-app").busy)'));
  const stateRegression = await first.evaluate(`(()=>{
    const app=document.querySelector('kin-app');
    window.dispatchEvent(new Event('offline'));
    const offline=app.stateNotice.isConnected && !app.stateNotice.hidden && app.stateNotice.textContent.startsWith("You're offline. Your changes are saved on this device") &&
      !app.stateNotice.textContent.includes('sync') && app.stateNotice.getAttribute('role')==='status';
    app.ctx.sync.handleSyncState({state:'paused',code:'device_not_trusted',message:'device_not_trusted'});
    const revoked=app.stateNotice.textContent.startsWith('This device no longer has access to household updates') &&
      !app.stateNotice.textContent.includes('device_not_trusted');
    const status=app.status.textContent;
    app.ctx.sync.handleSyncState({state:'ready',message:'Device sync is up to date.'});
    const cleared=app.stateNotice.hidden;
    app.ctx.status.setStatus(status);
    const store=app.store; app.store=null; app.onOnline(); app.store=store;
    return {offline,revoked,cleared,notice:app.stateNotice.textContent,hidden:app.stateNotice.hidden,unlocked:!!app.vault&&!app.vault.locked};
  })()`);
  assert.equal(stateRegression.offline && stateRegression.revoked && stateRegression.cleared, true,
    `state notice stays attached through unlock-lock-unlock and offline/revoked-device states remain announced with truthful, human-readable copy (${JSON.stringify(stateRegression)})`);
  // KIN_REGRESSION_PART splits this suite in two for parallel CI jobs (#329).
  // Part 1 runs every single-tab check. Part 2 runs the quick in-page
  // single-tab checks too, because the two-tab checks build on the handoffs,
  // topics and routines they leave, then the two-tab checks; it skips the slow
  // browser-driven sections marked `heavy`. Unset runs everything once.
  const heavy = REGRESSION_PART !== "2";
  console.log(await first.evaluate(`(${regressions.toString()})()`));
  await first.evaluate(`document.querySelector('kin-app').nav.querySelector('a[href="#routines"]').focus()`);
  await first.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13,
  });
  await first.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
  });
  await visit(first, "routines");
  assert.equal(
    await first.evaluate("document.activeElement===document.querySelector('kin-app').navLinks.get('routines')"),
    true,
    "keyboard Enter activates a primary destination and retains navigation focus",
  );
  await visit(first, "today");
  await visit(first, "updates/handoffs");
  console.log(await first.evaluate(`(${handoffRegressions.toString()})()`));
  assert.deepEqual(await first.evaluate(`(async()=>{
    const app=document.querySelector('kin-app');
    const links=[...app.segmentNavs.get('updates').querySelectorAll('.segment-link')];
    const labels=links.map((link)=>link.textContent.trim().split(/\\s/)[0]).join();
    app.ctx.navigation.navigate('#updates/talk');
    for (let i=0;i<5;i++) await new Promise((r)=>requestAnimationFrame(r));
    const current=[...app.segmentNavs.get('updates').querySelectorAll('.segment-link')];
    return { labels, hash: location.hash, current: current[1]?.getAttribute('aria-current'),
      handoffsHidden: document.querySelector('#handoffs-panel').hidden, chatShown: !document.querySelector('#chat-panel').hidden,
      inList: Boolean(app.talks.closest('.chat-topics')), shown: !app.talks.closest('[hidden]'),
      hint: Boolean(app.talks.querySelector('.talk-hint')?.textContent.includes('Topics to discuss')) };
  })()`), { labels: "Handoffs,Chat", hash: "#updates/chat", current: "true", handoffsHidden: true, chatShown: true, inList: true, shown: true, hint: true },
    "Updates has Handoffs and Chat; an old Talk link opens Chat's To talk about list with the older topics (#312, #313)");
  console.log(await first.evaluate(`(${talkRegressions.toString()})()`));
  // The list the old Talk link opened closes again, leaving Chat its room.
  await first.evaluate(`document.querySelector('kin-app').chat.toggleTopics(false)`);
  await visit(first, "updates/chat");
  assert.equal(await first.evaluate(`(()=>{const app=document.querySelector('kin-app');const links=[...app.segmentNavs.get('updates').querySelectorAll('.segment-link')];
    return location.hash==='#updates/chat' && links[1]?.getAttribute('aria-current')==='true' && !document.querySelector('#chat-panel').hidden &&
      !document.querySelector('#talk-panel') && Boolean(document.querySelector('kin-chat .chat-scroll'));
  })()`), true, "Updates → Chat is the second segment");
  console.log(await first.evaluate(`(${chatRegressions.toString()})({ keepRoom: true })`));
  console.log(await chatLayoutRegressions(first, { until }));
  await visit(first, "household/areas");
  console.log(await first.evaluate(`(${pulseRegressions.toString()})()`));
  console.log(
    await first.evaluate(`(${pulseResilienceRegressions.toString()})()`),
  );
  await visit(first, "today");
  console.log(await first.evaluate(`(${catchUpRegressions.toString()})()`));
  await visit(first, "lists/shopping");
  console.log(await first.evaluate(`(${shoppingRegressions.toString()})()`));
  console.log(await first.evaluate(`(${mealsRegressions.toString()})()`));
  console.log(await mealsAcceptanceRegressions(first, until));
  // Fuller meal plans (#679): every meal, favourites, the week's Shopping.
  await visit(first, "lists/meals");
  console.log(await first.evaluate(`(${mealPlanRegressions.toString()})()`));
  await visit(first, "today");
  console.log(await first.evaluate(`(${planningDateRegressions.toString()})()`));
  await visit(first, "today");
  console.log(await first.evaluate(`(${shareRegressions.toString()})()`));
  await visit(first, "today");
  console.log(await first.evaluate(`(${weekRegressions.toString()})()`));
  // The family calendar (#660): views, editing, Undo, colours, import.
  await visit(first, "today");
  console.log(await calendarRegressions(first, { until }));
  console.log(await first.evaluate(`(${sitterRegressions.toString()})()`));
  console.log(await first.evaluate(`(${photoAlbumRegressions.toString()})()`));
  console.log(await first.evaluate(`(${rotationsRegressions.toString()})()`));
  // The chore chart (#676): a child's card, points, rewards, adults joining.
  console.log(await first.evaluate(`(${choreChartRegressions.toString()})()`));
  // Kitchen display mode (#669): tablet sizes, panels, leaving with the secret.
  await visit(first, "today");
  console.log(await kitchenDisplayRegressions(first, { until, recovery: recoverySecret }));
  console.log(await first.evaluate(`(${importRegressions.toString()})()`));
  console.log(await first.evaluate(`(${storeSectionsRegressions.toString()})()`));
  // Household features (#623–#626): off, hidden everywhere, on again.
  await visit(first, "today");
  console.log(await first.evaluate(`(${householdFeaturesRegressions.toString()})()`));
  // Outside calendars (#665): add, warning, read-only occurrences, turn off.
  // The link the calendar's server refuses logs its 4xx; that one is expected.
  await visit(first, "today");
  const calendarSyncStart = problems.length;
  console.log(await first.evaluate(`(${calendarSyncRegressions.toString()})(${JSON.stringify(CALENDAR_HARNESS_HOUSEHOLD)})`));
  problems.push(...problems.splice(calendarSyncStart).filter((entry) => !expectedCalendarRefusal(entry)));
  await visit(first, "today");
  await setViewport(first, { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  try {
    console.log(await first.evaluate(`(${shoppingModeRegressions.toString()})()`));
  } finally {
    await first.send("Emulation.clearDeviceMetricsOverride");
  }
  await visit(first, "today");
  console.log(await first.evaluate(`(${quickAddRegressions.toString()})()`));
  await visit(first, "today");
  console.log(await first.evaluate(`(${qrRegressions.toString()})(${JSON.stringify(qrExpected)})`));
  await visit(first, "today");
  if (heavy) console.log(await first.evaluate(`(${mobileUxRegressions.toString()})(${JSON.stringify(recoverySecret)})`));
  if (heavy) console.log(await attachmentUploadRegressions(first, { recovery: recoverySecret, visit: (id) => visit(first, id), scratch: profile }));
  if (heavy) console.log(await first.evaluate(`(${workspaceUxRegressions.toString()})(${JSON.stringify(recoverySecret)})`));
  if (heavy) console.log(await workspaceViewportRegressions(first, { visit: (id) => visit(first, id) }));
  await visit(first, "today");
  if (heavy) console.log(await first.evaluate(`(${todayActionableRegressions.toString()})(${JSON.stringify(recoverySecret)})`));
  // The lifecycle suite unlocks while the network is deliberately offline, so
  // the app's own status probe fails then. Only that exact failure, inside
  // this window, is expected; every other console error still fails the run.
  const offlineWindowStart = problems.length;
  if (heavy) console.log(await todayLifecycleRegressions(first, { visit: (id) => visit(first, id), ready }));
  const offlineStatusProbe = (entry) => entry.source === "network" && entry.text === "Failed to load resource: net::ERR_INTERNET_DISCONNECTED" &&
    typeof entry.url === "string" && new URL(entry.url).origin === origin && new URL(entry.url).pathname === "/api/status";
  problems.push(...problems.splice(offlineWindowStart).filter((entry) => !offlineStatusProbe(entry)));
  if (heavy) console.log(await keyboardCommandRegressions(first, { visit: (id) => visit(first, id), ready }));
  if (heavy) console.log(await bulkActionRegressions(first, { visit: (id) => visit(first, id), ready }));
  if (heavy) { await visit(first, "today"); console.log(await first.evaluate(`(${undoRegressions.toString()})()`)); }
  if (heavy) console.log(await recurringTaskRegressions(first, { visit: (id) => visit(first, id), ready }));
  // The hardening suite also unlocks offline; the same probe filter applies.
  const hardeningOfflineStart = problems.length;
  if (heavy) console.log(await dailyUxHardeningRegressions(first, { visit: (id) => visit(first, id), ready, tab }));
  problems.push(...problems.splice(hardeningOfflineStart).filter((entry) => !offlineStatusProbe(entry)));
  await visit(first, "routines");
  console.log(await first.evaluate(`(${routineRegressions.toString()})()`));
  const playbookResult = await first.evaluate(async () => {
    const app = document.querySelector("kin-app"), ui = app.routines;
    const wait = async () => { for (let i = 0; app.busy && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 10)); };
    const form = ui.playbookList.parentElement.querySelector("form");
    const titleErrorId = ui.playbookTitle.getAttribute("aria-describedby");
    ui.playbookTitle.value = "界".repeat(43);
    ui.playbookEntries.value = "A valid step";
    form.requestSubmit();
    const invalidCreateTitle = ui.playbookTitle.getAttribute("aria-invalid") === "true" && titleErrorId === ui.playbookTitleError.id && ui.playbookTitleError.textContent === "This checklist name is too long." && !ui.playbookTitleError.hidden && !app.busy;
    ui.playbookTitle.value = "A valid title";
    ui.playbookEntries.value = "界".repeat(86);
    form.requestSubmit();
    const entryErrorId = ui.playbookEntries.getAttribute("aria-describedby").split(/\s+/).find(id => id.includes("entry-error"));
    const invalidCreateEntry = ui.playbookEntries.getAttribute("aria-invalid") === "true" && ui.playbookEntryErrors.querySelector(`#${entryErrorId}`)?.textContent === "Step 1: This step is too long." && !app.busy;
    const uniqueIds = () => { const ids = [...document.querySelectorAll("[id]")].map(node => node.id); return ids.length === new Set(ids).size; };
    const uniqueIdsAfterInvalid = uniqueIds();
    ui.playbookTitle.value = "Regression playbook";
    ui.playbookEntries.value = "First step\nSecond step";
    form.requestSubmit();
    await wait();
    const record = app.state.playbooks.find(item => item.title === "Regression playbook");
    if (!record || record.entries.join("|") !== "First step|Second step") return false;
    const append = app.ctx.append.appendCommand;
    let guardedAppends = 0;
    app.ctx.append.appendCommand = async command => { guardedAppends++; return append.call(app.ctx.append, command); };
    app.busy = true;
    await app.ctx.routines.handlePlaybookIntent(new CustomEvent("kin:archive-playbook", { detail: { playbookId: record.playbookId } }));
    app.busy = false;
    app.ctx.append.appendCommand = append;
    const operationGuarded = guardedAppends === 0 && !app.state.playbooks.find(value => value.playbookId === record.playbookId).archived;
    const instantiate = app.ctx.routines.instantiatePlaybook.bind(app.ctx.routines); let savedBatch;
    app.ctx.routines.instantiatePlaybook = batch => { savedBatch = batch; return instantiate(batch); };
    const appendForChecklist = app.ctx.append.appendCommand;
    const renderForChecklist = app.ctx.render.renderState;
    const broadcastForChecklist = app.ctx.peers.broadcastEventChange;
    let checklistSteps = 0, partialRenders = 0, partialBroadcasts = 0;
    app.ctx.append.appendCommand = async command => {
      if (command.type === "add-item-step" && ++checklistSteps === 2)
        throw Object.assign(new Error("Synthetic checklist failure"), { userMessage: "Kin could not save that change locally." });
      return appendForChecklist.call(app.ctx.append, command);
    };
    app.ctx.render.renderState = (...args) => { partialRenders++; return renderForChecklist.apply(app.ctx.render, args); };
    app.ctx.peers.broadcastEventChange = (...args) => { partialBroadcasts++; return broadcastForChecklist.apply(app.ctx.peers, args); };
    [...ui.playbookList.querySelectorAll("button")].find(button => button.textContent === "Use checklist").click();
    await wait();
    app.ctx.append.appendCommand = appendForChecklist;
    app.ctx.render.renderState = renderForChecklist;
    app.ctx.peers.broadcastEventChange = broadcastForChecklist;
    const partialItem = app.state.items.find(value => value.text === "Regression playbook");
    const partialReported = partialItem?.steps.length === 1 && partialRenders === 1 && partialBroadcasts === 1 &&
      app.alert.textContent === "Checklist partly created. Retry to add the remaining steps." && !app.retryButton.hidden;
    app.retryButton.click();
    await wait();
    const item = app.state.items.find(value => value.text === "Regression playbook");
    if (!item || item.steps.map(step => step.text).join("|") !== "First step|Second step") return false;
    const itemCount = app.state.items.length;
    await instantiate(savedBatch); await wait();
    if (app.state.items.length !== itemCount || app.state.items.find(value => value.itemId === item.itemId).steps.length !== 2) return false;
    [...ui.playbookList.querySelectorAll("button")].find(button => button.textContent === "Edit").click();
    ui.playbookTitle.value = "P".repeat(129); ui.playbookEntries.value = "Changed later";
    form.requestSubmit();
    const invalidEditTitle = ui.playbookTitle.getAttribute("aria-invalid") === "true" && ui.playbookTitleError.textContent === "This checklist name is too long." && app.state.playbooks.find(value => value.playbookId === record.playbookId).title === "Regression playbook" && !app.busy;
    ui.playbookTitle.value = "Edited template"; ui.playbookEntries.value = "Changed later\n";
    form.requestSubmit();
    const emptyEditStepId = ui.playbookEntries.getAttribute("aria-describedby").split(/\s+/).find(id => id.includes("entry-error"));
    const invalidEditEntry = ui.playbookEntries.getAttribute("aria-invalid") === "true" && ui.playbookEntryErrors.querySelector(`#${emptyEditStepId}`)?.textContent === "Step 2: Checklist steps can't be empty." && !app.busy;
    ui.playbookTitle.value = "Edited template"; ui.playbookEntries.value = "Changed later";
    form.requestSubmit(); await wait();
    const independent = app.state.items.find(value => value.itemId === item.itemId);
    if (independent.text !== "Regression playbook" || independent.steps[0].text !== "First step") return false;
    [...ui.playbookList.querySelectorAll("button")].find(button => button.textContent === "Archive").click(); await wait();
    return { archived: app.state.playbooks.find(value => value.playbookId === record.playbookId).archived, invalidCreateTitle, invalidCreateEntry, invalidEditTitle, invalidEditEntry, uniqueIdsAfterInvalid, operationGuarded, partialReported };
  });
  assert.equal(playbookResult.archived, true, "Playbooks save ordered entries, instantiate independent checklist state, edit, and archive");
  assert.equal(playbookResult.invalidCreateTitle, true, "Playbook create rejects overlong UTF-8 title with associated inline feedback");
  assert.equal(playbookResult.invalidCreateEntry, true, "Playbook create rejects overlong UTF-8 step with associated inline feedback");
  assert.equal(playbookResult.invalidEditTitle, true, "Playbook edit uses the same title validation");
  assert.equal(playbookResult.invalidEditEntry, true, "Playbook edit rejects an empty step with associated inline feedback");
  assert.equal(playbookResult.uniqueIdsAfterInvalid, true, "Playbook validation keeps DOM IDs unique");
  assert.equal(playbookResult.operationGuarded, true, "Playbook commands refuse overlapping work at the handler boundary");
  assert.equal(playbookResult.partialReported, true, "A partial Playbook instantiation renders committed work, notifies peers, and offers Retry");
  console.log("PASS Playbook authoring, independent checklist instantiation, edit, and archive");
  const responsibilityLifecycle = await first.evaluate(async () => {
    const app = document.querySelector("kin-app");
    const item = app.state.items.find(value => value.text === "Regression playbook");
    const memberId = app.ctx.detail.responsibilityContext().memberId;
    if (!item || !memberId) return false;
    const append = app.ctx.append.appendCommand;
    const render = app.ctx.render.renderState;
    const flush = app.ctx.peers.flushPeerRefresh;
    let renders = 0, flushes = 0;
    app.ctx.append.appendCommand = async command => {
      const result = await append.call(app.ctx.append, command);
      if (command.type === "change-responsibility") app.pendingRefresh = true;
      return result;
    };
    app.ctx.render.renderState = (...args) => { renders++; return render.apply(app.ctx.render, args); };
    app.ctx.peers.flushPeerRefresh = (...args) => { flushes++; return flush.apply(app.ctx.peers, args); };
    try {
      await app.ctx.items.handleChangeResponsibility({ detail: { targetKind: "item", targetId: item.itemId, memberId } });
    } finally {
      app.ctx.append.appendCommand = append;
      app.ctx.render.renderState = render;
      app.ctx.peers.flushPeerRefresh = flush;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let index = 0; index < 300 && (app.busy || app.refreshing || app.pendingRefresh || app.wakePending); index++) await new Promise(resolve => setTimeout(resolve, 10));
    const owner = app.state.responsibilities.find(value => value.targetKind === "item" && value.targetId === item.itemId)?.memberId;
    const renderedOwner = app.needs.ownerContext?.responsibilities?.find(value => value.targetKind === "item" && value.targetId === item.itemId)?.memberId;
    return owner === memberId && renderedOwner === memberId && renders >= 1 && flushes === 1 && !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending;
  });
  assert.equal(responsibilityLifecycle, true, "Responsibility changes render committed ownership and flush refreshes deferred while busy");
  await visit(first, "today");
  const backgroundResponsibilityFocus = await first.evaluate(async () => {
    const app = document.querySelector("kin-app");
    const input = app.compose.input;
    const item = app.state.items.find(value => value.status !== "archived");
    const currentMember = app.ctx.detail.responsibilityContext().memberId;
    if (!item || !currentMember) return false;
    const append = app.ctx.append.appendCommand;
    const setBusy = app.ctx.status.setBusy;
    const coordinator = app.syncCoordinator;
    const responsibilities = app.state.responsibilities;
    let busyCalls = 0;
    app.syncCoordinator = {
      ...(coordinator ?? {}),
      identity: { ...(coordinator?.identity ?? {}), memberId: currentMember },
    };
    app.activeMemberIds = [currentMember];
    app.state.responsibilities = [{ targetKind: "item", targetId: item.itemId, memberId: "ff".repeat(16) }];
    app.ctx.append.appendCommand = async command => {
      await Promise.resolve();
      if (command.type === "change-responsibility") app.state.responsibilities = [];
    };
    app.ctx.status.setBusy = (...args) => { busyCalls++; return setBusy.apply(app.ctx.status, args); };
    input.focus();
    try {
      await app.ctx.sync.reconcileResponsibilityMembers();
      return busyCalls === 0 && !app.compose.input.disabled && document.activeElement === app.compose.input;
    } finally {
      app.ctx.append.appendCommand = append;
      app.ctx.status.setBusy = setBusy;
      app.syncCoordinator = coordinator;
      app.state.responsibilities = responsibilities;
    }
  });
  assert.equal(backgroundResponsibilityFocus, true, "Background responsibility reconciliation leaves Today capture enabled and focused");
  // #351: a refresh keeps Kin unlocked in the same tab; Lock, the setting and
  // a non-refresh navigation still leave it locked.
  if (heavy) try {
    // Each condition carries its expression as a label, so a timeout names it.
    const safely = (expression) => Object.assign(async () => { try { return await first.evaluate(expression); } catch { return false; } }, { label: expression });
    const settled = safely('(()=>{const app=document.querySelector("kin-app");return Boolean(app?.security?.heading)&&!app.busy&&(app.security.phase!=="unlocked"||Boolean(app.store))&&!app.starting})()');
    const phase = () => first.evaluate('document.querySelector("kin-app").security.phase');
    const armed = safely('Boolean(document.querySelector("kin-app")?.reloadResume?.armed)');
    assert.equal(await first.evaluate('getComputedStyle(document.documentElement).overscrollBehaviorY'), "none",
      "the page root stops the browser's pull-to-refresh");
    await first.evaluate('(()=>{localStorage.setItem("kin.reload-resume-enabled","on");const app=document.querySelector("kin-app");return app.reloadResume.arm(app.vault)})()');
    await until(armed);
    await first.evaluate('location.hash="#lists/shopping"');
    await first.send("Page.reload");
    await until(settled, { attempts: 600 });
    await until(safely('document.querySelector("kin-app").security.phase==="unlocked"&&Boolean(document.querySelector("kin-app").store)'), { attempts: 600 });
    assert.equal(await first.evaluate('location.hash'), "#lists/shopping", "a refresh keeps Kin unlocked on the same page");
    assert.equal(await first.evaluate('sessionStorage.getItem("kin.reload-resume")'), null, "the resume ticket is used once");
    await until(armed);
    await first.evaluate('document.querySelector("kin-app").lockButton.click()');
    await until(safely('document.querySelector("kin-app").security.phase!=="unlocked"'));
    await first.send("Page.reload");
    await until(settled, { attempts: 600 });
    await delay(500);
    assert.notEqual(await phase(), "unlocked", "after Lock, a refresh stays locked");
    await ready(first);
    await until(armed);
    await first.send("Page.navigate", { url: `${origin}/?resume-check=1#today` });
    await until(settled, { attempts: 600 });
    await delay(500);
    assert.notEqual(await phase(), "unlocked", "navigating to Kin again (not a refresh) stays locked");
    await ready(first);
    await first.evaluate('localStorage.setItem("kin.reload-resume-enabled","off")');
    await first.send("Page.reload");
    await until(settled, { attempts: 600 });
    await delay(500);
    assert.notEqual(await phase(), "unlocked", "with the setting off, a refresh locks like closing the tab");
    await ready(first);
    await first.evaluate('location.hash="#today"');
    console.log("PASS refresh keeps Kin unlocked in the same tab; Lock, navigation and the setting still lock (#351)");
  } catch (error) {
    // Where the tab was when a #351 wait ran out (#469).
    const resume = await first.evaluate(`({ navigation: performance.getEntriesByType("navigation")[0]?.type ?? null,
      ticket: Boolean(sessionStorage.getItem("kin.reload-resume")), armed: Boolean(document.querySelector("kin-app")?.reloadResume?.armed),
      preference: localStorage.getItem("kin.reload-resume-enabled") })`).catch((reason) => ({ unreadable: String(reason?.message ?? reason) }));
    printLoadTrace(first);
    error.message += ` — tab state ${JSON.stringify(await tabFacts(first))}; resume ${JSON.stringify(resume)}; unfinished requests ${JSON.stringify(first.unfinished())}; failed requests ${JSON.stringify(first.failed())}; recent problems ${JSON.stringify(problems.slice(-3)).slice(0, 800)}`;
    throw error;
  }
  // Home-screen shortcuts and the app icon count (#471): each shortcut loads
  // Kin locked, then lands after unlock; it ends unlocked on Today.
  try {
    console.log(await shortcutsBadgeRegressions(first, { origin, until, ready, recovery: recoverySecret }));
  } catch (error) {
    printLoadTrace(first);
    error.message += ` — tab state ${JSON.stringify(await tabFacts(first))}; unfinished requests ${JSON.stringify(first.unfinished())}; failed requests ${JSON.stringify(first.failed())}`;
    throw error;
  }
  if (heavy) console.log(await fridgeRegressions(first, until));
  // Easy mode and Help on every screen (#616, #620), before Simple view
  // reloads into the full layout.
  if (heavy) console.log(await easyModeRegressions(first, { until }));
  // The easy-mode sweep (#639): every page in easy mode at 320px and desktop.
  if (heavy) console.log(await easySweepRegressions(first, { until }));
  console.log(await simpleRegressions(first, { until, ready }));
  await first.evaluate(
    'sessionStorage.setItem("kin.test.expectedState", JSON.stringify(document.querySelector("kin-app").state))',
  );
  await first.send("Page.reload");
  await ready(first);
  const stateDifferences = await first.evaluate(`(() => {
    const before = JSON.parse(sessionStorage.getItem("kin.test.expectedState"));
    const after = document.querySelector("kin-app").state;
    return Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  })()`);
  assert.deepEqual(
    stateDifferences,
    [],
    "Rust-derived household and summary state survives reload",
  );
  assert.equal(
    await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      const expected=JSON.parse(sessionStorage.getItem('kin.test.catchUpCursor'));
      return JSON.stringify((await app.store.getCatchUpState()).cursor)===JSON.stringify(expected);
    })()`),
    true,
    "installation-local catch-up cursor survives reload",
  );
  await first.evaluate('sessionStorage.removeItem("kin.test.catchUpCursor")');
  await first.evaluate('sessionStorage.removeItem("kin.test.expectedState")');
  assert.equal(
    await first.evaluate(`(() => {
      const app = document.querySelector("kin-app");
      const archivedTexts = JSON.parse(sessionStorage.getItem("kin.test.archivedTexts"));
      const visibleTexts = [...app.querySelectorAll(".item-text")]
        .map(element => element.textContent);
      const archivedRows = app.store.loadEvents();
      return Promise.resolve(archivedRows).then(events =>
        archivedTexts.every(text =>
          app.state.items.find(item => item.text === text)?.status === "archived" &&
          !visibleTexts.includes(text)
        ) && events.filter(event => event.kind === "ITEM_ARCHIVED").length >= 2
      );
    })()`),
    true,
    "archived state survives reload and remains hidden",
  );
  assert.equal(
    await first.evaluate('document.querySelector("input").value'),
    "",
    "reload discards unsaved plaintext drafts",
  );
  assert.equal(
    await first.evaluate('(()=>{const c=document.querySelector("kin-app").compose;return `${c.classification.value}/${c.plan.value}/${c.pin.checked}`;})()'),
    "need/today/false",
    "reload defaults the ephemeral Today capture to a task planned for today, not pinned",
  );
  await first.evaluate(`(()=>{const input=document.querySelector('kin-compose input');input.value='Keyboard after unlock';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
  await first.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  await first.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await ready(first);
  assert.equal(
    await first.evaluate('document.querySelector("input").value'),
    "",
  );
  console.log("PASS recovery unlock/replay, draft disposal, keyboard submission");

  await visit(first, "updates/handoffs");
  await first.evaluate('document.querySelector("kin-app").ctx.navigation.navigate("#updates/handoffs")');
  assert.equal(
    await first.evaluate('document.querySelector("#handoff-text").value'),
    "",
    "Handoff draft is discarded on reload",
  );
  await first.evaluate(`(()=>{const input=document.querySelector('#handoff-text');input.value='Newer handoff draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
  // A background refresh (routine timers) may briefly disable the field; hold
  // focus on it before the keystroke so Enter cannot land on the body.
  await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');const input=document.querySelector('#handoff-text');if(app.busy||input.disabled)return false;if(document.activeElement!==input)input.focus();return document.activeElement===input;})()`));
  await pressEnterUntil(first,
    `app.state.handoffs.some(row=>row.text==='Newer handoff draft')&&document.querySelector('#handoff-text').value===''`,
    // Not submitted yet: the draft is still in the focused, enabled field.
    `!app.busy&&!app.state.handoffs.some(row=>row.text==='Newer handoff draft')&&document.activeElement===document.querySelector('#handoff-text')&&document.querySelector('#handoff-text').value==='Newer handoff draft'&&!document.querySelector('#handoff-text').disabled`);
  assert.equal(
    await first.evaluate('document.querySelector("#handoff-text").value'),
    "",
  );
  // Check idle and focus in one evaluate (#469): a background refresh that
  // starts between two evaluates disables the workspace fieldset, so focus()
  // on Got it does nothing. :disabled also sees a disabled ancestor fieldset.
  const focusGotIt = `(()=>{
    const app=document.querySelector('kin-app');
    const target=app.querySelector('kin-handoff-list [aria-label="Acknowledge Newer handoff draft"]');
    const idle=!app.busy&&!app.refreshing&&!app.pendingRefresh&&!app.wakePending&&!!target&&!target.matches(':disabled');
    if(idle&&document.activeElement!==target)target.focus();
    return {idle,focused:!!target&&document.activeElement===target,target:target?.outerHTML,active:document.activeElement?.outerHTML?.slice(0,200)};
  })()`;
  const handoffFocus = await until(async () => { const state = await first.evaluate(focusGotIt); return state.idle && state.focused && state; })
    .catch(() => first.evaluate(focusGotIt));
  assert.equal(handoffFocus.focused,true,JSON.stringify(handoffFocus));
  await pressEnterUntil(first,
    `app.state.handoffs.find(row=>row.text==='Newer handoff draft')?.status==='acknowledged'`,
    `!app.busy&&app.state.handoffs.find(row=>row.text==='Newer handoff draft')?.status!=='acknowledged'&&document.activeElement?.getAttribute('aria-label')==='Acknowledge Newer handoff draft'&&!document.activeElement.disabled`);
  // Read focus only while idle (#469): a background refresh that starts after
  // pressEnterUntil's idle check moves focus to the body until it ends.
  const composerFocus = `(()=>{const app=document.querySelector('kin-app');return {idle:!app.busy&&!app.refreshing&&!app.pendingRefresh&&!app.wakePending,focused:document.activeElement===document.querySelector('#handoff-text'),active:document.activeElement?.outerHTML?.slice(0,120)};})()`;
  const restoredFocus = await until(async () => { const state = await first.evaluate(composerFocus); return state.idle && state; })
    .catch(() => first.evaluate(composerFocus));
  assert.equal(restoredFocus.focused, true, JSON.stringify(restoredFocus));
  const keyboardHandoffState = await first.evaluate(`(()=>{const app=document.querySelector('kin-app');return {status:app.state.handoffs.find(row=>row.text==='Newer handoff draft')?.status,alert:app.alert.textContent,notice:app.status.textContent,button:!!app.querySelector('[aria-label="Acknowledge Newer handoff draft"]'),focus:document.activeElement?.outerHTML?.slice(0,120)}})()`);
  assert.equal(keyboardHandoffState.status, "acknowledged", JSON.stringify(keyboardHandoffState));
  console.log(
    "PASS Handoff draft disposal, keyboard capture/acknowledgement, focus restoration",
  );
  await first.evaluate('document.querySelector("kin-app").ctx.navigation.navigate("#updates/talk")');
  assert.equal(
    await first.evaluate('document.querySelector("#talk-text").value'),
    "",
    "Talk draft is discarded on reload",
  );
  await first.evaluate(`(()=>{const input=document.querySelector('#talk-text');input.value='Newer talk draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
  for (const type of ["keyDown", "keyUp"])
    await first.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
  await householdState(first, `app.state.talks.some(row=>row.text==='Newer talk draft')&&document.querySelector('#talk-text').value===''`);
  assert.equal(
    await first.evaluate('document.querySelector("#talk-text").value'),
    "",
  );
  await first.evaluate(
    'document.querySelector("kin-talk-list .complete-button").focus()',
  );
  for (const type of ["keyDown", "keyUp"])
    await first.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
  await householdState(first, `app.state.talks.find(row=>row.text==='Newer talk draft')?.status==='resolved'`);
  assert.equal(
    await first.evaluate(
      'document.activeElement === document.querySelector("#talk-text")',
    ),
    true,
  );
  assert.equal(
    await first.evaluate(
      'document.querySelector("kin-app").state.talks.at(-1).status',
    ),
    "resolved",
  );
  console.log(
    "PASS Talk draft disposal, keyboard capture/resolution, focus restoration",
  );
  // Exercise the remaining Talk lifecycle through native keyboard activation.
  for (const label of ["Reopen", "Resolve", "Archive"]) {
    await first.evaluate(`(()=>{
      const capture=document.querySelector('kin-app').talks;
      const row=[...capture.querySelectorAll('li')].find(row=>row.querySelector('.item-text').textContent==='Newer talk draft');
      [...row.querySelectorAll('button')].find(button=>button.textContent==='${label}').focus();
    })()`);
    for (const type of ["keyDown", "keyUp"])
      await first.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
    const expectedStatus = label === "Reopen" ? "open" : label === "Resolve" ? "resolved" : "archived";
    await householdState(first, `app.state.talks.find(row=>row.text==='Newer talk draft')?.status===${JSON.stringify(expectedStatus)}`);
    assert.equal(
      await first.evaluate(
        'document.activeElement===document.querySelector("#talk-text")',
      ),
      true,
    );
    assert.equal(
      await first.evaluate(
        'document.querySelector("kin-app").state.talks.at(-1).status',
      ),
      label === "Reopen"
        ? "open"
        : label === "Resolve"
          ? "resolved"
          : "archived",
    );
  }
  await first.evaluate('document.querySelector("#talk-text").focus()');
  await first.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await first.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  assert.equal(
    await first.evaluate(
      'document.activeElement===document.querySelector("kin-talk-list .add-button")',
    ),
    true,
    "Talk input followed by Add in native focus order",
  );
  console.log(
    "PASS Talk keyboard resolve/reopen/archive, focus and native tab order",
  );
  if (REGRESSION_PART !== "1") {
    const second = await tab();
    await second.evaluate(`window.peerReads=0; window.peerReplays=0; window.peerMessages=[];
      { const a=document.querySelector('kin-app'); const load=a.store.getCatchUpState.bind(a.store); const replay=a.engine.applyEvents;
        a.store.getCatchUpState=async()=>{window.peerReads++;return load();};
        a.engine.applyEvents=(...args)=>{window.peerReplays++;return replay(...args);};
        a.channel.addEventListener('message',e=>window.peerMessages.push(e.data)); }`);
    await first.evaluate(
      `{const a=document.querySelector('kin-app');a.compose.input.value='Peer addition';a.compose.classification.value='need';a.compose.saveDraft();a.compose.form.requestSubmit();}`,
    );
    await until(() =>
      second.evaluate(
        `document.querySelector('kin-app').state.items.some(i=>i.text==='Peer addition')`,
      ),
    );
    assert.deepEqual(
      await second.evaluate(
        "[window.peerReads,window.peerReplays,window.peerMessages]",
      ),
      [1, 1, [{ type: "events-changed" }]],
    );
    assert.equal(
      await second.evaluate(
        'JSON.stringify(document.querySelector("kin-app").state)',
      ),
      await first.evaluate(
        'JSON.stringify(document.querySelector("kin-app").state)',
      ),
    );
    console.log(await syncMotionRegressions(first, second));

    const raceItemId = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      app.compose.input.value='Peer action race';
      app.compose.saveDraft();
      app.compose.form.requestSubmit();
      for(let index=0;app.busy&&index<200;index++)
        await new Promise(resolve=>setTimeout(resolve,10));
      return app.state.items.find(item=>item.text==='Peer action race').itemId;
    })()`);
    await until(() =>
      second.evaluate(
        `document.querySelector('kin-app').state.items.some(item=>item.itemId==='${raceItemId}'&&item.status==='active')`,
      ),
    );
    const failedPeerAction = await second.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      window.peerActionCountBefore=(await app.store.loadEvents()).length;
      const item=[...app.querySelectorAll('kin-item')]
        .find(element=>element.record?.itemId==='${raceItemId}');
      const original=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){
        if(this.name==='events')
          throw new DOMException('Synthetic quota failure','QuotaExceededError');
        return original.apply(this,args);
      };
      try{
        item.querySelector('.complete-button').click();
        for(let index=0;app.busy&&index<200;index++)
          await new Promise(resolve=>setTimeout(resolve,10));
      }finally{
        IDBObjectStore.prototype.add=original;
      }
      return {retryVisible:!app.retryButton.hidden,status:app.state.items.find(row=>row.itemId==='${raceItemId}').status};
    })()`);
    assert.deepEqual(failedPeerAction, { retryVisible: true, status: "active" });
    await second.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      [...app.querySelectorAll('kin-item')]
        .find(item=>item.querySelector('.item-text')?.textContent==='Peer addition')
        .querySelector('.complete-button').focus();
    })()`);
    await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      app.ctx.detail.openItemDetail('${raceItemId}');
      app.detail.querySelector('.archive-button').click();
      for(let index=0;app.busy&&index<200;index++)
        await new Promise(resolve=>setTimeout(resolve,10));
      app.ctx.detail.closeItemDetail({ restoreFocus: false });
    })()`);
    await until(() =>
      second.evaluate(
        `document.querySelector('kin-app').state.items.find(item=>item.itemId==='${raceItemId}')?.status==='archived'&&!document.querySelector('kin-app').busy`,
      ),
    );
    assert.deepEqual(
      await second.evaluate(`(async()=>{
        const app=document.querySelector('kin-app');
        return {
          status:app.state.items.find(item=>item.itemId==='${raceItemId}').status,
          retryHidden:app.retryButton.hidden,
          focusRestored:document.activeElement===app.compose.input||document.activeElement?.getAttribute('aria-label')==='Complete Peer addition',
          itemVisible:[...app.querySelectorAll('kin-item')]
            .some(item=>item.record?.itemId==='${raceItemId}'),
          eventCount:(await app.store.loadEvents()).length,
          expectedCount:window.peerActionCountBefore+1,
          updateMessage:app.status.textContent,
        };
      })()`),
      {
        status: "archived",
        retryHidden: true,
        focusRestored: true,
        itemVisible: false,
        eventCount: (await second.evaluate("window.peerActionCountBefore")) + 1,
        expectedCount:
          (await second.evaluate("window.peerActionCountBefore")) + 1,
        updateMessage: "That item changed. Review its current state below.",
      },
    );
    const noSignalItemId = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      app.compose.input.value='Missed invalidation race';
      app.compose.saveDraft();
      app.compose.form.requestSubmit();
      for(let index=0;app.busy&&index<200;index++)
        await new Promise(resolve=>setTimeout(resolve,10));
      return app.state.items.find(item=>item.text==='Missed invalidation race').itemId;
    })()`);
    await until(() =>
      second.evaluate(
        `document.querySelector('kin-app').state.items.some(item=>item.itemId==='${noSignalItemId}'&&item.status==='active')`,
      ),
    );
    const noSignalFailedAction = await second.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      app.channel.removeEventListener('message',app.onPeerMessage);
      window.noSignalCountBefore=(await app.store.loadEvents()).length;
      const item=[...app.querySelectorAll('kin-item')]
        .find(element=>element.record?.itemId==='${noSignalItemId}');
      const original=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){
        if(this.name==='events')
          throw new DOMException('Synthetic quota failure','QuotaExceededError');
        return original.apply(this,args);
      };
      try{
        item.querySelector('.complete-button').click();
        for(let index=0;app.busy&&index<200;index++)
          await new Promise(resolve=>setTimeout(resolve,10));
      }finally{
        IDBObjectStore.prototype.add=original;
      }
      return !app.retryButton.hidden;
    })()`);
    assert.equal(noSignalFailedAction, true);
    await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      app.ctx.detail.openItemDetail('${noSignalItemId}');
      app.detail.querySelector('.archive-button').click();
      for(let index=0;app.busy&&index<200;index++)
        await new Promise(resolve=>setTimeout(resolve,10));
      app.ctx.detail.closeItemDetail({ restoreFocus: false });
    })()`);
    await second.evaluate(
      "document.querySelector('kin-app').retryButton.click()",
    );
    await until(() =>
      second.evaluate(`(()=>{
        const app=document.querySelector('kin-app');
        return !app.busy&&app.retryButton.hidden&&
          app.state.items.find(item=>item.itemId==='${noSignalItemId}')?.status==='archived';
      })()`),
    );
    assert.equal(
      await second.evaluate(
        `(async()=> (await document.querySelector('kin-app').store.loadEvents()).length === window.noSignalCountBefore+1)()`,
      ),
      true,
      "stale action retry reloads canonical history without appending",
    );
    assert.equal(
      await second.evaluate(
        'document.querySelector("kin-app").status.textContent',
      ),
      "That item changed. Review its current state below.",
    );
    await second.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      app.channel.addEventListener('message',app.onPeerMessage);
    })()`);
    console.log(
      "PASS two tabs, content-free invalidation, canonical IndexedDB reload, Rust replay",
    );

    await visit(first, "updates/handoffs");
    await visit(second, "updates/handoffs");
    await handoffPeerRegressions(first, second, until);
    await first.evaluate('document.querySelector("kin-app").ctx.navigation.navigate("#updates/talk")');
    await second.evaluate('document.querySelector("kin-app").ctx.navigation.navigate("#updates/talk")');
    await talkPeerRegressions(first, second, until);
    await visit(first, "household/areas");
    await visit(second, "household/areas");
    await pulsePeerRegressions(first, second, until, ready);
    await visit(first, "today");
    await visit(second, "today");
    await catchUpPeerRegressions(first, second, until);
    await eventArenaPeerRegressions(first, second, until);
    await incrementalRenderPeerRegressions(first, second, until);
    await visit(first, "household/areas");
    await pulseKeyboardRegressions(first, until);
    await visit(first, "routines");
    await visit(second, "routines");
    await routinePeerRegressions(first, second, until);
    await routineKeyboardRegressions(first, until);
    await visit(first, "household/areas");
    await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      app.modeSelect.value='vacation';
      app.modeSelect.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await until(() =>
      first.evaluate(`(()=>{
        const app=document.querySelector('kin-app');
        return !app.busy&&app.state.mode==='vacation';
      })()`),
    );
    const modeResult = await first.evaluate(`(async()=>{
        const app=document.querySelector('kin-app');
        const events=await app.store.loadEvents();
        return {
          mode:app.modeSelect.value,
          record:events.at(-1).kind,
          routineCount:app.state.routines.length,
          completionActions:app.routines.querySelectorAll('[data-action="complete-routine-occurrence"]').length,
          paused:app.routines.textContent.includes('paused during Vacation'),
        };
      })()`);
    assert.equal(modeResult.mode, "vacation");
    assert.equal(modeResult.record, "HOUSEHOLD_MODE_CHANGED");
    assert.ok(modeResult.routineCount > 0, "routine definitions remain intact");
    assert.equal(modeResult.completionActions, 0);
    assert.equal(modeResult.paused, true, "routine occurrences are paused");
    await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      app.modeSelect.value='normal';
      app.modeSelect.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await until(() =>
      first.evaluate(`(()=>{
        const app=document.querySelector('kin-app');
        return !app.busy&&(app.state.mode??'normal')==='normal';
      })()`),
    );
    console.log("PASS household mode replay, local persistence, and routine pause");
    await visit(first, "today");
    await visit(second, "today");
    await visit(first, "lists/todo");
    await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      // The item is planned for today and therefore also listed on the hidden
      // Today page; use the visible To do list.
      const item=[...app.needs.querySelectorAll('kin-item')]
        .find(element=>element.querySelector('.item-text')?.textContent==='Peer addition');
      item.querySelector('.complete-button').focus();
    })()`);
    await first.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      text: "\r",
      windowsVirtualKeyCode: 13,
    });
    await first.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await until(() =>
      first.evaluate(
        `!document.querySelector('kin-app').busy&&document.querySelector('kin-app').state.items.find(item=>item.text==='Peer addition')?.status==='completed'`,
      ),
    );
    assert.equal(
      await first.evaluate(
        'document.activeElement.getAttribute("aria-label")==="Reopen Peer addition"',
      ),
      true,
      "keyboard completion in Lists restores focus to that item's next action",
    );
    console.log("PASS keyboard item action and focus restoration");

    await first.evaluate(
      `{const a=document.querySelector('kin-app');a.remove();document.body.append(a);}`,
    );
    await ready(first);
    // Reconnecting must not duplicate capture forms: one Today form plus one
    // fixed-destination form per list (Needs, Shopping, Staples).
    assert.deepEqual(
      await first.evaluate(`(()=>({
        total:document.querySelectorAll("kin-compose .compose-form").length,
        today:document.querySelectorAll("#today kin-compose .compose-form:not(.compose-form-compact)").length,
        lists:[...document.querySelectorAll("#lists kin-compose")].map(node=>node.fixedClassification).join(","),
      }))()`),
      { total: 4, today: 1, lists: "need,shopping,staple" },
    );
    assert.deepEqual(await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      const {loadAppearance,saveAppearance}=await import('/appearance/store.js');
      const originalActor=app.store.actorId;
      const originalAppearance=await loadAppearance(app.store,app.vault);
      const otherActor='ab'.repeat(16);
      const count=store=>new Promise((resolve,reject)=>{const request=app.store.database.transaction(store).objectStore(store).count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      const before={events:await count('events'),outbox:await count('sync_outbox')};
      const a=await saveAppearance(app.store,app.vault,{version:1,mode:'dark',colorSource:'preset',seed:'#74507D',manual:{source:'preset',name:'Plum',seed:'#74507D'},image:null});
      app.store.actorId=otherActor;
      const bInitial=await loadAppearance(app.store,app.vault);
      await saveAppearance(app.store,app.vault,{version:1,mode:'light',colorSource:'custom',seed:'#16756F',manual:{source:'custom',name:'Custom color',seed:'#16756F'},image:null});
      const b=await loadAppearance(app.store,app.vault);
      app.store.actorId=originalActor;
      const restoredA=await loadAppearance(app.store,app.vault);
      await saveAppearance(app.store,app.vault,originalAppearance);
      const archive=await app.store.snapshotForArchive();
      const after={events:await count('events'),outbox:await count('sync_outbox')};
      return {aSeed:a.seed,bInitial:bInitial.colorSource??'inherit',bSeed:b.seed,restoredA:restoredA.seed,pipelineUnchanged:before.events===after.events&&before.outbox===after.outbox,archiveFields:Object.keys(archive).sort()};
    })()`), {
      aSeed: "#74507D", bInitial: "inherit", bSeed: "#16756F", restoredA: "#74507D",
      pipelineUnchanged: true, archiveFields: ["attachments", "events", "formatVersion", "local_context"],
    }, "personal appearance stays member-bound and absent from events, relay outbox, and portable snapshots");
    console.log("PASS personal appearance member isolation and household-pipeline exclusion");
    assert.deepEqual(await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      await location.hash.includes('appearance')||Promise.resolve();
      const appearance=app.appearance;
      const saves=[];
      const saveHandler=(event)=>{event.stopImmediatePropagation();saves.push(event.detail.value);event.detail.complete(event.detail.value,null);};
      appearance.addEventListener('kin:save-appearance',saveHandler,true);
      const invalid=()=>{appearance.hex.value='#12';appearance.hex.dispatchEvent(new Event('input'));};
      invalid(); appearance.choosePreset({id:'plum',name:'Plum',seed:'#74507D'}); await appearance.requestSave();
      const preset={saved:saves.at(-1)?.seed,hex:appearance.hex.value,error:appearance.hex.getAttribute('aria-invalid')};
      appearance.draft={...appearance.draft,image:{bytes:new Uint8Array([1]),type:'image/webp',width:1,height:1,seed:'#16756F'}};
      invalid(); appearance.useBackground.click(); await appearance.requestSave();
      const background={saved:saves.at(-1)?.seed,hex:appearance.hex.value,error:appearance.hex.getAttribute('aria-invalid')};
      appearance.hex.value='#256A91';appearance.hex.dispatchEvent(new Event('input'));
      invalid(); const before=saves.length; await appearance.requestSave();
      const rejected={unchanged:saves.length===before,error:appearance.hex.getAttribute('aria-invalid')};
      appearance.hex.value='#256A91';appearance.hex.dispatchEvent(new Event('input'));await appearance.requestSave();
      const custom={saved:saves.at(-1)?.seed,error:appearance.hex.getAttribute('aria-invalid')};
      appearance.removeEventListener('kin:save-appearance',saveHandler,true);
      return {preset,background,rejected,custom};
    })()`), {
      preset:{saved:"#74507D",hex:"#74507D",error:"false"},
      background:{saved:"#16756F",hex:"#16756F",error:"false"},
      rejected:{unchanged:true,error:"true"},
      custom:{saved:"#256A91",error:"false"},
    }, "appearance saves validate the active color source and clear stale hex errors");
    console.log("PASS appearance color-source validation");
    await visit(first, "household/appearance");
    assert.deepEqual(await first.evaluate(`(()=>{
      const appearance=document.querySelector('kin-app').appearance;
      window.__appearanceRadioSaved=structuredClone(appearance.saved);
      appearance.initialize({...appearance.saved,colorSource:'default',seed:'#984D38',manual:null});
      const radios=[...appearance.querySelectorAll('.appearance-swatch input[type="radio"]')];
      return {
        count:radios.length,
        names:new Set(radios.map(input=>input.name)).size,
        checked:radios.filter(input=>input.checked).map(input=>input.value),
        labels:radios.every(input=>input.labels?.length===1&&input.labels[0].textContent.trim().length>0),
        native:!appearance.swatches.hasAttribute('role')&&radios.every(input=>!input.hasAttribute('role')&&!input.hasAttribute('aria-checked')),
      };
    })()`), {count:8,names:1,checked:['default'],labels:true,native:true},
    "appearance presets expose one labeled native radio group without emulated radio state");
    await first.evaluate("document.querySelector('kin-app').appearance.querySelector('.appearance-follow').focus()");
    await first.send("Input.dispatchKeyEvent", {type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
    await first.send("Input.dispatchKeyEvent", {type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
    assert.equal(await first.evaluate(`(()=>{const appearance=document.querySelector('kin-app').appearance;return document.activeElement===appearance.presetControls.get('default')})()`), true,
      "one Tab from the preceding control enters the checked theme preset");
    await first.send("Input.dispatchKeyEvent", {type:"keyDown",key:"ArrowLeft",code:"ArrowLeft",windowsVirtualKeyCode:37});
    await first.send("Input.dispatchKeyEvent", {type:"keyUp",key:"ArrowLeft",code:"ArrowLeft",windowsVirtualKeyCode:37});
    await until(() => first.evaluate(`document.querySelector('kin-app').appearance.draft.seed==='#596675'`));
    assert.deepEqual(await first.evaluate(`(()=>{const appearance=document.querySelector('kin-app').appearance;const checked=[...appearance.querySelectorAll('.appearance-swatch input:checked')];return {checked:checked.map(input=>input.value),focus:document.activeElement?.value,source:appearance.draft.colorSource,feedback:appearance.feedback.textContent}})()`),
      {checked:['slate'],focus:'slate',source:'preset',feedback:'Unsaved changes.'},
      "native ArrowLeft wraps to Slate and previews that preset");
    await setViewport(first, {width:320,height:720,deviceScaleFactor:1,mobile:false});
    assert.deepEqual(await first.evaluate(`(()=>{const appearance=document.querySelector('kin-app').appearance;const labels=[...appearance.querySelectorAll('.appearance-swatch')],checked=labels.find(label=>label.querySelector('input').checked),radio=checked.querySelector('input');return {overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,targets:labels.every(label=>label.getBoundingClientRect().height>=44),checked:labels.filter(label=>label.querySelector('input').checked).length,radioClipped:radio.getBoundingClientRect().width===1,marker:getComputedStyle(checked,'::after').content.includes('✓')}})()`),
      {overflow:false,targets:true,checked:1,radioClipped:true,marker:true}, "theme presets keep native radios visually clipped behind fluid 44px swatch targets at 320px");
    await setMedia(first, [{name:"forced-colors",value:"active"}]);
    await first.evaluate("document.querySelector('kin-app').appearance.presetControls.get('slate').focus()");
    assert.deepEqual(await first.evaluate(`(()=>{const input=document.activeElement;return {outline:getComputedStyle(input.closest('.appearance-swatch')).outlineWidth,radioWidth:input.getBoundingClientRect().width,marker:getComputedStyle(input.closest('.appearance-swatch'),'::after').content}})()`),
      {outline:"3px",radioWidth:20,marker:"none"}, "theme presets reveal native radios and keep focus visible in forced colors");
    await setMedia(first);
    await first.evaluate(`(()=>{const appearance=document.querySelector('kin-app').appearance;appearance.initialize(window.__appearanceRadioSaved);delete window.__appearanceRadioSaved})()`);
    console.log("PASS native appearance preset radios, keyboard wrap, narrow reflow and forced colors");
    assert.deepEqual(await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      const original=structuredClone(app.currentAppearance);
      const {contrastRatio}=await import('/appearance/palette.js');
      const cases=[];
      for(const [name,mode,seed,colorSource] of [
        ['default light','light','#984D38','default'],
        ['default dark','dark','#984D38','default'],
        ['generated light','light','#16756F','custom'],
      ]){
        app.ctx.appearance.applyAppearance({version:2,owner:null,mode,colorSource,seed,manual:null,image:null});
        const root=getComputedStyle(document.documentElement),control=getComputedStyle(app.compose.input);
        const token=root.getPropertyValue('--line-strong').trim(),surface=root.getPropertyValue('--surface').trim(),bg=root.getPropertyValue('--bg').trim();
        const probe=document.createElement('span');probe.style.color='var(--line-strong)';document.body.append(probe);
        const expected=getComputedStyle(probe).color;probe.remove();
        cases.push({name,boundaryMatches:control.borderTopColor===expected,surface:contrastRatio(token,surface)>=3,bg:contrastRatio(token,bg)>=3});
      }
      app.ctx.appearance.applyAppearance(original);
      return cases;
    })()`), [
      {name:'default light',boundaryMatches:true,surface:true,bg:true},
      {name:'default dark',boundaryMatches:true,surface:true,bg:true},
      {name:'generated light',boundaryMatches:true,surface:true,bg:true},
    ], "essential control boundaries keep 3:1 contrast across default and generated palettes");
    console.log("PASS essential control-boundary contrast");
    assert.deepEqual(await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      app.ctx.appearance.clearAppliedAppearance();
      const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
      const created=[],revoked=[];
      URL.createObjectURL=()=>{const url='blob:test-'+created.length;created.push(url);return url;};
      URL.revokeObjectURL=(url)=>revoked.push(url);
      const base={version:1,owner:null,mode:'system',colorSource:'background',seed:'#984D38',manual:null};
      const image=(bytes)=>({bytes:new Uint8Array(bytes),type:'image/webp',width:1,height:1,seed:'#112233'});
      app.ctx.appearance.applyAppearance({...base,image:image([1,2,3])});
      app.ctx.appearance.applyAppearance({...base,image:image([1,2,3])});
      app.ctx.appearance.applyAppearance({...base,image:image([3,2,1])});
      app.ctx.appearance.applyAppearance({...base,image:null,colorSource:'default'});
      const result={created:[...created],revoked:[...revoked],active:app.appearanceObjectUrl};
      URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;
      return result;
    })()`), {created:["blob:test-0","blob:test-1"],revoked:["blob:test-0","blob:test-1"],active:null},
    "background identity compares content, reuses equal content, and revokes replacements and clears");
    console.log("PASS appearance background object URL lifecycle");
    await visit(first, "today");
    await setViewport(first, {
      width: 320,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await setMedia(first, [{ name: "prefers-color-scheme", value: "dark" }]);
    assert.equal(
      await first.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()"),
      "#171d19",
      "dark appearance follows the operating-system preference",
    );
    await setMedia(first, [{ name: "prefers-color-scheme", value: "light" }]);
    assert.equal(
      await first.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()"),
      "#f3f1e9",
      "light appearance follows the operating-system preference",
    );
    await first.evaluate('document.querySelector("input").focus()');
    assert.equal(
      await first.evaluate(
        "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
      ),
      true,
    );
    assert.equal(
      await first.evaluate(
        'getComputedStyle(document.querySelector("input")).outlineWidth',
      ),
      "3px",
    );
    // The first rendered select: Quick add's Repeat select sits earlier in the
    // DOM inside a closed dialog.
    await first.evaluate("[...document.querySelectorAll('select')].find((node)=>node.getClientRects().length).focus()");
    assert.deepEqual(
      await first.evaluate(`(()=>{
        const select=[...document.querySelectorAll('select')].find((node)=>node.getClientRects().length);
        return {
          label:select.labels?.[0]?.textContent,
          targetHeight:select.getBoundingClientRect().height,
          focusWidth:getComputedStyle(select).outlineWidth,
        };
      })()`),
      { label: "What it is", targetHeight: 48, focusWidth: "3px" },
    );
    await setMedia(first, [
      { name: "forced-colors", value: "active" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    assert.deepEqual(
      await first.evaluate(`(()=>{
        const controls=[...document.querySelectorAll('button,select')];
        controls.push(...document.querySelectorAll('.nav-link'));
        return {
          forcedColors:matchMedia('(forced-colors: active)').matches,
          reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
          undersized:controls.some(control=>control.getClientRects().length>0&&control.getBoundingClientRect().height<48),
          focusWidth:getComputedStyle([...document.querySelectorAll('select')].find((node)=>node.getClientRects().length)).outlineWidth,
          overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        };
      })()`),
      {
        forcedColors: true,
        reducedMotion: true,
        undersized: false,
        focusWidth: "3px",
        overflow: false,
      },
    );
    await visit(first, "updates/handoffs");
    assert.equal(
      await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      const capture=app.handoffs;
      capture.input.focus();
      return capture.querySelector('h2').textContent==='Handoff' &&
        capture.input.labels[0].textContent==='What would help to know?' &&
        capture.querySelectorAll('ul > li').length>0 &&
        getComputedStyle(capture.input).outlineWidth==='3px' &&
        app.status.getAttribute('aria-live')==='polite' && app.alert.getAttribute('role')==='alert' &&
        [...capture.querySelectorAll('button')].every(button=>button.textContent && button.getBoundingClientRect().height>=48);
    })()`),
      true,
      "Handoff semantics, announcements, focus and targets in forced colors",
    );
    await first.evaluate('document.querySelector("kin-app").ctx.navigation.navigate("#updates/talk")');
    assert.equal(
      await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app'),capture=app.talks;
      capture.input.focus();
      return capture.querySelector('h2').textContent==='Other topics' &&
        capture.input.labels[0].textContent==='What should we talk about?' &&
        capture.querySelectorAll('ul > li').length>0 &&
        [...capture.querySelectorAll('h3')].every(heading=>['Open','Resolved'].includes(heading.textContent)) &&
        getComputedStyle(capture.input).outlineWidth==='3px' &&
        app.status.getAttribute('aria-live')==='polite' && app.alert.getAttribute('role')==='alert' &&
        [...capture.querySelectorAll('button')].every(button=>button.textContent && button.getBoundingClientRect().height>=48);
    })()`),
      true,
      "Talk semantics, announcements, focus and targets in forced colors",
    );
    await visit(first, "household/areas");
    assert.equal(
      await first.evaluate(`(()=>{
      const p=document.querySelector('kin-app').pulse;p.valueSelect.focus();
      return p.querySelector('h2').textContent==='Pulse' &&
        p.valueSelect.labels[0].textContent.startsWith('Current capacity') &&
        p.durationSelect.labels[0].textContent.startsWith('For') &&
        getComputedStyle(p.valueSelect).outlineWidth==='3px' &&
        [...p.querySelectorAll('button,select')].filter(c=>c.getClientRects().length).every(c=>c.getBoundingClientRect().height>=48);
    })()`),
      true,
      "Pulse semantics, native labels, focus and targets in forced colors",
    );
    await visit(first, "routines");
    assert.equal(
      await first.evaluate(`(()=>{
        const app=document.querySelector('kin-app'),ui=app.routines;ui.openCreate();ui.cadence.focus();
        return ui.querySelector('h2').textContent==='Routines' && ui.input.labels.length===1 && ui.cadence.labels[0].textContent==='Repeat' &&
          ui.querySelectorAll('ul > li').length>0 && ui.textContent.includes('today') &&
          ui.input.getBoundingClientRect().width >= ui.querySelector('.routine-form').getBoundingClientRect().width * .7 &&
          getComputedStyle(ui.cadence).outlineWidth==='3px' &&
          [...ui.querySelectorAll('button,select,input')].filter(control=>control.getClientRects().length>0).every(control=>control.getBoundingClientRect().height>=48) &&
          app.status.getAttribute('aria-live')==='polite' && app.alert.getAttribute('role')==='alert';
      })()`),
      true,
      "Routine semantics, labels, textual state, focus and targets in forced colors",
    );
    await visit(first, "today");
    const spacingResult = await first.evaluate(`(()=>{
      const sheet=[...document.styleSheets].find(candidate=>candidate.href?.endsWith('/styles/app.css'));
      const ruleIndex=sheet.cssRules.length;
      sheet.insertRule('*{letter-spacing:.12em!important;word-spacing:.16em!important;line-height:1.5!important}',ruleIndex);
      const overflow=document.documentElement.scrollWidth>document.documentElement.clientWidth;
      sheet.deleteRule(ruleIndex);
      return overflow;
    })()`);
    assert.equal(
      spacingResult,
      false,
      "increased text spacing keeps 320px layout usable",
    );
    await setViewport(first, {
      width: 640,
      height: 960,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await first.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    assert.equal(
      await first.evaluate("visualViewport.scale"),
      2,
      "Chromium page-scale zoom reaches 200 percent",
    );
    console.log(
      "PASS 320px reflow, forced colors, reduced motion, text spacing, 200% page-scale zoom, focus and targets",
    );

    await first.evaluate(`(async()=>{const a=document.querySelector('kin-app');
      const tx=a.store.database.transaction('events','readwrite');tx.objectStore('events').add({event_id:crypto.getRandomValues(new Uint8Array(16)),encoded_event:new Uint8Array([1])});
      await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j;});
      await a.ctx.refresh.refreshFromEvents();
      if(a.alert.hidden || a.busy) throw Error('Malformed row must fail safely');
      const read=a.store.database.transaction('events','readonly').objectStore('events').getAll();
      await new Promise((r,j)=>{read.onsuccess=r;read.onerror=j;});
      if(read.result.at(-1).encoded_event.length!==1) throw Error('Malformed row was changed');
      const cleanup=a.store.database.transaction('events','readwrite');
      cleanup.objectStore('events').delete(read.result.at(-1).local_sequence);
      await new Promise((r,j)=>{cleanup.oncomplete=r;cleanup.onabort=j;});
      await a.ctx.refresh.refreshFromEvents();
      if(!a.retryButton.hidden || a.retryAction!==null) throw Error('Recovered refresh left stale retry');
      const goodRead=a.store.database.transaction('events','readonly').objectStore('events').getAll();
      await new Promise((r,j)=>{goodRead.onsuccess=r;goodRead.onerror=j;});
      const original=goodRead.result.find(row=>row.kind==='ITEM_ADDED');
      const originalBytes=[...new Uint8Array(original.encoded_event)];
      const corrupted={...original,kind:'ITEM_COMPLETED'};
      const corruptTx=a.store.database.transaction('events','readwrite');
      corruptTx.objectStore('events').put(corrupted);
      await new Promise((r,j)=>{corruptTx.oncomplete=r;corruptTx.onabort=j;});
      // The arena already holds this row; out-of-band corruption is detected at the next full read (THREAT-MODEL.md).
      a.store.arena.reset(null);
      await a.ctx.refresh.refreshFromEvents();
      if(a.alert.hidden || a.busy) throw Error('Metadata mismatch must fail safely');
      const persistedRead=a.store.database.transaction('events','readonly').objectStore('events').get(original.local_sequence);
      await new Promise((r,j)=>{persistedRead.onsuccess=r;persistedRead.onerror=j;});
      if(persistedRead.result.kind!=='ITEM_COMPLETED') throw Error('Corrupt metadata was changed');
      if([...new Uint8Array(persistedRead.result.encoded_event)].some((byte,index)=>byte!==originalBytes[index])) throw Error('Canonical event bytes changed');
      const restoreTx=a.store.database.transaction('events','readwrite');
      restoreTx.objectStore('events').put(original);
      await new Promise((r,j)=>{restoreTx.oncomplete=r;restoreTx.onabort=j;});
      await a.ctx.refresh.refreshFromEvents();
      if(!a.retryButton.hidden || a.retryAction!==null) throw Error('Metadata recovery left stale retry');
    })()`);
    console.log(
      "PASS malformed row and metadata preservation, canonical-byte integrity, refresh recovery",
    );
    await visit(first, "household/areas");
    const areasResult = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      const idle=async()=>{for(let i=0;i<300&&(app.busy||app.refreshing||app.pendingRefresh||app.wakePending);i++)await new Promise(r=>setTimeout(r,10));if(app.busy||app.refreshing)throw Error('Area action did not settle');};
      const form=app.areas.querySelector('.area-create-form');
      const input=form.querySelector('input');
      input.value='Kitchen';input.focus();form.requestSubmit();await idle();
      const area=app.state.areas.at(-1);
      const createdFocused=document.activeElement===app.areas.querySelector('#area-create-name');
      app.nav.querySelector('a[href="#today"]').click();
      await new Promise(r=>setTimeout(r,0));
      const added=await app.store.append({type:'add',text:'Wipe counter',classification:'need'},app.engine);
      app.state=added.state;app.ctx.render.renderState();
      let item=app.state.items.at(-1);
      app.nav.querySelector('a[href="#lists/todo"]').click();
      app.ctx.detail.openItemDetail(item.itemId);
      let select=[...app.querySelectorAll('.item-area-select')].find(node=>node.dataset.itemId===item.itemId);
      const hasNoArea=select?.options[0]?.textContent==='No area';
      select.focus();select.value=area.areaId;select.dispatchEvent(new Event('change',{bubbles:true}));await idle();
      item=app.state.items.find(row=>row.itemId===item.itemId);
      const assigned=item.areaId===area.areaId;
      const assignmentFocus=document.activeElement?.classList.contains('item-area-select');
      app.ctx.detail.closeItemDetail({ restoreFocus: false });
      return {areaId:area.areaId,createdFocused,hasNoArea,assigned,assignmentFocus,status:app.status.textContent,alert:app.alert.textContent,selected:select.value,itemId:item.itemId};
    })()`);
    assert.equal(areasResult.createdFocused, true, "Area create returns focus to capture");
    assert.equal(areasResult.hasNoArea, true, "No area remains the default assignment");
    assert.equal(areasResult.assigned, true, `item assignment saves to canonical state: ${JSON.stringify(areasResult)}`);
    assert.equal(areasResult.assignmentFocus, true, "item assignment restores selector focus");
    const noteValidation = await first.evaluate(`(()=>{
      const validate=customElements.get('kin-notes').validateText;
      return {
        scalarBoundary:validate('A'.repeat(80),'').error===null,
        scalarOverflow:validate('A'.repeat(81),'').field==='title',
        unicodeByteBoundary:validate('😀'.repeat(64),'').error===null,
        unicodeByteOverflow:validate('😀'.repeat(65),'').field==='title',
        bodyByteBoundary:validate('Title','é'.repeat(2048)).error===null,
        bodyByteOverflow:validate('Title','é'.repeat(2049)).field==='body',
        titleControls:validate('Bad\\u0001 title','').field==='title',
        bodyControls:validate('Title','Bad\\u0000 body').field==='body',
        bodyWhitespace:validate('Title','line\\nline\\tindented').error===null,
      };
    })()`);
    assert.deepEqual(noteValidation, {scalarBoundary:true,scalarOverflow:true,unicodeByteBoundary:true,unicodeByteOverflow:true,bodyByteBoundary:true,bodyByteOverflow:true,titleControls:true,bodyControls:true,bodyWhitespace:true}, 'browser Note validation matches Rust scalar, byte, and control-character rules');
    const notesResult = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      app.ctx.navigation.navigate('#household/notes');
      const idle=async()=>{for(let i=0;i<300&&(app.busy||app.refreshing||app.pendingRefresh||app.wakePending);i++)await new Promise(r=>setTimeout(r,10));if(app.busy||app.refreshing)throw Error('Note action did not settle');};
      const form=app.notes.querySelector('form');
      const [title,body]=form.querySelectorAll('input,textarea');const area=app.state.areas.find(row=>row.name==='Kitchen');const areaSelect=form.querySelector('select');areaSelect.value=area.areaId;
      const beforeInvalid=app.state.notes.length;title.value='A'.repeat(81);body.value='';form.requestSubmit();const invalidNoAppend=app.state.notes.length===beforeInvalid&&title.getAttribute('aria-invalid')==='true'&&!form.querySelector('[id$="title-error"]').hidden;
      title.value='Wi-Fi details';body.value='<img src=x onerror=alert(1)>'+String.fromCharCode(10)+'Router location';form.requestSubmit();await idle();
      let note=app.state.notes.at(-1);const stableId=note.noteId;
      const safeText=app.notes.querySelector('.note-body').textContent===body.value&&!app.notes.querySelector('.note-body img');
      app.notes.querySelector('.note-row [data-focus-id^="edit-"]').click();const editForm=app.notes.querySelector('form');const editTitle=editForm.querySelector('input'),editBody=editForm.querySelector('textarea');editTitle.value='Home Wi-Fi';editBody.value='Router location';editForm.requestSubmit();await idle();
      note=app.state.notes.find(row=>row.noteId===stableId);const updated=note.title==='Home Wi-Fi'&&note.body==='Router location';
      app.notes.querySelector('.note-row [data-focus-id^="archive-"]').click();await idle();
      note=app.state.notes.find(row=>row.noteId===stableId);
      return {created:!!note,stableId,areaLinked:note.areaId===area.areaId,updated,archived:note.archived,safeText,invalidNoAppend,status:app.status.textContent,alert:app.alert.textContent};
    })()`);
    assert.equal(notesResult.created, true, `Note create persists: ${JSON.stringify(notesResult)}`);
    assert.equal(notesResult.updated, true, "Note edit updates the same stable identity");
    assert.equal(notesResult.areaLinked, true, "Note may use an existing household Area");
    assert.equal(notesResult.archived, true, "Note archive is terminal state");
    assert.equal(notesResult.safeText, true, "Note body displays as plain text without creating markup");
    assert.equal(notesResult.invalidNoAppend, true, "invalid Note text is explained in the browser and appends no event");
    assert.equal(notesResult.alert, "", "Note lifecycle completes without an app error");
    await visit(first, "household/notes");
    const referenceResult = await first.evaluate(async () => {
      const app = document.querySelector("kin-app"), ui = app.notes;
      const idle = async () => { for (let i = 0; i < 300 && (app.busy || app.refreshing || app.pendingRefresh || app.wakePending); i++) await new Promise(resolve => setTimeout(resolve, 10)); };
      const setValue = (control, value) => { control.value = value; control.dispatchEvent(new Event("input", { bubbles: true })); };
      let form = ui.querySelector(".reference-records form");
      const title = form.querySelector("input");
      setValue(title, "界".repeat(43));
      form.requestSubmit();
      const titleError = ui.querySelector(`#${title.getAttribute("aria-describedby")}`);
      const invalidTitle = title.getAttribute("aria-invalid") === "true" && titleError.textContent === "This title is too long." && !titleError.hidden && !app.busy;
      setValue(title, "Household Wi-Fi");
      let fields = [...form.querySelectorAll("fieldset")];
      let [label, value] = fields[0].querySelectorAll("input,textarea");
      setValue(label, ""); setValue(value, "value");
      form.requestSubmit();
      const labelError = ui.querySelector(`#${label.getAttribute("aria-describedby")}`);
      const invalidLabel = label.getAttribute("aria-invalid") === "true" && labelError.textContent === "Field labels can't be empty." && !labelError.hidden && !app.busy;
      setValue(fields[0].querySelector("input"), "Network");
      ui.querySelector(".reference-records form button[type=button]").click();
      form = ui.querySelector(".reference-records form");
      fields = [...form.querySelectorAll("fieldset")];
      setValue(fields[0].querySelectorAll("input,textarea")[0], "Network");
      setValue(fields[0].querySelectorAll("input,textarea")[1], "Home");
      setValue(fields[1].querySelectorAll("input,textarea")[0], "Password");
      setValue(fields[1].querySelectorAll("input,textarea")[1], "V".repeat(1025));
      form.requestSubmit();
      const valueControl = fields[1].querySelectorAll("input,textarea")[1];
      const valueError = ui.querySelector(`#${valueControl.getAttribute("aria-describedby")}`);
      const invalidValue = valueControl.getAttribute("aria-invalid") === "true" && valueError.textContent === "This field value is too long." && !valueError.hidden && !app.busy;
      for (let i = 0; i < 15; i++) [...ui.querySelectorAll(".reference-records form button[type=button]")].find(button => button.textContent === "Add field").click();
      form = ui.querySelector(".reference-records form");
      const addField = [...form.querySelectorAll("button[type=button]")].find(button => button.textContent === "Add field");
      form.requestSubmit();
      const countError = ui.querySelector(`#${addField.getAttribute("aria-describedby")}`);
      const invalidCount = form.querySelectorAll("fieldset").length === 17 && addField.getAttribute("aria-invalid") === "true" && countError.textContent === "Reference records can have up to 16 fields." && !countError.hidden && !app.busy;
      const ids = [...document.querySelectorAll("[id]")].map(node => node.id);
      const uniqueIds = ids.length === new Set(ids).size;
      while (ui.querySelectorAll(".reference-records fieldset").length > 2) {
        const last = [...ui.querySelectorAll(".reference-records fieldset")].at(-1);
        last.querySelector("button").click();
      }
      form = ui.querySelector(".reference-records form"); fields = [...form.querySelectorAll("fieldset")];
      setValue(form.querySelector("input"), "Household Wi-Fi");
      setValue(fields[0].querySelectorAll("input,textarea")[0], "Network");
      setValue(fields[0].querySelectorAll("input,textarea")[1], "Home");
      setValue(fields[1].querySelectorAll("input,textarea")[0], "Password");
      setValue(fields[1].querySelectorAll("input,textarea")[1], "private value");
      form.requestSubmit(); await idle();
      const saved = app.state.referenceRecords.find(record => record.title === "Household Wi-Fi");
      if (!saved) return { invalidTitle, invalidLabel, invalidValue, invalidCount, uniqueIds, created: false };
      const stableId = saved.recordId;
      [...ui.querySelectorAll(".reference-records li button")].find(button => button.textContent === "Edit").click();
      form = ui.querySelector(".reference-records form");
      form.querySelector("input").value = "Updated Wi-Fi";
      form.requestSubmit(); await idle();
      const edited = app.state.referenceRecords.find(record => record.recordId === stableId)?.title === "Updated Wi-Fi";
      const maintenanceForm = () => ui.querySelector(`[data-record-id="${stableId}"] section form`);
      const maintenanceValues = () => [...maintenanceForm().querySelectorAll("input,select")].map(control => control.value);
      let maintenance = maintenanceForm();
      let [summary, performed, nextOn, routine] = maintenance.querySelectorAll("input,select");
      setValue(summary, "Changed filter");
      performed.value = "2026-10-15"; performed.dispatchEvent(new Event("input", { bubbles: true }));
      nextOn.value = "2027-04-15"; nextOn.dispatchEvent(new Event("input", { bubbles: true }));
      const expectedDraft = ["Changed filter", "2026-10-15", "2027-04-15", routine.value];
      ui.disabled = true; ui.disabled = false;
      const busyPreserved = JSON.stringify(maintenanceValues()) === JSON.stringify(expectedDraft);
      ui.maintenance = [...ui.maintenanceEvents];
      const refreshPreserved = JSON.stringify(maintenanceValues()) === JSON.stringify(expectedDraft);
      const appendCommand = app.ctx.append.appendCommand;
      app.ctx.append.appendCommand = async command => {
        if (command.type === "save-maintenance-event") {
          const failure = new Error("Synthetic maintenance failure");
          failure.userMessage = "Synthetic maintenance failure";
          throw failure;
        }
        return appendCommand.call(app.ctx.append, command);
      };
      maintenanceForm().requestSubmit(); await idle();
      app.ctx.append.appendCommand = appendCommand;
      const failedSavePreserved = JSON.stringify(maintenanceValues()) === JSON.stringify(expectedDraft)
        && app.alert.textContent === "Synthetic maintenance failure"
        && !app.state.maintenanceEvents.some(event => event.recordId === stableId && event.summary === "Changed filter");
      maintenanceForm().requestSubmit(); await idle();
      const maintenanceSaved = app.state.maintenanceEvents.some(event => event.recordId === stableId
        && event.summary === "Changed filter" && event.performedOn === 20261015 && event.nextOn === 20270415);
      const successCleared = maintenanceValues().every(value => value === "") && !ui.maintenanceDrafts.has(stableId);
      [...ui.querySelectorAll(".reference-records li button")].find(button => button.textContent === "Archive").click(); await idle();
      return { invalidTitle, invalidLabel, invalidValue, invalidCount, uniqueIds, created: true, edited,
        busyPreserved, refreshPreserved, failedSavePreserved, maintenanceSaved, successCleared,
        archived: app.state.referenceRecords.find(record => record.recordId === stableId)?.archived };
    });
    assert.equal(referenceResult.invalidTitle, true, `Reference title errors are linked and announced: ${JSON.stringify(referenceResult)}`);
    assert.equal(referenceResult.invalidLabel, true, "Reference label errors are linked to their specific control");
    assert.equal(referenceResult.invalidValue, true, "Reference value errors are linked to their specific control");
    assert.equal(referenceResult.invalidCount, true, "Reference field count is checked in the component");
    assert.equal(referenceResult.uniqueIds, true, "Reference form and errors have unique DOM IDs");
    assert.equal(referenceResult.created, true, "Valid Reference Record saves from the browser");
    assert.equal(referenceResult.edited, true, "Reference Record edit preserves its stable identity");
    assert.equal(referenceResult.busyPreserved, true, "Maintenance drafts survive the app busy cycle");
    assert.equal(referenceResult.refreshPreserved, true, "Maintenance drafts survive a refreshed projection");
    assert.equal(referenceResult.failedSavePreserved, true, "A failed Maintenance save keeps the draft available for retry");
    assert.equal(referenceResult.maintenanceSaved, true, "A retried Maintenance entry saves with its dates intact");
    assert.equal(referenceResult.successCleared, true, "A successful Maintenance save clears only its submitted draft");
    assert.equal(referenceResult.archived, true, "Reference Record archive remains terminal");
    console.log("PASS Reference Record validation and lifecycle; Maintenance draft refresh, failure, retry and save");
    await visit(first, "household/notes");
    await first.send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    const noteSemantics = await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      app.notes.clearEditor();app.notes.render();
      const form=app.notes.querySelector('form'),[title,body]=form.querySelectorAll('input,textarea'),area=form.querySelector('select');
      const ids=[...app.notes.querySelectorAll('[id]')].map(node=>node.id);
      const labels=[title,body,area].every(control=>control.id&&[...control.labels].length===1);
      const uniqueIds=new Set(ids).size===ids.length;
      const descriptionsResolve=[title,body].every(control=>control.getAttribute('aria-describedby').split(' ').every(id=>ids.includes(id)));
      title.value='T'.repeat(81);body.value='';form.requestSubmit();
      const titleOnly=title.getAttribute('aria-invalid')==='true'&&!body.hasAttribute('aria-invalid')&&!form.querySelector('[id$="title-error"]').hidden;
      title.value='Resilience note';body.value='bad\u0000body';form.requestSubmit();
      const bodyOnly=!title.hasAttribute('aria-invalid')&&body.getAttribute('aria-invalid')==='true'&&!form.querySelector('[id$="body-error"]').hidden;
      return {labels,uniqueIds,descriptionsResolve,titleOnly,bodyOnly};
    })()`);
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app'),form=app.notes.querySelector('form');if(app.busy||app.refreshing||app.pendingRefresh||app.wakePending||form.querySelector('button').disabled)return false;form.querySelector('input').value='Resilience note';form.querySelector('textarea').value='offline body';form.requestSubmit();return app.busy})()`));
    const resilienceId = await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app'),note=app.state?.notes?.find(item=>item.title==='Resilience note');return note&&!note.archived?note.noteId:false})()`));
    const localCreate = await first.evaluate(`(()=>{const app=document.querySelector('kin-app');return app.notes.querySelector('[data-focus-id="title"]')===document.activeElement&&app.status.textContent.includes('saved on this device')})()`);
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');if(app.busy||app.refreshing||app.pendingRefresh||app.wakePending)return false;const edit=[...app.notes.querySelectorAll('[data-focus-id]')].find(node=>node.dataset.focusId==='edit-${resilienceId}');if(!edit||edit.disabled)return false;edit.click();const form=app.notes.querySelector('form');if(form.querySelector('button').disabled)return false;form.querySelector('input').value='Resilience note updated';form.querySelector('textarea').value='edited offline';form.requestSubmit();return app.busy})()`));
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app'),note=app.state?.notes?.find(item=>item.noteId==='${resilienceId}');return note?.title==='Resilience note updated'&&!app.busy})()`));
    const localUpdate = await first.evaluate(`(()=>document.querySelector('kin-app').state.notes.find(item=>item.noteId==='${resilienceId}')?.body==='edited offline')()`);
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');return !app.busy&&!app.refreshing&&!app.pendingRefresh&&!app.wakePending})()`));
    await first.evaluate(`(async()=>{const app=document.querySelector('kin-app'),result=await app.store.append({type:'archive-note',noteId:'${resilienceId}'},app.engine);app.state=result.state})()`);
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');return !app.busy&&!app.refreshing&&!app.pendingRefresh&&!app.wakePending})()`));
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');if(app.busy||app.refreshing||app.pendingRefresh||app.wakePending)return false;app.notes.notes=[{...app.state.notes.find(item=>item.noteId==='${resilienceId}'),archived:false}];const edit=[...app.notes.querySelectorAll('[data-focus-id]')].find(node=>node.dataset.focusId==='edit-${resilienceId}');if(!edit||edit.disabled)return false;edit.click();const form=app.notes.querySelector('form');if(form.querySelector('button').disabled)return false;form.querySelector('input').value='Must not revive';form.querySelector('textarea').value='stale';form.requestSubmit();return app.busy})()`));
    try {
      await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');return app.alert.textContent.length>0&&!app.busy&&!app.refreshing&&!app.pendingRefresh&&!app.wakePending&&app.state.notes.find(item=>item.noteId==='${resilienceId}')?.archived===true})()`));
    } catch (error) {
      const detail = await first.evaluate(`(()=>{const app=document.querySelector('kin-app'),note=app.state.notes.find(item=>item.noteId==='${resilienceId}'),form=app.notes.querySelector('form');return {busy:app.busy,refreshing:app.refreshing,pendingRefresh:app.pendingRefresh,wakePending:app.wakePending,alert:app.alert.textContent,note:note&&{title:note.title,archived:note.archived},formNoteId:form.dataset.noteId,saveDisabled:form.querySelector('button').disabled,componentDisabled:app.notes.disabledState,retry:app.retryButton.hidden}})()`);
      throw new Error(`${error.message}; stale Note result: ${JSON.stringify(detail)}`);
    }
    const staleRejected = true;
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');if(app.busy||app.refreshing||app.pendingRefresh||app.wakePending)return false;app.notes.clearEditor();app.notes.render();const form=app.notes.querySelector('form');form.querySelector('input').value='Offline archive';form.querySelector('textarea').value='saved offline';form.requestSubmit();return app.busy})()`));
    const offlineId = await until(() => first.evaluate(`(()=>{const note=document.querySelector('kin-app').state?.notes?.find(item=>item.title==='Offline archive');return note&&!note.archived?note.noteId:false})()`));
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');if(app.busy||app.refreshing||app.pendingRefresh||app.wakePending)return false;const edit=[...app.notes.querySelectorAll('[data-focus-id]')].find(node=>node.dataset.focusId==='edit-${offlineId}');if(!edit||edit.disabled)return false;edit.click();const form=app.notes.querySelector('form');if(form.querySelector('button').disabled)return false;form.querySelector('input').value='Offline archive updated';form.querySelector('textarea').value='updated offline';form.requestSubmit();return app.busy})()`));
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app'),note=app.state?.notes?.find(item=>item.noteId==='${offlineId}');return note?.title==='Offline archive updated'&&!app.busy})()`));
    const offlineUpdate = await first.evaluate(`(()=>document.querySelector('kin-app').state.notes.find(item=>item.noteId==='${offlineId}')?.body==='updated offline')()`);
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');if(app.busy||app.refreshing||app.pendingRefresh||app.wakePending)return false;const button=[...app.notes.querySelectorAll('[data-focus-id]')].find(node=>node.dataset.focusId==='archive-${offlineId}');if(!button||button.disabled)return false;button.click();return app.busy})()`));
    await until(() => first.evaluate(`(()=>{const app=document.querySelector('kin-app');return app.state?.notes?.find(item=>item.noteId==='${offlineId}')?.archived===true&&!app.busy})()`));
    const offlineNote = {noteId:offlineId,created:true,updated:offlineUpdate,archived:true};
    await first.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await first.send("Page.reload");
    await ready(first);
    const noteReloaded = await until(async()=>first.evaluate(`(()=>{const app=document.querySelector('kin-app'),note=app?.state?.notes?.find(item=>item.noteId==='${offlineNote.noteId}');return note?.archived===true})()`));
    assert.deepEqual({ ...noteSemantics, localCreate,localUpdate,staleRejected,noteId:resilienceId,offlineCreate:offlineNote.created,offlineUpdate:offlineNote.updated,offlineArchive:offlineNote.archived,reloadedArchived:noteReloaded },{labels:true,uniqueIds:true,descriptionsResolve:true,titleOnly:true,bodyOnly:true,localCreate:true,localUpdate:true,staleRejected:true,noteId:resilienceId,offlineCreate:true,offlineUpdate:true,offlineArchive:true,reloadedArchived:true},'Notes fields, offline lifecycle, stale canonical replay, and reload resilience');
    console.log("PASS Notes labels, field errors, offline lifecycle, stale replay rejection and archived reload");
    const areaNameValidation = await first.evaluate(`(()=>{
      const host=document.createElement('kin-areas');
      host.areas=[{areaId:'a'.repeat(32),name:'Kitchen',archived:false}];
      document.body.append(host);
      const intents=[];host.addEventListener('kin:area-intent',event=>intents.push(event.detail));
      const submit=form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      const create=host.querySelector('.area-create-form'),createInput=create.querySelector('input'),createError=create.querySelector('.area-name-error');
      createInput.value='A'.repeat(48);submit(create);
      const ascii48=intents.at(-1)?.name==='A'.repeat(48);
      const before=intents.length;createInput.value='A'.repeat(49);submit(create);
      const ascii49Rejected=intents.length===before&&createError.textContent==='Area names can be up to 48 characters.';
      createInput.value='é'.repeat(48);submit(create);
      const multibyte48=intents.at(-1)?.name==='é'.repeat(48);
      const beforeBytes=intents.length;createInput.value='😀'.repeat(32);submit(create);
      const bytesRejected=intents.length===beforeBytes&&createError.textContent==='This Area name is too long.';
      createInput.value='\\u0085Pantry\\u0085';submit(create);
      const trimmed=intents.at(-1)?.name==='Pantry'&&createInput.value==='Pantry';
      const beforeEmpty=intents.length;createInput.value='  ';submit(create);
      const emptyRejected=intents.length===beforeEmpty&&createError.textContent==='Enter an Area name.';
      const beforeControl=intents.length;createInput.value='Bad\\u0001Name';submit(create);
      const controlRejected=intents.length===beforeControl&&createError.textContent==="Area names can't contain control characters.";
      const row=host.querySelector('.area-row'),area=host.records[0];host.editName(row,area);
      const rename=row.querySelector('form'),renameInput=rename.querySelector('input'),renameError=rename.querySelector('.area-name-error');
      const ids=[...host.querySelectorAll('[id]')].map(node=>node.id);
      const uniqueIds=new Set(ids).size===ids.length;
      const describedTargets=[createInput,renameInput].map(input=>({input:input.id,ids:input.getAttribute('aria-describedby').split(' ')}));
      const allDescriptionsResolve=describedTargets.every(input=>input.ids.every(id=>ids.includes(id)));
      const renameLabel=rename.querySelector('label[for="'+renameInput.id+'"]');
      const labeledRename=!!renameInput.id&&!!renameLabel&&renameLabel.textContent==='Rename '+area.name;
      renameInput.value='R'.repeat(49);const beforeRename=intents.length;submit(rename);
      const renameRejected=intents.length===beforeRename&&renameError.textContent==='Area names can be up to 48 characters.';
      const renameDescribed=renameInput.getAttribute('aria-describedby').split(' ');
      const ownRenameError=renameDescribed.includes(renameError.id)&&renameDescribed.every(id=>id!==create.querySelector('.area-name-error').id);
      createInput.value='  ';submit(create);
      const createDescribed=createInput.getAttribute('aria-describedby').split(' ');
      const ownCreateError=createDescribed.includes(create.querySelector('.area-name-error').id)&&createDescribed.every(id=>id!==renameError.id);
      renameInput.value='  Pantry  ';submit(rename);
      const renameTrimmed=intents.at(-1)?.action==='rename-area'&&intents.at(-1)?.name==='Pantry';
      host.remove();
      return {ascii48,ascii49Rejected,multibyte48,bytesRejected,trimmed,emptyRejected,controlRejected,uniqueIds,allDescriptionsResolve,labeledRename,ownRenameError,ownCreateError,renameRejected,renameTrimmed};
    })()`);
    assert.deepEqual(areaNameValidation,{ascii48:true,ascii49Rejected:true,multibyte48:true,bytesRejected:true,trimmed:true,emptyRejected:true,controlRejected:true,uniqueIds:true,allDescriptionsResolve:true,labeledRename:true,ownRenameError:true,ownCreateError:true,renameRejected:true,renameTrimmed:true});
    const areaDraftSync = await first.evaluate(`(()=>{
      const areaId='b'.repeat(32),host=document.createElement('kin-areas');
      host.areas=[{areaId,name:'Kitchen',archived:false}];document.body.append(host);
      const intents=[];host.addEventListener('kin:area-intent',event=>intents.push(event.detail));
      const update=(input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
      update(host.querySelector('#area-create-name'),'Garden draft');
      host.querySelector('[aria-label="Rename Kitchen"]').click();
      update(host.querySelector('.area-edit-form input'),'Pantry draft');
      host.areas=[{areaId,name:'Kitchen',archived:false},{areaId:'c'.repeat(32),name:'Garage',archived:false}];
      const unrelatedSync={create:host.querySelector('#area-create-name').value,rename:host.querySelector('.area-edit-form input').value,editing:!!host.querySelector('.area-edit-form')};
      host.areas=[{areaId,name:'Pantry draft',archived:false},{areaId:'c'.repeat(32),name:'Garage',archived:false}];
      const matchingRenameConverged=!host.querySelector('.area-rename-conflict')&&host.renameDraft.baseName==='Pantry draft';
      host.areas=[{areaId,name:'Kitchen shared',archived:false},{areaId:'c'.repeat(32),name:'Garage',archived:false}];
      const conflicted={create:host.querySelector('#area-create-name').value,rename:host.querySelector('.area-edit-form input').value,
        message:host.querySelector('.area-rename-conflict')?.textContent.includes('Kitchen shared'),saveDisabled:host.querySelector('.area-edit-form button[type="submit"]').disabled};
      host.querySelector('.area-edit-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      const forcedSubmitRefused=intents.length===0;
      [...host.querySelectorAll('.area-rename-conflict button')].find(button=>button.textContent==='Keep my draft').click();
      const reviewCleared=!host.querySelector('.area-rename-conflict')&&host.querySelector('.area-edit-form input').value==='Pantry draft';
      host.querySelector('.area-edit-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      const renameIntent=intents.at(-1);
      const renameRetained=host.querySelector('.area-edit-form input').value==='Pantry draft';
      host.saved('rename-area',{areaId});
      host.areas=[{areaId,name:'Pantry draft',archived:false},{areaId:'c'.repeat(32),name:'Garage',archived:false}];
      const renameCleared=!host.querySelector('.area-edit-form');
      host.querySelector('.area-create-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      const createIntent=intents.at(-1),createRetained=host.querySelector('#area-create-name').value==='Garden draft';
      host.saved('create-area',{});const createCleared=host.querySelector('#area-create-name').value==='';
      host.remove();
      return {unrelatedSync,matchingRenameConverged,conflicted,forcedSubmitRefused,reviewCleared,renameIntent,renameRetained,renameCleared,createIntent,createRetained,createCleared};
    })()`);
    assert.deepEqual(areaDraftSync,{
      unrelatedSync:{create:'Garden draft',rename:'Pantry draft',editing:true},
      matchingRenameConverged:true,
      conflicted:{create:'Garden draft',rename:'Pantry draft',message:true,saveDisabled:true},
      forcedSubmitRefused:true,reviewCleared:true,
      renameIntent:{action:'rename-area',areaId:'b'.repeat(32),name:'Pantry draft'},renameRetained:true,renameCleared:true,
      createIntent:{action:'create-area',name:'Garden draft'},createRetained:true,createCleared:true,
    });
    await visit(first, "household/areas");
    const areaEnter = async () => {
      await first.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13,
      });
      await first.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      });
    };
    const areaIdle = async () => first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      for(let i=0;i<300&&(app.busy||app.refreshing||app.pendingRefresh||app.wakePending);i++)await new Promise(r=>setTimeout(r,10));
      if(app.busy||app.refreshing)throw Error('Area action did not settle');
    })()`);
    await first.evaluate(`document.querySelector('kin-app').areas.querySelector('[aria-label="Rename Kitchen"]').focus()`);
    await areaEnter();
    await first.evaluate(`(()=>{const input=document.querySelector('kin-app').areas.querySelector('.area-edit-form input');input.value='Food prep';input.focus()})()`);
    await areaEnter(); await areaIdle();
    await first.evaluate(`document.querySelector('kin-app').areas.querySelector('[aria-label="Archive Food prep"]').focus()`);
    await areaEnter();
    const archivePrompt = await first.evaluate(`(()=>{const dialog=document.querySelector('kin-app').areas.querySelector('[role="group"]');
      return {copy:dialog.textContent.includes('existing links'),focused:document.activeElement===dialog.querySelector('button')};})()`);
    await areaEnter(); await areaIdle();
    const postArchive = await first.evaluate(`(()=>{const app=document.querySelector('kin-app'),old=app.state.areas.find(area=>area.name==='Food prep');
      return {archived:old?.archived===true,retained:app.state.items.some(item=>item.areaId===old?.areaId),
        headingFocus:document.activeElement===app.areas.querySelector('h2')};})()`);
    await first.evaluate(`(()=>{const input=document.querySelector('kin-app').areas.querySelector('#area-create-name');input.value='L'.repeat(48);
      document.querySelector('kin-app').areas.querySelector('.area-create-form button').focus();})()`);
    await areaEnter(); await areaIdle();
    const areaLifecycle = await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app'),old=app.state.areas.find(area=>area.name==='Food prep');
      const longName='L'.repeat(48);
      const longNameShown=[...app.areas.querySelectorAll('.area-name')].some(node=>node.textContent===longName);
      const emptyHost=document.createElement('kin-areas');emptyHost.areas=[];
      const emptyCopy=emptyHost.textContent.includes('No Areas yet. You can add one whenever it helps.');emptyHost.remove();
      const controls=[...app.areas.querySelectorAll('button,input')].filter(node=>node.getClientRects().length);
      return {renamed:!!old,archived:old?.archived===true,retained:app.state.items.some(item=>item.areaId===old?.areaId),
        headingFocus:document.activeElement===app.areas.querySelector('h2'),createFocus:document.activeElement===app.areas.querySelector('#area-create-name'),longNameShown,emptyCopy,
        status:app.status.getAttribute('aria-live')==='polite'&&!!app.status.textContent,
        targets:controls.every(node=>node.getBoundingClientRect().height>=48),
        labels:app.areas.querySelector('#area-create-name').labels.length===1,
        overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        zoom:visualViewport.scale===2,forced:matchMedia('(forced-colors: active)').matches};
    })()`);
    const areaLifecycleExpected={renamed:true,archived:true,retained:true,headingFocus:false,createFocus:true,longNameShown:true,emptyCopy:true,
      status:true,targets:true,labels:true,overflow:false,zoom:true,forced:true};
    assert.deepEqual(archivePrompt,{copy:true,focused:true});
    assert.deepEqual(postArchive,{archived:true,retained:true,headingFocus:true});
    assert.deepEqual(areaLifecycle,areaLifecycleExpected);
    await visit(first, "lists/todo");
    const archivedAreaContext = await first.evaluate(`(()=>{const app=document.querySelector('kin-app');app.ctx.detail.openItemDetail('${areasResult.itemId}');
      const select=[...document.querySelectorAll('.item-area-select')].find(node=>node.dataset.itemId==='${areasResult.itemId}');
      const result={label:select?.getAttribute('aria-label'),selected:select?.selectedOptions[0]?.textContent};
      app.ctx.detail.closeItemDetail({ restoreFocus: false });return result;})()`);
    assert.deepEqual(archivedAreaContext,{label:"Area for Wipe counter",selected:"Food prep (archived)"});
    await visit(first, "household/areas");
    await setViewport(first, {width:320,height:900,deviceScaleFactor:1,mobile:true});
    const narrowAreaLayout=await first.evaluate(`(()=>({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
      width:innerWidth,targets:[...document.querySelectorAll('kin-areas button,kin-areas input,.item-area-select')]
        .filter(node=>node.getClientRects().length).every(node=>node.getBoundingClientRect().height>=48)}))()`);
    assert.deepEqual(narrowAreaLayout,{overflow:false,width:320,targets:true});
    await visit(first, "today");
    const narrowTodayLayout = await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app');
      const visibleControls=[...app.main.querySelectorAll('button,select,input:not([type=checkbox]),a')].filter(node=>node.getClientRects().length);
      const row=app.today.querySelector('kin-item .item-row');
      const nav=getComputedStyle(app.nav);
      const header=app.header.getBoundingClientRect();
      const viewport=document.querySelector('meta[name="viewport"]').content;
      return {
        overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        targets:visibleControls.every(node=>node.getBoundingClientRect().height>=48),
        rowFits:!row||row.getBoundingClientRect().width<=innerWidth,
        bottomNav:nav.position==='fixed'&&nav.bottom==='0px',
        headerFits:header.width<=innerWidth,
        safeArea:viewport.includes('viewport-fit=cover')&&viewport.includes('interactive-widget=resizes-content'),
        detailsCollapsed:[...app.today.querySelectorAll('.item-tools')].every(panel=>panel.hidden),
        primaryVisible:[...app.today.querySelectorAll('kin-item')].every(item=>item.querySelector('.complete-button,.reopen-button,.replenish-button')?.getClientRects().length>0),
      };
    })()`);
    assert.deepEqual(narrowTodayLayout,{overflow:false,targets:true,rowFits:true,bottomNav:true,headerFits:true,safeArea:true,detailsCollapsed:true,primaryVisible:true},
      `Today at 320px keeps every control reachable: ${JSON.stringify(narrowTodayLayout)}`);
    await visit(first, "household/areas");
    await setMedia(first, [{name:"forced-colors",value:"none"},{name:"prefers-reduced-motion",value:"no-preference"},{name:"prefers-color-scheme",value:"dark"}]);
    assert.equal(await first.evaluate("matchMedia('(prefers-color-scheme: dark)').matches"),true,"Area manager follows dark mode");
    await setMedia(first, [{name:"forced-colors",value:"active"},{name:"prefers-reduced-motion",value:"reduce"}]);
    const areaLockReplacement = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app'),prior=app.areas,priorNotes=app.notes;
      const create=prior.querySelector('#area-create-name');create.value='Private Area draft';create.dispatchEvent(new Event('input',{bubbles:true}));
      const rename=[...prior.querySelectorAll('[aria-label^="Rename "]')][0];rename.click();
      const renameInput=prior.querySelector('.area-edit-form input');renameInput.value='Private rename draft';renameInput.dispatchEvent(new Event('input',{bubbles:true}));
      priorNotes.editor.title='Private Note draft';
      priorNotes.referenceEditor={recordId:null,title:'Private Reference draft',areaId:'',fields:[]};
      priorNotes.updateMaintenanceDraft('private-record',{summary:'Private Maintenance draft',performed:'2026-10-15',nextOn:'',routineId:''});
      app.ctx.session.lockHousehold(false);
      const replaced=app.areas!==prior&&app.areas.createDraft===''&&app.areas.renameDraft===null&&app.areas.records.length===0;
      const notesReplaced=app.notes!==priorNotes&&app.notes.editor.title===''&&app.notes.referenceEditor?.title===''&&app.notes.maintenanceDrafts.size===0;
      await app.security.unlockRecovery(${JSON.stringify(recoverySecret)});
      return replaced&&notesReplaced;
    })()`);
    await ready(first);await visit(first,"household/areas");
    const areaDraftsClearedAfterUnlock=await first.evaluate(`(()=>{const areas=document.querySelector('kin-app').areas;
      return areas.createDraft===''&&areas.renameDraft===null&&areas.querySelector('#area-create-name').value===''&&!areas.querySelector('.area-edit-form');})()`);
    assert.equal(areaLockReplacement&&areaDraftsClearedAfterUnlock,true,"locking replaces Areas and Notes state and discards private drafts before unlock");
    console.log("PASS Area validation, sync-safe create/rename drafts, conflicts, controls, and lifecycle flows");

    const eventLimitResult = await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      const context=await app.store.ensureContext();
      const database=app.store.database;
      const transaction=database.transaction(['events','local_context'],'readwrite');
      const events=transaction.objectStore('events');
      events.clear();
      const textBytes=Uint8Array.of(0x78);
      const textLength=new Uint8Array(4);
      new DataView(textLength.buffer).setUint32(0,1,true);
      const nextLogicalTime=10001n;
      for(let index=0;index<10000;index++){
        const eventId=new Uint8Array(16);
        const itemId=new Uint8Array(16);
        new DataView(eventId.buffer).setUint32(12,index+1,true);
        new DataView(itemId.buffer).setUint32(12,index+1,true);
        const payload=new Uint8Array(25);
        payload.set(itemId);
        payload[16]=1; // Need; three reserved zero bytes follow
        payload.set(textLength,20);
        payload.set(textBytes,24);
        const encoded=new Uint8Array(88+payload.length);
        const view=new DataView(encoded.buffer);
        view.setUint16(0,2,true);
        view.setUint16(2,1,true);
        encoded.set(eventId,4);
        encoded.set(context.household_id,20);
        encoded.set(context.actor_id,36);
        encoded.set(context.device_id,52);
        const timestamp=1760000000000+index;
        const logicalTime=BigInt(index+1);
        view.setBigInt64(68,BigInt(timestamp),true);
        view.setBigUint64(76,logicalTime,true);
        view.setUint32(84,payload.length,true);
        encoded.set(payload,88);
        events.add({event_id:eventId,household_id:context.household_id,actor_id:context.actor_id,
          device_id:context.device_id,timestamp,logical_time:logicalTime,kind:'ITEM_ADDED',
          event_version:2,encoded_event:encoded});
      }
      const replacementContext={...context,next_logical_time:nextLogicalTime,
        last_looked_event_id:null,last_looked_local_sequence:0,last_looked_at:Date.now()};
      transaction.objectStore('local_context').put(replacementContext);
      await new Promise((resolve,reject)=>{
        transaction.oncomplete=resolve;
        transaction.onabort=()=>reject(transaction.error);
      });
      await app.store.ensureContext();
      let rejected=false;
      try{
        await app.store.append({type:'add',text:'Beyond the limit',classification:'need'},app.engine);
      }catch(error){
        rejected=error.userMessage?.includes('event limit')===true;
      }
      const stored=await app.store.loadEvents();
      const finalContext=await app.store.ensureContext();
      return {rejected,count:stored.length,nextLogicalTime:finalContext.next_logical_time.toString()};
    })()`);
    assert.deepEqual(eventLimitResult, {
      rejected: true,
      count: 10000,
      nextLogicalTime: "10001",
    });
    console.log("PASS 10,000-event limit preserves history and logical counter");
  }
  assert.deepEqual(problems, [], "Uncaught errors or CSP/console errors");
  assert.ok(
    requests.length > 0 &&
      requests.every((url) =>
        url.startsWith(origin + "/") ||
        url.startsWith(`blob:${origin}/`) ||
        url.startsWith("data:image/svg+xml;base64,")
      ),
    `All page requests stay same-origin (including the page's own blob: previews) or use browser-native SVG data: ${requests.filter((url) => !url.startsWith(origin + "/") && !url.startsWith(`blob:${origin}/`) && !url.startsWith("data:image/svg+xml;base64,")).join(", ")}`,
  );
  console.log(
    "PASS CSP/console and same-origin requests (favicon 404 excluded)",
  );
  await syncStorageRegressions(first);
  console.log("PASS final encrypted sync storage regression");
  // The first run with a password (#557) needs the real service, so it
  // runs its own on another origin, in isolated browser contexts; its pages
  // are not part of the same-origin and console checks above.
  if (REGRESSION_PART !== "1") console.log(await firstRunRegressions({ endpoint, browserClient }));
  // Signing in on a new device (#568), on its own service too.
  if (REGRESSION_PART !== "1") console.log(await newDeviceRegressions({ endpoint, browserClient }));
  // A password account's passkey and backup code (#560, #571), with a virtual
  // authenticator, on its own service too.
  if (REGRESSION_PART !== "1") console.log(await accountSecurityRegressions({ endpoint, browserClient }));
  // Just for me (#510) needs private storage, which opens after a password
  // sign-up (#557): like the first run, it runs its own service and context.
  if (REGRESSION_PART !== "1") console.log(await justForMeRegressions({ endpoint, browserClient }));
  // Reminders and settings that follow a member across two of their devices
  // (#520), on the real service the same way.
  if (REGRESSION_PART !== "1") console.log(await syncedPrefsRegressions({ endpoint, browserClient }));
  // The journal (#496) through the same real password flow, on its own
  // origin: private storage opens with the vault key sign-up keeps.
  if (REGRESSION_PART !== "1") console.log(await journalRegressions({ endpoint, browserClient }));
  // Finishing epic #546 and #480: a household set up the old way moves to an
  // account and signs in on a fresh browser, offline passkey unlock, the
  // member's own private export, start over, remove passkey and a password
  // changed elsewhere, with a virtual authenticator on its own service.
  if (REGRESSION_PART !== "1") console.log(await accountMigrationRegressions({ endpoint, browserClient }));
  // Reports and suggestions to the Kin team (#634, ADR 0021 §3): a report
  // with a detail removed, with a cropped picture, from the outbox after
  // being offline, and from the lock screen; an admin's suggestion; and What
  // I've sent with a status the operator set. On its own service too.
  if (REGRESSION_PART !== "1") console.log(await reportProblemRegressions({ endpoint, browserClient }));
  // Set up Kin for someone (#612–#615): an admin prepares an invitation for
  // Rose with easy mode and prints its sheet; Rose opens the link in a fresh
  // browser, sets a password, the admin approves, and she lands on Today in
  // easy mode with her name. On its own service too.
  if (REGRESSION_PART !== "1") console.log(await setupForSomeoneRegressions({ endpoint, browserClient }));
} catch (error) {
  // The whole failure as an annotation, so an attempt that a passing retry
  // hides can still be read in CI (#594).
  if (process.env.GITHUB_ACTIONS) {
    const text = `${error?.stack ?? error}`.slice(0, 3500).replace(/%/g, "%25").replace(/\r?\n/g, "%0A");
    console.log(`::warning title=Kin browser regression attempt failed::${text}`);
  }
  // Before the browser closes: what each page showed (#328).
  await captureFailure("browser regression");
  throw error;
} finally {
  printAbortedModules(createLoadTrace({ aborted: abortedModuleLoads }));
  if (browserClient) await browserClient.send("Browser.close").catch(() => {});
  for (const client of clients) client.close();
  browser.kill();
  await new Promise((done) => server.close(done));
  await calendarHarness.close();
  // The path was created by mkdtemp above; never remove a user browser profile.
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
