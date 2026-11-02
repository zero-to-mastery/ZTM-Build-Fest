// KTUN version 1: the tunnel between a home server and a connection relay
// (ADR 0025 §2, #730). A pure codec: it builds and checks bytes and does the
// credit arithmetic, and never touches a socket, a timer or a file. The relay
// (relay/tunnel.mjs) and the home server's tunnel client (#733) both import
// it, so nothing relay-only belongs here.
//
// Byte layout (all integers little-endian):
//
//   Preface (home server → relay, once):  "KTUN" version:u16 flags:u16
//   Frame (both ways):  type:u8 flags:u8 reserved:u16 stream:u32 length:u32
//                       payload:length          (header 12, payload ≤ 16,384)
//
// docs/TEST-VECTORS.md "KTUN v1 tunnel frames" pins exact bytes for every
// frame type; relay/ktun.test.mjs checks them.
import { createHash, createPublicKey, sign, verify } from "node:crypto";

export const PREFACE_MAGIC = Buffer.from("KTUN", "ascii");
export const PREFACE_LENGTH = 8;
export const VERSION = 1;
export const ALPN = "kin-tunnel/1";
/** RFC 8446 §7.5 exporter label for the sign-in signature; no context. */
export const EXPORTER_LABEL = "EXPORTER-kin-tunnel-auth";
export const EXPORTER_LENGTH = 32;
export const NONCE_LENGTH = 32;
export const HEADER_LENGTH = 12;
export const MAX_PAYLOAD = 16_384;
export const MAX_U32 = 0xffff_ffff;
/** Stream numbers stay below 2³¹; near it the relay sends GOAWAY (§2). */
export const STREAM_LIMIT = 0x7fff_ffff;

export const FrameType = Object.freeze({
  HELLO: 1, AUTH: 2, READY: 3, OPEN: 4, DATA: 5, WINDOW: 6, RESET: 7, PING: 8, GOAWAY: 9, CONTROL: 10,
});
export const FRAME_NAMES = Object.freeze(Object.fromEntries(Object.entries(FrameType).map(([name, type]) => [type, name])));

/** DATA flag bit 0 is FIN; PING flag bit 0 is ACK. No other flag bit exists. */
export const FLAG_FIN = 1;
export const FLAG_ACK = 1;

/** Codes for RESET, GOAWAY and CONTROL status (§2). */
export const Code = Object.freeze({
  NONE: 0,
  PROTOCOL_ERROR: 1,
  AUTH_FAILED: 2,
  REPLACED: 3,
  LIMIT: 4,
  SUSPENDED: 5,
  UNKNOWN_NAME: 6,
  OVERLOADED: 7,
  SHUTTING_DOWN: 8,
  NAME_TAKEN: 9,
  NAME_NOT_ALLOWED: 10,
});

/** CONTROL operations (§3). 7 `CHECK` (#719) asks, without binding
 * anything, whether this key could have a name: the control panel's live
 * availability check during setup. A relay that predates it answers status
 * 1, which the home server reads as "can't check; the claim will tell". */
export const ControlOp = Object.freeze({
  CLAIM: 1, RELEASE: 2, SET_CAA: 3, ADD_DOMAIN: 4, REMOVE_DOMAIN: 5, TRANSFER: 6, CHECK: 7,
});

/** HELLO defaults (§2, §4): 256 open connections per name, 256 KiB per
 * stream, 4 MiB per tunnel, PING after 25 s of silence, dead after 75 s. */
export const DEFAULT_HELLO = Object.freeze({
  maxStreams: 256,
  streamWindow: 256 * 1024,
  connectionWindow: 4 * 1024 * 1024,
  pingSeconds: 25,
  idleSeconds: 75,
});

/** The longest host name in an OPEN or a name list (RFC 1035 text form). */
export const MAX_NAME_LENGTH = 253;
/** The longest CAA account URI SET_CAA accepts. */
export const MAX_ACCOUNT_URI_LENGTH = 512;

/** A protocol violation. `code` is the KTUN code the receiver sends in its
 * GOAWAY (always PROTOCOL_ERROR for framing faults). */
export class KtunError extends Error {
  constructor(message, code = Code.PROTOCOL_ERROR) {
    super(message);
    this.name = "KtunError";
    this.code = code;
  }
}

const fail = (message) => { throw new KtunError(message); };

// ---------------------------------------------------------------- preface

