import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio and the real citation API (core parser and resolver) over a small source
// library. Covers keyboard search, focus, Unicode, undo, a stale library, mixed hand-written and
// generated citations, and Markdown round trips between Visual and Markdown modes.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const LIBRARY = (extra = []) => JSON.stringify({
  version: 1,
  sources: [
    { id: "plato-republic", kind: "work", title: "Πολιτεία", creators: [{ name: "Plato", role: "author" }] },
    { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam", issued: "2003" },
    ...extra,
  ],
});
let root;
let server;
let origin;

const writeLibrary = (extra) => {
  const path = join(root, ".openblog", "private", "research", "sources.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, LIBRARY(extra));
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-citations-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeLibrary();
  execFileSync(binary, ["user", "add", "writer", "--root", root], {
    env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe",
  });
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
    expect((await fetch(`${origin}/admin/`)).ok).toBe(true);
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

test.beforeEach(() => writeLibrary());

async function openNewPost(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/#/new/posts`);
  await expect(page.getByRole("button", { name: "Cite a source" })).toBeVisible();
}

const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });
const visual = (page) => page.getByRole("textbox", { name: "Visual editor" });
const mode = (page, name) => page.getByRole("button", { name, exact: true });
const citeDialog = (page, name = "Insert citation") => page.getByRole("dialog", { name });

async function useMarkdown(page, text, selection) {
  await mode(page, "Markdown").click();
  await markdown(page).fill(text);
  await markdown(page).evaluate((element, [start, end]) => element.setSelectionRange(start, end), selection);
}

