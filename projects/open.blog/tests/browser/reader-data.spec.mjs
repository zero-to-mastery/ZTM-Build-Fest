import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// A reader's export, import and privacy controls (#87, ADR 0243): an explicit export that states what it
// holds, a previewed import that refuses hostile, oversized or newer files and changes nothing on refusal,
// a switch that turns the feature off without losing data, and an erase that can be checked.

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
  root = mkdtempSync(join(tmpdir(), "openblog-reader-data-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Data",
    url: "https://data-site.example.org",
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
const featureKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("openblog.reader-annotations")).sort());

async function open(page, path = "/cave/") {
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => customElements.get("ob-reading-trail") !== undefined);
  await expect(panel(page).locator(".ob-trail-lead")).toBeVisible();
}

const work = (path) => ({ site: origin, path });
const note = (id, path, text) => ({ id, kind: "note", work: work(path), revision: REVISION, target: { version: 1, kind: "work" }, text, createdAt: NOW, updatedAt: NOW });
const link = (id, title, url) => ({ id, kind: "source", title, url, createdAt: NOW, updatedAt: NOW });
const trail = (id, title, refs) => ({ id, kind: "trail", title, steps: refs.map((ref) => ({ ref })), createdAt: NOW, updatedAt: NOW });
const documentOf = (parts) => ({
  format: "openblog.reader-annotations",
  version: 2,
  privacy: { scope: "reader-private", notes: "included" },
  annotations: [],
  sources: [],
  trails: [],
  reflections: [],
  ...parts,
});
const RICH = () => documentOf({
  annotations: [note("n1", "/cave/", "Private cave words"), note("n2", "/plain/", "Plain one")],
  sources: [link("s1", "Kettle guide", "https://example.org/kettles")],
  trails: [trail("t1", "Cave trail", ["s1", "n1"])],
});

async function seed(page, value) {
  await page.addInitScript(({ key, text }) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(key, text);
    }
  }, { key: KEY, text: typeof value === "string" ? value : JSON.stringify(value) });
}

const asFile = (value, name = "trail.json") => ({
  name,
  mimeType: "application/json",
  buffer: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
});

async function download(page, trails) {
  const waiting = page.waitForEvent("download");
  await trails.getByRole("button", { name: "Download my reading trail" }).click();
  const file = await waiting;
  const path = await file.path();
  return { name: file.suggestedFilename(), text: readFileSync(path, "utf8") };
}

test("export leaves notes out until asked, says what it holds, and downloads only the document", async ({ page }) => {
  const outside = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("blob:") && new URL(request.url()).origin !== origin) outside.push(request.url());
  });
  await seed(page, RICH());
  await open(page);
  const trails = panel(page);
  await expect(trails.getByText("Kept in this browser: 0 highlights, 2 notes, 1 saved source, 1 trail.")).toBeVisible();

  // Default: the reader's own words stay home, and the statement says so before anything is made.
  const include = trails.getByLabel("Include the text of my notes and source notes");
  await expect(include).not.toBeChecked();
  await expect(trails.locator("#" + (await trails.locator("[id$='-export-describe']").getAttribute("id")))).toContainText("Your own notes are left out");
  const plain = await download(page, trails);
  expect(plain.name).toMatch(/^openblog-reading-trail-\d{4}-\d{2}-\d{2}\.json$/);
  const parsed = JSON.parse(plain.text);
  expect(Object.keys(parsed)).toEqual(["format", "version", "privacy", "annotations", "sources", "trails", "reflections"]);
  expect(parsed.privacy).toEqual({ scope: "reader-private", notes: "omitted" });
  expect(plain.text).not.toContain("Private cave words");
  expect(parsed.annotations).toEqual([]);

  // Asking for the notes is a visible, keyboard-operable choice, and the saved data is untouched.
  await include.focus();
  await page.keyboard.press("Space");
  await expect(include).toBeChecked();
  await expect(include).toBeFocused();
  await expect(trails.locator("[id$='-export-describe']")).toContainText("Your own notes are included");
  const full = await download(page, trails);
  expect(JSON.parse(full.text).privacy.notes).toBe("included");
  expect(full.text).toContain("Private cave words");
  expect(await saved(page)).toEqual(RICH());

  // The contents can be read before they are downloaded.
  await trails.getByText("Show exactly what the file contains").click();
  await expect(trails.getByLabel("The file contents")).toContainText("Private cave words");
  expect(outside).toEqual([]);
});

