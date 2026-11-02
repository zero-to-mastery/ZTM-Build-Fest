// The live channel (#107): RFC 6455 handshake and framing written natively,
// and the /api/live endpoint's access rules, over real sockets.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import {
  acceptKey, CLOSE, closePayload, encodeFrame, encodeMessage, FrameParser, isClientKey, isValidCloseCode, OPCODE, parseMessage,
} from "./live/websocket.mjs";
import { LIVE_TYPE, LiveService } from "./live/live-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

/** A client frame: masked, as browsers send them. */
function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = true, rsv = 0, lengthOverride } = {}) {
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | rsv | opcode;
  if (extra === 0) header[1] = (mask ? 0x80 : 0) | (lengthOverride ?? length);
  else if (extra === 2) { header[1] = (mask ? 0x80 : 0) | 126; header.writeUInt16BE(length, 2); }
  else { header[1] = (mask ? 0x80 : 0) | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(length, 6); }
  if (!mask) return Buffer.concat([header, payload]);
  const key = randomBytes(4);
  key.copy(header, 2 + extra);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) body[index] ^= key[index & 3];
  return Buffer.concat([header, body]);
}

// ---- Protocol -----------------------------------------------------------------

test("the handshake answers the RFC's own example key", () => {
  // RFC 6455 §1.3.
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.equal(isClientKey("dGhlIHNhbXBsZSBub25jZQ=="), true);
  for (const bad of ["", "short", "dGhlIHNhbXBsZSBub25jZQ", Buffer.alloc(15).toString("base64"), undefined])
    assert.equal(isClientKey(bad), false, String(bad));
});

test("the RFC's masked frame is read, but Kin takes binary only", () => {
  // RFC 6455 §5.7: a single-frame masked text message "Hello".
  const hello = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  // The parser owns what it is fed (it unmasks in place), so each gets a copy.
  const binary = Buffer.from(hello);
  binary[0] = 0x82;
  const [event] = new FrameParser().feed(Buffer.from(hello));
  assert.deepEqual(event, { type: "error", code: CLOSE.UNSUPPORTED_DATA, reason: "Kin uses binary messages only." });
  assert.equal(new FrameParser().feed(binary)[0].data.toString(), "Hello");
});

test("fragments reassemble, with control frames between them, across any chunking", () => {
  const frames = Buffer.concat([
    clientFrame(OPCODE.BINARY, Buffer.from("Hel"), { fin: false }),
    clientFrame(OPCODE.PING, Buffer.from("p")),
    clientFrame(OPCODE.CONTINUATION, Buffer.from("lo, "), { fin: false }),
    clientFrame(OPCODE.CONTINUATION, Buffer.from("Kin"), { fin: true }),
  ]);
  for (const size of [1, 2, 3, 7, frames.length]) {
    const parser = new FrameParser();
    const events = [];
    const copy = Buffer.from(frames);
    for (let at = 0; at < copy.length; at += size) events.push(...parser.feed(copy.subarray(at, at + size)));
    assert.deepEqual(events.map((event) => event.type), ["ping", "message"], `chunks of ${size}`);
    assert.equal(events[1].data.toString(), "Hello, Kin");
  }
});

test("16-bit and 64-bit lengths parse; a message past the cap is refused from its header", () => {
  const medium = randomBytes(300);
  assert.deepEqual(new FrameParser().feed(clientFrame(OPCODE.BINARY, medium))[0].data, medium);
  const large = randomBytes(70_000);
  assert.deepEqual(new FrameParser().feed(clientFrame(OPCODE.BINARY, large))[0].data, large);
  // Only the header of an oversized frame is needed to refuse it.
  const header = clientFrame(OPCODE.BINARY, Buffer.alloc(300_000)).subarray(0, 14);
  assert.equal(new FrameParser().feed(header)[0].code, CLOSE.TOO_BIG);
  // Fragments add up: the cap is for the whole message.
  const parser = new FrameParser({ maxMessage: 1000 });
  assert.deepEqual(parser.feed(clientFrame(OPCODE.BINARY, Buffer.alloc(600), { fin: false })), []);
  assert.equal(parser.feed(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(600)))[0].code, CLOSE.TOO_BIG);
});

test("thousands of tiny fragments in one chunk end in a refusal, never a crash", () => {
  const flood = [clientFrame(OPCODE.BINARY, Buffer.alloc(0), { fin: false })];
  for (let index = 0; index < 20_000; index += 1) flood.push(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(0), { fin: false }));
  const events = new FrameParser().feed(Buffer.concat(flood));
  assert.equal(events.length, 1);
  assert.equal(events[0].code, CLOSE.TOO_BIG, "past 128 fragments the message is refused");
  // Up to the cap, fragments reassemble.
  const fine = [clientFrame(OPCODE.BINARY, Buffer.from("a"), { fin: false })];
  for (let index = 0; index < 126; index += 1) fine.push(clientFrame(OPCODE.CONTINUATION, Buffer.from("b"), { fin: false }));
  fine.push(clientFrame(OPCODE.CONTINUATION, Buffer.from("c")));
  const [message] = new FrameParser().feed(Buffer.concat(fine));
  assert.equal(message.data.length, 128);
});

