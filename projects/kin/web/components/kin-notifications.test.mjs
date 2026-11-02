// Per-device notification settings (#85): support detection and the VAPID
// key conversion, without a browser.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
const { applicationServerKey, endpointTag, KinNotifications, MUTE_CHOICES, notificationDeviceChecks, notificationSupport, sameServerKey } = await import("./kin-notifications.js");

test("a browser subscription made for other server keys is recognised", () => {
  const key = Uint8Array.from([4, 1, 2, 3]);
  assert.equal(sameServerKey({ options: { applicationServerKey: key.slice().buffer } }, key), true);
  assert.equal(sameServerKey({ options: { applicationServerKey: Uint8Array.from([4, 1, 2, 9]).buffer } }, key), false);
  assert.equal(sameServerKey({ options: { applicationServerKey: Uint8Array.from([4, 1, 2]).buffer } }, key), false);
  assert.equal(sameServerKey({ options: {} }, key), false);
});

test("each unsupported situation gets its own state", () => {
  const base = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: "default", platform: { ios: false, standalone: false } };
  assert.equal(notificationSupport(base), "available");
  assert.equal(notificationSupport({ ...base, hasPushManager: false }), "unsupported");
  assert.equal(notificationSupport({ ...base, permission: "denied" }), "blocked");
  assert.equal(notificationSupport({ ...base, platform: { ios: true, standalone: false } }), "ios-home-screen", "an iOS browser tab can't receive pushes");
  assert.equal(notificationSupport({ ...base, platform: { ios: true, standalone: true } }), "available", "the Home Screen app can");
});

test("local diagnostics explain permission, subscription and mute without endpoint details", () => {
  const now = Date.UTC(2026, 9, 18, 16, 0);
  assert.deepEqual(notificationDeviceChecks({
    support: "available",
    permission: "granted",
    status: {
      subscribed: true,
      mutedUntil: now + 60_000,
      mutedIndefinitely: false,
      endpointHost: "fcm.googleapis.com",
      endpointTag: "private-fingerprint",
    },
    now,
    formatDate: () => "Oct 18, 2026, 12:01 PM",
  }), [
    ["Browser permission", "Allowed"],
    ["Kin subscription", "On for this device"],
    ["Mute", "Muted until Oct 18, 2026, 12:01 PM"],
  ]);

  assert.deepEqual(notificationDeviceChecks({
    support: "blocked",
    permission: "denied",
    status: { subscribed: false, mutedUntil: null, mutedIndefinitely: false },
    now,
  }), [
    ["Browser permission", "Blocked in browser settings"],
    ["Kin subscription", "Off for this device"],
    ["Mute", "Not applicable while notifications are off"],
  ]);

  assert.equal(notificationDeviceChecks({ support: "available", permission: "default", status: null, now })[1][1],
    "Could not check — check your connection and try again");
});

test("the VAPID key becomes the subscribe() bytes", () => {
  const raw = new Uint8Array(65).map((_, index) => (index * 37) & 255);
  raw[0] = 4;
  const key = Buffer.from(raw).toString("base64url");
  assert.deepEqual(applicationServerKey(key), raw);
});

test("mute choices match the service's choices", async () => {
  const { PUSH_MUTES } = await import("../../server/push-service.mjs");
  assert.deepEqual(MUTE_CHOICES.map(([value]) => value), Object.keys(PUSH_MUTES));
});

test("the endpoint fingerprint matches the service's", async () => {
  const { endpointTag: serverTag } = await import("../../server/push-service.mjs");
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
  assert.equal(await endpointTag(endpoint), serverTag(endpoint));
});

