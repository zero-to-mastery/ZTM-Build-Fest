// The first run with a password (#557, #558, #559), in a real browser
// against the production Kin server: create a household in at most three
// screens and reach Today; lock and unlock with the password (a wrong one is
// calm and keeps the form); a second, separate browser profile joins by
// invitation with a password, the founder approves with a fresh password,
// and the joiner finishes and reaches Today. Both members' account vaults
// exist on the service.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/first-run-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, captureFailure, waitForOrigin } from "./cdp-page.mjs";
import { setViewport } from "./cdp-viewport.mjs";
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

export const FOUNDER = { name: "Robin", household: "The Lees", username: "lee.founder", password: "kettle lantern meadow" };
const POLL_MS = 100;
export const PARTNER = { name: "Sam", username: "lee.partner", password: "harbor pencil orchard" };

/** Waits in Node for `check()` to hold (up to `ms`). */
export async function eventually(check, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`First-run regression timed out: ${label}`);
    await delay(POLL_MS);
  }
}

/** A CDP client for one page target: send() and evaluate(). */
export async function pageClient(webSocketUrl) {
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

/** Opens `url` in a new, isolated browser context (its own cookies and
 * storage, like a second person's phone). */
export async function isolatedPage(endpoint, browserClient, url) {
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

export async function createHousehold(founder) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    const app = document.querySelector("kin-app");
    throw new Error(`Wait timed out: ${label}; step=${app?.security?.dataset.firstRunStep} alert=${app?.security?.alert?.textContent} card=${app?.onboarding?.textContent?.slice(0, 200)} household=${app?.household?.textContent?.slice(0, 200)}`);
  };
  await wait(() => document.querySelector("kin-app")?.security?.heading && !document.querySelector("kin-app").starting, "first screen");
  const app = document.querySelector("kin-app");
  const security = app.security;
  const steps = [];
  const note = () => { const step = security.dataset.firstRunStep; if (step && steps.at(-1) !== step) steps.push(step); };
  const button = (label) => [...security.querySelectorAll("button")].find((element) => element.textContent === label);
  const type = (name, value) => {
    const input = security.querySelector(`input[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  };
  const started = performance.now();
  note();
  check(security.dataset.firstRunStep === "welcome" && Boolean(button("Start a new household")) && !security.querySelector("input"),
    "screen 1 offers two choices and nothing to type");
  check(document.documentElement.scrollWidth <= innerWidth, `the first screen fits ${innerWidth} px without sideways scrolling`);
  button("Start a new household").click();
  note();
  check(security.querySelector('input[name="name"]')?.autocomplete === "name", "screen 2 asks for your name");
  type("name", founder.name);
  type("household", founder.household);
  security.querySelector("form").requestSubmit();
  await wait(() => security.dataset.firstRunStep === "account", "screen 3");
  note();
  check(security.querySelector('input[name="username"]').autocomplete === "username" &&
    security.querySelector('input[name="password"]').autocomplete === "new-password",
    "screen 3 is a username and a new password, as password managers expect");
  check(security.textContent.includes("can't reset this password"), "the trade-off is one line where the password is set");
  check(!/backup key|recovery key/i.test(security.textContent) && !security.querySelector(".recovery-key"), "no key is shown at first run");
  // Below the floor: refused in plain words, nothing lost.
  type("username", founder.username);
  type("password", "1234567890");
  security.querySelector("form").requestSubmit();
  await wait(() => security.querySelector(".field-error"), "a weak password refused");
  check(/too easy to guess/.test(security.querySelector(".field-error").textContent) &&
    security.querySelector('input[name="username"]').value === founder.username, "a weak password is refused calmly and the form keeps the username");
  type("password", founder.password);
  security.querySelector("form").requestSubmit();
  await wait(() => app.store && app.household?.identity && !app.firstRun && !app.busy, "Today after sign-up", 60_000);
  const ms = Math.round(performance.now() - started);
  check(JSON.stringify(steps) === JSON.stringify(["welcome", "about", "account"]), `three screens before Today: ${steps.join(", ")}`);
  check(location.hash === "#today" && !app.pages.get("today").hidden, "the founder lands on Today");
  check(app.security.phase === "unlocked" && app.security.manifest.wrappers.map((wrapper) => wrapper.type).join() === "password",
    "this device's storage has one password wrapper and no backup key");
  // The names arrive once sync is ready.
  await wait(() => app.pendingProfile === null && app.householdSettings?.name === founder.household, "household name saved", 60_000);
  const names = await app.ctx.sync.memberNames();
  check(names.some((entry) => entry.memberId === app.household.identity.memberId && entry.name === founder.name), "the founder's name is recorded");
  // Something to find again after unlocking.
  app.compose.input.value = "Milk";
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  await wait(() => !app.busy && app.state.items.some((item) => item.text === "Milk"), "an item added");
  return { checks: checks.length, ms, identity: app.household.identity };
}

export async function lockAndUnlock(founder) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; alert=${document.querySelector("kin-app")?.security?.alert?.textContent}`);
  };
  const app = document.querySelector("kin-app");
  // Sign out first, so the unlock below must sign in with the password.
  await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  app.ctx.session.lockHousehold();
  await wait(() => app.security.querySelector("#password-unlock"), "the password lock screen");
  const input = app.security.querySelector("#password-unlock");
  check(input.autocomplete === "current-password" &&
    app.security.querySelector('input[autocomplete="username"]')?.value === founder.username, "the lock screen asks for the password and names the username for password managers");
  check(!app.security.querySelector("#recovery-unlock"), "no backup key field");
  input.value = "kettle lantern meadoW";
  input.form.requestSubmit();
  await wait(() => !app.security.busy && app.security.alert.textContent, "a wrong password answered");
  check(app.security.alert.textContent === "That password didn't work. Check it and try again." && app.vault === null,
    "a wrong password gets one calm line and unlocks nothing");
  const again = app.security.querySelector("#password-unlock");
  check(Boolean(again) && document.activeElement === again, "the form stays, ready to type again");
  again.value = founder.password;
  again.form.requestSubmit();
  await wait(() => app.store && !app.busy && app.state?.items.some((item) => item.text === "Milk"), "unlocked with the password");
  const status = await (await fetch("/api/status")).json();
  check(Boolean(status.identity), "unlocking with the password also signed this device in");
  return checks.length;
}

