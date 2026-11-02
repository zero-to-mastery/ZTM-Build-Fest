// Sign in with your phone, the computer's side (#100): the request, its QR
// code and countdown, the code field, the code checked against the approving
// device, completion for a new and a returning computer with the approver
// pinned, and every way the request ends. Without a browser.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { installDom, settle } from "../qr-test-dom.mjs";
import { deviceKeyFingerprint } from "../../sync/crypto.js";
import {
  cleanLinkCode, consumeOpenedSignInLink, isLinkCode, linkNonce, linkTag, linkTagMatches, newLinkCode, signInLink, signInRequest, takeSignInLink,
} from "../../device-link.js";

globalThis.crypto ??= webcrypto;
const defined = installDom();
const ORIGIN = "https://kin.test";
const where = { origin: ORIGIN, pathname: "/", href: `${ORIGIN}/` };
Object.defineProperty(globalThis, "location", { configurable: true, value: where });
const replaced = [];
globalThis.history = { replaceState: (_, __, url) => replaced.push(url) };
const released = [];
globalThis.fetch = async (url, init) => {
  released.push({ url, init });
  return { ok: true, json: async () => ({}) };
};
await import("../kin-qr.js");
const { HouseholdLink, MAX_SIGN_IN_REFRESHES, SIGN_IN_STEPS } = await import("./link.js");

async function publicKeys() {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  ]);
  const keys = { agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey), signing: await crypto.subtle.exportKey("jwk", signing.publicKey) };
  return { publicKeys: keys, fingerprint: await deviceKeyFingerprint(keys) };
}

const FRESH = await publicKeys();
const BOUND = await publicKeys();
const PHONE = await publicKeys();
const hex = (n, c) => c.repeat(n);
const PHONE_ID = hex(32, "9");
const MEMBER = hex(32, "b");
const HOUSEHOLD = hex(32, "a");
let serial = 0;
/** What the service answers for a request with `keys`. */
const created = (keys, extra = {}) => {
  serial += 1;
  return {
    requestId: String(serial).padStart(32, "0"),
    secret: `S${String(serial).padStart(42, "x")}`,
    fingerprint: keys.fingerprint,
    expiresAt: Date.now() + 120_000,
    returning: false,
    ...extra,
  };
};
const approvedStatus = () => ({ state: "approved", expiresAt: Date.now() + 120_000 });
/** The code A's phone shows in these tests. */
const CODE = "482915";

/** A household element stand-in around the link part, with a scripted API. */
function rig({ bound = null, routes = {}, pendingFingerprint } = {}) {
  const calls = [];
  const bindings = [];
  const pins = [];
  const store = {
    latestBoundDevice: async () => bound,
    getOrCreatePendingDevice: async () => ({ ...FRESH }),
    getDevice: async (id) => (id === "pending" ? { fingerprint: pendingFingerprint ?? FRESH.fingerprint } : null),
    bindPendingDevice: async (identity) => { bindings.push(identity); return identity; },
    discards: 0,
    discardPendingDevice: async () => { store.discards += 1; return true; },
    getPinnedDevice: async () => null,
    pinTrustedDevice: async (pin) => { pins.push(pin); return pin; },
  };
  const host = document.createElement("div");
  host.isConnected = true;
  let busy = false;
  Object.assign(host, {
    intent: "phone",
    claim: null,
    syncKeyStore: store,
    errors: [],
    loads: 0,
    get busy() { return busy; },
    async run(action) {
      if (busy) return;
      busy = true;
      try { await action(); } catch (error) { host.errors.push(error); } finally { busy = false; }
    },
    async api(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options.method ?? "GET", body });
      const route = Object.entries(routes).find(([pattern]) => path.endsWith(pattern));
      if (!route) throw new Error(`unexpected ${path}`);
      return route[1](body, path);
    },
    async load() { host.loads += 1; },
    text(content) { const p = document.createElement("p"); p.textContent = content; host.append(p); return p; },
    button(label, action, className) { const b = host.makeButton(label, action, className); host.append(b); return b; },
    makeButton(label, action) { const b = document.createElement("button"); b.textContent = label; b.addEventListener("click", () => action?.()); return b; },
    startIntent(kind) { host.intent = kind; host.render(); },
    render() { host.replaceChildren(); if (host.intent === "phone") link.render(); },
  });
  const ctx = { host, api: { openSyncKeyStore: async () => store } };
  const link = new HouseholdLink(ctx);
  link.announceDelay = 0;
  ctx.link = link;
  return { host, link, calls, bindings, pins, store };
}

