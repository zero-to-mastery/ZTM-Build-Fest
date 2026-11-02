// Member certification keys and the device certificates they sign (ADR 0018
// section 3, #568). The browser makes and checks these (web/security/
// device-certification.js); the service checks them again before it stores
// one, and keeps only public keys and signatures.
//
// A member's certification key is an ECDSA P-256 key whose private half
// lives only inside their account vault. A trusted device of that member
// vouches for it once, with an endorsement:
//
//   { version: 1, purpose: "kin.account.certification-key.v1",
//     householdId, memberId,
//     publicKey: { kty, crv, x, y },          the certification key
//     fingerprint,                            SHA-256 of canonical publicKey
//     issuerDeviceId, issuerFingerprint,      the endorsing device and its key
//     anchors: [{ deviceId, fingerprint }],   that device's trust anchors
//     signature,                              by the endorsing device's key
//     certificationSignature }                by the certification key
//
// Both signatures cover the same bytes: canonical JSON of the endorsement
// without its two signatures. The device's signature is what the household
// trusts (it chains to the device like any approval); the certification
// key's signature proves the endorsement was made by someone holding the
// vault, so a new device that opens the vault can trust the anchors listed
// in it (the devices the endorsing device itself trusted).
//
// A device certificate signed by the certification key (version 2):
//
//   { version: 2, householdId, memberId, deviceId, publicKeys, fingerprint,
//     certificationFingerprint, endorsement, signature }
//
// `signature` is the certification key's, over canonical JSON of the
// certificate without it. Version 1 certificates (one device approving
// another) are unchanged (server/pairing-service/devices.mjs).
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalJson } from "./sync-contract.mjs";
import { PairingError } from "./pairing-service/shared.mjs";

export const ENDORSEMENT_PURPOSE = "kin.account.certification-key.v1";
/** Most trust anchors an endorsement may list: every trusted device a
 * household can have (MAX_TRUSTED_DEVICES) plus revoked ones it pinned. */
export const MAX_ENDORSEMENT_ANCHORS = 64;

const ID = /^[a-f0-9]{32}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Canonical base64url only, so one signature has one spelling.
const isSignature = (value) => SIGNATURE.test(value ?? "") && Buffer.from(value, "base64url").toString("base64url") === value;

/** SHA-256 hex of a public key's canonical JSON (the same rule as device
 * key fingerprints). */
export function publicKeyFingerprint(publicKey) {
  return createHash("sha256").update(canonicalJson(publicKey)).digest("hex");
}

/**
 * Whether `value` has an endorsement's exact shape, with no cryptography
 * (durable-identity.mjs checks stored rows with this). `expected` may pin
 * householdId, memberId and issuerDeviceId.
 */
export function validEndorsementShape(value, expected = {}) {
  if (!isRecord(value)) return false;
  const keys = ["version", "purpose", "householdId", "memberId", "publicKey", "fingerprint", "issuerDeviceId",
    "issuerFingerprint", "anchors", "signature", "certificationSignature"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) return false;
  if (value.version !== 1 || value.purpose !== ENDORSEMENT_PURPOSE || !ID.test(value.householdId ?? "") ||
      !ID.test(value.memberId ?? "") || !ID.test(value.issuerDeviceId ?? "") ||
      !FINGERPRINT.test(value.fingerprint ?? "") || !FINGERPRINT.test(value.issuerFingerprint ?? "") ||
      !isSignature(value.signature) || !isSignature(value.certificationSignature))
    return false;
  for (const [name, wanted] of Object.entries(expected))
    if (wanted !== undefined && value[name] !== wanted) return false;
  const key = value.publicKey;
  if (!isRecord(key) || Object.keys(key).length !== 4 || key.kty !== "EC" || key.crv !== "P-256" ||
      !COORDINATE.test(key.x ?? "") || !COORDINATE.test(key.y ?? ""))
    return false;
  if (!Array.isArray(value.anchors) || value.anchors.length < 1 || value.anchors.length > MAX_ENDORSEMENT_ANCHORS) return false;
  let previous = "";
  let issuerListed = false;
  for (const anchor of value.anchors) {
    if (!isRecord(anchor) || Object.keys(anchor).length !== 2 || !ID.test(anchor.deviceId ?? "") ||
        !FINGERPRINT.test(anchor.fingerprint ?? "") || anchor.deviceId <= previous)
      return false;
    previous = anchor.deviceId;
    if (anchor.deviceId === value.issuerDeviceId) issuerListed = anchor.fingerprint === value.issuerFingerprint;
  }
  return issuerListed;
}

