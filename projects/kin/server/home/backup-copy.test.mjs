// The copy of each backup to a second folder (ADR 0025 §10, #763): what is
// copied and in what order, keeping 14, the folders Kin refuses, failures
// that leave nothing behind, and one copy at a time. Another disk and a full
// drive are stand-ins (the `files` seam), never real drives.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { BackupCopier, COPIES_FOLDER, copyFileFlushed, copyFolderFor, currentAccountSid, parseAccountSid, protectArguments, protectFolder } from "./backup-copy.mjs";
import { BACKUPS_KEPT, BACKUP_COPY_ERROR_CODES, BACKUP_COPY_STATUS, BACKUP_MANIFEST, backupsDirectory, listBackups, makeBackupSet } from "./backups.mjs";
import { HOME_KEY_FILE } from "./home-key.mjs";

const NAME = "fern.home.kin.journeytocode.io";
const HOUR = 60 * 60_000;

/**
 * A data directory with a home folder and settings naming `folder` (by
 * default an empty folder beside it, `chosen`), and a clock. `makeSet()`
 * makes a backup set with a small stand-in database.
 */
function fixture(t, { folder, name = NAME } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kin-backup-copy-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const dataDirectory = join(root, "data");
  const chosen = join(root, "usb");
  mkdirSync(join(dataDirectory, "home"), { recursive: true });
  mkdirSync(chosen);
  writeFileSync(join(dataDirectory, "home", HOME_KEY_FILE), "synthetic home key\n");
  const settings = (value) => writeFileSync(join(dataDirectory, "home", "settings.json"), `${JSON.stringify({ format: 1, ...(name ? { name } : {}), ...(value ? { backupCopyFolder: value } : {}) })}\n`);
  settings(folder === undefined ? chosen : folder);
  let time = Date.parse("2026-10-25T03:00:00Z");
  const clock = { now: () => time, advance: (ms) => { time += ms; } };
  let made = 0;
  const makeSet = async () => {
    made += 1;
    const set = await makeBackupSet({
      dataDirectory, version: "1.6.0", reason: "scheduled", now: clock.now,
      copyDatabase: async (destination) => { writeFileSync(destination, `synthetic database ${made}\n`.repeat(100)); return destination; },
    });
    clock.advance(24 * HOUR);
    return set;
  };
  return { root, dataDirectory, chosen, copies: join(chosen, COPIES_FOLDER, name ?? "none"), clock, makeSet, settings };
}

/** A `realpath` for stand-in paths with no links. */
const same = async (path) => path;

/** A `stat` that puts everything under `root` on another disk. */
const otherDisk = (root) => async (path) => {
  const info = await stat(path);
  if (!path.startsWith(root)) return info;
  return { ...info, dev: info.dev + 1, isDirectory: () => info.isDirectory() };
};

/** A copier for `context`; the Windows permissions are a stand-in unless a
 * test asks for them. */
function copier(context, { files = {}, events = [], platform } = {}) {
  return new BackupCopier({ dataDirectory: context.dataDirectory, env: {}, now: context.clock.now, log: (event) => events.push(event), ...(platform ? { platform } : {}), files: { stat: otherDisk(context.chosen), protect: async () => {}, ...files } });
}

async function writtenStatus(instance, context) {
  await instance.written;
  return JSON.parse(readFileSync(join(backupsDirectory(context.dataDirectory), BACKUP_COPY_STATUS), "utf8"));
}

const systemError = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

