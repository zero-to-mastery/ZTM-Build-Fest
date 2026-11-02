// The home tunnel's parts (#734–#736): home settings, the home key, client
// addresses for rate limits, and the client's resilience against the real
// relay (and a deliberately broken one): backoff, wake and network-change
// reconnects, keep-alive, refusals, stopping, and home mode under Node's
// permission model. Every test has a time limit and closes what it opened.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";
import {
  ALPN, Code, FrameReader, FrameType, encodeGoaway, encodeHello, encodeReady, keyHashText, rawEd25519PublicKey,
} from "../../relay/ktun.mjs";
import { ConnectionRelay } from "../../relay/relay.mjs";
import { clientKey } from "../client-key.mjs";
import { APP_ROOT } from "../permissions.mjs";
import { canonicalPath } from "../path-safety.mjs";
import { HOME_KEY_FILE, loadOrCreateHomeKey } from "./home-key.mjs";
import { softwareVersionNumber } from "./home-server.mjs";
import {
  DEFAULT_RELAY, DEFAULT_ZONE, LETS_ENCRYPT_DIRECTORY, homeOrigin, homeSettingsPath, isFreeName, loadHomeSettings, resolveHomeSettings,
} from "./settings.mjs";
import { TunnelClient, networkFingerprint } from "./tunnel-client.mjs";

const TIMEOUT = { timeout: 60_000 };
const fixture = (name) => readFileSync(new URL(`../../relay/test-fixtures/${name}`, import.meta.url));
const RELAY_TLS = { key: fixture("relay-test.key"), cert: fixture("relay-test.crt") };

// What each test has to stop before its temporary folders are removed.
const stopFirst = new WeakMap();

