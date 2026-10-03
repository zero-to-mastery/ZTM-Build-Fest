// Node 22+ and a Chromium-family executable; no npm packages required.
// Uses a fresh temporary profile and loopback server, never an existing Kin DB.
import {
  pulseRegressions,
  pulsePeerRegressions,
  pulseResilienceRegressions,
  pulseKeyboardRegressions,
} from "./pulse-regression.mjs";
import { talkRegressions, talkPeerRegressions } from "./talk-regression.mjs";
import assert from "node:assert/strict";
import {
  routineRegressions,
  routinePeerRegressions,
  routineKeyboardRegressions,
} from "./routine-regression.mjs";
import {
  handoffRegressions,
  handoffPeerRegressions,
} from "./handoff-regression.mjs";
import {
  catchUpRegressions,
  catchUpPeerRegressions,
} from "./catch-up-regression.mjs";
import { syncStorageRegressions } from "./sync-storage-regression.mjs";
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
const server = createServer(async (request, response) => {
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
const browser = spawn(
  executable,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let launchError;
browser.on("error", (error) => {
  launchError = error;
});
const clients = [];
const problems = [];
const requests = [];
let browserClient;

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (launchError) throw launchError;
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Timed out waiting for browser state");
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    socket.onopen = done;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
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
    }
  };
  const client = {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const number = ++id;
        const timeout = setTimeout(
          () => reject(new Error(`CDP timeout: ${method}`)),
          120000,
        );
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
      const result = await this.send("Runtime.evaluate", {
        expression,
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
  };
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
    app.today
      .querySelectorAll("section")[1]
      .querySelector("kin-item .item-text")?.textContent === "Normal success",
    "default item appears in Needs",
  );
  draft("");
  check(document.activeElement === compose.input, "add focus");
  passed.push(
    "startup, normal add, own draft clearing, sessionStorage removal, focus, busy",
  );

  const legacyText = "Legacy v0.1 item";
  const legacyTextBytes = new TextEncoder().encode(legacyText);
  const legacyContext = await app.store.ensureContext();
  const legacyEventId = crypto.getRandomValues(new Uint8Array(16));
  const legacyItemId = crypto.getRandomValues(new Uint8Array(16));
  const legacyTimestamp = Date.now();
  const legacyLogicalTime = legacyContext.next_logical_time;
  const legacyPayload = new Uint8Array(20 + legacyTextBytes.length);
  legacyPayload.set(legacyItemId);
  new DataView(legacyPayload.buffer).setUint32(
    16,
    legacyTextBytes.length,
    true,
  );
  legacyPayload.set(legacyTextBytes, 20);
  const legacyBytes = new Uint8Array(88 + legacyPayload.length);
  const legacyView = new DataView(legacyBytes.buffer);
  legacyView.setUint16(0, 1, true);
  legacyView.setUint16(2, 1, true);
  legacyBytes.set(legacyEventId, 4);
  legacyBytes.set(legacyContext.household_id, 20);
  legacyBytes.set(legacyContext.actor_id, 36);
  legacyBytes.set(legacyContext.device_id, 52);
  legacyView.setBigInt64(68, BigInt(legacyTimestamp), true);
  legacyView.setBigUint64(76, legacyLogicalTime, true);
  legacyView.setUint32(84, legacyPayload.length, true);
  legacyBytes.set(legacyPayload, 88);
  const legacyTransaction = app.store.database.transaction(
    ["events", "local_context"],
    "readwrite",
  );
  const legacyCompletion = new Promise((resolve, reject) => {
    legacyTransaction.oncomplete = resolve;
    legacyTransaction.onabort = () => reject(legacyTransaction.error);
  });
  legacyTransaction.objectStore("events").add({
    event_id: legacyEventId,
    household_id: legacyContext.household_id,
    actor_id: legacyContext.actor_id,
    device_id: legacyContext.device_id,
    timestamp: legacyTimestamp,
    logical_time: legacyLogicalTime,
    kind: "ITEM_ADDED",
    event_version: 1,
    encoded_event: legacyBytes,
  });
  legacyTransaction.objectStore("local_context").put({
    ...legacyContext,
    next_logical_time: legacyLogicalTime + 1n,
  });
  await legacyCompletion;
  await app.refreshFromEvents();
  const legacyStored = (await app.store.loadEvents()).at(-1).encoded_event;
  check(
    [...new Uint8Array(legacyStored)].every(
      (byte, index) => byte === legacyBytes[index],
    ),
    "legacy source bytes remain unchanged",
  );
  check(
    app.state.items.find((item) => item.text === legacyText).classification ===
      "today",
    "legacy item normalizes to Today",
  );
  passed.push(
    "synthetic v0.1 event replay, Today normalization, immutable source bytes",
  );

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
  async function failOnce(mode, operation = submit) {
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
    check(document.activeElement === compose.input, "failure focus");
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
    if (changed) edit("Buy bread", "today");
    if (changed) {
      const retry = app.retryAction;
      const load = app.store.getCatchUpState.bind(app.store);
      app.store.getCatchUpState = async () => {
        throw new Error("Synthetic item refresh failure");
      };
      try {
        await app.refreshFromEvents();
        await app.refreshFromEvents();
      } finally {
        app.store.getCatchUpState = load;
      }
      await app.retryAction();
      check(
        app.retryAction === retry,
        "Item retry survives repeated refresh failure",
      );
      app.handlePeerMessage({ data: { type: "events-changed" } });
      await idle();
      check(
        !app.retryButton.hidden,
        "peer refresh must retain failed-command retry",
      );
      draft("Buy bread", "today");
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
    draft(changed ? "Buy bread" : "", changed ? "today" : "need");
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
  edit("Pending original", "today");
  const event = {
    detail: { text: "Pending original", classification: "today" },
  };
  const operation = app.handleAddItem(event);
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
    app.state.items.at(-1).classification === "today",
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
      ".archive-button",
    ]) {
      const buttons = [...app.querySelectorAll(`kin-item ${selector}`)];
      check(buttons.length > 0, `fixture must expose ${selector}`);
      check(
        buttons.every((button) => button.disabled === disabled),
        `${selector} disabled state`,
      );
    }
    for (const control of [
      compose.input,
      compose.classification,
      compose.button,
      app.retryButton,
    ]) {
      check(control.disabled === disabled, `${control.tagName} disabled state`);
    }
  };
  checkControls(true);
  // Native disabled buttons must suppress activation, including retry clicks.
  let activations = 0;
  const recordActivation = () => {
    activations++;
  };
  app.addEventListener("click", recordActivation);
  for (const button of [...app.main.querySelectorAll("button"), app.retryButton]) button.click();
  app.removeEventListener("click", recordActivation);
  check(activations === 0, "busy controls must not dispatch clicks");
  check((await count()) === actionEventCount, "pending retry has not appended");
  releaseRetry();
  await idle();
  app.store.append = append;
  check(appendCalls === 1, "busy clicks must not start additional writes");
  check(
    [...app.querySelectorAll("kin-item button")].every(
      (button) => !button.disabled,
    ) &&
      !compose.input.disabled &&
      !compose.classification.disabled &&
      !compose.button.disabled &&
      !app.retryButton.disabled,
    "all appropriate controls become usable after retry",
  );
  check(
    document.activeElement === compose.input,
    "pending retry restores compose focus",
  );
  passed.push(
    "pending retry disables Complete, Reopen, every Archive, compose input/select/Add and retry; controls and focus recover",
  );
  check(
    app.state.items.find((item) => item.text === actionText).status ===
      "active",
    "reopen retry applies once",
  );
  check((await count()) === actionEventCount + 1, "reopen retry appends once");

  actionItem = findItem(actionText);
  actionEventCount = await count();
  await failOnce("quota", async () => {
    actionItem.querySelector(".archive-button").click();
    await idle();
  });
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
  reopenedItem.querySelector(".archive-button").click();
  await idle();
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
  const completedTodayItem = [...app.querySelectorAll("kin-item")].find(
    (item) => item.querySelector(".item-text")?.textContent === legacyText,
  );
  completedTodayItem.querySelector(".archive-button").click();
  await idle();
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

  history.replaceState(null, "", "/pair?code=F7KM-Q2DX");
  const household = document.createElement("kin-household");
  document.body.append(household);
  for (
    let attempt = 0;
    attempt < 100 && !household.querySelector('input[name="code"]');
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  check(
    location.pathname === "/pair" && location.search === "",
    "invitation code must be removed from browser history immediately",
  );
  check(
    household.querySelector('input[name="code"]')?.value === "F7KM-Q2DX",
    "invitation code must prefill after URL cleanup",
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
      (button) => button.textContent === "Log in with passkey",
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
  const port = await until(async () => {
    try {
      return (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
    } catch {
      return false;
    }
  });
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
    await client.send("Page.navigate", { url: origin });
    await ready(client);
    return client;
  }
  async function ready(client) {
    await until(() => client.evaluate('Boolean(document.querySelector("kin-app")?.security?.heading)'));
    const locked = await client.evaluate('document.querySelector("kin-app").security.phase !== "unlocked"');
    if (locked) await client.evaluate(`(async () => {
      const security = document.querySelector("kin-app").security;
      if (security.manifest) await security.unlockRecovery(${JSON.stringify(recoverySecret)});
      else await security.establishProtection(${JSON.stringify(recoverySecret)});
    })()`);
    await until(() => client.evaluate('Boolean(document.querySelector("kin-app")?.store && !document.querySelector("kin-app").busy)'));
  }
  const first = await tab();
  console.log(await first.evaluate(`(${regressions.toString()})()`));
  console.log(await first.evaluate(`(${handoffRegressions.toString()})()`));
  console.log(await first.evaluate(`(${talkRegressions.toString()})()`));
  console.log(await first.evaluate(`(${pulseRegressions.toString()})()`));
  console.log(
    await first.evaluate(`(${pulseResilienceRegressions.toString()})()`),
  );
  console.log(await first.evaluate(`(${catchUpRegressions.toString()})()`));
  console.log(await first.evaluate(`(${routineRegressions.toString()})()`));
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
    await first.evaluate('document.querySelector("select").value'),
    "need",
    "reload defaults ephemeral draft classification to Needs",
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

  assert.equal(
    await first.evaluate('document.querySelector("#handoff-text").value'),
    "",
    "Handoff draft is discarded on reload",
  );
  await first.evaluate(`(()=>{const input=document.querySelector('#handoff-text');input.value='Newer handoff draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
  for (const type of ["keyDown", "keyUp"])
    await first.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
  await ready(first);
  assert.equal(
    await first.evaluate('document.querySelector("#handoff-text").value'),
    "",
  );
  await first.evaluate(
    'document.querySelector("kin-handoff-list [aria-label=\\\"Acknowledge Newer handoff draft\\\"]").focus()',
  );
  for (const type of ["keyDown", "keyUp"])
    await first.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
  await ready(first);
  assert.equal(
    await first.evaluate(
      'document.activeElement === document.querySelector("#handoff-text")',
    ),
    true,
  );
  assert.equal(
    await first.evaluate(
      'document.querySelector("kin-app").state.handoffs.find(row=>row.text==="Newer handoff draft").status',
    ),
    "acknowledged",
  );
  console.log(
    "PASS Handoff draft disposal, keyboard capture/acknowledgement, focus restoration",
  );
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
  await ready(first);
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
  await ready(first);
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
    await ready(first);
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
  const second = await tab();
  await second.evaluate(`window.peerReads=0; window.peerReplays=0; window.peerMessages=[];
    { const a=document.querySelector('kin-app'); const load=a.store.getCatchUpState.bind(a.store); const replay=a.engine.applyEvents;
      a.store.getCatchUpState=async()=>{window.peerReads++;return load();};
      a.engine.applyEvents=(...args)=>{window.peerReplays++;return replay(...args);};
      a.channel.addEventListener('message',e=>window.peerMessages.push(e.data)); }`);
  await first.evaluate(
    `{const a=document.querySelector('kin-app');a.compose.input.value='Peer addition';a.compose.saveDraft();a.compose.form.requestSubmit();}`,
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
    [...app.querySelectorAll('kin-item')]
      .find(element=>element.record?.itemId==='${raceItemId}')
      .querySelector('.archive-button').click();
    for(let index=0;app.busy&&index<200;index++)
      await new Promise(resolve=>setTimeout(resolve,10));
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
        focusRestored:document.activeElement===app.compose.input,
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
    [...app.querySelectorAll('kin-item')]
      .find(element=>element.record?.itemId==='${noSignalItemId}')
      .querySelector('.archive-button').click();
    for(let index=0;app.busy&&index<200;index++)
      await new Promise(resolve=>setTimeout(resolve,10));
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

  await handoffPeerRegressions(first, second, until);
  await talkPeerRegressions(first, second, until);
  await pulsePeerRegressions(first, second, until, ready);
  await catchUpPeerRegressions(first, second, until);
  await pulseKeyboardRegressions(first, until);
  await routinePeerRegressions(first, second, until);
  await routineKeyboardRegressions(first, until);
  await first.evaluate(`(()=>{
    const app=document.querySelector('kin-app');
    const item=[...app.querySelectorAll('kin-item')]
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
      'document.activeElement===document.querySelector("input")',
    ),
    true,
    "keyboard completion restores capture focus",
  );
  console.log("PASS keyboard item action and focus restoration");

  await first.evaluate(
    `{const a=document.querySelector('kin-app');a.remove();document.body.append(a);}`,
  );
  await ready(first);
  assert.equal(
    await first.evaluate(
      'document.querySelectorAll("kin-compose .compose-form").length',
    ),
    1,
  );
  await first.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
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
  await first.evaluate('document.querySelector("select").focus()');
  assert.deepEqual(
    await first.evaluate(`(()=>{
      const select=document.querySelector('select');
      return {
        label:select.labels?.[0]?.textContent,
        targetHeight:select.getBoundingClientRect().height,
        focusWidth:getComputedStyle(select).outlineWidth,
      };
    })()`),
    { label: "Add to", targetHeight: 54, focusWidth: "3px" },
  );
  await first.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "forced-colors", value: "active" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  assert.deepEqual(
    await first.evaluate(`(()=>{
      const controls=[...document.querySelectorAll('button,select')];
      return {
        forcedColors:matchMedia('(forced-colors: active)').matches,
        reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
        undersized:controls.some(control=>control.getClientRects().length>0&&control.getBoundingClientRect().height<48),
        focusWidth:getComputedStyle(document.querySelector('select')).outlineWidth,
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
  assert.equal(
    await first.evaluate(`(()=>{
    const app=document.querySelector('kin-app'),capture=app.talks;
    capture.input.focus();
    return capture.querySelector('h2').textContent==='Talk' &&
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
  assert.equal(
    await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app'),ui=app.routines;ui.cadence.focus();
      return ui.querySelector('h2').textContent==='Routines' && ui.input.labels.length===1 && ui.cadence.labels[0].textContent==='Repeat' &&
        ui.querySelectorAll('ul > li').length>0 && ui.textContent.includes('today') &&
        getComputedStyle(ui.cadence).outlineWidth==='3px' &&
        [...ui.querySelectorAll('button,select,input')].every(control=>control.getBoundingClientRect().height>=48) &&
        app.status.getAttribute('aria-live')==='polite' && app.alert.getAttribute('role')==='alert';
    })()`),
    true,
    "Routine semantics, labels, textual state, focus and targets in forced colors",
  );
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
  // Keep optional visual evidence under ignored project build output.
  if (process.env.KIN_VISUAL_CHECK === "1") {
    await first.send("Emulation.setEmulatedMedia", { features: [] });
    await first.evaluate(
      "document.querySelector('kin-app').routines.scrollIntoView({block:'start'})",
    );
    await writeFile(
      resolve(webRoot, "../target/routines-320.png"),
      Buffer.from(
        (await first.send("Page.captureScreenshot", { format: "png" })).data,
        "base64",
      ),
    );
    await first.evaluate(
      `(async()=>{const a=document.querySelector('kin-app'),timestamp=Date.now();await a.savePulse({type:'set-pulse',value:'need-quiet',timestamp,expiresAt:timestamp+14400000});a.pulse.scrollIntoView({block:'center'});})()`,
    );
    await writeFile(
      resolve(webRoot, "../target/pulse-active-320.png"),
      Buffer.from(
        (await first.send("Page.captureScreenshot", { format: "png" })).data,
        "base64",
      ),
    );
    await first.evaluate(
      `(()=>{const p=document.querySelector('kin-app').pulse;p.changeButton.click();p.scrollIntoView({block:'end'});})()`,
    );
    await writeFile(
      resolve(webRoot, "../target/pulse-change-320.png"),
      Buffer.from(
        (await first.send("Page.captureScreenshot", { format: "png" })).data,
        "base64",
      ),
    );
    await first.evaluate(
      `document.querySelector('kin-app').savePulse({type:'clear-pulse'})`,
    );
  }
  await first.send("Emulation.setDeviceMetricsOverride", {
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
    await a.refreshFromEvents();
    if(a.alert.hidden || a.busy) throw Error('Malformed row must fail safely');
    const read=a.store.database.transaction('events','readonly').objectStore('events').getAll();
    await new Promise((r,j)=>{read.onsuccess=r;read.onerror=j;});
    if(read.result.at(-1).encoded_event.length!==1) throw Error('Malformed row was changed');
    const cleanup=a.store.database.transaction('events','readwrite');
    cleanup.objectStore('events').delete(read.result.at(-1).local_sequence);
    await new Promise((r,j)=>{cleanup.oncomplete=r;cleanup.onabort=j;});
    await a.refreshFromEvents();
    if(!a.retryButton.hidden || a.retryAction!==null) throw Error('Recovered refresh left stale retry');
    const goodRead=a.store.database.transaction('events','readonly').objectStore('events').getAll();
    await new Promise((r,j)=>{goodRead.onsuccess=r;goodRead.onerror=j;});
    const original=goodRead.result.find(row=>row.kind==='ITEM_ADDED');
    const originalBytes=[...new Uint8Array(original.encoded_event)];
    const corrupted={...original,kind:'ITEM_COMPLETED'};
    const corruptTx=a.store.database.transaction('events','readwrite');
    corruptTx.objectStore('events').put(corrupted);
    await new Promise((r,j)=>{corruptTx.oncomplete=r;corruptTx.onabort=j;});
    await a.refreshFromEvents();
    if(a.alert.hidden || a.busy) throw Error('Metadata mismatch must fail safely');
    const persistedRead=a.store.database.transaction('events','readonly').objectStore('events').get(original.local_sequence);
    await new Promise((r,j)=>{persistedRead.onsuccess=r;persistedRead.onerror=j;});
    if(persistedRead.result.kind!=='ITEM_COMPLETED') throw Error('Corrupt metadata was changed');
    if([...new Uint8Array(persistedRead.result.encoded_event)].some((byte,index)=>byte!==originalBytes[index])) throw Error('Canonical event bytes changed');
    const restoreTx=a.store.database.transaction('events','readwrite');
    restoreTx.objectStore('events').put(original);
    await new Promise((r,j)=>{restoreTx.oncomplete=r;restoreTx.onabort=j;});
    await a.refreshFromEvents();
    if(!a.retryButton.hidden || a.retryAction!==null) throw Error('Metadata recovery left stale retry');
  })()`);
  console.log(
    "PASS malformed row and metadata preservation, canonical-byte integrity, refresh recovery",
  );
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
      const payload=new Uint8Array(21);
      payload.set(itemId);
      payload.set(textLength,16);
      payload.set(textBytes,20);
      const encoded=new Uint8Array(88+payload.length);
      const view=new DataView(encoded.buffer);
      view.setUint16(0,1,true);
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
        event_version:1,encoded_event:encoded});
    }
    const replacementContext={...context,next_logical_time:nextLogicalTime};
    delete replacementContext.last_looked_event_id;
    delete replacementContext.last_looked_local_sequence;
    delete replacementContext.last_looked_at;
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
  assert.deepEqual(problems, [], "Uncaught errors or CSP/console errors");
  assert.ok(
    requests.length > 0 &&
      requests.every((url) => url.startsWith(origin + "/")),
    `All page requests stay same-origin: ${requests.filter((url) => !url.startsWith(origin + "/")).join(", ")}`,
  );
  console.log(
    "PASS CSP/console and same-origin requests (favicon 404 excluded)",
  );
  await syncStorageRegressions(first);
} finally {
  if (browserClient) await browserClient.send("Browser.close").catch(() => {});
  for (const client of clients) client.close();
  browser.kill();
  await new Promise((done) => server.close(done));
  // The path was created by mkdtemp above; never remove a user browser profile.
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
