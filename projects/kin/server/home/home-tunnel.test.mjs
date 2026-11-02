// The home server's side of the tunnel, end to end on loopback (#733):
// the real connection relay (relay/relay.mjs), a Kin server in home mode
// with its tunnel and certificate manager (home-server.mjs), the in-process
// ACME server, and a phone that connects to the relay with SNI and talks
// HTTPS and the live WebSocket to Kin through it. Nothing reaches the
// internet. Every test has a time limit and closes what it opened, so a
// failure can't leave Windows CI waiting.
import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { connect as tlsConnect } from "node:tls";
import { ConnectionRelay } from "../../relay/relay.mjs";
import { Registry } from "../../relay/registry.mjs";
import { keyHash } from "../../relay/ktun.mjs";
import { startAcmeTestServer } from "../acme/acme-test-server.mjs";
import { CertificateStore } from "../acme/keys.mjs";
import { createHttpsTransport } from "../acme/transport.mjs";
import { DurableStore } from "../durable-store.mjs";
import { LIVE_TYPE } from "../live/live-service.mjs";
import { parseMessage } from "../live/websocket.mjs";
import { PairingService } from "../pairing-service.mjs";
import { createKinServer } from "../server.mjs";
import { startHomeServer } from "./home-server.mjs";
import { resolveHomeSettings } from "./settings.mjs";
import { TunnelClient } from "./tunnel-client.mjs";
import { loadOrCreateHomeKey } from "./home-key.mjs";

const TIMEOUT = { timeout: 60_000 };
const fixture = (name) => readFileSync(new URL(`../../relay/test-fixtures/${name}`, import.meta.url));
const RELAY_TLS = { key: fixture("relay-test.key"), cert: fixture("relay-test.crt") };
const HOME_TLS = { key: fixture("home-test.key"), cert: fixture("home-test.crt") };
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const FAST_BACKOFF = { minMs: 50, maxMs: 400, resetMs: 60_000 };

