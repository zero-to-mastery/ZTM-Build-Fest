// Onboarding entry points and first useful action, without a browser framework.
import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";

installDom();
const { StatusController } = await import("./status.js");
const { PASSKEY_SUGGESTION_DISMISSED_KEY } = await import("../../security/backup-key-entry.js");

// Per-device browser storage, as the passkey suggestion's dismissal uses it.
const stored = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
});

// A browser that can use passkeys (passkeyUnlockSupported), for one test.
async function withPasskeySupport(action) {
  const credentials = Object.getOwnPropertyDescriptor(globalThis.navigator, "credentials");
  globalThis.PublicKeyCredential = class {};
  Object.defineProperty(globalThis.navigator, "credentials", { configurable: true, value: { get() {} } });
  try { return await action(); } finally {
    delete globalThis.PublicKeyCredential;
    if (credentials) Object.defineProperty(globalThis.navigator, "credentials", credentials);
    else delete globalThis.navigator.credentials;
    stored.clear();
  }
}

function passkeyRig({ justSetUp = false, offline = false, addPasskey = async () => {} } = {}) {
  const card = document.createElement("section");
  card.classList = { remove() {}, toggle() {} };
  card.querySelector = () => null;
  const statuses = [];
  const security = {
    justSetUp,
    passkeyWrappers: [],
    alert: { textContent: "" },
    async run(action) { try { await action(); } catch (error) { security.alert.textContent = error.message; } },
    addPasskey: () => addPasskey(security),
  };
  const app = {
    onboarding: card,
    vault: { locked: false },
    offline,
    state: { items: [{ text: "Get milk" }] },
    householdStatus: { identity: { deviceId: "trusted" } },
    security,
    pages: new Map(),
    alert: { textContent: "", hidden: true },
    retryButton: {},
  };
  const ctx = { app, navigation: { navigate() {} } };
  const controller = new StatusController(ctx);
  ctx.status = { setStatus: (message) => statuses.push(message) };
  controller.renderOnboarding();
  return { card, app, controller, security, statuses };
}

function rig({ connected = true, hasItems = false } = {}) {
  const card = document.createElement("section");
  card.classList = { remove() {}, toggle() {} };
  card.querySelector = () => null; // The fake DOM does not implement <details> selectors.
  let focused = false;
  const navigated = [];
  const intents = [];
  const app = {
    onboarding: card,
    vault: { locked: false },
    state: { items: hasItems ? [{ text: "Get milk" }] : [] },
    householdStatus: { identity: connected ? { deviceId: "trusted" } : null },
    security: { passkeyWrappers: [{}] },
    pages: new Map(),
    compose: { input: { focus() { focused = true; } } },
    household: { startIntent(intent) { intents.push(intent); } },
  };
  const ctx = { app, navigation: { navigate(path) { navigated.push(path); } } };
  const controller = new StatusController(ctx);
  controller.renderOnboarding();
  return { card, app, controller, navigated, intents, get focused() { return focused; } };
}

test("unconnected household offers the same four choices as member setup", () => {
  const r = rig({ connected: false });
  const choices = [
    ["Start a new household", "create"],
    ["Join my household", "join"],
    ["Sign in using my phone", "phone"],
    ["Add my device", "device"],
  ];
  for (const [label, intent] of choices) {
    const button = r.card.byText(label);
    assert.ok(button, `missing ${label}`);
    button.click();
    assert.equal(r.intents.at(-1), intent);
    assert.equal(r.navigated.at(-1), "#household/people");
  }
  assert.equal(r.card.hidden, false);
});

test("empty connected household guides one first action and can be dismissed", () => {
  const r = rig();
  assert.match(r.card.textContent, /Welcome home/);
  assert.match(r.card.textContent, /shopping/);
  r.card.byText("Add something").click();
  assert.equal(r.focused, true, "uses the existing capture input");
  r.card.byText("Not now").click();
  assert.equal(r.app.firstActionWelcomeDismissed, true);
  assert.equal(r.card.hidden, true, "skipping onboarding is allowed");
});

test("welcome is absent for a household that already has content", () => {
  const r = rig({ hasItems: true });
  assert.equal(r.card.hidden, true);
  assert.equal(r.card.byText("Add something"), null);
});

