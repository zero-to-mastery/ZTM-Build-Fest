// The SNI parser (#729): byte-built ClientHellos in browsers' shapes, real
// hellos captured from Node's TLS client, every refusal the ADR lists, and a
// seeded fuzz run.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { connect } from "node:tls";
import { MAX_HELLO_BYTES, MAX_HELLO_RECORDS, Refusal, readClientHello } from "./sni.mjs";
import { isHostName } from "./ktun.mjs";
import {
  chromeLike, clientHelloMessage, echOuter, extension, firefoxLike, opensslLike, records, safariLike, serverName,
} from "./test-support/client-hello.mjs";

const named = (name) => ({ state: "name", name });
const refused = (reason) => ({ state: "refuse", reason });

test("browser-shaped hellos give their server name", () => {
  for (const [label, build] of [["chrome", chromeLike], ["firefox", firefoxLike], ["safari", safariLike], ["openssl", opensslLike]]) {
    const bytes = records(build("x.home.test"));
    assert.deepEqual(readClientHello(bytes), named("x.home.test"), label);
  }
  // The post-quantum key share makes Chrome's hello well over 1.2 KB.
  assert.ok(chromeLike("x.home.test").length > 1500);
});

test("names are lowercased, and a name needs LDH labels with no trailing dot", () => {
  assert.deepEqual(readClientHello(records(opensslLike("Smith.HOME.test"))), named("smith.home.test"));
  for (const bad of ["x.home.test.", ".x.home.test", "x..home", "-x.home.test", "x-.home.test", "x_y.home.test", "x y.test", `${"a".repeat(64)}.test`, "ü.test"])
    assert.deepEqual(readClientHello(records(opensslLike(bad))), refused(Refusal.MALFORMED), bad);
  const longest = Array.from({ length: 4 }, () => "a".repeat(62)).join(".") + ".a"; // 253 bytes
  assert.equal(longest.length, 253);
  assert.deepEqual(readClientHello(records(opensslLike(longest))), named(longest));
  assert.deepEqual(readClientHello(records(opensslLike(`${longest}c`))), refused(Refusal.MALFORMED));
});

test("a hello split across records and segments is read only when complete", () => {
  const message = chromeLike("x.home.test");
  const split = records(message, [300, 700, 1000]);
  for (let cut = 0; cut < split.length; cut += 1) assert.deepEqual(readClientHello(split.subarray(0, cut)), { state: "more" }, `cut at ${cut}`);
  assert.deepEqual(readClientHello(split), named("x.home.test"));
  // Bytes after the hello (the next flight, say) are allowed and untouched.
  assert.deepEqual(readClientHello(Buffer.concat([split, Buffer.from([23, 3, 3, 0, 1, 0])])), named("x.home.test"));
});

test("at most 4 records and 16 KiB", () => {
  const message = chromeLike("x.home.test");
  const four = records(message, [Math.ceil(message.length / 4)]);
  assert.deepEqual(readClientHello(four), named("x.home.test"));
  assert.deepEqual(readClientHello(records(message, [Math.ceil(message.length / 5)])), refused(Refusal.TOO_MANY_RECORDS));
  assert.equal(MAX_HELLO_RECORDS, 4);
  // A hello claiming more than the bound is refused before it is all read.
  const huge = clientHelloMessage({ extensions: [serverName("x.home.test"), extension(21, Buffer.alloc(MAX_HELLO_BYTES))] });
  assert.deepEqual(readClientHello(records(huge).subarray(0, 100)), refused(Refusal.TOO_LARGE));
  // Just inside the bound: 16,384 bytes on the wire in all.
  const fits = (padding) => records(clientHelloMessage({ extensions: [serverName("x.home.test"), extension(21, Buffer.alloc(padding))] }), [16_000]);
  let padding = 15_000;
  while (fits(padding + 1).length <= MAX_HELLO_BYTES) padding += 1;
  assert.equal(fits(padding).length <= MAX_HELLO_BYTES, true);
  assert.deepEqual(readClientHello(fits(padding)), named("x.home.test"));
  assert.notEqual(readClientHello(fits(padding + 40)).state, "name");
});

test("record headers: handshake type, major version 3, length 1 to 16,384", () => {
  const message = opensslLike("x.home.test");
  assert.deepEqual(readClientHello(records(message, undefined, { type: 23 })), refused(Refusal.NOT_TLS));
  assert.deepEqual(readClientHello(records(message, undefined, { version: 0x0201 })), refused(Refusal.MALFORMED));
  assert.deepEqual(readClientHello(records(message, undefined, { version: 0x0300 })), named("x.home.test"));
  const empty = Buffer.from([22, 3, 1, 0, 0]);
  assert.deepEqual(readClientHello(empty), refused(Refusal.MALFORMED));
  const over = Buffer.from([22, 3, 1, 0x40, 0x01]);
  assert.deepEqual(readClientHello(over), refused(Refusal.MALFORMED));
  // A handshake message that isn't a ClientHello.
  const serverHello = Buffer.from(message);
  serverHello[0] = 2;
  assert.deepEqual(readClientHello(records(serverHello)), refused(Refusal.MALFORMED));
  // Plain HTTP and SSL 2.0.
  assert.deepEqual(readClientHello(Buffer.from("GET / HTTP/1.1\r\n")), refused(Refusal.NOT_TLS));
  assert.deepEqual(readClientHello(Buffer.from([0x80, 0x2e, 0x01, 0x00, 0x02])), refused(Refusal.SSL2));
  // Handshake bytes after the ClientHello in its own records.
  assert.deepEqual(readClientHello(records(Buffer.concat([message, Buffer.from([20, 0, 0, 0])]))), refused(Refusal.MALFORMED));
});

