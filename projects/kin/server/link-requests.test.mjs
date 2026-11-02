// Link requests (#99): a phone signs a computer in. The authority matrix,
// expiry, replay, wrong secret, fingerprint mismatch, code attempts, capacity,
// a revoked phone or a deleted household mid-flow, cancellation from either
// side, and the HTTP routes.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { createDeviceAuthorizationCertificate, deviceKeyFingerprint } from "../web/sync/crypto.js";
import { DurableStore } from "./durable-store.mjs";
import {
  LINK_CODE_ATTEMPTS, LINK_CODE_TTL_MS, LINK_REQUEST_TTL_MS, MAX_LINK_REQUESTS_PER_CLIENT, MAX_TRUSTED_DEVICES, PairingError,
  PairingService, RATE_LIMIT,
} from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

globalThis.crypto ??= webcrypto;

/** The phone's tag (web/device-link.js linkTag); the service only keeps it. */
const TAG = "T".repeat(43);
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const refused = (code) => (error) => error instanceof PairingError && error.code === code;

async function keyPair() {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  return {
    signingKey: signing.privateKey,
    publicKeys: {
      agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey),
      signing: await crypto.subtle.exportKey("jwk", signing.publicKey),
    },
  };
}

/** A household with one Adult whose phone is a trusted device with keys. */
async function household({ now } = {}) {
  let clock = 1_000_000;
  const service = new PairingService({ now: now ?? (() => clock) });
  const phoneKeys = await keyPair();
  const phone = service.bootstrap({ credential: credential("phone"), deviceLabel: "iPhone", syncPublicKeys: phoneKeys.publicKeys });
  return { service, phone, phoneKeys, advance: (ms) => { clock += ms; } };
}

/** The certificate the phone signs for the computer in `view`. */
async function certificateFor({ phone, phoneKeys }, view) {
  return createDeviceAuthorizationCertificate({
    householdId: view.householdId,
    memberId: view.memberId,
    deviceId: view.deviceId,
    issuerDeviceId: phone.deviceId,
    issuerFingerprint: await deviceKeyFingerprint(phoneKeys.publicKeys),
    publicKeys: view.syncPublicKeys,
    signingKey: phoneKeys.signingKey,
  });
}

/** A computer asks, the phone approves; returns everything a test needs. */
async function approved(h, { computerKeys, deviceToken, rateKey = "198.51.100.1" } = {}) {
  const keys = computerKeys ?? (await keyPair());
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, deviceLabel: "Chrome on Windows", deviceToken, rateKey });
  const scan = { secret: request.secret, fingerprint: request.fingerprint };
  const view = h.service.linkRequestForApprover(h.phone.sessionToken, request.requestId, scan);
  const deviceCertificate = view.existingDevice ? undefined : await certificateFor(h, view);
  // The phone derives the code (web/device-link.js); any six digits do here.
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const approval = { ...h.service.approveLinkRequest(h.phone.sessionToken, request.requestId, { ...scan, deviceCertificate, code, tag: TAG }), code };
  return { request, view, approval, keys, rateKey };
}

