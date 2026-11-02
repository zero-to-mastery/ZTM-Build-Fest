import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore, DurableStoreError } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { canonicalJson } from "./sync-contract.mjs";
import { openTestDatabase, sqlitePragma } from "./sqlite-test-utils.mjs";

function deviceKeys() {
  const agreement = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateSigning: signing.privateKey,
    publicKeys: {
      agreement: { ...agreement.publicKey.export({ format: "jwk" }), key_ops: [] },
      signing: { ...signing.publicKey.export({ format: "jwk" }), key_ops: ["verify"] },
    },
  };
}

function makeEnvelope(identity, eventId) {
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

function makePackage(grant, recipientKeys) {
  return {
    version: 1,
    householdId: grant.householdId,
    senderDeviceId: grant.senderDeviceId,
    recipientDeviceId: grant.recipientDeviceId,
    recipientFingerprint: grant.recipientFingerprint,
    grantId: grant.grantId,
    keyEpoch: grant.keyEpoch,
    expiresAt: grant.expiresAt,
    ephemeralPublicKey: recipientKeys.publicKeys.agreement,
    salt: Buffer.alloc(32, 4).toString("base64url"),
    nonce: Buffer.alloc(12, 5).toString("base64url"),
    wrappedKey: Buffer.alloc(48, 6).toString("base64url"),
    signature: Buffer.alloc(64, 7).toString("base64url"),
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kin-sync-integrity-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  let now = 1_700_000_000_000;
  const pairing = new PairingService({ store, now: () => now });
  const credential = (id) => ({ id, publicKey: `synthetic-${id}`, algorithm: -7 });
  const adult = pairing.bootstrap({ credential: credential("sender"), deviceLabel: "Sender" });
  const invitation = pairing.createPairing(adult.sessionToken);
  const claim = pairing.claimPairing({
    code: invitation.code,
    credential: credential("recipient"),
    deviceLabel: "Recipient",
  });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const recipient = pairing.activateClaim(claim.claimToken);
  const senderKeys = deviceKeys();
  const recipientKeys = deviceKeys();
  pairing.registerSyncPublicKeys(adult.sessionToken, senderKeys.publicKeys);
  pairing.registerSyncPublicKeys(recipient.sessionToken, recipientKeys.publicKeys);
  const sync = new EncryptedSyncService(pairing, { store, now: () => now });
  sync.enable(adult.sessionToken);
  const grant = sync.createProvisioningGrant(adult.sessionToken, {
    recipientDeviceId: recipient.deviceId,
    keyEpoch: 1,
    requestId: "c".repeat(32),
  });
  sync.submitProvisioning(adult.sessionToken, grant.grantId, makePackage(grant, recipientKeys));
  sync.push(adult.sessionToken, [makeEnvelope(adult, "a".repeat(32))]);
  sync.pushBindings(adult.sessionToken, [makeEnvelope(adult, "b".repeat(32))]);
  return {
    directory, databasePath, store, pairing, sync, adult, recipient, recipientKeys, grant,
    expire() { now += 11 * 60_000; },
    rotate() {
      sync.rotateEpoch(adult.sessionToken, {
        expectedEpoch: 1,
        proposalId: "d".repeat(32),
        packages: [makePackage({ ...grant, grantId: "e".repeat(32), keyEpoch: 2 }, recipientKeys)],
      });
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function mutateGrant(db, grantId, mutate) {
  const row = db.prepare("SELECT grant_json FROM provisioning_grants WHERE grant_id = ?").get(grantId);
  const grant = JSON.parse(row.grant_json);
  mutate(grant);
  db.prepare("UPDATE provisioning_grants SET grant_json = ? WHERE grant_id = ?")
    .run(JSON.stringify(grant), grantId);
}

function mutateRotation(db, householdId, mutate) {
  const row = db.prepare("SELECT last_rotation_json FROM sync_households WHERE household_id = ?").get(householdId);
  const rotation = JSON.parse(row.last_rotation_json);
  mutate(rotation);
  db.prepare("UPDATE sync_households SET last_rotation_json = ? WHERE household_id = ?")
    .run(JSON.stringify(rotation), householdId);
}

const mutations = [
  ["grant recipient normalized mismatch", (db, f) => {
    db.prepare("UPDATE provisioning_grants SET recipient_device_id = ?").run(f.adult.deviceId);
  }],
  ["grant sender normalized mismatch", (db, f) => {
    db.prepare("UPDATE provisioning_grants SET sender_device_id = ?").run(f.recipient.deviceId);
  }],
  ["grant expiry normalized mismatch", (db) => {
    db.prepare("UPDATE provisioning_grants SET expires_at = expires_at + 1").run();
  }],
  ["grant household JSON mismatch", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.householdId = "f".repeat(32); });
  }],
  ["grant request normalized mismatch", (db) => {
    db.prepare("UPDATE provisioning_grants SET request_id = ?").run("f".repeat(32));
  }],
  ["grant unsupported epoch", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.keyEpoch = 129; });
  }],
  ["grant unsupported state", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.state = "approved"; });
  }],
  ["grant malformed recipient fingerprint", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.recipientFingerprint = "bad"; });
  }],
  ["grant unrelated recipient fingerprint", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.recipientFingerprint = "f".repeat(64); });
  }],
  ["grant malformed request identity", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.requestId = "bad"; });
    db.prepare("UPDATE provisioning_grants SET request_id = 'bad'").run();
  }],
  ["grant unsafe expiry timestamp", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.expiresAt = 1.5; });
    db.prepare("UPDATE provisioning_grants SET expires_at = 1.5").run();
  }],
  ["grant malformed package", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => {
      grant.package.version = 2;
      grant.canonicalPackage = canonicalJson(grant.package);
    });
  }],
  ["grant package canonical mismatch", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.package.wrappedKey = "different"; });
  }],
  ["acknowledged grant missing package", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => {
      grant.state = "acknowledged";
      grant.package = null;
      grant.canonicalPackage = null;
    });
  }],
  ["binding household mismatch", (db) => {
    const row = db.prepare("SELECT canonical_envelope FROM sync_bindings").get();
    const pairs = JSON.parse(row.canonical_envelope);
    pairs.find(([name]) => name === "householdId")[1] = "f".repeat(32);
    db.prepare("UPDATE sync_bindings SET canonical_envelope = ?").run(JSON.stringify(pairs));
  }],
  ["binding event identity mismatch", (db) => {
    db.prepare("UPDATE sync_bindings SET event_id = ?").run("f".repeat(32));
  }],
  ["binding unsupported envelope", (db) => {
    const row = db.prepare("SELECT canonical_envelope FROM sync_bindings").get();
    const pairs = JSON.parse(row.canonical_envelope);
    pairs.find(([name]) => name === "envelopeVersion")[1] = 2;
    db.prepare("UPDATE sync_bindings SET canonical_envelope = ?").run(JSON.stringify(pairs));
  }],
  ["binding unknown originating device", (db) => {
    const row = db.prepare("SELECT canonical_envelope FROM sync_bindings").get();
    const pairs = JSON.parse(row.canonical_envelope);
    pairs.find(([name]) => name === "deviceId")[1] = "f".repeat(32);
    db.prepare("UPDATE sync_bindings SET canonical_envelope = ?").run(JSON.stringify(pairs));
  }],
  ["sync unsafe sequence high water", (db) => {
    db.prepare("UPDATE sync_device_sequences SET last_sequence = 1.5").run();
  }],
];

