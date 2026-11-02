// Reminders and settings that follow a member (#520, #521, #524), in a real
// browser against the production Kin server: one member, two browser
// contexts (a phone in New York and a laptop in Paris). The member signs up
// with a password on the phone (#557), so the phone keeps the account vault
// key and private storage is on. The laptop signs in as the same member with
// the username and password and "Add this as a new device" (#568), which
// opens the member's vault there too.
//
// Then: a reminder, a theme and a text size set on the phone arrive on the
// laptop (the reminder at the same instant, with the phone's time zone beside
// it); the reminder goes off on the laptop and is dismissed there, and it is
// gone from the phone; and a laptop that uses its own settings keeps them
// while the phone changes the theme again.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/synced-prefs-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { captureFailure, waitForOrigin } from "./cdp-page.mjs";
import { createHousehold, eventually, isolatedPage, pageClient } from "./first-run-regression.mjs";
import { signInHere } from "./new-device-regression.mjs";
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

// `item` is what the new-device sign-in waits to see arrive: createHousehold
// adds it.
const MEMBER = { name: "Jordan", household: "The Okafors", username: "jordan.okafor", password: "copper willow lighthouse", item: "Milk" };
// The reminder is due soon enough to go off during the run.
const REMINDER_IN_MS = 45_000;
// Lets a killed browser release its profile before the folder is removed.
const BROWSER_EXIT_MS = 300;

// ---- In-page steps (stringified and run in the browser) ---------------------

async function pageSync() {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  if (!app.syncCoordinator) await app.ctx.sync.configureSyncCoordinator();
  const coordinator = app.syncCoordinator;
  if (!coordinator) throw new Error("No sync on this device.");
  for (let i = 0; i < 1200 && (!coordinator.deviceKeys || coordinator.running); i++) await new Promise((r) => setTimeout(r, step));
  await coordinator.running;
  await coordinator.syncNow();
  await coordinator.running;
  for (let i = 0; i < 20; i++) await app.ctx.privatePrefs.work;
  return { state: app.syncState?.state ?? null, code: app.syncState?.code ?? null, privateLog: Boolean(coordinator.privateLog), scope: app.ctx.privatePrefs.scope };
}

async function pageIdentity() {
  const identity = document.querySelector("kin-app").household.identity;
  return { memberId: identity.memberId, deviceId: identity.deviceId, householdId: identity.householdId };
}

async function pageSetReminderAndTheme(inMs) {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  if (!prefs.available) throw new Error("Private storage isn't on: " + prefs.scope);
  const item = app.state.items.find((entry) => entry.text === "Milk" && entry.status === "active");
  const id = `item:${item.itemId}`;
  const at = Math.ceil((Date.now() + inMs) / 1000) * 1000;
  await app.ctx.records.handleLocalReminder({ id, title: item.text, at });
  // The theme through the appearance editor's own save.
  const { resolveAppearance } = await import("/appearance/household.js");
  const baseline = resolveAppearance(app.personalAppearance, app.householdSettings);
  await new Promise((resolve, reject) => app.ctx.appearance.handleSaveAppearance({ detail: {
    value: { ...baseline, mode: "dark" }, baseline, forceExplicit: false,
    complete: (value, error) => (error ? reject(error) : resolve(value)),
  } }));
  await prefs.setDisplaySetting("text-size", "large");
  for (let i = 0; i < 400; i++) {
    await prefs.refresh();
    const projection = prefs.projection;
    if (projection?.reminders.some((reminder) => reminder.reminderId === id && reminder.at === at) &&
        projection.settings["theme-mode"]?.value === "dark" && projection.settings["text-size"]?.value === "large") break;
    await new Promise((r) => setTimeout(r, step));
  }
  const reminder = prefs.projection.reminders.find((entry) => entry.reminderId === id);
  if (!reminder) throw new Error("The reminder isn't in the private log.");
  return {
    id, at, timeZone: reminder.timeZone, offset: reminder.utcOffsetMinutes,
    theme: prefs.projection.settings["theme-mode"]?.value, textSize: prefs.projection.settings["text-size"]?.value,
  };
}