test("protocol violations close with the right code", () => {
  const cases = [
    [clientFrame(OPCODE.BINARY, Buffer.from("x"), { mask: false }), CLOSE.PROTOCOL_ERROR, "unmasked"],
    [clientFrame(OPCODE.BINARY, Buffer.from("x"), { rsv: 0x40 }), CLOSE.PROTOCOL_ERROR, "compressed (RSV1)"],
    [clientFrame(0x3, Buffer.from("x")), CLOSE.PROTOCOL_ERROR, "reserved opcode"],
    [clientFrame(OPCODE.PING, Buffer.alloc(126)), CLOSE.PROTOCOL_ERROR, "oversized control frame"],
    [clientFrame(OPCODE.PING, Buffer.alloc(1), { fin: false }), CLOSE.PROTOCOL_ERROR, "fragmented control frame"],
    [clientFrame(OPCODE.CONTINUATION, Buffer.from("x")), CLOSE.PROTOCOL_ERROR, "continuation with no message"],
    [Buffer.concat([clientFrame(OPCODE.BINARY, Buffer.from("a"), { fin: false }), clientFrame(OPCODE.BINARY, Buffer.from("b"))]), CLOSE.PROTOCOL_ERROR, "new message mid-message"],
    [clientFrame(OPCODE.CLOSE, Buffer.from([0x03])), CLOSE.PROTOCOL_ERROR, "one-byte close"],
    [clientFrame(OPCODE.CLOSE, closePayload(1005)), CLOSE.PROTOCOL_ERROR, "reserved close code"],
    [clientFrame(OPCODE.CLOSE, Buffer.concat([closePayload(1000), Buffer.from([0xff])])), CLOSE.INVALID_DATA, "invalid UTF-8 reason"],
  ];
  for (const [bytes, code, name] of cases) {
    const events = new FrameParser().feed(bytes);
    assert.equal(events.at(-1).type, "error", name);
    assert.equal(events.at(-1).code, code, name);
  }
  // A 16-bit length that should have been 7-bit isn't minimal.
  const notMinimal = Buffer.from([0x82, 0xfe, 0x00, 0x05, 1, 2, 3, 4, 0, 0, 0, 0, 0]);
  assert.equal(new FrameParser().feed(notMinimal)[0].code, CLOSE.PROTOCOL_ERROR);
  // A parser that failed stays failed.
  const parser = new FrameParser();
  parser.feed(clientFrame(OPCODE.TEXT, Buffer.from("x")));
  assert.deepEqual(parser.feed(clientFrame(OPCODE.BINARY, Buffer.from("x"))), []);
});

test("close frames carry a code and reason; codes are checked", () => {
  const [close] = new FrameParser().feed(clientFrame(OPCODE.CLOSE, closePayload(4000, "bye")));
  assert.deepEqual(close, { type: "close", code: 4000, reason: "bye" });
  assert.deepEqual(new FrameParser().feed(clientFrame(OPCODE.CLOSE))[0], { type: "close", code: 1005, reason: "" });
  for (const code of [1000, 1001, 1011, 3000, 4999]) assert.equal(isValidCloseCode(code), true, code);
  for (const code of [999, 1004, 1005, 1006, 1015, 2999, 5000]) assert.equal(isValidCloseCode(code), false, code);
});

test("server frames are unmasked and minimally sized", () => {
  assert.deepEqual([...encodeFrame(OPCODE.PONG)], [0x8a, 0x00]);
  assert.deepEqual([...encodeFrame(OPCODE.BINARY, Buffer.alloc(200)).subarray(0, 4)], [0x82, 126, 0, 200]);
  const big = encodeFrame(OPCODE.BINARY, Buffer.alloc(70_000));
  assert.deepEqual([...big.subarray(0, 2)], [0x82, 127]);
  assert.equal(big.readUInt32BE(6), 70_000);
});

test("Kin records: an 8-byte little-endian header and an exact length", () => {
  const record = encodeMessage(0x02, Buffer.from([9, 8, 7]), 0x01);
  assert.deepEqual([...record], [0x02, 0x01, 0, 0, 3, 0, 0, 0, 9, 8, 7]);
  const parsed = parseMessage(record);
  assert.equal(parsed.type, 2);
  assert.equal(parsed.flags, 1);
  assert.deepEqual([...parsed.payload], [9, 8, 7]);
  assert.equal(parsed.payload.buffer, record.buffer, "the payload is a view, not a copy");
  assert.equal(parseMessage(record.subarray(0, 7)), null, "short header");
  assert.equal(parseMessage(Buffer.concat([record, Buffer.from([0])])), null, "length mismatch");
  const reserved = Buffer.from(record);
  reserved[2] = 1;
  assert.equal(parseMessage(reserved), null, "reserved bits set");
});

// ---- The endpoint -------------------------------------------------------------

/** A server with one household: two of the Adult's devices. */
async function rig(live = {}) {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("phone"), deviceLabel: "Phone" });
  const application = createKinServer({ store: new DurableStore(":memory:"), service, origin: "http://localhost", live });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const port = application.server.address().port;
  // A second trusted device for the same member.
  const pairing = service.createDevicePairing(adult.sessionToken);
  const claim = service.claimPairing({ code: pairing.code, credential: credential("laptop"), deviceLabel: "Laptop" });
  service.approvePairing(adult.sessionToken, pairing.pairingId, claim.version);
  const laptop = service.activateClaim(claim.claimToken);
  return {
    application, service, port, adult, laptop,
    close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => application.store.close()),
  };
}

