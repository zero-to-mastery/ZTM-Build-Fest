// Stage-level performance baseline for the refactor track.
//
//   node scripts/core-performance.mjs                 Node stages only
//   node scripts/core-performance.mjs --browser <exe> adds browser stages
//   node scripts/core-performance.mjs --json <file>   also writes the report
//
// Node stages (real release WASM, no storage): loading a whole history into
// the instance (batch build, copy, Rust validation), appending one more event,
// Rust replay + projection encode of the held history (a full replay, then
// one more event replayed from the checkpoint the first left), and copy-out +
// JS decode. Since Slice 6 the instance holds the history, so a refresh pays the
// one-event append, not the load.
// Browser stages (real IndexedDB, Web Crypto and the shipped app): native IDB
// read of the protected rows, decryption of every row, first unlock to a
// projection, store-level refresh and command, and the app's full
// cross-tab refresh and render. Fixtures are synthetic and the browser profile
// is temporary. Every figure is a median; see `samples` for the count.
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(projectRoot, "web/wasm/kin_engine.wasm");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const DATASETS = [
  { name: "1k short", count: 1000, textBytes: 24 },
  { name: "10k short", count: 10_000, textBytes: 24 },
  { name: "10k x 4 KB", count: 10_000, textBytes: 4096 },
];

