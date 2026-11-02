// Live household authority and recovery drill across independent browser
// profiles. Each client is a separate Chromium process with its own
// --user-data-dir, cookies, IndexedDB, device keys and virtual authenticator,
// talking to one real in-process Kin server and relay over loopback HTTP.
// The server clock is injectable so Temporary expiry is deterministic.
//
// Evidence limits: pairing operates the real fingerprint checkboxes and
// passkey buttons, but the "comparison" is automated equality between strings
// rendered in two profiles. It does not count as a human verification
// ceremony, and separate profiles on one machine are not separate devices.
//
// Usage: node scripts/household-authority-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, captureFailure, createLoadTrace, printAbortedModules, printLoadTrace, waitForOrigin } from "./cdp-page.mjs";
import { setViewport } from "./cdp-viewport.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Page-side helpers. Each function is serialized with toString() and evaluated
// inside a browser profile, so it must be self-contained.
// ---------------------------------------------------------------------------

async function pageWaitReady() {
  // 30 s: a fresh profile's first start can take longer than 10 s (#164).
  for (let i = 0; i < 1200; i++) {
    const app = document.querySelector("kin-app");
    if (app?.security?.heading && !app.starting) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  const app = document.querySelector("kin-app");
  throw new Error("Kin shell did not become ready: " + JSON.stringify({
    readyState: document.readyState, defined: Boolean(customElements.get("kin-app")), app: Boolean(app),
    starting: Boolean(app?.starting), heading: Boolean(app?.security?.heading), children: app?.childElementCount ?? null,
    controller: Boolean(navigator.serviceWorker?.controller), text: document.body.innerText.slice(0, 200),
  }));
}

async function pageSetupProtection() {
  const app = document.querySelector("kin-app");
  if (app.state !== null || app.vault !== null) throw new Error("Fresh profile must start locked and empty.");
  app.security.showSetup();
  const recovery = app.security.querySelector(".recovery-key").textContent;
  const input = app.security.querySelector("#confirm-recovery");
  input.checked = true;
  input.form.requestSubmit();
  for (let i = 0; i < 400 && !(app.store && !app.security.busy && !app.busy); i++)
    await new Promise((r) => setTimeout(r, 25));
  if (!app.store) throw new Error("Recovery setup did not unlock: " + app.security.alert.textContent);
  return recovery;
}

async function pageUnlock(secret) {
  const app = document.querySelector("kin-app");
  if (app.store && !app.busy) return "already-unlocked";
  await app.security.run(() => app.security.unlockRecovery(secret));
  for (let i = 0; i < 400 && !(app.store && !app.busy && !app.security.busy); i++)
    await new Promise((r) => setTimeout(r, 25));
  if (!app.store) {
    // The alert is START_ERROR whatever went wrong; the ring says what (#770).
    const { diagnostics } = await import("/diagnostics/ring-buffer.js");
    const recent = diagnostics.snapshot().slice(-6).map(({ code, fields }) => ({ code, ...fields }));
    throw new Error("Recovery unlock failed: " + app.security.alert.textContent + " | diagnostics: " + JSON.stringify(recent));
  }
  for (let i = 0; i < 400 && !app.household; i++) await new Promise((r) => setTimeout(r, 25));
  return "unlocked";
}

// Whether this page can start Kin offline (#770): a service worker controls
// it and its release cache holds the engine. A worker only takes control
// once its install staged the whole shell (one failed fetch deletes the new
// cache), so control means the cache is complete. Waits up to 15 s for the
// worker to take control.
async function pageOfflineShell() {
  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
  }
  const names = (await caches.keys()).filter((name) => name.startsWith("kin-static-"));
  const cache = names.length === 1 ? await caches.open(names[0]) : null;
  return {
    controlled: Boolean(navigator.serviceWorker.controller),
    caches: names,
    entries: cache ? (await cache.keys()).length : 0,
    engine: Boolean(await cache?.match("/wasm/kin_engine.wasm")),
  };
}

async function pageIsLocked() {
  const app = document.querySelector("kin-app");
  return Boolean(app?.security?.heading) && !app.starting && app.store === null;
}

async function pageWaitHousehold() {
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 400; i++) {
    const h = app.household;
    if (h && !h.busy && (h.identity !== undefined)) {
      // load() has completed when either identity or claim has been assigned
      // and the component rendered its first content.
      if (h.childElementCount > 0) return { identity: h.identity, claim: h.claim };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Household component did not load: " + document.body.innerText.slice(0, 400));
}

async function pageBootstrap(deviceLabel) {
  const app = document.querySelector("kin-app");
  await app.household.register("bootstrap", { deviceLabel });
  if (!app.household.identity)
    throw new Error("Bootstrap registration failed: " + (app.household.querySelector(".household-message")?.textContent ?? ""));
  await app.security.run(() => app.security.addPasskey());
  const wrapper = app.security.manifest.wrappers.find((value) => value.type === "prf");
  return { identity: app.household.identity, prf: Boolean(wrapper) };
}

// Fingerprint verification. The helpers below read the fingerprint each
// profile renders, compare it with what the *other* profile renders (the
// drill passes those strings between processes), and only then operate the
// product's real "I compared this fingerprint" checkbox and passkey button.
// That proves the rendered values agree across independent clients and that
// approval/activation stay gated until confirmation. It is still automated
// string equality, not a person comparing two screens: it is protocol and UI
// gating evidence, not a completed human verification ceremony.

async function pageShownFingerprint(prompt) {
  const household = document.querySelector("kin-app").household;
  const paragraph = [...household.querySelectorAll(".pairing-fingerprint")]
    .find((element) => element.textContent.startsWith(`${prompt}: `));
  return paragraph?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
}

async function pageClaim({ code, deviceLabel }) {
  const app = document.querySelector("kin-app");
  await app.household.register("claim", { code, deviceLabel });
  const claim = app.household.claim;
  if (!claim)
    throw new Error("Claim registration failed: " + (app.household.querySelector(".household-message")?.textContent ?? ""));
  const shown = (prompt) => [...app.household.querySelectorAll(".pairing-fingerprint")]
    .find((element) => element.textContent.startsWith(`${prompt}: `))
    ?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
  return {
    state: claim.state,
    fingerprint: app.household.localFingerprint,
    shownOwnKey: shown("Compare this device key with the approving adult"),
    shownApprovingKey: shown("Compare the approving device key"),
  };
}

// Invite by QR (#97). The inviter's QR is read back from its canvas pixels by
// the real engine; the joining browser opens the link as a phone's camera app
// would, and a scanner result is stubbed (the camera itself is covered by
// qr-regression.mjs in the browser regression).
async function pageInvitationQr() {
  const h = document.querySelector("kin-app").household;
  const qr = h.querySelector("kin-qr.pairing-qr");
  if (!qr) throw new Error("The invitation shows no QR code");
  for (let i = 0; i < 400 && qr.querySelector(".kin-qr-frame")?.hidden !== false; i++) await new Promise((r) => setTimeout(r, 25));
  const canvas = qr.querySelector("canvas");
  if (!canvas || qr.querySelector(".kin-qr-frame").hidden) throw new Error("The invitation QR was not drawn: " + qr.textContent);
  const { qrCodec } = await import("/wasm/kin-qr.js");
  const codec = await qrCodec();
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const readBack = codec.decodeFrame(width, height, (target) => {
    for (let pixel = 0, byte = 0; pixel < target.length; pixel += 1, byte += 4)
      target[pixel] = (rgba[byte] * 77 + rgba[byte + 1] * 150 + rgba[byte + 2] * 29) >> 8;
  });
  return { value: qr.value, readBack, label: canvas.getAttribute("aria-label"), codeShown: h.querySelector(".pairing-code")?.textContent ?? null };
}

// Sign in with your phone (#100, #101). The computer's QR code is read back
// from its canvas by the real engine, and A's phone approves through its real
// screens, with a real passkey and its real device key.
async function pageStartPhoneSignIn() {
  const app = document.querySelector("kin-app");
  const h = app.household;
  // On People & devices, as a person would be: focus can't move into a
  // hidden view.
  location.hash = "#household/people";
  app.ctx.navigation.showPageFromLocation();
  const choice = [...h.querySelectorAll("button")].find((button) => button.textContent === "Sign in using my phone");
  if (!choice) throw new Error("The signed-out screen offers no Sign in using my phone: " + h.textContent.slice(0, 300));
  choice.click();
  for (let i = 0; i < 400 && !h.querySelector("kin-qr.sign-in-qr"); i++) await new Promise((r) => setTimeout(r, 25));
  const qr = h.querySelector("kin-qr.sign-in-qr");
  if (!qr) throw new Error("The sign-in screen shows no QR code: " + h.textContent.slice(0, 300));
  for (let i = 0; i < 400 && qr.querySelector(".kin-qr-frame")?.hidden !== false; i++) await new Promise((r) => setTimeout(r, 25));
  const canvas = qr.querySelector("canvas");
  if (!canvas || qr.querySelector(".kin-qr-frame").hidden) throw new Error("The sign-in QR was not drawn: " + qr.textContent);
  const { qrCodec } = await import("/wasm/kin-qr.js");
  const codec = await qrCodec();
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const readBack = codec.decodeFrame(width, height, (target) => {
    for (let pixel = 0, byte = 0; pixel < target.length; pixel += 1, byte += 4)
      target[pixel] = (rgba[byte] * 77 + rgba[byte + 1] * 150 + rgba[byte + 2] * 29) >> 8;
  });
  const request = h.ctx.link.request;
  return {
    value: qr.value, readBack, label: canvas.getAttribute("aria-label"), keys: request?.keys ?? null,
    steps: h.textContent.includes("On your phone, open Kin → People & devices → Add a computer → Scan."),
    countdown: h.querySelector(".sign-in-countdown")?.textContent ?? "",
    countdownLive: h.querySelector(".sign-in-countdown")?.hasAttribute("role") ?? true,
    focused: document.activeElement === h.querySelector(".sign-in-heading"),
  };
}

// Add a computer (#101) on A's phone, through its real screens; only the
// scanner's result is stubbed (the camera is covered by qr-regression.mjs).
async function pagePhoneApprove(link) {
  const h = document.querySelector("kin-app").household;
  h.pairing = null;
  h.render();
  const add = [...h.querySelectorAll("button")].find((button) => button.textContent === "Add a computer");
  if (!add) throw new Error("People & devices offers no Add a computer: " + h.textContent.slice(0, 300));
  add.click();
  const scanner = h.querySelector("kin-qr-scanner");
  if (!scanner) throw new Error("Add a computer did not open the scanner");
  const cameraOff = scanner.state === "idle";
  scanner.dispatchEvent(new CustomEvent("kin-qr-scan", { bubbles: true, detail: { url: link } }));
  for (let i = 0; i < 400 && !h.querySelector(".link-approval-warning"); i++) await new Promise((r) => setTimeout(r, 25));
  const warning = h.querySelector(".link-approval-warning")?.textContent ?? "";
  const deviceName = h.querySelector(".link-approval-device")?.textContent ?? "";
  const asYou = h.textContent.includes("signed in as you");
  const view = h.ctx.linkApproval.flow?.view;
  if (!view) throw new Error("The phone shows no approval screen: " + h.textContent.slice(0, 300));
  const approve = [...h.querySelectorAll("button")].find((button) => button.textContent === "Approve with passkey");
  approve.click();
  for (let i = 0; i < 400 && !h.querySelector(".link-approval-code"); i++) await new Promise((r) => setTimeout(r, 25));
  const shown = h.querySelector(".link-approval-code");
  if (!shown) throw new Error("The phone shows no code: " + h.textContent.slice(0, 300));
  return {
    code: shown.querySelector("[aria-hidden=true]")?.textContent ?? "", existingDevice: view.existingDevice, deviceId: view.deviceId, deviceLabel: view.deviceLabel,
    secret: h.ctx.linkApproval.flow.scanned.secret, nonce: h.ctx.linkApproval.flow.scanned.nonce, warning, deviceName, asYou, cameraOff,
    countdown: h.querySelector(".link-approval-countdown")?.textContent ?? "",
  };
}

async function pagePhoneApprovalDone() {
  const h = document.querySelector("kin-app").household;
  for (let i = 0; i < 400 && h.querySelector(".link-approval-heading")?.textContent !== "The computer is signed in"; i++)
    await new Promise((r) => setTimeout(r, 25));
  const heading = h.querySelector(".link-approval-heading")?.textContent ?? "";
  const done = [...h.querySelectorAll("button")].find((button) => button.textContent === "Done");
  done?.click();
  return { heading, closed: !h.ctx.linkApproval.open };
}

async function pageSignInCodeField() {
  const h = document.querySelector("kin-app").household;
  for (let i = 0; i < 400 && !h.querySelector(".sign-in-code input"); i++) await new Promise((r) => setTimeout(r, 25));
  const field = h.querySelector(".sign-in-code input");
  if (!field) throw new Error("The computer never asked for the code: " + h.textContent.slice(0, 300));
  // The status is announced just after the field appears, so the region
  // exists first and screen readers hear it change.
  for (let i = 0; i < 80 && !h.querySelector(".sign-in-status")?.textContent; i++) await new Promise((r) => setTimeout(r, 25));
  return {
    inputMode: field.inputMode, autocomplete: field.autocomplete, focused: document.activeElement === field,
    qrGone: !h.querySelector("kin-qr"), status: h.querySelector(".sign-in-status")?.textContent ?? "",
  };
}

async function pageTypeSignInCode({ code, navigates }) {
  const h = document.querySelector("kin-app").household;
  const field = h.querySelector(".sign-in-code input");
  field.value = code;
  if (navigates) {
    // A new device starts Kin afresh: submit after returning, as pageActivate does.
    setTimeout(() => field.form.requestSubmit(), 100);
    return { submitted: true };
  }
  field.form.requestSubmit();
  for (let i = 0; i < 400 && (h.busy || !h.identity); i++) await new Promise((r) => setTimeout(r, 25));
  if (!h.identity) throw new Error("The computer was not signed in: " + h.textContent.slice(0, 300));
  return { identity: h.identity, path: location.pathname };
}

async function pageJoinField() {
  const h = document.querySelector("kin-app").household;
  for (let i = 0; i < 400 && !h.querySelector('input[name="code"]'); i++) await new Promise((r) => setTimeout(r, 25));
  const field = h.querySelector('input[name="code"]');
  if (!field) throw new Error("The join screen has no code field: " + h.textContent.slice(0, 300));
  return { value: field.value, path: location.pathname, hash: location.hash, search: location.search, claimed: Boolean(h.claim) };
}

async function pageScanInvitation(link) {
  const h = document.querySelector("kin-app").household;
  const field = h.querySelector('input[name="code"]');
  field.value = "";
  const scan = [...h.querySelectorAll("button")].find((button) => button.textContent === "Scan invitation");
  if (!scan) throw new Error("The join screen offers no Scan invitation button");
  scan.click();
  const scanner = h.querySelector("kin-qr-scanner");
  if (!scanner) throw new Error("Scan invitation did not open the scanner");
  const offersTyping = [...scanner.querySelectorAll("button")].some((button) => button.textContent === "Type the code instead");
  const cameraOff = scanner.state === "idle";
  // The stub: the scanner reports the link as it would from the camera.
  scanner.dispatchEvent(new CustomEvent("kin-qr-scan", { bubbles: true, detail: { url: link } }));
  return {
    value: field.value,
    offersTyping,
    cameraOff,
    scannerClosed: !h.querySelector("kin-qr-scanner"),
    claimed: Boolean(h.claim),
    status: h.querySelector(".pairing-scan [role=status]")?.textContent ?? "",
    stillJoining: Boolean([...h.querySelectorAll("button")].find((button) => button.textContent === "Create passkey and request approval")),
  };
}

async function pageRevokeInvitation() {
  const h = document.querySelector("kin-app").household;
  const revoke = [...h.querySelectorAll("button")].find((button) => button.textContent === "Revoke");
  if (!revoke) throw new Error("The invitation has no Revoke button");
  revoke.click();
  for (let i = 0; i < 400 && (h.busy || h.pairing?.state !== "Revoked"); i++) await new Promise((r) => setTimeout(r, 25));
  return {
    state: h.pairing?.state,
    stateText: h.querySelector(".pairing-state")?.textContent ?? "",
    qrShown: Boolean(h.querySelector("kin-qr")),
    codeShown: Boolean(h.querySelector(".pairing-code")),
  };
}

async function pageCreatePairing({ kind, expiresAt }) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  await h.createPairing(kind, expiresAt);
  // Require the code the user would read, not merely component state.
  const shownCode = h.querySelector(".pairing-code")?.textContent;
  const alert = h.querySelector('.household-message[role="alert"]');
  if (!h.pairing?.code || alert || shownCode !== h.pairing.code)
    throw new Error(`Could not create ${kind} invitation: ` + (alert?.textContent ?? "the code was not displayed"));
  return { code: shownCode, pairingId: h.pairing.pairingId, state: h.pairing.state };
}

