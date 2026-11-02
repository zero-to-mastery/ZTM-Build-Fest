import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Contextual entry previews on a published post (ADR 0174, #74), built and served by the real
// binary from a private atlas and a post that links words to atlas entries. Without JavaScript the
// links are ordinary links to the entry pages. With it, focusing or hovering a link (or a first
// tap) shows the entry's type, provenance, approved summary and the relationships around it, from
// the public atlas-query.json alone; Tab continues into the preview with no focus trap, Escape
// closes it and returns focus, reading position is kept, reduced motion is respected, nothing
// overflows a 320px screen (a 1280px window at 400% zoom), and every failure leaves plain links.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";
const PRIVATE = "PRIVATE-PREVIEW-MARKER";
const HOSTILE = `<img src=x onerror="window.__previewXss=1">`;
const LONG_LABEL = "the extraordinarily long and unbroken allegoryofthecaveandtheshadowsonthewallthatthe prisoners mistake for the whole of reality";
const LIBRARY = { version: 1, sources: [{ id: "plato-republic", kind: "work", title: "Politeia" }] };
const NOTEBOOK = { version: 1, passages: [], notes: [] };
const entry = (id, kind, label, visibility, extra = {}) => ({ id, kind, label, visibility, ...extra });
const ATLAS = {
  version: 2,
  entries: [
    entry("plato", "person", "Plato", "approved", { summary: "An Athenian philosopher.\n\nHe wrote dialogues." }),
    entry("republic", "work", "Republic", "approved", { source: "plato-republic", summary: "A dialogue on justice." }),
    entry("allegory-of-the-cave", "concept", "Allegory of the cave", "approved", { summary: "Prisoners and shadows." }),
    entry("secret", "concept", `${PRIVATE} label`, "private", { summary: `${PRIVATE} summary` }),
  ],
  relationships: [
    {
      id: "r-authored", kind: "authored", from: "plato", to: "republic", visibility: "approved",
      assertedBy: { kind: "author" }, confidence: "plausible",
      evidence: [{ source: "plato-republic", locators: [{ kind: "canonical", value: "514a" }] }],
      uncertainty: "The dating is unsettled.",
      contestedBy: [{ by: { kind: "named", name: "A later editor" }, note: "Dates it later.", evidence: [{ source: "plato-republic" }] }],
    },
    {
      id: "r-private", kind: "influenced", from: "plato", to: "secret", visibility: "private",
      assertedBy: { kind: "author" }, evidence: [{ source: "plato-republic" }], uncertainty: `${PRIVATE} relationship`,
    },
  ],
};
const filler = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} of the argument.`).join("\n\n");
const BODY = [
  "Long ago, [Plato](atlas:plato) wrote the [Republic](atlas:republic), and described",
  `[${LONG_LABEL}](atlas:allegory-of-the-cave).`,
  "",
  "A [hidden idea](atlas:secret) and a [typo](atlas:Plato) stay plain.",
  "",
  filler,
  "",
  "At the end, [Plato](atlas:plato) again, near the bottom of the page.",
  "",
].join("\n");
// A post with both kinds of preview: a concept link in a heading and in a footnote, and a citation.
const MIXED = [
  "---",
  "title: Mixed",
  "date: 2026-10-17",
  "citations: notes",
  "---",
  "## About [Plato](atlas:plato)",
  "",
  "[Plato](atlas:plato) wrote [@plato-republic, canonical 514a] and left a note.[^1]",
  "",
  "[^1]: A footnote about the [Republic](atlas:republic) and [Plato](atlas:plato).",
  "",
].join("\n");
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-concept-previews-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Previews", url: "https://previews.example.org", author: { name: "Site Author" }, knowledgeAtlas: { publish: true } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "cave.md"), `---\ntitle: The cave\ndate: 2026-10-19\n---\n${BODY}`);
  writeFileSync(join(root, "content", "posts", "mixed.md"), MIXED);
  writeFileSync(join(root, "content", "posts", "plain.md"), "---\ntitle: Plain\ndate: 2026-10-18\n---\nNo links at all.\n");
  const research = join(root, ".openblog", "private", "research");
  mkdirSync(research, { recursive: true });
  writeFileSync(join(research, "sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(join(research, "notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(join(research, "atlas.json"), JSON.stringify(ATLAS));
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
    expect((await fetch(`${origin}/posts/cave/`)).ok).toBe(true);
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

const preview = (page) => page.locator(".ob-concept-preview");
const links = (page) => page.locator("main#main a.ob-concept");
const plato = (page) => links(page).nth(0);
const republic = (page) => links(page).nth(1);

/**
 * The cave page once the component is defined and waiting. It fetches nothing until a link
 * shows interest (focus, hover or a press), so a preview that is wanted is awaited by its own
 * assertion.
 */
async function open(page, path = "/posts/cave/") {
  await page.goto(`${origin}${path}`);
  await expect(page.locator("ob-concept-previews")).toHaveCount(1);
  await expect(page.locator("ob-concept-previews")).toHaveAttribute("data-state", /^(idle|loading|ready)$/);
}

async function overflow(page) {
  return page.evaluate(() => {
    const region = document.querySelector("main#main");
    const elements = [region, ...region.querySelectorAll("*")];
    const limit = window.innerWidth;
    const widest = Math.max(...elements.map((element) => element.getBoundingClientRect().right));
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      content: Math.max(widest - limit, region.scrollWidth - region.clientWidth),
    };
  });
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the links are ordinary links, with their hint, and nothing else appears", async ({ page }) => {
    await page.goto(`${origin}/posts/cave/`);
    await expect(links(page)).toHaveCount(4);
    await expect(plato(page)).toHaveAttribute("href", "/atlas/plato/");
    await expect(plato(page)).toHaveAccessibleName("Plato (atlas entry)");
    await expect(preview(page)).toHaveCount(0);
    await expect(page.locator("ob-concept-previews")).toBeHidden();
    await plato(page).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/atlas/plato/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plato");
  });
});

test("a link has a visible atlas indicator and the entry's type is in its preview, not repeated from the hint", async ({ page }) => {
  await open(page);
  expect(await plato(page).evaluate((element) => getComputedStyle(element).textDecorationStyle)).toBe("dotted");
  await expect(plato(page)).toHaveAccessibleName("Plato (atlas entry)");
  await plato(page).focus();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator(".ob-concept-preview-kind")).toHaveText("Person");
  // The preview's words do not say "atlas entry" again: the link's name already does.
  expect(await preview(page).locator(".ob-concept-preview-details").innerText()).not.toMatch(/atlas entry/i);
});

test("keyboard: focus opens the preview, Tab enters it, Escape returns focus, Enter follows the link", async ({ page }) => {
  await open(page);
  await plato(page).focus();
  await expect(preview(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "Plato: Person" })).toBeVisible();
  await expect(preview(page).locator(".ob-concept-preview-provenance")).toHaveText("From the author's approved Knowledge Atlas");
  await expect(preview(page)).toContainText("An Athenian philosopher.");
  // Only the first paragraph is shown, and it says the page has the rest.
  await expect(preview(page)).not.toContainText("He wrote dialogues.");
  await expect(preview(page)).toContainText("The entry's page has the rest.");
  await expect(plato(page)).toHaveAccessibleDescription(/Person.*An Athenian philosopher\./);
  await page.keyboard.press("Tab");
  const full = preview(page).getByRole("link", { name: "Read the full entry: Plato" });
  await expect(full).toBeFocused();
  await expect(full).toHaveAttribute("href", "/atlas/plato/");
  await page.keyboard.press("Escape");
  await expect(preview(page)).toBeHidden();
  await expect(plato(page)).toBeFocused();
  await expect(plato(page)).not.toHaveAttribute("aria-describedby", /./);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${origin}/atlas/plato/`);
});