/** A raw client: performs the handshake and reads server frames. */
async function open(port, { session, origin = "http://localhost", key = randomBytes(16).toString("base64"), extraHeaders = "", path = "/api/live" } = {}) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n` +
    (origin ? `Origin: ${origin}\r\n` : "") + (session ? `Cookie: kin_session=${session}\r\n` : "") + extraHeaders + "\r\n",
  );
  let buffer = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  let status = null;
  let headers = "";
  let ended = false;
  const parse = () => {
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = buffer.readUInt32BE(6); offset = 10; }
      if (buffer.length < offset + length) return;
      frames.push({ opcode: buffer[0] & 0x0f, data: buffer.subarray(offset, offset + length) });
      buffer = buffer.subarray(offset + length);
    }
  };
  const notify = () => { for (const waiter of waiters.splice(0)) waiter(); };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (status === null) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      headers = buffer.subarray(0, end).toString();
      status = Number(headers.split(" ")[1]);
      buffer = buffer.subarray(end + 4);
    }
    parse();
    notify();
  });
  socket.on("close", () => { ended = true; notify(); });
  socket.on("error", () => {});
  const until = async (predicate, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  await until(() => status !== null || ended);
  const records = () => frames.filter((frame) => frame.opcode === OPCODE.BINARY).map((frame) => parseMessage(frame.data));
  const closeFrame = () => {
    const frame = frames.find((entry) => entry.opcode === OPCODE.CLOSE);
    return frame && { code: frame.data.readUInt16BE(0), reason: frame.data.subarray(2).toString() };
  };
  return {
    socket, frames, records, closeFrame, until,
    get status() { return status; },
    get headers() { return headers; },
    get ended() { return ended; },
    send: (bytes) => socket.write(bytes),
  };
}

test("a trusted device opens the live channel and is greeted", async () => {
  const r = await rig();
  try {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const client = await open(r.port, { session: r.adult.sessionToken, key });
    assert.equal(client.status, 101);
    assert.match(client.headers, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.doesNotMatch(client.headers, /Sec-WebSocket-Extensions|Sec-WebSocket-Protocol/i, "no extension or subprotocol is accepted");
    await client.until(() => client.records().length);
    assert.equal(client.records()[0].type, LIVE_TYPE.HELLO);
    // Ping → pong with the same payload.
    client.send(clientFrame(OPCODE.PING, Buffer.from("hi")));
    await client.until(() => client.frames.some((frame) => frame.opcode === OPCODE.PONG));
    assert.equal(client.frames.find((frame) => frame.opcode === OPCODE.PONG).data.toString(), "hi");
    // A clean close is echoed.
    client.send(clientFrame(OPCODE.CLOSE, closePayload(1000)));
    await client.until(() => client.ended);
    assert.equal(client.closeFrame().code, 1000);
    assert.equal(r.application.liveService.connections.size, 0);
  } finally {
    await r.close();
  }
});

test("the upgrade is refused without the right origin, a session, or a proper handshake", async () => {
  const r = await rig();
  try {
    const session = r.adult.sessionToken;
    assert.equal((await open(r.port, { session, origin: "https://evil.example" })).status, 403, "cross-site origin");
    assert.equal((await open(r.port, { session, origin: null })).status, 403, "no origin at all");
    assert.equal((await open(r.port, {})).status, 401, "no session");
    assert.equal((await open(r.port, { session: "forged" })).status, 401, "unknown session");
    assert.equal((await open(r.port, { session, key: "bad" })).status, 400, "bad key");
    assert.equal((await open(r.port, { session, extraHeaders: "Sec-WebSocket-Protocol: chat\r\n" })).status, 400, "subprotocol");
    assert.equal((await open(r.port, { session, path: "/api/other" })).status, 404, "other path");
    assert.equal(r.application.liveService.connections.size, 0);
  } finally {
    await r.close();
  }
});

test("a text message, an unmasked frame or an unknown record type closes the socket", async () => {
  const r = await rig();
  try {
    for (const [bytes, code] of [
      [clientFrame(OPCODE.TEXT, Buffer.from("hi")), CLOSE.UNSUPPORTED_DATA],
      [clientFrame(OPCODE.BINARY, Buffer.from("hi"), { mask: false }), CLOSE.PROTOCOL_ERROR],
      [clientFrame(OPCODE.BINARY, encodeMessage(0x7f)), CLOSE.UNSUPPORTED_DATA],
      [clientFrame(OPCODE.BINARY, Buffer.from([1, 2, 3])), CLOSE.INVALID_DATA],
    ]) {
      const client = await open(r.port, { session: r.adult.sessionToken });
      client.send(bytes);
      await client.until(() => client.ended);
      assert.equal(client.closeFrame()?.code, code);
    }
  } finally {
    await r.close();
  }
});

test("one socket per device: a new one replaces the old", async () => {
  const r = await rig();
  try {
    const first = await open(r.port, { session: r.adult.sessionToken });
    const second = await open(r.port, { session: r.adult.sessionToken });
    await first.until(() => first.ended);
    assert.equal(first.closeFrame().code, CLOSE.REPLACED);
    assert.equal(second.ended, false);
    assert.equal(r.application.liveService.connections.size, 1);
  } finally {
    await r.close();
  }
});

test("revoking the device closes its socket at once; signing out closes with 4401", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    // Revoke the laptop as the revocation route does (after its passkey check).
    r.service.revokeDevice(r.adult.sessionToken, r.laptop.deviceId, r.adult.memberId);
    r.application.syncService.onAccessChange(r.adult.householdId, [r.laptop.deviceId]);
    await laptop.until(() => laptop.ended);
    assert.equal(laptop.closeFrame().code, CLOSE.ACCESS_LOST);
    assert.equal(phone.ended, false, "the household's other device stays connected");
    // Signing out ends the phone's session.
    await fetch(`http://127.0.0.1:${r.port}/api/logout`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: `kin_session=${r.adult.sessionToken}` }, body: "{}",
    });
    await phone.until(() => phone.ended);
    assert.equal(phone.closeFrame().code, CLOSE.SESSION_ENDED);
  } finally {
    await r.close();
  }
});

test("a deleted household's sockets close", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    r.service.requestHouseholdDeletion(r.adult.sessionToken, r.adult.memberId);
    r.application.liveService.revalidate(r.adult.householdId);
    await phone.until(() => phone.ended);
    assert.equal(phone.closeFrame().code, CLOSE.ACCESS_LOST);
  } finally {
    await r.close();
  }
});

test("accepted events nudge the household's other devices, never the author", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    await phone.until(() => phone.records().length === 1);
    await laptop.until(() => laptop.records().length === 1);
    r.application.liveService.eventsAccepted(r.adult.householdId, r.adult.deviceId);
    await laptop.until(() => laptop.records().length === 2);
    assert.equal(laptop.records()[1].type, LIVE_TYPE.SYNC_HINT);
    assert.equal(laptop.records()[1].payload.length, 0, "the hint says nothing about what changed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(phone.records().length, 1, "the author isn't nudged");
  } finally {
    await r.close();
  }
});

test("two unanswered pings close the socket; answering keeps it open and re-checks the session", async () => {
  const r = await rig({ pingInterval: 60 });
  try {
    const silent = await open(r.port, { session: r.adult.sessionToken });
    await silent.until(() => silent.ended, 2000);
    assert.equal(silent.closeFrame().code, CLOSE.GOING_AWAY);
    assert.ok(silent.frames.filter((frame) => frame.opcode === OPCODE.PING).length >= 2);

    const lively = await open(r.port, { session: r.laptop.sessionToken });
    lively.socket.on("data", () => {
      for (const frame of lively.frames.splice(0)) if (frame.opcode === OPCODE.PING) lively.send(clientFrame(OPCODE.PONG, frame.data));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(lively.ended, false, "a peer that answers stays connected");
    // The session ends behind its back: the next ping notices.
    r.service.logout(r.laptop.sessionToken);
    await lively.until(() => lively.ended, 2000);
  } finally {
    await r.close();
  }
});

test("a client that stops reading is dropped once its queue passes the limit", async () => {
  const r = await rig({ maxQueued: 64 * 1024 });
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    client.socket.pause();
    const connection = r.application.liveService.connections.get(r.adult.deviceId);
    const big = Buffer.alloc(32 * 1024);
    for (let index = 0; index < 400 && !connection.closing; index += 1) connection.send(0x03, big);
    assert.equal(connection.closing, true, "the slow consumer is closed (4429)");
    assert.equal(connection.queuedBytes, 0, "and its queue dropped");
    assert.equal(r.application.liveService.connections.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(connection.disposed, true, "its socket goes after a short grace");
    assert.equal(r.application.liveService.sockets.size, 0);
  } finally {
    await r.close();
  }
});

test("a flood of fragments over the socket closes it with 1009 and the service lives on", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    const flood = [clientFrame(OPCODE.BINARY, Buffer.alloc(0), { fin: false })];
    for (let index = 0; index < 5_000; index += 1) flood.push(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(0), { fin: false }));
    client.send(Buffer.concat(flood));
    await client.until(() => client.ended);
    assert.equal(client.closeFrame()?.code, CLOSE.TOO_BIG);
    const again = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(again.status, 101, "the service still answers");
  } finally {
    await r.close();
  }
});

