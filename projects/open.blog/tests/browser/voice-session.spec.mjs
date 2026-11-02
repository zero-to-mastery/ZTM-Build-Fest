import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// Voice sessions in Admin Studio, from the real binary and the real page (ADR 0272 to 0276): the flow, the
// rough box that refuses corrections, a reload in the middle of the window, and the phone-first layout at 400px
// and on a desktop. Layout is measured on the region under test with a small tolerance: CI fonts are wider than
// the ones on a developer machine, so nothing here depends on a font's metrics.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const shots = join(repository, "tests", "browser", "test-results", "voice");
let root;
let server;
let origin;
const TOLERANCE = 1.5;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  root = mkdtempSync(join(tmpdir(), "openblog-voice-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\n---\nA post.\n");
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Voice", url: "https://voice.example.org", author: { name: "Site Author" } }));
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
  }
});

test.beforeEach(({ page }) => {
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
});

async function signIn(page, hash = "#/voice") {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/${hash}`);
}

/** Give up whatever session is open; a scrap names the session it means. */
async function scrapOpen(page) {
  const standing = await api(page, "GET", "voice/status");
  return api(page, "DELETE", "voice/session", { sessionId: standing.body?.session?.sessionId ?? null });
}

/** A call to the Admin API as the signed-in page makes it. */
async function api(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const session = await (await fetch("/admin/api/session")).json();
    const reply = await fetch(`/admin/api/${path}`, {
      method,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: reply.status, body: await reply.json().catch(() => null) };
  }, [method, path, body]);
}

async function clean(page) {
  await signIn(page, "#/overview");
  await scrapOpen(page);
}

const voiceFiles = () => {
  const found = [];
  for (const folder of [join(root, ".openblog", "private", "context", "voice"), join(root, "assistant", "context", "voice")]) {
    if (existsSync(folder)) for (const name of readdirSync(folder)) if (name.endsWith(".md")) found.push(join(folder, name));
  }
  return found;
};

const cards = (page) => page.locator("[data-prompt].oba-voice-card");

async function chooseFirst(page) {
  await expect(page.getByRole("heading", { name: "Choose what to write about" })).toBeVisible();
  await expect(cards(page)).toHaveCount(3);
  const id = await cards(page).first().getAttribute("data-prompt");
  await cards(page).first().locator("input").check();
  await page.getByRole("button", { name: "Start the 3:00 timer" }).click();
  await expect(page.locator("[data-voice-rough]")).toBeVisible();
  return id;
}

/** How far the region under test reaches past the screen, and the page itself, in pixels. */
const sideways = (page, selector) =>
  page.evaluate((selector) => {
    const region = document.querySelector(selector);
    const width = document.documentElement.clientWidth;
    let widest = 0;
    let culprit = "";
    for (const node of region.querySelectorAll("*")) {
      const box = node.getBoundingClientRect();
      if (box.width && box.right > widest) {
        widest = box.right;
        culprit = `${node.tagName.toLowerCase()}.${node.className}`;
      }
    }
    return { region: region.scrollWidth - region.clientWidth, widest: widest - width, page: document.documentElement.scrollWidth - width, left: region.getBoundingClientRect().left, culprit };
  }, selector);

const preferenceFiles = () => {
  const folder = join(root, ".openblog", "private", "admin-preferences");
  return existsSync(folder) ? readdirSync(folder).map((name) => join(folder, name)) : [];
};
const invitation = (page) => page.locator("[data-voice-invitation]");
/** Reload the Admin home and wait until it has asked whether to invite, so "no card" is a real answer. */
async function reloadHome(page) {
  await Promise.all([page.waitForResponse((reply) => reply.url().includes("/admin/api/voice/status")), page.reload()]);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

test("the invitation shows once on the Admin home, Start opens Voice, and Dismiss is remembered", async ({ page }) => {
  await clean(page);
  await page.goto(`${origin}/admin/#/overview`);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(invitation(page)).toBeVisible();
  await expect(invitation(page).getByRole("heading", { name: "Gather your voice" })).toBeVisible();
  // A session in progress means it is not shown.
  const drawn = await api(page, "POST", "voice/draw", {});
  const open = await api(page, "POST", "voice/session/start", { promptId: drawn.body.prompts[0].id });
  expect(open.status).toBe(201);
  await reloadHome(page);
  await expect(invitation(page)).toHaveCount(0);
  await scrapOpen(page);
  await reloadHome(page);
  await expect(invitation(page)).toBeVisible();
  // Start opens the Voice view.
  await invitation(page).getByRole("link", { name: /voice session/i }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Voice" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose what to write about" })).toBeVisible();
  // Dismiss is stored in the admin's own preferences and the card does not come back.
  await page.goto(`${origin}/admin/#/overview`);
  await expect(invitation(page)).toBeVisible();
  await invitation(page).getByRole("button", { name: "Dismiss this invitation" }).click();
  await expect(invitation(page)).toHaveCount(0);
  await expect.poll(() => preferenceFiles().some((file) => readFileSync(file, "utf8").includes('"voiceInvitationDismissed": true') || readFileSync(file, "utf8").includes('"voiceInvitationDismissed":true'))).toBe(true);
  await reloadHome(page);
  await expect(invitation(page)).toHaveCount(0);
  await page.screenshot({ path: join(shots, "overview-dismissed.png") });
});