test("there is no focus trap: Tab leaves the preview and the page goes on", async ({ page }) => {
  await open(page);
  await plato(page).focus();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(republic(page)).toBeFocused();
  await expect(preview(page)).toContainText("Work");
  await expect(preview(page)).not.toContainText("Person");
  // Shift+Tab goes back to the link before it, which opens its own preview in turn.
  await page.keyboard.press("Shift+Tab");
  await expect(plato(page)).toBeFocused();
  await expect(preview(page)).toContainText("Person");
  // Past the last link the focus reaches the rest of the page and the preview is closed.
  await links(page).last().focus();
  for (let step = 0; step < 4; step += 1) await page.keyboard.press("Tab");
  await expect(preview(page)).toBeHidden();
  await expect(page.locator("[aria-describedby]")).toHaveCount(0);
});

test("provenance and uncertainty: who asserts, how firmly, the dissent, the source, and nothing private", async ({ page }) => {
  await open(page);
  await plato(page).focus();
  const text = await preview(page).innerText();
  expect(text).toContain("Plato authored Republic");
  expect(text).toContain("Site Author (the site author)");
  expect(text).toContain("Plausible");
  expect(text).toContain("Contested: 1 recorded dissent.");
  expect(text).toContain("Uncertainty: The dating is unsettled.");
  expect(text).toContain("Evidence: Politeia");
  expect(text).not.toContain(PRIVATE);
  // A private relationship is neither shown nor counted.
  expect(text).not.toMatch(/more on the entry's page/);
  await republic(page).focus();
  await expect(preview(page)).toContainText("Work");
  await expect(preview(page)).toContainText("Source: Politeia");
  await expect(preview(page)).toContainText("Republic authored by Plato");
  await expect(preview(page)).toContainText("A dialogue on justice.");
});

test("pointer: hover opens it, leaving closes it, a press outside closes it, a click follows the link", async ({ page }) => {
  await open(page);
  await plato(page).hover();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toContainText("An Athenian philosopher.");
  // The pointer may move into the preview without closing it.
  await preview(page).hover();
  await expect(preview(page)).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(preview(page)).toBeHidden();
  await plato(page).focus();
  await expect(preview(page)).toBeVisible();
  await page.locator("h1").click();
  await expect(preview(page)).toBeHidden();
  await plato(page).click();
  await expect(page).toHaveURL(`${origin}/atlas/plato/`);
});

test("touch: the first tap opens the preview, a second tap follows the link", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 700 } });
  const page = await context.newPage();
  await open(page);
  // A touch screen has no hover: a concept link scrolling into view is the interest.
  await expect(page.locator("ob-concept-previews")).toHaveAttribute("data-state", "ready");
  await plato(page).tap();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toContainText("An Athenian philosopher.");
  expect(page.url()).toBe(`${origin}/posts/cave/`);
  // The preview's own link is a large enough target to reach, and a tap outside closes it.
  const box = await preview(page).getByRole("link", { name: /Read the full entry/ }).boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(16);
  await plato(page).tap();
  await expect(page).toHaveURL(`${origin}/atlas/plato/`);
  await context.close();
});

