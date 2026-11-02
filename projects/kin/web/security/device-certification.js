// Member certification keys and the device certificates they sign (ADR 0018
// section 3, #568/#570). The formats are documented with the service's
// checks in server/account-certification.mjs; CRYPTOGRAPHY.md explains the
// chain. Every primitive is Web Crypto ECDSA P-256 with SHA-256 and raw
// (IEEE P1363) signatures, the same as device approval certificates.
//
//   trusted device X of member M ──signs──▶ endorsement of M's certification
//                                            key C (also signed by C, and
//                                            listing X's trust anchors)
//   C (private half only in M's vault) ──signs──▶ new device's certificate
//
// Other household devices accept the new device when X verifies for them
// (pinned or certified as before), X belongs to M, X's signature on the
// endorsement verifies, and C's signature on the certificate verifies. They
// pin C per member the first time; a different C later is refused.
//
// The new device itself trusts C because it opened M's vault, so it trusts
// the endorsement C signed, and with it the anchors X listed (X itself and
// the devices X had pinned): those become its own pins.
import { deviceKeyFingerprint, importDevicePublicKeys } from "../sync/crypto.js";
import { fromBase64Url, toBase64Url } from "./local-vault.js";

export const ENDORSEMENT_PURPOSE = "kin.account.certification-key.v1";
export const MAX_ENDORSEMENT_ANCHORS = 64;
const ID = /^[a-f0-9]{32}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const ECDSA = { name: "ECDSA", hash: "SHA-256" };

export class CertificationError extends Error {
  constructor(message, code = "certification_invalid") {
    super(message);
    this.name = "CertificationError";
    this.code = code;
  }
}

/** Canonical JSON: object keys sorted, as the service's canonicalJson. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** SHA-256 hex of a public key's canonical JSON. */
export async function publicKeyFingerprint(publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(stableJson(publicKey))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The public half of a vault's certification key (PKCS8 bytes) and a
 * signing key for it: `{ publicKey, fingerprint, signingKey }`. The private
 * key is imported non-extractable; the public JWK keeps only kty, crv, x, y.
 */
export async function certificationKeyPair(pkcs8) {
  if (!(pkcs8 instanceof Uint8Array) || !pkcs8.length) throw new CertificationError("This account's vault has no certification key.", "certification_missing");
  const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", extractable);
  const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  jwk.d = "";
  const signingKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { publicKey, fingerprint: await publicKeyFingerprint(publicKey), signingKey };
}

function unsignedEndorsement(endorsement) {
  const { signature: _signature, certificationSignature: _certification, ...unsigned } = endorsement;
  return unsigned;
}

async function sign(key, value) {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(ECDSA, key, encoder.encode(stableJson(value)))));
}

