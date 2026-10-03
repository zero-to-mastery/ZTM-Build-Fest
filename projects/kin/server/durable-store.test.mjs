import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireDatabaseProcessLock,
  DurableConflictError,
  DurableStore,
  DurableStoreError,
  hasDatabaseProcessLock,
} from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "kin-durable-store-"));
}

function createAcceptedEvent(store, credentialId = "durable-adult") {
  const pairing = new PairingService({ store });
  const identity = pairing.bootstrap({
    credential: {
      id: credentialId,
      publicKey: `key-${credentialId}`,
      algorithm: -7,
    },
    deviceLabel: "Durable test device",
  });
  const sync = new EncryptedSyncService(pairing, { store });
  const envelope = {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId: "a".repeat(32),
    householdId: identity.householdId,
    deviceId: identity.deviceId,
    deviceSequence: 1,
    logicalTime: "1",
    keyEpoch: 1,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    signature: Buffer.alloc(64, 3).toString("base64url"),
  };
  sync.push(identity.sessionToken, [envelope]);
  return { pairing, identity, sync, envelope };
}

test("failed v0-to-v1 migration rolls back and permits a clean retry", () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "kin.sqlite");
  try {
    assert.throws(
      () =>
        new DurableStore(databasePath, {
          migrationFault() {
            throw new Error("injected migration interruption");
          },
        }),
      DurableStoreError,
    );
    const inspection = new Database(databasePath);
    assert.equal(inspection.pragma("user_version", { simple: true }), 0);
    assert.deepEqual(
      inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all(),
      [],
    );
    inspection.close();

    const recovered = new DurableStore(databasePath);
    assert.equal(recovered.validate(), true);
    recovered.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a database with a newer schema fails closed without modification", () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "kin.sqlite");
  try {
    const database = new Database(databasePath);
    database.pragma("user_version = 2");
    database.close();

    assert.throws(
      () => new DurableStore(databasePath),
      /newer server version/,
    );
    const inspection = new Database(databasePath, { readonly: true });
    assert.equal(inspection.pragma("user_version", { simple: true }), 2);
    inspection.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt canonical relay data fails closed during bounded reads", () => {
  const store = new DurableStore(":memory:");
  try {
    const { identity } = createAcceptedEvent(store);
    store.db
      .prepare(
        "UPDATE sync_events SET canonical_envelope = ? WHERE household_id = ?",
      )
      .run("{}", identity.householdId);

    assert.throws(
      () => store.readEvents(identity.householdId, 0, 20, 1),
      DurableStoreError,
    );
    assert.equal(store.failed, true);
    assert.throws(() => store.health(), /storage is unavailable/);
  } finally {
    store.close();
  }
});

