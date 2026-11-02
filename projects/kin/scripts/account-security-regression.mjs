// A password account's passkey and backup code (#560-#562, #571-#573), in a
// real browser with a virtual authenticator (PRF on) against the production
// Kin server:
//
//   1. a founder signs up with a password and adds an item; Today's calm card
//      offers a passkey; adding it (after the password) replaces the vault's
//      password-only wrapper and adds passkey unlock on this device;
//   2. Security makes a backup code (print view, then turned on with the
//      password), and the password member's device exports: the export opens
//      with the backup code;
//   3. with fresh storage (another device), the passkey alone signs in and
//      sets the device up with no per-device backup key;
//   4. there, "Require password and passkey" is turned on; with fresh storage
//      the passkey alone is refused and password-then-passkey signs in;
//   5. with fresh storage, the backup code signs in and forces a new password.
//
// "Fresh storage" clears this page's cookies and site data rather than
// opening another browser context, so the same virtual authenticator (and
// its passkey) stays attached. Storage is cleared only once the account vault
// holds the household's current key, as a device left running would see to.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/account-security-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, captureFailure, waitForOrigin } from "./cdp-page.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

const FOUNDER = { name: "Robin", household: "The Lees", username: "lee.passkey", password: "kettle lantern meadow", item: "Oat milk", newPassword: "harbor pencil orchard bell" };
const POLL_MS = 100;

