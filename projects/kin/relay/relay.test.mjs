// The connection relay end to end on loopback (#728): a fake home server
// signs in over KTUN, a phone opens TLS to the relay for x.home.test, and
// the handshake completes with the home server's own certificate, which the
// relay never had. Then limits, replacement, keep-alive, flow control,
// registration and refusals.
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect as netConnect } from "node:net";
import test from "node:test";
import { connect } from "node:tls";
import { Code, ControlOp, encodeData, encodeFrame, keyHash, keyHashText, rawEd25519PublicKey, signEd25519, transferMessage } from "./ktun.mjs";
import { ConnectionRelay } from "./relay.mjs";
import { Registry } from "./registry.mjs";
import { UNRECOGNIZED_NAME_ALERT } from "./sni.mjs";
import { chromeLike, echOuter, records } from "./test-support/client-hello.mjs";
import { FakeHome } from "./test-support/fake-home.mjs";
import { holdTcpOnly } from "./test-support/ports.mjs";

const fixture = (name) => readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url));
const RELAY_TLS = { key: fixture("relay-test.key"), cert: fixture("relay-test.crt") };
const HOME_TLS = { key: fixture("home-test.key"), cert: fixture("home-test.crt") };
const HOME_FINGERPRINT = new X509Certificate(HOME_TLS.cert).fingerprint256;

/** Resolves when a socket closes (events.once would reject on its error). */
const closed = (socket) => new Promise((resolve) => socket.once("close", resolve));

async function waitFor(check, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startRelay(options = {}) {
  const relay = new ConnectionRelay({
    zone: "home.test", relayName: "relay.home.test", tls: RELAY_TLS, addresses: ["127.0.0.1", "::1"],
    resolveTxt: async () => [], certificateSeen: async () => null, ...options,
  });
  await relay.listen({ host: "127.0.0.1", tlsPort: 0, httpPort: 0, dnsPort: 0 });
  return relay;
}

function home(relay, options = {}) {
  return new FakeHome({ port: relay.ports.tls, relayName: "relay.home.test", relayCert: RELAY_TLS.cert, homeTls: HOME_TLS, ...options });
}

/** Binds `name` to a key in the registry directly. The task's test name
 * x.home.test has a one-letter label, shorter than a free name may be (3 to
 * 40), so it can't be claimed; claims are tested with longer names. */
function seed(relay, name, publicKey) {
  const today = relay.registry.today;
  relay.registry.sql.insertName.run(name, keyHash(publicKey), today, today);
}

/** A home server signed in, with `name` routed to it. */
async function homeWithName(relay, name = "x.home.test", options) {
  const server = home(relay, options);
  seed(relay, name, server.publicKey);
  assert.deepEqual(await server.connect(), [name]);
  return server;
}

/** A phone: TLS to the relay's port for `name`, trusting the home's cert. */
function phone(relay, name = "x.home.test", options = {}) {
  const socket = connect({ port: relay.ports.tls, host: "127.0.0.1", servername: name, ca: HOME_TLS.cert, ALPNProtocols: ["http/1.1"], ...options });
  socket.on("error", () => {});
  return socket;
}

async function phoneGet(relay, name) {
  const socket = phone(relay, name);
  await once(socket, "secureConnect");
  const fingerprint = socket.getPeerCertificate().fingerprint256;
  socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { text += chunk; });
  await once(socket, "end");
  return { fingerprint, text };
}

/** Raw bytes to port 443; resolves with everything sent back before close. */
function raw(relay, bytes) {
  return new Promise((resolve) => {
    const socket = netConnect(relay.ports.tls, "127.0.0.1", () => socket.write(bytes));
    const received = [];
    socket.on("data", (chunk) => received.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => resolve(Buffer.concat(received)));
  });
}