test("independent relay writers reject a stale cursor and can retry without restarting", () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "kin.sqlite");
  let firstStore;
  let secondStore;
  let inspection;
  try {
    firstStore = new DurableStore(databasePath, {
      acquireProcessLock: false,
    });
    const firstPairing = new PairingService({ store: firstStore });
    const adult = firstPairing.bootstrap({
      credential: { id: "writer-a", publicKey: "key-a", algorithm: -7 },
      deviceLabel: "Writer A",
    });
    const invitation = firstPairing.createPairing(adult.sessionToken);
    const claim = firstPairing.claimPairing({
      code: invitation.code,
      credential: { id: "writer-b", publicKey: "key-b", algorithm: -7 },
      deviceLabel: "Writer B",
    });
    firstPairing.approvePairing(
      adult.sessionToken,
      invitation.pairingId,
      claim.version,
    );
    const joined = firstPairing.activateClaim(claim.claimToken);

    secondStore = new DurableStore(databasePath, {
      acquireProcessLock: false,
    });
    const secondPairing = new PairingService({ store: secondStore });
    const secondIdentity = secondPairing.reauthenticate(
      joined.deviceToken,
      "writer-b",
    );
    const firstSync = new EncryptedSyncService(firstPairing, {
      store: firstStore,
    });
    const secondSync = new EncryptedSyncService(secondPairing, {
      store: secondStore,
    });
    firstSync.status(adult.sessionToken);
    secondSync.status(secondIdentity.sessionToken);

    const makeEnvelope = (identity, eventId) => ({
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
    });
    const firstAccepted = firstSync.push(adult.sessionToken, [
      makeEnvelope(adult, "a".repeat(32)),
    ]);
    assert.throws(
      () =>
        secondSync.push(secondIdentity.sessionToken, [
          makeEnvelope(joined, "b".repeat(32)),
        ]),
      (error) =>
        error instanceof DurableConflictError &&
        error.code === "sync_cursor_conflict",
    );
    assert.equal(secondStore.failed, false);
    assert.equal(secondStore.health(), true);
    assert.equal(secondStore.eventCount(adult.householdId), 1);
    assert.equal(
      secondSync.status(secondIdentity.sessionToken).latestCursor,
      firstAccepted.latestCursor,
    );
    assert.deepEqual(
      secondSync.push(secondIdentity.sessionToken, [
        makeEnvelope(joined, "b".repeat(32)),
      ]),
      { accepted: 1, latestCursor: "AAAAAAAAAAI", durable: true },
    );
    assert.deepEqual(
      secondSync
        .pull(secondIdentity.sessionToken)
        .events.map((event) => event.envelope.eventId),
      ["a".repeat(32), "b".repeat(32)],
    );

    secondStore.close();
    secondStore = undefined;
    firstStore.close();
    firstStore = undefined;
    inspection = new DurableStore(databasePath, {
      acquireProcessLock: false,
    });
    assert.equal(inspection.eventCount(adult.householdId), 2);
  } finally {
    inspection?.close();
    secondStore?.close();
    firstStore?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verified backup restores identity and opaque relay state offline", async () => {
  const directory = temporaryDirectory();
  const sourcePath = join(directory, "kin.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  const corruptBackupPath = join(directory, "corrupt-backup.sqlite");
  const targetPath = join(directory, "restored.sqlite");
  let source;
  let target;
  try {
    source = new DurableStore(sourcePath);
    const sourceState = createAcceptedEvent(source);
    assert.equal(await source.backup(backupPath), backupPath);
    await assert.rejects(
      source.backup(backupPath),
      /backup destination already exists/,
    );
    source.close();
    source = undefined;

    target = new DurableStore(targetPath);
    const previousState = createAcceptedEvent(target, "previous-adult");
    target.close();
    target = undefined;

    const releaseLock = acquireDatabaseProcessLock(targetPath);
    try {
      assert.equal(hasDatabaseProcessLock(targetPath), true);
      await assert.rejects(
        DurableStore.restoreBackup(backupPath, targetPath),
        /lock already exists/,
      );
    } finally {
      releaseLock();
    }

    copyFileSync(backupPath, corruptBackupPath);
    const corruptBackup = new Database(corruptBackupPath);
    corruptBackup
      .prepare(
        "UPDATE sync_events SET canonical_envelope = ? WHERE household_id = ?",
      )
      .run("{", sourceState.identity.householdId);
    corruptBackup.close();
    await assert.rejects(
      DurableStore.restoreBackup(corruptBackupPath, targetPath),
      /data is malformed/,
    );

    const restored = await DurableStore.restoreBackup(backupPath, targetPath);
    assert.ok(restored.previousDatabasePath);
    assert.equal(statSync(restored.previousDatabasePath).isFile(), true);
    target = new DurableStore(targetPath);
    assert.equal(target.validate(), true);
    const identity = target.loadIdentity();
    assert.ok(identity.members.has(sourceState.identity.memberId));
    assert.equal(identity.members.has(previousState.identity.memberId), false);
    const events = target.readEvents(
      sourceState.identity.householdId,
      0,
      20,
      1,
    );
    assert.deepEqual(events.events[0].envelope, sourceState.envelope);
  } finally {
    source?.close();
    target?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service lock is exclusive, released by its owner, and path-scoped", () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "kin.sqlite");
  try {
    const release = acquireDatabaseProcessLock(databasePath);
    assert.equal(hasDatabaseProcessLock(databasePath), true);
    assert.throws(
      () => acquireDatabaseProcessLock(databasePath),
      /lock already exists/,
    );
    release();
    assert.equal(hasDatabaseProcessLock(databasePath), false);
    const otherRelease = acquireDatabaseProcessLock(
      join(directory, "other.sqlite"),
    );
    otherRelease();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
