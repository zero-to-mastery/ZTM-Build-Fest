const ENVELOPE_VERSION = 1;
const PROTOCOL_VERSION = 1;
const MAX_ID_LENGTH = 128;
const encoder = new TextEncoder();

export class SyncCryptoError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "SyncCryptoError";
    this.code = code;
  }
}

export async function generateHouseholdKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function createHouseholdEpochKey({
  householdId,
  keyEpoch,
  deviceKeys,
}) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const householdKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    const sealed = await sealKeyBytes({
      rawKey,
      householdId,
      keyEpoch,
      deviceKeys,
    });
    return { householdKey, sealed, fingerprint: await fingerprintKey(rawKey) };
  } finally {
    rawKey.fill(0);
  }
}

export async function createProvisionedHouseholdEpoch({
  householdId,
  keyEpoch,
  deviceKeys,
  senderDeviceId,
  recipients,
  expiresAt,
}) {
  if (!Array.isArray(recipients) || recipients.length > 64) {
    throw new SyncCryptoError(
      "provisioning_limit",
      "Kin cannot prepare this many device key transfers at once.",
    );
  }
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const householdKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    const sealed = await sealKeyBytes({
      rawKey,
      householdId,
      keyEpoch,
      deviceKeys,
    });
    const fingerprint = await fingerprintKey(rawKey);
    const packages = await Promise.all(
      recipients.map((recipient) =>
        wrapEpochKey({
          rawKey,
          householdId,
          senderDeviceId,
          recipientDeviceId: recipient.deviceId,
          recipientPublicKeys: recipient.publicKeys,
          recipientFingerprint: recipient.fingerprint,
          keyEpoch,
          grantId: randomIdHex(),
          expiresAt,
          signingKey: deviceKeys.signingPrivateKey,
        }),
      ),
    );
    return { householdKey, sealed, fingerprint, packages };
  } finally {
    rawKey.fill(0);
  }
}

export async function restoreHouseholdEpochKey({ sealed, deviceKeys }) {
  const rawKey = await openSealedKey({ sealed, deviceKeys });
  try {
    return await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    rawKey.fill(0);
  }
}

// Rotation verifies the recoverable epoch secret, including its public routing
// metadata and fingerprint, without replacing the household's transport key.
export async function verifyStoredHouseholdEpoch({ record, deviceKeys }) {
  if (record?.sealed?.householdId !== record.householdId || record?.sealed?.keyEpoch !== record.keyEpoch)
    throw new SyncCryptoError("stored_key_mismatch", "The epoch metadata does not match its sealed key.");
  const rawKey = await openSealedKey({ sealed: record.sealed, deviceKeys });
  try {
    if (rawKey.length !== 32 || await fingerprintKey(rawKey) !== record.fingerprint)
      throw new SyncCryptoError("stored_key_mismatch", "The epoch fingerprint does not match its sealed key.");
    return await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally { rawKey.fill(0); }
}

export async function wrapEpochKey({
  rawKey,
  householdId,
  senderDeviceId,
  recipientDeviceId,
  recipientPublicKeys,
  recipientFingerprint,
  keyEpoch,
  grantId,
  expiresAt,
  signingKey,
}) {
  validateKeyGrant({
    householdId,
    senderDeviceId,
    recipientDeviceId,
    recipientFingerprint,
    keyEpoch,
    grantId,
    expiresAt,
  });
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) {
    throw new SyncCryptoError(
      "provisioning_key_invalid",
      "The household key could not be provisioned.",
    );
  }
  const recipient = await importDevicePublicKeys(recipientPublicKeys);
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const ephemeralPublicKey = await crypto.subtle.exportKey(
    "jwk",
    ephemeral.publicKey,
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: recipient.agreement },
      ephemeral.privateKey,
      256,
    ),
  );
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = provisioningAad({
    householdId,
    senderDeviceId,
    recipientDeviceId,
    recipientFingerprint,
    keyEpoch,
    grantId,
    expiresAt,
  });
  try {
    const wrappingKey = await deriveWrappingKey(sharedSecret, salt, aad, [
      "wrapKey",
    ]);
    const exportableKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    const wrappedKey = new Uint8Array(
      await crypto.subtle.wrapKey("raw", exportableKey, wrappingKey, {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad,
        tagLength: 128,
      }),
    );
    const publicBytes = encoder.encode(stableJson(ephemeralPublicKey));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signingKey,
        encodeFields([
          "kin.sync.key-wrap.signature.v1",
          aad,
          salt,
          nonce,
          wrappedKey,
          publicBytes,
        ]),
      ),
    );
    return {
      version: 1,
      householdId,
      senderDeviceId,
      recipientDeviceId,
      recipientFingerprint,
      keyEpoch,
      grantId,
      expiresAt,
      ephemeralPublicKey,
      salt: toBase64Url(salt),
      nonce: toBase64Url(nonce),
      wrappedKey: toBase64Url(wrappedKey),
      signature: toBase64Url(signature),
    };
  } finally {
    sharedSecret.fill(0);
  }
}

