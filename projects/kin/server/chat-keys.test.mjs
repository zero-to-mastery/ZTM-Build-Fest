// The dedicated chat key (#123): a household's chat content is sealed under a
// key only devices of members allowed to read are given. The service tracks
// who holds a wrapped copy and who may, makes an adult's device rotate it when
// someone loses access, and never sees a key.
import assert from "node:assert/strict";
import test from "node:test";
import { ChatBlobService } from "./chat-blob-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const hex = (byte, length = 16) => byte.toString(16).padStart(2, "0").repeat(length);
const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

function envelope(who, sequence) {
  return {
    protocolVersion: 1, envelopeVersion: 1, eventId: hex(sequence + 10), householdId: who.householdId, deviceId: who.deviceId,
    deviceSequence: sequence, logicalTime: String(sequence), keyEpoch: 1, nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(40, sequence).toString("base64url"), signature: Buffer.alloc(64, 2).toString("base64url"),
  };
}

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.liveService = { eventsAccepted() {}, revalidate() {} };
  const relay = new ChatRelayService({ syncService: sync, store });
  sync.chatRelayService = relay;
  new ChatBlobService({ pairingService: pairing, store });
  const admin = pairing.bootstrap({ credential: credential(`founder-${Math.random()}`) });
  const admit = (options) => {
    const invitation = pairing.createPairing(admin.sessionToken, options);
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`m-${Math.random()}`), deviceLabel: "Phone" });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const child = admit({ kind: "limited" });
  const guest = admit({ kind: "temporary", expiresAt: Date.now() + 86_400_000 });
  const adult = admit({ kind: "adult" });
  sync.enable(admin.sessionToken);
  let counter = 0;
  for (const who of [admin, child, guest, adult]) pairing.devices.get(who.deviceId).syncKeyFingerprint = hex(++counter + 100, 32);
  const auth = (who) => sync.authorize(who.sessionToken);
  const setPolicy = (limited, temporary) => pairing.setChatPolicy(admin.sessionToken, { limited, temporary }, admin.memberId);
  const fingerprint = (who) => pairing.devices.get(who.deviceId).syncKeyFingerprint;
  // A key package as the service sees it: routing fields it checks, opaque rest.
  const pack = (sender, recipient, keyEpoch) => ({
    version: 1, grantId: hex(keyEpoch * 16 + Math.floor(Math.random() * 15) + 1), householdId: `chat:${admin.householdId}`,
    senderDeviceId: sender.deviceId, recipientDeviceId: recipient.deviceId, recipientFingerprint: fingerprint(recipient), keyEpoch,
    expiresAt: Date.now() + 600_000, ephemeralPublicKey: { kty: "EC" }, salt: "s", nonce: "n", wrappedKey: "w", signature: "g",
  });
  const rotation = (sender, recipients, epoch) => ({
    expectedEpoch: epoch - 1, epoch,
    packages: recipients.map((to) => ({ deviceId: to.deviceId, keyEpoch: epoch, package: pack(sender, to, epoch) })),
  });
  return { pairing, sync, relay, admin, child, guest, adult, auth, setPolicy, pack, rotation, fingerprint, admit, nextFingerprint: () => hex(++counter + 100, 32) };
}

/** What the status tells a device about the chat key, without the counters. */
function keyOf(h, who) {
  const { epoch, pending, action } = h.sync.status(who.sessionToken).chat.key;
  return { epoch, pending, action };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store), store); } finally { store.close(); }
  });
}

bothStores("a household nobody is shut out of never needs a chat key", (h) => {
  for (const who of [h.admin, h.child, h.guest, h.adult])
    assert.deepEqual(keyOf(h, who), { epoch: 0, pending: false, action: null });
  h.relay.push(h.auth(h.child), [envelope(h.child, 1)]);
});

bothStores("shutting a class out asks an adult's device for a chat key, and pauses sending until it exists", (h) => {
  h.setPolicy("none", "write");
  assert.deepEqual(keyOf(h, h.admin), { epoch: 0, pending: true, action: "rotate" });
  assert.deepEqual(keyOf(h, h.adult), { epoch: 0, pending: true, action: "rotate" });
  assert.deepEqual(keyOf(h, h.guest), { epoch: 0, pending: true, action: null }, "a Temporary member can't rotate");
  assert.equal(h.sync.status(h.child.sessionToken).chat.key.action, null);
  assert.throws(() => h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)]), rejects("chat_key_rotation_pending", 409));
  const plan = h.relay.keys(h.auth(h.admin)).plan;
  assert.equal(plan.action, "rotate");
  assert.deepEqual(plan.recipients.map((entry) => entry.deviceId).sort(), [h.admin, h.guest, h.adult].map((who) => who.deviceId).sort(), "only devices that may read");
  assert.throws(() => h.relay.keys(h.auth(h.child)), rejects("chat_unavailable", 403));
});