async function eventually(check, label, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Account security regression timed out: ${label}`);
    await delay(POLL_MS);
  }
}

async function pageClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const number = ++id;
    const timer = setTimeout(() => fail(new Error(`CDP timeout: ${method}`)), 240_000);
    pending.set(number, { resolve: (value) => { clearTimeout(timer); done(value); }, reject: (error) => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id: number, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 2000));
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

// ---- In-page steps (stringified and run in the browser) ---------------------

/** What every step needs, made inside the page. */
function helpers() {
  const app = () => document.querySelector("kin-app");
  const security = () => app()?.security;
  // `detail`, if given, adds what that wait needs to say why it timed out.
  const wait = async (condition, label, ms = 60_000, detail = () => "") => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; ${detail()}step=${security()?.dataset.firstRunStep} message=${security()?.message?.textContent} alert=${security()?.alert?.textContent} card=${app()?.onboarding?.textContent?.slice(0, 200)}`);
  };
  const button = (label, root = security()) => [...root.querySelectorAll("button")].find((element) => element.textContent === label);
  const type = (selector, value, root = security()) => {
    const input = root.querySelector(selector);
    if (!input) throw new Error(`No field ${selector}`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const today = () => wait(() => app()?.store && app().household?.identity && !app().firstRun && !app().busy, "Today", 120_000);
  // Once (#469) a new device's items never arrived and the log couldn't say
  // whether sync never ran, was refused or was paused: this says which.
  const syncDetail = () => {
    const coordinator = app()?.syncCoordinator;
    return `sync=${JSON.stringify({ state: app()?.syncState?.state ?? null, code: app()?.syncState?.code ?? null, message: app()?.syncState?.message?.slice(0, 120) ?? null,
      coordinator: Boolean(coordinator), running: Boolean(coordinator?.running), lastSyncOk: coordinator?.lastSyncOk ?? null,
      sinceLastSync: coordinator?.lastSyncEndedAt ? Date.now() - coordinator.lastSyncEndedAt : null, items: app()?.state?.items?.length ?? null })} `;
  };
  return { app, security, wait, button, type, today, syncDetail };
}

async function createHousehold(founder, h) {
  await h.wait(() => h.security()?.heading && !h.app().starting, "first screen");
  const app = h.app();
  h.button("Start a new household").click();
  h.type('input[name="name"]', founder.name);
  h.type('input[name="household"]', founder.household);
  h.security().querySelector("form").requestSubmit();
  await h.wait(() => h.security().dataset.firstRunStep === "account", "the account screen");
  h.type('input[name="username"]', founder.username);
  h.type('input[name="password"]', founder.password);
  h.security().querySelector("form").requestSubmit();
  await h.today();
  await h.wait(() => app.syncState?.state === "ready", "sync ready", 60_000);
  app.compose.input.value = founder.item;
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  await h.wait(() => !app.busy && app.state.items.some((item) => item.text === founder.item), "an item added");
  return app.household.identity;
}

async function addPasskeyFromToday(founder, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = h.app();
  // The first useful action is done: Today offers the passkey, calmly.
  await h.wait(() => app.onboarding?.dataset.accountOffer === "account-passkey", "the passkey card on Today", 60_000);
  const card = app.onboarding;
  check(!card.hidden && /passkey/i.test(card.textContent), "Today offers a passkey after the first useful action");
  check(Boolean(h.button("Not now", card)), "the card can be dismissed");
  h.button("Add a passkey", card).click();
  await h.wait(() => h.security().querySelector("#account-password-add-passkey"), "the add-passkey step under Security");
  const field = h.security().querySelector("#account-password-add-passkey");
  check(field.autocomplete === "current-password" && field.labels?.[0]?.textContent === "Your password", "it asks for the current password, labelled");
  field.value = founder.password;
  h.security().querySelector('[data-account-flow="add-passkey"]').requestSubmit();
  await h.wait(() => /Passkey added/.test(h.security().message.textContent), "the passkey added", 120_000);
  const types = h.security().manifest.wrappers.map((wrapper) => wrapper.type).sort();
  check(types.join() === "password,prf", "this device unlocks with the passkey now, and still with the password");
  await h.wait(() => app.onboarding.dataset.accountOffer !== "account-passkey", "the card is gone once the passkey is added");
  check(h.security().querySelector('[data-account-section="passkey"] .security-status').textContent.startsWith("On"), "Security says the passkey is on");
  check(/backup code/.test(h.security().querySelector('[data-account-section="passkey"]').textContent), "and what losing it means: the backup code");
  return checks.length;
}

async function makeBackupCode(founder, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  check(await h.security().account.start("backup-code"), "Security offers a backup code");
  await h.wait(() => h.security().querySelector("#backup-code-print .backup-code span"), "the code on screen");
  const code = [...h.security().querySelectorAll("#backup-code-print .backup-code span")].map((span) => span.textContent).join("-");
  check(/^([0-9A-HJKMNP-TV-Z]{7}-){7}[0-9A-HJKMNP-TV-Z]{7}$/.test(code), "8 groups of 7 unambiguous characters");
  // The print view: only the code card prints.
  const printed = [];
  const print = window.print;
  window.print = () => printed.push(document.documentElement.classList.contains("printing-backup-code"));
  try { h.button("Print").click(); } finally { window.print = print; }
  check(printed[0] === true, "Print shows the code card on its own");
  const form = h.security().querySelector('[data-account-flow="backup-code"]');
  form.querySelector("#account-password-backup-code").value = founder.password;
  form.requestSubmit();
  await h.wait(() => /Print or save the code first/.test(h.security().alert.textContent), "turning it on waits for the saved box");
  check(true, "the code isn't turned on until the person says it's saved");
  h.security().querySelector("#backup-code-saved").checked = true;
  h.security().querySelector("#account-password-backup-code").value = founder.password;
  h.security().querySelector('[data-account-flow="backup-code"]').requestSubmit();
  await h.wait(() => /backup code is on/.test(h.security().message.textContent), "the code turned on", 60_000);
  check(!h.security().querySelector("#backup-code-print"), "the code leaves the screen");
  return { checks: checks.length, code };
}

/** Exports on this password-member device and opens the export with the code. */
async function exportWithCode(code, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = h.app();
  const blobs = [];
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => { blobs.push(blob); return createObjectURL.call(URL, blob); };
  try { await h.security().run(() => h.security().downloadArchive()); } finally { URL.createObjectURL = createObjectURL; }
  check(!h.security().alert.textContent && /opens with your account backup code/.test(h.security().message.textContent),
    `a device set up with a password exports, sealed for the backup code: ${h.security().alert.textContent}`);
  const bytes = new Uint8Array(await blobs[0].arrayBuffer());
  const archive = await import("/security/archive.js");
  const { getActiveVault } = await import("/security/local-vault.js");
  const described = await archive.describeHouseholdArchive(bytes, app.engine);
  check(described.backupCode && described.labels.length === 0, "the export names the backup code, and no device key");
  const staged = await archive.validateHouseholdArchive({ bytes, recoverySecret: code.toLowerCase(), engine: app.engine, vault: getActiveVault() });
  check(staged.eventCount > 0, "the backup code opens the export");
  archive.discardValidatedHouseholdArchive(staged.stage);
  return checks.length;
}

async function passkeySignInHere(founder, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.wait(() => h.security()?.heading && !h.app().starting, "first screen");
  const status = await (await fetch("/api/status")).json();
  check(status.identity === null, "fresh storage: no session, no device");
  h.button("Sign in").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-credentials", "the sign-in screen");
  h.button("Sign in with a passkey").click();
  await h.wait(() => h.security().querySelector("#sign-in-username-error"), "a passkey needs the username first");
  check(true, "the passkey button asks for the username first");
  h.type('input[name="username"]', founder.username);
  h.button("Sign in with a passkey").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-device", "Which device is this?", 120_000);
  h.security().querySelector("form").requestSubmit();
  await h.today();
  const manifest = h.security().manifest;
  check(manifest.wrappers.map((wrapper) => wrapper.type).join() === "prf" && manifest.accountRecovery === "backup-code",
    "the passkey alone set this device up, with no backup key for it (the account has a backup code)");
  await h.wait(() => h.app().state?.items.some((item) => item.text === founder.item), "the household's item arrives", 120_000, h.syncDetail);
  check(true, "the household's items are here");
  return checks.length;
}

async function requireBothHere(founder, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.security().account.refresh({ render: false });
  h.security().render();
  const box = h.security().querySelector("#require-password-and-passkey");
  check(box && !box.checked && box.labels?.[0]?.textContent === "Require password and passkey", "Require password and passkey is a setting, off by default");
  box.click();
  await h.wait(() => h.security().querySelector("#account-password-require-both"), "it asks for the password");
  h.security().querySelector("#account-password-require-both").value = founder.password;
  h.security().querySelector('[data-account-flow="require-both"]').requestSubmit();
  await h.wait(() => /asks for your password and your passkey/.test(h.security().message.textContent), "require-both on", 120_000);
  check(h.security().querySelector("#require-password-and-passkey").checked, "the setting shows on");
  return checks.length;
}

async function passwordThenPasskeyHere(founder, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.wait(() => h.security()?.heading && !h.app().starting, "first screen");
  h.button("Sign in").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-credentials", "the sign-in screen");
  h.type('input[name="username"]', founder.username);
  h.type('input[name="password"]', founder.password);
  h.security().querySelector("form").requestSubmit();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-passkey", "the passkey step after the password", 120_000);
  check(/password and your passkey/.test(h.security().textContent), "the account asks for both");
  h.button("Use my passkey").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-device", "Which device is this?", 120_000);
  h.security().querySelector("form").requestSubmit();
  await h.today();
  check(h.security().manifest.wrappers.map((wrapper) => wrapper.type).join() === "password", "this device unlocks with the password");
  return checks.length;
}

async function backupCodeSignInHere(founder, code, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.wait(() => h.security()?.heading && !h.app().starting, "first screen");
  h.button("Sign in").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-credentials", "the sign-in screen");
  h.button("Use my backup code").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-backup-code", "the backup-code screen");
  h.type('input[name="username"]', founder.username);
  // A typo is caught on the device, calmly, before anything is sent.
  const typo = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
  h.type('input[name="code"]', typo);
  h.security().querySelector("form").requestSubmit();
  await h.wait(() => /typo/.test(h.security().alert.textContent), "a typo is named");
  check(h.security().dataset.firstRunStep === "sign-in-backup-code", "a typo keeps the form");
  h.type('input[name="code"]', code.replaceAll("-", " ").toLowerCase());
  h.security().querySelector("form").requestSubmit();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-device", "Which device is this?", 120_000);
  h.security().querySelector("form").requestSubmit();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-new-password", "a new password is required", 60_000);
  check(h.security().querySelector('input[name="newPassword"]').autocomplete === "new-password", "the new password field is one password managers save");
  h.type('input[name="newPassword"]', founder.newPassword);
  h.type('input[name="newPasswordAgain"]', founder.newPassword);
  h.security().querySelector("form").requestSubmit();
  await h.today();
  const wrapper = h.security().manifest.wrappers.find((entry) => entry.type === "password");
  check(wrapper && h.security().manifest.wrappers.length === 1, "this device unlocks with the new password");
  await h.wait(() => h.app().state?.items.some((item) => item.text === founder.item), "the household's item arrives", 120_000, h.syncDetail);
  check(true, "the household's items are here");
  return checks.length;
}

/** Whether the member's vault as the service stores it (`version`, and
 * `ciphertext` in base64url) holds household epoch `epoch`, opened with
 * this device's vault key. */
async function vaultHoldsEpoch({ version, ciphertext, epoch }, h) {
  const { openVault, wipeVaultContents } = await import("/security/account-vault.js");
  const { fromBase64Url } = await import("/security/local-vault.js");
  const { householdId, memberId } = h.app().household.identity;
  const vaultKey = await h.app().household.syncKeyStore.accountVaultKey(householdId);
  if (!vaultKey) return false;
  let contents = null;
  try {
    contents = await openVault(vaultKey, fromBase64Url(ciphertext), { householdId, memberId, version });
    return contents.epochs.some((entry) => entry.family === "household" && entry.epoch === epoch);
  } finally {
    vaultKey.fill(0);
    wipeVaultContents(contents);
  }
}

// ---- The suite -------------------------------------------------------------------

export async function accountSecurityRegressions({ endpoint, browserClient }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  const { browserContextId } = await browserClient.send("Target.createBrowserContext", { disposeOnDetach: true });
  let client;
  let authenticatorId;
  try {
    const { targetId } = await browserClient.send("Target.createTarget", { url: "about:blank", browserContextId });
    const target = await eventually(async () => (await (await fetch(`${endpoint}/json/list`)).json()).find((entry) => entry.id === targetId), "the page target", 10_000);
    client = await pageClient(target.webSocketDebuggerUrl);
    await applyRegressionDefaults(client.send);
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("WebAuthn.enable", { enableUI: false });
    ({ authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
    } }));
    const open = async () => {
      await client.send("Page.navigate", { url: origin });
      await waitForOrigin(client.evaluate, origin, { navigate: () => client.send("Page.navigate", { url: origin }) });
    };
    // Another device: the same page with no cookies and no site data.
    const fresh = async () => {
      // A device that just signed in commits the key rotation its own
      // sign-in started, and is then the only device holding the new key
      // until its vault keeper adds it to the account vault a moment later.
      // Wiping it before then leaves the next device's vault a key behind,
      // and that device's sync pauses for a household key (#791). Losing
      // every device in that moment is the test's doing, not a person's:
      // wait for the rotation and the vault first.
      await eventually(async () => {
        const sync = kin.syncService.state(identity.householdId);
        const vault = store.accountVault(identity.householdId, identity.memberId);
        return !sync.rotationPending && vault && run(vaultHoldsEpoch, { version: vault.version,
          ciphertext: Buffer.from(vault.ciphertext).toString("base64url"), epoch: sync.currentEpoch });
      }, "the account vault holds the household's current key");
      // Four devices of one member in a few minutes spend the vault
      // download limits (per member and per address in 15 minutes);
      // in real use they'd be hours apart, so each new device starts a
      // fresh window here. The limits themselves are tested on the service.
      kin.accountVaultService.memberDownloads.spends.clear();
      kin.accountVaultService.addressDownloads.spends.clear();
      await client.send("Page.navigate", { url: "about:blank" });
      await eventually(async () => (await client.evaluate("location.href")) === "about:blank", "about:blank");
      await client.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
      await client.send("Network.clearBrowserCookies");
      await open();
    };
    const run = (step, ...args) => client.evaluate(`(${step.toString()})(${args.map((value) => JSON.stringify(value)).join(", ")}${args.length ? ", " : ""}(${helpers.toString()})())`);

    await open();
    let checks = 0;
    const identity = await run(createHousehold, FOUNDER);
    await eventually(() => kin.service.certificationEndorsement(identity.memberId), "the certification key endorsed");
    await eventually(() => (store.accountVault(identity.householdId, identity.memberId)?.version ?? 0) >= 2, "the vault holds the first key");
    const auth = { household: { id: identity.householdId }, member: { id: identity.memberId } };
    const types = () => kin.accountVaultService.summary(auth).map((wrapper) => wrapper.type).sort().join();
    const member = kin.service.members.get(identity.memberId);
    assert.equal(kin.service.confirmsWithPassword(member), true);

    // 1. A passkey, from Today's card.
    checks += await run(addPasskeyFromToday, FOUNDER);
    assert.equal(types(), "passkey", "the passkey wrapper replaced the password-only one");
    assert.equal(member.credentials.size, 1);
    assert.equal(kin.service.confirmsWithPassword(member), false, "admin actions use the passkey now");
    assert.equal((await client.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length, 1);
    checks += 4;

    // 2. A backup code, and an export from this password-member device.
    const made = await run(makeBackupCode, FOUNDER);
    checks += made.checks;
    assert.equal(types(), "backup-code,passkey");
    checks += await run(exportWithCode, made.code);

    // 3. The passkey alone, on a new device.
    await fresh();
    checks += await run(passkeySignInHere, FOUNDER);
    const devices = () => [...kin.service.devices.values()].filter((device) => device.memberId === identity.memberId && !device.revokedAt).length;
    assert.equal(devices(), 2);
    checks += 1;

    // 4. Require password and passkey: the passkey alone is refused.
    checks += await run(requireBothHere, FOUNDER);
    assert.equal(types(), "backup-code,password-passkey");
    await fresh();
    const credentialId = [...member.credentials][0];
    const aloneOptions = await client.evaluate(`fetch("/api/account/sign-in/passkey/options", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ${JSON.stringify(FOUNDER.username)} }) }).then((response) => response.json())`);
    assert.ok(!aloneOptions.publicKey.allowCredentials.some((entry) => entry.id === credentialId), "the passkey alone is offered nothing real");
    checks += 1;
    checks += await run(passwordThenPasskeyHere, FOUNDER);
    assert.equal(devices(), 3);

    // 5. The backup code: a new device and a new password.
    const before = Buffer.from(member.password.salt).toString("base64url");
    await fresh();
    try {
      checks += await run(backupCodeSignInHere, FOUNDER, made.code);
    } catch (error) {
      // The server's view of this new device, for a sync that never brought
      // the household's item (#469).
      const deviceId = await client.evaluate(`document.querySelector("kin-app")?.household?.identity?.deviceId ?? null`).catch(() => null);
      const device = deviceId ? kin.service.devices.get(deviceId) : null;
      error.message += ` — server: device ${deviceId ? deviceId.slice(0, 8) : "unknown"} ${device ? (device.revokedAt ? "revoked" : "trusted") : "not known"}, ${devices()} active device(s)`;
      throw error;
    }
    assert.notEqual(Buffer.from(member.password.salt).toString("base64url"), before, "the backup code replaced the password");
    assert.equal(types(), "backup-code", "the combined wrapper (it needs the passkey) went with the old password");
    assert.equal(devices(), 4);
    checks += 3;
    return `PASS ${checks} account-security checks; passkey added from Today, passkey-alone and password-plus-passkey sign-in, backup code made, exported and used with a new password`;
  } finally {
    if (authenticatorId) await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
    client?.close();
    await browserClient.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    kin.server.closeAllConnections?.();
    await new Promise((done) => kin.server.close(done));
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/account-security-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-account-security-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await accountSecurityRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("account security regression");
    throw error;
  } finally {
    browserClient?.close();
    browser.kill();
    await delay(POLL_MS * 3);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  process.exit(0);
}
