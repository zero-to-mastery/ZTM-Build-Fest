import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Comparing earlier and later private readings on-device (#233, ADR 0244): saving a reading as a snapshot,
// following an earlier one, a keyboard-only comparison with no scoring, an article that changed since a
// reading, long and right-to-left text, a large history, storage that is denied, and the page without JavaScript.
// No request leaves the page.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const POST = `---
title: Tides
date: 2026-10-20
---
The moon causes the tides. The sun matters too.

## Methods

We measured the tides twice a day.

## Results

The tides rose again.
`;
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-reflection-history-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Readings",
    url: "https://readings-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    readerAnnotations: { enabled: true },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/tides/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  removeTree(root);
});

const KEY = "openblog.reader-annotations";
const panel = (page) => page.getByRole("region", { name: "Your readings over time" });
const items = (page) => panel(page).locator(".ob-reflection-history-item");
const saved = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEY);

async function open(page) {
  await page.goto(`${origin}/tides/`);
  await page.waitForFunction(() => customElements.get("ob-reflection-history") !== undefined);
  await expect(page.locator(".ob-reflection-history-make")).toBeVisible();
}

async function save(page, text, label) {
  if (label !== undefined) await panel(page).getByLabel("Label (optional, for you)").fill(label);
  await panel(page).getByLabel("Your reading (private)").fill(text);
  await panel(page).getByRole("button", { name: "Save this reading" }).click();
}

test("keyboard: a reader saves two readings, labels one, and compares them without any score, offline", async ({ page }) => {
  const outside = [];
  const after = [];
  let loaded = false;
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) outside.push(request.url());
    else if (loaded) after.push(request.url());
  });
  await open(page);
  await page.waitForLoadState("networkidle");
  loaded = true;
  await expect(page.locator(".ob-reflection-history-static")).toHaveCount(0);
  await expect(panel(page).getByText("No readings saved for this post yet.")).toBeVisible();

  const text = panel(page).getByLabel("Your reading (private)");
  await text.focus();
  await page.keyboard.type("I thought the moon explained it all.");
  await panel(page).getByRole("button", { name: "Save this reading" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toHaveText(/Reading saved\. Saved in this browser\./);
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toBeFocused();
  await expect(items(page).first()).toContainText("Reading 1");
  await expect(items(page).first()).toContainText("The post is as you read it.");
  // A single reading cannot be compared yet.
  await expect(panel(page).getByText("Save a second reading to put it beside the first.")).toBeVisible();

  // The second reading follows the first by default.
  await expect(panel(page).getByLabel("This reading follows")).toHaveValue(/refl/);
  await save(page, "Now I see the sun matters too.", "After the second look");
  await expect(items(page)).toHaveCount(2);
  const doc = await saved(page);
  expect(doc.reflections).toHaveLength(2);
  expect(doc.reflections[1].revises).toBe(doc.reflections[0].id);
  expect(doc.reflections[1]).toMatchObject({ label: "After the second look", provenance: "written", work: { site: origin, path: "/tides/" } });

  // Compare by keyboard.
  await panel(page).getByLabel("One reading").selectOption({ index: 1 });
  await panel(page).getByLabel("Another reading").selectOption({ index: 2 });
  const pair = panel(page).getByRole("group", { name: "The two readings you chose" });
  await expect(pair.locator("article")).toHaveCount(2);
  await expect(pair.locator("article").first()).toContainText("Written first");
  await expect(pair.locator("article").first()).toContainText("I thought the moon explained it all.");
  await expect(pair.locator("article").last()).toContainText("After the second look");
  // Nothing says which is right.
  const words = await pair.innerText();
  expect(words).not.toMatch(/correct|incorrect|score|better|worse|wrong|improv/i);

  // Rename by keyboard; the words are never touched.
  const before = doc.reflections[0].text;
  const rename = items(page).first().getByRole("button", { name: "Add a label to: Reading 1" });
  await rename.focus();
  await page.keyboard.press("Enter");
  const input = items(page).first().getByLabel("Label for Reading 1");
  await expect(input).toBeFocused();
  await page.keyboard.type("First look");
  await page.keyboard.press("Enter");
  await expect(items(page).first()).toContainText("First look");
  await expect(items(page).first().getByRole("button", { name: "Change the label of: First look" })).toBeFocused();
  const renamed = await saved(page);
  expect(renamed.reflections[0]).toMatchObject({ label: "First look", text: before });

  expect(outside).toEqual([]);
  expect(after).toEqual([]);
});

test("an article that changed since a reading is told so, and the reading is never rewritten", async ({ page }) => {
  await open(page);
  await save(page, "Whole post reading.");
  await panel(page).getByRole("radio", { name: "A section" }).check();
  await panel(page).getByLabel("Section for the reading").selectOption({ label: "Methods" });
  await save(page, "Methods reading.");
  await expect(items(page)).toHaveCount(2);
  await page.evaluate((key) => {
    const flip = (value) => value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
    const doc = JSON.parse(localStorage.getItem(key));
    doc.reflections[0].revision = flip(doc.reflections[0].revision);
    doc.reflections[1].target.digest = flip(doc.reflections[1].target.digest);
    localStorage.setItem(key, JSON.stringify(doc));
  }, KEY);
  const tampered = await saved(page);
  await open(page);
  await expect(items(page).first()).toContainText("The post has changed since you wrote this.");
  await expect(items(page).nth(1)).toContainText("Methods reading.");
  await expect(items(page).nth(1)).toContainText("can no longer be found");
  expect(await saved(page)).toEqual(tampered);
});

test("long and right-to-left readings stay in the region on a 320px phone, with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page);
  await save(page, "a".repeat(2000), "x".repeat(150));
  await save(page, "مرحبا بالعالم، هذا رأيي في المد والجزر. ".repeat(40));
  await panel(page).getByLabel("One reading").selectOption({ index: 1 });
  await panel(page).getByLabel("Another reading").selectOption({ index: 2 });
  await expect(panel(page).locator(".ob-reflection-history-column")).toHaveCount(2);
  const overflow = await panel(page).evaluate((region) => region.scrollWidth - region.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(items(page).nth(1).locator(".ob-reflection-history-text")).toHaveAttribute("dir", "auto");
  const motion = await panel(page).evaluate((region) =>
    [...region.querySelectorAll("*")].every((node) => {
      const style = getComputedStyle(node);
      return parseFloat(style.transitionDuration) === 0 && parseFloat(style.animationDuration) === 0;
    }));
  expect(motion).toBe(true);
});

test("a large history lists in order and compares", async ({ page }) => {
  await open(page);
  await save(page, "Reading one.");
  await page.evaluate((key) => {
    const doc = JSON.parse(localStorage.getItem(key));
    const first = doc.reflections[0];
    for (let n = 2; n <= 60; n += 1) {
      doc.reflections.push({ ...first, id: `refl-bulk-${n}`, text: `Reading number ${n}.`, revises: n === 2 ? first.id : `refl-bulk-${n - 1}` });
    }
    localStorage.setItem(key, JSON.stringify(doc));
  }, KEY);
  await open(page);
  await expect(items(page)).toHaveCount(60);
  await expect(items(page).last()).toContainText("Reading number 60.");
  await panel(page).getByLabel("One reading").selectOption({ index: 1 });
  await panel(page).getByLabel("Another reading").selectOption({ index: 60 });
  await expect(panel(page).locator(".ob-reflection-history-column")).toHaveCount(2);
});

test("deleted elsewhere: a cleared store empties the view", async ({ page }) => {
  await open(page);
  await save(page, "Only reading.");
  await expect(items(page)).toHaveCount(1);
  await page.evaluate((key) => {
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }, KEY);
  await expect(items(page)).toHaveCount(0);
  await expect(panel(page).getByText("No readings saved for this post yet.")).toBeVisible();
});

test("storage denied: readings are kept for the visit and the reader is told", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  await open(page);
  await expect(page.getByRole("heading", { name: "Tides", level: 1 })).toBeVisible();
  await expect(panel(page).locator(".ob-reflection-history-notice")).toContainText("does not allow saving");
  await save(page, "Kept in memory.");
  await expect(panel(page).getByRole("status")).toHaveText(/Kept until you leave this page\./);
  await expect(items(page)).toHaveCount(1);
});

test("without JavaScript the post reads as usual and the region says what it needs", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/tides/`);
  await expect(page.getByText("The moon causes the tides.")).toBeVisible();
  await expect(page.locator(".ob-reflection-history-static")).toContainText("needs JavaScript");
  await expect(page.locator(".ob-reflection-history-static")).toContainText("nothing is sent to anyone");
  await expect(page.locator(".ob-reflection-history-make")).toHaveCount(0);
  await context.close();
});