bothStores("a rotation must reach exactly the devices that may read", (h) => {
  h.setPolicy("none", "write");
  const admin = h.auth(h.admin);
  const readers = [h.admin, h.guest, h.adult];
  assert.throws(() => h.relay.putKeys(admin, h.rotation(h.admin, [h.admin, h.adult], 1)), rejects("chat_keys_stale", 409), "a reader left out");
  assert.throws(() => h.relay.putKeys(admin, h.rotation(h.admin, [...readers, h.child], 1)), rejects("chat_keys_invalid", 400), "someone shut out included");
  assert.throws(() => h.relay.putKeys(admin, { ...h.rotation(h.admin, readers, 2), expectedEpoch: 1 }), rejects("chat_keys_stale", 409), "wrong epoch");
  assert.throws(() => h.relay.putKeys(h.auth(h.guest), h.rotation(h.guest, readers, 1)), rejects("chat_keys_stale", 409), "only an adult's device");
  const forged = h.rotation(h.admin, readers, 1);
  forged.packages[0].package.senderDeviceId = h.adult.deviceId;
  assert.throws(() => h.relay.putKeys(admin, forged), rejects("chat_keys_invalid", 400), "a package must name its real sender");
  const wrongFamily = h.rotation(h.admin, readers, 1);
  wrongFamily.packages[0].package.householdId = h.admin.householdId;
  assert.throws(() => h.relay.putKeys(admin, wrongFamily), rejects("chat_keys_invalid", 400), "a household-key package isn't a chat key");
  const result = h.relay.putKeys(admin, h.rotation(h.admin, readers, 1));
  assert.equal(result.epoch, 1);
  assert.equal(result.pending, false);
  assert.equal(h.relay.keys(h.auth(h.guest)).packages.length, 1);
  assert.equal(h.relay.keys(h.auth(h.guest)).packages[0].keyEpoch, 1);
  assert.throws(() => h.relay.putKeys(admin, h.rotation(h.admin, readers, 2)), rejects("chat_keys_stale", 409), "no rotation when none is needed");
  h.relay.push(h.auth(h.adult), [envelope(h.adult, 1)], { chatEpoch: 1 });
  assert.throws(() => h.relay.keys(h.auth(h.child)), rejects("chat_unavailable", 403), "the shut-out device is given nothing");
  assert.equal(h.pairing.events.some((event) => event.type === "chat_key_rotated" && event.epoch === 1), true);
});

bothStores("two devices rotating at once: the first wins", (h) => {
  h.setPolicy("none", "write");
  const readers = [h.admin, h.guest, h.adult];
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, readers, 1));
  assert.throws(() => h.relay.putKeys(h.auth(h.adult), h.rotation(h.adult, readers, 1)), rejects("chat_keys_stale", 409));
});

bothStores("giving access back asks a holder to share the key; other members can't", (h) => {
  h.setPolicy("none", "write");
  const readers = [h.admin, h.guest, h.adult];
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, readers, 1));
  h.setPolicy("read", "write");
  assert.deepEqual(keyOf(h, h.admin), { epoch: 1, pending: false, action: "grant" });
  assert.equal(h.sync.status(h.child.sessionToken).chat.key.action, null, "the member waiting for it can't grant");
  const plan = h.relay.keys(h.auth(h.admin)).plan;
  assert.deepEqual(plan.recipients.map((entry) => [entry.deviceId, entry.keyEpochs]), [[h.child.deviceId, [1]]]);
  const grant = (sender, recipient, keyEpoch) => ({ expectedEpoch: 1, epoch: 1, packages: [{ deviceId: recipient.deviceId, keyEpoch, package: h.pack(sender, recipient, keyEpoch) }] });
  assert.throws(() => h.relay.putKeys(h.auth(h.child), grant(h.child, h.child, 1)), rejects("chat_keys_invalid", 400), "a device can't grant itself");
  assert.throws(() => h.relay.putKeys(h.auth(h.admin), grant(h.admin, h.guest, 1)), rejects("chat_keys_invalid", 400), "someone who already holds it");
  assert.throws(() => h.relay.putKeys(h.auth(h.admin), grant(h.admin, h.child, 2)), rejects("chat_keys_invalid", 400), "an epoch that doesn't exist");
  h.relay.putKeys(h.auth(h.admin), grant(h.admin, h.child, 1));
  assert.equal(h.relay.keys(h.auth(h.child)).packages[0].senderDeviceId, h.admin.deviceId);
  assert.deepEqual(keyOf(h, h.admin), { epoch: 1, pending: false, action: null });
});