const qrOf = (host) => host.find((node) => node.constructor === defined["kin-qr"]);
const texts = (host) => [...host.all()].map((node) => node._text).filter(Boolean);
const releases = () => released.filter((entry) => entry.init?.method === "DELETE" && entry.url.startsWith("/api/link/"));
const logouts = () => released.filter((entry) => entry.url === "/api/logout");

test.afterEach(() => { released.length = 0; replaced.length = 0; });

test("the screen asks with fresh keys and shows the request, with a nonce, as a QR code for its fragment link", async () => {
  let answer;
  const { host, link, calls } = rig({ routes: { "/api/link/requests": () => (answer = created(FRESH)) } });
  await link.begin();
  link.stop();
  const ask = calls.find((call) => call.path === "/api/link/requests");
  assert.deepEqual(ask.body.syncPublicKeys, FRESH.publicKeys);
  assert.equal(typeof ask.body.deviceLabel, "string", "the computer's automatic name");
  const qr = qrOf(host);
  const read = signInRequest(qr.value, ORIGIN);
  assert.equal(read.requestId, answer.requestId);
  assert.equal(read.secret, answer.secret);
  assert.equal(read.fingerprint, FRESH.fingerprint);
  assert.equal(read.nonce, link.request.nonce, "the nonce rides in the QR code");
  assert.equal(JSON.stringify(calls).includes(link.request.nonce), false, "and never reaches the service");
  assert.equal(qr.value.includes("?"), false, "nothing in the query");
  assert.ok(qr.value.length - ORIGIN.length <= 157, "the link fits the QR limit for origins up to 56 bytes");
  assert.ok(Math.abs(qr.expiresAt - (Date.now() + 120_000)) < 2_000, "two minutes from when the computer heard");
  assert.equal(qr.code, "", "there's nothing to type on this screen");
  assert.ok(texts(host).includes(SIGN_IN_STEPS));
  assert.equal(SIGN_IN_STEPS, "On your phone, open Kin → People & devices → Add a computer → Scan.");
  const countdown = host.byClass("sign-in-countdown");
  assert.match(countdown.textContent, /^This code changes in 0[12]:\d\d$/);
  assert.equal(countdown.getAttribute("role"), null, "the countdown isn't a live region");
  assert.equal(host.byClass("sign-in-status").getAttribute("role"), "status");
  assert.ok(host.byText("Cancel"));
  assert.equal(document.activeElement, host.byClass("sign-in-heading"), "focus moves to the screen's heading at once");
});

test("the countdown runs on this computer's clock, whatever the service's says", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => created(FRESH, { expiresAt: Date.now() + 6 * 60_000 }) } });
  await link.begin();
  link.stop();
  assert.match(host.byClass("sign-in-countdown").textContent, /^This code changes in 0(1:5\d|2:00)$/);
});

test("an answer for keys the computer didn't offer is refused", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => created(BOUND) } });
  await link.begin();
  assert.equal(link.request, null);
  assert.match(host.errors[0]?.message ?? "", /didn't offer/);
  assert.equal(releases().length, 1);
});

test("a returning computer offers its device's keys, and falls back to fresh keys when the service doesn't know it", async () => {
  const bound = { deviceId: hex(32, "d"), householdId: HOUSEHOLD, memberId: MEMBER, ...BOUND };
  const offered = [];
  const answers = [created(BOUND, { returning: false }), created(FRESH)];
  const { link } = rig({ bound, routes: { "/api/link/requests": (body) => { offered.push(body.syncPublicKeys); return answers.shift(); } } });
  await link.begin();
  link.stop();
  assert.deepEqual(offered, [BOUND.publicKeys, FRESH.publicKeys]);
  assert.equal(releases().length, 1, "the first request is ended first");
  assert.equal(link.request.keys, "pending");

  const known = rig({ bound, routes: { "/api/link/requests": () => created(BOUND, { returning: true }) } });
  await known.link.begin();
  known.link.stop();
  assert.equal(known.link.request.keys, "existing");
  assert.equal(known.link.request.deviceId, bound.deviceId);
});

