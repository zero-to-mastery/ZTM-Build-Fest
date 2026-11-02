// Google Play Store screenshots (#540, epic #527), taken from the real Kin:
// the production server in this process (in-memory database) and a headless
// Chrome or Edge, as the browser regressions run it. Two members set up a
// demo household through the real password flow (Robin creates it, Sam joins
// by invitation), fill it with made-up household things, and the script
// captures Today, Shopping, This week, Chat and the journal on a phone and on
// 7- and 10-inch tablets:
//
//   phone     360 × 640 CSS px at 3×   → 1080 × 1920 (9:16)
//   tablet7   720 × 1280 CSS px at 1.5× → 1080 × 1920 (9:16), tablet layout
//   tablet10  1280 × 720 CSS px at 2×   → 2560 × 1440 (16:9)
//
// Play wants 16:9 or 9:16 screenshots with no alpha channel, so each PNG is
// re-encoded as 24-bit RGB (scripts/render-icons.mjs's encoder). All text is
// invented; nothing comes from a real household.
//
//   node scripts/play-screenshots.mjs <browser executable> [--out <directory>]
//
// The default directory is target/play-screenshots/ (ignored). CI runs this
// on request only (Run workflow → play-screenshots job) and uploads the files
// as the `kin-play-screenshots` artifact; see docs/PLAY-LISTING.md.
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { captureFailure, waitForOrigin } from "./cdp-page.mjs";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";
import {
  approveWithPassword, createHousehold, eventually, finishJoining, invite, isolatedPage, joinByInvitation, pageClient,
} from "./first-run-regression.mjs";
import { decodePng, encodePng } from "./render-icons.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Made-up people. Passwords pass Kin's strength rules; they exist only in
// this run's in-memory database.
export const ROBIN = { name: "Robin", household: "The Rivera house", username: "robin.rivera", password: "copper lantern orchard" };
export const SAM = { name: "Sam", username: "sam.rivera", password: "maple harbor ribbon" };

export const DEVICES = Object.freeze([
  { name: "phone", width: 360, height: 640, deviceScaleFactor: 3, mobile: true, pixels: [1080, 1920] },
  { name: "tablet7", width: 720, height: 1280, deviceScaleFactor: 1.5, mobile: true, pixels: [1080, 1920] },
  { name: "tablet10", width: 1280, height: 720, deviceScaleFactor: 2, mobile: false, pixels: [2560, 1440] },
]);

export const SCREENS = Object.freeze([
  { name: "today", hash: "#today", ready: "!app.pages.get('today').hidden", anchor: "app.today" },
  { name: "shopping", hash: "#lists/shopping", ready: "!app.pages.get('lists').hidden && app.shopping.textContent.includes('Bananas')", anchor: "[...document.querySelectorAll('main *')].find((node) => !node.children.length && node.textContent === 'Milk' && node.getClientRects().length)" },
  { name: "week", hash: "#week", ready: "!app.pages.get('week').hidden && app.week.querySelectorAll('.week-day').length === 7" },
  { name: "chat", hash: "#updates/chat", ready: "!app.pages.get('updates').hidden && app.chat.querySelectorAll('.chat-text').length >= 4" },
  { name: "journal", hash: "#journal", ready: "!app.pages.get('journal').hidden && app.journal.querySelectorAll('.journal-entry').length >= 2" },
]);

// ---- In-page steps (stringified and run in the browser) ---------------------

/** Robin's household things: plans for today and the week, a routine and a
 * shopping list. Uses the same commands as the Today and Lists composers. */