test("the whole flow works in a real browser and the rough box refuses every correction", async ({ page }) => {
  await clean(page);
  await page.goto(`${origin}/admin/#/voice`);
  const promptId = await chooseFirst(page);
  const rough = page.locator("[data-voice-rough]");
  await expect(rough).toBeFocused();
  // The browser is told, in every way it can be told, to leave the words alone.
  expect(await rough.evaluate((node) => ({ spellcheck: node.spellcheck, autocorrect: node.getAttribute("autocorrect"), autocapitalize: node.autocapitalize, autocomplete: node.autocomplete, suggestions: node.getAttribute("writingsuggestions") }))).toEqual({ spellcheck: false, autocorrect: "off", autocapitalize: "none", autocomplete: "off", suggestions: "false" });
  await expect(page.locator("[data-voice-clock]")).toHaveText(/^[23]:\d\d$/);
  const words = "teh  quick   brown fox\n\n  jumps ovr the lazy dog";
  await rough.fill(words);
  await page.getByRole("button", { name: "Finish early" }).click();
  await expect(page.getByRole("heading", { name: "Your rough draft is locked" })).toBeVisible();
  await expect(page.locator("[data-voice-rough-text]")).toHaveText(words);
  await expect(page.locator("[data-voice-polished-body]")).toBeFocused();
  // The rough view has nothing to edit, and the polished editor is pre-filled.
  expect(await page.locator("[data-voice-rough-view]").locator("input, textarea, [contenteditable]").count()).toBe(0);
  await expect(page.locator("[data-voice-polished-body]")).toHaveValue(words);
  expect(await page.locator("[data-voice-polished-body]").evaluate((node) => node.spellcheck)).toBe(true);
  // The stored file is what was typed, with nothing corrected or trimmed.
  const stored = voiceFiles().filter((file) => file.endsWith("-rough.md"));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toContain(promptId);
  expect(readFileSync(stored[0], "utf8").replace(/\r\n/g, "\n").endsWith(`\n\n${words}\n`)).toBe(true);
  // Polish a copy and save it.
  await page.locator("[data-voice-polished-body]").fill("The quick brown fox jumps over the lazy dog.");
  await page.getByRole("button", { name: "Save polished draft" }).click();
  await expect(page.locator("[data-voice-polished-status]")).toContainText("Saved.");
  expect(voiceFiles().filter((file) => file.endsWith("-polished.md"))).toHaveLength(1);
  expect(readFileSync(stored[0], "utf8").replace(/\r\n/g, "\n").endsWith(`\n\n${words}\n`)).toBe(true);
});

