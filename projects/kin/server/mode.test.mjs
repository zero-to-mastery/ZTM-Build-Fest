// KIN_MODE (ADR 0025 §9, #713): hosted by default; home mode refuses the
// Google Play settings, limits new households to the owner's and keeps its
// data in the platform's system location.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { applyServerMode, HOME_MAX_HOUSEHOLDS, homeDataDirectory, serverMode } from "./mode.mjs";
import { HOUSEHOLD_CREATION_CLOSED, PairingError, PairingService } from "./pairing-service.mjs";
import { APP_ROOT, configuredDatabasePath } from "./permissions.mjs";
import { canonicalPath } from "./path-safety.mjs";
import { createKinServer } from "./server.mjs";

const FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const server = (options) => createKinServer({ store: new DurableStore(":memory:"), origin: "http://localhost", ...options });

test("KIN_MODE is hosted by default, home when asked, and nothing else", { timeout: 60_000 }, () => {
  assert.equal(serverMode(undefined), "hosted");
  assert.equal(serverMode(""), "hosted");
  assert.equal(serverMode(" hosted "), "hosted");
  assert.equal(serverMode("home"), "home");
  assert.equal(serverMode("HOME"), "home");
  for (const value of ["homeserver", "1", "self-hosted"])
    assert.throws(() => serverMode(value), (error) => error.code === "server_mode_invalid" && error.message.includes(value));
});

test("home mode refuses the Google Play settings; hosted mode keeps them", { timeout: 60_000 }, () => {
  for (const settings of [{ KIN_ANDROID_PACKAGE: "io.example.kin" }, { KIN_ANDROID_CERT_SHA256: FINGERPRINT }])
    assert.throws(() => applyServerMode("home", settings), (error) =>
      error.code === "home_mode_setting_refused" && error.message.includes(Object.keys(settings)[0]));
  assert.throws(() => applyServerMode("home", { KIN_ANDROID_PACKAGE: "io.example.kin", KIN_ANDROID_CERT_SHA256: FINGERPRINT }),
    /KIN_ANDROID_PACKAGE and KIN_ANDROID_CERT_SHA256 are/);
  assert.doesNotThrow(() => applyServerMode("home", { KIN_ANDROID_PACKAGE: " ", KIN_ANDROID_CERT_SHA256: "" }));
  assert.doesNotThrow(() => applyServerMode("hosted", { KIN_ANDROID_PACKAGE: "io.example.kin", KIN_ANDROID_CERT_SHA256: FINGERPRINT }));

  assert.throws(() => server({ mode: "home", androidPackage: "io.example.kin", androidCertSha256: FINGERPRINT }), { code: "home_mode_setting_refused" });
  const hosted = server({ mode: "hosted", androidPackage: "io.example.kin", androidCertSha256: FINGERPRINT });
  assert.equal(hosted.mode, "hosted");
  hosted.store.close();
});

test("home mode limits new households to one unless a limit is configured", { timeout: 60_000 }, () => {
  assert.equal(applyServerMode("home", {}).maxHouseholds, HOME_MAX_HOUSEHOLDS);
  assert.equal(applyServerMode("home", { KIN_MAX_HOUSEHOLDS: "3" }).maxHouseholds, "3");
  assert.equal(applyServerMode("home", { KIN_MAX_HOUSEHOLDS: 0 }).maxHouseholds, 0);
  assert.equal(applyServerMode("hosted", {}).maxHouseholds, undefined);

  const home = server({ mode: "home", service: new PairingService() });
  assert.equal(home.mode, "home");
  assert.deepEqual({ ...home.service.householdPolicy }, { allowNew: true, maxHouseholds: 1 });
  home.service.bootstrap({ credential: credential("owner") });
  assert.throws(() => home.service.bootstrap({ credential: credential("second") }), (error) =>
    error instanceof PairingError && error.code === "household_creation_closed" && error.message === HOUSEHOLD_CREATION_CLOSED);
  home.store.close();

  // The control panel (#718) will raise it; the setting does today.
  const raised = server({ mode: "home", maxHouseholds: "2", service: new PairingService() });
  raised.service.bootstrap({ credential: credential("owner") });
  raised.service.bootstrap({ credential: credential("grandparents") });
  assert.throws(() => raised.service.bootstrap({ credential: credential("third") }), { code: "household_creation_closed" });
  raised.store.close();

  // Closing creation still wins.
  const closed = server({ mode: "home", allowNewHouseholds: "false", service: new PairingService() });
  assert.throws(() => closed.service.bootstrap({ credential: credential("owner") }), { code: "household_creation_closed" });
  closed.store.close();

  const hosted = server({ service: new PairingService() });
  assert.equal(hosted.mode, "hosted");
  for (const name of ["a", "b", "c"]) hosted.service.bootstrap({ credential: credential(name) });
  hosted.store.close();
});

