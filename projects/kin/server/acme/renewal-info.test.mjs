// ACME Renewal Information (ARI, RFC 9773, #751): the certificate
// identifier, the choice of renewal time, Retry-After clamping, `replaces`,
// and how ARI sits with the two-thirds fallback and the backoff. Schedules
// run on a fake clock and a fixed `random`; ACME runs against the in-process
// test CA with real TLS-ALPN-01 over loopback. Nothing sleeps.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import test from "node:test";
import { defaultRenewalWindow, startAcmeTestServer } from "./acme-test-server.mjs";
import { AcmeClient } from "./client.mjs";
import { implicitPrimitive, integer, sequence, tlv } from "./der.mjs";
import { CertificateStore, generateP256Key } from "./keys.mjs";
import {
  ARI_POLL_DEFAULT_MS, ARI_POLL_MAX_MS, ARI_POLL_MIN_MS, CertificateManager, DAY, HOUR,
  ariPollDelay, chooseRenewalTime, renewalTime,
} from "./renewal.mjs";
import { ChallengeResponder } from "./tls-alpn.mjs";
import { acmeTlsServerOptions, closeChallengeConnections } from "./tls-hook.mjs";
import { createHttpsTransport } from "./transport.mjs";
import {
  OID, ariCertificateIdentifier, authorityKeyIdentifier, authorityKeyIdentifierExtension, buildCertificate,
  certificateIdentifier, extension, readCertificate, spkiDer, subjectAltNameExtension,
} from "./x509.mjs";

const NAME = "fern.home.kin.test";
const TIMEOUT = { timeout: 30_000 };

// RFC 9773 §4.1's example.
const RFC_KEY_IDENTIFIER = Buffer.from("69885b6b87464041e1b37b847ba0ae2cde01c8d4", "hex");
const RFC_SERIAL = Buffer.from("0087654321", "hex");
const RFC_IDENTIFIER = "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE";

// ---- The certificate identifier ------------------------------------------------

test("the ARI identifier matches RFC 9773 §4.1's example, read from a real DER certificate", TIMEOUT, () => {
  assert.equal(ariCertificateIdentifier(RFC_KEY_IDENTIFIER, RFC_SERIAL), RFC_IDENTIFIER);

  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  // integer() keeps the leading 0x00 that 0x87… needs to stay positive, so
  // the serial's content octets are exactly the RFC's 00:87:65:43:21.
  assert.deepEqual(integer(RFC_SERIAL), Buffer.from("02050087654321", "hex"));
  const der = buildCertificate({
    subjectPublicKeyInfo: spkiDer(key), subject: NAME, issuer: "Example CA", serial: RFC_SERIAL,
    notBefore: Date.UTC(2026, 0, 1), notAfter: Date.UTC(2026, 3, 1),
    extensions: [subjectAltNameExtension([NAME]), authorityKeyIdentifierExtension(RFC_KEY_IDENTIFIER)], signingKey: key,
  });
  assert.deepEqual(readCertificate(der).serial, RFC_SERIAL);
  assert.deepEqual(authorityKeyIdentifier(der), RFC_KEY_IDENTIFIER);
  assert.equal(certificateIdentifier(der), RFC_IDENTIFIER);
  // Zero-copy: the views point into the certificate.
  assert.equal(readCertificate(der).serial.buffer, der.buffer);
});

