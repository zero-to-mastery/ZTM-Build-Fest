// Finishing one account on every device (epic #546) and private exports
// (#493), in a real browser with a virtual authenticator (PRF on) against the
// production Kin server:
//
//   1. a household set up the old way: a backup key for this device, a
//      passkey registered with the household, passkey unlock, sync, an item;
//   2. on the next unlock, Today calmly invites the member to choose a
//      username and password (#574/#575); accepting makes the account and its
//      vault (the PRF passkey is the vault's way in), and this device unlocks
//      with the password too, the backup key still beside it;
//   3. offline, the passkey unlocks with a challenge made on the device
//      (#551/#552/#553);
//   4. a backup code: the per-device backup key is no longer needed (#576);
//   5. a journal entry, then "Save my private things" (#493/#494): the file
//      opens again on this device, and restoring it twice adds nothing;
//   6. the service loses the private stream; a fresh browser signs in with
//      the passkey alone, sees the household, and restoring the file brings
//      the journal back for this member (#495);
//   7. on that passkey-only device: "Start over on this browser" (#592
//      follow-up) clears Kin's data and opens Sign in;
//   8. signed in again: a session alone can't change the vault's wrappers,
//      "Remove this passkey" brings the password back, and a password changed
//      on another device is asked for at the next online unlock.
//
// "A fresh browser" clears this page's cookies and site data rather than
// opening another browser context, so the same virtual authenticator (and
// its passkey) stays attached.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/account-migration-regression.mjs <browser executable>
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

const MEMBER = { username: "lee.moved", password: "kettle lantern meadow", newPassword: "harbor pencil orchard bell", thirdPassword: "copper willow ferry stone",
  item: "Oat milk", journal: "Planted the garlic by the fence." };
const POLL_MS = 100;