async function pageApprove({ joiningKey }) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  let latest;
  for (let i = 0; i < 200; i++) {
    latest = await h.api(`/api/pairings/${h.pairing.pairingId}`);
    if (latest.state === "Claimed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (latest.state !== "Claimed") throw new Error("Invitation was not claimed: " + latest.state);
  h.pairing = { ...h.pairing, ...latest };
  const controls = () => {
    h.render();
    const shownKey = [...h.querySelectorAll(".pairing-fingerprint")]
      .find((element) => element.textContent.startsWith("Confirm this matches the joining device: "))
      ?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
    const approve = [...h.querySelectorAll("button")].find((button) => button.textContent === "Approve with passkey");
    const confirmation = [...h.querySelectorAll("label")]
      .find((label) => label.textContent.includes("I compared this fingerprint on both devices."))
      ?.querySelector('input[type="checkbox"]');
    if (!approve || !confirmation) throw new Error("Approval verification controls are missing");
    return { shownKey, approve, confirmation };
  };
  const idle = async () => {
    for (let i = 0; i < 400 && h.busy; i++) await new Promise((r) => setTimeout(r, 25));
  };
  let { shownKey, approve, confirmation } = controls();
  if (!shownKey || shownKey !== joiningKey)
    throw new Error("The approver's displayed fingerprint differs from the joining device's own display");
  const visuallyGated = approve.disabled;
  h.disabled = true;
  h.disabled = false;
  const gateSurvivedBusyCycle = approve.disabled;
  if (confirmation.checked) throw new Error("Approval fingerprint confirmation started checked");
  const versionBefore = h.pairing.version;
  approve.disabled = false;
  approve.click();
  await idle();
  const refusal = h.querySelector('.household-message[role="alert"]')?.textContent ?? "";
  const refusedBeforeConfirmation = /Compare the device fingerprint on both devices before approving/.test(refusal) &&
    h.pairing.state === "Claimed" && h.pairing.version === versionBefore &&
    (await h.api(`/api/pairings/${h.pairing.pairingId}`)).state === "Claimed";
  ({ approve, confirmation } = controls());
  confirmation.click();
  if (approve.disabled) throw new Error("Approval stayed disabled after fingerprint confirmation");
  approve.click();
  for (let i = 0; i < 400 && (h.busy || h.pairing.state !== "Confirmed"); i++) {
    const alert = h.querySelector(".household-message");
    if (alert?.getAttribute("role") === "alert") throw new Error("Approval failed: " + alert.textContent);
    await new Promise((r) => setTimeout(r, 25));
  }
  if (h.pairing.state !== "Confirmed")
    throw new Error("Approval did not confirm: " + (h.querySelector(".household-message")?.textContent ?? h.pairing.state));
  return { memberId: h.pairing.confirmedMemberId, deviceId: h.pairing.confirmedDeviceId,
    refusedBeforeConfirmation, visuallyGated, gateSurvivedBusyCycle, shownKey };
}

async function pageActivate({ approvingKey }) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  await h.load();
  if (h.claim?.state !== "Confirmed") throw new Error("Claim is not confirmed: " + JSON.stringify(h.claim));
  const shownKey = [...h.querySelectorAll(".pairing-fingerprint")]
    .find((element) => element.textContent.startsWith("Compare the approving device key: "))
    ?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
  if (!shownKey || shownKey !== approvingKey)
    throw new Error("The joining device's displayed approver fingerprint differs from the approver's own display");
  const activate = [...h.querySelectorAll("button")].find((button) => button.textContent === "Activate with passkey");
  const confirmation = [...h.querySelectorAll("label")]
    .find((label) => label.textContent.includes("I compared this fingerprint on both devices."))
    ?.querySelector('input[type="checkbox"]');
  if (!activate || !confirmation) throw new Error("Activation verification controls are missing");
  const visuallyGated = activate.disabled;
  h.disabled = true;
  h.disabled = false;
  const gateSurvivedBusyCycle = activate.disabled;
  if (!visuallyGated || !gateSurvivedBusyCycle || confirmation.checked)
    throw new Error("Activation was available before fingerprint confirmation");
  confirmation.click();
  if (activate.disabled) throw new Error("Activation stayed disabled after fingerprint confirmation");
  // Return the gate evidence before activation navigates and destroys this
  // execution context. The caller then waits for the real navigation.
  setTimeout(() => activate.click(), 100);
  return { visuallyGated, gateSurvivedBusyCycle };
}

async function pageTrustDevice(deviceLabel) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const listed = await h.api("/api/devices");
  const device = listed.devices.find((entry) => entry.label === deviceLabel);
  if (!device) throw new Error(`Trusted-device list is missing ${deviceLabel}`);
  await h.showDevices();
  // The row shows the device's synced name (#71), which can differ from the
  // server label, so it is found by device ID.
  const item = h.querySelector(`li[data-device-id="${device.id}"]`);
  if (!item?.textContent.includes("Untrusted"))
    throw new Error(`Untrusted device row is missing for ${deviceLabel}`);
  const verify = [...(item?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Verify device",
  );
  if (!verify) throw new Error(`Verify device is unavailable for ${deviceLabel}`);
  verify.click();
  const trust = [...item.querySelectorAll("button")].find(
    (button) => button.textContent === "Trust this device",
  );
  const confirmation = [...item.querySelectorAll("label")]
    .find((label) => label.textContent.includes("The codes match."))
    ?.querySelector('input[type="checkbox"]');
  if (!trust || !confirmation)
    throw new Error(`Device trust confirmation controls are missing for ${deviceLabel}`);
  const visuallyGated = trust.disabled;
  h.disabled = true;
  h.disabled = false;
  const gateSurvivedBusyCycle = trust.disabled;

  trust.disabled = false;
  trust.click();
  for (let i = 0; i < 400 && h.busy; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const refusal = h.querySelector('.household-message[role="alert"]')?.textContent ?? "";
  const refusedBeforeConfirmation =
    refusal === "Compare the codes on both devices before trusting this device.";
  const unpinnedBeforeConfirmation = !(await h.syncKeyStore.getPinnedDevice(
    h.identity.householdId,
    device.id,
  ));

  confirmation.click();
  if (trust.disabled)
    throw new Error("Device trust stayed disabled after code confirmation");
  trust.click();
  for (let i = 0; i < 400 && h.busy; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const pinnedAfterConfirmation = Boolean(
    await h.syncKeyStore.getPinnedDevice(h.identity.householdId, device.id),
  );
  await h.showDevices();
  const trustedAfterConfirmation = Boolean(
    h.querySelector(`li[data-device-id="${device.id}"]`)?.textContent.includes("Trusted"),
  );
  return {
    visuallyGated,
    gateSurvivedBusyCycle,
    refusedBeforeConfirmation,
    unpinnedBeforeConfirmation,
    pinnedAfterConfirmation,
    trustedAfterConfirmation,
  };
}

async function pageHousehold() {
  const app = document.querySelector("kin-app");
  return app.household.api("/api/household");
}

async function pagePeopleDevicesLayout() {
  const app = document.querySelector("kin-app");
  const h = app.household;
  location.hash = "#household/people";
  app.ctx.navigation.showPageFromLocation();
  await h.showDevices();
  const firstName = h.querySelector(".device-name-line strong");
  if (firstName)
    firstName.textContent = "Alex's very long shared household tablet name that must wrap";
  const groups = [...h.querySelectorAll(".device-group")];
  const lines = [...h.querySelectorAll(".device-name-line")];
  const actions = [...h.querySelectorAll(".people-device-actions button")];
  return {
    width: innerWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    groupCount: groups.length,
    linesFit: lines.every((line) => line.getBoundingClientRect().right <= innerWidth + 0.5),
    actions: actions.map((button) => button.textContent),
    targetHeights: actions.map((button) => button.getBoundingClientRect().height),
  };
}

// `bytes` (an array of byte values) sends a binary body, as sync event
// batches are (web/sync/envelope-wire.js).
async function pageFetch({ path, method = "GET", body, bytes }) {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: bytes ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {},
    body: bytes ? new Uint8Array(bytes) : body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function pagePauseAutomaticSync() {
  const app = document.querySelector("kin-app");
  app.syncCoordinator?.stop();
  app.syncCoordinator = null;
  app.ctx.sync.configureSyncCoordinator = async () => {};
}

async function pageResumeAutomaticSync() {
  const app = document.querySelector("kin-app");
  delete app.ctx.sync.configureSyncCoordinator;
}

async function pageReconnectAutomaticSync() {
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 400 && !(app.syncCoordinator && app.household?.localFingerprint); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  return Boolean(app.syncCoordinator && app.household?.localFingerprint);
}

async function pageShiftClock(offsetMs) {
  const original = Date.now.bind(Date);
  window.__kinOriginalDateNow = original;
  Date.now = () => original() + offsetMs;
}

async function pageRestoreClock() {
  if (!window.__kinOriginalDateNow) return;
  Date.now = window.__kinOriginalDateNow;
  delete window.__kinOriginalDateNow;
}

// The fridge through the real wiring (#372): sync opens the board room and
// hands it to Household → Fridge; nothing is attached by hand. Returns where
// the door is and what the page says, so a failure explains itself.
async function pageOpenFridge() {
  const app = document.querySelector("kin-app");
  location.hash = "#household/fridge";
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  for (let i = 0; i < 600 && !app.fridge?.room; i++) await frame();
  await frame(); await frame();
  const fridge = app.fridge;
  const door = fridge?.querySelector(".fridge-door");
  // A person scrolls to the door first; input outside the viewport goes nowhere.
  door?.scrollIntoView({ block: "center", behavior: "instant" });
  await frame(); await frame();
  const rect = door?.getBoundingClientRect();
  return {
    room: Boolean(fridge?.room), access: fridge?.room?.access ?? null, coordinatorBoard: Boolean(app.syncCoordinator?.board),
    summary: fridge?.querySelector(".fridge-summary")?.textContent ?? null,
    status: fridge?.querySelector(".fridge-status")?.textContent ?? null,
    door: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
    canvas: door ? [...door.querySelectorAll("canvas")].map((canvas) => [canvas.width, canvas.height]) : null,
    hit: rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.className ?? null : null,
  };
}

async function pageFridgeAfterDrawing() {
  const app = document.querySelector("kin-app");
  const fridge = app.fridge;
  const count = () => { try { return fridge.room?.board().strokes.length ?? -1; } catch { return -2; } };
  for (let i = 0; i < 300 && count() < 1 && !fridge.querySelector(".fridge-status")?.textContent; i++)
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  return {
    strokes: count(),
    summary: fridge.querySelector(".fridge-summary")?.textContent ?? null,
    status: fridge.querySelector(".fridge-status")?.textContent ?? null,
    waiting: fridge.room?.waiting ?? null,
  };
}

// Simple view (#343, #350): an admin's switch on a Limited member's row, by
// the real People & devices control and a fresh passkey.
async function pageToggleSimpleView(on) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await h.showHousehold();
    const prefix = on ? "Turn on Simple view for " : "Turn off Simple view for ";
    const button = [...h.querySelectorAll("button")].find((b) => b.textContent.startsWith(prefix));
    if (!button) throw new Error("No control '" + prefix + "': " + h.textContent);
    button.click();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      if (!h.busy && [...h.querySelectorAll("button")].some((b) => b.textContent.startsWith(on ? "Turn off Simple view" : "Turn on Simple view"))) break;
      const alert = h.querySelector(".household-message");
      if (!h.busy && alert?.getAttribute("role") === "alert") throw new Error("Simple view change failed: " + alert.textContent);
    }
    return { text: h.textContent, rowSaysOn: /Simple view on/.test(h.textContent) };
  } finally {
    globalThis.confirm = originalConfirm;
  }
}