export async function invite() {
  const app = document.querySelector("kin-app");
  // The panel's own load after unlocking finishes first, so the invitation
  // view isn't replaced under it.
  for (let i = 0, step = 25; i < 1200 && !(app.household?.identity && app.household.syncStatus?.enabled && !app.household.busy); i++)
    await new Promise((r) => setTimeout(r, step));
  await app.household.loaded;
  await app.household.createPairing("adult");
  if (!app.household.pairing?.code) throw new Error("No invitation code: " + app.household.textContent.slice(0, 300));
  return app.household.pairing.code;
}

export async function joinByInvitation(partner, founderUsername) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    const app = document.querySelector("kin-app");
    throw new Error(`Wait timed out: ${label}; step=${app?.security?.dataset.firstRunStep} alert=${app?.security?.alert?.textContent} card=${app?.onboarding?.textContent?.slice(0, 200)} household=${app?.household?.textContent?.slice(0, 300)}`);
  };
  await wait(() => document.querySelector("kin-app")?.security?.heading && !document.querySelector("kin-app").starting, "first screen");
  const app = document.querySelector("kin-app");
  const security = app.security;
  const type = (name, value) => {
    const input = security.querySelector(`input[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  check(security.dataset.firstRunStep === "about" && security.heading.textContent === "Join your household" &&
    security.querySelector('input[name="code"]').value.length === 9, "an invitation link opens on joining, with its code filled in");
  type("name", partner.name);
  security.querySelector("form").requestSubmit();
  await wait(() => security.dataset.firstRunStep === "account", "join screen 2");
  // A taken username is said on the field; the rest of the form stays.
  type("username", founderUsername);
  type("password", partner.password);
  security.querySelector("form").requestSubmit();
  await wait(() => security.querySelector(".field-error"), "a taken username");
  check(security.querySelector(".field-error").textContent === "That username is taken. Try another." &&
    security.querySelector('input[name="password"]').value === partner.password, "a taken username is refused calmly, keeping the password typed");
  type("username", partner.username);
  security.querySelector("form").requestSubmit();
  await wait(() => app.household?.claim?.state === "Claimed" && !app.firstRun, "the request is waiting for approval", 60_000);
  check(location.pathname === "/pair" && app.household.textContent.includes("approve"), "the joiner waits for approval, as with a passkey");
  return checks.length;
}

export async function approveWithPassword(founder) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; household=${document.querySelector("kin-app")?.household?.textContent?.slice(0, 300)}`);
  };
  const app = document.querySelector("kin-app");
  const household = app.household;
  // The panel polls every 2 s; reading the same route here as well keeps a
  // slow or throttled background tab from deciding the outcome.
  for (let i = 0; i < 300 && household.pairing?.state !== "Claimed"; i++) {
    const latest = await household.api(`/api/pairings/${household.pairing.pairingId}`);
    if (latest.state === "Claimed") { household.pairing = { ...household.pairing, ...latest }; household.render(); break; }
    await new Promise((r) => setTimeout(r, i));
  }
  await wait(() => household.pairing?.state === "Claimed" && household.pairing.syncKeyFingerprint, "the claim reaches the founder");
  household.verifiedFingerprint = household.pairing.syncKeyFingerprint;
  const confirmWith = async (password) => {
    const approving = household.ctx.pairing.approve();
    await wait(() => document.querySelector("dialog.password-confirmation input[type=password]"), "the password confirmation");
    const dialog = document.querySelector("dialog.password-confirmation");
    check(dialog.open && dialog.querySelector('input[autocomplete="username"]').value === founder.username,
      "approving asks the founder, who has no passkey yet, for their password");
    dialog.querySelector("input[type=password]").value = password;
    dialog.querySelector("form").requestSubmit();
    await approving;
  };
  await confirmWith("not my password at all");
  check(household.pairing.state === "Claimed" && /didn't match/.test(household.textContent), "a wrong password approves nothing and says so calmly");
  household.verifiedFingerprint = household.pairing.syncKeyFingerprint;
  await confirmWith(founder.password);
  await wait(() => household.pairing?.state === "Confirmed", "approved");
  return checks.length;
}

