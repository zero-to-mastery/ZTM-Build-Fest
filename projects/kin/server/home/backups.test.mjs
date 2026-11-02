// Scheduled backups and restore (ADR 0025 §10, #721): what a set holds, the
// schedule (a local hour, catching up after a missed one), keeping 14, the
// check that a backup opens, and the restore the next start runs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "../durable-store.mjs";
import { PairingService } from "../pairing-service.mjs";
import {
  BACKUPS_KEPT, BACKUP_COPY_STATUS, BACKUP_MANIFEST, BACKUP_RETRY_MS, HomeBackups, RESTORE_REQUEST, RESTORE_RESULT,
  backupsDirectory, lastScheduled, listBackups, nextScheduled, runPendingRestore,
} from "./backups.mjs";
import { HOME_KEY_FILE } from "./home-key.mjs";
import { isBackupCopyFolder, loadHomeSettings, resolveHomeSettings, writeHomeSettings } from "./settings.mjs";

const HOUR = 60 * 60_000;
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const configured = resolveHomeSettings({ format: 1, name: "fern.home.kin.journeytocode.io", acmeTermsAgreed: true }, {});

/** A data directory with a file database (its lock released, as restore
 * needs) and a fake `home/`. */
function fixture(t, { home = true } = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "kin-backups-"));
  const databasePath = join(dataDirectory, "kin.sqlite");
  const store = new DurableStore(databasePath, { acquireProcessLock: false });
  if (home) {
    mkdirSync(join(dataDirectory, "home"), { mode: 0o700 });
    writeFileSync(join(dataDirectory, "home", HOME_KEY_FILE), "synthetic home key\n", { mode: 0o600 });
    writeFileSync(join(dataDirectory, "home", "settings.json"), `${JSON.stringify({ format: 1, name: "fern.home.kin.journeytocode.io" })}\n`, { mode: 0o600 });
    writeFileSync(join(dataDirectory, "home", "control-sessions.json"), "{}\n", { mode: 0o600 });
  }
  let time = Date.parse("2026-10-25T12:00:00Z");
  const clock = { now: () => time, set: (value) => { time = value; }, advance: (ms) => { time += ms; } };
  let settings = configured;
  const restarts = [];
  const backups = new HomeBackups({
    store, dataDirectory, getSettings: () => settings, version: "1.6.0", now: clock.now,
    restart: (reason) => restarts.push(reason),
  });
  t.after(() => {
    backups.stop();
    try { store.close(); } catch { /* closed by the test */ }
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dataDirectory, databasePath, store, backups, clock, restarts, setSettings: (value) => { settings = value; } };
}

test("the schedule: the latest and next local hour", () => {
  const now = new Date(2026, 9, 25, 14, 30).getTime();
  assert.equal(lastScheduled(now, 3), new Date(2026, 9, 25, 3, 0).getTime());
  assert.equal(nextScheduled(now, 3), new Date(2026, 9, 26, 3, 0).getTime());
  const early = new Date(2026, 9, 25, 2, 59).getTime();
  assert.equal(lastScheduled(early, 3), new Date(2026, 9, 24, 3, 0).getTime());
  assert.equal(nextScheduled(early, 3), new Date(2026, 9, 25, 3, 0).getTime());
  const onTheHour = new Date(2026, 9, 25, 3, 0).getTime();
  assert.equal(lastScheduled(onTheHour, 3), onTheHour);
  assert.equal(nextScheduled(onTheHour, 3), new Date(2026, 9, 26, 3, 0).getTime());
});

test("a backup set holds the verified database, the home files and a manifest written last", async (t) => {
  const { dataDirectory, backups } = fixture(t);
  const set = await backups.create("manual");
  assert.equal(set.id, "kin-20261025T120000Z");
  const folder = join(backupsDirectory(dataDirectory), set.id);
  assert.deepEqual(readdirSync(folder).sort(), [BACKUP_MANIFEST, "home", "kin.sqlite"]);
  assert.deepEqual(readdirSync(join(folder, "home")).sort(), [HOME_KEY_FILE, "settings.json"], "the control panel's sessions stay on this computer");
  const manifest = JSON.parse(readFileSync(join(folder, BACKUP_MANIFEST), "utf8"));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.reason, "manual");
  assert.equal(manifest.version, "1.6.0");
  assert.ok(manifest.databaseBytes > 0);
  new DurableStore(join(folder, "kin.sqlite"), { acquireProcessLock: false, readonly: true }).close();
  // Two in the same second get their own folders.
  const again = await backups.create("manual");
  assert.equal(again.id, "kin-20261025T120000Z-2");
  // A folder without a manifest is unfinished, not a backup.
  mkdirSync(join(backupsDirectory(dataDirectory), "kin-20261025T110000Z"));
  assert.deepEqual(listBackups(backupsDirectory(dataDirectory)).map((entry) => entry.id), ["kin-20261025T120000Z-2", "kin-20261025T120000Z"]);
});