async function pageSimpleState() {
  const app = document.querySelector("kin-app");
  return {
    simple: app?.simpleView === true, flag: document.documentElement.dataset.kinSimple ?? null,
    lists: Boolean(document.getElementById("lists")), unlocked: Boolean(app?.store), hash: location.hash,
    nav: app?.navLinks ? [...app.navLinks.values()].filter((link) => !link.hidden).map((link) => link.textContent.trim()) : [],
  };
}

async function pageWaitSimple(want) {
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 600 && (app?.simpleView === true) !== want; i++) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    if (i % 40 === 39) await app?.syncCoordinator?.syncNow?.();
  }
  // Page functions run alone in the page: no calling pageSimpleState here.
  return {
    simple: app?.simpleView === true, flag: document.documentElement.dataset.kinSimple ?? null,
    lists: Boolean(document.getElementById("lists")), unlocked: Boolean(app?.store), hash: location.hash,
    nav: app?.navLinks ? [...app.navLinks.values()].filter((link) => !link.hidden).map((link) => link.textContent.trim()) : [],
  };
}

async function pageLockNow() {
  const app = document.querySelector("kin-app");
  app.ctx.session.lockHousehold();
  for (let i = 0; i < 400 && app.store; i++) await new Promise((r) => requestAnimationFrame(() => r()));
  return !app.store;
}

async function pageEnableSync() {
  const app = document.querySelector("kin-app");
  await app.household.enableSync();
  if (!app.household.syncStatus?.enabled)
    throw new Error("Sync enable failed: " + (app.household.querySelector(".household-message")?.textContent ?? ""));
  return app.household.syncStatus;
}

async function pageSync() {
  const app = document.querySelector("kin-app");
  if (!app.store) throw new Error("Cannot sync a locked profile.");
  if (!app.syncCoordinator) await app.ctx.sync.configureSyncCoordinator();
  const coordinator = app.syncCoordinator;
  if (!coordinator) return { started: false, items: app.state?.items.map((item) => item.text) ?? [] };
  // start() binds device keys and runs its own first sync; wait for that run
  // to settle so this call observes a complete, freshly started sync.
  for (let i = 0; i < 1200 && (!coordinator.deviceKeys || coordinator.running); i++)
    await new Promise((r) => setTimeout(r, 25));
  if (!coordinator.deviceKeys) throw new Error("Sync coordinator did not finish starting: " + app.stateNotice.textContent);
  const states = [];
  const original = coordinator.onState;
  coordinator.onState = (value) => {
    states.push({ state: value.state, code: value.code ?? null, message: value.message ?? null });
    original(value);
  };
  try {
    // A pass already running (a live hint's, or chat's) may have started
    // before the change this call wants to see: let it finish, then run one
    // of our own.
    await coordinator.running;
    await coordinator.syncNow();
    // A device records its automatic name after a successful sync (#71);
    // send it now so relay counts and event sets settle within this call.
    if (await app.deviceDescription) await coordinator.syncNow();
    // A pass cut short to stay within the request budget ("Catching up…")
    // continues shortly: let it, so the call sees a whole sync.
    for (let i = 0; i < 3 && states.at(-1)?.state === "syncing"; i++) {
      await new Promise((r) => setTimeout(r, 300));
      await coordinator.running;
      await coordinator.syncNow();
    }
  } finally {
    coordinator.onState = original;
  }
  for (let i = 0; i < 200 && (app.busy || app.refreshing || app.pendingRefresh || app.wakePending); i++) await new Promise((r) => setTimeout(r, 25));
  return {
    started: true,
    states,
    // A pass that chat or a live hint started earlier may already have
    // paused the coordinator before this call listened: the app keeps the
    // state it last showed.
    last: states.at(-1) ?? (app.syncState?.state
      ? { state: app.syncState.state, code: app.syncState.code ?? null, message: app.syncState.message ?? null }
      : null),
    items: app.state?.items.map((item) => item.text) ?? [],
    notice: app.stateNotice.hidden ? "" : app.stateNotice.textContent,
  };
}

async function pageAddItem(text) {
  const app = document.querySelector("kin-app");
  app.compose.input.value = text;
  // The drill counts one relay envelope per item: capture without a date.
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  for (let i = 0; i < 400; i++) {
    if (!app.busy && app.state?.items.some((item) => item.text === text)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!app.state?.items.some((item) => item.text === text))
    throw new Error("Item was not added locally: " + text);
  return app.state.items.map((item) => item.text);
}

async function pageLocal() {
  const app = document.querySelector("kin-app");
  const events = await app.store.loadEvents();
  const outbox = await app.store.getPendingOutbox(100);
  return {
    events: events.length,
    eventIds: events.map((row) => Array.from(row.event_id, (b) => b.toString(16).padStart(2, "0")).join("")).sort(),
    pendingOutbox: outbox.length,
    items: app.state?.items.map((item) => item.text) ?? null,
    syncState: Boolean(await app.store.getSyncState()),
  };
}

async function pageRevokeDeviceButton(label) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    // Rows show synced device names (#71), so the row is found by the ID
    // behind the server label.
    const device = (await h.api("/api/devices")).devices.find((entry) => entry.label === label);
    if (!device) throw new Error("No trusted device labelled " + label);
    const row = () => h.querySelector(`li[data-device-id="${device.id}"]`);
    // The household may still be finishing a pairing UI command. Wait for it
    // before requesting the device list; run() intentionally ignores busy calls.
    for (let i = 0; i < 400 && h.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (h.busy) throw new Error("Household stayed busy before device revocation");
    await h.showDevices();
    const button = [...(row()?.querySelectorAll("button") ?? [])].find((b) => b.textContent.startsWith("Revoke "));
    if (!button) throw new Error("No revoke control for " + label + ": " + h.textContent);
    button.click();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (!h.busy && row()?.textContent.includes("Revoked")) break;
      const alert = h.querySelector(".household-message");
      if (!h.busy && alert?.getAttribute("role") === "alert") throw new Error("Revocation failed: " + alert.textContent);
    }
    if (!row()?.textContent.includes("Revoked")) throw new Error("Device not shown revoked: " + h.textContent);
    return h.textContent;
  } finally {
    globalThis.confirm = originalConfirm;
  }
}

