import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Citation-preview security, accessibility and publication regressions (#67): hostile reference
// data never executes and the page asks nothing of any other origin; the component never moves the
// text, so reading position survives enhancement and browser history; slow, failing or broken
// enhancement leaves every citation followable; print shows the notes and none of the enhancement;
// at 400% zoom the preview fits the visible width; and assistive technology meets the same links
// and names with or without the component.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const COMPONENT = "/assets/components/ob-citation-previews.js";
// The component's module, whatever query string versions it.
const component = (url) => url.pathname === COMPONENT;
const LIBRARY = JSON.stringify({
  version: 1,
  sources: [
    {
      id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam", issued: "2003",
      identifiers: [{ scheme: "doi", value: "doi:10.1000/xyz" }],
    },
    { id: "plato-republic", kind: "work", title: "Πολιτεία" },
    { id: "script", kind: "work", title: "</script><script>window.__citationXss=1</script>" },
    {
      id: "image", kind: "work", title: `<img src="https://tracker.example/pixel.png" onerror="window.__citationXss=2">`,
      creators: [{ name: `" onmouseover="window.__citationXss=3`, role: "author" }],
    },
    { id: "elsewhere", kind: "work", title: "A site elsewhere", identifiers: [{ scheme: "url", value: "https://evil.example/track?id=1" }] },
    { id: "unbroken", kind: "work", title: "W".repeat(400) },
  ],
});
const filler = (from) => Array.from({ length: 12 }, (_, index) => `Paragraph ${from + index} of the argument.`).join("\n\n");
const POST = `---
title: The cave
date: 2026-10-20
citations: notes
---
The cave [@slings-2003, page 514] and the work [@plato-republic, canonical 514a].

${filler(1)}

A script [@script], an image [@image] and a site elsewhere [@elsewhere].

${filler(13)}

An unbroken title [@unbroken] near the end, and the edition again [@slings-2003, page 514].

${filler(25)}
`;
let root;
let server;
let origin;

// Smooth scrolling (the default without a reduced-motion preference) would make positions depend
// on timing.
test.use({ reducedMotion: "reduce" });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-citation-regressions-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Regressions", url: "https://regressions.example.org", postPath: "/{slug}/", author: { name: "A" } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "cave.md"), POST);
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
const markers = (page) => page.locator('a[role="doc-noteref"]');

// A marker's first box is its visually hidden "Citation " prefix, clipped out of hit testing, so
// Playwright's default point would land on the paragraph. A pointer aims at the visible number.
async function onNumber(locator) {
  const { width, height } = await locator.boundingBox();
  return { position: { x: width / 2, y: height / 2 } };
}

/** The cave page once the component has enhanced it. */
async function enhanced(page, hash = "") {
  await page.goto(`${origin}/cave/${hash}`);
  await page.waitForFunction(() => customElements.get("ob-citation-previews") !== undefined);
}

test("hostile reference data never executes and nothing is requested from another origin", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  context.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  await enhanced(page);
  const count = await markers(page).count();
  expect(count).toBe(7);
  for (let index = 0; index < count; index += 1) {
    const marker = markers(page).nth(index);
    await marker.focus();
    await expect(preview(page)).toBeVisible();
    await expect(preview(page).locator("img, script, svg, iframe, object")).toHaveCount(0);
    const hrefs = await preview(page).locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    for (const href of hrefs) expect(href).toMatch(/^(#cite-\d+|https?:\/\/[^\s"<>]+)$/);
    await marker.hover(await onNumber(marker));
  }
  await expect(preview(page)).toBeVisible();
  // The text is shown, as text.
  await page.locator('[id="cite-4-ref-1"]').focus();
  await expect(preview(page).locator(".ob-citation-preview-reference")).toContainText(`<img src="https://tracker.example/pixel.png"`);
  // A link the data allows is shown, but nothing fetches it.
  await page.locator('[id="cite-5-ref-1"]').focus();
  await expect(preview(page).getByRole("link", { name: "https://evil.example/track?id=1" })).toBeVisible();
  expect(await page.evaluate(() => window.__citationXss)).toBeUndefined();
  expect(errors).toEqual([]);
  const foreign = requests.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith("data:"));
  expect(foreign).toEqual([]);
  await context.close();
});

test("the component never moves the text: every marker and note sits where it does without it", async ({ browser }) => {
  const positions = async (blocked) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    if (blocked) await page.route(component, (route) => route.abort());
    await page.goto(`${origin}/cave/#cite-2`);
    if (!blocked) await page.waitForFunction(() => customElements.get("ob-citation-previews") !== undefined);
    await expect(page.locator("#cite-2:target")).toHaveCount(1);
    await expect(page.locator("#cite-2")).toBeInViewport();
    const measured = await page.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      height: document.documentElement.scrollHeight,
      at: [...document.querySelectorAll('a[role="doc-noteref"], .ob-citation-note')].map((element) => Math.round(element.getBoundingClientRect().top + window.scrollY)),
    }));
    await context.close();
    return measured;
  };
  const without = await positions(true);
  const withIt = await positions(false);
  expect(withIt).toEqual(without);
});

