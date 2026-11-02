// Safe updates for the home server (ADR 0025 §10, #722). The launcher runs
// this, outside the sandbox: it is the only part of Kin that may start
// processes and write outside the data directory.
//
// Each day it fetches the signed release manifest (release.mjs) and checks
// it with the built-in release key. A newer patch or minor release installs
// itself at night (02:00 to 05:00 local time) unless the home settings say
// `autoUpdate: false`; a major release, and any release when an admin asks
// in the control panel, installs on request. Installing:
//
//   1. download this computer's file beside the executable and check its
//      size and SHA-256 against the signed manifest;
//   2. unpack its app into a cache folder of its own (`update-<version>/`),
//      so the running version's files stay untouched;
//   3. stop the service and make a backup set (backups.mjs, reason
//      "before-update") with the database closed;
//   4. try the new release as the service, in the sandbox, from its own
//      folder: /health must answer within 60 seconds and the service must
//      stay up for 5 minutes;
//   5. then keep it: the current executable becomes `kin.previous`, the new
//      one takes its place, and the launcher goes on running the new service.
//      If the trial fails: stop it, put the backup's database back (a newer
//      server schema can't be read by an older server), and start the
//      version that was running. That version isn't tried again by itself.
//
// Trying the new release from the old, known-good launcher, rather than
// swapping first and restarting, means a release that can't even start
// leaves a running Kin and nothing for the service manager to restart into.
// Events that reached the server during a failed trial are still on the
// devices that sent them, which send them again (THREAT-MODEL).
//
// Only Kin installed as a service (`kin --install-service`) updates itself:
// it runs from its install folder, which its account may write. Any other
// copy (one run by hand, a checkout, the container image) shows that an
// update is available and where to get it.
//
// The control panel and the launcher share two files in
// `<data directory>/updates/`: `status.json`, which only the launcher writes
// and the panel shows, and `request.json`, which the panel writes when an
// admin asks to install and the launcher reads within a minute.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { writePrivateFile } from "../acme/keys.mjs";
import { DurableStore, acquireDatabaseProcessLock } from "../durable-store.mjs";
import { serviceLayout } from "../service-install.mjs";
import { BackupError, makeBackupSet } from "./backups.mjs";
import { DEFAULT_RELEASES, ReleaseError, offer, releasePublicKey, releaseTarget, releaseUrls, verifyManifest, MAX_MANIFEST_BYTES } from "./release.mjs";

export const UPDATES_DIRECTORY = "updates";
export const STATUS_FILE = "status.json";
export const REQUEST_FILE = "request.json";
export const UPDATE_FORMAT = 1;
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const FIRST_CHECK_MS = 5 * 60_000;
export const POLL_MS = 60_000;
export const NIGHT_FROM_HOUR = 2;
export const NIGHT_UNTIL_HOUR = 5;
export const HEALTH_TIMEOUT_MS = 60_000;
export const TRIAL_MS = 5 * 60_000;
const HEALTH_POLL_MS = 1_000;
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const PREPARE_TIMEOUT_MS = 5 * 60_000;
/** Every code an update reports (web/control/explain.js has words for each). */
export const UPDATE_ERROR_CODES = Object.freeze([
  "update-network", "update-signature", "update-manifest", "update-no-file", "update-too-old", "update-download",
  "update-checksum", "update-prepare", "update-backup", "update-unhealthy", "update-exited", "update-swap", "update-failed",
]);
export const UPDATE_STATES = Object.freeze(["off", "not-checked", "up-to-date", "available", "installing", "failed"]);

export const updatesDirectory = (dataDirectory) => join(dataDirectory, UPDATES_DIRECTORY);

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

/** What the launcher last wrote, for the control panel, or null. */
export function readUpdateStatus(dataDirectory) {
  const status = readJson(join(updatesDirectory(dataDirectory), STATUS_FILE));
  return status?.format === UPDATE_FORMAT ? status : null;
}

/** The control panel's request to install `version` (an admin asked). */
export async function writeUpdateRequest(dataDirectory, { version, now = Date.now }) {
  mkdirSync(updatesDirectory(dataDirectory), { recursive: true, mode: 0o700 });
  await writePrivateFile(join(updatesDirectory(dataDirectory), REQUEST_FILE), `${JSON.stringify({ format: UPDATE_FORMAT, action: "install", version, requestedAt: new Date(now()).toISOString() })}\n`);
}