test("the AKI reader takes keyIdentifier among the other fields, and a certificate without AKI has no identifier", TIMEOUT, () => {
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const base = { subjectPublicKeyInfo: spkiDer(key), subject: NAME, serial: Buffer.from([0x01, 0x02]), notBefore: Date.UTC(2026, 0, 1), notAfter: Date.UTC(2026, 3, 1), signingKey: key };
  // AuthorityKeyIdentifier with all three fields: [0] keyIdentifier,
  // [1] authorityCertIssuer (GeneralNames, constructed), [2] serial.
  const full = extension(OID.authorityKeyIdentifier, sequence(
    implicitPrimitive(0, RFC_KEY_IDENTIFIER),
    tlv(0xa1, implicitPrimitive(2, Buffer.from("ca.test", "ascii"))),
    implicitPrimitive(2, Buffer.from([0x05])),
  ));
  assert.equal(certificateIdentifier(buildCertificate({ ...base, extensions: [full] })), `${RFC_IDENTIFIER.split(".")[0]}.AQI`);
  // Only issuer and serial: nothing ARI can use.
  const noKeyId = extension(OID.authorityKeyIdentifier, sequence(tlv(0xa1, implicitPrimitive(2, Buffer.from("ca.test", "ascii"))), implicitPrimitive(2, Buffer.from([0x05]))));
  assert.equal(certificateIdentifier(buildCertificate({ ...base, extensions: [noKeyId] })), null);
  assert.equal(certificateIdentifier(buildCertificate({ ...base, extensions: [subjectAltNameExtension([NAME])] })), null);
  assert.equal(certificateIdentifier(buildCertificate(base)), null, "no extensions at all");
  assert.throws(() => readCertificate(Buffer.from("3003020100", "hex")), RangeError);
  assert.throws(() => ariCertificateIdentifier(Buffer.alloc(0), RFC_SERIAL), RangeError);
});

// ---- Choosing the time and the next poll ----------------------------------------

test("the renewal time is uniform in the window, capped at two thirds, and now once the window has passed", TIMEOUT, () => {
  const cert = { notBefore: 0, notAfter: 90 * DAY };
  const T = renewalTime(cert.notBefore, cert.notAfter); // day 60
  const now = 10 * DAY;
  const window = { start: 50 * DAY, end: 54 * DAY };
  assert.equal(chooseRenewalTime(window, cert, now, () => 0), 50 * DAY, "never before the start");
  assert.equal(chooseRenewalTime(window, cert, now, () => 0.5), 52 * DAY);
  const late = chooseRenewalTime(window, cert, now, () => 0.999999);
  assert.ok(late >= 50 * DAY && late < 54 * DAY, "inside [start, end)");

  // A window straddling T: drawn from [start, T), never after T.
  const straddling = { start: 58 * DAY, end: 64 * DAY };
  assert.equal(chooseRenewalTime(straddling, cert, now, () => 0.5), 59 * DAY);
  assert.ok(chooseRenewalTime(straddling, cert, now, () => 0.999999) < T);
  // Let's Encrypt's own window is centred on T: still never after it.
  const le = defaultRenewalWindow(cert);
  for (const r of [0, 0.3, 0.7, 0.999999]) {
    const at = chooseRenewalTime(le, cert, now, () => r);
    assert.ok(at >= le.start && at <= T, `r=${r}`);
  }

  // The whole window after T: T wins.
  assert.equal(chooseRenewalTime({ start: 70 * DAY, end: 80 * DAY }, cert, now, () => 0.5), T);
  // The window has passed: now, whatever T says.
  assert.equal(chooseRenewalTime({ start: 1 * DAY, end: 2 * DAY }, cert, now, () => 0.5), now);
  assert.equal(chooseRenewalTime({ start: 70 * DAY, end: 80 * DAY }, cert, 85 * DAY, () => 0.5), 85 * DAY);
  // Started already but not over: a draw in the past means "now" to dueAt().
  assert.ok(chooseRenewalTime({ start: 5 * DAY, end: 15 * DAY }, cert, now, () => 0.1) <= now);
});

test("Retry-After for the next ARI poll is clamped to 1 h – 24 h, 6 h when absent", TIMEOUT, () => {
  assert.equal(ariPollDelay(undefined), ARI_POLL_DEFAULT_MS);
  assert.equal(ariPollDelay(NaN), ARI_POLL_DEFAULT_MS);
  assert.equal(ariPollDelay(0), ARI_POLL_MIN_MS);
  assert.equal(ariPollDelay(60_000), HOUR);
  assert.equal(ariPollDelay(3 * HOUR), 3 * HOUR);
  assert.equal(ariPollDelay(30 * DAY), ARI_POLL_MAX_MS);
  assert.equal(ARI_POLL_MAX_MS, DAY);
});

// ---- The client's renewalInfo request --------------------------------------------