test("each finished set is copied into Kin backups/<name>/, newest first, verified, with backup.json last", async (t) => {
  const context = fixture(t);
  const older = await context.makeSet();
  const newer = await context.makeSet();
  const order = [];
  const events = [];
  const instance = copier(context, { events, files: { copyFile: async (source, destination) => { order.push(source); return copyFileFlushed(source, destination); } } });
  assert.deepEqual(await instance.sync(), { state: "ok", copied: 2, removed: 0 });
  assert.equal(context.copies, copyFolderFor(context.chosen, NAME));
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), [newer.id, older.id]);
  for (const set of [older, newer]) {
    const from = join(backupsDirectory(context.dataDirectory), set.id);
    const to = join(context.copies, set.id);
    assert.deepEqual(readFileSync(join(to, "kin.sqlite")), readFileSync(join(from, "kin.sqlite")));
    assert.deepEqual(readdirSync(join(to, "home")).sort(), [HOME_KEY_FILE, "settings.json"]);
    assert.equal(readFileSync(join(to, BACKUP_MANIFEST), "utf8"), readFileSync(join(from, BACKUP_MANIFEST), "utf8"));
  }
  // Newest first; in each set the database first and the manifest last.
  assert.ok(order[0].includes(newer.id));
  for (const id of [newer.id, older.id]) {
    const files = order.filter((source) => source.includes(id)).map((source) => basename(source));
    assert.deepEqual(files, ["kin.sqlite", HOME_KEY_FILE, "settings.json", BACKUP_MANIFEST]);
  }
  const status = await writtenStatus(instance, context);
  assert.equal(status.format, 1);
  assert.equal(status.state, "ok");
  assert.equal(status.folder, context.chosen);
  assert.equal(status.copies, 2);
  assert.equal(status.lastCopiedCreatedAt, newer.createdAt);
  assert.equal(status.lastError, null);
  assert.deepEqual(events, [{ event: "home_backup_copied", copied: 2, removed: 0 }], "counts, never a path");
  // Nothing new: the next minute's look doesn't copy.
  assert.equal(instance.due(), false);
  await context.makeSet();
  assert.equal(instance.due(), true, "a newer set is due");
});

test("the 14 newest are kept; only Kin's own folders are touched", async (t) => {
  const context = fixture(t);
  writeFileSync(join(context.chosen, "holiday-photos.txt"), "the person's own file\n");
  const other = join(context.chosen, COPIES_FOLDER, "other.home.kin.journeytocode.io", "kin-20200101T000000Z");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, BACKUP_MANIFEST), JSON.stringify({ format: 1, createdAt: "2020-01-01T00:00:00.000Z" }));
  mkdirSync(join(context.copies, "kin-notaset"), { recursive: true });
  writeFileSync(join(context.copies, "my-notes.txt"), "notes\n");
  const made = [];
  for (let n = 0; n < BACKUPS_KEPT; n += 1) made.push((await context.makeSet()).id);
  const instance = copier(context);
  assert.equal((await instance.sync()).copied, BACKUPS_KEPT);
  for (let n = 0; n < 2; n += 1) made.push((await context.makeSet()).id);
  assert.deepEqual(await instance.sync(), { state: "ok", copied: 2, removed: 2 });
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), made.slice(2).reverse(), "the two oldest went");
  assert.ok(existsSync(join(context.chosen, "holiday-photos.txt")));
  assert.ok(existsSync(join(other, BACKUP_MANIFEST)), "another home server's copies on the same drive stay");
  assert.ok(existsSync(join(context.copies, "kin-notaset")));
  assert.ok(existsSync(join(context.copies, "my-notes.txt")));
  assert.equal((await writtenStatus(instance, context)).copies, BACKUPS_KEPT);
});

test("a missing folder is reported and never made; once it exists the next minute's look copies", async (t) => {
  const context = fixture(t);
  const missing = join(context.root, "unplugged");
  context.settings(missing);
  await context.makeSet();
  const events = [];
  const instance = copier(context, { events, files: { stat: otherDisk(missing) } });
  assert.deepEqual(await instance.sync(), { state: "failed", code: "backup-copy-missing" });
  assert.ok(!existsSync(missing), "Kin never makes the chosen folder");
  const status = await writtenStatus(instance, context);
  assert.equal(status.state, "failed");
  assert.equal(status.lastError.code, "backup-copy-missing");
  // Looked at every minute, logged once.
  assert.equal(instance.due(), true);
  await instance.tick();
  assert.equal(events.filter((event) => event.event === "home_backup_copy_failed").length, 1);
  assert.deepEqual(events[0], { event: "home_backup_copy_failed", code: "backup-copy-missing", reason: "ENOENT" });
  mkdirSync(missing);
  context.clock.advance(60_000);
  assert.equal((await instance.tick()).state, "ok");
  assert.equal(listBackups(join(missing, COPIES_FOLDER, NAME)).length, 1);
  assert.equal((await writtenStatus(instance, context)).lastError, null);
});

