import test from "node:test";
import assert from "node:assert/strict";
import { authenticatePrf } from "./passkey-unlock.js";
import { toBase64Url } from "./local-vault.js";

async function fixture(action, { supported = true, accepted = true } = {}) {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalCredential = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
  const result = new Uint8Array(32).fill(42);
  const calls = [];
  let request;
  Object.defineProperty(globalThis, "PublicKeyCredential", { value: class {}, configurable: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { credentials: { get: async (options) => {
    request = options;
    return { id: "AQID", type: "public-key", response: {
      clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer, userHandle: null,
    }, getClientExtensionResults: () => supported ? { prf: { results: { first: result.buffer } } } : {} };
  } } } });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/options")) return { ok: true, json: async () => ({ flow: "single-use", publicKey: {
      challenge: "AQID", rpId: "localhost", allowCredentials: [{ type: "public-key", id: "AQID" }],
    } }) };
    return { ok: accepted };
  };
  try { await action({ result, calls, request: () => request }); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
    if (originalCredential) Object.defineProperty(globalThis, "PublicKeyCredential", originalCredential); else delete globalThis.PublicKeyCredential;
  }
}

test("PRF requires UV and server verification and never transmits its secret", async () => {
  await fixture(async ({ result, calls, request }) => {
    const controller = new AbortController();
    const value = await authenticatePrf(null, { signal: controller.signal });
    assert.equal(request().publicKey.userVerification, "required");
    assert.equal(request().publicKey.extensions.prf.eval.first.length, 32);
    assert.equal(value.secret.length, 32);
    assert.equal(value.secret[0], 42);
    assert.ok(result.every((byte) => byte === 0));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[1].options.signal, controller.signal);
    assert.equal(request().signal, controller.signal);
    assert.ok(!calls[1].options.body.includes(toBase64Url(value.secret)));
    assert.equal(JSON.parse(calls[1].options.body).credential.id, "AQID");
    value.secret.fill(0);
  });
});

test("missing PRF result fails explicitly without plaintext fallback", async () => {
  await fixture(async ({ calls }) => {
    await assert.rejects(authenticatePrf(), { code: "unsupported_unlock" });
    assert.equal(calls.length, 1);
  }, { supported: false });
});

test("server rejection cannot unlock even with PRF output", async () => {
  await fixture(async ({ result }) => {
    await assert.rejects(authenticatePrf(), { code: "authentication_failed" });
    assert.ok(result.every((byte) => byte === 0));
  }, { accepted: false });
});

test("credential-bound wrapper rejects a different authorized credential", async () => {
  await fixture(async ({ request }) => {
    await assert.rejects(authenticatePrf({ credentialId: "BAUG", prfSalt: toBase64Url(new Uint8Array(32)) }), { code: "credential_unavailable" });
    assert.equal(request(), undefined);
  });
});
