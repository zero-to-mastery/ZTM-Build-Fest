// The TLS hook (#726, #727): acme-tls/1 answers only for a pending name,
// ordinary connections keep the server's certificate, challenge connections
// never reach HTTP, and setSecureContext swaps the certificate live.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer } from "node:tls";
import test from "node:test";
import { certificateExtensions, validateTlsAlpn } from "./acme-test-server.mjs";
import { generateP256Key, privateKeyPem } from "./keys.mjs";
import { ChallengeResponder, keyAuthorizationDigest } from "./tls-alpn.mjs";
import { acmeTlsServerOptions, applyCertificate, closeChallengeConnections } from "./tls-hook.mjs";
import { OID, buildCertificate, spkiDer, subjectAltNameExtension, toPem } from "./x509.mjs";

const NAME = "fern.home.kin.test";

/** A self-signed stand-in for the home server's real certificate. */
function serverCertificate(subject) {
  const key = generateP256Key();
  const der = buildCertificate({ subjectPublicKeyInfo: spkiDer(key), subject, notBefore: Date.now() - 60_000, notAfter: Date.now() + 86_400_000, extensions: [subjectAltNameExtension([NAME])], signingKey: key });
  return { key, chainPem: toPem(der, "CERTIFICATE"), fingerprint: new X509Certificate(der).fingerprint256 };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function handshake(port, { servername = NAME, ALPNProtocols } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, servername, ALPNProtocols, rejectUnauthorized: false });
    socket.on("secureConnect", () => {
      const raw = socket.getPeerCertificate(false).raw;
      const result = { ok: true, alpn: socket.alpnProtocol, fingerprint: new X509Certificate(raw).fingerprint256, raw, data: "" };
      socket.on("data", (chunk) => { result.data += chunk; });
      socket.on("close", () => resolve(result));
      socket.on("error", () => {});
    });
    socket.on("error", (error) => resolve({ ok: false, error: error.code ?? error.message }));
  });
}

async function setup(t, { https = false } = {}) {
  const responder = new ChallengeResponder();
  const initial = serverCertificate("first");
  const requests = [];
  const options = { key: privateKeyPem(initial.key), cert: initial.chainPem, ...acmeTlsServerOptions({ responder }) };
  const server = https
    ? createHttpsServer(options, (request, response) => { requests.push(request.url); response.end("app"); })
    : createServer(options, (socket) => socket.end("app"));
  closeChallengeConnections(server);
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { responder, server, port, initial, requests };
}

test("ALPNCallback runs before SNICallback with the socket as this (the hook relies on it)", async (t) => {
  const order = [];
  const initial = serverCertificate("probe");
  const server = createServer({
    key: privateKeyPem(initial.key), cert: initial.chainPem,
    ALPNCallback({ protocols }) { order.push(["alpn", this?.constructor?.name]); return protocols[0]; },
    SNICallback(name, done) { order.push(["sni", this?.constructor?.name]); done(null); },
  }, (socket) => socket.end());
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await handshake(port, { ALPNProtocols: ["acme-tls/1"] });
  assert.deepEqual(order, [["alpn", "TLSSocket"], ["sni", "TLSSocket"]]);
});

test("a pending name answers acme-tls/1 with the validation certificate, and the connection carries no data", async (t) => {
  const { responder, port } = await setup(t);
  responder.add(NAME, "token.thumbprint");
  const result = await handshake(port, { ALPNProtocols: ["acme-tls/1"] });
  assert.equal(result.alpn, "acme-tls/1");
  assert.equal(result.data, "", "no application data on a challenge connection");
  const identifier = certificateExtensions(result.raw).find((item) => item.oid === OID.acmeIdentifier);
  assert.ok(identifier?.critical);
  assert.ok(identifier.value.subarray(2).equals(keyAuthorizationDigest("token.thumbprint")));
  assert.deepEqual(await validateTlsAlpn({ port, name: NAME, keyAuthorization: "token.thumbprint" }), { ok: true });
});

test("ordinary connections get the real certificate and http/1.1, even while a challenge is pending", async (t) => {
  const { responder, port, initial } = await setup(t);
  responder.add(NAME, "token.thumbprint");
  for (const ALPNProtocols of [["http/1.1"], ["h2", "http/1.1"], undefined]) {
    const result = await handshake(port, { ALPNProtocols });
    assert.equal(result.fingerprint, initial.fingerprint);
    assert.equal(result.alpn, ALPNProtocols ? "http/1.1" : false);
    assert.equal(result.data, "app");
  }
});

test("acme-tls/1 is refused for a name with no pending answer, and for other names", async (t) => {
  const { responder, port } = await setup(t);
  assert.equal((await handshake(port, { ALPNProtocols: ["acme-tls/1"] })).ok, false);
  responder.add(NAME, "token.thumbprint");
  assert.equal((await handshake(port, { servername: "other.home.kin.test", ALPNProtocols: ["acme-tls/1"] })).ok, false);
  responder.remove(NAME);
  assert.equal((await handshake(port, { ALPNProtocols: ["acme-tls/1"] })).ok, false);
});

test("on an HTTPS server, challenge connections never reach the request handler", async (t) => {
  const { responder, port, requests } = await setup(t, { https: true });
  responder.add(NAME, "token.thumbprint");
  const result = await handshake(port, { ALPNProtocols: ["acme-tls/1"] });
  assert.equal(result.alpn, "acme-tls/1");
  assert.deepEqual(requests, []);
});

test("applyCertificate swaps the certificate without a restart and keeps the ACME hook", async (t) => {
  const { responder, server, port, initial } = await setup(t);
  assert.equal((await handshake(port, { ALPNProtocols: ["http/1.1"] })).fingerprint, initial.fingerprint);
  const next = serverCertificate("second");
  applyCertificate(server, next);
  assert.equal((await handshake(port, { ALPNProtocols: ["http/1.1"] })).fingerprint, next.fingerprint);
  responder.add(NAME, "token.thumbprint");
  assert.deepEqual(await validateTlsAlpn({ port, name: NAME, keyAuthorization: "token.thumbprint" }), { ok: true });
});