export async function provisionSealedEpochKey({ sealed, deviceKeys, grant }) {
  const rawKey = await openSealedKey({ sealed, deviceKeys });
  try {
    return await wrapEpochKey({ ...grant, rawKey });
  } finally {
    rawKey.fill(0);
  }
}

export async function unwrapEpochKey({
  package: keyPackage,
  deviceKeys,
  householdId,
  deviceId,
  deviceFingerprint,
  senderSigningKey,
  now = Date.now(),
}) {
  validateProvisioningPackage(keyPackage);
  if (
    keyPackage.householdId !== householdId ||
    keyPackage.recipientDeviceId !== deviceId ||
    keyPackage.recipientFingerprint !== deviceFingerprint
  ) {
    throw new SyncCryptoError(
      "provisioning_device_mismatch",
      "This key transfer was not created for this trusted device.",
    );
  }
  if (!Number.isSafeInteger(now) || keyPackage.expiresAt <= now) {
    throw new SyncCryptoError(
      "provisioning_expired",
      "This key transfer expired. Ask an active trusted device to try again.",
    );
  }
  const aad = provisioningAad(keyPackage);
  const salt = fromBase64Url(keyPackage.salt);
  const nonce = fromBase64Url(keyPackage.nonce);
  const wrappedKey = fromBase64Url(keyPackage.wrappedKey);
  const signature = fromBase64Url(keyPackage.signature);
  const publicBytes = encoder.encode(stableJson(keyPackage.ephemeralPublicKey));
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    senderSigningKey,
    signature,
    encodeFields([
      "kin.sync.key-wrap.signature.v1",
      aad,
      salt,
      nonce,
      wrappedKey,
      publicBytes,
    ]),
  );
  if (!verified) {
    throw new SyncCryptoError(
      "provisioning_signature_invalid",
      "The trusted device could not authenticate this key transfer.",
    );
  }
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "jwk",
    keyPackage.ephemeralPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: ephemeralPublicKey },
      deviceKeys.agreementPrivateKey,
      256,
    ),
  );
  try {
    const wrappingKey = await deriveWrappingKey(sharedSecret, salt, aad);
    const rawKey = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: aad,
          tagLength: 128,
        },
        wrappingKey,
        wrappedKey,
      ),
    );
    try {
      if (rawKey.length !== 32) {
        throw new SyncCryptoError(
          "provisioning_key_invalid",
          "The household key could not be provisioned.",
        );
      }
      const householdKey = await crypto.subtle.importKey(
        "raw",
        rawKey,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
      const sealed = await sealKeyBytes({
        rawKey,
        householdId,
        keyEpoch: keyPackage.keyEpoch,
        deviceKeys,
      });
      const fingerprint = await fingerprintKey(rawKey);
      return { householdKey, sealed, fingerprint };
    } finally {
      rawKey.fill(0);
    }
  } finally {
    sharedSecret.fill(0);
  }
}

