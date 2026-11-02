// Private envelopes (ADR 0019, #492): a member's private events sealed
// under the member key (MK) for one epoch.
//
// The envelope has the sync envelope's fields and versions (protocol 1,
// envelope 1: event ID, household, device, device sequence, logical time,
// key epoch, nonce, ciphertext, signature), so it travels in the same binary
// batches and passes the service's same opaque checks. What differs is
// inside the cryptography:
//
//   key        the member key of `keyEpoch` (AES-256-GCM), not a household key
//   AAD        fields("kin.sync.private.aad.v1", protocol, envelope version,
//              "private", household, member, event, device, device sequence,
//              logical time, key epoch)
//   signature  ECDSA P-256 / SHA-256 by the sending device's signing key over
//              fields("kin.sync.private.signature.v1", AAD, nonce, ciphertext)
//
// `fields` is the sync envelope's length-prefixed encoding (u32 big-endian
// length, then the bytes, for each field). The AAD names the stream and the
// member, so a private envelope can't be replayed into another member's
// stream or passed off as a household, chat or board envelope, and the
// signature says which of the member's devices wrote it. Every primitive is
// Web Crypto.
import { fromBase64Url, toBase64Url } from "../security/local-vault.js";

const PROTOCOL_VERSION = 1;
const ENVELOPE_VERSION = 1;
const ID = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();

export class PrivateEnvelopeError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "PrivateEnvelopeError";
    this.code = code;
  }
}

function fields(values) {
  const parts = values.map((value) => (typeof value === "string" ? encoder.encode(value) : value));
  const result = new Uint8Array(parts.reduce((total, part) => total + 4 + part.length, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    result.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return result;
}

function checkMetadata({ eventId, householdId, memberId, deviceId, deviceSequence, logicalTime, keyEpoch }) {
  if (![eventId, householdId, memberId, deviceId].every((id) => ID.test(id ?? "")) ||
      !Number.isSafeInteger(deviceSequence) || deviceSequence < 1 ||
      !/^[1-9][0-9]{0,15}$/.test(String(logicalTime)) ||
      !Number.isSafeInteger(keyEpoch) || keyEpoch < 1 || keyEpoch > 128)
    throw new PrivateEnvelopeError("envelope_malformed", "The private event's identity is invalid.");
}

/** The AAD a private envelope's ciphertext is bound to. */
export function privateAad({ householdId, memberId, eventId, deviceId, deviceSequence, logicalTime, keyEpoch }) {
  return fields([
    "kin.sync.private.aad.v1", String(PROTOCOL_VERSION), String(ENVELOPE_VERSION), "private",
    householdId, memberId, eventId, deviceId, String(deviceSequence), String(logicalTime), String(keyEpoch),
  ]);
}

const signatureInput = (aad, nonce, ciphertext) => fields(["kin.sync.private.signature.v1", aad, nonce, ciphertext]);

/** Seals one canonical private event under `memberKey` (a CryptoKey) and
 * signs it with this device's `signingKey`. */
export async function encryptPrivateEvent({ eventId, householdId, memberId, deviceId, deviceSequence, logicalTime, keyEpoch, plaintext, memberKey, signingKey }) {
  const metadata = { eventId, householdId, memberId, deviceId, deviceSequence, logicalTime: String(logicalTime), keyEpoch };
  checkMetadata(metadata);
  if (!(plaintext instanceof Uint8Array) || plaintext.length === 0)
    throw new PrivateEnvelopeError("event_plaintext_invalid", "The private event cannot be encrypted.");
  const aad = privateAad(metadata);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, memberKey, plaintext));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, signatureInput(aad, nonce, ciphertext)));
    return {
      protocolVersion: PROTOCOL_VERSION, envelopeVersion: ENVELOPE_VERSION, eventId, householdId, deviceId,
      deviceSequence, logicalTime: metadata.logicalTime, keyEpoch,
      nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext), signature: toBase64Url(signature),
    };
  } catch (error) {
    throw new PrivateEnvelopeError("encrypt_failed", "The private event could not be encrypted.", error);
  }
}

function parts(envelope, memberId) {
  if (!envelope || envelope.protocolVersion !== PROTOCOL_VERSION || envelope.envelopeVersion !== ENVELOPE_VERSION)
    throw new PrivateEnvelopeError("envelope_unsupported", "This private event version is not supported.");
  checkMetadata({ ...envelope, memberId });
  let nonce, ciphertext, signature;
  try {
    nonce = fromBase64Url(envelope.nonce);
    ciphertext = fromBase64Url(envelope.ciphertext);
    signature = fromBase64Url(envelope.signature);
  } catch (error) {
    throw new PrivateEnvelopeError("envelope_malformed", "The private event is incomplete.", error);
  }
  if (nonce.length !== 12 || ciphertext.length < 16 || signature.length !== 64)
    throw new PrivateEnvelopeError("envelope_malformed", "The private event is incomplete.");
  return { aad: privateAad({ ...envelope, memberId }), nonce, ciphertext, signature };
}

async function open(memberKey, { aad, nonce, ciphertext }) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, memberKey, ciphertext));
  } catch (error) {
    throw new PrivateEnvelopeError("decrypt_failed", "A private event could not be decrypted.", error);
  }
}

/** Authenticates a relayed private envelope against one of the sending
 * device's public signing keys (`verifyKeys`, newest first, as a device's
 * verified key history gives them) and decrypts it. */
export async function decryptPrivateEvent({ envelope, memberId, memberKey, verifyKeys }) {
  const sealed = parts(envelope, memberId);
  let verified = false;
  for (const key of verifyKeys) {
    try {
      if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sealed.signature, signatureInput(sealed.aad, sealed.nonce, sealed.ciphertext))) {
        verified = true;
        break;
      }
    } catch { /* the next key */ }
  }
  if (!verified) throw new PrivateEnvelopeError("event_signature_invalid", "A private event could not be authenticated.");
  return open(memberKey, sealed);
}

/** Decrypts an envelope this device authenticated when it arrived and kept
 * as it was; the AES-GCM tag still binds it to its metadata and member. */
export async function decryptStoredPrivateEvent({ envelope, memberId, memberKey }) {
  return open(memberKey, parts(envelope, memberId));
}
