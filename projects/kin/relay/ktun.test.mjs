// KTUN v1 codec (#730): the TEST-VECTORS "KTUN v1 tunnel frames" vectors
// (186–193), every decode check, the frame reader, and credit accounting.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ALPN, Code, ControlOp, DEFAULT_HELLO, EXPORTER_LABEL, FrameReader, FrameType, KtunError, MAX_PAYLOAD, ReceiveWindow,
  SendWindow, authMessage, checkHeader, decodeAuth, decodeControl, decodeControlBody, decodeGoaway, decodeHello,
  decodeNameList, decodeOpen, decodePreface, decodeReady, decodeReset, decodeWindow, encodeAuth, encodeControl,
  encodeControlBody, encodeData, encodeFrame, encodeGoaway, encodeHello, encodeNameList, encodeOpen, encodePing,
  encodePreface, encodeReady, encodeReset, encodeWindow, isHostName, keyHashText, rawEd25519PublicKey, signEd25519,
  transferMessage, verifyEd25519,
} from "./ktun.mjs";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const seedKey = (byte) => createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, byte)]), format: "der", type: "pkcs8",
});
const HOME = seedKey(1);
const NEW_HOME = seedKey(2);
const PUBLIC = rawEd25519PublicKey(HOME);
const NEW_PUBLIC = rawEd25519PublicKey(NEW_HOME);
const NONCE = Buffer.alloc(32, 0xaa);
const EXPORTER = Buffer.alloc(32, 0xbb);

/** Every vector: its number, and the bytes the codec must produce. The doc
 * carries the same hex, checked below, so the two can't drift apart. */