test("touch: a query file of 256 KB or more, or of unknown size, is not read until the first tap", async ({ browser }) => {
  for (const bytes of ["262144", "999999", null]) {
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 700 } });
    const page = await context.newPage();
    await page.route(`${origin}/posts/cave/`, async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const changed = bytes === null
        ? html.replace(/ data-bytes="\d+"/, "")
        : html.replace(/data-bytes="\d+"/, `data-bytes="${bytes}"`);
      await route.fulfill({ response, body: changed });
    });
    const requests = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(`${origin}/posts/cave/`);
    await expect(page.locator("ob-concept-previews")).toHaveCount(1);
    // Scroll every link into view: on a small file that is the interest, here it is not.
    for (const link of await links(page).all()) await link.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await expect(page.locator("ob-concept-previews"), `bytes ${bytes}`).toHaveAttribute("data-state", "idle");
    expect(requests.filter((path) => path.includes("atlas-query")), `bytes ${bytes}`).toEqual([]);
    // The first tap is the interest.
    await links(page).first().dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
    await expect.poll(() => requests.filter((path) => path === "/atlas-query.json").length, `bytes ${bytes}`).toBe(1);
    await context.close();
  }
});

test("opening a preview keeps the reading position", async ({ page }) => {
  await open(page);
  const last = links(page).last();
  await last.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(300);
  await last.evaluate((element) => element.focus({ preventScroll: true }));
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await last.hover();
  await expect(preview(page)).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("at the viewport's edges the preview stays on screen, opening above near the bottom", async ({ browser }) => {
  // 320 CSS pixels wide is a 1280-pixel window at 400% zoom.
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  await open(page);
  const last = links(page).last();
  await last.scrollIntoViewIfNeeded();
  await last.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().bottom - window.innerHeight + 24));
  await last.evaluate((element) => element.focus({ preventScroll: true }));
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toHaveAttribute("data-side", "above");
  const [box, at] = await page.evaluate(
    (elements) => elements.map((element) => element.getBoundingClientRect().toJSON()),
    [await preview(page).elementHandle(), await last.elementHandle()],
  );
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(at.y);
  const measured = await overflow(page);
  expect(measured.page).toBeLessThanOrEqual(0);
  expect(measured.content).toBeLessThanOrEqual(1);
  await context.close();
});