test("a client that half-closes is let go at once", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    await client.until(() => client.records().length);
    client.socket.end();
    const live = r.application.liveService;
    const deadline = Date.now() + 1000;
    while (live.sockets.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(live.connections.size, 0);
    assert.equal(live.sockets.size, 0);
  } finally {
    await r.close();
  }
});

test("bytes sent with the upgrade request are read after it is accepted", async () => {
  const r = await rig();
  try {
    const socket = connect(r.port, "127.0.0.1");
    await once(socket, "connect");
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.write(Buffer.concat([
      Buffer.from(`GET /api/live HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nOrigin: http://localhost\r\n` +
        `Cookie: kin_session=${r.adult.sessionToken}\r\n\r\n`),
      clientFrame(OPCODE.PING, Buffer.from("early")),
    ]));
    const deadline = Date.now() + 2000;
    while (!Buffer.concat(chunks).includes(Buffer.from("early")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(Buffer.concat(chunks).includes(Buffer.from([0x8a, 5, ...Buffer.from("early")])), "the early ping is answered");
    socket.destroy();
  } finally {
    await r.close();
  }
});

test("the socket closes when the session expires, without waiting for a ping", async () => {
  const r = await rig();
  try {
    const auth = r.service.authorize(r.adult.sessionToken);
    auth.session.expiresAt = r.service.now() + 150;
    const client = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(client.status, 101);
    await client.until(() => client.ended, 2000);
    assert.equal(client.closeFrame()?.code, CLOSE.SESSION_ENDED);
  } finally {
    await r.close();
  }
});

test("a Temporary member's socket closes when the membership ends", async () => {
  const r = await rig();
  try {
    const member = r.service.members.get(r.adult.memberId);
    member.kind = "temporary";
    member.expiresAt = r.service.now() + 150;
    const client = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(client.status, 101);
    await client.until(() => client.ended, 2000);
    assert.equal(client.closeFrame()?.code, CLOSE.ACCESS_LOST);
  } finally {
    await r.close();
  }
});

test("a storage failure is a server error, not lost access", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    const authorize = r.service.authorize;
    r.service.authorize = () => { throw new Error("disk gone"); };
    r.application.liveService.revalidate(r.adult.householdId);
    await client.until(() => client.ended);
    assert.equal(client.closeFrame()?.code, CLOSE.SERVER_ERROR);
    assert.equal((await open(r.port, { session: r.adult.sessionToken })).status, 503, "and the upgrade says unavailable");
    r.service.authorize = authorize;
  } finally {
    await r.close();
  }
});

test("the connection limit counts every socket; a wrong version gets 426", async () => {
  const r = await rig({ maxConnections: 1 });
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    assert.equal(phone.status, 101);
    assert.equal((await open(r.port, { session: r.laptop.sessionToken })).status, 503, "a second device past the limit");
    assert.equal((await open(r.port, { session: r.adult.sessionToken })).status, 101, "the same device still replaces its own");
    const old = await open(r.port, { session: r.adult.sessionToken, extraHeaders: "" });
    assert.equal(old.status, 101);
    const versioned = connect(r.port, "127.0.0.1");
    await once(versioned, "connect");
    versioned.write(`GET /api/live HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nOrigin: http://localhost\r\n\r\n`);
    const [answer] = await once(versioned, "data");
    assert.match(answer.toString(), /^HTTP\/1.1 426 Upgrade Required/);
    assert.match(answer.toString(), /Sec-WebSocket-Version: 13/);
    versioned.destroy();
  } finally {
    await r.close();
  }
});

test("a device reconnecting in a loop holds at most two sockets", async () => {
  const r = await rig({ maxConnections: 4 });
  const held = [];
  try {
    for (let index = 0; index < 12; index += 1) {
      // A client that ignores close frames and never ends its side.
      const socket = connect({ port: r.port, host: "127.0.0.1", allowHalfOpen: true });
      await once(socket, "connect");
      socket.on("error", () => {});
      socket.write(`GET /api/live HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nOrigin: http://localhost\r\n` +
        `Cookie: kin_session=${r.adult.sessionToken}\r\n\r\n`);
      await once(socket, "data");
      held.push(socket);
    }
    assert.ok(r.application.liveService.sockets.size <= 2, `held ${r.application.liveService.sockets.size}`);
    assert.equal((await open(r.port, { session: r.laptop.sessionToken })).status, 101, "another device still gets in");
  } finally {
    for (const socket of held) socket.destroy();
    await r.close();
  }
});

test("sync hints waiting behind a full socket are queued once", async () => {
  const r = await rig();
  try {
    const client = await open(r.port, { session: r.adult.sessionToken });
    client.socket.pause();
    const connection = r.application.liveService.connections.get(r.adult.deviceId);
    connection.blocked = true; // as if the socket refused more
    for (let index = 0; index < 1000; index += 1) r.application.liveService.eventsAccepted(r.adult.householdId, r.laptop.deviceId);
    assert.equal(connection.queue.length, 1, "one hint says it all");
    connection.flush();
    assert.equal(connection.queuedHint, false);
  } finally {
    await r.close();
  }
});