// #769: a device carried over from the old address by a move shows as such,
// and the admin removes it with the real People & devices button and a fresh
// passkey.
async function pageRemoveCarriedOver(deviceId) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const originalConfirm = globalThis.confirm;
  let asked = "";
  globalThis.confirm = (text) => { asked = text; return true; };
  const wait = async (predicate, label) => {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error("Timed out waiting for " + label + ": " + h.textContent);
  };
  try {
    await wait(() => !h.busy, "People & devices to be idle");
    await h.showDevices();
    const row = () => h.querySelector(`li[data-device-id="${deviceId}"]`);
    const rowText = row()?.textContent ?? "";
    const rowButtons = [...(row()?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    const remove = () => [...h.querySelectorAll("button")].find((b) => b.textContent === "Remove the device from the old address");
    const offered = Boolean(remove());
    if (!offered) throw new Error("No remove-together button: " + h.textContent);
    remove().click();
    await wait(() => {
      const alert = h.querySelector(".household-message");
      if (!h.busy && alert?.getAttribute("role") === "alert") throw new Error("Removal failed: " + alert.textContent);
      return !h.busy && row()?.textContent.includes("Revoked");
    }, "the device to show as revoked");
    return { rowText, rowButtons, offered, asked, revoked: Boolean(row()?.textContent.includes("Revoked")), gone: !remove() };
  } finally {
    globalThis.confirm = originalConfirm;
  }
}

// #78: Adult A publishes the household's home-screen identity through the
// admin-only Home screen section; the manifest and icons then follow A's
// device cookie. Non-admins have no section and the service refuses them.
async function pagePublishInstallIdentity({ shortName, upload = false }) {
  const app = document.querySelector("kin-app");
  await app.ctx.appearance.refreshHouseholdDefaults();
  await app.ctx.appearance.refreshInstallIdentity();
  const panel = app.householdDefaults.install;
  if (!panel) return { section: false };
  const wait = async (predicate, label) => {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error("Timed out waiting for " + label + ": " + panel.textContent);
  };
  panel.toggle.click();
  await wait(() => panel.icons, "first-letter icons");
  if (upload) {
    const source = panel.icons.icon512;
    panel.uploadChoice.input.click();
    const transfer = new DataTransfer();
    transfer.items.add(new File([source], "household-icon.png", { type: "image/png" }));
    panel.file.files = transfer.files;
    panel.file.dispatchEvent(new Event("change"));
    await wait(() => panel.icons && panel.uploadChoice.input.checked, "uploaded icons");
  }
  const privacyShown = !panel.privacy.hidden && panel.privacy.textContent.includes("without encryption");
  const gatedBeforeConfirm = panel.save.disabled;
  panel.shortName.value = shortName;
  panel.shortName.dispatchEvent(new Event("input"));
  panel.confirm.click();
  panel.save.click();
  await wait(() => panel.status.textContent.startsWith("Saved"), "the publish");
  await wait(() => !app.brandUploadedMark.hidden, "the private uploaded header icon");
  const manifest = await (await fetch("/manifest.webmanifest", { credentials: "same-origin", cache: "no-store" })).json();
  const icon = new Uint8Array(await (await fetch(manifest.icons[1].src, { credentials: "same-origin" })).arrayBuffer());
  const view = new DataView(icon.buffer);
  return {
    section: true, privacyShown, gatedBeforeConfirm,
    shortName: manifest.short_name, name: manifest.name, id: manifest.id, iconSrc: manifest.icons[1].src,
    iconSize: [view.getUint32(16), view.getUint32(20)], withdrawShown: !panel.withdraw.hidden,
    privateBrand: app.householdSettings?.brand?.iconSource,
    header: { name: app.brandTitle.textContent, label: app.brandLink.getAttribute("aria-label"), genericHidden: app.brandGenericMark.hidden,
      letterHidden: app.brandLetterMark.hidden, uploadHidden: app.brandUploadedMark.hidden },
    cached: (await caches.keys()).length ? await Promise.all((await caches.keys()).map(async (key) => Boolean(await (await caches.open(key)).match("/manifest.webmanifest")))) : [],
  };
}

async function pageInstallIdentityAsMember() {
  const app = document.querySelector("kin-app");
  await app.ctx.appearance.refreshHouseholdDefaults();
  await app.ctx.appearance.refreshInstallIdentity();
  const put = await fetch("/api/household/install-identity", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
  const manifest = await (await fetch("/manifest.webmanifest", { credentials: "same-origin", cache: "no-store" })).json();
  for (let i = 0; i < 400 && app.brandUploadedMark.hidden; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  return { section: Boolean(app.householdDefaults.install || document.querySelector("kin-install-identity")), putStatus: put.status, shortName: manifest.short_name,
    privateBrand: app.householdSettings?.brand?.iconSource,
    header: { name: app.brandTitle.textContent, label: app.brandLink.getAttribute("aria-label"), genericHidden: app.brandGenericMark.hidden,
      letterHidden: app.brandLetterMark.hidden, uploadHidden: app.brandUploadedMark.hidden } };
}

async function pageWithdrawInstallIdentity() {
  const app = document.querySelector("kin-app");
  // After A's offline reload the section is gone (no authority offline) and
  // returns only on a later sync poll; load authority now rather than race it.
  await app.ctx.appearance.refreshHouseholdDefaults();
  await app.ctx.appearance.refreshInstallIdentity();
  const panel = app.householdDefaults.install;
  if (!panel) return { section: false };
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    panel.stopShowing();
    for (let i = 0; i < 400 && panel.state.published; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  } finally { globalThis.confirm = originalConfirm; }
  const manifest = await (await fetch("/manifest.webmanifest", { credentials: "same-origin", cache: "no-store" })).json();
  return { section: true, published: Boolean(panel.state.published), shortName: manifest.short_name, privateBrand: app.householdSettings?.brand?.iconSource,
    header: { name: app.brandTitle.textContent, genericHidden: app.brandGenericMark.hidden,
      letterHidden: app.brandLetterMark.hidden, uploadHidden: app.brandUploadedMark.hidden } };
}

async function pageHeaderBrandModes() {
  const app = document.querySelector("kin-app");
  const previous = structuredClone(app.currentAppearance);
  const results = [];
  for (const mode of ["light", "dark"]) {
    app.ctx.appearance.applyAppearance({ ...previous, mode });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const mark = app.brandMark.getBoundingClientRect();
    const header = app.header.getBoundingClientRect();
    results.push({ mode, width: innerWidth, mark: [mark.width, mark.height], headerFits: header.right <= innerWidth,
      uploadVisible: !app.brandUploadedMark.hidden, genericHidden: app.brandGenericMark.hidden,
      background: getComputedStyle(app.header).backgroundColor, color: getComputedStyle(app.header).color });
  }
  app.ctx.appearance.applyAppearance(previous);
  return results;
}

async function pagePrivateBrandState() {
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 400 && app.brandUploadedMark.hidden && app.householdSettings?.brand?.iconSource === "upload"; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  return { locked: !app.vault || app.vault.locked, name: app.brandTitle.textContent,
    label: app.brandLink.getAttribute("aria-label"), revision: app.householdSettings?.revision ?? null,
    privateBrand: app.householdSettings?.brand?.iconSource ?? null, genericHidden: app.brandGenericMark.hidden,
    letterHidden: app.brandLetterMark.hidden, uploadHidden: app.brandUploadedMark.hidden };
}

async function pageFailPrivateBrandAsset() {
  const app = document.querySelector("kin-app");
  app.brandUploadedMark.onerror?.(new Event("error"));
  return { genericHidden: app.brandGenericMark.hidden, letterHidden: app.brandLetterMark.hidden,
    uploadHidden: app.brandUploadedMark.hidden, hasObjectUrl: Boolean(app.brandObjectUrl) };
}

async function pageLockAndReadBrand() {
  const app = document.querySelector("kin-app");
  app.ctx.session.lockHousehold(false);
  for (let i = 0; i < 400 && app.store !== null; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  return { locked: !app.vault, title: document.title, name: app.brandTitle.textContent,
    label: app.brandLink.getAttribute("aria-label"), genericHidden: app.brandGenericMark.hidden,
    letterHidden: app.brandLetterMark.hidden, uploadHidden: app.brandUploadedMark.hidden };
}

async function pageWaitForLockedBrand() {
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 400 && app.vault; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  return { locked: !app.vault, name: app.brandTitle.textContent, label: app.brandLink.getAttribute("aria-label"),
    genericHidden: app.brandGenericMark.hidden, letterHidden: app.brandLetterMark.hidden,
    uploadHidden: app.brandUploadedMark.hidden };
}

// #85, #90, #227: turn notifications on and off through the real panel, with the
// browser's permission prompt and PushManager stubbed (no push service).
async function pageNotifications(action) {
  const app = document.querySelector("kin-app");
  const panel = app.notifications;
  if (!window.__kinPushStub) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    let current = null;
    const stub = { prompts: 0, unsubscribed: 0 };
    window.__kinPushStub = stub;
    window.Notification = { permission: "default", requestPermission: async () => { stub.prompts += 1; window.Notification.permission = "granted"; return "granted"; } };
    window.PushManager ??= function PushManager() {};
    const pushManager = {
      getSubscription: async () => current,
      subscribe: async ({ applicationServerKey, userVisibleOnly }) => {
        stub.userVisibleOnly = userVisibleOnly;
        current = { options: { applicationServerKey }, unsubscribe: async () => { stub.unsubscribed += 1; current = null; return true; },
          toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/kin-drill", keys: { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } }) };
        return current;
      },
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve({ pushManager }), controller: null } });
  }
  const stub = window.__kinPushStub;
  await panel.refresh();
  const wait = async (predicate, label) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error("Timed out waiting for " + label + ": " + panel.textContent);
  };
  const button = (text) => [...panel.querySelectorAll("button")].find((entry) => entry.textContent === text);
  if (action === "on") {
    const promptsBefore = stub.prompts;
    button("Turn on notifications").click();
    await wait(() => panel.state.textContent === "On.", "notifications on");
    return { state: panel.state.textContent, promptedOnlyOnPress: stub.prompts === promptsBefore + 1, userVisibleOnly: stub.userVisibleOnly,
      status: await (await fetch("/api/push/subscription")).json(),
      recipientExplanation: panel.textContent.includes("other household members") && panel.textContent.includes("never receive notifications for changes you make"),
      localChecks: [...panel.querySelectorAll(".notification-checks dd")].map((entry) => entry.textContent),
      testGuide: panel.textContent.includes("two distinct household members") && ![...panel.querySelectorAll("button")].some((entry) => /send.*test/i.test(entry.textContent)),
      accessibleDiagnostics: panel.querySelectorAll(".notification-checks dt").length === 3 && (() => {
        const summary = panel.querySelector(".notification-test-guide > summary");
        return summary?.tagName === "SUMMARY" && getComputedStyle(summary).minHeight === "48px";
      })(),
    };
  }
  button("Turn off notifications").click();
  await wait(() => panel.state.textContent === "Off.", "notifications off");
  return { state: panel.state.textContent, unsubscribed: stub.unsubscribed, status: await (await fetch("/api/push/subscription")).json() };
}

async function pageRemoveMemberButton(buttonText) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await h.showHousehold();
    const button = [...h.querySelectorAll("button")].find((b) => b.textContent === buttonText);
    if (!button) throw new Error("No control '" + buttonText + "': " + h.textContent);
    button.click();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (!h.busy && ![...h.querySelectorAll("button")].some((b) => b.textContent === buttonText)) break;
      const alert = h.querySelector(".household-message");
      if (!h.busy && alert?.getAttribute("role") === "alert") throw new Error("Removal failed: " + alert.textContent);
    }
    return h.textContent;
  } finally {
    globalThis.confirm = originalConfirm;
  }
}

async function pageHouseholdText() {
  const app = document.querySelector("kin-app");
  await app.household.showHousehold();
  return app.household.textContent;
}

async function pageExportArchive({ clockOffset = 0 } = {}) {
  const app = document.querySelector("kin-app");
  let blob = null;
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalCreate = URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function () {};
  URL.createObjectURL = (value) => { blob = value; return originalCreate.call(URL, value); };
  const systemNow = Date.now;
  Date.now = () => systemNow() + clockOffset;
  try {
    await app.security.run(() => app.security.downloadArchive());
  } finally {
    Date.now = systemNow;
    HTMLAnchorElement.prototype.click = originalClick;
    URL.createObjectURL = originalCreate;
  }
  if (!blob) throw new Error("Export produced no download: " + app.security.alert.textContent);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const snapshot = await app.store.snapshotForArchive();
  const membership = app.syncCoordinator ? await app.syncCoordinator.portableMembershipSnapshot() : null;
  return { base64: btoa(binary), bytes: bytes.length, events: snapshot.events.length,
    membership, message: app.security.message.textContent };
}

async function pageRestoreArchive({ base64, secret, clockOffset = 0 }) {
  const app = document.querySelector("kin-app");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  location.hash = "#household/privacy";
  app.ctx.navigation.showPageFromLocation();
  app.security.showRestore();
  const file = app.security.querySelector("#archive-file");
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], "kin-household.kin", { type: "application/octet-stream" }));
  file.files = transfer.files;
  app.security.querySelector("#archive-recovery").value = secret;
  const systemNow = Date.now;
  Date.now = () => systemNow() + clockOffset;
  file.form.requestSubmit();
  for (let i = 0; i < 800 && !(!app.security.busy && app.security.querySelector("#restore-confirm")); i++)
    await new Promise((r) => setTimeout(r, 25));
  const confirmation = app.security.querySelector("#restore-confirm");
  Date.now = systemNow;
  if (!confirmation) throw new Error("Archive validation failed: " + app.security.alert.textContent);
  const stagedEvents = (await app.store.loadEvents()).length;
  confirmation.click();
  for (let i = 0; i < 800 && (app.security.busy || app.busy); i++) await new Promise((r) => setTimeout(r, 25));
  if (!app.security.message.textContent.includes("restored on this device"))
    throw new Error("Restore did not complete: " + app.security.alert.textContent + " " + app.security.message.textContent);
  for (let i = 0; i < 400 && (app.busy || !app.household || app.household.busy); i++) await new Promise((r) => setTimeout(r, 25));
  const snapshot = await app.store.snapshotForArchive();
  return {
    stagedEvents,
    events: (await app.store.loadEvents()).length,
    items: app.state?.items.map((item) => item.text) ?? [],
    message: app.security.message.textContent,
    membership: snapshot.local_context[0]?.portable_membership ?? null,
    identity: app.household?.identity ?? null,
    syncState: Boolean(await app.store.getSyncState()),
    coordinator: Boolean(app.syncCoordinator),
  };
}

// ---------------------------------------------------------------------------
// Node-side browser profile management.
// ---------------------------------------------------------------------------

