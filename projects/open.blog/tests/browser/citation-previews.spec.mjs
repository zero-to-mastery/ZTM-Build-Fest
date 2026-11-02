import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The citation preview component on a published reader page (ADR 0061): keyboard, pointer and
// touch use, Escape and focus return, outside interaction, viewport edges, reduced motion, hostile
// data, no requests of its own, the strict content security policy, and an unchanged page without
// JavaScript.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const HOSTILE = `<img src=x onerror="window.__citationXss=1">`;
const LIBRARY = JSON.stringify({
  version: 1,
  sources: [
    { id: "plato-republic", kind: "work", title: "Πολιτεία", creators: [{ name: "Plato", role: "author" }] },
    {
      id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam", issued: "2003",
      identifiers: [{ scheme: "doi", value: "doi:10.1000/xyz" }],
    },
    { id: "hostile", kind: "work", title: HOSTILE },
  ],
});
const filler = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} of the argument.`).join("\n\n");
const POST = `---
title: The cave
date: 2026-10-20
citations: notes
---
The cave [@slings-2003, page 514] and the work [@plato-republic, canonical 514a].

${filler}

A hostile title [@hostile].
`;
// The policy the Admin serves pages under: no inline styles, scripts only from the site.
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-citation-previews-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Previews", url: "https://previews.example.org", postPath: "/{slug}/", author: { name: "A" } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "cave.md"), POST);
  writeFileSync(join(root, "content", "posts", "plain.md"), "---\ntitle: Plain\ndate: 2026-10-19\n---\nNo citations[^1].\n\n[^1]: A footnote.\n");
  const library = join(root, ".openblog", "private", "research", "sources.json");
  mkdirSync(dirname(library), { recursive: true });
  writeFileSync(library, LIBRARY);
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
    expect((await fetch(`${origin}/cave/`)).ok).toBe(true);
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

const preview = (page) => page.locator(".ob-citation-preview");
const marker = (page, id) => page.locator(`[id="${id}"]`);

// A marker's first box is its visually hidden "Citation " prefix, clipped out of hit testing, so
// Playwright's default point would land on the paragraph. A pointer aims at the visible number.
async function onNumber(locator) {
  const { width, height } = await locator.boundingBox();
  return { position: { x: width / 2, y: height / 2 } };
}

/** The cave page once the component has enhanced it. */
async function open(page) {
  await page.goto(`${origin}/cave/`);
  await expect(page.locator("ob-citation-previews")).toHaveCount(1);
  await page.waitForFunction(() => customElements.get("ob-citation-previews") !== undefined);
}

test("keyboard: focus opens the preview, Tab enters it, Escape returns focus, Enter follows the link", async ({ page }) => {
  await open(page);
  const first = marker(page, "cite-1-ref-1");
  await first.focus();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toContainText("Platonis Rempublicam");
  await expect(preview(page)).toContainText("p. 514");
  await expect(page.getByRole("group", { name: "Citation 1" })).toBeVisible();
  await expect(first).toHaveAccessibleDescription(/Platonis Rempublicam.*p\. 514/);
  await page.keyboard.press("Tab");
  await expect(preview(page).getByRole("link", { name: "https://doi.org/10.1000/xyz" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(preview(page).getByRole("link", { name: "Go to note" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toBeHidden();
  await expect(first).toBeFocused();
  await expect(first).not.toHaveAttribute("aria-describedby", /./);
  // The marker is still the link to its note.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#cite-1$/);
  await expect(page.locator("#cite-1")).toBeFocused();
  await expect(preview(page)).toBeHidden();
});

test("Tab past the preview, or moving to the next marker, closes or moves it", async ({ page }) => {
  await open(page);
  await marker(page, "cite-1-ref-1").focus();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(marker(page, "cite-2-ref-1")).toBeFocused();
  await expect(preview(page)).toHaveCount(1);
  await expect(preview(page)).toContainText("Πολιτεία");
  await expect(preview(page)).not.toContainText("Platonis");
  // Its only link is the note; the next stop is the last marker, then the notes themselves.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(marker(page, "cite-3-ref-1")).toBeFocused();
  await expect(preview(page)).toContainText("window.__citationXss");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(preview(page)).toBeHidden();
  await expect(page.locator("[aria-describedby]")).toHaveCount(0);
});

test("pointer: hover opens it, leaving closes it, a press outside closes it, a click follows the link", async ({ page }) => {
  await open(page);
  const second = marker(page, "cite-2-ref-1");
  await second.hover(await onNumber(second));
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toContainText("Πολιτεία");
  await page.mouse.move(1, 1);
  await expect(preview(page)).toBeHidden();
  await second.focus();
  await expect(preview(page)).toBeVisible();
  await page.locator("h1").click();
  await expect(preview(page)).toBeHidden();
  await second.click(await onNumber(second));
  await expect(page).toHaveURL(/#cite-2$/);
  await expect(page.locator("#cite-2")).toBeFocused();
});

test("touch: the first tap opens the preview, a second tap follows the link", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 700 } });
  const page = await context.newPage();
  await open(page);
  const first = marker(page, "cite-1-ref-1");
  await first.tap(await onNumber(first));
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toContainText("Platonis Rempublicam");
  expect(page.url()).not.toMatch(/#cite-1$/);
  await first.tap(await onNumber(first));
  await expect(page).toHaveURL(/#cite-1$/);
  await context.close();
});

test("at the viewport's edges the preview stays on screen, opening above near the bottom", async ({ browser }) => {
  // 320 CSS pixels wide is a 1280-pixel window at 400% zoom.
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  await open(page);
  const last = marker(page, "cite-3-ref-1");
  await last.scrollIntoViewIfNeeded();
  // Bring the marker to the bottom of the viewport, then focus it without scrolling.
  await last.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().bottom - window.innerHeight + 24));
  await last.evaluate((element) => element.focus({ preventScroll: true }));
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toHaveAttribute("data-side", "above");
  // Both boxes come from one layout pass, so a reflow cannot fall between them.
  const [box, at] = await page.evaluate(
    (elements) => elements.map((element) => element.getBoundingClientRect().toJSON()),
    [await preview(page).elementHandle(), await last.elementHandle()],
  );
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(at.y);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});

test("reduced motion: the preview appears without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page);
  await marker(page, "cite-1-ref-1").focus();
  await expect(preview(page)).toBeVisible();
  expect(await preview(page).evaluate((element) => getComputedStyle(element).animationName)).toBe("ob-citation-preview-in");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await marker(page, "cite-2-ref-1").focus();
  await expect(preview(page)).toBeVisible();
  expect(await preview(page).evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
});

test("hostile reference text is shown as text, and the component makes no requests", async ({ page }) => {
  const requests = [];
  await open(page);
  page.on("request", (request) => requests.push(request.url()));
  await marker(page, "cite-3-ref-1").focus();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator(".ob-citation-preview-reference")).toHaveText(HOSTILE);
  await expect(preview(page).locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__citationXss)).toBeUndefined();
  // The links it shows are the data's link and the note.
  const hrefs = await preview(page).locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs).toEqual(["#cite-3"]);
  const cited = marker(page, "cite-1-ref-1");
  await cited.hover(await onNumber(cited));
  await expect(preview(page)).toContainText("Platonis");
  expect(requests).toEqual([]);
});

test("it works under the strict content security policy", async ({ page }) => {
  await page.route(`${origin}/cave/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await open(page);
  // The page's own inline theme snippet may be refused by this policy; nothing the component
  // does is.
  const before = await page.evaluate(() => window.__violations.slice());
  expect(before.filter((violation) => violation.includes("ob-citation-previews"))).toEqual([]);
  const first = marker(page, "cite-1-ref-1");
  await first.focus();
  await expect(preview(page)).toBeVisible();
  const offset = await preview(page).evaluate((element) => element.style.getPropertyValue("--ob-citation-preview-y"));
  expect(offset).toMatch(/^-?\d+px$/);
  await page.keyboard.press("Escape");
  const second = marker(page, "cite-2-ref-1");
  await second.hover(await onNumber(second));
  await expect(preview(page)).toContainText("Πολιτεία");
  expect(await page.evaluate(() => window.__violations)).toEqual(before);
});

test("only a page with reference data loads the component, and without JavaScript nothing changes", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const loaded = [];
  page.on("request", (request) => loaded.push(request.url()));
  await page.goto(`${origin}/plain/`);
  await expect(page.locator("h1")).toHaveText("Plain");
  expect(loaded.some((url) => url.includes("ob-citation-previews"))).toBe(false);
  await expect(page.locator("ob-citation-previews")).toHaveCount(0);
  await open(page);
  // The built page versions its asset addresses (`?v=`), so compare the path only.
  expect(loaded.some((url) => new URL(url).pathname === "/assets/components/ob-citation-previews.js")).toBe(true);
  await context.close();

  const scriptless = await browser.newContext({ javaScriptEnabled: false });
  const plain = await scriptless.newPage();
  await plain.goto(`${origin}/cave/`);
  const first = marker(plain, "cite-1-ref-1");
  await first.focus();
  await expect(plain.locator(".ob-citation-preview")).toHaveCount(0);
  await plain.keyboard.press("Enter");
  await expect(plain).toHaveURL(/#cite-1$/);
  await expect(plain.locator("#cite-1")).toBeFocused();
  await scriptless.close();
});
