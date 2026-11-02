import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Passage feedback forms on a published reader page (#82, ADR 0082): keyboard use, a selection
// quoted from the build's passage text, announced errors, an explicit pending state, success, the
// copy-and-send fallback when the service is off, 320px, a strict content security policy, no
// requests beyond the configured endpoint, and the page without JavaScript or without the opt-in.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const ENDPOINT = "https://feedback.example/api";
const FEEDBACK_URL = `${ENDPOINT}/feedback`;
const POST = `---
title: Tides
date: 2026-10-20
---
The moon causes the tides. The sun matters too.

## Methods

We measured the tides twice a day[^1]. The tides rose.

## Results

The tides rose again.

[^1]: At the harbour.
`;
const POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(ENDPOINT).origin}; img-src 'self' data:; object-src 'none'; base-uri 'none'`;
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-passage-feedback-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Feedback",
    url: "https://feedback-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: false, analytics: false, feedback: true, endpoint: ENDPOINT, feedbackContact: "mailto:ada@feedback-site.example.org" },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
  writeFileSync(join(root, "content", "posts", "closed.md"), "---\ntitle: Closed\ndate: 2026-10-19\ncomments: locked\n---\n## Part\n\nClosed text.\n");
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

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * Answers the hosted function's feedback route: preflight first, then `answer` (status and
 * body), recording each submission; `hold` delays the answer until it is released.
 */
async function mockFeedback(page, answer = { status: 202, body: { status: "pending" } }, { hold = false } = {}) {
  const submissions = [];
  let release = () => {};
  const held = hold ? new Promise((done) => (release = done)) : Promise.resolve();
  await page.route(FEEDBACK_URL, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    submissions.push(request.postDataJSON());
    await held;
    await route.fulfill({ status: answer.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(answer.body) });
  });
  return { submissions, release: () => release() };
}

/** Every request the page makes beyond the site and the configured endpoint. */
function outsideRequests(page) {
  const outside = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && url.origin !== new URL(ENDPOINT).origin) outside.push(request.url());
  });
  return outside;
}

const form = (page) => page.locator(".ob-passage-feedback-form");

async function open(page) {
  await page.goto(`${origin}/tides/`);
  await page.waitForFunction(() => customElements.get("ob-passage-feedback") !== undefined);
  await expect(form(page)).toBeVisible();
}

/** The build's passage data on the page. */
const passageData = (page) => page.evaluate(() => JSON.parse(document.getElementById("ob-passages").textContent));

/** Selects `words` inside the article's prose, as a reader dragging over them would. */
async function selectWords(page, words) {
  await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.querySelector(".ob-prose"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(wanted);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no text ${wanted}`);
  }, words);
}

test("keyboard: a reader picks a section, a kind and a note, sends it, and hears each state", async ({ page }) => {
  const outside = outsideRequests(page);
  const service = await mockFeedback(page, undefined, { hold: true });
  await open(page);
  await expect(page.locator(".ob-passage-feedback-static")).toHaveCount(0);
  const region = page.getByRole("region", { name: "Questions and corrections" });
  await expect(region).toBeVisible();
  const whole = region.getByRole("radio", { name: "The whole post" });
  await whole.focus();
  await expect(whole).toBeChecked();
  // Arrow keys move through the native radio group.
  await page.keyboard.press("ArrowDown");
  await expect(region.getByRole("radio", { name: "A section" })).toBeChecked();
  await region.getByLabel("Section", { exact: true }).selectOption({ label: "Results" });
  await region.getByLabel("Kind of feedback").selectOption("question");
  await region.getByLabel("Your note", { exact: true }).fill("How was the rise measured?");
  await region.getByLabel("Your note", { exact: true }).press("Tab");
  await region.getByRole("button", { name: "Send for review" }).focus();
  await page.keyboard.press("Enter");
  // Pending is explicit and announced outside the busy form.
  await expect(form(page)).toHaveAttribute("aria-busy", "true");
  await expect(region.getByRole("button", { name: "Sending…" })).toHaveAttribute("aria-disabled", "true");
  await expect(region.getByRole("status")).toHaveText("Sending your note…");
  service.release();
  await expect(region.getByRole("status")).toHaveText("Sent for review.");
  const done = page.locator(".ob-passage-feedback-done");
  await expect(done).toBeFocused();
  await expect(done).toContainText("sent to the author for review");
  await expect(form(page)).not.toHaveAttribute("aria-busy", /./);
  const data = await passageData(page);
  const results = data.sections.find((section) => section.title === "Results");
  expect(service.submissions).toHaveLength(1);
  expect(service.submissions[0]).toMatchObject({
    version: 1,
    kind: "question",
    work: "/tides/",
    revision: data.revision,
    target: { version: 1, kind: "section", section: "results", digest: results.digest },
    body: "How was the rise measured?",
  });
  expect(service.submissions[0].attribution).toBeUndefined();
  expect(outside).toEqual([]);
});