test("due: once a day at the chosen hour, catching up after a missed one, never before setup", async (t) => {
  const { backups, clock, setSettings } = fixture(t);
  setSettings(resolveHomeSettings(null, {}));
  assert.equal(backups.due(), false, "nothing to keep before setup");
  assert.equal(backups.status().state, "off");
  setSettings(configured);
  assert.equal(backups.due(), true, "no backup yet");
  clock.set(new Date(2026, 9, 25, 3, 0, 30).getTime());
  assert.ok(await backups.runIfDue());
  assert.equal(backups.due(), false);
  const status = backups.status();
  assert.equal(status.state, "ok");
  assert.equal(status.nextBackupAt, new Date(new Date(2026, 9, 26, 3, 0).getTime()).toISOString());
  clock.set(new Date(2026, 9, 26, 2, 59).getTime());
  assert.equal(backups.due(), false);
  // The computer was off at 03:00: the first check after it starts makes one.
  clock.set(new Date(2026, 9, 26, 9, 15).getTime());
  assert.equal(backups.due(), true);
  assert.equal(backups.status().due, true);
  // Another hour (home/settings.json backupHour).
  setSettings(resolveHomeSettings({ format: 1, name: "fern.home.kin.journeytocode.io", backupHour: 23 }, {}));
  assert.equal(backups.status().hour, 23);
  assert.equal(backups.due(), true, "yesterday's 23:00 came after the last backup (03:00)");
  assert.ok(await backups.runIfDue());
  assert.equal(backups.status().nextBackupAt, new Date(new Date(2026, 9, 26, 23, 0).getTime()).toISOString());
  assert.throws(() => resolveHomeSettings({ format: 1, backupHour: 24 }, {}), /0 to 23/);
});

test("the 14 newest sets are kept; other files in the folder are left alone", async (t) => {
  const { dataDirectory, backups, clock } = fixture(t);
  const directory = backupsDirectory(dataDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "my-own-notes.txt"), "a person's own file\n");
  mkdirSync(join(directory, "my-copy"));
  // An unfinished set left by a crash an hour and more ago.
  const stale = join(directory, "kin-20261001T030000Z");
  mkdirSync(stale);
  const old = new Date(clock.now() - 2 * HOUR);
  utimesSync(stale, old, old);
  const made = [];
  for (let day = 0; day < BACKUPS_KEPT + 2; day += 1) {
    made.push((await backups.create("scheduled")).id);
    clock.advance(24 * HOUR);
  }
  const kept = listBackups(directory).map((set) => set.id);
  assert.equal(kept.length, BACKUPS_KEPT);
  assert.deepEqual(kept, made.slice(2).reverse(), "the two oldest went");
  assert.ok(existsSync(join(directory, "my-own-notes.txt")));
  assert.ok(existsSync(join(directory, "my-copy")));
  assert.ok(!existsSync(stale), "the unfinished set went");
  assert.equal(backups.status().backups.length, BACKUPS_KEPT);
});

test("a failed backup leaves nothing behind, says why, and waits an hour before trying again", async (t) => {
  const { dataDirectory, backups, clock, store } = fixture(t);
  store.close();
  await assert.rejects(backups.create("scheduled"), { code: "backup-failed" });
  assert.deepEqual(listBackups(backupsDirectory(dataDirectory)), []);
  assert.deepEqual(readdirSync(backupsDirectory(dataDirectory)), [], "the folder was removed");
  const status = backups.status();
  assert.equal(status.state, "failed");
  assert.equal(status.lastError.code, "backup-failed");
  assert.equal(status.nextBackupAt, new Date(clock.now() + BACKUP_RETRY_MS).toISOString());
  assert.equal(backups.due(), false);
  clock.advance(BACKUP_RETRY_MS);
  assert.equal(backups.due(), true);
});