async function fillHousehold() {
  const app = document.querySelector("kin-app");
  const settle = async (label) => {
    for (let i = 0; i < 2400; i++) {
      if (!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Kin stayed busy: ${label}`);
  };
  const today = app.ctx.navigation.currentCivilDate();
  const days = (await app.store.week(today)).map((day) => day.date);
  const add = async (text, classification, planningDate = null) => {
    await app.ctx.items.handleAddItem({ detail: { text, classification, planningDate } });
    await settle(text);
    if (!app.state.items.some((item) => item.text === text)) throw new Error(`Not added: ${text}`);
  };
  // createHousehold added "Milk" as a to-do; it belongs on Shopping.
  const milk = app.state.items.find((item) => item.text === "Milk");
  if (milk) { await app.ctx.items.handleItemAction("archive", milk.itemId); await settle("archive Milk"); }
  for (const [text, day] of [
    ["Call the dentist about Thursday", 0], ["Pack Maya's swim bag", 0], ["Pay the water bill", 0],
    ["Parent–teacher meeting, 4:30", 1], ["Take the bins out", 2], ["Grandma visits for lunch", 3],
    ["Return library books", 4], ["Soccer pickup at 5", 5],
  ]) await add(text, "need", days[day]);
  for (const text of ["Milk", "Eggs", "Bananas", "Sourdough bread", "Dish soap", "Coffee filters", "Swim cap for Maya"]) await add(text, "shopping");
  await app.ctx.routines.saveRoutine({ type: "create-routine", text: "Feed the cat", cadence: "daily" });
  await settle("routine");
  await app.ctx.routines.saveRoutine({ type: "create-routine", text: "Water the plants", cadence: "weekly" });
  await settle("routine");
  app.ctx.undo?.clear?.();
  return app.state.items.length;
}

/** One chat message from this page's member, then waits until the room
 * holds `expected` messages. It first waits for the `expected - 1` before
 * it, so each message reaches the relay after the previous one and the
 * conversation keeps its order. */
async function sendChat({ text, expected }) {
  const app = document.querySelector("kin-app");
  const wait = async (condition, label, ms = 120_000) => {
    for (let i = 0, step = 50; i < ms / step; i++) {
      if (await condition()) return;
      // Sparingly: a pass is many requests, and Kin limits each device to
      // a budget per minute. The live channel brings most messages at once.
      if (i % 160 === 159) void app.syncCoordinator?.syncNow();
      await new Promise((r) => setTimeout(r, step));
    }
    throw new Error(`Chat wait timed out: ${label}; room=${Boolean(app.chat?.room)} access=${app.chatAccess}`);
  };
  await wait(() => app.chat?.room, "the chat room opens");
  const room = app.chat.room;
  await wait(() => room.page({ limit: 50 }).total >= expected - 1, `${expected - 1} earlier messages`);
  if (text) {
    await room.send(text);
    void app.syncCoordinator?.syncNow();
  }
  await wait(() => room.page({ limit: 50 }).total >= expected, `${expected} messages`);
  return room.page({ limit: 50 }).total;
}

/** Two journal entries in Robin's private journal. */
async function writeJournal() {
  const app = document.querySelector("kin-app");
  const wait = async (condition, label, ms = 60_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (await condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Journal wait timed out: ${label}; status=${app.ctx.journal?.status()}`);
  };
  app.ctx.navigation.navigate("#journal");
  void app.syncCoordinator?.syncNow();
  await wait(() => app.ctx.journal.status() === "ready" && !app.journal.workspace.hidden, "the journal opens");
  const page = app.journal;
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const now = new Date();
  const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  for (const [date, title, body] of [
    [iso(earlier), "First swim lesson", "Maya put her face in the water three times and came out grinning. Sam cheered louder than anyone."],
    [iso(now), "Park day", "Swings, then cocoa at the café. She laughed the whole way home."],
  ]) {
    page.newButton.click();
    type(page.dateInput, date);
    type(page.titleInput, title);
    type(page.bodyInput, body);
    page.saveButton.click();
    await wait(() => [...page.querySelectorAll(".journal-entry")].some((node) => node.textContent.includes(title)), title);
  }
  page.undoBar?.querySelector?.(".journal-undo-dismiss")?.click?.();
  return page.querySelectorAll(".journal-entry").length;
}

/** Shows one screen, calm: no one-time offers, toasts or focus rings. */
async function showScreen({ hash }, isReady, anchorOf) {
  const app = document.querySelector("kin-app");
  app.passkeyPromptDismissed = true;
  app.ctx.navigation.navigate(hash);
  // Settled, and the header says "Up to date" rather than "Syncing…".
  const synced = () => !document.querySelector("kin-sync-status") || document.querySelector("kin-sync-status").state === "ready";
  for (let i = 0; i < 2400; i++) {
    if (!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && isReady(app) && synced()) break;
    if (i === 2399) throw new Error(`${hash} didn't settle; sync=${document.querySelector("kin-sync-status")?.state}`);
    if (i % 320 === 160) void app.syncCoordinator?.syncNow();
    await new Promise((r) => setTimeout(r, 25));
  }
  // One-time cards (a passkey suggestion, a catch-up summary) and toasts are
  // real, but not what a listing should show.
  const later = [...(app.onboarding?.querySelectorAll("button") ?? [])].find((button) => /^Not now$/.test(button.textContent));
  later?.click();
  if (app.onboarding) app.onboarding.hidden = true;
  // The demo's own setup fills "Since you last looked"; mark it caught up.
  const caughtUp = app.catchUp?.button;
  if (caughtUp && !caughtUp.hidden && !caughtUp.disabled && caughtUp.getClientRects().length) {
    caughtUp.click();
    for (let i = 0; i < 400 && (app.busy || app.refreshing || app.pendingRefresh || app.wakePending); i++) await new Promise((r) => setTimeout(r, 25));
  }
  app.ctx.undo?.clear?.();
  if (app.status) app.status.textContent = "";
  for (const composer of document.querySelectorAll("kin-compose")) composer.clearResult?.();
  for (const details of document.querySelectorAll("details.list-actions")) details.open = false;
  document.activeElement?.blur?.();
  scrollTo(0, 0);
  for (const scroller of document.querySelectorAll(".chat-scroll")) scroller.scrollTop = scroller.scrollHeight;
  // Let the page finish what navigating started (it may move focus or the
  // scroll position) before placing the view.
  await new Promise((r) => setTimeout(r, 300));
  // When the screen's main content (Today's list, Shopping's first row)
  // starts below the top quarter, as behind a composer on a phone, scroll it
  // up to there, keeping a little of what is above it for context. Checked
  // again after a moment, in case the page moved it back.
  let anchor = null, top = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    anchor = anchorOf(app);
    top = anchor?.getBoundingClientRect().top ?? 0;
    if (top <= innerHeight * 0.3) break;
    scrollBy(0, top - innerHeight * 0.25);
    await new Promise((r) => setTimeout(r, 200));
  }
  const scrolled = `[anchor ${anchor ? Math.round(anchor.getBoundingClientRect().top) : "none"}, scrolled ${Math.round(scrollY)}] `;
  if (app.security?.phase !== "unlocked") throw new Error(`Kin is ${app.security?.phase} on ${hash}`);
  // What the picture shows, in words, for the log: the text on screen.
  const seen = [];
  const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && seen.join(" | ").length < 700; node = walker.nextNode()) {
    const text = node.textContent.trim();
    const rect = node.parentElement?.getBoundingClientRect();
    if (!text || !rect || !rect.width || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
    if (node.parentElement.closest("[hidden], .visually-hidden, .skip-link, details:not([open]) > :not(summary)")) continue;
    if (getComputedStyle(node.parentElement).visibility === "hidden") continue;
    seen.push(text.replace(/\s+/g, " ").slice(0, 60));
  }
  return scrolled + seen.join(" | ");
}

