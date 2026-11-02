// Scheduled backups and restore for the home server (ADR 0025 §10, #721).
//
// A backup set is a folder in `<data directory>/backups/`:
//
//   kin-20261025T030000Z/          the time it was made, UTC
//     kin.sqlite                   0600  the verified copy (VACUUM INTO, then
//                                        opened and validated: DurableStore.backup)
//     home/                        0700  the home key, the ACME account key, the
//                                        certificate and the home settings, so a
//                                        restore on a new computer is the same
//                                        home server with the same name
//     backup.json                  0600  { format, createdAt, reason, version,
//                                        databaseBytes, home }: written last, so a
//                                        folder without it is unfinished
//
// Why the service makes them, not the launcher (§10 says the launcher): the
// sets live inside the data directory, which the sandboxed service may
// write, and the service already holds the database, a clock and the
// control panel the status and changes go through. A copy outside the data
// directory (the optional second folder, a USB drive) is the one thing that
// needs the launcher: backup-copy.mjs (#763) makes it, and writes how it went
// to `backups/copy-status.json`, which this file reads for the panel.
//
// The schedule is a local hour (default 03:00). A backup is due when the
// newest set is older than the latest such hour, so a computer that was
// asleep or off at 03:00 makes one soon after it wakes or starts. The 14
// newest sets are kept; Kin removes only folders it named, never other files.
//
// Restore stops the service, puts the set back and starts it again: the
// control panel writes `backups/restore.json` and asks the launcher for a
// restart (RESTART_EXIT_CODE). On the next start, before the database is
// opened, server.mjs calls runPendingRestore, which uses the existing
// restore (DurableStore.restoreBackup: validates the copy, refuses one that
// would revive a pending deletion, keeps deletion tombstones and current
// authority, and keeps the replaced database as kin.sqlite.pre-restore-…).
// The outcome goes to `backups/restore-result.json` for the panel. The
// set's `home/` is put back only on a computer that has no home key of its
// own yet (moving to a new computer); otherwise this computer's keys,
// which the relay knows, stay.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../acme/keys.mjs";
import { DurableStore } from "../durable-store.mjs";
import { HOME_KEY_FILE } from "./home-key.mjs";
import { homeDirectory } from "./settings.mjs";

export const BACKUPS_KEPT = 14;
export const DEFAULT_BACKUP_HOUR = 3;
export const BACKUP_FORMAT = 1;
export const BACKUP_DATABASE = "kin.sqlite";
export const BACKUP_MANIFEST = "backup.json";
export const RESTORE_REQUEST = "restore.json";
export const RESTORE_RESULT = "restore-result.json";
/** How often the schedule is checked, and how long after a failure Kin
 * waits before trying again. */
export const BACKUP_CHECK_MS = 5 * 60_000;
export const BACKUP_RETRY_MS = 60 * 60_000;
/** The first check after the service starts, so starting stays quick. */
export const BACKUP_START_DELAY_MS = 60_000;
/** The files of `home/` a set holds. The control panel's sessions are not
 * among them: they belong to this computer. */
export const HOME_FILES = Object.freeze([HOME_KEY_FILE, "acme-account-key.pem", "acme-account.json", "certificate-key.pem", "certificate.pem", "certificate-history.json", "settings.json"]);
const SET_NAME = /^kin-(\d{8}T\d{6}Z)(?:-(\d{1,3}))?$/;
const REASONS = Object.freeze(["scheduled", "manual", "before-update"]);
/** An unfinished set (no manifest) older than this is left over from a
 * failure or a crash, and is removed. */
const UNFINISHED_MS = 60 * 60_000;

/** Every code a backup or restore reports, and the states of the control
 * panel's "backups" section (web/control/explain.js has words for each). */
export const BACKUP_ERROR_CODES = Object.freeze(["backup-failed", "backup-disk-full", "backup-busy", "backup-restore-pending", "backup-unknown", "backup-unreadable", "restore-failed", "restore-deletion-pending", "restore-newer-household"]);
export const BACKUP_STATES = Object.freeze(["ok", "none", "running", "failed", "restoring", "off"]);