const VECTORS = {
  186: {
    preface: [encodePreface(), "4b54554e01000000"],
    hello: [encodeHello({ nonce: Buffer.alloc(32, 0x11), ...DEFAULT_HELLO }),
      "010000000000000034000000111111111111111111111111111111111111111111111111111111111111111100010000000004000000400019004b0000000000"],
  },
  187: {
    publicKey: [PUBLIC, "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"],
    message: [authMessage("relay.home.test", NONCE, EXPORTER),
      "6b696e2d74756e6e656c2d617574682f310072656c61792e686f6d652e7465737400aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    signature: [signEd25519(HOME, authMessage("relay.home.test", NONCE, EXPORTER)),
      "ec493467e5400d087b84cfb357a302228979eab44257b05d003e5793c7ad37b62578f9558552f402f09966443662ac5e29af9a67a738d5749c0f97a486f0440f"],
    auth: [encodeAuth({ publicKey: PUBLIC, signature: signEd25519(HOME, authMessage("relay.home.test", NONCE, EXPORTER)), softwareVersion: 0x0001_0600 }),
      "0200000000000000680000008a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5cec493467e5400d087b84cfb357a302228979eab44257b05d003e5793c7ad37b62578f9558552f402f09966443662ac5e29af9a67a738d5749c0f97a486f0440f0006010000000000"],
    keyHash: [Buffer.from(keyHashText(PUBLIC)), Buffer.from("NHUPmL1Z_PyUbaRaqr6TO-FUpLUJThxKv0KGZQXzyX4").toString("hex")],
  },
  188: {
    ready: [encodeReady(["x.home.test", "kin.family.test"]), "030000000000000020000000020000000b782e686f6d652e746573740f6b696e2e66616d696c792e74657374"],
    empty: [encodeReady([]), "03000000000000000400000000000000"],
  },
  189: {
    open4: [encodeOpen(1, { name: "x.home.test", address: "203.0.113.7" }), "04000000010000001f000000040b0000cb007107000000000000000000000000782e686f6d652e74657374"],
    open6: [encodeOpen(2, { name: "x.home.test", address: "2001:db8::1" }), "04000000020000001f000000060b000020010db8000000000000000000000001782e686f6d652e74657374"],
    mapped: [encodeOpen(1, { name: "x.home.test", address: "::ffff:203.0.113.7" }), "04000000010000001f000000040b0000cb007107000000000000000000000000782e686f6d652e74657374"],
  },
  190: {
    data: [encodeData(1, Buffer.from([0x16, 0x03, 0x01])), "050000000100000003000000160301"],
    fin: [encodeData(1, Buffer.alloc(0), true), "050100000100000000000000"],
    window0: [encodeWindow(0, 2_097_152), "06000000000000000400000000002000"],
    window1: [encodeWindow(1, 131_072), "06000000010000000400000000000200"],
    reset: [encodeReset(3, Code.NONE), "07000000030000000400000000000000"],
  },
  191: {
    ping: [encodePing(Buffer.from("0102030405060708", "hex")), "0800000000000000080000000102030405060708"],
    ack: [encodePing(Buffer.from("0102030405060708", "hex"), true), "0801000000000000080000000102030405060708"],
    goaway: [encodeGoaway(7, Code.REPLACED), "0900000000000000080000000700000003000000"],
  },
  192: {
    claim: [encodeControl({ requestId: 1, op: ControlOp.CLAIM, body: encodeControlBody(ControlOp.CLAIM, { name: "x.home.test" }) }),
      "0a00000000000000140000000100000001000c000b782e686f6d652e74657374"],
    claimed: [encodeControl({ requestId: 1, op: ControlOp.CLAIM, status: Code.NONE, body: encodeNameList(["x.home.test"]) }),
      "0a00000000000000180000000100000001001000010000000b782e686f6d652e74657374"],
    taken: [encodeControl({ requestId: 1, op: ControlOp.CLAIM, status: Code.NAME_TAKEN }), "0a00000000000000080000000100000001090000"],
    setCaa: [encodeControl({ requestId: 2, op: ControlOp.SET_CAA, body: encodeControlBody(ControlOp.SET_CAA, { name: "x.home.test", accountUri: "https://acme.test/acct/1" }) }),
      "0a000000000000002e00000002000000030026000b782e686f6d652e74657374180068747470733a2f2f61636d652e746573742f616363742f31"],
    check: [encodeControl({ requestId: 3, op: ControlOp.CHECK, body: encodeControlBody(ControlOp.CHECK, { name: "x.home.test" }) }),
      "0a00000000000000140000000300000007000c000b782e686f6d652e74657374"],
  },
  193: {
    newKey: [NEW_PUBLIC, "8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"],
    message: [transferMessage("x.home.test", PUBLIC, NEW_PUBLIC),
      "6b696e2d74756e6e656c2d7472616e736665722f3100782e686f6d652e74657374008a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"],
    signature: [signEd25519(NEW_HOME, transferMessage("x.home.test", PUBLIC, NEW_PUBLIC)),
      "747c6bed27ac0d4abe631d8995062d6afaf17cd9e2b27c0f475ce3e914719eaf33cebf2cc575ff9e4db5d72de280c82651a34744c63e9db76b432c08ffe1d20d"],
  },
};

test("the codec produces every vector's bytes (186–193)", () => {
  for (const [number, entries] of Object.entries(VECTORS))
    for (const [label, [actual, expected]] of Object.entries(entries)) assert.equal(hex(actual), expected, `${number} ${label}`);
});