function fakeCa({ directory, answer }) {
  const requests = [];
  const respond = (status, body, headers = {}) => ({ status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const transport = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body });
    if (url === "https://ca.test/dir") return respond(200, { newNonce: "https://ca.test/nonce", newAccount: "https://ca.test/acct", newOrder: "https://ca.test/order", ...directory });
    return answer(url, respond);
  };
  return { transport, requests };
}

const clientFor = (transport, now = () => Date.UTC(2026, 9, 22)) => new AcmeClient({ directoryUrl: "https://ca.test/dir", accountKey: generateP256Key(), transport, now });

test("the client GETs <renewalInfo>/<id> unauthenticated and validates the window", TIMEOUT, async () => {
  let reply = { status: 200, body: { suggestedWindow: { start: "2026-12-20T00:00:00Z", end: "2026-12-22T00:00:00Z" }, explanationURL: "https://ca.test/why" }, headers: { "retry-after": "21600" } };
  const { transport, requests } = fakeCa({ directory: { renewalInfo: "https://ca.test/renewal-info/" }, answer: (url, respond) => respond(reply.status, reply.body, reply.headers) });
  const client = clientFor(transport);
  const info = await client.renewalInfo(RFC_IDENTIFIER);
  assert.deepEqual(info, { start: Date.UTC(2026, 11, 20), end: Date.UTC(2026, 11, 22), explanationURL: "https://ca.test/why", retryAfterMs: 21_600_000 });
  const last = requests.at(-1);
  assert.equal(last.url, `https://ca.test/renewal-info/${RFC_IDENTIFIER}`, "one slash between base and identifier");
  assert.equal(last.method, "GET");
  assert.equal(last.body, undefined, "no JWS: ARI is unauthenticated (§4.1)");

  reply = { status: 200, body: { suggestedWindow: { start: "2026-12-20T00:00:00+02:00", end: "2026-12-21T00:00:00.5Z" }, explanationURL: "http://ca.test/why" }, headers: {} };
  const offset = await client.renewalInfo(RFC_IDENTIFIER);
  assert.equal(offset.start, Date.UTC(2026, 11, 19, 22));
  assert.equal(offset.explanationURL, null, "only https explanation links are kept");
  assert.equal(offset.retryAfterMs, undefined);

  for (const window of [
    { start: "2026-12-22T00:00:00Z", end: "2026-12-22T00:00:00Z" }, // end must follow start (§4.2)
    { start: "2026-12-22T00:00:00Z", end: "2026-12-21T00:00:00Z" },
    { start: "December 20, 2026", end: "2026-12-22T00:00:00Z" },
    undefined,
  ]) {
    reply = { status: 200, body: { suggestedWindow: window }, headers: { "retry-after": "7200" } };
    await assert.rejects(client.renewalInfo(RFC_IDENTIFIER), (error) => error.code === "acme-bad-response" && error.retryAfterMs === 7_200_000);
  }
  reply = { status: 503, body: { type: "urn:ietf:params:acme:error:serverInternal", detail: "busy" }, headers: { "retry-after": "120" } };
  await assert.rejects(client.renewalInfo(RFC_IDENTIFIER), (error) => error.code === "acme-server-error" && error.retryAfterMs === 120_000);
  await assert.rejects(client.renewalInfo("../../etc"), TypeError);
});

test("a CA without renewalInfo: renewalInfo() is null and newOrder never sends replaces", TIMEOUT, async () => {
  const { transport, requests } = fakeCa({
    directory: {},
    answer: (url, respond) => respond(url.endsWith("/nonce") ? 200 : 201, url.endsWith("/nonce") ? "" : { status: "pending", authorizations: [], finalize: "https://ca.test/fin" }, { "replay-nonce": "abc", location: "https://ca.test/order/1", "content-type": "application/json" }),
  });
  const client = clientFor(transport);
  client.accountUrl = "https://ca.test/acct/1";
  assert.equal(await client.renewalInfo(RFC_IDENTIFIER), null);
  assert.ok(!requests.some((request) => request.url.includes("renewal")), "nothing asked");
  await client.newOrder([NAME], { replaces: RFC_IDENTIFIER });
  const payload = JSON.parse(Buffer.from(JSON.parse(requests.at(-1).body).payload, "base64url").toString("utf8"));
  assert.deepEqual(payload, { identifiers: [{ type: "dns", value: NAME }] });
});

