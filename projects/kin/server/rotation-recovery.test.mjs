import assert from "node:assert/strict";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { MAX_KEY_EPOCHS, MAX_ROTATION_PACKAGES } from "./sync-contract.mjs";
import { SyncCoordinator } from "../web/sync/sync-coordinator.js";
import {
  generateDeviceKeys, exportDevicePublicKeys, deviceKeyFingerprint,
  createDeviceAuthorizationCertificate, createDeviceKeyTransition,
  createHouseholdEpochKey, createProvisionedHouseholdEpoch, provisionSealedEpochKey,
  resealHouseholdEpoch, unwrapEpochKey,
} from "../web/sync/crypto.js";

async function fixture(t) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const pairing = new PairingService();
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  const fingerprint = await deviceKeyFingerprint(publicKeys);
  const adult = pairing.bootstrap({ credential: { id: "adult", publicKey: "key", algorithm: -7 }, syncPublicKeys: publicKeys });
  const sync = new EncryptedSyncService(pairing);
  const partnerKeys = await generateDeviceKeys();
  const partnerPublic = await exportDevicePublicKeys(partnerKeys);
  const invite = pairing.createPairing(adult.sessionToken);
  const claim = pairing.claimPairing({ code: invite.code, deviceLabel: "Partner",
    credential: { id: "partner", publicKey: "partner-key", algorithm: -7 }, syncPublicKeys: partnerPublic });
  const claimant = pairing.pairings.get(invite.pairingId).claimant;
  const certificate = await createDeviceAuthorizationCertificate({ householdId: adult.householdId,
    memberId: claimant.memberId, deviceId: claimant.deviceId, issuerDeviceId: adult.deviceId,
    issuerFingerprint: fingerprint, publicKeys: partnerPublic, signingKey: keys.signingPrivateKey });
  pairing.approvePairing(adult.sessionToken, invite.pairingId, claim.version, certificate);
  const partner = pairing.activateClaim(claim.claimToken);
  sync.onAccessChange(adult.householdId);
  const initial = await createHouseholdEpochKey({ householdId: adult.householdId, keyEpoch: 1, deviceKeys: keys });
  const epochs = new Map([[1, initial]]);
  const state = { currentEpoch: 1, pendingRotation: null };
  let replacements = 0;
  // Browser coverage separately exercises these compare-and-set operations in
  // encrypted IndexedDB. This fixture controls request/response loss precisely.
  const store = {
    async getSyncState() { return structuredClone(state); },
    async savePendingRotation(value) {
      assert.equal(state.pendingRotation, null);
      state.pendingRotation = structuredClone(value);
      return structuredClone(value);
    },
    async replacePendingRotationPackages({ expected, packages, issuerFingerprint }) {
      assert.deepEqual(state.pendingRotation, expected);
      replacements++;
      state.pendingRotation = { ...state.pendingRotation, packages, issuerFingerprint };
      return structuredClone(state.pendingRotation);
    },
    async commitPendingRotation({ currentEpoch, proposalId }) {
      assert.equal(state.pendingRotation.proposalId, proposalId);
      state.pendingRotation = null;
      state.currentEpoch = currentEpoch;
    },
    async clearPendingRotation(proposalId) {
      assert.equal(state.pendingRotation.proposalId, proposalId);
      state.pendingRotation = null;
    },
  };
  const coordinator = new SyncCoordinator({ store, engine: {}, identity: adult });
  coordinator.deviceKeys = { keys, fingerprint };
  coordinator.keyStore = {
    async getEpoch(householdId, epoch) { return epochs.get(epoch); },
    async saveEpoch(record) {
      const existing = epochs.get(record.keyEpoch);
      if (existing) assert.equal(existing.fingerprint, record.fingerprint);
      epochs.set(record.keyEpoch, record);
    },
  };
  coordinator.loadDeviceDirectory = async () => sync.deviceDirectory(adult.sessionToken);
  coordinator.provisionMemberHistory = async () => {};
  const submitted = [];
  const request = async (path, options) => {
    if (path === "/api/sync/status") return sync.status(adult.sessionToken);
    assert.equal(path, "/api/sync/epochs");
    const value = JSON.parse(options.body);
    submitted.push(value);
    return sync.rotateEpoch(adult.sessionToken, value);
  };
  coordinator.request = request;
  return { pairing, sync, adult, partner, keys, partnerKeys, coordinator, state, epochs, submitted, request,
    advance: () => { now += 600_001; }, replacements: () => replacements,
    retry: () => coordinator.commitRotation(),
  };
}

async function interrupt(f, { accepted = false } = {}) {
  f.coordinator.request = async (path, options) => {
    if (path !== "/api/sync/epochs") return f.request(path, options);
    if (accepted) await f.request(path, options);
    throw new Error("Simulated connection loss");
  };
  await assert.rejects(f.retry(), /Simulated connection loss/);
  f.coordinator.request = f.request;
  return structuredClone(f.state.pendingRotation);
}

async function assertSameKey(f, keyPackage, deviceKeys = f.partnerKeys) {
  const restored = await unwrapEpochKey({ package: keyPackage, deviceKeys,
    householdId: f.adult.householdId, deviceId: f.partner.deviceId,
    deviceFingerprint: keyPackage.recipientFingerprint, senderSigningKey: f.keys.signingPublicKey });
  assert.equal(restored.fingerprint, f.epochs.get(2).fingerprint);
}

