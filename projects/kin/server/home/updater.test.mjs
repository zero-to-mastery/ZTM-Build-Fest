// Safe updates (ADR 0025 §10, #722): the signed check, what installs by
// itself and when, the trial of a new release as the service, keeping it,
// and going back to the running version and its database when it fails.
// The network, the service, unpacking and the health check are stand-ins;
// the database, the backup and the files are real.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { holdFor } from "../../scripts/held-file.mjs";
import { makeReleaseKey } from "../../scripts/release-key.mjs";
import { signManifest } from "../../scripts/sign-release.mjs";
import { DurableStore } from "../durable-store.mjs";
import { PairingService } from "../pairing-service.mjs";
import { listBackups } from "./backups.mjs";
import { releasePublicKey } from "./release.mjs";
import { HomeUpdater, REQUEST_FILE, cannotInstall, isNight, readUpdateStatus, updatesDirectory, writeUpdateRequest } from "./updater.mjs";

const RELEASES = "https://releases.test/kin/releases";
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const NIGHT = new Date(2026, 10, 3, 2, 30).getTime();
const DAY = new Date(2026, 10, 3, 14, 0).getTime();
const households = (path) => {
  const store = new DurableStore(path, { acquireProcessLock: false });
  try { return new PairingService({ store }).countLiveHouseholds(); } finally { store.close(); }
};

/**
 * A home server installed as a service, with one household, on version
 * 1.6.0, and a release `version` signed with a fresh key. `serve` holds the
 * releases' files by URL.
 */
function installed(t, { version = "1.6.1", minimumVersion = "1.0.0", health = () => 0, trialMs = 40, executableBytes = Buffer.from("synthetic kin 1.7.0"), signWith = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kin-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const data = join(root, "data");
  const install = join(root, "install");
  const appCache = join(root, "cache");
  for (const folder of [data, install, appCache]) mkdirSync(folder, { recursive: true });
  const executable = join(install, "kin");
  writeFileSync(executable, "synthetic kin 1.6.0");
  const databasePath = join(data, "kin.sqlite");
  const store = new DurableStore(databasePath, { acquireProcessLock: false });
  new PairingService({ store }).bootstrap({ credential: credential("update-admin") });
  store.close();

  const { privatePem, publicBase64 } = makeReleaseKey();
  const file = { file: `kin-${version}-linux-x64`, size: executableBytes.length, sha256: createHash("sha256").update(executableBytes).digest("hex") };
  const manifest = Buffer.from(JSON.stringify({ format: 1, name: "kin-home", version, releasedAt: "2026-11-02T10:00:00.000Z", minimumVersion, files: { "linux-x64": file } }));
  const serve = new Map([
    [`${RELEASES}/latest/download/kin-home-manifest.json`, manifest],
    [`${RELEASES}/latest/download/kin-home-manifest.json.sig`, signManifest(manifest, signWith ?? privatePem)],
    [`${RELEASES}/download/kin-v${version}/${file.file}`, executableBytes],
  ]);
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const body = serve.get(url);
    return body ? new Response(body) : new Response("missing", { status: 404 });
  };

  // The service, as runService's controller drives it.
  const calls = [];
  let trialExit = null;
  const original = { command: executable, args: [], env: { DIR: "current" } };
  const controller = {
    canStop: true,
    serviceEnv: { KIN_MODE: "home" },
    spec: original,
    flagsFor: (appRoot) => ["--permission", `--allow-fs-read=${appRoot}`],
    pause: async () => { calls.push(["pause"]); },
    resume: (spec, { onExit = null } = {}) => { calls.push(["resume", spec]); trialExit = onExit; controller.spec = spec; return true; },
    endTrial: () => { calls.push(["endTrial"]); trialExit = null; },
    adopt: (spec) => { calls.push(["adopt", spec]); controller.spec = spec; },
  };
  const program = {
    kind: "sea", executable, appCache, appDirectory: join(appCache, "app-0000000000000000"),
    serviceProcessFor: ({ executable: command, appDirectory }) => ({ flags, env }) => ({ command, args: [], env: { ...env, DIR: appDirectory, FLAGS: flags.join(" ") } }),
  };
  let time = DAY;
  const updater = new HomeUpdater({
    dataDirectory: data, databasePath, version: "1.6.0", program, controller, env: { KIN_HOME_RELEASES: RELEASES },
    platform: "linux", target: "linux-x64", key: releasePublicKey(publicBase64), fetchImpl,
    health: async () => health(calls), now: () => time, log: () => {},
    prepare: async (staged, cacheRoot) => { const directory = join(cacheRoot, "app-1111111111111111"); mkdirSync(directory, { recursive: true }); return directory; },
    healthTimeoutMs: 100, trialMs, healthPollMs: 5,
  });
  updater.cannotInstall = cannotInstall({ program, platform: "linux", env: {}, target: "linux-x64" }) === "not-installed" ? null : updater.cannotInstall;
  return { root, data, install, appCache, executable, databasePath, updater, controller, calls, fetched, serve, original, exitTrial: (code) => trialExit?.(code), setTime: (value) => { time = value; } };
}

