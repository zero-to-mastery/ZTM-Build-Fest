// Reports and suggestions to the Kin team (#634, #629, ADR 0021 §3), in a real
// browser against the production Kin server: the founder (a household admin,
// signed up with a password) reports a problem from Household with a detail
// removed in the preview, then one with a cropped picture of the screen, then
// one while offline that waits in the outbox and goes once online; suggests
// something from Household › Features; sees both with their status in What I've
// sent after the operator's command sets one; reaches the report from the
// keyboard help, an error message and `kin:report-problem`; and, locked,
// reports a problem without signing in. On the service: what arrived, with
// nothing the person removed, and the anonymous one linked to nobody.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/report-problem-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { captureFailure, waitForOrigin } from "./cdp-page.mjs";
import { setViewport } from "./cdp-viewport.mjs";
import { FOUNDER, createHousehold, eventually, isolatedPage, pageClient } from "./first-run-regression.mjs";
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
import { REFERENCE_PATTERN, sniffImageType } from "../web/feedback/format.js";

const SETTLE_MS = 300;

// ---- In-page steps (stringified and run in the browser) ---------------------

/** Shared helpers, defined in the page once. */
function installHelpers() {
  const app = document.querySelector("kin-app");
  const step = 25;
  window.__report = {
    app,
    wait: async (condition, label, ms = 30_000) => {
      for (let i = 0; i < ms / step; i++) { if (await condition()) return; await new Promise((r) => setTimeout(r, step)); }
      const dialog = document.querySelector("kin-report dialog");
      throw new Error(`Wait timed out: ${label}; dialog=${dialog?.open} step=${dialog?.dataset.step} text=${dialog?.textContent?.slice(0, 300)}`);
    },
    dialog: () => document.querySelector("kin-report dialog"),
    button: (label) => [...document.querySelector("kin-report dialog").querySelectorAll("button")].find((node) => node.textContent === label),
    type: (name, value) => {
      const area = document.querySelector(`kin-report dialog textarea[name="${name}"]`);
      area.value = value;
      area.dispatchEvent(new Event("input", { bubbles: true }));
    },
    fits: () => document.documentElement.scrollWidth <= innerWidth,
  };
  return true;
}

async function reportWithRemovedDetail() {
  const { app, wait, dialog, button, type, fits } = window.__report;
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  app.ctx.navigation.navigate("#household");
  const open = app.pages.get("household").querySelector(".hub-report-problem");
  check(Boolean(open) && !open.hidden, "Household offers Report a problem");
  open.click();
  await wait(() => dialog()?.open && dialog().dataset.step === "form", "the report dialog opens");
  check(document.activeElement === dialog().querySelector("h2"), "focus starts on the dialog's heading");
  check(dialog().querySelector("#report-include-shot")?.checked === false, "the screenshot is off by default");
  check(fits(), `the dialog fits ${innerWidth} px without sideways scrolling`);
  type("happened", "The shopping list froze after I added milk.");
  type("expected", "It should save and show the milk.");
  button("Review what will be sent").click();
  await wait(() => dialog().dataset.step === "preview" && dialog().querySelector('.report-details li[data-key="version"]'), "the preview with details");
  check(/Kin team/.test(dialog().querySelector(".report-destination").textContent), "the preview says where it goes");
  check(dialog().querySelector(".report-typed").textContent.includes("froze after I added milk"), "the preview shows what was typed");
  const keys = [...dialog().querySelectorAll(".report-details li")].map((row) => row.dataset.key);
  for (const key of ["version", "browser", "os", "page", "online"]) check(keys.includes(key), `the preview lists ${key}`);
  check(dialog().querySelector('.report-details li[data-key="page"] .report-detail-value').textContent === "household", "the page is a route name");
  check(!dialog().textContent.includes(app.household.identity.memberId) && !dialog().textContent.includes(app.household.identity.householdId), "no IDs in the preview");
  dialog().querySelector('.report-details li[data-key="browser"] .report-remove').click();
  await wait(() => !dialog().querySelector('.report-details li[data-key="browser"]'), "the browser row is removed");
  check(/Browser removed/.test(dialog().querySelector(".report-status").textContent), "the removal is announced");
  check(dialog().contains(document.activeElement) && document.activeElement !== document.body, "focus stays in the dialog");
  button("Send").click();
  await wait(() => dialog().dataset.step === "done", "sent");
  const reference = dialog().querySelector(".report-reference-number").textContent;
  check(dialog().querySelector("h2").textContent === "Sent", "it says Sent");
  check((await app.ctx.report.outbox.list()).length === 0, "nothing waits in the outbox");
  button("Done").click();
  await wait(() => !dialog().open, "the dialog closes");
  return { checks: checks.length, reference };
}

