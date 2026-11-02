// Signing in on a new device (#568, #569, #570), in a real browser against
// the production Kin server: a founder creates a household with a password
// in one browser context and adds an item; a fresh context with no cookie
// and no local data signs in with that username and password, chooses "Add
// this as a new device", reaches Today and sees the household's item; then
// another fresh context signs in and chooses "This replaces <the first new
// device>", reaches Today, and that device is revoked.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/new-device-regression.mjs <browser executable>
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

const FOUNDER = { name: "Robin", household: "The Lees", username: "lee.robin", password: "kettle lantern meadow", item: "Oat milk" };
const POLL_MS = 100;

async function eventually(check, label, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`New-device regression timed out: ${label}`);
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

async function isolatedPage(endpoint, browserClient, url) {
  const { browserContextId } = await browserClient.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await browserClient.send("Target.createTarget", { url: "about:blank", browserContextId });
  const target = await eventually(async () => (await (await fetch(`${endpoint}/json/list`)).json()).find((entry) => entry.id === targetId),
    "new target listed", 10_000);
  const client = await pageClient(target.webSocketDebuggerUrl);
  await applyRegressionDefaults(client.send);
  await client.send("Page.enable");
  await client.send("Page.navigate", { url });
  return { client, browserContextId };
}

// ---- In-page steps (stringified and run in the browser) ---------------------