// Export, delete and an explicit copy (#234, ADR 0244).

const trailsPanel = (page) => page.getByRole("region", { name: "Your reading trails and saved sources" });
const HOSTED = "https://hosted.example.org";

async function hostThirdPerspective(page, { receipts = true } = {}) {
  await page.evaluate(({ endpoint, receipts }) => {
    const region = document.createElement("ob-third-perspective");
    region.setAttribute("endpoint", endpoint);
    region.setAttribute("page", "https://readings-site.example.org/tides/");
    region.setAttribute("contact", "mailto:author@example.org");
    if (receipts) region.setAttribute("receipts", "");
    document.body.append(region);
  }, { endpoint: HOSTED, receipts });
}

async function prepare(page, item, { consent = true } = {}) {
  await item.getByRole("button", { name: /^Send a copy for review/ }).click();
  const send = item.getByRole("region", { name: /^Send a copy of/ });
  await expect(send.getByLabel("Prompt (optional)")).toBeFocused();
  if (consent) await send.getByLabel("I agree this reading may be published once a moderator approves it").check();
  await send.getByRole("button", { name: "Preview the copy" }).click();
  return send;
}

test("deleting one reading is confirmed, checked, reconnects the line and leaves the rest", async ({ page }) => {
  await open(page);
  await save(page, "First.");
  await save(page, "Second.");
  await save(page, "Third.");
  await expect(items(page)).toHaveCount(3);
  const before = await saved(page);

  await items(page).nth(1).getByRole("button", { name: "Delete this reading: Reading 2" }).click();
  const confirm = items(page).nth(1).getByRole("group", { name: "Delete Reading 2?" });
  await expect(confirm.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(items(page)).toHaveCount(3);
  expect(await saved(page)).toEqual(before);

  await items(page).nth(1).getByRole("button", { name: "Delete this reading: Reading 2" }).click();
  await items(page).nth(1).getByRole("button", { name: "Yes, delete it" }).click();
  await expect(items(page)).toHaveCount(2);
  await expect(panel(page).getByRole("status")).toHaveText(/Deleted the reading\. 2 readings left for this post\. Checked: it is no longer saved in this browser\./);
  const after = await saved(page);
  expect(after.reflections.map((each) => each.text)).toEqual(["First.", "Third."]);
  expect(after.reflections[1].revises).toBe(after.reflections[0].id);
  expect(JSON.stringify(after)).not.toContain("Second.");
});

test("removing every reading of the post asks first and then empties the view and the store", async ({ page }) => {
  await open(page);
  await save(page, "One.");
  await save(page, "Two.");
  await panel(page).getByRole("button", { name: "Remove all my readings of this post" }).click();
  await expect(panel(page).getByRole("button", { name: "Keep them" })).toBeFocused();
  await panel(page).getByRole("button", { name: "Keep them" }).click();
  await expect(items(page)).toHaveCount(2);
  await panel(page).getByRole("button", { name: "Remove all my readings of this post" }).click();
  await panel(page).getByRole("button", { name: "Yes, remove them all" }).click();
  await expect(items(page)).toHaveCount(0);
  await expect(panel(page).getByRole("status")).toHaveText(/Deleted 2 readings\. 0 readings left for this post\. Checked/);
  expect((await saved(page)).reflections).toEqual([]);
  await expect(panel(page).getByLabel("Your reading (private)")).toBeFocused();
});

test("export leaves readings out and counts them, then includes them when asked", async ({ page }) => {
  await open(page);
  await save(page, "Private words about tides.");
  await save(page, "More private words.");
  const trails = trailsPanel(page);
  await expect(trails.getByText("Kept in this browser: 0 highlights, 0 notes, 0 saved sources, 0 trails, 2 reflections.")).toBeVisible();
  await expect(trails.locator("[id$='-export-describe']")).toContainText("2 reflections left out");
  await trails.getByLabel("Include the text of my notes and source notes").check();
  await expect(trails.locator("[id$='-export-describe']")).not.toContainText("left out");
  await trails.getByText("Show exactly what the file contains").click();
  await expect(trails.getByLabel("The file contents")).toContainText("Private words about tides.");
});

test("a copy is prepared, previewed and only recorded when the reader says they sent it themselves", async ({ page }) => {
  const outside = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) outside.push(request.url());
  });
  await open(page);
  await hostThirdPerspective(page, { receipts: false });
  await save(page, "A private view.", "Secret label");
  const item = items(page).first();

  // Without agreeing to publication nothing is prepared.
  await prepare(page, item, { consent: false });
  await expect(item.getByText("Tick the agreement to offer a copy for publication.")).toBeVisible();
  await expect(item.getByLabel("Exactly what would be sent")).toHaveCount(0);

  const send = item.getByRole("region", { name: /^Send a copy of/ });
  await send.getByLabel("I agree this reading may be published once a moderator approves it").check();
  await send.getByRole("button", { name: "Preview the copy" }).click();
  const preview = send.getByLabel("Exactly what would be sent");
  await expect(preview).toBeVisible();
  const text = await preview.inputValue();
  const copy = JSON.parse(text);
  expect(copy).toMatchObject({ kind: "third-perspective", work: "/tides/", body: "A private view.", consent: { publish: true } });
  expect(text).not.toContain("Secret label");
  expect(text).not.toContain("refl-");
  // The copy names the page's canonical address and offers its contact, not the reader's own URL.
  await send.getByRole("button", { name: "Copy to send myself" }).click();
  await expect(send.getByLabel("The copy to send")).toHaveValue(/Third Perspective on https:\/\/readings-site\.example\.org\/tides\//);
  await expect(send.getByRole("link", { name: "Write to the author" })).toHaveAttribute("href", "mailto:author@example.org");
  // No hosted form on this site: the only send is the reader's own.
  await expect(send.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  expect((await saved(page)).reflections[0].submissions).toBeUndefined();

  // Changing anything takes the preview away.
  await send.getByLabel("Name (optional)").fill("Reader");
  await expect(send.getByLabel("Exactly what would be sent")).toHaveCount(0);
  await send.getByRole("button", { name: "Preview the copy" }).click();
  await send.getByRole("button", { name: "I sent it myself" }).click();
  await expect(item.getByText("Noted. Your reading here is unchanged and still private.")).toBeVisible();
  const doc = await saved(page);
  expect(doc.reflections[0].submissions).toHaveLength(1);
  expect(doc.reflections[0].submissions[0].channel).toBe("copy-and-send");
  expect(doc.reflections[0].text).toBe("A private view.");
  await expect(item).toContainText("1 copy of this reading was sent.");
  expect(outside).toEqual([]);
});

