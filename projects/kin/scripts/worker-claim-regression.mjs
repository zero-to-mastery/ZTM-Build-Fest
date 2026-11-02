// A page that loads while Kin's service worker is still installing must come
// under that worker once it activates (#770).
//
// The worker claims open pages when it activates. A page whose navigation
// left for the network before then, but committed after the claim, missed it:
// it stayed uncontrolled until its next load, so a lock and an offline unlock
// on it could not fetch the engine. In the household drill that page was a
// joining device's first reload, sent while its first install was still
// staging the shell. Here the server holds one shell file (keeping the
// install open) and the reloaded page's document (until the worker has
// activated), so the page always misses the claim; the check is that it is
// controlled anyway.
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, createLoadTrace, printLoadTrace, waitForKinStart } from "./cdp-page.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// How long each step may take: the worker's install and activation, and the
// page coming under it afterwards.
const STEP_TIMEOUT_MS = 20_000;
// A shell file only the worker's install fetches (the page never loads it).
const INSTALL_ONLY_FILE = "/privacy.html";

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function within(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), STEP_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

// A static server for web/ that can hold the next request for a path until
// the test releases it.
function staticServer(webRoot) {
  const holds = new Map();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const hold = holds.get(pathname);
    if (hold) {
      holds.delete(pathname);
      hold.arrived();
      await hold.released;
    }
    if (pathname === "/api/status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ identity: null, claim: null }));
      return;
    }
    const path = resolve(webRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(webRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      response.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const hold = (pathname) => {
    let release;
    const entry = { released: new Promise((resolveRelease) => { release = resolveRelease; }) };
    const arrived = new Promise((resolveArrival) => { entry.arrived = resolveArrival; });
    holds.set(pathname, entry);
    return { arrived, release };
  };
  return { server, hold };
}

export async function workerClaimRegression(executable) {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const { server, hold } = staticServer(webRoot);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), "kin-worker-claim-"));
  const browser = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--edge-skip-compat-layer-relaunch",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], BROWSER_STDIO);
  const loadTrace = createLoadTrace();
  const releases = [];
  let socket;
  try {
    const port = await waitForDevTools(browser, profile);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      socket.onopen = resolveOpen;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    const activations = [];
    let activated = () => {};
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method) loadTrace.observe(message);
      if (message.method === "ServiceWorker.workerVersionUpdated") {
        for (const version of message.params.versions) {
          if (version.scriptURL.startsWith(`${origin}/service-worker.js`) && version.status === "activated") {
            activations.push(version.versionId);
            activated();
          }
        }
      }
      if (message.id && pending.has(message.id)) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
      }
    };
    const send = (method, params) => new Promise((resolveSend, reject) => {
      const next = ++id;
      pending.set(next, { resolve: resolveSend, reject });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    for (const domain of ["Runtime", "Network"]) await send(`${domain}.enable`);
    await send("ServiceWorker.enable");
    await applyRegressionDefaults(send);

    // The first load registers the worker; its install waits on one file.
    const install = hold(INSTALL_ONLY_FILE);
    releases.push(install.release);
    await send("Page.navigate", { url: origin });
    await waitForKinStart(evaluate, origin);
    await within(install.arrived, "the worker's install to fetch the shell");

    // The page loads again while the worker installs. Its document request
    // reaches the server (there is no active worker to answer it) and waits
    // there until the worker has activated and claimed the open pages.
    const reload = hold("/");
    releases.push(reload.release);
    const navigated = send("Page.navigate", { url: origin });
    await within(reload.arrived, "the second load's document request");
    const activation = new Promise((resolveActivation) => { activated = resolveActivation; });
    install.release();
    await within(activation, "the worker to activate");
    reload.release();
    await within(navigated, "the second load to commit");
    await waitForKinStart(evaluate, origin);

    // The second page committed after the claim. It must still come under
    // the worker, or an offline start on it has no engine to load.
    const page = await evaluate(`(async () => {
      const container = navigator.serviceWorker;
      if (!container.controller) {
        await new Promise((resolveChange) => {
          const timer = setTimeout(resolveChange, ${STEP_TIMEOUT_MS});
          container.addEventListener("controllerchange", () => { clearTimeout(timer); resolveChange(); }, { once: true });
        });
      }
      const registration = await container.getRegistration();
      return { controlled: Boolean(container.controller), active: registration?.active?.state ?? null };
    })()`);
    assert.equal(activations.length > 0, true, "the worker activated");
    assert.deepEqual(page, { controlled: true, active: "activated" },
      "a page that loaded while the worker installed comes under it once it activates: " + JSON.stringify(page));
    console.log("PASS a page that loaded while the service worker installed comes under it (#770)");
  } catch (error) {
    printLoadTrace(loadTrace);
    throw error;
  } finally {
    for (const release of releases) release();
    if (socket) {
      const closed = new Promise((resolveClose) => socket.addEventListener("close", resolveClose, { once: true }));
      socket.close();
      await Promise.race([closed, delay(1_000)]);
    }
    if (process.platform === "win32" && browser.pid) {
      const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
        "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe' OR Name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
      const [code] = await once(killer, "exit");
      if (code !== 0) console.warn(`Could not terminate browser processes for the test profile (PowerShell ${code}).`);
    } else browser.kill();
    if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(2_000)]);
    browser.unref();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((error) => {
      if (error.code !== "EBUSY") throw error;
      console.warn("Temporary profile remained busy; the OS may remove it later.");
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/worker-claim-regression.mjs <browser executable>");
  await workerClaimRegression(executable);
  process.exit(0);
}