test("signing in as someone else always offers fresh keys", async () => {
  const bound = { deviceId: hex(32, "d"), householdId: HOUSEHOLD, memberId: MEMBER, ...BOUND };
  const offered = [];
  const { host, link } = rig({ bound, routes: {
    "/api/link/requests": (body) => { offered.push(body.syncPublicKeys); return created(body.syncPublicKeys === undefined ? FRESH : (offered.length === 1 ? BOUND : FRESH), { returning: offered.length === 1 }); },
    "/status": () => ({ state: "ended" }),
  } });
  await link.begin();
  await link.poll(); // another member's phone was refused: the request ended
  assert.ok(host.byText("Sign in as someone else"));
  host.byText("Sign in as someone else").click();
  await settle();
  link.stop();
  assert.deepEqual(offered.at(-1), FRESH.publicKeys);
  assert.equal(link.request.keys, "pending");
});

test("once the phone approves, the screen asks for the 6-digit code with a numeric keypad and says so", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => created(FRESH), "/status": approvedStatus } });
  await link.begin();
  await link.poll();
  link.stop();
  assert.equal(qrOf(host), null, "the QR code is gone once approved");
  const input = host.byClass("sign-in-code").find((node) => node.tagName === "INPUT");
  assert.equal(input.inputMode, "numeric");
  assert.equal(input.autocomplete, "one-time-code");
  assert.equal(input.pattern, undefined, "no pattern to contradict typed spaces or dashes");
  assert.equal(document.activeElement, input, "focus moves to the field");
  assert.match(host.byClass("sign-in-status").textContent, /approved this computer/);
  assert.match(host.byClass("sign-in-countdown").textContent, /^The code works for/);
});

test("a request the phone approved at the last moment is kept, never replaced", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => created(FRESH), "/status": approvedStatus } });
  await link.begin();
  const kept = link.request.requestId;
  assert.equal(await link.refresh(), null);
  link.stop();
  assert.equal(releases().length, 0, "the approved request isn't cancelled");
  assert.equal(link.request.requestId, kept);
  assert.equal(link.request.state, "approved");
  assert.ok(host.byClass("sign-in-code"));
});

/** The phone's tag for the request on screen (what the real phone sends). */
const phoneTag = (request, { code = CODE, nonce = request.nonce, deviceId = PHONE_ID, fingerprint = PHONE.fingerprint } = {}) =>
  linkTag({ nonce, code, requestId: request.requestId, approverDeviceId: deviceId, approverFingerprint: fingerprint, computerFingerprint: request.fingerprint });

async function approvedRig({ keys = "pending", completion, directory, pendingFingerprint } = {}) {
  const bound = keys === "existing" ? { deviceId: hex(32, "d"), householdId: HOUSEHOLD, memberId: MEMBER, ...BOUND } : null;
  let rigged;
  const r = rig({ bound, pendingFingerprint, routes: {
    "/api/link/requests": () => created(keys === "existing" ? BOUND : FRESH, { returning: keys === "existing" }),
    "/status": approvedStatus,
    "/complete": async (body) => (completion ? completion(body, rigged) : {
      householdId: HOUSEHOLD, memberId: MEMBER, deviceId: keys === "existing" ? bound.deviceId : hex(32, "c"), newDevice: keys !== "existing",
      approverDeviceId: PHONE_ID, approverFingerprint: PHONE.fingerprint, tag: await phoneTag(rigged.link.request ?? rigged.request),
    }),
    "/api/sync/devices": directory ?? (() => ({ devices: [{ deviceId: PHONE_ID, memberId: MEMBER, publicKeys: PHONE.publicKeys, fingerprint: PHONE.fingerprint }] })),
  } });
  rigged = r;
  await r.link.begin();
  await r.link.poll();
  r.link.stop();
  r.request = r.link.request;
  return { ...r, bound };
}

test("a wrong code is checked by the service and says how many tries are left", async () => {
  const { host, link } = await approvedRig({ completion: () => { throw Object.assign(new Error("That code didn't match. 2 tries left."), { code: "link_code_mismatch" }); } });
  link.field.value = "111111";
  await link.complete("111111");
  assert.equal(link.field.value, "");
  assert.equal(document.activeElement, link.field);
  assert.match(host.byClass("sign-in-status").textContent, /2 tries left/);
  assert.ok(link.request, "the request stays open");
});

