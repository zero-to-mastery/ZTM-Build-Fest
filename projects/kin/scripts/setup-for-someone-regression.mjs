// Set up Kin for someone (#612–#615, ADR 0021 §4), in a real browser against
// the production Kin server:
// - an admin (Mikey) prepares an invitation for Rose from People & devices,
//   with easy mode on and a note; the invitation shows a QR code, and its
//   one-page setup sheet renders the QR, the link, the code, three steps,
//   who to call and when it ends, and prints on its own;
// - a fresh browser context at 320px opens the link: "Hi Rose — your family
//   set this up for you" already in easy mode, then a password with Show
//   password and a username chosen from her name, then the wait for Mikey
//   in plain words;
// - Mikey compares Rose's code with his screen and approves with his
//   password; Rose's screen asks "Do these match?" against Mikey's code;
// - she lands on Today in easy mode with Help on the page, her name set and
//   easy mode in her synced settings; the invitation is spent.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/setup-for-someone-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { captureFailure, waitForOrigin } from "./cdp-page.mjs";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import { approveWithPassword, createHousehold, isolatedPage, pageClient } from "./first-run-regression.mjs";
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

export const HELPER = { name: "Mikey", household: "The Nicholses", username: "mikey.helper", password: "lantern orchard kettle" };
// How long the browser gets to let go of its profile before it is removed.
const SETTLE_MS = 300;
export const ROSE = { name: "Rose", note: "Call me when you get this and I'll help.", password: "garden teapot sunrise" };

// ---- In-page steps (stringified and run in the browser) ---------------------