test("stopping the service doesn't wait on a peer that ignores the close", async () => {
  const r = await rig();
  const client = await open(r.port, { session: r.adult.sessionToken });
  client.socket.pause(); // never reads the close frame, never answers
  const started = Date.now();
  await r.close();
  assert.ok(Date.now() - started < 1500, `stopped in ${Date.now() - started} ms`);
});

test("closing the service closes live sockets", async () => {
  const r = await rig();
  const client = await open(r.port, { session: r.adult.sessionToken });
  await r.close();
  await client.until(() => client.ended);
  assert.equal(client.closeFrame()?.code, CLOSE.GOING_AWAY);
});

// ---- Typing frames (#122) and receipt hints (#121) ----------------------------------

const typingFrame = (device, extra = {}) => Buffer.from(JSON.stringify({ householdId: device.householdId, deviceId: device.deviceId, ciphertext: "x", ...extra }));
const sendRecord = (client, type, payload) => client.send(clientFrame(OPCODE.BINARY, encodeMessage(type, payload)));
const typing = (client) => client.records().filter((record) => record.type === LIVE_TYPE.TYPING);

test("a typing frame is relayed unchanged to the household's other devices, never back to its sender", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    await phone.until(() => phone.records().length === 1);
    await laptop.until(() => laptop.records().length === 1);
    const frame = typingFrame(r.adult);
    sendRecord(phone, LIVE_TYPE.TYPING, frame);
    await laptop.until(() => typing(laptop).length === 1);
    assert.deepEqual(Buffer.from(typing(laptop)[0].payload), frame, "relayed byte for byte");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(typing(phone).length, 0, "not echoed to the sender");
    assert.equal(phone.ended, false, "the sender stays connected");
  } finally {
    await r.close();
  }
});

test("a typing frame must be small, valid, and name the sender's own household and device", async () => {
  const r = await rig();
  try {
    for (const [payload, code] of [
      [Buffer.alloc(3000, 0x61), CLOSE.TOO_BIG],
      [Buffer.from("not json"), CLOSE.INVALID_DATA],
      [typingFrame(r.laptop), CLOSE.POLICY],
      [typingFrame(r.adult, { householdId: "other" }), CLOSE.POLICY],
      [Buffer.from("null"), CLOSE.POLICY],
    ]) {
      const client = await open(r.port, { session: r.adult.sessionToken });
      await client.until(() => client.records().length === 1);
      sendRecord(client, LIVE_TYPE.TYPING, payload);
      await client.until(() => client.ended);
      assert.equal(client.closeFrame()?.code, code);
    }
  } finally {
    await r.close();
  }
});

test("typing frames faster than a person types are dropped, and nothing is stored", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    await phone.until(() => phone.records().length === 1);
    await laptop.until(() => laptop.records().length === 1);
    for (let count = 0; count < 12; count += 1) sendRecord(phone, LIVE_TYPE.TYPING, typingFrame(r.adult, { n: count }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(typing(laptop).length, 4, "a burst of four, then dropped");
    assert.equal(phone.ended, false, "dropped, not closed");
    // The service keeps no typing state: nothing in the live service holds a frame.
    assert.deepEqual(Object.keys(r.application.liveService).filter((key) => /typing/i.test(key)), []);
  } finally {
    await r.close();
  }
});

test("a read-receipt change nudges the household's other devices with an empty record", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    await phone.until(() => phone.records().length === 1);
    await laptop.until(() => laptop.records().length === 1);
    r.application.liveService.receiptsChanged(r.adult.householdId, r.adult.deviceId);
    await laptop.until(() => laptop.records().length === 2);
    assert.equal(laptop.records()[1].type, LIVE_TYPE.RECEIPTS);
    assert.equal(laptop.records()[1].payload.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(phone.records().length, 1, "the writer isn't nudged");
  } finally {
    await r.close();
  }
});

// ---- Online now (#128) ---------------------------------------------------------------

const presenceRecords = (client) => client.records().filter((record) => record.type === LIVE_TYPE.PRESENCE);

test("a presence frame is relayed unchanged to the household's other devices, validated like typing", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    await phone.until(() => phone.records().length === 1);
    await laptop.until(() => laptop.records().length === 1);
    const frame = typingFrame(r.adult);
    sendRecord(phone, LIVE_TYPE.PRESENCE, frame);
    await laptop.until(() => presenceRecords(laptop).length === 1);
    assert.deepEqual(Buffer.from(presenceRecords(laptop)[0].payload), frame, "relayed byte for byte");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(presenceRecords(phone).length, 0, "not echoed to the sender");
    for (const [payload, code] of [
      [Buffer.alloc(3000, 0x61), CLOSE.TOO_BIG],
      [Buffer.from("not json"), CLOSE.INVALID_DATA],
      [typingFrame(r.laptop), CLOSE.POLICY],
      [typingFrame(r.adult, { householdId: "other" }), CLOSE.POLICY],
    ]) {
      const client = await open(r.port, { session: r.adult.sessionToken });
      await client.until(() => client.records().length === 1);
      sendRecord(client, LIVE_TYPE.PRESENCE, payload);
      await client.until(() => client.ended);
      assert.equal(client.closeFrame()?.code, code);
    }
  } finally {
    await r.close();
  }
});

test("presence is relayed and forgotten: nothing is written to the database or the logs", async () => {
  const r = await rig();
  const output = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info, write: process.stdout.write, errWrite: process.stderr.write };
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const laptop = await open(r.port, { session: r.laptop.sessionToken });
    await phone.until(() => phone.records().length === 1);
    await laptop.until(() => laptop.records().length === 1);
    const changes = () => r.application.store.db.prepare("SELECT total_changes() AS n").get().n;
    const before = changes();
    for (const name of ["log", "warn", "error", "info"]) console[name] = (...args) => { output.push(args.join(" ")); };
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { output.push(String(chunk)); return true; };
    for (let count = 0; count < 5; count += 1) sendRecord(phone, LIVE_TYPE.PRESENCE, typingFrame(r.adult, { n: count }));
    await laptop.until(() => presenceRecords(laptop).length === 5);
    Object.assign(console, { log: originals.log, warn: originals.warn, error: originals.error, info: originals.info });
    process.stdout.write = originals.write;
    process.stderr.write = originals.errWrite;
    assert.equal(changes(), before, "no row was written");
    assert.deepEqual(output.filter((line) => !line.includes("ok") && line.trim()).filter((line) => /presence|online|heartbeat/i.test(line)), [], "and nothing about it was logged");
    assert.deepEqual(Object.keys(r.application.liveService).filter((key) => /presence|online/i.test(key)), [], "the service holds no presence state");
  } finally {
    Object.assign(console, { log: originals.log, warn: originals.warn, error: originals.error, info: originals.info });
    process.stdout.write = originals.write;
    process.stderr.write = originals.errWrite;
    await r.close();
  }
});