/** True between 02:00 and 05:00 on this computer's clock. */
export function isNight(now) {
  const hour = new Date(now).getHours();
  return hour >= NIGHT_FROM_HOUR && hour < NIGHT_UNTIL_HOUR;
}

/**
 * Why this copy of Kin can't replace itself, or null when it can: it must
 * be the single executable installed as a service, in its install folder,
 * and the launcher must be able to stop the service cleanly.
 */
export function cannotInstall({ program, platform = process.platform, env = process.env, canStop = true, target = releaseTarget() }) {
  if (program?.kind !== "sea" || !program.serviceProcessFor || !program.appCache) return "not-installed";
  if (!target) return "no-target";
  let layout;
  try { layout = serviceLayout(platform, env); } catch { return "not-installed"; }
  const same = platform === "win32" ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  if (!same(program.executable, layout.executable)) return "not-installed";
  if (!canStop) return "not-installed";
  return null;
}

/** Downloads `url` to `path` and checks it against the signed `file`
 * ({ size, sha256 }); the file appears only once it matches. */
export async function download(url, path, file, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const partial = `${path}.${randomBytes(4).toString("hex")}.download`;
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new UpdateError("update-network", "Kin couldn't download the update.");
  }
  if (!response.ok || !response.body) throw new UpdateError("update-download", "The update's download wasn't there.");
  const hash = createHash("sha256");
  let size = 0;
  const descriptor = openSync(partial, "wx", 0o700);
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > file.size) throw new UpdateError("update-checksum", "The update's download is larger than its release says.");
      hash.update(chunk);
      writeSync(descriptor, chunk);
    }
    closeSync(descriptor);
    if (size !== file.size || hash.digest("hex") !== file.sha256) throw new UpdateError("update-checksum", "The update's download doesn't match its release.");
    if (process.platform !== "win32") chmodSync(partial, 0o755);
    renameSync(partial, path);
  } catch (error) {
    try { closeSync(descriptor); } catch { /* closed */ }
    rmSync(partial, { force: true });
    if (error instanceof UpdateError) throw error;
    throw new UpdateError("update-download", "Kin couldn't download the update.");
  }
}

/** Unpacks `executable`'s app into `cacheRoot` (`kin --prepare`) and returns
 * the app folder it printed, which must be inside `cacheRoot`. */
export function prepareRelease(executable, cacheRoot, { spawnImpl = spawn, env = process.env, timeoutMs = PREPARE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new UpdateError("update-prepare", "The update couldn't unpack its app."));
    let child;
    try {
      const childEnv = { ...env, KIN_APP_CACHE: cacheRoot };
      delete childEnv.KIN_SEA_ROLE;
      delete childEnv.KIN_SEA_APP_DIR;
      child = spawnImpl(executable, ["--prepare", "--app-cache", cacheRoot], { stdio: ["ignore", "pipe", "ignore"], env: childEnv, windowsHide: true });
    } catch { failed(); return; }
    let output = "";
    const timer = setTimeout(() => child.kill?.(), timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); failed(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const printed = output.trim().split(/\r?\n/).at(-1) ?? "";
      if (code !== 0 || !printed) { failed(); return; }
      let directory;
      let inside;
      try {
        directory = realpathSync(printed);
        inside = relative(realpathSync(cacheRoot), directory);
      } catch { failed(); return; }
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) { failed(); return; }
      resolve(directory);
    });
  });
}

/** Puts `backupDatabase` in place of the database, with the service
 * stopped (its lock is taken here); the failed update's database and WAL
 * are kept beside it as `<database>.failed-update-<time>`. */
