// RFC 6455 WebSocket protocol, written on node:crypto and Buffers (#107).
// Node 24 ships a WebSocket client but no server, and Kin takes no npm
// packages, so the handshake, framing and close handling live here. This
// module is pure: it parses and builds bytes and knows nothing about sockets,
// sessions or households (live-service.mjs does).
//
// What Kin accepts, deliberately narrower than the RFC allows:
// - Binary messages only. A text frame closes the connection with 1003.
// - No extensions (RSV bits must be zero, permessage-deflate is never
//   offered) and no subprotocols.
// - Every client frame must be masked (RFC 6455 §5.1); an unmasked frame
//   closes with 1002.
// - A message, reassembled from its fragments, is at most `maxMessage` bytes
//   (256 KiB by default) in at most 128 frames; more closes with 1009 before
//   the bytes arrive.
//
// Inside each binary message Kin carries one record:
//   [u8 type][u8 flags][u16 reserved = 0][u32 length][length bytes payload]
// little-endian, parsed as a view over the message buffer (no copy).
import { createHash } from "node:crypto";

/** The GUID every server appends to the client's key (RFC 6455 §1.3). */
export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_MESSAGE_BYTES = 256 * 1024;
/** Most frames one message may be split into. Empty fragments cost memory
 * without adding bytes, so the byte cap alone doesn't bound them. */
export const MAX_FRAGMENTS = 128;
export const KIN_HEADER_BYTES = 8;

export const OPCODE = Object.freeze({ CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });

/** Close codes Kin sends. 4xxx are Kin's own (RFC 6455 §7.4.2). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_DATA: 1007,
  POLICY: 1008,
  TOO_BIG: 1009,
  SERVER_ERROR: 1011,
  /** The session ended (signed out or expired): sign in again. */
  SESSION_ENDED: 4401,
  /** The device, member or household no longer has access. */
  ACCESS_LOST: 4403,
  /** Another connection from the same device replaced this one. */
  REPLACED: 4409,
  /** The client stopped reading; it should fall back to HTTP pull. */
  SLOW_CONSUMER: 4429,
});

const utf8 = new TextDecoder("utf-8", { fatal: true });
const EMPTY = Buffer.alloc(0);
/** Returned by FrameParser.next for a non-final fragment. */
const FRAGMENT = Symbol("fragment");

/** Sec-WebSocket-Accept for a client's Sec-WebSocket-Key. */
export function acceptKey(key) {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

/** Whether `key` is a valid Sec-WebSocket-Key: base64 of exactly 16 bytes. */
export function isClientKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, "base64").length === 16;
}

/** Whether a close code may appear on the wire (RFC 6455 §7.4). */
export function isValidCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

/**
 * A streaming frame parser for one connection. Feed it the socket's chunks as
 * they arrive; it returns the events those bytes completed:
 *   { type: "message", data }      a whole binary message (a Buffer)
 *   { type: "ping", data } / { type: "pong", data }
 *   { type: "close", code, reason } the peer's close (code 1005 if none)
 *   { type: "error", code, reason } a protocol violation; the caller closes
 *                                   with `code`, and the parser stops.
 * Header parsing is a small state machine over a fixed scratch; payloads are
 * unmasked in place in the buffer they arrived in, so feed() takes ownership
 * of each chunk (a socket's chunks are read by nothing else).
 */
export class FrameParser {
  constructor({ maxMessage = MAX_MESSAGE_BYTES, maxFragments = MAX_FRAGMENTS } = {}) {
    this.maxMessage = maxMessage;
    this.maxFragments = maxFragments;
    this.pending = [];        // unparsed chunks
    this.pendingBytes = 0;
    this.fragments = [];      // payloads of the message being reassembled
    this.fragmentBytes = 0;
    this.inMessage = false;
    this.failed = false;
  }