test("expired interrupted rotation refreshes packages without replacing the proposed epoch key", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f);
  f.advance();
  await f.retry();
  assert.equal(f.replacements(), 1);
  assert.equal(f.submitted[0].proposalId, original.proposalId);
  assert.notDeepEqual(f.submitted[0].packages, original.packages);
  assert.equal(f.epochs.get(2).fingerprint, original.fingerprint);
  assert.deepEqual(f.epochs.get(2).sealed, original.sealed);
  await assertSameKey(f, f.submitted[0].packages[0]);
  assert.equal(f.state.pendingRotation, null);
});

test("accepted rotation with a lost response is reconciled before expired packages change", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f, { accepted: true });
  f.advance();
  await f.retry();
  assert.equal(f.submitted.length, 1);
  assert.equal(f.replacements(), 0);
  assert.equal(f.epochs.get(2).fingerprint, original.fingerprint);
  assert.equal(f.state.pendingRotation, null);
});

test("access changes retain accepted proposal recovery while blocking event uploads", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f, { accepted: true });
  f.sync.onAccessChange(f.adult.householdId);
  await f.retry();
  assert.equal(f.epochs.get(2).fingerprint, original.fingerprint);
  const status = f.sync.status(f.adult.sessionToken);
  assert.equal(status.lastRotationProposalId, original.proposalId);
  assert.equal(status.rotationPending, true);
  assert.throws(() => f.sync.push(f.adult.sessionToken, []), error => error.code === "sync_rotation_pending");
  await f.retry();
  assert.equal(f.sync.status(f.adult.sessionToken).currentEpoch, 3);
});

test("a revoked rotation sender's expired committed package restores the next rotation", async (t) => {
  const f = await fixture(t);
  await f.retry();
  assert.ok(
    f.pairing.devices.get(f.adult.deviceId).syncProvisionedEpochs.includes(2),
    "the rotating device is recorded as holding its committed epoch",
  );

  const [packageForPartner] = f.sync.pendingProvisioning(
    f.partner.sessionToken,
  );
  const initialKey = await unwrapEpochKey({
    package: packageForPartner.package,
    deviceKeys: f.partnerKeys,
    householdId: f.adult.householdId,
    deviceId: f.partner.deviceId,
    deviceFingerprint: packageForPartner.recipientFingerprint,
    senderSigningKey: f.keys.signingPublicKey,
  });
  assert.equal(initialKey.fingerprint, f.epochs.get(2).fingerprint);
  f.sync.acknowledgeProvisioning(
    f.partner.sessionToken,
    packageForPartner.grantId,
  );

  f.sync.onAccessChange(f.adult.householdId);
  const recipient = f.sync.deviceDirectory(f.partner.sessionToken).find(
    (device) => device.deviceId === f.adult.deviceId,
  );
  const committed = await createProvisionedHouseholdEpoch({
    householdId: f.adult.householdId,
    keyEpoch: 3,
    deviceKeys: f.partnerKeys,
    senderDeviceId: f.partner.deviceId,
    recipients: [recipient],
    expiresAt: Date.now() + 600_000,
  });
  f.sync.rotateEpoch(f.partner.sessionToken, {
    expectedEpoch: 2,
    packages: committed.packages,
    proposalId: "9".repeat(32),
  });
  assert.ok(
    f.pairing.devices.get(f.partner.deviceId).syncProvisionedEpochs.includes(3),
    "the second rotating device is recorded as holding its committed epoch",
  );

  f.pairing.revokeDevice(
    f.adult.sessionToken,
    f.partner.deviceId,
    f.adult.memberId,
  );
  f.sync.onAccessChange(f.adult.householdId, [f.partner.deviceId]);
  f.advance();

  const [recovery] = f.sync.pendingProvisioning(f.adult.sessionToken);
  assert.equal(recovery.committedRotation, true);
  assert.equal(recovery.keyEpoch, 3);
  const recovered = await unwrapEpochKey({
    package: recovery.package,
    deviceKeys: f.keys,
    householdId: f.adult.householdId,
    deviceId: f.adult.deviceId,
    deviceFingerprint: f.coordinator.deviceKeys.fingerprint,
    senderSigningKey: f.partnerKeys.signingPublicKey,
    allowExpiredCommittedRotation: recovery.committedRotation,
  });
  assert.equal(recovered.fingerprint, committed.fingerprint);
  f.epochs.set(3, { ...recovered, sealed: null });
  f.sync.acknowledgeProvisioning(f.adult.sessionToken, recovery.grantId);
  assert.ok(
    f.pairing.devices.get(f.adult.deviceId).syncProvisionedEpochs.includes(3),
  );

  await f.retry();
  assert.equal(f.sync.status(f.adult.sessionToken).currentEpoch, 4);
});

