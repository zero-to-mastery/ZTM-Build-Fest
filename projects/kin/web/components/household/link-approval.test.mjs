// Add a computer, the phone's side (#101): the scanner accepts only sign-in
// links, the review names the computer and warns, Approve runs a fresh
// passkey and signs the certificate for the keys the camera saw, then the
// code is shown until the computer finishes. Without a browser.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";
import { deviceKeyFingerprint } from "../../sync/crypto.js";
import { linkNonce, linkTagMatches, signInLink } from "../../device-link.js";

globalThis.crypto ??= webcrypto;
const defined = installDom();
const ORIGIN = "https://kin.test";
Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: ORIGIN, pathname: "/" } });
globalThis.requestAnimationFrame = (callback) => callback();
const released = [];
globalThis.fetch = async (url, init) => {
  released.push({ url, init });
  return { ok: true, json: async () => ({}) };
};
let assertion = async () => ({ id: "cred", type: "public-key", response: { clientDataJSON: new Uint8Array([1]), authenticatorData: new Uint8Array([2]), signature: new Uint8Array([3]), userHandle: null } });
const assertions = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { credentials: { get: (options) => { assertions.push(options); return assertion(options); } } } });
const { HouseholdViews } = await import("./views.js");
const { HouseholdLinkApproval, APPROVE_WARNING } = await import("./link-approval.js");

async function keyPair() {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  return {
    keys: { signingPrivateKey: signing.privateKey },
    publicKeys: {
      agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey),
      signing: await crypto.subtle.exportKey("jwk", signing.publicKey),
    },
  };
}

const hex = (n, c) => c.repeat(n);
const phoneKeys = await keyPair();
const phoneFingerprint = await deviceKeyFingerprint(phoneKeys.publicKeys);
const computerKeys = await keyPair();
const computerFingerprint = await deviceKeyFingerprint(computerKeys.publicKeys);
const identity = { householdId: hex(32, "a"), memberId: hex(32, "b"), deviceId: hex(32, "c") };
const scan = { requestId: hex(32, "1"), secret: "s".repeat(43), fingerprint: computerFingerprint, nonce: linkNonce() };
const linkUrl = signInLink(ORIGIN, scan);
/** Whether the phone's tag binds this phone, this code and the QR nonce. */
const tagged = (body) => linkTagMatches(body.tag, { nonce: scan.nonce, code: body.code, requestId: scan.requestId,
  approverDeviceId: identity.deviceId, approverFingerprint: phoneFingerprint, computerFingerprint });
const view = (extra = {}) => ({
  requestId: scan.requestId, householdId: identity.householdId, memberId: identity.memberId, deviceId: hex(32, "e"),
  deviceLabel: "Chrome on Windows", syncPublicKeys: computerKeys.publicKeys, syncKeyFingerprint: computerFingerprint,
  existingDevice: false, expiresAt: Date.now() + 120_000, ...extra,
});
const publicKey = { challenge: "AQID", allowCredentials: [{ id: "AQID", type: "public-key" }] };

function rig({ routes = {} } = {}) {
  const calls = [];
  const pins = [];
  const syncs = [];
  const host = document.createElement("div");
  host.isConnected = true;
  let busy = false;
  Object.assign(host, {
    identity,
    localFingerprint: phoneFingerprint,
    pairing: null,
    syncStatus: { memberKind: "adult", enabled: true },
    syncKeyError: null,
    connectionAbort: new AbortController(),
    syncKeyStore: {
      getDevice: async (deviceId) => (deviceId === identity.deviceId ? { publicKeys: phoneKeys.publicKeys, keys: phoneKeys.keys } : null),
      pinTrustedDevice: async (pin) => { pins.push(pin); return pin; },
    },
    errors: [],
    async run(action) {
      if (busy) return;
      busy = true;
      try { await action(); } catch (error) { host.errors.push(error); } finally { busy = false; }
    },
    async api(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      const route = Object.entries(routes).find(([pattern]) => path.endsWith(pattern));
      if (!route) throw new Error(`unexpected ${path}`);
      return route[1](body);
    },
    text(content) { const p = document.createElement("p"); p.textContent = content; host.append(p); return p; },
    message(content) { return host.text(content); },
    button(label, action, className) { const b = host.makeButton(label, action, className); host.append(b); return b; },
    makeButton(label, action) { const b = document.createElement("button"); b.textContent = label; b.addEventListener("click", () => action?.()); return b; },
    showFingerprint() {},
    setControlDisabled() {},
    render() { host.replaceChildren(); views.renderMember(); },
    showDevices() {}, showHousehold() {}, createDevicePairing() {}, enableSync() {},
  });
  // A getter survives only through defineProperty (Object.assign copies values).
  Object.defineProperty(host, "busy", { get: () => busy });
  const ctx = { host, api: { openSyncKeyStore: async () => host.syncKeyStore, requestSync: () => syncs.push(1) }, pairing: {} };
  const approval = new HouseholdLinkApproval(ctx);
  ctx.linkApproval = approval;
  ctx.auth = { logout() {} };
  const views = new HouseholdViews(ctx);
  ctx.views = views;
  return { host, approval, calls, pins, syncs };
}