export async function prepareForRose(helper, rose) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = document.querySelector("kin-app");
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; household=${app?.household?.textContent?.slice(0, 400)}`);
  };
  const button = (label, root = app.household) => [...root.querySelectorAll("button")].find((element) => element.textContent === label);
  await wait(() => app.household?.identity && app.household.syncStatus?.enabled && !app.household.busy, "the household is ready", 60_000);
  await app.household.loaded;
  app.ctx.navigation.navigate("#household/people");
  await app.household.showDevices();
  const setup = button("Set up Kin for someone");
  check(Boolean(setup), "People & devices offers an admin “Set up Kin for someone”");
  setup.click();
  await wait(() => app.household.querySelector("form.setup-form") && app.household.querySelector('input[name="helper"]')?.value, "the setup form, with the helper's name");
  const form = app.household.querySelector("form.setup-form");
  check(form.querySelector('input[name="easyMode"]').checked, "easy mode is on by default");
  check(form.querySelector('input[name="kind"][value="adult"]').checked, "who they are starts at a grown-up, and is a plain choice");
  check(form.querySelector('input[name="helper"]').value === helper.name, "the admin's own name is filled in as the person to call");
  check(form.querySelector('select[name="days"]').value === "7", "it lasts a week by default, long enough to post");
  const type = (selector, value) => {
    const input = form.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // Without a name, it says so on the field.
  form.requestSubmit();
  await wait(() => app.household.querySelector("form.setup-form .field-error"), "a missing name is said");
  check(app.household.querySelector("#setup-name")?.getAttribute("aria-invalid") === "true", "the name field is marked");
  type('input[name="name"]', rose.name);
  type('textarea[name="note"]', rose.note);
  app.household.querySelector("form.setup-form").requestSubmit();
  await wait(() => app.household.pairing?.prepared && app.household.pairing.state === "Pending" && app.household.querySelector("kin-qr"), "the invitation is ready");
  check(app.household.querySelector(".pairing-path").textContent === `${rose.name}'s invitation is ready`, "it says the invitation for Rose is ready");
  const pairingId = app.household.pairing.pairingId;
  const kept = app.household.prepared.kept.get(pairingId);
  check(/\/pair#code=[2-9A-Z]{4}-[2-9A-Z]{4}&k=[A-Za-z0-9_-]{22}$/.test(kept.link), "the link carries the code and the card's key, only in the fragment");
  check(app.household.querySelector("kin-qr").value === kept.link, "the QR code is that link");
  const status = await (await fetch("/api/account/invitation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: kept.code }) })).json();
  check(status.prepared?.easyMode === true && status.prepared.memberKind === "adult" && !JSON.stringify(status).includes(rose.name),
    "the service tells the code's holder about easy mode, and can't read Rose's name");

  // The setup sheet.
  button("Print the setup sheet").click();
  await wait(() => app.household.querySelector(".setup-sheet .kin-qr-frame:not([hidden]) canvas"), "the sheet's QR code is drawn");
  const sheet = app.household.querySelector(".setup-sheet");
  check(sheet.querySelector("h2").textContent === "How to open Kin", "the sheet is called How to open Kin");
  check(sheet.querySelector(".setup-sheet-for").textContent === `For ${rose.name}, from ${helper.name}`, "it names Rose and Mikey");
  check(sheet.querySelector("kin-qr").value === kept.link && sheet.querySelector("canvas").getBoundingClientRect().width >= 200, "a large QR code for the link");
  check(sheet.querySelectorAll(".setup-sheet-steps li").length === 3, "three numbered steps");
  check(sheet.querySelector(".setup-sheet-address").textContent === kept.link, "the link, for someone without a camera");
  check(sheet.querySelector(".setup-sheet-code strong").textContent === kept.code, "and the code to type");
  check(sheet.querySelector(".setup-sheet-call").textContent === `If you get stuck, call ${helper.name}.`, "who to call");
  check(/works once, until/.test(sheet.querySelector(".setup-sheet-ends").textContent), "when it ends");
  check(parseFloat(getComputedStyle(sheet).fontSize) >= 20, "large type");
  const print = globalThis.print;
  let printed = 0;
  globalThis.print = () => { printed += 1; };
  try { button("Print").click(); } finally { globalThis.print = print; }
  check(printed === 1, "Print prints");
  return { checks: checks.length, link: kept.link, code: kept.code, pairingId };
}

/** Under the print stylesheet only the sheet shows. */
export function printedParts() {
  const visible = (selector) => {
    const node = document.querySelector(selector);
    return node ? getComputedStyle(node).visibility === "visible" && getComputedStyle(node).display !== "none" : null;
  };
  return { sheet: visible(".setup-sheet"), steps: visible(".setup-sheet-steps"), header: visible(".site-header"), actions: visible(".setup-sheet-actions"),
    // Why, should it fail.
    why: { marked: document.documentElement.classList.contains("printing-setup-sheet"), print: matchMedia("print").matches,
      headerVisibility: getComputedStyle(document.querySelector(".site-header")).visibility,
      brandVisibility: getComputedStyle(document.querySelector(".site-header .brand") ?? document.body).visibility } };
}

export async function backFromSheet() {
  const app = document.querySelector("kin-app");
  [...app.household.querySelectorAll(".setup-sheet-actions button")].find((element) => element.textContent === "Back").click();
  for (let i = 0, step = 25; i < 200 && !app.household.querySelector(".pairing-path"); i++) await new Promise((r) => setTimeout(r, step));
  return app.household.querySelector(".pairing-path")?.textContent ?? null;
}

export async function roseOpens(helper, rose) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    const app = document.querySelector("kin-app");
    throw new Error(`Wait timed out: ${label}; step=${app?.security?.dataset.firstRunStep} heading=${app?.security?.heading?.textContent} alert=${app?.security?.alert?.textContent} card=${app?.onboarding?.textContent?.slice(0, 200)} household=${app?.household?.textContent?.slice(0, 300)}`);
  };
  await wait(() => document.querySelector("kin-app")?.security?.dataset.firstRunStep === "hello", "the welcome screen");
  const app = document.querySelector("kin-app");
  const security = app.security;
  const fits = () => document.documentElement.scrollWidth <= innerWidth;
  const smallButtons = () => [...security.querySelectorAll("button, input:not([type=checkbox])")]
    .filter((node) => node.getClientRects().length && node.getBoundingClientRect().width > 2 && node.getBoundingClientRect().height < 55.5)
    .map((node) => `${node.textContent || node.name}:${Math.round(node.getBoundingClientRect().height)}`);
  check(security.heading.textContent === `Hi ${rose.name} — your family set this up for you`, "one welcome screen greets her by name");
  check(document.documentElement.dataset.kinEasy === "on", "easy mode is on before she does anything");
  check(security.textContent.includes(`If you get stuck, call ${helper.name}.`), "it says who to call");
  check(security.textContent.includes(rose.note), "Mikey's note is there");
  check(!security.querySelector("input"), "nothing to type on the welcome");
  check(fits(), "the welcome fits 320px");
  // The page settles at easy mode's size (it turned on as the screen opened).
  await wait(() => smallButtons().length === 0, `every button is at least 56px: ${smallButtons().join(", ")} (zoom ${getComputedStyle(document.body).zoom}, easy ${document.documentElement.dataset.kinEasy})`, 5_000);
  checks.push("every button is at least 56px");
  [...security.querySelectorAll("button")].find((element) => element.textContent === "Continue").click();
  await wait(() => security.dataset.firstRunStep === "account", "the password screen");
  check(security.heading.textContent === "Choose a password", "then a password");
  const username = security.querySelector('input[name="username"]').value;
  check(/^rose\.\d{4}$/.test(username), `a username chosen from her name (${username})`);
  const password = security.querySelector('input[name="password"]');
  check(password.type === "password" && password.autocomplete === "new-password", "a new password, as password managers expect");
  const toggle = security.querySelector("button.show-password");
  check(toggle?.textContent === "Show password" && toggle.getAttribute("aria-pressed") === "false" && toggle.getAttribute("aria-controls") === password.id,
    "Show password, a toggle tied to the field");
  toggle.click();
  check(security.querySelector('input[name="password"]').type === "text" && toggle.getAttribute("aria-pressed") === "true" && toggle.textContent === "Hide password",
    "showing the password is one tap");
  check(security.textContent.includes("A few unrelated words works well") && security.textContent.includes("Write it down"), "plain guidance");
  check(security.textContent.includes(`If you get stuck, call ${helper.name}.`), "who to call, here too");
  check(fits() && smallButtons().length === 0, `the password screen fits 320px with big controls: ${smallButtons().join(", ")}`);
  // Below the strength floor (#557): refused calmly, the field keeps it.
  const field = security.querySelector('input[name="password"]');
  field.value = "1234567890";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  security.querySelector("form").requestSubmit();
  await wait(() => security.querySelector(".field-error"), "a weak password refused");
  check(/too easy to guess/.test(security.querySelector(".field-error").textContent), "the strength floor applies");
  const again = security.querySelector('input[name="password"]');
  again.value = rose.password;
  again.dispatchEvent(new Event("input", { bubbles: true }));
  security.querySelector("form").requestSubmit();
  await wait(() => app.household?.claim?.state === "Claimed" && !app.firstRun, "waiting for approval", 90_000);
  await wait(() => app.household.textContent.includes(`Waiting for ${helper.name} to say yes.`), "the wait names Mikey");
  check(app.household.textContent.includes(`Almost there, ${rose.name}`), "waiting, in plain words");
  check(app.household.textContent.includes(`If you get stuck, call ${helper.name}.`), "who to call while waiting");
  check(location.pathname === "/pair" && fits(), "the waiting screen fits 320px");
  return { checks: checks.length, username, fingerprint: app.household.localFingerprint };
}