test("reading position survives following a citation and browser history, with the component", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await enhanced(page);
  const marker = page.locator('[id="cite-6-ref-1"]');
  await marker.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 300));
  const reading = await page.evaluate(() => Math.round(window.scrollY));
  // A mouse click follows the link as without JavaScript, and Back returns to the same place.
  await marker.click(await onNumber(marker));
  await expect(page).toHaveURL(/#cite-6$/);
  await expect(page.locator("#cite-6")).toBeFocused();
  await expect(page.locator("#cite-6")).toBeInViewport();
  await page.goBack();
  await expect(page).not.toHaveURL(/#/);
  await expect.poll(() => page.evaluate((at) => Math.abs(Math.round(window.scrollY) - at), reading)).toBeLessThanOrEqual(1);
  await expect(marker).toBeInViewport();
  // The way back from the note returns focus to the marker; its preview opens beside it without
  // scrolling anything.
  await marker.click(await onNumber(marker));
  await expect(page.locator("#cite-6")).toBeFocused();
  await page.locator('#cite-6 a[href="#cite-6-ref-1"]').click();
  await expect(page).toHaveURL(/#cite-6-ref-1$/);
  await expect(marker).toBeFocused();
  await expect(marker).toBeInViewport();
  await expect(preview(page)).toBeVisible();
  const returned = await page.evaluate(() => Math.round(window.scrollY));
  await page.keyboard.press("Escape");
  await expect(preview(page)).toBeHidden();
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(returned);
  await page.goBack();
  await expect(page).toHaveURL(/#cite-6$/);
  await expect(page.locator("#cite-6")).toBeInViewport();
  await context.close();
});

test("slow, failing or broken enhancement leaves every citation followable", async ({ browser }) => {
  const follow = async (page) => {
    const marker = page.locator('[id="cite-1-ref-1"]');
    await marker.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#cite-1$/);
    await expect(page.locator("#cite-1")).toBeFocused();
  };
  // Slow: until the component arrives the page is the plain page.
  {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    let release;
    const arrived = new Promise((done) => { release = done; });
    await page.route(component, async (route) => {
      await arrived;
      await route.continue();
    });
    // A module script holds back DOMContentLoaded, so wait only for the text itself.
    await page.goto(`${origin}/cave/`, { waitUntil: "commit" });
    await expect(page.locator('[id="cite-1-ref-1"]')).toBeVisible();
    await follow(page);
    await expect(preview(page)).toHaveCount(0);
    release();
    await page.waitForFunction(() => customElements.get("ob-citation-previews") !== undefined);
    await page.locator('[id="cite-2-ref-1"]').focus();
    await expect(preview(page)).toBeVisible();
    await context.close();
  }
  // Failing: the module never loads.
  {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.route(component, (route) => route.abort());
    await page.goto(`${origin}/cave/`);
    await follow(page);
    await expect(preview(page)).toHaveCount(0);
    await context.close();
  }
  // Broken: the module throws as it loads.
  {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(component, (route) => route.fulfill({ contentType: "text/javascript", body: "throw new Error('broken enhancement');" }));
    await page.goto(`${origin}/cave/`);
    await expect.poll(() => errors.some((message) => message.includes("broken enhancement"))).toBe(true);
    await follow(page);
    await expect(preview(page)).toHaveCount(0);
    await context.close();
  }
});

test("print shows every note and none of the enhancement", async ({ page }) => {
  await enhanced(page);
  await page.locator('[id="cite-1-ref-1"]').focus();
  await expect(preview(page)).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(preview(page)).toBeHidden();
  const notes = page.locator(".ob-citation-note");
  await expect(notes).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) await expect(notes.nth(index)).toBeVisible();
  await expect(page.locator(".ob-citation-back").first()).toBeHidden();
  await expect(page.locator('[role="doc-endnotes"]')).toContainText("Platonis Rempublicam");
});

test("at 400% zoom the preview of an unbroken title fits the visible width", async ({ browser }) => {
  // 320 CSS pixels wide is a 1280-pixel window at 400% zoom.
  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await enhanced(page);
  const marker = page.locator('[id="cite-6-ref-1"]');
  await marker.scrollIntoViewIfNeeded();
  await marker.focus();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toContainText("WWWW");
  const { left, right, width, visible, overflow } = await preview(page).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = document.documentElement;
    return { left: box.left, right: box.right, width: box.width, visible: view.clientWidth, overflow: view.scrollWidth - view.clientWidth };
  });
  expect(left).toBeGreaterThanOrEqual(7.5);
  expect(right).toBeLessThanOrEqual(visible - 7.5);
  expect(width).toBeLessThanOrEqual(visible - 16 + 0.5);
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});

test("assistive technology meets the same links and names with or without the component", async ({ browser }) => {
  const names = async (javaScriptEnabled) => {
    const context = await browser.newContext({ javaScriptEnabled, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${origin}/cave/`);
    if (javaScriptEnabled) await page.waitForFunction(() => customElements.get("ob-citation-previews") !== undefined);
    const found = await page.locator('a[role="doc-noteref"], a[role="doc-backlink"], .ob-citation-note a').evaluateAll((links) => links.map((link) => [link.id, link.getAttribute("href"), link.getAttribute("role"), link.textContent]));
    await context.close();
    return found;
  };
  expect(await names(true)).toEqual(await names(false));

  // While a preview is open it describes its marker, is a named group, and goes away cleanly.
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await enhanced(page);
  const marker = page.getByRole("link", { name: "Citation 3", exact: true });
  await marker.focus();
  await expect(page.getByRole("group", { name: "Citation 3" })).toBeVisible();
  await expect(marker).toHaveAccessibleDescription(/window\.__citationXss=1/);
  const described = await marker.getAttribute("aria-describedby");
  await expect(page.locator(`[id="${described}"]`)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(marker).toBeFocused();
  await expect(marker).not.toHaveAttribute("aria-describedby", /./);
  await context.close();
});
