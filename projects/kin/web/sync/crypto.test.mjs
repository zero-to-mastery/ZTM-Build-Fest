import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  createHouseholdEpochKey,
  createDeviceAuthorizationCertificate,
  decryptEvent,
  deviceKeyFingerprint,
  encryptEvent,
  generateDeviceKeys,
  generateHouseholdKey,
  exportDevicePublicKeys,
  provisionSealedEpochKey,
  restoreHouseholdEpochKey,
  SyncCryptoError,
  unwrapEpochKey,
  validateEnvelope,
  verifyDeviceAuthorizationCertificate,
} from "./crypto.js";

globalThis.crypto ??= webcrypto;

const identity = (digit) => digit.repeat(32);
const plaintext = new TextEncoder().encode("canonical domain event bytes");
const tamper = (value) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

async function fixture() {
  const [householdKey, deviceKeys] = await Promise.all([
    generateHouseholdKey(),
    generateDeviceKeys(),
  ]);
  const envelope = await encryptEvent({
    eventId: identity("1"),
    householdId: identity("2"),
    deviceId: identity("3"),
    deviceSequence: 1,
    logicalTime: 8n,
    keyEpoch: 1,
    plaintext,
    householdKey,
    signingKey: deviceKeys.signingPrivateKey,
  });
  return { householdKey, deviceKeys, envelope };
}

test("encrypted event roundtrips while semantic bytes remain opaque", async () => {
  const { householdKey, deviceKeys, envelope } = await fixture();
  assert.equal(envelope.protocolVersion, 1);
  assert.equal(envelope.envelopeVersion, 1);
  assert.equal(
    JSON.stringify(envelope).includes("canonical domain event bytes"),
    false,
  );
  assert.deepEqual(
    await decryptEvent({
      envelope,
      householdKey,
      signingKey: deviceKeys.signingPublicKey,
    }),
    plaintext,
  );
});

test("wrong key fails authentication after the device signature verifies", async () => {
  const { deviceKeys, envelope } = await fixture();
  await assert.rejects(
    decryptEvent({
      envelope,
      householdKey: await generateHouseholdKey(),
      signingKey: deviceKeys.signingPublicKey,
    }),
    (error) =>
      error instanceof SyncCryptoError && error.code === "decrypt_failed",
  );
});

test("metadata substitution, ciphertext corruption, and signature corruption fail closed", async () => {
  const { householdKey, deviceKeys, envelope } = await fixture();
  const variants = [
    { ...envelope, householdId: identity("4") },
    { ...envelope, eventId: identity("4") },
    { ...envelope, deviceId: identity("4") },
    { ...envelope, keyEpoch: 2 },
    { ...envelope, logicalTime: "9" },
    { ...envelope, deviceSequence: 2 },
    { ...envelope, ciphertext: tamper(envelope.ciphertext) },
    { ...envelope, signature: tamper(envelope.signature) },
    { ...envelope, nonce: tamper(envelope.nonce) },
  ];
  for (const variant of variants) {
    await assert.rejects(
      decryptEvent({
        envelope: variant,
        householdKey,
        signingKey: deviceKeys.signingPublicKey,
      }),
      (error) =>
        error instanceof SyncCryptoError &&
        ["event_signature_invalid", "envelope_malformed"].includes(error.code),
    );
  }
});

test("random event nonces differ across independent encryptions", async () => {
  const { householdKey, deviceKeys } = await fixture();
  const encrypt = () =>
    encryptEvent({
      eventId: identity("5"),
      householdId: identity("2"),
      deviceId: identity("3"),
      deviceSequence: 2,
      logicalTime: 9n,
      keyEpoch: 1,
      plaintext,
      householdKey,
      signingKey: deviceKeys.signingPrivateKey,
    });
  const envelopes = await Promise.all(Array.from({ length: 64 }, encrypt));
  assert.equal(new Set(envelopes.map((value) => value.nonce)).size, 64);
});

test("unknown versions and truncated ciphertext are rejected", async () => {
  const { envelope } = await fixture();
  assert.throws(
    () => validateEnvelope({ ...envelope, envelopeVersion: 2 }),
    (error) =>
      error instanceof SyncCryptoError && error.code === "envelope_unsupported",
  );
  assert.throws(
    () => validateEnvelope({ ...envelope, ciphertext: "AQ" }),
    (error) =>
      error instanceof SyncCryptoError && error.code === "envelope_malformed",
  );
});