test("a phone's TLS handshake completes with the home server through the relay, never with the relay", async () => {
  const relay = await startRelay();
  const server = home(relay);
  try {
    seed(relay, "x.home.test", server.publicKey);
    assert.deepEqual(await server.connect(), ["x.home.test"], "READY names what the key holds");
    const opened = once(server, "open");
    const { fingerprint, text } = await phoneGet(relay, "X.Home.Test");
    assert.equal(fingerprint, HOME_FINGERPRINT, "the certificate the phone saw is the home server's");
    assert.match(text, /home server/);
    const [open] = await opened;
    assert.deepEqual(open, { family: 4, address: "127.0.0.1", name: "x.home.test" }, "OPEN carries the lowercase name and the phone's address");
    // The registry holds nothing about the connection but counts.
    relay.flush();
    const dump = JSON.stringify(["names", "domains", "retired", "counters", "errors", "waitlist"]
      .map((table) => relay.registry.db.prepare(`SELECT * FROM ${table}`).all()), (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : typeof value === "bigint" ? Number(value) : value));
    assert.ok(!dump.includes("127.0.0.1") && !dump.includes("::1"), "no client address on disk");
    assert.ok(!dump.includes("home server") && !dump.includes("GET"), "no byte of a stream on disk");
    const counters = relay.registry.db.prepare("SELECT name, connections, bytes_in, bytes_out FROM counters").all();
    assert.equal(counters.length, 1);
    assert.equal(counters[0].name, "x.home.test");
    assert.equal(counters[0].connections, 1);
    assert.ok(counters[0].bytes_in > 0 && counters[0].bytes_out > 0);
  } finally { server.close(); await relay.close(); }
});

test("refusals: unrouted names get unrecognized_name; malformed, SNI-less and real-ECH hellos get closed or refused", async () => {
  const relay = await startRelay();
  const server = await homeWithName(relay);
  try {
    const nobody = phone(relay, "nobody.home.test");
    const [error] = await once(nobody, "error");
    assert.match(error.code ?? error.message, /UNRECOGNIZED_NAME|unrecognized name/i);
    // Real ECH: the outer name is the ECH configuration's public name, which
    // the relay doesn't route, so it answers unrecognized_name.
    assert.deepEqual(await raw(relay, records(chromeLike("public.ech.example", { ech: echOuter(400) }))), UNRECOGNIZED_NAME_ALERT);
    // GREASE ECH carries the real name and is routed like any hello. The
    // hello's key shares are fixed test patterns, so the home server's TLS
    // refuses them with its own alert and the stream closes at once: wait
    // for the OPEN and the home server's answer, not for an open stream.
    const opened = once(server, "open");
    const answer = await raw(relay, records(chromeLike("x.home.test")));
    assert.deepEqual((await opened)[0], { family: 4, address: "127.0.0.1", name: "x.home.test" });
    assert.equal(answer[0], 0x15, "a TLS alert from the home server came back through the relay");
    assert.notDeepEqual(answer, UNRECOGNIZED_NAME_ALERT, "not the relay's own refusal");
    // Malformed, plain HTTP and no SNI: closed without a reply.
    assert.equal((await raw(relay, Buffer.from([22, 3, 1, 0, 0]))).length, 0);
    assert.equal((await raw(relay, Buffer.from("GET / HTTP/1.1\r\nHost: x.home.test\r\n\r\n"))).length, 0);
    const noSni = connect({ port: relay.ports.tls, host: "127.0.0.1", rejectUnauthorized: false });
    const [noSniError] = await once(noSni, "error");
    assert.match(noSniError.code, /ECONNRESET|socket hang up/i);
    relay.flush();
    const errors = relay.registry.errors();
    assert.ok(errors.unrouted >= 2 && errors["hello-malformed"] >= 1 && errors["hello-not-tls"] >= 1 && errors["hello-no-sni"] >= 1, JSON.stringify(errors));
  } finally { server.close(); await relay.close(); }
});

test("the relay's own name: a status line for browsers, a tunnel only with kin-tunnel/1 over TLS 1.3", async () => {
  const relay = await startRelay({ abuseContact: "abuse@relay.test" });
  try {
    const browser = connect({ port: relay.ports.tls, host: "127.0.0.1", servername: "relay.home.test", ca: RELAY_TLS.cert, ALPNProtocols: ["h2", "http/1.1"] });
    let text = "";
    browser.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
    await once(browser, "end");
    assert.match(text, /^HTTP\/1\.1 200 OK/);
    assert.match(text, /Kin connection relay for home\.test\. Abuse reports: abuse@relay\.test\n$/);
    // A tunnel over TLS 1.2 is refused with GOAWAY 1.
    const old = connect({ port: relay.ports.tls, host: "127.0.0.1", servername: "relay.home.test", ca: RELAY_TLS.cert, ALPNProtocols: ["kin-tunnel/1"], maxVersion: "TLSv1.2" });
    await once(old, "secureConnect");
    old.write(Buffer.from("4b54554e01000000", "hex"));
    const chunks = [];
    old.on("data", (chunk) => chunks.push(chunk));
    await once(old, "close");
    assert.equal(Buffer.concat(chunks).toString("hex"), "09000000000000000800000000000000" + "01000000");
  } finally { await relay.close(); }
});