const scannerOf = (host) => host.find((node) => node.constructor === defined["kin-qr-scanner"]);
const texts = (host) => [...host.all()].map((node) => node.textContent ?? "").filter(Boolean);
const deletes = () => released.filter((entry) => entry.init?.method === "DELETE");

test.afterEach(() => { released.length = 0; assertions.length = 0; });

test("People & devices offers Add a computer, which opens the scanner", () => {
  const { host } = rig();
  host.render();
  host.byText("Add a computer").click();
  assert.ok(scannerOf(host), "the scanner opens");
  assert.equal(host.byClass("link-approval-heading").textContent, "Add a computer");
  assert.equal(document.activeElement, host.byClass("link-approval-heading"));
  host.byText("Back").click();
  assert.equal(scannerOf(host), null);
  assert.ok(host.byText("Add a computer"), "back on People & devices");
});

test("only a computer's sign-in link is accepted", async () => {
  const { host, approval, calls } = rig();
  approval.start();
  scannerOf(host).dispatchEvent(new CustomEvent("kin-qr-scan", { detail: { url: `${ORIGIN}/pair#code=F7KM-Q2DX` } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(host.byClass("link-approval-status").textContent, /household invitation, not a computer's sign-in code/);
  await approval.scanned(signInLink("https://evil.test", scan));
  assert.match(host.byClass("link-approval-status").textContent, /isn't a computer's sign-in code/);
  await approval.scanned(linkUrl.replace(scan.secret, "short"));
  assert.match(host.byClass("link-approval-status").textContent, /isn't a computer's sign-in code/);
  assert.equal(calls.length, 0, "nothing reaches the service");
  assert.ok(scannerOf(host), "scanning can go on");
});

test("typing instead explains that a computer needs its QR code", () => {
  const { host, approval } = rig();
  approval.start();
  scannerOf(host).dispatchEvent(new CustomEvent("kin-qr-manual"));
  assert.match(host.byClass("link-approval-status").textContent, /needs its QR code/);
});

test("a scanned computer is shown by name, as you, with the warning, before anything is approved", async () => {
  const { host, approval, calls } = rig({ routes: { "/approve/options": () => ({ flow: "f1", publicKey, request: view() }) } });
  approval.start();
  await approval.scanned(linkUrl.replace(scan.secret, "short"));
  assert.equal(calls.length, 0);
  approval.start();
  await approval.scanned(linkUrl);
  const [options] = calls;
  assert.equal(options.path, `/api/link/requests/${scan.requestId}/approve/options`);
  assert.deepEqual(options.body, { secret: scan.secret, fingerprint: scan.fingerprint }, "the secret goes only in the body");
  assert.equal(host.byClass("link-approval-heading").textContent, "Approve this computer?");
  assert.equal(host.byClass("link-approval-device").textContent, "Chrome on Windows");
  assert.ok(texts(host).some((value) => /signed in as you/.test(value)));
  assert.equal(host.byClass("link-approval-warning").textContent, APPROVE_WARNING);
  assert.equal(APPROVE_WARNING, "Only approve a computer that's in front of you.");
  assert.ok(host.byText("Approve with passkey") && host.byText("Cancel"));
  assert.equal(assertions.length, 0, "no passkey yet");
  assert.equal(scannerOf(host), null, "the camera is gone");
});

async function reviewed(routes) {
  const r = rig({ routes: { "/approve/options": () => ({ flow: `f${Math.random()}`, publicKey, request: view() }), ...routes } });
  r.approval.start();
  await r.approval.scanned(r.linkUrl ?? linkUrl);
  return r;
}

test("Approve runs a fresh passkey, signs the certificate for the scanned keys, pins them and shows the code", async () => {
  let finishBody;
  const r = await reviewed({ "/approve/finish": (body) => { finishBody = body; return { expiresAt: Date.now() + 120_000 }; } });
  await r.approval.approve();
  assert.equal(r.calls.filter((call) => call.path.endsWith("/approve/options")).length, 2, "a fresh challenge for the ceremony");
  assert.equal(assertions.length, 1, "one passkey ceremony");
  assert.equal(finishBody.secret, scan.secret);
  assert.equal(finishBody.fingerprint, scan.fingerprint);
  assert.match(finishBody.code, /^\d{6}$/, "a random 6-digit code");
  assert.equal(await tagged(finishBody), true, "with a tag binding this phone, the code and the QR nonce");
  assert.equal(JSON.stringify(finishBody).includes(scan.nonce), false, "the nonce never reaches the service");
  const certificate = finishBody.deviceCertificate;
  assert.equal(certificate.issuerDeviceId, identity.deviceId, "signed by this phone");
  assert.equal(certificate.deviceId, view().deviceId);
  assert.equal(certificate.memberId, identity.memberId);
  assert.deepEqual(r.pins, [{ householdId: identity.householdId, memberId: identity.memberId, deviceId: view().deviceId,
    publicKeys: computerKeys.publicKeys, fingerprint: computerFingerprint }]);
  const code = r.host.byClass("link-approval-code");
  assert.equal(code.children[0].textContent, finishBody.code, "the code shown is the one sent");
  assert.equal(code.children[0].getAttribute("aria-hidden"), "true");
  assert.equal(code.byClass("visually-hidden").textContent, `Code ${[...finishBody.code].join(" ")}`, "read out digit by digit");
  assert.notEqual(code.tagName, "OUTPUT", "not a live region");
  assert.match(r.host.byClass("link-approval-countdown").textContent, /^The code works for 0[12]:\d\d$/);
  assert.equal(r.host.byClass("link-approval-countdown").getAttribute("role"), null);
  r.approval.stop();
});

test("once the computer finishes, the phone says Done and syncs to provision it", async () => {
  const r = await reviewed({
    "/approve/finish": () => ({ expiresAt: Date.now() + 120_000 }),
    "/status": () => ({ state: "done" }),
  });
  await r.approval.approve();
  await r.approval.poll();
  assert.equal(r.host.byClass("link-approval-heading").textContent, "The computer is signed in");
  assert.equal(r.syncs.length, 1, "a sync provisions the new device");
  r.host.byText("Done").click();
  assert.equal(r.approval.open, false);
  assert.equal(deletes().length, 0, "a finished request isn't cancelled");
});

test("a computer that's already yours needs no certificate", async () => {
  let finishBody;
  const r = rig({ routes: {
    "/approve/options": () => ({ flow: "f", publicKey, request: view({ existingDevice: true }) }),
    "/approve/finish": (body) => { finishBody = body; return { expiresAt: Date.now() + 120_000 }; },
  } });
  r.approval.start();
  await r.approval.scanned(linkUrl);
  assert.ok(texts(r.host).some((value) => /already one of your devices/.test(value)));
  await r.approval.approve();
  assert.equal(finishBody.deviceCertificate, undefined);
  assert.equal(await tagged(finishBody), true);
  assert.equal(r.pins.length, 0);
  r.approval.stop();
});

test("keys from the service that aren't the ones the camera saw are never signed", async () => {
  const other = await keyPair();
  const finished = [];
  const r = rig({ routes: {
    "/approve/options": () => ({ flow: "f", publicKey, request: view({ syncPublicKeys: other.publicKeys }) }),
    "/approve/finish": (body) => { finished.push(body); return {}; },
  } });
  r.approval.start();
  await r.approval.scanned(linkUrl);
  await r.approval.approve();
  assert.equal(finished.length, 0);
  assert.equal(r.pins.length, 0);
  assert.ok(texts(r.host).some((value) => /doesn't match the code you scanned/.test(value)));
  assert.equal(deletes().length, 1, "and the request is ended");
});

test("a dismissed passkey leaves the review open, unapproved", async () => {
  const r = await reviewed({});
  assertion = async () => { throw Object.assign(new Error("dismissed"), { name: "NotAllowedError" }); };
  try {
    await r.approval.approve();
  } finally {
    assertion = async () => ({ id: "cred", type: "public-key", response: { clientDataJSON: new Uint8Array([1]), authenticatorData: new Uint8Array([2]), signature: new Uint8Array([3]), userHandle: null } });
  }
  assert.equal(r.host.byClass("link-approval-heading").textContent, "Approve this computer?");
  assert.match(r.host.byClass("link-approval-status").textContent, /was not approved/);
  assert.equal(deletes().length, 0);
});

test("an expired or used code says to show a new one on the computer", async () => {
  const { host, approval } = rig({ routes: { "/approve/options": () => { throw Object.assign(new Error("gone"), { code: "link_unavailable" }); } } });
  approval.start();
  await approval.scanned(linkUrl);
  assert.ok(texts(host).some((value) => /expired or was already used/.test(value)));
  assert.ok(host.byText("Scan again"));
});

test("Cancel while the code is shown ends the request, with the secret only in the body", async () => {
  const r = await reviewed({ "/approve/finish": () => ({ expiresAt: Date.now() + 120_000 }) });
  await r.approval.approve();
  r.host.byText("Cancel").click();
  const [cancel] = deletes();
  assert.equal(cancel.url, `/api/link/requests/${scan.requestId}`);
  assert.deepEqual(JSON.parse(cancel.init.body), { secret: scan.secret });
  assert.equal(r.approval.open, false);
});

test("locking ends the request and closes the screen", async () => {
  const r = await reviewed({});
  r.approval.abandon();
  assert.equal(deletes().length, 1);
  assert.equal(r.approval.open, false);
});

test("a computer for another member or household is never approved", async () => {
  for (const other of [{ memberId: hex(32, "f") }, { householdId: hex(32, "f") }]) {
    const r = rig({ routes: { "/approve/options": () => ({ flow: "f", publicKey, request: view(other) }) } });
    r.approval.start();
    await r.approval.scanned(linkUrl);
    assert.ok(texts(r.host).some((value) => /couldn't confirm who this computer would sign in as/.test(value)));
    assert.equal(r.host.byText("Approve with passkey"), null);
    released.length = 0;
  }
});

test("a network failure leaves the computer's request alone, and a busy phone asks to scan again", async () => {
  const r = rig({ routes: { "/approve/options": () => { throw new Error("Kin could not reach the service."); } } });
  r.approval.start();
  await r.approval.scanned(linkUrl);
  assert.equal(deletes().length, 0);
  assert.match(r.host.byClass("link-approval-status").textContent, /Scan the code again/);
  assert.ok(scannerOf(r.host), "the scanner is back");
  let release;
  r.host.run(() => new Promise((resolve) => { release = resolve; }));
  await r.approval.scanned(linkUrl);
  assert.match(r.host.byClass("link-approval-status").textContent, /still finishing something else/);
  release();
});

test("a phone in the middle of a key update doesn't approve", async () => {
  const finished = [];
  const r = await reviewed({ "/approve/finish": (body) => { finished.push(body); return {}; } });
  const getDevice = r.host.syncKeyStore.getDevice;
  r.host.syncKeyStore.getDevice = async (id) => ({ ...(await getDevice(id)), pendingTransition: { generation: 1 } });
  await r.approval.approve();
  assert.equal(finished.length, 0);
  assert.equal(assertions.length, 0, "refused before any passkey prompt");
  assert.ok(texts(r.host).some((value) => /finishing a key update/.test(value)));
});

test("a key that can't be pinned cancels the approved request instead of hanging", async () => {
  const r = await reviewed({ "/approve/finish": () => ({ expiresAt: Date.now() + 120_000 }) });
  r.host.syncKeyStore.pinTrustedDevice = async () => { throw new Error("storage"); };
  await r.approval.approve();
  assert.ok(texts(r.host).some((value) => /couldn't save the computer's key/.test(value)));
  assert.equal(deletes().length, 1);
  assert.equal(r.host.byClass("link-approval-code"), null);
});

test("a request that ends while the code is shown says nothing was signed in", async () => {
  const r = await reviewed({
    "/approve/finish": () => ({ expiresAt: Date.now() + 120_000 }),
    "/status": () => ({ state: "ended" }),
  });
  await r.approval.approve();
  await r.approval.poll();
  assert.ok(texts(r.host).some((value) => /Nothing was signed in/.test(value)));
});