export function encodePreface(version = VERSION, flags = 0) {
  const bytes = Buffer.alloc(PREFACE_LENGTH);
  PREFACE_MAGIC.copy(bytes, 0);
  bytes.writeUInt16LE(version, 4);
  bytes.writeUInt16LE(flags, 6);
  return bytes;
}

/** Checks the 8-byte preface. A relay refuses a version it doesn't speak and
 * a preface whose flags aren't zero. */
export function decodePreface(bytes) {
  if (bytes.length !== PREFACE_LENGTH) fail("preface must be 8 bytes");
  if (!bytes.subarray(0, 4).equals(PREFACE_MAGIC)) fail("preface magic is not KTUN");
  const version = bytes.readUInt16LE(4);
  const flags = bytes.readUInt16LE(6);
  if (version !== VERSION) fail(`KTUN version ${version} is not spoken here`);
  if (flags !== 0) fail("preface flags must be zero");
  return { version, flags };
}

// ----------------------------------------------------------------- frames

/** One frame's bytes: the 12-byte header followed by `payload`. */
export function encodeFrame(type, flags, stream, payload = EMPTY) {
  if (payload.length > MAX_PAYLOAD) throw new RangeError(`KTUN payload ${payload.length} is over ${MAX_PAYLOAD}`);
  const bytes = Buffer.allocUnsafe(HEADER_LENGTH + payload.length);
  bytes[0] = type;
  bytes[1] = flags;
  bytes.writeUInt16LE(0, 2);
  bytes.writeUInt32LE(stream >>> 0, 4);
  bytes.writeUInt32LE(payload.length, 8);
  if (payload.length) bytes.set(payload, HEADER_LENGTH);
  return bytes;
}
const EMPTY = Buffer.alloc(0);

/** Fixed payload lengths; READY, OPEN, DATA and CONTROL vary. */
const FIXED_LENGTH = { 1: 52, 2: 104, 6: 4, 7: 4, 8: 8, 9: 8 };
/** Who may send each type: "relay", "home" or "both" (§2 table). */
const DIRECTION = { 1: "relay", 2: "home", 3: "relay", 4: "relay", 5: "both", 6: "both", 7: "both", 8: "both", 9: "both", 10: "both" };
/** Stream rule: 0 = must be 0, 1 = must be ≥ 1, 2 = either. */
const STREAM_RULE = { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 2, 7: 1, 8: 0, 9: 0, 10: 0 };
/** Flag bits each type defines. */
const ALLOWED_FLAGS = { 5: FLAG_FIN, 8: FLAG_ACK };

/**
 * Checks one frame header (and fixed-size payload lengths) before anything
 * acts on it (§2): an unknown type, a flag bit the type doesn't define, a
 * reserved field that isn't zero, a stream number wrong for the type, a type
 * sent in the wrong direction, a payload over 16,384 or of the wrong fixed
 * length is a protocol error. `sender` is "relay" or "home".
 */
export function checkHeader({ type, flags, reserved, stream, length }, sender) {
  if (!(type in DIRECTION)) fail(`unknown frame type ${type}`);
  if (reserved !== 0) fail("frame reserved field is not zero");
  if (length > MAX_PAYLOAD) fail(`frame payload ${length} is over ${MAX_PAYLOAD}`);
  if ((flags & ~(ALLOWED_FLAGS[type] ?? 0)) !== 0) fail(`flag bits ${flags} are not defined for ${FRAME_NAMES[type]}`);
  const direction = DIRECTION[type];
  if (sender && direction !== "both" && direction !== sender) fail(`${FRAME_NAMES[type]} may not be sent by the ${sender}`);
  const rule = STREAM_RULE[type];
  if (rule === 0 && stream !== 0) fail(`${FRAME_NAMES[type]} must be on stream 0`);
  if (rule === 1 && stream === 0) fail(`${FRAME_NAMES[type]} must be on a stream`);
  if (stream > STREAM_LIMIT) fail("stream number is 2³¹ or more");
  const fixed = FIXED_LENGTH[type];
  if (fixed !== undefined && length !== fixed) fail(`${FRAME_NAMES[type]} payload must be ${fixed} bytes`);
}

/**
 * Splits a byte stream into checked frames. Bytes are pushed as they
 * arrive; complete frames come back with `payload` as a view into the
 * pushed bytes (no copy when a frame lies inside one chunk). At most one
 * partial frame is held, so the reader never keeps more than
 * 12 + 16,384 bytes beyond the chunk being pushed.
 */