test("restore: checked first, then run by the next start, keeping the replaced database", async (t) => {
  const context = fixture(t);
  const { dataDirectory, databasePath, store, backups, restarts } = context;
  const pairing = new PairingService({ store });
  pairing.bootstrap({ credential: credential("backup-admin") });
  const set = await backups.create("manual");
  assert.throws(() => backups.checkRestore("kin-20200101T000000Z"), { code: "backup-unknown" });
  assert.throws(() => backups.checkRestore("../kin.sqlite"), { code: "backup-unknown" });
  const answer = await backups.requestRestore(set.id);
  assert.equal(answer.id, set.id);
  assert.deepEqual(restarts, ["restore"]);
  assert.equal(backups.status().state, "restoring");
  assert.equal(backups.due(), false, "no backups while a restore waits");
  await assert.rejects(backups.create("manual"), { code: "backup-restore-pending" });
  assert.ok(existsSync(join(backupsDirectory(dataDirectory), RESTORE_REQUEST)));
  // The service stops; the next start restores before opening the database.
  store.close();
  const events = [];
  const result = await runPendingRestore({ dataDirectory, databasePath, log: (event) => events.push(event) });
  assert.equal(result.outcome, "restored");
  assert.equal(result.backupCreatedAt, set.createdAt);
  assert.equal(result.homeRestored, false, "this computer's own home key stays");
  assert.deepEqual(events.map((event) => event.event), ["home_restore_finished"]);
  assert.ok(!existsSync(join(backupsDirectory(dataDirectory), RESTORE_REQUEST)), "asked once");
  assert.ok(readdirSync(dataDirectory).some((name) => name.startsWith("kin.sqlite.pre-restore-")), "the replaced database is kept");
  assert.equal(await runPendingRestore({ dataDirectory, databasePath }), null, "nothing more to do");
  const restored = new DurableStore(databasePath, { acquireProcessLock: false, readonly: true });
  restored.close();
  // The panel shows the outcome.
  const after = new HomeBackups({ store: null, dataDirectory, getSettings: () => configured, version: "1.6.0" });
  assert.equal(after.status().lastRestore.outcome, "restored");
});

test("restore refuses a backup that doesn't open, and one older than a household that exists now", async (t) => {
  const { dataDirectory, databasePath, store, backups } = fixture(t);
  const pairing = new PairingService({ store });
  const set = await backups.create("manual");
  pairing.bootstrap({ credential: credential("newer-admin") });
  // Damaged: the check fails before anything is asked for.
  const damaged = await backups.create("manual");
  writeFileSync(join(backupsDirectory(dataDirectory), damaged.id, "kin.sqlite"), "not a database");
  assert.throws(() => backups.checkRestore(damaged.id), { code: "backup-unreadable" });
  // Older than the household: the restore itself refuses, and Kin starts
  // with the database it has.
  await backups.requestRestore(set.id);
  store.close();
  const result = await runPendingRestore({ dataDirectory, databasePath });
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "restore-newer-household");
  assert.ok(!readdirSync(dataDirectory).some((name) => name.startsWith("kin.sqlite.pre-restore-")), "nothing was replaced");
  const result2 = JSON.parse(readFileSync(join(backupsDirectory(dataDirectory), RESTORE_RESULT), "utf8"));
  assert.equal(result2.code, "restore-newer-household");
  // A request naming no set fails the same way, without stopping the start.
  writeFileSync(join(backupsDirectory(dataDirectory), RESTORE_REQUEST), JSON.stringify({ format: 1, id: "kin-20200101T000000Z" }));
  assert.equal((await runPendingRestore({ dataDirectory, databasePath })).code, "backup-unknown");
});

test("on a new computer (no home key yet) a restore brings the home files: the same server and name", async (t) => {
  const source = fixture(t);
  const set = await source.backups.create("manual");
  source.store.close();
  // The new computer: an empty data directory with the set copied in.
  const target = fixture(t, { home: false });
  target.store.close();
  const copied = join(backupsDirectory(target.dataDirectory), set.id);
  mkdirSync(join(copied, "home"), { recursive: true });
  for (const name of [BACKUP_MANIFEST, "kin.sqlite"]) writeFileSync(join(copied, name), readFileSync(join(backupsDirectory(source.dataDirectory), set.id, name)));
  for (const name of [HOME_KEY_FILE, "settings.json"]) writeFileSync(join(copied, "home", name), readFileSync(join(backupsDirectory(source.dataDirectory), set.id, "home", name)));
  writeFileSync(join(backupsDirectory(target.dataDirectory), RESTORE_REQUEST), JSON.stringify({ format: 1, id: set.id }));
  const result = await runPendingRestore({ dataDirectory: target.dataDirectory, databasePath: target.databasePath });
  assert.equal(result.outcome, "restored");
  assert.equal(result.homeRestored, true);
  assert.equal(readFileSync(join(target.dataDirectory, "home", HOME_KEY_FILE), "utf8"), "synthetic home key\n");
  assert.match(readFileSync(join(target.dataDirectory, "home", "settings.json"), "utf8"), /fern\.home\.kin\.journeytocode\.io/);
});