function temporary(t) {
  const directory = canonicalPath(mkdtempSync(join(tmpdir(), "kin-home-")));
  t.after(async () => {
    // node:test runs t.after hooks in the order they were added, and this one
    // is added before the test starts its service. So it stops the service
    // itself; otherwise a failing test would remove the folder under it.
    for (const stop of stopFirst.get(t)?.splice(0) ?? []) await stop();
    // A killed service on Windows lets go of its files a moment after it is
    // reported as exited. The promise rm retries through that; rmSync in
    // Node 24.18 and earlier (and 25.1) gives up on the first EPERM there.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return directory;
}

// Stops a test's service when the test ends, before its folders are removed.
function stopBeforeCleanup(t, stop) {
  if (!stopFirst.has(t)) stopFirst.set(t, []);
  stopFirst.get(t).push(stop);
}

async function waitFor(check, what, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startRelay(t, options = {}) {
  const relay = new ConnectionRelay({
    zone: "home.test", relayName: "relay.home.test", tls: RELAY_TLS, addresses: ["127.0.0.1"],
    resolveTxt: async () => [], certificateSeen: async () => null, ...options,
  });
  await relay.listen({ host: "127.0.0.1", tlsPort: 0, httpPort: null, dnsPort: null });
  t.after(() => relay.close());
  return relay;
}

function client(t, port, options = {}) {
  const tunnel = new TunnelClient({
    relay: { host: "relay.home.test", port }, name: "fern.home.test", freeName: true,
    privateKey: generateKeyPairSync("ed25519").privateKey, connectHost: "127.0.0.1", ca: RELAY_TLS.cert,
    backoff: { minMs: 20, maxMs: 80 }, interfaces: () => ({}), ...options,
  });
  t.after(() => tunnel.stop());
  return tunnel;
}

// ------------------------------------------------------------------ settings

test("home settings: defaults, the file, environment overrides, free names and own domains", TIMEOUT, async (t) => {
  const none = resolveHomeSettings(null, {});
  assert.equal(none.configured, false);
  assert.deepEqual(none.relay, { host: DEFAULT_RELAY, port: 443 });
  assert.equal(none.zone, DEFAULT_ZONE);
  assert.equal(none.acmeDirectory, LETS_ENCRYPT_DIRECTORY);
  assert.equal(none.acmeTermsAgreed, false);

  const free = resolveHomeSettings({ format: 1, name: "Fern.home.kin.journeytocode.io", acmeTermsAgreed: true }, {});
  assert.equal(free.name, "fern.home.kin.journeytocode.io");
  assert.equal(free.freeName, true);
  assert.equal(free.configured, true);
  assert.equal(free.acmeTermsAgreed, true);
  const own = resolveHomeSettings({ format: 1, name: "kin.smith.family" }, {});
  assert.equal(own.freeName, false);
  assert.equal(isFreeName("a.b.home.test", "home.test"), false, "two labels under the zone is not a free name");

  const env = { KIN_HOME_RELAY: "relay.example.org:8443", KIN_HOME_ZONE: "home.example.org", KIN_HOME_NAME: "fern.home.example.org", KIN_HOME_ACME_DIRECTORY: "https://ca.example.org/dir", KIN_HOME_ACME_TERMS_AGREED: "true" };
  const overridden = resolveHomeSettings({ format: 1, name: "other.home.kin.journeytocode.io" }, env);
  assert.deepEqual(overridden.relay, { host: "relay.example.org", port: 8443 });
  assert.equal(overridden.name, "fern.home.example.org");
  assert.equal(overridden.freeName, true);
  assert.equal(overridden.acmeDirectory, "https://ca.example.org/dir");
  assert.equal(overridden.acmeTermsAgreed, true);

  for (const [file, envValues, pattern] of [
    [{ format: 2 }, {}, /format 2/],
    [[], {}, /JSON object/],
    [null, { KIN_HOME_NAME: "not a name" }, /host name/],
    [null, { KIN_HOME_NAME: "x.home.test", KIN_HOME_RELAY: "relay.home.test:0" }, /port/],
    [null, { KIN_HOME_NAME: "x.home.test", KIN_HOME_ACME_DIRECTORY: "http://ca.example.org/" }, /https/],
    [null, { KIN_HOME_NAME: "x.home.test", KIN_HOME_ACME_TERMS_AGREED: "maybe" }, /true or false/],
    [null, { KIN_HOME_NAME: DEFAULT_RELAY }, /relay's own/],
  ]) assert.throws(() => resolveHomeSettings(file, envValues), (error) => error.code === "home_settings_invalid" && pattern.test(error.message), JSON.stringify([file, envValues]));

  assert.equal(homeOrigin(free, undefined), "https://fern.home.kin.journeytocode.io");
  assert.equal(homeOrigin(free, "https://fern.home.kin.journeytocode.io/"), "https://fern.home.kin.journeytocode.io");
  assert.throws(() => homeOrigin(free, "https://kin.journeytocode.io"), { code: "home_settings_invalid" });

  const directory = temporary(t);
  assert.equal((await loadHomeSettings(directory, {})).configured, false, "no file is fine");
  mkdirSync(join(directory, "home"));
  writeFileSync(homeSettingsPath(directory), `{\r\n  "format": 1,\r\n  "name": "fern.home.test",\r\n  "zone": "home.test"\r\n}\r\n`);
  const loaded = await loadHomeSettings(directory, {});
  assert.equal(loaded.name, "fern.home.test");
  assert.equal(loaded.freeName, true);
  writeFileSync(homeSettingsPath(directory), "{ not json");
  await assert.rejects(loadHomeSettings(directory, {}), { code: "home_settings_invalid" });
});

test("the home key is made once, owner-only, and a damaged one is refused rather than replaced", TIMEOUT, async (t) => {
  const directory = temporary(t);
  const key = await loadOrCreateHomeKey(directory);
  assert.equal(key.asymmetricKeyType, "ed25519");
  const path = join(directory, "home", HOME_KEY_FILE);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, "home")).mode & 0o777, 0o700);
  }
  const again = await loadOrCreateHomeKey(directory);
  assert.ok(rawEd25519PublicKey(again).equals(rawEd25519PublicKey(key)), "the same key on every start");
  writeFileSync(path, "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n");
  await assert.rejects(loadOrCreateHomeKey(directory), { code: "home_key_invalid" });
  assert.equal(softwareVersionNumber("1.6.0"), 0x010600);
});

// ------------------------------------------------------------ client address

test("rate limits key on a tunnel stream's OPEN address, per IPv4 address or IPv6 /64, never on X-Forwarded-For", TIMEOUT, async () => {
  const { trustTunnelPeer } = await import("../client-key.mjs");
  const trusted = new Set(["127.0.0.1"]);
  const tunneled = (address) => { const socket = { remoteAddress: address }; trustTunnelPeer(socket, address); return socket; };
  const forwarded = { "x-forwarded-for": "198.51.100.7" };
  assert.equal(clientKey({ socket: tunneled("203.0.113.9"), headers: forwarded }, trusted), "203.0.113.9");
  // The relay's OPEN text form for IPv6 has no zero compression.
  assert.equal(clientKey({ socket: tunneled("2001:db8:a:b:1:2:3:4"), headers: forwarded }, trusted), "2001:db8:a:b::/64");
  assert.equal(clientKey({ socket: tunneled("2001:db8:a:b:0:0:0:9"), headers: {} }, trusted), "2001:db8:a:b::/64", "one limit per /64");
  // Even a tunnel address that is itself a "trusted proxy" doesn't open the header.
  assert.equal(clientKey({ socket: tunneled("127.0.0.1"), headers: forwarded }, trusted), "127.0.0.1");
  assert.equal(clientKey({ socket: tunneled("not an address"), headers: forwarded }, trusted), "unknown");
  // Direct connections keep today's rules.
  assert.equal(clientKey({ socket: { remoteAddress: "127.0.0.1" }, headers: forwarded }, trusted), "198.51.100.7");
  assert.equal(clientKey({ socket: { remoteAddress: "203.0.113.9" }, headers: forwarded }, trusted), "203.0.113.9");
});