test("a folder on the same disk as the data directory is refused, and nothing is written there", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  const instance = new BackupCopier({ dataDirectory: context.dataDirectory, env: {}, now: context.clock.now });
  assert.deepEqual(await instance.sync(), { state: "failed", code: "backup-copy-same-disk" });
  assert.deepEqual(readdirSync(context.chosen), []);
  // A path that isn't a full path on this computer (settings restored from
  // another kind of computer) is refused the same way as a missing one.
  context.settings(process.platform === "win32" ? "/media/usb" : "E:\\Backups");
  assert.equal((await instance.sync()).code, "backup-copy-missing");
});

test("each problem has its code; a full drive is found before anything is written", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  const events = [];
  const failing = (code) => async (path) => { if (path.startsWith(context.chosen)) throw systemError(code); return stat(path); };
  const codeWith = async (files) => (await copier(context, { events, files }).sync()).code;
  assert.equal(await codeWith({ stat: failing("ENOTDIR") }), "backup-copy-not-folder");
  for (const code of ["EACCES", "EPERM", "EROFS"]) assert.equal(await codeWith({ stat: failing(code) }), "backup-copy-denied", code);
  assert.equal(await codeWith({ stat: failing("EIO") }), "backup-copy-failed");
  assert.equal(await codeWith({ statfs: async () => ({ bavail: 1, bsize: 4096 }) }), "backup-copy-full");
  assert.deepEqual(readdirSync(context.copies), [], "nothing was written");
  assert.equal(await codeWith({ copyFile: async () => { throw systemError("ENOSPC"); } }), "backup-copy-full");
  assert.equal(await codeWith({ copyFile: async () => { throw systemError("EFBIG"); } }), "backup-copy-too-big");
  assert.equal(await codeWith({ copyFile: async () => { throw systemError("EIO"); } }), "backup-copy-failed");
  assert.deepEqual(readdirSync(context.copies), [], "a failed copy leaves no folder");
  // A file where the folder should be.
  const file = join(context.root, "a-file");
  writeFileSync(file, "not a folder\n");
  context.settings(file);
  assert.equal((await copier(context, { events, files: { stat: otherDisk(file) } }).sync()).code, "backup-copy-not-folder");
  for (const event of events) assert.ok(BACKUP_COPY_ERROR_CODES.includes(event.code), event.code);
  assert.ok(!JSON.stringify(events).includes(context.root), "the log holds no path");
});

test("a copy that fails half-way leaves nothing behind, and an unfinished one is copied again", async (t) => {
  const context = fixture(t);
  const older = await context.makeSet();
  const newer = await context.makeSet();
  // The newer set copies; the older one fails between its files.
  const halfway = copier(context, { files: { copyFile: async (source, destination) => {
    if (source.includes(older.id) && source.includes("home")) throw systemError("EIO");
    return copyFileFlushed(source, destination);
  } } });
  assert.equal((await halfway.sync()).code, "backup-copy-failed");
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), [newer.id], "the copy that worked stays");
  assert.ok(!existsSync(join(context.copies, older.id)), "the half-made copy went");
  // A copy that doesn't read back as the original is removed too.
  const damaged = copier(context, { files: { copyFile: async (source, destination) => {
    const copied = await copyFileFlushed(source, destination);
    if (basename(source) === "kin.sqlite") appendFileSync(destination, "x");
    return copied;
  } } });
  assert.equal((await damaged.sync()).code, "backup-copy-failed");
  assert.ok(!existsSync(join(context.copies, older.id)));
  // A folder left without its manifest (Kin stopped mid-copy) is unfinished.
  mkdirSync(join(context.copies, older.id));
  writeFileSync(join(context.copies, older.id, "kin.sqlite"), "half");
  assert.equal((await copier(context).sync()).copied, 1);
  assert.deepEqual(readFileSync(join(context.copies, older.id, "kin.sqlite")), readFileSync(join(backupsDirectory(context.dataDirectory), older.id, "kin.sqlite")));
});