function ensureWasm() {
  if (existsSync(wasmPath)) return false;
  console.error("kin_engine.wasm is missing; building the release WASM first.");
  const build = spawnSync("cargo", ["build", "--manifest-path", join(projectRoot, "Cargo.toml"),
    "--target", "wasm32-unknown-unknown", "--release"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) throw new Error("cargo build for wasm32-unknown-unknown failed");
  spawnSync(process.execPath, ["-e", `require("node:fs").copyFileSync(${JSON.stringify(join(projectRoot,
    "target/wasm32-unknown-unknown/release/kin.wasm"))}, ${JSON.stringify(wasmPath)})`], { stdio: "inherit" });
  return true;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function nodeStages() {
  const { loadKinEngine, encodeAddedRecord, encodeReplayRequest, decodeProjection } =
    await import("../web/wasm/kin-engine.js");
  const { appendBatch, callExport } = await import("../web/wasm/abi-test-support.mjs");
  const bytes = await readFile(wasmPath);
  const codec = await loadKinEngine(`data:application/wasm;base64,${bytes.toString("base64")}`);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const abi = instance.exports;
  const id = (value, tag) => {
    const out = new Uint8Array(16).fill(tag);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
  };
  const context = encodeReplayRequest([], 1_760_100_000_000, null, 20261014, null);
  const results = [];
  for (const dataset of DATASETS) {
    const text = "h".repeat(dataset.textBytes);
    const records = Array.from({ length: dataset.count }, (_, index) => encodeAddedRecord({
      eventId: id(index + 1, 1), itemId: id(index + 1, 2), householdId: id(7, 3),
      actorId: id(8, 4), deviceId: id(9, 5), timestamp: 1_760_000_000_000 + index,
      logicalTime: BigInt(index + 1), text, classification: "need",
    }));
    const last = appendBatch(records.slice(-1));
    const stage = { load: [], append: [], replay: [], incremental: [], decode: [] };
    for (let sample = 0; sample < 8; sample += 1) {
      let start = performance.now();
      abi.kin_history_reset();
      assert.equal(callExport(abi, "kin_history_append", appendBatch(records.slice(0, -1))), 0);
      const load = performance.now() - start;
      start = performance.now();
      assert.equal(callExport(abi, "kin_project", context), 0);
      const replay = performance.now() - start; // full replay; leaves a checkpoint
      start = performance.now();
      assert.equal(callExport(abi, "kin_history_append", last), 0);
      const append = performance.now() - start;
      start = performance.now();
      assert.equal(callExport(abi, "kin_project", context), 0);
      const incremental = performance.now() - start; // one event after the checkpoint
      start = performance.now();
      const output = new Uint8Array(abi.memory.buffer, abi.kin_result_ptr(), abi.kin_result_len()).slice();
      const state = decodeProjection(output);
      const decode = performance.now() - start;
      assert.equal(state.items.length, dataset.count);
      if (sample === 0) continue; // warm-up
      stage.load.push(load); stage.append.push(append);
      stage.replay.push(replay); stage.incremental.push(incremental); stage.decode.push(decode);
    }
    results.push({
      dataset: dataset.name, events: dataset.count,
      canonicalBytes: records.reduce((total, row) => total + row.length, 0),
      historyLoadMs: median(stage.load), appendOneMs: median(stage.append),
      replayEncodeMs: median(stage.replay), incrementalReplayMs: median(stage.incremental),
      jsDecodeMs: median(stage.decode), samples: stage.replay.length,
    });
  }
  abi.kin_clear();
  codec.dispose();
  return { wasmBytes: bytes.length, datasets: results };
}

// Runs in a bare same-origin page: builds the encrypted fixture and measures
// storage stages. Returns the recovery secret so the app page can unlock.
async function storageStages({ count: requested, textBytes }) {
  // Leave room under the 10,000-event store limit for the command samples.
  const count = Math.min(requested, 9_980);
  const { LocalVault } = await import("/security/local-vault.js");
  const { EventStore, EVENT_STORE_DEFINITIONS } = await import("/storage/event-store.js");
  const { unprotectRecord, mapProtectedBatch } = await import("/storage/encrypted-idb.js");
  const { loadKinEngine, encodeAddedRecord, randomId } = await import("/wasm/kin-engine.js");
  const { projectionContext } = await import("/browser-time.js");
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  // A history view (session arena) or, before it, an array of rows.
  const source = (events) => (typeof events.copyTo === "function" ? events : events.map((row) => row.encoded_event));
  const deleteDatabase = (name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  });
  await deleteDatabase("kin");
  await deleteDatabase("kin-crypto-keys");
  const engine = await loadKinEngine();
  const legacy = await EventStore.openLegacyForMigration();
  const context = await legacy.ensureContext();
  const text = "h".repeat(textBytes);
  await new Promise((resolve, reject) => {
    const transaction = legacy.database.transaction(["events", "local_context"], "readwrite");
    for (let i = 0; i < count; i += 1) {
      const eventId = randomId();
      const identity = { eventId, householdId: context.household_id, actorId: context.actor_id,
        deviceId: context.device_id, timestamp: 1_760_000_000_000 + i, logicalTime: BigInt(i + 1) };
      transaction.objectStore("events").add({ event_id: eventId, household_id: identity.householdId,
        actor_id: identity.actorId, device_id: identity.deviceId, timestamp: identity.timestamp,
        logical_time: identity.logicalTime, kind: "ITEM_ADDED", event_version: 2,
        encoded_event: encodeAddedRecord({ ...identity, itemId: randomId(), text, classification: "need" }) });
    }
    transaction.objectStore("local_context").put({ ...context, next_logical_time: BigInt(count + 1) });
    transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
  });
  legacy.close();
  const { vault, manifest, recoverySecret } = await LocalVault.create();
  await EventStore.prepareSecurity(manifest);
  await EventStore.migrate({ vault, engine, prepareKeys: async () => ({}), finalizeKeys: async () => {} });
  vault.lock();

  const unlockStart = performance.now();
  const unlocked = await LocalVault.unlock(await EventStore.securityStatus(), recoverySecret);
  const store = await EventStore.open({ vault: unlocked, engine });
  const first = await store.getCatchUpState();
  const { asOf, civilDate } = projectionContext();
  engine.applyEvents(source(first.events), asOf, first.cursor.eventId, civilDate, first.syncIdentity);
  const unlockMs = performance.now() - unlockStart;

  const raw = await new Promise((resolve, reject) => {
    const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const reads = [], decrypts = [];
  for (let sample = 0; sample < 4; sample += 1) {
    let start = performance.now();
    const rows = await new Promise((resolve, reject) => {
      const request = raw.transaction("events").objectStore("events").getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    reads.push(performance.now() - start);
    start = performance.now();
    await mapProtectedBatch(rows, (row) => unprotectRecord(unlocked, "events", EVENT_STORE_DEFINITIONS.events, row));
    decrypts.push(performance.now() - start);
  }
  raw.close();

  const refreshes = [];
  for (let sample = 0; sample < 6; sample += 1) {
    const start = performance.now();
    const snapshot = await store.getCatchUpState();
    const context = projectionContext();
    engine.applyEvents(source(snapshot.events), context.asOf, snapshot.cursor.eventId,
      context.civilDate, snapshot.syncIdentity);
    if (sample) refreshes.push(performance.now() - start);
  }
  const commands = [];
  for (let sample = 0; sample < 6; sample += 1) {
    const start = performance.now();
    await store.append({ type: "add", text: `Benchmark command ${sample}`, classification: "need" }, engine);
    if (sample) commands.push(performance.now() - start);
  }
  store.close();
  unlocked.lock();
  engine.dispose();
  return {
    events: count, recoverySecret, unlockToProjectionMs: unlockMs, idbReadMs: median(reads), decryptMs: median(decrypts),
    storeRefreshMs: median(refreshes), storeCommandMs: median(commands),
    samples: { idb: reads.length, refresh: refreshes.length, command: commands.length },
  };
}

// Runs in the shipped app page after it unlocked the fixture household.
// renderMs and appRefreshMs repeat with nothing changed; changeRefreshMs is a
// peer refresh after one new Handoff (Items untouched); fullRenderMs renders
// after every projection array was replaced, so no section can be skipped.
async function appStages() {
  const app = document.querySelector("kin-app");
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const idle = async () => {
    for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 2000; i += 1) await new Promise((r) => setTimeout(r, 5));
  };
  const copyArrays = (state) => Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
  await idle();
  const renders = [], refreshes = [], changeRefreshes = [], fullRenders = [];
  const busyOn = [], busyOff = [];
  for (let sample = 0; sample < 6; sample += 1) {
    let start = performance.now();
    app.ctx.status.setBusy(true);
    const enableBusy = performance.now() - start;
    start = performance.now();
    app.ctx.status.setBusy(false);
    const disableBusy = performance.now() - start;
    await idle();
    start = performance.now();
    app.ctx.render.renderState();
    const render = performance.now() - start;
    await idle();
    start = performance.now();
    await app.ctx.refresh.refreshFromEvents();
    const refresh = performance.now() - start;
    await idle();
    await app.store.append({ type: "add-handoff", text: `Benchmark handoff ${sample}` }, app.engine);
    start = performance.now();
    await app.ctx.refresh.refreshFromEvents();
    const changeRefresh = performance.now() - start;
    await idle();
    app.state = copyArrays(app.state);
    start = performance.now();
    app.ctx.render.renderState();
    const fullRender = performance.now() - start;
    await idle();
    await app.ctx.refresh.refreshFromEvents(); // re-seeds reusable sections after the copy
    await idle();
    if (sample) {
      busyOn.push(enableBusy); busyOff.push(disableBusy);
      renders.push(render); refreshes.push(refresh); changeRefreshes.push(changeRefresh); fullRenders.push(fullRender);
    }
  }
  return { renderMs: median(renders), appRefreshMs: median(refreshes), changeRefreshMs: median(changeRefreshes),
    fullRenderMs: median(fullRenders), busyOnMs: median(busyOn), busyOffMs: median(busyOff),
    busyRoundTripMs: median(busyOn) + median(busyOff), controls: app.main.querySelectorAll("button,input,select,textarea").length,
    items: app.state.items.length, samples: renders.length };
}

async function browserStages(executable) {
  const webRoot = join(projectRoot, "web");
  const profile = await mkdtemp(join(tmpdir(), "kin-performance-"));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/api/status") { response.setHeader("Content-Type", "application/json"); response.end('{"identity":null,"claim":null}'); return; }
    if (pathname === "/__perf") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Kin performance</title>"); return; }
    const path = resolve(webRoot, `.${pathname.replace(/\/$/, "/index.html")}`);
    if (!path.startsWith(webRoot + sep)) { response.writeHead(403).end(); return; }
    try {
      response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" }[extname(path)] ?? "application/octet-stream");
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  BROWSER_STDIO);
  let socket;
  try {
    const port = await waitForDevTools(browser, profile);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const task = pending.get(message.id); pending.delete(message.id);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((done, reject) => {
      const number = ++id; pending.set(number, { resolve: done, reject });
      socket.send(JSON.stringify({ id: number, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async (expression, limit = 1200) => {
      for (let attempt = 0; attempt < limit; attempt += 1) {
        try { if (await evaluate(expression)) return; } catch { /* page navigating */ }
        await delay(50);
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };
    await send("Page.enable");
    const results = [];
    for (const dataset of DATASETS) {
      await send("Page.navigate", { url: `${origin}/__perf` });
      await until("document.readyState === 'complete' && location.pathname === '/__perf'");
      const storage = await evaluate(`(${storageStages.toString()})(${JSON.stringify(dataset)})`);
      await send("Page.navigate", { url: `${origin}/` });
      await until('Boolean(document.querySelector("kin-app")?.security?.manifest)');
      const unlockStart = Date.now();
      await evaluate(`document.querySelector("kin-app").security.unlockRecovery(${JSON.stringify(storage.recoverySecret)})`);
      await until('Boolean(document.querySelector("kin-app")?.store && !document.querySelector("kin-app").busy)');
      const appUnlockMs = Date.now() - unlockStart;
      const app = await evaluate(`(${appStages.toString()})()`);
      delete storage.recoverySecret;
      results.push({ dataset: dataset.name, events: dataset.count, appUnlockMs, ...storage, ...app });
      console.error(`browser ${dataset.name}: ${JSON.stringify(results.at(-1))}`);
    }
    return { browser: version.Browser, datasets: results };
  } finally {
    socket?.close();
    if (process.platform === "win32" && browser.pid) {
      const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
        "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe' OR Name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
      await once(killer, "exit");
    } else browser.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await delay(300);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

const built = ensureWasm();
const report = {
  scope: "Medians after one warm-up. Node: raw ABI over the release WASM. Browser: real IndexedDB, Web Crypto and app.",
  node: process.version, platform: `${process.platform}/${process.arch}`, builtWasm: built,
  core: await nodeStages(),
};
const executable = argument("--browser");
if (executable) report.browser = await browserStages(executable);
const output = argument("--json");
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
