import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Local highlights and private notes on a published post (#85, ADR 0241): selection in both
// directions and in Unicode, keyboard-only use, accessible names and announcements, bounded storage
// that is denied, full or unreadable without breaking reading, stale annotations kept and explained,
// hostile note text shown as text, reduced motion, 320px, no requests, and the page without JavaScript.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const POST = `---
title: Tides
date: 2026-10-20
---
The moon causes the tides. The sun matters too.

## Methods

We measured the tides twice a day[^1]. The tides rose.

Café crème 日本語 😀 stays whole.

## Results

The tides rose again.

[^1]: At the harbour.
`;
const SHIFTING = (words) => `---
title: Shifting
date: 2026-10-19
---
## Notes

${words}
`;
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-reader-annotations-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Annotations",
    url: "https://annotations-site.example.org",
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
const panel = (page) => page.getByRole("region", { name: "Your highlights and notes" });
const items = (page) => panel(page).getByRole("listitem");

async function open(page, path = "/tides/") {
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => customElements.get("ob-annotations") !== undefined);
  await expect(page.locator(".ob-annotations-make")).toBeVisible();
}

/** Selects `words` inside the prose, forwards, or backwards as a reader dragging right to left would. */
async function selectWords(page, words, { backward = false } = {}) {
  await page.evaluate(({ wanted, backward: reverse }) => {
    const walker = document.createTreeWalker(document.querySelector(".ob-prose"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(wanted);
      if (at < 0) continue;
      const selection = getSelection();
      selection.removeAllRanges();
      if (reverse) selection.setBaseAndExtent(node, at + wanted.length, node, at);
      else selection.setBaseAndExtent(node, at, node, at + wanted.length);
      return;
    }
    throw new Error(`no text ${wanted}`);
  }, { wanted: words, backward });
}

const saved = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEY);
const painted = (page) => page.evaluate(() => (CSS.highlights.has("ob-annotation") ? [...CSS.highlights.get("ob-annotation")].map((range) => range.toString()) : []));

test("keyboard: a reader highlights, adds a note, edits it and deletes it, and hears each state", async ({ page }) => {
  const outside = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) outside.push(request.url());
  });
  await open(page);
  await expect(page.locator(".ob-annotations-static")).toHaveCount(0);
  const article = await page.locator(".ob-prose").innerHTML();
  await selectWords(page, "twice a day");
  await expect(panel(page).locator(".ob-annotations-selection")).toHaveText("Selected: “twice a day”");

  // Tab order reaches the button without losing the selection.
  const highlight = panel(page).getByRole("button", { name: "Highlight the selected words" });
  await highlight.focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toHaveText(/Highlighted: twice a day\. Saved in this browser\./);
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText("Highlight");
  await expect(items(page).first()).toContainText("Found where you saved it");
  expect(await painted(page)).toEqual(["twice a day"]);
  // The post's markup is never changed.
  expect(await page.locator(".ob-prose").innerHTML()).toBe(article);
  const record = (await saved(page)).annotations[0];
  expect(record).toMatchObject({ kind: "highlight", work: { site: origin, path: "/tides/" }, target: { kind: "quote", exact: "twice a day" } });
  expect(record.text).toBeUndefined();

  // Edit by keyboard: the highlight gets a note.
  const edit = items(page).first().getByRole("button", { name: "Add a note to: twice a day" });
  await edit.focus();
  await page.keyboard.press("Enter");
  const field = items(page).first().getByLabel("Note on twice a day");
  await expect(field).toBeFocused();
  await page.keyboard.type("Check the harbour log.");
  await page.keyboard.press("Tab");
  await expect(items(page).first().getByRole("button", { name: "Save" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toHaveText(/Note saved\. Saved in this browser\./);
  await expect(items(page).first().getByRole("button", { name: "Edit the note on: twice a day" })).toBeFocused();
  await expect(items(page).first()).toContainText("Check the harbour log.");
  expect((await saved(page)).annotations[0]).toMatchObject({ kind: "note", text: "Check the harbour log." });

  // Escape cancels an edit and changes nothing.
  await page.keyboard.press("Enter");
  await page.keyboard.type(" more");
  await page.keyboard.press("Escape");
  await expect(panel(page).getByRole("status")).toHaveText("Editing cancelled. Nothing changed.");
  expect((await saved(page)).annotations[0].text).toBe("Check the harbour log.");

  // It survives a revisit and is painted again.
  await page.reload();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText("Check the harbour log.");
  expect(await painted(page)).toEqual(["twice a day"]);

  // Show in the post selects the passage.
  await items(page).first().getByRole("button", { name: "Show in the post: twice a day" }).click();
  expect(await page.evaluate(() => getSelection().toString())).toBe("twice a day");

  // Delete asks first, by keyboard.
  const del = items(page).first().getByRole("button", { name: "Delete: twice a day" });
  await del.focus();
  await page.keyboard.press("Enter");
  await expect(items(page).first().getByRole("button", { name: "Confirm delete: twice a day" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toHaveText(/Deleted\./);
  await expect(items(page)).toHaveCount(0);
  expect((await saved(page)).annotations).toEqual([]);
  expect(await painted(page)).toEqual([]);
  expect(outside).toEqual([]);
});

test("selection direction and Unicode: backward and forward selections give the same passage", async ({ page }) => {
  await open(page);
  await selectWords(page, "Café crème 日本語 😀", { backward: true });
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await selectWords(page, "tides rose again");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(items(page)).toHaveCount(2);
  const document = await saved(page);
  expect(document.annotations.map((each) => each.target.exact)).toEqual(["Café crème 日本語 😀", "tides rose again"]);
  expect(await painted(page)).toEqual(["Café crème 日本語 😀", "tides rose again"]);
  expect(document.annotations[1].target.section).toBe("results");
  await page.reload();
  expect(await painted(page)).toEqual(["Café crème 日本語 😀", "tides rose again"]);
});

test("notes on a section and on the whole post, and a selection that cannot be quoted", async ({ page }) => {
  await open(page);
  const region = panel(page);
  await region.getByRole("radio", { name: "A section" }).check();
  await region.getByLabel("Section for the note").selectOption({ label: "Results" });
  await region.getByLabel("Your note (private)").fill("Compare with methods.");
  await region.getByRole("button", { name: "Save note" }).click();
  await region.getByRole("radio", { name: "The whole post" }).check();
  await region.getByLabel("Your note (private)").fill("Whole post note");
  await region.getByRole("button", { name: "Save note" }).click();
  await expect(items(page)).toHaveCount(2);
  const document = await saved(page);
  expect(document.annotations[0].target).toMatchObject({ kind: "section", section: "results" });
  expect(document.annotations[1].target).toEqual({ version: 1, kind: "work" });
  await expect(items(page).first()).toContainText("the section Results");
  await expect(items(page).first()).toContainText("Found where you saved it");

  // A note with no text is refused beside the field and nothing is saved.
  await region.getByLabel("Your note (private)").fill("   ");
  await region.getByRole("button", { name: "Save note" }).click();
  await expect(region.getByLabel("Your note (private)")).toHaveAttribute("aria-invalid", "true");
  await expect(region.getByLabel("Your note (private)")).toBeFocused();
  await expect(region.getByLabel("Your note (private)")).toHaveAccessibleDescription("Error: Write your note first.");
  expect((await saved(page)).annotations).toHaveLength(2);

  // Words in the quote choice with nothing selected are refused with advice.
  await region.getByRole("radio", { name: "The words I selected" }).check();
  await region.getByLabel("Your note (private)").fill("Needs a selection");
  await region.getByRole("button", { name: "Save note" }).click();
  await expect(region.getByLabel("Your note (private)")).toHaveAccessibleDescription(/Select words in the post first/);
  // Words in one paragraph can be quoted.
  await selectWords(page, "The tides rose.");
  await expect(region.locator(".ob-annotations-selection")).toHaveText("Selected: “The tides rose.”");
});

test("hostile note text is shown as text and never runs", async ({ page }) => {
  await open(page);
  const hostile = `<img src=x onerror="window.__ran = 1"><script>window.__ran = 2</script> "quoted" & <b>bold</b>`;
  await panel(page).getByRole("radio", { name: "The whole post" }).check();
  await panel(page).getByLabel("Your note (private)").fill(hostile);
  await panel(page).getByRole("button", { name: "Save note" }).click();
  await expect(items(page).first()).toContainText(hostile);
  expect(await panel(page).locator("img, script, b").count()).toBe(0);
  await page.reload();
  await expect(items(page).first()).toContainText(hostile);
  expect(await page.evaluate(() => window.__ran)).toBeUndefined();
});

test("storage denied: reading and highlighting still work, and the reader is told", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  await open(page);
  await expect(page.getByRole("heading", { name: "Tides", level: 1 })).toBeVisible();
  await expect(panel(page).locator(".ob-annotations-notice")).toContainText("does not allow saving");
  await selectWords(page, "twice a day");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(/Kept until you leave this page\./);
  await expect(items(page)).toHaveCount(1);
  expect(await painted(page)).toEqual(["twice a day"]);
});

test("storage full: the change stays in memory and what was saved is unchanged", async ({ page }) => {
  await open(page);
  await selectWords(page, "twice a day");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(items(page)).toHaveCount(1);
  const before = await page.evaluate((key) => localStorage.getItem(key), KEY);
  await page.evaluate(() => {
    Storage.prototype.setItem = function () { throw new DOMException("full", "QuotaExceededError"); };
  });
  await selectWords(page, "tides rose again");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(panel(page).getByRole("status")).toHaveText(/Kept until you leave this page\./);
  await expect(panel(page).locator(".ob-annotations-notice")).toContainText("no room to save more");
  await expect(items(page)).toHaveCount(2);
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(before);
});

test("storage full: deleting something to make room keeps the change that could not be saved", async ({ page }) => {
  await open(page);
  await selectWords(page, "twice a day");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(items(page)).toHaveCount(1);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    window.__setItem = set;
    Storage.prototype.setItem = function () { throw new DOMException("full", "QuotaExceededError"); };
  });
  await selectWords(page, "tides rose again");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(items(page)).toHaveCount(2);
  // The reader makes room, as the notice asks.
  await page.evaluate(() => { Storage.prototype.setItem = window.__setItem; });
  await items(page).first().getByRole("button", { name: /^Delete: / }).click();
  await items(page).first().getByRole("button", { name: /^Confirm delete: / }).click();
  await expect(panel(page).getByRole("status")).toHaveText(/Deleted\. Saved in this browser\./);
  await expect(items(page)).toHaveCount(1);
  expect((await saved(page)).annotations).toHaveLength(1);
  expect(await painted(page)).toEqual(["tides rose again"]);
});

test("the same post under /index.html finds annotations saved under its published path", async ({ page }) => {
  await open(page);
  await selectWords(page, "twice a day");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(items(page)).toHaveCount(1);
  await open(page, "/tides/index.html");
  await expect(items(page)).toHaveCount(1);
  expect(await painted(page)).toEqual(["twice a day"]);
});

test("unreadable saved data is left untouched", async ({ page }) => {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(key, "{ not a reader annotation document");
    }
  }, KEY);
  await open(page);
  await expect(panel(page).locator(".ob-annotations-notice")).toContainText("could not be read");
  await selectWords(page, "twice a day");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(items(page)).toHaveCount(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe("{ not a reader annotation document");
});

test("another site's or a research notebook's data under the key is refused, not merged", async ({ page }) => {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(key, JSON.stringify({ format: "openblog.research-notebook", version: 1, notes: [] }));
    }
  }, KEY);
  await open(page);
  await expect(panel(page).locator(".ob-annotations-notice")).toContainText("could not be read");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).format, KEY)).toBe("openblog.research-notebook");
});

test("a revised post keeps its annotation: found again as moved, or stale with the reason, never silently moved", async ({ page }) => {
  const file = join(root, "content", "posts", "shifting.md");
  writeFileSync(file, SHIFTING("Steep the tea for three minutes. Then taste it."));
  await expect(async () => expect((await fetch(`${origin}/shifting/`)).ok).toBe(true)).toPass({ timeout: 15000 });
  await open(page, "/shifting/");
  await selectWords(page, "three minutes");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText("Found where you saved it");

  // Context changes but the words stay: found again, and said to have moved.
  writeFileSync(file, SHIFTING("A new line first. Steep the tea for three minutes. Then taste it."));
  await expect(async () => {
    await page.reload();
    await expect(items(page).first()).toContainText("Moved");
  }).toPass({ timeout: 15000 });
  expect(await painted(page)).toEqual(["three minutes"]);

  // The words go: the annotation stays listed with its quote and the reason, and cannot be shown.
  writeFileSync(file, SHIFTING("Steep the tea for a while. Then taste it."));
  await expect(async () => {
    await page.reload();
    await expect(items(page).first()).toContainText("Not found");
  }).toPass({ timeout: 15000 });
  await expect(items(page).first()).toContainText("three minutes");
  await expect(items(page).first()).toContainText("The words are no longer on the page.");
  await expect(items(page).first().getByRole("button", { name: /Show in the post/ })).toHaveCount(0);
  expect(await painted(page)).toEqual([]);
  expect((await saved(page)).annotations).toHaveLength(1);
  // A stale note can still be edited and deleted.
  await expect(items(page).first().getByRole("button", { name: "Delete: three minutes" })).toBeVisible();
});

test("reduced motion and a 320px phone: no animation and no horizontal overflow of the region", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page);
  await selectWords(page, "Café crème 日本語 😀");
  await panel(page).getByRole("button", { name: "Highlight the selected words" }).click();
  await panel(page).getByRole("radio", { name: "The whole post" }).check();
  await panel(page).getByLabel("Your note (private)").fill("a".repeat(400));
  await panel(page).getByRole("button", { name: "Save note" }).click();
  await expect(items(page)).toHaveCount(2);
  const overflow = await panel(page).evaluate((region) => region.scrollWidth - region.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const motion = await panel(page).evaluate((region) => {
    const durations = [...region.querySelectorAll("*")].map((node) => getComputedStyle(node));
    return durations.every((style) => parseFloat(style.transitionDuration) === 0 && parseFloat(style.animationDuration) === 0);
  });
  expect(motion).toBe(true);
  await items(page).first().getByRole("button", { name: /Show in the post/ }).click();
  expect(await page.evaluate(() => getSelection().toString())).toBe("Café crème 日本語 😀");
});

test("without JavaScript the post reads as usual and the region says what it needs", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/tides/`);
  await expect(page.getByText("The moon causes the tides.")).toBeVisible();
  await expect(page.locator(".ob-annotations-static")).toContainText("need JavaScript");
  await expect(page.locator(".ob-annotations-make")).toHaveCount(0);
  await context.close();
});
