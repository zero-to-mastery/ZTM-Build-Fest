// Builds TLS ClientHello bytes field by field for the SNI parser's tests
// (#729). The profiles copy the shape of what browsers send today: GREASE
// values, a post-quantum X25519MLKEM768 key share (1,216 bytes), GREASE ECH,
// ALPN, padding. Values that don't matter to the parser (random, key shares)
// are fixed patterns, so every vector is deterministic.

const u8 = (value) => Buffer.from([value]);
const u16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const u24 = (value) => Buffer.from([value >> 16, (value >> 8) & 0xff, value & 0xff]);
const vec8 = (bytes) => Buffer.concat([u8(bytes.length), bytes]);
const vec16 = (bytes) => Buffer.concat([u16(bytes.length), bytes]);
const fill = (length, seed) => Buffer.from(Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff));

/** One extension: type:u16 length:u16 data. */
export const extension = (type, data = Buffer.alloc(0)) => Buffer.concat([u16(type), vec16(data)]);

/** The server_name extension for one host name. */
export const serverName = (name) => extension(0, vec16(Buffer.concat([u8(0), vec16(Buffer.from(name, "latin1"))])));

/** An encrypted_client_hello extension (0xfe0d), outer form: type 0,
 * HPKE suite, config id, enc (32) and payload. Real and GREASE ECH look the
 * same on the wire; that is the point of GREASE. */
export const echOuter = (payloadLength = 208) => extension(0xfe0d, Buffer.concat([
  u8(0), u16(0x0001), u16(0x0001), u8(0x42), vec16(fill(32, 7)), vec16(fill(payloadLength, 11)),
]));

const alpn = (...protocols) => extension(16, vec16(Buffer.concat(protocols.map((protocol) => vec8(Buffer.from(protocol))))));
const supportedVersions = (...versions) => extension(43, vec8(Buffer.concat(versions.map(u16))));
const groups = (...ids) => extension(10, vec16(Buffer.concat(ids.map(u16))));
const signatureAlgorithms = extension(13, vec16(Buffer.concat([0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601].map(u16))));
const keyShare = (...shares) => extension(51, vec16(Buffer.concat(shares.map(([group, length]) => Buffer.concat([u16(group), vec16(fill(length, group & 0xff))])))));

/** The ClientHello handshake message (type 1, u24 length, body). */
export function clientHelloMessage({ extensions, sessionId = fill(32, 3), suites = [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f], compression = [0], version = 0x0303, withExtensions = true }) {
  const body = Buffer.concat([
    u16(version),
    fill(32, 1),
    vec8(sessionId),
    vec16(Buffer.concat(suites.map(u16))),
    vec8(Buffer.from(compression)),
    withExtensions ? vec16(Buffer.concat(extensions)) : Buffer.alloc(0),
  ]);
  return Buffer.concat([u8(1), u24(body.length), body]);
}

/** Wraps handshake bytes in TLS records of at most `sizes[i]` bytes each
 * (the last size repeats), record version 0x0301 as browsers send. */
export function records(message, sizes = [16_384], { type = 22, version = 0x0301 } = {}) {
  const parts = [];
  let offset = 0;
  let index = 0;
  while (offset < message.length) {
    const size = Math.min(sizes[Math.min(index, sizes.length - 1)], message.length - offset);
    parts.push(Buffer.concat([u8(type), u16(version), u16(size), message.subarray(offset, offset + size)]));
    offset += size;
    index += 1;
  }
  return Buffer.concat(parts);
}

const GREASE = (n) => 0x0a0a + n * 0x1010;