test("right after setup, passkey unlock is offered as one calm step (#577)", () => withPasskeySupport(async () => {
  const r = passkeyRig({ justSetUp: true, addPasskey: async (security) => { security.passkeyWrappers = [{ type: "prf" }]; } });
  assert.equal(r.card.hidden, false);
  assert.equal(r.card.dataset.passkeyOffer, "setup");
  assert.match(r.card.textContent, /Unlock with your face, fingerprint or screen lock next time\?/);
  assert.match(r.card.textContent, /backup key still works/);
  r.card.byText("Turn on").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.statuses, ["Passkey unlock is on for this device."]);
  assert.equal(r.card.dataset.passkeyOffer, undefined, "once on, the step is gone");
}));

test("Not now after setup goes on without remembering a dismissal", () => withPasskeySupport(() => {
  const r = passkeyRig({ justSetUp: true });
  r.card.byText("Not now").click();
  assert.equal(r.app.passkeyPromptDismissed, true);
  assert.equal(r.card.dataset.passkeyOffer, undefined);
  assert.equal(stored.has(PASSKEY_SUGGESTION_DISMISSED_KEY), false, "the later suggestion is still allowed");
}));

test("a failed enrolment says so plainly and carries on", () => withPasskeySupport(async () => {
  const r = passkeyRig({ justSetUp: true, addPasskey: async () => { throw new Error("This device isn't signed in to a household yet."); } });
  r.card.byText("Turn on").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(r.app.alert.textContent, /^Passkey unlock didn't turn on\. This device isn't signed in/);
  assert.match(r.app.alert.textContent, /More → Security/);
  assert.equal(r.app.passkeyPromptDismissed, true);
  assert.equal(r.card.dataset.passkeyOffer, undefined, "the step does not come back and block");
}));

test("not offered offline or where passkeys can't be used", async () => {
  await withPasskeySupport(() => {
    const r = passkeyRig({ justSetUp: true, offline: true });
    assert.equal(r.card.dataset.passkeyOffer, undefined);
  });
  const unsupported = passkeyRig({ justSetUp: true });
  assert.equal(unsupported.card.dataset.passkeyOffer, undefined);
});

test("after a backup-key unlock, a one-time suggestion this device remembers dismissing (#579)", () => withPasskeySupport(() => {
  const r = passkeyRig();
  assert.equal(r.card.dataset.passkeyOffer, "suggestion");
  assert.match(r.card.textContent, /Skip the backup key next time\?/);
  assert.ok(r.card.byText("Turn on passkey unlock"));
  r.card.byText("Not now").click();
  assert.equal(stored.get(PASSKEY_SUGGESTION_DISMISSED_KEY), "1");
  const next = passkeyRig();
  assert.equal(next.card.dataset.passkeyOffer, undefined, "a later unlock doesn't suggest it again");
}));

test("Today says where a household moved, or that it is moving (#737)", () => {
  const card = document.createElement("section");
  card.classList = { remove() {}, toggle() {} };
  card.querySelector = () => null;
  const app = {
    onboarding: card,
    vault: { locked: false },
    state: { items: [] },
    householdStatus: { identity: false, lifecycle: "moved", movedTo: "https://fern.home.kin.journeytocode.io" },
    security: { passkeyWrappers: [] },
    pages: new Map(),
  };
  const controller = new StatusController({ app, navigation: { navigate() {} } });
  controller.renderOnboarding();
  const all = (items) => items.flatMap((item) => [item, ...all(item.children ?? [])]);
  const nodes = all(card.children ?? card.childNodes ?? []);
  const text = nodes.map((node) => node.textContent ?? "").join(" ");
  assert.match(text, /Your household moved/);
  assert.match(text, /It's at https:\/\/fern\.home\.kin\.journeytocode\.io now\. Open it there and sign in/);
  const open = nodes.find((node) => node.tagName?.toLowerCase() === "a" && /^Open /.test(node.textContent));
  assert.equal(open.href, "https://fern.home.kin.journeytocode.io");
  assert.doesNotMatch(text, /Get started/, "not the first-run card");
  app.householdStatus = { identity: false, lifecycle: "moving", movedTo: "https://fern.home.kin.journeytocode.io" };
  controller.renderOnboarding();
  const moving = all(card.children ?? card.childNodes ?? []).map((node) => node.textContent ?? "").join(" ");
  assert.match(moving, /Your household is moving/);
});
