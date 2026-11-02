import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio and the real alignments API (core validation, revision-checked store)
// over a small library, notebook and alignments file. Covers keyboard-only reading and editing,
// focus order, the layout switch and the narrow-screen reflow, right-to-left wording, absent
// places, screen-reader names, copying only after the rights statements are read, a conflict
// that keeps the draft, and hostile text that stays text.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const HOSTILE = "<img src=x onerror=alert(1)> Πλάτων";
const HEBREW = "ירדתי אתמול לפיראוס";
const GREEK = "κατέβην χθὲς εἰς Πειραιᾶ";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Πολιτεία" },
    { id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam", creators: [{ name: "S. R. Slings", role: "editor", attribution: "stated" }], rights: { status: "publicDomain" } },
    { id: "bloom", kind: "translation", of: "plato", language: "en", title: HOSTILE, creators: [{ name: "Allan Bloom", role: "translator", attribution: "attributed" }], rights: { status: "rightsReserved" } },
    { id: "he", kind: "translation", of: "plato", language: "he", title: "פוליטאה", anonymous: true },
    { id: "ms", kind: "witness", of: "plato", title: "Paris gr. 1807", repository: "BnF", shelfmark: "gr. 1807" },
  ],
  interpretations: [
    { id: "mine", kind: "rendering", source: "slings", locators: [{ kind: "canonical", value: "327a" }], language: "en", text: "Down I went, yesterday", interpreters: [{ name: "Ada", attribution: "uncertain" }] },
  ],
};
const NOTEBOOK = {
  version: 1,
  passages: [
    { id: "p-gr", source: "slings", excerpt: { text: GREEK, language: "grc" }, locators: [{ kind: "canonical", value: "327a" }] },
    { id: "p-en", source: "bloom", excerpt: { text: `I went down ${HOSTILE}`, language: "en" }, locators: [{ kind: "canonical", value: "327a" }] },
    { id: "p-he", source: "he", excerpt: { text: HEBREW, language: "he" }, locators: [{ kind: "page", value: "3" }] },
  ],
  notes: [],
};
const ALIGNMENTS = () => ({
  version: 1,
  alignments: [
    {
      id: "opening",
      label: "Opening: the descent",
      correspondence: "partial",
      members: [
        { source: "slings", passage: "p-gr", locators: [{ kind: "canonical", value: "327a" }] },
        { source: "bloom", passage: "p-en", locators: [{ kind: "canonical", value: "327a" }] },
        { source: "he", passage: "p-he", normalized: { text: "ירדתי אתמול", note: "vowel points removed" } },
        { source: "ms", absent: true, note: "the leaf is lost" },
        { interpretation: "mine" },
      ],
      confidence: "plausible",
      recordedBy: { kind: "author" },
      visibility: "private",
    },
  ],
});
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const writeResearch = (alignments = ALIGNMENTS()) => {
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("alignments.json"), JSON.stringify(alignments));
};
const storedAlignments = () => readFileSync(research("alignments.json"), "utf8");

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-compare-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeResearch();
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

test.beforeEach(({ page }) => {
  writeResearch();
  // Hostile text must never run: any dialog fails the test.
  page.on("dialog", (dialog) => {
    if (dialog.type() !== "confirm") throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
    dialog.accept();
  });
});

