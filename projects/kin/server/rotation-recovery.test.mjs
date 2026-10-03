import assert from "node:assert/strict";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { SyncCoordinator } from "../web/sync/sync-coordinator.js";
import {
  generateDeviceKeys, exportDevicePublicKeys, deviceKeyFingerprint,
  createDeviceAuthorizationCertificate, createDeviceKeyTransition,
  createHouseholdEpochKey, createProvisionedHouseholdEpoch, resealHouseholdEpoch, unwrapEpochKey,
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

test("recipient key succession refreshes pending packages for the same epoch secret", async (t) => {
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
  assert.equal(f.epochs.get(2).fingerprint, original.fingerprint);
  await assertSameKey(f, f.submitted[0].packages[0], replacement);
});

test("revoked recipients are removed from an unaccepted pending rotation", async (t) => {
  const f = await fixture(t);
  const original = await interrupt(f);
  f.pairing.devices.get(f.partner.deviceId).revokedAt = Date.now();
  f.sync.onAccessChange(f.adult.householdId, [f.partner.deviceId]);
  await f.retry();
  assert.deepEqual(f.submitted[0].packages, []);
  assert.equal(f.epochs.get(2).fingerprint, original.fingerprint);
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