test("a committed rotation package is discarded when its recipient is revoked", async (t) => {
  const f = await fixture(t);
  await f.retry();
  const before = f.sync.pendingProvisioning(f.partner.sessionToken);
  assert.equal(before.length, 1);
  assert.equal(before[0].committedRotation, true);

  f.pairing.revokeDevice(
    f.adult.sessionToken,
    f.partner.deviceId,
    f.adult.memberId,
  );
  f.sync.onAccessChange(f.adult.householdId, [f.partner.deviceId]);
  assert.equal(f.sync.state(f.adult.householdId).grants.size, 0);
});

// #176: the pending key was wrapped for the recipient's previous key, so an
// unaccepted proposal is replaced with a fresh epoch key for the new one.
test("recipient key succession replaces an unaccepted pending rotation with a fresh epoch key", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f);
  const replacement = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(replacement);
  const transition = await createDeviceKeyTransition({ ...f.partner, generation: 1,
    oldFingerprint: original.packages[0].recipientFingerprint,
    publicKeys, signingKey: f.partnerKeys.signingPrivateKey });
  f.pairing.transitionSyncPublicKeys(f.partner.sessionToken, transition);
  f.sync.onDeviceKeyTransition(f.adult.householdId, f.partner.deviceId);
  await f.retry();
  assert.notEqual(f.epochs.get(2).fingerprint, original.fingerprint);
  await assertSameKey(f, f.submitted[0].packages[0], replacement);
});

// #176: never commit a key already wrapped for the revoked device.
test("a revoked recipient makes an unaccepted pending rotation use a fresh epoch key", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f);
  f.pairing.devices.get(f.partner.deviceId).revokedAt = Date.now();
  f.sync.onAccessChange(f.adult.householdId, [f.partner.deviceId]);
  await f.retry();
  assert.deepEqual(f.submitted[0].packages, []);
  assert.notEqual(f.epochs.get(2).fingerprint, original.fingerprint);
});

test("issuer key migration reseals the pending epoch and refreshes its package signatures", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f);
  const replacement = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(replacement);
  const transition = await createDeviceKeyTransition({ ...f.adult, generation: 1,
    oldFingerprint: f.coordinator.deviceKeys.fingerprint,
    publicKeys, signingKey: f.keys.signingPrivateKey });
  f.state.pendingRotation.sealed = await resealHouseholdEpoch({ sealed: original.sealed,
    oldDeviceKeys: f.keys, newDeviceKeys: replacement });
  f.pairing.transitionSyncPublicKeys(f.adult.sessionToken, transition);
  f.sync.onDeviceKeyTransition(f.adult.householdId, f.adult.deviceId);
  f.keys = replacement;
  f.coordinator.deviceKeys = { keys: replacement, fingerprint: transition.fingerprint };
  await f.retry();
  assert.equal(f.epochs.get(2).fingerprint, original.fingerprint);
  assert.equal(f.submitted[0].proposalId, original.proposalId);
  await assertSameKey(f, f.submitted[0].packages[0]);
});

test("original submission accepted during package refresh recovers its identical key on the next retry", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f);
  // A legacy migration changes the issuer marker and requires fresh packages;
  // the still-valid original request can arrive after status reconciliation.
  delete f.state.pendingRotation.issuerFingerprint;
  let raced = false;
  f.coordinator.request = async (path, options) => {
    if (path === "/api/sync/epochs" && !raced) {
      raced = true;
      f.sync.rotateEpoch(f.adult.sessionToken, original);
    }
    return f.request(path, options);
  };
  await assert.rejects(f.retry(), error => error.code === "stale_key_epoch");
  assert.equal(f.epochs.has(2), false);
  assert.equal(f.state.pendingRotation.proposalId, original.proposalId);
  await f.retry();
  assert.equal(f.epochs.get(2).fingerprint, original.fingerprint);
  assert.equal(f.state.pendingRotation, null);
});

test("a competing accepted proposal never installs the local losing proposal's epoch key", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f);
  const competing = await createProvisionedHouseholdEpoch({ householdId: f.adult.householdId,
    keyEpoch: 2, deviceKeys: f.keys, senderDeviceId: f.adult.deviceId,
    recipients: f.sync.deviceDirectory(f.adult.sessionToken).filter(device => device.deviceId !== f.adult.deviceId),
    expiresAt: Date.now() + 600_000 });
  f.sync.rotateEpoch(f.adult.sessionToken, { expectedEpoch: 1, proposalId: "f".repeat(32), packages: competing.packages });
  await assert.rejects(f.retry(), /approved key transfer/);
  assert.equal(f.epochs.has(2), false);
  assert.equal(f.state.pendingRotation.fingerprint, original.fingerprint);
  f.epochs.set(2, competing);
  await f.retry();
  assert.equal(f.epochs.get(2).fingerprint, competing.fingerprint);
  assert.equal(f.state.pendingRotation, null);
});

test("a mismatched rotation acknowledgement cannot install the proposed key", async (t) => {
  const f = await fixture(t);
  f.coordinator.request = async (path, options) => path === "/api/sync/epochs"
    ? { currentEpoch: 3, proposalId: "f".repeat(32) } : f.request(path, options);
  await assert.rejects(f.retry(), /match the accepted key rotation/);
  assert.equal(f.epochs.has(2), false);
  assert.equal(f.epochs.has(3), false);
  assert.ok(f.state.pendingRotation);
});

