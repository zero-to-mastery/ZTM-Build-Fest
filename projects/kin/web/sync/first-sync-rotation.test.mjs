// A device whose very first sync finds a key rotation pending (an Adult was
// removed, a device revoked, or a Temporary member expired before this device
// finished joining) must set up its local sync state before it commits the
// rotation: the pending rotation is saved inside that state. Before the fix
// the rotation ran first and failed with "Kin has not initialized encrypted
// sync.", and because the relay pauses pushes until the rotation commits, the
// device could stay stuck. The relay and stores are fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { createHouseholdEpochKey, decryptIdentityBinding, encryptIdentityBinding, generateDeviceKeys } from "./crypto.js";
import { SyncCoordinator } from "./sync-coordinator.js";

const HOUSEHOLD = "a".repeat(32);
const ME = { householdId: HOUSEHOLD, memberId: "b".repeat(32), deviceId: "c".repeat(32) };

function freshDevice({ rotationPending = true, existingState = null, heldEpochs = null } = {}) {
  const calls = [];
  let syncState = existingState;
  let committed = false;
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.identity = ME;
  coordinator.deviceKeys = { keys: {}, fingerprint: "f" };
  coordinator.abortController = new AbortController();
  coordinator.now = () => 0;
  coordinator.onState = () => {};
  coordinator.keyStore = {
    vault: { assertUnlocked() {} },
    async getEpoch(householdId, keyEpoch) {
      const held = heldEpochs ? heldEpochs.includes(keyEpoch) : keyEpoch === (committed ? 2 : 1);
      return held ? { keyEpoch, householdKey: {} } : null;
    },
  };
  coordinator.store = {
    async requeueAfterRelayReset() {},
    async updateSyncServerState() {},
    async getSyncState() { return syncState && structuredClone(syncState); },
    async getSyncBootstrap() { return { events: [], legacyIdentity: null, maxLogicalTime: 0n }; },
    async initializeSync({ serverStatus }) {
      calls.push("initializeSync");
      assert.equal(syncState, null, "sync state is created once");
      syncState = { key: "active", currentEpoch: serverStatus.currentEpoch };
    },
    async installIdentityBindings() { calls.push("installIdentityBindings"); },
  };
  coordinator.request = async (path) => {
    assert.equal(path, "/api/sync/status");
    return {
      enabled: true,
      memberKind: "adult",
      currentEpoch: committed ? 2 : 1,
      rotationPending: rotationPending && !committed,
      eventCount: 3,
      latestCursor: "",
    };
  };
  coordinator.loadDeviceDirectory = async () => [{ deviceId: ME.deviceId, historyFromEpoch: 1, publicKeys: {} }];
  coordinator.receiveProvisioning = async () => {};
  coordinator.fetchBindings = async () => [];
  // The real rotation saves its proposal inside the sync state.
  coordinator.commitRotation = async () => {
    calls.push("commitRotation");
    if (!syncState) throw new Error("Kin has not initialized encrypted sync.");
    committed = true;
  };
  coordinator.provisionMemberHistory = async () => { calls.push("provisionMemberHistory"); };
  coordinator.pushIdentityBindings = async () => { calls.push("pushIdentityBindings"); };
  coordinator.pullCatchUpPages = async () => { calls.push("pull"); return { hasMore: false }; };
  return { coordinator, calls };
}

test("a first sync with a rotation pending sets up sync state before rotating", async () => {
  const { coordinator, calls } = freshDevice();
  await coordinator.runOnce();
  assert.deepEqual(calls, ["initializeSync", "commitRotation", "provisionMemberHistory", "pushIdentityBindings", "pull"]);
});

test("a first sync with no rotation pending is unchanged", async () => {
  const { coordinator, calls } = freshDevice({ rotationPending: false });
  await coordinator.runOnce();
  assert.deepEqual(calls, ["initializeSync", "provisionMemberHistory", "pushIdentityBindings", "pull"]);
});

test("an initialized device still rotates and does not re-create its state", async () => {
  const { coordinator, calls } = freshDevice({ existingState: { key: "active", currentEpoch: 1 } });
  await coordinator.runOnce();
  assert.deepEqual(calls, ["commitRotation", "provisionMemberHistory", "pushIdentityBindings", "pull"]);
});

// Each place a pass finds no key for the relay's current epoch says which
// place it was and which epoch it lacked (#791); the words stay the same.

const KEY_MISSING = "This device needs an authorized household key before sync can continue.";

test("a pass that holds no key for the current epoch says so with its own code", async () => {
  const { coordinator, calls } = freshDevice({ rotationPending: false, heldEpochs: [] });
  await assert.rejects(coordinator.runOnce(), { message: KEY_MISSING, code: "household_key_missing", keyEpoch: 1 });
  assert.deepEqual(calls, []);
});

