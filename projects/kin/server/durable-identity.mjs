import { createHash, createPublicKey } from "node:crypto";
import { canonicalJson, MAX_KEY_EPOCHS } from "./sync-contract.mjs";

const isRecord = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !Buffer.isBuffer(value);
const isId = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const isFingerprint = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isEpoch = (value) =>
  Number.isSafeInteger(value) && value >= 1 && value <= MAX_KEY_EPOCHS;
const isSignature = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{86}$/.test(value);
const isCanonicalSignature = (value) =>
  isSignature(value) &&
  Buffer.from(value, "base64url").toString("base64url") === value;

export function validCredentialId(value) {
  // Service-level fixtures and existing enrollment permit opaque non-base64 IDs.
  return typeof value === "string" && value.length > 0;
}

export function validStoredCredential(credential) {
  return (
    isRecord(credential) &&
    validCredentialId(credential.id) &&
    isId(credential.memberId) &&
    [-7, -257].includes(credential.algorithm) &&
    ((typeof credential.publicKey === "string" &&
      credential.publicKey.trim().length > 0) ||
      (Buffer.isBuffer(credential.publicKey) && credential.publicKey.length > 0)) &&
    Number.isSafeInteger(credential.signCount) &&
    credential.signCount >= 0 &&
    credential.signCount <= 0xffffffff &&
    (credential.transports === undefined || Array.isArray(credential.transports))
  );
}

export function validStoredDevice(device) {
  if (
    !isRecord(device) ||
    !isId(device.id) ||
    !isId(device.memberId) ||
    !isId(device.householdId) ||
    typeof device.label !== "string" ||
    !device.label.trim() ||
    device.label.length > 48 ||
    !isTimestamp(device.trustedAt) ||
    (device.revokedAt !== null && !isTimestamp(device.revokedAt)) ||
    (device.tokenHash !== null && !isFingerprint(device.tokenHash))
  )
    return false;

  // A new adult can await the next epoch, including the terminal epoch's
  // unfulfillable successor. Do not turn that existing paused state into loss.
  if (
    device.syncHistoryFromEpoch !== undefined &&
    (!Number.isSafeInteger(device.syncHistoryFromEpoch) ||
      device.syncHistoryFromEpoch < 1 ||
      device.syncHistoryFromEpoch > MAX_KEY_EPOCHS + 1)
  )
    return false;
  if (
    device.syncProvisionedEpochs !== undefined &&
    (!Array.isArray(device.syncProvisionedEpochs) ||
      device.syncProvisionedEpochs.length > MAX_KEY_EPOCHS ||
      device.syncProvisionedEpochs.some((epoch) => !isEpoch(epoch)) ||
      new Set(device.syncProvisionedEpochs).size !==
        device.syncProvisionedEpochs.length)
  )
    return false;

  const hasKeys =
    device.syncPublicKeys !== undefined || device.syncKeyFingerprint !== undefined;
  if (hasKeys && !validPublicKeys(device.syncPublicKeys, device.syncKeyFingerprint))
    return false;
  const hasHistory =
    device.syncKeyHistory !== undefined ||
    device.syncKeyTransitions !== undefined ||
    device.syncKeyGeneration !== undefined;
  if (hasHistory) {
    const generation = device.syncKeyGeneration;
    const history = device.syncKeyHistory;
    const transitions = device.syncKeyTransitions;
    if (
      !hasKeys ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > 16 ||
      !Array.isArray(history) ||
      history.length !== generation + 1 ||
      !Array.isArray(transitions) ||
      transitions.length !== generation
    )
      return false;
    const transitionIds = new Set();
    for (let index = 0; index < history.length; index += 1) {
      const entry = history[index];
      if (
        !isRecord(entry) ||
        entry.generation !== index ||
        !validPublicKeys(entry.publicKeys, entry.fingerprint)
      )
        return false;
      if (index === 0) continue;
      const transition = transitions[index - 1];
      if (
        !isRecord(transition) ||
        transition.version !== 1 ||
        transition.purpose !== "kin.sync.device-key-successor.v1" ||
        transition.householdId !== device.householdId ||
        transition.memberId !== device.memberId ||
        transition.deviceId !== device.id ||
        transition.generation !== index ||
        !isId(transition.transitionId) ||
        transitionIds.has(transition.transitionId) ||
        transition.oldFingerprint !== history[index - 1].fingerprint ||
        transition.fingerprint !== entry.fingerprint ||
        transition.fingerprint === transition.oldFingerprint ||
        canonicalJson(transition.publicKeys) !== canonicalJson(entry.publicKeys) ||
        !isCanonicalSignature(transition.signature)
      )
        return false;
      transitionIds.add(transition.transitionId);
    }
    if (
      history[generation].fingerprint !== device.syncKeyFingerprint ||
      canonicalJson(history[generation].publicKeys) !==
        canonicalJson(device.syncPublicKeys)
    )
      return false;
  }
  if (device.deviceAuthorizationCertificate !== undefined) {
    const certificate = device.deviceAuthorizationCertificate;
    const original = device.syncKeyHistory?.[0] ?? {
      publicKeys: device.syncPublicKeys,
      fingerprint: device.syncKeyFingerprint,
    };
    // Approval historically verified the decoded signature without requiring
    // canonical unused base64 bits. Preserve those accepted certificate bytes.
    if (
      !hasKeys ||
      !isRecord(certificate) ||
      certificate.version !== 1 ||
      certificate.householdId !== device.householdId ||
      certificate.memberId !== device.memberId ||
      certificate.deviceId !== device.id ||
      !isId(certificate.issuerDeviceId) ||
      !isFingerprint(certificate.issuerFingerprint) ||
      certificate.fingerprint !== original.fingerprint ||
      canonicalJson(certificate.publicKeys) !==
        canonicalJson(original.publicKeys) ||
      !isSignature(certificate.signature)
    )
      return false;
  }
  return true;
}

function validPublicKeys(value, fingerprint) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !isFingerprint(fingerprint)
  )
    return false;
  try {
    for (const name of ["agreement", "signing"]) {
      const key = value[name];
      if (
        !isRecord(key) ||
        key.kty !== "EC" ||
        key.crv !== "P-256" ||
        typeof key.x !== "string" ||
        typeof key.y !== "string" ||
        "d" in key ||
        createPublicKey({ key, format: "jwk" }).asymmetricKeyType !== "ec" ||
        (name === "signing" &&
          (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify")))
      )
        return false;
    }
    return (
      createHash("sha256").update(canonicalJson(value)).digest("hex") === fingerprint
    );
  } catch {
    return false;
  }
}