async function reportWithScreenshot() {
  const { app, wait, dialog, button, type } = window.__report;
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  app.ctx.navigation.navigate("#today");
  app.ctx.report.open("problem");
  await wait(() => dialog()?.open, "the dialog opens");
  type("happened", "The Today page looks wrong.");
  const box = dialog().querySelector("#report-include-shot");
  box.checked = true;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => dialog().querySelector(".report-shot-preview img")?.complete && dialog().querySelector(".report-shot-preview img").naturalWidth > 0 ||
    dialog().querySelector(".report-shot .error-message"), "the picture is taken", 30_000);
  const failed = dialog().querySelector(".report-shot .error-message")?.textContent;
  if (failed) throw new Error(`The screenshot failed (${app.ctx.report.element().shotErrorCode}): ${failed}`);
  check(/can show private things/.test(dialog().querySelector(".report-warning").textContent), "the picture comes with a warning");
  const before = app.ctx.report.element().shot.crop;
  const top = [...dialog().querySelectorAll(".report-trim input")][1];
  top.value = "50";
  top.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => app.ctx.report.element().shot?.crop?.y > 0, "the crop applies");
  const after = app.ctx.report.element().shot.crop;
  check(after.height < before.height && after.y > 0, "cropping keeps the lower half");
  const encodedHeight = app.ctx.report.element().shot.height;
  button("Review what will be sent").click();
  await wait(() => dialog().dataset.step === "preview" && dialog().querySelector(".report-shot-thumb"), "the preview shows the picture");
  check(/never posted to the issue tracker/.test(dialog().textContent), "the preview says the picture stays on the service");
  button("Send").click();
  await wait(() => dialog().dataset.step === "done", "sent with the picture");
  const reference = dialog().querySelector(".report-reference-number").textContent;
  check(!app.ctx.report.element().shot, "the picture is dropped from memory once sent");
  button("Done").click();
  return { checks: checks.length, reference, height: encodedHeight };
}

async function reportWhileOffline() {
  const { app, wait, dialog, button, type } = window.__report;
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  app.ctx.report.open("problem");
  await wait(() => dialog()?.open, "the dialog opens");
  type("happened", "Sent from the train.");
  button("Review what will be sent").click();
  await wait(() => dialog().dataset.step === "preview", "the preview");
  button("Send").click();
  await wait(() => dialog().dataset.step === "done", "saved");
  check(dialog().querySelector("h2").textContent === "Saved to send", "offline, it is saved to send");
  check(/will be sent when Kin can reach the service/.test(dialog().textContent), "and says it will go later");
  const reference = dialog().querySelector(".report-reference-number").textContent;
  check((await app.ctx.report.outbox.list()).some((item) => item.reference === reference), "it waits in the outbox");
  button("Done").click();
  return { checks: checks.length, reference };
}

async function backOnline({ reference }) {
  const { app, wait } = window.__report;
  window.dispatchEvent(new Event("online"));
  await wait(async () => !(await app.ctx.report.outbox.list()).some((item) => item.reference === reference), "the outbox sends once online");
  return 1;
}

