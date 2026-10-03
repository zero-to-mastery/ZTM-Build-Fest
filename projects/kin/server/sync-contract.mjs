// Opaque routing/package rules shared by live acceptance and durable validation.
// These checks never decode household content or require an unexpired grant.
export const CANONICAL_ENVELOPE_FIELDS = [
  "protocolVersion",
  "envelopeVersion",
  "eventId",
  "householdId",
  "deviceId",
  "deviceSequence",
  "logicalTime",
  "keyEpoch",
  "nonce",
  "ciphertext",
  "signature",
];
export const MAX_ENVELOPE_BYTES = 8_192;
export const MAX_HOUSEHOLD_EVENTS = 100_000;
export const MAX_KEY_EPOCHS = 128;
export const MAX_BINDINGS = 256;
export const MAX_ROTATION_PACKAGES = 64;

export function isEventEnvelopeValid(envelope) {
  return Boolean(
    envelope &&
      typeof envelope === "object" &&
      Object.keys(envelope).length === CANONICAL_ENVELOPE_FIELDS.length &&
      CANONICAL_ENVELOPE_FIELDS.every((field) => Object.hasOwn(envelope, field)) &&
      envelope.protocolVersion === 1 &&
      envelope.envelopeVersion === 1 &&
      isSyncId(envelope.eventId) &&
      isSyncId(envelope.householdId) &&
      isSyncId(envelope.deviceId) &&
      Number.isSafeInteger(envelope.keyEpoch) &&
      envelope.keyEpoch >= 1 &&
      envelope.keyEpoch <= MAX_KEY_EPOCHS &&
      Number.isSafeInteger(envelope.deviceSequence) &&
      envelope.deviceSequence >= 1 &&
      /^(0|[1-9][0-9]*)$/.test(envelope.logicalTime) &&
      /^[A-Za-z0-9_-]{16}$/.test(envelope.nonce) &&
      typeof envelope.ciphertext === "string" &&
      /^[A-Za-z0-9_-]+$/.test(envelope.ciphertext) &&
      Buffer.byteLength(envelope.ciphertext) <= MAX_ENVELOPE_BYTES &&
      /^[A-Za-z0-9_-]{86}$/.test(envelope.signature) &&
      Buffer.from(envelope.nonce, "base64url").length === 12 &&
      Buffer.from(envelope.signature, "base64url").length === 64 &&
      Buffer.from(envelope.ciphertext, "base64url").length >= 16,
  );
}

export function isProvisioningPackageValid(value, expected) {
  return Boolean(
    value &&
      value.version === 1 &&
      isSyncId(value.grantId) &&
      (value.requestId == null || isSyncId(value.requestId)) &&
      value.householdId === expected.householdId &&
      value.senderDeviceId === expected.senderDeviceId &&
      value.recipientDeviceId === expected.recipientDeviceId &&
      value.recipientFingerprint === expected.recipientFingerprint &&
      value.keyEpoch === expected.keyEpoch &&
      value.grantId === expected.grantId &&
      Number.isSafeInteger(value.expiresAt) &&
      value.expiresAt === expected.expiresAt &&
      typeof value.signature === "string" &&
      typeof value.wrappedKey === "string" &&
      typeof value.ephemeralPublicKey === "object" &&
      Buffer.byteLength(JSON.stringify(value)) <= MAX_ENVELOPE_BYTES,
  );
}

export function canonicalEventEnvelope(envelope) {
  return JSON.stringify(
    CANONICAL_ENVELOPE_FIELDS.map((field) => [field, envelope[field]]),
  );
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function isSyncId(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isGrantRoutingValid(grant, householdId, currentEpoch, getDevice) {
  if (
    !grant ||
    !isSyncId(grant.grantId) ||
    grant.householdId !== householdId ||
    !isSyncId(grant.senderDeviceId) ||
    !isSyncId(grant.recipientDeviceId) ||
    typeof grant.recipientFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(grant.recipientFingerprint) ||
    !Number.isSafeInteger(grant.keyEpoch) ||
    grant.keyEpoch < 1 ||
    grant.keyEpoch > currentEpoch ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.expiresAt < 0
  )
    return false;
  const sender = getDevice(grant.senderDeviceId);
  const recipient = getDevice(grant.recipientDeviceId);
  return Boolean(
    sender && recipient &&
      sender.householdId === householdId &&
      recipient.householdId === householdId &&
      grant.keyEpoch >= (sender.syncHistoryFromEpoch ?? 1) &&
      grant.keyEpoch >= (recipient.syncHistoryFromEpoch ?? 1) &&
      (grant.recipientFingerprint === recipient.syncKeyFingerprint ||
        recipient.syncKeyHistory?.some(
          (entry) => entry.fingerprint === grant.recipientFingerprint,
        )),
  );
}

export function isDurableGrantValid(grant, row, currentEpoch, getDevice) {
  if (
    !isGrantRoutingValid(grant, row.household_id, currentEpoch, getDevice) ||
    grant.grantId !== row.grant_id ||
    grant.senderDeviceId !== row.sender_device_id ||
    grant.recipientDeviceId !== row.recipient_device_id ||
    (grant.requestId ?? null) !== row.request_id ||
    grant.expiresAt !== row.expires_at ||
    (grant.requestId != null && !isSyncId(grant.requestId)) ||
    !["pending", "acknowledged"].includes(grant.state)
  )
    return false;
  if (grant.package === null)
    return grant.canonicalPackage === null && grant.state === "pending";
  return Boolean(
    isProvisioningPackageValid(grant.package, grant) &&
      typeof grant.canonicalPackage === "string" &&
      canonicalJson(grant.package) === grant.canonicalPackage,
  );
}

export function isDurableRotationValid(
  rotation,
  householdId,
  currentEpoch,
  getDevice,
) {
  if (rotation === null) return currentEpoch === 1;
  if (
    !rotation ||
    !Number.isSafeInteger(rotation.expectedEpoch) ||
    rotation.expectedEpoch < 1 ||
    rotation.expectedEpoch >= MAX_KEY_EPOCHS ||
    rotation.expectedEpoch + 1 !== currentEpoch ||
    !isSyncId(rotation.proposalId) ||
    (rotation.rotationId !== undefined && !isSyncId(rotation.rotationId)) ||
    typeof rotation.canonical !== "string" ||
    Buffer.byteLength(rotation.canonical) >
      MAX_ROTATION_PACKAGES * (MAX_ENVELOPE_BYTES + 1) + 2
  )
    return false;
  const packages = JSON.parse(rotation.canonical);
  if (
    !Array.isArray(packages) ||
    packages.length > MAX_ROTATION_PACKAGES ||
    canonicalJson(packages) !== rotation.canonical
  )
    return false;
  const recipients = new Set();
  let senderId;
  for (const keyPackage of packages) {
    if (
      !isGrantRoutingValid(keyPackage, householdId, currentEpoch, getDevice) ||
      keyPackage.keyEpoch !== currentEpoch ||
      !isProvisioningPackageValid(keyPackage, keyPackage) ||
      recipients.has(keyPackage.recipientDeviceId) ||
      keyPackage.recipientDeviceId === keyPackage.senderDeviceId ||
      (senderId !== undefined && senderId !== keyPackage.senderDeviceId)
    )
      return false;
    recipients.add(keyPackage.recipientDeviceId);
    senderId = keyPackage.senderDeviceId;
  }
  // Recipient authority and keys can change after acceptance. Retain historical
  // relationships, never require this proposal to cover today's active devices.
  return true;
}
