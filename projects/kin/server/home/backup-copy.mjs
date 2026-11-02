// The copy of each backup to a second folder (ADR 0025 §10, #763): a USB
// drive or another disk the person chooses in the control panel.
//
// The launcher runs this, outside the sandbox. The sets are made by the
// service inside its data directory (backups.mjs, #721), which is all the
// service may write; the second folder is outside it. The launcher keeps
// that folder in step by looking again, never by being told which set is
// new, so a missed look does no harm. Three things make it look:
//
// - the service's `home_backup_created` line (in home mode the launcher
//   already reads the service's output, server/launcher.mjs);
// - the launcher starting;
// - a look every minute, which catches the set the updater makes before an
//   update (in the launcher, so no line is printed), a drive plugged in
//   later, a folder just chosen, and a drive unplugged, swapped for another
//   or emptied since the last copy (the folder and its sets are looked at
//   even when the last copy went well).
//
// Each look copies every finished set the folder lacks, newest first, to
//
//   <chosen folder>/Kin backups/<server name>/kin-<time>/
//
// in the same form as the set in `backups/`. `kin.sqlite` comes first, and
// is read back and checked against the original's size and SHA-256 and the
// manifest (the system may answer that read from memory, so this catches a
// copy Kin got wrong, not a drive that loses what it was given); then
// `home/`; `backup.json` last, so a folder without it is unfinished, as in
// `backups/`. Each file is flushed to the drive (removable drives hold
// writes back). Any failure removes that set's folder. The 14 newest are
// kept there too, and only Kin's own folders are touched (pruneBackups): the
// person's own files, and another home server's folder on the same drive,
// stay. A folder changed or cleared in the panel stops the run before the
// next set, so the old folder gets no more.
//
// On Windows the modes below mean nothing, so `Kin backups/<name>` is given
// permissions like the data directory's (the installer's icacls): SYSTEM,
// Administrators, whoever owns each file, the service's account (LOCAL
// SERVICE) and the account Kin runs as now, so a folder first made by a
// `kin` run as the person still lets the service in. When that fails
// (FAT32 and exFAT hold no permissions; an NTFS folder the person made may
// not let Kin change them) the copy goes ahead, the status says the copies
// aren't private, and the next look tries again.
//
// Kin never makes the chosen folder itself, and refuses one on the same
// partition as its data directory: a drive that isn't plugged in is then
// reported, instead of filling this computer's own disk with copies that
// wouldn't survive it failing. Another partition of the same disk can't be
// told apart (the guide says so). Outside Windows, the folder's real path
// (its links followed and, on a Mac, its name in the case the disk holds)
// is looked at when it is under /media, /mnt, /run/media or /Volumes: from
// the folder up to the one directly under that area, when none of them is
// on another partition than the folder above it, nothing is mounted there
// and it is reported as missing. A drive mounted at /mnt (or /media,
// /run/media) itself is used; /Volumes never counts as one, since on a Mac
// it can be on another partition than / with no drive mounted at it. A full
// drive is reported, never cleared to make room.
//
// How it went goes to `backups/copy-status.json`, which only the launcher
// writes and the control panel reads (backups.mjs). Kin's log gets codes
// and counts, never a path.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { mkdir, open, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { writePrivateFile } from "../acme/keys.mjs";
import {
  BACKUPS_KEPT, BACKUP_COPY_FORMAT, BACKUP_COPY_STATUS, BACKUP_DATABASE, BACKUP_MANIFEST, BACKUP_RETRY_MS, HOME_FILES,
  backupsDirectory, listBackups, pruneBackups, readBackupCopyStatus,
} from "./backups.mjs";
import { homeSettingsPath, normalizeBackupCopyFolder, resolveHomeSettings } from "./settings.mjs";

export const COPIES_FOLDER = "Kin backups";
export const COPY_POLL_MS = 60_000;
/** How long after a failure of the copy itself (a full drive, a bad
 * read-back) Kin waits before trying again. */
export const COPY_RETRY_MS = BACKUP_RETRY_MS;
/** Room the drive must have beyond the set itself. */
const SPARE_BYTES = 1024 * 1024;
/** Problems with the folder rather than the copy: looked at every minute,
 * so a drive plugged in is copied to within one. */