test("the regions do not overflow at 320px with a preview open on each kind of link, and at 400% zoom", async ({ browser }) => {
  for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 800 }]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.width === 1280 ? 4 : 1 });
    const page = await context.newPage();
    await open(page);
    // At 400% zoom a 1280px window is a 320 CSS pixel layout viewport.
    if (viewport.width === 1280) {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 4, mobile: false });
    }
    for (const index of [0, 1, 2]) {
      await links(page).nth(index).focus();
      await expect(preview(page)).toBeVisible();
      const measured = await overflow(page);
      expect(measured.page, `link ${index} at ${viewport.width}`).toBeLessThanOrEqual(0);
      expect(measured.content, `link ${index} at ${viewport.width}`).toBeLessThanOrEqual(1);
      const box = await preview(page).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320 + 1);
      // The preview's own text does not scroll sideways.
      expect(await preview(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
    await context.close();
  }
});

test("reduced motion: the preview appears without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page);
  await plato(page).focus();
  await expect(preview(page)).toBeVisible();
  expect(await preview(page).evaluate((element) => getComputedStyle(element).animationName)).toBe("ob-concept-preview-in");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await republic(page).focus();
  await expect(preview(page)).toBeVisible();
  expect(await preview(page).evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
});

test("it reads one public file from the site, nothing more, and only a post with links loads it", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${origin}/posts/plain/`);
  await expect(page.locator("h1")).toHaveText("Plain");
  expect(requests.some((url) => url.includes("ob-concept-previews") || url.includes("atlas-query"))).toBe(false);
  await expect(page.locator("ob-concept-previews")).toHaveCount(0);
  requests.length = 0;
  await open(page);
  // Nothing is fetched while the page is only being read.
  await page.waitForTimeout(500);
  expect(requests.filter((url) => url.includes("atlas-query")), "nothing before interest").toEqual([]);
  await plato(page).hover();
  await republic(page).hover();
  await expect(preview(page)).toBeVisible();
  const own = requests.filter((url) => new URL(url).pathname === "/atlas-query.json");
  expect(own, "fetched once however many previews open").toHaveLength(1);
  // The address names the file's content, so a changed atlas is never read from a stale cache.
  expect(new URL(own[0]).search).toMatch(/^\?v=[0-9a-f]{16}$/);
  expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
  await context.close();
});

test("the file is public: nothing private is in it or in a preview", async ({ page }) => {
  const response = await page.request.get(`${origin}/atlas-query.json`);
  const body = await response.text();
  expect(body).not.toContain(PRIVATE);
  await open(page);
  for (const index of [0, 1, 2]) {
    await links(page).nth(index).focus();
    expect(await preview(page).innerText()).not.toContain(PRIVATE);
  }
  // Unavailable ids are words, with no preview to reach.
  await expect(page.locator("main#main").getByRole("link", { name: "hidden idea" })).toHaveCount(0);
});

test("a failure leaves ordinary links: unavailable, unreadable, newer, off-site, or wrong", async ({ browser }) => {
  const query = (await (await fetch(`${origin}/atlas-query.json`)).json());
  const cases = [
    ["not found", (route) => route.fulfill({ status: 404, body: "no" })],
    ["a network failure", (route) => route.abort()],
    ["not JSON", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{ nope" })],
    ["a newer format version", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...query, formatVersion: 2 }) })],
    ["another file", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...query, format: "openblog-atlas" }) })],
    ["no entries", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...query, entries: [] }) })],
    ["entries whose pages are elsewhere", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...query, entries: query.entries.map((item) => ({ ...item, url: "/atlas/elsewhere/" })) }) })],
  ];
  for (const [name, handler] of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`${origin}/atlas-query.json?**`, handler);
    await page.route(`${origin}/atlas-query.json`, handler);
    await page.goto(`${origin}/posts/cave/`);
    await plato(page).focus();
    // The file was read and found wrong ("failed"), or read and matched no link ("ready"): either
    // way it is settled, and no link is enhanced.
    await expect(page.locator("ob-concept-previews")).toHaveAttribute("data-state", /^(failed|ready)$/, { timeout: 10000 });
    await plato(page).focus();
    await plato(page).hover();
    await page.waitForTimeout(400);
    await expect(preview(page), name).toHaveCount(0);
    expect(errors, name).toEqual([]);
    await expect(plato(page)).toHaveAttribute("href", "/atlas/plato/");
    await plato(page).click();
    await expect(page, name).toHaveURL(`${origin}/atlas/plato/`);
    await context.close();
  }
});

test("hostile data is shown as text, never as markup", async ({ page }) => {
  const query = await (await fetch(`${origin}/atlas-query.json`)).json();
  const hostile = { ...query, entries: query.entries.map((item) => item.id === "plato" ? { ...item, kindLabel: HOSTILE, label: HOSTILE, preview: HOSTILE } : item) };
  await page.route(`${origin}/atlas-query.json?**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hostile) }));
  await open(page);
  await plato(page).focus();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator(".ob-concept-preview-kind")).toHaveText(HOSTILE);
  await expect(preview(page).locator(".ob-concept-preview-summary")).toHaveText(HOSTILE);
  await expect(preview(page).locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__previewXss)).toBeUndefined();
  const hrefs = await preview(page).locator("a").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")));
  expect(hrefs).toEqual(["/atlas/plato/"]);
});