test("only Kin installed as a service replaces itself; any other copy points to the download", () => {
  const program = (executable) => ({ kind: "sea", executable, appCache: "/var/cache/kin", serviceProcessFor: () => {} });
  assert.equal(cannotInstall({ program: program("/usr/local/lib/kin/kin"), platform: "linux", target: "linux-x64" }), null);
  assert.equal(cannotInstall({ program: program("/home/fern/Downloads/kin-1.6.0-linux-x64"), platform: "linux", target: "linux-x64" }), "not-installed");
  assert.equal(cannotInstall({ program: program("C:\\Program Files\\Kin\\KIN.exe"), platform: "win32", env: {}, target: "win-x64" }), null, "Windows paths ignore case");
  assert.equal(cannotInstall({ program: program("/usr/local/lib/kin/kin"), platform: "linux", target: "linux-x64", canStop: false }), "not-installed", "it must be able to stop the service cleanly");
  assert.equal(cannotInstall({ program: { kind: "node", command: "node", args: [] }, platform: "linux", target: "linux-x64" }), "not-installed", "a checkout");
  assert.equal(cannotInstall({ program: program("/usr/local/lib/kin/kin"), platform: "linux", target: null }), "no-target");
  assert.equal(isNight(new Date(2026, 10, 3, 1, 59).getTime()), false);
  assert.equal(isNight(new Date(2026, 10, 3, 2, 0).getTime()), true);
  assert.equal(isNight(new Date(2026, 10, 3, 5, 0).getTime()), false);
});

test("without a release key nothing is fetched and the panel says updates are off", async (t) => {
  const context = installed(t);
  context.updater.key = null;
  context.updater.start();
  context.updater.stop();
  await context.updater.tick();
  assert.deepEqual(context.fetched, []);
  await context.updater.written;
  assert.equal(readUpdateStatus(context.data).state, "off");
});

test("a patch release installs at night: download, backup, trial, then it takes the installed one's place", async (t) => {
  const context = installed(t);
  await context.updater.check();
  const status = context.updater.status();
  assert.equal(status.state, "available");
  assert.deepEqual({ version: status.available.version, kind: status.available.kind, install: status.available.install }, { version: "1.6.1", kind: "patch", install: "automatic" });
  assert.equal(status.available.page, `${RELEASES}/tag/kin-v1.6.1`);
  await context.updater.tick();
  assert.ok(!context.calls.length, "not during the day");
  context.setTime(NIGHT);
  await context.updater.tick();
  await context.updater.installing;
  assert.equal(readFileSync(context.executable, "utf8"), "synthetic kin 1.7.0", "the new executable is in place");
  assert.equal(readFileSync(join(context.install, "kin.previous"), "utf8"), "synthetic kin 1.6.0", "the old one is kept");
  assert.deepEqual(readdirSync(context.install).sort(), ["kin", "kin.previous"], "no download left behind");
  // The service: stopped, tried from the new file and its own app folder,
  // then kept running and adopted from the installed path.
  assert.deepEqual(context.calls.map(([name]) => name), ["pause", "resume", "endTrial", "adopt"]);
  const trial = context.calls[1][1];
  assert.match(trial.command, /kin-1\.6\.1\.new$/);
  assert.match(trial.env.DIR, /update-1\.6\.1/);
  assert.match(trial.env.FLAGS, /--allow-fs-read=.*update-1\.6\.1/, "the sandbox reads the new release's app folder");
  assert.equal(context.calls[3][1].command, context.executable);
  // A backup with the database closed, before anything changed.
  const [set] = listBackups(join(context.data, "backups"));
  assert.equal(set.reason, "before-update");
  const after = context.updater.status();
  assert.equal(after.current, "1.6.1");
  assert.equal(after.available, null);
  assert.deepEqual({ from: after.lastUpdate.from, to: after.lastUpdate.to, outcome: after.lastUpdate.outcome }, { from: "1.6.0", to: "1.6.1", outcome: "updated" });
  await context.updater.written;
  assert.equal(readUpdateStatus(context.data).lastUpdate.outcome, "updated", "written for the panel");
});

