// Issue #176: a key rotation whose recipient set shrinks between attempts
// must not reuse a key already wrapped for a device that left the set. A
// relay that kept the earlier package could otherwise hand the revoked device
// the new epoch's key. Real WebCrypto; the relay and stores are fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { deviceKeyFingerprint, exportDevicePublicKeys, generateDeviceKeys } from "./crypto.js";
import { rotationRecipientDeparted, SyncCoordinator } from "./sync-coordinator.js";

const HOUSEHOLD = "a".repeat(32);
const ME = "c".repeat(32);
const mine = await generateDeviceKeys();
const myFingerprint = await deviceKeyFingerprint(await exportDevicePublicKeys(mine));

async function device(id) {
  const publicKeys = await exportDevicePublicKeys(await generateDeviceKeys());
  return { deviceId: id, publicKeys, fingerprint: await deviceKeyFingerprint(publicKeys), revokedAt: null };
}
const x = await device("1".repeat(32));
const y = await device("2".repeat(32));
const z = await device("3".repeat(32));

/**
 * A rotating coordinator whose relay loses the first epoch POST's response.
 * With `commitsLostPost`, that POST still commits on the relay.
 */
function rotator({ commitsLostPost = false } = {}) {
  const state = { pendingRotation: null };
  const posts = [];
  const savedKeys = [];
  let devices = [];
  let committed = false;
  let committedProposal = null;
  let failNext = true;
  let onDirectory = null;
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.identity = { householdId: HOUSEHOLD, deviceId: ME };
  coordinator.deviceKeys = { keys: mine, fingerprint: myFingerprint };
  coordinator.keyStore = {
    async getEpoch(householdId, keyEpoch) { return keyEpoch === 1 ? { keyEpoch } : null; },
    async saveEpoch(record) { savedKeys.push({ keyEpoch: record.keyEpoch, fingerprint: record.fingerprint }); return record; },
  };
  coordinator.store = {
    async getSyncState() { return structuredClone(state); },
    async savePendingRotation(rotation) {
      assert.equal(state.pendingRotation, null, "a pending rotation is never silently replaced");
      state.pendingRotation = structuredClone(rotation);
      return structuredClone(rotation);
    },
    async replacePendingRotationPackages({ expected, packages, issuerFingerprint }) {
      assert.equal(state.pendingRotation.proposalId, expected.proposalId);
      state.pendingRotation = { ...state.pendingRotation, packages: structuredClone(packages), issuerFingerprint };
      return structuredClone(state.pendingRotation);
    },
    async clearPendingRotation(proposalId) {
      assert.equal(state.pendingRotation?.proposalId, proposalId);
      state.pendingRotation = null;
    },
    async commitPendingRotation() { committed = true; state.pendingRotation = null; },
  };
  coordinator.loadDeviceDirectory = async () => {
    const hook = onDirectory;
    onDirectory = null;
    hook?.();
    return structuredClone(devices);
  };
  coordinator.provisionMemberHistory = async () => {};
  coordinator.request = async (path, options) => {
    if (path === "/api/sync/status")
      return { currentEpoch: committed ? 2 : 1, rotationPending: !committed, lastRotationProposalId: committedProposal };
    if (path === "/api/sync/epochs") {
      const body = JSON.parse(options.body);
      posts.push({ ...body, fingerprint: state.pendingRotation.fingerprint });
      if (failNext) {
        failNext = false;
        if (commitsLostPost) { committed = true; committedProposal = body.proposalId; }
        throw new Error("The response was lost.");
      }
      return { currentEpoch: 2, proposalId: body.proposalId };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  return {
    coordinator, posts, savedKeys, state,
    setDevices(list) { devices = list; },
    // Runs once, when the next device directory is read: another tab's
    // earlier submission of the pending proposal commits on the relay.
    commitPendingDuringDirectoryRead() {
      onDirectory = () => { committed = true; committedProposal = state.pendingRotation.proposalId; };
    },
  };
}

const recipientsOf = (post) => post.packages.map((keyPackage) => keyPackage.recipientDeviceId).sort();

test("a revoked device between attempts gets a fresh key and proposal, never the first key", async () => {
  const { coordinator, posts, setDevices } = rotator();
  setDevices([x, y]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  setDevices([{ ...x, revokedAt: Date.now() }, y]);
  await coordinator.commitRotation();
  assert.equal(posts.length, 2);
  assert.deepEqual(recipientsOf(posts[0]), [x.deviceId, y.deviceId].sort());
  assert.deepEqual(recipientsOf(posts[1]), [y.deviceId]);
  assert.notEqual(posts[1].fingerprint, posts[0].fingerprint, "the committed key is not the one wrapped for revoked X");
  assert.notEqual(posts[1].proposalId, posts[0].proposalId);
});

test("a re-keyed device between attempts also gets a fresh key", async () => {
  const { coordinator, posts, setDevices } = rotator();
  setDevices([x, y]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  const rekeyed = await device(x.deviceId);
  setDevices([rekeyed, y]);
  await coordinator.commitRotation();
  assert.notEqual(posts[1].fingerprint, posts[0].fingerprint);
});

test("a growing recipient set keeps the pending key and proposal", async () => {
  const { coordinator, posts, setDevices } = rotator();
  setDevices([x]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  setDevices([x, z]);
  await coordinator.commitRotation();
  assert.deepEqual(recipientsOf(posts[1]), [x.deviceId, z.deviceId].sort());
  assert.equal(posts[1].fingerprint, posts[0].fingerprint, "no one left, so the key may be reused");
  assert.equal(posts[1].proposalId, posts[0].proposalId);
});

test("rotationRecipientDeparted matches recipients by device and fingerprint", () => {
  const packages = [{ recipientDeviceId: x.deviceId, recipientFingerprint: x.fingerprint }];
  assert.equal(rotationRecipientDeparted(packages, [x, y]), false);
  assert.equal(rotationRecipientDeparted(packages, [y]), true);
  assert.equal(rotationRecipientDeparted(packages, [{ ...x, fingerprint: y.fingerprint }]), true);
  assert.equal(rotationRecipientDeparted([], [x]), false);
});

test("a lost response that did commit keeps its key, even after a recipient is revoked", async () => {
  const { coordinator, posts, savedKeys, setDevices } = rotator({ commitsLostPost: true });
  setDevices([x, y]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  setDevices([{ ...x, revokedAt: Date.now() }, y]);
  await coordinator.commitRotation();
  assert.equal(posts.length, 1, "nothing is re-posted: the relay already holds the proposal");
  assert.deepEqual(savedKeys, [{ keyEpoch: 2, fingerprint: posts[0].fingerprint }], "the committed key is kept");
});

test("a commit that lands between the status and directory reads is accepted, not discarded", async () => {
  const { coordinator, posts, savedKeys, setDevices, commitPendingDuringDirectoryRead } = rotator();
  setDevices([x, y]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  setDevices([{ ...x, revokedAt: Date.now() }, y]);
  commitPendingDuringDirectoryRead();
  await coordinator.commitRotation();
  assert.equal(posts.length, 1);
  assert.deepEqual(savedKeys, [{ keyEpoch: 2, fingerprint: posts[0].fingerprint }]);
});

test("rotation runs under a cross-tab Web Lock when the browser has one", async () => {
  const { coordinator, setDevices } = rotator();
  setDevices([x]);
  const requested = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request(name, options, callback) { requested.push([name, options.ifAvailable]); return callback({ name }); } },
  } });
  try {
    await assert.rejects(coordinator.commitRotation(), /lost/);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
  assert.deepEqual(requested, [["kin-key-rotation", true]]);
});

test("a tab that finds the rotation lock held skips the pass", async () => {
  const { coordinator, posts, setDevices } = rotator();
  setDevices([x]);
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request(name, options, callback) { return callback(null); } },
  } });
  try {
    assert.equal(await coordinator.commitRotation(), undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
  assert.equal(posts.length, 0);
});