test("a service that names a device of its own can't produce the phone's tag", async () => {
  const impostor = await publicKeys();
  const impostorId = hex(32, "7");
  const r = await approvedRig({
    completion: async (body, rigged) => ({
      householdId: HOUSEHOLD, memberId: MEMBER, deviceId: hex(32, "c"), newDevice: true,
      // The service knows the code but not the QR code's nonce.
      approverDeviceId: impostorId, approverFingerprint: impostor.fingerprint,
      tag: await phoneTag(rigged.request, { nonce: linkNonce(), deviceId: impostorId, fingerprint: impostor.fingerprint, code: body.code }),
    }),
    directory: () => ({ devices: [{ deviceId: impostorId, memberId: MEMBER, publicKeys: impostor.publicKeys, fingerprint: impostor.fingerprint }] }),
  });
  await r.link.complete(CODE);
  assert.equal(r.bindings.length, 0, "the keys aren't bound");
  assert.equal(r.pins.length, 0, "and nothing is pinned");
  assert.equal(logouts().length, 1, "the computer signs itself out");
  assert.equal(r.store.discards, 1, "and throws its pending keys away, so the next try uses fresh ones");
  assert.match(r.host.errors[0]?.message ?? "", /couldn't verify the phone/);
});

test("the real phone's tag doesn't vouch for another device, even with the right code", async () => {
  const impostor = await publicKeys();
  const r = await approvedRig({
    completion: async (body, rigged) => ({
      householdId: HOUSEHOLD, memberId: MEMBER, deviceId: hex(32, "c"), newDevice: true,
      approverDeviceId: PHONE_ID, approverFingerprint: impostor.fingerprint, tag: await phoneTag(rigged.request),
    }),
  });
  await r.link.complete(CODE);
  assert.equal(r.pins.length, 0);
  assert.equal(logouts().length, 1);
});

test("a short code is caught before anything is checked", async () => {
  const { link, calls } = await approvedRig();
  await link.complete("12 34");
  assert.equal(calls.some((call) => call.path.endsWith("/complete")), false);
  assert.match(link.status.textContent, /all 6 digits/);
});

test("a new computer binds its fresh keys, pins the approving phone's checked key, then starts Kin afresh", async () => {
  const { link, bindings, pins, calls, request } = await approvedRig();
  await link.complete("482-915");
  const sent = calls.find((call) => call.path.endsWith("/complete"));
  assert.deepEqual(sent.body, { secret: request.secret, code: CODE }, "the secret and code go only in the body");
  assert.equal(JSON.stringify(calls).includes(request.nonce), false, "the nonce never reaches the service");
  assert.deepEqual(bindings, [{ deviceId: hex(32, "c"), householdId: HOUSEHOLD, memberId: MEMBER }]);
  assert.deepEqual(pins, [{ householdId: HOUSEHOLD, memberId: MEMBER, deviceId: PHONE_ID, publicKeys: PHONE.publicKeys, fingerprint: PHONE.fingerprint }]);
  assert.equal(where.href, "/");
  assert.equal(link.request, null);
  where.href = `${ORIGIN}/`;
});

test("a directory whose phone key isn't the one behind the code signs the computer out", async () => {
  const other = await publicKeys();
  const { link, host, pins } = await approvedRig({
    directory: () => ({ devices: [{ deviceId: PHONE_ID, memberId: MEMBER, publicKeys: other.publicKeys, fingerprint: PHONE.fingerprint }] }),
  });
  await link.complete(CODE);
  assert.equal(pins.length, 0);
  assert.equal(logouts().length, 1);
  assert.match(host.errors[0]?.message ?? "", /couldn't verify the phone/);
  assert.equal(where.href, `${ORIGIN}/`, "no restart");
});

test("a directory that can't be reached signs the computer out rather than leaving it unpinned", async () => {
  const { link, host, pins } = await approvedRig({ directory: () => { throw new Error("offline"); } });
  await link.complete(CODE);
  assert.equal(pins.length, 0);
  assert.equal(logouts().length, 1);
  assert.match(host.errors[0]?.message ?? "", /couldn't verify the phone/);
});

test("keys replaced while signing in (another tab) stop the sign-in before it finishes", async () => {
  const { link, calls } = await approvedRig({ pendingFingerprint: hex(64, "0") });
  await link.complete(CODE);
  assert.equal(calls.some((call) => call.path.endsWith("/complete")), false);
  assert.equal(link.request, null);
});

test("a returning computer is signed back in, and pins the phone unless it already has", async () => {
  const r = await approvedRig({ keys: "existing" });
  await r.link.complete(CODE);
  assert.deepEqual(r.bindings, [], "its keys are already its own");
  assert.equal(r.pins.length, 1);
  assert.equal(r.host.loads, 1);
  assert.deepEqual(replaced, ["/"]);
  assert.equal(r.host.intent, null);

  const again = await approvedRig({ keys: "existing" });
  again.store.getPinnedDevice = async () => ({ fingerprint: "earlier" });
  await again.link.complete(CODE);
  assert.equal(again.pins.length, 0, "an existing pin is kept; sync checks it against the key history");
  assert.equal(again.host.loads, 1);
});

test("an answer that doesn't fit the request is refused and signed out", async () => {
  const { link, host, bindings } = await approvedRig({
    completion: async (body, rigged) => ({ householdId: HOUSEHOLD, memberId: MEMBER, deviceId: "d", newDevice: false,
      approverDeviceId: PHONE_ID, approverFingerprint: PHONE.fingerprint, tag: await phoneTag(rigged.request) }),
  });
  await link.complete(CODE);
  assert.equal(bindings.length, 0);
  assert.equal(logouts().length, 1);
  assert.match(host.errors[0]?.message ?? "", /couldn't verify/);
  assert.equal(host.loads, 0);
});

for (const code of ["link_code_attempts", "link_unavailable"]) {
  test(`${code} from the service ends the screen with a way to start again`, async () => {
    const r = await approvedRig({ completion: () => { throw Object.assign(new Error("x"), { code }); } });
    await r.link.complete(CODE);
    assert.equal(r.link.request, null);
    assert.ok(texts(r.host).some((value) => /Nothing was signed in/.test(value)));
    assert.ok(r.host.byText("Show a new code"));
    assert.equal(r.host.byText("Sign in as someone else"), null, "fresh keys were already offered");
    assert.equal(document.activeElement, r.host.byClass("sign-in-heading"));
  });
}

test("a request the phone cancelled ends the screen at the next poll", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => created(FRESH), "/status": () => ({ state: "ended" }) } });
  await link.begin();
  await link.poll();
  link.stop();
  assert.equal(link.request, null);
  assert.ok(host.byText("Show a new code"));
});

