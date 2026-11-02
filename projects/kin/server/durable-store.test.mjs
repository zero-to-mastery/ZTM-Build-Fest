import assert from "node:assert/strict";
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
import { canParticipate, PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { openTestDatabase, sqlitePragma } from "./sqlite-test-utils.mjs";
import { canonicalEventEnvelope } from "./sync-contract.mjs";

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

for (const path of ["event commit", "binding save"]) {
  test(`durable ${path} rejects non-canonical envelopes before writing`, () => {
    const store = new DurableStore(":memory:");
    try {
      const { pairing, identity, sync, envelope } = createAcceptedEvent(store);
      const invalid = {
        ...envelope, eventId: "b".repeat(32), deviceSequence: 2, logicalTime: "2",
        signature: `${envelope.signature.slice(0, -1)}B`,
      };
      const canonical = canonicalEventEnvelope(invalid);
      if (path === "event commit") {
        assert.throws(() => store.commitEvents(identity.householdId, 2, identity.deviceId, 1,
          [{ envelope: invalid, canonical }]), DurableStoreError);
      } else {
        const state = sync.state(identity.householdId);
        state.bindings.set(invalid.eventId, { envelope: invalid, canonical });
        assert.throws(() => store.saveSyncState(identity.householdId, state, pairing), DurableStoreError);
      }
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sync_events").get().count, 1);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sync_bindings").get().count, 0);
    } finally {
      store.close();
    }
  });
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
    const inspection = openTestDatabase(databasePath);
    assert.equal(sqlitePragma(inspection, "user_version", { simple: true }), 0);
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