test("a reload in the middle of the window continues the same clock with the same words", async ({ page }) => {
  await clean(page);
  await page.goto(`${origin}/admin/#/voice`);
  await chooseFirst(page);
  const rough = page.locator("[data-voice-rough]");
  await rough.fill("words typed before the reload");
  await expect(page.locator("[data-voice-savenote]")).toContainText("Saved on the server");
  const before = await page.locator("[data-voice-clock]").innerText();
  await page.reload();
  await expect(page.locator("[data-voice-rough]")).toHaveValue("words typed before the reload");
  const after = await page.locator("[data-voice-clock]").innerText();
  const seconds = (clock) => Number(clock.split(":")[0]) * 60 + Number(clock.split(":")[1]);
  expect(seconds(after)).toBeLessThanOrEqual(seconds(before));
  expect(seconds(after)).toBeGreaterThan(seconds(before) - 20);
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Yes, start over" }).click();
  await expect(page.getByRole("heading", { name: "Choose what to write about" })).toBeFocused();
});

test("leaving with unsaved polished edits asks first, and staying keeps them", async ({ page }) => {
  await clean(page);
  await page.goto(`${origin}/admin/#/voice`);
  await chooseFirst(page);
  await page.locator("[data-voice-rough]").fill("some words to polish");
  await page.getByRole("button", { name: "Finish early" }).click();
  const body = page.locator("[data-voice-polished-body]");
  await expect(body).toBeFocused();
  // Nothing has changed from the pre-filled copy, so leaving needs no question.
  await body.fill("some words to polish, edited");
  const asked = [];
  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    asked.push(dialog.message());
    await dialog.dismiss();
  });
  await page.evaluate(() => { location.hash = "#/overview"; });
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toMatch(/unsaved changes/i);
  await expect(page.locator("[data-voice-polished-body]")).toHaveValue("some words to polish, edited");
  await page.getByRole("button", { name: "Save polished draft" }).click();
  await expect(page.locator("[data-voice-polished-status]")).toContainText("Saved.");
  await page.evaluate(() => { location.hash = "#/overview"; });
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  expect(asked).toHaveLength(1);
});

test("at 400px the cards stack, the box is at least 40% of the screen, the bar is within reach and nothing scrolls sideways", async ({ page }) => {
  await clean(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`${origin}/admin/#/voice`);
  await expect(cards(page)).toHaveCount(3);
  const boxes = await cards(page).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((b) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom })));
  for (let i = 1; i < boxes.length; i += 1) {
    expect(boxes[i].top, "each card is below the one before it").toBeGreaterThanOrEqual(boxes[i - 1].bottom - TOLERANCE);
    expect(Math.abs(boxes[i].left - boxes[0].left)).toBeLessThanOrEqual(TOLERANCE);
  }
  for (const b of boxes) {
    expect(b.left, "16px gutter").toBeGreaterThanOrEqual(16 - TOLERANCE);
    expect(b.right, "16px gutter").toBeLessThanOrEqual(400 - 16 + TOLERANCE);
  }
  let overflow = await sideways(page, "ob-voice-session");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.widest, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.left).toBeGreaterThanOrEqual(16 - TOLERANCE);
  await page.screenshot({ path: join(shots, "draw-400.png"), fullPage: true });

  await chooseFirst(page);
  const LONG = "an_extraordinarily_long_unbroken_word_that_must_wrap_instead_of_overflowing_a_small_screen_at_all_even_at_320";
  await page.locator("[data-voice-rough]").fill(`${LONG} ${LONG}`);
  const geometry = await page.evaluate(() => {
    const box = document.querySelector("[data-voice-rough]").getBoundingClientRect();
    const bar = document.querySelector("[data-voice-bar]").getBoundingClientRect();
    return { boxHeight: box.height, bar: { top: bar.top, bottom: bar.bottom }, inner: innerHeight };
  });
  expect(geometry.boxHeight, "at least 40vh").toBeGreaterThanOrEqual(geometry.inner * 0.4 - TOLERANCE);
  // The bar is reachable without scrolling to the end of the page: it floats at the bottom edge.
  expect(geometry.bar.bottom).toBeLessThanOrEqual(geometry.inner + TOLERANCE);
  expect(geometry.bar.top).toBeGreaterThanOrEqual(0);
  await expect(page.getByRole("button", { name: "Finish early" })).toBeInViewport();
  overflow = await sideways(page, "ob-voice-session");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.widest, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  await page.screenshot({ path: join(shots, "write-400.png"), fullPage: true });

  await page.getByRole("button", { name: "Finish early" }).click();
  await expect(page.locator("[data-voice-rough-text]")).toBeVisible();
  overflow = await sideways(page, "ob-voice-session");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.widest, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  const polishedHeight = await page.locator("[data-voice-polished-body]").evaluate((node) => node.getBoundingClientRect().height);
  expect(polishedHeight).toBeGreaterThanOrEqual(800 * 0.4 - TOLERANCE);
  await expect(page.getByRole("button", { name: "Save polished draft" })).toBeInViewport();
  await page.screenshot({ path: join(shots, "refine-400.png"), fullPage: true });
});