export async function helperSeesRose(rose, roseFingerprint) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = document.querySelector("kin-app");
  const household = app.household;
  for (let i = 0; i < 300 && household.pairing?.state !== "Claimed"; i++) {
    const latest = await household.api(`/api/pairings/${household.pairing.pairingId}`);
    if (latest.state === "Claimed") { household.pairing = { ...household.pairing, ...latest }; household.render(); break; }
    await new Promise((r) => setTimeout(r, Math.min(i * 10, 250)));
  }
  check(household.pairing?.state === "Claimed", "Rose's request reaches Mikey");
  check(household.querySelector(".pairing-path")?.textContent === `${rose.name} is joining`, "Mikey's screen says Rose is joining");
  const yes = [...household.querySelectorAll("button")].find((element) => element.textContent === `Yes, let ${rose.name} in`);
  check(yes?.disabled, "saying yes waits until the codes are compared");
  // In person: the code on Rose's screen is the one on Mikey's.
  check(household.pairing.syncKeyFingerprint === roseFingerprint &&
    household.textContent.replaceAll(" ", "").includes(roseFingerprint), "the code Mikey checks is the one on Rose's screen");
  return checks.length;
}

export async function helperAfterYes(rose) {
  const app = document.querySelector("kin-app");
  const household = app.household;
  return {
    heading: household.querySelector(".pairing-path")?.textContent ?? null,
    shows: household.textContent.replaceAll(" ", "").includes(household.localFingerprint),
    fingerprint: household.localFingerprint,
    named: household.textContent.includes(`${rose.name}'s screen`),
  };
}