async function suggestSomething() {
  const { app, wait, dialog, button, type } = window.__report;
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  app.ctx.navigation.navigate("#household/features");
  await wait(() => !app.suggestSection.hidden, "Suggest something shows for the admin");
  check(app.pages.get("household").querySelector(".features-page").contains(app.suggestSection), "Household › Features offers Suggest something to an admin");
  app.suggestSection.querySelector(".suggest-button").click();
  await wait(() => dialog()?.open && dialog().dataset.mode === "suggestion", "the suggestion form");
  button("Review what will be sent").click();
  await wait(() => /Write what you'd like first/.test(dialog().querySelector(".report-alert").textContent), "the wish is needed");
  check(true, "an empty suggestion is caught in plain words");
  type("wish", "A pantry list");
  type("why", "We keep running out of rice.");
  button("Review what will be sent").click();
  await wait(() => dialog().dataset.step === "preview" && dialog().querySelector('.report-details li[data-key="version"]'), "the suggestion's preview");
  check([...dialog().querySelectorAll(".report-details li")].map((row) => row.dataset.key).join() === "version", "a suggestion carries only the Kin version");
  button("Send").click();
  await wait(() => dialog().dataset.step === "done", "suggested");
  const reference = dialog().querySelector(".report-reference-number").textContent;
  button("Done").click();
  return { checks: checks.length, reference };
}

async function whatIveSent({ planned, received }) {
  const { app, wait, dialog } = window.__report;
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  app.ctx.navigation.navigate("#household");
  app.pages.get("household").querySelector(".hub-feedback-sent").click();
  const row = (reference) => dialog().querySelector(`.report-sent li[data-reference="${reference}"]`);
  await wait(() => row(planned) && row(received), "both are listed");
  check(row(planned).querySelector(".report-sent-status").textContent === "Planned", "the status the team set shows");
  check(row(received).querySelector(".report-sent-status").textContent === "Received", "a new report is Received");
  check(row(planned).querySelector(".report-sent-kind").textContent === "Suggestion", "kinds are named");
  check(window.__report.fits(), "What I've sent fits without sideways scrolling");
  dialog().close();
  return checks.length;
}

async function otherWaysIn() {
  const { app, wait, dialog } = window.__report;
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  // The keyboard help.
  app.commandPalette.openHelp();
  const helpButton = [...app.commandPalette.help.querySelectorAll("button")].find((node) => node.textContent === "Report a problem");
  check(Boolean(helpButton), "the keyboard help offers Report a problem");
  helpButton.click();
  await wait(() => dialog()?.open && dialog().dataset.mode === "problem" && !app.commandPalette.help.open, "the help hands over to the report");
  dialog().close();
  // Help (#616) fires this event.
  window.dispatchEvent(new CustomEvent("kin:report-problem"));
  await wait(() => dialog()?.open, "kin:report-problem opens it");
  dialog().close();
  // Every error message.
  app.ctx.status.showAlert("Kin could not complete that action.");
  check(!app.reportButton.hidden, "an error message offers Report a problem");
  app.ctx.status.clearAlert();
  check(app.reportButton.hidden, "and it goes with the message");
  return checks.length;
}

async function reportWhileLocked() {
  const { app, wait, dialog, button, type } = window.__report;
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  // A draft with a picture is dropped by the lock.
  app.ctx.report.open("problem");
  await wait(() => dialog()?.open, "a draft opens");
  type("happened", "Something private about the family.");
  app.ctx.session.lockHousehold();
  await wait(() => app.security.querySelector(".security-report-button"), "the lock screen");
  check(!dialog().open, "locking closes the report");
  app.security.querySelector(".security-report-button").click();
  await wait(() => dialog()?.open && dialog().dataset.step === "form", "the report opens on the lock screen");
  check(dialog().querySelector('textarea[name="happened"]').value === "", "the draft did not survive the lock");
  type("happened", "I can't unlock on this phone.");
  button("Review what will be sent").click();
  await wait(() => dialog().dataset.step === "preview" && dialog().querySelector('.report-details li[data-key="page"]'), "the preview");
  check(dialog().querySelector('.report-details li[data-key="page"] .report-detail-value').textContent === "locked", "the page is the lock screen");
  check(dialog().querySelector('.report-details li[data-key="signedIn"] .report-detail-value').textContent === "No", "and not signed in");
  button("Send").click();
  await wait(() => dialog().dataset.step === "done", "sent while locked");
  const reference = dialog().querySelector(".report-reference-number").textContent;
  button("Done").click();
  return { checks: checks.length, reference };
}

export async function reportProblemRegressions({ endpoint, browserClient }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store, feedbackGithub: false });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  const pages = [];
  try {
    const founderPage = await isolatedPage(endpoint, browserClient, origin);
    pages.push(founderPage);
    const page = founderPage.client;
    await waitForOrigin(page.evaluate, origin, { navigate: () => page.send("Page.navigate", { url: origin }) });
    await setViewport(page, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const created = await page.evaluate(`(${createHousehold.toString()})(${JSON.stringify(FOUNDER)})`);
    await page.evaluate(`(${installHelpers.toString()})()`);
    let checks = 0;
    // A phone-width report, with a detail removed.
    await setViewport(page, { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
    const first = await page.evaluate(`(${reportWithRemovedDetail.toString()})()`);
    checks += first.checks;
    assert.match(first.reference, REFERENCE_PATTERN);
    const stored = kin.feedbackService.show(first.reference);
    assert.equal(stored.memberId, created.identity.memberId, "a signed-in report is linked to its member");
    assert.equal(stored.report.text.happened, "The shopping list froze after I added milk.");
    assert.equal(stored.report.diagnostics.browser, undefined, "the removed detail was not sent");
    assert.equal(stored.report.diagnostics.page, "household");
    assert.equal(stored.status, "received");
    checks += 5;
    // With a cropped picture.
    await setViewport(page, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const second = await page.evaluate(`(${reportWithScreenshot.toString()})()`);
    checks += second.checks;
    const shot = store.feedbackScreenshot(second.reference);
    assert.ok(shot, "the picture is on the service");
    assert.ok(shot.bytes.length <= 1024 * 1024, "at most 1 MiB");
    assert.equal(sniffImageType(new Uint8Array(shot.bytes)), shot.type, "its bytes are the image type it says");
    assert.equal(shot.type, "image/png");
    assert.equal(shot.bytes.readUInt32BE(20), second.height, "the cropped height was sent");
    checks += 5;
    // Offline: the outbox keeps it, then sends it.
    await page.send("Network.enable");
    await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const offline = await page.evaluate(`(${reportWhileOffline.toString()})()`);
    checks += offline.checks;
    assert.equal(kin.feedbackService.show(offline.reference), null, "nothing reached the service while offline");
    await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    checks += await page.evaluate(`(${backOnline.toString()})(${JSON.stringify({ reference: offline.reference })})`);
    await eventually(() => kin.feedbackService.show(offline.reference), "the offline report arrives");
    checks += 1;
    // An admin's suggestion, its status set the way the operator's command
    // does (server/admin.mjs feedback-set-status), and What I've sent.
    const idea = await page.evaluate(`(${suggestSomething.toString()})()`);
    checks += idea.checks;
    const suggestion = kin.feedbackService.show(idea.reference);
    assert.equal(suggestion.kind, "suggestion");
    assert.deepEqual(suggestion.report.text, { wish: "A pantry list", why: "We keep running out of rice." });
    assert.equal(kin.feedbackService.setStatus(idea.reference, "planned"), true);
    checks += 3;
    await setViewport(page, { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
    checks += await page.evaluate(`(${whatIveSent.toString()})(${JSON.stringify({ planned: idea.reference, received: first.reference })})`);
    await setViewport(page, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    checks += await page.evaluate(`(${otherWaysIn.toString()})()`);
    // Locked: a report without signing in.
    const locked = await page.evaluate(`(${reportWhileLocked.toString()})()`);
    checks += locked.checks;
    const anonymous = kin.feedbackService.show(locked.reference);
    assert.equal(anonymous.memberId, null, "a report from the lock screen is linked to nobody");
    assert.equal(anonymous.householdId, null);
    assert.equal(anonymous.report.diagnostics.page, "locked");
    checks += 3;
    return `PASS ${checks} report and suggestion checks`;
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
  assert.ok(executable, "Usage: node scripts/report-problem-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-report-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await reportProblemRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("report problem regression");
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