test("a key missing after this device's own rotation has a different code", async () => {
  // Another device committed a newer epoch meanwhile, so this one holds epoch 1 only.
  const { coordinator, calls } = freshDevice({ heldEpochs: [1] });
  await assert.rejects(coordinator.runOnce(), { message: KEY_MISSING, code: "household_key_missing_after_rotation", keyEpoch: 2 });
  assert.deepEqual(calls, ["initializeSync", "commitRotation"]);
});

// Bindings wait for a pending rotation and are re-sealed under the relay's
// current epoch when they were sealed under an older one (real WebCrypto).

const deviceKeys = await generateDeviceKeys();
const epochKeys = new Map();
for (const keyEpoch of [1, 2])
  epochKeys.set(keyEpoch, (await createHouseholdEpochKey({ householdId: HOUSEHOLD, keyEpoch, deviceKeys })).householdKey);
const BINDING = {
  legacyHouseholdId: "d".repeat(32), legacyActorId: "e".repeat(32), legacyDeviceId: "f".repeat(32),
  householdId: ME.householdId, actorId: ME.memberId, deviceId: ME.deviceId,
};

async function bindingPusher(sealedEpoch, { uploadedMeanwhile = false } = {}) {
  const envelope = await encryptIdentityBinding({
    binding: BINDING, householdId: HOUSEHOLD, deviceId: ME.deviceId, deviceSequence: 1, logicalTime: "7",
    keyEpoch: sealedEpoch, householdKey: epochKeys.get(sealedEpoch), signingKey: deviceKeys.signingPrivateKey,
  });
  const record = { legacy_key: "legacy", ...BINDING, controlEnvelope: envelope, uploaded: false };
  const posted = [];
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.identity = ME;
  coordinator.deviceKeys = { keys: deviceKeys };
  coordinator.keyStore = { async getEpoch(householdId, keyEpoch) { return epochKeys.has(keyEpoch) ? { householdKey: epochKeys.get(keyEpoch) } : null; } };
  coordinator.store = {
    async getPendingBindings() { return record.uploaded ? [] : [structuredClone(record)]; },
    async replacePendingBindingEnvelope(key, expectedEventId, next) {
      if (uploadedMeanwhile || record.uploaded || record.controlEnvelope.eventId !== expectedEventId) return false;
      record.controlEnvelope = structuredClone(next);
      return true;
    },
    async markBindingUploaded() { record.uploaded = true; },
  };
  coordinator.request = async (path, options) => {
    assert.equal(path, "/api/sync/bindings");
    posted.push(JSON.parse(options.body).bindings[0]);
    return {};
  };
  return { coordinator, posted, record };
}

test("identity bindings wait while a key rotation is pending", async () => {
  const { coordinator, posted } = await bindingPusher(1);
  await coordinator.pushIdentityBindings({ currentEpoch: 1, rotationPending: true });
  assert.equal(posted.length, 0);
});

test("a binding sealed under a retired epoch is re-sealed under the current one before upload", async () => {
  const { coordinator, posted, record } = await bindingPusher(1);
  await coordinator.pushIdentityBindings({ currentEpoch: 2, rotationPending: false });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].keyEpoch, 2);
  assert.equal(posted[0].deviceSequence, 1);
  assert.equal(posted[0].logicalTime, "7");
  assert.deepEqual(record.controlEnvelope, posted[0], "the stored envelope is the uploaded one");
  const opened = await decryptIdentityBinding({ envelope: posted[0], householdKey: epochKeys.get(2), signingKey: deviceKeys.signingPublicKey, expectedHouseholdId: HOUSEHOLD });
  assert.deepEqual(opened, BINDING);
});

test("a binding that can't be re-sealed for lack of the current key has its own code", async () => {
  const { coordinator, posted } = await bindingPusher(1);
  await assert.rejects(coordinator.pushIdentityBindings({ currentEpoch: 3, rotationPending: false }),
    { message: KEY_MISSING, code: "household_key_missing_for_binding", keyEpoch: 3 });
  assert.equal(posted.length, 0);
});

test("a binding already at the current epoch is uploaded as it is", async () => {
  const { coordinator, posted, record } = await bindingPusher(2);
  const before = structuredClone(record.controlEnvelope);
  await coordinator.pushIdentityBindings({ currentEpoch: 2, rotationPending: false });
  assert.deepEqual(posted, [before]);
});

test("a binding another tab uploaded meanwhile is not re-sealed or sent again", async () => {
  const { coordinator, posted } = await bindingPusher(1, { uploadedMeanwhile: true });
  await coordinator.pushIdentityBindings({ currentEpoch: 2, rotationPending: false });
  assert.equal(posted.length, 0);
});

test("events wait while this device's own binding is still pending", async () => {
  const { coordinator, posted } = await bindingPusher(1);
  let outboxRead = false;
  coordinator.store.getPendingOutbox = async () => { outboxRead = true; return [{ envelope: { eventId: "x" } }]; };
  await coordinator.pushPendingEvents();
  assert.equal(outboxRead, false, "no event is pushed ahead of the binding it depends on");
  assert.equal(posted.length, 0);
});
