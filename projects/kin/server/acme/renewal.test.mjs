// Renewal at two thirds of the lifetime with backoff, hot swap, status and
// the daily CT check (#727). The schedule runs on a fake clock; ACME runs
// against the in-process test server with real TLS-ALPN-01 over loopback.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import test from "node:test";
import { startAcmeTestServer } from "./acme-test-server.mjs";
import { checkTransparency, nameCovers, normalizeSerial } from "./ct-check.mjs";
import { CertificateStore, generateP256Key, spkiSha256 } from "./keys.mjs";
import {
  BACKOFF_MAX_MS, CertificateManager, DAY, HOUR, backoffDelay, caaRecords, renewalTime,
} from "./renewal.mjs";
import { ChallengeResponder } from "./tls-alpn.mjs";
import { acmeTlsServerOptions, closeChallengeConnections } from "./tls-hook.mjs";
import { createHttpsTransport } from "./transport.mjs";
import { implicitPrimitive, sequence } from "./der.mjs";
import { OID, buildCertificate, extension, spkiDer, subjectAltNameExtension, toPem } from "./x509.mjs";

const NAME = "fern.home.kin.test";

function fakeClock(start) {
  const clock = {
    time: start,
    timers: [],
    now: () => clock.time,
    setTimeout: (fn, ms) => { const timer = { fn, ms, at: clock.time + ms, cleared: false }; clock.timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    /** The live timer due soonest (the renewal one has the shorter delays). */
    pending: () => clock.timers.filter((timer) => !timer.cleared),
  };
  return clock;
}

function servedFingerprint(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, servername: NAME, ALPNProtocols: ["http/1.1"], rejectUnauthorized: false }, () => {
      resolve(new X509Certificate(socket.getPeerCertificate(false).raw).fingerprint256);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

const leafFingerprint = (chainPem) => new X509Certificate(chainPem).fingerprint256;

async function setup(t, { lifetimeMs = 90 * DAY, ctTransport } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kin-acme-renewal-"));
  const responder = new ChallengeResponder();
  const server = createServer({ ...acmeTlsServerOptions({ responder }) }, (socket) => socket.end("app"));
  closeChallengeConnections(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const clock = fakeClock(Date.now());
  const ca = await startAcmeTestServer({ validationPort: port, lifetimeMs, now: clock.now, holdPolls: 0 });
  t.after(async () => {
    await ca.close();
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new CertificateStore(directory);
  const events = [];
  const caaSeen = [];
  const make = () => new CertificateManager({
    name: NAME, store, directoryUrl: ca.directoryUrl, transport: createHttpsTransport({ allowLoopbackHttp: true }),
    responder, server, termsOfServiceAgreed: true, clock, sleep: async () => {},
    ctTransport, ctBaseUrl: "https://ct.test/",
    onEvent: (event) => events.push(event),
    beforeOrder: async (account) => { caaSeen.push(account); },
  });
  return { ca, clock, store, server, port, responder, events, caaSeen, make };
}

test("renewalTime is two thirds of the lifetime; backoff is 1 h doubling to 24 h, stretched by Retry-After", () => {
  assert.equal(renewalTime(0, 90 * DAY), 60 * DAY);
  assert.equal(renewalTime(1000, 1000 + 6 * DAY), 1000 + 4 * DAY);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n) / HOUR), [1, 2, 4, 8, 16, 24, 24, 24]);
  assert.equal(backoffDelay(1, 3 * DAY), 3 * DAY);
  assert.equal(backoffDelay(6, 1000), BACKOFF_MAX_MS);
  assert.equal(backoffDelay(1, 30 * DAY), 7 * DAY, "Retry-After is capped at a week");
});

test("CAA records bind the name to the account and to tls-alpn-01 (RFC 8657)", () => {
  assert.deepEqual(caaRecords(NAME, "https://acme.test/acct/7"), [
    `${NAME}. CAA 0 issue "letsencrypt.org; accounturi=https://acme.test/acct/7; validationmethods=tls-alpn-01"`,
    `${NAME}. CAA 0 issuewild ";"`,
  ]);
});

test("first start: no certificate, obtains one, serves it, and plans renewal at two thirds", async (t) => {
  const { clock, store, port, events, caaSeen, make } = await setup(t);
  const manager = make();
  const before = await manager.start();
  assert.equal(before.state, "none");
  assert.equal(before.certificate, null);
  assert.equal(clock.pending()[0].ms, 0, "renewal is due at once");

  clock.pending()[0].fn();
  const status = await manager.renew();
  assert.equal(status.state, "valid");
  assert.equal(status.certificate.daysLeft, 89);
  assert.equal(Date.parse(status.renewAt) - Date.parse(status.certificate.notBefore), 60 * DAY);
  assert.equal(status.failures, 0);
  assert.equal(status.lastError, null);
  assert.match(status.accountUrl, /\/account\//);
  assert.match(status.caa[0], /accounturi=.*validationmethods=tls-alpn-01/);
  assert.equal(caaSeen.length, 1, "CAA is published before the order");
  assert.equal(caaSeen[0].accountUrl, status.accountUrl);
  assert.deepEqual(events.map((event) => event.type), ["renewed"]);

  const stored = await store.certificate();
  assert.equal(await servedFingerprint(port), leafFingerprint(stored.chainPem), "the TLS server now serves it");
  assert.equal((await store.history())[0].spkiSha256, spkiSha256(stored.key));
  assert.deepEqual(await store.account(), { directoryUrl: manager.directoryUrl, accountUrl: status.accountUrl });
  const renewTimer = clock.pending().find((timer) => timer.ms === DAY);
  assert.ok(renewTimer, "the next wake-up is capped at a day");
});

test("renews at two thirds with a new key and hot-swaps it; a restart loads it without renewing", async (t) => {
  const { clock, store, port, ca, make } = await setup(t);
  const manager = make();
  await manager.start();
  await manager.renew();
  const first = await store.certificate();
  const firstStatus = manager.status();

  clock.time = Date.parse(firstStatus.renewAt) - 1000;
  assert.ok(manager.dueAt() > clock.now(), "not yet due");
  clock.time = Date.parse(firstStatus.renewAt);
  const due = clock.pending().at(-1);
  due.fn();
  const second = await manager.renew();
  assert.notEqual(second.certificate.serial, firstStatus.certificate.serial);
  const stored = await store.certificate();
  assert.notEqual(spkiSha256(stored.key), spkiSha256(first.key), "a fresh certificate key each time");
  assert.equal(await servedFingerprint(port), leafFingerprint(stored.chainPem), "swapped without a restart");
  assert.equal((await store.history()).length, 2);
  assert.equal(ca.state.accounts.size, 1, "the same account");

  manager.stop();
  const restarted = make();
  const loaded = await restarted.start();
  assert.equal(loaded.state, "valid");
  assert.equal(loaded.certificate.serial, second.certificate.serial);
  assert.equal(loaded.accountUrl, second.accountUrl);
  assert.ok(restarted.dueAt() > clock.now());
  restarted.stop();
});

test("failures back off 1 h, 2 h, 4 h … 24 h, honour Retry-After, and recover", async (t) => {
  const { ca, clock, make, events } = await setup(t);
  const manager = make();
  await manager.start();
  const waits = [];
  for (let i = 0; i < 7; i += 1) {
    ca.failNext("new-order", "serverInternal", { status: 500 });
    await assert.rejects(manager.renew(), { code: "acme-server-error" });
    const status = manager.status();
    assert.equal(status.state, "failed");
    assert.equal(status.lastError.code, "acme-server-error");
    assert.equal(status.failures, i + 1);
    waits.push((Date.parse(status.nextAttemptAt) - clock.now()) / HOUR);
    assert.equal(manager.dueAt(), Date.parse(status.nextAttemptAt));
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 24, 24]);

  ca.failNext("new-order", "rateLimited", { status: 429, retryAfter: 3 * 24 * 60 * 60 });
  await assert.rejects(manager.renew(), { code: "acme-rate-limited" });
  assert.equal(Date.parse(manager.status().nextAttemptAt) - clock.now(), 3 * DAY);

  const recovered = await manager.renew();
  assert.equal(recovered.state, "valid");
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.nextAttemptAt, null);
  assert.ok(events.some((event) => event.type === "failed" && event.code === "acme-rate-limited"));
});

test("a failed renewal keeps serving the old certificate (valid-retrying), warns under 14 days, then fails", async (t) => {
  const { ca, clock, port, store, make, events } = await setup(t);
  const manager = make();
  await manager.start();
  await manager.renew();
  const { chainPem } = await store.certificate();
  clock.time = Date.parse(manager.status().renewAt);
  ca.failNext("new-order", "rateLimited", { status: 429 });
  await assert.rejects(manager.renew());
  const status = manager.status();
  assert.equal(status.state, "valid-retrying");
  assert.equal(await servedFingerprint(port), leafFingerprint(chainPem));

  // Under 14 days left: the next failed attempt tells the control panel.
  clock.time = Date.parse(status.certificate.notAfter) - 13 * DAY;
  assert.equal(manager.status().expiringSoon, true);
  ca.failNext("new-order", "rateLimited", { status: 429 });
  clock.pending().at(-1).fn();
  await assert.rejects(manager.renew());
  assert.ok(events.some((event) => event.type === "expiring"));

  // Past expiry with renewal still failing.
  clock.time = Date.parse(status.certificate.notAfter) + 1000;
  const expired = manager.status();
  assert.equal(expired.state, "failed");
  assert.equal(expired.certificate.daysLeft, 0);
  manager.stop();
});

test("a stored certificate that doesn't match its key or name is renewed at once", async (t) => {
  const { store, clock, make } = await setup(t);
  const key = generateP256Key();
  const other = generateP256Key();
  const der = buildCertificate({ subjectPublicKeyInfo: spkiDer(other), subject: NAME, notBefore: clock.now(), notAfter: clock.now() + 90 * DAY, extensions: [subjectAltNameExtension([NAME])], signingKey: other });
  await store.saveCertificate({ key, chainPem: toPem(der, "CERTIFICATE") });
  const manager = make();
  assert.equal((await manager.start()).state, "none");
  assert.equal(manager.dueAt(), clock.now());
  manager.stop();
});

// ---- Certificate Transparency ------------------------------------------------

function certificateFor(key, { names = [NAME], signer = key } = {}) {
  // SAN written by hand: Kin's own builder refuses wildcards, a CA's doesn't.
  const san = extension(OID.subjectAltName, sequence(...names.map((name) => implicitPrimitive(2, Buffer.from(name, "ascii")))));
  const der = buildCertificate({ subjectPublicKeyInfo: spkiDer(key), subject: names[0], notBefore: Date.now(), notAfter: Date.now() + 90 * DAY, extensions: [san], signingKey: signer });
  const certificate = new X509Certificate(der);
  return { pem: toPem(der, "CERTIFICATE"), serial: normalizeSerial(certificate.serialNumber) };
}

/** A crt.sh stand-in: `lists` by query, `certificates` by id. */
function fakeCtSearch({ lists, certificates, requests = [] }) {
  return async (url) => {
    requests.push(url);
    const query = new URL(url).searchParams;
    if (query.has("d")) return { status: 200, headers: { get: () => null }, text: async () => certificates[query.get("d")] };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(lists[query.get("q")] ?? []) };
  };
}