export async function finishJoining(partner) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; household=${document.querySelector("kin-app")?.household?.textContent?.slice(0, 300)}`);
  };
  const app = document.querySelector("kin-app");
  const household = app.household;
  for (let i = 0; i < 300 && household.claim?.state !== "Confirmed"; i++) {
    const latest = await household.api("/api/claim");
    if (latest.state === "Confirmed") { household.claim = latest; household.render(); break; }
    await new Promise((r) => setTimeout(r, i));
  }
  await wait(() => household.claim?.state === "Confirmed", "the joiner sees the approval");
  const finish = [...household.querySelectorAll("button")].find((element) => element.textContent === "Finish joining");
  check(Boolean(finish), "the joiner finishes with the password, not a passkey");
  household.verifiedInviterFingerprint = true;
  await household.account.activate();
  await wait(() => household.identity && location.hash === "#today", "the joiner is in");
  await wait(() => app.pendingProfile === null, "the joiner's name saved", 60_000);
  const names = await app.ctx.sync.memberNames();
  check(names.some((entry) => entry.memberId === household.identity.memberId && entry.name === partner.name), "the joiner's name is recorded");
  return { checks: checks.length, identity: household.identity };
}

// ---- The suite -------------------------------------------------------------------

/**
 * Runs the first-run checks with an existing browser. `endpoint` is its
 * DevTools HTTP address and `browserClient` a CDP client for the browser
 * target (for isolated contexts).
 */
export async function firstRunRegressions({ endpoint, browserClient }) {
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
    const founderPage = await isolatedPage(endpoint, browserClient, origin);
    pages.push(founderPage);
    const founder = founderPage.client;
    await waitForOrigin(founder.evaluate, origin, { navigate: () => founder.send("Page.navigate", { url: origin }) });
    // The first run at the narrowest supported width.
    await setViewport(founder, { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
    const created = await founder.evaluate(`(${createHousehold.toString()})(${JSON.stringify(FOUNDER)})`);
    let checks = created.checks;
    const member = kin.service.members.get(created.identity.memberId);
    assert.equal(member.username, FOUNDER.username);
    assert.equal(member.credentials.size, 0, "the founder signed up without a passkey");
    // The account vault exists, behind a password wrapper, and gains the
    // household's first key once sync installs it (the keeper, #567).
    const vault = await eventually(() => {
      const row = store.accountVault(created.identity.householdId, created.identity.memberId);
      return row && row.version >= 2 ? row : null;
    }, "the founder's vault holds the first household key");
    assert.deepEqual(vault.wrappers.map((wrapper) => wrapper.type), ["password"]);
    checks += 3;
    await setViewport(founder, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    checks += await founder.evaluate(`(${lockAndUnlock.toString()})(${JSON.stringify(FOUNDER)})`);
    const code = await founder.evaluate(`(${invite.toString()})()`);

    const partnerPage = await isolatedPage(endpoint, browserClient, `${origin}/pair#code=${code}`);
    pages.push(partnerPage);
    const partner = partnerPage.client;
    await waitForOrigin(partner.evaluate, origin, { navigate: () => partner.send("Page.navigate", { url: `${origin}/pair#code=${code}` }) });
    checks += await partner.evaluate(`(${joinByInvitation.toString()})(${JSON.stringify(PARTNER)}, ${JSON.stringify(FOUNDER.username)})`);
    checks += await founder.evaluate(`(${approveWithPassword.toString()})(${JSON.stringify(FOUNDER)})`);
    const joined = await partner.evaluate(`(${finishJoining.toString()})(${JSON.stringify(PARTNER)})`);
    checks += joined.checks;
    const partnerMember = kin.service.members.get(joined.identity.memberId);
    assert.equal(partnerMember.username, PARTNER.username);
    assert.equal(partnerMember.householdId, created.identity.householdId);
    assert.ok(store.accountVault(joined.identity.householdId, joined.identity.memberId), "the joiner's vault exists");
    checks += 3;
    return `PASS ${checks} first-run checks; a household created in three screens and ${created.ms} ms to Today`;
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
  assert.ok(executable, "Usage: node scripts/first-run-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-first-run-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await firstRunRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("first-run regression");
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
