// Real browser IndexedDB + Web Crypto regressions; no third-party harness.
import assert from "node:assert/strict";
import { householdLifecycleChecks } from "./security-household-regression.mjs";
import { securityOperationChecks } from "./security-operation-regression.mjs";
import { rootRotationUiChecks } from "./root-rotation-ui-regression.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function securityUiRegressions(client) {
  // The synthetic recovery secret stays in this process only; never print it.
  const result = await client.evaluate(`(${browserUiChecks.toString()})()`);
  assert.ok(result.checks >= 25);
  console.log(`PASS ${result.checks} core security UI assertions`);
  const operations = await client.evaluate(`(${securityOperationChecks.toString()})(${JSON.stringify(result.recovery)})`);
  console.log(`PASS ${operations.checks} overlapping security operation assertions`);
  const lifecycle = await client.evaluate(`(${householdLifecycleChecks.toString()})(${JSON.stringify(result.recovery)})`);
  console.log(`PASS ${lifecycle.checks} household lifecycle cancellation assertions`);
  const rotation = await client.evaluate(`(${rootRotationUiChecks.toString()})(${JSON.stringify(result.recovery)})`);
  result.recovery = rotation.recovery;
  console.log(`PASS ${rotation.checks} root rotation UI assertions`);
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.evaluate("globalThis.__kinReloadSentinel = true");
  await client.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  try {
    await client.send("Page.reload", { ignoreCache: false });
    let ready = false;
    for (let attempt = 0; attempt < 400 && !ready; attempt++) {
      try {
        ready = await client.evaluate(
          "!globalThis.__kinReloadSentinel && Boolean(document.querySelector('kin-app')?.security?.manifest) && !document.querySelector('kin-app').starting",
        );
      } catch {
        /* Reload destroys the old execution context. */
      }
      if (!ready) await delay(25);
    }
    assert.ok(ready, "Offline application shell did not load");
    const offline = await client.evaluate(
      `(${offlineReloadChecks.toString()})(${JSON.stringify(result.recovery)})`,
    );
    console.log(
      `PASS ${result.checks + operations.checks + lifecycle.checks + rotation.checks + offline.checks} application lock, recovery, peer-tab and offline assertions`,
    );
    console.log(JSON.stringify({ ...result.timings, ...offline.timings }));
  } finally {
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
  process.exit(0);
}

async function offlineReloadChecks(recovery) {
  let checks = 0;
  const check = (ok, message) => {
    if (!ok) throw Error(message);
    checks++;
  };
  const app = document.querySelector("kin-app");
  check(!navigator.onLine, "browser is actually offline");
  check(
    app.state === null &&
      app.engine === null &&
      app.store === null &&
      app.vault === null,
    "offline reload starts without household/key capabilities",
  );
  check(
    app.main.hidden &&
      !document.body.textContent.includes("Synthetic protected"),
    "offline shell displays no household plaintext",
  );
  check(
    Boolean(navigator.serviceWorker.controller),
    "offline document is controlled by the static shell service worker",
  );
  check(
    Boolean(app.security.querySelector("#recovery-unlock")),
    "offline locked shell offers explicit recovery unlock",
  );
  const started = performance.now();
  await app.security.run(() => app.security.unlockRecovery(recovery));
  check(
    app.state?.items[0]?.text === "Synthetic protected household secret",
    "offline recovery decrypts and replays persisted household",
  );
  const elapsed = performance.now() - started;
  const oldEngine = app.engine;
  app.lockHousehold();
  let denied = false;
  try {
    oldEngine.applyEvents([], 1234, null, 20261003);
  } catch {
    denied = true;
  }
  check(
    denied &&
      app.state === null &&
      !document.body.textContent.includes("Synthetic protected"),
    "offline lock clears projection and revokes old engine",
  );
  return { checks, timings: { offlineUnlockAndReplayMs: elapsed } };
}