for (const [name, mutate] of mutations) {
  test(`startup rejects SQLite-valid ${name}`, () => {
    const f = fixture();
    try {
      assert.equal(f.store.validate(), true);
      f.store.close();
      const db = openTestDatabase(f.databasePath);
      try {
        sqlitePragma(db, "foreign_keys = ON");
        mutate(db, f);
        assert.equal(sqlitePragma(db, "quick_check", { simple: true }), "ok");
        assert.deepEqual(sqlitePragma(db, "foreign_key_check"), []);
      } finally {
        db.close();
      }
      assert.throws(() => new DurableStore(f.databasePath), DurableStoreError);
    } finally {
      f.close();
    }
  });
}

for (const [name, mutate] of [
  ["invalid proposal ID", (rotation) => { rotation.proposalId = "bad"; }],
  ["invalid rotation ID", (rotation) => { rotation.rotationId = "bad"; }],
  ["invalid expected epoch", (rotation) => { rotation.expectedEpoch = 0; }],
  ["accepted epoch contradiction", (rotation) => { rotation.expectedEpoch = 2; }],
  ["noncanonical packages", (rotation) => { rotation.canonical = "[] "; }],
  ["incorrect package epoch", (rotation) => {
    const packages = JSON.parse(rotation.canonical);
    packages[0].keyEpoch = 1;
    rotation.canonical = canonicalJson(packages);
  }],
  ["duplicate package recipients", (rotation) => {
    const packages = JSON.parse(rotation.canonical);
    rotation.canonical = canonicalJson([...packages, packages[0]]);
  }],
]) {
  test(`startup rejects rotation metadata with ${name}`, () => {
    const f = fixture();
    try {
      f.rotate();
      assert.equal(f.store.validate(), true);
      f.store.close();
      const db = openTestDatabase(f.databasePath);
      try {
        mutateRotation(db, f.adult.householdId, mutate);
        assert.equal(sqlitePragma(db, "quick_check", { simple: true }), "ok");
      } finally {
        db.close();
      }
      assert.throws(() => new DurableStore(f.databasePath), DurableStoreError);
    } finally {
      f.close();
    }
  });
}