export async function deviceKeyFingerprint(publicKeys) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(stableJson(publicKeys)),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createDeviceAuthorizationCertificate({
  householdId,
  memberId,
  deviceId,
  issuerDeviceId,
  issuerFingerprint,
  publicKeys,
  signingKey,
}) {
  const certificate = {
    version: 1,
    householdId,
    memberId,
    deviceId,
    issuerDeviceId,
    issuerFingerprint,
    publicKeys,
    fingerprint: await deviceKeyFingerprint(publicKeys),
  };
  certificate.signature = toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signingKey,
        encoder.encode(stableJson(certificate)),
      ),
    ),
  );
  return certificate;
}

export async function verifyDeviceAuthorizationCertificate({
  certificate,
  issuerPublicKeys,
  issuerDeviceId,
  device,
}) {
  if (
    !certificate ||
    certificate.version !== 1 ||
    certificate.householdId !== device.householdId ||
    certificate.memberId !== device.memberId ||
    certificate.deviceId !== device.deviceId ||
    certificate.issuerDeviceId !== issuerDeviceId ||
    certificate.fingerprint !== device.fingerprint ||
    stableJson(certificate.publicKeys) !== stableJson(device.publicKeys)
  ) {
    throw new SyncCryptoError(
      "device_certificate_invalid",
      "A trusted device key does not match its approval record.",
    );
  }
  const fingerprint = await deviceKeyFingerprint(certificate.publicKeys);
  if (fingerprint !== certificate.fingerprint) {
    throw new SyncCryptoError(
      "device_certificate_invalid",
      "A trusted device key fingerprint does not match its key.",
    );
  }
  if (
    (await deviceKeyFingerprint(issuerPublicKeys)) !==
    certificate.issuerFingerprint
  )
    throw new SyncCryptoError(
      "device_certificate_invalid",
      "The device approval came from an unexpected trusted key.",
    );
  const unsigned = { ...certificate };
  delete unsigned.signature;
  const signer = await importDevicePublicKeys(issuerPublicKeys);
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    signer.signing,
    fromBase64Url(certificate.signature),
    encoder.encode(stableJson(unsigned)),
  );
  if (!verified)
    throw new SyncCryptoError(
      "device_certificate_invalid",
      "A trusted device key approval signature is invalid.",
    );
  return true;
}

export async function generateDeviceKeys() {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]),
  ]);
  return {
    agreementPrivateKey: agreement.privateKey,
    agreementPublicKey: agreement.publicKey,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
  };
}

// Private JWKs exist only during generation/serialization and inside the unlocked
// vault adapter. Runtime signing and agreement keys are always nonextractable.
export async function generateProtectedDeviceKeys() {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  ]);
  const serializedKeys = {
    agreement: await crypto.subtle.exportKey("jwk", agreement.privateKey),
    signing: await crypto.subtle.exportKey("jwk", signing.privateKey),
  };
  return { serializedKeys, keys: await importProtectedDeviceKeys(serializedKeys) };
}

export async function importProtectedDeviceKeys(serializedKeys) {
  const publicJwk = (key, key_ops) => {
    const { d, ...value } = key;
    return { ...value, key_ops };
  };
  const [agreementPrivateKey, signingPrivateKey, agreementPublicKey, signingPublicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", serializedKeys.agreement, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.importKey("jwk", serializedKeys.signing, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    crypto.subtle.importKey("jwk", publicJwk(serializedKeys.agreement, []), { name: "ECDH", namedCurve: "P-256" }, true, []),
    crypto.subtle.importKey("jwk", publicJwk(serializedKeys.signing, ["verify"]), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
  ]);
  return { agreementPrivateKey, signingPrivateKey, agreementPublicKey, signingPublicKey };
}

export async function verifyLegacyHouseholdEpoch({ record, deviceKeys }) {
  if (record?.sealed?.householdId !== record.householdId || record?.sealed?.keyEpoch !== record.keyEpoch)
    throw new SyncCryptoError("stored_key_mismatch", "The legacy epoch metadata does not match its sealed key.");
  const rawKey = await openSealedKey({ sealed: record.sealed, deviceKeys });
  try {
    if (await fingerprintKey(rawKey) !== record.fingerprint)
      throw new SyncCryptoError("stored_key_mismatch", "The legacy epoch fingerprint does not match its sealed key.");
    const restored = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sentinel = crypto.getRandomValues(new Uint8Array(32));
    const params = { name: "AES-GCM", iv, additionalData: encoder.encode("kin.sync.legacy-key-verification.v1"), tagLength: 128 };
    const [original, recovered] = await Promise.all([
      crypto.subtle.encrypt(params, record.householdKey, sentinel), crypto.subtle.encrypt(params, restored, sentinel),
    ]);
    const bytes = new Uint8Array(original), other = new Uint8Array(recovered);
    if (bytes.length !== other.length || bytes.some((value, index) => value !== other[index]))
      throw new SyncCryptoError("stored_key_mismatch", "The legacy AES key differs from its recovery seal. Original keys were preserved.");
  } finally { rawKey.fill(0); }
}