test("sending through the site: a failure records nothing, then success keeps the receipt and records the send", async ({ page }) => {
  let attempts = 0;
  let body;
  await page.route(`${HOSTED}/feedback`, async (route) => {
    attempts += 1;
    body = route.request().postData();
    if (attempts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ receipt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }) });
  });
  await open(page);
  await hostThirdPerspective(page);
  await save(page, "Send this one.");
  const item = items(page).first();
  const send = await prepare(page, item);
  await send.getByRole("button", { name: "Send for review" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(/The copy was not sent: the service had a problem\. Your reading is unchanged and nothing is recorded as sent/);
  expect((await saved(page)).reflections[0].submissions).toBeUndefined();

  await send.getByRole("button", { name: "Send for review" }).click();
  await expect(item.getByText(/A copy was sent for review\./)).toBeVisible();
  expect(JSON.parse(body)).toMatchObject({ kind: "third-perspective", body: "Send this one." });
  const doc = await saved(page);
  expect(doc.reflections[0].submissions).toHaveLength(1);
  expect(doc.reflections[0].submissions[0].channel).toBe("hosted");
  expect(attempts).toBe(2);
});

test("a label change after sending does not touch the words that were sent", async ({ page }) => {
  await open(page);
  await hostThirdPerspective(page, { receipts: false });
  await save(page, "Original words.");
  const item = items(page).first();
  const send = await prepare(page, item);
  const sentText = await send.getByLabel("Exactly what would be sent").inputValue();
  await send.getByRole("button", { name: "I sent it myself" }).click();
  await item.getByRole("button", { name: "Close" }).click();
  await item.getByRole("button", { name: /^Add a label to/ }).click();
  await page.keyboard.type("Renamed");
  await page.keyboard.press("Enter");
  await expect(item).toContainText("Renamed");
  const doc = await saved(page);
  expect(doc.reflections[0].text).toBe("Original words.");
  expect(doc.reflections[0].submissions).toHaveLength(1);
  expect(JSON.parse(sentText).body).toBe("Original words.");
  await expect(item).toContainText("changing or deleting this reading does not change it");
});

