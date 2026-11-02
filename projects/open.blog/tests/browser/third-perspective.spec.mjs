import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Third Perspective submission on a published reader page (#221, ADR 0114): keyboard use through
// native radio groups, explicit consent (publication, a shown name, clarification), no ranking or
// vote, announced errors with focus on the field, an explicit pending state and a double submit
// that waits, success with the receipt, network loss and a failing service keeping the reflection
// with retry and copy, choosing not to publish, 320px and 400% zoom without sideways scrolling,
// reduced motion, a strict content security policy, no requests beyond the configured endpoint,
// and the page without JavaScript or on a locked post.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const ENDPOINT = "https://perspectives.example/api";
const FEEDBACK_URL = `${ENDPOINT}/feedback`;
const RECEIPT = "R".repeat(43);
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
const POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(ENDPOINT).origin}; img-src 'self' data:; object-src 'none'; base-uri 'none'`;
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-third-perspective-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Perspectives",
    url: "https://perspectives-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: false, analytics: false, endpoint: ENDPOINT, receipts: true, feedbackContact: "mailto:ada@perspectives-site.example.org" },
    participation: { kinds: { "third-perspective": "open" } },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
  writeFileSync(join(root, "content", "posts", "closed.md"), "---\ntitle: Closed\ndate: 2026-10-19\nparticipation:\n  - third-perspective: locked\n---\n## Part\n\nClosed text.\n");
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
 * Answers the hosted function's feedback route with each of `answers` in turn (the last one
 * repeats); an answer of "abort" drops the connection. `hold` delays answers until released.
 */
async function mockService(page, answers = [{ status: 202, body: { status: "pending", receipt: RECEIPT } }], { hold = false } = {}) {
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
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === "abort") {
      await route.abort("internetdisconnected");
      return;
    }
    await route.fulfill({ status: answer.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(answer.body) });
  });
  return { submissions, release: () => release() };
}

function outsideRequests(page) {
  const outside = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && url.origin !== new URL(ENDPOINT).origin) outside.push(request.url());
  });
  return outside;
}

const region = (page) => page.getByRole("region", { name: "Offer a Third Perspective" });

async function open(page) {
  await page.goto(`${origin}/tides/`);
  await page.waitForFunction(() => customElements.get("ob-third-perspective") !== undefined);
  await expect(page.locator(".ob-third-perspective-form")).toBeVisible();
}

test("keyboard: a reader chooses a section, a prompt and their consent, sends it, and hears each state", async ({ page }) => {
  const outside = outsideRequests(page);
  const service = await mockService(page, undefined, { hold: true });
  await open(page);
  const form = region(page);
  await expect(page.locator(".ob-third-perspective-static")).toHaveCount(0);
  const whole = form.getByRole("radio", { name: "The whole work" });
  await whole.focus();
  await expect(whole).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(form.getByRole("radio", { name: "One section" })).toBeChecked();
  await form.getByLabel("Section", { exact: true }).selectOption({ label: "Results" });
  const noPrompt = form.getByRole("radio", { name: "No prompt" });
  await expect(noPrompt).toBeChecked();
  await noPrompt.focus();
  await page.keyboard.press("ArrowDown");
  const reading = form.getByRole("radio", { name: "Another reading" });
  await expect(reading).toBeChecked();
  await expect(reading).toHaveAccessibleDescription("How do you read this, in your own way?");
  await form.getByLabel("Your reflection", { exact: true }).fill("The two halves read as one conversation.");
  // Publication is a choice the reader makes; nothing is checked for them.
  const yes = form.getByRole("radio", { name: "Yes, publish it on this page if a moderator approves it" });
  await expect(yes).not.toBeChecked();
  await expect(form.getByRole("radio", { name: "No, it is only for the author" })).not.toBeChecked();
  await yes.focus();
  await page.keyboard.press("Space");
  await expect(yes).toBeChecked();
  await form.getByLabel("Name", { exact: true }).fill("Ada");
  await expect(form.getByRole("checkbox", { name: "Show my name with my reflection if it is published" })).not.toBeChecked();
  await form.getByRole("checkbox", { name: "You may ask me to clarify it" }).check();
  await form.getByRole("button", { name: "Send for review" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ob-third-perspective-form")).toHaveAttribute("aria-busy", "true");
  await expect(form.getByRole("button", { name: "Sending…" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".ob-third-perspective-status")).toHaveText("Sending your reflection…");
  // A second press while sending waits.
  await page.keyboard.press("Enter");
  service.release();
  await expect(page.locator(".ob-third-perspective-status")).toHaveText("Sent for review.");
  const done = page.locator(".ob-third-perspective-done");
  await expect(done).toBeFocused();
  await expect(done).toContainText("published only if a moderator approves it");
  expect(service.submissions).toHaveLength(1);
  const data = await page.evaluate(() => JSON.parse(document.getElementById("ob-passages").textContent));
  const results = data.sections.find((section) => section.title === "Results");
  expect(service.submissions[0]).toMatchObject({
    version: 1,
    kind: "third-perspective",
    work: "/tides/",
    revision: data.revision,
    target: { version: 1, kind: "section", section: "results", digest: results.digest },
    category: "another-reading",
    body: "The two halves read as one conversation.",
    attribution: { name: "Ada", publishName: false },
    consent: { publish: true, clarification: true, feature: false },
  });
  for (const field of ["rank", "rating", "score", "vote"]) expect(service.submissions[0][field]).toBeUndefined();
  // The receipt is shown once, with the consent the reader already gave.
  await expect(page.getByRole("textbox", { name: "Receipt" })).toHaveValue(RECEIPT);
  await expect(page.getByRole("checkbox", { name: "The author may ask me to clarify this reflection through this receipt" })).toBeChecked();
  expect(outside).toEqual([]);
});

test("errors are announced on their field with focus there, and nothing is sent", async ({ page }) => {
  const service = await mockService(page);
  await open(page);
  const form = region(page);
  await form.getByLabel("Your reflection", { exact: true }).fill("A thought.");
  await form.getByRole("button", { name: "Send for review" }).click();
  const yes = form.getByRole("radio", { name: "Yes, publish it on this page if a moderator approves it" });
  await expect(yes).toBeFocused();
  await expect(yes).toHaveAttribute("aria-invalid", "true");
  await expect(yes).toHaveAccessibleDescription(/Choose whether your reflection may be published/);
  await expect(form.getByRole("alert")).toHaveText("Choose whether your reflection may be published.");
  await yes.check();
  await form.getByLabel("Your reflection", { exact: true }).fill("   ");
  await form.getByRole("button", { name: "Send for review" }).click();
  const body = form.getByLabel("Your reflection", { exact: true });
  await expect(body).toBeFocused();
  await expect(body).toHaveAttribute("aria-invalid", "true");
  await body.fill("A thought.");
  await form.getByRole("checkbox", { name: "Show my name with my reflection if it is published" }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  await expect(form.getByRole("checkbox", { name: "Show my name with my reflection if it is published" })).toBeFocused();
  await expect(form.getByRole("alert")).toContainText("Enter your name");
  expect(service.submissions).toEqual([]);
});

test("network loss keeps the reflection, offers a retry that sends it, and a copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const service = await mockService(page, ["abort", { status: 202, body: { status: "pending", receipt: RECEIPT } }]);
  await open(page);
  const form = region(page);
  await form.getByLabel("Your reflection", { exact: true }).fill("Is the second rise <b>real</b>?");
  await form.getByRole("radio", { name: "Yes, publish it on this page if a moderator approves it" }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  const message = page.locator(".ob-third-perspective-fallback-message");
  await expect(message).toBeFocused();
  await expect(message).toContainText("Nothing you wrote was lost");
  await expect(form.getByLabel("Your reflection", { exact: true })).toHaveValue("Is the second rise <b>real</b>?");
  const copy = page.getByLabel("Your reflection, ready to send to the author");
  await expect(copy).toHaveValue(/^Third Perspective on https:\/\/perspectives-site\.example\.org\/tides\//);
  await expect(copy).toHaveValue(/open\.blog Third Perspective record/);
  await page.getByRole("button", { name: "Copy reflection" }).click();
  await expect(page.locator(".ob-third-perspective-status")).toHaveText(/copied|selected/);
  await expect(page.getByRole("link", { name: "Write to the author" })).toHaveAttribute("href", /^mailto:ada@perspectives-site\.example\.org\?subject=/);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".ob-third-perspective-done")).toBeFocused();
  expect(service.submissions).toHaveLength(2);
  expect(service.submissions[1]).toEqual(service.submissions[0]);
  await expect(page.locator(".ob-prose b")).toHaveCount(0);
});

test("a service that is off offers the copy without a retry; choosing not to publish sends nothing", async ({ page }) => {
  let service = await mockService(page, [{ status: 404, body: { error: "This site does not take Third Perspectives through the form.", code: "unavailable" } }]);
  await open(page);
  const form = region(page);
  await form.getByLabel("Your reflection", { exact: true }).fill("Kept words.");
  await form.getByRole("radio", { name: "Yes, publish it on this page if a moderator approves it" }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-third-perspective-fallback-message")).toContainText("not taking reflections through the form");
  await expect(page.getByRole("button", { name: "Try again" })).toBeHidden();
  expect(service.submissions).toHaveLength(1);

  await page.unroute(FEEDBACK_URL);
  service = await mockService(page);
  await form.getByRole("radio", { name: "No, it is only for the author" }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-third-perspective-fallback-message")).toContainText("You chose not to publish it, so it was not sent");
  await expect(page.getByLabel("Your reflection, ready to send to the author")).toHaveValue(/Not for publication: for the author only\./);
  expect(service.submissions).toEqual([]);
});

for (const [name, viewport, zoom] of [["320px", { width: 320, height: 640 }, 1], ["400% zoom", { width: 1280, height: 800 }, 4]]) {
  test(`at ${name} the form reflows without scrolling sideways`, async ({ page }) => {
    await page.setViewportSize(zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockService(page);
    await open(page);
    const box = page.locator("#ob-third-perspective");
    const overflow = await box.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const width = page.viewportSize().width;
    const regionBox = await box.boundingBox();
    expect(regionBox.x + regionBox.width).toBeLessThanOrEqual(width);
    for (const label of ["Your reflection", "Name", "Section"]) {
      const control = await page.getByLabel(label, { exact: true }).boundingBox();
      expect(control.x).toBeGreaterThanOrEqual(0);
      expect(control.x + control.width).toBeLessThanOrEqual(width);
    }
    for (const label of ["A connection", "Yes, publish it on this page if a moderator approves it", "You may ask me to clarify it"]) {
      const control = await page.getByLabel(label, { exact: true }).boundingBox();
      expect(control.x + control.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

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
  const service = await mockService(page);
  await open(page);
  const before = await page.evaluate(() => window.__violations.slice());
  const form = region(page);
  await form.getByLabel("Your reflection", { exact: true }).fill("Under a strict policy.");
  await form.getByRole("radio", { name: "Yes, publish it on this page if a moderator approves it" }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-third-perspective-done")).toBeFocused();
  expect(service.submissions[0].target).toEqual({ version: 1, kind: "work" });
  expect(await page.evaluate(() => window.__violations)).toEqual(before);
});

test("without JavaScript the region explains how to write instead, and a locked post has no form", async ({ browser }) => {
  const scriptless = await browser.newContext({ javaScriptEnabled: false });
  const page = await scriptless.newPage();
  await page.goto(`${origin}/tides/`);
  const fallback = page.locator(".ob-third-perspective-static");
  await expect(fallback).toContainText("The form needs JavaScript");
  await expect(fallback).toContainText("whether it may be published, whether your name may be shown");
  await expect(fallback.locator("code")).toHaveText(/^p1:[0-9a-f]{32}$/);
  await expect(fallback.getByRole("link", { name: "ada@perspectives-site.example.org" })).toHaveAttribute("href", "mailto:ada@perspectives-site.example.org");
  await expect(page.locator(".ob-third-perspective-form")).toHaveCount(0);
  await expect(page.locator(".ob-prose")).toContainText("twice a day");
  await scriptless.close();

  const context = await browser.newContext();
  const closed = await context.newPage();
  const loaded = [];
  closed.on("request", (request) => loaded.push(new URL(request.url()).pathname));
  await closed.goto(`${origin}/closed/`);
  await expect(closed.locator("h1")).toHaveText("Closed");
  await expect(closed.locator("#ob-third-perspective, #ob-passages, ob-third-perspective")).toHaveCount(0);
  expect(loaded.some((path) => path.includes("third-perspective"))).toBe(false);
  await context.close();
});
