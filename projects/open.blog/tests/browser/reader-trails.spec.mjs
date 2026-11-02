import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// A reader's local saved sources and reading trails on a published post (#86, ADR 0242): opt-in and
// disclosed, nothing recorded as a reader reads, ordering and duplicates, keyboard use and
// announcements, clearing one item or everything, storage that is denied, full, unreadable or at its
// limits, hostile text shown as text, 320px, no requests, and the page without JavaScript.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const HOSTILE = `<img src=x onerror="window.__trailXss=1">`;
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
const CAVE = `---
title: The cave
date: 2026-10-20
citations: notes
---
The cave [@slings-2003, page 514] and the work [@plato-republic, canonical 514a].

A hostile title [@hostile].

Shadows on the wall stay shadows.
`;
const PLAIN = "---\ntitle: Plain\ndate: 2026-10-19\n---\nNo citations here, only shadows.\n";
const KEY = "openblog.reader-annotations";
const NOW = "2026-10-27T09:30:00Z";
const REVISION = "p1:0123456789abcdef0123456789abcdef";
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-reader-trails-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Trails",
    url: "https://trails-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    readerAnnotations: { enabled: true },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "cave.md"), CAVE);
  writeFileSync(join(root, "content", "posts", "plain.md"), PLAIN);
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

const panel = (page) => page.getByRole("region", { name: "Your reading trails and saved sources" });
const notes = (page) => page.getByRole("region", { name: "Your highlights and notes" });
const saved = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEY);
const raw = (page) => page.evaluate((key) => localStorage.getItem(key), KEY);

async function open(page, path = "/cave/") {
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => customElements.get("ob-reading-trail") !== undefined);
  await expect(panel(page).locator(".ob-trail-lead")).toBeVisible();
}

const work = (path) => ({ site: origin, path });
const note = (id, path, text) => ({ id, kind: "note", work: work(path), revision: REVISION, target: { version: 1, kind: "work" }, text, createdAt: NOW, updatedAt: NOW });
const link = (id, title, url) => ({ id, kind: "source", title, url, createdAt: NOW, updatedAt: NOW });
const post = (id, title, path) => ({ id, kind: "source", title, work: work(path), createdAt: NOW, updatedAt: NOW });
const trail = (id, title, refs) => ({ id, kind: "trail", title, steps: refs.map((ref) => ({ ref })), createdAt: NOW, updatedAt: NOW });
const documentOf = (parts) => ({
  format: "openblog.reader-annotations",
  version: 1,
  privacy: { scope: "reader-private", notes: "included" },
  annotations: [],
  sources: [],
  trails: [],
  ...parts,
});

/** Saved data present from the first load of the next page only. */
async function seed(page, value) {
  await page.addInitScript(({ key, text }) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(key, text);
    }
  }, { key: KEY, text: typeof value === "string" ? value : JSON.stringify(value) });
}

const RICH = () => documentOf({
  annotations: [note("n1", "/cave/", "Cave note"), note("n2", "/plain/", "Plain one"), note("n3", "/plain/", "Plain two")],
  sources: [link("s1", "Kettle guide", "https://example.org/kettles"), post("s2", "Plain post", "/plain/")],
  trails: [trail("t1", "Cave trail", ["s1", "n1"]), trail("t2", "Plain trail", ["n2"])],
});

test("nothing is recorded as a reader reads, and the panel says so", async ({ page }) => {
  const outside = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) outside.push(request.url());
  });
  await open(page);
  await expect(panel(page).locator(".ob-reading-trail-static")).toHaveCount(0);
  await expect(panel(page)).toContainText("Nothing is recorded as you read");
  await expect(panel(page)).toContainText("never sent anywhere");
  await page.goto(`${origin}/plain/`);
  await page.waitForFunction(() => customElements.get("ob-reading-trail") !== undefined);
  await expect(panel(page).getByText("No trails yet.")).toBeVisible();
  expect(await raw(page)).toBeNull();
  expect(outside).toEqual([]);
});

