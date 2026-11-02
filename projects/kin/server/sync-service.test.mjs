import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { isEventEnvelopeValid } from "./sync-contract.mjs";
import { MAX_ATTACHMENT_BYTES, MAX_HOUSEHOLD_ATTACHMENT_BYTES } from "./durable-store.mjs";

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

test("only household admins can replace encrypted household settings with revision checks", () => {
  const { pairing, adult, sync } = fixture();
  sync.enable(adult.sessionToken);
  const invitation = pairing.createPairing(adult.sessionToken, { kind: "adult" });
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential("second"), deviceLabel: "Second" });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const second = pairing.activateClaim(claim.claimToken);
  const ciphertext = Buffer.alloc(40, 7);
  const value = { expectedRevision: 0, keyEpoch: 1, ciphertext: ciphertext.toString("base64url"), digest: createHash("sha256").update(ciphertext).digest("hex"), ownerId: second.memberId, isOwner: true, admin: true, householdAdmin: true };
  assert.equal(pairing.households.get(adult.householdId).ownerMemberId, adult.memberId);
  assert.equal(sync.householdSettings(adult.sessionToken).admin, true);
  assert.equal(sync.householdSettings(second.sessionToken).admin, false);
  assert.equal(sync.householdSettings(second.sessionToken).adminRecorded, true);
  assert.throws(() => sync.updateHouseholdSettings(second.sessionToken, value), (error) => error.code === "household_admin_required");
  assert.deepEqual(sync.updateHouseholdSettings(adult.sessionToken, value), { revision: 1, accepted: true });
  assert.equal(sync.householdSettings(second.sessionToken).settings.revision, 1);
  assert.throws(() => sync.updateHouseholdSettings(adult.sessionToken, value), (error) => error.code === "household_settings_stale");

  pairing.setHouseholdAdmin(adult.sessionToken, second.memberId, true, adult.memberId);
  pairing.devices.get(second.deviceId).syncProvisionedEpochs = [1];
  assert.equal(sync.householdSettings(second.sessionToken).admin, true);
  assert.deepEqual(sync.updateHouseholdSettings(second.sessionToken, { ...value, expectedRevision: 1 }), { revision: 2, accepted: true });
  pairing.setHouseholdAdmin(second.sessionToken, second.memberId, false, second.memberId);
  assert.throws(() => sync.updateHouseholdSettings(second.sessionToken, { ...value, expectedRevision: 2 }), (error) => error.code === "household_admin_required");
});

test("household settings require the active provisioned epoch and preserve accepted bytes on rejection", () => {
  const { pairing, adult, sync } = fixture();
  sync.enable(adult.sessionToken);
  const ciphertext = Buffer.alloc(40, 5);
  const value = { expectedRevision: 0, keyEpoch: 1, ciphertext, digest: createHash("sha256").update(ciphertext).digest("hex") };
  assert.deepEqual(sync.updateHouseholdSettings(adult.sessionToken, value), { revision: 1, accepted: true });
  const accepted = sync.householdSettings(adult.sessionToken).settings;

  for (const keyEpoch of [0, 2]) {
    assert.throws(() => sync.updateHouseholdSettings(adult.sessionToken, { ...value, expectedRevision: 1, keyEpoch }),
      (error) => ["household_settings_invalid", "household_settings_key_unavailable"].includes(error.code));
  }
  const state = sync.state(adult.householdId);
  state.currentEpoch = 2;
  for (const keyEpoch of [1, 3])
    assert.throws(() => sync.updateHouseholdSettings(adult.sessionToken, { ...value, expectedRevision: 1, keyEpoch }),
      (error) => error.code === "household_settings_key_unavailable");
  adultDevice(pairing, adult).syncProvisionedEpochs = [];
  assert.throws(() => sync.updateHouseholdSettings(adult.sessionToken, { ...value, expectedRevision: 1, keyEpoch: 2 }),
    (error) => error.code === "household_settings_key_unavailable");
  adultDevice(pairing, adult).syncProvisionedEpochs = [2];
  state.rotationPending = true;
  assert.throws(() => sync.updateHouseholdSettings(adult.sessionToken, { ...value, expectedRevision: 1, keyEpoch: 2 }),
    (error) => error.code === "household_settings_key_unavailable");

  const retained = sync.householdSettings(adult.sessionToken).settings;
  assert.equal(retained.revision, accepted.revision);
  assert.equal(retained.digest, accepted.digest);
  assert.deepEqual(retained.ciphertext, accepted.ciphertext);
});

function adultDevice(pairing, adult) { return pairing.devices.get(adult.deviceId); }