test("a release that fails its trial is undone: the old version and its database come back, and it isn't tried again by itself", async (t) => {
  // Healthy only while the old version runs: the trial never answers.
  const context = installed(t, { health: (calls) => (calls.at(-1)?.[0] === "resume" && calls.at(-1)[1].command.endsWith(".new") ? 1 : 0) });
  await context.updater.check();
  // What the trial would have written: a second household.
  const realResume = context.controller.resume;
  context.controller.resume = (spec, options) => {
    if (spec.command.endsWith(".new")) {
      const store = new DurableStore(context.databasePath, { acquireProcessLock: false });
      const service = new PairingService({ store });
      service.householdPolicy = { allowNew: true, maxHouseholds: null };
      service.bootstrap({ credential: credential("during-trial") });
      store.close();
    }
    return realResume(spec, options);
  };
  assert.equal(households(context.databasePath), 1);
  context.setTime(NIGHT);
  assert.equal(await context.updater.install("automatic"), "rolled-back");
  assert.equal(readFileSync(context.executable, "utf8"), "synthetic kin 1.6.0", "the installed executable never changed");
  assert.deepEqual(readdirSync(context.install), ["kin"]);
  assert.equal(households(context.databasePath), 1, "the database from before the update");
  assert.ok(readdirSync(context.data).some((name) => name.startsWith("kin.sqlite.failed-update-")), "the trial's database is kept aside");
  assert.equal(context.calls.at(-1)[0], "resume");
  assert.equal(context.calls.at(-1)[1], context.original, "the version that was running starts again");
  assert.ok(!existsSync(join(context.appCache, "update-1.6.1")));
  const status = context.updater.status();
  assert.deepEqual({ outcome: status.lastUpdate.outcome, code: status.lastUpdate.code }, { outcome: "rolled-back", code: "update-unhealthy" });
  assert.equal(status.available.install, "admin", "an admin may still try it");
  context.calls.length = 0;
  await context.updater.tick();
  assert.deepEqual(context.calls, [], "not again by itself");
});

test("a release whose service exits during the trial is undone the same way", async (t) => {
  const context = installed(t, { trialMs: 5_000 });
  await context.updater.check();
  const done = context.updater.install("admin");
  for (let tries = 0; tries < 200 && !context.calls.some(([name, spec]) => name === "resume" && spec.command.endsWith(".new")); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  context.exitTrial(1);
  assert.equal(await done, "rolled-back");
  assert.equal(context.updater.status().lastUpdate.code, "update-exited");
  assert.equal(context.calls.at(-1)[1], context.original);
});

// Windows can hold a file in a trial folder for a moment after its service
// stops; the clean-ups retry until it lets go, whatever the Node version
// (#785).
test("a trial folder Windows still holds for a moment is removed once it lets go, after a failed trial", async (t) => {
  const context = installed(t, { health: (calls) => (calls.at(-1)?.[0] === "resume" && calls.at(-1)[1].command.endsWith(".new") ? 1 : 0) });
  await context.updater.check();
  const trialCache = join(context.appCache, "update-1.6.1");
  const held = join(trialCache, "app-1111111111111111", "kin.sqlite-wal");
  let released = null;
  const realResume = context.controller.resume;
  context.controller.resume = (spec, options) => {
    if (spec.command.endsWith(".new")) writeFileSync(held, "the trial's");
    return realResume(spec, options);
  };
  // The trial has stopped; the file is still held as the rollback starts.
  const realPause = context.controller.pause;
  context.controller.pause = async () => {
    if (existsSync(held) && !released) released = holdFor(held, 150);
    return realPause();
  };
  assert.equal(await context.updater.install("admin"), "rolled-back");
  assert.ok(released, "the file was held");
  await released;
  assert.ok(!existsSync(trialCache), "removed after the hold");
  assert.equal(context.calls.at(-1)[1], context.original, "the version that was running starts again");
});

test("a trial folder Windows still holds for a moment is removed once it lets go, after an install fails", async (t) => {
  const context = installed(t);
  await context.updater.check();
  let released = null;
  context.updater.prepare = async (staged, cacheRoot) => {
    const directory = join(cacheRoot, "app-1111111111111111");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "half-unpacked"), "");
    released = holdFor(join(directory, "half-unpacked"), 150);
    throw new Error("unpacking stopped");
  };
  assert.equal(await context.updater.install("admin"), "failed");
  await released;
  assert.ok(!existsSync(join(context.appCache, "update-1.6.1")));
  assert.deepEqual(readdirSync(context.install), ["kin"], "no download left behind");
});

test("an earlier update's leftovers are removed on start, even held for a moment, before an install uses the name", async (t) => {
  const context = installed(t);
  const leftover = join(context.appCache, "update-1.6.1", "app-0123456789abcdef");
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "server.mjs"), "an unfinished update's");
  writeFileSync(join(context.install, "kin-1.6.1.new"), "an unfinished download");
  const released = holdFor(join(leftover, "server.mjs"), 150);
  await context.updater.check();
  context.updater.start();
  context.updater.stop();
  // Straight away: the install waits for the clean-up of a folder it reuses.
  assert.equal(await context.updater.install("admin"), "updated");
  await released;
  assert.ok(!existsSync(leftover), "the leftover folder is gone");
  assert.ok(existsSync(join(context.appCache, "update-1.6.1", "app-1111111111111111")), "the new release's folder stays");
  assert.deepEqual(readdirSync(context.install).sort(), ["kin", "kin.previous"]);
});