// A panel without a DOM: render and support are stubbed, requests recorded.
async function harness({ browserSubscription }) {
  const requests = [];
  let releasePut;
  const putHeld = new Promise((resolve) => { releasePut = resolve; });
  const key = new Uint8Array(65).fill(4);
  const publicKey = btoa(String.fromCharCode(...key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let current = browserSubscription ? { endpoint: "https://fcm.googleapis.com/fcm/send/new", options: { applicationServerKey: key },
    unsubscribe: async () => { current = null; return true; }, toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: {} }) } : null;
  const pushManager = { getSubscription: async () => current, subscribe: async () => { requests.push("subscribe"); return current; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { ready: Promise.resolve({ pushManager }) } } });
  globalThis.Notification = { permission: "granted" };
  globalThis.fetch = async (path, init = {}) => {
    const method = init.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (path.endsWith("vapid-public-key")) return Response.json({ publicKey });
    if (method === "PUT") { await putHeld; return Response.json({ available: true, subscribed: true }); }
    if (method === "DELETE") return Response.json({ available: true, subscribed: false });
    return Response.json({ available: true, subscribed: true, endpointTag: "old-endpoint" });
  };
  const panel = new KinNotifications();
  panel.firstElementChild = true;
  panel.render = () => {};
  panel.support = () => "available";
  panel.querySelectorAll = () => [];
  panel.querySelector = () => null;
  panel.error = {};
  panel.feedback = {};
  return { panel, requests, releasePut };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a subscription the browser lost is forgotten, never silently revived", async () => {
  const { panel, requests } = await harness({ browserSubscription: false });
  await panel.refresh();
  await settle();
  assert.ok(requests.includes("DELETE /api/push/subscription"));
  assert.ok(!requests.includes("subscribe") && !requests.some((entry) => entry.startsWith("PUT")));
  assert.equal(panel.status.subscribed, false);
});

test("a press waits for a repair's request in flight, so its own request comes after", async () => {
  const { panel, requests, releasePut } = await harness({ browserSubscription: true });
  await panel.refresh();
  await settle();
  assert.equal(requests.at(-1), "PUT /api/push/subscription", "the repair is sending the replaced endpoint");
  const press = panel.run(() => panel.turnOff());
  await settle();
  assert.ok(!requests.includes("DELETE /api/push/subscription"), "turning off waits for the PUT");
  releasePut();
  await press;
  assert.equal(requests.at(-1), "DELETE /api/push/subscription");
  assert.equal(panel.status.subscribed, false);
});

test("a refresh during a press runs after it", async () => {
  const { panel, requests, releasePut } = await harness({ browserSubscription: false });
  releasePut();
  let finish;
  const press = panel.run(() => new Promise((resolve) => { finish = resolve; }));
  await panel.refresh();
  assert.ok(!requests.includes("GET /api/push/subscription"), "deferred while the press runs");
  finish();
  await press;
  await settle();
  assert.ok(requests.includes("GET /api/push/subscription"));
});

test("a failed retry announces the actionable error and restores focus", async () => {
  let focused = false;
  globalThis.document = { activeElement: { dataset: { notificationAction: "retry" } } };
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  const panel = new KinNotifications();
  panel.firstElementChild = true;
  panel.support = () => "available";
  panel.contains = () => true;
  panel.render = () => {};
  panel.actions = { contains: () => true, querySelector: () => ({ focus: () => { focused = true; } }) };
  panel.error = {};
  await panel.refresh();
  assert.equal(panel.hidden, false);
  assert.match(panel.error.textContent, /Check your connection and try again/);
  assert.equal(focused, true);

  focused = false;
  globalThis.document.activeElement = { dataset: {} };
  await panel.refresh();
  assert.equal(focused, false, "a background refresh does not move focus from another control");
});

test("a successful retry announces the update and moves focus to the replacement action", async () => {
  let focused = false;
  globalThis.document = { activeElement: { dataset: { notificationAction: "retry" } } };
  globalThis.fetch = async () => Response.json({ available: true, subscribed: false, mutedUntil: null, mutedIndefinitely: false });
  const panel = new KinNotifications();
  panel.firstElementChild = true;
  panel.support = () => "available";
  panel.render = () => {};
  panel.repair = async () => {};
  panel.actions = { contains: () => true, querySelector: () => ({ focus: () => { focused = true; } }) };
  panel.feedback = {};
  await panel.refresh();
  assert.equal(panel.feedback.textContent, "Notification settings updated.");
  assert.equal(focused, true);
});