for (const change of ["peer lock", "root rotation"]) {
  test(`an in-flight provisioning response cannot resume after a missed ${change} broadcast`, async (t) => {
    const marker = { lockEpoch: 4, rootVersion: 1 };
    let checks = 0, locked = false, privateProcessing = false, release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const response = new Promise(resolve => { release = resolve; });
    t.mock.method(globalThis, "fetch", async () => {
      entered();
      return { ok: true, json: () => response };
    });
    const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: {} });
    coordinator.keyStore = { vault: {
      assertUnlocked() { if (locked) throw Object.assign(new Error("Local vault locked"), { code: "locked" }); },
      async checkSecurityEpoch() {
        checks++;
        if (marker.lockEpoch !== 4 || marker.rootVersion !== 1) {
          locked = true;
          throw Object.assign(new Error("The durable local protection epoch changed"), { code: "locked" });
        }
      },
    } };
    const sender = { deviceId: "sender", publicKeys: {},
      get verifiedKeyHistory() { privateProcessing = true; return []; } };
    const receiving = coordinator.receiveProvisioning([sender]);
    const rejected = assert.rejects(receiving, error => error.code === "locked");
    await started;
    // Deliberately do not invoke stop()/lock(): the broadcast was missed.
    marker.lockEpoch++;
    if (change === "root rotation") marker.rootVersion++;
    release({ grants: [{ senderDeviceId: sender.deviceId }] });
    await rejected;
    assert.equal(checks, 2);
    assert.equal(locked, true);
    assert.equal(privateProcessing, false, "stale response must stop before entering private key processing");
  });
}

// ---------------------------------------------------------------------------
// B-002 committed-rotation recovery: authorization, cryptographic binding,
// continuity, and capacity. Packages are real ECDH/ECDSA key transfers.
// ---------------------------------------------------------------------------

async function admit(f, kind, label, options = {}) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  const invite = f.pairing.createPairing(f.adult.sessionToken, { kind, ...options });
  const claim = f.pairing.claimPairing({ code: invite.code, deviceLabel: label,
    credential: { id: label, publicKey: `${label}-key`, algorithm: -7 }, syncPublicKeys: publicKeys });
  const claimant = f.pairing.pairings.get(invite.pairingId).claimant;
  const certificate = await createDeviceAuthorizationCertificate({ householdId: f.adult.householdId,
    memberId: claimant.memberId, deviceId: claimant.deviceId, issuerDeviceId: f.adult.deviceId,
    issuerFingerprint: f.coordinator.deviceKeys.fingerprint, publicKeys, signingKey: f.keys.signingPrivateKey });
  f.pairing.approvePairing(f.adult.sessionToken, invite.pairingId, claim.version, certificate);
  const session = f.pairing.activateClaim(claim.claimToken);
  f.sync.onAccessChange(f.adult.householdId);
  return { ...session, keys };
}

// Commits the next epoch from another Adult's device, exactly as its client would.
async function commitAs(f, member, deviceKeys, expectedEpoch, proposalId, mapPackage = (value) => value) {
  const recipients = f.sync.deviceDirectory(member.sessionToken).filter((device) =>
    device.deviceId !== member.deviceId && !device.revokedAt && device.memberActive);
  const committed = await createProvisionedHouseholdEpoch({ householdId: f.adult.householdId,
    keyEpoch: expectedEpoch + 1, deviceKeys, senderDeviceId: member.deviceId, recipients,
    expiresAt: Date.now() + 600_000 });
  f.sync.rotateEpoch(member.sessionToken, { expectedEpoch, proposalId,
    packages: committed.packages.map(mapPackage) });
  return committed;
}

// Routes the Adult's coordinator provisioning requests to the in-process relay.
function connectProvisioning(f) {
  const acks = [];
  f.coordinator.request = async (path, options) => {
    if (path === "/api/sync/provisioning")
      return { grants: f.sync.pendingProvisioning(f.adult.sessionToken) };
    const ack = path.match(/^\/api\/sync\/provisioning\/([a-f0-9]{32})\/ack$/);
    if (ack) {
      acks.push(ack[1]);
      return f.sync.acknowledgeProvisioning(f.adult.sessionToken, ack[1]);
    }
    return f.request(path, options);
  };
  return acks;
}

// The coordinator receives directory entries whose key history it already
// verified; tests supply that verified history explicitly.
function verifiedDirectory(f, overrides = new Map()) {
  return f.sync.deviceDirectory(f.adult.sessionToken).map((device) => ({ ...device,
    verifiedKeyHistory: overrides.get(device.deviceId) ??
      device.keyHistory ?? [{ publicKeys: device.publicKeys, fingerprint: device.fingerprint }] }));
}

function envelope(member, householdId, { eventId, deviceSequence = 1, keyEpoch }) {
  return {
    protocolVersion: 1, envelopeVersion: 1, eventId, householdId, deviceId: member.deviceId,
    deviceSequence, logicalTime: String(deviceSequence), keyEpoch,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    signature: Buffer.alloc(64, 3).toString("base64url"),
  };
}

function committedGrantFor(f, deviceId) {
  return [...f.sync.state(f.adult.householdId).grants.values()]
    .find((grant) => grant.recipientDeviceId === deviceId);
}