async function openAdmin(page, hash) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/${hash}`);
}

const heading = (page) => page.locator("#oba-compare-heading");
const version = (page, key) => page.locator(`[data-compare-version="${key}"]`);
const placeAt = (page, index) => page.locator(`[data-compare-place="${index}"]`);

test("an alignment is opened and read from the keyboard alone, in a sensible focus order", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAdmin(page, "#/compare");
  await expect(page.getByRole("link", { name: "Compare", exact: true })).toHaveAttribute("aria-current", "page");
  const item = page.locator('[data-compare-alignment="opening"]');
  await expect(item).toBeVisible();
  await item.focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toBeFocused();
  await expect(heading(page)).toHaveText("Opening: the descent");
  await expect(page.locator("[data-compare-correspondence]")).toHaveText("The author reads these places as corresponding in part.");
  // Focus moves from the heading through the alignment's actions, then each place in reading order.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Edit alignment" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Remove alignment" })).toBeFocused();
  for (const index of [0, 1, 2, 3, 4]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("checkbox", { name: `Select place ${index + 1} for copying` })).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Select every place" })).toBeFocused();
  // Screen-reader names: version headings, the layout group, and each place described by its identification.
  await expect(page.getByRole("heading", { level: 4, name: "Platonis Rempublicam" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4, name: HOSTILE })).toBeVisible();
  await expect(page.getByRole("group", { name: "Layout" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select place 1 for copying" })).toHaveAccessibleDescription(
    "Platonis Rempublicam · Edition · Editor: S. R. Slings (stated) · Locator: canonical 327a",
  );
  await expect(placeAt(page, 4)).toContainText("Interpreted by: Ada (uncertain)");
  // Switch to one column with the arrow keys, and back.
  await page.getByRole("radio", { name: "Side by side" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Single column" })).toBeChecked();
  await expect(page.locator('ol[data-compare-layout="sequence"] > li')).toHaveCount(5);
  await page.keyboard.press("ArrowUp");
  await expect(page.locator('div[data-compare-layout="columns"]')).toBeVisible();
  // The normalization appears on request, labelled, after the original.
  await page.getByLabel("Show the author's normalizations").focus();
  await page.keyboard.press("Space");
  await expect(placeAt(page, 2).locator("[data-compare-normalized]")).toHaveText("ירדתי אתמול");
  await expect(placeAt(page, 2)).toContainText("The author's normalization, not the source text");
});

test("right-to-left wording keeps its direction, and absent places are said in words", async ({ page }) => {
  await openAdmin(page, "#/compare/opening");
  await expect(heading(page)).toBeFocused();
  const hebrew = placeAt(page, 2).locator("[data-compare-original]");
  await expect(hebrew).toHaveText(HEBREW);
  await expect(hebrew).toHaveAttribute("lang", "he");
  await expect(hebrew).toHaveAttribute("dir", "rtl");
  expect(await hebrew.evaluate((element) => getComputedStyle(element).direction)).toBe("rtl");
  const greek = placeAt(page, 0).locator("[data-compare-original]");
  await expect(greek).toHaveText(GREEK);
  expect(await greek.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr");
  // A right-to-left title is isolated, so the label after it keeps its order.
  const title = version(page, "source:he").locator("h4 bdi");
  await expect(title).toHaveText("פוליטאה");
  expect(await title.evaluate((element) => getComputedStyle(element).unicodeBidi)).toBe("isolate");
  await expect(placeAt(page, 3)).toContainText("Absent: this version lacks the passage.");
  await expect(placeAt(page, 3)).toContainText("Author's note: the leaf is lost");
  await expect(version(page, "source:ms")).toContainText("BnF, gr. 1807");
  await expect(version(page, "source:he")).toContainText("Translator: anonymous; the source names nobody");
  await expect(version(page, "source:he").locator("[data-compare-rights]")).toHaveText("Rights not checked yet");
  // Hostile text stays text.
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(placeAt(page, 1).locator("[data-compare-original]")).toHaveText(`I went down ${HOSTILE}`);
});

test("versions sit side by side on a wide screen and follow one another on a phone, in the same order", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openAdmin(page, "#/compare/opening");
  await expect(heading(page)).toBeFocused();
  // Every box comes from one layout pass, so a reflow elsewhere on the page cannot fall between them.
  const boxes = () => page.locator("[data-compare-version]").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  await expect(page.locator("[data-compare-version]").nth(1)).toBeVisible();
  let [first, second] = await boxes();
  expect(Math.abs(first.y - second.y)).toBeLessThan(2);
  expect(second.x).toBeGreaterThan(first.x + first.width - 1);

  await page.setViewportSize({ width: 375, height: 800 });
  const narrow = await boxes();
  for (let index = 1; index < narrow.length; index += 1) {
    expect(narrow[index].y).toBeGreaterThanOrEqual(narrow[index - 1].y + narrow[index - 1].height - 1);
    expect(Math.abs(narrow[index].x - narrow[0].x)).toBeLessThan(2);
  }
  const overflow = await page.evaluate(() => {
    const region = document.querySelector("#oba-compare-lists");
    const widest = Math.max(...[region, ...region.querySelectorAll("*")].map((element) => element.getBoundingClientRect().right));
    return Math.max(widest - window.innerWidth, document.documentElement.scrollWidth - window.innerWidth);
  });
  expect(overflow).toBeLessThanOrEqual(1);
  // The single-column choice reads the same on a phone.
  await page.getByRole("radio", { name: "Single column" }).check();
  await expect(page.locator('ol[data-compare-layout="sequence"] > li')).toHaveCount(5);
});

test("copying takes only selected places after the rights statements are read", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await openAdmin(page, "#/compare/opening");
  await expect(heading(page)).toBeFocused();
  await page.getByRole("button", { name: "Copy selected places" }).click();
  await expect(page.locator("#oba-compare-export-error")).toContainText("Select at least one place first");
  await expect(page.getByRole("button", { name: "Select every place" })).toBeFocused();
  await page.getByRole("checkbox", { name: "Select place 1 for copying" }).check();
  await page.getByRole("checkbox", { name: "Select place 3 for copying" }).check();
  await expect(page.locator("[data-compare-selection]")).toHaveText("2 places selected.");
  await expect(page.locator("[data-compare-rights-summary]")).toContainText("פוליטאה: Rights not checked yet");
  await page.getByRole("button", { name: "Copy selected places" }).click();
  await expect(page.locator("#oba-compare-confirm-rights")).toBeFocused();
  await page.locator("#oba-compare-confirm-rights").check();
  await page.getByRole("button", { name: "Copy selected places" }).click();
  await expect(page.getByText(/Copied 2 places/)).toBeVisible();
  // The system clipboard may turn line feeds into CRLF (Windows); the copied text is otherwise exact.
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  expect(copied).toContain(GREEK);
  expect(copied).toContain(HEBREW);
  expect(copied).toContain("Rights: Rights not checked yet");
  expect(copied).not.toContain("I went down");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download selected places" }).click()]);
  expect(download.suggestedFilename()).toBe("alignment-opening.txt");
  expect(readFileSync(await download.path(), "utf8")).toBe(copied);
});

test("a new alignment is added from the keyboard and a conflicting edit keeps the draft", async ({ page }) => {
  await openAdmin(page, "#/compare");
  await page.getByRole("button", { name: "New alignment" }).focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toBeFocused();
  await expect(heading(page)).toHaveText("New alignment");
  await page.locator("#oba-alignment-label").fill("Glaucon");
  await expect(page.locator("#oba-alignment-id")).toHaveValue("glaucon");
  await page.locator("#oba-alignment-member-0-source").selectOption("slings");
  await page.locator("#oba-alignment-member-0-locators").fill("canonical: 327b");
  await page.locator("#oba-alignment-member-1-source").selectOption("he");
  await page.locator("#oba-alignment-member-1-absent").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#oba-alignment-member-1-locators")).toHaveCount(0);
  await page.getByRole("button", { name: "Add alignment" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Alignment saved to the private alignments file.")).toBeVisible();
  await expect(heading(page)).toHaveText("Glaucon");
  const saved = JSON.parse(storedAlignments()).alignments.find((alignment) => alignment.id === "glaucon");
  expect(saved.members).toEqual([{ source: "slings", locators: [{ kind: "canonical", value: "327b" }] }, { source: "he", absent: true }]);

  // Someone else renames it while this tab edits it.
  await page.getByRole("button", { name: "Edit alignment" }).click();
  await page.locator("#oba-alignment-label").fill("Glaucon, my label");
  const file = JSON.parse(storedAlignments());
  file.alignments.find((alignment) => alignment.id === "glaucon").label = "Renamed elsewhere";
  writeFileSync(research("alignments.json"), JSON.stringify(file));
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("[data-alignment-conflict]")).toContainText("was changed after you opened it");
  await expect(page.getByRole("button", { name: "Use the stored copy" })).toBeFocused();
  expect(JSON.parse(storedAlignments()).alignments.find((alignment) => alignment.id === "glaucon").label).toBe("Renamed elsewhere");
  await page.getByRole("button", { name: "Keep my draft" }).click();
  await expect(page.locator("#oba-alignment-label")).toHaveValue("Glaucon, my label");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(heading(page)).toHaveText("Glaucon, my label");
  expect(JSON.parse(storedAlignments()).alignments.find((alignment) => alignment.id === "glaucon").label).toBe("Glaucon, my label");
});

test("a refused alignment is reported at its field and leaves the file unchanged", async ({ page }) => {
  await openAdmin(page, "#/compare/opening");
  await page.getByRole("button", { name: "Edit alignment" }).click();
  // Folios need a witness: the server refuses one on an edition, at the locator.
  await page.locator("#oba-alignment-member-0-locators").fill("folio: 12r");
  const before = storedAlignments();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#oba-alignment-error")).toContainText("members[0].locators[0].kind");
  await expect(page.locator("#oba-alignment-member-0-locators")).toBeFocused();
  await expect(page.locator("#oba-alignment-member-0-locators")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Not saved. The stored alignments are unchanged.")).toBeVisible();
  expect(storedAlignments()).toBe(before);
});