test("sign-in: a bad signature gets GOAWAY 2; a signature from another TLS session can't be replayed", async () => {
  const relay = await startRelay();
  try {
    const forger = home(relay, { tamperSignature: (signature) => { const copy = Buffer.from(signature); copy[0] ^= 1; return copy; } });
    const refused = once(forger, "goaway");
    forger.connect().catch(() => {});
    assert.deepEqual((await refused)[0], { lastStream: 0, code: Code.AUTH_FAILED });
    await forger.closed;
    // Replay: sign for one TLS session, present it on another.
    const { privateKey } = generateKeyPairSync("ed25519");
    let captured = null;
    const first = home(relay, { privateKey, tamperSignature: (signature) => (captured = signature) });
    await first.connect();
    first.close();
    const second = home(relay, { privateKey, tamperSignature: () => captured });
    const replay = once(second, "goaway");
    second.connect().catch(() => {});
    assert.equal((await replay)[0].code, Code.AUTH_FAILED);
    second.close();
    relay.flush();
    assert.equal(relay.registry.errors()["auth-failed"], 2);
  } finally { await relay.close(); }
});

test("a newer tunnel for the same key replaces the older one, whose phones are closed", async () => {
  const relay = await startRelay();
  const { privateKey } = generateKeyPairSync("ed25519");
  const older = await homeWithName(relay, "x.home.test", { privateKey });
  const newer = home(relay, { privateKey });
  try {
    const stuck = phone(relay);
    await once(stuck, "secureConnect");
    const replaced = once(older, "goaway");
    const phoneClosed = closed(stuck);
    assert.deepEqual(await newer.connect(), ["x.home.test"], "the newer tunnel gets the key's names");
    assert.equal((await replaced)[0].code, Code.REPLACED);
    await older.closed;
    await phoneClosed;
    const { fingerprint } = await phoneGet(relay, "x.home.test");
    assert.equal(fingerprint, HOME_FINGERPRINT);
    assert.equal(relay.stats().tunnels, 1);
  } finally { older.close(); newer.close(); await relay.close(); }
});

test("keep-alive: PING after pingSeconds of silence; a tunnel silent for idleSeconds is closed", async () => {
  const relay = await startRelay({ hello: { pingSeconds: 1, idleSeconds: 2 } });
  const alive = home(relay);
  const dead = home(relay, { answerPings: false });
  try {
    await alive.connect();
    await dead.connect();
    const pinged = await waitFor(() => alive.frames.includes(8), "a PING");
    assert.ok(pinged);
    await dead.closed;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(alive.socket.destroyed, false, "a tunnel that answers stays up");
    assert.equal(relay.stats().tunnels, 1);
    relay.flush();
    assert.equal(relay.registry.errors()["tunnel-dead"], 1);
  } finally { alive.close(); dead.close(); await relay.close(); }
});

test("flow control: the relay stops reading a phone with no credit, and holds at most a window per stream", async () => {
  const window = 32 * 1024;
  const relay = await startRelay({ hello: { streamWindow: window, connectionWindow: 4 * window } });
  const server = await homeWithName(relay, "x.home.test", { grantCredit: false });
  try {
    // Without grants, the home server's TLS handshake still fits in a window.
    const socket = phone(relay);
    await once(socket, "secureConnect");
    socket.write(Buffer.alloc(1024 * 1024, 1));
    const tunnel = [...relay.tunnels.values()][0];
    const stream = await waitFor(() => [...tunnel.streams.values()][0], "the stream");
    await waitFor(() => stream.send.available === 0, "the stream's credit to run out");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(stream.queued <= 64 * 1024 + 16_384, `at most one socket read waits (${stream.queued})`);
    assert.equal(stream.socket.isPaused(), true, "the phone's socket is paused, so TCP pushes back");
    // Credit arrives: the relay reads on.
    const entry = server.streams.get(stream.id);
    server.options.grantCredit = true;
    server.raw(Buffer.concat([encodeFrame(6, 0, stream.id, Buffer.from([0, 0, 1, 0])), encodeFrame(6, 0, 0, Buffer.from([0, 0, 1, 0]))]));
    await waitFor(() => entry.recv.remaining < window, "more data once credit is granted");
    socket.destroy();
  } finally { server.close(); await relay.close(); }
});