test("committed recovery packages reach only recipients that still hold household trust", async (t) => {
  const f = await fixture(t);
  const householdId = f.adult.householdId;
  const limited = await admit(f, "limited", "limited");
  const removed = await admit(f, "limited", "removed");
  const temporary = await admit(f, "temporary", "temporary", { expiresAt: Date.now() + 120_000 });
  await f.retry();
  for (const member of [f.partner, limited, removed, temporary]) {
    const [grant] = f.sync.pendingProvisioning(member.sessionToken);
    assert.equal(grant.committedRotation, true);
    assert.equal(grant.keyEpoch, 2);
  }
  const partnerGrant = committedGrantFor(f, f.partner.deviceId);
  const limitedGrant = committedGrantFor(f, limited.deviceId);
  const removedGrant = committedGrantFor(f, removed.deviceId);
  const temporaryGrant = committedGrantFor(f, temporary.deviceId);
  assert.throws(() => f.sync.acknowledgeProvisioning(limited.sessionToken, partnerGrant.grantId),
    (error) => error.code === "provisioning_device_mismatch", "a device cannot acknowledge another device's package");

  // Revoked recipient: the package is removed and the stale session is refused.
  f.pairing.revokeDevice(f.adult.sessionToken, f.partner.deviceId, f.adult.memberId);
  f.sync.onAccessChange(householdId, [f.partner.deviceId]);
  assert.equal(f.sync.state(householdId).grants.has(partnerGrant.grantId), false);
  assert.throws(() => f.sync.pendingProvisioning(f.partner.sessionToken), (error) => error.status === 401);
  assert.throws(() => f.sync.acknowledgeProvisioning(f.partner.sessionToken, partnerGrant.grantId),
    (error) => error.status === 401);

  // Removed member: removal revokes its devices and discards their packages.
  f.pairing.removeMembership(f.pairing.households.get(householdId), removed.memberId, f.adult.memberId);
  f.sync.onAccessChange(householdId, [removed.deviceId]);
  assert.equal(f.sync.state(householdId).grants.has(removedGrant.grantId), false);
  assert.throws(() => f.sync.pendingProvisioning(removed.sessionToken), (error) => error.status === 401);

  // Temporary expiry: the committed exception outlives the package TTL, but
  // never the member's own access window.
  f.advance();
  assert.throws(() => f.sync.pendingProvisioning(temporary.sessionToken),
    (error) => error.code === "membership_removed", "expired access is refused before cleanup runs");
  assert.throws(() => f.sync.acknowledgeProvisioning(temporary.sessionToken, temporaryGrant.grantId),
    (error) => error.code === "membership_removed");
  for (const expired of f.pairing.expireTemporaryMemberships(Date.now()))
    f.sync.onAccessChange(expired.householdId, expired.deviceIds);
  assert.equal(f.sync.state(householdId).grants.has(temporaryGrant.grantId), false);

  // The remaining trusted recipient still recovers its expired committed package.
  const [recovery] = f.sync.pendingProvisioning(limited.sessionToken);
  assert.equal(recovery.grantId, limitedGrant.grantId);
  const recovered = await unwrapEpochKey({ package: recovery.package, deviceKeys: limited.keys,
    householdId, deviceId: limited.deviceId, deviceFingerprint: recovery.recipientFingerprint,
    senderSigningKey: f.keys.signingPublicKey, allowExpiredCommittedRotation: recovery.committedRotation });
  assert.equal(recovered.fingerprint, f.epochs.get(2).fingerprint);
  f.sync.acknowledgeProvisioning(limited.sessionToken, recovery.grantId);
  assert.deepEqual([...f.sync.state(householdId).grants.keys()], [limitedGrant.grantId]);
});

test("any access change drops committed packages whose recipient lost trust, even without an exclusion list", async (t) => {
  const f = await fixture(t);
  const householdId = f.adult.householdId;
  const limited = await admit(f, "limited", "limited");
  const temporary = await admit(f, "temporary", "temporary", { expiresAt: Date.now() + 120_000 });
  await f.retry();
  const temporaryGrant = committedGrantFor(f, temporary.deviceId);
  const limitedGrant = committedGrantFor(f, limited.deviceId);
  const partnerGrant = committedGrantFor(f, f.partner.deviceId);

  // The Temporary window ends and the partner device is marked revoked, but an
  // unrelated access change runs before the expiry sweep or revocation hook.
  f.advance();
  f.pairing.devices.get(f.partner.deviceId).revokedAt = Date.now();
  f.sync.onAccessChange(householdId);
  const grants = f.sync.state(householdId).grants;
  assert.equal(grants.has(temporaryGrant.grantId), false);
  assert.equal(grants.has(partnerGrant.grantId), false);
  assert.equal(grants.has(limitedGrant.grantId), true, "a still-trusted recipient keeps its expired package");
});