const COMMITTED_GRANT_ID = "e".repeat(32);

for (const [name, mutate] of [
  ["a non-boolean committed marker", (db) => {
    mutateGrant(db, COMMITTED_GRANT_ID, (grant) => { grant.committedRotation = "yes"; });
  }],
  ["a false committed marker", (db) => {
    mutateGrant(db, COMMITTED_GRANT_ID, (grant) => { grant.committedRotation = false; });
  }],
  ["a committed marker on an acknowledged grant", (db) => {
    mutateGrant(db, COMMITTED_GRANT_ID, (grant) => { grant.state = "acknowledged"; });
  }],
  ["a committed marker without its package", (db) => {
    mutateGrant(db, COMMITTED_GRANT_ID, (grant) => {
      grant.package = null;
      grant.canonicalPackage = null;
    });
  }],
  ["a committed marker with a request identity", (db) => {
    mutateGrant(db, COMMITTED_GRANT_ID, (grant) => { grant.requestId = "f".repeat(32); });
    db.prepare("UPDATE provisioning_grants SET request_id = ? WHERE grant_id = ?").run("f".repeat(32), COMMITTED_GRANT_ID);
  }],
  ["a committed marker injected into an ordinary provisioning grant", (db, f) => {
    mutateGrant(db, f.grant.grantId, (grant) => { grant.committedRotation = true; });
  }],
]) {
  test(`startup rejects committed-rotation grant metadata with ${name}`, () => {
    const f = fixture();
    try {
      f.rotate();
      assert.equal(f.store.validate(), true);
      f.store.close();
      const db = openTestDatabase(f.databasePath);
      try {
        mutate(db, f);
        assert.equal(sqlitePragma(db, "quick_check", { simple: true }), "ok");
      } finally {
        db.close();
      }
      assert.throws(() => new DurableStore(f.databasePath), DurableStoreError);
    } finally {
      f.close();
    }
  });
}

function reopen(f) {
  const store = new DurableStore(f.databasePath);
  const pairing = new PairingService({ store });
  return { store, pairing, sync: new EncryptedSyncService(pairing, { store }) };
}

test("sender revocation after a restart preserves committed recovery and relay history", () => {
  const f = fixture();
  let first;
  let second;
  try {
    f.rotate();
    f.store.close();

    first = reopen(f);
    assert.ok(first.pairing.devices.get(f.adult.deviceId).syncProvisionedEpochs.includes(2),
      "the rotating device's committed epoch is durable");
    const recipient = first.pairing.reauthenticate(f.recipient.deviceToken, "recipient");
    const historyBefore = first.sync.pull(recipient.sessionToken, "", "20");
    // Revoking another member's device is household-admin authority.
    first.pairing.members.get(f.recipient.memberId).householdAdmin = true;
    first.pairing.revokeDevice(recipient.sessionToken, f.adult.deviceId, f.recipient.memberId);
    first.sync.onAccessChange(f.adult.householdId, [f.adult.deviceId]);
    // The reopened services use the real clock, well past the fixture's TTL.
    const [recovery] = first.sync.pendingProvisioning(recipient.sessionToken);
    assert.equal(recovery.grantId, COMMITTED_GRANT_ID);
    assert.equal(recovery.committedRotation, true);
    assert.ok(recovery.expiresAt < Date.now());
    assert.equal(first.sync.acknowledgeProvisioning(recipient.sessionToken, recovery.grantId).acknowledged, true);
    assert.equal(first.sync.acknowledgeProvisioning(recipient.sessionToken, recovery.grantId).acknowledged, true,
      "a retried acknowledgement is idempotent");
    assert.deepEqual(first.pairing.devices.get(f.recipient.deviceId).syncProvisionedEpochs
      .filter((epoch) => epoch === 2), [2]);
    assert.deepEqual(first.sync.pull(recipient.sessionToken, "", "20"), historyBefore);
    assert.equal(first.store.eventCount(f.adult.householdId), 1);
    assert.equal(first.store.validate(), true);
    first.store.close();

    // The acknowledged package reloads as ordinary state and its capacity is
    // released by the next normal prune.
    second = reopen(f);
    const grant = second.store.loadSyncState(f.adult.householdId).grants.get(COMMITTED_GRANT_ID);
    assert.equal(grant.state, "acknowledged");
    assert.equal(grant.committedRotation, undefined);
    // Reauthentication rotates the device token, so use the latest one.
    const session = second.pairing.reauthenticate(recipient.deviceToken, "recipient");
    assert.deepEqual(second.sync.pendingProvisioning(session.sessionToken), []);
    assert.equal(second.store.loadSyncState(f.adult.householdId).grants.size, 0);
    assert.deepEqual(second.sync.pull(session.sessionToken, "", "20"), historyBefore);
  } finally {
    second?.store.close();
    first?.store.close();
    f.close();
  }
});