test("a member with no chat access neither sends nor receives presence", async () => {
  const r = await rig();
  try {
    const invitation = r.service.createPairing(r.adult.sessionToken, { kind: "limited" });
    const claim = r.service.claimPairing({ code: invitation.code, credential: credential("child"), deviceLabel: "Tablet" });
    r.service.approvePairing(r.adult.sessionToken, invitation.pairingId, claim.version);
    const child = r.service.activateClaim(claim.claimToken);
    r.service.setChatPolicy(r.adult.sessionToken, { limited: "none", temporary: "write" }, r.adult.memberId);
    const phone = await open(r.port, { session: r.adult.sessionToken });
    const tablet = await open(r.port, { session: child.sessionToken });
    await phone.until(() => phone.records().length >= 1);
    await tablet.until(() => tablet.records().length >= 1 || tablet.ended);
    if (!tablet.ended) {
      sendRecord(phone, LIVE_TYPE.PRESENCE, typingFrame(r.adult));
      sendRecord(tablet, LIVE_TYPE.PRESENCE, typingFrame(child));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(presenceRecords(tablet).length, 0, "receives none");
      assert.equal(presenceRecords(phone).length, 0, "and its frame goes nowhere");
    }
  } finally {
    await r.close();
  }
});

// ---- Ephemeral envelope (#257, #258) ------------------------------------------------

import { EPHEMERAL_VERSION, SCOPE, decodeRequest, encodeDelivery, encodeRequest, CATEGORIES, EphemeralError } from "./live/ephemeral.mjs";

const SIGNAL = 7;
const categories = (extra = {}) => new Map([[SIGNAL, { name: "test", maxPayload: 64, burst: 3, refillMs: 60_000, scopes: [SCOPE.HOUSEHOLD, SCOPE.MEMBER, SCOPE.DEVICE], access: "chat", ...extra }]]);
const envelope = (scope, targetId, payload = "hi", extra = {}) => encodeRequest({ category: SIGNAL, scope, targetId, correlation: randomBytes(16), payload: Buffer.from(payload), ...extra });
const ephemeral = (client) => client.records().filter((record) => record.type === LIVE_TYPE.EPHEMERAL);
const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

async function household(options = {}) {
  const r = await rig({ ephemeralCategories: categories(options) });
  const invitation = r.service.createPairing(r.adult.sessionToken, { kind: "limited" });
  const claim = r.service.claimPairing({ code: invitation.code, credential: credential("tablet"), deviceLabel: "Tablet" });
  r.service.approvePairing(r.adult.sessionToken, invitation.pairingId, claim.version);
  r.tablet = r.service.activateClaim(claim.claimToken);
  r.phone = await open(r.port, { session: r.adult.sessionToken });
  r.laptopSocket = await open(r.port, { session: r.laptop.sessionToken });
  r.tabletSocket = await open(r.port, { session: r.tablet.sessionToken });
  for (const client of [r.phone, r.laptopSocket, r.tabletSocket]) await client.until(() => client.records().length >= 1);
  return r;
}

test("the envelope reads only what a category allows, and the sender is never taken from it", () => {
  const table = categories();
  const good = envelope(SCOPE.MEMBER, "ab".repeat(16));
  const request = decodeRequest(good, table);
  assert.equal(request.scope, SCOPE.MEMBER);
  assert.equal(request.targetId, "ab".repeat(16));
  assert.equal(request.payload.toString(), "hi");
  const bad = (bytes, reason) => assert.throws(() => decodeRequest(bytes, table), (error) => error instanceof EphemeralError && error.reason === reason, reason);
  const mutate = (change) => { const copy = Buffer.from(good); change(copy); return copy; };
  bad(good.subarray(0, 39), "malformed");
  bad(mutate((b) => { b[0] = 2; }), "version");
  bad(mutate((b) => { b[1] = 99; }), "category");
  bad(mutate((b) => { b[2] = 3; }), "scope");
  bad(mutate((b) => { b[3] = 1; }), "malformed");
  bad(Buffer.concat([good, Buffer.from("x")]), "malformed");
  bad(envelope(SCOPE.HOUSEHOLD, "ab".repeat(16)), "malformed");
  bad(envelope(SCOPE.DEVICE, null), "malformed");
  bad(envelope(SCOPE.HOUSEHOLD, null, "x".repeat(65)), "too_big");
  assert.throws(() => decodeRequest(good, CATEGORIES), (error) => error.reason === "category", "production has no categories");
  assert.equal(CATEGORIES.size, 0);
  const delivery = encodeDelivery({ categoryId: SIGNAL, scope: SCOPE.MEMBER, correlation: Buffer.alloc(16, 1), senderMemberId: "cd".repeat(16), senderDeviceId: "ef".repeat(16), payload: Buffer.from("yo") });
  assert.equal(delivery[0], EPHEMERAL_VERSION);
  assert.equal(delivery.subarray(20, 36).toString("hex"), "cd".repeat(16));
  assert.equal(delivery.subarray(36, 52).toString("hex"), "ef".repeat(16));
  assert.equal(delivery.subarray(56).toString(), "yo");
});

test("production accepts no ephemeral category: a client that sends one is closed", async () => {
  const r = await rig();
  try {
    const phone = await open(r.port, { session: r.adult.sessionToken });
    await phone.until(() => phone.records().length === 1);
    sendRecord(phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null));
    await phone.until(() => phone.ended);
    assert.equal(phone.closeFrame().code, CLOSE.UNSUPPORTED_DATA);
  } finally {
    await r.close();
  }
});

