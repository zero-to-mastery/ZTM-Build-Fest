// Issue #155 (A2): per-client pairing limits behind a trusted proxy, and only
// failed attempts spend a client's budget.
import assert from "node:assert/strict";
import test from "node:test";
import { clientKey, limitKey, normalizeAddress, parseTrustedProxies } from "./client-key.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { RATE_LIMIT } from "./pairing-service/shared.mjs";
import { createKinServer } from "./server.mjs";

const PROXY = "127.0.0.1";
const request = (remoteAddress, forwarded) => ({
  socket: { remoteAddress },
  headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
});
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

test("without trusted proxies, X-Forwarded-For is ignored", () => {
  assert.equal(clientKey(request(PROXY, "203.0.113.7"), new Set()), PROXY);
  assert.equal(clientKey(request(PROXY, "203.0.113.7"), undefined), PROXY);
  assert.equal(clientKey(request("::ffff:127.0.0.1"), new Set()), PROXY);
});

test("a header from an untrusted peer is ignored", () => {
  const trusted = parseTrustedProxies(PROXY);
  assert.equal(clientKey(request("198.51.100.9", "203.0.113.7"), trusted), "198.51.100.9");
});

test("from a trusted proxy, the right-most hop is the client; spoofed left hops are ignored", () => {
  const trusted = parseTrustedProxies(`${PROXY}, 10.0.0.2`);
  assert.equal(clientKey(request(PROXY, "203.0.113.7"), trusted), "203.0.113.7");
  // The client wrote "1.2.3.4"; the proxy appended the real address.
  assert.equal(clientKey(request(PROXY, "1.2.3.4, 203.0.113.7"), trusted), "203.0.113.7");
  // A chain of trusted proxies is skipped from the right.
  assert.equal(clientKey(request(PROXY, "1.2.3.4, 203.0.113.7, 10.0.0.2"), trusted), "203.0.113.7");
  assert.equal(clientKey(request(PROXY, "2001:db8::5"), trusted), "2001:db8:0:0::/64");
  assert.equal(clientKey(request(`::ffff:${PROXY}`, "::ffff:203.0.113.7"), trusted), "203.0.113.7");
});

test("a malformed or missing forwarded hop falls back to the proxy, never to a spoofable value", () => {
  const trusted = parseTrustedProxies(PROXY);
  assert.equal(clientKey(request(PROXY), trusted), PROXY);
  assert.equal(clientKey(request(PROXY, "not-an-ip"), trusted), PROXY);
  assert.equal(clientKey(request(PROXY, "203.0.113.7, garbage"), trusted), PROXY);
  assert.equal(clientKey(request(PROXY, "203.0.113.7".repeat(400)), trusted), PROXY);
  assert.equal(clientKey(request(PROXY, PROXY), trusted), PROXY);
  // Zone IDs: isIP accepts any text after "%", which must not reach the key.
  assert.equal(clientKey(request(PROXY, "fe80::1%1:2:3:4:5:6:7:8"), trusted), PROXY);
  assert.equal(clientKey(request(PROXY, "1::%a:b:c:d:e:f"), trusted), PROXY);
});

test("the trusted-proxy setting accepts only IP addresses", () => {
  assert.deepEqual([...parseTrustedProxies("")], []);
  assert.deepEqual([...parseTrustedProxies(undefined)], []);
  assert.deepEqual([...parseTrustedProxies(" 127.0.0.1 , ::1 ")], ["127.0.0.1", "::1"]);
  assert.throws(() => parseTrustedProxies("localhost"), (error) =>
    error.code === "trusted_proxies_invalid" && /must list IP addresses/.test(error.message));
  assert.equal(normalizeAddress("::FFFF:10.1.2.3"), "10.1.2.3");
});

test("IPv6 clients share one limit per /64; IPv4 clients are per address", () => {
  for (const address of ["2001:db8::1", "2001:db8:0:0:ffff::1", "2001:db8:0:0:1:2:3:4"])
    assert.equal(limitKey(address), "2001:db8:0:0::/64", address);
  assert.equal(limitKey("2001:db8:0:1::1"), "2001:db8:0:1::/64");
  assert.equal(limitKey("64:ff9b::1.2.3.4"), "64:ff9b:0:0::/64");
  assert.equal(limitKey("203.0.113.7"), "203.0.113.7");
});