test("the CT check flags certificates for the name that this server's keys didn't get, including wildcards", async () => {
  const ours = generateP256Key();
  const ourCertificate = certificateFor(ours);
  const ourPrecertificate = certificateFor(ours, { signer: generateP256Key() }); // same key, other serial
  const foreign = certificateFor(generateP256Key());
  const wildcard = certificateFor(generateP256Key(), { names: ["*.home.kin.test"] });
  const requests = [];
  const transport = fakeCtSearch({
    requests,
    lists: {
      [NAME]: [
        { id: 1, serial_number: ourCertificate.serial, name_value: NAME, issuer_name: "C=US, O=Let's Encrypt, CN=R11" },
        { id: 2, serial_number: ourPrecertificate.serial, name_value: NAME },
        { id: 3, serial_number: foreign.serial, name_value: `${NAME}\nwww.${NAME}`, issuer_name: "C=XX, O=Elsewhere, CN=X1" },
      ],
      "*.home.kin.test": [
        { id: 4, serial_number: wildcard.serial, name_value: "*.home.kin.test" },
        { id: 5, serial_number: "05", name_value: "other.home.kin.test" }, // doesn't cover the name: ignored
      ],
    },
    certificates: { 2: ourPrecertificate.pem, 3: foreign.pem, 4: wildcard.pem },
  });
  const result = await checkTransparency({ name: NAME, transport, known: { serials: [ourCertificate.serial], spkiHashes: [spkiSha256(ours)] }, baseUrl: "https://ct.test/" });
  assert.equal(result.checked, 4);
  assert.deepEqual(result.unexpected.map((item) => item.id), ["3", "4"]);
  assert.equal(result.unexpected[0].issuer, "C=XX, O=Elsewhere, CN=X1");
  assert.equal(result.unexpected[0].serial, foreign.serial);
  assert.ok(!requests.some((url) => url.includes("d=1")), "a known serial isn't downloaded");
  assert.ok(requests.every((url) => url.startsWith("https://ct.test/")));
  assert.ok(requests.some((url) => url.includes("exclude=expired")));
});