test("selected words are quoted from the build's passage text and the article never changes", async ({ page }) => {
  const service = await mockFeedback(page);
  await open(page);
  const article = await page.locator(".ob-prose").innerHTML();
  await selectWords(page, "twice a day");
  const button = page.getByRole("button", { name: "Give feedback on the selected words" });
  await expect(button).toBeVisible();
  await button.click();
  const chosen = page.getByRole("radio", { name: "The words I selected" });
  await expect(chosen).toBeChecked();
  await expect(chosen).toBeFocused();
  await expect(chosen).toHaveAccessibleDescription("“twice a day”");
  // The quotation survives losing the selection.
  await page.evaluate(() => getSelection().removeAllRanges());
  await expect(page.locator(".ob-passage-feedback-quote")).toHaveText("“twice a day”");
  await page.getByLabel("Kind of feedback").selectOption("correction-suggestion");
  await expect(page.getByLabel("Suggested wording (optional)")).toBeVisible();
  await page.getByLabel("Your note", { exact: true }).fill("Only once on Sundays.");
  await page.getByLabel("Suggested wording (optional)").fill("twice a day, once on Sundays");
  await page.getByLabel("Name", { exact: true }).fill("Ada");
  await page.getByLabel("Show my name with this note if the author publishes it").check();
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-passage-feedback-done")).toBeFocused();
  const sent = service.submissions[0];
  expect(sent.target).toEqual({
    version: 1,
    kind: "quote",
    section: "methods",
    exact: "twice a day",
    prefix: "Methods We measured the tides ",
    suffix: ". The tides rose.",
    start: 30,
  });
  expect(sent.details).toEqual({ suggestedText: "twice a day, once on Sundays" });
  expect(sent.attribution).toEqual({ name: "Ada", publishName: true });
  expect(await page.locator(".ob-prose").innerHTML()).toBe(article);

  // Words across the note marker are not passage text: explained, never guessed.
  await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll(".ob-prose p")].find((p) => p.textContent.includes("twice a day"));
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.lastChild, 5);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(page.locator(".ob-passage-feedback-hint", { hasText: "cannot quote" })).toBeVisible();
  await expect(button).toBeHidden();
});

test("errors are announced, the field is marked and takes focus, and nothing is sent", async ({ page }) => {
  const service = await mockFeedback(page);
  await open(page);
  await page.getByRole("button", { name: "Send for review" }).click();
  const note = page.getByLabel("Your note", { exact: true });
  await expect(note).toBeFocused();
  await expect(note).toHaveAttribute("aria-invalid", "true");
  await expect(note).toHaveAccessibleDescription(/Write your note/);
  await expect(page.locator("#ob-feedback").getByRole("alert")).toContainText("Write your note");
  await page.getByLabel("Kind of feedback").selectOption("source-suggestion");
  await note.fill("A better source.");
  await page.getByLabel("Link to the source").fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByLabel("Link to the source")).toBeFocused();
  await expect(page.locator("#ob-feedback").getByRole("alert")).toContainText("full web address");
  expect(service.submissions).toEqual([]);
});