// --------------------------------------------------------------- resilience

test("an unreachable relay: waiting with full-jitter backoff that doubles to the cap, and the error in status", TIMEOUT, async (t) => {
  // A port nothing listens on.
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const delays = [];
  const tunnel = client(t, port, { random: () => 1 });
  tunnel.on("status", (status) => {
    if (status.state === "waiting" && status.nextAttemptAt) delays.push(Date.parse(status.nextAttemptAt) - Date.parse(status.since));
  });
  tunnel.start();
  await waitFor(() => delays.length >= 4, "four retries");
  const status = tunnel.status();
  assert.equal(status.connected, false);
  assert.equal(status.lastError.code, "relay-unreachable");
  assert.deepEqual(delays.slice(0, 4).map((delay) => Math.round(delay / 20) * 20), [20, 40, 80, 80], "1×, 2×, 4×, then the cap");
  await tunnel.stop();
  assert.equal(tunnel.status().state, "stopped");
});

test("a relay whose certificate isn't trusted is reported as such", TIMEOUT, async (t) => {
  const relay = await startRelay(t);
  const tunnel = client(t, relay.ports.tls, { ca: undefined });
  tunnel.start();
  await waitFor(() => tunnel.status().lastError, "an error");
  assert.equal(tunnel.status().lastError.code, "relay-certificate");
  assert.equal(relay.stats().tunnels, 0);
});

test("it claims its free name, reconnects at once on wake and on a network change, and says goodbye on stop", TIMEOUT, async (t) => {
  const relay = await startRelay(t);
  let offset = 0;
  let network = { eth0: [{ address: "192.0.2.10", internal: false }] };
  const log = [];
  const tunnel = client(t, relay.ports.tls, { now: () => Date.now() + offset, interfaces: () => network, networkCheckMs: 50, log: (event) => log.push(event) });
  tunnel.start();
  await waitFor(() => tunnel.status().routed, "the claimed name");
  assert.deepEqual(tunnel.status().names, ["fern.home.test"]);
  assert.equal(tunnel.status().nameError, null);
  let first = [...relay.tunnels.values()][0];

  // The clock jumps ten minutes: the computer slept.
  offset += 10 * 60_000;
  await waitFor(() => first.closed && relay.stats().tunnels === 1 && tunnel.status().routed, "a new tunnel after the wake");
  assert.ok(log.some((event) => event.event === "home_tunnel_reconnect" && event.reason === "wake"));
  assert.equal(tunnel.status().lastError, null, "the replaced tunnel isn't an error");

  // A new address: the network changed.
  first = [...relay.tunnels.values()][0];
  network = { wlan0: [{ address: "198.51.100.20", internal: false }] };
  await waitFor(() => first.closed && relay.stats().tunnels === 1 && tunnel.status().routed, "a new tunnel after the network change");
  assert.ok(log.some((event) => event.event === "home_tunnel_reconnect" && event.reason === "network-change"));
  assert.notEqual(networkFingerprint({ lo: [{ address: "127.0.0.1", internal: true }] }), networkFingerprint(network));
  assert.equal(networkFingerprint({ lo: [{ address: "127.0.0.1", internal: true }] }), "", "loopback doesn't count");

  await tunnel.stop();
  await waitFor(() => relay.stats().tunnels === 0, "the relay to drop the tunnel");
  assert.deepEqual(relay.stats().routes, []);
  for (const event of log) assert.doesNotMatch(JSON.stringify(event), /\d+\.\d+\.\d+\.\d+/, "no address in the log");
});