  /** Takes `count` bytes off the front of the pending chunks, as one Buffer
   * (a view when they sit in one chunk, a copy only across chunk edges). */
  take(count) {
    const first = this.pending[0];
    if (first.length >= count) {
      const out = first.subarray(0, count);
      if (first.length === count) this.pending.shift();
      else this.pending[0] = first.subarray(count);
      this.pendingBytes -= count;
      return out;
    }
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.pending[0];
      const used = Math.min(chunk.length, count - filled);
      chunk.copy(out, filled, 0, used);
      filled += used;
      if (used === chunk.length) this.pending.shift();
      else this.pending[0] = chunk.subarray(used);
    }
    this.pendingBytes -= count;
    return out;
  }

  /** Reads `count` header bytes without consuming them, or null. */
  peek(count) {
    if (this.pendingBytes < count) return null;
    const first = this.pending[0];
    if (first.length >= count) return first;
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    for (const chunk of this.pending) {
      const used = Math.min(chunk.length, count - filled);
      chunk.copy(out, filled, 0, used);
      filled += used;
      if (filled === count) break;
    }
    return out;
  }

  fail(code, reason) {
    this.failed = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.fragments = [];
    return { type: "error", code, reason };
  }

  feed(chunk) {
    const events = [];
    if (this.failed) return events;
    if (chunk.length) {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    }
    // A loop, never recursion: a client can send any number of frames in
    // one chunk.
    for (;;) {
      const event = this.next();
      if (event === null) break;
      if (event === FRAGMENT) continue;
      events.push(event);
      if (event.type === "error") break;
    }
    return events;
  }

  /** One frame, if all of it has arrived: its event, FRAGMENT for a non-final
   * part of a message, or null when more bytes are needed. */
  next() {
    const head = this.peek(2);
    if (!head) return null;
    const fin = (head[0] & 0x80) !== 0;
    const rsv = head[0] & 0x70;
    const opcode = head[0] & 0x0f;
    const masked = (head[1] & 0x80) !== 0;
    const short = head[1] & 0x7f;
    if (rsv) return this.fail(CLOSE.PROTOCOL_ERROR, "Extensions are not supported.");
    if (!masked) return this.fail(CLOSE.PROTOCOL_ERROR, "Client frames must be masked.");
    const control = opcode >= 0x8;
    if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) return this.fail(CLOSE.PROTOCOL_ERROR, "Unknown opcode.");
    if (control && (!fin || short > 125)) return this.fail(CLOSE.PROTOCOL_ERROR, "Invalid control frame.");
    const extra = short === 126 ? 2 : short === 127 ? 8 : 0;
    const headerBytes = 2 + extra + 4;
    const header = this.peek(headerBytes);
    let length = short;
    if (extra === 2) {
      if (this.pendingBytes < 4) return null;
      length = (header ?? this.peek(4)).readUInt16BE(2);
      if (length < 126) return this.fail(CLOSE.PROTOCOL_ERROR, "Length not minimally encoded.");
    } else if (extra === 8) {
      if (this.pendingBytes < 10) return null;
      const view = header ?? this.peek(10);
      if (view.readUInt32BE(2) !== 0) return this.fail(CLOSE.TOO_BIG, "Message too large.");
      length = view.readUInt32BE(6);
      if (length < 65536) return this.fail(CLOSE.PROTOCOL_ERROR, "Length not minimally encoded.");
    }
    // Refuse an oversized message as soon as its header says so.
    if (!control && (this.inMessage ? this.fragmentBytes : 0) + length > this.maxMessage)
      return this.fail(CLOSE.TOO_BIG, "Message too large.");
    if (!control && this.inMessage && this.fragments.length >= this.maxFragments)
      return this.fail(CLOSE.TOO_BIG, "Message in too many fragments.");
    if (this.pendingBytes < headerBytes + length) return null;
    const frameHeader = this.take(headerBytes);
    const mask = frameHeader.subarray(headerBytes - 4, headerBytes);
    // Unmasked in place: the payload is a view of only its own bytes in a
    // chunk the socket handed over and nothing else reads.
    const data = length ? this.take(length) : EMPTY;
    for (let index = 0; index < data.length; index += 1) data[index] ^= mask[index & 3];

    if (opcode === OPCODE.PING) return { type: "ping", data };
    if (opcode === OPCODE.PONG) return { type: "pong", data };
    if (opcode === OPCODE.CLOSE) {
      if (data.length === 0) return { type: "close", code: 1005, reason: "" };
      if (data.length === 1) return this.fail(CLOSE.PROTOCOL_ERROR, "Invalid close frame.");
      const code = data.readUInt16BE(0);
      if (!isValidCloseCode(code)) return this.fail(CLOSE.PROTOCOL_ERROR, "Invalid close code.");
      let reason;
      try {
        reason = utf8.decode(data.subarray(2));
      } catch {
        return this.fail(CLOSE.INVALID_DATA, "Invalid close reason.");
      }
      return { type: "close", code, reason };
    }
    if (opcode === OPCODE.TEXT) return this.fail(CLOSE.UNSUPPORTED_DATA, "Kin uses binary messages only.");
    if (opcode === OPCODE.CONTINUATION) {
      if (!this.inMessage) return this.fail(CLOSE.PROTOCOL_ERROR, "Continuation without a message.");
    } else if (this.inMessage) {
      return this.fail(CLOSE.PROTOCOL_ERROR, "A new message began before the last ended.");
    } else {
      this.inMessage = true;
      this.fragments = [];
      this.fragmentBytes = 0;
    }
    this.fragments.push(data);
    this.fragmentBytes += data.length;
    if (!fin) return FRAGMENT;
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentBytes);
    this.inMessage = false;
    this.fragments = [];
    this.fragmentBytes = 0;
    return { type: "message", data: message };
  }
}

/** A server frame (servers never mask, RFC 6455 §5.1). */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true } = {}) {
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.allocUnsafe(2 + extra);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (extra === 0) header[1] = length;
  else if (extra === 2) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  return length ? Buffer.concat([header, payload], header.length + length) : header;
}

/** A close frame's payload: the code and an optional short UTF-8 reason. */
export function closePayload(code, reason = "") {
  const text = Buffer.from(reason, "utf8").subarray(0, 123);
  const out = Buffer.allocUnsafe(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

/** One Kin record: [u8 type][u8 flags][u16 reserved][u32 length][payload]. */
export function encodeMessage(type, payload = Buffer.alloc(0), flags = 0) {
  const out = Buffer.allocUnsafe(KIN_HEADER_BYTES + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt8(flags, 1);
  out.writeUInt16LE(0, 2);
  out.writeUInt32LE(payload.length, 4);
  payload.copy?.(out, KIN_HEADER_BYTES) ?? Buffer.from(payload).copy(out, KIN_HEADER_BYTES);
  return out;
}

/** The Kin record in a message, or null when it is malformed: a short
 * header, non-zero reserved bits, or a length that doesn't match exactly.
 * The payload is a view over `message`. */
export function parseMessage(message) {
  if (!Buffer.isBuffer(message) || message.length < KIN_HEADER_BYTES) return null;
  if (message.readUInt16LE(2) !== 0) return null;
  const length = message.readUInt32LE(4);
  if (length !== message.length - KIN_HEADER_BYTES) return null;
  return { type: message[0], flags: message[1], payload: message.subarray(KIN_HEADER_BYTES) };
}