test("recipient revocation after a restart removes its committed package as it does before one", () => {
  const f = fixture();
  let reopened;
  try {
    f.rotate();
    f.store.close();
    reopened = reopen(f);
    const adult = reopened.pairing.reauthenticate(f.adult.deviceToken, "sender");
    reopened.pairing.revokeDevice(adult.sessionToken, f.recipient.deviceId, f.adult.memberId);
    reopened.sync.onAccessChange(f.adult.householdId, [f.recipient.deviceId]);
    assert.equal(reopened.sync.state(f.adult.householdId).grants.has(COMMITTED_GRANT_ID), false);
    assert.throws(() => reopened.pairing.reauthenticate(f.recipient.deviceToken, "recipient"));
    assert.equal(reopened.store.validate(), true);
    reopened.store.close();
    reopened = reopen(f);
    assert.equal(reopened.store.loadSyncState(f.adult.householdId).grants.has(COMMITTED_GRANT_ID), false);
  } finally {
    reopened?.store.close();
    f.close();
  }
});

test("rotation grants stored before committed-recovery markers load and expire as ordinary grants", () => {
  const f = fixture();
  let reopened;
  try {
    f.rotate();
    f.store.close();
    const db = openTestDatabase(f.databasePath);
    try {
      // The pre-marker shape had neither the marker nor an explicit request ID.
      mutateGrant(db, COMMITTED_GRANT_ID, (grant) => {
        delete grant.committedRotation;
        delete grant.requestId;
      });
    } finally {
      db.close();
    }
    reopened = reopen(f);
    assert.equal(reopened.store.validate(), true);
    const recipient = reopened.pairing.reauthenticate(f.recipient.deviceToken, "recipient");
    assert.deepEqual(reopened.sync.pendingProvisioning(recipient.sessionToken), []);
    assert.equal(reopened.store.loadSyncState(f.adult.householdId).grants.has(COMMITTED_GRANT_ID), false);
  } finally {
    reopened?.store.close();
    f.close();
  }
});

test("valid expired grants survive validation and prune through the normal sync API", () => {
  const f = fixture();
  let reopened;
  try {
    f.expire();
    assert.equal(f.store.validate(), true);
    f.store.close();
    reopened = new DurableStore(f.databasePath);
    assert.equal(reopened.loadSyncState(f.adult.householdId).grants.size, 1);
    const pairing = new PairingService({ store: reopened });
    const session = pairing.reauthenticate(f.recipient.deviceToken, "recipient");
    const sync = new EncryptedSyncService(pairing, { store: reopened });
    assert.deepEqual(sync.pendingProvisioning(session.sessionToken), []);
    assert.equal(reopened.loadSyncState(f.adult.householdId).grants.size, 0);
  } finally {
    reopened?.close();
    f.close();
  }
});

test("committed rotation recovery survives sender revocation, expiry, and restart", () => {
  const f = fixture();
  let reopened;
  try {
    f.rotate();
    // Revoking another member's device is household-admin authority.
    f.pairing.members.get(f.recipient.memberId).householdAdmin = true;
    f.pairing.revokeDevice(
      f.recipient.sessionToken,
      f.adult.deviceId,
      f.recipient.memberId,
    );
    f.sync.onAccessChange(f.adult.householdId, [f.adult.deviceId]);
    f.expire();
    assert.equal(f.store.validate(), true);
    f.store.close();

    reopened = new DurableStore(f.databasePath);
    const pairing = new PairingService({ store: reopened });
    const recipient = pairing.reauthenticate(
      f.recipient.deviceToken,
      "recipient",
    );
    const sync = new EncryptedSyncService(pairing, { store: reopened });
    const [recovery] = sync.pendingProvisioning(recipient.sessionToken);
    assert.equal(recovery.committedRotation, true);
    assert.equal(recovery.keyEpoch, 2);
    assert.equal(
      sync.acknowledgeProvisioning(recipient.sessionToken, recovery.grantId)
        .acknowledged,
      true,
    );
    assert.ok(
      pairing.devices.get(f.recipient.deviceId).syncProvisionedEpochs.includes(2),
    );
  } finally {
    reopened?.close();
    f.close();
  }
});