test("a new computer becomes a trusted device of the approving member", async () => {
  const h = await household();
  const devicesBefore = h.service.devices.size;
  const { request, view, approval, rateKey } = await approved(h);
  assert.equal(view.existingDevice, false);
  assert.equal(view.deviceLabel, "Chrome on Windows", "the phone shows the computer's automatic name");
  assert.equal(view.memberId, h.phone.memberId, "signing in as the phone's member");
  const status = h.service.linkStatus(request.requestId, request.secret);
  assert.equal(status.state, "approved");
  assert.deepEqual(Object.keys(status).sort(), ["expiresAt", "state"], "the status says nothing about the approver");

  const done = h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: approval.code, rateKey });
  assert.equal(done.newDevice, true);
  assert.equal(done.memberId, h.phone.memberId);
  assert.equal(done.deviceId, view.deviceId);
  assert.equal(done.approverDeviceId, h.phone.deviceId, "a correct code releases which device approved");
  assert.equal(done.approverFingerprint, h.service.devices.get(h.phone.deviceId).syncKeyFingerprint, "its key");
  assert.equal(done.tag, TAG, "and the phone's tag, for the computer to check");
  const device = h.service.devices.get(done.deviceId);
  assert.equal(device.label, "Chrome on Windows");
  assert.equal(device.syncKeyFingerprint, request.fingerprint);
  assert.equal(device.deviceAuthorizationCertificate.issuerDeviceId, h.phone.deviceId, "the phone signed its certificate");
  assert.equal(h.service.devices.size, devicesBefore + 1);
  assert.equal(h.service.authorize(done.sessionToken).device.id, done.deviceId, "the computer has a session");
  assert.equal(h.service.trustedDevice(done.deviceToken).device.id, done.deviceId, "and a device token");
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "done");
  const types = h.service.events.map((event) => event.type);
  for (const type of ["device_link_requested", "device_link_approved", "device_trusted", "device_link_completed"])
    assert.ok(types.includes(type), type);
});

test("a computer already trusted for that member is signed back in, with its token rotated", async () => {
  const h = await household();
  const first = await approved(h);
  const done = h.service.completeLinkRequest({ requestId: first.request.requestId, secret: first.request.secret, code: first.approval.code, rateKey: first.rateKey });
  h.service.logout(done.sessionToken); // the session ended
  const devicesBefore = h.service.devices.size;
  const again = await approved(h, { computerKeys: first.keys, deviceToken: done.deviceToken });
  assert.equal(again.view.existingDevice, true);
  assert.equal(again.view.deviceId, done.deviceId);
  const back = h.service.completeLinkRequest({ requestId: again.request.requestId, secret: again.request.secret, code: again.approval.code, rateKey: again.rateKey });
  assert.equal(back.newDevice, false);
  assert.equal(back.deviceId, done.deviceId);
  assert.equal(h.service.devices.size, devicesBefore, "no second device");
  assert.throws(() => h.service.trustedDevice(done.deviceToken), refused("device_not_trusted"), "the old device token is rotated out");
  assert.equal(h.service.trustedDevice(back.deviceToken).device.id, done.deviceId);
  assert.equal(h.service.authorize(back.sessionToken).device.id, done.deviceId);
});

test("a trusted computer with different keys is added as a new device instead", async () => {
  const h = await household();
  const first = await approved(h);
  const done = h.service.completeLinkRequest({ requestId: first.request.requestId, secret: first.request.secret, code: first.approval.code, rateKey: first.rateKey });
  const again = await approved(h, { deviceToken: done.deviceToken }); // new keys
  assert.equal(again.view.existingDevice, false, "keys the service hasn't trusted can't reuse the old device");
});

test("an expired request grants nothing", async () => {
  const h = await household();
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  h.advance(LINK_REQUEST_TTL_MS + 1);
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "ended");
  assert.throws(() => h.service.linkRequestForApprover(h.phone.sessionToken, request.requestId, { secret: request.secret, fingerprint: request.fingerprint }), refused("link_unavailable"));

  const late = await approved(h);
  h.advance(LINK_CODE_TTL_MS + 1);
  assert.throws(() => h.service.completeLinkRequest({ requestId: late.request.requestId, secret: late.request.secret, code: late.approval.code }), refused("link_unavailable"), "an approved code expires too");
});

test("a used request can't be completed or approved again", async () => {
  const h = await household();
  const { request, approval, rateKey } = await approved(h);
  h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: approval.code, rateKey });
  assert.throws(() => h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: approval.code, rateKey }), refused("link_unavailable"));
  assert.throws(() => h.service.linkRequestForApprover(h.phone.sessionToken, request.requestId, { secret: request.secret, fingerprint: request.fingerprint }), refused("link_unavailable"));
});