test("home mode keeps its data in the platform's system location unless KIN_DATA_DIR says otherwise", { timeout: 60_000 }, () => {
  assert.equal(homeDataDirectory("linux"), "/var/lib/kin");
  assert.equal(homeDataDirectory("darwin"), "/Library/Application Support/Kin");
  assert.equal(homeDataDirectory("win32", { ProgramData: "D:\\Data" }), "D:\\Data\\Kin");
  assert.equal(homeDataDirectory("win32", {}), "C:\\ProgramData\\Kin");

  const appData = canonicalPath(join(APP_ROOT, ".kin-data", "kin.sqlite"));
  assert.equal(configuredDatabasePath({}, {}), appData);
  assert.equal(configuredDatabasePath({}, { KIN_MODE: "hosted" }), appData);
  if (process.platform !== "win32") {
    const expected = canonicalPath(join(homeDataDirectory(process.platform), "kin.sqlite"));
    assert.equal(configuredDatabasePath({}, { KIN_MODE: "home" }), expected);
    assert.equal(configuredDatabasePath({ mode: "home" }, {}), expected);
  }
  const directory = canonicalPath(mkdtempSync(join(tmpdir(), "kin-mode-")));
  try {
    assert.equal(configuredDatabasePath({}, { KIN_MODE: "home", KIN_DATA_DIR: directory }), join(directory, "kin.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.throws(() => configuredDatabasePath({}, { KIN_MODE: "office" }), { code: "server_mode_invalid" });
});

function startService(t, env) {
  const directory = canonicalPath(mkdtempSync(join(tmpdir(), "kin-mode-start-")));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const child = spawn(process.execPath, [join(APP_ROOT, "server", "start.mjs")], {
    env: { ...process.env, KIN_DATA_DIR: join(directory, "data"), KIN_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Never leave a service behind: a running child would keep this test
  // file's process (and the whole gate) waiting.
  t.after(() => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", resolve);
    child.kill();
  }));
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  // "close" waits for the output to drain; if a grandchild kept the pipes
  // open after the launcher exited, give up waiting after five seconds.
  return new Promise((resolve) => {
    child.once("close", (code) => resolve({ code, output }));
    child.once("exit", (code) => setTimeout(() => resolve({ code, output }), 5_000).unref());
  });
}

test("the service refuses to start in home mode with a Google Play setting, or with an unknown mode", { timeout: 30_000 }, async (t) => {
  const refused = await startService(t, { KIN_MODE: "home", KIN_ANDROID_PACKAGE: "io.example.kin", KIN_ANDROID_CERT_SHA256: FINGERPRINT });
  assert.equal(refused.code, 1);
  const line = JSON.parse(refused.output.trim().split("\n").find((entry) => entry.includes("startup_failed")));
  assert.equal(line.outcome, "home_mode_setting_refused");
  assert.match(line.message, /home mode/);

  const unknown = await startService(t, { KIN_MODE: "office" });
  assert.equal(unknown.code, 1);
  const failure = JSON.parse(unknown.output.trim().split("\n").find((entry) => entry.includes("startup_failed")));
  assert.equal(failure.outcome, "server_mode_invalid");
  assert.match(failure.message, /KIN_MODE must be "hosted" or "home"/);
});