const FOLDER_PROBLEMS = Object.freeze(["backup-copy-missing", "backup-copy-not-folder", "backup-copy-same-disk", "backup-copy-denied"]);
/** Where drives are mounted outside Windows. */
const MOUNT_AREAS = Object.freeze(["/run/media", "/media", "/mnt", "/Volumes"]);

export class BackupCopyError extends Error {
  constructor(code) {
    super("Kin couldn't copy a backup to the second folder.");
    this.name = "BackupCopyError";
    this.code = code;
  }
}

// The launcher is stopping: the copy under way is removed and nothing is
// reported.
const STOPPED = new BackupCopyError("stopped");
// The folder was changed or cleared during a run: it stops before the next
// set, unreported, and the run starts again with the new setting.
const CHANGED = new BackupCopyError("changed");

/** Where this server's copies go in `folder`. */
export function copyFolderFor(folder, name, platform = process.platform) {
  return (platform === "win32" ? win32 : posix).join(folder, COPIES_FOLDER, name);
}

/** A failure as the code the control panel puts in plain words. */
export function copyErrorCode(error) {
  if (error instanceof BackupCopyError) return error.code;
  switch (error?.code) {
    case "ENOENT": return "backup-copy-missing";
    case "ENOTDIR": return "backup-copy-not-folder";
    case "EACCES": case "EPERM": case "EROFS": return "backup-copy-denied";
    case "ENOSPC": case "EDQUOT": return "backup-copy-full";
    // FAT32, common on USB sticks, holds no file over 4 GB.
    case "EFBIG": return "backup-copy-too-big";
    default: return "backup-copy-failed";
  }
}

/** For Kin's log only: the system's code, never a path. */
const systemCode = (error) => (typeof error?.code === "string" && /^E[A-Z0-9]{1,30}$/.test(error.code) ? error.code : null);

/** Copies `source` to a new file `destination` (0600) and flushes it to
 * the drive. Resolves with the source's { bytes, sha256 }. */
export async function copyFileFlushed(source, destination) {
  const hash = createHash("sha256");
  let bytes = 0;
  const target = await open(destination, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(source)) {
      hash.update(chunk);
      bytes += chunk.length;
      for (let offset = 0; offset < chunk.length;) offset += (await target.write(chunk, offset)).bytesWritten;
    }
    await target.sync();
  } finally {
    await target.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** A file's { bytes, sha256 }, read back (perhaps from the system's memory
 * of what was just written, not the drive itself). */
async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** LOCAL SERVICE, the account the Windows service runs as. */
const LOCAL_SERVICE = "S-1-5-19";
const SID = /^S-1-\d+(-\d+)+$/;

/** The SID in `whoami /user /fo csv /nh` output ("name","S-1-…"), or null. */
export function parseAccountSid(output) {
  const sid = /"(S-1-[\d-]+)"$/.exec(String(output ?? "").trim())?.[1];
  return sid && SID.test(sid) ? sid : null;
}

let accountSid = null;
/** The account Kin runs as, by SID, looked up once; null when it can't be
 * told (the copies folder then lets in each file's owner and the service's
 * account only). Windows only. */
export function currentAccountSid() {
  // Windows' own whoami, not another one earlier on the PATH (Git's).
  const whoami = process.env.SystemRoot ? win32.join(process.env.SystemRoot, "System32", "whoami.exe") : "whoami.exe";
  accountSid ??= new Promise((resolve) => {
    execFile(whoami, ["/user", "/fo", "csv", "/nh"], { windowsHide: true }, (error, stdout) => {
      const sid = error ? null : parseAccountSid(stdout);
      if (sid) return resolve(sid);
      let name = "";
      try { name = userInfo().username; } catch { name = ""; }
      return resolve(/^local ?service$/i.test(name) ? LOCAL_SERVICE : null);
    });
  });
  return accountSid;
}

/** icacls's arguments for `folder`: SYSTEM, Administrators, each file's
 * owner, LOCAL SERVICE and `account` (a SID, or null), nothing inherited.
 * Given to icacls as they are, never through a shell. */
export function protectArguments(folder, account = null) {
  const sids = ["S-1-5-18", "S-1-5-32-544", "S-1-3-4", LOCAL_SERVICE];
  if (typeof account === "string" && SID.test(account) && !sids.includes(account)) sids.push(account);
  return [folder, "/inheritance:r", "/grant:r", ...sids.map((sid) => `*${sid}:(OI)(CI)F`)];
}