async function pageArrived({ id, at }) {
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  const view = prefs.reminderView().get(id);
  return {
    reminder: view ? { at: view.at, scope: view.scope, where: view.where } : null,
    // Armed for that instant, or already gone off here.
    armed: app.localReminders.entries.get(id)?.at === at || prefs.fired.has(`${id}@${at}`),
    theme: app.personalAppearance?.mode ?? null,
    applied: document.documentElement.dataset.kinAppearance ?? null,
    textSize: document.documentElement.dataset.kinTextSize ?? null,
    scope: prefs.scope,
    settingsLine: app.personalSettings?.querySelector(".personal-settings-scope")?.textContent ?? "",
  };
}

async function pageDismissWhenItGoesOff({ id, at, ms }) {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  for (let i = 0; i < ms / step && !prefs.shown.has(id); i++) await new Promise((r) => setTimeout(r, step));
  const shown = prefs.shown.get(id);
  let how;
  if (shown?.at === at) {
    // The member clicks the notification, as on a real screen (a click is
    // a dismissal on every platform; a close event isn't reported on all).
    shown.notification.dispatchEvent(new Event("click"));
    how = "clicked the notification";
  } else {
    // A browser that can't construct a notification here: the same step
    // closing it takes.
    await prefs.endReminder(id, "dismissed", at);
    how = "dismissed without a notification";
  }
  const gone = () => !prefs.projection?.reminders.some((reminder) => reminder.reminderId === id);
  for (let i = 0; i < 400 && !gone(); i++) {
    await prefs.work;
    await new Promise((r) => setTimeout(r, step));
  }
  return { how, gone: gone() };
}

async function pageGone(id) {
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  return {
    inLog: Boolean(prefs.projection?.reminders.some((reminder) => reminder.reminderId === id)),
    shown: prefs.reminderView().has(id),
    armed: app.localReminders.entries.has(id),
    notificationOpen: Boolean(prefs.shown.get(id)),
  };
}

async function pageUseOwnSettings(on) {
  const app = document.querySelector("kin-app");
  app.ctx.privatePrefs.setDeviceOnly(on);
  for (let i = 0; i < 20; i++) await app.ctx.privatePrefs.work;
  return app.ctx.privatePrefs.scope;
}

async function pageSetTheme(mode) {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  const { resolveAppearance } = await import("/appearance/household.js");
  const baseline = resolveAppearance(app.personalAppearance, app.householdSettings);
  await new Promise((resolve, reject) => app.ctx.appearance.handleSaveAppearance({ detail: {
    value: { ...baseline, mode }, baseline, forceExplicit: false,
    complete: (value, error) => (error ? reject(error) : resolve(value)),
  } }));
  for (let i = 0; i < 400 && app.ctx.privatePrefs.projection?.settings["theme-mode"]?.value !== mode; i++) {
    await app.ctx.privatePrefs.refresh();
    await new Promise((r) => setTimeout(r, step));
  }
  return app.ctx.privatePrefs.projection?.settings["theme-mode"]?.value;
}

// ---- The suite -------------------------------------------------------------------

/**
 * Runs the synced reminders and settings checks with an existing browser.
 * `endpoint` is its DevTools HTTP address and `browserClient` a CDP client
 * for the browser target (for isolated contexts).
 */