async function browserUiChecks() {
  let checks = 0;
  const check = (ok, message) => {
    if (!ok) throw Error(message);
    checks++;
  };
  const wait = async (condition) => {
    for (let i = 0; i < 400; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("UI wait timed out: " + document.body.innerText);
  };
  await wait(
    () =>
      document.querySelector("kin-app")?.security?.heading &&
      !document.querySelector("kin-app").starting,
  );
  const app = document.querySelector("kin-app");
  check(
    app.state === null &&
      app.engine === null &&
      app.store === null &&
      app.vault === null,
    "startup has no projection/engine/store/key",
  );
  check(app.main.hidden, "locked startup shell only");
  app.security.showSetup();
  let recovery = app.security.querySelector(".recovery-key").textContent;
  check(recovery.length === 64, "setup displays user-held recovery secret");
  const confirm = app.security.querySelector("#confirm-recovery");
  confirm.value = recovery;
  const started = performance.now();
  confirm.form.requestSubmit();
  await wait(() => Boolean(app.store) && !app.busy && !app.security.busy);
  const setupMs = performance.now() - started;
  check(
    app.security.phase === "unlocked" && app.state.items.length === 0,
    "setup verifies root and empty replay before unlock",
  );
  app.compose.input.value = "Synthetic protected household secret";
  app.compose.form.requestSubmit();
  await wait(() => !app.busy);
  check(
    app.state.items.length === 1 &&
      app.state.items[0].text === "Synthetic protected household secret",
    "unlocked household command works",
  );
  app.compose.input.value = "Unsaved private draft";
  app.compose.input.dispatchEvent(new Event("input"));
  check(
    sessionStorage.getItem("kin.compose.draft") === null,
    "draft is never persisted in plaintext",
  );
  const raw = await new Promise((resolve, reject) => {
    const q = indexedDB.open("kin");
    q.onsuccess = () => {
      const db = q.result;
      const tx = db.transaction("events");
      const r = tx.objectStore("events").getAll();
      tx.oncomplete = () => {
        db.close();
        resolve(r.result);
      };
      tx.onabort = () => reject(tx.error);
    };
    q.onerror = () => reject(q.error);
  });
  check(
    raw.length === 1 &&
      raw[0].protected_version === 1 &&
      !JSON.stringify(raw).includes("Synthetic") &&
      !Object.hasOwn(raw[0], "encoded_event"),
    "browser IDB has ciphertext only",
  );
  const oldStore = app.store;
  app.lockHousehold();
  check(
    app.state === null &&
      app.engine === null &&
      app.store === null &&
      app.vault === null,
    "lock drops projection and key capabilities",
  );
  check(
    !document.body.textContent.includes("Synthetic protected") &&
      !document.body.textContent.includes("Unsaved private"),
    "lock clears household and draft DOM",
  );
  let denied = false;
  try {
    await oldStore.loadEvents();
  } catch {
    denied = true;
  }
  check(denied, "old store capability rejected after lock");
  await app.security.run(() => app.security.unlockRecovery("f".repeat(64)));
  check(
    app.state === null &&
      app.store === null &&
      app.security.alert.textContent.includes("could not unlock"),
    "wrong recovery stays locked",
  );
  const unlockStart = performance.now();
  await app.security.run(() => app.security.unlockRecovery(recovery));
  check(
    app.state?.items.length === 1 && !app.busy,
    "recovery unlock replays saved ciphertext",
  );
  const unlockMs = performance.now() - unlockStart;
  const { exportHouseholdArchive } = await import("/security/archive.js");
  const archive = await exportHouseholdArchive({
    store: app.store,
    engine: app.engine,
    vault: app.vault,
  });
  check(
    archive instanceof Uint8Array && archive.length > 100,
    "encrypted archive export available",
  );
  const parsed = app.engine.decodeArchive(archive);
  check(
    !new TextDecoder().decode(parsed.ciphertext).includes("Synthetic"),
    "archive body preserves encryption",
  );
  const {
    deserializeProtectedValue,
    serializeProtectedValue,
    toBase64Url,
    LocalVault,
  } = await import("/security/local-vault.js");
  const header = deserializeProtectedValue(parsed.metadata);
  const recoveryVault = await LocalVault.unlock(header.manifest, recovery);
  const authenticatedMetadata = serializeProtectedValue({
    archiveVersion: 1,
    manifest: header.manifest,
  });
  const archiveEnvelope = {
    ...header.protection,
    ciphertext: toBase64Url(parsed.ciphertext),
  };
  const snapshot = await recoveryVault.openArchive(
    archiveEnvelope,
    authenticatedMetadata,
  );
  check(
    snapshot.events.length === 1,
    "archive recovery round trip preserves history",
  );
  const changed = authenticatedMetadata.slice();
  changed[changed.length - 2] ^= 1;
  denied = false;
  try {
    await recoveryVault.openArchive(archiveEnvelope, changed);
  } catch {
    denied = true;
  }
  check(denied, "archive metadata tampering rejected");
  recoveryVault.lock();
  await navigator.serviceWorker.ready;
  const keys = await caches.keys();
  const cache = await caches.open(
    keys.find((key) => key.startsWith("kin-static-")),
  );
  const requests = await cache.keys();
  check(
    requests.length > 15 &&
      requests.every(
        (request) =>
          !new URL(request.url).pathname.startsWith("/api/") &&
          !new URL(request.url).search,
      ),
    "offline cache contains static shell only",
  );
  // Destroy only these test-owned databases in the isolated temporary profile.
  // Restore into a separately created root to exercise actual portable recovery.
  const sourceRecovery = recovery;
  app.lockHousehold();
  for (const name of ["kin", "kin-crypto-keys"]) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(Error("Test archive restore database is still open"));
    });
  }
  await app.security.initialize();
  app.security.showSetup();
  recovery = app.security.querySelector(".recovery-key").textContent;
  const targetInput = app.security.querySelector("#confirm-recovery");
  targetInput.value = recovery;
  targetInput.form.requestSubmit();
  await wait(() => app.store && !app.security.busy && !app.busy);
  check(
    app.vault.vaultId !== header.manifest.vaultId &&
      app.state.items.length === 0,
    "restore target has an independently established empty protected household",
  );
  const { importHouseholdArchive } = await import("/security/archive.js");
  const corrupted = archive.slice();
  corrupted[corrupted.length - 1] ^= 1;
  denied = false;
  try {
    await importHouseholdArchive({
      bytes: corrupted,
      recoverySecret: sourceRecovery,
      engine: app.engine,
      vault: app.vault,
    });
  } catch {
    denied = true;
  }
  check(
    denied && (await app.store.loadEvents()).length === 0,
    "corrupt portable archive rejects before any target history mutation",
  );
  for (const stage of ["unlock", "decrypt"]) {
    const unlockBefore = LocalVault.unlock;
    const openBefore = LocalVault.prototype.openArchive;
    let releaseSource,
      sourceReady,
      sourceVault,
      openCalls = 0;
    const holdSource = new Promise((resolve) => (releaseSource = resolve));
    const reachedSource = new Promise((resolve) => (sourceReady = resolve));
    LocalVault.unlock = async (...args) => {
      const value = await unlockBefore.call(LocalVault, ...args);
      if (args[0].vaultId === header.manifest.vaultId) {
        sourceVault = value;
        if (stage === "unlock") {
          sourceReady();
          await holdSource;
        }
      }
      return value;
    };
    LocalVault.prototype.openArchive = async function (...args) {
      if (this.vaultId !== header.manifest.vaultId)
        return openBefore.apply(this, args);
      openCalls++;
      const plaintext = await openBefore.apply(this, args);
      if (stage === "decrypt") {
        sourceReady();
        await holdSource;
      }
      return plaintext;
    };
    try {
      const pendingImport = importHouseholdArchive({
        bytes: archive,
        recoverySecret: sourceRecovery,
        engine: app.engine,
        vault: app.vault,
      }).then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, error }),
      );
      await reachedSource;
      check(
        (await app.store.loadEvents()).length === 0,
        `archive ${stage} pending leaves target untouched`,
      );
      app.lockHousehold();
      releaseSource();
      const outcome = await pendingImport;
      check(
        !outcome.accepted && app.state === null && app.vault === null,
        `target lock cancels pending archive ${stage} without projection`,
      );
      check(
        sourceVault.locked && sourceVault.root === null,
        `cancelled archive ${stage} releases its source key capability`,
      );
      if (stage === "unlock")
        check(
          openCalls === 0,
          "target lock during source unlock prevents starting archive decryption",
        );
    } finally {
      releaseSource();
      LocalVault.unlock = unlockBefore;
      LocalVault.prototype.openArchive = openBefore;
      sourceVault?.lock();
    }
    await app.security.run(() => app.security.unlockRecovery(recovery));
    check(
      app.state?.items.length === 0 &&
        (await app.store.loadEvents()).length === 0,
      `cancelled archive ${stage} retains original recoverable empty target`,
    );
  }
  const imported = await importHouseholdArchive({
    bytes: archive,
    recoverySecret: sourceRecovery,
    engine: app.engine,
    vault: app.vault,
  });
  await app.initialize();
  check(
    imported.eventCount === 1 &&
      app.state.items[0].text === "Synthetic protected household secret",
    "encrypted portable archive imports and renders exact recovered history",
  );
  const restored = await app.store.loadEvents();
  check(
    Array.from(restored[0].encoded_event).join(",") ===
      Array.from(snapshot.events[0].encoded_event).join(","),
    "archive restoration preserves canonical source bytes",
  );
  denied = false;
  try {
    await importHouseholdArchive({
      bytes: archive,
      recoverySecret: sourceRecovery,
      engine: app.engine,
      vault: app.vault,
    });
  } catch {
    denied = true;
  }
  check(
    denied && (await app.store.loadEvents()).length === 1,
    "restore cannot silently overwrite an existing household",
  );

  // This is a second same-origin browsing context with its own module state.
  const peer = window.open(location.origin, "kin-security-peer");
  check(Boolean(peer), "peer tab can open");
  try {
    await wait(
      () =>
        peer.document.querySelector("kin-app")?.security?.manifest &&
        !peer.document.querySelector("kin-app").starting,
    );
    const peerApp = peer.document.querySelector("kin-app");
    check(
      peerApp.state === null &&
        peerApp.engine === null &&
        peerApp.vault === null,
      "second tab starts locked despite existing ciphertext",
    );
    await peerApp.security.run(() => peerApp.security.unlockRecovery(recovery));
    check(
      peerApp.state?.items.length === 1,
      "second tab independently unlocks same canonical history",
    );
    const peerStore = peerApp.store,
      peerEngine = peerApp.engine;
    const peerVault = peerApp.vault;
    const originalPeerOpen = peerVault.open.bind(peerVault);
    let releasePeerRead, reachedPeerRead;
    const peerReadGate = new Promise((resolve) => { releasePeerRead = resolve; });
    const peerReadStarted = new Promise((resolve) => { reachedPeerRead = resolve; });
    peerVault.open = async (...args) => {
      const value = await originalPeerOpen(...args);
      reachedPeerRead();
      await peerReadGate;
      return value;
    };
    const peerRead = peerStore.loadEvents().then(() => false, () => true);
    try {
      await peerReadStarted;
      app.lockHousehold();
      await wait(() => peerApp.state === null && peerApp.vault === null);
      await app.lockBarrier;
      check(await peerRead, "peer lock intent aborts a crypto-held read before the durable epoch write can deadlock");
      check(peerVault.locked, "peer lock disposes the key during a native read transaction");
    } finally { releasePeerRead(); peerVault.open = originalPeerOpen; }
    check(
      peerApp.store === null && peerApp.engine === null && peerApp.main.hidden,
      "lock broadcast revokes peer capabilities",
    );
    check(
      !peer.document.body.textContent.includes("Synthetic protected"),
      "peer lock removes plaintext DOM",
    );
    denied = false;
    try {
      await peerStore.loadEvents();
    } catch {
      denied = true;
    }
    check(denied, "peer stale storage capability rejected after lock");
    denied = false;
    try {
      peerEngine.applyEvents([], 1234, null, 20261003);
    } catch {
      denied = true;
    }
    check(denied, "peer stale engine cannot construct a projection after lock");
  } finally {
    peer?.close();
  }

  // Hold only the asynchronous crypto completion boundary to exercise a real
  // cancellation race; the production authentication/persistence path is used.
  const originalUnlock = LocalVault.unlock;
  let release, reached, pendingVault;
  const gate = new Promise((resolve) => (release = resolve));
  const obtained = new Promise((resolve) => (reached = resolve));
  LocalVault.unlock = async (...args) => {
    pendingVault = await originalUnlock.call(LocalVault, ...args);
    reached();
    await gate;
    return pendingVault;
  };
  try {
    const pending = app.security.run(() =>
      app.security.unlockRecovery(recovery),
    );
    await obtained;
    check(
      app.state === null && app.engine === null,
      "unlock does not project before crypto completion",
    );
    app.lockHousehold();
    release();
    await pending;
    check(
      app.state === null && app.engine === null && app.vault === null,
      "lock during pending unlock prevents late projection",
    );
    check(
      pendingVault.locked && pendingVault.root === null,
      "cancelled unlock discards the completed key capability",
    );
  } finally {
    release();
    LocalVault.unlock = originalUnlock;
    pendingVault?.lock();
  }

  // Capability detection is isolated from authenticator availability; this is
  // explicitly unsupported-PRF coverage, not a claim of physical PRF testing.
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "PublicKeyCredential",
  );
  try {
    Object.defineProperty(globalThis, "PublicKeyCredential", {
      configurable: true,
      value: undefined,
    });
    await app.security.run(() =>
      app.security.unlockPasskey({ id: "unavailable" }),
    );
    check(
      app.state === null &&
        app.security.alert.textContent.includes("recovery key"),
      "unsupported secure credential path stays locked with explicit recovery",
    );
    check(
      Boolean(app.security.querySelector("#recovery-unlock")),
      "unsupported PRF retains an accessible recovery control",
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "PublicKeyCredential", descriptor);
    else delete globalThis.PublicKeyCredential;
  }
  await app.security.run(() => app.security.unlockRecovery(recovery));
  check(
    app.state?.items.length === 1,
    "normal unlock still works after cancelled and unsupported paths: " + JSON.stringify({phase:app.security.phase,error:app.security.alert?.textContent,status:app.status?.textContent,items:app.state?.items.length}),
  );
  return {
    checks,
    recovery,
    timings: {
      emptySetupMs: setupMs,
      oneEventUnlockAndReplayMs: unlockMs,
      archiveBytes: archive.length,
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const executable = process.argv[2];
  assert.ok(
    executable,
    "Usage: node scripts/security-ui-regression.mjs <browser executable> ",
  );
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const profile = await mkdtemp(join(tmpdir(), "kin-security-ui-"));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/api/status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ identity: null, claim: null }));
      return;
    }
    const path = resolve(
      webRoot,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!path.startsWith(webRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
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
      response.end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--edge-skip-compat-layer-relaunch",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let socket;
  try {
    let port;
    for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
      try {
        port = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0];
      } catch {
        await delay(50);
      }
    }
    assert.ok(port, "Browser did not start");
    const target = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        message.error
          ? task.reject(Error(JSON.stringify(message.error)))
          : task.resolve(message.result);
      }
    };
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const next = ++id;
        pending.set(next, { resolve, reject });
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    const client = {
      send,
      evaluate: async (expression) => {
        const result = await send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        assert.equal(
          result.exceptionDetails,
          undefined,
          JSON.stringify(result.exceptionDetails),
        );
        return result.result.value;
      },
    };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await client.evaluate("location.origin === " + JSON.stringify(origin))
      )
        break;
      await delay(20);
    }
    await securityUiRegressions(client);
  } finally {
    if (socket) {
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
      socket.close();
      await Promise.race([closed, delay(1_000)]);
    }
    if (process.platform === "win32" && browser.pid) {
      const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
        "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
      const [code] = await once(killer, "exit");
      if (code !== 0) console.warn(`Could not terminate Edge processes for the isolated test profile (PowerShell ${code}).`);
    } else browser.kill();
    if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(2_000)]);
    browser.unref();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await delay(300);
    assert.ok(
      resolve(profile).startsWith(resolve(tmpdir()) + sep),
      "Refuse cleanup outside the test-profile directory",
    );
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    }).catch((error) => {
      if (error.code !== "EBUSY") throw error;
      console.warn("Temporary Edge profile remained busy; the OS may remove it later.");
    });
  }
}
