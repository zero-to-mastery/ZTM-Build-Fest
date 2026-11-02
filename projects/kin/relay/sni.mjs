// The connection relay's ClientHello reader (ADR 0025 §4, #729). It finds
// the server name (SNI) a phone asked for and nothing else: the relay
// routes on it and splices the bytes, still encrypted, into the home
// server's tunnel. A small pure function with fixed bounds; relay/sni.test.mjs
// checks it with byte-built ClientHellos and a fuzz run.
//
// Bounds (§4): at most 16 KiB read from the connection, in at most 4 TLS
// records (the 10-second limit is the caller's timer). Every length is checked
// against the bytes that remain; only extension type 0 (server_name) is
// interpreted, every other extension is skipped by its length unread. That
// includes encrypted_client_hello (0xfe0d): GREASE ECH carries the real name
// as its outer SNI, and real ECH carries the public name of an ECH
// configuration, which the relay's DNS never publishes and so never routes
// (relay/README.md, "ECH").
import { isHostName } from "./ktun.mjs";

export const MAX_HELLO_BYTES = 16_384;
export const MAX_HELLO_RECORDS = 4;
export const HELLO_TIMEOUT_MS = 10_000;

const RECORD_HEADER = 5;
const HANDSHAKE = 22;
const CLIENT_HELLO = 1;
const SERVER_NAME = 0;
const HOST_NAME = 0;

/** Why a hello is refused. "unrouted" is the caller's (a good hello for a
 * name it doesn't route); the parser gives the others. */
export const Refusal = Object.freeze({
  NOT_TLS: "not-tls",
  SSL2: "ssl2",
  MALFORMED: "malformed",
  TOO_LARGE: "too-large",
  TOO_MANY_RECORDS: "too-many-records",
  NO_SNI: "no-sni",
});

const more = Object.freeze({ state: "more" });
const refuse = (reason) => ({ state: "refuse", reason });

/**
 * Reads the ClientHello at the start of `bytes` (everything received so far
 * on the connection, at most MAX_HELLO_BYTES). Returns
 *
 * - `{ state: "more" }`: incomplete; read more (if the bounds allow);
 * - `{ state: "name", name }`: a well-formed hello for `name` (lowercase);
 * - `{ state: "refuse", reason }`: close without a reply (a Refusal value).
 *
 * The bytes are never changed; after "name" the caller forwards all of them
 * exactly as received.
 */
export function readClientHello(bytes) {
  if (bytes.length === 0) return more;
  // An SSL 2.0-style hello starts with a two-byte length whose high bit is set.
  if (bytes[0] & 0x80) return refuse(Refusal.SSL2);
  if (bytes[0] !== HANDSHAKE) return refuse(Refusal.NOT_TLS);

  // Walk the records, gathering the handshake bytes they carry. A
  // ClientHello's length is known after the first 4 handshake bytes.
  const fragments = [];
  let gathered = 0;
  let needed = -1;
  let offset = 0;
  let records = 0;
  while (needed < 0 || gathered < needed) {
    if (records === MAX_HELLO_RECORDS) return refuse(Refusal.TOO_MANY_RECORDS);
    if (bytes.length - offset < RECORD_HEADER) return bytes.length >= MAX_HELLO_BYTES ? refuse(Refusal.TOO_LARGE) : more;
    const type = bytes[offset];
    const major = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 3);
    if (type !== HANDSHAKE || major !== 3 || length < 1 || length > 16_384) return refuse(Refusal.MALFORMED);
    if (offset + RECORD_HEADER + length > MAX_HELLO_BYTES) return refuse(Refusal.TOO_LARGE);
    records += 1;
    if (bytes.length < offset + RECORD_HEADER + length) return more;
    const fragment = bytes.subarray(offset + RECORD_HEADER, offset + RECORD_HEADER + length);
    fragments.push(fragment);
    gathered += fragment.length;
    offset += RECORD_HEADER + length;
    if (needed < 0 && gathered >= 4) {
      const head = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
      if (head[0] !== CLIENT_HELLO) return refuse(Refusal.MALFORMED);
      const messageLength = (head[1] << 16) | (head[2] << 8) | head[3];
      // The whole message, with its 4-byte header and at least one record
      // header, must fit in the read bound.
      if (messageLength + 4 + RECORD_HEADER > MAX_HELLO_BYTES) return refuse(Refusal.TOO_LARGE);
      needed = messageLength + 4;
    }
  }
  // The ClientHello is alone in its records: nothing may follow it there.
  if (gathered !== needed) return refuse(Refusal.MALFORMED);
  const message = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
  return parseClientHelloBody(message.subarray(4));
}