async function createHousehold(founder) {
  const wait = async (condition, label, ms = 60_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    const app = document.querySelector("kin-app");
    throw new Error(`Wait timed out: ${label}; step=${app?.security?.dataset.firstRunStep} alert=${app?.security?.alert?.textContent} card=${app?.onboarding?.textContent?.slice(0, 200)}`);
  };
  await wait(() => document.querySelector("kin-app")?.security?.heading && !document.querySelector("kin-app").starting, "first screen");
  const app = document.querySelector("kin-app");
  const security = app.security;
  const button = (label) => [...security.querySelectorAll("button")].find((element) => element.textContent === label);
  const type = (name, value) => {
    const input = security.querySelector(`input[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  button("Start a new household").click();
  type("name", founder.name);
  type("household", founder.household);
  security.querySelector("form").requestSubmit();
  await wait(() => security.dataset.firstRunStep === "account", "the account screen");
  type("username", founder.username);
  type("password", founder.password);
  security.querySelector("form").requestSubmit();
  await wait(() => app.store && app.household?.identity && !app.firstRun && !app.busy, "Today after sign-up", 90_000);
  await wait(() => app.syncState?.state === "ready", "the founder's sync ready", 60_000);
  app.compose.input.value = founder.item;
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  await wait(() => !app.busy && app.state.items.some((item) => item.text === founder.item), "an item added");
  return app.household.identity;
}

/** Signs in on this fresh browser and answers "Which device is this?" with
 * `choice` ("new", or a device ID this one replaces). `fromOldAddress`
 * lists the devices the list should mark as carried over by a move (#780). */
export async function signInHere(founder, choice, fromOldAddress = []) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const wait = async (condition, label, ms = 60_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    const app = document.querySelector("kin-app");
    throw new Error(`Wait timed out: ${label}; step=${app?.security?.dataset.firstRunStep} alert=${app?.security?.alert?.textContent} card=${app?.onboarding?.textContent?.slice(0, 300)} sync=${JSON.stringify(app?.syncState)}`);
  };
  await wait(() => document.querySelector("kin-app")?.security?.heading && !document.querySelector("kin-app").starting, "first screen");
  const app = document.querySelector("kin-app");
  const security = app.security;
  const button = (label) => [...security.querySelectorAll("button")].find((element) => element.textContent === label);
  const type = (name, value) => {
    const input = security.querySelector(`input[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const status = await (await fetch("/api/status")).json();
  check(status.identity === null, "this browser starts with no session and no trusted device");
  check(Boolean(button("Sign in")), "the first screen offers Sign in beside create and join");
  button("Sign in").click();
  await wait(() => security.dataset.firstRunStep === "sign-in-credentials", "the sign-in screen");
  check(security.querySelector('input[name="username"]').autocomplete === "username" &&
    security.querySelector('input[name="password"]').autocomplete === "current-password", "a username and the current password, as password managers expect");
  // A wrong password: one calm line, nothing kept.
  type("username", founder.username);
  type("password", "not the password at all");
  security.querySelector("form").requestSubmit();
  await wait(() => !security.busy && security.alert.textContent, "a wrong password answered");
  check(/didn't match/.test(security.alert.textContent) && security.dataset.firstRunStep === "sign-in-credentials",
    "a wrong password is refused calmly and the form stays");
  type("password", founder.password);
  security.querySelector("form").requestSubmit();
  await wait(() => security.dataset.firstRunStep === "sign-in-device", "Which device is this?", 60_000);
  const options = [...security.querySelectorAll('input[name="device-choice"]')];
  check(options[0]?.value === "new" && options[0].checked && options[0].parentElement.textContent.includes("Add this as a new device"),
    "Add this as a new device is offered first, and chosen");
  check(options.slice(1).every((input) => input.parentElement.textContent.includes("This replaces")), "each of the member's devices can be replaced");
  check(options.slice(1).every((input) => input.parentElement.textContent.includes("From the old address") ===
    fromOldAddress.includes(input.value.slice("replace:".length))), "the devices from the old address, and only those, say so");
  const warning = security.querySelector("#device-choice-warning");
  check(warning.hidden, "no warning while adding a new device");
  if (choice !== "new") {
    const replace = options.find((input) => input.value === `replace:${choice}`);
    check(Boolean(replace), "the device to replace is listed");
    replace.click();
    check(!warning.hidden && /signed out for good/.test(warning.textContent) &&
      replace.getAttribute("aria-describedby") === warning.id, "replacing shows a clear warning, tied to the choice");
  }
  security.querySelector("form").requestSubmit();
  await wait(() => app.store && app.household?.identity && !app.firstRun && !app.busy, "this device set up", 90_000);
  check(location.hash === "#today", "the member lands on Today");
  check(app.security.manifest.wrappers.map((wrapper) => wrapper.type).join() === "password",
    "this device's storage is protected by the password, with no backup key shown");
  await wait(() => app.state?.items.some((item) => item.text === founder.item), "the household's item arrives", 90_000);
  check(true, "the household's items are here");
  return { checks: checks.length, identity: app.household.identity };
}

// ---- The suite -------------------------------------------------------------------

export async function newDeviceRegressions({ endpoint, browserClient }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  const pages = [];
  const open = async () => {
    const page = await isolatedPage(endpoint, browserClient, origin);
    pages.push(page);
    await waitForOrigin(page.client.evaluate, origin, { navigate: () => page.client.send("Page.navigate", { url: origin }) });
    return page.client;
  };
  try {
    const founder = await open();
    const identity = await founder.evaluate(`(${createHousehold.toString()})(${JSON.stringify(FOUNDER)})`);
    let checks = 0;
    // The founder's device endorsed the certification key, and the vault
    // holds the household's first key, before anyone signs in elsewhere.
    await eventually(() => kin.service.certificationEndorsement(identity.memberId), "the certification key endorsed");
    await eventually(() => (store.accountVault(identity.householdId, identity.memberId)?.version ?? 0) >= 2, "the vault holds the first key");
    checks += 2;

    const laptop = await open();
    const added = await laptop.evaluate(`(${signInHere.toString()})(${JSON.stringify(FOUNDER)}, "new")`);
    checks += added.checks;
    assert.equal(added.identity.memberId, identity.memberId);
    assert.notEqual(added.identity.deviceId, identity.deviceId, "a new device of the same member");
    const laptopDevice = kin.service.devices.get(added.identity.deviceId);
    assert.equal(laptopDevice.deviceAuthorizationCertificate.version, 2, "certified by the member's certification key");
    assert.equal(laptopDevice.revokedAt, null);
    checks += 3;

    // What a move leaves of the founder's device (ADR 0026 §6, #769): its
    // record, marked, with no token. The list says it's from the old address
    // (#780); the phone still replaces the laptop.
    const founderDevice = kin.service.devices.get(identity.deviceId);
    kin.service.deviceTokens.delete(founderDevice.tokenHash);
    founderDevice.tokenHash = null;
    founderDevice.carriedOver = true;
    for (const [sessionHash, session] of kin.service.sessions)
      if (session.deviceId === founderDevice.id) kin.service.sessions.delete(sessionHash);
    kin.service.persistHousehold(founderDevice.householdId);
    const phone = await open();
    const replaced = await phone.evaluate(`(${signInHere.toString()})(${JSON.stringify(FOUNDER)}, ${JSON.stringify(added.identity.deviceId)}, ${JSON.stringify([identity.deviceId])})`);
    checks += replaced.checks;
    assert.ok(kin.service.devices.get(added.identity.deviceId).revokedAt, "the replaced device is revoked");
    assert.equal(kin.service.devices.get(replaced.identity.deviceId).revokedAt, null);
    const laptopStatus = await laptop.evaluate(`fetch("/api/sync/status").then((response) => response.status)`);
    assert.ok([401, 403].includes(laptopStatus), "the replaced device can't sync any more");
    checks += 3;
    return `PASS ${checks} new-device checks; signed in as a new device and as a replacement`;
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
  assert.ok(executable, "Usage: node scripts/new-device-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-new-device-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await newDeviceRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("new-device regression");
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