// ---- Capture ----------------------------------------------------------------------

/** A browser PNG as 24-bit RGB (Play refuses alpha), checked for its size. */
export function playPng(bytes, [width, height]) {
  const image = decodePng(bytes);
  if (image.width !== width || image.height !== height)
    throw new Error(`The screenshot is ${image.width} × ${image.height}, not ${width} × ${height}.`);
  if (image.channels === 3) return encodePng(width, height, image.pixels, { channels: 3 });
  const rgb = new Uint8Array(width * height * 3);
  // The page is opaque; any transparency is composited over white.
  for (let source = 0, target = 0; source < image.pixels.length; source += 4, target += 3) {
    const alpha = image.pixels[source + 3] / 255;
    for (let channel = 0; channel < 3; channel++) rgb[target + channel] = Math.round(image.pixels[source + channel] * alpha + 255 * (1 - alpha));
  }
  return encodePng(width, height, rgb, { channels: 3 });
}

export async function playScreenshots({ endpoint, browserClient, outDir }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  const pages = [];
  const written = [];
  try {
    await mkdir(outDir, { recursive: true });
    // Robin creates the household; Sam joins by invitation.
    const robinPage = await isolatedPage(endpoint, browserClient, origin);
    pages.push(robinPage);
    const robin = robinPage.client;
    await waitForOrigin(robin.evaluate, origin, { navigate: () => robin.send("Page.navigate", { url: origin }) });
    await setViewport(robin, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await robin.evaluate(`(${createHousehold.toString()})(${JSON.stringify(ROBIN)})`);
    const code = await robin.evaluate(`(${invite.toString()})()`);
    const samPage = await isolatedPage(endpoint, browserClient, `${origin}/pair#code=${code}`);
    pages.push(samPage);
    const sam = samPage.client;
    await waitForOrigin(sam.evaluate, origin, { navigate: () => sam.send("Page.navigate", { url: `${origin}/pair#code=${code}` }) });
    await sam.evaluate(`(${joinByInvitation.toString()})(${JSON.stringify(SAM)}, ${JSON.stringify(ROBIN.username)})`);
    await robin.evaluate(`(${approveWithPassword.toString()})(${JSON.stringify(ROBIN)})`);
    const joined = await sam.evaluate(`(${finishJoining.toString()})(${JSON.stringify(SAM)})`);
    await eventually(() => store.accountVault(joined.identity.householdId, joined.identity.memberId), "Sam's account");
    console.log("Demo household: Robin and Sam");

    console.log(`Household things: ${await robin.evaluate(`(${fillHousehold.toString()})()`)} items`);
    // A short, interleaved conversation.
    const conversation = [
      [sam, "Picked up the dry cleaning on the way back 👍"],
      [robin, "Thank you! Could you grab milk and bananas too? They're on the list."],
      [sam, "On it. Anything else for Maya's swim lesson?"],
      [robin, "Her swim cap. The old one finally split."],
      [sam, "Got it. Home by 6."],
    ];
    for (const [index, [client, text]] of conversation.entries()) {
      await client.send("Page.bringToFront").catch(() => {});
      await client.evaluate(`(${sendChat.toString()})(${JSON.stringify({ text, expected: index + 1 })})`);
    }
    await robin.evaluate(`(${sendChat.toString()})(${JSON.stringify({ text: "", expected: conversation.length })})`);
    console.log(`Journal entries: ${await robin.evaluate(`(${writeJournal.toString()})()`)}`);

    // Sam's page isn't needed for the pictures.
    sam.close();
    await browserClient.send("Target.disposeBrowserContext", { browserContextId: samPage.browserContextId }).catch(() => {});
    pages.pop();

    await setMedia(robin, [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }]);
    await robin.send("Emulation.setScrollbarsHidden", { hidden: true }).catch(() => {});
    await robin.send("Page.bringToFront").catch(() => {});
    for (const device of DEVICES) {
      const { name, pixels, ...metrics } = device;
      await setViewport(robin, metrics);
      const seen = [];
      for (const [index, screen] of SCREENS.entries()) {
        const text = await robin.evaluate(`(${showScreen.toString()})(${JSON.stringify(screen)}, (app) => ${screen.ready}, (app) => ${screen.anchor ?? "null"})`);
        // Let layout and fonts finish for the new size before capturing.
        await delay(150);
        const { data } = await robin.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const file = join(outDir, `${name}-${index + 1}-${screen.name}.png`);
        await writeFile(file, playPng(Buffer.from(data, "base64"), pixels));
        written.push(file);
        seen.push(`${screen.name}: ${text}`);
      }
      console.log(`${name}: ${SCREENS.length} screenshots at ${pixels.join(" × ")}\n  ${seen.join("\n  ")}`);
      // In CI, what each picture shows also goes into a notice the checks
      // API returns, since the job log and artifacts may not be readable.
      if (process.env.GITHUB_ACTIONS)
        console.log(`::notice title=Play screenshots (${name})::${seen.join("\n").replace(/%/g, "%25").replace(/\r?\n/g, "%0A").slice(0, 3800)}`);
    }
    return written;
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
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const outDir = resolve(outAt >= 0 ? args[outAt + 1] ?? "" : join(PROJECT_ROOT, "target", "play-screenshots"));
  const executable = args.find((arg, index) => !arg.startsWith("--") && (outAt < 0 || index !== outAt + 1));
  assert.ok(executable && (outAt < 0 || args[outAt + 1]), "Usage: node scripts/play-screenshots.mjs <browser executable> [--out <directory>]");
  const profile = await mkdtemp(join(tmpdir(), "kin-play-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars",
    // Two members' pages take turns; neither may be throttled as a background tab.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  let failed = false;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    console.log(`Browser: ${version.Browser}; Node: ${process.version}`);
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    const files = await playScreenshots({ endpoint, browserClient, outDir });
    console.log(`PASS ${files.length} Play screenshots in ${outDir}`);
  } catch (error) {
    failed = true;
    await captureFailure("play screenshots");
    console.error(error);
  } finally {
    browserClient?.close();
    browser.kill();
    await delay(300);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the temporary profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  process.exit(failed ? 1 : 0);
}