test("every length inside the hello is checked", () => {
  const ok = { extensions: [serverName("x.home.test")] };
  assert.deepEqual(readClientHello(records(clientHelloMessage(ok))), named("x.home.test"));
  assert.deepEqual(readClientHello(records(clientHelloMessage({ ...ok, sessionId: Buffer.alloc(0) }))), named("x.home.test"));
  assert.deepEqual(readClientHello(records(clientHelloMessage({ ...ok, sessionId: Buffer.alloc(33) }))), refused(Refusal.MALFORMED));
  assert.deepEqual(readClientHello(records(clientHelloMessage({ ...ok, suites: [] }))), refused(Refusal.MALFORMED));
  assert.deepEqual(readClientHello(records(clientHelloMessage({ ...ok, compression: [] }))), refused(Refusal.MALFORMED));
  // An odd cipher-suite length.
  const odd = clientHelloMessage({ ...ok, suites: [0x1301] });
  const oddBytes = Buffer.from(odd);
  oddBytes.writeUInt16BE(3, 4 + 34 + 1 + 32);
  assert.deepEqual(readClientHello(records(oddBytes)), refused(Refusal.MALFORMED));
  // No extensions block at all: no SNI.
  assert.deepEqual(readClientHello(records(clientHelloMessage({ ...ok, withExtensions: false }))), refused(Refusal.NO_SNI));
  // Extensions without server_name.
  assert.deepEqual(readClientHello(records(clientHelloMessage({ extensions: [extension(23), extension(35)] }))), refused(Refusal.NO_SNI));
  // An extensions block that doesn't end at the end of the message.
  const short = Buffer.from(clientHelloMessage(ok));
  const at = 4 + 34 + 1 + 32 + 2 + 10 + 2;
  short.writeUInt16BE(short.readUInt16BE(at) - 1, at);
  assert.deepEqual(readClientHello(records(short)), refused(Refusal.MALFORMED));
  // An extension whose length runs past the block.
  assert.deepEqual(readClientHello(records(clientHelloMessage({ extensions: [serverName("x.home.test"), Buffer.from([0, 23, 0, 9])] }))), refused(Refusal.MALFORMED));
});

test("server_name: one extension, exactly one host_name entry", () => {
  const two = clientHelloMessage({ extensions: [serverName("x.home.test"), serverName("y.home.test")] });
  assert.deepEqual(readClientHello(records(two)), refused(Refusal.MALFORMED));
  const entries = (data) => records(clientHelloMessage({ extensions: [extension(0, data)] }));
  const entry = (type, name) => Buffer.concat([Buffer.from([type]), Buffer.from([0, name.length]), Buffer.from(name)]);
  const list = (...items) => { const body = Buffer.concat(items); return Buffer.concat([Buffer.from([body.length >> 8, body.length & 0xff]), body]); };
  assert.deepEqual(readClientHello(entries(list(entry(0, "x.home.test")))), named("x.home.test"));
  assert.deepEqual(readClientHello(entries(list(entry(0, "x.home.test"), entry(0, "y.home.test")))), refused(Refusal.MALFORMED));
  assert.deepEqual(readClientHello(entries(list(entry(1, "x.home.test")))), refused(Refusal.MALFORMED));
  assert.deepEqual(readClientHello(entries(list(entry(0, "")))), refused(Refusal.MALFORMED));
  assert.deepEqual(readClientHello(entries(Buffer.alloc(0))), refused(Refusal.MALFORMED));
  assert.deepEqual(readClientHello(entries(Buffer.from([0, 5, 0, 0, 1, 0x61]))), refused(Refusal.MALFORMED));
});

test("ECH: GREASE is skipped unread; real ECH's outer name is the only name read", () => {
  // GREASE ECH: the outer SNI is the real name, so it routes as usual.
  assert.deepEqual(readClientHello(records(chromeLike("x.home.test"))), named("x.home.test"));
  assert.deepEqual(readClientHello(records(chromeLike("x.home.test", { ech: null }))), named("x.home.test"));
  // Real ECH: the outer SNI is the ECH configuration's public name, never a
  // name the relay routes, so the relay refuses it (relay.test.mjs checks
  // the unrecognized_name answer end to end).
  assert.deepEqual(readClientHello(records(chromeLike("public.ech.example", { ech: echOuter(400) }))), named("public.ech.example"));
  // The ECH extension's contents are never parsed: garbage in it is fine.
  const garbage = clientHelloMessage({ extensions: [serverName("x.home.test"), extension(0xfe0d, Buffer.from([0xff, 0xff, 0xff]))] });
  assert.deepEqual(readClientHello(records(garbage)), named("x.home.test"));
});

