import assert from "node:assert/strict";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function fixture() {
  const pairing = new PairingService();
  const adult = pairing.bootstrap({
    credential: credential("a"),
    deviceLabel: "A",
  });
  const sync = new EncryptedSyncService(pairing);
  return { pairing, adult, sync };
}

function makeEnvelope(adult, overrides = {}) {
  return {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId: "a".repeat(32),
    householdId: adult.householdId,
    deviceId: adult.deviceId,
    deviceSequence: 1,
    logicalTime: "1",
    keyEpoch: 1,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    signature: Buffer.alloc(64, 3).toString("base64url"),
    ...overrides,
  };
}

function makeBindings(adult, count, start = 1) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = start + index;
    return makeEnvelope(adult, {
      eventId: sequence.toString(16).padStart(32, "0"),
      deviceSequence: sequence,
    });
  });
}

function storeBindings(sync, adult, bindings) {
  for (let index = 0; index < bindings.length; index += 20)
    sync.pushBindings(adult.sessionToken, bindings.slice(index, index + 20));
}

function pullAllBindings(sync, adult) {
  const bindings = [];
  let cursor = "";
  do {
    const page = sync.pullBindings(adult.sessionToken, cursor);
    bindings.push(...page.bindings);
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (true);
  return bindings;
}

function keyPairMarker(suffix) {
  return {
    agreement: { kty: "EC", crv: "P-256", x: suffix, y: suffix },
    signing: { kty: "EC", crv: "P-256", x: suffix, y: suffix },
  };
}

test("opaque relay accepts exact retries once and advances a separate cursor", () => {
  const { adult, sync } = fixture();
  const first = makeEnvelope(adult);
  assert.equal(
    sync.push(adult.sessionToken, [first]).latestCursor,
    "AAAAAAAAAAE",
  );
  assert.equal(
    sync.push(adult.sessionToken, [first]).latestCursor,
    "AAAAAAAAAAE",
  );
  const pulled = sync.pull(adult.sessionToken, "", "20");
  assert.equal(pulled.events.length, 1);
  assert.deepEqual(pulled.events[0].envelope, first);
  assert.equal(pulled.nextCursor, "AAAAAAAAAAE");
  assert.equal(sync.status(adult.sessionToken).eventCount, 1);
  assert.equal(sync.status(adult.sessionToken).acceptance, "process-local");
});

test("conflicting IDs, sequence gaps, semantic metadata, stale epochs, and bad cursors fail", () => {
  const { adult, sync } = fixture();
  const first = makeEnvelope(adult);
  sync.push(adult.sessionToken, [first]);
  assert.throws(
    () =>
      sync.push(adult.sessionToken, [
        makeEnvelope(adult, {
          ciphertext: Buffer.alloc(32, 9).toString("base64url"),
        }),
      ]),
    (error) => error.code === "event_duplicate_conflict",
  );
  assert.throws(
    () =>
      sync.push(adult.sessionToken, [
        makeEnvelope(adult, { eventId: "b".repeat(32), deviceSequence: 3 }),
      ]),
    (error) => error.code === "sync_sequence_gap",
  );
  assert.throws(
    () =>
      sync.push(adult.sessionToken, [
        makeEnvelope(adult, {
          eventId: "c".repeat(32),
          deviceSequence: 2,
          kind: "ITEM_ADDED",
        }),
      ]),
    (error) => error.code === "event_envelope_invalid",
  );
  assert.throws(
    () =>
      sync.push(adult.sessionToken, [
        makeEnvelope(adult, {
          eventId: "d".repeat(32),
          deviceSequence: 2,
          keyEpoch: 2,
        }),
      ]),
    (error) => error.code === "event_envelope_invalid",
  );
  assert.throws(
    () => sync.pull(adult.sessionToken, "-1", "1"),
    (error) => error.code === "sync_cursor_invalid",
  );
});

test("every relay operation reauthorizes and revoked sessions cannot pull old cursors", () => {
  const { pairing, adult, sync } = fixture();
  const session = adult.sessionToken;
  sync.push(session, [makeEnvelope(adult)]);
  pairing.devices.get(adult.deviceId).revokedAt = Date.now();
  assert.throws(
    () => sync.pull(session, "AAAAAAAAAAE", "1"),
    (error) => error.code === "device_not_trusted",
  );
});

test("new-member history starts at the post-join epoch and rotation uses compare-and-advance", () => {
  const { pairing, adult, sync } = fixture();
  const invite = pairing.createPairing(adult.sessionToken);
  const claim = pairing.claimPairing({
    code: invite.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  pairing.approvePairing(adult.sessionToken, invite.pairingId, claim.version);
  const joined = pairing.activateClaim(claim.claimToken);
  const recipient = pairing.devices.get(joined.deviceId);
  recipient.syncPublicKeys = keyPairMarker("b");
  recipient.syncKeyFingerprint = "b".repeat(64);

  sync.push(adult.sessionToken, [makeEnvelope(adult)]);
  assert.equal(sync.onDeviceAdded(adult.householdId, joined.deviceId), 2);
  assert.equal(recipient.syncHistoryFromEpoch, 2);
  assert.equal(sync.pull(joined.sessionToken, "", "20").events.length, 0);
  assert.throws(
    () =>
      sync.push(joined.sessionToken, [makeEnvelope(joined, { keyEpoch: 1 })]),
    (error) => error.code === "sync_rotation_pending",
  );
  assert.throws(
    () =>
      sync.createProvisioningGrant(adult.sessionToken, {
        recipientDeviceId: joined.deviceId,
        keyEpoch: 1,
      }),
    (error) => error.code === "sync_rotation_pending",
  );

  const packageForB = {
    version: 1,
    householdId: adult.householdId,
    senderDeviceId: adult.deviceId,
    recipientDeviceId: joined.deviceId,
    recipientFingerprint: recipient.syncKeyFingerprint,
    keyEpoch: 2,
    grantId: "e".repeat(32),
    expiresAt: Date.now() + 60_000,
    ephemeralPublicKey: { kty: "EC", crv: "P-256" },
    salt: Buffer.alloc(32).toString("base64url"),
    nonce: Buffer.alloc(12).toString("base64url"),
    wrappedKey: Buffer.alloc(48).toString("base64url"),
    signature: Buffer.alloc(64).toString("base64url"),
  };
  assert.deepEqual(
    sync.rotateEpoch(adult.sessionToken, {
      expectedEpoch: 1,
      packages: [packageForB],
      proposalId: "f".repeat(32),
    }),
    {
      currentEpoch: 2,
      rotationPending: false,
      retried: false,
      proposalId: "f".repeat(32),
    },
  );
  const grant = sync.createProvisioningGrant(adult.sessionToken, {
    recipientDeviceId: joined.deviceId,
    keyEpoch: 2,
    requestId: "c".repeat(32),
  });
  assert.equal(grant.recipientFingerprint, recipient.syncKeyFingerprint);
  assert.equal(
    sync.createProvisioningGrant(adult.sessionToken, {
      recipientDeviceId: joined.deviceId,
      keyEpoch: 2,
      requestId: grant.requestId,
    }).grantId,
    grant.grantId,
  );
  assert.throws(
    () =>
      sync.createProvisioningGrant(adult.sessionToken, {
        recipientDeviceId: joined.deviceId,
        keyEpoch: 1,
      }),
    (error) => error.code === "provisioning_device_mismatch",
  );
  const keyPackage = {
    version: 1,
    householdId: grant.householdId,
    senderDeviceId: grant.senderDeviceId,
    recipientDeviceId: grant.recipientDeviceId,
    recipientFingerprint: grant.recipientFingerprint,
    keyEpoch: grant.keyEpoch,
    grantId: grant.grantId,
    expiresAt: grant.expiresAt,
    ephemeralPublicKey: { kty: "EC", crv: "P-256" },
    salt: Buffer.alloc(32, 1).toString("base64url"),
    nonce: Buffer.alloc(12, 2).toString("base64url"),
    wrappedKey: Buffer.alloc(48, 3).toString("base64url"),
    signature: Buffer.alloc(64, 4).toString("base64url"),
  };
  assert.deepEqual(
    sync.submitProvisioning(adult.sessionToken, grant.grantId, keyPackage),
    { accepted: true, grantId: grant.grantId, durable: false },
  );
  assert.equal(
    sync.submitProvisioning(adult.sessionToken, grant.grantId, keyPackage)
      .accepted,
    true,
  );
  assert.throws(
    () =>
      sync.submitProvisioning(adult.sessionToken, grant.grantId, {
        ...keyPackage,
        salt: Buffer.alloc(32, 9).toString("base64url"),
      }),
    (error) => error.code === "provisioning_conflict",
  );
  assert.ok(
    sync
      .pendingProvisioning(joined.sessionToken)
      .some((entry) => entry.grantId === grant.grantId),
  );
  assert.equal(
    sync.acknowledgeProvisioning(joined.sessionToken, grant.grantId)
      .acknowledged,
    true,
  );
  assert.equal(
    sync.rotateEpoch(adult.sessionToken, {
      expectedEpoch: 1,
      packages: [packageForB],
      proposalId: "f".repeat(32),
    }).retried,
    true,
  );
  assert.equal(
    sync.push(adult.sessionToken, [
      makeEnvelope(adult, {
        eventId: "f".repeat(32),
        deviceSequence: 2,
        logicalTime: "2",
        keyEpoch: 1,
      }),
    ]).accepted,
    1,
  );
  assert.equal(sync.pull(joined.sessionToken, "", "20").events.length, 0);
  assert.throws(
    () =>
      sync.rotateEpoch(adult.sessionToken, { expectedEpoch: 1, packages: [] }),
    (error) => error.code === "stale_key_epoch",
  );
});

test("household key epochs stop at the retained-history bound", () => {
  const { adult, sync } = fixture();
  sync.state(adult.householdId).currentEpoch = 128;
  assert.throws(
    () =>
      sync.rotateEpoch(adult.sessionToken, {
        expectedEpoch: 128,
        proposalId: "a".repeat(32),
        packages: [],
      }),
    (error) => error.code === "sync_epoch_limit",
  );
});

test("pending provisioning grants remain capped at 128", () => {
  const { pairing, adult, sync } = fixture();
  const invitation = pairing.createPairing(adult.sessionToken);
  const claim = pairing.claimPairing({
    code: invitation.code,
    credential: credential("recipient"),
    deviceLabel: "Recipient device",
  });
  pairing.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = pairing.activateClaim(claim.claimToken);
  const device = pairing.devices.get(joined.deviceId);
  device.syncPublicKeys = keyPairMarker("b");
  device.syncKeyFingerprint = "b".repeat(64);
  for (let index = 0; index < 128; index += 1)
    sync.createProvisioningGrant(adult.sessionToken, {
      recipientDeviceId: joined.deviceId,
      keyEpoch: 1,
    });
  assert.throws(
    () =>
      sync.createProvisioningGrant(adult.sessionToken, {
        recipientDeviceId: joined.deviceId,
        keyEpoch: 1,
      }),
    (error) => error.code === "provisioning_capacity",
  );
});

test("sync requests are rate-limited per trusted device and recover after the window", () => {
  let now = 10_000;
  const pairing = new PairingService({ now: () => now });
  const adult = pairing.bootstrap({
    credential: credential("rate-limited"),
    deviceLabel: "Rate-limited device",
  });
  const sync = new EncryptedSyncService(pairing, { now: () => now });
  for (let index = 0; index < 256; index += 1) sync.status(adult.sessionToken);
  assert.throws(
    () => sync.status(adult.sessionToken),
    (error) => error.code === "sync_rate_limited",
  );
  now += 60_001;
  assert.equal(sync.status(adult.sessionToken).currentEpoch, 1);
});

test("encrypted identity bindings use a separate bounded cursor", () => {
  const { adult, sync } = fixture();
  const bindings = makeBindings(adult, 25);
  assert.equal(
    sync.pushBindings(adult.sessionToken, bindings.slice(0, 20)).accepted,
    20,
  );
  assert.equal(
    sync.pushBindings(adult.sessionToken, bindings.slice(20)).accepted,
    5,
  );
  const first = sync.pullBindings(adult.sessionToken);
  assert.equal(first.bindings.length, 20);
  assert.equal(first.hasMore, true);
  const second = sync.pullBindings(adult.sessionToken, first.nextCursor);
  assert.equal(second.bindings.length, 5);
  assert.equal(second.hasMore, false);
});

test("identity binding exact retry succeeds at capacity without adding a record", () => {
  const { adult, sync } = fixture();
  const bindings = makeBindings(adult, 256);
  storeBindings(sync, adult, bindings);

  assert.equal(
    sync.pushBindings(adult.sessionToken, [bindings[0]]).accepted,
    1,
  );
  assert.deepEqual(pullAllBindings(sync, adult), bindings);
});

test("identity binding conflict at capacity is rejected without mutation", () => {
  const { adult, sync } = fixture();
  const bindings = makeBindings(adult, 256);
  storeBindings(sync, adult, bindings);
  const before = pullAllBindings(sync, adult);

  assert.throws(
    () =>
      sync.pushBindings(adult.sessionToken, [
        makeEnvelope(adult, {
          eventId: bindings[0].eventId,
          ciphertext: Buffer.alloc(32, 9).toString("base64url"),
        }),
      ]),
    (error) => error.code === "event_duplicate_conflict",
  );
  assert.deepEqual(pullAllBindings(sync, adult), before);
});

test("identity binding conflict does not commit earlier records in the request", () => {
  const { adult, sync } = fixture();
  const existing = makeBindings(adult, 1)[0];
  const newBinding = makeBindings(adult, 1, 2)[0];
  sync.pushBindings(adult.sessionToken, [existing]);

  assert.throws(
    () =>
      sync.pushBindings(adult.sessionToken, [
        newBinding,
        makeEnvelope(adult, {
          eventId: existing.eventId,
          ciphertext: Buffer.alloc(32, 9).toString("base64url"),
        }),
      ]),
    (error) => error.code === "event_duplicate_conflict",
  );
  assert.deepEqual(pullAllBindings(sync, adult), [existing]);
});

test("new identity binding beyond capacity is rejected without mutation", () => {
  const { adult, sync } = fixture();
  const bindings = makeBindings(adult, 256);
  storeBindings(sync, adult, bindings);
  const before = pullAllBindings(sync, adult);

  assert.throws(
    () =>
      sync.pushBindings(adult.sessionToken, [makeBindings(adult, 1, 257)[0]]),
    (error) => error.code === "sync_limit",
  );
  assert.deepEqual(pullAllBindings(sync, adult), before);
});

test("duplicate identity bindings in one request are committed once", () => {
  const { adult, sync } = fixture();
  const binding = makeBindings(adult, 1)[0];

  assert.equal(
    sync.pushBindings(adult.sessionToken, [binding, binding]).accepted,
    2,
  );
  assert.deepEqual(pullAllBindings(sync, adult), [binding]);
});

test("identity binding storage accepts the final slot then rejects the next", () => {
  const { adult, sync } = fixture();
  const bindings = makeBindings(adult, 255);
  storeBindings(sync, adult, bindings);
  const [finalBinding, overCapacityBinding] = makeBindings(adult, 2, 256);

  assert.throws(
    () =>
      sync.pushBindings(adult.sessionToken, [finalBinding, overCapacityBinding]),
    (error) => error.code === "sync_limit",
  );
  assert.deepEqual(pullAllBindings(sync, adult), bindings);

  assert.equal(
    sync.pushBindings(adult.sessionToken, [finalBinding]).accepted,
    1,
  );
  const atCapacity = pullAllBindings(sync, adult);
  assert.equal(atCapacity.length, 256);
  assert.throws(
    () =>
      sync.pushBindings(adult.sessionToken, [makeBindings(adult, 1, 257)[0]]),
    (error) => error.code === "sync_limit",
  );
  assert.deepEqual(pullAllBindings(sync, adult), atCapacity);
});