test("the manager runs the CT check daily, turns red on a stranger, and treats an outage as an error, not an alert", async (t) => {
  let mode = "clean";
  const stranger = certificateFor(generateP256Key());
  const transport = async (url) => {
    if (mode === "down") throw new Error("ECONNREFUSED");
    const query = new URL(url).searchParams;
    if (query.has("d")) return { status: 200, headers: { get: () => null }, text: async () => stranger.pem };
    const list = mode === "stranger" && query.get("q") === NAME ? [{ id: 9, serial_number: stranger.serial, name_value: NAME }] : [];
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(list) };
  };
  const { clock, make, events } = await setup(t, { ctTransport: transport });
  const manager = make();
  await manager.start();
  await manager.renew();
  assert.equal(manager.status().transparency.state, "not-checked");

  const ctTimer = clock.pending().find((timer) => timer.ms === HOUR);
  assert.ok(ctTimer, "the first check is an hour after a start without a certificate");
  await manager.checkTransparency();
  assert.equal(manager.status().transparency.state, "ok");

  mode = "stranger";
  await manager.checkTransparency();
  const red = manager.status().transparency;
  assert.equal(red.state, "alert");
  assert.equal(red.unexpected[0].serial, stranger.serial);
  assert.ok(events.some((event) => event.type === "transparency-alert" && event.count === 1));

  mode = "down";
  await assert.rejects(manager.checkTransparency(), { code: "ct-unavailable" });
  const after = manager.status().transparency;
  assert.equal(after.state, "alert", "the last result stands");
  assert.equal(after.error.code, "ct-unavailable");
  manager.stop();
});