/** A Chrome-like hello: GREASE, X25519MLKEM768 + X25519, GREASE ECH. */
export function chromeLike(name, { ech = echOuter() } = {}) {
  return clientHelloMessage({
    suites: [GREASE(0), 0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035],
    extensions: [
      extension(GREASE(1)),
      extension(65_281, u8(0)),
      serverName(name),
      extension(23),
      extension(35),
      groups(GREASE(2), 0x11ec, 0x001d, 0x0017, 0x0018),
      extension(11, vec8(u8(0))),
      extension(5, Buffer.from([1, 0, 0, 0, 0])),
      alpn("h2", "http/1.1"),
      signatureAlgorithms,
      extension(18),
      keyShare([GREASE(2), 1], [0x11ec, 1216], [0x001d, 32]),
      extension(45, vec8(u8(1))),
      supportedVersions(GREASE(3), 0x0304, 0x0303),
      extension(27, vec8(u16(2))),
      extension(17513, vec16(vec8(Buffer.from("h2")))),
      ...(ech ? [ech] : []),
      extension(GREASE(4), u8(0)),
    ],
  });
}

/** A Firefox-like hello: no GREASE, ML-KEM and X25519 shares, a record
 * size limit, padding to a round size. */
export function firefoxLike(name) {
  const base = [
    serverName(name),
    extension(23),
    extension(65_281, u8(0)),
    groups(0x11ec, 0x001d, 0x0017, 0x0018, 0x0019, 0x0100, 0x0101),
    extension(11, vec8(u8(0))),
    alpn("h2", "http/1.1"),
    extension(5, Buffer.from([1, 0, 0, 0, 0])),
    extension(34, vec16(Buffer.concat([0x0403, 0x0503, 0x0603, 0x0203].map(u16)))),
    keyShare([0x11ec, 1216], [0x001d, 32], [0x0017, 65]),
    supportedVersions(0x0304, 0x0303),
    signatureAlgorithms,
    extension(45, vec8(u8(1))),
    extension(28, u16(0x4001)),
    extension(27, vec8(Buffer.concat([u16(1), u16(2), u16(3)]))),
  ];
  return clientHelloMessage({ extensions: [...base, extension(21, Buffer.alloc(57))] });
}

/** A Safari-like hello: GREASE, classic X25519 only, a short padding. */
export function safariLike(name) {
  return clientHelloMessage({
    suites: [GREASE(5), 0x1301, 0x1302, 0x1303, 0xc02c, 0xc02b, 0xcca9, 0xc030, 0xc02f, 0xcca8],
    extensions: [
      extension(GREASE(6)),
      serverName(name),
      extension(23),
      extension(65_281, u8(0)),
      groups(GREASE(7), 0x001d, 0x0017, 0x0018, 0x0019),
      extension(11, vec8(u8(0))),
      alpn("h2", "http/1.1"),
      extension(5, Buffer.from([1, 0, 0, 0, 0])),
      signatureAlgorithms,
      extension(18),
      keyShare([GREASE(7), 1], [0x001d, 32]),
      extension(45, vec8(u8(1))),
      supportedVersions(GREASE(8), 0x0304, 0x0303, 0x0302, 0x0301),
      extension(27, vec8(u16(1))),
      extension(GREASE(9), u8(0)),
      extension(21, Buffer.alloc(20)),
    ],
  });
}

/** An OpenSSL/curl-like hello: TLS 1.3 and 1.2 suites, no GREASE. */
export function opensslLike(name) {
  return clientHelloMessage({
    suites: [0x1302, 0x1303, 0x1301, 0xc02c, 0xc030, 0x009f, 0xcca9, 0xcca8, 0xccaa, 0xc02b, 0xc02f, 0x009e, 0x00ff],
    extensions: [
      serverName(name),
      extension(11, vec8(Buffer.from([0, 1, 2]))),
      groups(0x001d, 0x0017, 0x001e, 0x0019, 0x0018),
      extension(35),
      alpn("http/1.1"),
      extension(22),
      extension(23),
      signatureAlgorithms,
      supportedVersions(0x0304, 0x0303),
      extension(45, vec8(u8(1))),
      keyShare([0x001d, 32]),
    ],
  });
}