bothStores("a revoked device that held the key means rotating it", (h) => {
  h.setPolicy("none", "write");
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, [h.admin, h.guest, h.adult], 1));
  h.pairing.devices.get(h.guest.deviceId).revokedAt = Date.now();
  assert.deepEqual(keyOf(h, h.admin), { epoch: 1, pending: true, action: "rotate" });
  assert.throws(() => h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)]), rejects("chat_key_rotation_pending", 409));
  h.relay.putKeys(h.auth(h.adult), h.rotation(h.adult, [h.admin, h.adult], 2));
  assert.equal(h.sync.status(h.admin.sessionToken).chat.key.epoch, 2);
  h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)], { chatEpoch: 2 });
});

bothStores("a push must say which chat key it was sealed under", (h) => {
  h.setPolicy("none", "write");
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, [h.admin, h.guest, h.adult], 1));
  assert.throws(() => h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)]), rejects("chat_key_stale", 409), "an event sealed before the key, or by a client that doesn't know it");
  assert.throws(() => h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)], { chatEpoch: 2 }), rejects("chat_key_stale", 409));
  h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)], { chatEpoch: 1 });
  assert.equal(h.sync.status(h.admin.sessionToken).chat.key.since, 1, "events from the relay position where the key began must be sealed");
});

bothStores("only an adult's device shares a key, and a device can drop a package it can't open", (h) => {
  h.setPolicy("none", "write");
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, [h.admin, h.guest, h.adult], 1));
  h.setPolicy("read", "write");
  const grant = (sender, keyEpoch = 1) => ({ expectedEpoch: 1, epoch: 1, packages: [{ deviceId: h.child.deviceId, keyEpoch, package: h.pack(sender, h.child, keyEpoch) }] });
  assert.throws(() => h.relay.putKeys(h.auth(h.guest), grant(h.guest)), rejects("chat_keys_stale", 409), "a Temporary member holds the key but can't share it");
  h.relay.putKeys(h.auth(h.adult), grant(h.adult));
  assert.equal(keyOf(h, h.admin).action, null);
  // The child's device can't open it (say it was re-keyed): it drops it and is offered a fresh one.
  h.relay.rejectKey(h.auth(h.child), { keyEpoch: 1 });
  assert.equal(h.relay.keys(h.auth(h.child)).packages.length, 0);
  assert.equal(keyOf(h, h.admin).action, "grant");
  assert.throws(() => h.relay.rejectKey(h.auth(h.child), { keyEpoch: 0 }), rejects("chat_keys_invalid", 400));
  h.relay.rejectKey(h.auth(h.child), { keyEpoch: 1 });
  h.relay.putKeys(h.auth(h.admin), grant(h.admin));
  assert.equal(h.relay.keys(h.auth(h.child)).packages.length, 1);
});

bothStores("an epoch nobody who may read still holds is reported lost", (h) => {
  h.setPolicy("none", "write");
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, [h.admin, h.guest, h.adult], 1));
  assert.deepEqual(h.sync.status(h.admin.sessionToken).chat.key.lost, []);
  h.setPolicy("write", "write");
  for (const who of [h.admin, h.guest, h.adult]) h.pairing.devices.get(who.deviceId).revokedAt = Date.now();
  assert.deepEqual(h.relay.keySummary(h.auth(h.child)).lost, [1]);
});

bothStores("a household that replaced its Adult devices gets its key back from a device that still holds it", (h) => {
  h.setPolicy("none", "write");
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, [h.admin, h.guest, h.adult], 1));
  const fresh = h.admit({ kind: "adult" });
  h.pairing.devices.get(fresh.deviceId).syncKeyFingerprint = h.nextFingerprint();
  // While an Adult's device holds the key, only Adults share it.
  assert.equal(keyOf(h, h.guest).action, null);
  assert.equal(keyOf(h, h.admin).action, "grant");
  for (const who of [h.admin, h.adult]) h.pairing.devices.get(who.deviceId).revokedAt = Date.now();
  // Both Adults that held it are gone. The new Adult's device makes a fresh key,
  // and the Temporary member's device, which still holds the old one and
  // which no Adult's device does, shares it so history stays readable.
  assert.equal(keyOf(h, h.guest).action, null, "rotating is an Adult's to do");
  assert.deepEqual(keyOf(h, fresh), { epoch: 1, pending: true, action: "rotate" });
  h.relay.putKeys(h.auth(fresh), h.rotation(fresh, [h.guest, fresh], 2));
  assert.equal(keyOf(h, h.guest).action, "grant");
  const grant = { expectedEpoch: 2, epoch: 2, packages: [{ deviceId: fresh.deviceId, keyEpoch: 1, package: h.pack(h.guest, fresh, 1) }] };
  h.relay.putKeys(h.auth(h.guest), grant);
  assert.deepEqual(h.relay.keys(h.auth(fresh)).packages.map((row) => row.keyEpoch), [1, 2]);
  assert.equal(keyOf(h, h.guest).action, null);
});
