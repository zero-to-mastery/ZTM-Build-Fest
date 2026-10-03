import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore, DurableStoreError, hasDatabaseProcessLock } from "./durable-store.mjs";
import { MAX_TRUSTED_DEVICES, PairingService } from "./pairing-service.mjs";
import {
  createDeviceAuthorizationCertificate,
  createDeviceKeyTransition,
  deviceKeyFingerprint,
  exportDevicePublicKeys,
  generateDeviceKeys,
} from "../web/sync/crypto.js";

const credential = (id) => ({ id, publicKey: `synthetic-key-${id}`, algorithm: -7 });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "kin-durable-identity-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = 10_000;
  const pairing = new PairingService({ store, now: () => now });
  const adult = pairing.bootstrap({ credential: credential("adult") });
  function joinMember(id, purpose = "member") {
    now += 60_001;
    const invitation = purpose === "member"
      ? pairing.createPairing(adult.sessionToken)
      : pairing.createDevicePairing(adult.sessionToken);
    const claim = pairing.claimPairing({
      code: invitation.code, credential: credential(id), deviceLabel: id,
    });
    pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  }
  return { databasePath, store, pairing, adult, joinMember };
}

function changeDevice(f, edit, deviceId = f.adult.deviceId) {
  const row = f.store.db.prepare("SELECT device_json FROM devices WHERE id = ?").get(deviceId);
  const value = JSON.parse(row.device_json);
  edit(value);
  f.store.db.prepare("UPDATE devices SET device_json = ? WHERE id = ?")
    .run(JSON.stringify(value), deviceId);
}

function changeCredential(f, edit) {
  const row = f.store.db.prepare("SELECT credential_json FROM credentials WHERE id = ?").get("adult");
  const value = JSON.parse(row.credential_json);
  edit(value);
  f.store.db.prepare("UPDATE credentials SET credential_json = ? WHERE id = ?")
    .run(JSON.stringify(value), "adult");
}

function assertCorrupt(f) {
  assert.equal(f.store.db.pragma("quick_check", { simple: true }), "ok");
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
  const safeError = (error) => {
    assert.ok(error instanceof DurableStoreError);
    assert.doesNotMatch(error.message, /SELECT|UPDATE|sqlite|synthetic-key/);
    assert.equal(error.message.includes(f.adult.householdId), false);
    assert.equal(error.message.includes(f.databasePath), false);
    return true;
  };
  assert.throws(() => f.store.loadIdentity(), safeError);
  assert.equal(f.store.failed, true);
  assert.throws(() => f.pairing.authorize(f.adult.sessionToken), DurableStoreError);
  f.store.close();
  assert.throws(() => new DurableStore(f.databasePath), safeError);
  assert.equal(hasDatabaseProcessLock(f.databasePath), false);
}

test("three active adults fail identity load and startup without repairing membership", (t) => {
  const f = fixture(t);
  const removed = f.joinMember("removed");
  f.pairing.removeOtherAdult(f.adult.sessionToken, removed.memberId, f.adult.memberId);
  f.joinMember("replacement");
  assert.equal(f.store.validate(), true);
  // Only this synthetic database drops its trigger to represent restored or
  // manually corrupted state; production constraints are unchanged.
  f.store.db.exec("DROP TRIGGER members_active_limit_update");
  f.store.db.prepare("UPDATE members SET active = 1 WHERE id = ?").run(removed.memberId);
  assertCorrupt(f);
});

test("too many non-revoked devices fail identity load and startup", (t) => {
  const f = fixture(t);
  const devices = [];
  for (let index = 1; index < MAX_TRUSTED_DEVICES; index += 1)
    devices.push(f.joinMember(`device-${index}`, "device"));
  const revoked = devices[0];
  f.pairing.revokeDevice(f.adult.sessionToken, revoked.deviceId);
  f.joinMember("replacement-device", "device");
  assert.equal(f.store.validate(), true);
  f.store.db.exec("DROP TRIGGER devices_active_limit_update");
  f.store.db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = ?").run(revoked.deviceId);
  changeDevice(f, (device) => { device.revokedAt = null; }, revoked.deviceId);
  assertCorrupt(f);
});