async function verify(publicJwk, value, signature) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  let bytes;
  try { bytes = fromBase64Url(signature); } catch { return false; }
  const key = await crypto.subtle.importKey("jwk", { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify(ECDSA, key, bytes, encoder.encode(stableJson(value)));
}

/**
 * Anchors in canonical order: `[{ deviceId, fingerprint }]`, unique by
 * device, sorted by device ID, at most MAX_ENDORSEMENT_ANCHORS.
 */
export function normalizeAnchors(anchors) {
  const byDevice = new Map();
  for (const anchor of anchors ?? []) {
    if (!ID.test(anchor?.deviceId ?? "") || !FINGERPRINT.test(anchor?.fingerprint ?? ""))
      throw new CertificationError("A trusted device anchor is invalid.");
    byDevice.set(anchor.deviceId, { deviceId: anchor.deviceId, fingerprint: anchor.fingerprint });
  }
  const list = [...byDevice.values()].sort((left, right) => (left.deviceId < right.deviceId ? -1 : 1));
  if (!list.length || list.length > MAX_ENDORSEMENT_ANCHORS) throw new CertificationError("Too many trusted device anchors.");
  return list;
}

/**
 * A trusted device's endorsement of its member's certification key. `device`
 * is the endorsing device (`{ deviceId, fingerprint, signingKey }`, its
 * current key); `anchors` are the devices it trusts (it is added itself).
 */
export async function createCertificationEndorsement({ householdId, memberId, certification, device, anchors = [] }) {
  const unsigned = {
    version: 1,
    purpose: ENDORSEMENT_PURPOSE,
    householdId,
    memberId,
    publicKey: certification.publicKey,
    fingerprint: certification.fingerprint,
    issuerDeviceId: device.deviceId,
    issuerFingerprint: device.fingerprint,
    anchors: normalizeAnchors([...anchors.filter((anchor) => anchor.deviceId !== device.deviceId),
      { deviceId: device.deviceId, fingerprint: device.fingerprint }]),
  };
  return {
    ...unsigned,
    signature: await sign(device.signingKey, unsigned),
    certificationSignature: await sign(certification.signingKey, unsigned),
  };
}

/** Checks an endorsement's fields for `householdId`/`memberId`, its key's
 * fingerprint, and the certification key's own signature. */
async function checkEndorsementBody(endorsement, { householdId, memberId }) {
  const fail = (message = "This account's certification key could not be verified.") => new CertificationError(message);
  if (!endorsement || endorsement.version !== 1 || endorsement.purpose !== ENDORSEMENT_PURPOSE ||
      endorsement.householdId !== householdId || endorsement.memberId !== memberId ||
      !ID.test(endorsement.issuerDeviceId ?? "") || !FINGERPRINT.test(endorsement.issuerFingerprint ?? "") ||
      endorsement.publicKey?.kty !== "EC" || endorsement.publicKey?.crv !== "P-256" || Object.keys(endorsement.publicKey).length !== 4)
    throw fail();
  const anchors = normalizeAnchors(endorsement.anchors);
  if (stableJson(anchors) !== stableJson(endorsement.anchors) ||
      !anchors.some((anchor) => anchor.deviceId === endorsement.issuerDeviceId && anchor.fingerprint === endorsement.issuerFingerprint))
    throw fail();
  if (await publicKeyFingerprint(endorsement.publicKey) !== endorsement.fingerprint) throw fail();
  if (!(await verify(endorsement.publicKey, unsignedEndorsement(endorsement), endorsement.certificationSignature))) throw fail();
}

/**
 * On a new device that opened the vault: checks that the service's
 * `endorsement` is for exactly this vault's certification key (`certification`
 * from certificationKeyPair) and signed by it. Its anchors can then be
 * trusted. Throws CertificationError otherwise.
 */
export async function verifyOwnEndorsement(endorsement, { householdId, memberId, certification }) {
  await checkEndorsementBody(endorsement, { householdId, memberId });
  if (endorsement.fingerprint !== certification.fingerprint || stableJson(endorsement.publicKey) !== stableJson(certification.publicKey))
    throw new CertificationError("The service offered a certification key that isn't this account's.", "certification_mismatch");
  return normalizeAnchors(endorsement.anchors);
}

/**
 * A new device's certificate, signed by the member's certification key.
 * `device` is `{ deviceId, publicKeys, fingerprint }` for this device.
 */
export async function createMemberCertificate({ householdId, memberId, device, endorsement, certification }) {
  if (endorsement.fingerprint !== certification.fingerprint)
    throw new CertificationError("The certification key doesn't match its endorsement.", "certification_mismatch");
  const unsigned = {
    version: 2,
    householdId,
    memberId,
    deviceId: device.deviceId,
    publicKeys: device.publicKeys,
    fingerprint: device.fingerprint,
    certificationFingerprint: certification.fingerprint,
    endorsement,
  };
  return { ...unsigned, signature: await sign(certification.signingKey, unsigned) };
}

/**
 * Verifies a version 2 device certificate for directory entry `device`
 * (`{ householdId, memberId, deviceId, publicKeys, fingerprint }`, its
 * original keys) given the endorsing device's public keys at
 * `endorsement.issuerFingerprint` (`issuerPublicKeys`, which the caller has
 * already verified, and whose member must be `device.memberId`). Returns the
 * certification key's fingerprint for pinning.
 */
export async function verifyMemberCertificate({ certificate, device, issuerPublicKeys, issuerMemberId }) {
  const fail = () => new CertificationError("A device certified by its member's account could not be verified.", "device_certificate_invalid");
  if (!certificate || certificate.version !== 2 || certificate.householdId !== device.householdId ||
      certificate.memberId !== device.memberId || certificate.deviceId !== device.deviceId ||
      certificate.fingerprint !== device.fingerprint || stableJson(certificate.publicKeys) !== stableJson(device.publicKeys) ||
      issuerMemberId !== device.memberId)
    throw fail();
  if (await deviceKeyFingerprint(certificate.publicKeys) !== certificate.fingerprint) throw fail();
  const endorsement = certificate.endorsement;
  try {
    await checkEndorsementBody(endorsement, { householdId: device.householdId, memberId: device.memberId });
  } catch { throw fail(); }
  if (certificate.certificationFingerprint !== endorsement.fingerprint) throw fail();
  if (await deviceKeyFingerprint(issuerPublicKeys) !== endorsement.issuerFingerprint) throw fail();
  const issuer = await importDevicePublicKeys(issuerPublicKeys);
  const signed = encoder.encode(stableJson(unsignedEndorsement(endorsement)));
  let signatureBytes;
  try { signatureBytes = fromBase64Url(endorsement.signature); } catch { throw fail(); }
  if (!(await crypto.subtle.verify(ECDSA, issuer.signing, signatureBytes, signed))) throw fail();
  const { signature, ...unsigned } = certificate;
  if (!(await verify(endorsement.publicKey, unsigned, signature))) throw fail();
  return endorsement.fingerprint;
}