test("malformed, unknown-version and oversized envelopes close the socket with a code that says why", async () => {
  const r = await household();
  try {
    const cases = [
      [Buffer.alloc(10), CLOSE.INVALID_DATA],
      [(() => { const b = envelope(SCOPE.HOUSEHOLD, null); b[0] = 9; return b; })(), CLOSE.UNSUPPORTED_DATA],
      [(() => { const b = envelope(SCOPE.HOUSEHOLD, null); b[1] = 200; return b; })(), CLOSE.UNSUPPORTED_DATA],
      [envelope(SCOPE.HOUSEHOLD, null, "x".repeat(65)), CLOSE.TOO_BIG],
    ];
    for (const [payload, code] of cases) {
      const client = await open(r.port, { session: r.adult.sessionToken });
      await client.until(() => client.records().length >= 1);
      sendRecord(client, LIVE_TYPE.EPHEMERAL, payload);
      await client.until(() => client.ended);
      assert.equal(client.closeFrame().code, code);
    }
  } finally {
    await r.close();
  }
});

test("household, member and device scopes reach exactly the sockets they name, stamped with the sender", async () => {
  const r = await household();
  try {
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null, "everyone"));
    await r.laptopSocket.until(() => ephemeral(r.laptopSocket).length === 1);
    await r.tabletSocket.until(() => ephemeral(r.tabletSocket).length === 1);
    const delivered = ephemeral(r.laptopSocket)[0].payload;
    assert.equal(delivered.subarray(20, 36).toString("hex"), r.adult.memberId, "the sender is the session's member");
    assert.equal(delivered.subarray(36, 52).toString("hex"), r.adult.deviceId, "and its device");
    assert.equal(delivered.subarray(56).toString(), "everyone");
    assert.equal(ephemeral(r.phone).length, 0, "never back to the sender");

    // A member's own other device gets a member-addressed message too.
    sendRecord(r.tabletSocket, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.MEMBER, r.adult.memberId, "to the adult"));
    await r.phone.until(() => ephemeral(r.phone).length === 1);
    await r.laptopSocket.until(() => ephemeral(r.laptopSocket).length === 2);
    assert.equal(ephemeral(r.tabletSocket).length, 1, "the other member's device is not addressed");

    // One device only.
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.laptop.deviceId, "just the laptop"));
    await r.laptopSocket.until(() => ephemeral(r.laptopSocket).length === 3);
    await quiet();
    assert.equal(ephemeral(r.tabletSocket).length, 1);
    assert.equal(ephemeral(r.phone).length, 1);
  } finally {
    await r.close();
  }
});

test("a member or device that is foreign, unknown, offline or revoked gets nothing, and the sender is told nothing", async () => {
  const r = await household();
  try {
    const stranger = "11".repeat(16);
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.MEMBER, stranger));
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, stranger));
    // A device named by its member's id (or the reverse) is not a match.
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.tablet.memberId));
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.MEMBER, r.tablet.deviceId));
    await quiet();
    for (const client of [r.laptopSocket, r.tabletSocket, r.phone]) assert.equal(ephemeral(client).length, 0);
    assert.equal(r.phone.ended, false, "the sender is not closed or told");

    // Revoked: its socket closes, and a message to it goes nowhere.
    r.service.revokeDevice(r.adult.sessionToken, r.laptop.deviceId, r.adult.memberId);
    r.application.liveService.revalidate(r.adult.householdId);
    await r.laptopSocket.until(() => r.laptopSocket.ended);
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.laptop.deviceId));
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.MEMBER, r.adult.memberId));
    await quiet();
    assert.equal(r.phone.ended, false);
    assert.equal(ephemeral(r.tabletSocket).length, 0);
  } finally {
    await r.close();
  }
});

test("a second socket for a device replaces the first, so only the newest receives", async () => {
  const r = await household();
  try {
    const tab = await open(r.port, { session: r.laptop.sessionToken });
    await tab.until(() => tab.records().length >= 1);
    await r.laptopSocket.until(() => r.laptopSocket.ended);
    assert.equal(r.laptopSocket.closeFrame().code, CLOSE.REPLACED);
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.laptop.deviceId, "once"));
    await tab.until(() => ephemeral(tab).length === 1);
    assert.equal(ephemeral(r.laptopSocket).length, 0);
  } finally {
    await r.close();
  }
});

test("a message is never queued for a receiver that can't take it, and a sender over the rate is dropped", async () => {
  const r = await household({ burst: 2 });
  try {
    const connection = r.application.liveService.connections.get(r.laptop.deviceId);
    connection.blocked = true;
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.laptop.deviceId));
    await quiet();
    assert.equal(connection.queue.length, 0, "dropped, not queued");
    connection.blocked = false;
    for (let count = 0; count < 5; count += 1) sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.tablet.deviceId, `n${count}`));
    await r.tabletSocket.until(() => ephemeral(r.tabletSocket).length >= 1);
    await quiet();
    assert.equal(ephemeral(r.tabletSocket).length, 1, "one token was spent above; the burst of two leaves one");
  } finally {
    await r.close();
  }
});

test("access to the chat gates both sending and receiving, and a write category needs write", async () => {
  const r = await household({ access: "write" });
  try {
    r.service.setChatPolicy(r.adult.sessionToken, { limited: "read", temporary: "write" }, r.adult.memberId);
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null, "to a reader"));
    sendRecord(r.tabletSocket, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null, "from a reader"));
    await quiet();
    assert.equal(ephemeral(r.tabletSocket).length, 0, "a read-only member receives no write-category message");
    assert.equal(ephemeral(r.phone).length, 0, "and sends none");
    assert.equal(ephemeral(r.laptopSocket).length, 1, "the adult's laptop still gets the adult's");
  } finally {
    await r.close();
  }
});

test("ephemeral messages write nothing: no row, no log line, no state in the service", async () => {
  const r = await household();
  const output = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info, write: process.stdout.write, errWrite: process.stderr.write };
  try {
    const changes = () => r.application.store.db.prepare("SELECT total_changes() AS n").get().n;
    const before = changes();
    for (const name of ["log", "warn", "error", "info"]) console[name] = (...args) => { output.push(args.join(" ")); };
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { output.push(String(chunk)); return true; };
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null, "secret-signal"));
    await r.tabletSocket.until(() => ephemeral(r.tabletSocket).length === 1);
    Object.assign(console, { log: originals.log, warn: originals.warn, error: originals.error, info: originals.info });
    process.stdout.write = originals.write;
    process.stderr.write = originals.errWrite;
    assert.equal(changes(), before, "no row was written");
    assert.deepEqual(output.filter((line) => /secret-signal/.test(line)), [], "nothing was logged");
    assert.deepEqual(Object.keys(r.application.liveService).filter((key) => /ephemeral|signal/i.test(key)), ["ephemeralCategories"], "the service holds only its category table");
  } finally {
    Object.assign(console, { log: originals.log, warn: originals.warn, error: originals.error, info: originals.info });
    process.stdout.write = originals.write;
    process.stderr.write = originals.errWrite;
    await r.close();
  }
});