export async function resealHouseholdEpoch({ sealed, oldDeviceKeys, newDeviceKeys }) {
  const rawKey = await openSealedKey({ sealed, deviceKeys: oldDeviceKeys });
  try {
    return await sealKeyBytes({ rawKey, householdId: sealed.householdId, keyEpoch: sealed.keyEpoch, deviceKeys: newDeviceKeys });
  } finally { rawKey.fill(0); }
}

export const MAX_DEVICE_KEY_GENERATION = 16;
export async function createDeviceKeyTransition({ householdId, memberId, deviceId, generation, oldFingerprint, publicKeys, signingKey, transitionId = randomIdHex() }) {
  const value = {
    version: 1, purpose: "kin.sync.device-key-successor.v1", householdId, memberId,
    deviceId, generation, oldFingerprint, publicKeys,
    fingerprint: await deviceKeyFingerprint(publicKeys), transitionId,
  };
  value.signature = toBase64Url(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(stableJson(value)),
  )));
  return value;
}

export async function verifyDeviceKeyTransition({ transition, previous, device }) {
  const t = transition;
  if (!t || t.version !== 1 || t.purpose !== "kin.sync.device-key-successor.v1" ||
      t.householdId !== device.householdId || t.memberId !== device.memberId || t.deviceId !== device.deviceId ||
      t.oldFingerprint !== previous.fingerprint || t.generation !== previous.generation + 1 ||
      t.generation > MAX_DEVICE_KEY_GENERATION || !/^[a-f0-9]{32}$/.test(t.transitionId) ||
      await deviceKeyFingerprint(t.publicKeys) !== t.fingerprint || t.fingerprint === t.oldFingerprint)
    throw new SyncCryptoError("device_transition_invalid", "A trusted device key transition is invalid.");
  const { signature, ...unsigned } = t;
  const keys = await importDevicePublicKeys(previous.publicKeys);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.signing,
      fromBase64Url(signature), encoder.encode(stableJson(unsigned))))
    throw new SyncCryptoError("device_transition_invalid", "A trusted device key transition signature is invalid.");
  return { publicKeys: t.publicKeys, fingerprint: t.fingerprint, generation: t.generation };
}

export async function verifiedDeviceKeyHistory(device) {
  const transitions = device.keyTransitions ?? [];
  const history = device.keyHistory ?? [{ publicKeys: device.publicKeys, fingerprint: device.fingerprint, generation: 0 }];
  if (!Array.isArray(transitions) || transitions.length > MAX_DEVICE_KEY_GENERATION ||
      !Array.isArray(history) || history.length !== transitions.length + 1 || history[0]?.generation !== 0 ||
      await deviceKeyFingerprint(history[0].publicKeys) !== history[0].fingerprint)
    throw new SyncCryptoError("device_transition_invalid", "The trusted device key history is invalid.");
  let previous = history[0];
  for (let i = 0; i < transitions.length; i++) {
    previous = await verifyDeviceKeyTransition({ transition: transitions[i], previous, device });
    if (stableJson(previous) !== stableJson(history[i + 1]))
      throw new SyncCryptoError("device_transition_invalid", "The trusted device key history does not match its signed transition.");
  }
  if (previous.fingerprint !== device.fingerprint || stableJson(previous.publicKeys) !== stableJson(device.publicKeys))
    throw new SyncCryptoError("device_transition_invalid", "The trusted device current key does not match its history.");
  return history;
}