test("it works under a strict content security policy", async ({ page }) => {
  await page.route(`${origin}/posts/cave/`, async (route) => {
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
  const before = await page.evaluate(() => window.__violations.slice());
  expect(before.filter((violation) => violation.includes("concept-previews") || violation.includes("atlas-query"))).toEqual([]);
  await plato(page).focus();
  await expect(preview(page)).toBeVisible();
  expect(await preview(page).evaluate((element) => element.style.getPropertyValue("--ob-concept-preview-y"))).toMatch(/^-?\d+px$/);
  await page.keyboard.press("Escape");
  await republic(page).hover();
  await expect(preview(page)).toContainText("Work");
  expect(await page.evaluate(() => window.__violations)).toEqual(before);
});

test("a reader whose focus arrives before the file hears one announcement when it is ready", async ({ page }) => {
  let release;
  const gate = new Promise((done) => { release = done; });
  await page.route(`${origin}/atlas-query.json?**`, async (route) => {
    await gate;
    await route.continue();
  });
  await open(page);
  await plato(page).focus();
  // Nothing yet: the link is still just a link with its own name.
  await expect(preview(page)).toHaveCount(0);
  await expect(page.locator("ob-concept-previews")).toHaveAttribute("data-state", "loading");
  const status = page.getByRole("status");
  await expect(status).toHaveText("");
  release();
  await expect(preview(page)).toBeVisible();
  await expect(status).toHaveText(/Plato: Person\. An Athenian philosopher\./);
  await expect(plato(page)).toHaveAccessibleDescription(/Person.*An Athenian philosopher\./);
});

test("a concept link in a heading keeps the heading's name, and its preview is outside the heading", async ({ page }) => {
  await open(page, "/posts/mixed/");
  // The heading's own anchor link ("#") is part of its text; the concept link's hint is not.
  const heading = page.locator("main h2#about-plato");
  await expect(heading).toBeVisible();
  const link = heading.locator("a.ob-concept");
  // The hint describes the link; it is not part of the heading's text, name or the outline.
  await expect(link).toHaveAccessibleName("Plato");
  await expect(link).toHaveAccessibleDescription("Atlas entry");
  await expect(heading.locator(".ob-visually-hidden")).toHaveCount(0);
  await link.focus();
  await expect(preview(page)).toBeVisible();
  expect(await heading.locator(".ob-concept-preview").count()).toBe(0);
  expect(await preview(page).evaluate((card) => card.previousElementSibling?.matches("h2"))).toBe(true);
  await expect(link).toHaveAccessibleDescription(/Atlas entry.*Person.*An Athenian philosopher\./);
  await expect(heading).toHaveAccessibleName(/^About Plato(?! \(atlas entry\))/);
  // Tab passes the heading's own anchor, which keeps the preview open, and enters the preview.
  await page.keyboard.press("Tab");
  await expect(heading.locator("a.ob-heading-anchor")).toBeFocused();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(preview(page).getByRole("link", { name: "Read the full entry: Plato" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await expect(link).toHaveAccessibleDescription("Atlas entry");
});

test("citation previews and concept previews share a page, and a concept link in a footnote works", async ({ page }) => {
  await open(page, "/posts/mixed/");
  await expect(page.locator("ob-citation-previews")).toHaveCount(1);
  // The concept link in the body opens its own preview and not the citation's.
  await links(page).nth(1).focus();
  await expect(preview(page)).toBeVisible();
  await expect(page.locator(".ob-citation-preview")).toBeHidden();
  // The citation marker opens the citation preview and closes the concept preview.
  const marker = page.locator("[id^='cite-1-ref']").first();
  await marker.focus();
  await expect(page.locator(".ob-citation-preview")).toBeVisible();
  await expect(preview(page)).toBeHidden();
  // The concept link inside the footnote has its own preview.
  const inNote = page.locator("a.ob-concept", { hasText: "Republic" }).first();
  await inNote.focus();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toContainText("Work");
  await expect(page.locator(".ob-citation-preview")).toBeHidden();
  const box = await preview(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  await page.keyboard.press("Escape");
  await expect(preview(page)).toBeHidden();
  await expect(inNote).toBeFocused();
});

test("the components assign no field that is already a property of HTMLElement, in any form of assignment", async ({ page }) => {
  // `popover` bit the citation previews: HTMLElement's own property turned the element into a
  // string. The names are read from every component's source, and each is asked of the real
  // HTMLElement.prototype in the browser, not matched against a list kept by hand.
  const dir = join(repository, "web", "components");
  const assignment = /\bthis\.([A-Za-z_$][\w$]*)\s*(?:(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])=|=(?!=))/g;
  const update = /(?:\+\+|--)\s*this\.([A-Za-z_$][\w$]*)|\bthis\.([A-Za-z_$][\w$]*)\s*(?:\+\+|--)/g;
  // A pattern or a loop that assigns to a field of `this` would hide a name from the scan.
  const hidden = /:\s*this\.[A-Za-z_$][\w$]*\s*[,}=]|\[[^\]]*\bthis\.[A-Za-z_$][\w$]*[^\]]*\]\s*=(?!=)|\bfor\s*\(\s*(?:const|let|var)?\s*this\./g;
  // Two components deliberately use a real property of their own host: un-hiding it, and giving
  // it its text. Each is named with its file, and must still be there, so no other field hides
  // behind them.
  const intended = { "ob-theme-toggle.js": ["hidden"], "ob-views.js": ["textContent"] };
  const assigned = new Map();
  // A component's host is anything whose `extends` chain reaches HTMLElement: directly, through
  // the `BaseElement` alias (`globalThis.HTMLElement ?? class {}`) a module uses to load in node,
  // or through another class of the components.
  const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
  const sources = new Map(files.map((file) => [file, readFileSync(join(dir, file), "utf8")]));
  const parents = new Map();
  for (const source of sources.values()) {
    for (const match of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/g)) parents.set(match[1], match[2]);
  }
  const isElement = (name, seen = new Set()) => {
    if (name === "HTMLElement" || name === "BaseElement") return true;
    if (seen.has(name) || !parents.has(name)) return false;
    return isElement(parents.get(name), new Set([...seen, name]));
  };
  expect([...parents.keys()].filter((name) => isElement(name)), "the classes found to be elements").toEqual(
    expect.arrayContaining(["ObConceptPreviews", "ObAtlasTrail", "ObAtlasTimeline"]),
  );
  for (const file of files) {
    const source = sources.get(file);
    if (![...source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\s+extends\b/g)].some((match) => isElement(match[1]))) continue;
    const names = new Set();
    for (const match of source.matchAll(assignment)) names.add(match[1]);
    for (const match of source.matchAll(update)) names.add(match[1] ?? match[2]);
    for (const name of intended[file] ?? []) {
      expect(names.has(name), `${file} no longer assigns ${name}; drop the exemption`).toBe(true);
      names.delete(name);
    }
    assigned.set(file, [...names]);
    expect(source.match(hidden), `${file} assigns to a field of this through a pattern`).toBeNull();
  }
  expect(assigned.get("ob-concept-previews.js").length).toBeGreaterThanOrEqual(10);
  expect(assigned.get("ob-concept-previews.js")).toContain("state");
  await page.goto(`${origin}/posts/plain/`);
  const names = [...new Set([...assigned.values()].flat())];
  const reserved = await page.evaluate((candidates) => candidates.filter((name) => name in HTMLElement.prototype), names);
  expect(reserved, "fields that are HTMLElement properties").toEqual([]);
  // The check itself finds a property when there is one.
  expect(await page.evaluate(() => ["popover", "hidden", "title", "inert"].filter((name) => name in HTMLElement.prototype))).toEqual(["popover", "hidden", "title", "inert"]);
});