test("a set the service removes during the copy is skipped, not reported", async (t) => {
  const context = fixture(t);
  const older = await context.makeSet();
  const newer = await context.makeSet();
  const events = [];
  const instance = copier(context, { events, files: { copyFile: async (source, destination) => {
    if (source.includes(older.id)) rmSync(join(backupsDirectory(context.dataDirectory), older.id), { recursive: true, force: true });
    return copyFileFlushed(source, destination);
  } } });
  assert.deepEqual(await instance.sync(), { state: "ok", copied: 1, removed: 0 });
  assert.deepEqual(listBackups(context.copies).map((set) => set.id), [newer.id]);
  assert.ok(!existsSync(join(context.copies, older.id)));
  assert.ok(!events.some((event) => event.event === "home_backup_copy_failed"));
});

test("no folder or no name: off, and nothing outside the data directory is looked at; a folder chosen later is picked up", async (t) => {
  for (const options of [{ folder: null }, { name: null }]) {
    const context = fixture(t, options);
    await context.makeSet();
    const looked = [];
    const instance = copier(context, { files: { stat: async (path) => { looked.push(path); return stat(path); } } });
    assert.deepEqual(await instance.sync(), { state: "off" });
    assert.equal(instance.due(), false);
    assert.deepEqual(looked.filter((path) => !path.startsWith(context.dataDirectory)), [], JSON.stringify(options));
    assert.ok(!existsSync(join(backupsDirectory(context.dataDirectory), BACKUP_COPY_STATUS)), "off from the start: nothing to write");
  }
  const context = fixture(t, { folder: null });
  await context.makeSet();
  const instance = copier(context);
  await instance.sync();
  context.settings(context.chosen);
  assert.equal(instance.due(), true, "the folder changed");
  assert.equal((await instance.tick()).state, "ok");
  const status = await writtenStatus(instance, context);
  assert.equal(status.folder, context.chosen);
  assert.equal(status.copies, 1);
  // Turned off again: said once.
  context.settings(null);
  assert.equal(instance.due(), true);
  await instance.tick();
  assert.equal((await writtenStatus(instance, context)).state, "off");
  assert.equal(instance.due(), false);
});

test("one look at a time: a backup made during a copy is copied by the next run, never alongside", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const copying = new Promise((resolve) => { reached = resolve; });
  let active = 0;
  let most = 0;
  let first = true;
  const events = [];
  const instance = copier(context, { events, files: { copyFile: async (source, destination) => {
    active += 1;
    most = Math.max(most, active);
    try {
      if (first) { first = false; reached(); await held; }
      return await copyFileFlushed(source, destination);
    } finally {
      active -= 1;
    }
  } } });
  const running = instance.sync();
  await copying;
  assert.equal((await writtenStatus(instance, context)).state, "copying");
  const later = await context.makeSet();
  instance.backupMade();
  instance.backupMade();
  assert.equal(await instance.tick(), null, "the minute's look waits for the copy under way");
  release();
  await running;
  assert.equal(most, 1, "never two copies at once");
  assert.deepEqual(events.map((event) => event.copied), [1, 1], "two runs, one after the other");
  assert.equal(listBackups(context.copies)[0].id, later.id);
  const status = await writtenStatus(instance, context);
  assert.equal(status.state, "ok");
  assert.equal(status.copies, 2);
});

test("stopping: a copy under way stops after its file and leaves no half copy", async (t) => {
  const context = fixture(t);
  const set = await context.makeSet();
  let instance;
  instance = copier(context, { files: { copyFile: async (source, destination) => {
    const copied = await copyFileFlushed(source, destination);
    instance.stop();
    return copied;
  } } });
  assert.deepEqual(await instance.sync(), { state: "stopped" });
  assert.ok(!existsSync(join(context.copies, set.id)));
});