test("an own domain is added with ADD_DOMAIN; a refused name is reported and not routed", TIMEOUT, async (t) => {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const proof = keyHashText(rawEd25519PublicKey(privateKey));
  const relay = await startRelay(t, { resolveTxt: async (name) => (name === "_kin-relay.kin.family.test" ? [[proof]] : []) });
  const own = client(t, relay.ports.tls, { name: "kin.family.test", freeName: false, privateKey });
  own.start();
  await waitFor(() => own.status().routed, "the own domain");
  await own.setCaa("https://acme.test/account/1"); // nothing to send for an own domain
  assert.equal(relay.registry.dnsInfo("kin.family.test").routed, false, "an own domain's CAA stays in its own DNS");

  const reserved = client(t, relay.ports.tls, { name: "www.home.test" });
  reserved.start();
  await waitFor(() => reserved.status().nameError, "the refusal");
  assert.equal(reserved.status().nameError.code, "name-not-allowed");
  assert.equal(reserved.status().routed, false);
  assert.equal(reserved.status().connected, true, "the tunnel itself stays up for the control panel to explain");
  await assert.rejects(reserved.setCaa("https://acme.test/account/2", { timeoutMs: 100 }), { code: "tunnel-not-ready" });
});

/** A relay that speaks just enough KTUN to sign a home server in, then does
 * whatever `behave` says. */
async function brokenRelay(t, behave, { pingSeconds = 1, idleSeconds = 2 } = {}) {
  const sockets = new Set();
  const server = createTlsServer({ ...RELAY_TLS, ALPNProtocols: [ALPN], minVersion: "TLSv1.3" }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const reader = new FrameReader("home");
    let preface = true;
    socket.on("data", (chunk) => {
      if (preface) {
        preface = false;
        chunk = chunk.subarray(8);
        socket.write(encodeHello({ nonce: Buffer.alloc(32, 1), maxStreams: 4, streamWindow: 16_384, connectionWindow: 16_384, pingSeconds, idleSeconds }));
      }
      for (const frame of reader.push(chunk)) behave(socket, frame);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); for (const socket of sockets) socket.destroy(); }));
  return server.address().port;
}

// KTUN's HELLO carries whole seconds (pingSeconds ≥ 1, idleSeconds >
// pingSeconds), so these can't be shorter. 1 s / 2 s is the tightest pair a
// relay may send; 1 s / 4 s leaves room to check the timing itself.
for (const [pingSeconds, idleSeconds] of [[1, 2], [1, 4]]) {
  test(`keep-alive (ping ${pingSeconds} s, idle ${idleSeconds} s): it pings a silent relay, then gives up on it`, TIMEOUT, async (t) => {
    let readyAt = 0;
    let closedAt = 0;
    const pings = [];
    const port = await brokenRelay(t, (socket, frame) => {
      if (frame.type === FrameType.AUTH) {
        socket.write(encodeReady(["fern.home.test"]));
        readyAt = Date.now();
        socket.once("close", () => { closedAt = Date.now(); });
      }
      // Recorded as each PING arrives; never answered.
      if (frame.type === FrameType.PING) pings.push(Date.now() - readyAt);
    }, { pingSeconds, idleSeconds });
    const tunnel = client(t, port, { backoff: { minMs: 60_000, maxMs: 60_000 } });
    tunnel.start();
    await waitFor(() => tunnel.status().lastError?.code === "tunnel-dead" && closedAt, "the dead tunnel", 15_000);
    assert.ok(pings.length >= 1, "it pinged before giving up");
    // Windows timers can fire ~15 ms late; allow a little either side.
    assert.ok(pings[0] >= pingSeconds * 1000 - 100, `not before the ping interval (${pings[0]} ms)`);
    assert.ok(pings[0] < idleSeconds * 1000, `well before giving up (${pings[0]} ms)`);
    assert.ok(closedAt - readyAt >= idleSeconds * 1000 - 100, `gave up only after the idle time (${closedAt - readyAt} ms)`);
    if (idleSeconds >= 4) assert.ok(pings[0] <= pingSeconds * 1000 + 500, `soon after the ping interval (${pings[0]} ms)`);
  });
}

test("a tunnel reset with no GOAWAY is reported and dialled again", TIMEOUT, async (t) => {
  let signIns = 0;
  const port = await brokenRelay(t, (socket, frame) => {
    if (frame.type !== FrameType.AUTH) return;
    signIns += 1;
    socket.write(encodeReady(["fern.home.test"]));
    // The first tunnel vanishes without a word; later ones stay.
    if (signIns === 1) setTimeout(() => socket.destroy(), 50);
  });
  const tunnel = client(t, port);
  const lost = [];
  tunnel.on("status", (status) => { if (!status.connected && status.lastError) lost.push(status.lastError.code); });
  tunnel.start();
  await waitFor(() => signIns >= 2 && tunnel.status().connected, "the second tunnel");
  assert.equal(lost[0], "connection-lost");
  assert.equal(tunnel.status().routed, true);
});