test("on a desktop the three cards sit side by side", async ({ page }) => {
  await clean(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/admin/#/voice`);
  await expect(cards(page)).toHaveCount(3);
  const tops = await cards(page).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  const overflow = await sideways(page, "ob-voice-session");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  await page.screenshot({ path: join(shots, "draw-1280.png"), fullPage: true });
  await chooseFirst(page);
  await page.screenshot({ path: join(shots, "write-1280.png"), fullPage: true });
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Yes, start over" }).click();
  await expect(page.getByRole("heading", { name: "Choose what to write about" })).toBeVisible();
});

test("the clock runs out in real time: the last thirty seconds warn in words and the draft locks by itself", async ({ page }) => {
  test.setTimeout(90000);
  await clean(page);
  const started = await api(page, "POST", "voice/draw", {});
  const prompt = started.body.prompts[0].id;
  const open = await api(page, "POST", "voice/session/start", { promptId: prompt, timeLimitSeconds: 30 });
  expect(open.status).toBe(201);
  await page.goto(`${origin}/admin/#/voice`);
  const rough = page.locator("[data-voice-rough]");
  await expect(rough).toBeVisible();
  await expect(page.locator("[data-voice-timer]")).toHaveAttribute("data-state", "warning");
  await expect(page.locator("[data-voice-timer-state]")).toContainText("seconds left");
  await rough.fill("typed in the last half minute");
  await expect(page.locator("[data-voice-announce]")).toHaveText(/\S/, { timeout: 5000 }).catch(() => {});
  await expect(page.getByRole("heading", { name: "Your rough draft is locked" })).toBeVisible({ timeout: 45000 });
  await expect(page.locator("[data-voice-rough-text]")).toHaveText("typed in the last half minute");
  await expect(page.locator("[data-voice-announce]")).toHaveText("Time is up. Your rough draft is locked.");
  // The session is over: the server takes no more text for it.
  const late = await api(page, "PUT", "voice/session/draft", { sessionId: open.body.sessionId, text: "too late" });
  expect(late.status).toBe(409);
});

test("the library lists what was written, opens a rough draft read-only and a polished one for editing, and fits a phone", async ({ page }) => {
  await clean(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`${origin}/admin/#/voice/library`);
  await expect(page.getByRole("heading", { level: 2, name: "Your voice samples" })).toBeVisible();
  const rows = page.locator("li.oba-voice-row[data-prompt]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(page.locator("[data-voice-summary]")).toContainText("samples written");
  const LONG = "an_extraordinarily_long_unbroken_word_that_must_wrap_instead_of_overflowing_a_small_screen_at_all_even_at_320";
  let overflow = await sideways(page, "ob-voice-library");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.widest, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  await page.screenshot({ path: join(shots, "library-400.png"), fullPage: true });

  // A row with both drafts: read the rough one, then edit the polished one.
  const both = page.locator("li.oba-voice-row:has([data-stage=\"polished\"])").first();
  await expect(both).toBeVisible();
  await both.getByRole("link", { name: /^Read the rough draft/ }).click();
  await expect(page.locator("[data-voice-rough-view]")).toBeVisible();
  expect(await page.locator("[data-voice-rough-view]").locator("input, textarea, [contenteditable]").count()).toBe(0);
  await expect(page.locator("[data-voice-rough-note]")).toContainText("exactly as you wrote it");
  await expect(page.locator("[data-voice-polish-heading]")).toHaveText("Edit your polished draft");
  const roughBefore = voiceFiles().filter((file) => file.endsWith("-rough.md")).map((file) => [file, readFileSync(file, "utf8")]);
  overflow = await sideways(page, "ob-voice-library");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  await page.screenshot({ path: join(shots, "open-rough-400.png"), fullPage: true });
  const body = page.locator("[data-voice-polished-body]");
  await body.fill(`The polished draft, edited again from the library. ${LONG}`);
  await page.getByRole("button", { name: "Save polished draft" }).click();
  await expect(page.locator("[data-voice-polished-status]")).toContainText("Saved.");
  overflow = await sideways(page, "ob-voice-library");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  const openedId = decodeURIComponent(page.url().split("/voice/library/")[1]);
  const polishedFile = voiceFiles().find((file) => file.endsWith(`${openedId.replace(/-rough$/, "-polished")}.md`));
  expect(polishedFile).toBeTruthy();
  expect(readFileSync(polishedFile, "utf8")).toContain("edited again from the library");
  for (const [file, before] of roughBefore) expect(readFileSync(file, "utf8")).toBe(before);
  // Leaving after the save asks nothing; leaving with a new edit asks first.
  await body.fill("one more edit that is not saved");
  const asked = [];
  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    asked.push(dialog.message());
    await dialog.dismiss();
  });
  await page.evaluate(() => { location.hash = "#/voice/library"; });
  await expect.poll(() => asked.length).toBe(1);
  await expect(body).toHaveValue("one more edit that is not saved");
});

