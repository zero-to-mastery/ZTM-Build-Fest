// A small DER (X.690) writer and reader for the ACME client (#725, #726).
//
// Only what Kin's certificate signing request and the TLS-ALPN-01 challenge
// certificate need: definite-length TLVs with single-byte tags. Every writer
// returns a Buffer holding one complete TLV, so structures are built by
// nesting calls; the reader walks TLVs over the input buffer without copying
// (each `value` is a subarray of the input).
//
// Tags used (X.690 §8, X.680 §8.6):
//   0x01 BOOLEAN   0x02 INTEGER   0x03 BIT STRING   0x04 OCTET STRING
//   0x05 NULL      0x06 OBJECT IDENTIFIER            0x0c UTF8String
//   0x13 PrintableString         0x16 IA5String      0x17 UTCTime
//   0x18 GeneralizedTime         0x30 SEQUENCE       0x31 SET
//   0xa0 + n  [n] constructed, context-specific      0x80 + n  [n] primitive

/** The DER length octets for `length`: short form below 128, otherwise
 * 0x80 | count followed by the big-endian length in `count` bytes. */
export function encodeLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("DER length must be a non-negative integer");
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV: `tag`, then the length, then the concatenated `parts`. */
export function tlv(tag, ...parts) {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xfe || (tag & 0x1f) === 0x1f) throw new RangeError("only single-byte DER tags are supported");
  const content = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const sequence = (...items) => tlv(0x30, ...items);
export const set = (...items) => tlv(0x31, ...items);
export const nullValue = () => Buffer.from([0x05, 0x00]);
export const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
export const octetString = (bytes) => tlv(0x04, bytes);
export const utf8String = (text) => tlv(0x0c, Buffer.from(String(text), "utf8"));
/** IA5String (ASCII); used for dNSName in subjectAltName. */
export function ia5String(text) {
  const value = String(text);
  if (!/^[\x00-\x7f]*$/.test(value)) throw new RangeError("IA5String must be ASCII");
  return tlv(0x16, Buffer.from(value, "ascii"));
}

/** BIT STRING with `unusedBits` (0–7) padding bits in the last byte. Keys and
 * signatures are whole bytes, so Kin always passes 0. */
export function bitString(bytes, unusedBits = 0) {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) throw new RangeError("unused bits must be 0–7");
  return tlv(0x03, Buffer.from([unusedBits]), bytes);
}

/** INTEGER from a non-negative bigint, number or big-endian unsigned byte
 * string. DER wants the shortest two's-complement form: leading zero bytes
 * are dropped and one 0x00 is added back if the top bit is set, so the value
 * stays positive. */
export function integer(value) {
  let bytes;
  if (typeof value === "bigint" || typeof value === "number") {
    let rest = BigInt(value);
    if (rest < 0n) throw new RangeError("only non-negative INTEGERs are supported");
    const out = [];
    do { out.unshift(Number(rest & 0xffn)); rest >>= 8n; } while (rest > 0n);
    bytes = Buffer.from(out);
  } else {
    bytes = Buffer.from(value);
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  bytes = bytes.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

/** OBJECT IDENTIFIER from dotted text: the first two arcs share one value
 * (40 × first + second), and each arc is base-128 with the high bit set on
 * every byte but the last. */
export function objectIdentifier(dotted) {
  const arcs = String(dotted).split(".").map((arc) => {
    if (!/^(0|[1-9]\d*)$/.test(arc)) throw new RangeError(`bad OID arc in ${dotted}`);
    return BigInt(arc);
  });
  if (arcs.length < 2 || arcs[0] > 2n || (arcs[0] < 2n && arcs[1] > 39n)) throw new RangeError(`bad OID ${dotted}`);
  const values = [arcs[0] * 40n + arcs[1], ...arcs.slice(2)];
  const out = [];
  for (const value of values) {
    const group = [Number(value & 0x7fn)];
    for (let rest = value >> 7n; rest > 0n; rest >>= 7n) group.unshift(Number(rest & 0x7fn) | 0x80);
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
}

/** The dotted text of an OBJECT IDENTIFIER's content bytes. */
export function decodeObjectIdentifier(content) {
  const values = [];
  let value = 0n;
  for (const byte of content) {
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) { values.push(value); value = 0n; }
  }
  if (values.length === 0) throw new RangeError("empty OID");
  const first = values[0] < 80n ? values[0] / 40n : 2n;
  return [first, values[0] - first * 40n, ...values.slice(1)].join(".");
}

const pad = (value, width = 2) => String(value).padStart(width, "0");

/** Time for X.509 validity (RFC 5280 §4.1.2.5): UTCTime YYMMDDHHMMSSZ for
 * years 1950–2049, GeneralizedTime YYYYMMDDHHMMSSZ otherwise. Seconds only;
 * fractions are not allowed. */
export function time(date) {
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) throw new RangeError("invalid date");
  const year = at.getUTCFullYear();
  const rest = `${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, "ascii"));
  return tlv(0x18, Buffer.from(`${pad(year, 4)}${rest}`, "ascii"));
}

/** [n] EXPLICIT: a constructed context tag wrapping complete TLVs. */
export const explicit = (n, ...items) => tlv(0xa0 | n, ...items);
/** [n] IMPLICIT on a primitive type: the content with the context tag. */
export const implicitPrimitive = (n, content) => tlv(0x80 | n, content);

// ---- Reading -----------------------------------------------------------------

/** The TLV at `offset` in `bytes`. `value` is a view into `bytes`; `end` is the
 * offset just after it. Only definite lengths (DER) are accepted, and every
 * length is checked against what is left. */
export function readTlv(bytes, offset = 0) {
  if (offset + 2 > bytes.length) throw new RangeError("DER: truncated header");
  const tag = bytes[offset];
  if ((tag & 0x1f) === 0x1f) throw new RangeError("DER: multi-byte tags are not supported");
  let length = bytes[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new RangeError("DER: unsupported length form");
    if (offset + 2 + count > bytes.length) throw new RangeError("DER: truncated length");
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[offset + 2 + i];
    if (length < 0x80 || bytes[offset + 2] === 0) throw new RangeError("DER: length is not minimal");
    header += count;
  }
  const start = offset + header;
  const end = start + length;
  if (end > bytes.length) throw new RangeError("DER: value runs past the input");
  return { tag, start: offset, header, length, end, value: bytes.subarray(start, end), raw: bytes.subarray(offset, end) };
}

/** Every TLV inside a constructed value, in order. Fails unless they exactly
 * fill it. */
export function readChildren(content) {
  const out = [];
  for (let offset = 0; offset < content.length;) {
    const item = readTlv(content, offset);
    out.push(item);
    offset = item.end;
  }
  return out;
}

// ---- ECDSA signatures --------------------------------------------------------

/** An ECDSA signature in IEEE P1363 form (r ‖ s, each `size` bytes, as JWS
 * ES256 uses) re-encoded as the DER `ECDSA-Sig-Value ::= SEQUENCE { r
 * INTEGER, s INTEGER }` that X.509 and PKCS#10 carry (RFC 5480 §2.2,
 * RFC 3279 §2.2.3). */
export function ecdsaRawToDer(raw, size = 32) {
  const bytes = Buffer.from(raw);
  if (bytes.length !== size * 2) throw new RangeError(`ECDSA signature must be ${size * 2} bytes`);
  return sequence(integer(bytes.subarray(0, size)), integer(bytes.subarray(size)));
}