test("flow control towards a phone that doesn't read: credit comes back only as it takes the bytes", async () => {
  const window = 32 * 1024;
  const relay = await startRelay({ hello: { streamWindow: window, connectionWindow: 8 * window } });
  const server = await homeWithName(relay);
  try {
    const socket = phone(relay);
    await once(socket, "secureConnect");
    socket.write("BIG 4000000");
    socket.pause();
    const tunnel = [...relay.tunnels.values()][0];
    const stream = await waitFor(() => [...tunnel.streams.values()][0], "the stream");
    const entry = server.streams.get(stream.id);
    await waitFor(() => entry.pending.length > 0 && entry.send.available === 0, "the home server to run out of credit");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const held = stream.unpassed + stream.down.reduce((sum, bytes) => sum + bytes.length, 0);
    assert.ok(held <= window, `bytes held for the phone stay within one window (${held})`);
    let received = 0;
    socket.on("data", (chunk) => { received += chunk.length; });
    socket.resume();
    await waitFor(() => received >= 4_000_000, "all 4 MB once the phone reads");
  } finally { server.close(); await relay.close(); }
});

test("limits: open connections per name, new connections per client per minute, bandwidth", async () => {
  const relay = await startRelay({ limits: { connectionsPerName: 2, connectionsPerClientPerMinute: 3 } });
  const server = await homeWithName(relay);
  try {
    const first = phone(relay);
    const second = phone(relay);
    await Promise.all([once(first, "secureConnect"), once(second, "secureConnect")]);
    const third = phone(relay);
    await closed(third);
    assert.equal(third.encrypted && third.authorized, false, "the third connection to the name is refused");
    first.destroy(); second.destroy();
    await waitFor(() => relay.stats().streams === 0, "streams to close");
    const fourth = phone(relay);
    await closed(fourth);
    relay.flush();
    const errors = relay.registry.errors();
    assert.equal(errors["limit-name-connections"], 1);
    assert.equal(errors["limit-client-rate"], 1, "the fourth new connection from one client in a minute is refused");
  } finally { server.close(); await relay.close(); }

  const slow = await startRelay({ limits: { bytesPerSecondPerName: 100_000 } });
  const slowHome = await homeWithName(slow);
  try {
    const socket = phone(slow);
    await once(socket, "secureConnect");
    const started = Date.now();
    socket.write("BIG 350000");
    let received = 0;
    socket.on("data", (chunk) => { received += chunk.length; });
    await waitFor(() => received >= 350_000, "the download", 15_000);
    // A 200 KB burst, then 100 KB/s: at least about 1.5 s.
    assert.ok(Date.now() - started >= 1200, `sustained bandwidth is limited (${Date.now() - started} ms)`);
  } finally { slowHome.close(); await slow.close(); }

  const capped = await startRelay({ limits: { bytesPer30DaysPerName: 2_000 } });
  const cappedHome = await homeWithName(capped);
  try {
    const { text } = await phoneGet(capped, "x.home.test");
    assert.match(text, /home server/);
    capped.flush();
    const refused = phone(capped);
    await closed(refused);
    capped.flush();
    assert.equal(capped.registry.errors()["limit-name-bandwidth"], 1, "over 30 days' bytes, new connections are refused");
  } finally { cappedHome.close(); await capped.close(); }
});

test("limits: tunnel sign-ins per source per hour", async () => {
  const relay = await startRelay({ limits: { signInsPerSourcePerHour: 2 } });
  try {
    const a = home(relay); await a.connect(); a.close();
    const b = home(relay); await b.connect(); b.close();
    const c = home(relay);
    const refused = once(c, "goaway");
    c.connect().catch(() => {});
    assert.equal((await refused)[0].code, Code.LIMIT);
    c.close();
  } finally { await relay.close(); }
});