test("the expired-package exception never relaxes recipient binding or signature verification", async (t) => {
  const f = await fixture(t);
  const householdId = f.adult.householdId;
  await f.retry();
  const [grant] = f.sync.pendingProvisioning(f.partner.sessionToken);
  f.advance();
  const keyPackage = grant.package;
  const open = (overrides = {}) => unwrapEpochKey({ package: keyPackage, deviceKeys: f.partnerKeys,
    householdId, deviceId: f.partner.deviceId, deviceFingerprint: grant.recipientFingerprint,
    senderSigningKey: f.keys.signingPublicKey, allowExpiredCommittedRotation: true, ...overrides });
  const flip = (value) => {
    const bytes = Buffer.from(value, "base64url");
    bytes[0] ^= 1;
    return bytes.toString("base64url");
  };
  const code = (expected) => (error) => error.code === expected;

  assert.equal((await open()).fingerprint, f.epochs.get(2).fingerprint);
  await assert.rejects(open({ allowExpiredCommittedRotation: false }), code("provisioning_expired"));
  for (const field of ["wrappedKey", "salt", "nonce", "signature"])
    await assert.rejects(open({ package: { ...keyPackage, [field]: flip(keyPackage[field]) } }),
      code("provisioning_signature_invalid"), `tampered ${field}`);
  // Signed routing metadata cannot be moved to another epoch or extended.
  await assert.rejects(open({ package: { ...keyPackage, keyEpoch: 3 } }), code("provisioning_signature_invalid"));
  await assert.rejects(open({ package: { ...keyPackage, expiresAt: keyPackage.expiresAt + 86_400_000 } }),
    code("provisioning_signature_invalid"));

  // A key that is not the named sender's cannot forge a recoverable package.
  const attacker = await generateDeviceKeys();
  const recipient = f.sync.deviceDirectory(f.adult.sessionToken)
    .find((device) => device.deviceId === f.partner.deviceId);
  const forged = await createProvisionedHouseholdEpoch({ householdId, keyEpoch: 2, deviceKeys: attacker,
    senderDeviceId: f.adult.deviceId, recipients: [recipient], expiresAt: keyPackage.expiresAt });
  await assert.rejects(open({ package: forged.packages[0] }), code("provisioning_signature_invalid"));

  // A package addressed to another device is refused before decryption.
  await assert.rejects(open({ package: { ...keyPackage, recipientDeviceId: f.adult.deviceId } }),
    code("provisioning_device_mismatch"));
  await assert.rejects(open({ deviceId: f.adult.deviceId }), code("provisioning_device_mismatch"));

  // After recipient key succession the relay drops the package, and the
  // replacement key cannot adopt a package bound to the old fingerprint.
  const replacement = await generateDeviceKeys();
  const transition = await createDeviceKeyTransition({ ...f.partner, generation: 1,
    oldFingerprint: grant.recipientFingerprint, publicKeys: await exportDevicePublicKeys(replacement),
    signingKey: f.partnerKeys.signingPrivateKey });
  f.pairing.transitionSyncPublicKeys(f.partner.sessionToken, transition);
  f.sync.onDeviceKeyTransition(householdId, f.partner.deviceId);
  assert.deepEqual(f.sync.pendingProvisioning(f.partner.sessionToken), []);
  await assert.rejects(open({ deviceKeys: replacement, deviceFingerprint: transition.fingerprint }),
    code("provisioning_device_mismatch"));
});

test("only the relay's own committed-rotation record grants the expired-package exception", async (t) => {
  const f = await fixture(t);
  const householdId = f.adult.householdId;
  await f.retry();
  const [partnerPackage] = f.sync.pendingProvisioning(f.partner.sessionToken);
  f.sync.acknowledgeProvisioning(f.partner.sessionToken, partnerPackage.grantId);

  // A rotating client cannot opt its packages out of committed recovery...
  f.sync.onAccessChange(householdId);
  await commitAs(f, f.partner, f.partnerKeys, 2, "5".repeat(32),
    (value) => ({ ...value, committedRotation: false }));
  assert.equal(committedGrantFor(f, f.adult.deviceId).committedRotation, true);

  // ...and an ordinary transfer cannot claim it through its package body.
  const grant = f.sync.createProvisioningGrant(f.adult.sessionToken,
    { recipientDeviceId: f.partner.deviceId, keyEpoch: 1, requestId: "6".repeat(32) });
  const keyPackage = await provisionSealedEpochKey({ sealed: f.epochs.get(1).sealed, deviceKeys: f.keys,
    grant: { ...grant, signingKey: f.keys.signingPrivateKey } });
  f.sync.submitProvisioning(f.adult.sessionToken, grant.grantId, { ...keyPackage, committedRotation: true });
  const [delivered] = f.sync.pendingProvisioning(f.partner.sessionToken);
  assert.equal(delivered.grantId, grant.grantId);
  assert.equal(delivered.committedRotation, undefined);

  f.advance();
  assert.throws(() => f.sync.acknowledgeProvisioning(f.partner.sessionToken, grant.grantId),
    (error) => error.code === "provisioning_expired" && error.status === 410);
  assert.deepEqual(f.sync.pendingProvisioning(f.partner.sessionToken), []);
  assert.equal(f.sync.state(householdId).grants.has(grant.grantId), false);
  await assert.rejects(unwrapEpochKey({ package: delivered.package, deviceKeys: f.partnerKeys, householdId,
    deviceId: f.partner.deviceId, deviceFingerprint: delivered.recipientFingerprint,
    senderSigningKey: f.keys.signingPublicKey,
    allowExpiredCommittedRotation: delivered.committedRotation === true }),
  (error) => error.code === "provisioning_expired");
});