const deviceMutations = [
  ["device identity mismatch", (device) => { device.id = "a".repeat(32); }],
  ["device member mismatch", (device) => { device.memberId = "b".repeat(32); }],
  ["device household mismatch", (device) => { device.householdId = "c".repeat(32); }],
  ["device token mismatch", (device) => { device.tokenHash = "d".repeat(64); }],
  ["device revocation mismatch", (device) => { device.revokedAt = 123; }],
  ["invalid trusted timestamp", (device) => { device.trustedAt = "10000"; }],
  ["unsafe trusted timestamp", (device) => { device.trustedAt = Number.MAX_SAFE_INTEGER + 1; }],
  ["invalid device label", (device) => { device.label = {}; }],
  ["invalid history entitlement", (device) => { device.syncHistoryFromEpoch = 0; }],
  ["invalid provisioned epochs", (device) => { device.syncProvisionedEpochs = [1, 129]; }],
  ["duplicate provisioned epochs", (device) => { device.syncProvisionedEpochs = [1, 1]; }],
  ["malformed sync public keys", (device) => { device.syncPublicKeys = {}; device.syncKeyFingerprint = "f".repeat(64); }],
  ["orphan sync fingerprint", (device) => { device.syncKeyFingerprint = "f".repeat(64); }],
  ["malformed key history", (device) => { device.syncKeyHistory = {}; }],
  ["malformed key transitions", (device) => { device.syncKeyTransitions = {}; }],
  ["unsupported key generation", (device) => { device.syncKeyGeneration = 17; }],
  ["malformed approval certificate", (device) => { device.deviceAuthorizationCertificate = {}; }],
];
for (const [name, edit] of deviceMutations)
  test(`${name} fails identity load and startup`, (t) => {
    const f = fixture(t);
    changeDevice(f, edit);
    assertCorrupt(f);
  });

const credentialMutations = [
  ["credential identity mismatch", (value) => { value.id = "another-credential"; }],
  ["credential member mismatch", (value) => { value.memberId = "a".repeat(32); }],
  ["unsupported credential algorithm", (value) => { value.algorithm = 1; }],
  ["missing public key", (value) => { delete value.publicKey; }],
  ["invalid public key shape", (value) => { value.publicKey = {}; }],
  ["empty public key", (value) => { value.publicKey = ""; }],
  ["missing signature counter", (value) => { delete value.signCount; }],
  ["negative signature counter", (value) => { value.signCount = -1; }],
  ["overflowed signature counter", (value) => { value.signCount = 0x100000000; }],
  ["noninteger signature counter", (value) => { value.signCount = 0.5; }],
  ["invalid credential transports", (value) => { value.transports = {}; }],
];
for (const [name, edit] of credentialMutations)
  test(`${name} fails identity load and startup`, (t) => {
    const f = fixture(t);
    changeCredential(f, edit);
    assertCorrupt(f);
  });

test("credential normalized owner mismatch fails with valid foreign keys", (t) => {
  const f = fixture(t);
  const other = f.joinMember("other");
  f.store.db.prepare("UPDATE credentials SET member_id = ? WHERE id = ?").run(other.memberId, "adult");
  assertCorrupt(f);
});

for (const [name, ids] of [
  ["missing forward credential membership", []],
  ["unknown reverse credential membership", ["adult", "missing"]],
  ["duplicate credential membership", ["adult", "adult"]],
])
  test(`${name} fails identity load and startup`, (t) => {
    const f = fixture(t);
    f.store.db.prepare("UPDATE members SET credential_ids = ? WHERE id = ?")
      .run(JSON.stringify(ids), f.adult.memberId);
    assertCorrupt(f);
  });

test("another member cannot list an existing credential as their own", (t) => {
  const f = fixture(t);
  const other = f.joinMember("other");
  f.store.db.prepare("UPDATE members SET credential_ids = ? WHERE id = ?")
    .run(JSON.stringify(["other", "adult"]), other.memberId);
  assertCorrupt(f);
});

test("historical members, revoked devices, synthetic keys and Buffer keys survive restart", (t) => {
  const f = fixture(t);
  const removed = f.joinMember("removed");
  f.pairing.removeOtherAdult(f.adult.sessionToken, removed.memberId, f.adult.memberId);
  f.joinMember("replacement");
  const bufferCredential = { id: "buffer-key", publicKey: Buffer.from("synthetic-key"), algorithm: -257, signCount: 0xffffffff };
  const extra = f.pairing.bootstrap({ credential: bufferCredential });
  assert.equal(f.store.validate(), true);
  f.store.close();
  const reopened = new DurableStore(f.databasePath);
  try {
    const identity = reopened.loadIdentity();
    assert.equal(identity.members.get(removed.memberId).active, false);
    assert.ok(identity.devices.get(removed.deviceId).revokedAt);
    assert.equal(identity.households.get(f.adult.householdId).members.size, 3);
    assert.deepEqual(identity.credentials.get("buffer-key").publicKey, bufferCredential.publicKey);
    assert.equal(identity.credentials.get("buffer-key").memberId, extra.memberId);
    assert.equal(reopened.validate(), true);
  } finally {
    reopened.close();
  }
});