test("a post that takes no Third Perspectives offers no send control", async ({ page }) => {
  await open(page);
  await save(page, "Only mine.");
  const item = items(page).first();
  await expect(item.getByRole("button", { name: /^Send a copy for review/ })).toHaveCount(0);
  await expect(item).toContainText("This post does not take Third Perspectives");
  await expect(item.getByRole("button", { name: /^Delete this reading/ })).toBeVisible();
  expect((await saved(page)).reflections[0].submissions).toBeUndefined();
});

async function sendFailure(page, { route, before } = {}) {
  let requests = 0;
  await page.route(`${HOSTED}/feedback`, async (r) => {
    requests += 1;
    if (route) await route(r);
  });
  await open(page);
  await hostThirdPerspective(page);
  await save(page, "Keep me.");
  const item = items(page).first();
  const send = await prepare(page, item);
  if (before) await before();
  await send.getByRole("button", { name: "Send for review" }).click();
  return { send, count: () => requests };
}

test("sending while offline says so, sends nothing and records nothing", async ({ page, context }) => {
  const { send, count } = await sendFailure(page, { before: () => context.setOffline(true) });
  await expect(panel(page).getByRole("status")).toHaveText(/You seem to be offline, so nothing was sent\. Your reading is unchanged/);
  expect(count()).toBe(0);
  expect((await saved(page)).reflections[0].submissions).toBeUndefined();
  await expect(send.getByRole("button", { name: "Send for review" })).toBeEnabled();
});