test("the second backup folder: a full path on this kind of computer; a stored one that doesn't suit it never stops Kin", async (t) => {
  for (const good of ["E:\\", "E:\\Backups", "e:/Kin copies"]) assert.equal(isBackupCopyFolder(good, "win32"), true, good);
  for (const bad of ["E:", "E:foo", "\\\\nas\\share", "//nas/share", "\\Backups", "rel", "/media/usb", "E:\\a\0b", `E:\\${"a".repeat(1022)}`, "", 42, null])
    assert.equal(isBackupCopyFolder(bad, "win32"), false, String(bad).slice(0, 20));
  assert.equal(isBackupCopyFolder("/media/usb", "linux"), true);
  assert.equal(isBackupCopyFolder("/Volumes/KIN", "darwin"), true);
  for (const bad of ["media/usb", "E:\\Backups", "/media/\0usb"]) assert.equal(isBackupCopyFolder(bad, "linux"), false, bad);
  // Read leniently: a Windows path restored on Linux (or the reverse), or a
  // value that isn't a path at all, turns the copy off instead of stopping
  // Kin from starting.
  assert.equal(resolveHomeSettings({ format: 1, backupCopyFolder: "E:\\Backups" }, {}).backupCopyFolder, "E:\\Backups");
  assert.equal(resolveHomeSettings({ format: 1, backupCopyFolder: 7 }, {}).backupCopyFolder, null);
  assert.equal(resolveHomeSettings({ format: 1, backupCopyFolder: "x".repeat(1025) }, {}).backupCopyFolder, null);
  assert.equal(resolveHomeSettings(null, {}).backupCopyFolder, null);
  const { dataDirectory } = fixture(t);
  assert.equal((await writeHomeSettings(dataDirectory, { backupCopyFolder: "/media/usb" }, {})).backupCopyFolder, "/media/usb");
  assert.equal((await writeHomeSettings(dataDirectory, { backupCopyFolder: null }, {})).backupCopyFolder, null);
  assert.ok(!("backupCopyFolder" in JSON.parse(readFileSync(join(dataDirectory, "home", "settings.json"), "utf8"))), "null removes the field");
  writeFileSync(join(dataDirectory, "home", "settings.json"), JSON.stringify({ format: 1, name: "fern.home.kin.journeytocode.io", backupCopyFolder: { not: "a path" } }));
  assert.equal((await loadHomeSettings(dataDirectory, {})).backupCopyFolder, null);
  assert.equal((await writeHomeSettings(dataDirectory, { backupHour: 4 }, {})).backupHour, 4, "and other changes still save");
});

test("status shows the second copy as the launcher last wrote it, without the folder's path", (t) => {
  const { dataDirectory, backups, setSettings } = fixture(t);
  const folder = join(dataDirectory, "..", "usb");
  assert.deepEqual(backups.status().copy, { state: "off", kept: 14, lastCopyAt: null, lastCopiedCreatedAt: null, copies: 0, lastError: null, notPrivate: false });
  setSettings(resolveHomeSettings({ format: 1, name: "fern.home.kin.journeytocode.io", backupCopyFolder: folder }, {}));
  assert.equal(backups.status().copy.state, "waiting", "before the launcher has looked");
  const write = (value) => {
    mkdirSync(backupsDirectory(dataDirectory), { recursive: true });
    writeFileSync(join(backupsDirectory(dataDirectory), BACKUP_COPY_STATUS), JSON.stringify(value));
  };
  const written = { format: 1, state: "failed", folder, checkedAt: "2026-10-25T12:00:00.000Z", lastCopyAt: "2026-10-25T03:01:00.000Z", lastCopiedCreatedAt: "2026-10-25T03:00:00.000Z", copies: 3, lastError: { code: "backup-copy-full", at: "2026-10-25T12:00:00.000Z" } };
  write({ ...written, folder: "/somewhere/else" });
  assert.equal(backups.status().copy.state, "waiting", "the launcher hasn't looked at the folder now chosen");
  write(written);
  const copy = backups.status().copy;
  assert.deepEqual(copy, { state: "failed", kept: 14, lastCopyAt: written.lastCopyAt, lastCopiedCreatedAt: written.lastCopiedCreatedAt, copies: 3, lastError: written.lastError, notPrivate: false });
  assert.ok(!("folder" in copy));
  write({ ...written, state: "ok", lastError: null, notPrivate: true });
  assert.equal(backups.status().copy.notPrivate, true, "copies Kin couldn't make private are shown");
  write({ ...written, notPrivate: "yes" });
  assert.equal(backups.status().copy.notPrivate, false);
  assert.ok(!JSON.stringify(backups.status()).includes("usb"), "no path in the status");
  write({ ...written, format: 2 });
  assert.equal(backups.status().copy.state, "waiting", "a format this Kin doesn't know is ignored");
  setSettings(resolveHomeSettings({ format: 1, backupCopyFolder: folder }, {}));
  assert.equal(backups.status().copy.state, "off", "no copies before setup");
});
