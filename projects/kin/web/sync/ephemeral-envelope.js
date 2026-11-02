// The ephemeral envelope (#257, #258) as a browser sees it: the bytes of one
// short-lived live-channel message, see docs/SYNC.md "Ephemeral envelope" and
// server/live/ephemeral.mjs for the rules. This is only the codec. Nothing in
// the app sends or handles one yet: production accepts no category, and a
// feature that adds one adds its consumer with it. Messages are never
// stored, replayed or exported, and the sender in a delivery is whoever the
// service stamped, never anything the sender wrote.
export const EPHEMERAL_VERSION = 1;
export const SCOPE = Object.freeze({ HOUSEHOLD: 0, MEMBER: 1, DEVICE: 2 });
export const REQUEST_HEADER_BYTES = 40;
export const DELIVERY_HEADER_BYTES = 56;
export const MAX_EPHEMERAL_PAYLOAD = 4096;

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
const bytesToHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const isId = (value) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** The request for one message. `targetId` is a member or device id (32 hex),
 * required for member and device scopes and absent for the household. */
export function encodeEphemeralRequest({ category, scope, correlation, targetId = null, payload = new Uint8Array(0) }) {
  if (!Number.isInteger(category) || category < 0 || category > 255) throw new RangeError("Invalid ephemeral category.");
  if (!Object.values(SCOPE).includes(scope)) throw new RangeError("Invalid ephemeral scope.");
  if (!(correlation instanceof Uint8Array) || correlation.length !== 16) throw new RangeError("Invalid correlation id.");
  if ((scope === SCOPE.HOUSEHOLD) !== (targetId === null) || (targetId !== null && !isId(targetId))) throw new RangeError("Invalid ephemeral target.");
  if (!(payload instanceof Uint8Array) || payload.length > MAX_EPHEMERAL_PAYLOAD) throw new RangeError("Invalid ephemeral payload.");
  const bytes = new Uint8Array(REQUEST_HEADER_BYTES + payload.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = EPHEMERAL_VERSION;
  bytes[1] = category;
  bytes[2] = scope;
  bytes.set(correlation, 4);
  if (targetId !== null) bytes.set(hexToBytes(targetId), 20);
  view.setUint32(36, payload.length, true);
  bytes.set(payload, REQUEST_HEADER_BYTES);
  return bytes;
}

/** Reads a delivery, or returns null if it is not a well-formed version 1. */
export function decodeEphemeralDelivery(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < DELIVERY_HEADER_BYTES || bytes[0] !== EPHEMERAL_VERSION || bytes[3] !== 0) return null;
  if (!Object.values(SCOPE).includes(bytes[2])) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(52, true);
  if (length > MAX_EPHEMERAL_PAYLOAD || bytes.length !== DELIVERY_HEADER_BYTES + length) return null;
  return {
    category: bytes[1], scope: bytes[2],
    correlation: bytes.slice(4, 20),
    senderMemberId: bytesToHex(bytes.subarray(20, 36)),
    senderDeviceId: bytesToHex(bytes.subarray(36, 52)),
    payload: bytes.slice(DELIVERY_HEADER_BYTES),
  };
}