test("after a good copy, the minute's look notices a drive unplugged, another drive plugged in at the same place, and copies deleted", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  await context.makeSet();
  const instance = copier(context);
  assert.equal((await instance.sync()).copied, 2);
  assert.equal(await instance.tick(), null, "nothing changed: nothing copied");
  rmSync(context.chosen, { recursive: true, force: true });
  assert.deepEqual(await instance.tick(), { state: "failed", code: "backup-copy-missing" });
  // Another, empty drive at the same place gets every set within a minute.
  mkdirSync(context.chosen);
  context.clock.advance(60_000);
  assert.deepEqual(await instance.tick(), { state: "ok", copied: 2, removed: 0 });
  rmSync(join(context.chosen, COPIES_FOLDER), { recursive: true, force: true });
  assert.deepEqual(await instance.tick(), { state: "ok", copied: 2, removed: 0 });
  assert.equal(await instance.tick(), null);
});

test("a drive pulled out during a write is looked for every minute, and copied to once it is back", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  const disk = otherDisk(context.chosen);
  let plugged = true;
  let pulls = 1;
  const events = [];
  const instance = copier(context, { events, files: {
    stat: async (path) => { if (!plugged && path.startsWith(context.chosen)) throw systemError("ENOENT"); return disk(path); },
    copyFile: async (source, destination) => {
      if (pulls > 0) { pulls -= 1; plugged = false; throw systemError("EIO"); }
      return copyFileFlushed(source, destination);
    },
  } });
  assert.deepEqual(await instance.sync(), { state: "failed", code: "backup-copy-missing" });
  assert.deepEqual(events, [{ event: "home_backup_copy_failed", code: "backup-copy-missing", reason: "EIO" }]);
  plugged = true;
  context.clock.advance(60_000);
  assert.equal(instance.due(), true, "not an hour later");
  assert.deepEqual(await instance.tick(), { state: "ok", copied: 1, removed: 0 });
});

test("a folder changed or cleared during a copy gets no more sets after the one under way", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  await context.makeSet();
  const second = join(context.root, "usb2");
  mkdirSync(second);
  const drives = async (path) => {
    const info = await stat(path);
    return path.startsWith(context.chosen) || path.startsWith(second) ? { ...info, dev: info.dev + 1, isDirectory: () => info.isDirectory() } : info;
  };
  let change = () => context.settings(second);
  const instance = copier(context, { files: { stat: drives, copyFile: async (source, destination) => {
    const now = change;
    change = () => {};
    now();
    return copyFileFlushed(source, destination);
  } } });
  assert.deepEqual(await instance.sync(), { state: "ok", copied: 2, removed: 0 }, "the run starts again with the new folder");
  assert.equal(listBackups(context.copies).length, 1, "the old folder got only the set under way");
  assert.equal(listBackups(join(second, COPIES_FOLDER, NAME)).length, 2);
  const status = await writtenStatus(instance, context);
  assert.equal(status.folder, second);
  assert.equal(status.copies, 2);
  // Cleared during a copy: the copy is off, and nothing more is written.
  context.settings(context.chosen);
  await context.makeSet();
  change = () => context.settings(null);
  assert.deepEqual(await instance.sync(), { state: "off" });
  assert.equal(listBackups(context.copies).length, 2, "one of the two missing sets");
  assert.equal((await writtenStatus(instance, context)).state, "off");
});

test("outside Windows, an empty mount point under /mnt is reported as missing, even with the data directory on its own partition", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  context.settings("/mnt/kinusb");
  // Nothing mounted: /mnt/kinusb is on the same partition as /mnt, and /mnt
  // on the same partition as /.
  const stats = async (path) => (["/mnt/kinusb", "/mnt", "/"].includes(path) ? { dev: 7, isDirectory: () => true } : { ...(await stat(path)), dev: 8 });
  const made = [];
  const instance = copier(context, { platform: "linux", files: { stat: stats, realpath: same, mkdir: async (path) => { made.push(path); } } });
  assert.deepEqual(await instance.sync(), { state: "failed", code: "backup-copy-missing" });
  assert.deepEqual(made, [], "nothing made on the empty mount point");
});