export class FrameReader {
  #pending = null;
  #sender;
  constructor(sender) { this.#sender = sender; }

  /** Bytes held for an incomplete frame. */
  get buffered() { return this.#pending?.length ?? 0; }

  /** Returns the complete frames in `chunk` (plus any held bytes). Throws a
   * KtunError on the first bad header; nothing after it is returned. */
  push(chunk) {
    let bytes = this.#pending ? Buffer.concat([this.#pending, chunk]) : chunk;
    this.#pending = null;
    const frames = [];
    let offset = 0;
    while (bytes.length - offset >= HEADER_LENGTH) {
      const header = {
        type: bytes[offset],
        flags: bytes[offset + 1],
        reserved: bytes.readUInt16LE(offset + 2),
        stream: bytes.readUInt32LE(offset + 4),
        length: bytes.readUInt32LE(offset + 8),
      };
      checkHeader(header, this.#sender);
      const end = offset + HEADER_LENGTH + header.length;
      if (end > bytes.length) break;
      header.payload = bytes.subarray(offset + HEADER_LENGTH, end);
      delete header.reserved;
      frames.push(header);
      offset = end;
    }
    if (offset < bytes.length) this.#pending = bytes.subarray(offset);
    return frames;
  }
}

// --------------------------------------------------------------- payloads

/** A lowercase host name in text form: 1 to 253 bytes of LDH labels (1 to
 * 63 letters, digits and hyphens, not starting or ending with a hyphen)
 * separated by dots, with no trailing dot. Every name KTUN carries is one. */
export function isHostName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_NAME_LENGTH) return false;
  for (const label of name.split(".")) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return false;
  return true;
}

function ascii(name, what) {
  if (!isHostName(name)) throw new RangeError(`${what} must be a lowercase host name`);
  return Buffer.from(name, "latin1");
}

/** HELLO (relay → home): nonce:32 maxStreams:u32 streamWindow:u32
 * connectionWindow:u32 pingSeconds:u16 idleSeconds:u16 reserved:u32. */
export function encodeHello({ nonce, maxStreams, streamWindow, connectionWindow, pingSeconds, idleSeconds }) {
  if (nonce.length !== NONCE_LENGTH) throw new RangeError("HELLO nonce must be 32 bytes");
  const payload = Buffer.alloc(52);
  payload.set(nonce, 0);
  payload.writeUInt32LE(maxStreams, 32);
  payload.writeUInt32LE(streamWindow, 36);
  payload.writeUInt32LE(connectionWindow, 40);
  payload.writeUInt16LE(pingSeconds, 44);
  payload.writeUInt16LE(idleSeconds, 46);
  return encodeFrame(FrameType.HELLO, 0, 0, payload);
}

export function decodeHello(payload) {
  if (payload.readUInt32LE(48) !== 0) fail("HELLO reserved field is not zero");
  const hello = {
    nonce: payload.subarray(0, 32),
    maxStreams: payload.readUInt32LE(32),
    streamWindow: payload.readUInt32LE(36),
    connectionWindow: payload.readUInt32LE(40),
    pingSeconds: payload.readUInt16LE(44),
    idleSeconds: payload.readUInt16LE(46),
  };
  // A window under one full DATA payload could never carry a frame, and a
  // dead-tunnel timeout no longer than the ping interval would fire before
  // the ping could be answered.
  if (hello.maxStreams < 1) fail("HELLO maxStreams must be at least 1");
  if (hello.streamWindow < MAX_PAYLOAD || hello.connectionWindow < MAX_PAYLOAD) fail("HELLO windows must be at least 16,384");
  if (hello.pingSeconds < 1 || hello.idleSeconds <= hello.pingSeconds) fail("HELLO idleSeconds must exceed pingSeconds ≥ 1");
  return hello;
}

/** AUTH (home → relay): publicKey:32 signature:64 softwareVersion:u32 reserved:u32. */
export function encodeAuth({ publicKey, signature, softwareVersion = 0 }) {
  if (publicKey.length !== 32 || signature.length !== 64) throw new RangeError("AUTH needs a 32-byte key and a 64-byte signature");
  const payload = Buffer.alloc(104);
  payload.set(publicKey, 0);
  payload.set(signature, 32);
  payload.writeUInt32LE(softwareVersion, 96);
  return encodeFrame(FrameType.AUTH, 0, 0, payload);
}

export function decodeAuth(payload) {
  if (payload.readUInt32LE(100) !== 0) fail("AUTH reserved field is not zero");
  return { publicKey: payload.subarray(0, 32), signature: payload.subarray(32, 96), softwareVersion: payload.readUInt32LE(96) };
}

/** A name list: count:u16 reserved:u16, then count × (nameLength:u8 name).
 * READY's payload, and a successful CONTROL answer's body. */
export function encodeNameList(names) {
  const parts = names.map((name) => ascii(name, "a name"));
  const payload = Buffer.alloc(4 + parts.reduce((sum, part) => sum + 1 + part.length, 0));
  payload.writeUInt16LE(parts.length, 0);
  let offset = 4;
  for (const part of parts) { payload[offset] = part.length; part.copy(payload, offset + 1); offset += 1 + part.length; }
  if (payload.length > MAX_PAYLOAD) throw new RangeError("name list is over 16,384 bytes");
  return payload;
}

export function decodeNameList(payload) {
  if (payload.length < 4) fail("name list is shorter than its header");
  const count = payload.readUInt16LE(0);
  if (payload.readUInt16LE(2) !== 0) fail("name list reserved field is not zero");
  const names = [];
  let offset = 4;
  for (let index = 0; index < count; index += 1) {
    if (offset >= payload.length) fail("name list ends early");
    const length = payload[offset];
    if (length < 1 || offset + 1 + length > payload.length) fail("name list entry length is wrong");
    const name = payload.toString("latin1", offset + 1, offset + 1 + length);
    if (!isHostName(name)) fail("name list entry is not a lowercase host name");
    names.push(name);
    offset += 1 + length;
  }
  if (offset !== payload.length) fail("name list has bytes after its last entry");
  return names;
}

export const encodeReady = (names) => encodeFrame(FrameType.READY, 0, 0, encodeNameList(names));
export const decodeReady = decodeNameList;

/** The 16-byte address field: IPv4 fills the first 4 bytes, the rest zero. */
export function addressBytes(address) {
  const bytes = Buffer.alloc(16);
  if (address.includes(":")) {
    const value = address.replace(/^\[|\]$/g, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
    if (mapped) return { family: 4, bytes: addressBytes(mapped[1]).bytes };
    const [head, tail = null] = value.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) throw new RangeError("not an IPv6 address");
    groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
    return { family: 6, bytes };
  }
  const octets = address.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) throw new RangeError("not an IPv4 address");
  octets.forEach((octet, index) => { bytes[index] = Number(octet); });
  return { family: 4, bytes };
}