test("server schema v1 upgrades transactionally through the household move schema v30", () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "kin.sqlite");
  try {
    new DurableStore(databasePath).close();
    const legacy = openTestDatabase(databasePath);
    try {
      legacy.exec(`
        DROP TABLE household_moves;
        DELETE FROM server_migrations WHERE version = 30;
        DROP TABLE calendar_subscriptions;
        DELETE FROM server_migrations WHERE version = 29;
        ALTER TABLE households DROP COLUMN chore_adults_revision;
        ALTER TABLE households DROP COLUMN chore_adults;
        DELETE FROM server_migrations WHERE version = 28;
        DROP TABLE prepared_invitations;
        DELETE FROM server_migrations WHERE version = 27;
        DROP TABLE feedback_screenshots;
        DROP TABLE feedback;
        DELETE FROM server_migrations WHERE version = 26;
        ALTER TABLE households DROP COLUMN features_revision;
        ALTER TABLE households DROP COLUMN features_off;
        DELETE FROM server_migrations WHERE version = 25;
        DROP TABLE private_blobs;
        DELETE FROM server_migrations WHERE version = 24;
        DROP INDEX members_active_username;
        ALTER TABLE members DROP COLUMN username;
        DELETE FROM server_migrations WHERE version = 23;
        DROP TABLE private_events;
        DROP TABLE private_device_sequences;
        DROP TABLE private_relay_state;
        ALTER TABLE households DROP COLUMN private_policy_revision;
        ALTER TABLE households DROP COLUMN private_limited;
        DELETE FROM server_migrations WHERE version = 22;
        DROP TABLE account_vault_wrappers;
        DROP TABLE account_vaults;
        DROP TABLE account_passwords;
        DELETE FROM server_migrations WHERE version = 21;
        ALTER TABLE members DROP COLUMN simple_view;
        DELETE FROM server_migrations WHERE version = 20;
        ALTER TABLE households DROP COLUMN board_policy_revision;
        ALTER TABLE households DROP COLUMN board_temporary;
        ALTER TABLE households DROP COLUMN board_limited;
        DELETE FROM server_migrations WHERE version = 19;
        DROP TABLE board_events;
        DROP TABLE board_device_sequences;
        DROP TABLE board_relay_state;
        DELETE FROM server_migrations WHERE version = 18;
        DROP TABLE chat_key_packages;
        ALTER TABLE households DROP COLUMN chat_key_since;
        ALTER TABLE households DROP COLUMN chat_key_epoch;
        DELETE FROM server_migrations WHERE version = 17;
        ALTER TABLE households DROP COLUMN chat_policy_revision;
        ALTER TABLE households DROP COLUMN chat_temporary;
        ALTER TABLE households DROP COLUMN chat_limited;
        DELETE FROM server_migrations WHERE version = 16;
        DROP TABLE chat_receipts;
        DELETE FROM server_migrations WHERE version = 15;
        DROP TABLE chat_hidden;
        DELETE FROM server_migrations WHERE version = 14;
        DROP TABLE chat_events;
        DROP TABLE chat_device_sequences;
        DROP TABLE chat_relay_state;
        DELETE FROM server_migrations WHERE version = 13;
        DROP TABLE chat_blobs;
        DROP TABLE chat_blob_claims;
        DROP TABLE chat_blob_usage;
        DELETE FROM server_migrations WHERE version = 12;
        DROP TABLE push_subscriptions;
        DROP TABLE push_vapid_keys;
        DELETE FROM server_migrations WHERE version = 11;
        DROP TABLE household_install_identity;
        DROP TABLE household_install_identity_revisions;
        DELETE FROM server_migrations WHERE version = 10;
        DELETE FROM server_migrations WHERE version = 9;
        ALTER TABLE members DROP COLUMN household_admin;
        DELETE FROM server_migrations WHERE version = 8;
        DROP TABLE household_settings;
        ALTER TABLE households DROP COLUMN owner_member_id;
        DELETE FROM server_migrations WHERE version = 7;
        DROP TRIGGER members_active_household_insert;
        DROP TRIGGER devices_active_household_insert;
        DROP TRIGGER sync_households_active_household_insert;
        DROP TRIGGER sync_events_active_household_insert;
        DROP TRIGGER sync_bindings_active_household_insert;
        DROP TRIGGER provisioning_grants_active_household_insert;
        DROP TRIGGER members_temporary_expiry_insert;
        DROP TRIGGER members_temporary_expiry_update;
        DROP TABLE sync_attachments;
        ALTER TABLE members DROP COLUMN member_status;
        ALTER TABLE members DROP COLUMN expires_at;
        ALTER TABLE members DROP COLUMN kind;
        DELETE FROM server_migrations WHERE version = 4;
        DELETE FROM server_migrations WHERE version = 3;
        DELETE FROM server_migrations WHERE version = 5;
        DELETE FROM server_migrations WHERE version = 6;
        ALTER TABLE households DROP COLUMN deleted_at;
        ALTER TABLE households DROP COLUMN deletion_finalize_at;
        ALTER TABLE households DROP COLUMN deletion_requested_at;
        ALTER TABLE households DROP COLUMN lifecycle_state;
        DELETE FROM server_migrations WHERE version = 2;
      `);
      sqlitePragma(legacy, "user_version = 1");
    } finally {
      legacy.close();
    }
    const migrated = new DurableStore(databasePath);
    try {
      assert.equal(sqlitePragma(migrated.db, "user_version", { simple: true }), 30);
      assert.deepEqual(
        migrated.db
          .prepare("SELECT version FROM server_migrations ORDER BY version")
          .all()
          .map(({ version }) => version),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
      );
      assert.equal(migrated.validate(), true);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("server identity reload preserves Limited and expired Temporary membership", () => {
  const store = new DurableStore(":memory:");
  try {
    const first = new PairingService({ store, now: () => 5_000_000 });
    const adult = first.bootstrap({ credential: { id: "membership-adult", publicKey: "key-adult", algorithm: -7 }, deviceLabel: "Adult device" });
    const household = first.households.get(adult.householdId);
    const limitedId = "a".repeat(32);
    const temporaryId = "b".repeat(32);
    const activeTemporaryId = "c".repeat(32);
    const removedTemporaryId = "d".repeat(32);
    first.members.set(limitedId, { id: limitedId, householdId: adult.householdId, active: true, kind: "limited", credentials: new Set() });
    first.members.set(temporaryId, { id: temporaryId, householdId: adult.householdId, active: true, kind: "temporary", expiresAt: 4_000_000, credentials: new Set() });
    first.members.set(activeTemporaryId, { id: activeTemporaryId, householdId: adult.householdId, active: true, kind: "temporary", expiresAt: 6_000_000, credentials: new Set() });
    first.members.set(removedTemporaryId, { id: removedTemporaryId, householdId: adult.householdId, active: false, memberStatus: "removed", kind: "temporary", expiresAt: 4_500_000, credentials: new Set() });
    household.members.add(limitedId);
    household.members.add(temporaryId);
    household.members.add(activeTemporaryId);
    household.members.add(removedTemporaryId);
    first.expireTemporaryMemberships(5_000_000);
    store.saveIdentityHousehold(adult.householdId, first);

    const reloaded = new PairingService({ store, now: () => 5_000_000 });
    assert.equal(reloaded.members.get(limitedId).kind, "limited");
    assert.equal(reloaded.members.get(temporaryId).kind, "temporary");
    assert.equal(reloaded.members.get(temporaryId).expiresAt, 4_000_000);
    assert.equal(reloaded.members.get(temporaryId).memberStatus, "expired");
    assert.equal(canParticipate(reloaded.members.get(temporaryId), 5_000_000), false);
    assert.equal(reloaded.members.get(activeTemporaryId).kind, "temporary");
    assert.equal(reloaded.members.get(activeTemporaryId).expiresAt, 6_000_000);
    assert.equal(canParticipate(reloaded.members.get(activeTemporaryId), 5_000_000), true);
    assert.equal(reloaded.members.get(removedTemporaryId).memberStatus, "removed");
    assert.equal(canParticipate(reloaded.members.get(removedTemporaryId), 5_000_000), false);
    const authority = store.loadActiveAuthority()[0];
    assert.equal(authority.members.find((row) => row.id === limitedId).kind, "limited");
    assert.equal(authority.members.find((row) => row.id === temporaryId).expires_at, 4_000_000);
    assert.equal(authority.members.find((row) => row.id === activeTemporaryId).expires_at, 6_000_000);
  } finally {
    store.close();
  }
});

test("a database with a newer schema fails closed without modification", () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "kin.sqlite");
  try {
    const database = openTestDatabase(databasePath);
    sqlitePragma(database, "user_version = 999");
    database.close();

    assert.throws(
      () => new DurableStore(databasePath),
      /newer server version/,
    );
    const inspection = openTestDatabase(databasePath, { readonly: true });
    assert.equal(sqlitePragma(inspection, "user_version", { simple: true }), 999);
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
    target.close();
    target = undefined;

    const releaseLock = acquireDatabaseProcessLock(targetPath);
    try {
      assert.equal(hasDatabaseProcessLock(targetPath), true);
      await assert.rejects(
        DurableStore.restoreBackup(backupPath, targetPath, {
          acknowledgeDeletionHistory: true,
        }),
        /lock already exists/,
      );
    } finally {
      releaseLock();
    }

    copyFileSync(backupPath, corruptBackupPath);
    const corruptBackup = openTestDatabase(corruptBackupPath);
    corruptBackup
      .prepare(
        "UPDATE sync_events SET canonical_envelope = ? WHERE household_id = ?",
      )
      .run("{", sourceState.identity.householdId);
    corruptBackup.close();
    await assert.rejects(
      DurableStore.restoreBackup(corruptBackupPath, targetPath, {
        acknowledgeDeletionHistory: true,
      }),
      /data is malformed/,
    );

    const restored = await DurableStore.restoreBackup(backupPath, targetPath, {
      acknowledgeDeletionHistory: true,
    });
    assert.ok(restored.previousDatabasePath);
    assert.equal(statSync(restored.previousDatabasePath).isFile(), true);
    target = new DurableStore(targetPath);
    assert.equal(target.validate(), true);
    assert.equal(target.lifecycleInfo(sourceState.identity.householdId).state, "active");
    const identity = target.loadIdentity();
    assert.ok(identity.members.has(sourceState.identity.memberId));
    assert.ok(identity.devices.has(sourceState.identity.deviceId));
    assert.ok(identity.credentials.has("durable-adult"));
    assert.equal(identity.members.size, 1);
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

test("household admins persist across restart and the v8 migration promotes only a recorded owner", () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "kin.sqlite");
  try {
    const store = new DurableStore(databasePath);
    const first = new PairingService({ store });
    const owned = first.bootstrap({ credential: { id: "admin-owner", publicKey: "key-owner", algorithm: -7 }, deviceLabel: "Owner" });
    const ownerless = first.bootstrap({ credential: { id: "admin-legacy", publicKey: "key-legacy", algorithm: -7 }, deviceLabel: "Legacy" });
    store.close();

    // Simulate a v7 database: the admin column is absent and one household
    // predates recorded ownership.
    const legacy = openTestDatabase(databasePath);
    try {
      legacy.exec(`
        DROP TABLE household_moves;
        DELETE FROM server_migrations WHERE version = 30;
        DROP TABLE calendar_subscriptions;
        DELETE FROM server_migrations WHERE version = 29;
        ALTER TABLE households DROP COLUMN chore_adults_revision;
        ALTER TABLE households DROP COLUMN chore_adults;
        DELETE FROM server_migrations WHERE version = 28;
        DROP TABLE prepared_invitations;
        DELETE FROM server_migrations WHERE version = 27;
        DROP TABLE feedback_screenshots;
        DROP TABLE feedback;
        DELETE FROM server_migrations WHERE version = 26;
        ALTER TABLE households DROP COLUMN features_revision;
        ALTER TABLE households DROP COLUMN features_off;
        DELETE FROM server_migrations WHERE version = 25;
        DROP TABLE private_blobs;
        DELETE FROM server_migrations WHERE version = 24;
        DROP INDEX members_active_username;
        ALTER TABLE members DROP COLUMN username;
        DELETE FROM server_migrations WHERE version = 23;
        DROP TABLE private_events;
        DROP TABLE private_device_sequences;
        DROP TABLE private_relay_state;
        ALTER TABLE households DROP COLUMN private_policy_revision;
        ALTER TABLE households DROP COLUMN private_limited;
        DELETE FROM server_migrations WHERE version = 22;
        DROP TABLE account_vault_wrappers;
        DROP TABLE account_vaults;
        DROP TABLE account_passwords;
        DELETE FROM server_migrations WHERE version = 21;
        ALTER TABLE members DROP COLUMN simple_view;
        DELETE FROM server_migrations WHERE version = 20;
        ALTER TABLE households DROP COLUMN board_policy_revision;
        ALTER TABLE households DROP COLUMN board_temporary;
        ALTER TABLE households DROP COLUMN board_limited;
        DELETE FROM server_migrations WHERE version = 19;
        DROP TABLE board_events;
        DROP TABLE board_device_sequences;
        DROP TABLE board_relay_state;
        DELETE FROM server_migrations WHERE version = 18;
        DROP TABLE chat_key_packages;
        ALTER TABLE households DROP COLUMN chat_key_since;
        ALTER TABLE households DROP COLUMN chat_key_epoch;
        DELETE FROM server_migrations WHERE version = 17;
        ALTER TABLE households DROP COLUMN chat_policy_revision;
        ALTER TABLE households DROP COLUMN chat_temporary;
        ALTER TABLE households DROP COLUMN chat_limited;
        DELETE FROM server_migrations WHERE version = 16;
        DROP TABLE chat_receipts;
        DELETE FROM server_migrations WHERE version = 15;
        DROP TABLE chat_hidden;
        DELETE FROM server_migrations WHERE version = 14;
        DROP TABLE chat_events;
        DROP TABLE chat_device_sequences;
        DROP TABLE chat_relay_state;
        DELETE FROM server_migrations WHERE version = 13;
        DROP TABLE chat_blobs;
        DROP TABLE chat_blob_claims;
        DROP TABLE chat_blob_usage;
        DELETE FROM server_migrations WHERE version = 12;
        DROP TABLE push_subscriptions;
        DROP TABLE push_vapid_keys;
        DELETE FROM server_migrations WHERE version = 11;
        DROP TABLE household_install_identity;
        DROP TABLE household_install_identity_revisions;
        DELETE FROM server_migrations WHERE version = 10;
        ALTER TABLE sync_attachments DROP COLUMN uploader_member_id;
        DELETE FROM server_migrations WHERE version = 9;
        ALTER TABLE members DROP COLUMN household_admin;
        DELETE FROM server_migrations WHERE version = 8;
      `);
      legacy.prepare("UPDATE households SET owner_member_id = NULL WHERE id = ?").run(ownerless.householdId);
      sqlitePragma(legacy, "user_version = 7");
    } finally {
      legacy.close();
    }

    const migrated = new DurableStore(databasePath);
    try {
      assert.equal(sqlitePragma(migrated.db, "user_version", { simple: true }), 30);
      const reloaded = new PairingService({ store: migrated });
      assert.equal(reloaded.members.get(owned.memberId).householdAdmin, true);
      assert.equal(reloaded.members.get(ownerless.memberId).householdAdmin, undefined);
      assert.equal(reloaded.hasHouseholdAdmin(reloaded.households.get(ownerless.householdId)), false);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("granted household admin authority is durable and non-adult admin rows fail closed", () => {
  const store = new DurableStore(":memory:");
  try {
    const first = new PairingService({ store });
    const founder = first.bootstrap({ credential: { id: "durable-founder", publicKey: "key-founder", algorithm: -7 }, deviceLabel: "Founder" });
    const admit = (suffix, options) => {
      const invitation = first.createPairing(founder.sessionToken, options);
      const claim = first.claimPairing({ code: invitation.code, credential: { id: suffix, publicKey: `key-${suffix}`, algorithm: -7 }, deviceLabel: suffix });
      first.approvePairing(founder.sessionToken, invitation.pairingId, claim.version);
      return first.activateClaim(claim.claimToken);
    };
    const second = admit("durable-second");
    const child = admit("durable-child", { kind: "limited" });
    first.setHouseholdAdmin(founder.sessionToken, second.memberId, true, founder.memberId);

    const reloaded = new PairingService({ store });
    assert.equal(reloaded.members.get(second.memberId).householdAdmin, true);
    assert.equal(reloaded.members.get(child.memberId).householdAdmin, undefined);

    store.db.prepare("UPDATE members SET household_admin = 1 WHERE id = ?").run(child.memberId);
    assert.throws(() => new PairingService({ store }), /membership data is invalid/);
  } finally {
    store.close();
  }
});