test("an offline Adult recovers consecutive epochs from a later-revoked Adult and keeps history intact", async (t) => {
  const f = await fixture(t);
  const householdId = f.adult.householdId;
  await f.retry();
  const [partnerPackage] = f.sync.pendingProvisioning(f.partner.sessionToken);
  f.sync.acknowledgeProvisioning(f.partner.sessionToken, partnerPackage.grantId);
  f.sync.push(f.adult.sessionToken, [envelope(f.adult, householdId, { eventId: "a".repeat(32), keyEpoch: 2 })]);

  // A is offline while B commits two consecutive rotations, writing between them.
  f.sync.onAccessChange(householdId);
  const epoch3 = await commitAs(f, f.partner, f.partnerKeys, 2, "3".repeat(32));
  f.sync.push(f.partner.sessionToken, [envelope(f.partner, householdId, { eventId: "b".repeat(32), keyEpoch: 3 })]);
  f.sync.onAccessChange(householdId);
  const epoch4 = await commitAs(f, f.partner, f.partnerKeys, 3, "4".repeat(32));
  assert.deepEqual(f.pairing.devices.get(f.partner.deviceId).syncProvisionedEpochs, [2, 3, 4]);

  // B is revoked before A receives either package, and both TTLs pass.
  f.pairing.revokeDevice(f.adult.sessionToken, f.partner.deviceId, f.adult.memberId);
  f.sync.onAccessChange(householdId, [f.partner.deviceId]);
  f.advance();
  const historyBefore = f.sync.pull(f.adult.sessionToken, "", "20");
  assert.deepEqual(f.sync.pendingProvisioning(f.adult.sessionToken).map((grant) => grant.keyEpoch), [3, 4]);

  // A lost acknowledgement response is redelivered and accepted idempotently.
  const acks = connectProvisioning(f);
  const relay = f.coordinator.request;
  let dropped = false;
  f.coordinator.request = async (path, options) => {
    const result = await relay(path, options);
    if (!dropped && path.endsWith("/ack")) {
      dropped = true;
      throw new Error("Simulated lost acknowledgement");
    }
    return result;
  };
  await assert.rejects(f.coordinator.receiveProvisioning(verifiedDirectory(f), f.sync.status(f.adult.sessionToken)), /lost acknowledgement/);
  f.coordinator.request = relay;
  await f.coordinator.receiveProvisioning(verifiedDirectory(f), f.sync.status(f.adult.sessionToken));
  assert.equal(f.epochs.get(3).fingerprint, epoch3.fingerprint);
  assert.equal(f.epochs.get(4).fingerprint, epoch4.fingerprint);
  assert.equal(new Set(acks).size, 2);
  assert.deepEqual(f.pairing.devices.get(f.adult.deviceId).syncProvisionedEpochs, [2, 3, 4]);
  assert.deepEqual(f.sync.pendingProvisioning(f.adult.sessionToken), []);
  const delivered = acks.length;
  await f.coordinator.receiveProvisioning(verifiedDirectory(f), f.sync.status(f.adult.sessionToken));
  assert.equal(acks.length, delivered, "a completed recovery is not delivered again");

  // A completes the next required rotation without skipping an epoch.
  await f.retry();
  const status = f.sync.status(f.adult.sessionToken);
  assert.equal(status.currentEpoch, 5);
  assert.equal(status.rotationPending, false);
  assert.deepEqual(f.pairing.devices.get(f.adult.deviceId).syncProvisionedEpochs, [2, 3, 4, 5]);

  // Recovery neither rewrote nor duplicated relay history.
  assert.deepEqual(f.sync.pull(f.adult.sessionToken, "", "20"), historyBefore);
  assert.deepEqual(historyBefore.events.map((row) => row.envelope.eventId), ["a".repeat(32), "b".repeat(32)]);
  assert.equal(f.sync.status(f.adult.sessionToken).eventCount, 2);

  // The revoked device cannot write, retry its rotation, or rotate again.
  assert.throws(() => f.sync.push(f.partner.sessionToken,
    [envelope(f.partner, householdId, { eventId: "c".repeat(32), deviceSequence: 2, keyEpoch: 4 })]),
  (error) => error.status === 401);
  assert.throws(() => f.sync.rotateEpoch(f.partner.sessionToken,
    { expectedEpoch: 3, packages: epoch4.packages, proposalId: "4".repeat(32) }),
  (error) => error.status === 401);

  // Acknowledged packages stop consuming durable capacity after their TTL.
  f.advance();
  f.sync.pendingProvisioning(f.adult.sessionToken);
  assert.equal(f.sync.state(householdId).grants.size, 0);
});