test("accepted rotations retain valid historical keys, removed members and revoked devices", () => {
  const f = fixture();
  let reopened;
  try {
    f.rotate();
    const successor = deviceKeys();
    const unsigned = {
      version: 1,
      purpose: "kin.sync.device-key-successor.v1",
      householdId: f.adult.householdId,
      memberId: f.recipient.memberId,
      deviceId: f.recipient.deviceId,
      generation: 1,
      transitionId: "f".repeat(32),
      oldFingerprint: f.grant.recipientFingerprint,
      fingerprint: createHash("sha256").update(canonicalJson(successor.publicKeys)).digest("hex"),
      publicKeys: successor.publicKeys,
    };
    f.pairing.transitionSyncPublicKeys(f.recipient.sessionToken, {
      ...unsigned,
      signature: sign("sha256", Buffer.from(canonicalJson(unsigned)), {
        key: f.recipientKeys.privateSigning, dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
    });
    f.sync.onDeviceKeyTransition(f.adult.householdId, f.recipient.deviceId);
    f.pairing.removeOtherAdult(f.adult.sessionToken, f.recipient.memberId, f.adult.memberId);
    f.sync.onAccessChange(f.adult.householdId, [f.recipient.deviceId]);
    assert.equal(f.store.validate(), true);
    f.store.close();
    reopened = new DurableStore(f.databasePath);
    const state = reopened.loadSyncState(f.adult.householdId);
    assert.equal(state.currentEpoch, 2);
    assert.equal(state.rotationPending, true);
    assert.equal(state.lastRotation.proposalId, "d".repeat(32));
    assert.equal(state.grants.size, 0);
  } finally {
    reopened?.close();
    f.close();
  }
});

test("grant routing to another valid household cannot override the stored grant identity", () => {
  const f = fixture();
  try {
    const other = f.pairing.bootstrap({
      credential: { id: "foreign", publicKey: "synthetic-foreign", algorithm: -7 },
      deviceLabel: "Other household",
    });
    f.sync.enable(other.sessionToken);
    f.store.close();
    const db = openTestDatabase(f.databasePath);
    try {
      sqlitePragma(db, "foreign_keys = ON");
      db.prepare("UPDATE provisioning_grants SET household_id = ?, sender_device_id = ?, recipient_device_id = ?")
        .run(other.householdId, other.deviceId, other.deviceId);
      assert.deepEqual(sqlitePragma(db, "foreign_key_check"), []);
      assert.equal(sqlitePragma(db, "quick_check", { simple: true }), "ok");
    } finally {
      db.close();
    }
    assert.throws(() => new DurableStore(f.databasePath), DurableStoreError);
  } finally {
    f.close();
  }
});

for (const [name, operation] of [
  ["coerced request ID", (f) => f.sync.createProvisioningGrant(f.adult.sessionToken, {
    recipientDeviceId: f.recipient.deviceId, keyEpoch: 1, requestId: ["f".repeat(32)],
  })],
  ["coerced proposal ID", (f) => f.sync.rotateEpoch(f.adult.sessionToken, {
    expectedEpoch: 1,
    proposalId: ["f".repeat(32)],
    packages: [makePackage({ ...f.grant, keyEpoch: 2 }, f.recipientKeys)],
  })],
  ["malformed rotation grant ID", (f) => f.sync.rotateEpoch(f.adult.sessionToken, {
    expectedEpoch: 1,
    proposalId: "f".repeat(32),
    packages: [makePackage({ ...f.grant, grantId: "malformed", keyEpoch: 2 }, f.recipientKeys)],
  })],
  ["malformed rotation request ID", (f) => f.sync.rotateEpoch(f.adult.sessionToken, {
    expectedEpoch: 1,
    proposalId: "f".repeat(32),
    packages: [{ ...makePackage({ ...f.grant, keyEpoch: 2 }, f.recipientKeys), requestId: "malformed" }],
  })],
]) {
  test(`live sync rejects ${name} before mutating durable state`, () => {
    const f = fixture();
    try {
      const before = f.store.loadSyncState(f.adult.householdId);
      assert.throws(() => operation(f), (error) => error.code === "provisioning_invalid" || error.code === "stale_key_epoch");
      assert.equal(f.store.failed, false);
      assert.equal(f.store.validate(), true);
      assert.deepEqual(f.store.loadSyncState(f.adult.householdId), before);
    } finally {
      f.close();
    }
  });
}