/** Captures the first bytes Node's own TLS client sends. */
async function captureHello(options) {
  const server = createServer();
  const captured = new Promise((resolve) => server.once("connection", (socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      const result = readClientHello(bytes);
      if (result.state !== "more") { resolve({ bytes, result }); socket.destroy(); }
    });
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = connect({ port: server.address().port, host: "127.0.0.1", rejectUnauthorized: false, ...options });
  client.on("error", () => {});
  const value = await captured;
  client.destroy();
  server.close();
  return value;
}

test("real hellos captured from Node's TLS client", async () => {
  const plain = await captureHello({ servername: "x.home.test" });
  assert.deepEqual(plain.result, named("x.home.test"));
  const alpn = await captureHello({ servername: "Kin.Family.Test", ALPNProtocols: ["h2", "http/1.1"], minVersion: "TLSv1.3" });
  assert.deepEqual(alpn.result, named("kin.family.test"));
  const tunnel = await captureHello({ servername: "relay.home.test", ALPNProtocols: ["kin-tunnel/1"] });
  assert.deepEqual(tunnel.result, named("relay.home.test"));
  // Without a servername Node sends no SNI to an IP address.
  const none = await captureHello({});
  assert.deepEqual(none.result, refused(Refusal.NO_SNI));
});

/** xorshift32, so a failing fuzz case can be replayed from its seed. */
function random(seed) {
  let state = seed >>> 0 || 1;
  return (limit) => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state % limit;
  };
}

test("fuzz: mutated hellos never throw, hang or misreport", () => {
  const corpus = [
    records(chromeLike("x.home.test")), records(firefoxLike("y.home.test"), [500]), records(safariLike("kin.family.test"), [200, 400]),
    records(opensslLike("x.home.test")), records(chromeLike("x.home.test"), [600]),
  ];
  const next = random(0x4b494e31);
  const started = process.hrtime.bigint();
  const heap = process.memoryUsage().heapUsed;
  const counts = { name: 0, refuse: 0, more: 0 };
  let slowest = 0n;
  for (let iteration = 0; iteration < 20_000; iteration += 1) {
    const base = corpus[next(corpus.length)];
    let bytes = Buffer.from(base);
    const mutations = 1 + next(4);
    for (let index = 0; index < mutations; index += 1) {
      const at = next(bytes.length || 1);
      switch (next(7)) {
        case 0: bytes[at] ^= 1 << next(8); break;                                     // bit flip
        case 1: bytes[at] = next(256); break;                                         // byte set
        case 2: bytes = bytes.subarray(0, at); break;                                 // truncate
        case 3: bytes = Buffer.concat([bytes.subarray(0, at), Buffer.from([next(256)]), bytes.subarray(at)]); break; // insert
        case 4: bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + 1 + next(8))]); break;           // delete
        case 5: if (at + 1 < bytes.length) bytes.writeUInt16BE(next(65_536), at); break;                         // length field
        case 6: bytes = Buffer.concat([bytes, Buffer.alloc(next(20_000), next(256))]); break;                     // trailing junk
      }
    }
    if (bytes.length > MAX_HELLO_BYTES) bytes = bytes.subarray(0, MAX_HELLO_BYTES);
    const before = process.hrtime.bigint();
    let result;
    assert.doesNotThrow(() => { result = readClientHello(bytes); }, `iteration ${iteration}`);
    const spent = process.hrtime.bigint() - before;
    if (spent > slowest) slowest = spent;
    counts[result.state] += 1;
    assert.ok(["name", "refuse", "more"].includes(result.state));
    if (result.state === "name") assert.ok(isHostName(result.name), `iteration ${iteration} gave ${result.name}`);
    if (result.state === "refuse") assert.ok(Object.values(Refusal).includes(result.reason));
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.ok(seconds < 20, `fuzz took ${seconds}s`);
  assert.ok(slowest < 250_000_000n, `slowest parse took ${Number(slowest) / 1e6} ms`);
  // Bounded memory: a parse holds at most a 16 KiB copy, so 20,000 parses
  // leave nothing that grows with them.
  assert.ok(process.memoryUsage().heapUsed - heap < 64 * 1024 * 1024);
  assert.ok(counts.name > 0 && counts.refuse > 0 && counts.more > 0, JSON.stringify(counts));
});

test("fuzz: random bytes after a valid record header", () => {
  const next = random(7);
  for (let iteration = 0; iteration < 5_000; iteration += 1) {
    const length = next(MAX_HELLO_BYTES);
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) bytes[index] = next(256);
    if (length > 0) bytes[0] = 22;
    if (length > 1) bytes[1] = 3;
    if (length > 5) bytes[5] = 1;
    const result = readClientHello(bytes);
    assert.ok(["name", "refuse", "more"].includes(result.state));
  }
});