test("CT helpers: wildcard coverage and serial normalisation", () => {
  assert.ok(nameCovers(NAME, NAME));
  assert.ok(nameCovers("*.home.kin.test", NAME));
  assert.ok(!nameCovers("*.kin.test", NAME), "a wildcard covers one label only");
  assert.ok(!nameCovers("*.fern.home.kin.test", NAME));
  assert.ok(!nameCovers("other.home.kin.test", NAME));
  assert.equal(normalizeSerial("00:0A:FF"), "aff");
  assert.equal(normalizeSerial("0"), "0");
});

test("the CT check refuses a flood of unknown certificates and bad answers", async () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ id: i, serial_number: String(i + 10), name_value: NAME }));
  const stranger = certificateFor(generateP256Key()).pem;
  const transport = fakeCtSearch({ lists: { [NAME]: many }, certificates: { 0: stranger, 1: stranger, 2: stranger } });
  await assert.rejects(checkTransparency({ name: NAME, transport, known: { serials: [], spkiHashes: [] }, maxDownloads: 2 }), { code: "ct-too-many" });
  const broken = async () => ({ status: 200, headers: { get: () => null }, text: async () => "<html>" });
  await assert.rejects(checkTransparency({ name: NAME, transport: broken, known: { serials: [], spkiHashes: [] } }), { code: "ct-bad-response" });
  const unavailable = async () => ({ status: 502, headers: { get: () => null }, text: async () => "" });
  await assert.rejects(checkTransparency({ name: NAME, transport: unavailable, known: { serials: [], spkiHashes: [] } }), { code: "ct-unavailable" });
});
