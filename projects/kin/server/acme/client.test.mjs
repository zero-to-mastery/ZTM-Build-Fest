// ACME protocol client (#724) against the in-process test server, with a real
// TLS-ALPN-01 validation over loopback (#726). Never contacts a real CA.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { createServer } from "node:tls";
import test from "node:test";
import { startAcmeTestServer } from "./acme-test-server.mjs";
import { AcmeClient, AcmeError, ACME_ERROR_CODES, obtainCertificate, parseRetryAfter, problemToError } from "./client.mjs";
import { generateP256Key, jwkThumbprint } from "./keys.mjs";
import { ChallengeResponder } from "./tls-alpn.mjs";
import { acmeTlsServerOptions, closeChallengeConnections } from "./tls-hook.mjs";
import { createHttpsTransport } from "./transport.mjs";

const NAME = "fern.home.kin.test";

/** A home TLS server with no certificate of its own yet: before the first
 * issuance it can only answer challenges. */
async function startHome() {
  const responder = new ChallengeResponder();
  const server = createServer({ ...acmeTlsServerOptions({ responder }) }, (socket) => socket.end("app"));
  closeChallengeConnections(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { responder, server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function setup(t, options = {}) {
  const home = await startHome();
  const ca = await startAcmeTestServer({ validationPort: home.port, ...options });
  t.after(async () => { await ca.close(); await home.close(); });
  const delays = [];
  const client = new AcmeClient({
    directoryUrl: ca.directoryUrl,
    accountKey: generateP256Key(),
    transport: createHttpsTransport({ allowLoopbackHttp: true }),
    sleep: async (ms) => { delays.push(ms); },
  });
  return { home, ca, client, delays };
}

test("obtains a certificate end to end: account, order, TLS-ALPN-01 over loopback, finalize, download", async (t) => {
  const { home, ca, client, delays } = await setup(t);
  const certificateKey = generateP256Key();
  const { chainPem, orderUrl } = await obtainCertificate(client, { names: [NAME], certificateKey, responder: home.responder, termsOfServiceAgreed: true });

  assert.match(orderUrl, /\/order\//);
  const [leafPem, caPem] = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  const leaf = new X509Certificate(leafPem);
  assert.ok(leaf.verify(ca.caPublicKey), "leaf is signed by the CA");
  assert.equal(new X509Certificate(caPem).fingerprint256, new X509Certificate(ca.caPem).fingerprint256);
  assert.equal(leaf.subjectAltName, `DNS:${NAME}`);
  assert.ok(leaf.checkPrivateKey(certificateKey), "leaf certifies our key");
  assert.equal(ca.state.validations, 1, "the CA validated once, over a real TLS connection");
  assert.equal(home.responder.size, 0, "the challenge answer is removed afterwards");

  // JWS: jwk only on newAccount, kid afterwards; every request has a fresh nonce and its own url.
  const [first, ...rest] = ca.state.log;
  assert.equal(first.url, "/new-account");
  assert.ok(first.header.jwk && !first.header.kid);
  assert.deepEqual(Object.keys(first.header.jwk).sort(), ["crv", "kty", "x", "y"], "public members only");
  for (const entry of rest) { assert.equal(entry.header.kid, client.accountUrl); assert.equal(entry.header.jwk, undefined); }
  assert.equal(new Set(ca.state.log.map((entry) => entry.header.nonce)).size, ca.state.log.length);

  // Retry-After was honoured: 3 s on the pending authorization, 1 s on the processing order.
  assert.deepEqual(delays, [3000, 1000]);
});

test("the key authorization is token.thumbprint (RFC 8555 §8.1)", () => {
  const key = generateP256Key();
  const client = new AcmeClient({ directoryUrl: "https://ca.invalid/dir", accountKey: key, transport: async () => { throw new Error("offline"); } });
  assert.equal(client.keyAuthorization("evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA"), `evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA.${jwkThumbprint(key)}`);
  assert.throws(() => client.keyAuthorization("not a token!"), { code: "acme-bad-response" });
});

test("an existing account is found again rather than duplicated", async (t) => {
  const { ca, client } = await setup(t);
  const url = await client.ensureAccount({ termsOfServiceAgreed: true });
  const again = new AcmeClient({ directoryUrl: ca.directoryUrl, accountKey: client.accountKey, transport: client.transport });
  assert.equal(await again.ensureAccount({ termsOfServiceAgreed: true }), url);
  assert.equal(ca.state.accounts.size, 1);
});

test("the terms must be agreed before an account is made", async (t) => {
  const { client } = await setup(t);
  await assert.rejects(client.ensureAccount({}), { code: "acme-terms-not-agreed" });
});

test("a badNonce is retried with the nonce that came with it", async (t) => {
  const { ca, client } = await setup(t);
  await client.ensureAccount({ termsOfServiceAgreed: true });
  ca.badNonceOnce();
  const order = await client.newOrder([NAME]);
  assert.equal(order.status, "pending");
});

test("ACME problems become plain codes, with Retry-After kept for backoff", async (t) => {
  const { ca, client } = await setup(t);
  await client.ensureAccount({ termsOfServiceAgreed: true });
  ca.failNext("new-order", "rateLimited", { status: 429, retryAfter: 7200, detail: "too many certificates" });
  const error = await client.newOrder([NAME]).catch((caught) => caught);
  assert.ok(error instanceof AcmeError);
  assert.equal(error.code, "acme-rate-limited");
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 7_200_000);
  assert.equal(error.detail, "too many certificates");
});

test("a failed validation reports the CA's reason as a code", async (t) => {
  const { home, client } = await setup(t);
  // A responder that answers with the wrong key authorization.
  const wrong = { add: (name) => home.responder.add(name, "wrong.answer"), remove: (name) => home.responder.remove(name) };
  await assert.rejects(
    obtainCertificate(client, { names: [NAME], certificateKey: generateP256Key(), responder: wrong, termsOfServiceAgreed: true }),
    { code: "acme-incorrect-response" },
  );
  assert.equal(home.responder.size, 0);
});

test("problem documents map to codes, unknown ones to acme-error, compound to the first subproblem", () => {
  assert.equal(problemToError({ type: "urn:ietf:params:acme:error:caa" }).code, "acme-caa");
  assert.equal(problemToError({ type: "urn:ietf:params:acme:error:somethingNew" }).code, "acme-error");
  assert.equal(problemToError(null).code, "acme-error");
  assert.equal(problemToError({ type: "urn:ietf:params:acme:error:compound", subproblems: [{ type: "urn:ietf:params:acme:error:dns" }] }).code, "acme-dns");
  assert.equal(problemToError({ type: "urn:ietf:params:acme:error:malformed", detail: "x".repeat(1000) }).detail.length, 300);
  for (const code of ["acme-rate-limited", "acme-network", "acme-timeout", "acme-key-mismatch"]) assert.ok(ACME_ERROR_CODES.includes(code));
});

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter(new Date(10_000 + 30_000).toUTCString(), 10_000), 30_000);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});

test("the default transport refuses plain HTTP except to loopback when allowed", async () => {
  await assert.rejects(createHttpsTransport()("http://127.0.0.1:1/"), { code: "acme-insecure-url" });
  await assert.rejects(createHttpsTransport({ allowLoopbackHttp: true })("http://ca.example.org/"), { code: "acme-insecure-url" });
});

test("transport failures become acme-network", async () => {
  const client = new AcmeClient({ directoryUrl: "https://ca.invalid/dir", accountKey: generateP256Key(), transport: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(client.directory(), { code: "acme-network" });
});

test("polling gives up with acme-timeout after the poll limit", async (t) => {
  const { home, ca, client } = await setup(t, { holdPolls: 100 });
  client.pollLimit = 3;
  await assert.rejects(
    obtainCertificate(client, { names: [NAME], certificateKey: generateP256Key(), responder: home.responder, termsOfServiceAgreed: true }),
    { code: "acme-timeout" },
  );
  assert.equal(home.responder.size, 0);
  assert.equal(ca.state.issued.length, 0);
});