/** Whether `value` has a version 2 certificate's exact shape for `device`
 * (its stored ID, member, household and original keys); no cryptography. */
export function validMemberCertificateShape(value, { householdId, memberId, deviceId, fingerprint, publicKeys }) {
  if (!isRecord(value)) return false;
  const keys = ["version", "householdId", "memberId", "deviceId", "publicKeys", "fingerprint", "certificationFingerprint", "endorsement", "signature"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) return false;
  return value.version === 2 && value.householdId === householdId && value.memberId === memberId &&
    value.deviceId === deviceId && value.fingerprint === fingerprint &&
    canonicalJson(value.publicKeys) === canonicalJson(publicKeys) &&
    isSignature(value.signature) &&
    validEndorsementShape(value.endorsement, { householdId, memberId }) &&
    value.certificationFingerprint === value.endorsement.fingerprint;
}

/**
 * Checks an endorsement a trusted device sends (`PUT /api/account/
 * certification`): its shape, that it names `issuerDevice` (the session's own
 * device, with its current key) for that device's member and household, that
 * the fingerprint is the key's, and both signatures. Returns a clean copy;
 * throws `certification_invalid` (400) otherwise.
 */
export function validateCertificationEndorsement(value, { householdId, memberId, issuerDevice }) {
  try {
    if (!validEndorsementShape(value, { householdId, memberId, issuerDeviceId: issuerDevice.id }) ||
        value.issuerFingerprint !== issuerDevice.syncKeyFingerprint || !issuerDevice.syncPublicKeys?.signing ||
        publicKeyFingerprint(value.publicKey) !== value.fingerprint)
      throw new Error("endorsement fields");
    const signed = Buffer.from(canonicalJson(unsignedEndorsement(value)));
    if (!verifyP1363(issuerDevice.syncPublicKeys.signing, signed, value.signature) ||
        !verifyP1363(value.publicKey, signed, value.certificationSignature))
      throw new Error("endorsement signature");
    return structuredClone(value);
  } catch {
    throw new PairingError("certification_invalid", "Kin could not verify this account's certification key.", 400);
  }
}

/**
 * Checks a new device's version 2 certificate before the service trusts the
 * device (#570): it must carry exactly the member's stored `endorsement`,
 * name this device and its keys, and be signed by the endorsed certification
 * key. The service can't make one itself: it never holds that key.
 */
export function validateMemberCertifiedCertificate(certificate, { householdId, memberId, deviceId, publicKeys, fingerprint, endorsement }) {
  try {
    if (!validMemberCertificateShape(certificate, { householdId, memberId, deviceId, fingerprint, publicKeys }) ||
        canonicalJson(certificate.endorsement) !== canonicalJson(endorsement))
      throw new Error("certificate fields");
    const { signature, ...unsigned } = certificate;
    if (!verifyP1363(endorsement.publicKey, Buffer.from(canonicalJson(unsigned)), signature))
      throw new Error("certificate signature");
    return structuredClone(certificate);
  } catch {
    throw new PairingError("device_certificate_invalid", "Kin could not verify this device's certificate.", 400);
  }
}

export function unsignedEndorsement(value) {
  const { signature: _signature, certificationSignature: _certification, ...unsigned } = value;
  return unsigned;
}

function verifyP1363(jwk, bytes, signature) {
  const { kty, crv, x, y } = jwk;
  return verifySignature("sha256", bytes, { key: createPublicKey({ key: { kty, crv, x, y }, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"));
}