test("an expired request with no QR code to replace it ends instead of polling forever", async () => {
  const { link } = rig({ routes: { "/api/link/requests": () => created(FRESH), "/status": () => ({ state: "ended" }) } });
  await link.begin();
  link.request.expiresAt = Date.now() - 20_000;
  await link.poll();
  link.stop();
  assert.equal(link.request, null);
  assert.equal(link.poller, null);
});

test("Cancel ends the request with the service, sending the secret only in the body", async () => {
  let answer;
  const { host, link } = rig({ routes: { "/api/link/requests": () => (answer = created(FRESH)) } });
  await link.begin();
  host.byText("Cancel").click();
  const [cancel] = releases();
  assert.equal(cancel.url, `/api/link/requests/${answer.requestId}`);
  assert.deepEqual(JSON.parse(cancel.init.body), { secret: answer.secret });
  assert.equal(cancel.init.keepalive, true);
  assert.equal(host.intent, null, "back to the choices");
  assert.equal(link.request, null);
});

test("starting again, Kin locking or the page going away end the request too", async () => {
  const { link } = rig({ routes: { "/api/link/requests": () => created(FRESH) } });
  await link.begin();
  await link.begin();
  link.stop();
  assert.equal(releases().length, 1, "a new start ends the old request");
  link.onPageHide();
  assert.equal(releases().length, 2);
  link.abandon();
  assert.equal(releases().length, 3);
  assert.equal(link.request, null);
});

