import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireDatabaseMaintenanceLock,
  acquireDatabaseProcessLock,
  DurableStore,
  HOUSEHOLD_DELETION_GRACE_MS,
  hasDatabaseMaintenanceLock,
  hasDatabaseProcessLock,
} from "./durable-store.mjs";
import { createKinServer } from "./server.mjs";
import { PairingService } from "./pairing-service.mjs";
import { resolveDurablePath, webRoot } from "./path-safety.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

function admin(databasePath, ...args) {
  return spawnSync(
    process.execPath,
    [join(import.meta.dirname, "admin.mjs"), ...args],
    {
      env: {
        ...process.env,
        KIN_DATABASE_PATH: databasePath,
        NODE_NO_WARNINGS: "1",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
}

function rejected(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must be outside the static web root/);
}

function directoryLink(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function acceptedEvent(identity, eventId) {
  return {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId,
    householdId: identity.householdId,
    deviceId: identity.deviceId,
    deviceSequence: 1,
    logicalTime: "1",
    keyEpoch: 1,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    signature: Buffer.alloc(64, 3).toString("base64url"),
  };
}

function createHousehold(store, suffix, eventId) {
  const service = new PairingService({ store });
  const identity = service.bootstrap({
    credential: {
      id: `admin-${suffix}-passkey`,
      publicKey: `admin-${suffix}-key`,
      algorithm: -7,
    },
    deviceLabel: `Admin ${suffix} fixture`,
  });
  const sync = new EncryptedSyncService(service, { store });
  sync.push(identity.sessionToken, [acceptedEvent(identity, eventId)]);
  return { service, identity };
}

function purge(databasePath, householdId) {
  return admin(
    databasePath,
    "household-purge",
    householdId,
    "--confirm-household-id",
    householdId,
  );
}

function status(databasePath, householdId) {
  const result = admin(databasePath, "household-status", householdId);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertPurgeSucceeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /was purged and its deletion tombstone was verified/);
}

test("admin permits verified backup and restore outside the web root", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-"));
  const source = join(directory, "kin.sqlite");
  const backup = join(directory, "new", "nested", "backup.sqlite");
  const restored = join(directory, "restore", "kin.sqlite");
  const store = new DurableStore(source);
  try {
    const result = admin(source, "backup", backup);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(store.health(), true);
    const restore = admin(
      restored,
      "restore",
      backup,
      "--acknowledge-deletion-history",
    );
    assert.ifError(restore.error);
    assert.equal(restore.status, 0, restore.stderr);
    const verification = new DurableStore(restored);
    try {
      assert.equal(verification.validate(), true);
    } finally {
      verification.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("admin explains why restore over pending deletion is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-pending-"));
  const databasePath = join(directory, "kin.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  const store = new DurableStore(databasePath);
  try {
    const service = new PairingService({ store });
    const identity = service.bootstrap({
      credential: { id: "pending-admin-passkey", publicKey: "pending-admin-key", algorithm: -7 },
      deviceLabel: "Pending deletion admin fixture",
    });
    await store.backup(backupPath);
    service.requestHouseholdDeletion(identity.sessionToken, identity.memberId);
    store.close();
    const result = admin(databasePath, "restore", backupPath, "--acknowledge-deletion-history");
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.trim(),
      "Cannot restore over a household with a pending deletion. Cancel the deletion using current household authority or allow it to finalize first.",
    );
    const verification = new DurableStore(databasePath);
    try {
      assert.equal(verification.lifecycleInfo(identity.householdId).state, "deletion_pending");
      assert.equal(verification.validate(), true);
    } finally {
      verification.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin force-purges exactly one confirmed household and verifies its tombstone", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const service = new PairingService({ store });
  const first = service.bootstrap({
    credential: {
      id: "purge-first-passkey",
      publicKey: "purge-first-key",
      algorithm: -7,
    },
    deviceLabel: "First purge fixture",
  });
  const second = service.bootstrap({
    credential: {
      id: "purge-second-passkey",
      publicKey: "purge-second-key",
      algorithm: -7,
    },
    deviceLabel: "Second purge fixture",
  });
  store.close();
  try {
    const mismatch = admin(
      databasePath,
      "household-purge",
      first.householdId,
      "--confirm-household-id",
      second.householdId,
    );
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /Usage:/);

    const result = admin(
      databasePath,
      "household-purge",
      first.householdId,
      "--confirm-household-id",
      first.householdId,
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /was purged and its deletion tombstone was verified/,
    );

    const verified = admin(
      databasePath,
      "household-verify-purged",
      first.householdId,
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).purged, true);

    const untouched = admin(
      databasePath,
      "household-status",
      second.householdId,
    );
    assert.equal(untouched.status, 0, untouched.stderr);
    const untouchedStatus = JSON.parse(untouched.stdout);
    assert.equal(untouchedStatus.state, "active");
    assert.equal(untouchedStatus.purged, false);
    assert.equal(untouchedStatus.counts.members, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin purge refuses malformed and unknown household IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-invalid-"));
  const databasePath = join(directory, "kin.sqlite");
  new DurableStore(databasePath).close();
  try {
    for (const householdId of ["not-an-id", "a".repeat(32)]) {
      const result = admin(
        databasePath,
        "household-purge",
        householdId,
        "--confirm-household-id",
        householdId,
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin purge refuses an occupied service lock without changing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-service-lock-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const { identity } = createHousehold(store, "service-lock", "1".repeat(32));
  const before = store.householdPurgeStatus(identity.householdId);
  try {
    const refused = purge(databasePath, identity.householdId);
    assert.ifError(refused.error);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /service or maintenance lock already exists/);
    assert.deepEqual(store.householdPurgeStatus(identity.householdId), before);
    assert.equal(hasDatabaseProcessLock(databasePath), true);
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
  } finally {
    store.close();
  }
  try {
    assertPurgeSucceeded(purge(databasePath, identity.householdId));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin purge refuses an occupied maintenance lock without changing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-maintenance-lock-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const { identity } = createHousehold(store, "maintenance-lock", "2".repeat(32));
  const before = store.householdPurgeStatus(identity.householdId);
  store.close();
  const releaseMaintenanceLock = acquireDatabaseMaintenanceLock(
    databasePath,
    "test-maintenance",
  );
  try {
    const refused = purge(databasePath, identity.householdId);
    assert.ifError(refused.error);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /service or maintenance lock already exists/);
    assert.deepEqual(status(databasePath, identity.householdId), before);
    assert.equal(hasDatabaseMaintenanceLock(databasePath), true);
    assert.equal(hasDatabaseProcessLock(databasePath), false);
  } finally {
    releaseMaintenanceLock();
  }
  try {
    assertPurgeSucceeded(purge(databasePath, identity.householdId));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed admin purge releases both locks and leaves all households unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-failed-locks-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const { identity } = createHousehold(store, "failed-locks", "3".repeat(32));
  const before = store.householdPurgeStatus(identity.householdId);
  store.close();
  try {
    const missing = "f".repeat(32);
    assert.notEqual(missing, identity.householdId);
    const refused = purge(databasePath, missing);
    assert.ifError(refused.error);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /household does not exist/);
    assert.equal(hasDatabaseMaintenanceLock(databasePath), false);
    assert.equal(hasDatabaseProcessLock(databasePath), false);
    assert.deepEqual(status(databasePath, identity.householdId), before);

    const releaseMaintenanceLock = acquireDatabaseMaintenanceLock(
      databasePath,
      "test-after-failure",
    );
    const releaseProcessLock = acquireDatabaseProcessLock(databasePath, {
      operation: "test-after-failure",
    });
    releaseProcessLock();
    releaseMaintenanceLock();
    assertPurgeSucceeded(purge(databasePath, identity.householdId));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin force-purges deletion-pending data while preserving another household", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-pending-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const first = createHousehold(store, "pending", "4".repeat(32));
  const second = createHousehold(store, "isolated", "5".repeat(32));
  const pending = first.service.requestHouseholdDeletion(
    first.identity.sessionToken,
    first.identity.memberId,
  );
  assert.equal(pending.state, "deletion_pending");
  assert.equal(
    pending.finalizeAt - pending.requestedAt,
    HOUSEHOLD_DELETION_GRACE_MS,
  );
  const untouchedBefore = store.householdPurgeStatus(second.identity.householdId);
  assert.equal(untouchedBefore.counts.events, 1);
  assert.equal(untouchedBefore.counts.members, 1);
  assert.equal(untouchedBefore.counts.credentials, 1);
  assert.equal(untouchedBefore.counts.devices, 1);
  assert.equal(untouchedBefore.counts.syncState, 1);
  store.close();
  try {
    assertPurgeSucceeded(purge(databasePath, first.identity.householdId));
    const deleted = status(databasePath, first.identity.householdId);
    assert.equal(deleted.state, "deleted");
    assert.equal(deleted.requestedAt, null);
    assert.equal(deleted.finalizeAt, null);
    assert.ok(Number.isSafeInteger(deleted.deletedAt));
    assert.equal(deleted.ownerRecorded, false);
    assert.deepEqual(
      deleted.counts,
      Object.fromEntries(Object.keys(deleted.counts).map((key) => [key, 0])),
    );
    assert.equal(deleted.purged, true);
    assert.deepEqual(
      status(databasePath, second.identity.householdId),
      untouchedBefore,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repeated admin purge preserves the original deletion tombstone", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-repeat-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const { identity } = createHousehold(store, "repeat", "6".repeat(32));
  store.close();
  try {
    assertPurgeSucceeded(purge(databasePath, identity.householdId));
    const tombstone = status(databasePath, identity.householdId);
    assertPurgeSucceeded(purge(databasePath, identity.householdId));
    assert.deepEqual(status(databasePath, identity.householdId), tombstone);
    const verified = admin(
      databasePath,
      "household-verify-purged",
      identity.householdId,
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), tombstone);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin verification distinguishes active, pending, purged, and missing households", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-verify-purge-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const active = createHousehold(store, "verify-active", "7".repeat(32));
  const pending = createHousehold(store, "verify-pending", "8".repeat(32));
  const deleted = createHousehold(store, "verify-deleted", "9".repeat(32));
  pending.service.requestHouseholdDeletion(
    pending.identity.sessionToken,
    pending.identity.memberId,
  );
  store.close();
  try {
    assertPurgeSucceeded(purge(databasePath, deleted.identity.householdId));
    for (const householdId of [
      active.identity.householdId,
      pending.identity.householdId,
    ]) {
      const result = admin(databasePath, "household-verify-purged", householdId);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /has not been fully purged/);
    }
    const verified = admin(
      databasePath,
      "household-verify-purged",
      deleted.identity.householdId,
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).purged, true);

    const missing = admin(
      databasePath,
      "household-verify-purged",
      "e".repeat(32),
    );
    assert.ifError(missing.error);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /household does not exist/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incomplete deleted-household data never verifies as purged", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-purge-incomplete-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  const { identity } = createHousehold(store, "incomplete", "a".repeat(32));
  store.close();
  try {
    assertPurgeSucceeded(purge(databasePath, identity.householdId));
    const fixture = new DurableStore(databasePath);
    fixture.db
      .prepare(
        `INSERT INTO security_audit
         (household_id, created_at, event_type, details_json)
         VALUES (?, ?, 'controlled_incomplete_purge', '{}')`,
      )
      .run(identity.householdId, Date.now());
    const incomplete = fixture.householdPurgeStatus(identity.householdId);
    assert.equal(incomplete.state, "deleted");
    assert.equal(incomplete.counts.securityAudit, 1);
    assert.equal(incomplete.purged, false);
    fixture.close();

    const verification = admin(
      databasePath,
      "household-verify-purged",
      identity.householdId,
    );
    assert.ifError(verification.error);
    assert.equal(verification.status, 1);
    assert.equal(verification.stdout, "");
    assert.doesNotMatch(verification.stderr, /"purged": true/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin and service reject the web root and all descendants before creating files", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-"));
  const source = join(directory, "kin.sqlite");
  const store = new DurableStore(source);
  try {
    for (const unsafe of [
      webRoot,
      join(webRoot, "backup.sqlite"),
      join(webRoot, "missing-admin-subdir", "backup.sqlite"),
    ]) {
      rejected(admin(source, "backup", unsafe));
      rejected(
        admin(source, "restore", unsafe, "--acknowledge-deletion-history"),
      );
      rejected(
        admin(unsafe, "restore", source, "--acknowledge-deletion-history"),
      );
      rejected(admin(unsafe, "backup", join(directory, "backup.sqlite")));
      assert.throws(
        () => createKinServer({ databasePath: unsafe }),
        /outside the static web root/,
      );
    }
    assert.equal(existsSync(join(webRoot, "missing-admin-subdir")), false);
    assert.equal(existsSync(join(directory, "backup.sqlite")), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin and service resolve symlinked ancestors even before nested directories exist", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-admin-links-"));
  const alias = join(directory, "public-alias");
  const source = join(directory, "kin.sqlite");
  const store = new DurableStore(source);
  try {
    directoryLink(webRoot, alias);
    for (const unsafe of [
      alias,
      join(alias, "index.html"),
      join(alias, "backup.sqlite"),
      join(alias, "missing-admin-parent", "child", "backup.sqlite"),
    ]) {
      rejected(admin(source, "backup", unsafe));
      rejected(
        admin(source, "restore", unsafe, "--acknowledge-deletion-history"),
      );
      rejected(
        admin(unsafe, "restore", source, "--acknowledge-deletion-history"),
      );
      assert.throws(
        () => createKinServer({ databasePath: unsafe }),
        /outside the static web root/,
      );
    }
    assert.equal(existsSync(join(webRoot, "missing-admin-parent")), false);
    const privateDirectory = join(directory, "private");
    mkdirSync(privateDirectory);
    const privateAlias = join(directory, "private-alias");
    directoryLink(privateDirectory, privateAlias);
    assert.equal(
      resolveDurablePath(join(privateAlias, "new", "kin.sqlite")),
      join(realpathSync(privateDirectory), "new", "kin.sqlite"),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("static routes cannot serve durable state through traversal or symlink aliases", async () => {
  // A sibling whose name begins with 'web' catches unsafe string-prefix guards.
  const directory = mkdtempSync(join(webRoot, "..", "web-private-test-"));
  const linkDirectory = mkdtempSync(join(webRoot, "static-safety-test-"));
  const source = join(directory, "kin.sqlite");
  const backup = join(directory, "backup.sqlite");
  const app = createKinServer({ databasePath: source });
  let releaseMaintenanceLock;
  try {
    await app.store.backup(backup);
    releaseMaintenanceLock = acquireDatabaseMaintenanceLock(source, "backup");
    directoryLink(directory, join(linkDirectory, "private"));
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const name = directory.split(/[\\/]/).at(-1);
    const linkName = linkDirectory.split(/[\\/]/).at(-1);
    for (const file of [
      "kin.sqlite",
      "backup.sqlite",
      "kin.sqlite-wal",
      "kin.sqlite-shm",
      "kin.sqlite.service.lock",
      "kin.sqlite.maintenance.lock",
    ]) {
      assert.equal(existsSync(join(directory, file)), true, file);
      for (const path of [
        `/${file}`,
        `/%2e%2e%2f${name}/${file}`,
        `/%2e%2e%5c${name}/${file}`,
        `/${linkName}/private/${file}`,
      ]) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 404, path);
        assert.equal(await response.text(), "Not found");
      }
    }
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/readiness`)).status, 200);
  } finally {
    if (app.server.listening)
      await new Promise((resolve) => app.server.close(resolve));
    releaseMaintenanceLock?.();
    app.store.close();
    rmSync(linkDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