test("an unauthenticated or cross-origin socket cannot reach the ephemeral path at all", async () => {
  const r = await household();
  try {
    assert.equal((await open(r.port, {})).status, 401);
    assert.equal((await open(r.port, { session: r.adult.sessionToken, origin: "http://evil.example" })).status, 403);
  } finally {
    await r.close();
  }
});

test("a device or member of another household is never reached, even by its real ids", async () => {
  const r = await household();
  try {
    const foreign = r.service.bootstrap({ credential: credential("elsewhere"), deviceLabel: "Elsewhere" });
    const outsider = await open(r.port, { session: foreign.sessionToken });
    await outsider.until(() => outsider.records().length >= 1);
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, foreign.deviceId));
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.MEMBER, foreign.memberId));
    // And the other way: a foreign sender naming this household's ids.
    sendRecord(outsider, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.laptop.deviceId));
    sendRecord(outsider, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.MEMBER, r.adult.memberId));
    sendRecord(outsider, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null));
    await quiet();
    assert.equal(ephemeral(outsider).length, 0);
    for (const client of [r.phone, r.laptopSocket, r.tabletSocket]) assert.equal(ephemeral(client).length, 0);
    assert.equal(outsider.ended || r.phone.ended, false, "nobody was told anything");
  } finally {
    await r.close();
  }
});

test("access is re-checked at dispatch, even when nothing has closed the socket yet", async () => {
  const r = await household();
  try {
    // The receiver's device is revoked in the service; its socket is still open.
    r.service.revokeDevice(r.adult.sessionToken, r.laptop.deviceId, r.adult.memberId);
    assert.equal(r.laptopSocket.ended, false);
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.laptop.deviceId, "to a revoked device"));
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null, "to the household"));
    await r.tabletSocket.until(() => ephemeral(r.tabletSocket).length === 1);
    await quiet();
    assert.equal(ephemeral(r.laptopSocket).length, 0, "the revoked device got neither");

    // The sender's own device is revoked: its message goes nowhere and its socket closes.
    r.service.revokeDevice(r.adult.sessionToken, r.tablet.deviceId, r.adult.memberId);
    sendRecord(r.tabletSocket, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null, "from a revoked device"));
    await r.tabletSocket.until(() => r.tabletSocket.ended);
    await quiet();
    assert.equal(ephemeral(r.phone).length, 0);
  } finally {
    await r.close();
  }
});

test("the rate refills as time passes, keeps the part of an interval not yet earned, and a flood closes the connection", async () => {
  const r = await household({ burst: 2, refillMs: 1_000 });
  try {
    let time = 1_000_000;
    r.service.now = () => time;
    const sendOne = async (n) => { sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.tablet.deviceId, `m${n}`)); await quiet(); };
    const got = () => ephemeral(r.tabletSocket).length;
    await sendOne(1); await sendOne(2); await sendOne(3);
    assert.equal(got(), 2, "a burst of two");
    time += 1_500;
    await sendOne(4);
    assert.equal(got(), 3, "one token came back after 1.5 intervals");
    await sendOne(5);
    assert.equal(got(), 3, "and only one");
    time += 500; // the half interval carried over makes a whole one
    await sendOne(6);
    assert.equal(got(), 4, "the remainder was kept");
    // Buckets are per category and per connection: another connection has its own.
    sendRecord(r.laptopSocket, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.tablet.deviceId, "other sender"));
    await r.tabletSocket.until(() => got() === 5);
    // A flood is closed as abusive.
    for (let count = 0; count < 70; count += 1) sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.tablet.deviceId));
    await r.phone.until(() => r.phone.ended);
    assert.equal(r.phone.closeFrame().code, CLOSE.POLICY);
  } finally {
    await r.close();
  }
});

test("a member whose chat is switched off neither sends nor receives, and the service keeps no message", async () => {
  const r = await household();
  try {
    r.service.setChatPolicy(r.adult.sessionToken, { limited: "none", temporary: "write" }, r.adult.memberId);
    if (!r.tabletSocket.ended) {
      sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.MEMBER, r.tablet.memberId, "to a member without chat"));
      sendRecord(r.tabletSocket, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.HOUSEHOLD, null, "from a member without chat"));
      await quiet();
      assert.equal(ephemeral(r.tabletSocket).length, 0);
      assert.equal(ephemeral(r.phone).length, 0);
    }
    // After delivering, nothing the service holds contains the message.
    sendRecord(r.phone, LIVE_TYPE.EPHEMERAL, envelope(SCOPE.DEVICE, r.laptop.deviceId, "findme-1234"));
    await r.laptopSocket.until(() => ephemeral(r.laptopSocket).length === 1);
    for (const connection of r.application.liveService.connections.values()) {
      assert.equal(connection.queue.length, 0);
      for (const bucket of connection.ephemeralBuckets.values()) assert.deepEqual(Object.keys(bucket).sort(), ["drops", "refilledAt", "tokens"]);
    }
  } finally {
    await r.close();
  }
});

test("a category table with a missing or unsafe limit stops the service from starting", () => {
  const good = { name: "x", maxPayload: 64, burst: 2, refillMs: 1000, scopes: [SCOPE.HOUSEHOLD], access: "chat" };
  const start = (category, id = 3) => new LiveService({ service: {}, origin: "http://localhost", readSession() {}, ephemeralCategories: new Map([[id, category]]) });
  start(good);
  for (const bad of [{ ...good, maxPayload: undefined }, { ...good, maxPayload: 100_000 }, { ...good, burst: 0 }, { ...good, refillMs: undefined },
    { ...good, scopes: [] }, { ...good, scopes: [9] }, { ...good, access: "any" }, null])
    assert.throws(() => start(bad), RangeError);
  assert.throws(() => start(good, 300), RangeError);
});
