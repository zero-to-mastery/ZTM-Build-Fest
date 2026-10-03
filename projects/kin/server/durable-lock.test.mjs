import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acquireDatabaseMaintenanceLock,
  acquireDatabaseProcessLock,
  databaseLockPath,
  databaseMaintenanceLockPath,
  DurableStore,
  DurableStoreError,
  hasDatabaseMaintenanceLock,
  hasDatabaseProcessLock,
} from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "kin-durable-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, databasePath: join(directory, "kin.sqlite") };
}

function assertRecoveryGuidance(error, lockPath) {
  assert.ok(error instanceof DurableStoreError);
  assert.equal(error.code, "durable_lock_exists");
  assert.ok(error.message.includes(JSON.stringify(lockPath)));
  assert.match(error.message, /PID, operation and start time/);
  assert.match(error.message, /no Kin service, backup or restore operation/);
  assert.match(error.message, /Only after confirming all such processes have stopped/);
  assert.match(error.message, /remove this lock file manually and retry/);
  assert.match(error.message, /Never remove an active lock/);
  return true;
}

test("another service process refuses an owned lock and starts after release", (t) => {
  const { databasePath } = temporaryDatabase(t);
  const store = new DurableStore(databasePath);
  try {
    const refused = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./server.mjs", import.meta.url))],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          KIN_DATABASE_PATH: databasePath,
          KIN_PORT: "0",
          KIN_HOST: "127.0.0.1",
          KIN_ORIGIN: "http://localhost:8000",
        },
      },
    );
    assert.ifError(refused.error);
    assert.equal(refused.status, 1);
    const failure = JSON.parse(refused.stderr.trim());
    assert.equal(failure.event, "startup_failed");
    assert.ok(failure.message.includes(JSON.stringify(databaseLockPath(databasePath))));
    assert.match(failure.message, /remove this lock file manually and retry/);
    assert.equal(hasDatabaseProcessLock(databasePath), true);
  } finally {
    store.close();
  }

  assert.equal(hasDatabaseProcessLock(databasePath), false);
  const started = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createKinServer } from ${JSON.stringify(new URL("./server.mjs", import.meta.url).href)};
       const app = createKinServer({ databasePath: process.argv[1], origin: "http://localhost:8000", host: "127.0.0.1" });
       app.store.validate();
       app.store.close();`,
      databasePath,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(started.error);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(hasDatabaseProcessLock(databasePath), false);
});

for (const [kind, lockPathFor, acquire] of [
  ["service", databaseLockPath, acquireDatabaseProcessLock],
  ["maintenance", databaseMaintenanceLockPath, acquireDatabaseMaintenanceLock],
]) {
  test(`${kind} stale locks remain untouched and report manual recovery guidance`, (t) => {
    const { databasePath } = temporaryDatabase(t);
    const lockPath = lockPathFor(databasePath);
    const contents = JSON.stringify({
      pid: 2_147_483_647,
      token: "synthetic-orphaned-owner",
      operation: kind === "service" ? "service" : "restore",
      startedAt: 1,
    });
    writeFileSync(lockPath, contents, { flag: "wx" });
    assert.throws(
      () => acquire(databasePath),
      (error) => assertRecoveryGuidance(error, lockPath),
    );
    assert.equal(readFileSync(lockPath, "utf8"), contents);
    assert.equal(existsSync(databasePath), false);
  });
}

test("a previous owner cannot release a subsequent owner's lock", (t) => {
  const { databasePath } = temporaryDatabase(t);
  const releasePrevious = acquireDatabaseProcessLock(databasePath);
  releasePrevious();
  const releaseCurrent = acquireDatabaseProcessLock(databasePath);
  try {
    releasePrevious();
    assert.equal(hasDatabaseProcessLock(databasePath), true);
  } finally {
    releaseCurrent();
  }
  assert.equal(hasDatabaseProcessLock(databasePath), false);
});

test("online backup preserves service use and excludes competing admin operations", async (t) => {
  const { directory, databasePath } = temporaryDatabase(t);
  const destination = join(directory, "backup.sqlite");
  const store = new DurableStore(databasePath);
  let backup;
  try {
    const pairing = new PairingService({ store });
    const identity = pairing.bootstrap({
      credential: { id: "online-backup", publicKey: "key", algorithm: -7 },
      deviceLabel: "Online backup test",
    });
    const ownedServiceLock = readFileSync(databaseLockPath(databasePath), "utf8");
    backup = DurableStore.createBackup(databasePath, destination);
    assert.equal(hasDatabaseMaintenanceLock(databasePath), true);
    await assert.rejects(
      DurableStore.createBackup(databasePath, join(directory, "other.sqlite")),
      /lock already exists/,
    );
    await assert.rejects(
      DurableStore.restoreBackup(join(directory, "unused.sqlite"), databasePath),
      /lock already exists/,
    );
    assert.equal(await backup, destination);
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
    assert.equal(readFileSync(databaseLockPath(databasePath), "utf8"), ownedServiceLock);
    assert.equal(store.validate(), true);
    const verified = new DurableStore(destination);
    try {
      assert.equal(verified.validate(), true);
      assert.ok(verified.loadIdentity().members.has(identity.memberId));
    } finally {
      verified.close();
    }
    await assert.rejects(
      DurableStore.createBackup(databasePath, destination),
      /backup destination already exists/,
    );
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
    assert.equal(readFileSync(databaseLockPath(databasePath), "utf8"), ownedServiceLock);
  } finally {
    await backup?.catch(() => {});
    store.close();
  }
});

test("restore refuses a service-owned database and cleans up only its own lock", async (t) => {
  const { directory, databasePath } = temporaryDatabase(t);
  const store = new DurableStore(databasePath);
  try {
    const ownedServiceLock = readFileSync(databaseLockPath(databasePath), "utf8");
    await assert.rejects(
      DurableStore.restoreBackup(join(directory, "unused.sqlite"), databasePath),
      (error) => assertRecoveryGuidance(error, databaseLockPath(databasePath)),
    );
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
    assert.equal(readFileSync(databaseLockPath(databasePath), "utf8"), ownedServiceLock);
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("restore excludes startup and other admin operations then releases both locks", async (t) => {
  const { directory, databasePath } = temporaryDatabase(t);
  const sourcePath = join(directory, "source.sqlite");
  new DurableStore(databasePath).close();
  new DurableStore(sourcePath).close();
  const restore = DurableStore.restoreBackup(sourcePath, databasePath);
  try {
    assert.equal(hasDatabaseMaintenanceLock(databasePath), true);
    assert.equal(hasDatabaseProcessLock(databasePath), true);
    assert.throws(() => new DurableStore(databasePath), /lock already exists/);
    await assert.rejects(
      DurableStore.restoreBackup(sourcePath, databasePath),
      /lock already exists/,
    );
    await assert.rejects(
      DurableStore.createBackup(databasePath, join(directory, "blocked.sqlite")),
      /lock already exists/,
    );
    const result = await restore;
    assert.ok(existsSync(result.previousDatabasePath));
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
    assert.equal(hasDatabaseProcessLock(databasePath), false);
    const restarted = new DurableStore(databasePath);
    try {
      assert.equal(restarted.validate(), true);
    } finally {
      restarted.close();
    }
  } finally {
    await restore.catch(() => {});
  }
});

test("failed restore preserves its target and releases both acquired locks", async (t) => {
  const { directory, databasePath } = temporaryDatabase(t);
  new DurableStore(databasePath).close();
  const previous = readFileSync(databasePath);
  const invalidSource = join(directory, "invalid.sqlite");
  writeFileSync(invalidSource, "not a SQLite database");
  await assert.rejects(
    DurableStore.restoreBackup(invalidSource, databasePath),
    DurableStoreError,
  );
  assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
  assert.equal(hasDatabaseProcessLock(databasePath), false);
  assert.deepEqual(readFileSync(databasePath), previous);
  assert.deepEqual(readdirSync(directory).sort(), ["invalid.sqlite", "kin.sqlite"]);
  const restarted = new DurableStore(databasePath);
  try {
    assert.equal(restarted.validate(), true);
  } finally {
    restarted.close();
  }
});

test("backup failure removes partial output and releases its maintenance lock", async (t) => {
  const { directory, databasePath } = temporaryDatabase(t);
  const store = new DurableStore(databasePath);
  const destination = join(directory, "backup.sqlite");
  const originalBackup = store.db.backup;
  try {
    store.db.backup = async (temporary) => {
      writeFileSync(temporary, "partial backup");
      throw new Error("injected backup write failure");
    };
    await assert.rejects(store.backup(destination), /could not create a verified backup/);
    assert.equal(existsSync(destination), false);
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
    assert.equal(hasDatabaseProcessLock(databasePath), true);
    store.db.backup = originalBackup;
    assert.equal(await store.backup(destination), destination);
  } finally {
    store.db.backup = originalBackup;
    store.close();
  }
});

for (const kind of ["missing", "directory", "newer-schema", "empty"]) {
  test(`restore rejects a ${kind} source without changing source or target`, async (t) => {
    const { directory, databasePath } = temporaryDatabase(t);
    const sourcePath = join(directory, "source.sqlite");
    new DurableStore(databasePath).close();
    const previous = readFileSync(databasePath);
    if (kind === "directory") mkdirSync(sourcePath);
    if (kind === "empty") writeFileSync(sourcePath, "");
    if (kind === "newer-schema") {
      const source = new Database(sourcePath);
      source.pragma("user_version = 2");
      source.close();
    }
    const sourceBytes = ["newer-schema", "empty"].includes(kind)
      ? readFileSync(sourcePath)
      : null;
    await assert.rejects(
      DurableStore.restoreBackup(sourcePath, databasePath),
      DurableStoreError,
    );
    assert.deepEqual(readFileSync(databasePath), previous);
    if (sourceBytes) assert.deepEqual(readFileSync(sourcePath), sourceBytes);
    if (kind === "missing") assert.equal(existsSync(sourcePath), false);
    if (kind === "directory") assert.deepEqual(readdirSync(sourcePath), []);
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
    assert.equal(hasDatabaseProcessLock(databasePath), false);
    assert.equal(readdirSync(directory).some((name) => name.includes(".restore")), false);
    assert.equal(readdirSync(directory).some((name) => name.includes(".pre-restore-")), false);
  });
}

test("restore preserves the old database and its recoverable WAL/SHM sidecars", async (t) => {
  const { directory, databasePath } = temporaryDatabase(t);
  const sourcePath = join(directory, "source.sqlite");
  new DurableStore(sourcePath).close();
  const previousStore = new DurableStore(databasePath);
  let previousIdentity;
  let previousFiles;
  try {
    previousIdentity = new PairingService({ store: previousStore }).bootstrap({
      credential: { id: "previous-wal", publicKey: "previous-key", algorithm: -7 },
      deviceLabel: "Preserved WAL test",
    });
    previousFiles = new Map(
      ["", "-wal", "-shm"].map((suffix) => [
        suffix,
        readFileSync(`${databasePath}${suffix}`),
      ]),
    );
    assert.ok(previousFiles.get("-wal").length > 32);
  } finally {
    previousStore.close();
  }
  // Recreate an offline, committed database snapshot with uncheckpointed WAL.
  for (const [suffix, bytes] of previousFiles)
    writeFileSync(`${databasePath}${suffix}`, bytes);

  const result = await DurableStore.restoreBackup(sourcePath, databasePath);
  assert.ok(result.previousDatabasePath);
  for (const [suffix, bytes] of previousFiles)
    assert.deepEqual(readFileSync(`${result.previousDatabasePath}${suffix}`), bytes);
  assert.equal(existsSync(`${databasePath}-wal`), false);
  assert.equal(existsSync(`${databasePath}-shm`), false);
  const preserved = new DurableStore(result.previousDatabasePath);
  try {
    assert.equal(preserved.validate(), true);
    assert.ok(preserved.loadIdentity().members.has(previousIdentity.memberId));
  } finally {
    preserved.close();
  }
  const restored = new DurableStore(databasePath);
  try {
    assert.equal(restored.validate(), true);
    assert.equal(restored.loadIdentity().members.size, 0);
  } finally {
    restored.close();
  }
});