// ---- The manager against the test CA --------------------------------------------

function fakeClock(start) {
  const clock = {
    time: start,
    timers: [],
    now: () => clock.time,
    setTimeout: (fn, ms) => { const timer = { fn, ms, at: clock.time + ms, cleared: false }; clock.timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    pending: () => clock.timers.filter((timer) => !timer.cleared),
  };
  return clock;
}

async function setup(t, { renewalInfo = true, random = () => 0.25 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kin-acme-ari-"));
  const responder = new ChallengeResponder();
  const server = createServer({ ...acmeTlsServerOptions({ responder }) }, (socket) => socket.end("app"));
  closeChallengeConnections(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const clock = fakeClock(Date.UTC(2026, 9, 22, 8));
  const ca = await startAcmeTestServer({ validationPort: server.address().port, lifetimeMs: 90 * DAY, now: clock.now, holdPolls: 0, renewalInfo });
  t.after(async () => {
    await ca.close();
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new CertificateStore(directory);
  const make = () => new CertificateManager({
    name: NAME, store, directoryUrl: ca.directoryUrl, transport: createHttpsTransport({ allowLoopbackHttp: true }),
    responder, server, termsOfServiceAgreed: true, clock, sleep: async () => {}, random,
    ctTransport: async () => { throw new Error("no CT in these tests"); },
  });
  const orders = () => ca.state.log.filter((entry) => entry.url === "/new-order").map((entry) => entry.payload);
  return { ca, clock, store, make, orders };
}

/** A manager that has its first certificate. */
async function issued(t, options) {
  const context = await setup(t, options);
  const manager = context.make();
  t.after(() => manager.stop());
  await manager.start();
  const status = await manager.renew();
  return { ...context, manager, status, notBefore: Date.parse(status.certificate.notBefore), notAfter: Date.parse(status.certificate.notAfter) };
}

test("follows the CA's window: identifier, a time inside it, the poll interval, then renews with replaces", TIMEOUT, async (t) => {
  const { ca, clock, manager, orders, notBefore, notAfter } = await issued(t);
  const [firstId] = ca.issuedIdentifiers();
  const before = manager.status().renewalInfo;
  assert.equal(before.state, "unknown");
  assert.equal(before.certificateId, firstId, "the identifier read from the real certificate is the CA's");
  assert.equal(orders()[0].replaces, undefined, "the first certificate replaces nothing");
  assert.ok(clock.pending().some((timer) => timer.ms === 0), "the first poll is due at once");

  const info = await manager.refreshRenewalInfo();
  assert.deepEqual(ca.state.renewalInfoRequests, [firstId]);
  const window = defaultRenewalWindow({ notBefore, notAfter });
  const T = renewalTime(notBefore, notAfter);
  assert.equal(info.state, "ok");
  assert.deepEqual(info.suggestedWindow, { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() });
  assert.equal(info.explanationURL, null);
  assert.equal(Date.parse(info.nextCheckAt) - clock.now(), 6 * HOUR, "the CA's Retry-After: 21600");
  const renewAt = Date.parse(manager.status().renewAt);
  assert.equal(renewAt, window.start + Math.floor(0.25 * (T - window.start)), "uniform in [start, min(end, T))");
  assert.equal(manager.dueAt(), renewAt);

  // A later poll with the same window keeps the time.
  clock.time = Date.parse(info.nextCheckAt);
  await manager.refreshRenewalInfo();
  assert.equal(Date.parse(manager.status().renewAt), renewAt);

  // Due: the timer renews, naming the old certificate.
  clock.time = renewAt;
  clock.pending().at(-1).fn();
  const renewed = await manager.renew();
  assert.equal(renewed.state, "valid");
  assert.equal(orders().at(-1).replaces, firstId);
  assert.ok(ca.state.replaced.has(firstId));
  assert.equal(renewed.renewalInfo.state, "unknown", "the new certificate is asked about afresh");
  assert.equal(renewed.renewalInfo.certificateId, ca.issuedIdentifiers()[1]);
});

test("a window that has passed (an incident) means renew now, and explanationURL is shown", TIMEOUT, async (t) => {
  const { ca, clock, manager, orders } = await issued(t);
  ca.setRenewalInfo({ start: clock.now() - 2 * DAY, end: clock.now() - DAY, explanationURL: "https://acme.test/incident/42", retryAfter: 3600 });
  const info = await manager.refreshRenewalInfo();
  assert.equal(info.explanationURL, "https://acme.test/incident/42");
  assert.equal(manager.dueAt(), clock.now());
  assert.equal(Date.parse(manager.status().renewAt), clock.now());
  const due = clock.pending().at(-1);
  assert.equal(due.ms, 0, "planned for now");
  due.fn();
  await manager.renew();
  assert.equal(orders().length, 2);
  assert.equal(orders()[1].replaces, ca.issuedIdentifiers()[0]);
});

test("a window wholly after two thirds is capped at two thirds; a moved window is chosen again", TIMEOUT, async (t) => {
  let draws = 0;
  const { ca, manager, notBefore, notAfter, clock } = await issued(t, { random: () => { draws += 1; return 0.5; } });
  const T = renewalTime(notBefore, notAfter);
  ca.setRenewalInfo({ start: T + 5 * DAY, end: T + 10 * DAY });
  await manager.refreshRenewalInfo();
  assert.equal(manager.dueAt(), T);
  assert.equal(Date.parse(manager.status().renewAt), T);

  ca.setRenewalInfo({ start: notBefore + 30 * DAY, end: notBefore + 34 * DAY });
  clock.time += 6 * HOUR;
  await manager.refreshRenewalInfo();
  assert.equal(manager.dueAt(), notBefore + 32 * DAY, "pulled earlier and drawn again");
  assert.equal(draws, 1, "only the in-range window needed a draw");
});

test("without ARI the two-thirds rule stands, nothing is polled, and replaces is never sent", TIMEOUT, async (t) => {
  const { ca, clock, manager, orders, notBefore, notAfter } = await issued(t, { renewalInfo: false });
  const status = manager.status();
  assert.equal(status.renewalInfo.state, "unsupported");
  assert.ok(status.renewalInfo.certificateId, "the certificate has an AKI");
  assert.equal(Date.parse(status.renewAt), renewalTime(notBefore, notAfter));
  assert.equal(Date.parse(status.renewalInfo.nextCheckAt) - clock.now(), DAY, "the directory is looked at again daily");
  assert.ok(clock.pending().some((timer) => timer.ms === DAY));

  clock.time += DAY;
  assert.equal((await manager.refreshRenewalInfo()).state, "unsupported");
  assert.equal(ca.state.renewalInfoRequests.length, 0);

  // This CA refuses `replaces` as malformed, so success shows it wasn't sent.
  clock.time = renewalTime(notBefore, notAfter);
  await manager.renew();
  assert.deepEqual(orders().map((payload) => payload.replaces), [undefined, undefined]);
});

test("a failed ARI request falls back to two thirds (or keeps the last window) and polls again after a clamped Retry-After", TIMEOUT, async (t) => {
  const { ca, clock, manager, notBefore, notAfter } = await issued(t);
  const T = renewalTime(notBefore, notAfter);

  ca.setRenewalInfo({ status: 500, retryAfter: 60 });
  await assert.rejects(manager.refreshRenewalInfo(), { code: "acme-server-error" });
  let status = manager.status();
  assert.equal(status.renewalInfo.state, "failed");
  assert.equal(status.renewalInfo.error.code, "acme-server-error");
  assert.equal(Date.parse(status.renewAt), T, "no window yet: two thirds");
  assert.equal(Date.parse(status.renewalInfo.nextCheckAt) - clock.now(), HOUR, "60 s is raised to an hour");
  assert.equal(status.failures, 0, "an ARI failure is not a renewal failure");
  assert.equal(status.state, "valid");
  assert.equal(clock.pending().at(-1).ms, HOUR, "the next wake-up is the next poll");

  ca.setRenewalInfo({ start: notBefore + 40 * DAY, end: notBefore + 44 * DAY, retryAfter: 30 * 86_400 });
  clock.time += HOUR;
  clock.pending().at(-1).fn(); // the timer polls
  await manager.refreshRenewalInfo();
  status = manager.status();
  assert.equal(status.renewalInfo.state, "ok");
  assert.equal(status.renewalInfo.error, null);
  assert.equal(Date.parse(status.renewalInfo.nextCheckAt) - clock.now(), DAY, "30 days is cut to a day");
  const chosen = Date.parse(status.renewAt);
  assert.equal(chosen, notBefore + 41 * DAY);

  ca.setRenewalInfo({ status: 503 });
  clock.time += DAY;
  await assert.rejects(manager.refreshRenewalInfo());
  status = manager.status();
  assert.equal(status.renewalInfo.state, "failed");
  assert.equal(Date.parse(status.renewAt), chosen, "the last window still stands");
  assert.ok(status.renewalInfo.suggestedWindow);
  assert.equal(Date.parse(status.renewalInfo.nextCheckAt) - clock.now(), 6 * HOUR, "no Retry-After: 6 h");

  // Transport failure (the CA unreachable) is handled the same way.
  await ca.close();
  clock.time += 6 * HOUR;
  await assert.rejects(manager.refreshRenewalInfo(), { code: "acme-network" });
  assert.equal(manager.status().renewalInfo.error.code, "acme-network");
});

test("backoff governs after a failed renewal even when the window says now; success resets both", TIMEOUT, async (t) => {
  const { ca, clock, manager, orders } = await issued(t);
  ca.setRenewalInfo({ start: clock.now() - 2 * DAY, end: clock.now() - DAY });
  await manager.refreshRenewalInfo();
  assert.equal(manager.dueAt(), clock.now());

  ca.failNext("new-order", "serverInternal", { status: 500 });
  await assert.rejects(manager.renew(), { code: "acme-server-error" });
  assert.equal(manager.dueAt() - clock.now(), HOUR, "1 h backoff, not the passed window");
  assert.equal(orders()[1].replaces, ca.issuedIdentifiers()[0], "the failed attempt named the old certificate too");

  // A poll during the backoff doesn't shorten it.
  clock.time += 30 * 60_000;
  await manager.refreshRenewalInfo();
  assert.equal(manager.dueAt() - clock.now(), 30 * 60_000);

  ca.failNext("new-order", "rateLimited", { status: 429, retryAfter: 2 * 86_400 });
  clock.time += 30 * 60_000;
  await assert.rejects(manager.renew(), { code: "acme-rate-limited" });
  assert.equal(manager.dueAt() - clock.now(), 2 * DAY, "the CA's rate-limit Retry-After stretches the backoff");

  clock.time += 2 * DAY;
  ca.setRenewalInfo(null);
  const recovered = await manager.renew();
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.nextAttemptAt, null);
  assert.equal(recovered.renewalInfo.state, "unknown");
  assert.equal(orders().at(-1).replaces, ca.issuedIdentifiers()[0]);
  assert.ok(manager.dueAt() > clock.now());
});

test("alreadyReplaced: the order is placed again without replaces", TIMEOUT, async (t) => {
  const { ca, manager, orders } = await issued(t);
  ca.state.replaced.add(ca.issuedIdentifiers()[0]); // say an earlier renewal's download was lost
  const renewed = await manager.renew();
  assert.equal(renewed.state, "valid");
  assert.equal(renewed.failures, 0);
  assert.deepEqual(orders().map((payload) => payload.replaces), [undefined, ca.issuedIdentifiers()[0], undefined]);
});

test("a restart polls ARI at once for the stored certificate, without renewing", TIMEOUT, async (t) => {
  const { ca, clock, manager, make } = await issued(t);
  manager.stop();
  const restarted = make();
  t.after(() => restarted.stop());
  const status = await restarted.start();
  assert.equal(status.renewalInfo.state, "unknown");
  assert.equal(status.renewalInfo.nextCheckAt, new Date(clock.now()).toISOString());
  const timer = clock.pending().find((item) => item.ms === 0);
  assert.ok(timer);
  timer.fn();
  await restarted.refreshRenewalInfo(); // shares the poll the timer started
  assert.equal(ca.state.renewalInfoRequests.length, 1);
  assert.equal(restarted.status().renewalInfo.state, "ok");
  assert.ok(restarted.dueAt() > clock.now());
  assert.equal(ca.state.issued.length, 1, "nothing renewed");
});