test("a file made by export imports back, and the highlights panel refreshes", async ({ page }) => {
  await seed(page, RICH());
  await open(page);
  const trails = panel(page);
  await trails.getByLabel("Include the text of my notes and source notes").check();
  const file = await download(page, trails);

  await trails.getByRole("button", { name: /^Clear all my local data/ }).click();
  await trails.getByRole("button", { name: /^Confirm clear everything/ }).click();
  await expect(notes(page).getByRole("listitem")).toHaveCount(0);
  expect(await raw(page)).toBeNull();
  await expect(trails.getByText("Kept in this browser: nothing.")).toBeVisible();
  await expect(trails.getByRole("button", { name: "Download my reading trail" })).toBeDisabled();

  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(file.text, file.name));
  const preview = trails.getByRole("group", { name: /^Import preview: / });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Would add: 2 highlights and notes, 1 saved source, 1 trail, 0 private readings.");
  expect(await raw(page)).toBeNull();
  await expect(preview.getByRole("heading")).toBeFocused();
  await preview.getByRole("button", { name: "Import" }).click();
  await expect(trails.getByRole("status")).toContainText("Imported. Now saved in this browser: 0 highlights, 2 notes, 1 saved source, 1 trail.");
  expect(await saved(page)).toEqual(RICH());
  await expect(notes(page).getByRole("listitem")).toHaveCount(1);
  await expect(trails.getByRole("heading", { name: "Cave trail", level: 4 })).toBeVisible();

  // The same file again changes nothing, and the preview says so.
  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(file.text, file.name));
  await expect(trails.getByRole("group", { name: /^Import preview: / })).toContainText("Nothing in the file would change what is saved.");
  await expect(trails.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("a conflicting record is listed, and the reader chooses which version stays", async ({ page }) => {
  await seed(page, RICH());
  await open(page);
  const trails = panel(page);
  const theirs = RICH();
  theirs.annotations[0].text = "Their words";
  theirs.annotations[0].updatedAt = "2026-10-28T09:30:00Z";
  theirs.annotations.push(note("n3", "/plain/", "Extra"));
  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(theirs));
  const preview = trails.getByRole("group", { name: /^Import preview: / });
  await expect(preview).toContainText("1 record in the file has the same id as one you have but different content");
  await expect(preview.getByLabel("Keep what I have saved")).toBeChecked();
  await expect(preview).toContainText("Would add: 1 highlight or note, 0 saved sources, 0 trails, 0 private readings.");
  await preview.getByLabel("Use the file's version").check();
  await preview.getByRole("button", { name: "Import" }).click();
  const now = await saved(page);
  expect(now.annotations.map((each) => [each.id, each.text])).toEqual([["n1", "Their words"], ["n2", "Plain one"], ["n3", "Extra"]]);
});

test("a notes-free export imported with the file's version never removes a saved note", async ({ page }) => {
  const mine = RICH();
  mine.sources[0].text = "My source note";
  await seed(page, mine);
  await open(page);
  const trails = panel(page);
  const file = JSON.parse((await download(page, trails)).text);
  expect(file.privacy.notes).toBe("omitted");
  file.sources[0].title = "Kettle guide, second edition";
  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(file));
  const preview = trails.getByRole("group", { name: /^Import preview: / });
  await expect(preview).toContainText("1 record in the file has the same id as one you have but different content");
  await preview.getByLabel("Use the file's version").check();
  await preview.getByRole("button", { name: "Import" }).click();
  const now = await saved(page);
  expect(now.sources[0].title).toBe("Kettle guide, second edition");
  expect(now.sources[0].text).toBe("My source note");
  expect(now.annotations.map((each) => each.text)).toEqual(["Private cave words", "Plain one"]);
  expect(now.trails[0].steps.map((step) => step.ref)).toEqual(["s1", "n1"]);
});