test("outside Windows, a drive mounted at /mnt itself is used, and a drive mounted under it too", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  // The drive is /mnt (an fstab line mounting it there): /mnt and the folder
  // on it are on the drive's partition, / on another.
  for (const [folder, devs] of [["/mnt/kin-backups", { "/mnt/kin-backups": 9, "/mnt": 9, "/": 7 }], ["/mnt/usb", { "/mnt/usb": 9, "/mnt": 7, "/": 7 }]]) {
    context.settings(folder);
    const stats = async (path) => (path in devs ? { dev: devs[path], isDirectory: () => true } : { ...(await stat(path)), dev: 8 });
    const made = [];
    // The copies folder is never really made under /mnt: a stand-in that
    // refuses, which shows the folder itself was accepted.
    const instance = copier(context, { platform: "linux", files: { stat: stats, realpath: same, mkdir: async (path) => { made.push(path); throw systemError("EROFS"); } } });
    assert.deepEqual(await instance.sync(), { state: "failed", code: "backup-copy-denied" }, folder);
    assert.deepEqual(made, [`${folder}/${COPIES_FOLDER}/${NAME}`], folder);
  }
});

test("outside Windows, the folder directly under the mount area decides: empty on a Mac or under /media is missing, a drive mounted there is used", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  // On a Mac /Volumes can be on another partition than / (7 and 6 here)
  // with nothing mounted at it, so it never counts as a drive itself.
  // Under /media and /run/media the drive is two levels down, at
  // <you>/<label>.
  const cases = [
    ["darwin", "/Volumes/USB", { "/Volumes/USB": 7, "/Volumes": 7, "/": 6 }, "backup-copy-missing"],
    ["darwin", "/Volumes/USB/backups", { "/Volumes/USB/backups": 7, "/Volumes/USB": 7, "/Volumes": 7, "/": 6 }, "backup-copy-missing"],
    ["darwin", "/Volumes/USB", { "/Volumes/USB": 9, "/Volumes": 7, "/": 6 }, "backup-copy-denied"],
    ["darwin", "/Volumes/USB/backups", { "/Volumes/USB/backups": 9, "/Volumes/USB": 9, "/Volumes": 7, "/": 6 }, "backup-copy-denied"],
    ["linux", "/mnt/kin-backups", { "/mnt/kin-backups": 9, "/mnt": 9, "/": 7 }, "backup-copy-denied"],
    ["linux", "/mnt/usb", { "/mnt/usb": 7, "/mnt": 7, "/": 7 }, "backup-copy-missing"],
    ["linux", "/media/sam/KINUSB", { "/media/sam/KINUSB": 9, "/media/sam": 7, "/media": 7, "/": 7 }, "backup-copy-denied"],
    ["linux", "/media/sam/KINUSB", { "/media/sam/KINUSB": 7, "/media/sam": 7, "/media": 7, "/": 7 }, "backup-copy-missing"],
    ["linux", "/run/media/sam/KINUSB/backups", { "/run/media/sam/KINUSB/backups": 9, "/run/media/sam/KINUSB": 9, "/run/media/sam": 7, "/run/media": 7, "/run": 7, "/": 7 }, "backup-copy-denied"],
    ["linux", "/run/media/sam/KINUSB/backups", { "/run/media/sam/KINUSB/backups": 7, "/run/media/sam/KINUSB": 7, "/run/media/sam": 7, "/run/media": 7, "/run": 7, "/": 7 }, "backup-copy-missing"],
  ];
  for (const [platform, folder, devs, code] of cases) {
    context.settings(folder);
    const stats = async (path) => (path in devs ? { dev: devs[path], isDirectory: () => true } : { ...(await stat(path)), dev: 8 });
    const made = [];
    // A stand-in that refuses to make the copies folder: denied shows the
    // folder itself was accepted.
    const instance = copier(context, { platform, files: { stat: stats, realpath: same, mkdir: async (path) => { made.push(path); throw systemError("EROFS"); } } });
    const label = `${platform} ${folder} ${JSON.stringify(devs)}`;
    assert.deepEqual(await instance.sync(), { state: "failed", code }, label);
    assert.deepEqual(made, code === "backup-copy-missing" ? [] : [`${folder}/${COPIES_FOLDER}/${NAME}`], label);
  }
});

