// A personal journal (#496: #497, #501, #504, #507), in a real browser
// against the production Kin server, through the real password flow (#557):
// the founder creates a household with a password, which keeps the account
// vault key on the device, so private storage opens. Then, on the Journal
// page reached from Household: write (draft kept, focus), edit, delete and
// Undo; a photo added, removed with Undo, saved, shown as a thumbnail and
// opened in the viewer; search, a month jump and On this day; a share and
// the New journal entry shortcut opening the editor; nothing in household
// state; 320 px without sideways scrolling. The entries are sealed in the
// founder's private stream and blobs on the service, survive a lock and a
// password unlock, and a second member who joins with a password sees an
// empty journal and can't fetch the founder's photo.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/journal-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { captureFailure, waitForOrigin } from "./cdp-page.mjs";
import { setViewport } from "./cdp-viewport.mjs";
import {
  FOUNDER, PARTNER, approveWithPassword, createHousehold, eventually, finishJoining, invite, isolatedPage, joinByInvitation,
  lockAndUnlock, pageClient,
} from "./first-run-regression.mjs";
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

// How long a killed browser gets to let go of its profile.
const SETTLE_MS = 300;

// ---- In-page steps (stringified and run in the browser) ---------------------

async function writeInJournal() {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const app = document.querySelector("kin-app");
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (await condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; journal=${app.ctx.journal?.status()} reason=${app.ctx.journal?.journal?.reason} page=${app.journal?.textContent?.slice(0, 300)}`);
  };
  // Timers, not animation frames: this page is a background target in its
  // own browser context, where frames may be throttled or paused.
  const frame = () => new Promise((r) => setTimeout(() => setTimeout(r, 0), 0));
  const page = app.journal;
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const lastYear = `${now.getFullYear() - 1}-${today.slice(5)}`.replace(/-02-29$/, "-02-28");
  const older = `${now.getFullYear() - 2}-01-15`;
  const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const entryNode = (text) => [...page.querySelectorAll(".journal-entry")].find((node) => node.textContent.includes(text));
  const fits = () => document.documentElement.scrollWidth <= innerWidth;

  // Reached from Household, not a sixth destination.
  app.ctx.navigation.navigate("#household");
  const link = app.pages.get("household").querySelector('a.journal-hub-link[href="#journal"]');
  check(Boolean(link) && /Only you can see/.test(link.textContent), "Household offers the journal under Just for you");
  check(app.nav.querySelectorAll(".nav-link").length === 5 && !app.nav.querySelector('[data-page="journal"]'), "the five destinations are unchanged");
  link.click();
  await frame();
  check(location.hash === "#journal" && !app.pages.get("journal").hidden, "the link opens the Journal page");
  check(app.navLinks.get("household").getAttribute("aria-current") === "page", "the journal marks Household in the navigation");
  // Private storage opens once the vault key is on the device (#557).
  void app.syncCoordinator?.syncNow();
  await wait(() => app.ctx.journal.status() === "ready" && !page.workspace.hidden, "the journal opens", 60_000);
  check(page.querySelector(".journal-only-you")?.textContent === "Only you can see this.", "the page says only you can see it");
  check(/only your own devices can read it/.test(page.empty.textContent), "the empty journal explains its privacy in one sentence");
  check(fits(), `the journal fits ${innerWidth} px without sideways scrolling`);
  check(!app.journal.querySelector('input[type="file"]'), "the journal keeps no file input of its own (one is made only while the picker is open)");

  // Write: today by default; the draft is kept when the editor closes.
  page.newButton.click();
  check(!page.editor.hidden && document.activeElement === page.bodyInput, "New entry opens the editor with focus in the body");
  check(page.dateInput.value === today, "a new entry is dated today");
  typeInto(page.titleInput, "Park day");
  typeInto(page.bodyInput, "Swings, then cocoa.\nShe laughed the whole way home.");
  page.editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(page.editor.hidden && document.activeElement === page.newButton, "Escape closes the editor and returns focus");
  check(!page.draftNote.hidden && page.newButton.textContent === "Continue your draft", "the draft is kept while Kin is unlocked");
  page.newButton.click();
  check(page.titleInput.value === "Park day" && page.bodyInput.value.includes("She laughed"), "the draft comes back");
  page.saveButton.click();
  await wait(() => entryNode("She laughed"), "the entry is saved");
  await wait(() => document.activeElement === entryNode("She laughed"), "focus moves to the saved entry", 5_000);
  check(true, "focus moves to the saved entry");
  check(entryNode("She laughed").querySelector(".journal-entry-body").textContent === "Swings, then cocoa.\nShe laughed the whole way home.", "line breaks are kept");
  check(page.list.querySelector(".journal-day h2")?.textContent.includes(String(now.getFullYear())), "entries sit under date headings");
  // Earlier days, for On this day and the month jump.
  for (const [date, body] of [[lastYear, "A year ago we planted the apple tree."], [older, "Snow day. Nobody went anywhere."]]) {
    page.newButton.click();
    typeInto(page.dateInput, date);
    typeInto(page.bodyInput, body);
    page.saveButton.click();
    await wait(() => entryNode(body), `the entry from ${date}`);
  }
  const days = [...page.list.querySelectorAll(".journal-day")].map((node) => node.dataset.date);
  check(JSON.stringify(days) === JSON.stringify([today, lastYear, older]), "newest first");
  check(!page.onThisDaySection.hidden && page.onThisDaySection.textContent.includes("1 year ago") &&
    page.onThisDaySection.textContent.includes("apple tree") && !page.onThisDaySection.textContent.includes("Snow day"),
    "On this day shows the same day in an earlier year, on the journal page");

  // Edit.
  [...entryNode("She laughed").querySelectorAll("button")].find((button) => button.textContent === "Edit").click();
  check(page.editorTitle.textContent === "Edit entry" && page.bodyInput.value.startsWith("Swings"), "Edit opens the entry");
  typeInto(page.bodyInput, "Swings, then cocoa at the café.");
  page.saveButton.click();
  await wait(() => entryNode("cocoa at the café"), "the edit is saved");
  check(!entryNode("She laughed"), "the edit replaced the body");

  // Delete and Undo.
  [...entryNode("Snow day").querySelectorAll("button")].find((button) => button.textContent === "Delete").click();
  await wait(() => !entryNode("Snow day") && !page.undoBar.hidden, "the entry is deleted");
  check(document.activeElement === page.undoButton && page.undoText.textContent === "Entry deleted.", "Undo is offered, with focus on it");
  page.undoButton.click();
  await wait(() => entryNode("Snow day"), "the entry is back");
  await wait(() => document.activeElement === entryNode("Snow day"), "Undo puts the entry back and focuses it", 5_000);
  check(true, "Undo puts the entry back and focuses it");
  [...entryNode("Snow day").querySelectorAll("button")].find((button) => button.textContent === "Delete").click();
  await wait(() => !page.undoBar.hidden, "deleted again");
  page.undoBar.querySelector(".journal-undo-dismiss").click();
  check(page.undoBar.hidden && !entryNode("Snow day"), "dismissing Undo leaves it deleted");

  // A photo: added, removed with Undo, saved, a thumbnail, the viewer.
  const canvas = new OffscreenCanvas(64, 48);
  const context = canvas.getContext("2d");
  context.fillStyle = "#3a7"; context.fillRect(0, 0, 64, 48);
  const jpeg = new File([await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })], "garden.jpg", { type: "image/jpeg" });
  page.newButton.click();
  typeInto(page.bodyInput, "The garden at dusk.");
  await page.addPhotos([jpeg]);
  check(page.photoList.querySelectorAll("li").length === 1, "a photo joins the entry");
  page.photoList.querySelector(".journal-photo-remove").click();
  check(page.photoList.querySelectorAll("li").length === 0 && document.activeElement === page.undoButton, "removing a photo offers Undo");
  page.undoButton.click();
  check(page.photoList.querySelectorAll("li").length === 1, "Undo puts the photo back");
  page.saveButton.click();
  await wait(() => entryNode("garden at dusk")?.querySelector(".journal-thumb img"), "the saved entry shows its thumbnail");
  const thumb = entryNode("garden at dusk").querySelector(".journal-thumb");
  check(thumb.querySelector("img").alt === "Photo 1 of 1" && thumb.getAttribute("aria-label") === "Open photo 1 of 1", "the thumbnail is named");
  thumb.click();
  await wait(() => app.viewer.open && app.viewer.viewerImage.src.startsWith("blob:"), "the photo opens in the viewer");
  app.viewer.querySelector(".attachment-viewer-close").click();
  // The viewer hands focus back on its close event, a task of its own.
  await wait(() => !app.viewer.open && document.activeElement?.classList.contains("journal-thumb") &&
    document.activeElement.dataset.photoRef === thumb.dataset.photoRef, "closing the viewer returns focus to the thumbnail", 5_000);
  check(true, "closing the viewer returns focus to the thumbnail");

  // Search and the month jump.
  typeInto(page.search, "COCOA cafe");
  check(page.querySelectorAll(".journal-entry").length === 1 && entryNode("cocoa"), "search finds by words, ignoring case and accents");
  check(page.onThisDaySection.hidden, "On this day steps aside while searching");
  typeInto(page.search, "zebra");
  check(page.empty.textContent === "No entries match “zebra”.", "no match is said plainly");
  typeInto(page.search, "");
  page.month.value = lastYear.slice(0, 7);
  page.month.dispatchEvent(new Event("change"));
  check(document.activeElement?.id === `journal-day-${lastYear}`, "the month jump focuses that month's first day");

  // Sharing into the journal (#508) and the shortcut (#509) open the editor.
  void app.ctx.share.offer({ title: "", text: "A poem from another app", url: "", files: [] });
  await wait(() => app.shareSheet.dialog.open, "the share sheet");
  const toJournal = app.shareSheet.querySelector('button[data-kind="journal"]');
  check(toJournal?.textContent === "Add to my journal", "the share sheet offers the journal");
  toJournal.click();
  await wait(() => !page.editor.hidden && page.bodyInput.value === "A poem from another app", "a share opens a new entry");
  check(location.hash === "#journal", "on the Journal page");
  page.discardButton.click();
  app.ctx.navigation.navigate("#today");
  app.ctx.share.land("new-journal-entry");
  await wait(() => location.hash === "#journal" && !page.editor.hidden, "the shortcut opens the editor");
  check(page.editorTitle.textContent === "New entry" && page.dateInput.value === today, "the shortcut starts a new entry for today");
  page.discardButton.click();
  check(page.draftNote.hidden, "discarding leaves no draft");

  // Never household data: not in the projection, Today or household search.
  const household = JSON.stringify(app.state, (_key, value) => (typeof value === "bigint" ? String(value) : value));
  check(!household.includes("cocoa") && !household.includes("apple tree") && !household.includes("garden"), "nothing of the journal is in household state");
  check(!app.pages.get("today").textContent.includes("cocoa"), "nothing of the journal is on Today");
  check(fits(), "still no sideways scrolling");
  // Sealed and sent before the checks on the service.
  await app.syncCoordinator.syncNow();
  await wait(async () => { await app.syncCoordinator.syncNow(); return !app.syncCoordinator.privateLog.waiting; }, "the private pass sent everything", 60_000);
  const photo = app.ctx.journal.entries().find((entry) => entry.photos.length).photos[0];
  return { checks: checks.length, memberId: app.household.identity.memberId, photoRef: photo.ref, thumbnailRef: photo.thumbnail };
}

async function journalAfterUnlock() {
  const app = document.querySelector("kin-app");
  for (let i = 0, step = 25; i < 2400 && !(app.ctx.journal.status() === "ready" && app.ctx.journal.entries().length === 3); i++) {
    if (i % 40 === 0) void app.syncCoordinator?.syncNow();
    await new Promise((r) => setTimeout(r, step));
  }
  app.ctx.navigation.navigate("#journal");
  const text = app.journal.textContent;
  if (!(text.includes("cocoa at the café") && text.includes("apple tree") && text.includes("garden at dusk")))
    throw new Error(`The journal didn't come back after unlocking: ${app.ctx.journal.status()} ${text.slice(0, 300)}`);
  return 1;
}

async function otherMembersJournal({ photoRef }) {
  const app = document.querySelector("kin-app");
  for (let i = 0, step = 25; i < 2400 && app.ctx.journal.status() !== "ready"; i++) {
    if (i % 40 === 0) void app.syncCoordinator?.syncNow();
    await new Promise((r) => setTimeout(r, step));
  }
  app.ctx.navigation.navigate("#journal");
  const text = app.journal.textContent;
  const response = await fetch(`/api/private/blobs/${photoRef}`);
  return {
    ready: app.ctx.journal.status() === "ready",
    entries: app.ctx.journal.entries().length,
    leaks: ["cocoa", "apple tree", "garden"].filter((word) => text.includes(word) || JSON.stringify(app.state, (_key, value) => (typeof value === "bigint" ? String(value) : value)).includes(word)),
    photoStatus: response.status,
  };
}

// ---- The suite -------------------------------------------------------------------

export async function journalRegressions({ endpoint, browserClient }) {
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
    await setViewport(founder, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const created = await founder.evaluate(`(${createHousehold.toString()})(${JSON.stringify(FOUNDER)})`);
    // The journal at the narrowest supported width.
    await setViewport(founder, { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
    const wrote = await founder.evaluate(`(${writeInJournal.toString()})()`);
    let checks = wrote.checks;
    // On the service: only ciphertext, in the founder's own stream and blobs.
    const events = store.privateRelayState(created.identity.memberId).eventCount;
    assert.ok(events >= 8, `the founder's private stream holds the journal's events (${events})`);
    assert.ok(store.privateBlobBytes(created.identity.memberId, wrote.photoRef), "the photo is in the founder's private blobs");
    assert.ok(store.privateBlobBytes(created.identity.memberId, wrote.thumbnailRef), "and its thumbnail");
    assert.ok(!store.privateBlobBytes(created.identity.memberId, wrote.photoRef).includes(Buffer.from("JFIF")), "sealed, not a JPEG");
    const vault = store.accountVault(created.identity.householdId, created.identity.memberId);
    assert.ok(vault.version >= 3, "the member key went into the founder's vault");
    checks += 5;
    // Locking drops it all; the password unlock opens it again.
    await setViewport(founder, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    checks += await founder.evaluate(`(${lockAndUnlock.toString()})(${JSON.stringify(FOUNDER)})`);
    checks += await founder.evaluate(`(${journalAfterUnlock.toString()})()`);

    // Another member, with a password account of their own, sees none of it.
    const code = await founder.evaluate(`(${invite.toString()})()`);
    const partnerPage = await isolatedPage(endpoint, browserClient, `${origin}/pair#code=${code}`);
    pages.push(partnerPage);
    const partner = partnerPage.client;
    await waitForOrigin(partner.evaluate, origin, { navigate: () => partner.send("Page.navigate", { url: `${origin}/pair#code=${code}` }) });
    await partner.evaluate(`(${joinByInvitation.toString()})(${JSON.stringify(PARTNER)}, ${JSON.stringify(FOUNDER.username)})`);
    await founder.evaluate(`(${approveWithPassword.toString()})(${JSON.stringify(FOUNDER)})`);
    const joined = await partner.evaluate(`(${finishJoining.toString()})(${JSON.stringify(PARTNER)})`);
    await eventually(() => store.accountVault(joined.identity.householdId, joined.identity.memberId), "the partner's vault");
    const seen = await partner.evaluate(`(${otherMembersJournal.toString()})(${JSON.stringify({ photoRef: wrote.photoRef })})`);
    assert.equal(seen.ready, true, "the partner has a journal of their own");
    assert.equal(seen.entries, 0, "and it is empty");
    assert.deepEqual(seen.leaks, [], "nothing of the founder's journal shows for the partner");
    assert.equal(seen.photoStatus, 404, "the partner can't fetch the founder's photo");
    checks += 4;
    return `PASS ${checks} journal checks`;
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
  assert.ok(executable, "Usage: node scripts/journal-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-journal-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await journalRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("journal regression");
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