test("a refused sign-in waits the longest backoff instead of hammering the relay", TIMEOUT, async (t) => {
  const port = await brokenRelay(t, (socket, frame) => {
    if (frame.type === FrameType.AUTH) { socket.write(encodeGoaway(0, Code.AUTH_FAILED)); socket.end(); }
  });
  const tunnel = client(t, port, { random: () => 1, backoff: { minMs: 20, maxMs: 5_000 } });
  tunnel.start();
  await waitFor(() => tunnel.status().lastError, "the refusal");
  const status = tunnel.status();
  assert.equal(status.lastError.code, "auth-failed");
  assert.ok(Date.parse(status.nextAttemptAt) - Date.parse(status.since) >= 4_900, "the cap, not the first step");
});

// ------------------------------------------------------- the service, sandboxed

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = once(child, "exit");
  // Windows has no signals to forward: end the launcher and the service together.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
  return exited;
}

function collect(child) {
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  return () => output.replace(/\r\n/g, "\n");
}

const freePort = () => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

test("home mode under the permission model: makes its key, dials the relay, and serves its name's origin", TIMEOUT, async (t) => {
  const relay = await startRelay(t);
  const data = temporary(t);
  const port = await freePort();
  // The relay's test certificate names relay.home.test, which doesn't
  // resolve; dialling it as "localhost" still proves the sandboxed service
  // may make the connection and reaches the relay's TLS.
  const child = spawn(process.execPath, [join(APP_ROOT, "server", "start.mjs")], {
    env: {
      ...process.env, KIN_MODE: "home", KIN_DATA_DIR: data, KIN_PORT: String(port), KIN_HOST: "127.0.0.1", KIN_ORIGIN: "",
      KIN_HOME_NAME: "fern.home.test", KIN_HOME_ZONE: "home.test", KIN_HOME_RELAY: `localhost:${relay.ports.tls}`,
    },
  });
  const output = collect(child);
  stopBeforeCleanup(t, () => stop(child));
  await waitFor(() => /home_tunnel_lost/.test(output()) || child.exitCode !== null, "the first dial", 30_000);
  const lines = output().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  assert.deepEqual(lines.find((line) => line.event === "service_ready"), { event: "service_ready", origin: "https://fern.home.test", mode: "home" });
  const lost = lines.find((line) => line.event === "home_tunnel_lost");
  assert.ok(["relay-tls", "relay-certificate"].includes(lost.code), `reached the relay's TLS (${lost.code})`);
  assert.ok(!lines.some((line) => line.event === "startup_failed"), output());
  const key = join(data, "home", HOME_KEY_FILE);
  if (process.platform !== "win32") assert.equal(statSync(key).mode & 0o777, 0o600);
  else statSync(key);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await stop(child);
});

test("home mode without a name runs on loopback as before and says the tunnel is off", TIMEOUT, async (t) => {
  const data = temporary(t);
  const port = await freePort();
  const env = { ...process.env, KIN_MODE: "home", KIN_DATA_DIR: data, KIN_PORT: String(port), KIN_HOST: "127.0.0.1" };
  for (const name of ["KIN_HOME_NAME", "KIN_ORIGIN"]) delete env[name];
  const child = spawn(process.execPath, [join(APP_ROOT, "server", "start.mjs")], { env });
  const output = collect(child);
  stopBeforeCleanup(t, () => stop(child));
  await waitFor(() => /home_not_configured/.test(output()) || child.exitCode !== null, "startup", 30_000);
  assert.match(output(), /"origin":"http:\/\/localhost:\d+","mode":"home"/);
  assert.doesNotMatch(output(), /home_tunnel/);
  await stop(child);
});

test("a test's service is stopped before its temporary folder is removed, even if the test ends first", TIMEOUT, async (t) => {
  let directory, child, folderWhenStopped;
  await t.test("a test that ends without stopping its service", async (inner) => {
    directory = temporary(inner);
    // Stands in for the service: it holds a file open in the folder until stopped.
    child = spawn(process.execPath, ["-e", "require('fs').openSync(process.argv[1], 'w'); console.log('open'); setInterval(() => {}, 1000)", join(directory, "held")]);
    stopBeforeCleanup(inner, async () => { folderWhenStopped = existsSync(directory); await stop(child); });
    await once(child.stdout, "data");
  });
  assert.equal(folderWhenStopped, true, "the service was stopped while its folder was still there");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the service has exited");
  assert.equal(existsSync(directory), false, "the folder is removed");
});