/** Gives `folder` (and what is made in it) only the accounts above, as the
 * installer does for the data directory. `account` defaults to the one Kin
 * runs as. Windows only. */
export async function protectFolder(folder, account) {
  const args = protectArguments(folder, account === undefined ? await currentAccountSid() : account);
  return new Promise((resolve, reject) => {
    execFile("icacls", args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

const blank = (folder) => ({ folder, checkedAt: null, lastCopyAt: null, lastCopiedCreatedAt: null, copies: 0, lastError: null, notPrivate: false });

/**
 * The launcher's copier for one home server. Test seams: `files` replaces
 * `stat`, `realpath`, `statfs` (free space), `mkdir` (for the copies folder),
 * `copyFile` (copyFileFlushed) and `protect` (protectFolder, on Windows).
 */
export class BackupCopier {
  constructor({ dataDirectory, env = process.env, platform = process.platform, now = Date.now, log = () => {}, files = {}, pollMs = COPY_POLL_MS }) {
    Object.assign(this, { dataDirectory, env, platform, now, log, pollMs });
    this.files = { stat, realpath, statfs, mkdir, copyFile: copyFileFlushed, protect: protectFolder, ...files };
    this.source = backupsDirectory(dataDirectory);
    const previous = readBackupCopyStatus(dataDirectory);
    this.state = previous
      ? { state: previous.state, folder: previous.folder ?? null, checkedAt: previous.checkedAt ?? null, lastCopyAt: previous.lastCopyAt ?? null, lastCopiedCreatedAt: previous.lastCopiedCreatedAt ?? null, copies: previous.copies ?? 0, lastError: previous.lastError ?? null, notPrivate: previous.notPrivate === true }
      : { state: "off", ...blank(null) };
    this.running = null;
    this.again = false;
    this.timer = null;
    this.stopped = false;
    // The copies folder this launcher gave its permissions (Windows), once
    // that worked.
    this.protectedFolder = null;
    // Settles once the last status written is on disk (see #write).
    this.written = Promise.resolve();
  }

  /** Looks once now, then every minute. */
  start() {
    if (this.timer || this.stopped) return;
    this.sync().catch(() => {});
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
  }

  /** Stops looking. A copy under way stops after the file it is on; the
   * launcher doesn't wait for it. */
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** The service made a set. */
  backupMade() {
    if (!this.stopped) this.sync().catch(() => {});
  }

  /** The minute's look: copies when something may have changed, or when
   * the folder no longer holds what the last copy left there. */
  async tick() {
    if (this.stopped || this.running) return null;
    if (!this.due() && !(await this.#lacking())) return null;
    if (this.stopped || this.running) return null;
    return this.sync();
  }

  /** True when the last copy went well but the folder is gone (a drive
   * unplugged), or lacks a set (another drive plugged in at the same place,
   * or the copies deleted). Reads only the folder and the manifests. */
  async #lacking() {
    const { folder, name } = this.#settings();
    if (this.state.state !== "ok" || !folder || !name || this.state.folder !== folder) return false;
    try {
      const chosen = normalizeBackupCopyFolder(folder, this.platform);
      if (!chosen) return true;
      await this.#check(chosen);
      const kept = listBackups(copyFolderFor(chosen, name, this.platform));
      const there = new Set(kept.map((set) => set.id));
      // A set older than the 14 kept there would only be pruned again.
      const oldest = kept.length >= BACKUPS_KEPT ? kept.at(-1).createdAt : "";
      return listBackups(this.source).some((set) => !there.has(set.id) && set.createdAt > oldest);
    } catch {
      return true;
    }
  }

  /** The folder and server name from the home settings, read as the
   * updater reads them; a file that doesn't read turns the copy off. */
  #settings() {
    let file = null;
    try { file = JSON.parse(readFileSync(homeSettingsPath(this.dataDirectory), "utf8")); } catch { file = null; }
    try {
      const settings = resolveHomeSettings(file, this.env);
      return { folder: settings.backupCopyFolder, name: settings.name };
    } catch {
      return { folder: null, name: null };
    }
  }

  /** True when a look should copy: the folder changed, a folder problem
   * (every minute), another failure an hour ago, or a newer set. */
  due(now = this.now()) {
    const { folder, name } = this.#settings();
    const last = this.state;
    if (!folder || !name) return last.state !== "off";
    if (last.folder !== folder) return true;
    if (last.state === "failed") return FOLDER_PROBLEMS.includes(last.lastError?.code) || !(now - Date.parse(last.lastError?.at) < COPY_RETRY_MS);
    const newest = listBackups(this.source)[0];
    return Boolean(newest) && (!last.lastCopiedCreatedAt || newest.createdAt > last.lastCopiedCreatedAt);
  }

  /** Copies what the folder lacks. One at a time: a call while one runs
   * makes it run once more after, for the set that may be new. Resolves
   * with { state, copied, removed } or { state, code }; never rejects. */
  sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let result;
      do {
        this.again = false;
        result = await this.#sync();
      } while (this.again && !this.stopped);
      return result;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async #sync() {
    const { folder, name } = this.#settings();
    const at = new Date(this.now()).toISOString();
    if (!folder || !name) {
      if (this.state.state !== "off") this.#write({ state: "off", ...blank(null), checkedAt: at });
      return { state: "off" };
    }
    if (this.state.folder !== folder) this.state = { ...this.state, ...blank(folder) };
    try {
      const chosen = normalizeBackupCopyFolder(folder, this.platform);
      if (!chosen) throw new BackupCopyError("backup-copy-missing");
      await this.#check(chosen);
      const destination = copyFolderFor(chosen, name, this.platform);
      const made = await this.files.mkdir(destination, { recursive: true, mode: 0o700 });
      const notPrivate = !(await this.#protect(destination, made));
      if (notPrivate !== this.state.notPrivate) this.#write({ notPrivate });
      const there = new Set(listBackups(destination).map((set) => set.id));
      const missing = listBackups(this.source).filter((set) => !there.has(set.id));
      if (missing.length) this.#write({ state: "copying", checkedAt: at });
      let copied = 0;
      for (const set of missing) {
        const current = this.#settings();
        if (current.folder !== folder || current.name !== name) throw CHANGED;
        if (await this.#copySet(set, destination)) copied += 1;
      }
      const before = listBackups(destination).length;
      pruneBackups(destination, this.now());
      const kept = listBackups(destination);
      const done = new Date(this.now()).toISOString();
      this.#write({ state: "ok", checkedAt: done, lastCopyAt: copied ? done : this.state.lastCopyAt, lastCopiedCreatedAt: kept[0]?.createdAt ?? null, copies: kept.length, lastError: null });
      const removed = before - kept.length;
      if (copied || removed) this.log({ event: "home_backup_copied", copied, removed });
      return { state: "ok", copied, removed };
    } catch (error) {
      if (error === STOPPED) return { state: "stopped" };
      if (error === CHANGED) {
        this.again = true;
        return { state: "changed" };
      }
      let code = copyErrorCode(error);
      // A drive pulled out during a write fails with an error of its own
      // (EIO): if the folder has gone too, that is the problem, looked at
      // every minute, so the copy is made again once the drive is back.
      if (code === "backup-copy-failed") {
        const chosen = normalizeBackupCopyFolder(folder, this.platform);
        const now = chosen ? await this.#check(chosen).then(() => null, (problem) => copyErrorCode(problem)) : null;
        if (FOLDER_PROBLEMS.includes(now)) code = now;
      }
      // Logged when the problem is new, not every minute it lasts.
      if (this.state.state !== "failed" || this.state.lastError?.code !== code) {
        const reason = systemCode(error);
        this.log({ event: "home_backup_copy_failed", code, ...(reason ? { reason } : {}) });
      }
      this.#write({ state: "failed", checkedAt: at, lastError: { code, at } });
      return { state: "failed", code };
    }
  }

  /** Throws BackupCopyError (or the system's error) unless `folder` is a
   * folder on another partition than the data directory and, outside
   * Windows, not an empty mount point: walking up from the folder to the
   * one directly under the mount area (`/Volumes/USB`, or
   * `/media/<you>/<label>` and the folder between), it is refused when none
   * of them is on another partition than the folder above it, unless a
   * drive is mounted at the area itself (see the top of this file). The
   * walk is on the folder's real path: a link to an empty /mnt/usb, or
   * /media where /media links to /run/media, is looked at where it really
   * is, and /volumes/USB on a Mac as /Volumes/USB. */
  async #check(folder) {
    const info = await this.files.stat(folder);
    if (!info.isDirectory()) throw new BackupCopyError("backup-copy-not-folder");
    if ((await this.files.stat(this.dataDirectory)).dev === info.dev) throw new BackupCopyError("backup-copy-same-disk");
    if (this.platform === "win32") return;
    const real = await this.files.realpath(folder);
    const area = MOUNT_AREAS.find((root) => real.startsWith(`${root}/`));
    if (!area) return;
    for (let path = real; path.length > area.length; path = posix.dirname(path)) {
      if ((await this.files.stat(posix.dirname(path))).dev !== info.dev) return;
    }
    if (area !== "/Volumes" && (await this.files.stat(posix.dirname(area))).dev !== info.dev) return;
    throw new BackupCopyError("backup-copy-missing");
  }

  /** On Windows, gives this server's copies folder its permissions: when
   * it was just made (perhaps on another drive at the same place), once per
   * launcher for one made before, and at each look until that works.
   * Resolves false when it didn't: a drive that holds no permissions
   * (FAT32, exFAT), or a folder whose permissions Kin may not change. That
   * is logged once and copied to all the same, and the status says so. */
  async #protect(destination, made) {
    if (this.platform !== "win32" || (!made && this.protectedFolder === destination)) return true;
    this.protectedFolder = null;
    try {
      await this.files.protect(destination);
      this.protectedFolder = destination;
      return true;
    } catch (error) {
      if (!this.state.notPrivate) {
        const reason = systemCode(error);
        this.log({ event: "home_backup_copy_not_private", ...(reason ? { reason } : {}) });
      }
      return false;
    }
  }

  #stopping() {
    if (this.stopped) throw STOPPED;
  }

  /** Copies one set (see the top of this file). Resolves true, or false
   * when the service removed the set meanwhile (it keeps 14 too). */
  async #copySet(set, destination) {
    const from = join(this.source, set.id);
    const to = join(destination, set.id);
    try {
      this.#stopping();
      let home = [];
      try { home = (await readdir(join(from, "home"))).filter((name) => HOME_FILES.includes(name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      let needed = SPARE_BYTES;
      for (const path of [join(from, BACKUP_DATABASE), join(from, BACKUP_MANIFEST), ...home.map((name) => join(from, "home", name))]) needed += (await this.files.stat(path)).size;
      const disk = await this.files.statfs(destination);
      if (Number(disk.bavail) * Number(disk.bsize) < needed) throw new BackupCopyError("backup-copy-full");
      // A folder left without its manifest is unfinished: copied again.
      await rm(to, { recursive: true, force: true });
      await mkdir(to, { mode: 0o700 });
      const copied = await this.files.copyFile(join(from, BACKUP_DATABASE), join(to, BACKUP_DATABASE));
      const check = await hashFile(join(to, BACKUP_DATABASE));
      if (check.bytes !== copied.bytes || check.sha256 !== copied.sha256 || (set.databaseBytes !== null && copied.bytes !== set.databaseBytes))
        throw new BackupCopyError("backup-copy-failed");
      if (home.length) {
        this.#stopping();
        await mkdir(join(to, "home"), { mode: 0o700 });
        for (const name of home) {
          this.#stopping();
          await this.files.copyFile(join(from, "home", name), join(to, "home", name));
        }
      }
      this.#stopping();
      await this.files.copyFile(join(from, BACKUP_MANIFEST), join(to, BACKUP_MANIFEST));
      return true;
    } catch (error) {
      await rm(to, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      if (error !== STOPPED && !(await stat(join(from, BACKUP_MANIFEST)).then(() => true, () => false))) return false;
      throw error;
    }
  }

  // One write at a time, in order, so an older status never lands over a
  // newer one (the updater's pattern). A failed write leaves the panel the
  // last status it could read.
  #write(changes) {
    this.state = { ...this.state, ...changes };
    const text = `${JSON.stringify({ format: BACKUP_COPY_FORMAT, ...this.state })}\n`;
    this.written = this.written.then(async () => {
      await mkdir(this.source, { recursive: true, mode: 0o700 });
      await writePrivateFile(join(this.source, BACKUP_COPY_STATUS), text);
    }).catch(() => {});
  }
}

/** The copier runService starts in home mode (server/launcher.mjs). */
export function homeBackupCopier({ databasePath, env, log }) {
  return new BackupCopier({ dataDirectory: dirname(databasePath), env, log });
}