test("near the stream limit the relay sends GOAWAY and routes again after the home server reconnects", async () => {
  const relay = await startRelay({ streamLimit: 2 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const server = await homeWithName(relay, "x.home.test", { privateKey });
  try {
    const goaway = once(server, "goaway");
    await phoneGet(relay, "x.home.test");
    await phoneGet(relay, "x.home.test");
    assert.deepEqual((await goaway)[0], { lastStream: 2, code: Code.NONE });
    const refused = phone(relay);
    const [error] = await once(refused, "error");
    assert.match(error.code ?? error.message, /UNRECOGNIZED_NAME|unrecognized name/i);
    const again = home(relay, { privateKey });
    await again.connect();
    assert.equal((await phoneGet(relay, "x.home.test")).fingerprint, HOME_FINGERPRINT);
    again.close();
  } finally { server.close(); await relay.close(); }
});

test("protocol errors close the tunnel with GOAWAY 1", async () => {
  const relay = await startRelay();
  try {
    for (const bad of [
      encodeFrame(4, 0, 1, Buffer.alloc(21)),                // OPEN from the home server
      encodeData(9, Buffer.from("x")),                       // DATA on a stream never opened
      encodeFrame(8, 2, 0, Buffer.alloc(8)),                 // PING with an undefined flag
      Buffer.concat([encodeFrame(6, 0, 0, Buffer.alloc(4))]), // WINDOW of zero
      encodeFrame(10, 0, 0, Buffer.from("0100000001050000", "hex")), // a CONTROL request carrying a status
    ]) {
      const server = home(relay);
      await server.connect();
      const goaway = once(server, "goaway");
      server.raw(bad);
      assert.equal((await goaway)[0].code, Code.PROTOCOL_ERROR, bad.toString("hex"));
      await server.closed;
    }
    const server = home(relay);
    await server.connect();
    const answer = await new Promise((resolve) => {
      server.requests.set(7, resolve);
      server.raw(encodeFrame(10, 0, 0, Buffer.from("0700000063000000", "hex")));
    });
    assert.equal(answer.status, Code.PROTOCOL_ERROR, "an unknown op is answered, not fatal");
    server.close();
  } finally { await relay.close(); }
});

test("registration: claims, one name per key, retirement, transfer, per-source limits", async () => {
  const relay = await startRelay({ limits: { claimsPerSourcePerDay: 2 } });
  const a = home(relay);
  const b = home(relay);
  try {
    await a.connect();
    await b.connect();
    assert.equal((await a.control(ControlOp.CLAIM, { name: "www.home.test" })).status, Code.NAME_NOT_ALLOWED, "reserved");
    assert.equal((await a.control(ControlOp.CLAIM, { name: "ab.home.test" })).status, Code.NAME_NOT_ALLOWED, "too short");
    assert.equal((await a.control(ControlOp.CLAIM, { name: "x.other.test" })).status, Code.NAME_NOT_ALLOWED, "outside the zone");
    assert.deepEqual(await a.control(ControlOp.CLAIM, { name: "smith.home.test" }), { status: Code.NONE, names: ["smith.home.test"] });
    assert.deepEqual(a.names, ["smith.home.test"], "READY is sent again when the routed names change");
    assert.equal((await a.control(ControlOp.CLAIM, { name: "smith.home.test" })).status, Code.NONE, "claiming your own name again is fine");
    assert.equal((await a.control(ControlOp.CLAIM, { name: "jones.home.test" })).status, Code.LIMIT, "one free name per key");
    assert.equal((await b.control(ControlOp.CLAIM, { name: "smith.home.test" })).status, Code.NAME_TAKEN);
    assert.equal((await b.control(ControlOp.CLAIM, { name: "jones.home.test" })).status, Code.NONE);
    // Released: retired for good, even for the same key.
    assert.deepEqual(await b.control(ControlOp.RELEASE, { name: "jones.home.test" }), { status: Code.NONE, names: [] });
    assert.equal((await b.control(ControlOp.CLAIM, { name: "jones.home.test" })).status, Code.NAME_TAKEN);
    // Two new names from this address today; the third is refused.
    assert.equal((await b.control(ControlOp.CLAIM, { name: "brown.home.test" })).status, Code.LIMIT);
    // SET_CAA reaches DNS.
    assert.equal((await a.control(ControlOp.SET_CAA, { name: "smith.home.test", accountUri: "https://acme.test/acct/9" })).status, Code.NONE);
    assert.deepEqual(relay.registry.dnsInfo("smith.home.test"), { routed: true, caaAccountUri: "https://acme.test/acct/9" });
    assert.equal((await b.control(ControlOp.SET_CAA, { name: "smith.home.test", accountUri: "https://evil.test/1" })).status, Code.NAME_TAKEN);
    // TRANSFER to a new key, signed by the new key.
    const next = generateKeyPairSync("ed25519").privateKey;
    const newKey = rawEd25519PublicKey(next);
    const forged = signEd25519(generateKeyPairSync("ed25519").privateKey, transferMessage("smith.home.test", a.publicKey, newKey));
    assert.equal((await a.control(ControlOp.TRANSFER, { name: "smith.home.test", newKey, signature: forged })).status, Code.AUTH_FAILED);
    const signature = signEd25519(next, transferMessage("smith.home.test", a.publicKey, newKey));
    assert.deepEqual(await a.control(ControlOp.TRANSFER, { name: "smith.home.test", newKey, signature }), { status: Code.NONE, names: [] });
    assert.deepEqual(relay.registry.dnsInfo("smith.home.test"), { routed: true, caaAccountUri: null }, "CAA is cleared until the new key sets one");
    const moved = home(relay, { privateKey: next });
    assert.deepEqual(await moved.connect(), ["smith.home.test"]);
    moved.close();
  } finally { a.close(); b.close(); await relay.close(); }
});

test("own domains: routed after the TXT record proves the key, checked again daily", async () => {
  const txt = new Map();
  const relay = await startRelay({ resolveTxt: async (name) => { if (!txt.has(name)) throw Object.assign(new Error("no"), { code: "ENOTFOUND" }); return txt.get(name); } });
  const server = home(relay);
  try {
    await server.connect();
    assert.equal((await server.control(ControlOp.ADD_DOMAIN, { name: "kin.family.test" })).status, Code.NAME_NOT_ALLOWED, "no TXT record yet");
    assert.equal((await server.control(ControlOp.ADD_DOMAIN, { name: "x.home.test" })).status, Code.NAME_NOT_ALLOWED, "not inside the relay's zone");
    txt.set("_kin-relay.kin.family.test", [["something-else"], [keyHashText(server.publicKey)]]);
    assert.deepEqual(await server.control(ControlOp.ADD_DOMAIN, { name: "kin.family.test" }), { status: Code.NONE, names: ["kin.family.test"] });
    assert.equal((await phoneGet(relay, "kin.family.test")).fingerprint, HOME_FINGERPRINT);
    // Another key can't take it while the TXT record still names this one.
    const other = home(relay);
    await other.connect();
    txt.set("_kin-relay.kin.family.test", [[keyHashText(server.publicKey)], [keyHashText(other.publicKey)]]);
    assert.equal((await other.control(ControlOp.ADD_DOMAIN, { name: "kin.family.test" })).status, Code.NAME_TAKEN);
    // The household points it at the other key: it moves.
    txt.set("_kin-relay.kin.family.test", [[keyHashText(other.publicKey)]]);
    assert.deepEqual(await other.control(ControlOp.ADD_DOMAIN, { name: "kin.family.test" }), { status: Code.NONE, names: ["kin.family.test"] });
    await waitFor(() => server.names.length === 0, "the first tunnel to lose the domain");
    assert.deepEqual(await other.control(ControlOp.REMOVE_DOMAIN, { name: "kin.family.test" }), { status: Code.NONE, names: [] });
    other.close();
  } finally { server.close(); await relay.close(); }
});

test("CHECK (#719): answers what a claim would, binds nothing, and is limited per key", async () => {
  const txt = new Map();
  const relay = await startRelay({ limits: { checksPerKeyPerMinute: 6 }, resolveTxt: async (name) => { if (!txt.has(name)) throw Object.assign(new Error("no"), { code: "ENOTFOUND" }); return txt.get(name); } });
  const a = home(relay);
  const b = home(relay);
  try {
    await a.connect();
    await b.connect();
    const check = async (server, name) => (await server.control(ControlOp.CHECK, { name })).status;
    assert.equal(await check(a, "smith.home.test"), Code.NONE, "free");
    assert.equal(relay.registry.keyOf("smith.home.test"), null, "a check binds nothing");
    assert.deepEqual(a.names, [], "and routes nothing");
    assert.equal(await check(a, "www.home.test"), Code.NAME_NOT_ALLOWED, "reserved");
    assert.equal((await a.control(ControlOp.CLAIM, { name: "smith.home.test" })).status, Code.NONE);
    assert.equal(await check(a, "smith.home.test"), Code.NONE, "your own name");
    assert.equal(await check(b, "smith.home.test"), Code.NAME_TAKEN, "someone else's");
    assert.equal(await check(a, "jones.home.test"), Code.LIMIT, "one free name per key");
    assert.equal(await check(b, "kin.family.test"), Code.UNKNOWN_NAME, "an own domain whose TXT record the relay can't see yet");
    txt.set("_kin-relay.kin.family.test", [[keyHashText(b.publicKey)]]);
    assert.equal(await check(b, "kin.family.test"), Code.NONE, "the TXT record names this key");
    assert.equal(relay.registry.keyOf("kin.family.test"), null);
    assert.equal(await check(b, "x.home.test.other"), Code.UNKNOWN_NAME, "a name outside the zone is an own domain");
    assert.equal(await check(b, "relay.home.test"), Code.NAME_NOT_ALLOWED, "the relay's own name");
    assert.equal(await check(b, "anything.home.test"), Code.NONE);
    assert.equal(await check(b, "anything.home.test"), Code.LIMIT, "the per-key limit");
    assert.equal(await check(a, "other.home.test"), Code.LIMIT, "each key has its own count; a still holds a name");
  } finally { a.close(); b.close(); await relay.close(); }
});

test("suspension: an operator's suspension closes the tunnel with GOAWAY 5 and refuses sign-in", async () => {
  const relay = await startRelay();
  const { privateKey } = generateKeyPairSync("ed25519");
  const server = await homeWithName(relay, "x.home.test", { privateKey });
  try {
    assert.ok(relay.registry.suspend("x.home.test"));
    const goaway = once(server, "goaway");
    relay.minuteTick();
    assert.equal((await goaway)[0].code, Code.SUSPENDED);
    const again = home(relay, { privateKey });
    const refused = once(again, "goaway");
    again.connect().catch(() => {});
    assert.equal((await refused)[0].code, Code.SUSPENDED);
    again.close();
    assert.equal(relay.registry.keyOf("x.home.test").toString("hex"), relay.registry.keyOf("x.home.test").toString("hex"), "never moved to another key");
  } finally { server.close(); await relay.close(); }
});

test("a home server's GOAWAY drains its tunnel", async () => {
  const relay = await startRelay();
  const server = await homeWithName(relay);
  try {
    server.sendGoaway();
    await server.closed;
    await waitFor(() => relay.stats().tunnels === 0 && relay.stats().routes.length === 0, "the tunnel to go");
  } finally { server.close(); await relay.close(); }
});

test("port 80 redirects to https and forwards nothing", async () => {
  const relay = await startRelay();
  try {
    const response = await new Promise((resolve, reject) => {
      request({ port: relay.ports.http, host: "127.0.0.1", path: "/join?x=1", headers: { host: "x.home.test" } }, resolve).on("error", reject).end();
    });
    assert.equal(response.statusCode, 301);
    assert.equal(response.headers.location, "https://x.home.test/join?x=1");
    response.resume();
    const bad = await new Promise((resolve, reject) => {
      request({ port: relay.ports.http, host: "127.0.0.1", path: "/", headers: { host: "bad_host" } }, resolve).on("error", reject).end();
    });
    assert.equal(bad.statusCode, 400);
    bad.resume();
  } finally { await relay.close(); }
});

test("the daily sweep frees names that never got a certificate and rechecks own domains", async () => {
  const clock = { now: Date.now() };
  const seen = new Map([["brown.home.test", true], ["smith.home.test", false], ["jones.home.test", null]]);
  const txt = new Map();
  const registry = new Registry({ zone: "home.test", now: () => clock.now, newNamesPerWeek: 0 });
  const relay = await startRelay({ registry, certificateSeen: async (name) => seen.get(name), resolveTxt: async (name) => txt.get(name) ?? [] });
  const servers = [home(relay), home(relay), home(relay)];
  try {
    for (const server of servers) await server.connect();
    const [smith, brown, jones] = servers;
    assert.equal((await smith.control(ControlOp.CLAIM, { name: "smith.home.test" })).status, Code.NONE);
    assert.equal((await brown.control(ControlOp.CLAIM, { name: "brown.home.test" })).status, Code.NONE);
    assert.equal((await jones.control(ControlOp.CLAIM, { name: "jones.home.test" })).status, Code.NONE);
    txt.set("_kin-relay.kin.family.test", [[keyHashText(brown.publicKey)]]);
    assert.equal((await brown.control(ControlOp.ADD_DOMAIN, { name: "kin.family.test" })).status, Code.NONE);
    clock.now += 7 * 86_400_000;
    txt.delete("_kin-relay.kin.family.test");
    await relay.dailySweep();
    await waitFor(() => smith.names.length === 0, "smith's uncertified name to be freed");
    assert.equal(registry.keyOf("smith.home.test"), null, "freed, not retired: it may be claimed again");
    assert.ok(registry.keyOf("brown.home.test"), "a name with a certificate stays");
    assert.ok(registry.keyOf("jones.home.test"), "when CT can't tell, nothing is freed");
    assert.deepEqual(brown.names, ["brown.home.test"], "the domain whose TXT record went away no longer routes");
    assert.equal(relay.stats().addressesHeld > 0, true);
  } finally { for (const server of servers) server.close(); await relay.close(); registry.close(); }
});

test("a tunnel handshake the client aborts (an untrusted certificate) doesn't keep the relay from closing", async () => {
  const relay = await startRelay();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // No `ca`: the client refuses the relay's test certificate mid-handshake.
      const socket = connect({ port: relay.ports.tls, host: "127.0.0.1", servername: "relay.home.test", ALPNProtocols: ["kin-tunnel/1"] });
      const [error] = await once(socket, "error");
      assert.match(error.code, /SELF_SIGNED|UNABLE_TO_VERIFY/);
    }
  } finally {
    const started = Date.now();
    await relay.close();
    assert.ok(Date.now() - started < 2000, "close() ends the handed-over sockets at once");
  }
});