test("the invitation never shows when samples exist, even for an admin who has not dismissed it", async ({ page }) => {
  expect(voiceFiles().length).toBeGreaterThan(0);
  for (const file of preferenceFiles()) rmSync(file, { force: true });
  await signIn(page, "#/overview");
  await expect(page.locator("[data-action=\"logout\"]")).toBeVisible();
  await reloadHome(page);
  await expect(invitation(page)).toHaveCount(0);
});

test("erase lists first, needs the typed word, keeps everything on Cancel, then removes it all and fits a phone", async ({ page }) => {
  expect(voiceFiles().length).toBeGreaterThan(0);
  await signIn(page, "#/voice/library");
  await page.setViewportSize({ width: 400, height: 800 });
  await expect(page.getByRole("heading", { level: 2, name: "Your voice samples" })).toBeVisible();
  await page.locator("[data-voice-erase]").getByRole("button", { name: "Erase all voice data…" }).click();
  const list = page.locator("[data-voice-erase-list]");
  await expect(list).toBeVisible();
  expect(await list.locator("li").count()).toBe(voiceFiles().length);
  const overflow = await sideways(page, "ob-voice-library");
  expect(overflow.region, overflow.culprit).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page).toBeLessThanOrEqual(TOLERANCE);
  const confirm = page.getByRole("button", { name: "Erase everything" });
  await expect(confirm).toBeDisabled();
  await page.screenshot({ path: join(shots, "erase-400.png"), fullPage: true });

  // Cancel keeps everything.
  const before = voiceFiles().length;
  await page.getByRole("button", { name: "Keep my data" }).click();
  await expect(list).toHaveCount(0);
  expect(voiceFiles().length).toBe(before);

  await page.locator("[data-voice-erase]").getByRole("button", { name: "Erase all voice data…" }).click();
  await page.getByLabel(/^Type "erase" to confirm/).fill("erase");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator("[data-voice-erase-status]")).toContainText("nothing is left");
  expect(voiceFiles()).toEqual([]);
  expect(existsSync(join(root, ".openblog", "private", "voice", "session.json"))).toBe(false);
});