test("when the limit table is full, a new client is refused before its code is checked", () => {
  // Review finding on #175: a new client that could not be charged must not
  // get a 200 for the right code and a 429 for a wrong one.
  const service = new PairingService({ maxRateBuckets: 2 });
  const adult = service.bootstrap({ credential: credential("adult") });
  for (const key of ["first", "second"])
    assert.throws(() => service.validatePairingCode("BAD", { rateKey: key }), (error) => error.code === "invalid_code");
  const invitation = service.createPairing(adult.sessionToken);
  for (const code of ["BAD", invitation.code])
    assert.throws(() => service.validatePairingCode(code, { rateKey: "overflow" }), (error) => error.code === "rate_limited", code);
  assert.throws(
    () => service.claimPairing({ code: invitation.code, credential: credential("o"), deviceLabel: "O", rateKey: "overflow" }),
    (error) => error.code === "rate_limited",
  );
  // Clients already in the table keep working.
  assert.equal(service.validatePairingCode(invitation.code, { rateKey: "first" }).valid, true);
});

test("successful pairing attempts do not spend a client's budget", () => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("adult") });
  for (let index = 0; index < RATE_LIMIT + 5; index += 1) {
    const invitation = service.createPairing(adult.sessionToken);
    assert.equal(service.validatePairingCode(invitation.code, { rateKey: "home" }).valid, true);
    service.revokePairing(adult.sessionToken, invitation.pairingId);
  }
  assert.equal(service.rateBuckets.has("home"), false);
});

test("once a client is over the limit, even a valid code is refused (no guessing oracle)", () => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("adult") });
  for (let index = 0; index < RATE_LIMIT; index += 1)
    assert.throws(() => service.validatePairingCode(`BAD-${index}`, { rateKey: "guesser" }), (error) => error.code === "invalid_code");
  const invitation = service.createPairing(adult.sessionToken);
  assert.throws(() => service.validatePairingCode(invitation.code, { rateKey: "guesser" }), (error) => error.code === "rate_limited");
  assert.throws(
    () => service.claimPairing({ code: invitation.code, credential: credential("x"), deviceLabel: "X", rateKey: "guesser" }),
    (error) => error.code === "rate_limited",
  );
  // Another client is unaffected and can claim.
  const claim = service.claimPairing({ code: invitation.code, credential: credential("b"), deviceLabel: "B", rateKey: "family" });
  assert.ok(claim.claimToken);
});

async function startServer(trustedProxies) {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("adult") });
  const store = new DurableStore(":memory:");
  const application = createKinServer({ service, store, origin: "http://localhost", trustedProxies });
  await new Promise((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const preflight = (code, forwarded) => fetch(`${url}/api/passkeys/register/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(forwarded ? { "X-Forwarded-For": forwarded } : {}) },
    body: JSON.stringify({ purpose: "claim", code, deviceLabel: "Phone" }),
  });
  const close = () => new Promise((resolve) => application.server.close(resolve)).finally(() => store.close());
  return { service, adult, preflight, close };
}

test("behind a trusted proxy, one client's bad codes do not block another client's valid code", async () => {
  const server = await startServer(PROXY);
  try {
    for (let index = 0; index <= RATE_LIMIT; index += 1) {
      const response = await server.preflight(`BAD-${index}`, "203.0.113.66");
      assert.equal(response.status, index < RATE_LIMIT ? 404 : 429, `attempt ${index}`);
    }
    const invitation = server.service.createPairing(server.adult.sessionToken);
    const response = await server.preflight(invitation.code, "198.51.100.20");
    assert.equal(response.status, 200);
    // The guesser stays limited, valid code or not.
    assert.equal((await server.preflight(invitation.code, "203.0.113.66")).status, 429);
  } finally {
    await server.close();
  }
});

test("without the setting, a forged X-Forwarded-For cannot dodge the limit", async () => {
  const server = await startServer(undefined);
  try {
    for (let index = 0; index < RATE_LIMIT; index += 1)
      assert.equal((await server.preflight(`BAD-${index}`, `203.0.113.${index}`)).status, 404);
    const invitation = server.service.createPairing(server.adult.sessionToken);
    assert.equal((await server.preflight(invitation.code, "198.51.100.20")).status, 429);
  } finally {
    await server.close();
  }
});