test("on shutdown every home server reads GOAWAY 8 before its tunnel closes", async () => {
  const relay = await startRelay();
  const servers = [await homeWithName(relay, "x.home.test"), await homeWithName(relay, "y.home.test")];
  const goaways = servers.map((server) => new Promise((resolve) => server.once("goaway", (frame) => { resolve(frame.code); server.close(); })));
  const closing = relay.close();
  assert.deepEqual(await Promise.all(goaways), [Code.SHUTTING_DOWN, Code.SHUTTING_DOWN]);
  const started = Date.now();
  await closing;
  assert.ok(Date.now() - started < 1500, "close() doesn't wait the full two seconds once the home servers have gone");
});

test("a start that fails closes what it had opened, so nothing keeps the process alive (#469)", async () => {
  // DNS on a port TCP already has: TLS and HTTP listen first, then DNS fails.
  const { taken, release } = await holdTcpOnly();
  const relay = new ConnectionRelay({
    zone: "home.test", relayName: "relay.home.test", tls: RELAY_TLS, addresses: ["127.0.0.1"],
    resolveTxt: async () => [], certificateSeen: async () => null,
  });
  try {
    // Should it start after all, it is closed, so the test fails instead of
    // hanging on an open relay.
    const started = relay.listen({ host: "127.0.0.1", tlsPort: 0, httpPort: 0, dnsPort: taken }).then(async (ports) => { await relay.close(); return ports; });
    await assert.rejects(started, (error) => error.code === "EADDRINUSE" && error.syscall === "listen");
    assert.equal(relay.edge.listening, false, "the TLS listener is closed");
    assert.equal(relay.redirect.listening, false, "the HTTP listener is closed");
    // The DNS UDP socket on that number is closed too: it can be bound again.
    const udp = createSocket("udp4");
    await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(taken, "127.0.0.1", resolve); });
    await new Promise((resolve) => udp.close(resolve));
  } finally {
    relay.registry.close();
    await release();
  }
});
