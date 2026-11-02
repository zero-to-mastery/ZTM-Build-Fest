import test from "node:test";
import assert from "node:assert/strict";
import { authenticatePrf, authenticatePrfLocally, checkLocalAssertion } from "./passkey-unlock.js";
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

test("an unreachable identity service is reported as a connection problem, not a credential failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredential = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "PublicKeyCredential", { value: class {}, configurable: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { credentials: { get: async () => { throw new Error("must not reach the authenticator"); } } } });
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  try {
    await assert.rejects(authenticatePrf(), (error) => error.code === "connection_unavailable" && /backup key/.test(error.userMessage));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
    if (originalCredential) Object.defineProperty(globalThis, "PublicKeyCredential", originalCredential); else delete globalThis.PublicKeyCredential;
  }
});

// ---- Offline passkey unlock (#552) ------------------------------------------

/** An authenticator double: answers one assertion for `credentialId` with
 * clientData and authenticatorData built from the request it got. */
async function offlineFixture(action, { online = false, fetchFails = true, credentialId = "AQID", uv = true, origin = "https://kin.example", rpId = "kin.example", type = "webauthn.get", answerId = credentialId, prf = true } = {}) {
  const originals = ["fetch", "navigator", "PublicKeyCredential", "location"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const result = new Uint8Array(32).fill(7);
  const requests = [];
  const fetches = [];
  Object.defineProperty(globalThis, "PublicKeyCredential", { value: class {}, configurable: true });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://kin.example", hostname: "kin.example" } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: online, credentials: { get: async (options) => {
    requests.push(options);
    const clientData = new TextEncoder().encode(JSON.stringify({ type, challenge: toBase64Url(options.publicKey.challenge), origin }));
    const data = new Uint8Array(37);
    data.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId))), 0);
    data[32] = uv ? 0x05 : 0x01;
    return { id: answerId, type: "public-key", response: { clientDataJSON: clientData.buffer, authenticatorData: data.buffer, signature: new Uint8Array(64).buffer, userHandle: null },
      getClientExtensionResults: () => (prf ? { prf: { results: { first: result.buffer } } } : {}) };
  } } } });
  globalThis.fetch = async (url) => { fetches.push(url); if (fetchFails) throw new TypeError("Failed to fetch"); return { ok: false, status: 503, json: async () => ({}) }; };
  try { await action({ result, requests, fetches }); }
  finally {
    for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
}

const offlineWrapper = { credentialId: "AQID", prfSalt: toBase64Url(new Uint8Array(32).fill(3)) };

test("offline, the passkey unlocks with a local challenge: user verification required, nothing sent", async () => {
  await offlineFixture(async ({ result, requests, fetches }) => {
    const value = await authenticatePrf(offlineWrapper);
    assert.equal(fetches.length, 0, "a browser that says it's offline doesn't try the service");
    assert.equal(value.offline, true);
    assert.equal(value.secret[0], 7);
    assert.ok(result.every((byte) => byte === 0), "the browser's PRF buffer is zeroed");
    const { publicKey } = requests[0];
    assert.equal(publicKey.userVerification, "required");
    assert.equal(publicKey.challenge.length, 32, "a fresh 32-byte challenge made on this device");
    assert.deepEqual(publicKey.allowCredentials.map((entry) => toBase64Url(entry.id)), ["AQID"], "only this wrapper's passkey");
    assert.deepEqual([...publicKey.extensions.prf.eval.first], [...new Uint8Array(32).fill(3)], "the wrapper's own PRF salt");
    value.secret.fill(0);
  });
});

test("an unreachable service falls back to the local challenge; a refusing one does not", async () => {
  await offlineFixture(async ({ fetches }) => {
    const value = await authenticatePrf(offlineWrapper);
    assert.deepEqual(fetches, ["/api/login/options"], "online first, as before");
    assert.equal(value.offline, true);
  }, { online: true });
  await offlineFixture(async () => {
    assert.equal((await authenticatePrf(offlineWrapper)).offline, true, "a 5xx from a proxy counts as unreachable");
  }, { online: true, fetchFails: false });
  // Enrolling a new passkey still needs the service.
  await offlineFixture(async () => {
    await assert.rejects(authenticatePrf(null), { code: "connection_unavailable" });
  }, { online: true });
});

test("an offline unlock refuses a ceremony that wasn't this one", async () => {
  for (const options of [{ uv: false }, { origin: "https://elsewhere.example" }, { rpId: "elsewhere.example" }, { type: "webauthn.create" }, { answerId: "BAUG" }]) {
    await offlineFixture(async ({ result }) => {
      await assert.rejects(authenticatePrfLocally(offlineWrapper), { code: "authentication_failed" }, JSON.stringify(options));
      assert.ok(result.every((byte) => byte === 0), "the PRF output is zeroed even when refused");
    }, options);
  }
  await offlineFixture(async () => {
    await assert.rejects(authenticatePrfLocally(offlineWrapper), { code: "unsupported_unlock" });
  }, { prf: false });
  await assert.rejects(authenticatePrfLocally({ credentialId: "AQID" }, { credentials: { get: async () => null } }), { code: "credential_unavailable" });
});

test("checkLocalAssertion names a missing user verification plainly", async () => {
  const challenge = new Uint8Array(32).fill(1);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: toBase64Url(challenge), origin: "https://kin.example" }));
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kin.example"))), 0);
  authenticatorData[32] = 0x01;
  await assert.rejects(checkLocalAssertion({ clientDataJSON, authenticatorData }, { challenge, origin: "https://kin.example", rpId: "kin.example" }),
    (error) => error.code === "authentication_failed" && /confirm it's you/.test(error.message));
  authenticatorData[32] = 0x05;
  await checkLocalAssertion({ clientDataJSON, authenticatorData }, { challenge, origin: "https://kin.example", rpId: "kin.example" });
  await assert.rejects(checkLocalAssertion({ clientDataJSON: new Uint8Array([1]), authenticatorData }, { challenge, origin: "https://kin.example", rpId: "kin.example" }),
    { code: "authentication_failed" });
});

test("a device without a household credential gets an enrollment explanation", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredential = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "PublicKeyCredential", { value: class {}, configurable: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { credentials: { get: async () => { throw new Error("must not reach the authenticator"); } } } });
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: "device_not_trusted" }) });
  try {
    await assert.rejects(authenticatePrf(), (error) => error.code === "credential_unavailable" && /create or join your household/.test(error.userMessage) && !/device_not_trusted/.test(error.userMessage));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
    if (originalCredential) Object.defineProperty(globalThis, "PublicKeyCredential", originalCredential); else delete globalThis.PublicKeyCredential;
  }
});