async function waitFor(check, what, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startRelay(t, { registry, port = 0, hello, limits } = {}) {
  const relay = new ConnectionRelay({
    zone: "home.test", relayName: "relay.home.test", tls: RELAY_TLS, addresses: ["127.0.0.1"],
    resolveTxt: async () => [], certificateSeen: async () => null, ...(registry ? { registry } : {}), ...(hello ? { hello } : {}), ...(limits ? { limits } : {}),
  });
  await relay.listen({ host: "127.0.0.1", tlsPort: port, httpPort: null, dnsPort: null });
  t.after(() => relay.close());
  return relay;
}

/** Binds `name` to `publicKey` in the relay's registry directly (a name the
 * fixture certificate covers, such as x.home.test, is too short to claim). */
function seed(registry, name, publicKey) {
  registry.sql.insertName.run(name, keyHash(publicKey), registry.today, registry.today);
}

/**
 * A Kin server in home mode with one household, its loopback listener, and
 * its tunnel to `relayPort`. With `certificate: "fixture"` it starts with the
 * relay tests' home certificate (x.home.test); otherwise it gets one from
 * `acme` through the relay.
 */
async function startHome(t, { relayPort, name, certificate = "fixture", acme = null, trustedProxies, registry, tunnel = {} }) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "kin-home-tunnel-"));
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("phone"), deviceLabel: "Phone" });
  const application = createKinServer({
    store: new DurableStore(":memory:"), service, mode: "home", origin: `https://${name}`, ...(trustedProxies ? { trustedProxies } : {}),
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const settings = resolveHomeSettings({ format: 1, relay: `relay.home.test:${relayPort}`, zone: "home.test", name, acmeTermsAgreed: true }, {});
  if (certificate === "fixture") await new CertificateStore(dataDirectory).saveCertificate({ key: createPrivateKey(HOME_TLS.key), chainPem: HOME_TLS.cert.toString("utf8") });
  if (registry) seed(registry, name, (await import("../../relay/ktun.mjs")).rawEd25519PublicKey(await loadOrCreateHomeKey(dataDirectory)));
  const events = [];
  const home = await startHomeServer({
    application, dataDirectory, settings, log: (event) => events.push(event),
    connectHost: "127.0.0.1", relayCa: RELAY_TLS.cert,
    directoryUrl: acme?.directoryUrl ?? "http://127.0.0.1:9/directory",
    acmeTransport: createHttpsTransport({ allowLoopbackHttp: true, timeoutMs: 10_000 }),
    ctTransport: async () => { throw Object.assign(new Error("no CT search in tests"), { code: "ct-unavailable" }); },
    certificates: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))) },
    tunnel: { backoff: FAST_BACKOFF, interfaces: () => ({}), ...tunnel },
  });
  t.after(async () => {
    await home.stop();
    application.server.closeAllConnections?.();
    await new Promise((resolve) => application.server.close(resolve));
    application.store.close();
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { home, application, service, adult, dataDirectory, events, port: application.server.address().port };
}

/** An HTTPS request from a phone: TCP to the relay, SNI `name`, TLS with the
 * home server, trusting only `ca`. */
function phoneRequest(relayPort, name, ca, { method = "GET", path = "/health", headers = {}, body, onResponse } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: "127.0.0.1", port: relayPort, servername: name, ca, method, path, agent: false,
      headers: { host: name, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...headers },
    }, (response) => {
      onResponse?.(response);
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), socket: response.socket }));
      response.on("error", reject);
    });
    request.setTimeout(15_000, () => request.destroy(new Error("phone request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

/** The live channel from a phone: a WebSocket upgrade over TLS through the
 * relay. Resolves with the status and the first server message. */
async function phoneLive(relayPort, name, ca, session) {
  const socket = tlsConnect({ host: "127.0.0.1", port: relayPort, servername: name, ca, ALPNProtocols: ["http/1.1"] });
  socket.on("error", () => {});
  await once(socket, "secureConnect");
  socket.write(`GET /api/live HTTP/1.1\r\nHost: ${name}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: https://${name}\r\nCookie: kin_session=${session}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); });
  const result = await waitFor(() => {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return null;
    const status = Number(buffer.subarray(0, end).toString().split(" ")[1]);
    const rest = buffer.subarray(end + 4);
    if (status !== 101) return { status };
    if (rest.length < 2) return null;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (rest.length < 4) return null; length = rest.readUInt16BE(2); offset = 4; }
    if (rest.length < offset + length) return null;
    return { status, message: parseMessage(rest.subarray(offset, offset + length)) };
  }, "the live channel's greeting");
  socket.destroy();
  return result;
}

/** Every byte the relay handles: phones' connections at its edge, and the
 * tunnel as it reads it (after its own TLS, i.e. the KTUN frames). */
function recordRelayBytes(relay) {
  const chunks = [];
  relay.edge.on("connection", (socket) => socket.on("data", (chunk) => chunks.push(Buffer.from(chunk))));
  const watched = new WeakSet();
  const watchTunnels = () => {
    for (const tunnel of relay.tunnels.values())
      if (!watched.has(tunnel.socket)) { watched.add(tunnel.socket); tunnel.socket.on("data", (chunk) => chunks.push(Buffer.from(chunk))); }
  };
  return { chunks, watchTunnels, all: () => Buffer.concat(chunks) };
}

test("end to end: claim, CAA and a certificate through the relay; HTTPS and the live channel; the relay sees no plaintext", TIMEOUT, async (t) => {
  const relay = await startRelay(t);
  const recorder = recordRelayBytes(relay);
  // The CA validates TLS-ALPN-01 by connecting to the relay's port, exactly
  // as phones do. Its account URLs are https, as a real CA's are.
  const acme = await startAcmeTestServer({ validationPort: relay.ports.tls, holdPolls: 0, accountBase: "https://acme.test" });
  t.after(() => acme.close());
  const name = "fern.home.test";
  const { home, adult, events } = await startHome(t, { relayPort: relay.ports.tls, name, certificate: "acme", acme });

  // The tunnel signs in, claims the free name, sets CAA, and gets a certificate.
  await waitFor(() => home.certificates.status().state === "valid", "a certificate");
  recorder.watchTunnels();
  const status = home.status();
  assert.equal(status.tunnel.state, "connected");
  assert.equal(status.tunnel.routed, true);
  assert.deepEqual(status.tunnel.names, [name]);
  assert.equal(status.tunnel.lastError, null);
  assert.equal(status.tunnel.relay, `relay.home.test:${relay.ports.tls}`);
  assert.deepEqual(relay.stats().routes, [name]);
  const accountUrl = status.certificate.accountUrl;
  assert.match(accountUrl, /^https:\/\/acme\.test\/account\//);
  assert.equal(relay.registry.dnsInfo(name).caaAccountUri, accountUrl, "the relay's DNS names the home server's ACME account before the order");
  assert.equal(acme.state.validations, 1, "TLS-ALPN-01 passed through the relay");
  assert.ok(events.some((event) => event.event === "home_tunnel_caa_set"));
  assert.ok(events.some((event) => event.event === "home_certificate_renewed"));
  for (const event of events) assert.doesNotMatch(JSON.stringify(event), /127\.0\.0\.1/, "the home server logs no address");

  // A phone: TLS end to end with the home server's new certificate.
  const health = await phoneRequest(relay.ports.tls, name, acme.caPem);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok" });
  assert.equal(health.socket.getPeerCertificate().subjectaltname, `DNS:${name}`);
  // A real API route with the household's session.
  const session = await phoneRequest(relay.ports.tls, name, acme.caPem, {
    path: "/api/status", headers: { origin: `https://${name}`, cookie: `kin_session=${adult.sessionToken}` },
  });
  assert.equal(session.status, 200, session.body.toString());
  assert.equal(JSON.parse(session.body).identity.memberId, adult.memberId);
  // The live channel.
  const live = await phoneLive(relay.ports.tls, name, acme.caPem, adult.sessionToken);
  assert.equal(live.status, 101);
  assert.equal(live.message.type, LIVE_TYPE.HELLO);

  // The relay handled every one of those bytes and could read none of them.
  const seen = recorder.all();
  assert.ok(seen.length > 2000, "the recorder saw the traffic");
  for (const marker of ["HTTP/1.1", "GET /", "/api/status", "/api/live", "Upgrade: websocket", "kin_session", adult.sessionToken, '"status":"ok"'])
    assert.equal(seen.indexOf(marker), -1, `the relay never saw ${JSON.stringify(marker)}`);
});

test("the phone's address from OPEN reaches rate limits; X-Forwarded-For is ignored on tunnel streams", TIMEOUT, async (t) => {
  const registry = new Registry({ zone: "home.test", path: ":memory:" });
  t.after(() => registry.close());
  const relay = await startRelay(t, { registry });
  // The loopback listener trusts 127.0.0.1 as a proxy, as a hosted
  // deployment behind Caddy would: the tunnel must not inherit that.
  const { home, application, port } = await startHome(t, { relayPort: relay.ports.tls, name: "x.home.test", registry, trustedProxies: "127.0.0.1" });
  await waitFor(() => home.tunnel.status().routed, "the tunnel");
  const keys = [];
  const usernameAvailable = application.service.usernameAvailable.bind(application.service);
  application.service.usernameAvailable = (username, rateKey) => { keys.push(rateKey); return usernameAvailable(username, rateKey); };
  const body = JSON.stringify({ username: "fern" });
  const forwarded = { origin: "https://x.home.test", "x-forwarded-for": "198.51.100.7" };

  const first = await phoneRequest(relay.ports.tls, "x.home.test", HOME_TLS.cert, { method: "POST", path: "/api/account/username", headers: forwarded, body });
  assert.equal(first.status, 200, first.body.toString());
  assert.deepEqual(keys, ["127.0.0.1"], "the key is the phone's address from OPEN, not the forwarded header and not unknown");
  // The limit is counted for that address: 30 checks, then 429.
  let last;
  for (let index = 1; index <= 30; index += 1)
    last = await phoneRequest(relay.ports.tls, "x.home.test", HOME_TLS.cert, { method: "POST", path: "/api/account/username", headers: forwarded, body });
  assert.equal(last.status, 429);
  assert.ok(keys.every((key) => key === "127.0.0.1"));

  // Direct connections on the loopback listener keep today's rules: from a
  // trusted proxy, the forwarded address is the key.
  const direct = await new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/account/username", agent: false,
      headers: { host: "x.home.test", "content-type": "application/json", "content-length": body.length, ...forwarded } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end(body);
  });
  assert.equal(direct, 200);
  assert.equal(keys.at(-1), "198.51.100.7");
});

