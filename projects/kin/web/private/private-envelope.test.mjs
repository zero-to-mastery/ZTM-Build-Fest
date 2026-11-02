// Private envelopes (#492): AES-256-GCM under a member-key epoch, AAD
// binding the stream, household, member, device, sequence and epoch, and the
// sending device's ECDSA signature.
import test from "node:test";
import assert from "node:assert/strict";
import { generateDeviceKeys } from "../sync/crypto.js";
import { decryptPrivateEvent, decryptStoredPrivateEvent, encryptPrivateEvent, privateAad } from "./private-envelope.js";

const ids = { eventId: "e".repeat(32), householdId: "a".repeat(32), memberId: "b".repeat(32), deviceId: "d".repeat(32) };
const memberKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

async function sealed(overrides = {}) {
  const device = await generateDeviceKeys();
  const key = await memberKey();
  const envelope = await encryptPrivateEvent({
    ...ids, deviceSequence: 3, logicalTime: 7n, keyEpoch: 2, plaintext: new TextEncoder().encode("a private note"),
    memberKey: key, signingKey: device.signingPrivateKey, ...overrides,
  });
  return { device, key, envelope };
}

test("a private envelope opens for its member, with its device's key", async () => {
  const { device, key, envelope } = await sealed();
  assert.deepEqual(Object.keys(envelope), ["protocolVersion", "envelopeVersion", "eventId", "householdId", "deviceId",
    "deviceSequence", "logicalTime", "keyEpoch", "nonce", "ciphertext", "signature"], "the sync envelope's fields, nothing about the member");
  assert.equal(envelope.logicalTime, "7");
  const plaintext = await decryptPrivateEvent({ envelope, memberId: ids.memberId, memberKey: key, verifyKeys: [device.signingPublicKey] });
  assert.equal(new TextDecoder().decode(plaintext), "a private note");
  assert.equal(new TextDecoder().decode(await decryptStoredPrivateEvent({ envelope, memberId: ids.memberId, memberKey: key })), "a private note");
});

test("the AAD binds stream, household, member, device, sequence and epoch", async () => {
  const { device, key, envelope } = await sealed();
  const opens = (changed, memberId = ids.memberId) =>
    decryptPrivateEvent({ envelope: { ...envelope, ...changed }, memberId, memberKey: key, verifyKeys: [device.signingPublicKey] });
  // Another member's stream: the signature input changes with the AAD.
  await assert.rejects(opens({}, "c".repeat(32)), { code: "event_signature_invalid" });
  for (const changed of [{ householdId: "f".repeat(32) }, { deviceId: "9".repeat(32) }, { deviceSequence: 4 }, { keyEpoch: 3 }, { logicalTime: "8" }, { eventId: "1".repeat(32) }])
    await assert.rejects(opens(changed), { code: "event_signature_invalid" }, JSON.stringify(changed));
  // Even with the signature set aside, the GCM tag refuses a changed field.
  for (const changed of [{ deviceSequence: 4 }, { keyEpoch: 3 }])
    await assert.rejects(decryptStoredPrivateEvent({ envelope: { ...envelope, ...changed }, memberId: ids.memberId, memberKey: key }), { code: "decrypt_failed" });
  await assert.rejects(decryptStoredPrivateEvent({ envelope, memberId: "c".repeat(32), memberKey: key }), { code: "decrypt_failed" });
  // The wrong member key, or another device's signature, fails.
  await assert.rejects(decryptStoredPrivateEvent({ envelope, memberId: ids.memberId, memberKey: await memberKey() }), { code: "decrypt_failed" });
  const other = await generateDeviceKeys();
  await assert.rejects(decryptPrivateEvent({ envelope, memberId: ids.memberId, memberKey: key, verifyKeys: [other.signingPublicKey] }), { code: "event_signature_invalid" });
  // A device whose key changed still verifies with its older key in history.
  assert.ok(await decryptPrivateEvent({ envelope, memberId: ids.memberId, memberKey: key, verifyKeys: [other.signingPublicKey, device.signingPublicKey] }));
  // Its AAD is its own domain: not the household envelope's.
  const aad = new TextDecoder().decode(privateAad({ ...ids, deviceSequence: 3, logicalTime: "7", keyEpoch: 2 }));
  assert.ok(aad.includes("kin.sync.private.aad.v1") && aad.includes("private") && aad.includes(ids.memberId));
});

test("malformed identities and envelopes are refused before any cryptography", async () => {
  const device = await generateDeviceKeys();
  const key = await memberKey();
  const base = { ...ids, deviceSequence: 1, logicalTime: "1", keyEpoch: 1, plaintext: new Uint8Array([1]), memberKey: key, signingKey: device.signingPrivateKey };
  for (const changed of [{ memberId: "B".repeat(32) }, { deviceSequence: 0 }, { logicalTime: "0" }, { keyEpoch: 129 }, { plaintext: new Uint8Array() }])
    await assert.rejects(encryptPrivateEvent({ ...base, ...changed }), (error) => ["envelope_malformed", "event_plaintext_invalid"].includes(error.code));
  const { envelope } = await sealed();
  await assert.rejects(decryptStoredPrivateEvent({ envelope: { ...envelope, envelopeVersion: 2 }, memberId: ids.memberId, memberKey: key }), { code: "envelope_unsupported" });
  await assert.rejects(decryptStoredPrivateEvent({ envelope: { ...envelope, nonce: "AA" }, memberId: ids.memberId, memberKey: key }), { code: "envelope_malformed" });
});
