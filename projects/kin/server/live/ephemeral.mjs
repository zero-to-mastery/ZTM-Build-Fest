// The ephemeral envelope (#257, #258): the one internal shape for short-lived
// messages on the live channel, kept apart from durable chat on purpose.
//
// Durable chat is signed events and sealed blobs that move over the HTTP sync
// routes, are stored, replayed to a device that was offline, exported and
// pushed. An ephemeral message is none of that: it is relayed to sockets that
// are open right now, held in no table, queue or log, never replayed, and
// dropped when the receiver can't take it. A category is a closed list the
// service knows; there are none in production today (typing and presence keep
// their own record types, 3 and 5), so a client that sends one is refused.
// Adding a category later is a deliberate change to CATEGORIES with its limits,
// not a field a client can invent.
//
// Request (client → service, record type EPHEMERAL), little-endian:
//   0   u8   version         1
//   1   u8   category        a key of the service's category table
//   2   u8   scope           0 household, 1 member, 2 device
//   3   u8   reserved        0
//   4   16   correlation id  chosen by the sender, echoed unchanged
//   20  16   target id       the member or device (zero for household)
//   36  u32  payload length
//   40  ..   payload         opaque to the service, at most the category's limit
//
// Delivery (service → receiver), the same record type:
//   0   u8   version         1
//   1   u8   category
//   2   u8   scope           how the sender addressed it
//   3   u8   reserved        0
//   4   16   correlation id
//   20  16   sender member   stamped by the service from the sender's session
//   36  16   sender device   stamped by the service from the sender's session
//   52  u32  payload length
//   56  ..   payload
// The sender's identity is never read from the request.

export const EPHEMERAL_VERSION = 1;
export const SCOPE = Object.freeze({ HOUSEHOLD: 0, MEMBER: 1, DEVICE: 2 });
export const REQUEST_HEADER_BYTES = 40;
export const DELIVERY_HEADER_BYTES = 56;
/** The most any category may carry; a category's own limit is lower or equal. */
export const MAX_EPHEMERAL_PAYLOAD = 4096;
const ID_BYTES = 16;
const ZERO_ID = "0".repeat(ID_BYTES * 2);

/**
 * Categories the service accepts. A category is
 * `{ name, maxPayload, burst, refillMs, scopes, access }`:
 * `scopes` is the list of SCOPE values it may be addressed with, `access` is
 * "write" (the sender and every receiver must be allowed to post in chat) or
 * "chat" (allowed to see chat). Empty in production.
 */
export const CATEGORIES = new Map();

export class EphemeralError extends Error {
  /** @param {"malformed"|"version"|"category"|"too_big"|"scope"} reason */
  constructor(reason) {
    super(`Bad ephemeral message: ${reason}`);
    this.name = "EphemeralError";
    this.reason = reason;
  }
}

const isId = (value) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** Reads a request. Throws EphemeralError; never returns a half-checked one. */
export function decodeRequest(bytes, categories = CATEGORIES) {
  if (bytes.length < REQUEST_HEADER_BYTES) throw new EphemeralError("malformed");
  if (bytes[0] !== EPHEMERAL_VERSION) throw new EphemeralError("version");
  const category = categories.get(bytes[1]);
  if (!category) throw new EphemeralError("category");
  const scope = bytes[2];
  if (!category.scopes.includes(scope)) throw new EphemeralError("scope");
  if (bytes[3] !== 0) throw new EphemeralError("malformed");
  const length = bytes.readUInt32LE(36);
  if (length > Math.min(category.maxPayload, MAX_EPHEMERAL_PAYLOAD)) throw new EphemeralError("too_big");
  if (bytes.length !== REQUEST_HEADER_BYTES + length) throw new EphemeralError("malformed");
  const targetId = bytes.subarray(20, 36).toString("hex");
  if (scope === SCOPE.HOUSEHOLD ? targetId !== ZERO_ID : targetId === ZERO_ID) throw new EphemeralError("malformed");
  return {
    categoryId: bytes[1], category, scope,
    correlation: Buffer.from(bytes.subarray(4, 20)),
    targetId: scope === SCOPE.HOUSEHOLD ? null : targetId,
    payload: bytes.subarray(REQUEST_HEADER_BYTES),
  };
}

/** The bytes a receiver gets, with the sender stamped by the service. */
export function encodeDelivery({ categoryId, scope, correlation, senderMemberId, senderDeviceId, payload }) {
  if (!isId(senderMemberId) || !isId(senderDeviceId)) throw new EphemeralError("malformed");
  const bytes = Buffer.alloc(DELIVERY_HEADER_BYTES + payload.length);
  bytes[0] = EPHEMERAL_VERSION;
  bytes[1] = categoryId;
  bytes[2] = scope;
  correlation.copy(bytes, 4);
  Buffer.from(senderMemberId, "hex").copy(bytes, 20);
  Buffer.from(senderDeviceId, "hex").copy(bytes, 36);
  bytes.writeUInt32LE(payload.length, 52);
  payload.copy(bytes, DELIVERY_HEADER_BYTES);
  return bytes;
}

/** Builds a request (used by tests and, later, by a client codec). */
export function encodeRequest({ category, scope, correlation, targetId = null, payload = Buffer.alloc(0) }) {
  const bytes = Buffer.alloc(REQUEST_HEADER_BYTES + payload.length);
  bytes[0] = EPHEMERAL_VERSION;
  bytes[1] = category;
  bytes[2] = scope;
  correlation.copy(bytes, 4);
  Buffer.from(targetId ?? ZERO_ID, "hex").copy(bytes, 20);
  bytes.writeUInt32LE(payload.length, 36);
  Buffer.from(payload).copy(bytes, REQUEST_HEADER_BYTES);
  return bytes;
}