export async function roseFinishes(helper, rose, helperFingerprint) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = document.querySelector("kin-app");
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; household=${app?.household?.textContent?.slice(0, 400)}`);
  };
  const household = app.household;
  for (let i = 0; i < 300 && household.claim?.state !== "Confirmed"; i++) {
    const latest = await household.api("/api/claim");
    if (latest.state === "Confirmed") { household.claim = latest; household.render(); break; }
    await new Promise((r) => setTimeout(r, Math.min(i * 10, 250)));
  }
  await wait(() => household.claim?.state === "Confirmed", "Rose sees the yes");
  check(household.querySelector(".pairing-path")?.textContent === `${helper.name} said yes`, "her screen says Mikey said yes");
  check(household.textContent.includes(`does this code match the one on ${helper.name}'s screen?`), "and asks: do these match?");
  check(household.textContent.replaceAll(" ", "").includes(helperFingerprint), "showing the code on Mikey's screen");
  check(household.textContent.includes(`If you get stuck, call ${helper.name}.`), "who to call, still");
  const yes = [...household.querySelectorAll("button")].find((element) => element.textContent === "Yes, they match — open Kin");
  check(Boolean(yes) && Boolean([...household.querySelectorAll("button")].find((element) => element.textContent === "No, they're different")), "yes or no, in words");
  yes.click();
  await wait(() => household.identity && location.hash === "#today" && !app.pages.get("today").hidden, "Rose is on Today", 60_000);
  await wait(() => app.pendingProfile === null, "her name is saved", 60_000);
  const names = await app.ctx.sync.memberNames();
  check(names.some((entry) => entry.memberId === household.identity.memberId && entry.name === rose.name), "her name is set");
  check(document.documentElement.dataset.kinEasy === "on" && app.hasAttribute("data-easy") && localStorage.getItem("kin.easy-mode") === "on", "Today is in easy mode");
  const help = app.pages.get("today").querySelector(".page-intro .help-button");
  check(help && help.getClientRects().length > 0 && help.getBoundingClientRect().height >= 55.5, "Help is on the page, big enough to tap");
  check(document.documentElement.scrollWidth <= innerWidth, "Today fits 320px");
  // Easy mode follows her to her other devices: it is in her synced settings.
  await wait(() => app.ctx.privatePrefs.projection?.settings?.["easy-mode"]?.value === "on", "easy mode in her synced settings", 60_000);
  checks.push("easy mode is in her synced settings");
  return { checks: checks.length, identity: household.identity };
}

// ---- The suite -------------------------------------------------------------------