test("the home server reconnects after the relay restarts", TIMEOUT, async (t) => {
  const registry = new Registry({ zone: "home.test", path: ":memory:" });
  t.after(() => registry.close());
  const first = await startRelay(t, { registry });
  const port = first.ports.tls;
  const { home } = await startHome(t, { relayPort: port, name: "x.home.test", registry });
  await waitFor(() => home.tunnel.status().routed, "the first tunnel");
  assert.equal((await phoneRequest(port, "x.home.test", HOME_TLS.cert)).status, 200);

  // The tunnel is lost. Whether the home server read GOAWAY 8 first or only
  // saw the connection end depends on the platform's timing (relay.test.mjs
  // checks that GOAWAY 8 is sent and flushed); either way it must come back.
  const lost = [];
  home.tunnel.on("status", (status) => { if (!status.connected && status.lastError) lost.push(status.lastError.code); });
  await first.close();
  await waitFor(() => lost.length, "the tunnel to be lost");
  assert.ok(["relay-shutting-down", "connection-lost", "relay-unreachable"].includes(lost[0]), lost[0]);

  const second = await startRelay(t, { registry, port });
  await waitFor(() => home.tunnel.status().routed, "the tunnel back on the restarted relay");
  assert.equal(second.stats().tunnels, 1);
  assert.equal(home.tunnel.status().lastError, null);
  assert.equal((await phoneRequest(port, "x.home.test", HOME_TLS.cert)).status, 200);
});