test("committed packages signed before sender key succession verify only against the authentic key history", async (t) => {
  const f = await fixture(t);
  const householdId = f.adult.householdId;
  await f.retry();
  const [partnerPackage] = f.sync.pendingProvisioning(f.partner.sessionToken);
  f.sync.acknowledgeProvisioning(f.partner.sessionToken, partnerPackage.grantId);
  f.sync.onAccessChange(householdId);
  const committed = await commitAs(f, f.partner, f.partnerKeys, 2, "7".repeat(32));

  // B migrates its device key after committing, then is revoked.
  const original = f.sync.deviceDirectory(f.adult.sessionToken)
    .find((device) => device.deviceId === f.partner.deviceId);
  const successor = await generateDeviceKeys();
  const successorPublic = await exportDevicePublicKeys(successor);
  const transition = await createDeviceKeyTransition({ ...f.partner, generation: 1,
    oldFingerprint: original.fingerprint, publicKeys: successorPublic,
    signingKey: f.partnerKeys.signingPrivateKey });
  f.pairing.transitionSyncPublicKeys(f.partner.sessionToken, transition);
  f.sync.onDeviceKeyTransition(householdId, f.partner.deviceId);
  assert.equal(committedGrantFor(f, f.adult.deviceId)?.committedRotation, true,
    "sender key succession keeps the package verifiable against its historical key");
  f.pairing.revokeDevice(f.adult.sessionToken, f.partner.deviceId, f.adult.memberId);
  f.sync.onAccessChange(householdId, [f.partner.deviceId]);
  f.advance();
  const acks = connectProvisioning(f);
  const localBefore = structuredClone(f.state);

  // A history missing the signing key fails without installing or acknowledging.
  await assert.rejects(f.coordinator.receiveProvisioning(verifiedDirectory(f,
    new Map([[f.partner.deviceId, [{ publicKeys: successorPublic, fingerprint: transition.fingerprint }]]])),
  f.sync.status(f.adult.sessionToken)),
  /no valid historical signer/);
  assert.equal(f.epochs.has(3), false);
  assert.equal(acks.length, 0);
  assert.deepEqual(f.state, localBefore, "failed recovery leaves local sync state untouched");
  assert.equal(f.sync.pendingProvisioning(f.adult.sessionToken).length, 1, "the relay keeps the package for a retry");

  // The authentic history (original, then successor) verifies the original signature.
  const history = f.sync.deviceDirectory(f.adult.sessionToken)
    .find((device) => device.deviceId === f.partner.deviceId).keyHistory;
  assert.deepEqual(history.map((entry) => entry.fingerprint), [original.fingerprint, transition.fingerprint]);
  await f.coordinator.receiveProvisioning(verifiedDirectory(f), f.sync.status(f.adult.sessionToken));
  assert.equal(f.epochs.get(3).fingerprint, committed.fingerprint);
  assert.equal(acks.length, 1);
  await f.retry();
  assert.equal(f.sync.status(f.adult.sessionToken).currentEpoch, 4);
});

test("retained committed packages are bounded without blocking any supported rotation history", async (t) => {
  const f = await fixture(t);
  const householdId = f.adult.householdId;
  const state = f.sync.state(householdId);
  const retain = (count) => {
    state.grants.clear();
    for (let index = 0; index < count; index += 1) {
      const grantId = (index + 1).toString(16).padStart(32, "0");
      state.grants.set(grantId, { grantId, committedRotation: true, state: "pending",
        recipientDeviceId: f.partner.deviceId, senderDeviceId: f.adult.deviceId,
        expiresAt: Date.now() + 600_000, keyEpoch: 2 });
    }
  };
  const prepare = async () => {
    const recipients = f.sync.deviceDirectory(f.adult.sessionToken)
      .filter((device) => device.deviceId !== f.adult.deviceId);
    const next = await createProvisionedHouseholdEpoch({ householdId, keyEpoch: MAX_KEY_EPOCHS,
      deviceKeys: f.keys, senderDeviceId: f.adult.deviceId, recipients, expiresAt: Date.now() + 600_000 });
    return () => f.sync.rotateEpoch(f.adult.sessionToken,
      { expectedEpoch: MAX_KEY_EPOCHS - 1, packages: next.packages, proposalId: "8".repeat(32) });
  };
  state.currentEpoch = MAX_KEY_EPOCHS - 1;

  // Above the bound (reachable only through corruption), the rotation is
  // refused before any state, including the sender's held epoch, changes.
  retain(MAX_KEY_EPOCHS * MAX_ROTATION_PACKAGES);
  assert.throws(await prepare(), (error) => error.code === "provisioning_capacity");
  assert.equal(state.currentEpoch, MAX_KEY_EPOCHS - 1);
  assert.equal(state.rotationPending, true);
  assert.equal(state.grants.size, MAX_KEY_EPOCHS * MAX_ROTATION_PACKAGES);
  assert.equal(f.pairing.devices.get(f.adult.deviceId).syncProvisionedEpochs?.includes(MAX_KEY_EPOCHS) ?? false, false);

  // Every supported history fits: even if each earlier rotation left the
  // maximum package count unacknowledged, the final epoch still commits.
  const supported = (MAX_KEY_EPOCHS - 1) * MAX_ROTATION_PACKAGES;
  retain(supported - 1);
  (await prepare())();
  assert.equal(state.currentEpoch, MAX_KEY_EPOCHS);
  assert.equal(state.grants.size, supported);

  // Retained recovery packages never consume ordinary transfer capacity.
  const grant = f.sync.createProvisioningGrant(f.adult.sessionToken,
    { recipientDeviceId: f.partner.deviceId, keyEpoch: MAX_KEY_EPOCHS });
  assert.equal(grant.committedRotation, undefined);
});