test("a major release waits for an admin, who asks from the control panel", async (t) => {
  const context = installed(t, { version: "2.0.0" });
  await context.updater.check();
  assert.equal(context.updater.status().available.install, "admin");
  context.setTime(NIGHT);
  await context.updater.tick();
  assert.deepEqual(context.calls, [], "not by itself, even at night");
  await writeUpdateRequest(context.data, { version: "2.0.0" });
  context.setTime(DAY);
  await context.updater.tick();
  await context.updater.installing;
  assert.ok(!existsSync(join(updatesDirectory(context.data), REQUEST_FILE)), "the request is used once");
  assert.equal(context.updater.status().lastUpdate.outcome, "updated");
  assert.equal(readFileSync(context.executable, "utf8"), "synthetic kin 1.7.0");
});

test("automatic updates can be turned off; a release older servers can't take is shown, not installed", async (t) => {
  const context = installed(t);
  mkdirSync(join(context.data, "home"), { recursive: true });
  writeFileSync(join(context.data, "home", "settings.json"), JSON.stringify({ format: 1, autoUpdate: false }));
  await context.updater.check();
  assert.equal(context.updater.status().available.install, "admin");
  assert.equal(context.updater.status().autoUpdate, false);
  context.setTime(NIGHT);
  await context.updater.tick();
  assert.deepEqual(context.calls, []);
  const old = installed(t, { minimumVersion: "1.6.1" });
  await old.updater.check();
  assert.equal(old.updater.status().available.blocked, "too-old");
  assert.equal(old.updater.status().available.install, "manual");
  assert.equal(await old.updater.install("admin"), "failed");
  assert.equal(old.updater.status().lastUpdate.code, "update-too-old");
});

test("a wrong signature or a download that doesn't match changes nothing", async (t) => {
  const forged = installed(t, { signWith: makeReleaseKey().privatePem });
  await forged.updater.check();
  assert.equal(forged.updater.status().state, "failed");
  assert.equal(forged.updater.status().lastError.code, "update-signature");
  assert.equal(forged.updater.status().available, null);
  assert.ok(!forged.fetched.some((url) => url.includes("/download/kin-v")), "nothing downloaded");

  const tampered = installed(t);
  await tampered.updater.check();
  tampered.serve.set(`${RELEASES}/download/kin-v1.6.1/kin-1.6.1-linux-x64`, Buffer.from("synthetic kin 1.7.1"));
  assert.equal(await tampered.updater.install("admin"), "failed");
  assert.equal(tampered.updater.status().lastUpdate.code, "update-checksum");
  assert.deepEqual(tampered.calls, [], "the service was never stopped");
  assert.deepEqual(readdirSync(tampered.install), ["kin"]);
  assert.equal(readFileSync(tampered.executable, "utf8"), "synthetic kin 1.6.0");
});

test("a copy that can't replace itself still shows the update, with where to get it", async (t) => {
  const context = installed(t);
  context.updater.cannotInstall = "not-installed";
  await context.updater.check();
  const status = context.updater.status();
  assert.equal(status.available.install, "manual");
  assert.equal(status.cannotInstall, "not-installed");
  context.setTime(NIGHT);
  await context.updater.tick();
  assert.deepEqual(context.calls, []);
});

test("unpacking a release: the app folder it prints must be inside its own cache", async (t) => {
  const { spawn } = await import("node:child_process");
  const { prepareRelease } = await import("./updater.mjs");
  const root = mkdtempSync(join(tmpdir(), "kin-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A stand-in for `kin --prepare --app-cache DIR`: makes DIR/app-… (or
  // somewhere else) and prints it, as scripts/sea/main.cjs does.
  const release = (where) => (executable, args, options) => spawn(process.execPath, ["-e", `
    const { mkdirSync } = require("node:fs"); const { join } = require("node:path");
    const cache = process.argv[process.argv.indexOf("--app-cache") + 1];
    const target = ${JSON.stringify(where)} === "inside" ? join(cache, "app-2222222222222222") : join(cache, "..", "elsewhere");
    mkdirSync(target, { recursive: true }); console.log(target);`, "--", ...args], options);
  const cache = join(root, "update-1.6.1");
  const directory = await prepareRelease("kin-1.6.1.new", cache, { spawnImpl: release("inside"), env: {} });
  assert.match(directory, /update-1\.6\.1[\\/]app-2222222222222222$/);
  await assert.rejects(prepareRelease("kin-1.6.1.new", join(root, "update-1.6.2"), { spawnImpl: release("outside"), env: {} }), { code: "update-prepare" });
});