export async function setupForSomeoneRegressions({ endpoint, browserClient }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  const pages = [];
  try {
    const helperPage = await isolatedPage(endpoint, browserClient, origin);
    pages.push(helperPage);
    const helper = helperPage.client;
    await waitForOrigin(helper.evaluate, origin, { navigate: () => helper.send("Page.navigate", { url: origin }) });
    await setViewport(helper, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const created = await helper.evaluate(`(${createHousehold.toString()})(${JSON.stringify(HELPER)})`);
    let checks = created.checks;
    const prepared = await helper.evaluate(`(${prepareForRose.toString()})(${JSON.stringify(HELPER)}, ${JSON.stringify(ROSE)})`);
    checks += prepared.checks;
    assert.equal(store.loadPreparedInvitations(Date.now()).length, 1, "the service keeps the invitation, so the sheet survives a restart");
    // The print stylesheet prints only the sheet.
    await setMedia(helper, [], { media: "print" });
    const printed = await helper.evaluate(`(${printedParts.toString()})()`);
    await setMedia(helper);
    assert.deepEqual({ sheet: printed.sheet, steps: printed.steps, header: printed.header, actions: printed.actions }, { sheet: true, steps: true, header: false, actions: false }, `only the sheet prints: ${JSON.stringify(printed)}`);
    assert.equal(await helper.evaluate(`(${backFromSheet.toString()})()`), `${ROSE.name}'s invitation is ready`);
    checks += 2;

    // Rose's phone: a fresh browser at 320px opens the link.
    const rosePage = await isolatedPage(endpoint, browserClient, prepared.link);
    pages.push(rosePage);
    const rose = rosePage.client;
    await setViewport(rose, { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
    await waitForOrigin(rose.evaluate, origin, { navigate: () => rose.send("Page.navigate", { url: prepared.link }) });
    const opened = await rose.evaluate(`(${roseOpens.toString()})(${JSON.stringify(HELPER)}, ${JSON.stringify(ROSE)})`);
    checks += opened.checks;

    // Mikey checks Rose's code and says yes with his password.
    checks += await helper.evaluate(`(${helperSeesRose.toString()})(${JSON.stringify(ROSE)}, ${JSON.stringify(opened.fingerprint)})`);
    checks += await helper.evaluate(`(${approveWithPassword.toString()})(${JSON.stringify(HELPER)})`);
    const after = await helper.evaluate(`(${helperAfterYes.toString()})(${JSON.stringify(ROSE)})`);
    assert.deepEqual({ heading: after.heading, shows: after.shows, named: after.named }, { heading: `${ROSE.name} is in`, shows: true, named: true },
      `Mikey's screen shows his code for Rose's last step: ${JSON.stringify(after)}`);

    const finished = await rose.evaluate(`(${roseFinishes.toString()})(${JSON.stringify(HELPER)}, ${JSON.stringify(ROSE)}, ${JSON.stringify(after.fingerprint)})`);
    checks += finished.checks;
    const member = kin.service.members.get(finished.identity.memberId);
    assert.equal(member.username, opened.username);
    assert.equal(member.kind, "adult");
    assert.equal(member.householdId, created.identity.householdId);
    assert.deepEqual(store.loadPreparedInvitations(Date.now()), [], "the invitation is spent");
    assert.ok(store.accountVault(finished.identity.householdId, finished.identity.memberId), "Rose's account vault exists");
    checks += 5;
    return `PASS ${checks} set-up-for-someone checks: an admin prepares Kin for Rose with easy mode and a printable sheet; Rose opens it at 320px, sees her name, sets a password, Mikey approves, and she lands on Today in easy mode with her name (#612–#615)`;
  } finally {
    for (const page of pages) {
      page.client.close();
      await browserClient.send("Target.disposeBrowserContext", { browserContextId: page.browserContextId }).catch(() => {});
    }
    kin.server.closeAllConnections?.();
    await new Promise((done) => kin.server.close(done));
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/setup-for-someone-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-setup-for-someone-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await setupForSomeoneRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("set-up-for-someone regression");
    throw error;
  } finally {
    browserClient?.close();
    browser.kill();
    await delay(SETTLE_MS);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  process.exit(0);
}