/** The copy to a second folder (#763, backup-copy.mjs): the file only the
 * launcher writes, its states and its codes (explain.js has words for each). */
export const BACKUP_COPY_STATUS = "copy-status.json";
export const BACKUP_COPY_FORMAT = 1;
export const BACKUP_COPY_STATES = Object.freeze(["off", "waiting", "copying", "ok", "failed"]);
export const BACKUP_COPY_ERROR_CODES = Object.freeze([
  "backup-copy-missing", "backup-copy-not-folder", "backup-copy-same-disk", "backup-copy-denied", "backup-copy-full", "backup-copy-too-big", "backup-copy-failed",
]);

export const backupsDirectory = (dataDirectory) => join(dataDirectory, "backups");

/** What the launcher last wrote about the second copy, or null. */
export function readBackupCopyStatus(dataDirectory) {
  const status = readJson(join(backupsDirectory(dataDirectory), BACKUP_COPY_STATUS));
  return status?.format === BACKUP_COPY_FORMAT ? status : null;
}

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

/** "2026-10-25T03:00:00.000Z" → "kin-20261025T030000Z". */
function setName(time) {
  return `kin-${new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

/** The latest moment at `hour` local time at or before `now`. */
export function lastScheduled(now, hour) {
  const moment = new Date(now);
  moment.setHours(hour, 0, 0, 0);
  if (moment.getTime() > now) moment.setDate(moment.getDate() - 1);
  return moment.getTime();
}

/** The first moment at `hour` local time after `now`. */
export function nextScheduled(now, hour) {
  const moment = new Date(now);
  moment.setHours(hour, 0, 0, 0);
  if (moment.getTime() <= now) moment.setDate(moment.getDate() + 1);
  return moment.getTime();
}

export const isBackupHour = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 23;

/** A failure as a code the control panel puts in plain words. */
function failureCode(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (cause.code === "ENOSPC") return "backup-disk-full";
    if (cause.code === "durable_lock_exists") return "backup-busy";
    if (cause.code === "restore_blocked_deletion_pending") return "restore-deletion-pending";
    if (cause.code === "restore_missing_active_household") return "restore-newer-household";
  }
  return null;
}

function readManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest?.format !== BACKUP_FORMAT || Number.isNaN(Date.parse(manifest.createdAt))) return null;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * The finished sets in `directory`, newest first:
 * [{ id, createdAt, reason, version, databaseBytes, home }]. Anything that
 * isn't a folder Kin named with a readable manifest is not a set.
 */
export function listBackups(directory) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sets = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SET_NAME.test(entry.name)) continue;
    const manifest = readManifest(join(directory, entry.name, BACKUP_MANIFEST));
    if (!manifest) continue;
    sets.push({
      id: entry.name,
      createdAt: new Date(Date.parse(manifest.createdAt)).toISOString(),
      reason: REASONS.includes(manifest.reason) ? manifest.reason : "scheduled",
      version: typeof manifest.version === "string" ? manifest.version : null,
      databaseBytes: Number.isSafeInteger(manifest.databaseBytes) ? manifest.databaseBytes : null,
      home: Array.isArray(manifest.home) && manifest.home.includes(HOME_KEY_FILE),
    });
  }
  return sets.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Reads a small JSON file in the backups folder, or null. */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** Copies the home files that exist from `source` to `target`; returns
 * their names. */
function copyHome(source, target) {
  const copied = [];
  for (const name of HOME_FILES) {
    if (!statSync(join(source, name), { throwIfNoEntry: false })?.isFile()) continue;
    if (!copied.length) mkdirSync(target, { mode: 0o700 });
    copyFileSync(join(source, name), join(target, name));
    copied.push(name);
  }
  return copied;
}

/**
 * Makes one set in `<dataDirectory>/backups/` and removes the oldest beyond
 * 14. `copyDatabase(destination)` writes the verified database copy and
 * resolves with its path: the running service's `store.backup`, or
 * `DurableStore.createBackup` from the launcher before an update (#722),
 * while the service is stopped. Resolves with { id, createdAt, reason,
 * databaseBytes }; a failure removes the folder and throws BackupError.
 */
export async function makeBackupSet({ dataDirectory, copyDatabase, version, reason, now = Date.now }) {
  const directory = backupsDirectory(dataDirectory);
  const createdAt = new Date(now()).toISOString();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let id = setName(createdAt);
  for (let n = 2; statSync(join(directory, id), { throwIfNoEntry: false }); n += 1) id = `${setName(createdAt)}-${n}`;
  const folder = join(directory, id);
  try {
    mkdirSync(folder, { mode: 0o700 });
    const database = await copyDatabase(join(folder, BACKUP_DATABASE));
    const home = copyHome(homeDirectory(dataDirectory), join(folder, "home"));
    const databaseBytes = statSync(database).size;
    await writePrivateFile(join(folder, BACKUP_MANIFEST), `${JSON.stringify({ format: BACKUP_FORMAT, createdAt, reason, version, databaseBytes, home }, null, 2)}\n`);
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw new BackupError(failureCode(error) ?? "backup-failed", "Kin couldn't make a backup.");
  }
  pruneBackups(directory, now());
  return { id, createdAt, reason, databaseBytes: statSync(join(folder, BACKUP_DATABASE)).size };
}

/** Removes finished sets beyond the 14 newest, and unfinished ones left by
 * a failure. Only folders named like Kin's sets are touched. */
export function pruneBackups(directory, now = Date.now()) {
  const sets = listBackups(directory);
  for (const set of sets.slice(BACKUPS_KEPT)) rmSync(join(directory, set.id), { recursive: true, force: true });
  const finished = new Set(sets.map((set) => set.id));
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SET_NAME.test(entry.name) || finished.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (now - statSync(path).mtimeMs > UNFINISHED_MS) rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Makes, keeps and lists backups for one running home server, and asks for
 * a restore. Status is sync (the control panel's sections are).
 */
export class HomeBackups {
  /**
   * @param {object} options
   * @param {import("../durable-store.mjs").DurableStore} options.store  the service's database
   * @param {string} options.dataDirectory
   * @param {() => object} options.getSettings  resolved home settings
   * @param {string} options.version
   * @param {(reason: string) => void} [options.restart]  asks the launcher to start the service again
   * @param {(event: object) => void} [options.log]
   * @param {() => number} [options.now]
   */
  constructor({ store, dataDirectory, getSettings, version, restart = () => {}, log = () => {}, now = Date.now, checkMs = BACKUP_CHECK_MS, startDelayMs = BACKUP_START_DELAY_MS }) {
    Object.assign(this, { store, dataDirectory, getSettings, version, restart, log, now, checkMs, startDelayMs });
    this.directory = backupsDirectory(dataDirectory);
    this.running = null;
    this.lastError = null;
    this.timers = [];
    this.restoreRequested = false;
  }

  get hour() { return this.getSettings().backupHour ?? DEFAULT_BACKUP_HOUR; }

  list() { return listBackups(this.directory); }

  /** Starts the schedule. It runs only on a server with a name: before
   * setup there is nothing to keep. */
  start() {
    if (this.timers.length) return;
    const check = () => { this.runIfDue().catch(() => {}); };
    const first = setTimeout(check, this.startDelayMs);
    const every = setInterval(check, this.checkMs);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  stop() {
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
  }

  /** True when a scheduled backup should run now. */
  due(now = this.now()) {
    if (!this.getSettings().configured || this.restoreRequested) return false;
    if (this.lastError && now - Date.parse(this.lastError.at) < BACKUP_RETRY_MS) return false;
    const newest = this.list()[0];
    return !newest || Date.parse(newest.createdAt) < lastScheduled(now, this.hour);
  }

  async runIfDue() {
    if (this.running || !this.due()) return null;
    try { return await this.create("scheduled"); } catch { return null; }
  }

  /**
   * Makes a set now and removes the oldest beyond 14. Resolves with the new
   * set; throws BackupError with a code the control panel explains. One at
   * a time: a second call while one runs waits for it.
   */
  create(reason = "manual") {
    if (this.running) return this.running;
    this.running = this.#create(reason).finally(() => { this.running = null; });
    return this.running;
  }

  async #create(reason) {
    if (this.restoreRequested) throw new BackupError("backup-restore-pending", "Kin is about to restore a backup.");
    try {
      const set = await makeBackupSet({ dataDirectory: this.dataDirectory, copyDatabase: (destination) => this.store.backup(destination), version: this.version, reason, now: this.now });
      this.lastError = null;
      this.log({ event: "home_backup_created", reason, databaseBytes: set.databaseBytes });
      return set;
    } catch (error) {
      const code = error instanceof BackupError ? error.code : "backup-failed";
      this.lastError = { code, at: new Date(this.now()).toISOString() };
      this.log({ event: "home_backup_failed", reason, code });
      throw error instanceof BackupError ? error : new BackupError(code, "Kin couldn't make a backup.");
    }
  }

  /** Removes the oldest sets beyond 14 and unfinished ones (pruneBackups). */
  prune() { pruneBackups(this.directory, this.now()); }

  /** The set `id`, checked: it exists, and its database opens and passes
   * the same checks the service makes at startup. */
  checkRestore(id) {
    const set = typeof id === "string" ? this.list().find((candidate) => candidate.id === id) : undefined;
    if (!set) throw new BackupError("backup-unknown", "Kin doesn't have that backup.");
    try {
      new DurableStore(join(this.directory, id, BACKUP_DATABASE), { acquireProcessLock: false, readonly: true }).close();
    } catch {
      throw new BackupError("backup-unreadable", "That backup doesn't open.");
    }
    return set;
  }

  /** Asks for `id` to be restored on the next start, and for that start. */
  async requestRestore(id) {
    const set = this.checkRestore(id);
    if (this.running) await this.running.catch(() => {});
    await writePrivateFile(join(this.directory, RESTORE_REQUEST), `${JSON.stringify({ format: BACKUP_FORMAT, id: set.id, requestedAt: new Date(this.now()).toISOString() })}\n`);
    this.restoreRequested = true;
    this.log({ event: "home_restore_requested" });
    this.restart("restore");
    return { id: set.id, createdAt: set.createdAt };
  }

  /** The control panel's "backups" section: dates, sizes and codes only. */
  status() {
    const sets = this.list();
    const now = this.now();
    const configured = Boolean(this.getSettings().configured);
    const retryAt = this.lastError ? new Date(Date.parse(this.lastError.at) + BACKUP_RETRY_MS).toISOString() : null;
    const due = configured && !this.restoreRequested && (!sets[0] || Date.parse(sets[0].createdAt) < lastScheduled(now, this.hour));
    const restore = readJson(join(this.directory, RESTORE_RESULT));
    return {
      state: this.running ? "running" : this.restoreRequested ? "restoring" : !configured ? "off" : this.lastError ? "failed" : sets.length ? "ok" : "none",
      hour: this.hour,
      kept: BACKUPS_KEPT,
      lastBackupAt: sets[0]?.createdAt ?? null,
      // Due: the next check (within five minutes) makes one.
      due: due && !this.lastError,
      nextBackupAt: !configured ? null : this.lastError ? retryAt : due ? null : new Date(nextScheduled(now, this.hour)).toISOString(),
      lastError: this.lastError,
      totalBytes: sets.reduce((sum, set) => sum + (set.databaseBytes ?? 0), 0),
      backups: sets.map(({ id, createdAt, reason, databaseBytes, home }) => ({ id, createdAt, reason, databaseBytes, home })),
      lastRestore: restore && typeof restore.outcome === "string"
        ? { outcome: restore.outcome, at: restore.at ?? null, backupCreatedAt: restore.backupCreatedAt ?? null, code: restore.code ?? null, homeRestored: restore.homeRestored === true }
        : null,
      copy: this.#copy(),
    };
  }

  /** The second copy (#763), as the launcher last wrote it, without the
   * folder's path (a path can hold an account name). "waiting" until the
   * launcher has looked at the folder now chosen; Kin started without the
   * launcher never does. */
  #copy() {
    const settings = this.getSettings();
    const folder = settings.backupCopyFolder ?? null;
    const shown = (state, file = null) => ({
      state, kept: BACKUPS_KEPT,
      lastCopyAt: file?.lastCopyAt ?? null, lastCopiedCreatedAt: file?.lastCopiedCreatedAt ?? null,
      copies: Number.isSafeInteger(file?.copies) ? file.copies : 0,
      lastError: typeof file?.lastError?.code === "string" ? { code: file.lastError.code, at: file.lastError.at ?? null } : null,
      // On Windows: Kin couldn't make the copies folder private.
      notPrivate: file?.notPrivate === true,
    });
    if (!folder || !settings.configured) return shown("off");
    const file = readBackupCopyStatus(this.dataDirectory);
    if (!file || file.folder !== folder || !BACKUP_COPY_STATES.includes(file.state) || file.state === "off") return shown("waiting");
    return shown(file.state, file);
  }
}

/**
 * Runs a restore the control panel asked for, before the service opens its
 * database (server.mjs). Resolves with the outcome written to
 * restore-result.json, or null when none was asked for. The request is
 * removed first, so a restore that fails can't stop Kin from starting: the
 * current database stays and the panel shows why.
 */
export async function runPendingRestore({ dataDirectory, databasePath, now = Date.now, log = () => {} }) {
  const directory = backupsDirectory(dataDirectory);
  let request;
  try {
    request = JSON.parse(await readFile(join(directory, RESTORE_REQUEST), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    request = null;
  }
  await rm(join(directory, RESTORE_REQUEST), { force: true });
  const at = new Date(now()).toISOString();
  const set = typeof request?.id === "string" && SET_NAME.test(request.id) ? listBackups(directory).find((candidate) => candidate.id === request.id) : undefined;
  let result;
  let reason = null;
  if (!set) {
    result = { format: BACKUP_FORMAT, outcome: "failed", at, code: "backup-unknown" };
  } else {
    try {
      await DurableStore.restoreBackup(join(directory, set.id, BACKUP_DATABASE), databasePath, { acknowledgeDeletionHistory: true });
      const homeRestored = restoreHome(join(directory, set.id, "home"), homeDirectory(dataDirectory));
      result = { format: BACKUP_FORMAT, outcome: "restored", at, backupCreatedAt: set.createdAt, homeRestored };
    } catch (error) {
      result = { format: BACKUP_FORMAT, outcome: "failed", at, backupCreatedAt: set.createdAt, code: failureCode(error) ?? "restore-failed" };
      // For Kin's log only: the first system or store code, never a path.
      for (let cause = error; cause && !reason; cause = cause.cause) if (typeof cause.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(cause.code)) reason = cause.code;
    }
  }
  await writePrivateFile(join(directory, RESTORE_RESULT), `${JSON.stringify(result)}\n`);
  log({ event: result.outcome === "restored" ? "home_restore_finished" : "home_restore_failed", ...(result.code ? { code: result.code } : {}), ...(reason ? { reason } : {}), ...(result.homeRestored ? { homeRestored: true } : {}) });
  return result;
}

/** Puts a set's home files in place when this computer has no home key
 * (a new computer). Returns whether it did. */
function restoreHome(source, target) {
  if (statSync(join(target, HOME_KEY_FILE), { throwIfNoEntry: false })) return false;
  if (!statSync(join(source, HOME_KEY_FILE), { throwIfNoEntry: false })) return false;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of HOME_FILES)
    if (statSync(join(source, name), { throwIfNoEntry: false })?.isFile()) copyFileSync(join(source, name), join(target, name));
  return true;
}