test("when the service is off the reader gets the note to copy and the author's address", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockFeedback(page, { status: 404, body: { error: "Passage feedback is not available on this site.", code: "unavailable" } });
  await open(page);
  await page.getByLabel("Your note", { exact: true }).fill("Is the second rise <b>real</b>?");
  await page.getByRole("button", { name: "Send for review" }).click();
  const message = page.locator(".ob-passage-feedback-fallback-message");
  await expect(message).toBeFocused();
  await expect(message).toContainText("Nothing you wrote was lost");
  const copy = page.getByLabel("Your note, ready to send to the author");
  await expect(copy).toHaveValue(/^Question about https:\/\/feedback-site\.example\.org\/tides\//);
  await expect(copy).toHaveValue(/Is the second rise <b>real<\/b>\?/);
  await page.getByRole("button", { name: "Copy note" }).click();
  await expect(page.locator("#ob-feedback").getByRole("status")).toHaveText(/copied|selected/);
  const link = page.getByRole("link", { name: "Write to the author" });
  await expect(link).toHaveAttribute("href", /^mailto:ada@feedback-site\.example\.org\?subject=/);
  // Nothing the reader wrote was cleared.
  await expect(page.getByLabel("Your note", { exact: true })).toHaveValue("Is the second rise <b>real</b>?");
  await expect(page.locator(".ob-prose b")).toHaveCount(0);
});

test("at 320px the form fits without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await mockFeedback(page);
  await open(page);
  await page.getByLabel("Kind of feedback").selectOption("correction-suggestion");
  const region = page.locator("#ob-feedback");
  const overflow = await region.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const regionBox = await region.boundingBox();
  expect(regionBox.x + regionBox.width).toBeLessThanOrEqual(320);
  for (const label of ["Your note", "Link to a source (optional)", "Suggested wording (optional)", "Name"]) {
    const box = await page.getByLabel(label, { exact: true }).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
});

test("it works under a strict content security policy", async ({ page }) => {
  await page.route(`${origin}/tides/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const service = await mockFeedback(page);
  await open(page);
  // The page's own inline theme snippet may be refused by this policy; nothing the form does is.
  const before = await page.evaluate(() => window.__violations.slice());
  await selectWords(page, "The sun matters too.");
  await page.getByRole("button", { name: "Give feedback on the selected words" }).click();
  await page.getByLabel("Your note", { exact: true }).fill("Which sources say so?");
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-passage-feedback-done")).toBeFocused();
  expect(service.submissions[0].target).toMatchObject({ kind: "quote", exact: "The sun matters too." });
  expect(service.submissions[0].target.section).toBeUndefined();
  expect(await page.evaluate(() => window.__violations)).toEqual(before);
});

test("without JavaScript the region explains the fallback, and a closed post has no form at all", async ({ browser }) => {
  const scriptless = await browser.newContext({ javaScriptEnabled: false });
  const page = await scriptless.newPage();
  await page.goto(`${origin}/tides/`);
  const fallback = page.locator(".ob-passage-feedback-static");
  await expect(fallback).toContainText("The feedback form needs JavaScript");
  await expect(fallback.locator("code")).toHaveText(/^p1:[0-9a-f]{32}$/);
  await expect(fallback.getByRole("link", { name: "ada@feedback-site.example.org" })).toHaveAttribute("href", "mailto:ada@feedback-site.example.org");
  await expect(page.locator(".ob-passage-feedback-form")).toHaveCount(0);
  await expect(page.locator(".ob-prose")).toContainText("twice a day");
  await scriptless.close();

  const context = await browser.newContext();
  const closed = await context.newPage();
  const loaded = [];
  closed.on("request", (request) => loaded.push(new URL(request.url()).pathname));
  await closed.goto(`${origin}/closed/`);
  await expect(closed.locator("h1")).toHaveText("Closed");
  await expect(closed.locator("#ob-feedback, #ob-passages, ob-passage-feedback")).toHaveCount(0);
  expect(loaded.some((path) => path.includes("passage-feedback"))).toBe(false);
  await context.close();
});