test("a wrong secret looks exactly like a request that doesn't exist", async () => {
  const h = await household();
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  const wrong = "A".repeat(43);
  for (const attempt of [
    () => h.service.linkStatus(request.requestId, wrong),
    () => h.service.cancelLinkRequest(request.requestId, wrong),
    () => h.service.completeLinkRequest({ requestId: request.requestId, secret: wrong, code: "000000" }),
    () => h.service.linkStatus("f".repeat(32), request.secret),
    () => h.service.linkStatus(request.requestId, undefined),
  ]) assert.throws(attempt, (error) => refused("link_unavailable")(error) && error.status === 410);
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "pending", "the real request is untouched");
});

test("a scanned fingerprint that doesn't match the stored keys ends the request", async () => {
  const h = await household();
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  assert.throws(() => h.service.linkRequestForApprover(h.phone.sessionToken, request.requestId, { secret: request.secret, fingerprint: "0".repeat(64) }), refused("link_fingerprint_mismatch"));
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "ended");
});

test("three wrong codes end the request", async () => {
  const h = await household();
  const { request, approval, rateKey } = await approved(h);
  const wrong = approval.code === "000000" ? "000001" : "000000";
  for (let attempt = 1; attempt < LINK_CODE_ATTEMPTS; attempt += 1)
    assert.throws(() => h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: wrong, rateKey }), refused("link_code_mismatch"));
  assert.throws(() => h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: wrong, rateKey }), refused("link_code_attempts"));
  assert.throws(() => h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: approval.code, rateKey }), refused("link_unavailable"), "the right code is too late");
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "ended");
});

test("the code is useless before the phone approves", async () => {
  const h = await household();
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  assert.throws(() => h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: "123456" }), refused("link_not_approved"));
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "pending", "asking early doesn't end it");
});

test("a new computer needs the phone's certificate", async () => {
  const h = await household();
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  const scan = { secret: request.secret, fingerprint: request.fingerprint };
  assert.throws(() => h.service.approveLinkRequest(h.phone.sessionToken, request.requestId, { ...scan, code: "123456", tag: TAG }), refused("device_certificate_invalid"));
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "pending");
});

test("only an Adult's trusted session can approve", async () => {
  const h = await household();
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  const scan = { secret: request.secret, fingerprint: request.fingerprint };
  assert.throws(() => h.service.linkRequestForApprover("no-session", request.requestId, scan), refused("authentication_required"));
  h.service.members.get(h.phone.memberId).kind = "limited";
  assert.throws(() => h.service.linkRequestForApprover(h.phone.sessionToken, request.requestId, scan), refused("adult_required"),
    "Limited members follow their existing device rules");
});

test("a household at its device limit can't add a computer", async () => {
  const h = await household();
  for (let index = h.service.activeTrustedDeviceCount(h.service.households.get(h.phone.householdId)); index < MAX_TRUSTED_DEVICES; index += 1) {
    const id = index.toString(16).padStart(32, "0");
    h.service.devices.set(id, { id, memberId: h.phone.memberId, householdId: h.phone.householdId, label: "Device", trustedAt: 1, revokedAt: null });
  }
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  assert.throws(() => h.service.linkRequestForApprover(h.phone.sessionToken, request.requestId, { secret: request.secret, fingerprint: request.fingerprint }), refused("device_limit"));
});

test("a phone revoked after approving can't finish the sign-in", async () => {
  const h = await household();
  const { request, approval, rateKey } = await approved(h);
  const devicesBefore = h.service.devices.size;
  h.service.devices.get(h.phone.deviceId).revokedAt = 2_000_000;
  assert.throws(() => h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: approval.code, rateKey }), refused("link_unavailable"));
  assert.equal(h.service.devices.size, devicesBefore, "nothing was added");
  assert.ok(h.service.events.some((event) => event.type === "device_link_failed" && event.reason === "approver_revoked"));
});