test("sealed household key provisions to the fingerprint-bound device only", async () => {
  const senderKeys = await generateDeviceKeys();
  const recipientKeys = await generateDeviceKeys();
  const recipientPublicKeys = await exportDevicePublicKeys(recipientKeys);
  const recipientFingerprint = await deviceKeyFingerprint(recipientPublicKeys);
  const householdId = identity("6");
  const {
    householdKey,
    sealed,
    fingerprint: senderFingerprint,
  } = await createHouseholdEpochKey({
    householdId,
    keyEpoch: 1,
    deviceKeys: senderKeys,
  });
  assert.equal(householdKey.extractable, false);

  const grant = {
    householdId,
    senderDeviceId: identity("3"),
    recipientDeviceId: identity("7"),
    recipientPublicKeys,
    recipientFingerprint,
    keyEpoch: 1,
    grantId: identity("8"),
    expiresAt: 2_000,
    signingKey: senderKeys.signingPrivateKey,
  };
  const keyPackage = await provisionSealedEpochKey({
    sealed,
    deviceKeys: senderKeys,
    grant,
  });
  const restoredSenderKey = await restoreHouseholdEpochKey({
    sealed,
    deviceKeys: senderKeys,
  });
  const received = await unwrapEpochKey({
    package: keyPackage,
    deviceKeys: recipientKeys,
    householdId,
    deviceId: grant.recipientDeviceId,
    deviceFingerprint: recipientFingerprint,
    senderSigningKey: senderKeys.signingPublicKey,
    now: 1_000,
  });
  assert.equal(received.householdKey.extractable, false);
  assert.equal(received.fingerprint, senderFingerprint);

  const originalEnvelope = await encryptEvent({
    eventId: identity("1"),
    householdId,
    deviceId: identity("3"),
    deviceSequence: 1,
    logicalTime: 1n,
    keyEpoch: 1,
    plaintext,
    householdKey: restoredSenderKey,
    signingKey: senderKeys.signingPrivateKey,
  });
  assert.deepEqual(
    await decryptEvent({
      envelope: originalEnvelope,
      householdKey: received.householdKey,
      signingKey: senderKeys.signingPublicKey,
    }),
    plaintext,
  );

  await assert.rejects(
    unwrapEpochKey({
      package: keyPackage,
      deviceKeys: recipientKeys,
      householdId,
      deviceId: identity("9"),
      deviceFingerprint: recipientFingerprint,
      senderSigningKey: senderKeys.signingPublicKey,
      now: 1_000,
    }),
    (error) => error.code === "provisioning_device_mismatch",
  );
  await assert.rejects(
    unwrapEpochKey({
      package: keyPackage,
      deviceKeys: recipientKeys,
      householdId,
      deviceId: grant.recipientDeviceId,
      deviceFingerprint: recipientFingerprint,
      senderSigningKey: senderKeys.signingPublicKey,
      now: 2_000,
    }),
    (error) => error.code === "provisioning_expired",
  );
  await assert.rejects(
    unwrapEpochKey({
      package: { ...keyPackage, grantId: identity("4") },
      deviceKeys: recipientKeys,
      householdId,
      deviceId: grant.recipientDeviceId,
      deviceFingerprint: recipientFingerprint,
      senderSigningKey: senderKeys.signingPublicKey,
      now: 1_000,
    }),
    (error) => error.code === "provisioning_signature_invalid",
  );
});

test("device authorization certificates bind the approved key and issuer", async () => {
  const issuer = await generateDeviceKeys();
  const subject = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(subject);
  const issuerPublicKeys = await exportDevicePublicKeys(issuer);
  const certificate = await createDeviceAuthorizationCertificate({
    householdId: identity("a"),
    memberId: identity("b"),
    deviceId: identity("c"),
    issuerDeviceId: identity("d"),
    issuerFingerprint: await deviceKeyFingerprint(issuerPublicKeys),
    publicKeys,
    signingKey: issuer.signingPrivateKey,
  });
  const device = {
    householdId: identity("a"),
    memberId: identity("b"),
    deviceId: identity("c"),
    fingerprint: await deviceKeyFingerprint(publicKeys),
    publicKeys,
  };
  const isValid = await verifyDeviceAuthorizationCertificate({
    certificate,
    issuerPublicKeys,
    issuerDeviceId: identity("d"),
    device,
  });
  assert.equal(isValid, true);
  await assert.rejects(
    verifyDeviceAuthorizationCertificate({
      certificate: { ...certificate, deviceId: identity("e") },
      issuerPublicKeys,
      issuerDeviceId: identity("d"),
      device,
    }),
    (error) => error.code === "device_certificate_invalid",
  );
  await assert.rejects(
    verifyDeviceAuthorizationCertificate({
      certificate,
      issuerPublicKeys: await exportDevicePublicKeys(
        await generateDeviceKeys(),
      ),
      issuerDeviceId: identity("d"),
      device,
    }),
    (error) => error.code === "device_certificate_invalid",
  );
});