test("a newer tunnel replaces an older one: after a wake on the same client, and from another copy of the key", TIMEOUT, async (t) => {
  const registry = new Registry({ zone: "home.test", path: ":memory:" });
  t.after(() => registry.close());
  const relay = await startRelay(t, { registry });
  // After being replaced it waits a random time up to the longest backoff;
  // here that is ~30 s (random 0.99), longer than the test, so it doesn't take
  // the tunnel back while the other copy is checked.
  const { home, dataDirectory } = await startHome(t, {
    relayPort: relay.ports.tls, name: "x.home.test", registry, tunnel: { backoff: { minMs: 50, maxMs: 30_000 }, random: () => 0.99 },
  });
  await waitFor(() => home.tunnel.status().routed, "the tunnel");
  const before = [...relay.tunnels.values()][0];

  // The computer woke (or the network changed): a fresh tunnel at once; the
  // relay replaces the old one and the client doesn't count it as an error.
  home.tunnel.reconnectNow("wake");
  await waitFor(() => before.closed && relay.stats().tunnels === 1 && home.tunnel.status().routed, "the replacement");
  assert.notEqual([...relay.tunnels.values()][0], before);
  assert.equal(home.tunnel.status().lastError, null);
  assert.equal((await phoneRequest(relay.ports.tls, "x.home.test", HOME_TLS.cert)).status, 200);

  // Another home server with the same key (a restored backup running
  // elsewhere) takes the tunnel; this one sees "replaced" and backs off long.
  const other = new TunnelClient({
    relay: { host: "relay.home.test", port: relay.ports.tls }, name: "x.home.test", freeName: false,
    privateKey: await loadOrCreateHomeKey(dataDirectory), connectHost: "127.0.0.1", ca: RELAY_TLS.cert, interfaces: () => ({}),
  });
  const opened = [];
  other.on("stream", (stream) => { opened.push(stream.open); stream.destroy(); });
  const replaced = new Promise((resolve) => home.tunnel.on("status", (status) => { if (status.lastError?.code === "replaced") resolve(status); }));
  other.start();
  t.after(() => other.stop());
  const status = await replaced;
  await waitFor(() => other.status().routed, "the other copy to hold the name");
  assert.equal(status.connected, false);
  const wait = Date.parse(status.nextAttemptAt) - Date.parse(status.since);
  assert.ok(wait > 25_000 && wait <= 30_000, `a replaced tunnel waits from the longest backoff, not the first step (${wait} ms)`);
  assert.equal(home.tunnel.status().connected, false, "and doesn't take the tunnel back meanwhile");
  // Phones now reach the other copy.
  await phoneRequest(relay.ports.tls, "x.home.test", HOME_TLS.cert).catch(() => {});
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], { family: 4, address: "127.0.0.1", name: "x.home.test" });
});

