// Issue #152 (S2): a key grant's epoch, sender, recipient and household come
// only from the signed package. The relay's outer fields are unsigned, so a
// mismatch is refused, nothing is saved and nothing is acknowledged. An
// expired package is accepted only for an epoch the household has committed.
// Real WebCrypto; no network, no IndexedDB.
import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceKeyFingerprint,
  exportDevicePublicKeys,
  generateDeviceKeys,
  wrapEpochKey,
} from "./crypto.js";
import { SyncKeyStore } from "./key-store.js";
import { SyncCoordinator } from "./sync-coordinator.js";

const HOUSEHOLD = "a".repeat(32);
const OTHER_HOUSEHOLD = "e".repeat(32);
const SENDER = "b".repeat(32);
const OTHER_SENDER = "f".repeat(32);
const ME = "c".repeat(32);
const OTHER_DEVICE = "9".repeat(32);
const GRANT = "d".repeat(32);
const NOW = Date.now();
const LONG_AGO = 1_000;

const sender = await generateDeviceKeys();
const otherSender = await generateDeviceKeys();
const mine = await generateDeviceKeys();
const otherDevice = await generateDeviceKeys();
const senderPublic = await exportDevicePublicKeys(sender);
const otherSenderPublic = await exportDevicePublicKeys(otherSender);
const myPublic = await exportDevicePublicKeys(mine);
const otherDevicePublic = await exportDevicePublicKeys(otherDevice);
const myFingerprint = await deviceKeyFingerprint(myPublic);

const directory = [
  { deviceId: SENDER, publicKeys: senderPublic, verifiedKeyHistory: [{ publicKeys: senderPublic }] },
  { deviceId: OTHER_SENDER, publicKeys: otherSenderPublic, verifiedKeyHistory: [{ publicKeys: otherSenderPublic }] },
];

/** A correctly signed package; override any field to build a hostile case. */
async function signedPackage({
  keyEpoch,
  expiresAt = NOW + 60_000,
  householdId = HOUSEHOLD,
  recipientDeviceId = ME,
  recipientPublicKeys = myPublic,
  signingKey = sender.signingPrivateKey,
  senderDeviceId = SENDER,
} = {}) {
  return wrapEpochKey({
    rawKey: crypto.getRandomValues(new Uint8Array(32)),
    householdId,
    senderDeviceId,
    recipientDeviceId,
    recipientPublicKeys,
    recipientFingerprint: await deviceKeyFingerprint(recipientPublicKeys),
    keyEpoch,
    grantId: GRANT,
    expiresAt,
    signingKey,
  });
}

/** A coordinator wired to a fake relay that serves `grant` once. */
function receiver(grant) {
  const saved = [];
  const acked = [];
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.identity = { householdId: HOUSEHOLD, deviceId: ME };
  coordinator.deviceKeys = { keys: mine, fingerprint: myFingerprint };
  coordinator.keyStore = {
    async saveEpoch(record) {
      saved.push({ keyEpoch: record.keyEpoch, sealedEpoch: record.sealed?.keyEpoch });
      return record;
    },
  };
  let served = false;
  coordinator.request = async (path) => {
    if (path === "/api/sync/provisioning") {
      if (served) return { grants: [] };
      served = true;
      return { grants: [grant] };
    }
    if (path.endsWith("/ack")) {
      acked.push(path);
      return {};
    }
    throw new Error(`unexpected request ${path}`);
  };
  return { coordinator, saved, acked };
}

const refused = (error) => error.code === "provisioning_grant_refused";
const expired = (error) => error.code === "provisioning_expired";

test("an expired epoch-3 package relabelled as committed epoch 5 is refused, unsaved and unacknowledged", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 3, expiresAt: LONG_AGO });
  const { coordinator, saved, acked } = receiver({
    grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 5, committedRotation: true, package: keyPackage,
  });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 5 }), refused);
  assert.deepEqual(saved, []);
  assert.deepEqual(acked, []);
});

test("a fresh package relabelled with a different epoch is refused", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 3 });
  const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 4, package: keyPackage });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 4 }), refused);
  assert.deepEqual([saved, acked], [[], []]);
});

test("a package for another household is refused", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 2, householdId: OTHER_HOUSEHOLD });
  const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 2, package: keyPackage });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 2 }), refused);
  assert.deepEqual([saved, acked], [[], []]);
});