test("legacy households without a recorded admin fail closed", () => {
  const { pairing, adult, sync } = fixture();
  sync.enable(adult.sessionToken);
  pairing.households.get(adult.householdId).ownerMemberId = null;
  delete pairing.members.get(adult.memberId).householdAdmin;
  const ciphertext = Buffer.alloc(40, 9);
  const value = { expectedRevision: 0, keyEpoch: 1, ciphertext: ciphertext.toString("base64url"), digest: createHash("sha256").update(ciphertext).digest("hex") };
  assert.equal(sync.householdSettings(adult.sessionToken).adminRecorded, false);
  assert.throws(() => sync.updateHouseholdSettings(adult.sessionToken, value), (error) => error.code === "household_admin_required");
});

test("the device directory marks household admins by the service's record (#111)", () => {
  const { pairing, adult, sync } = fixture();
  const entry = () => sync.deviceDirectory(adult.sessionToken).find((device) => device.memberId === adult.memberId);
  assert.equal(entry().householdAdmin, true, "the founder");
  delete pairing.members.get(adult.memberId).householdAdmin;
  assert.equal(entry().householdAdmin, false);
});

test("relay enforces bounded interoperable logical time", () => {
  const { adult } = fixture();
  const base = makeEnvelope(adult);
  assert.equal(isEventEnvelopeValid(base), true);
  assert.equal(isEventEnvelopeValid({ ...base, logicalTime: "9007199254740991" }), true);
  for (const logicalTime of ["9007199254740992", "18446744073709551614", "340282366920938463463374607431768211455", "9".repeat(1000)])
    assert.equal(isEventEnvelopeValid({ ...base, logicalTime }), false);
});

test("relay caps a single logical-time jump while permitting the next valid write", () => {
  const { adult, sync } = fixture();
  sync.enable(adult.sessionToken);
  assert.throws(
    () => sync.push(adult.sessionToken, [makeEnvelope(adult, { logicalTime: "1000001" })]),
    (error) => error.code === "logical_time_invalid",
  );
  assert.equal(sync.push(adult.sessionToken, [makeEnvelope(adult, { logicalTime: "1000000" })]).accepted, 1);
  assert.equal(sync.push(adult.sessionToken, [makeEnvelope(adult, {
    eventId: "b".repeat(32), deviceSequence: 2, logicalTime: "1000001",
  })]).accepted, 1);
});

test("only Adults may enable sync, while active Limited and Temporary members may participate", () => {
  const { pairing, adult, sync } = fixture();
  const admit = (kind, suffix, options = {}) => {
    const invitation = pairing.createPairing(adult.sessionToken, { kind, ...options });
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(suffix), deviceLabel: suffix });
    pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const limited = admit("limited", "limited-enable");
  const temporary = admit("temporary", "temporary-enable", { expiresAt: Date.now() + 60_000 });
  const removedTemporary = admit("temporary", "temporary-removed", { expiresAt: Date.now() + 60_000 });
  assert.throws(() => sync.enable(limited.sessionToken), (error) => error.code === "adult_required");
  assert.throws(() => sync.enable(temporary.sessionToken), (error) => error.code === "adult_required");
  assert.deepEqual(sync.enable(adult.sessionToken), { enabled: true });
  assert.equal(sync.status(limited.sessionToken).enabled, true);
  assert.equal(sync.status(temporary.sessionToken).enabled, true);
  const membership = new Map(sync.membershipDirectory(adult.sessionToken)
    .map((member) => [member.memberId, member]));
  assert.equal(membership.get(adult.memberId).memberKind, "adult");
  assert.equal(membership.get(adult.memberId).memberActive, true);
  assert.equal(membership.get(limited.memberId).memberKind, "limited");
  assert.equal(membership.get(limited.memberId).memberActive, true);
  assert.equal(membership.get(temporary.memberId).memberKind, "temporary");
  assert.equal(membership.get(temporary.memberId).memberActive, true);
  assert.equal(membership.get(temporary.memberId).memberStatus, "active");
  assert.equal(membership.get(temporary.memberId).memberExpiresAt,
    pairing.members.get(temporary.memberId).expiresAt);
  const temporaryMember = pairing.members.get(temporary.memberId);
  const removedExpiry = pairing.members.get(removedTemporary.memberId).expiresAt;
  pairing.removeMembership(pairing.households.get(adult.householdId), removedTemporary.memberId, adult.memberId);
  sync.now = () => removedExpiry + 1;
  temporaryMember.expiresAt = Date.now() - 1;
  pairing.expireTemporaryMemberships(sync.now());
  pairing.removeMembership(pairing.households.get(adult.householdId), limited.memberId, adult.memberId);
  const ended = new Map(sync.membershipDirectory(adult.sessionToken).map((member) => [member.memberId, member]));
  assert.equal(ended.get(temporary.memberId).memberActive, false);
  assert.ok(ended.get(temporary.memberId).memberExpiresAt < Date.now());
  assert.equal(ended.get(temporary.memberId).memberStatus, "expired");
  assert.equal(ended.get(limited.memberId).memberActive, false);
  assert.equal(ended.get(limited.memberId).memberStatus, "removed");
  assert.equal(ended.get(removedTemporary.memberId).memberStatus, "removed");
  assert.equal(ended.get(removedTemporary.memberId).memberExpiresAt, removedExpiry);
});