test("outside Windows, the mount area is found on the folder's real path: a link to an empty mount point, a linked /media, or /volumes typed in lower case on a Mac", async (t) => {
  const context = fixture(t);
  await context.makeSet();
  // `real` stands in for realpath (links followed, the case the disk
  // holds); `stat` follows links, so the folder as typed has its target's
  // partition.
  const cases = [
    // /srv/kin-backups links to /mnt/usb, an fstab mount point with the drive unplugged.
    ["linux", "/srv/kin-backups", "/mnt/usb", { "/srv/kin-backups": 7, "/mnt/usb": 7, "/mnt": 7, "/": 7 }, "backup-copy-missing"],
    ["linux", "/srv/kin-backups", "/mnt/usb", { "/srv/kin-backups": 9, "/mnt/usb": 9, "/mnt": 7, "/": 7 }, "backup-copy-denied"],
    // Fedora Silverblue: /media links to /run/media, on tmpfs (5), while / is 7.
    ["linux", "/media/usb", "/run/media/usb", { "/media/usb": 5, "/run/media/usb": 5, "/media": 5, "/run/media": 5, "/run": 5, "/": 7 }, "backup-copy-missing"],
    ["linux", "/media/usb", "/run/media/usb", { "/media/usb": 9, "/run/media/usb": 9, "/media": 5, "/run/media": 5, "/run": 5, "/": 7 }, "backup-copy-denied"],
    // A Mac's disk ignores case: /volumes/USB is /Volumes/USB.
    ["darwin", "/volumes/USB", "/Volumes/USB", { "/volumes/USB": 7, "/Volumes/USB": 7, "/Volumes": 7, "/": 6 }, "backup-copy-missing"],
    ["darwin", "/volumes/USB", "/Volumes/USB", { "/volumes/USB": 9, "/Volumes/USB": 9, "/Volumes": 7, "/": 6 }, "backup-copy-denied"],
  ];
  for (const [platform, folder, real, devs, code] of cases) {
    context.settings(folder);
    const stats = async (path) => (path in devs ? { dev: devs[path], isDirectory: () => true } : { ...(await stat(path)), dev: 8 });
    const made = [];
    const instance = copier(context, { platform, files: { stat: stats, realpath: async (path) => (path === folder ? real : path), mkdir: async (path) => { made.push(path); throw systemError("EROFS"); } } });
    const label = `${platform} ${folder} -> ${real} ${JSON.stringify(devs)}`;
    assert.deepEqual(await instance.sync(), { state: "failed", code }, label);
    // A folder accepted is still used by the path the person gave.
    assert.deepEqual(made, code === "backup-copy-missing" ? [] : [`${folder}/${COPIES_FOLDER}/${NAME}`], label);
  }
});

