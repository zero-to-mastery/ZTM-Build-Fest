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

// Published passage comparisons (ADR 0092), from the real build and the real Admin Studio: the
// public page reads without JavaScript, identifies every version, quotes wording only where the
// author's rights statement allows it, keeps right-to-left wording in its direction, reflows on a
// phone and prints every version; approving and withdrawing in Admin publishes and removes it.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const HOSTILE = "<img src=x onerror=alert(1)> Πλάτων";
const HEBREW = "ירדתי אתמול לפיראוס";
const GREEK = "κατέβην χθὲς εἰς Πειραιᾶ";
const RESERVED = "ob-reserved-wording-never-public";
const SECRET = "ob-private-note-never-public";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Πολιτεία" },
    { id: "slings", kind: "edition", of: "plato", language: "grc", title: "Platonis Rempublicam", creators: [{ name: "S. R. Slings", role: "editor" }], rights: { status: "publicDomain", note: SECRET } },
    { id: "bloom", kind: "translation", of: "plato", language: "en", title: HOSTILE, creators: [{ name: "Allan Bloom", role: "translator" }], rights: { status: "rightsReserved" } },
    { id: "he", kind: "translation", of: "plato", language: "he", title: "פוליטאה", rights: { status: "openLicense", license: "CC-BY-4.0" } },
    { id: "ms", kind: "witness", of: "plato", title: "Paris gr. 1807" },
  ],
  interpretations: [
    { id: "mine", kind: "rendering", source: "slings", locators: [{ kind: "canonical", value: "327a" }], language: "en", text: "Down I went, yesterday", interpreters: [{ name: "Ada", attribution: "uncertain" }], rights: { status: "ownWork" } },
  ],
};
const NOTEBOOK = {
  version: 1,
  passages: [
    { id: "p-gr", source: "slings", excerpt: { text: GREEK, language: "grc" }, locators: [{ kind: "canonical", value: "327a" }] },
    { id: "p-en", source: "bloom", excerpt: { text: `${RESERVED} ${HOSTILE}`, language: "en" }, locators: [{ kind: "canonical", value: "327a" }] },
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
        { source: "slings", passage: "p-gr", note: SECRET },
        { source: "bloom", passage: "p-en" },
        { source: "he", passage: "p-he" },
        { source: "ms", absent: true },
        { interpretation: "mine" },
      ],
      rationale: "The first sentence in every version.",
      confidence: "plausible",
      recordedBy: { kind: "author" },
      visibility: "approved",
    },
    {
      id: "second",
      label: "Glaucon's request",
      members: [
        { source: "slings", locators: [{ kind: "canonical", value: "327b" }] },
        { source: "he", passage: "p-he" },
      ],
      confidence: "tentative",
      recordedBy: { kind: "author" },
      visibility: "private",
    },
  ],
});
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const writeResearch = () => {
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("alignments.json"), JSON.stringify(ALIGNMENTS()));
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-comparisons-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  const config = JSON.parse(readFileSync(join(root, "openblog.json"), "utf8"));
  config.comparisons = { publish: true };
  writeFileSync(join(root, "openblog.json"), JSON.stringify(config, null, 2));
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
    expect((await fetch(`${origin}/comparisons/opening/`)).ok).toBe(true);
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
  // Hostile text must never run: any dialog fails the test.
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the public page identifies every version and quotes only what its rights statement allows", async ({ page }) => {
    await page.goto(`${origin}/comparisons/`);
    await expect(page.getByRole("heading", { level: 1, name: "Comparisons" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Opening: the descent" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Glaucon's request" })).toHaveCount(0);
    await page.getByRole("link", { name: "Opening: the descent" }).click();
    await expect(page).toHaveURL(/\/comparisons\/opening\/$/);
    const article = page.locator("article.ob-comparison");
    await expect(page.getByRole("heading", { level: 1, name: "Opening: the descent" })).toBeVisible();
    await expect(article).toContainText("The author reads these places as corresponding in part.");
    await expect(article).toContainText("It does not say they mean the same thing");
    // One labelled section per version, in the author's order.
    const versions = page.locator("section.ob-comparison-version");
    await expect(versions).toHaveCount(5);
    await expect(page.getByRole("region", { name: "Platonis Rempublicam" })).toContainText("Editor: S. R. Slings");
    // Public domain: quoted exactly, in its language and direction.
    const greek = page.getByRole("region", { name: "Platonis Rempublicam" }).locator("blockquote");
    await expect(greek).toHaveText(GREEK);
    await expect(greek).toHaveAttribute("lang", "grc");
    await expect(greek).toHaveAttribute("dir", "ltr");
    // Rights reserved: identified and located, never quoted; the hostile title stays text.
    const bloom = page.getByRole("region", { name: HOSTILE });
    await expect(bloom).toContainText("Translator: Allan Bloom");
    await expect(bloom).toContainText("Where: 327a");
    await expect(bloom).toContainText("Wording not shown: the author states this version's text is under copyright");
    await expect(bloom.locator("blockquote")).toHaveCount(0);
    await expect(bloom.locator("img")).toHaveCount(0);
    // Open licence: quoted right to left, with the licence named.
    const hebrew = page.getByRole("region", { name: "פוליטאה" });
    await expect(hebrew).toContainText("(CC-BY-4.0)");
    const quote = hebrew.locator("blockquote");
    await expect(quote).toHaveText(HEBREW);
    await expect(quote).toHaveAttribute("dir", "rtl");
    expect(await quote.evaluate((node) => getComputedStyle(node).direction)).toBe("rtl");
    // Unknown rights and absence are said in words.
    await expect(page.getByRole("region", { name: "Paris gr. 1807" })).toContainText("Absent: this version lacks the passage.");
    // The interpretation is attributed and kept apart from the text it interprets.
    const rendering = page.getByRole("region", { name: "Rendering by Ada (uncertain)" });
    await expect(rendering).toContainText("An interpretation of Platonis Rempublicam");
    await expect(rendering.locator("blockquote")).toHaveText("Down I went, yesterday");
    await expect(article).toContainText("not legal judgements");
    const html = await page.content();
    expect(html).not.toContain(RESERVED);
    expect(html).not.toContain(SECRET);
    const json = await (await fetch(`${origin}/comparisons.json`)).text();
    expect(json).not.toContain(RESERVED);
    expect(json).not.toContain(SECRET);
    expect(JSON.parse(json).comparisons.map((comparison) => comparison.id)).toEqual(["opening"]);
  });

  test("the page reflows on a phone and prints every version", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${origin}/comparisons/opening/`);
    // The comparison (every version, place and wording) stays inside the viewport. The site's
    // own header and navigation belong to the theme, not to the comparison.
    const { overflow, offenders } = await page.evaluate(() => {
      const region = document.querySelector("article.ob-comparison");
      const elements = [region, ...region.querySelectorAll("*")];
      const limit = window.innerWidth;
      const offenders = elements
        .filter((element) => element.getBoundingClientRect().right > limit + 1)
        .map((element) => `${element.tagName.toLowerCase()}.${element.className}: ${Math.round(element.getBoundingClientRect().right)}px`);
      const widest = Math.max(...elements.map((element) => element.getBoundingClientRect().right));
      return { overflow: Math.max(widest - limit, region.scrollWidth - region.clientWidth), offenders };
    });
    expect(overflow, offenders.join(", ")).toBeLessThanOrEqual(1);
    await page.emulateMedia({ media: "print" });
    for (const name of ["Platonis Rempublicam", "פוליטאה", "Paris gr. 1807", "Rendering by Ada (uncertain)"]) {
      await expect(page.getByRole("region", { name })).toBeVisible();
    }
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

test("approving in Admin previews each place, publishes at once, and withdrawing removes the page", async ({ page }) => {
  writeResearch();
  await openAdmin(page, "#/compare/second");
  await expect(page.locator("#oba-compare-heading")).toHaveText("Glaucon's request");
  await expect(page.locator("[data-compare-publication]")).toHaveAttribute("data-compare-publication", "private");
  await expect(page.locator('[data-compare-place="0"] [data-compare-public]')).toHaveText("On a public page: located only; no wording is quoted for it.");
  await expect(page.locator('[data-compare-place="1"] [data-compare-public]')).toHaveText("On a public page: its wording is shown, with the version's rights statement.");
  expect((await fetch(`${origin}/comparisons/second/`)).status).toBe(404);

  await page.getByRole("button", { name: "Edit alignment" }).click();
  const approve = page.getByRole("checkbox", { name: "Approve this comparison for publication" });
  await expect(approve).toHaveAccessibleDescription(/\/comparisons\/second\/.*Your notes on places are never published/);
  await approve.focus();
  await page.keyboard.press("Space");
  await expect(approve).toBeChecked();
  await page.getByRole("button", { name: "Save changes" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Alignment saved to the private alignments file. The published comparisons were rebuilt.")).toBeVisible();
  const status = page.locator("[data-compare-publication]");
  await expect(status).toHaveAttribute("data-compare-publication", "published");
  await expect(status.getByRole("link", { name: "/comparisons/second/" })).toBeVisible();
  const published = await fetch(`${origin}/comparisons/second/`);
  expect(published.status).toBe(200);
  expect(await published.text()).toContain(HEBREW);
  expect(JSON.parse(readFileSync(research("alignments.json"), "utf8")).alignments[1].visibility).toBe("approved");

  await page.getByRole("button", { name: "Edit alignment" }).click();
  await page.getByRole("checkbox", { name: "Approve this comparison for publication" }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("[data-compare-publication]")).toHaveAttribute("data-compare-publication", "private");
  expect((await fetch(`${origin}/comparisons/second/`)).status).toBe(404);
  expect(await (await fetch(`${origin}/comparisons.json`)).text()).not.toContain("Glaucon");
});
