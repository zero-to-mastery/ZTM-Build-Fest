// Real WebAuthn through a virtual authenticator and the production Kin server.
// https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/WebAuthn.pdl
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

export async function passkeyRegressions(client) {
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    },
  );
  try {
    const setup = await client.evaluate(`(${setupPasskey.toString()})()`);
    const credentials = await client.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    assert.equal(credentials.credentials.length, 1);
    let checks = setup.checks + 1;
    if (setup.prfSupported) {
      checks += await client.evaluate(`(${unlockPasskey.toString()})(true)`);
      await client.send("WebAuthn.setResponseOverrideBits", {
        authenticatorId,
        isBadUV: true,
      });
      checks += await client.evaluate(`(${unlockPasskey.toString()})(false)`);
      await client.send("WebAuthn.setResponseOverrideBits", {
        authenticatorId,
        isBogusSignature: true,
      });
      checks += await client.evaluate(`(${unlockPasskey.toString()})(false)`);
      await client.send("WebAuthn.setResponseOverrideBits", {
        authenticatorId,
      });
      checks += await client.evaluate(`(${cancelPasskey.toString()})()`);
      checks += await client.evaluate(`(${unlockPasskey.toString()})(true)`);
    }
    checks += await client.evaluate(
      `(${recoverPasskey.toString()})(${JSON.stringify(setup.recovery)})`,
    );
    console.log(
      `PASS ${checks} virtual-authenticator assertions; PRF ${setup.prfSupported ? "supported and exercised" : "unavailable; explicit recovery exercised"}`,
    );
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId,
    });
    await client.send("WebAuthn.disable");
  }
}

async function setupPasskey() {
  let checks = 0;
  const check = (value, message) => {
    if (!value) throw Error(message);
    checks++;
  };
  const wait = async (condition) => {
    for (let i = 0; i < 400; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("Passkey setup timed out");
  };
  await wait(
    () =>
      document.querySelector("kin-app")?.security?.heading &&
      !document.querySelector("kin-app").starting,
  );
  const app = document.querySelector("kin-app");
  check(app.state === null && app.vault === null, "setup starts locked");
  app.security.showSetup();
  const recovery = app.security.querySelector(".recovery-key").textContent;
  const input = app.security.querySelector("#confirm-recovery");
  input.value = recovery;
  input.form.requestSubmit();
  await wait(() => app.store && !app.security.busy && !app.busy);
  app.compose.input.value = "Virtual passkey protected content";
  app.compose.form.requestSubmit();
  await wait(() => !app.busy);
  check(
    app.state.items.length === 1,
    "recovery-protected history exists before credential enrollment",
  );
  const persistedEvents = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open("kin");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("events");
        const rows = transaction.objectStore("events").getAll();
        transaction.oncomplete = () => {
          database.close();
          resolve(JSON.stringify(rows.result));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });
  const ciphertextBefore = await persistedEvents();
  await app.household.register("bootstrap", {
    deviceLabel: "Synthetic virtual authenticator",
  });
  check(
    Boolean(app.household.identity),
    "WebAuthn registration verified by Kin: " + app.household.textContent,
  );
  await app.security.run(() => app.security.addPasskey());
  check(
    (await persistedEvents()) === ciphertextBefore,
    "credential enrollment does not re-encrypt the canonical corpus",
  );
  const wrapper = app.security.manifest.wrappers.find(
    (value) => value.type === "prf",
  );
  if (!wrapper) {
    check(
      app.security.alert.textContent.includes("does not support secure PRF"),
      "unsupported PRF must be explicit: " + app.security.alert.textContent,
    );
    app.lockHousehold();
    check(
      app.vault === null && app.state === null,
      "login cookie alone cannot unlock local data",
    );
    return { checks, recovery, prfSupported: false };
  }
  check(
    wrapper.sealed && wrapper.credentialId && wrapper.prfSalt,
    "enrollment persists credential-associated root wrapper",
  );
  check(
    (await app.store.snapshotForArchive()).events.length === 1,
    "credential addition preserves corpus",
  );
  app.lockHousehold();
  check(
    app.vault === null &&
      app.state === null &&
      !document.body.textContent.includes("Virtual passkey protected content"),
    "registered logged-in credential still requires local unlock",
  );
  return { checks, recovery, prfSupported: true };
}

async function unlockPasskey(success) {
  const app = document.querySelector("kin-app");
  const wrapper = app.security.manifest.wrappers.find(
    (value) => value.type === "prf",
  );
  await app.security.run(() => app.security.unlockPasskey(wrapper));
  if (success) {
    if (app.state?.items[0]?.text !== "Virtual passkey protected content")
      throw Error(
        "PRF assertion failed to unlock: " + app.security.alert.textContent,
      );
    if (!app.vault || app.security.phase !== "unlocked")
      throw Error("PRF unlock lacks key capability");
    app.lockHousehold();
    return 2;
  }
  if (app.state !== null || app.vault !== null || app.engine !== null)
    throw Error("Bad UV/signature exposed household");
  if (!app.security.alert.textContent)
    throw Error("Rejected assertion has no feedback");
  return 2;
}

async function cancelPasskey() {
  const app = document.querySelector("kin-app");
  const wrapper = app.security.manifest.wrappers.find(
    (value) => value.type === "prf",
  );
  const originalGet = navigator.credentials.get.bind(navigator.credentials);
  navigator.credentials.get = (options) => {
    const controller = new AbortController();
    controller.abort();
    return originalGet({ ...options, signal: controller.signal });
  };
  try {
    await app.security.run(() => app.security.unlockPasskey(wrapper));
  } finally {
    delete navigator.credentials.get;
  }
  if (
    app.state !== null ||
    app.vault !== null ||
    !app.security.alert.textContent.includes("cancelled")
  )
    throw Error("Cancelled assertion escaped locked recovery state");
  return 1;
}

async function recoverPasskey(recovery) {
  const app = document.querySelector("kin-app");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  if (app.state?.items[0]?.text !== "Virtual passkey protected content")
    throw Error("Independent recovery path was lost");
  app.lockHousehold();
  return 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const executable = process.argv[2];
  assert.ok(
    executable,
    "Usage: node scripts/passkey-regression.mjs <browser executable> ",
  );
  const profile = await mkdtemp(join(tmpdir(), "kin-passkey-"));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const applicationPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://localhost:${applicationPort}`;
  const { server, store } = createKinServer({
    port: applicationPort,
    host: "127.0.0.1",
    origin,
    store: new DurableStore(":memory:"),
  });
  await new Promise((resolve) =>
    server.listen(applicationPort, "127.0.0.1", resolve),
  );
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
    await passkeyRegressions(client);
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
    try {
      await new Promise((resolve) => server.close(resolve));
    } finally {
      store.close();
    }
    await delay(300);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
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
  process.exit(0);
}