export async function syncedPrefsRegressions({ endpoint, browserClient }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  // The drill checks reminders and settings, not the account vault's
  // download allowance (10 per member per 15 minutes, its own tests cover
  // it): a sign-up, a second device signing in and both opening private
  // storage within a minute spend about that many, so the allowance is
  // widened for this run only.
  kin.accountVaultService.memberDownloads.limit = 100;
  const pages = [];
  let checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks += 1; };
  const run = (client, fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(", ")})`)
    .catch((error) => { error.message = `${fn.name}: ${error.message}`; throw error; });
  const open = async (url, timezoneId) => {
    const page = await isolatedPage(endpoint, browserClient, url);
    pages.push(page);
    await page.client.send("Emulation.setTimezoneOverride", { timezoneId });
    await browserClient.send("Browser.grantPermissions", { origin, permissions: ["notifications"], browserContextId: page.browserContextId });
    await waitForOrigin(page.client.evaluate, origin, { navigate: () => page.client.send("Page.navigate", { url }) });
    return page.client;
  };
  try {
    // The phone, in New York: a password sign-up, so private storage is on.
    const phone = await open(origin, "America/New_York");
    const created = await run(phone, createHousehold, MEMBER);
    const phoneSync = await eventually(async () => {
      const result = await run(phone, pageSync);
      return result.scope === "synced" ? result : null;
    }, "private storage on the phone", 60_000);
    check(phoneSync.privateLog, "the phone opens the member's private log; the member key comes with the first private change");

    // The laptop, in Paris: the same member, signed in with the password,
    // once the phone has endorsed the member's certification key and filled
    // the vault (as new-device-regression.mjs waits).
    await eventually(() => kin.service.certificationEndorsement(created.identity.memberId), "the certification key endorsed", 60_000);
    await eventually(() => (store.accountVault(created.identity.householdId, created.identity.memberId)?.version ?? 0) >= 2, "the vault holds the first key", 60_000);
    const laptop = await open(origin, "Europe/Paris");
    const signedIn = await run(laptop, signInHere, MEMBER, "new");
    const laptopIdentity = await run(laptop, pageIdentity);
    check(signedIn.identity.memberId === created.identity.memberId && laptopIdentity.deviceId !== created.identity.deviceId,
      "one member, two devices");
    const laptopSync = await eventually(async () => {
      const result = await run(laptop, pageSync);
      return result.scope === "synced" ? result : null;
    }, "private storage on the laptop", 90_000);
    check(laptopSync.privateLog, "the laptop opens the same private log with the member key from the vault");

    // A reminder, a theme and a text size, set on the phone.
    const set = await run(phone, pageSetReminderAndTheme, REMINDER_IN_MS);
    check(set.timeZone === "America/New_York" && [-240, -300].includes(set.offset),
      `the reminder keeps its absolute instant and the phone's zone: ${JSON.stringify(set)}`);
    check(set.theme === "dark" && set.textSize === "large", "the theme and text size are in the private log");
    await run(phone, pageSync);
    const arrived = await eventually(async () => {
      await run(laptop, pageSync);
      const value = await run(laptop, pageArrived, { id: set.id, at: set.at });
      return value.reminder && value.theme === "dark" && value.textSize === "large" ? value : null;
    }, "the reminder and settings on the laptop", 60_000);
    check(arrived.reminder.at === set.at && arrived.reminder.scope === "devices", "the laptop has the reminder at the same instant");
    check(/in America\/New_York, where it was set$/.test(arrived.reminder.where),
      `in Paris the reminder also says the time where it was set: ${arrived.reminder.where}`);
    check(arrived.armed, "the laptop, which allows notifications, arms it");
    check(arrived.applied === "dark", "the laptop shows the dark theme");
    check(arrived.scope === "synced" && /follow you to your other devices/.test(arrived.settingsLine), "the laptop's settings say they follow the member");

    // It goes off; the member dismisses it on the laptop; it's gone from the phone.
    const dismissed = await run(laptop, pageDismissWhenItGoesOff, { id: set.id, at: set.at, ms: REMINDER_IN_MS + 30_000 });
    check(dismissed.gone, `dismissed on the laptop (${dismissed.how})`);
    await run(laptop, pageSync);
    const gone = await eventually(async () => {
      await run(phone, pageSync);
      const value = await run(phone, pageGone, set.id);
      return !value.inLog ? value : null;
    }, "the dismissal on the phone", 60_000);
    check(!gone.shown && !gone.armed && !gone.notificationOpen, "the phone no longer shows, arms or displays the reminder");

    // A laptop that keeps its own settings (a kitchen tablet, say).
    check((await run(laptop, pageUseOwnSettings, true)) === "device-only", "the laptop uses its own settings");
    check((await run(phone, pageSetTheme, "light")) === "light", "the phone switches to the light theme");
    await run(phone, pageSync);
    await run(laptop, pageSync);
    await run(laptop, pageSync);
    const kept = await run(laptop, pageArrived, { id: set.id, at: set.at });
    check(kept.theme === "dark" && kept.applied === "dark", "the laptop keeps its own dark theme");
    check((await run(laptop, pageUseOwnSettings, false)) === "synced", "following again");
    const followed = await eventually(async () => {
      const value = await run(laptop, pageArrived, { id: set.id, at: set.at });
      return value.theme === "light" ? value : null;
    }, "the laptop follows the member's light theme again", 30_000);
    check(followed.applied === "light", "the laptop shows the member's light theme again");
    return `PASS ${checks} synced reminder and settings checks across two devices of one member (${dismissed.how})`;
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
  assert.ok(executable, "Usage: node scripts/synced-prefs-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-synced-prefs-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await syncedPrefsRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("synced reminders and settings regression");
    throw error;
  } finally {
    browserClient?.close();
    browser.kill();
    await delay(BROWSER_EXIT_MS);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  process.exit(0);
}