test("a household being deleted can't gain a computer mid-flow", async () => {
  const h = await household();
  const { request, approval, rateKey } = await approved(h);
  h.service.households.get(h.phone.householdId).lifecycleState = "deletion_pending";
  assert.throws(() => h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: approval.code, rateKey }), refused("link_unavailable"));
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "ended");
});

test("either side can cancel", async () => {
  const h = await household();
  const keys = await keyPair();
  const computerSide = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "x" });
  assert.deepEqual(h.service.cancelLinkRequest(computerSide.requestId, computerSide.secret), { state: "ended" });
  assert.throws(() => h.service.linkRequestForApprover(h.phone.sessionToken, computerSide.requestId, { secret: computerSide.secret, fingerprint: computerSide.fingerprint }), refused("link_unavailable"));

  const phoneSide = await approved(h);
  h.service.cancelLinkRequest(phoneSide.request.requestId, phoneSide.request.secret); // the phone scanned the secret
  assert.throws(() => h.service.completeLinkRequest({ requestId: phoneSide.request.requestId, secret: phoneSide.request.secret, code: phoneSide.approval.code }), refused("link_unavailable"));
});

test("requests are rate-limited per client, whether or not they succeed", async () => {
  const h = await household();
  const keys = await keyPair();
  for (let index = 0; index < RATE_LIMIT; index += 1) {
    const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "203.0.113.9" });
    h.service.cancelLinkRequest(request.requestId, request.secret); // cancelled ones count too
  }
  assert.throws(() => h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "203.0.113.9" }), refused("rate_limited"));
  h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "198.51.100.2" }); // another client is unaffected
});

test("a client holds only a few live requests, and ended ones don't count against anyone", async () => {
  const h = await household();
  const keys = await keyPair();
  const make = (rateKey = "203.0.113.20") => h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey });
  const held = Array.from({ length: MAX_LINK_REQUESTS_PER_CLIENT }, () => make());
  assert.throws(() => make(), refused("rate_limited"));
  make("198.51.100.20"); // another client is unaffected
  h.service.cancelLinkRequest(held[0].requestId, held[0].secret);
  make(); // a cancelled request frees its place at once
});

test("link limits keep their own buckets, so they can't crowd out pairing-code limits", async () => {
  let clock = 1_000_000;
  const service = new PairingService({ now: () => clock, maxRateBuckets: 2 });
  const keys = await keyPair();
  service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "a" });
  service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "b" });
  assert.equal(service.rateBuckets.size, 0, "the pairing-code table is untouched");
  assert.equal(service.linkRateBuckets.size, 2);
  assert.throws(() => service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "c" }), refused("rate_limited"));
  assert.equal(service.events.at(-1).type, "device_link_rate_limited");
});

test("a returning computer is told so only when its cookie names the device with those keys", async () => {
  const h = await household();
  const first = await approved(h);
  const done = h.service.completeLinkRequest({ requestId: first.request.requestId, secret: first.request.secret, code: first.approval.code, rateKey: first.rateKey });
  const ask = (syncPublicKeys, deviceToken) => h.service.createLinkRequest({ syncPublicKeys, deviceToken, rateKey: "198.51.100.30" });
  assert.equal(ask(first.keys.publicKeys, done.deviceToken).returning, true);
  assert.equal(ask(first.keys.publicKeys).returning, false, "no cookie");
  assert.equal(ask((await keyPair()).publicKeys, done.deviceToken).returning, false, "other keys");
});