// Historic exact envelopes do not carry key generation. A verified bounded public
// history preserves those bytes; only a signature mismatch advances to another key.
export async function decryptWithDeviceHistory({ device, ...options }) {
  const history = device.verifiedKeyHistory ?? await verifiedDeviceKeyHistory(device);
  for (const entry of [...history].reverse()) {
    const keys = await importDevicePublicKeys(entry.publicKeys);
    try { return await decryptEvent({ ...options, signingKey: keys.signing }); }
    catch (error) { if (error.code !== "event_signature_invalid") throw error; }
  }
  throw new SyncCryptoError("event_signature_invalid", "The received event could not be authenticated.");
}

export async function exportDevicePublicKeys(keys) {
  return {
    agreement: await crypto.subtle.exportKey("jwk", keys.agreementPublicKey),
    signing: await crypto.subtle.exportKey("jwk", keys.signingPublicKey),
  };
}

export async function importDevicePublicKeys(keys) {
  try {
    return {
      agreement: await crypto.subtle.importKey(
        "jwk",
        keys.agreement,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      ),
      signing: await crypto.subtle.importKey(
        "jwk",
        keys.signing,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      ),
    };
  } catch (error) {
    throw new SyncCryptoError(
      "device_key_invalid",
      "The trusted device key is invalid.",
      error,
    );
  }
}

export async function encryptEvent({
  eventId,
  householdId,
  deviceId,
  deviceSequence,
  logicalTime,
  keyEpoch,
  plaintext,
  householdKey,
  signingKey,
}) {
  validateMetadata({
    eventId,
    householdId,
    deviceId,
    deviceSequence,
    logicalTime,
    keyEpoch,
  });
  if (!(plaintext instanceof Uint8Array) || plaintext.length === 0) {
    throw new SyncCryptoError(
      "event_plaintext_invalid",
      "The local event cannot be encrypted.",
    );
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const metadata = {
    protocolVersion: PROTOCOL_VERSION,
    envelopeVersion: ENVELOPE_VERSION,
    eventId,
    householdId,
    deviceId,
    deviceSequence,
    logicalTime: String(logicalTime),
    keyEpoch,
  };
  const aad = associatedData(metadata);
  try {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
        householdKey,
        plaintext,
      ),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signingKey,
        signatureInput(aad, nonce, ciphertext),
      ),
    );
    return {
      ...metadata,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(ciphertext),
      signature: toBase64Url(signature),
    };
  } catch (error) {
    if (error instanceof SyncCryptoError) throw error;
    throw new SyncCryptoError(
      "encrypt_failed",
      "The event could not be encrypted.",
      error,
    );
  }
}

export async function decryptEvent({ envelope, householdKey, signingKey }) {
  validateEnvelope(envelope);
  const aad = associatedData(envelope);
  const nonce = fromBase64Url(envelope.nonce);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const signature = fromBase64Url(envelope.signature);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      signature,
      signatureInput(aad, nonce, ciphertext),
    );
  } catch (error) {
    throw new SyncCryptoError(
      "event_signature_invalid",
      "The received event could not be authenticated.",
      error,
    );
  }
  if (!verified) {
    throw new SyncCryptoError(
      "event_signature_invalid",
      "The received event could not be authenticated.",
    );
  }
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
        householdKey,
        ciphertext,
      ),
    );
  } catch (error) {
    throw new SyncCryptoError(
      "decrypt_failed",
      "The received event could not be decrypted.",
      error,
    );
  }
}

export async function encryptIdentityBinding({
  binding,
  householdId,
  deviceId,
  deviceSequence,
  logicalTime,
  keyEpoch,
  householdKey,
  signingKey,
}) {
  for (const field of [
    "legacyHouseholdId",
    "legacyActorId",
    "legacyDeviceId",
    "householdId",
    "actorId",
    "deviceId",
  ]) {
    if (
      typeof binding?.[field] !== "string" ||
      !/^[a-f0-9]{32}$/.test(binding[field])
    )
      throw new SyncCryptoError(
        "identity_binding_invalid",
        "This device identity could not be securely synchronized.",
      );
  }
  if (binding.householdId !== householdId || binding.deviceId !== deviceId)
    throw new SyncCryptoError(
      "identity_binding_invalid",
      "This device identity does not match the signed-in household.",
    );
  const eventId = randomIdHex();
  return encryptEvent({
    eventId,
    householdId,
    deviceId,
    deviceSequence,
    logicalTime,
    keyEpoch,
    plaintext: encoder.encode(
      stableJson({ protocolVersion: 1, type: "identity-binding", binding }),
    ),
    householdKey,
    signingKey,
  });
}