test("a package whose signed sender differs from the relay's sender is refused", async () => {
  // Signed by SENDER, served as if OTHER_SENDER sent it.
  const keyPackage = await signedPackage({ keyEpoch: 2 });
  const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: OTHER_SENDER, keyEpoch: 2, package: keyPackage });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 2 }), refused);
  assert.deepEqual([saved, acked], [[], []]);
});

test("a package addressed to another device is refused", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 2, recipientDeviceId: OTHER_DEVICE, recipientPublicKeys: otherDevicePublic });
  const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 2, package: keyPackage });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 2 }), refused);
  assert.deepEqual([saved, acked], [[], []]);
});

test("a package served under a different grant ID is refused", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 2 });
  const { coordinator, saved, acked } = receiver({ grantId: "1".repeat(32), senderDeviceId: SENDER, keyEpoch: 2, package: keyPackage });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 2 }), refused);
  assert.deepEqual([saved, acked], [[], []]);
});

test("an expired package marked committed is refused when its epoch is newer than the household's committed epoch", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 6, expiresAt: LONG_AGO });
  const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 6, committedRotation: true, package: keyPackage });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 5 }), expired);
  assert.deepEqual([saved, acked], [[], []]);
});

test("an expired package is refused when the relay does not mark it committed", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 5, expiresAt: LONG_AGO });
  const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 5, package: keyPackage });
  await assert.rejects(coordinator.receiveProvisioning(directory, { currentEpoch: 5 }), expired);
  assert.deepEqual([saved, acked], [[], []]);
});

test("an expired package for a committed epoch is saved under its signed epoch and acknowledged", async () => {
  // A device offline through a rotation still needs that epoch's key.
  for (const keyEpoch of [4, 5]) {
    const keyPackage = await signedPackage({ keyEpoch, expiresAt: LONG_AGO });
    const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch, committedRotation: true, package: keyPackage });
    await coordinator.receiveProvisioning(directory, { currentEpoch: 5 });
    assert.deepEqual(saved, [{ keyEpoch, sealedEpoch: keyEpoch }]);
    assert.deepEqual(acked, [`/api/sync/provisioning/${GRANT}/ack`]);
  }
});

test("a fresh, matching package is saved under its signed epoch and acknowledged", async () => {
  const keyPackage = await signedPackage({ keyEpoch: 6 });
  const { coordinator, saved, acked } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 6, package: keyPackage });
  await coordinator.receiveProvisioning(directory, { currentEpoch: 5 });
  assert.deepEqual(saved, [{ keyEpoch: 6, sealedEpoch: 6 }]);
  assert.deepEqual(acked, [`/api/sync/provisioning/${GRANT}/ack`]);
});

test("a refused grant pauses sync with a clear message", async () => {
  const states = [];
  const coordinator = new SyncCoordinator({
    store: {},
    engine: {},
    identity: { householdId: HOUSEHOLD, deviceId: ME },
    onState: (state) => states.push(state),
  });
  const keyPackage = await signedPackage({ keyEpoch: 3, expiresAt: LONG_AGO });
  const { coordinator: wired } = receiver({ grantId: GRANT, senderDeviceId: SENDER, keyEpoch: 5, committedRotation: true, package: keyPackage });
  coordinator.runOnce = () => wired.receiveProvisioning(directory, { currentEpoch: 5 });
  await coordinator.syncNow();
  const last = states.at(-1);
  assert.equal(last.state, "paused");
  assert.equal(last.code, "provisioning_grant_refused");
  assert.match(last.message, /refused a household key transfer/);
  coordinator.stop?.();
});

test("the key store refuses a sealed key saved under another epoch or household", () => {
  const store = Object.create(SyncKeyStore.prototype);
  store.database = { transaction() { throw new Error("must not reach storage"); } };
  const sealed = { version: 1, householdId: HOUSEHOLD, keyEpoch: 3 };
  assert.throws(() => store.saveEpoch({ householdId: HOUSEHOLD, keyEpoch: 5, sealed, fingerprint: "x" }), /different epoch or household/);
  assert.throws(() => store.saveEpoch({ householdId: OTHER_HOUSEHOLD, keyEpoch: 3, sealed, fingerprint: "x" }), /different epoch or household/);
  assert.throws(() => store.saveEpoch({ householdId: HOUSEHOLD, keyEpoch: 3, sealed, fingerprint: "x" }), /must not reach storage/);
});