async function eventually(check, label, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Account migration regression timed out: ${label}`);
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
  const wait = async (condition, label, ms = 60_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (await condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; step=${security()?.dataset.firstRunStep} phase=${security()?.phase} message=${security()?.message?.textContent} alert=${security()?.alert?.textContent} card=${app()?.onboarding?.textContent?.slice(0, 200)}`);
  };
  const button = (label, root = security()) => [...root.querySelectorAll("button")].find((element) => element.textContent === label);
  const type = (selector, value, root = security()) => {
    const input = root.querySelector(selector);
    if (!input) throw new Error(`No field ${selector}`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const today = () => wait(() => app()?.store && app().household?.identity && !app().firstRun && !app().busy, "Today", 120_000);
  const lock = async () => {
    app().ctx.session.lockHousehold();
    await wait(() => !app().store && security()?.phase === "locked" && !security().busy, "locked");
  };
  const unlockWithPassword = async (password) => {
    await wait(() => security().querySelector("#password-unlock"), "the password field on the lock screen");
    security().querySelector("#password-unlock").value = password;
    security().querySelector(".password-unlock-form").requestSubmit();
  };
  const types = () => security().manifest.wrappers.map((wrapper) => wrapper.type).sort().join();
  return { app, security, wait, button, type, today, lock, unlockWithPassword, types };
}

async function legacyHousehold(member, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.wait(() => h.security()?.heading && !h.app().starting, "first screen");
  const app = h.app();
  // The earlier setup: a backup key for this device first.
  h.security().showSetup();
  const recovery = h.security().querySelector(".recovery-key").textContent;
  h.security().querySelector("#confirm-recovery").checked = true;
  h.security().querySelector("#confirm-recovery").form.requestSubmit();
  await h.wait(() => app.store && !h.security().busy && !app.busy, "unlocked with the backup key");
  await h.wait(() => app.household?.isConnected && app.household.loaded, "the household panel");
  await app.household.register("bootstrap", { deviceLabel: "Old laptop" });
  check(Boolean(app.household.identity), "a household created with a passkey, the old way");
  await h.security().run(() => h.security().addPasskey());
  check(h.types() === "prf,recovery", "passkey unlock is on beside the backup key");
  await app.household.enableSync();
  await h.wait(() => app.syncState?.state === "ready", "sync ready", 60_000);
  app.compose.input.value = member.item;
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  await h.wait(() => !app.busy && app.state.items.some((item) => item.text === member.item), "an item added");
  return { checks: checks.length, recovery, identity: app.household.identity };
}

async function moveToAccount(member, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = h.app();
  // The next unlock: a calm, dismissible invitation on Today.
  await h.lock();
  h.security().querySelector('button.primary-action').click();
  await h.today();
  await h.wait(() => app.onboarding?.dataset.accountOffer === "account-migrate", "the invitation on Today", 60_000);
  const card = app.onboarding;
  check(/username and password/.test(card.textContent) && /other devices/.test(card.textContent), "Today invites the member to choose a username and password");
  check(Boolean(h.button("Not now", card)), "the invitation can be dismissed");
  h.button("Set up", card).click();
  await h.wait(() => h.security().querySelector("#account-migrate-username"), "the account step under Security");
  const form = h.security().querySelector('[data-account-flow="migrate"]');
  check(form.querySelector("#account-migrate-username").autocomplete === "username" &&
    form.querySelector("#account-migrate-password").autocomplete === "new-password", "a username and a new password, as password managers expect");
  h.type("#account-migrate-username", member.username);
  h.type("#account-migrate-password", member.password);
  h.type("#account-migrate-password-again", "something else entirely");
  form.requestSubmit();
  await h.wait(() => /don't match/.test(h.security().alert.textContent), "a mismatch named");
  check(true, "two different passwords are caught before anything is sent");
  h.type("#account-migrate-password", member.password);
  h.type("#account-migrate-password-again", member.password);
  h.security().querySelector('[data-account-flow="migrate"]').requestSubmit();
  await h.wait(() => /Your account is ready/.test(h.security().message.textContent), "the account made", 120_000);
  check(/passkey/.test(h.security().message.textContent), "the passkey signs in on another device");
  check(h.types() === "password,prf,recovery", "this device unlocks with the password too; the backup key and passkey stay");
  await h.wait(() => h.security().querySelector('[data-account-section="passkey"]'), "the account's settings");
  check(!h.security().querySelector('[data-account-section="migrate"]'), "the invitation is gone once the account exists");
  await h.wait(() => app.onboarding?.dataset.accountOffer !== "account-migrate", "the card is gone");
  check(true, "Today's card is gone");
  // The password unlocks this device; the backup key is one tap away.
  await h.lock();
  check(Boolean(h.security().querySelector("#password-unlock")) && Boolean(h.button("Use backup key")), "the lock screen asks for the password, with the backup key one tap away");
  await h.unlockWithPassword(member.password);
  await h.today();
  check(true, "the new password unlocks this device");
  return checks.length;
}

async function offlinePasskeyLockScreen(h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.lock();
  check(navigator.onLine === false, "the browser is offline");
  h.security().render();
  check(Boolean(h.security().querySelector("[data-offline-passkey]")) && /still unlocks/.test(h.security().textContent),
    "offline, the lock screen says the passkey still works");
  const requests = performance.getEntriesByType("resource").length;
  h.button("Unlock with passkey").click();
  await h.wait(() => h.app().store && !h.security().busy, "unlocked offline with the passkey", 60_000);
  check(!h.security().alert.textContent, `no error: ${h.security().alert.textContent}`);
  check(performance.getEntriesByType("resource").slice(requests).every((entry) => !entry.name.includes("/api/login/")), "nothing asked the identity service");
  return checks.length;
}

async function backupCodeRetiresTheKey(member, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = h.app();
  // Back online: the next unlock signs this device in again (an offline
  // unlock doesn't), and the household panel loads with it.
  await h.lock();
  await h.unlockWithPassword(member.password);
  await h.today();
  await h.wait(() => app.household?.identity, "the household signed in again");
  app.ctx.navigation.navigate("#household/privacy");
  const before = () => h.security().querySelector("[data-backup-key-retired]");
  await h.wait(async () => { await h.security().account.refresh({ render: false }); return h.security().account.ready(); }, "the account's summary on this device");
  h.security().render();
  check(before()?.dataset.backupKeyRetired === "false" && Boolean(h.button("Replace backup key")), "until there's a backup code, the backup key is the way back");
  check(await h.security().account.start("backup-code"), "Security offers a backup code");
  await h.wait(() => h.security().querySelector("#backup-code-print .backup-code span"), "the code on screen");
  const code = [...h.security().querySelectorAll("#backup-code-print .backup-code span")].map((span) => span.textContent).join("-");
  h.security().querySelector("#backup-code-saved").checked = true;
  h.security().querySelector("#account-password-backup-code").value = member.password;
  h.security().querySelector('[data-account-flow="backup-code"]').requestSubmit();
  await h.wait(() => /backup code is on/.test(h.security().message.textContent), "the code turned on", 60_000);
  await h.wait(() => before()?.dataset.backupKeyRetired === "true", "the backup key section updated");
  check(/no longer need this device's backup key/.test(before().textContent), "with a backup code, the backup key is no longer needed (#576)");
  check(!h.button("Replace backup key"), "and Kin no longer asks for a new one");
  check(h.types().includes("recovery"), "it still unlocks this device");
  return { checks: checks.length, code };
}

async function savePrivateThings(member, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = h.app();
  void app.syncCoordinator?.syncNow();
  await h.wait(() => app.ctx.journal?.journal && ["ready"].includes(app.ctx.journal.status()), "the journal opens", 90_000);
  const { todayCivilDate } = await import("/private/journal-view.js");
  const saved = await app.ctx.journal.save({ date: todayCivilDate(), body: member.journal });
  check(saved.ok, `a journal entry saved: ${saved.message}`);
  await h.wait(() => app.syncCoordinator?.privateLog?.active, "private storage active");
  // The save only starts a sync; wait until the entry has really reached the
  // relay, so the service has it when the next step makes it lose the stream.
  await h.wait(async () => { await app.syncCoordinator.syncNow(); return !(await app.syncCoordinator.privateLog.store.outbox()).length; },
    "the private changes sent to the relay", 60_000);
  app.ctx.navigation.navigate("#household/privacy");
  h.security().render();
  await h.wait(() => h.button("Save my private things"), "Backup and move offers your private things");
  check(/Household exports never include them/.test(h.security().textContent), "Security says household exports never include them");
  const blobs = [];
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => { blobs.push(blob); return createObjectURL.call(URL, blob); };
  try { await h.security().run(() => h.security().privateExport.save()); } finally { URL.createObjectURL = createObjectURL; }
  check(!h.security().alert.textContent && /Saved \d+ private/.test(h.security().message.textContent), `saved: ${h.security().alert.textContent}`);
  check(/backup code/.test(h.security().message.textContent), "it says the backup code opens it");
  const bytes = new Uint8Array(await blobs.at(-1).arrayBuffer());
  const { describePrivateArchive } = await import("/private/private-export.js");
  const described = describePrivateArchive(bytes);
  check(described.eventCount >= 1 && described.backupCode && described.memberId === app.household.identity.memberId, "the file is this member's, with the backup code's way in");
  // Restoring on the same device adds nothing.
  await h.security().run(() => h.security().privateExport.restore(new File([bytes], "mine.kinp")));
  check(/already here/.test(h.security().message.textContent), `restoring again duplicates nothing: ${h.security().alert.textContent}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { checks: checks.length, file: btoa(binary) };
}

async function passkeySignInAndRestore(member, file, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.wait(() => h.security()?.heading && !h.app().starting, "first screen");
  check((await (await fetch("/api/status")).json()).identity === null, "a fresh browser: no session, no device");
  h.button("Sign in").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-credentials", "the sign-in screen");
  h.type('input[name="username"]', member.username);
  h.button("Sign in with a passkey").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-device", "Which device is this?", 120_000);
  h.security().querySelector("form").requestSubmit();
  await h.today();
  const app = h.app();
  check(h.types() === "prf" && h.security().manifest.accountRecovery === "backup-code", "the moved account's passkey alone sets up a new device");
  await h.wait(() => app.state?.items.some((item) => item.text === member.item), "the household's item arrives", 120_000);
  check(true, "the household set up the old way is here");
  void app.syncCoordinator?.syncNow();
  await h.wait(() => app.ctx.journal?.journal && app.ctx.journal.status() === "ready", "the journal opens", 90_000);
  check(!app.ctx.journal.entries().some((entry) => entry.body === member.journal), "the service lost the private stream: the journal is empty here");
  const bytes = Uint8Array.from(atob(file), (character) => character.charCodeAt(0));
  app.ctx.navigation.navigate("#household/privacy");
  h.security().render();
  await h.wait(() => h.button("Restore my private things"), "Restore my private things");
  h.button("Restore my private things").click();
  check(h.security().querySelector("#private-export-file")?.accept === ".kinp", "the restore form takes the private file");
  await h.security().run(() => h.security().privateExport.restore(new File([bytes], "mine.kinp")));
  check(/Restored \d+ private/.test(h.security().message.textContent), `restored: ${h.security().alert.textContent}`);
  await h.wait(() => app.ctx.journal.entries().some((entry) => entry.body === member.journal), "the journal entry is back");
  check(true, "the journal entry is back, for this member");
  await h.security().run(() => h.security().privateExport.restore(new File([bytes], "mine.kinp")));
  check(/already here/.test(h.security().message.textContent), "a second restore adds nothing");
  return checks.length;
}

/** Locks, then "Start over on this browser" on the passkey-only lock screen.
 * Resolves before the page reloads. */
async function startOver(h) {
  await h.lock();
  const help = [...h.security().querySelectorAll("details summary")].find((summary) => summary.textContent === "Can't use your passkey?");
  if (!help) throw new Error("No help for a passkey that fails");
  const button = h.button("Start over on this browser");
  if (!button || button.getAttribute("aria-describedby") !== "start-over-help") throw new Error("Start over isn't offered with its explanation");
  globalThis.confirm = (message) => {
    if (!/removes everything it keeps in this browser/.test(message)) throw new Error(`Unclear warning: ${message}`);
    return true;
  };
  // Marks this page, so the suite waits for the one that loads after it.
  globalThis.kinBeforeStartOver = true;
  setTimeout(() => button.click(), 0);
  return true;
}

async function afterStartOver(h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await h.wait(() => h.security()?.dataset.firstRunStep === "sign-in-credentials", "Sign in, straight after starting over", 60_000);
  check(true, "after starting over, Kin opens Sign in");
  const names = (await indexedDB.databases()).map((entry) => entry.name);
  check(!names.some((name) => /^kin-(private|chat|board)-/.test(name ?? "")) && h.security().manifest === null, `this browser's Kin data is gone: ${names.join()}`);
  check((await (await fetch("/api/status")).json()).identity === null, "and its session");
  return checks.length;
}

async function signInAgainAndHarden(member, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = h.app();
  h.type('input[name="username"]', member.username);
  h.button("Sign in with a passkey").click();
  await h.wait(() => h.security().dataset.firstRunStep === "sign-in-device", "Which device is this?", 120_000);
  h.security().querySelector("form").requestSubmit();
  await h.today();
  // A session alone can't change how the vault opens.
  const security = await (await fetch("/api/account/security")).json();
  const [anyWrapper] = security.vault.wrappers;
  const bare = await fetch(`/api/account/vault/wrappers/${anyWrapper.wrapperId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(bare.status === 401 && (await bare.json()).error === "fresh_auth_required", "removing a vault wrapper needs the password or a fresh passkey");
  // Remove this passkey: the last one, so the password comes back.
  app.ctx.navigation.navigate("#household/privacy");
  await h.wait(async () => { await h.security().account.refresh({ render: false }); return h.security().account.ready(); }, "the account's summary on this device");
  h.security().render();
  const credentialId = security.passkeys[0];
  await h.wait(() => h.security().querySelector(`[data-remove-passkey="${credentialId}"]`), "Remove this passkey");
  check(h.security().querySelector(`[data-remove-passkey="${credentialId}"]`).textContent === "Remove this passkey", "each passkey can be removed");
  h.security().querySelector(`[data-remove-passkey="${credentialId}"]`).click();
  await h.wait(() => h.security().querySelector("#account-password-remove-passkey"), "it asks for the password");
  check(/password signs you in on a new device again/.test(h.security().querySelector('[data-account-flow="remove-passkey"]').textContent), "it says what removing the last passkey means");
  check(/your password unlocks it from then on/.test(h.security().querySelector('[data-account-flow="remove-passkey"]').textContent),
    "it says this device's unlock moves to the password, and that Kin locks");
  h.security().querySelector("#account-password-remove-passkey").value = member.password;
  h.security().querySelector('[data-account-flow="remove-passkey"]').requestSubmit();
  // Taking an unlock path away locks Kin, as removing any unlock path does.
  await h.wait(() => !app.store && h.security().phase === "locked" && !h.security().busy, "locked after the passkey went", 60_000);
  await h.wait(() => h.security().querySelector("#password-unlock") && !h.button("Unlock with passkey"), "the lock screen without the passkey", 10_000);
  check(true, "the lock screen asks for the password; the passkey is gone");
  await h.unlockWithPassword(member.password);
  await h.today();
  check(h.types() === "password", "this passkey-only device now unlocks with the password");
  return { checks: checks.length, credentialId };
}

async function newPasswordAtUnlock(member, h) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  // What another of the member's devices does to change the password: the
  // service's verifier and the vault's password wrappers, nothing here.
  // (Defined in here: each step runs in the page on its own.)
  const changePasswordElsewhere = async (oldPassword, newPassword) => {
  const app = h.app();
  const { derivePasswordKeys, newPasswordSalt } = await import("/security/account-vault.js");
  const { passwordChangeWrappers, wrapperChangeBody } = await import("/security/account-wrappers.js");
  const { fromBase64Url, toBase64Url } = await import("/security/local-vault.js");
  const security = await (await fetch("/api/account/security")).json();
  const current = await derivePasswordKeys(oldPassword, fromBase64Url(security.passwordParameters.salt), { iterations: security.passwordParameters.iterations });
  const salt = newPasswordSalt();
  const fresh = await derivePasswordKeys(newPassword, salt);
  const identity = app.household.identity;
  const vaultKey = await app.household.syncKeyStore.accountVaultKey(identity.householdId);
  const change = await passwordChangeWrappers({ vaultKey, householdId: identity.householdId, memberId: identity.memberId, wrappers: security.vault.wrappers,
    passwordKey: fresh.passwordKey, password: { salt, iterations: 600_000 } });
  const response = await fetch("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    currentAuthKey: toBase64Url(current.authKey), salt: toBase64Url(salt), iterations: 600_000, authKey: toBase64Url(fresh.authKey), vaultChange: wrapperChangeBody(change) }) });
  if (!response.ok) throw new Error(`The password change failed: ${response.status}`);
  return toBase64Url(salt);
  };
  const salt = await changePasswordElsewhere(member.password, member.newPassword);
  await h.lock();
  // The previous password opens this device's storage, but online Kin asks for the new one first.
  await h.unlockWithPassword(member.password);
  await h.wait(() => h.security().querySelector('[data-password-change="new"]'), "asked for the new password", 60_000);
  check(!h.app().store && /changed on another device/.test(h.security().textContent), "the household stays closed until the new password is given");
  h.security().querySelector("#password-new-unlock").value = "not the new one at all";
  h.security().querySelector('[data-password-change="new"]').requestSubmit();
  await h.wait(() => /isn't your new password/.test(h.security().alert.textContent), "a wrong new password refused");
  check(true, "a wrong new password is refused");
  h.security().querySelector("#password-new-unlock").value = member.newPassword;
  h.security().querySelector('[data-password-change="new"]').requestSubmit();
  await h.today();
  await h.wait(() => h.security().manifest.wrappers.find((wrapper) => wrapper.type === "password")?.salt === salt, "the wrapper follows the new password");
  check(true, "this device switched to the new password");
  // Changed again elsewhere; this time the new password is typed first.
  const third = await changePasswordElsewhere(member.newPassword, member.thirdPassword, h);
  await h.lock();
  await h.unlockWithPassword(member.thirdPassword);
  await h.wait(() => /That's your new password/.test(h.security().message.textContent), "the new password recognised", 60_000);
  check(h.security().querySelector('label[for="password-unlock"]').textContent === "Previous password", "Kin asks for the previous password once");
  await h.unlockWithPassword(member.newPassword);
  await h.today();
  await h.wait(() => h.security().manifest.wrappers.find((wrapper) => wrapper.type === "password")?.salt === third, "switched again");
  await h.lock();
  await h.unlockWithPassword(member.thirdPassword);
  await h.today();
  check(true, "from then on the new password unlocks this device directly");
  return checks.length;
}

// ---- The suite -------------------------------------------------------------------

export async function accountMigrationRegressions({ endpoint, browserClient }) {
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
    const fresh = async (whileAway = () => {}) => {
      kin.accountVaultService.memberDownloads.spends.clear();
      kin.accountVaultService.addressDownloads.spends.clear();
      await client.send("Page.navigate", { url: "about:blank" });
      await eventually(async () => (await client.evaluate("location.href")) === "about:blank", "about:blank");
      await whileAway();
      await client.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
      await client.send("Network.clearBrowserCookies");
      await open();
    };
    const offline = (on) => client.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const run = (step, ...args) => client.evaluate(`(${step.toString()})(${args.map((value) => JSON.stringify(value)).join(", ")}${args.length ? ", " : ""}(${helpers.toString()})())`);

    await open();
    let checks = 0;
    // 1. The old way.
    const legacy = await run(legacyHousehold, MEMBER);
    checks += legacy.checks;
    const { identity } = legacy;
    const member = kin.service.members.get(identity.memberId);
    assert.equal(member.username, undefined, "no username yet");
    assert.equal(member.password, undefined);
    assert.equal(member.credentials.size, 1);
    checks += 3;

    // 2. The move.
    checks += await run(moveToAccount, MEMBER);
    const auth = { household: { id: identity.householdId }, member: { id: identity.memberId } };
    const types = () => (kin.accountVaultService.summary(auth) ?? []).map((wrapper) => wrapper.type).sort().join();
    assert.equal(member.username, MEMBER.username);
    assert.ok(member.password?.verifier);
    assert.equal(types(), "passkey", "the PRF passkey opens the vault; no password-only wrapper exists");
    await eventually(() => kin.service.certificationEndorsement(identity.memberId), "the certification key endorsed");
    checks += 4;

    // 3. Offline passkey unlock.
    await offline(true);
    try { checks += await run(offlinePasskeyLockScreen); } finally { await offline(false); }

    // 4. A backup code retires the per-device key.
    const made = await run(backupCodeRetiresTheKey, MEMBER);
    checks += made.checks;
    assert.equal(types(), "backup-code,passkey");

    // 5. Private things saved.
    const saved = await run(savePrivateThings, MEMBER);
    checks += saved.checks;

    // 6. The service loses the private stream; a fresh browser restores.
    // Purged only once the old page has left the origin: a push from it
    // after the purge would start the "lost" stream again at sequence 1.
    await fresh(() => kin.privateRelayService.forgetMember(identity.memberId));
    checks += await run(passkeySignInAndRestore, MEMBER, saved.file);

    // 7. Start over on this (passkey-only) browser.
    await run(startOver);
    await eventually(async () => {
      try {
        return await client.evaluate("!globalThis.kinBeforeStartOver && document.readyState === 'complete' && Boolean(document.querySelector('kin-app')?.security?.heading)");
      } catch { return false; }
    }, "the page after starting over", 60_000);
    checks += await run(afterStartOver);

    // 8. Signed in again: the hardening follow-ups.
    kin.accountVaultService.memberDownloads.spends.clear();
    kin.accountVaultService.addressDownloads.spends.clear();
    const hardened = await run(signInAgainAndHarden, MEMBER);
    checks += hardened.checks;
    assert.equal(member.credentials.size, 0, "the passkey is gone from the account");
    assert.equal(types(), "backup-code,password", "the last passkey's going brought the password wrapper back");
    checks += 2;
    checks += await run(newPasswordAtUnlock, MEMBER);
    return `PASS ${checks} account-migration checks; an old-style household moved to an account and signed in on a fresh browser, offline passkey unlock, private things saved and restored, start over, remove passkey and a password changed elsewhere`;
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
  assert.ok(executable, "Usage: node scripts/account-migration-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-account-migration-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await accountMigrationRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("account migration regression");
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
