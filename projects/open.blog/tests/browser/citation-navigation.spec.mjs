import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The published reader page of a post with citations, with and without JavaScript: following a
// marker lands focus on its note, each way back returns to the marker it names (repeated citations
// included), the notes are one named endnotes region, long addresses wrap at high zoom, print keeps
// every note, and the inline reference data matches the anchors on the page.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const LONG_URL = `https://example.org/${"a-very-long-path-segment-".repeat(12)}end`;
const LIBRARY = JSON.stringify({
  version: 1,
  sources: [
    { id: "plato-republic", kind: "work", title: "Πολιτεία", creators: [{ name: "Plato", role: "author" }] },
    {
      id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam", issued: "2003",
      identifiers: [{ scheme: "doi", value: "doi:10.1000/xyz" }],
    },
    { id: "long-address", kind: "work", title: "A source with a long address", identifiers: [{ scheme: "url", value: LONG_URL }] },
  ],
});
const filler = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} keeps the notes below the fold.`).join("\n\n");
const POST = `---
title: The cave
date: 2026-10-20
citations: notes
---
The cave [@slings-2003, page 514].

${filler}

Again [@slings-2003, page 514], the work [@plato-republic, canonical 514a] and [@long-address].
`;
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-citation-navigation-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  const library = join(root, ".openblog", "private", "research", "sources.json");
  mkdirSync(dirname(library), { recursive: true });
  writeFileSync(library, LIBRARY);
  writeFileSync(join(root, "content", "posts", "cave.md"), POST);
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

const marker = (page, number, occurrence = 0) =>
  page.getByRole("link", { name: `Citation ${number}`, exact: true }).nth(occurrence);
const back = (page, name) => page.getByRole("link", { name, exact: true });

for (const javaScriptEnabled of [false, true]) {
  test(`keyboard navigation follows each citation to its note and back (JavaScript ${javaScriptEnabled ? "on" : "off"})`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    await page.goto(`${origin}/cave/`);
    await expect(marker(page, 1)).toBeVisible();
    await expect(page.getByRole("link", { name: "Citation 1", exact: true })).toHaveCount(2);

    // First citation: marker to note, note to the first way back, back to the marker.
    await marker(page, 1).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#cite-1$/);
    const note = page.locator("#cite-1");
    await expect(note).toBeFocused();
    await expect(note).toBeInViewport();
    await expect(note).toContainText("Platonis Rempublicam");
    await page.keyboard.press("Tab");
    await expect(page.locator("#cite-1 a").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(back(page, "Back to citation 1 (1)")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#cite-1-ref-1$/);
    await expect(marker(page, 1, 0)).toBeFocused();
    await expect(marker(page, 1, 0)).toBeInViewport();

    // The repeated citation shares the note and returns to its own place.
    await marker(page, 1, 1).focus();
    await page.keyboard.press("Enter");
    await expect(note).toBeFocused();
    await back(page, "Back to citation 1 (2)").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#cite-1-ref-2$/);
    await expect(marker(page, 1, 1)).toBeFocused();
    await expect(marker(page, 1, 1)).toBeInViewport();

    // History restores the reading position: Back returns to the note, then to the text.
    await page.goBack();
    await expect(page).toHaveURL(/#cite-1$/);
    await context.close();
  });
}

test("the notes are one region named by their heading, and every anchor resolves", async ({ page }) => {
  await page.goto(`${origin}/cave/`);
  const region = page.locator('[role="doc-endnotes"]');
  await expect(region).toHaveCount(1);
  const labelledBy = await region.getAttribute("aria-labelledby");
  await expect(page.locator(`#${labelledBy}`)).toHaveText(/^Notes/);
  // Four citations, two of them identical, make three notes.
  await expect(region.locator(".ob-citation-note")).toHaveCount(3);
  await expect(page.locator('[role="doc-noteref"]')).toHaveCount(4);
  await expect(page.locator('[role="doc-backlink"]')).toHaveCount(4);
  const problems = await page.evaluate(() => {
    const data = JSON.parse(document.getElementById("ob-references").textContent);
    const found = [];
    for (const citation of data.citations) {
      const markerElement = document.getElementById(citation.marker);
      const noteElement = document.getElementById(citation.note);
      if (!markerElement || !noteElement) found.push(`missing ${citation.marker} or ${citation.note}`);
      else if (markerElement.getAttribute("href") !== `#${citation.note}`) found.push(`${citation.marker} does not link to its note`);
      if (!document.querySelector(`a[href="#${citation.marker}"]`)) found.push(`no way back to ${citation.marker}`);
    }
    for (const link of document.querySelectorAll('a[href^="#"]')) {
      const id = decodeURIComponent(link.getAttribute("href").slice(1));
      if (id && !document.getElementById(id)) found.push(`#${id} has no target`);
    }
    return found;
  });
  expect(problems).toEqual([]);
});

test("at high zoom a long address wraps inside its note", async ({ browser }) => {
  // 320 CSS pixels wide is a 1280-pixel window at 400% zoom.
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  await page.goto(`${origin}/cave/`);
  const note = page.locator(".ob-citation-note", { hasText: "A source with a long address" });
  await note.scrollIntoViewIfNeeded();
  await expect(note).toBeVisible();
  const overflow = await note.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await note.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(321);
  await context.close();
});

test("print keeps every note and hides only the ways back", async ({ page }) => {
  await page.goto(`${origin}/cave/`);
  await page.emulateMedia({ media: "print" });
  const notes = page.locator(".ob-citation-note");
  await expect(notes).toHaveCount(3);
  for (const text of ["Platonis Rempublicam", "Πολιτεία", "514a", "A source with a long address"]) {
    await expect(page.locator('[role="doc-endnotes"]')).toContainText(text);
  }
  for (let index = 0; index < 3; index += 1) await expect(notes.nth(index)).toBeVisible();
  await expect(page.locator(".ob-citation-back").first()).toBeHidden();
  await expect(marker(page, 2)).toBeVisible();
});