test("a computer set up for one account can't be signed in to another, and keys are never shared", async () => {
  const h = await household();
  const first = await approved(h);
  const done = h.service.completeLinkRequest({ requestId: first.request.requestId, secret: first.request.secret, code: first.approval.code, rateKey: first.rateKey });
  // An Adult of another household scans this computer's code.
  const otherKeys = await keyPair();
  const other = { service: h.service, phoneKeys: otherKeys,
    phone: h.service.bootstrap({ credential: credential("other-phone"), syncPublicKeys: otherKeys.publicKeys }) };
  for (const deviceToken of [done.deviceToken, undefined]) {
    const request = h.service.createLinkRequest({ syncPublicKeys: first.keys.publicKeys, deviceToken, rateKey: "198.51.100.31" });
    assert.throws(
      () => other.service.linkRequestForApprover(other.phone.sessionToken, request.requestId, { secret: request.secret, fingerprint: request.fingerprint }),
      refused("link_device_taken"),
    );
    assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "ended", "the request ends");
  }
  // The same member, without the cookie, can't make a second device of those keys either.
  const bare = h.service.createLinkRequest({ syncPublicKeys: first.keys.publicKeys, rateKey: "198.51.100.32" });
  assert.throws(
    () => h.service.linkRequestForApprover(h.phone.sessionToken, bare.requestId, { secret: bare.secret, fingerprint: bare.fingerprint }),
    refused("link_device_taken"),
  );
  assert.equal([...h.service.devices.values()].filter((device) => device.syncKeyFingerprint === first.request.fingerprint).length, 1);
});

test("the phone's code must be six digits, with a well-formed tag", async () => {
  const h = await household();
  const keys = await keyPair();
  const request = h.service.createLinkRequest({ syncPublicKeys: keys.publicKeys, rateKey: "198.51.100.40" });
  const scan = { secret: request.secret, fingerprint: request.fingerprint };
  const view = h.service.linkRequestForApprover(h.phone.sessionToken, request.requestId, scan);
  const deviceCertificate = await certificateFor(h, view);
  for (const [code, tag] of [[undefined, TAG], ["12345", TAG], ["1234567", TAG], ["12345a", TAG], [123456, TAG], ["123456", undefined], ["123456", "short"], ["123456", `${TAG}=`]])
    assert.throws(() => h.service.approveLinkRequest(h.phone.sessionToken, request.requestId, { ...scan, deviceCertificate, code, tag }), refused("invalid_request"));
  assert.equal(h.service.linkStatus(request.requestId, request.secret).state, "pending");
});

test("no secret or code is kept or audited", async () => {
  const h = await household();
  const { request, approval, rateKey } = await approved(h);
  const stored = JSON.stringify([...h.service.linkRequests.values()], (key, value) => (Buffer.isBuffer(value) || value?.type === "Buffer" ? "<digest>" : value));
  assert.equal(stored.includes(request.secret), false, "only a verifier of the secret");
  assert.equal(stored.includes(approval.code), false, "only a hash of the code");
  h.service.completeLinkRequest({ requestId: request.requestId, secret: request.secret, code: approval.code, rateKey });
  const audited = JSON.stringify(h.service.events);
  assert.equal(audited.includes(request.secret), false);
  assert.equal(audited.includes(approval.code), false);
});

// ---- HTTP -------------------------------------------------------------------

const webauthn = () => ({
  registrationOptions: (flow) => ({ challenge: flow }),
  authenticationOptions: (flow) => ({ challenge: flow }),
  verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
  verifyAuthentication: () => true,
  discardFlow() {},
});

async function server() {
  const application = createKinServer({ store: new DurableStore(":memory:"), webauthn: webauthn(), origin: "http://localhost" });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const requests = [];
  application.server.on("request", (request) => requests.push(request.url));
  const call = async (method, path, body, cookie = "") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]).filter((value) => !value.endsWith("="));
    return { status: response.status, body: await response.json(), cookies: cookies.join("; ") };
  };
  return {
    application, call, requests,
    close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => application.store.close()),
  };
}

