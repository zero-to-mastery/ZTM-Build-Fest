// Binary sync envelopes for /api/sync/events (application/octet-stream),
// shared by the browser and the server (server/server.mjs imports this file).
//
// The envelope objects are unchanged: the browser signs and encrypts them as
// before (crypto.js), the server validates and stores them as before
// (sync-contract.mjs). Only the transport changes: nonce, signature and
// ciphertext travel as bytes instead of base64url text inside JSON, IDs as
// 16 bytes instead of 32 hex characters. Decoding gives back the exact
// object that was encoded (field order, lowercase hex, canonical unpadded
// base64url), so canonical comparisons and signatures are unaffected.
//
// All integers are little-endian.
//
// Envelope record (148 bytes, then the ciphertext):
//   eventId:16  householdId:16  deviceId:16
//   deviceSequence:u64  logicalTime:u64  keyEpoch:u32
//   nonce:12  signature:64  ciphertextLength:u32  ciphertext
// protocolVersion and envelopeVersion are both 1; the format version implies them.
//
// Push batch (POST body):  "KSEV" version:u16=1 count:u16, then `count` records.
// Pull page (GET response): "KSEP" version:u16=1 flags:u8 (bit 0: hasMore)
//   reserved:u8=0 count:u32 nextCursor:8, then per event cursor:8 and a record.
// A cursor is 8 opaque bytes; the objects carry it as unpadded base64url, the
// form the query string takes.

export const ENVELOPE_CONTENT_TYPE = "application/octet-stream";
export const RECORD_FIXED = 148;
// Ciphertext of an envelope whose base64url text fits MAX_ENVELOPE_BYTES
// (8,192 characters, sync-contract.mjs).
export const MAX_CIPHERTEXT_BYTES = 6_144;
const MAX_PAGE_EVENTS = 1_000;
const MAX_SAFE = 9_007_199_254_740_991n;
const encoder = new TextEncoder();

export class EnvelopeWireError extends Error {
  constructor(message = "That sync batch is malformed.") {
    super(message);
    this.name = "EnvelopeWireError";
    this.code = "sync_batch_invalid";
  }
}

const fail = () => { throw new EnvelopeWireError(); };

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(text, length = null) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) fail();
  let binary;
  try { binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4)); }
  catch { fail(); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Only the canonical spelling of these bytes round-trips exactly.
  if ((length !== null && bytes.length !== length) || toBase64Url(bytes) !== text) fail();
  return bytes;
}

function hexBytes(text) {
  if (typeof text !== "string" || !/^[a-f0-9]{32}$/.test(text)) fail();
  return Uint8Array.from(text.match(/../g), (pair) => Number.parseInt(pair, 16));
}

function bytesHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recordLength(envelope) {
  return RECORD_FIXED + fromBase64Url(envelope?.ciphertext).length;
}

function writeRecord(view, bytes, offset, envelope) {
  if (envelope?.protocolVersion !== 1 || envelope.envelopeVersion !== 1 ||
      !Number.isSafeInteger(envelope.deviceSequence) || envelope.deviceSequence < 1 ||
      !Number.isSafeInteger(envelope.keyEpoch) || envelope.keyEpoch < 1 || envelope.keyEpoch > 0xffffffff ||
      typeof envelope.logicalTime !== "string" || !/^[1-9][0-9]{0,15}$/.test(envelope.logicalTime) ||
      BigInt(envelope.logicalTime) > MAX_SAFE)
    fail();
  const ciphertext = fromBase64Url(envelope.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > MAX_CIPHERTEXT_BYTES) fail();
  bytes.set(hexBytes(envelope.eventId), offset);
  bytes.set(hexBytes(envelope.householdId), offset + 16);
  bytes.set(hexBytes(envelope.deviceId), offset + 32);
  view.setBigUint64(offset + 48, BigInt(envelope.deviceSequence), true);
  view.setBigUint64(offset + 56, BigInt(envelope.logicalTime), true);
  view.setUint32(offset + 64, envelope.keyEpoch, true);
  bytes.set(fromBase64Url(envelope.nonce, 12), offset + 68);
  bytes.set(fromBase64Url(envelope.signature, 64), offset + 80);
  view.setUint32(offset + 144, ciphertext.length, true);
  bytes.set(ciphertext, offset + RECORD_FIXED);
  return offset + RECORD_FIXED + ciphertext.length;
}