test("keyboard: save sources, build a trail, reorder it, and hear each change", async ({ page }) => {
  await open(page);
  const trails = panel(page);
  const status = trails.getByRole("status");

  // Save this post, once.
  const savePost = trails.getByRole("button", { name: "Save this post as a source" });
  await savePost.focus();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("This post is saved as a source.");
  await expect(trails.getByRole("link", { name: "The cave" })).toBeVisible();
  await expect(savePost).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(trails.locator(".ob-trail-error:not([hidden])")).toHaveText(/That source is already saved\./);
  expect((await saved(page)).sources).toHaveLength(1);
  expect((await saved(page)).sources[0]).toMatchObject({ kind: "source", title: "The cave", work: { site: origin, path: "/cave/" } });

  // Save every reference the post cites: a link keeps where it was found, one without a link points to its note.
  const select = trails.getByLabel("A reference this post cites");
  const count = await select.locator("option").count();
  expect(count).toBeGreaterThanOrEqual(2);
  for (let index = 0; index < count; index += 1) {
    await select.selectOption({ index });
    await trails.getByRole("button", { name: "Save the reference" }).click();
    await expect(trails.getByRole("list", { name: "Your saved sources" }).getByRole("listitem")).toHaveCount(2 + index);
  }
  const sources = (await saved(page)).sources;
  expect(sources).toHaveLength(1 + count);
  const doi = sources.find((source) => source.url?.startsWith("https://doi.org/"));
  expect(doi).toMatchObject({ from: { site: origin, path: "/cave/" } });
  const pointer = sources.find((source) => source.url?.startsWith(`${origin}/cave/#`));
  expect(pointer).toMatchObject({ from: { site: origin, path: "/cave/" } });
  await expect(trails.getByRole("listitem").filter({ hasText: "Link to doi.org" })).toContainText("Found in this post");
  // Saving the same reference again is refused and changes nothing.
  await select.selectOption({ index: 0 });
  await trails.getByRole("button", { name: "Save the reference" }).click();
  await expect(trails.locator(".ob-trail-error:not([hidden])")).toHaveText(/already saved/);
  expect((await saved(page)).sources).toHaveLength(1 + count);

  // A highlight made in the other panel is listed here without a reload.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector(".ob-prose"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf("Shadows on the wall");
      if (at >= 0) getSelection().setBaseAndExtent(node, at, node, at + "Shadows on the wall".length);
    }
  });
  await notes(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(trails.getByRole("list", { name: "Posts you have highlighted or noted" })).toContainText("1 highlight");

  // Name a trail with the keyboard.
  await trails.getByLabel("Name a new trail").fill("Reading the cave");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("Started the trail: Reading the cave.");
  await expect(trails.getByRole("heading", { name: "Reading the cave", level: 4 })).toBeVisible();
  await expect(trails.getByLabel("Name a new trail")).toHaveValue("");
  await expect(trails.getByLabel("Name a new trail")).toBeFocused();

  // Add three things; each leaves the choices as it was found and is offered no longer.
  const items = trails.getByLabel("This source, highlight or note");
  const before = await items.locator("option").count();
  const order = [];
  for (const wanted of [/Source: The cave/, /Highlight: Shadows on the wall/, /Source: Platonis/]) {
    const label = await items.locator("option").filter({ hasText: wanted }).first().textContent();
    order.push(label);
    await items.selectOption({ label });
    await trails.getByRole("button", { name: "Add to the trail" }).click();
    await expect(status).toContainText("Added to the trail");
    await expect(items.locator("option").filter({ hasText: label })).toHaveCount(0);
  }
  expect(await items.locator("option").count()).toBe(before - 3);
  const steps = trails.getByRole("list", { name: "Steps of Reading the cave" }).getByRole("listitem");
  await expect(steps).toHaveCount(3);
  const refs = (await saved(page)).trails[0].steps.map((step) => step.ref);
  expect(refs).toHaveLength(3);
  await expect(steps.nth(0)).toContainText("Source: The cave");
  await expect(steps.nth(1)).toContainText("Highlight: Shadows on the wall");
  await expect(steps.nth(2)).toContainText("Source: Platonis");

  // Reorder by keyboard: the third step moves earlier and keeps the focus.
  const earlier = steps.nth(2).getByRole("button", { name: /Move earlier/ });
  await earlier.focus();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("Moved earlier, to step 2 of 3.");
  await expect(steps.nth(1)).toContainText("Source: Platonis");
  await expect(steps.nth(1).getByRole("button", { name: /Move earlier/ })).toBeFocused();
  const reordered = (await saved(page)).trails[0].steps.map((step) => step.ref);
  expect(reordered).toEqual([refs[0], refs[2], refs[1]]);
  // The first step cannot move earlier and the last cannot move later.
  await expect(steps.nth(0).getByRole("button", { name: /Move earlier/ })).toBeDisabled();
  await expect(steps.nth(2).getByRole("button", { name: /Move later/ })).toBeDisabled();

  // Removing a step keeps the source; focus moves to the next step.
  await steps.nth(1).getByRole("button", { name: /Remove from the trail/ }).click();
  await expect(status).toContainText("The source, highlight or note itself is kept");
  await expect(steps).toHaveCount(2);
  const afterRemove = await saved(page);
  expect(afterRemove.trails[0].steps).toHaveLength(2);
  expect(afterRemove.sources).toHaveLength(1 + count);
  expect(await trails.getByRole("button", { name: /Remove from the trail/ }).nth(1).evaluate((node) => node === document.activeElement)).toBe(true);
});