export function replaceDatabase(backupDatabase, databasePath, { now = Date.now } = {}) {
  const release = acquireDatabaseProcessLock(databasePath, { operation: "update-rollback" });
  try {
    const aside = `${databasePath}.failed-update-${now()}`;
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${databasePath}${suffix}`)) renameSync(`${databasePath}${suffix}`, `${aside}${suffix}`);
    const temporary = `${databasePath}.${randomBytes(4).toString("hex")}.rollback`;
    copyFileSync(backupDatabase, temporary);
    renameSync(temporary, databasePath);
    return aside;
  } finally {
    release();
  }
}

/**
 * The launcher's updater for one running home server. `controller` is
 * runService's handle on the service (server/launcher.mjs): pause(),
 * resume(spec, { onExit }), adopt(spec), flagsFor(appRoot), serviceEnv,
 * canStop and spec.
 */
// Removes a trial app folder. The service that just ran from it, or an
// antivirus scan, can hold its files on Windows for a moment, so this
// retries. rmSync's retries can't be relied on: some Node 24 releases stop
// at the first EPERM (#785).
const removeFolder = (folder) => rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

export class HomeUpdater {
  constructor({
    dataDirectory, databasePath, version, program, controller,
    env = process.env, platform = process.platform, target = releaseTarget(),
    key = releasePublicKey(), releases = env.KIN_HOME_RELEASES || DEFAULT_RELEASES,
    fetchImpl = fetch, spawnImpl = spawn, health, now = Date.now, log = () => {},
    prepare = (executable, cacheRoot) => prepareRelease(executable, cacheRoot, { spawnImpl, env }),
    healthTimeoutMs = HEALTH_TIMEOUT_MS, trialMs = TRIAL_MS, healthPollMs = HEALTH_POLL_MS,
  }) {
    Object.assign(this, { dataDirectory, databasePath, version, program, controller, env, platform, target, key, fetchImpl, health, now, log, prepare, healthTimeoutMs, trialMs, healthPollMs });
    this.urls = releaseUrls(releases);
    this.directory = updatesDirectory(dataDirectory);
    this.cannotInstall = cannotInstall({ program, platform, env, canStop: controller?.canStop !== false, target });
    const previous = readUpdateStatus(dataDirectory);
    this.state = {
      checkedAt: null, available: null, lastError: null,
      lastUpdate: previous?.lastUpdate ?? null,
      failedVersion: previous?.failedVersion ?? null,
    };
    this.manifest = null;
    this.installing = null;
    // Settles once start()'s clean-up of an earlier update is done.
    this.cleaned = Promise.resolve();
    this.timers = [];
    // Settles once the last status written is on disk (see #write).
    this.written = Promise.resolve();
  }

  /** Starts the daily check and the minute's look at requests. */
  start() {
    this.cleaned = this.#cleanUp();
    this.#write(this.key ? "not-checked" : "off");
    if (!this.key || this.timers.length) return;
    const first = setTimeout(() => this.tick().catch(() => {}), FIRST_CHECK_MS);
    const every = setInterval(() => this.tick().catch(() => {}), POLL_MS);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  stop() {
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
  }

  /** One look: an admin's request, the daily check, a night-time install. */
  async tick() {
    if (!this.key || this.installing) return;
    const request = readJson(join(this.directory, REQUEST_FILE));
    if (request) {
      rmSync(join(this.directory, REQUEST_FILE), { force: true });
      if (request.format === UPDATE_FORMAT && request.action === "install" && typeof request.version === "string") {
        await this.check();
        if (this.state.available?.version === request.version) await this.install("admin");
        return;
      }
    }
    if (!this.state.checkedAt || this.now() - Date.parse(this.state.checkedAt) >= CHECK_INTERVAL_MS) await this.check();
    const available = this.state.available;
    if (available && this.#automatic(available) && isNight(this.now())) await this.install("automatic");
  }

  #automatic(available) {
    return available.kind !== "major" && !available.blocked && available.file && !this.cannotInstall && available.version !== this.state.failedVersion && this.#autoUpdate();
  }

  #autoUpdate() {
    try { return readJson(join(this.dataDirectory, "home", "settings.json"))?.autoUpdate !== false; } catch { return true; }
  }

  async #fetchBytes(url) {
    let response;
    try {
      response = await this.fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new UpdateError("update-network", "Kin couldn't reach the releases.");
    }
    if (!response.ok) throw new UpdateError("update-network", "Kin couldn't reach the releases.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MANIFEST_BYTES) throw new UpdateError("update-manifest", "The release's manifest is too large.");
    return bytes;
  }

  /** Fetches and verifies the manifest; records what it offers. */
  async check() {
    try {
      const [bytes, signature] = await Promise.all([this.#fetchBytes(this.urls.manifest), this.#fetchBytes(this.urls.signature)]);
      let manifest;
      try { manifest = verifyManifest(bytes, signature, this.key); } catch (error) {
        throw new UpdateError(error instanceof ReleaseError && error.code === "release-signature" ? "update-signature" : "update-manifest", error.message);
      }
      this.manifest = manifest;
      const offered = offer(manifest, { current: this.version, target: this.target });
      this.state.available = offered ? {
        version: offered.version, kind: offered.kind, releasedAt: offered.releasedAt, page: this.urls.page(offered.version),
        blocked: offered.blocked ?? (offered.file ? null : "no-file"), file: offered.file,
      } : null;
      this.state.lastError = null;
      this.state.checkedAt = new Date(this.now()).toISOString();
      this.log({ event: "home_update_checked", available: offered?.version ?? null });
    } catch (error) {
      this.state.lastError = { code: error.code ?? "update-failed", at: new Date(this.now()).toISOString() };
      // A failed check is tried again in an hour, not a day.
      this.state.checkedAt = new Date(this.now() - CHECK_INTERVAL_MS + 60 * 60_000).toISOString();
      this.log({ event: "home_update_check_failed", code: this.state.lastError.code });
    }
    this.#write();
  }

  /** Installs what the last check offered (see the top of this file).
   * Resolves with the outcome: "updated", "rolled-back" or "failed". */
  install(reason) {
    this.installing ??= this.#install(reason).finally(() => { this.installing = null; this.#write(); });
    return this.installing;
  }

  async #install(reason) {
    const available = this.state.available;
    const from = this.version;
    if (!available || this.cannotInstall) return "failed";
    // An earlier update's trial folder may still be going (#cleanUp); this
    // one may have the same name.
    await this.cleaned;
    const to = available.version;
    const fail = (code) => {
      this.state.lastUpdate = { from, to, outcome: "failed", at: new Date(this.now()).toISOString(), code };
      // Not tried again by itself, unless the network was all that failed.
      if (!["update-network", "update-download"].includes(code)) this.state.failedVersion = to;
      this.log({ event: "home_update_failed", to, code });
      return "failed";
    };
    if (available.blocked === "too-old") return fail("update-too-old");
    if (!available.file) return fail("update-no-file");
    const executable = this.program.executable;
    const installDirectory = dirname(executable);
    const extension = this.platform === "win32" ? ".exe" : "";
    const staged = join(installDirectory, `kin-${to}.new${extension}`);
    const trialCache = join(this.program.appCache, `update-${to}`);
    const original = this.controller.spec;
    let paused = false;
    let set = null;
    this.log({ event: "home_update_started", from, to, reason });
    try {
      this.#write("installing", "downloading");
      rmSync(staged, { force: true });
      await download(this.urls.file(to, available.file.file), staged, available.file, { fetchImpl: this.fetchImpl });
      this.#write("installing", "preparing");
      rmSync(trialCache, { recursive: true, force: true });
      const appDirectory = await this.prepare(staged, trialCache);
      this.#write("installing", "backing-up");
      await this.controller.pause();
      paused = true;
      try {
        set = await makeBackupSet({ dataDirectory: this.dataDirectory, copyDatabase: (destination) => DurableStore.createBackup(this.databasePath, destination), version: from, reason: "before-update", now: this.now });
      } catch (error) {
        throw new UpdateError("update-backup", error instanceof BackupError ? error.message : "Kin couldn't back up before the update.");
      }
      this.#write("installing", "trying");
      const trial = this.program.serviceProcessFor({ executable: staged, appDirectory })({ flags: this.controller.flagsFor(appDirectory), env: this.controller.serviceEnv });
      const outcome = await this.#trial(trial);
      if (outcome !== "ok") {
        await this.#rollBack({ set, original, staged, trialCache, code: outcome });
        return this.#rolledBack(from, to, outcome);
      }
      // Kept: the new executable takes the installed one's place, and the
      // service the launcher starts from now on is the new one.
      const previous = join(installDirectory, `kin.previous${extension}`);
      try {
        rmSync(previous, { force: true });
        renameSync(executable, previous);
        renameSync(staged, executable);
      } catch {
        await this.controller.pause();
        if (existsSync(previous) && !existsSync(executable)) renameSync(previous, executable);
        await this.#rollBack({ set, original, staged, trialCache, code: "update-swap" });
        return this.#rolledBack(from, to, "update-swap");
      }
      this.controller.adopt(this.program.serviceProcessFor({ executable, appDirectory })({ flags: this.controller.flagsFor(appDirectory), env: this.controller.serviceEnv }));
      this.version = to;
      this.state.available = null;
      this.state.lastUpdate = { from, to, outcome: "updated", at: new Date(this.now()).toISOString(), code: null };
      this.state.failedVersion = null;
      this.log({ event: "home_update_finished", from, to });
      return "updated";
    } catch (error) {
      const code = error instanceof UpdateError ? error.code : "update-failed";
      rmSync(staged, { force: true });
      await removeFolder(trialCache);
      if (paused) this.controller.resume(original);
      return fail(code);
    }
  }

  #rolledBack(from, to, code) {
    this.state.lastUpdate = { from, to, outcome: "rolled-back", at: new Date(this.now()).toISOString(), code };
    this.state.failedVersion = to;
    this.log({ event: "home_update_rolled_back", from, to, code });
    return "rolled-back";
  }

  /** Runs `spec` as the service until it is healthy for the trial, or
   * fails. Resolves "ok" (still running) or a failure code (stopped). */
  #trial(spec) {
    return new Promise((resolve) => {
      let settled = false;
      const timers = [];
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        if (result === "ok") this.controller.endTrial();
        else await this.controller.pause();
        resolve(result);
      };
      this.controller.resume(spec, { onExit: () => finish("update-exited") });
      // Elapsed time, not the clock of day (which `now` stands for).
      const deadline = performance.now() + this.healthTimeoutMs;
      const poll = async () => {
        if (settled) return;
        if (await this.health() === 0) {
          // Healthy: it must stay up for the trial, and answer at its end.
          timers.push(setTimeout(async () => finish(await this.health() === 0 ? "ok" : "update-unhealthy"), this.trialMs));
          return;
        }
        if (performance.now() >= deadline) { finish("update-unhealthy"); return; }
        timers.push(setTimeout(poll, this.healthPollMs));
      };
      poll();
    });
  }

  /** The trial failed: put the pre-update database back and start the
   * version that was running. */
  async #rollBack({ set, original, staged, trialCache, code }) {
    try {
      replaceDatabase(join(this.dataDirectory, "backups", set.id, "kin.sqlite"), this.databasePath, { now: this.now });
    } catch {
      this.log({ event: "home_update_rollback_database_failed", code });
    }
    rmSync(staged, { force: true });
    await removeFolder(trialCache);
    this.controller.resume(original);
  }

  /** Leftovers of an update that stopped half-way: downloads, unused
   * staged executables and trial app folders. `kin.previous` stays. */
  async #cleanUp() {
    if (this.cannotInstall) return;
    const installDirectory = dirname(this.program.executable);
    try {
      for (const name of readdirSync(installDirectory))
        if (/^kin-\d+\.\d+\.\d+\.new(?:\.exe)?(?:\.[0-9a-f]{8}\.download)?$/.test(name)) rmSync(join(installDirectory, name), { force: true });
    } catch { /* nothing to clean */ }
    try {
      const inUse = this.program.appDirectory ? basename(dirname(this.program.appDirectory)) : null;
      for (const name of readdirSync(this.program.appCache))
        if (/^update-\d+\.\d+\.\d+$/.test(name) && name !== inUse) await removeFolder(join(this.program.appCache, name));
    } catch { /* nothing to clean */ }
  }

  /** The status the control panel shows. */
  status(state = null, stage = null) {
    const available = this.state.available;
    return {
      format: UPDATE_FORMAT,
      state: state ?? (!this.key ? "off" : this.installing ? "installing" : !this.state.checkedAt ? "not-checked" : this.state.lastError ? "failed" : available ? "available" : "up-to-date"),
      stage,
      current: this.version,
      checkedAt: this.state.lastError ? this.state.lastError.at : this.state.checkedAt,
      available: available ? {
        version: available.version, kind: available.kind, releasedAt: available.releasedAt, page: available.page, blocked: available.blocked,
        install: this.cannotInstall || available.blocked ? "manual" : available.kind === "major" || !this.#autoUpdate() || available.version === this.state.failedVersion ? "admin" : "automatic",
      } : null,
      autoUpdate: this.#autoUpdate(),
      cannotInstall: this.cannotInstall,
      lastError: this.state.lastError,
      lastUpdate: this.state.lastUpdate,
      failedVersion: this.state.failedVersion,
    };
  }

  // One write at a time, in order, so an older status never lands over a
  // newer one. A failed write leaves the panel the last status it could read.
  #write(state = null, stage = null) {
    const text = `${JSON.stringify(this.status(state, stage))}\n`;
    this.written = this.written.then(() => {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      return writePrivateFile(join(this.directory, STATUS_FILE), text);
    }).catch(() => {});
  }
}

/** The updater runService starts in home mode (server/launcher.mjs). */
export function homeUpdater({ controller, program, version, databasePath, env, log, health }) {
  return new HomeUpdater({ dataDirectory: dirname(databasePath), databasePath, version, program, controller, env, log, health });
}