test("over HTTP: request, approve with a passkey, complete with the code, and sign in", async () => {
  const s = await server();
  try {
    const phoneKeys = await keyPair();
    const options = await s.call("POST", "/api/passkeys/register/options", { purpose: "bootstrap", deviceLabel: "iPhone" });
    const credentialId = `phone-${options.body.flow}`;
    const phone = await s.call("POST", "/api/passkeys/register/finish", { flow: options.body.flow, credential: { id: credentialId }, syncPublicKeys: phoneKeys.publicKeys });
    assert.equal(phone.status, 201);

    const computerKeys = await keyPair();
    const created = await s.call("POST", "/api/link/requests", { syncPublicKeys: computerKeys.publicKeys, deviceLabel: "Chrome on Windows" });
    assert.equal(created.status, 201);
    const { requestId, secret, fingerprint } = created.body;
    assert.match(requestId, /^[a-f0-9]{32}$/);
    assert.deepEqual((await s.call("POST", `/api/link/requests/${requestId}/status`, { secret })).body.state, "pending");

    const approveOptions = await s.call("POST", `/api/link/requests/${requestId}/approve/options`, { secret, fingerprint }, phone.cookies);
    assert.equal(approveOptions.status, 200);
    const view = approveOptions.body.request;
    assert.equal(view.deviceLabel, "Chrome on Windows");
    const deviceCertificate = await certificateFor({ phone: { deviceId: phone.body.deviceId }, phoneKeys }, view);
    const code = "407153";
    const finish = await s.call("POST", `/api/link/requests/${requestId}/approve/finish`,
      { flow: approveOptions.body.flow, credential: { id: credentialId }, secret, fingerprint, deviceCertificate, code, tag: TAG }, phone.cookies);
    assert.equal(finish.status, 200);
    assert.equal("code" in finish.body, false, "the phone already knows its code");
    finish.body.code = code;

    const wrong = await s.call("POST", `/api/link/requests/${requestId}/complete`, { secret, code: finish.body.code === "000000" ? "000001" : "000000" });
    assert.equal(wrong.status, 400);
    const complete = await s.call("POST", `/api/link/requests/${requestId}/complete`, { secret, code: finish.body.code });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.newDevice, true);
    assert.equal(complete.body.tag, TAG, "the tag comes back only with a correct code");
    assert.equal("tag" in wrong.body, false);
    assert.equal("sessionToken" in complete.body || "deviceToken" in complete.body, false, "tokens travel only as cookies");
    assert.match(complete.cookies, /kin_session=/);
    assert.match(complete.cookies, /kin_device=/);
    const status = await s.call("GET", "/api/status", undefined, complete.cookies);
    assert.equal(status.body.identity.deviceId, view.deviceId, "the computer is signed in as the new device");
    assert.equal(status.body.identity.memberId, phone.body.memberId);
    assert.ok(s.requests.every((url) => !url.includes(secret) && !url.includes(finish.body.code)), "the secret and code never appear in a URL");
    const saved = s.application.store.db.prepare("SELECT event_type, details_json FROM security_audit").all();
    const types = saved.map((row) => row.event_type);
    for (const type of ["device_link_approved", "device_trusted", "device_link_completed"])
      assert.ok(types.includes(type), `${type} is saved with the household at once`);
    assert.ok(saved.every((row) => !row.details_json.includes(secret) && !row.details_json.includes(finish.body.code)));
    const directory = await s.call("GET", "/api/sync/devices", undefined, complete.cookies);
    const added = directory.body.devices.find((device) => device.deviceId === view.deviceId);
    assert.equal(added?.historyFromEpoch, 1, "the new computer receives the retained history");
  } finally {
    await s.close();
  }
});

/** A household created over HTTP: the phone's cookies, IDs and keys. */
async function httpPhone(s, label = "phone") {
  const phoneKeys = await keyPair();
  const options = await s.call("POST", "/api/passkeys/register/options", { purpose: "bootstrap", deviceLabel: "iPhone" });
  const credentialId = `${label}-${options.body.flow}`;
  const phone = await s.call("POST", "/api/passkeys/register/finish", { flow: options.body.flow, credential: { id: credentialId }, syncPublicKeys: phoneKeys.publicKeys });
  return { ...phone, phoneKeys, credentialId };
}