test("TEST-VECTORS.md carries the same bytes", () => {
  const doc = readFileSync(new URL("../docs/TEST-VECTORS.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = doc.indexOf("## The KTUN tunnel (#730)");
  assert.ok(start >= 0, "the KTUN section exists");
  const section = doc.slice(start, doc.indexOf("\n## ", start + 4) === -1 ? undefined : doc.indexOf("\n## ", start + 4));
  // Long values are wrapped at 64 hex digits in the doc.
  const flat = section.replace(/([0-9a-f])\n([0-9a-f])/g, "$1$2");
  for (const [number, entries] of Object.entries(VECTORS)) {
    assert.ok(section.includes(`**${number} — `), `vector ${number} is described`);
    for (const [label, [, expected]] of Object.entries(entries)) {
      if (label === "keyHash") { assert.ok(section.includes("NHUPmL1Z_PyUbaRaqr6TO-FUpLUJThxKv0KGZQXzyX4")); continue; }
      if (label === "mapped") continue;
      assert.ok(flat.includes(expected), `${number} ${label} is written out`);
    }
  }
});

test("constants are the ADR's", () => {
  assert.equal(ALPN, "kin-tunnel/1");
  assert.equal(EXPORTER_LABEL, "EXPORTER-kin-tunnel-auth");
  assert.equal(MAX_PAYLOAD, 16_384);
  assert.deepEqual(FrameType, { HELLO: 1, AUTH: 2, READY: 3, OPEN: 4, DATA: 5, WINDOW: 6, RESET: 7, PING: 8, GOAWAY: 9, CONTROL: 10 });
  assert.deepEqual(Object.values(Code), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(ControlOp, { CLAIM: 1, RELEASE: 2, SET_CAA: 3, ADD_DOMAIN: 4, REMOVE_DOMAIN: 5, TRANSFER: 6, CHECK: 7 });
  assert.deepEqual(DEFAULT_HELLO, { maxStreams: 256, streamWindow: 262_144, connectionWindow: 4_194_304, pingSeconds: 25, idleSeconds: 75 });
});

test("the preface: version 1 only, flags zero", () => {
  assert.deepEqual(decodePreface(encodePreface()), { version: 1, flags: 0 });
  assert.throws(() => decodePreface(encodePreface(2)), KtunError);
  assert.throws(() => decodePreface(encodePreface(1, 1)), KtunError);
  assert.throws(() => decodePreface(Buffer.from("KTUM\x01\0\0\0", "latin1")), KtunError);
  assert.throws(() => decodePreface(Buffer.from("KTUN\x01\0\0", "latin1")), KtunError);
});

test("payloads decode back to what was encoded", () => {
  const read = (bytes, sender) => { const frames = new FrameReader(sender).push(bytes); assert.equal(frames.length, 1); return frames[0]; };
  const hello = read(VECTORS[186].hello[0], "relay");
  assert.deepEqual({ ...decodeHello(hello.payload), nonce: hex(decodeHello(hello.payload).nonce) }, { ...DEFAULT_HELLO, nonce: "11".repeat(32) });
  const auth = decodeAuth(read(VECTORS[187].auth[0], "home").payload);
  assert.equal(auth.softwareVersion, 0x0001_0600);
  assert.ok(verifyEd25519(auth.publicKey, authMessage("relay.home.test", NONCE, EXPORTER), auth.signature));
  assert.ok(!verifyEd25519(auth.publicKey, authMessage("relay.other.test", NONCE, EXPORTER), auth.signature), "bound to the relay's name");
  assert.ok(!verifyEd25519(auth.publicKey, authMessage("relay.home.test", NONCE, Buffer.alloc(32)), auth.signature), "bound to the TLS session");
  assert.ok(!verifyEd25519(Buffer.alloc(31), Buffer.alloc(1), Buffer.alloc(64)), "a bad key is false, not a throw");
  assert.deepEqual(decodeReady(read(VECTORS[188].ready[0], "relay").payload), ["x.home.test", "kin.family.test"]);
  assert.deepEqual(decodeOpen(read(VECTORS[189].open4[0], "relay").payload), { family: 4, address: "203.0.113.7", name: "x.home.test" });
  assert.deepEqual(decodeOpen(read(VECTORS[189].open6[0], "relay").payload), { family: 6, address: "2001:db8:0:0:0:0:0:1", name: "x.home.test" });
  assert.equal(decodeWindow(read(VECTORS[190].window1[0], "home").payload), 131_072);
  assert.equal(decodeReset(read(VECTORS[190].reset[0], "home").payload), 0);
  assert.deepEqual(decodeGoaway(read(VECTORS[191].goaway[0], "home").payload), { lastStream: 7, code: 3 });
  const claim = decodeControl(read(VECTORS[192].claim[0], "home").payload);
  assert.deepEqual({ ...claim, body: undefined }, { requestId: 1, op: 1, status: 0, body: undefined });
  assert.deepEqual(decodeControlBody(ControlOp.CLAIM, claim.body), { name: "x.home.test" });
  const caa = decodeControl(read(VECTORS[192].setCaa[0], "home").payload);
  assert.deepEqual(decodeControlBody(ControlOp.SET_CAA, caa.body), { name: "x.home.test", accountUri: "https://acme.test/acct/1" });
  assert.deepEqual(decodeNameList(decodeControl(read(VECTORS[192].claimed[0], "relay").payload).body), ["x.home.test"]);
  const check = decodeControl(read(VECTORS[192].check[0], "home").payload);
  assert.equal(check.op, 7);
  assert.deepEqual(decodeControlBody(ControlOp.CHECK, check.body), { name: "x.home.test" });
  assert.throws(() => decodeControlBody(ControlOp.CHECK, Buffer.concat([check.body, Buffer.from([0])])), KtunError, "a name only");
  const transfer = encodeControlBody(ControlOp.TRANSFER, { name: "x.home.test", newKey: NEW_PUBLIC, signature: VECTORS[193].signature[0] });
  const decoded = decodeControlBody(ControlOp.TRANSFER, transfer);
  assert.ok(verifyEd25519(decoded.newKey, transferMessage(decoded.name, PUBLIC, decoded.newKey), decoded.signature));
});

test("every frame is checked before it is acted on", () => {
  const header = (type, { flags = 0, reserved = 0, stream = 0, length } = {}) => ({ type, flags, reserved, stream, length: length ?? ({ 1: 52, 2: 104, 6: 4, 7: 4, 8: 8, 9: 8 }[type] ?? 0) });
  const bad = (fields, sender) => assert.throws(() => checkHeader(fields, sender), KtunError, JSON.stringify(fields));
  const good = (fields, sender) => assert.doesNotThrow(() => checkHeader(fields, sender), JSON.stringify(fields));
  bad(header(0)); bad(header(11)); bad(header(255));
  bad(header(5, { reserved: 1, stream: 1 }));
  bad(header(5, { stream: 1, length: 16_385 }));
  good(header(5, { stream: 1, length: 16_384 }));
  bad(header(5, { stream: 0 }));                        // DATA on stream 0
  bad(header(5, { stream: 1, flags: 2 }));              // undefined flag bit
  good(header(5, { stream: 1, flags: 1 }));
  bad(header(4, { stream: 0, length: 30 }), "relay");   // OPEN on stream 0
  bad(header(4, { stream: 1, length: 30 }), "home");    // OPEN from the home server
  bad(header(1), "home"); bad(header(3, { length: 4 }), "home"); bad(header(2), "relay");
  bad(header(1, { length: 51 }), "relay");              // HELLO of the wrong length
  bad(header(2, { length: 105 }), "home");
  bad(header(6, { length: 8 })); bad(header(7, { stream: 1, length: 0 })); bad(header(8, { length: 7 })); bad(header(9, { length: 9 }));
  bad(header(8, { stream: 1 })); bad(header(9, { stream: 2 })); bad(header(10, { stream: 1, length: 8 })); bad(header(7, { stream: 0 }));
  bad(header(8, { flags: 2 })); bad(header(6, { flags: 1 }));
  good(header(6, { stream: 0 })); good(header(6, { stream: 9 }));
  bad(header(5, { stream: 0x8000_0000 }));
  // Payload-level checks.
  const hello = Buffer.from(VECTORS[186].hello[0].subarray(12));
  hello.writeUInt32LE(1, 48);
  assert.throws(() => decodeHello(hello), KtunError, "HELLO reserved");
  const auth = Buffer.from(VECTORS[187].auth[0].subarray(12));
  auth.writeUInt32LE(1, 100);
  assert.throws(() => decodeAuth(auth), KtunError, "AUTH reserved");
  assert.throws(() => decodeWindow(Buffer.alloc(4)), KtunError, "a zero WINDOW");
  assert.throws(() => decodeNameList(Buffer.from("0100010000", "hex")), KtunError, "READY reserved");
  assert.throws(() => decodeNameList(Buffer.from("01000000", "hex")), KtunError, "READY short");
  assert.throws(() => decodeNameList(Buffer.from("0000000000", "hex")), KtunError, "READY trailing byte");
  assert.throws(() => decodeNameList(Buffer.concat([Buffer.from("0100000003", "hex"), Buffer.from("A.b")])), KtunError, "uppercase name");
  const open = Buffer.from(VECTORS[189].open4[0].subarray(12));
  for (const [at, value] of [[0, 5], [2, 1], [10, 1], [1, 12]]) {
    const copy = Buffer.from(open);
    copy[at] = value;
    assert.throws(() => decodeOpen(copy), KtunError, `OPEN byte ${at}`);
  }
  assert.throws(() => decodeControl(Buffer.from("01000000010003000000", "hex")), KtunError, "CONTROL bodyLength");
  assert.throws(() => decodeControlBody(ControlOp.CLAIM, Buffer.from("0278", "hex")), KtunError);
  assert.throws(() => decodeControlBody(ControlOp.CLAIM, Buffer.from("01787878", "hex")), KtunError, "bytes after the name");
  assert.throws(() => decodeControlBody(ControlOp.TRANSFER, Buffer.from("0178", "hex")), KtunError);
  assert.throws(() => decodeControlBody(99, Buffer.from("0178", "hex")), KtunError);
  // Encoders refuse what could never be sent.
  assert.throws(() => encodeFrame(5, 0, 1, Buffer.alloc(16_385)), RangeError);
  assert.throws(() => encodeWindow(1, 0), RangeError);
  assert.throws(() => encodeOpen(1, { name: "X.home.test", address: "203.0.113.7" }), RangeError);
  assert.throws(() => encodeOpen(1, { name: "x.home.test", address: "300.0.0.1" }), RangeError);
});

test("the frame reader handles any chunking and holds at most one partial frame", () => {
  const frames = Buffer.concat([
    encodeData(1, Buffer.alloc(16_384, 7)), encodeWindow(0, 5), encodePing(Buffer.alloc(8), false), encodeData(3, Buffer.alloc(0), true),
  ]);
  for (const size of [1, 2, 11, 12, 13, 100, 4096, 16_396, frames.length]) {
    const reader = new FrameReader("home");
    const seen = [];
    for (let offset = 0; offset < frames.length; offset += size) {
      seen.push(...reader.push(frames.subarray(offset, offset + size)));
      assert.ok(reader.buffered <= 12 + 16_384, `chunk ${size}`);
    }
    assert.deepEqual(seen.map(({ type, stream, flags, payload }) => [type, stream, flags, payload.length]), [[5, 1, 0, 16_384], [6, 0, 0, 4], [8, 0, 0, 8], [5, 3, 1, 0]], `chunk ${size}`);
    assert.equal(reader.buffered, 0);
  }
  // A bad header is refused as soon as its 12 bytes are in, before its payload.
  const reader = new FrameReader("home");
  assert.throws(() => reader.push(encodeFrame(5, 0, 1, Buffer.alloc(0)).fill(0xff, 8, 12)), KtunError);
  // Zero copy: a payload inside one chunk is a view of that chunk.
  const chunk = encodeData(1, Buffer.from("abc"));
  const [frame] = new FrameReader("home").push(chunk);
  assert.equal(frame.payload.buffer, chunk.buffer);
});

test("credit: windows are spent by DATA and refilled by WINDOW after half is passed on", () => {
  const send = new SendWindow(DEFAULT_HELLO.streamWindow);
  assert.ok(send.spend(200_000));
  assert.equal(send.spend(100_000), false, "a sender never goes past its credit");
  assert.equal(send.available, 62_144);
  send.grant(131_072);
  assert.equal(send.available, 193_216);
  assert.throws(() => new SendWindow(0xffff_fff0).grant(0x20), KtunError, "credit past 2³²−1");

  const receive = new ReceiveWindow(DEFAULT_HELLO.streamWindow);
  receive.receive(100_000);
  receive.passed(100_000);
  assert.equal(receive.takeGrant(), 0, "no grant before half a window");
  receive.receive(40_000);
  receive.passed(40_000);
  assert.equal(receive.takeGrant(), 140_000, "a grant once half a window was passed on");
  assert.equal(receive.remaining, DEFAULT_HELLO.streamWindow);
  receive.receive(262_144);
  assert.throws(() => receive.receive(1), KtunError, "DATA over the credit is a protocol error");
  receive.passed(1);
  assert.equal(receive.takeGrant(true), 1, "forced grants return what was passed");
});

test("host names: LDH labels, lowercase, ≤ 253 bytes", () => {
  for (const name of ["x.home.test", "a", "xn--bcher-kva.example", "a-b.c"]) assert.ok(isHostName(name), name);
  for (const name of ["", "X.home", "x.", ".x", "x..y", "-x", "x-", "x_y", `${"a".repeat(64)}`, `${"a.".repeat(127)}a`]) assert.ok(!isHostName(name), name);
});