/** Text form of an OPEN address (IPv6 without zero compression). */
export function addressText(family, bytes) {
  if (family === 4) return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

/** OPEN (relay → home, stream n): family:u8 nameLength:u8 reserved:u16
 * address:16 name:nameLength. The name is the phone's SNI, lowercase. */
export function encodeOpen(stream, { name, address }) {
  const nameBytes = ascii(name, "OPEN name");
  const { family, bytes } = addressBytes(address);
  const payload = Buffer.alloc(20 + nameBytes.length);
  payload[0] = family;
  payload[1] = nameBytes.length;
  payload.set(bytes, 4);
  nameBytes.copy(payload, 20);
  return encodeFrame(FrameType.OPEN, 0, stream, payload);
}

export function decodeOpen(payload) {
  if (payload.length < 21) fail("OPEN is shorter than its fixed part and a name");
  const family = payload[0];
  const nameLength = payload[1];
  if (family !== 4 && family !== 6) fail("OPEN family must be 4 or 6");
  if (payload.readUInt16LE(2) !== 0) fail("OPEN reserved field is not zero");
  if (nameLength < 1 || payload.length !== 20 + nameLength) fail("OPEN name length is wrong");
  const address = payload.subarray(4, 20);
  if (family === 4 && address.subarray(4).some((byte) => byte !== 0)) fail("OPEN IPv4 address has bytes after the first 4");
  const name = payload.toString("latin1", 20);
  if (!isHostName(name)) fail("OPEN name is not a lowercase host name");
  return { family, address: addressText(family, address), name };
}

export const encodeData = (stream, bytes, fin = false) => encodeFrame(FrameType.DATA, fin ? FLAG_FIN : 0, stream, bytes);

function u32Payload(value) { const payload = Buffer.alloc(4); payload.writeUInt32LE(value >>> 0, 0); return payload; }

/** WINDOW: increment:u32, at least 1 (a zero grant means nothing and is
 * refused as a protocol error, as in HTTP/2). */
export function encodeWindow(stream, increment) {
  if (!Number.isInteger(increment) || increment < 1 || increment > MAX_U32) throw new RangeError("WINDOW increment must be 1 to 2³²−1");
  return encodeFrame(FrameType.WINDOW, 0, stream, u32Payload(increment));
}
export function decodeWindow(payload) {
  const increment = payload.readUInt32LE(0);
  if (increment === 0) fail("WINDOW increment is zero");
  return increment;
}

export const encodeReset = (stream, code) => encodeFrame(FrameType.RESET, 0, stream, u32Payload(code));
export const decodeReset = (payload) => payload.readUInt32LE(0);

export function encodePing(opaque, ack = false) {
  if (opaque.length !== 8) throw new RangeError("PING opaque data must be 8 bytes");
  return encodeFrame(FrameType.PING, ack ? FLAG_ACK : 0, 0, opaque);
}

export function encodeGoaway(lastStream, code) {
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(lastStream >>> 0, 0);
  payload.writeUInt32LE(code >>> 0, 4);
  return encodeFrame(FrameType.GOAWAY, 0, 0, payload);
}
export const decodeGoaway = (payload) => ({ lastStream: payload.readUInt32LE(0), code: payload.readUInt32LE(4) });

/** CONTROL (stream 0): requestId:u32 op:u8 status:u8 bodyLength:u16 body.
 * The home server sends requests (status 0); the relay answers each with
 * the same requestId and op, a status code, and on success the name list
 * now routed to the tunnel. */
export function encodeControl({ requestId, op, status = 0, body = EMPTY }) {
  if (body.length > MAX_PAYLOAD - 8) throw new RangeError("CONTROL body is too long");
  const payload = Buffer.alloc(8 + body.length);
  payload.writeUInt32LE(requestId >>> 0, 0);
  payload[4] = op;
  payload[5] = status;
  payload.writeUInt16LE(body.length, 6);
  payload.set(body, 8);
  return encodeFrame(FrameType.CONTROL, 0, 0, payload);
}

export function decodeControl(payload) {
  if (payload.length < 8) fail("CONTROL is shorter than its header");
  const bodyLength = payload.readUInt16LE(6);
  if (payload.length !== 8 + bodyLength) fail("CONTROL bodyLength doesn't match the payload");
  return { requestId: payload.readUInt32LE(0), op: payload[4], status: payload[5], body: payload.subarray(8) };
}

// ------------------------------------------------------ CONTROL request bodies
//
// The ADR fixes the CONTROL header; these bodies are KTUN 1's (TEST-VECTORS):
//   CLAIM, RELEASE, ADD_DOMAIN, REMOVE_DOMAIN:  nameLength:u8 name
//   SET_CAA:   nameLength:u8 name uriLength:u16 accountUri (≤ 512 bytes)
//   TRANSFER:  nameLength:u8 name newKey:32 signature:64

export function encodeControlBody(op, { name, accountUri, newKey, signature }) {
  const nameBytes = ascii(name, "a name");
  const head = Buffer.concat([Buffer.from([nameBytes.length]), nameBytes]);
  if (op === ControlOp.SET_CAA) {
    const uri = Buffer.from(accountUri, "utf8");
    if (uri.length < 1 || uri.length > MAX_ACCOUNT_URI_LENGTH) throw new RangeError("account URI must be 1–512 bytes");
    const length = Buffer.alloc(2);
    length.writeUInt16LE(uri.length, 0);
    return Buffer.concat([head, length, uri]);
  }
  if (op === ControlOp.TRANSFER) {
    if (newKey.length !== 32 || signature.length !== 64) throw new RangeError("TRANSFER needs a 32-byte key and a 64-byte signature");
    return Buffer.concat([head, newKey, signature]);
  }
  return head;
}

/** Decodes a request body; throws KtunError (status 1) when it is malformed. */
export function decodeControlBody(op, body) {
  if (body.length < 2) fail("CONTROL body is too short");
  const nameLength = body[0];
  if (nameLength < 1 || 1 + nameLength > body.length) fail("CONTROL name length is wrong");
  const name = body.toString("latin1", 1, 1 + nameLength);
  const rest = body.subarray(1 + nameLength);
  switch (op) {
    case ControlOp.CLAIM: case ControlOp.RELEASE: case ControlOp.ADD_DOMAIN: case ControlOp.REMOVE_DOMAIN: case ControlOp.CHECK:
      if (rest.length !== 0) fail("CONTROL body has bytes after the name");
      return { name };
    case ControlOp.SET_CAA: {
      if (rest.length < 2) fail("SET_CAA has no URI length");
      const length = rest.readUInt16LE(0);
      if (length < 1 || length > MAX_ACCOUNT_URI_LENGTH || rest.length !== 2 + length) fail("SET_CAA URI length is wrong");
      const accountUri = rest.toString("utf8", 2);
      if (Buffer.byteLength(accountUri) !== length) fail("SET_CAA URI is not UTF-8");
      return { name, accountUri };
    }
    case ControlOp.TRANSFER:
      if (rest.length !== 96) fail("TRANSFER must carry a 32-byte key and a 64-byte signature");
      return { name, newKey: rest.subarray(0, 32), signature: rest.subarray(32, 96) };
    default:
      fail(`unknown CONTROL op ${op}`);
  }
}

// ------------------------------------------------------------- signatures

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** A raw 32-byte Ed25519 public key as a KeyObject. */
export function ed25519PublicKey(raw) {
  if (raw.length !== 32) throw new RangeError("an Ed25519 public key is 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
}

/** The raw 32 bytes of an Ed25519 public (or private) KeyObject. */
export function rawEd25519PublicKey(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519.length);
}

/** SHA-256 of a raw public key: what the registry keeps (§4) and, as
 * base64url, the own-domain TXT record's value (§3). */
export const keyHash = (raw) => createHash("sha256").update(raw).digest();
export const keyHashText = (raw) => keyHash(raw).toString("base64url");

/** "kin-tunnel-auth/1" 0x00 relayName 0x00 nonce(32) exporter(32). */
export function authMessage(relayName, nonce, exporter) {
  if (nonce.length !== NONCE_LENGTH || exporter.length !== EXPORTER_LENGTH) throw new RangeError("nonce and exporter are 32 bytes each");
  return Buffer.concat([Buffer.from("kin-tunnel-auth/1\0", "latin1"), Buffer.from(relayName, "latin1"), Buffer.from([0]), nonce, exporter]);
}

/** "kin-tunnel-transfer/1" 0x00 name 0x00 oldKey(32) newKey(32). */
export function transferMessage(name, oldKey, newKey) {
  return Buffer.concat([Buffer.from("kin-tunnel-transfer/1\0", "latin1"), Buffer.from(name, "latin1"), Buffer.from([0]), oldKey, newKey]);
}

export const signEd25519 = (privateKey, message) => sign(null, message, privateKey);

/** True when `signature` is `raw`'s Ed25519 signature over `message`; never
 * throws for a malformed key or signature. */
export function verifyEd25519(raw, message, signature) {
  try { return signature.length === 64 && verify(null, message, ed25519PublicKey(raw), signature); }
  catch { return false; }
}

// ------------------------------------------------------------ flow control

/**
 * The sender's side of one window (a stream's or the tunnel's). Every DATA
 * payload spends credit; WINDOW adds it. Sending past the credit is the
 * sender's protocol error, so a sender must check `available` first.
 */
export class SendWindow {
  constructor(initial) { this.available = initial; }
  /** Spends `bytes`; false (and nothing spent) when there isn't enough. */
  spend(bytes) {
    if (bytes > this.available) return false;
    this.available -= bytes;
    return true;
  }
  /** Adds a WINDOW grant. Credit past 2³²−1 is a protocol error. */
  grant(increment) {
    if (this.available + increment > MAX_U32) fail("WINDOW grant takes credit past 2³²−1");
    this.available += increment;
  }
}

/**
 * The receiver's side of one window. `receive` counts arriving DATA (more
 * than the credit given is a protocol error); `passed` counts bytes handed
 * on (to the phone's socket, or to the TLS server); `takeGrant` returns the
 * WINDOW increment to send once at least half a window has been passed on,
 * else 0 (§2).
 */
export class ReceiveWindow {
  #size;
  #unacknowledged = 0;
  constructor(size) { this.#size = size; this.remaining = size; }
  receive(bytes) {
    if (bytes > this.remaining) fail("DATA is over the credit given");
    this.remaining -= bytes;
  }
  passed(bytes) { this.#unacknowledged += bytes; }
  takeGrant(force = false) {
    if (this.#unacknowledged === 0 || (!force && this.#unacknowledged < this.#size / 2)) return 0;
    const increment = this.#unacknowledged;
    this.#unacknowledged = 0;
    this.remaining += increment;
    return increment;
  }
}