test("a reader can clear one item at a time, each after asking, or everything", async ({ page }) => {
  await seed(page, RICH());
  await open(page);
  const trails = panel(page);
  const status = trails.getByRole("status");

  // Keeping it changes nothing.
  await trails.getByRole("button", { name: /^Remove: Kettle guide/ }).click();
  await trails.getByRole("button", { name: /^Confirm remove: Kettle guide/ }).waitFor();
  await expect(trails.getByRole("button", { name: /^Confirm remove: Kettle guide/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("Nothing was changed.");
  expect((await saved(page)).sources).toHaveLength(2);

  // Removing a source takes it out of every trail and keeps the rest.
  await trails.getByRole("button", { name: /^Remove: Kettle guide/ }).click();
  await trails.getByRole("button", { name: /^Confirm remove: Kettle guide/ }).click();
  await expect(status).toHaveText("The source was removed.");
  let now = await saved(page);
  expect(now.sources.map((source) => source.id)).toEqual(["s2"]);
  expect(now.trails.find((each) => each.id === "t1").steps).toEqual([{ ref: "n1" }]);

  // Deleting a trail keeps what it named.
  await trails.getByRole("button", { name: /^Delete the trail: Plain trail/ }).click();
  await trails.getByRole("button", { name: /^Confirm delete: Plain trail/ }).click();
  await expect(status).toContainText("The trail was deleted");
  now = await saved(page);
  expect(now.trails.map((each) => each.id)).toEqual(["t1"]);
  expect(now.annotations).toHaveLength(3);

  // Removing a post's highlights and notes takes them out of trails too.
  await trails.getByRole("button", { name: /^Remove these highlights and notes: \/cave\// }).click();
  await trails.getByRole("button", { name: /^Confirm remove: \/cave\// }).click();
  now = await saved(page);
  expect(now.annotations.map((each) => each.id)).toEqual(["n2", "n3"]);
  expect(now.trails[0].steps).toEqual([]);
  // The other panel dropped it without a reload.
  await expect(notes(page).getByRole("listitem")).toHaveCount(0);

  // Everything.
  await trails.getByRole("button", { name: /^Clear all my local data/ }).click();
  await expect(trails.getByText(/including anything this page could not read/)).toBeVisible();
  await trails.getByRole("button", { name: /^Confirm clear everything/ }).click();
  await expect(status).toHaveText("Everything was cleared from this browser.");
  expect(await raw(page)).toBeNull();
  await expect(trails.getByText("No trails yet.")).toBeVisible();
  await expect(trails.getByText("You have not highlighted or noted anything yet.")).toBeVisible();
});

test("the two panels share one document: a note on this post is listed and cleared across them", async ({ page }) => {
  await seed(page, RICH());
  await open(page);
  await expect(notes(page).getByRole("listitem")).toHaveCount(1);
  await expect(panel(page).getByRole("list", { name: "Posts you have highlighted or noted" })).toContainText("/cave/ (this post)");
  await panel(page).getByRole("button", { name: /^Clear all my local data/ }).click();
  await panel(page).getByRole("button", { name: /^Confirm clear everything/ }).click();
  await expect(notes(page).getByRole("listitem")).toHaveCount(0);
});

test("storage that is full changes nothing and says why", async ({ page }) => {
  await seed(page, RICH());
  await open(page);
  const before = await raw(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await panel(page).getByRole("button", { name: "Save this post as a source" }).click();
  await expect(panel(page).locator(".ob-trail-error:not([hidden])")).toContainText("no room to save");
  await expect(panel(page).getByRole("status")).toContainText("nothing was changed");
  await panel(page).getByLabel("Name a new trail").fill("Another");
  await page.keyboard.press("Enter");
  await expect(panel(page).locator("[id$=\"-trail-error\"]:not([hidden])")).toContainText("no room to save");
  await expect(panel(page).getByLabel("Name a new trail")).toHaveAttribute("aria-invalid", "true");
  expect(await raw(page)).toBe(before);
  await expect(panel(page).getByRole("heading", { name: "Another" })).toHaveCount(0);
});

test("private browsing or blocked storage: the panel says so and nothing breaks", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  await open(page);
  await expect(page.getByRole("heading", { name: "The cave", level: 1 })).toBeVisible();
  await expect(panel(page).locator(".ob-trail-notice")).toContainText("does not allow saving");
  await panel(page).getByRole("button", { name: "Save this post as a source" }).click();
  await expect(panel(page).getByRole("status")).toContainText("does not allow saving here, so nothing was changed");
  await expect(panel(page).getByText("No sources saved yet.")).toBeVisible();
  await panel(page).getByRole("button", { name: /^Clear all my local data/ }).click();
  await panel(page).getByRole("button", { name: /^Confirm clear everything/ }).click();
  await expect(panel(page).getByRole("status")).toContainText("would not let the saved data be cleared");
});

test("unreadable saved data is never written over, and the reader can still clear it", async ({ page }) => {
  const text = "{ not a reader annotation document";
  await seed(page, text);
  await open(page);
  await expect(panel(page).locator(".ob-trail-notice")).toContainText("could not be read");
  await panel(page).getByRole("button", { name: "Save this post as a source" }).click();
  await expect(panel(page).locator(".ob-trail-error:not([hidden])")).toContainText("could not be read");
  await panel(page).getByLabel("Name a new trail").fill("Mine");
  await page.keyboard.press("Enter");
  expect(await raw(page)).toBe(text);
  await panel(page).getByRole("button", { name: /^Clear all my local data/ }).click();
  await panel(page).getByRole("button", { name: /^Confirm clear everything/ }).click();
  expect(await raw(page)).toBeNull();
  await expect(panel(page).locator(".ob-trail-notice")).toBeHidden();
  await panel(page).getByRole("button", { name: "Save this post as a source" }).click();
  expect((await saved(page)).sources).toHaveLength(1);
});

test("the limits are explained: no more than 50 trails", async ({ page }) => {
  const full = documentOf({ trails: Array.from({ length: 50 }, (_, index) => trail(`t${index}`, `Trail ${index}`, [])) });
  await seed(page, full);
  await open(page);
  await panel(page).getByLabel("Name a new trail").fill("One too many");
  await page.keyboard.press("Enter");
  await expect(panel(page).locator(".ob-trail-error:not([hidden])")).toContainText("no room for another one");
  expect((await saved(page)).trails).toHaveLength(50);
});

test("hostile titles and links are shown as text and never run", async ({ page }) => {
  await seed(page, documentOf({
    sources: [link("s1", HOSTILE, "https://example.org/%3Cb%3E")],
    trails: [trail("t1", HOSTILE, ["s1"])],
  }));
  await open(page);
  await expect(panel(page).getByRole("link", { name: HOSTILE }).first()).toBeVisible();
  await expect(panel(page).locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__trailXss)).toBeUndefined();
  await expect(panel(page).getByRole("link", { name: HOSTILE }).first()).toHaveAttribute("href", "https://example.org/%3Cb%3E");
});

test("a javascript: link in saved data is refused whole and nothing in the panel follows it", async ({ page }) => {
  const bad = documentOf({ sources: [link("s1", "Bad", "javascript:window.__trailXss=1")] });
  await seed(page, bad);
  await open(page);
  await expect(panel(page).locator(".ob-trail-notice")).toContainText("could not be read");
  await expect(panel(page).locator('a[href^="javascript"]')).toHaveCount(0);
  expect(await raw(page)).toBe(JSON.stringify(bad));
});

test("320px phone and reduced motion: no horizontal overflow of the region", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 700 });
  await seed(page, documentOf({
    annotations: [note("n1", "/cave/", "x".repeat(300))],
    sources: [link("s1", "A very long source title ".repeat(8), `https://example.org/${"long-segment/".repeat(12)}`)],
    trails: [trail("t1", "A trail with a long name ".repeat(6), ["s1", "n1"])],
  }));
  await open(page);
  await expect(panel(page).getByRole("listitem").first()).toBeVisible();
  const overflow = await panel(page).evaluate((region) => region.scrollWidth - region.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const motion = await panel(page).evaluate((region) =>
    [...region.querySelectorAll("*")].every((node) => parseFloat(getComputedStyle(node).transitionDuration) === 0 && parseFloat(getComputedStyle(node).animationDuration) === 0));
  expect(motion).toBe(true);
});

test("without JavaScript the post reads as usual and the region says what it needs", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/cave/`);
  await expect(page.getByText("Shadows on the wall stay shadows.")).toBeVisible();
  await expect(page.locator(".ob-reading-trail-static")).toContainText("need JavaScript");
  await expect(page.locator(".ob-reading-trail-static")).toContainText("Nothing is recorded as you read");
  await expect(page.locator(".ob-trail-body")).toHaveCount(0);
  await context.close();
});