function readRecord(view, bytes, offset) {
  if (offset + RECORD_FIXED > bytes.length) fail();
  const deviceSequence = view.getBigUint64(offset + 48, true);
  const logicalTime = view.getBigUint64(offset + 56, true);
  const keyEpoch = view.getUint32(offset + 64, true);
  const length = view.getUint32(offset + 144, true);
  const end = offset + RECORD_FIXED + length;
  if (deviceSequence < 1n || deviceSequence > MAX_SAFE || logicalTime < 1n || logicalTime > MAX_SAFE ||
      keyEpoch < 1 || length < 16 || length > MAX_CIPHERTEXT_BYTES || end > bytes.length)
    fail();
  const envelope = {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId: bytesHex(bytes.subarray(offset, offset + 16)),
    householdId: bytesHex(bytes.subarray(offset + 16, offset + 32)),
    deviceId: bytesHex(bytes.subarray(offset + 32, offset + 48)),
    deviceSequence: Number(deviceSequence),
    logicalTime: logicalTime.toString(),
    keyEpoch,
    nonce: toBase64Url(bytes.subarray(offset + 68, offset + 80)),
    ciphertext: toBase64Url(bytes.subarray(offset + RECORD_FIXED, end)),
    signature: toBase64Url(bytes.subarray(offset + 80, offset + 144)),
  };
  return { envelope, end };
}

function header(magic, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(encoder.encode(magic));
  view.setUint16(4, 1, true);
  return view;
}

function checkHeader(magic, bytes, minimum) {
  if (!(bytes instanceof Uint8Array) || bytes.length < minimum ||
      String.fromCharCode(...bytes.subarray(0, 4)) !== magic)
    fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1) throw new EnvelopeWireError("This sync format version is not supported.");
  return view;
}

/** A push batch of envelopes (the POST body). */
export function encodeEnvelopeBatch(envelopes) {
  if (!Array.isArray(envelopes) || envelopes.length > 0xffff) fail();
  const bytes = new Uint8Array(8 + envelopes.reduce((total, envelope) => total + recordLength(envelope), 0));
  const view = header("KSEV", bytes);
  view.setUint16(6, envelopes.length, true);
  let offset = 8;
  for (const envelope of envelopes) offset = writeRecord(view, bytes, offset, envelope);
  return bytes;
}

/** The envelopes of a push batch; rejects counts over maxCount before decoding records. */
export function decodeEnvelopeBatch(bytes, { maxCount = 0xffff } = {}) {
  const view = checkHeader("KSEV", bytes, 8);
  const count = view.getUint16(6, true);
  if (count > maxCount) fail();
  const envelopes = [];
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    const { envelope, end } = readRecord(view, bytes, offset);
    envelopes.push(envelope);
    offset = end;
  }
  if (offset !== bytes.length) fail();
  return envelopes;
}

function cursorBytes(cursor) {
  return fromBase64Url(cursor, 8);
}

/** A pull page ({ events: [{ cursor, envelope }], nextCursor, hasMore }). */
export function encodeEventPage({ events, nextCursor, hasMore }) {
  if (!Array.isArray(events) || events.length > MAX_PAGE_EVENTS) fail();
  const bytes = new Uint8Array(20 + events.reduce((total, event) => total + 8 + recordLength(event.envelope), 0));
  const view = header("KSEP", bytes);
  bytes[6] = hasMore ? 1 : 0;
  view.setUint32(8, events.length, true);
  bytes.set(cursorBytes(nextCursor), 12);
  let offset = 20;
  for (const event of events) {
    bytes.set(cursorBytes(event.cursor), offset);
    offset = writeRecord(view, bytes, offset + 8, event.envelope);
  }
  return bytes;
}

/** The pull page a GET returned; throws EnvelopeWireError when malformed. */
export function decodeEventPage(bytes) {
  const view = checkHeader("KSEP", bytes, 20);
  if (bytes[6] > 1 || bytes[7] !== 0) fail();
  const count = view.getUint32(8, true);
  if (count > MAX_PAGE_EVENTS) fail();
  const events = [];
  let offset = 20;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > bytes.length) fail();
    const cursor = toBase64Url(bytes.subarray(offset, offset + 8));
    const { envelope, end } = readRecord(view, bytes, offset + 8);
    events.push({ cursor, envelope });
    offset = end;
  }
  if (offset !== bytes.length) fail();
  return { events, nextCursor: toBase64Url(bytes.subarray(12, 20)), hasMore: bytes[6] === 1 };
}