/** Request and approve over HTTP; returns the request and the code. */
async function httpApproved(s, phone) {
  const computerKeys = await keyPair();
  const created = await s.call("POST", "/api/link/requests", { syncPublicKeys: computerKeys.publicKeys, deviceLabel: "Chrome on Windows" });
  const { requestId, secret, fingerprint } = created.body;
  const options = await s.call("POST", `/api/link/requests/${requestId}/approve/options`, { secret, fingerprint }, phone.cookies);
  const deviceCertificate = await certificateFor({ phone: { deviceId: phone.body.deviceId }, phoneKeys: phone.phoneKeys }, options.body.request);
  const code = "582604";
  const finish = await s.call("POST", `/api/link/requests/${requestId}/approve/finish`,
    { flow: options.body.flow, credential: { id: phone.credentialId }, secret, fingerprint, deviceCertificate, code, tag: TAG }, phone.cookies);
  assert.equal(finish.status, 200);
  return { requestId, secret, code };
}

test("over HTTP: a request ended by a failing call keeps its audit, though the call rolls back", async () => {
  const s = await server();
  try {
    const phone = await httpPhone(s);
    const { requestId, secret, code } = await httpApproved(s, phone);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= LINK_CODE_ATTEMPTS; attempt += 1)
      await s.call("POST", `/api/link/requests/${requestId}/complete`, { secret, code: wrong });
    const rows = s.application.store.db.prepare("SELECT details_json FROM security_audit WHERE event_type = 'device_link_failed'").all();
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].details_json).reason, "code_attempts");
  } finally {
    await s.close();
  }
});

test("over HTTP: deleting a household ends its requests, and nothing can then break the store", async () => {
  const s = await server();
  try {
    const phone = await httpPhone(s);
    const bystander = await httpPhone(s, "bystander");
    const { requestId, secret } = await httpApproved(s, phone);
    const sessionToken = phone.cookies.match(/kin_session=([^;]+)/)[1];
    s.application.service.requestHouseholdDeletion(sessionToken, phone.body.memberId);
    const status = await s.call("POST", `/api/link/requests/${requestId}/status`, { secret });
    assert.equal(status.body.state, "ended", "the request ended with the household");
    assert.equal((await s.call("DELETE", `/api/link/requests/${requestId}`, { secret })).status, 200);
    assert.equal(s.application.store.failed, false);
    const other = await s.call("GET", "/api/status", undefined, bystander.cookies);
    assert.equal(other.status, 200, "every other household keeps working");
    assert.equal(other.body.identity.householdId, bystander.body.householdId);
  } finally {
    await s.close();
  }
});

test("over HTTP: the computer can cancel, and a cross-site request is refused", async () => {
  const s = await server();
  try {
    const keys = await keyPair();
    const created = await s.call("POST", "/api/link/requests", { syncPublicKeys: keys.publicKeys });
    const { requestId, secret } = created.body;
    assert.equal((await s.call("DELETE", `/api/link/requests/${requestId}`, { secret })).body.state, "ended");
    const after = await s.call("POST", `/api/link/requests/${requestId}/status`, { secret });
    assert.deepEqual([after.status, after.body.state], [200, "ended"], "the computer's poll sees that it ended");
    assert.equal((await s.call("POST", `/api/link/requests/${requestId}/status`, { secret: "wrong" })).status, 410);
    const crossSite = await fetch(`http://127.0.0.1:${s.application.server.address().port}/api/link/requests`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://elsewhere.example" }, body: JSON.stringify({ syncPublicKeys: keys.publicKeys }),
    });
    assert.equal(crossSite.status, 403);
  } finally {
    await s.close();
  }
});