test("back-pressure: a large response to a phone that stops reading stalls at the source, not in the tunnel or the relay", TIMEOUT, async (t) => {
  const registry = new Registry({ zone: "home.test", path: ":memory:" });
  t.after(() => registry.close());
  // The smallest windows KTUN allows: one full DATA frame per stream.
  // No bandwidth cap: the test is about windows, not the relay's rate limit.
  const relay = await startRelay(t, { registry, hello: { streamWindow: 16_384, connectionWindow: 32_768 }, limits: { bytesPerSecondPerName: 1e10 } });
  const { home, application } = await startHome(t, { relayPort: relay.ports.tls, name: "x.home.test", registry });
  await waitFor(() => home.tunnel.status().routed, "the tunnel");
  // A response far larger than any socket buffer on the way, made only as
  // fast as it is read (Kin's own static files are smaller than the
  // operating system's loopback buffers, which would hide back-pressure).
  const SIZE = 24 * 1024 * 1024;
  const CHUNK = 64 * 1024;
  const pattern = Buffer.alloc(CHUNK, 0);
  for (let index = 0; index < CHUNK; index += 1) pattern[index] = (index * 7) & 0xff;
  let produced = 0;
  const [kin] = application.server.listeners("request");
  application.server.removeAllListeners("request");
  application.server.on("request", (request, response) => {
    if (request.url !== "/large") { kin(request, response); return; }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": SIZE });
    const source = new Readable({
      read() {
        if (produced >= SIZE) { this.push(null); return; }
        produced += CHUNK;
        this.push(pattern);
      },
    });
    source.pipe(response);
  });

  let paused;
  let received = 0;
  const digest = createHash("sha256");
  const reading = phoneRequest(relay.ports.tls, "x.home.test", HOME_TLS.cert, {
    path: "/large",
    onResponse: (response) => {
      response.on("data", (chunk) => { received += chunk.length; digest.update(chunk); });
      response.pause();
      paused = response;
    },
  });
  await waitFor(() => paused, "the response headers");
  // The phone isn't reading. Let the bytes go as far as they can.
  let last = -1;
  await waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const settled = produced === last;
    last = produced;
    return settled;
  }, "the source to stall");
  assert.ok(produced < SIZE / 2, `the source stopped early (${produced} of ${SIZE} bytes made)`);
  const homeStream = [...home.tunnel.current.streams.values()][0];
  const relayStream = [...[...relay.tunnels.values()][0].streams.values()][0];
  assert.ok(homeStream && relayStream, "the stream is open on both sides");
  assert.ok(homeStream.unacknowledged <= 16_384, `the home server sent at most one window ahead (${homeStream.unacknowledged})`);
  const relayHeld = relayStream.unpassed + relayStream.down.reduce((sum, bytes) => sum + bytes.length, 0);
  assert.ok(relayHeld <= 16_384, `the relay holds at most one window (${relayHeld})`);
  assert.ok(homeStream.outgoingBytes <= 64 * 1024, `the home TLS socket was pushed back (${homeStream.outgoingBytes} queued)`);

  paused.resume();
  const response = await reading;
  assert.equal(response.status, 200);
  assert.equal(received, SIZE, "every byte arrived");
  const expected = createHash("sha256");
  for (let offset = 0; offset < SIZE; offset += CHUNK) expected.update(pattern);
  assert.equal(digest.digest("hex"), expected.digest("hex"), "in order");
});
