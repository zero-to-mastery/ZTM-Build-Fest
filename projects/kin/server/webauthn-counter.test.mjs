// Issue #158 (A5): a passkey's signature counter never goes down, and once
// it is above 0 an assertion must report a strictly higher one. Real ECDSA
// P-256 signatures over real authenticator data.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { WebAuthn } from "./webauthn.mjs";

const RP = "localhost";
const ORIGIN = "http://localhost";
const sha256 = (value) => createHash("sha256").update(value).digest();
const b64url = (value) => Buffer.from(value).toString("base64url");

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" });

/** A signed assertion for a fresh challenge, reporting `count`. */
function assertion(webauthn, count) {
  const challenge = webauthn.challenge("authenticate", "flow");
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(count);
  const authData = Buffer.concat([sha256(RP), Buffer.from([0x05]), counter]);
  const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
  return {
    id: "credential-a",
    response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature) },
  };
}

function passkey(signCount) {
  return { id: "credential-a", algorithm: -7, publicKey: PUBLIC_PEM, signCount };
}

const replayed = (error) =>
  error.code === "credential_replayed" &&
  /may|can mean it was copied/.test(error.message) &&
  /another passkey or your backup key/.test(error.message);

test("a stored count of 5 rejects an assertion reporting 0 and keeps 5", () => {
  const webauthn = new WebAuthn({ rpId: RP, origin: ORIGIN });
  const credential = passkey(5);
  assert.throws(() => webauthn.verifyAuthentication(assertion(webauthn, 0), "flow", credential), replayed);
  assert.equal(credential.signCount, 5);
});

test("a stored count rejects an equal or lower count and keeps the stored count", () => {
  const webauthn = new WebAuthn({ rpId: RP, origin: ORIGIN });
  const credential = passkey(5);
  for (const count of [5, 4, 1]) {
    assert.throws(() => webauthn.verifyAuthentication(assertion(webauthn, count), "flow", credential), replayed, String(count));
    assert.equal(credential.signCount, 5);
  }
});

test("a higher count is accepted and stored", () => {
  const webauthn = new WebAuthn({ rpId: RP, origin: ORIGIN });
  const credential = passkey(5);
  assert.equal(webauthn.verifyAuthentication(assertion(webauthn, 6), "flow", credential), true);
  assert.equal(credential.signCount, 6);
  assert.throws(() => webauthn.verifyAuthentication(assertion(webauthn, 0), "flow", credential), replayed);
  assert.equal(credential.signCount, 6);
});

test("an authenticator that always reports 0 keeps working", () => {
  const webauthn = new WebAuthn({ rpId: RP, origin: ORIGIN });
  const credential = passkey(0);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(webauthn.verifyAuthentication(assertion(webauthn, 0), "flow", credential), true);
    assert.equal(credential.signCount, 0);
  }
});

test("an authenticator that starts counting from 0 is then held to its counter", () => {
  const webauthn = new WebAuthn({ rpId: RP, origin: ORIGIN });
  const credential = passkey(0);
  assert.equal(webauthn.verifyAuthentication(assertion(webauthn, 3), "flow", credential), true);
  assert.equal(credential.signCount, 3);
  assert.throws(() => webauthn.verifyAuthentication(assertion(webauthn, 0), "flow", credential), replayed);
  assert.equal(credential.signCount, 3);
});