export async function decryptIdentityBinding({
  envelope,
  householdKey,
  signingKey,
  expectedHouseholdId,
}) {
  const plaintext = await decryptEvent({ envelope, householdKey, signingKey });
  let record;
  try {
    record = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch (error) {
    throw new SyncCryptoError(
      "identity_binding_invalid",
      "The synchronized device identity could not be verified.",
      error,
    );
  }
  const binding = record?.binding;
  if (
    record?.protocolVersion !== 1 ||
    record?.type !== "identity-binding" ||
    binding?.householdId !== expectedHouseholdId ||
    binding?.deviceId !== envelope.deviceId ||
    [
      "legacyHouseholdId",
      "legacyActorId",
      "legacyDeviceId",
      "householdId",
      "actorId",
      "deviceId",
    ].some((field) => !/^[a-f0-9]{32}$/.test(binding?.[field] ?? ""))
  ) {
    throw new SyncCryptoError(
      "identity_binding_invalid",
      "The synchronized device identity could not be verified.",
    );
  }
  return binding;
}

export function validateEnvelope(envelope) {
  if (
    !envelope ||
    envelope.protocolVersion !== PROTOCOL_VERSION ||
    envelope.envelopeVersion !== ENVELOPE_VERSION
  ) {
    throw new SyncCryptoError(
      "envelope_unsupported",
      "This synchronized event version is not supported.",
    );
  }
  validateMetadata(envelope);
  const nonce = fromBase64Url(envelope.nonce);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const signature = fromBase64Url(envelope.signature);
  if (
    nonce.length !== 12 ||
    ciphertext.length < 16 ||
    signature.length !== 64
  ) {
    throw new SyncCryptoError(
      "envelope_malformed",
      "The synchronized event is incomplete.",
    );
  }
  return envelope;
}

function validateMetadata({
  eventId,
  householdId,
  deviceId,
  deviceSequence,
  logicalTime,
  keyEpoch,
}) {
  for (const id of [eventId, householdId, deviceId]) {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_ID_LENGTH
    ) {
      throw new SyncCryptoError(
        "envelope_malformed",
        "The synchronized event identity is invalid.",
      );
    }
  }
  if (
    !Number.isSafeInteger(deviceSequence) ||
    deviceSequence < 1 ||
    !/^(0|[1-9][0-9]*)$/.test(String(logicalTime)) ||
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1
  ) {
    throw new SyncCryptoError(
      "envelope_malformed",
      "The synchronized event ordering is invalid.",
    );
  }
}

function associatedData(metadata) {
  return encodeFields([
    "kin.sync.event.aad.v1",
    String(metadata.protocolVersion),
    String(metadata.envelopeVersion),
    metadata.householdId,
    metadata.eventId,
    metadata.deviceId,
    String(metadata.deviceSequence),
    String(metadata.logicalTime),
    String(metadata.keyEpoch),
  ]);
}

async function sealKeyBytes({ rawKey, householdId, keyEpoch, deviceKeys }) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields([
    "kin.sync.local-key.v1",
    householdId,
    String(keyEpoch),
  ]);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: deviceKeys.agreementPublicKey },
      deviceKeys.agreementPrivateKey,
      256,
    ),
  );
  try {
    const wrappingKey = await deriveWrappingKey(sharedSecret, salt, aad);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
        wrappingKey,
        rawKey,
      ),
    );
    return {
      version: 1,
      householdId,
      keyEpoch,
      salt: toBase64Url(salt),
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(ciphertext),
    };
  } finally {
    sharedSecret.fill(0);
  }
}