test("normal device key succession survives restart and corrupt history fails closed", async (t) => {
  const f = fixture(t);
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  f.pairing.registerSyncPublicKeys(f.adult.sessionToken, publicKeys);
  const successor = await generateDeviceKeys();
  const transition = await createDeviceKeyTransition({
    ...f.adult,
    generation: 1,
    oldFingerprint: await deviceKeyFingerprint(publicKeys),
    publicKeys: await exportDevicePublicKeys(successor),
    signingKey: keys.signingPrivateKey,
  });
  f.pairing.transitionSyncPublicKeys(f.adult.sessionToken, transition);
  assert.equal(f.store.validate(), true);
  assert.equal(f.store.loadIdentity().devices.get(f.adult.deviceId).syncKeyGeneration, 1);
  const peer = new DurableStore(f.databasePath, { acquireProcessLock: false });
  try {
    assert.equal(peer.validate(), true);
  } finally {
    peer.close();
  }
  changeDevice(f, (device) => { device.syncKeyHistory[0].generation = 1; });
  assertCorrupt(f);
});

for (const noncanonicalSignature of [false, true])
test(`retained approval certificates with ${noncanonicalSignature ? "noncanonical" : "canonical"} signature encoding remain valid after key changes`, async (t) => {
  const f = fixture(t);
  const issuerKeys = await generateDeviceKeys();
  const issuerPublicKeys = await exportDevicePublicKeys(issuerKeys);
  f.pairing.registerSyncPublicKeys(f.adult.sessionToken, issuerPublicKeys);
  const recipientKeys = await generateDeviceKeys();
  const recipientPublicKeys = await exportDevicePublicKeys(recipientKeys);
  const invitation = f.pairing.createPairing(f.adult.sessionToken);
  const claim = f.pairing.claimPairing({
    code: invitation.code, credential: credential("recipient"),
    deviceLabel: "Recipient", syncPublicKeys: recipientPublicKeys,
  });
  const claimant = f.pairing.pairings.get(invitation.pairingId).claimant;
  const certificate = await createDeviceAuthorizationCertificate({
    householdId: f.adult.householdId,
    memberId: claimant.memberId,
    deviceId: claimant.deviceId,
    issuerDeviceId: f.adult.deviceId,
    issuerFingerprint: await deviceKeyFingerprint(issuerPublicKeys),
    publicKeys: recipientPublicKeys,
    signingKey: issuerKeys.signingPrivateKey,
  });
  const alternateEncoding = (signature) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    return signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)) + 1];
  };
  if (noncanonicalSignature) {
    const original = certificate.signature;
    certificate.signature = alternateEncoding(original);
    assert.notEqual(certificate.signature, original);
    assert.deepEqual(
      Buffer.from(certificate.signature, "base64url"),
      Buffer.from(original, "base64url"),
    );
  }
  f.pairing.approvePairing(f.adult.sessionToken, invitation.pairingId, claim.version, certificate);
  const recipient = f.pairing.activateClaim(claim.claimToken);
  for (const [identity, keys, publicKeys] of [
    [f.adult, issuerKeys, issuerPublicKeys],
    [recipient, recipientKeys, recipientPublicKeys],
  ]) {
    const successor = await generateDeviceKeys();
    const transition = await createDeviceKeyTransition({
      ...identity, generation: 1,
      oldFingerprint: await deviceKeyFingerprint(publicKeys),
      publicKeys: await exportDevicePublicKeys(successor),
      signingKey: keys.signingPrivateKey,
    });
    assert.throws(
      () => f.pairing.transitionSyncPublicKeys(identity.sessionToken, {
        ...transition, signature: alternateEncoding(transition.signature),
      }),
      (error) => error.code === "device_transition_invalid",
    );
    f.pairing.transitionSyncPublicKeys(identity.sessionToken, transition);
  }
  f.pairing.revokeDevice(recipient.sessionToken, f.adult.deviceId);
  assert.equal(f.store.validate(), true);
  const peer = new DurableStore(f.databasePath, { acquireProcessLock: false });
  try {
    assert.equal(peer.validate(), true);
    assert.deepEqual(peer.loadIdentity().devices.get(recipient.deviceId).deviceAuthorizationCertificate, certificate);
  } finally {
    peer.close();
  }
  changeDevice(f, (device) => {
    device.deviceAuthorizationCertificate.memberId = f.adult.memberId;
  }, recipient.deviceId);
  assertCorrupt(f);
});

test("malformed token verifier fails even when normalized and serialized values agree", (t) => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE devices SET token_hash = ? WHERE id = ?")
    .run("invalid-token-hash", f.adult.deviceId);
  changeDevice(f, (device) => { device.tokenHash = "invalid-token-hash"; });
  assertCorrupt(f);
});