test("a service that never answers times out, records nothing and re-enables the button", async ({ page }) => {
  await page.clock.install();
  const { send, count } = await sendFailure(page, { route: () => new Promise(() => {}) });
  await expect(send.getByRole("button", { name: "Sending…" })).toBeVisible();
  await page.clock.fastForward(16000);
  await expect(panel(page).getByRole("status")).toHaveText(/The copy was not sent: the service did not answer\. Your reading is unchanged and nothing is recorded as sent/);
  await expect(send.getByRole("button", { name: "Send for review" })).not.toHaveAttribute("aria-disabled", "true");
  expect(count()).toBe(1);
  expect((await saved(page)).reflections[0].submissions).toBeUndefined();
});

test("a duplicate and a rate limit give their own messages and record nothing", async ({ page }) => {
  let status = 409;
  const { send } = await sendFailure(page, {
    route: (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 409 ? { code: "duplicate" } : {}) }),
  });
  await expect(panel(page).getByRole("status")).toHaveText("This copy was already sent from here and is waiting for review.");
  expect((await saved(page)).reflections[0].submissions).toBeUndefined();
  status = 429;
  await send.getByRole("button", { name: "Send for review" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(/The copy was not sent: too many have come from here recently/);
  expect((await saved(page)).reflections[0].submissions).toBeUndefined();
});