test("a hostile, newer, oversized or unreadable file is refused and changes nothing", async ({ page }) => {
  await seed(page, RICH());
  await open(page);
  const trails = panel(page);
  const before = await raw(page);
  const chooser = trails.getByLabel("Reading-trail file");
  const refused = async (file, words) => {
    await chooser.setInputFiles(file);
    const preview = trails.getByRole("group", { name: /^Import preview: / });
    await expect(preview).toContainText("This file cannot be imported, so nothing was changed.");
    await expect(preview).toContainText(words);
    await expect(preview.getByRole("button", { name: "Import", exact: true })).toHaveCount(0);
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(trails.getByRole("group", { name: /^Import preview: / })).toHaveCount(0);
    await expect(chooser).toBeFocused();
    expect(await raw(page)).toBe(before);
  };
  const unsafe = RICH();
  unsafe.sources[0].url = "javascript:window.__xss=1";
  await refused(asFile(unsafe), "not a plain http or https link");
  const traversal = RICH();
  traversal.annotations[0].work.path = "/cave/../../secret/";
  await refused(asFile(traversal), "not a safe, canonical path");
  const newer = RICH();
  newer.version = 3;
  await refused(asFile(newer), "newer version");
  await refused(asFile({ format: "openblog.research-notebook", version: 1 }), "not a reading-trail file");
  await refused(asFile("{not json"), "not a readable reading-trail document");
  const hostile = RICH();
  hostile.annotations[0].text = `<img src=x onerror="window.__xss=1">`;
  hostile.annotations[0].id = "x".repeat(70);
  await refused(asFile(hostile), "breaks a rule (invalidId)");

  // Too big to read at all.
  await chooser.setInputFiles({ name: "big.json", mimeType: "application/json", buffer: Buffer.alloc(4 * 1024 * 1024 + 1, 32) });
  await expect(trails.locator(".ob-trail-error:not([hidden])")).toContainText("larger than 4 MiB");
  expect(await raw(page)).toBe(before);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // Markup in a good file is text.
  const loud = RICH();
  loud.annotations[0].text = `<img src=x onerror="window.__xss=1">`;
  await chooser.setInputFiles(asFile(loud));
  await trails.getByLabel("Use the file's version").check();
  await trails.getByRole("button", { name: "Import", exact: true }).click();
  expect((await saved(page)).annotations[0].text).toContain("<img");
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test("data that cannot be read is never imported over, and erasing it asks first and is verifiable", async ({ page }) => {
  const garbage = '{"format":"openblog.reader-annotations","version":9}';
  await seed(page, garbage);
  await open(page);
  const trails = panel(page);
  await expect(trails.getByText("Something is saved in this browser that this page cannot read.")).toBeVisible();
  await expect(trails.getByRole("button", { name: "Download my reading trail" })).toBeDisabled();
  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(RICH()));
  await expect(trails.locator(".ob-trail-error:not([hidden])")).toContainText("could not be read");
  expect(await raw(page)).toBe(garbage);
  await trails.getByRole("button", { name: /^Clear all my local data/ }).click();
  await trails.getByRole("button", { name: /^Confirm clear everything/ }).click();
  expect(await featureKeys(page)).toEqual([]);
  await expect(trails.getByText("Browser storage used by this feature: none.")).toBeVisible();
  await expect(trails.getByText("Kept in this browser: nothing.")).toBeVisible();
});

test("turning the feature off hides it everywhere, keeps the data, and turning it on restores it", async ({ page }) => {
  await seed(page, RICH());
  await open(page);
  const trails = panel(page);
  await expect(notes(page).getByRole("listitem")).toHaveCount(1);
  const before = await raw(page);
  const off = trails.getByRole("button", { name: "Turn highlights, notes and trails off" });
  await off.focus();
  await page.keyboard.press("Enter");
  await expect(trails.getByRole("status")).toHaveText("Highlights, notes and trails are off. Nothing saved was removed.");
  await expect(notes(page).getByRole("listitem")).toHaveCount(0);
  await expect(notes(page).getByRole("button", { name: "Highlight the selected words" })).toBeHidden();
  await expect(notes(page)).toContainText("turned off in this browser");
  await expect(trails.getByRole("button", { name: "Save this post as a source" })).toHaveCount(0);
  await expect(trails.getByLabel("Reading-trail file")).toHaveCount(0);
  await expect(trails.getByRole("button", { name: "Turn highlights, notes and trails back on" })).toBeFocused();
  expect(await raw(page)).toBe(before);

  // It stays off on the next visit, and nothing is requested or painted.
  await page.reload();
  await page.waitForFunction(() => customElements.get("ob-reading-trail") !== undefined);
  await expect(notes(page)).toContainText("turned off in this browser");
  expect(await page.evaluate(() => (CSS.highlights ? CSS.highlights.size : 0))).toBe(0);
  await expect(trails.getByText("Browser storage used by this feature: openblog.reader-annotations, openblog.reader-annotations.off.")).toBeVisible();

  await trails.getByRole("button", { name: "Turn highlights, notes and trails back on" }).click();
  await expect(notes(page).getByRole("listitem")).toHaveCount(1);
  await expect(trails.getByRole("button", { name: "Save this post as a source" })).toBeVisible();
  expect(await raw(page)).toBe(before);
  expect(await featureKeys(page)).toEqual(["openblog.reader-annotations"]);

  // Erasing while off removes the data and leaves the switch where the reader put it.
  await trails.getByRole("button", { name: "Turn highlights, notes and trails off" }).click();
  await trails.getByRole("button", { name: /^Clear all my local data/ }).click();
  await trails.getByRole("button", { name: /^Confirm clear everything/ }).click();
  expect(await featureKeys(page)).toEqual(["openblog.reader-annotations.off"]);
  await expect(trails.getByText("Kept in this browser: nothing.")).toBeVisible();
});

test("the controls fit a phone and the page without JavaScript still reads", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const page = await context.newPage();
  await seed(page, RICH());
  await open(page);
  const trails = panel(page);
  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(RICH()));
  await trails.getByText("Show exactly what the file contains").click();
  const wide = await trails.evaluate((region) => {
    const box = region.getBoundingClientRect();
    return [...region.querySelectorAll("*")].filter((node) => node.getBoundingClientRect().right > box.right + 0.5 && !node.querySelector("*")).map((node) => `${node.tagName}.${node.className}#${node.id} ${Math.round(node.getBoundingClientRect().width)} ${node.textContent.slice(0, 30)}`);
  });
  expect(wide).toEqual([]);
  const overflow = await trails.evaluate((region) => region.scrollWidth - region.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await context.close();

  const plain = await browser.newContext({ javaScriptEnabled: false });
  const bare = await plain.newPage();
  await bare.goto(`${origin}/cave/`);
  await expect(panel(bare)).toContainText("need JavaScript");
  await expect(bare.locator("article")).toContainText("Shadows on the wall stay shadows.");
  await plain.close();
});

test("the import preview names private readings, so they never enter the notebook unannounced", async ({ page }) => {
  await open(page);
  const trails = panel(page);
  const reading = { id: "refl-a", kind: "reflection", work: work("/cave/"), revision: REVISION, target: { version: 1, kind: "work" }, text: "What I thought then", provenance: "written", createdAt: NOW, updatedAt: NOW };
  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(documentOf({ reflections: [reading] })));
  const preview = trails.getByRole("group", { name: /^Import preview: / });
  await expect(preview).toContainText("Would add: 0 highlights and notes, 0 saved sources, 0 trails, 1 private reading.");
  await preview.getByRole("button", { name: "Import" }).click();
  expect((await saved(page)).reflections).toHaveLength(1);
  await trails.getByLabel("Reading-trail file").setInputFiles(asFile(documentOf({ reflections: [reading] })));
  await expect(trails.getByRole("group", { name: /^Import preview: / })).toContainText("Nothing in the file would change what is saved.");
});