/** Parses a ClientHello body (after the 4-byte handshake header). */
export function parseClientHelloBody(body) {
  let at = 0;
  const left = () => body.length - at;
  // legacy_version (2) and random (32).
  if (left() < 34) return refuse(Refusal.MALFORMED);
  at += 34;
  // legacy_session_id: 0–32 bytes.
  if (left() < 1) return refuse(Refusal.MALFORMED);
  const sessionLength = body[at];
  at += 1;
  if (sessionLength > 32 || left() < sessionLength) return refuse(Refusal.MALFORMED);
  at += sessionLength;
  // cipher_suites: an even number of bytes, at least 2.
  if (left() < 2) return refuse(Refusal.MALFORMED);
  const suitesLength = body.readUInt16BE(at);
  at += 2;
  if (suitesLength < 2 || suitesLength % 2 !== 0 || left() < suitesLength) return refuse(Refusal.MALFORMED);
  at += suitesLength;
  // legacy_compression_methods: at least 1 byte.
  if (left() < 1) return refuse(Refusal.MALFORMED);
  const compressionLength = body[at];
  at += 1;
  if (compressionLength < 1 || left() < compressionLength) return refuse(Refusal.MALFORMED);
  at += compressionLength;
  // A hello with no extensions block has no SNI.
  if (left() === 0) return refuse(Refusal.NO_SNI);
  if (left() < 2) return refuse(Refusal.MALFORMED);
  const extensionsLength = body.readUInt16BE(at);
  at += 2;
  // The extensions block must end exactly at the end of the message.
  if (extensionsLength !== left()) return refuse(Refusal.MALFORMED);
  let name = null;
  while (left() > 0) {
    if (left() < 4) return refuse(Refusal.MALFORMED);
    const type = body.readUInt16BE(at);
    const length = body.readUInt16BE(at + 2);
    at += 4;
    if (left() < length) return refuse(Refusal.MALFORMED);
    if (type === SERVER_NAME) {
      if (name !== null) return refuse(Refusal.MALFORMED);
      name = parseServerName(body.subarray(at, at + length));
      if (name === null) return refuse(Refusal.MALFORMED);
    }
    at += length;
  }
  return name === null ? refuse(Refusal.NO_SNI) : { state: "name", name };
}

/** The server_name extension's data: exactly one entry, of type host_name,
 * 1 to 253 bytes of LDH labels with no trailing dot. Lowercased; null when
 * anything is wrong. */
function parseServerName(data) {
  if (data.length < 2 || data.readUInt16BE(0) !== data.length - 2) return null;
  if (data.length < 5 || data[2] !== HOST_NAME) return null;
  const length = data.readUInt16BE(3);
  if (length < 1 || length > 253 || data.length !== 5 + length) return null;
  // ASCII letters only are folded, so a non-ASCII byte can't fold into one.
  let text = "";
  for (let index = 5; index < data.length; index += 1) {
    const byte = data[index];
    text += String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte);
  }
  return isHostName(text) ? text : null;
}

/** A TLS fatal alert record: unrecognized_name (112), sent for a
 * well-formed hello whose name isn't routed (§4). */
export const UNRECOGNIZED_NAME_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70]);