test("on Windows, the copies folder lets in SYSTEM, Administrators, the owner, the service's account and the account Kin runs as, by SID, never through a shell", async () => {
  assert.equal(parseAccountSid('"desktop-fern\\sam","S-1-5-21-1004336348-1177238915-682003330-1001"\r\n'), "S-1-5-21-1004336348-1177238915-682003330-1001");
  assert.equal(parseAccountSid('"nt authority\\local service","S-1-5-19"'), "S-1-5-19");
  for (const output of ["", "ERROR: no", '"sam","S-1-5-21; del *"', null]) assert.equal(parseAccountSid(output), null, String(output));
  const folder = "E:\\Kin backups\\fern & co";
  const grants = (account) => protectArguments(folder, account).slice(3);
  assert.deepEqual(protectArguments(folder, "S-1-5-21-1-2-3-1001").slice(0, 3), [folder, "/inheritance:r", "/grant:r"], "the path is one argument of its own");
  assert.deepEqual(grants("S-1-5-21-1-2-3-1001"), ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-3-4:(OI)(CI)F", "*S-1-5-19:(OI)(CI)F", "*S-1-5-21-1-2-3-1001:(OI)(CI)F"]);
  assert.deepEqual(grants("S-1-5-19"), grants(null), "running as the service: LOCAL SERVICE once");
  assert.deepEqual(grants("S-1-5-21:(OI)(CI)F /T"), grants(null), "anything but a SID is left out");
  if (process.platform === "win32") assert.match(await currentAccountSid(), /^S-1-5-\d+(-\d+)*$/);
});

test("on Windows, Kin's copies folder is given private permissions: when made, once per launcher, and again on another drive", { skip: process.platform !== "win32" && "Windows permissions" }, async (t) => {
  const context = fixture(t);
  await context.makeSet();
  const given = [];
  const events = [];
  const instance = copier(context, { platform: "win32", events, files: { protect: async (folder) => { given.push(folder); } } });
  await instance.sync();
  await context.makeSet();
  await instance.sync();
  assert.deepEqual(given, [context.copies], "once");
  rmSync(context.chosen, { recursive: true, force: true });
  mkdirSync(context.chosen);
  await instance.sync();
  assert.deepEqual(given, [context.copies, context.copies], "a folder made anew");
  // A drive that holds no permissions (exFAT) is copied to all the same.
  rmSync(context.chosen, { recursive: true, force: true });
  mkdirSync(context.chosen);
  // An NTFS folder whose permissions Kin may not change fails the same way.
  let refuse = true;
  const tried = [];
  const unprotected = copier(context, { platform: "win32", events, files: { protect: async (folder) => { tried.push(folder); if (refuse) throw systemError("EINVAL"); } } });
  assert.equal((await unprotected.sync()).state, "ok");
  assert.deepEqual(events.filter((event) => event.event === "home_backup_copy_not_private"), [{ event: "home_backup_copy_not_private", reason: "EINVAL" }]);
  let status = await writtenStatus(unprotected, context);
  assert.equal(status.state, "ok");
  assert.equal(status.notPrivate, true, "the panel says the copies aren't private");
  // Tried again at the next look, not marked done; logged once.
  await context.makeSet();
  await unprotected.sync();
  assert.equal(tried.length, 2, "tried again");
  assert.equal(events.filter((event) => event.event === "home_backup_copy_not_private").length, 1, "logged once");
  assert.equal((await writtenStatus(unprotected, context)).notPrivate, true);
  // A copier started later reads it back, and clears it once it works.
  refuse = false;
  const later = copier(context, { platform: "win32", events, files: { protect: unprotected.files.protect } });
  assert.equal(later.state.notPrivate, true);
  await context.makeSet();
  await later.sync();
  status = await writtenStatus(later, context);
  assert.equal(status.notPrivate, false);
  await context.makeSet();
  await later.sync();
  assert.equal(tried.length, 3, "once it worked, once per launcher");
  // The real permissions: no one but SYSTEM, Administrators and the owner.
  const real = join(context.root, "real");
  mkdirSync(join(real, "kin-x"), { recursive: true });
  await protectFolder(real);
  const file = join(real, "kin-x", "kin.sqlite");
  writeFileSync(file, "synthetic\n");
  const acl = execFileSync("icacls", [file], { encoding: "utf8", windowsHide: true }).replace(file, "");
  assert.doesNotMatch(acl, /\bUsers\b|Everyone|Authenticated/, acl);
  assert.match(acl, /OWNER RIGHTS|S-1-3-4/, acl);
  assert.match(acl, /LOCAL SERVICE|S-1-5-19/, acl);
  const account = execFileSync("whoami", { encoding: "utf8", windowsHide: true }).trim();
  assert.ok(acl.toLowerCase().includes(`${account.toLowerCase()}:`) || acl.includes(await currentAccountSid()), `the account Kin runs as (${account}) by name: ${acl}`);
  assert.equal(readFileSync(file, "utf8"), "synthetic\n", "Kin's own account can still read it");
});