test("an unscanned code replaces itself a few times, ending each old request, then stops", async () => {
  const { link } = rig({ routes: { "/api/link/requests": () => created(FRESH), "/status": () => ({ state: "pending" }) } });
  await link.begin();
  const seen = new Set([link.request.requestId]);
  const nonces = new Set([link.request.nonce]);
  for (let index = 0; index < MAX_SIGN_IN_REFRESHES; index += 1) {
    const next = await link.refresh();
    assert.ok(next?.value.startsWith(`${ORIGIN}/link#r=`));
    assert.equal(next.code, "");
    seen.add(link.request.requestId);
    nonces.add(link.request.nonce);
  }
  link.stop();
  assert.equal(seen.size, MAX_SIGN_IN_REFRESHES + 1, "each replacement is a new request");
  assert.equal(nonces.size, MAX_SIGN_IN_REFRESHES + 1, "with a new nonce");
  assert.equal(releases().length, MAX_SIGN_IN_REFRESHES, "and each old one is ended");
  assert.equal(await link.refresh(), null, "then the screen asks before making more");
});

test("a failed request leaves a way to try again", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => { throw new Error("Too many attempts."); } } });
  await link.begin();
  assert.equal(host.errors.length, 1);
  assert.ok(texts(host).includes("Kin couldn't get a sign-in code."));
  assert.ok(host.byText("Try again"));
});

// ---- Sign-in links and codes ------------------------------------------------

const sample = { requestId: hex(32, "a"), secret: "A".repeat(20) + "b-_" + "9".repeat(20), fingerprint: FRESH.fingerprint, nonce: linkNonce() };

test("a sign-in link reads back exactly, secret and nonce case and all", () => {
  const link = signInLink(ORIGIN, sample);
  assert.deepEqual(signInRequest(link, ORIGIN), sample);
});

test("anything but an exact sign-in link for this origin is refused", () => {
  const good = signInLink(ORIGIN, sample);
  for (const bad of [
    signInLink("https://evil.test", sample),
    good.replace("/link#", "/pair#"),
    good.replace("/link#", "/link?x=1#"),
    `${good}&x=1`,
    `${good}&r=${sample.requestId}`,
    good.replace(sample.secret, sample.secret.slice(1)),
    good.replace(`&c=${sample.nonce}`, ""),
    good.replace(sample.nonce, `${sample.nonce}A`),
    good.replace(sample.requestId, sample.requestId.toUpperCase()),
    good.replace(/&f=[^&]+/, ""),
    good.replace("https://kin.test", "https://user@kin.test"),
    "not a url",
  ]) assert.equal(signInRequest(bad, ORIGIN), null, bad);
});

test("codes are six random digits, and the tag needs the nonce, the code and the right device", async () => {
  const codes = new Set(Array.from({ length: 50 }, () => newLinkCode()));
  for (const code of codes) assert.match(code, /^\d{6}$/);
  assert.ok(codes.size > 45, "random");
  const values = { nonce: sample.nonce, code: CODE, requestId: sample.requestId, approverDeviceId: PHONE_ID, approverFingerprint: PHONE.fingerprint, computerFingerprint: FRESH.fingerprint };
  const tag = await linkTag(values);
  assert.match(tag, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await linkTagMatches(tag, values), true);
  for (const change of [{ nonce: linkNonce() }, { code: "482916" }, { approverDeviceId: hex(32, "7") }, { approverFingerprint: BOUND.fingerprint }, { computerFingerprint: BOUND.fingerprint }, { requestId: hex(32, "b") }])
    assert.equal(await linkTagMatches(tag, { ...values, ...change }), false, JSON.stringify(change));
  assert.equal(await linkTagMatches(undefined, values), false);
  assert.equal(await linkTagMatches(tag, { ...values, nonce: "short" }), false);
});

test("typed codes ignore spaces and dashes, and must be six digits", () => {
  assert.equal(cleanLinkCode(" 123-456 "), "123456");
  assert.equal(isLinkCode("123456"), true);
  assert.equal(isLinkCode("12345"), false);
  assert.equal(isLinkCode("12345a"), false);
});

test("a sign-in link opened outside Kin's scanner is dropped from the address", () => {
  assert.equal(takeSignInLink({ pathname: "/pair" }, globalThis.history), false);
  assert.equal(consumeOpenedSignInLink(), false);
  assert.equal(takeSignInLink({ pathname: "/link", hash: "#r=1" }, globalThis.history), true);
  assert.deepEqual(replaced, ["/"]);
  assert.equal(consumeOpenedSignInLink(), true);
  assert.equal(consumeOpenedSignInLink(), false, "said once");
});