test("attachment relay is opaque, authorized, idempotent, integrity checked, and removable", () => {
  const { adult, sync } = fixture();
  sync.enable(adult.sessionToken);
  const attachmentId = "c".repeat(32), ciphertext = Buffer.alloc(128, 0xa5);
  const digest = createHash("sha256").update(ciphertext).digest("hex");
  assert.deepEqual(sync.pushAttachment(adult.sessionToken, { attachmentId, keyEpoch: 1, ciphertext, digest }), { accepted: true, size: 128, digest });
  assert.deepEqual(sync.pushAttachment(adult.sessionToken, { attachmentId, keyEpoch: 1, ciphertext, digest }), { accepted: false, size: 128, digest });
  assert.deepEqual(sync.listAttachments(adult.sessionToken), [{ attachmentId, keyEpoch: 1, size: 128, digest }]);
  assert.deepEqual(sync.getAttachment(adult.sessionToken, attachmentId).ciphertext, ciphertext);
  assert.throws(() => sync.pushAttachment(adult.sessionToken, { attachmentId, keyEpoch: 1, ciphertext, digest: "0".repeat(64) }), (error) => error.code === "attachment_invalid");
  assert.throws(() => sync.pushAttachment(adult.sessionToken, { attachmentId, keyEpoch: 1, ciphertext: Buffer.alloc(128, 0x11), digest: createHash("sha256").update(Buffer.alloc(128, 0x11)).digest("hex") }), (error) => error.code === "attachment_conflict");
  assert.deepEqual(sync.removeAttachment(adult.sessionToken, attachmentId), { removed: true });
  assert.deepEqual(sync.removeAttachment(adult.sessionToken, attachmentId), { removed: true });
  assert.throws(() => sync.getAttachment(adult.sessionToken, attachmentId), (error) => error.code === "attachment_missing");
  assert.throws(() => sync.getAttachment("not-a-session", attachmentId), (error) => error.code === "authentication_required");
});

test("a queued attachment from a previously provisioned epoch can upload after key rotation", () => {
  const { pairing, adult, sync } = fixture();
  sync.enable(adult.sessionToken);
  const device = pairing.devices.get(adult.deviceId);
  device.syncProvisionedEpochs = [1, 2];
  sync.state(adult.householdId).currentEpoch = 2;
  const ciphertext = Buffer.alloc(64, 0x7a), digest = createHash("sha256").update(ciphertext).digest("hex");
  const row = { attachmentId: "d".repeat(32), keyEpoch: 1, ciphertext, digest };
  assert.deepEqual(sync.pushAttachment(adult.sessionToken, row), { accepted: true, size: 64, digest });
  assert.deepEqual(sync.pushAttachment(adult.sessionToken, row), { accepted: false, size: 64, digest });
});

test("relay accepts the exact bounded attachment aggregate and rejects the next byte", () => {
  const { adult, sync } = fixture();
  sync.enable(adult.sessionToken);
  const sizes = [...Array(12).fill(MAX_ATTACHMENT_BYTES), MAX_HOUSEHOLD_ATTACHMENT_BYTES - 12 * MAX_ATTACHMENT_BYTES - 29, 29];
  for (let index = 0; index < sizes.length; index += 1) {
    const ciphertext = Buffer.alloc(sizes[index], index + 1);
    const digest = createHash("sha256").update(ciphertext).digest("hex");
    assert.equal(sync.pushAttachment(adult.sessionToken, {
      attachmentId: (index + 1).toString(16).padStart(32, "0"), keyEpoch: 1, ciphertext, digest,
    }).accepted, true);
  }
  assert.throws(() => {
    const ciphertext = Buffer.alloc(29, 9);
    sync.pushAttachment(adult.sessionToken, {
      attachmentId: "f".repeat(32), keyEpoch: 1, ciphertext,
      digest: createHash("sha256").update(ciphertext).digest("hex"),
    });
  }, (error) => error.code === "attachment_limit");
});

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
      vault: null,
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