async function launchProfile(executable, label, origin) {
  const profile = await mkdtemp(join(tmpdir(), `kin-authority-${label}-`));
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--edge-skip-compat-layer-relaunch",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    BROWSER_STDIO,
  );
  const port = await waitForDevTools(browser, profile, { label: `Browser ${label}` });
  // The tab opens on about:blank and loads Kin only once the load trace
  // (#594) is listening, so a first start that stalls can show why.
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
    .then((response) => response.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  // Page errors, failed requests and requests still open, reported when the
  // shell fails to start (#164): it once stopped with only the skip link
  // rendered, which means the app's modules never finished loading.
  const diagnostics = { errors: [], failed: [], open: new Map() };
  const loadTrace = createLoadTrace();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) loadTrace.observe(message);
    if (message.method === "Runtime.exceptionThrown")
      diagnostics.errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
    else if (message.method === "Log.entryAdded" && message.params.entry.level === "error")
      diagnostics.errors.push(`${message.params.entry.text} ${message.params.entry.url ?? ""}`.trim());
    else if (message.method === "Network.requestWillBeSent")
      diagnostics.open.set(message.params.requestId, message.params.request.url);
    else if (message.method === "Network.loadingFinished")
      diagnostics.open.delete(message.params.requestId);
    else if (message.method === "Network.loadingFailed") {
      diagnostics.failed.push(`${diagnostics.open.get(message.params.requestId) ?? message.params.requestId}: ${message.params.errorText}`);
      diagnostics.open.delete(message.params.requestId);
    }
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (!task) return;
      message.error ? task.reject(Error(JSON.stringify(message.error))) : task.resolve(message.result);
    }
  };
  socket.onclose = () => {
    for (const task of pending.values()) task.reject(new Error("CDP socket closed"));
    pending.clear();
  };
  const send = (method, params) =>
    new Promise((resolveSend, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {
        pending.delete(next);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
      pending.set(next, {
        resolve: (value) => { clearTimeout(timer); resolveSend(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails)
      throw new Error(`[${label}] ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  // A failure names the page function, so a CI log says which step broke.
  const call = (fn, argument) => (beforePageCall(), evaluate(`(${fn.toString()})(${argument === undefined ? "" : JSON.stringify(argument)})`)
    .catch((error) => {
      if (!error.message.startsWith(`[${label}]`)) error.message = `[${label}] ${fn.name || "inline page function"}: ${error.message}`;
      throw error;
    }));
  // For page functions that only wait or read: a navigation can tear down
  // the page's context mid-call (#164), so retry those a few times. Never
  // used for a step that changes anything, which must not run twice.
  const contextLost = (error) => /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated/.test(error?.message ?? "");
  const callStable = async (fn, argument) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call(fn, argument);
      } catch (error) {
        if (!contextLost(error) || attempt >= 5) throw error;
        await delay(200);
      }
    }
  };
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  // Worker starts, stops and version changes go into the load trace.
  await send("ServiceWorker.enable").catch(() => {});
  await applyRegressionDefaults(send);
  await send("Page.navigate", { url: origin });
  await waitForOrigin(evaluate, origin, { navigate: () => send("Page.navigate", { url: origin }) });
  await send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  const client = {
    label,
    profile,
    send,
    evaluate,
    call,
    callStable,
    authenticatorId,
    recovery: null,
    async ready() {
      try {
        await callStable(pageWaitReady);
      } catch (error) {
        client.addDiagnostics(error);
        // How the tab loaded Kin, and whether a load lost a module (#594).
        printLoadTrace(loadTrace, label);
        printAbortedModules(loadTrace, label);
        throw error;
      }
    },
    addDiagnostics(error) {
      const report = { errors: diagnostics.errors.slice(-10), failed: diagnostics.failed.slice(-10), open: [...diagnostics.open.values()].slice(-20) };
      error.message += ` | page diagnostics: ${JSON.stringify(report)}`;
    },
    // How the tab loaded Kin, with its service worker's states (#594, #770).
    printTrace() { printLoadTrace(loadTrace, label); },
    async setOffline(offline) {
      await send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },
    // Wait through a navigation until the locked shell is present, then unlock.
    async waitForReloadAndUnlock() {
      let locked = false;
      for (let attempt = 0; attempt < 400 && !locked; attempt += 1) {
        locked = await call(pageIsLocked).catch(() => false);
        if (!locked) await delay(25);
      }
      assert.ok(locked, `[${label}] page did not return to the locked shell after activation`);
      await call(pageUnlock, client.recovery);
      return callStable(pageWaitHousehold);
    },
    async close() {
      try {
        await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
        await send("WebAuthn.disable").catch(() => {});
      } finally {
        const closed = new Promise((resolveClose) => socket.addEventListener("close", resolveClose, { once: true }));
        socket.close();
        await Promise.race([closed, delay(1_000)]);
        if (process.platform === "win32" && browser.pid) {
          const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
            "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe' OR Name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
          { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
          const [code] = await once(killer, "exit");
          if (code !== 0) console.warn(`Could not terminate browser processes for profile ${label} (PowerShell ${code}).`);
        } else browser.kill();
        if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(2_000)]);
        browser.unref();
        await delay(200);
        assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
        await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((error) => {
          if (error.code !== "EBUSY") throw error;
          console.warn(`Temporary profile ${label} remained busy; the OS may remove it later.`);
        });
      }
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// The drill.
// ---------------------------------------------------------------------------

// The drill drives hundreds of requests per device in a minute (sync, chat,
// exports, sign-in). It checks authority, not the 256-requests-a-minute sync
// limit, which has its own tests: each page step starts with a fresh window,
// so a slow runner cannot turn the drill's own pace into a failure.
let beforePageCall = () => {};

export async function householdAuthorityDrill({ executable, origin, service, syncService, clock, pushes = [], requests = [] }) {
  beforePageCall = () => syncService.rateBuckets?.clear();
  let checks = 0;
  const check = (condition, message) => {
    assert.ok(condition, message);
    checks += 1;
  };
  const pass = (message) => console.log(`PASS ${message}`);
  const open = [];
  const launch = async (label) => {
    const client = await launchProfile(executable, label, origin);
    open.push(client);
    await client.ready();
    client.recovery = await client.call(pageSetupProtection);
    await client.callStable(pageWaitHousehold);
    return client;
  };
  const retire = async (client) => {
    open.splice(open.indexOf(client), 1);
    await client.close();
  };
  const relaySession = (memberId, deviceId) => service.issueSession(memberId, deviceId).sessionToken;
  const relayEvents = (token) => {
    const rows = [];
    let cursor = "";
    for (;;) {
      const page = syncService.pull(token, cursor, "20");
      rows.push(...page.events);
      if (!page.events.length || !page.nextCursor || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
      if (rows.length > 500) break;
    }
    return rows;
  };
  // Drives the real fingerprint controls on both sides of a pairing; see the
  // evidence note above pageShownFingerprint().
  const verifyAndApprove = async ({ inviter, invitee, invitation, deviceLabel }) => {
    const approverKey = await inviter.call(pageShownFingerprint, "Compare this household device key");
    const claimed = await invitee.call(pageClaim, { code: invitation.code, deviceLabel });
    check(claimed.state === "Claimed" && claimed.fingerprint, `${deviceLabel} claim is recorded with its local device fingerprint`);
    check(/^[a-f0-9]{64}$/.test(approverKey ?? "") && claimed.shownApprovingKey === approverKey &&
      claimed.shownOwnKey === claimed.fingerprint,
    `${deviceLabel} and its approver render matching fingerprints for both device keys`);
    const approved = await inviter.call(pageApprove, { joiningKey: claimed.shownOwnKey });
    check(approved.visuallyGated && approved.gateSurvivedBusyCycle &&
      approved.refusedBeforeConfirmation && approved.shownKey === claimed.fingerprint,
      `${deviceLabel} approval stays visibly and functionally gated until the approver confirms the compared fingerprint`);
    return { approved, approverKey };
  };
  const join = async ({ inviter, invitee, kind, expiresAt, deviceLabel }) => {
    const invitation = await inviter.call(pageCreatePairing, { kind, expiresAt });
    const { approved, approverKey } = await verifyAndApprove({ inviter, invitee, invitation, deviceLabel });
    check(/^[a-f0-9]{32}$/.test(approved.memberId) && /^[a-f0-9]{32}$/.test(approved.deviceId), `${deviceLabel} approval confirms member and device identities`);
    // pageActivate also refuses to continue unless activation is gated until
    // the joining device confirms the approver fingerprint.
    const activation = await invitee.call(pageActivate, { approvingKey: approverKey });
    check(activation.visuallyGated && activation.gateSurvivedBusyCycle,
      `${deviceLabel} activation stays disabled through a busy cycle until the approver fingerprint is confirmed`);
    const loaded = await invitee.waitForReloadAndUnlock();
    check(loaded.identity?.memberId === approved.memberId && loaded.identity?.deviceId === approved.deviceId,
      `${deviceLabel} holds the approved identity after reload and local unlock`);
    return approved;
  };

  try {
    // ---- Profile A: first Adult, household creator -----------------------
    const a = await launch("adult-a");
    const aBoot = await a.call(pageBootstrap, "Chrome on Windows");
    check(aBoot.identity && aBoot.prf, "Adult A registers with a real virtual passkey and PRF wrapper");
    await a.call(pageAddItem, "A1 before anyone joins");
    const aSync = await a.call(pageEnableSync);
    check(aSync.enabled, "Adult A enables household sync");
    let result = await a.call(pageSync);
    check(result.last?.state !== "paused", "Adult A completes the first relay sync: " + JSON.stringify(result.last));
    const aRelay = relaySession(aBoot.identity.memberId, aBoot.identity.deviceId);
    check(relayEvents(aRelay).length === 2, "relay holds A1 and A's device name (#71) as two opaque envelopes");
    // Draw on the fridge with the real mouse, through the real wiring (#372).
    const fridge = await a.callStable(pageOpenFridge);
    check(fridge.room && fridge.access === "write" && fridge.door?.width > 100,
      "sync opens the fridge for Adult A: " + JSON.stringify(fridge));
    const point = (fx, fy) => ({ x: Math.round(fridge.door.left + fridge.door.width * fx), y: Math.round(fridge.door.top + fridge.door.height * fy) });
    const start = point(0.3, 0.3);
    await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
    await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 8; step += 1)
      await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point(0.3 + step * 0.04, 0.3 + step * 0.03), button: "left", buttons: 1 });
    await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point(0.62, 0.54), button: "left", buttons: 0, clickCount: 1 });
    const drawn = await a.callStable(pageFridgeAfterDrawing);
    check(drawn.strokes >= 1, "a mouse stroke on the synced fridge is saved: " + JSON.stringify({ ...fridge, ...drawn }));
    await a.call(() => { location.hash = "#today"; });
    pass(`${checks} household creation assertions (profile A)`);

    // ---- Profile B: second Adult -----------------------------------------
    const b = await launch("adult-b");

    // Invite by QR (#97), with an invitation that is then revoked; B joins
    // below with a fresh one.
    const qrInvitation = await a.call(pageCreatePairing, { kind: "adult" });
    const shownQr = await a.call(pageInvitationQr);
    check(shownQr.value === `${origin}/pair#code=${encodeURIComponent(qrInvitation.code)}` && shownQr.readBack === shownQr.value &&
      shownQr.codeShown === qrInvitation.code && /QR code for this invitation/.test(shownQr.label ?? ""),
      "the invitation shows a labelled QR code, beside its code, that reads back as the fragment link");
    await b.send("Page.navigate", { url: shownQr.value });
    await b.waitForReloadAndUnlock();
    const opened = await b.callStable(pageJoinField);
    check(opened.value === qrInvitation.code && opened.path === "/pair" && opened.hash === "" && opened.search === "" && !opened.claimed,
      "opening the invitation link fills in the code and clears it from the address bar: " + JSON.stringify(opened));
    const scanned = await b.call(pageScanInvitation, shownQr.value);
    check(scanned.value === qrInvitation.code && scanned.scannerClosed && scanned.offersTyping && scanned.cameraOff && scanned.stillJoining && !scanned.claimed &&
      /Code filled in/.test(scanned.status),
      "a scanned invitation fills in the code; the camera waits for a tap, typing is offered, and joining still needs a passkey: " + JSON.stringify(scanned));
    const codeForms = [qrInvitation.code, qrInvitation.code.replaceAll("-", "")].map((value) => value.toLowerCase());
    const leaked = requests.filter(({ url, referer }) => codeForms.some((value) => url.toLowerCase().includes(value) || referer.toLowerCase().includes(value)));
    // The service also sends Referrer-Policy: no-referrer, so the Referer half
    // is a second line of defence; the request URLs are the real check.
    check(requests.length > 0 && leaked.length === 0, "the invitation code never appears in a request URL or Referer: " + JSON.stringify(leaked.slice(0, 3)));
    // Opening the link and scanning it filled in a field and nothing more.
    const untouched = await a.call(pageFetch, { path: `/api/pairings/${qrInvitation.pairingId}` });
    check(untouched.status === 200 && untouched.body?.state === "Pending",
      "opening or scanning an invitation claims nothing: the service still has it pending: " + JSON.stringify(untouched.body?.state));
    const ended = await a.call(pageRevokeInvitation);
    check(ended.state === "Revoked" && ended.stateText === "This invitation ended: it was revoked." && !ended.qrShown && !ended.codeShown,
      "a revoked invitation is replaced by \"This invitation ended\", never a stale QR or code: " + JSON.stringify(ended));
    pass("invite by QR assertions (#97)");
    const bIdentity = await join({ inviter: a, invitee: b, kind: "adult", deviceLabel: "Edge on Windows" });
    let household = await b.callStable(pageHousehold);
    const bMember = household.members.find((member) => member.current);
    check(bMember?.kind === "adult" && bMember.active, "Adult B is an active Adult in the server household view");
    check(household.adminRecorded && !bMember.admin && !household.canManageMembers &&
      household.members.some((member) => !member.current && member.kind === "adult" && member.admin),
      "the founding Adult A is the household admin and Adult B is not");
    await setViewport(a, { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
    const peopleDevicesLayout = await a.call(pagePeopleDevicesLayout);
    check(peopleDevicesLayout.width === 320 && !peopleDevicesLayout.overflow &&
      peopleDevicesLayout.groupCount >= 2 && peopleDevicesLayout.linesFit &&
      peopleDevicesLayout.actions.includes("Invite another person") && peopleDevicesLayout.actions.includes("Add my device") &&
      peopleDevicesLayout.targetHeights.every((height) => height >= 44),
    "People & devices groups members, wraps a long label, and keeps both actions tappable without 320px overflow: " +
      JSON.stringify(peopleDevicesLayout));
    await setViewport(a, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const bPairing = await b.call(pageFetch, { path: "/api/pairings", method: "POST", body: { kind: "limited" } });
    check(bPairing.status === 403 && bPairing.body?.error === "household_admin_required",
      "non-admin Adult B cannot create invitations: " + JSON.stringify(bPairing));
    result = await a.call(pageSync); // A commits the rotation and provisions B's epoch keys.
    check(result.last?.state !== "paused", "Adult A rotates and provisions after B joins: " + JSON.stringify(result.last));
    const notificationsOn = await b.call(pageNotifications, "on");
    check(notificationsOn.state === "On." && notificationsOn.promptedOnlyOnPress && notificationsOn.userVisibleOnly === true &&
      notificationsOn.status.subscribed && notificationsOn.recipientExplanation && notificationsOn.testGuide && notificationsOn.accessibleDiagnostics &&
      notificationsOn.localChecks.includes("Allowed") && notificationsOn.localChecks.includes("On for this device") && notificationsOn.localChecks.includes("Not muted"),
      "Adult B turns notifications on: one permission prompt after pressing Turn on, a visible-only subscription, recipient rules and local diagnostics stated");
    const pushesBefore = pushes.length;
    await a.call(pageAddItem, "A2 after B joined");
    result = await a.call(pageSync);
    result = await b.call(pageSync);
    check(result.started && result.items.includes("A2 after B joined"), "Adult B receives A2 through the relay: " + JSON.stringify(result));
    check(pushes.slice(pushesBefore).includes(bIdentity.deviceId) && !pushes.slice(pushesBefore).includes(aBoot.identity.deviceId),
      "A's synced change notifies B's device, never the author's own: " + JSON.stringify(pushes.slice(pushesBefore)));
    const notificationsOff = await b.call(pageNotifications, "off");
    check(notificationsOff.state === "Off." && notificationsOff.unsubscribed === 1 && !notificationsOff.status.subscribed,
      "Adult B turns notifications off: the browser subscription and the service's copy are both removed");
    check(!result.items.includes("A1 before anyone joins"),
      "new Adult B receives current and later epochs only; pre-join A1 is not provisioned (PAIRING contract)");
    await setViewport(a, { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
    const published = await a.call(pagePublishInstallIdentity, { shortName: "Nichols", upload: true });
    check(published.section && published.privacyShown && published.gatedBeforeConfirm,
      "admin A's Home screen section states what the service will store and requires confirmation before the first publish");
    check(published.shortName === "Nichols" && published.id === "/" && /^\/install-icon\/512\.png\?v=[a-f0-9]{16}$/.test(published.iconSrc),
      "A's device receives the published manifest with a stable id and content-versioned icons: " + JSON.stringify(published));
    check(published.iconSize[0] === 512 && published.iconSize[1] === 512, "the uploaded icon is a real 512x512 PNG redrawn in the browser");
    check(published.privateBrand === "upload" && published.header.name && published.header.label === `${published.header.name} — Today` &&
      published.header.genericHidden && published.header.letterHidden && !published.header.uploadHidden,
      "admin A's unlocked header uses the uploaded icon from encrypted household settings: " + JSON.stringify(published.header));
    await a.setOffline(true);
    await a.send("Page.reload", {});
    await a.waitForReloadAndUnlock();
    const offlineBrand = await a.call(pagePrivateBrandState);
    check(!offlineBrand.locked && offlineBrand.privateBrand === "upload" && offlineBrand.revision > 0 &&
      offlineBrand.genericHidden && offlineBrand.letterHidden && !offlineBrand.uploadHidden,
      "an immediate offline hard reload restores the accepted private icon from the protected revision cache: " + JSON.stringify(offlineBrand));
    await a.setOffline(false);
    check(await a.call(pageReconnectAutomaticSync), "A reconnects household sync after the offline identity restore");
    const mobileBrandModes = await a.call(pageHeaderBrandModes);
    check(mobileBrandModes.every((entry) => entry.width === 320 && entry.mark[0] === 32 && entry.mark[1] === 32 && entry.headerFits &&
      entry.uploadVisible && entry.genericHidden && entry.background !== entry.color),
      "the private brand fits the 320px header in light and dark modes: " + JSON.stringify(mobileBrandModes));
    await setViewport(a, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const desktopBrandModes = await a.call(pageHeaderBrandModes);
    check(desktopBrandModes.every((entry) => entry.width === 1280 && entry.mark[0] === 32 && entry.mark[1] === 32 && entry.headerFits &&
      entry.uploadVisible && entry.genericHidden && entry.background !== entry.color),
      "the private brand fits the desktop header in light and dark modes: " + JSON.stringify(desktopBrandModes));
    check(published.withdrawShown && !published.cached.some(Boolean), "Stop showing is offered and the service worker never caches the manifest");
    const memberView = await b.call(pageInstallIdentityAsMember);
    check(!memberView.section && memberView.putStatus === 403,
      "non-admin B has no Home screen section and the service refuses B's publish");
    check(memberView.shortName === "Nichols", "B's device in the same household receives the published manifest");
    check(memberView.privateBrand === "upload" && memberView.header.name === published.header.name && memberView.header.label === published.header.label &&
      memberView.header.genericHidden && memberView.header.letterHidden && !memberView.header.uploadHidden,
      "non-admin B's unlocked header receives the private household icon and accessible name: " + JSON.stringify(memberView.header));
    const failedBrand = await b.call(pageFailPrivateBrandAsset);
    check(!failedBrand.genericHidden && failedBrand.letterHidden && failedBrand.uploadHidden && !failedBrand.hasObjectUrl,
      "a failed private icon asset falls back to the generic Kin mark without retaining its object URL: " + JSON.stringify(failedBrand));
    const recoveredBrand = await b.call(pageInstallIdentityAsMember);
    check(recoveredBrand.header.genericHidden && recoveredBrand.header.letterHidden && !recoveredBrand.header.uploadHidden,
      "the next verified household refresh replaces an asset failure with the current private icon");
    const lockedBrand = await b.call(pageLockAndReadBrand);
    check(lockedBrand.locked && lockedBrand.title.endsWith("— Kin") && !lockedBrand.title.includes(published.header.name) &&
      lockedBrand.name === "Kin" && lockedBrand.label === "Kin — Today" &&
      !lockedBrand.genericHidden && lockedBrand.letterHidden && lockedBrand.uploadHidden,
      "locking clears the private household identity before the locked shell is exposed: " + JSON.stringify(lockedBrand));
    await b.call(pageUnlock, b.recovery);
    await b.callStable(pageWaitHousehold);
    const reopenedBrand = await b.call(pagePrivateBrandState);
    check(reopenedBrand.privateBrand === "upload" && reopenedBrand.genericHidden && reopenedBrand.letterHidden && !reopenedBrand.uploadHidden,
      "reopening the household restores its private identity without retaining the locked fallback: " + JSON.stringify(reopenedBrand));
    const withdrawn = await a.call(pageWithdrawInstallIdentity);
    check(withdrawn.section && !withdrawn.published && withdrawn.shortName === "Kin" && withdrawn.privateBrand === "upload" &&
      withdrawn.header.genericHidden && withdrawn.header.letterHidden && !withdrawn.header.uploadHidden,
      "withdrawing plaintext home-screen identity leaves A's encrypted in-app icon intact: " + JSON.stringify(withdrawn));
    const memberAfterWithdrawal = await b.call(pageInstallIdentityAsMember);
    check(memberAfterWithdrawal.shortName === "Kin" && memberAfterWithdrawal.privateBrand === "upload" &&
      memberAfterWithdrawal.header.genericHidden && memberAfterWithdrawal.header.letterHidden && !memberAfterWithdrawal.header.uploadHidden,
      "B keeps the private in-app icon after normal refresh while the manifest returns to Kin: " + JSON.stringify(memberAfterWithdrawal));
    pass(`${checks} Adult admission assertions (profiles A and B)`);

    // ---- Profile C: Limited member ---------------------------------------
    let c = await launch("limited-c");
    await join({ inviter: a, invitee: c, kind: "limited", deviceLabel: "Firefox on Linux" });
    household = await c.callStable(pageHousehold);
    const cMember = household.members.find((member) => member.current);
    check(cMember?.kind === "limited" && cMember.active, "Limited C is an active Limited member");
    for (const probe of [
      { path: "/api/pairings", method: "POST", body: { kind: "adult" } },
      { path: "/api/devices/pairings", method: "POST", body: {} },
      { path: "/api/sync/enable", method: "POST", body: {} },
      { path: "/api/devices", method: "GET" },
      { path: "/api/household/membership/remove/options", method: "POST", body: { memberId: bIdentity.memberId } },
      { path: "/api/sync/provisioning/grants", method: "POST", body: { recipientDeviceId: bIdentity.deviceId, keyEpoch: 1, requestId: "a".repeat(32) } },
      { path: "/api/sync/epochs", method: "POST", body: { expectedEpoch: 1, packages: [], proposalId: "b".repeat(32) } },
    ]) {
      const denied = await c.call(pageFetch, probe);
      check(denied.status === 403 && denied.body?.error === "adult_required",
        `Limited C is denied ${probe.method} ${probe.path} (${denied.status} ${denied.body?.error})`);
    }
    result = await a.call(pageSync);
    result = await c.call(pageSync);
    check(result.started && result.last?.state !== "paused", "Limited C syncs after Adult A provisions it: " + JSON.stringify(result.last));
    const bTrustsC = await b.call(pageTrustDevice, "Firefox on Linux");
    check(bTrustsC.visuallyGated && bTrustsC.gateSurvivedBusyCycle,
      "Adult B's Trust this device control stays disabled through a busy cycle until code confirmation");
    check(bTrustsC.refusedBeforeConfirmation && bTrustsC.unpinnedBeforeConfirmation,
      "Adult B's forced unconfirmed device-trust click is refused without pinning Client C");
    check(bTrustsC.pinnedAfterConfirmation,
      "Adult B pins Client C exactly after confirming the displayed device code");
    check(bTrustsC.trustedAfterConfirmation,
      "Adult B sees Client C change from Untrusted to Trusted after confirmation");
    await c.call(pageAddItem, "C1 limited member item");
    result = await c.call(pageSync);
    result = await a.call(pageSync);
    check(result.items.includes("C1 limited member item"), "Adult A receives Limited C's event");
    // Simple view (#343, #350): A turns it on; C's device switches on its
    // next poll; an offline unlock stays simple; A turns it off again.
    const turnedOn = await a.call(pageToggleSimpleView, true);
    check(turnedOn.rowSaysOn, "the admin's People row says Simple view on");
    result = await c.call(pageSync);
    let simple = await c.call(pageWaitSimple, true);
    check(simple.simple && simple.flag === "on" && !simple.lists && JSON.stringify(simple.nav) === JSON.stringify(["Today", "Chat", "Fridge"]),
      "Limited C's device switches to Simple view on its next poll: " + JSON.stringify(simple));
    check(await c.call(pageLockNow), "Limited C locks");
    const shell = await c.callStable(pageOfflineShell);
    // The trace shows whether C's last load began before its worker activated (#770).
    if (!(shell.controlled && shell.engine)) c.printTrace();
    check(shell.controlled && shell.engine, "Limited C's service worker controls the page and holds the shell before going offline: " + JSON.stringify(shell));
    await c.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
      await c.call(pageUnlock, c.recovery);
      simple = await c.callStable(pageSimpleState);
      check(simple.unlocked && simple.simple && !simple.lists, "an offline unlock opens Simple view from the cached layout: " + JSON.stringify(simple));
    } catch (error) {
      c.addDiagnostics(error);
      c.printTrace();
      throw error;
    } finally {
      await c.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
    const turnedOff = await a.call(pageToggleSimpleView, false);
    check(!turnedOff.rowSaysOn, "the admin's People row no longer says Simple view on");
    // C's next pass reloads Kin into the full layout (unlocked again where a
    // refresh keeps Kin unlocked; otherwise C unlocks).
    let full = await c.callStable(pageWaitSimple, false);
    if (!full.unlocked) {
      await c.callStable(pageWaitReady);
      await c.call(pageUnlock, c.recovery);
    }
    full = await c.callStable(pageWaitSimple, false);
    check(full && !full.simple && full.lists && full.flag === null, "turning it off brings back the full Kin: " + JSON.stringify(full));
    await c.callStable(pageWaitHousehold);
    pass(`${checks} Limited admission and restriction assertions (profile C)`);

    // ---- Remove Limited C while C is offline --------------------------------
    const cDevice = [...service.devices.values()].find((device) => device.memberId === cMember.id);
    await c.setOffline(true);
    await c.call(pageAddItem, "C2 written offline before removal");
    const cBefore = await c.callStable(pageLocal);
    check(cBefore.pendingOutbox >= 1, "Limited C holds an unsent outbox entry while offline");
    await a.call(pageRemoveMemberButton, "Remove Limited member 1 from household");
    check(service.members.get(cMember.id).active === false && service.members.get(cMember.id).memberStatus === "removed",
      "server marks Limited C removed through the Adult UI control");
    check(Boolean(service.devices.get(cDevice.id).revokedAt), "removal revokes Limited C's device");
    await c.setOffline(false);
    // Coming back online re-checks authorization, and a removed device locks
    // and ends its session (context.js onOnline). That lock races this sync:
    // it can land before the call (the profile is locked) or during it (the
    // coordinator stops without a state). Either way the device is refused.
    result = await c.call(pageSync).catch((error) => {
      if (/Cannot sync a locked profile/.test(error.message)) return { locked: true };
      throw error;
    });
    const cLocked = result.locked === true || await c.call(() => !document.querySelector("kin-app").store);
    check(cLocked || (result.last?.state === "paused" && ["authentication_required", "membership_removed", "device_not_trusted"].includes(result.last.code)),
      "removed Limited C's reconnect sync is refused: " + JSON.stringify({ locked: cLocked, last: result.last ?? null }));
    const cStatus = await c.call(pageFetch, { path: "/api/sync/status" });
    check([401, 403].includes(cStatus.status), `removed Limited C's stale session cannot read sync status (${cStatus.status})`);
    // An empty event batch: "KSEV", version 1, count 0.
    const cPush = await c.call(pageFetch, { path: "/api/sync/events", method: "POST", bytes: [75, 83, 69, 86, 1, 0, 0, 0] });
    check([401, 403].includes(cPush.status), `removed Limited C's stale session cannot push (${cPush.status})`);
    let cAfter = await c.callStable(pageLocal).catch(() => null);
    if (!cAfter) {
      await c.call(pageUnlock, c.recovery);
      cAfter = await c.callStable(pageLocal);
    }
    check(cAfter.events === cBefore.events && cAfter.pendingOutbox === cBefore.pendingOutbox,
      "removal leaves Limited C's local history and unsent outbox intact");
    result = await a.call(pageSync);
    check(result.items.includes("C1 limited member item") && !result.items.includes("C2 written offline before removal"),
      "Adult A keeps C1 history and never receives C's post-removal offline event");
    check(relayEvents(aRelay).filter((row) => row.envelope.deviceId === cDevice.id).length === 2,
      "relay holds exactly C's two pre-removal envelopes (its device name and C1) from C's device");
    pass(`${checks} member removal during disconnection assertions (profile C)`);
    await retire(c);

    // ---- Profile C2: Temporary member with deterministic expiry -------------
    const c2 = await launch("temporary-c2");
    // Short real expiry: the server clock is advanced for instant enforcement.
    const temporaryExpiry = clock.now() + 20_000;
    const c2Identity = await join({ inviter: a, invitee: c2, kind: "temporary", expiresAt: temporaryExpiry, deviceLabel: "Opera on Linux" });
    household = await c2.callStable(pageHousehold);
    const c2Member = household.members.find((member) => member.current);
    check(c2Member?.kind === "temporary" && c2Member.active && c2Member.expiresAt === temporaryExpiry,
      "Temporary C2 carries the inviter-chosen absolute expiry");
    const aheadClockExport = await a.call(pageExportArchive, { clockOffset: 10 * MINUTE });
    check(aheadClockExport.bytes > 0 && aheadClockExport.membership?.some((member) =>
      member.memberId === c2Identity.memberId && member.status === "active"),
      "export preserves active Temporary status when the browser clock is ahead of the server");
    const c2Denied = await c2.call(pageFetch, { path: "/api/pairings", method: "POST", body: { kind: "adult" } });
    check(c2Denied.status === 403 && c2Denied.body?.error === "adult_required", "Temporary C2 cannot manage trust");
    result = await a.call(pageSync);
    result = await c2.call(pageSync);
    check(result.started && result.last?.state !== "paused", "Temporary C2 syncs while unexpired: " + JSON.stringify(result.last));
    await c2.call(pageAddItem, "T1 temporary member item");
    result = await c2.call(pageSync);
    result = await a.call(pageSync);
    check(result.items.includes("T1 temporary member item"), "Adult A receives Temporary C2's event");
    const c2Local = await c2.callStable(pageLocal);
    result = await b.call(pageSync);
    check(result.last?.state !== "paused", "Adult B holds the current epoch before the expiry race: " + JSON.stringify(result.last));
    const epochBeforeExpiry = syncService.status(
      relaySession(bIdentity.memberId, bIdentity.deviceId),
    ).currentEpoch;
    await a.call(pagePauseAutomaticSync);
    await a.setOffline(true);
    clock.offset += 4 * MINUTE; // Server time passes the expiry; browsers keep real time.
    household = await b.callStable(pageHousehold);
    const expiredView = household.members.find((member) => member.id === c2Identity.memberId);
    check(expiredView && expiredView.active === false, "Adult B's household view shows Temporary C2 ended after expiry");
    check(service.members.get(c2Identity.memberId).memberStatus === "expired", "server records natural expiry, not removal");
    const c2Status = await c2.call(pageFetch, { path: "/api/sync/status" });
    check([401, 403].includes(c2Status.status), `expired Temporary C2 cannot read sync status (${c2Status.status})`);
    result = await c2.call(pageSync).catch(() => ({ last: { state: "paused", code: "locked" } }));
    check(result.last?.state === "paused", "expired Temporary C2's sync pauses: " + JSON.stringify(result.last));
    let c2After = await c2.callStable(pageLocal).catch(() => null);
    if (!c2After) {
      await c2.call(pageUnlock, c2.recovery);
      c2After = await c2.callStable(pageLocal);
    }
    check(c2After.events === c2Local.events, "expiry leaves Temporary C2's local history intact");
    result = await b.call(pageSync);
    check(result.last?.state !== "paused", "Adult B commits the expiry rotation while Adult A is offline: " + JSON.stringify(result.last));
    const committedEpoch = syncService.status(
      relaySession(bIdentity.memberId, bIdentity.deviceId),
    ).currentEpoch;
    check(committedEpoch === epochBeforeExpiry + 1, "Adult B commits exactly the epoch reserved by Temporary expiry");
    const waitingForA = [...syncService.state(aBoot.identity.householdId).grants.values()]
      .find((grant) => grant.recipientDeviceId === aBoot.identity.deviceId && grant.keyEpoch === committedEpoch);
    check(waitingForA?.committedRotation === true, "the committed epoch package remains queued for offline Adult A");
    pass(`${checks} Temporary expiry and committed-rotation race assertions (profiles A, B, C2)`);
    await retire(c2);

    // ---- Revoke the rotation sender before A receives its package ----------
    await b.setOffline(true);
    await b.call(pageAddItem, "B1 written offline before revocation");
    const bBefore = await b.callStable(pageLocal);
    const bRelayBefore = relayEvents(aRelay).filter((row) => row.envelope.deviceId === bIdentity.deviceId).length;
    check(bRelayBefore === 1, "before revocation the relay holds only B's device name from B's device");
    check(bBefore.pendingOutbox >= 1, "Adult B holds an unsent outbox entry while offline");
    await a.setOffline(false);
    await a.call(pageRevokeDeviceButton, "Edge on Windows");
    check(Boolean(service.devices.get(bIdentity.deviceId).revokedAt), "Adult A revokes B's device with a fresh passkey through the UI");
    check(service.members.get(bIdentity.memberId).active === true, "device revocation keeps B's membership (device ≠ member)");
    check(syncService.state(aBoot.identity.householdId).grants.has(waitingForA.grantId),
      "revoking the rotation sender preserves the package for still-trusted Adult A");
    clock.offset += 7 * MINUTE;
    await a.call(pageResumeAutomaticSync);
    await a.call(pageShiftClock, 11 * MINUTE);
    result = await a.call(pageSync);
    await a.call(pageRestoreClock);
    clock.offset -= 7 * MINUTE;
    check(result.last?.state !== "paused", "Adult A recovers the expired committed package and rotates after revocation: " + JSON.stringify(result.last));
    check(syncService.status(relaySession(aBoot.identity.memberId, aBoot.identity.deviceId)).currentEpoch === committedEpoch + 1,
      "Adult A obtains the committed epoch before completing the required post-revocation rotation");
    await b.setOffline(false);
    const revokedBrand = await b.call(pageWaitForLockedBrand);
    check(revokedBrand.locked && revokedBrand.name === "Kin" && revokedBrand.label === "Kin — Today" &&
      !revokedBrand.genericHidden && revokedBrand.letterHidden && revokedBrand.uploadHidden,
      "revoked B is locked and private branding is cleared immediately on reconnect: " + JSON.stringify(revokedBrand));
    const bPush = await b.call(pageFetch, { path: "/api/sync/events", method: "POST", bytes: [75, 83, 69, 86, 1, 0, 0, 0] });
    check([401, 403].includes(bPush.status), `revoked B cannot push its stale outbox (${bPush.status})`);
    const bLogin = await b.call(pageFetch, { path: "/api/login/options", method: "POST", body: {} });
    check(bLogin.status !== 200, `revoked B's device cookie cannot start a fresh login (${bLogin.status} ${bLogin.body?.error ?? ""})`);
    let bAfter = await b.callStable(pageLocal).catch(() => null);
    if (!bAfter) {
      await b.call(pageUnlock, b.recovery);
      bAfter = await b.callStable(pageLocal);
    }
    check(bAfter.events === bBefore.events && bAfter.pendingOutbox === bBefore.pendingOutbox,
      "revocation leaves B's local history and unsent outbox intact");
    result = await a.call(pageSync);
    check(!result.items.includes("B1 written offline before revocation"), "Adult A never receives B's post-revocation offline event");
    check(relayEvents(aRelay).filter((row) => row.envelope.deviceId === bIdentity.deviceId).length === bRelayBefore,
      "relay holds no envelope B wrote after its revocation");
    pass(`${checks} device revocation during disconnection assertions (profile B)`);
    await retire(b);

    // ---- Export from A ------------------------------------------------------
    while (Date.now() <= temporaryExpiry + 1_000) await delay(250);
    const exported = await a.call(pageExportArchive, { clockOffset: -10 * MINUTE });
    check(exported.bytes > 0 && exported.message.includes("export prepared"), "Adult A exports a household archive through the product control");
    const statuses = Object.fromEntries((exported.membership ?? []).map((member) => [member.memberId, `${member.memberKind}:${member.status}`]));
    check(statuses[aBoot.identity.memberId] === "adult:active" && statuses[bIdentity.memberId] === "adult:active" &&
      statuses[cMember.id] === "limited:removed" && statuses[c2Identity.memberId] === "temporary:expired",
      "archive membership snapshot records active, removed, and expired statuses: " + JSON.stringify(statuses));
    const aLocalAtExport = await a.callStable(pageLocal);
    check(exported.events === aLocalAtExport.events, "archive event count equals Adult A's local history");
    await a.call(pageAddItem, "A3 after export");
    result = await a.call(pageSync);
    const relayTotal = relayEvents(aRelay).length;
    pass(`${checks} export assertions (profile A)`);

    // ---- Profile D: clean browser, restore, then re-authorize ---------------
    const d = await launch("restore-d");
    const restored = await d.call(pageRestoreArchive, {
      base64: exported.base64, secret: a.recovery, clockOffset: 10 * MINUTE,
    });
    check(restored.stagedEvents === 0, "validation stages the archive without touching the empty target");
    check(restored.events === exported.events, `restore imports the exact archive history (${restored.events} events)`);
    check(restored.items.includes("A1 before anyone joins") && restored.items.includes("C1 limited member item") &&
      restored.items.includes("T1 temporary member item") && !restored.items.includes("A3 after export"),
      "restored history includes removed and expired members' events and nothing after the export");
    check(JSON.stringify(restored.membership) === JSON.stringify(exported.membership),
      "restored membership snapshot preserves removed and expired statuses");
    check(restored.identity === null && !restored.syncState && !restored.coordinator,
      "restore grants no identity, sync state, or coordinator");
    const dStatus = await d.call(pageFetch, { path: "/api/sync/status" });
    check(dStatus.status === 401, `restored clean profile has no sync authority (${dStatus.status})`);
    check(restored.message.includes("needs household approval"), "restore notice states that approval is still required");
    // Same-member device pairing is the documented path to re-authorize a restored device.
    const invitation = await a.call(async () => {
      const app = document.querySelector("kin-app");
      await app.household.createDevicePairing();
      const shownCode = app.household.querySelector(".pairing-code")?.textContent;
      const alert = app.household.querySelector('.household-message[role="alert"]');
      if (!app.household.pairing?.code || alert || shownCode !== app.household.pairing.code)
        throw new Error("Device pairing failed: " + (alert?.textContent ?? "the code was not displayed"));
      return { code: shownCode };
    });
    await d.callStable(pageWaitHousehold);
    const { approved: dApproved, approverKey: dApproverKey } =
      await verifyAndApprove({ inviter: a, invitee: d, invitation, deviceLabel: "Safari on Mac" });
    check(dApproved.memberId === aBoot.identity.memberId, "device pairing binds D to Adult A's membership");
    const dActivation = await d.call(pageActivate, { approvingKey: dApproverKey });
    check(dActivation.visuallyGated && dActivation.gateSurvivedBusyCycle,
      "D activation stays disabled through a busy cycle until the approver fingerprint is confirmed");
    const dLoaded = await d.waitForReloadAndUnlock();
    check(dLoaded.identity?.deviceId === dApproved.deviceId, "D holds the approved same-member device identity");
    result = await a.call(pageSync); // rotation + provisioning for D (all epochs for a same-member device)
    check(result.last?.state !== "paused", "Adult A provisions D's device: " + JSON.stringify(result.last));
    result = await d.call(pageSync);
    if (result.last?.state === "paused") result = await d.call(pageSync);
    check(result.last?.state !== "paused", "restored D syncs after approval: " + JSON.stringify(result.last));
    result = await a.call(pageSync); // A receives D's device name (#71).
    const dLocal = await d.callStable(pageLocal);
    const aLocal = await a.callStable(pageLocal);
    check(dLocal.items.includes("A3 after export"), "D catches up with history created after the export");
    check(dLocal.events === aLocal.events && JSON.stringify(dLocal.eventIds) === JSON.stringify(aLocal.eventIds),
      `D and A hold identical event sets without duplication (${dLocal.events} events)`);
    check(relayEvents(aRelay).length === relayTotal + 1,
      "re-authorizing a restored device adds only its device name (#71), no duplicate relay events");
    pass(`${checks} clean-profile restore and re-authorization assertions (profile D)`);

    // ---- Two authorized clients reconnect after concurrent offline edits ------
    await a.setOffline(true);
    await d.setOffline(true);
    await a.call(pageAddItem, "A4 offline concurrent");
    await d.call(pageAddItem, "D1 offline concurrent");
    await a.setOffline(false);
    await d.setOffline(false);
    for (const client of [a, d, a, d]) {
      result = await client.call(pageSync);
      check(result.last?.state !== "paused", `${client.label} reconnect sync completes: ` + JSON.stringify(result.last));
    }
    const aFinal = await a.callStable(pageLocal);
    const dFinal = await d.callStable(pageLocal);
    check(aFinal.items.includes("A4 offline concurrent") && aFinal.items.includes("D1 offline concurrent") &&
      dFinal.items.includes("A4 offline concurrent") && dFinal.items.includes("D1 offline concurrent"),
      "both clients converge on both offline items");
    check(aFinal.events === dFinal.events && JSON.stringify(aFinal.eventIds) === JSON.stringify(dFinal.eventIds),
      `both clients hold identical event sets (${aFinal.events} events)`);
    check(aFinal.pendingOutbox === 0 && dFinal.pendingOutbox === 0, "no outbox entries remain after reconciliation");
    check(aFinal.items.filter((text) => text === "A4 offline concurrent").length === 1 &&
      dFinal.items.filter((text) => text === "D1 offline concurrent").length === 1,
      "repeated syncs do not duplicate items");
    check(relayEvents(aRelay).length === relayTotal + 3, "relay gained exactly the two concurrent events");
    pass(`${checks} two-client reconciliation assertions (profiles A and D)`);
    // ---- Profile E: a computer signed in with A's phone (#100) ------------
    const e = await launch("computer-e");
    const requestsBefore = requests.length;
    const shownSignIn = await e.call(pageStartPhoneSignIn);
    check(shownSignIn.readBack === shownSignIn.value && /^http:\/\/localhost:\d+\/link#r=[a-f0-9]{32}&s=[A-Za-z0-9_-]{43}&f=[A-Za-z0-9_-]{43}&c=[A-Za-z0-9_-]{22}$/.test(shownSignIn.value),
      "the computer shows a QR code that reads back as its fragment sign-in link: " + shownSignIn.value);
    check(shownSignIn.steps && /QR code to sign in on this computer/.test(shownSignIn.label ?? "") && shownSignIn.keys === "pending",
      "the sign-in screen tells the person what to do on the phone, and a new computer offers fresh keys");
    check(/^This code changes in 0[12]:\d\d$/.test(shownSignIn.countdown) && !shownSignIn.countdownLive && shownSignIn.focused,
      "the countdown is visible but not a live region, and focus moves to the screen: " + JSON.stringify(shownSignIn));
    const firstApproval = await a.call(pagePhoneApprove, shownSignIn.value);
    check(/^\d{6}$/.test(firstApproval.code) && !firstApproval.existingDevice, "A's phone approves the new computer with a passkey and gets a 6-digit code");
    check(firstApproval.warning === "Only approve a computer that's in front of you." && firstApproval.deviceName === firstApproval.deviceLabel &&
      firstApproval.asYou && firstApproval.cameraOff && /^The code works for 0[12]:\d\d$/.test(firstApproval.countdown),
      "the phone names the computer, says it signs in as you, warns before approving, and counts the code down: " + JSON.stringify(firstApproval));
    const codeField = await e.call(pageSignInCodeField);
    check(codeField.inputMode === "numeric" && codeField.autocomplete === "one-time-code" && codeField.focused && codeField.qrGone &&
      /approved this computer/.test(codeField.status),
      "the computer notices the approval and asks for the code in a focused numeric field: " + JSON.stringify(codeField));
    await e.call(pageTypeSignInCode, { code: firstApproval.code, navigates: true });
    const eLoaded = await e.waitForReloadAndUnlock();
    const phoneDone = await a.call(pagePhoneApprovalDone);
    check(phoneDone.heading === "The computer is signed in" && phoneDone.closed, "the phone sees the computer finish and closes with Done");
    check(eLoaded.identity?.memberId === aBoot.identity.memberId && eLoaded.identity?.deviceId === firstApproval.deviceId,
      "the computer is signed in as a new device of A's membership");
    const aDevices = await a.call(pageFetch, { path: "/api/devices" });
    check(aDevices.body?.devices?.some((device) => device.id === firstApproval.deviceId && device.label === firstApproval.deviceLabel),
      "A's trusted devices list the computer under its automatic name");
    result = await a.call(pageSync); // provisioning for the computer
    check(result.last?.state !== "paused", "A provisions the computer: " + JSON.stringify(result.last));
    result = await e.call(pageSync);
    if (result.last?.state === "paused") result = await e.call(pageSync);
    const eLocal = await e.callStable(pageLocal);
    check(result.last?.state !== "paused" && eLocal.items.includes("A4 offline concurrent") && eLocal.items.includes("A3 after export"),
      "the computer receives the household's retained history: " + JSON.stringify(result.last));

    // The session ends; the same computer signs back in as the same device.
    await e.call(pageFetch, { path: "/api/logout", method: "POST", body: {} });
    await e.send("Page.reload", {});
    const eSignedOut = await e.waitForReloadAndUnlock();
    check(!eSignedOut.identity, "after signing out, the computer has no session");
    const again = await e.call(pageStartPhoneSignIn);
    check(again.keys === "existing", "a returning computer offers its own device's keys");
    const secondApproval = await a.call(pagePhoneApprove, again.value);
    check(secondApproval.existingDevice && secondApproval.deviceId === firstApproval.deviceId, "A's phone sees the computer as A's existing device");
    await e.call(pageSignInCodeField);
    const back = await e.call(pageTypeSignInCode, { code: secondApproval.code, navigates: false });
    check(back.identity.deviceId === firstApproval.deviceId && back.path === "/", "the computer is signed back in as the same device, without a restart");
    const devicesAfter = await a.call(pageFetch, { path: "/api/devices" });
    check(devicesAfter.body.devices.filter((device) => device.id === firstApproval.deviceId).length === 1 &&
      devicesAfter.body.devices.length === aDevices.body.devices.length, "signing back in adds no device");
    const secrets = [firstApproval.secret, secondApproval.secret, firstApproval.code, secondApproval.code, firstApproval.nonce, secondApproval.nonce];
    check(requests.slice(requestsBefore).every(({ url, referer }) => secrets.every((value) => !url.includes(value) && !referer.includes(value))),
      "no sign-in secret or code ever reaches a request URL or Referer");
    check((await a.call(pagePhoneApprovalDone)).closed, "the phone closes once the returning computer finishes");
    pass(`${checks} phone sign-in assertions (profile E with A's phone)`);
    await retire(e);

    // ---- Devices from the old address (#769) ------------------------------
    // What a move leaves of the computer: its record, marked, with no token.
    const carried = service.devices.get(firstApproval.deviceId);
    service.deviceTokens.delete(carried.tokenHash);
    carried.tokenHash = null;
    carried.carriedOver = true;
    for (const [sessionHash, session] of service.sessions)
      if (session.deviceId === carried.id) service.sessions.delete(sessionHash);
    service.persistHousehold(carried.householdId);
    const removal = await a.call(pageRemoveCarriedOver, carried.id);
    check(removal.rowText.includes("From the old address · can't sign in here") &&
      !removal.rowButtons.some((label) => label === "Verify device" || label === "Replace this device"),
      "People & devices marks the device from the old address, with nothing to verify or replace: " + JSON.stringify(removal));
    check(removal.offered && /^Remove the device from the old address\? It can't sign in here\./.test(removal.asked),
      "the admin is offered one button to remove it, and told what it is first");
    check(removal.revoked && removal.gone && service.devices.get(carried.id).revokedAt &&
      service.events.some((event) => event.type === "device_revoked" && event.deviceId === carried.id && event.reason === "carried_over"),
      "after a fresh passkey the device is revoked and the button goes");
    pass(`${checks} devices-from-the-old-address assertions (profile A)`);
    console.log(`PASS ${checks} live household authority and recovery assertions across independent browser profiles`);
    return checks;
  } catch (error) {
    // Before the browser closes: what each page showed (#328).
    await captureFailure("household authority regression");
    throw error;
  } finally {
    for (const client of [...open]) await client.close().catch((error) => console.warn(error.message));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/household-authority-regression.mjs <browser executable>");
  const reservation = createServer();
  await new Promise((resolveListen) => reservation.listen(0, "127.0.0.1", resolveListen));
  const applicationPort = reservation.address().port;
  await new Promise((resolveClose) => reservation.close(resolveClose));
  const origin = `http://localhost:${applicationPort}`;
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const { server, store, service, syncService, pushService } = createKinServer({
    port: applicationPort,
    host: "127.0.0.1",
    origin,
    store: new DurableStore(":memory:"),
    now: () => clock.now(),
  });
  // Every request URL and Referer the service receives, so the drill can show
  // that an invitation code never travels in either (#97).
  const requests = [];
  server.on("request", (request) => requests.push({ url: request.url ?? "", referer: request.headers.referer ?? "" }));
  await new Promise((resolveListen) => server.listen(applicationPort, "127.0.0.1", resolveListen));
  // Push services are not reachable from the drill: record what would be sent.
  const pushes = [];
  pushService.send = (row) => { pushes.push(row.deviceId); return Promise.resolve({ status: 201 }); };
  // The drill serves http://127.0.0.1, which push services won't take as a
  // VAPID subject; name one as an operator would (KIN_PUSH_SUBJECT).
  pushService.subject = "mailto:drill@example.org";
  try {
    await householdAuthorityDrill({ executable, origin, service, syncService, clock, pushes, requests });
  } finally {
    server.closeAllConnections();
    try {
      await new Promise((resolveClose) => server.close(resolveClose));
    } finally {
      store.close();
    }
  }
  process.exit(0);
}