async function openSealedKey({ sealed, deviceKeys }) {
  if (
    sealed?.version !== 1 ||
    typeof sealed.householdId !== "string" ||
    !Number.isSafeInteger(sealed.keyEpoch) ||
    sealed.keyEpoch < 1
  ) {
    throw new SyncCryptoError(
      "stored_key_invalid",
      "Kin could not read this device's encryption key.",
    );
  }
  const salt = fromBase64Url(sealed.salt);
  const nonce = fromBase64Url(sealed.nonce);
  const ciphertext = fromBase64Url(sealed.ciphertext);
  if (salt.length !== 32 || nonce.length !== 12 || ciphertext.length !== 48) {
    throw new SyncCryptoError(
      "stored_key_invalid",
      "Kin could not read this device's encryption key.",
    );
  }
  const aad = encodeFields([
    "kin.sync.local-key.v1",
    sealed.householdId,
    String(sealed.keyEpoch),
  ]);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: deviceKeys.agreementPublicKey },
      deviceKeys.agreementPrivateKey,
      256,
    ),
  );
  try {
    const wrappingKey = await deriveWrappingKey(sharedSecret, salt, aad);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
        wrappingKey,
        ciphertext,
      ),
    );
  } catch (error) {
    throw new SyncCryptoError(
      "stored_key_invalid",
      "Kin could not read this device's encryption key.",
      error,
    );
  } finally {
    sharedSecret.fill(0);
  }
}

async function deriveWrappingKey(
  sharedSecret,
  salt,
  info,
  usages = ["encrypt", "decrypt"],
) {
  const inputKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    inputKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function provisioningAad(grant) {
  return encodeFields([
    "kin.sync.key-wrap.aad.v1",
    String(grant.version ?? 1),
    grant.householdId,
    grant.senderDeviceId,
    grant.recipientDeviceId,
    grant.recipientFingerprint,
    String(grant.keyEpoch),
    grant.grantId,
    String(grant.expiresAt),
  ]);
}

function validateKeyGrant(grant) {
  if (
    typeof grant.householdId !== "string" ||
    typeof grant.senderDeviceId !== "string" ||
    typeof grant.recipientDeviceId !== "string" ||
    !/^[a-f0-9]{64}$/.test(grant.recipientFingerprint) ||
    !Number.isSafeInteger(grant.keyEpoch) ||
    grant.keyEpoch < 1 ||
    typeof grant.grantId !== "string" ||
    !Number.isSafeInteger(grant.expiresAt)
  ) {
    throw new SyncCryptoError(
      "provisioning_invalid",
      "The key transfer request is invalid.",
    );
  }
}

function validateProvisioningPackage(value) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.ephemeralPublicKey !== "object" ||
    typeof value.signature !== "string"
  ) {
    throw new SyncCryptoError(
      "provisioning_invalid",
      "The key transfer package is invalid.",
    );
  }
  validateKeyGrant(value);
  const salt = fromBase64Url(value.salt);
  const nonce = fromBase64Url(value.nonce);
  const wrappedKey = fromBase64Url(value.wrappedKey);
  const signature = fromBase64Url(value.signature);
  if (
    salt.length !== 32 ||
    nonce.length !== 12 ||
    wrappedKey.length !== 48 ||
    signature.length !== 64
  ) {
    throw new SyncCryptoError(
      "provisioning_invalid",
      "The key transfer package is incomplete.",
    );
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function randomIdHex() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintKey(rawKey) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawKey));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signatureInput(aad, nonce, ciphertext) {
  return encodeFields(["kin.sync.event.signature.v1", aad, nonce, ciphertext]);
}

function encodeFields(fields) {
  const values = fields.map((field) =>
    typeof field === "string" ? encoder.encode(field) : field,
  );
  const length = values.reduce((total, value) => total + 4 + value.length, 0);
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const value of values) {
    view.setUint32(offset, value.length, false);
    offset += 4;
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SyncCryptoError(
      "envelope_malformed",
      "The synchronized event encoding is invalid.",
    );
  }
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const result = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (toBase64Url(result) !== value) throw new Error("Noncanonical encoding");
    return result;
  } catch (error) {
    throw new SyncCryptoError(
      "envelope_malformed",
      "The synchronized event encoding is invalid.",
      error,
    );
  }
}