test("a citation is inserted from the keyboard and undo restores the exact draft and caret", async ({ page }) => {
  await openNewPost(page);
  const draft = "Claim about the cave. Ünïcödé 🙂\n\nA footnote[^1].\n\n[^1]: Hand-written [@Manual Key].\n";
  await useMarkdown(page, draft, [6, 11]);
  await page.getByRole("button", { name: "Cite a source" }).focus();
  await page.keyboard.press("Enter");
  await expect(citeDialog(page)).toBeVisible();
  const search = page.getByLabel("Search sources");
  await expect(search).toBeFocused();
  await page.keyboard.type("Πολι");
  const sources = page.getByLabel("Source", { exact: true });
  await expect(sources.locator("option")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(sources).toBeFocused();
  await sources.selectOption("plato-republic");
  await page.getByLabel("Locators (optional)").fill("canonical: 514a");
  await expect(page.locator("#oba-citation-preview")).toHaveText("[@plato-republic, canonical 514a]");
  await page.getByRole("button", { name: "Insert citation" }).press("Enter");
  await expect(citeDialog(page)).toBeHidden();
  const expected = draft.replace("Claim about", "Claim about [@plato-republic, canonical 514a]");
  await expect(markdown(page)).toHaveValue(expected);
  await expect(markdown(page)).toBeFocused();
  const caret = await markdown(page).evaluate((element) => [element.selectionStart, element.selectionEnd]);
  expect(caret).toEqual([11 + " [@plato-republic, canonical 514a]".length, 11 + " [@plato-republic, canonical 514a]".length]);
  await page.keyboard.press("Control+z");
  await expect(markdown(page)).toHaveValue(draft);
  expect(await markdown(page).evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([6, 11]);
});

test("Escape closes the dialog, returns focus, and leaves the draft alone", async ({ page }) => {
  await openNewPost(page);
  await useMarkdown(page, "Untouched text.", [3, 7]);
  await page.getByRole("button", { name: "Cite a source" }).click();
  await expect(page.getByLabel("Search sources")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(citeDialog(page)).toBeHidden();
  await expect(markdown(page)).toBeFocused();
  await expect(markdown(page)).toHaveValue("Untouched text.");
  expect(await markdown(page).evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([3, 7]);
});

test("a stale library is refused without changing the draft, then insertion succeeds", async ({ page }) => {
  await openNewPost(page);
  await useMarkdown(page, "A claim.", [7, 7]);
  await page.getByRole("button", { name: "Cite a source" }).click();
  await page.getByLabel("Source", { exact: true }).selectOption("slings-2003");
  await page.getByLabel("Locators (optional)").fill("page: 514 to 520");
  writeLibrary([{ id: "added-later", kind: "work", title: "Added later" }]);
  await page.getByRole("button", { name: "Insert citation" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /source library changed/i })).toBeVisible();
  await expect(page.getByLabel("Source", { exact: true }).locator("option", { hasText: "Added later" })).toHaveCount(1);
  await expect(page.getByLabel("Locators (optional)")).toHaveValue("page: 514 to 520");
  await expect(markdown(page)).toHaveValue("A claim.");
  await page.getByRole("button", { name: "Insert citation" }).click();
  await expect(citeDialog(page)).toBeHidden();
  await expect(markdown(page)).toHaveValue("A claim [@slings-2003, page 514 to 520].");
});

test("an unknown locator target is reported in the dialog and nothing is inserted", async ({ page }) => {
  await openNewPost(page);
  await useMarkdown(page, "A claim.", [7, 7]);
  await page.getByRole("button", { name: "Cite a source" }).click();
  await page.getByLabel("Source", { exact: true }).selectOption("plato-republic");
  await page.getByLabel("Locators (optional)").fill("page: 5");
  await page.getByRole("button", { name: "Insert citation" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /page/i })).toBeVisible();
  await expect(page.getByLabel("Locators (optional)")).toBeFocused();
  await expect(markdown(page)).toHaveValue("A claim.");
});

test("visual insertion makes an atomic chip that round-trips with hand-written citations", async ({ page }) => {
  await openNewPost(page);
  const draft = "Manual [@Manual Key] and [@plato-republic, canonical 514a] stay.\n\nA footnote[^1].\n\n[^1]: Note.\n";
  await useMarkdown(page, draft, [0, 0]);
  await mode(page, "Visual").click();
  await expect(visual(page).locator(".oba-citation")).toHaveCount(2);
  const paragraph = visual(page).locator("p").first();
  await paragraph.click({ position: { x: 2, y: 8 } });
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "Cite a source" }).click();
  await page.getByLabel("Source", { exact: true }).selectOption("slings-2003");
  await page.getByRole("button", { name: "Insert citation" }).click();
  await expect(citeDialog(page)).toBeHidden();
  await expect(visual(page).locator(".oba-citation")).toHaveCount(3);
  await mode(page, "Markdown").click();
  const written = await markdown(page).inputValue();
  expect(written).toContain("[@Manual Key]");
  expect(written).toContain("[@plato-republic, canonical 514a]");
  expect(written).toContain("stay. [@slings-2003]");
  expect(written).toContain("A footnote[^1].");
  expect(written).toContain("[^1]: Note.");
  await mode(page, "Visual").click();
  await mode(page, "Markdown").click();
  await expect(markdown(page)).toHaveValue(written);

  // A chip reopens its own citation for editing, from the keyboard.
  await mode(page, "Visual").click();
  const chip = visual(page).locator(".oba-citation", { hasText: "[@plato-republic, canonical 514a]" });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(citeDialog(page, "Edit citation")).toBeVisible();
  await expect(page.getByLabel("Locators (optional)")).toHaveValue("canonical: 514a");
  await page.getByLabel("Locators (optional)").fill("canonical: 514b");
  await page.getByRole("button", { name: "Update citation" }).click();
  await expect(citeDialog(page, "Edit citation")).toBeHidden();
  await mode(page, "Markdown").click();
  await expect(markdown(page)).toHaveValue(written.replace("canonical 514a", "canonical 514b"));
});

test("undo after a Visual insertion restores the exact Markdown and caret", async ({ page }) => {
  await openNewPost(page);
  const draft = "First claim here.\n\nSecond paragraph.\n";
  await useMarkdown(page, draft, [0, 0]);
  await mode(page, "Visual").click();
  await expect(visual(page).locator("p")).toHaveCount(2);
  await visual(page).locator("p").first().click({ position: { x: 2, y: 8 } });
  await page.keyboard.press("End");
  const caret = () => page.evaluate(() => {
    const selection = getSelection();
    return { text: selection.anchorNode?.textContent, offset: selection.anchorOffset, collapsed: selection.isCollapsed };
  });
  const before = await caret();
  expect(before.collapsed).toBe(true);
  await page.getByRole("button", { name: "Cite a source" }).click();
  await page.getByLabel("Source", { exact: true }).selectOption("slings-2003");
  await page.getByRole("button", { name: "Insert citation" }).click();
  await expect(citeDialog(page)).toBeHidden();
  await expect(visual(page).locator(".oba-citation")).toHaveCount(1);
  await expect(visual(page)).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(visual(page).locator(".oba-citation")).toHaveCount(0);
  await expect(page.locator("[data-citation-undo]")).toBeHidden();
  await expect(visual(page)).toBeFocused();
  expect(await caret()).toEqual(before);
  await mode(page, "Markdown").click();
  await expect(markdown(page)).toHaveValue(draft);
});
