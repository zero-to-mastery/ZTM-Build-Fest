import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The draft-side research panel in the real Admin Studio (A8.2, ADR 0122): a quotation goes in
// with its server-checked citation and renders exactly in the production preview; Ctrl+Z undoes
// it; Visual and Markdown modes keep the same bytes; context links appear only for published
// pages; a private note goes in only through explicit conversion; the panel works from the
// keyboard and reflows at 320 pixels; and nothing is written to the research files.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const EXCERPT = "Behold *human* beings [in] a <b>den</b> & 1. more";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Politeia" },
    { id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam", rights: { status: "publicDomain" } },
    { id: "bloom", kind: "translation", of: "plato", language: "en", title: "The Republic of Plato" },
  ],
};
const NOTEBOOK = {
  version: 1,
  passages: [
    { id: "cave", source: "slings", excerpt: { text: EXCERPT, language: "en" }, locators: [{ kind: "page", value: "514" }] },
    { id: "den", source: "bloom", excerpt: { text: "A translation nobody has checked" } },
  ],
  notes: [{ id: "why", kind: "question", text: "Private worry about the cave", passages: ["cave"] }],
};
const ATLAS = {
  version: 2,
  entries: [
    { id: "plato-person", kind: "person", label: "Plato", visibility: "approved" },
    { id: "the-good", kind: "concept", label: "The Good" },
  ],
  relationships: [],
};
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const researchBytes = () => ["sources.json", "notebook.json", "atlas.json"].map((name) => readFileSync(research(name), "utf8"));
const usePreset = (preset, editorMode) => {
  const file = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, preset, density: "comfortable", editorMode, moduleOrder: MODULES, hiddenModules: [] }));
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-draft-research-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS));
  const config = JSON.parse(readFileSync(join(root, "openblog.json"), "utf8"));
  config.knowledgeAtlas = { publish: true };
  writeFileSync(join(root, "openblog.json"), JSON.stringify(config, null, 2));
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
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
  // Windows can hold the stopped server's files for a moment.
  removeTree(root);
});

let dialogs;
test.beforeEach(({ page }) => {
  usePreset("simple", "markdown");
  dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
});

async function openNewPost(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/#/new/posts`);
  await expect(page.getByRole("button", { name: "Research", exact: true })).toBeVisible();
}

const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });
const visual = (page) => page.getByRole("textbox", { name: "Visual editor" });
const mode = (page, name) => page.getByRole("button", { name, exact: true });
const panel = (page) => page.getByRole("complementary", { name: "Research" });
const item = (page, key) => panel(page).locator(`[data-draft-item="${key}"]`);

async function useMarkdown(page, text, caret) {
  await mode(page, "Markdown").click();
  await markdown(page).fill(text);
  await markdown(page).evaluate((element, at) => element.setSelectionRange(at, at), caret);
}

test("a quotation goes in with its citation, renders exactly in the preview, and Ctrl+Z undoes it", async ({ page }) => {
  await openNewPost(page);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("On the cave");
  const draft = "An opening paragraph.\n\nA closing paragraph.\n";
  await useMarkdown(page, draft, 5);
  const before = researchBytes();
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Research", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Search research")).toBeFocused();
  await expect(panel(page).getByText("Your research stays private.", { exact: false })).toBeVisible();
  await expect(panel(page)).not.toContainText("Private worry about the cave");

  await item(page, "passage:cave").click();
  await expect(panel(page).locator("#oba-draft-research-detail-title")).toBeFocused();
  await expect(panel(page)).toContainText("1 private note is linked to this passage. It is never inserted with it.");
  await panel(page).getByRole("button", { name: "Insert quotation with citation" }).click();
  const quotation = "> Behold \\*human\\* beings \\[in\\] a &lt;b>den&lt;/b> &amp; 1. more [@slings, page 514]";
  await expect(markdown(page)).toHaveValue(`An opening paragraph.\n\n${quotation}\n\nA closing paragraph.\n`);
  await expect(markdown(page)).toBeFocused();
  await expect(page.locator(".oba-citation-bar [role=status]")).toHaveText(/Quotation inserted into your unsaved draft/);
  await expect(page.getByRole("button", { name: "Undo quotation" })).toBeVisible();

  // The production renderer shows the stored wording exactly, with no markup made from it.
  await page.getByRole("button", { name: "Site preview", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Preview"]');
  await expect(preview.locator("blockquote")).toContainText(EXCERPT);
  await expect(preview.locator("blockquote em, blockquote b")).toHaveCount(0);
  await page.getByRole("button", { name: "Write", exact: true }).click();

  await markdown(page).focus();
  await page.keyboard.press("Control+z");
  await expect(markdown(page)).toHaveValue(draft);
  await expect(page.locator(".oba-citation-bar [role=status]")).toHaveText("Quotation undone. The draft is as it was before.");
  expect(researchBytes()).toEqual(before);
  expect(dialogs).toEqual([]);
});

test("a quotation inserted in Visual mode keeps the same Markdown across mode switches", async ({ page }) => {
  await openNewPost(page);
  await useMarkdown(page, "First paragraph.\n\nSecond paragraph.\n", 0);
  await mode(page, "Visual").click();
  await visual(page).locator("p").first().click();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await item(page, "passage:cave").click();
  await panel(page).getByRole("button", { name: "Insert quotation with citation" }).click();
  await expect(visual(page).locator("blockquote .oba-citation")).toHaveText("[@slings, page 514]");
  await expect(visual(page).locator("blockquote")).toContainText("Behold *human* beings [in] a");
  await expect(visual(page).locator("blockquote em")).toHaveCount(0);
  await mode(page, "Markdown").click();
  const written = await markdown(page).inputValue();
  expect(written).toBe("First paragraph.\n\n> Behold \\*human\\* beings \\[in\\] a &lt;b>den&lt;/b> &amp; 1. more [@slings, page 514]\n\nSecond paragraph.\n");
  await mode(page, "Visual").click();
  await mode(page, "Markdown").click();
  await expect(markdown(page)).toHaveValue(written);
});

test("one source selection gives a citation with its locator, and nothing else", async ({ page }) => {
  await openNewPost(page);
  await useMarkdown(page, "A claim.", 7);
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await page.getByLabel("Search research").fill("republic of plato");
  await expect(panel(page).locator("[data-draft-item]")).toHaveCount(2);
  await item(page, "source:bloom").click();
  await panel(page).locator("#oba-draft-research-locators").fill("section: 7");
  await expect(panel(page).locator("[data-draft-research-citation]")).toHaveText("[@bloom, section 7]");
  await panel(page).getByRole("button", { name: "Insert citation" }).click();
  await expect(markdown(page)).toHaveValue("A claim [@bloom, section 7].");

  // A passage whose rights nobody checked waits for the author's confirmation.
  await item(page, "passage:den").click();
  await panel(page).getByRole("button", { name: "Insert quotation with citation" }).click();
  await expect(panel(page).locator("[data-draft-research-error]")).toContainText("Confirm that you have read the rights statement first");
  await expect(markdown(page)).toHaveValue("A claim [@bloom, section 7].");
});

test("context links only published pages, and a private note goes in only when converted", async ({ page }) => {
  await openNewPost(page);
  await useMarkdown(page, "Plato wrote.", 5);
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await page.getByLabel("Show").selectOption("context");
  await item(page, "atlas:the-good").click();
  await expect(panel(page).locator("[data-draft-research-warning]")).toContainText("Not published: this entry is private research");
  await expect(panel(page).getByRole("button", { name: /Insert link/ })).toHaveCount(0);
  await item(page, "atlas:plato-person").click();
  await panel(page).getByRole("button", { name: "Insert link to this entry" }).click();
  await expect(markdown(page)).toHaveValue("Plato [Plato](/atlas/plato-person/) wrote.");

  await page.getByLabel("Show").selectOption("notes");
  await item(page, "note:why").click();
  await panel(page).getByRole("button", { name: "Convert to draft text…" }).click();
  await expect(panel(page).getByLabel(/Put this private note into my draft as my own words/)).toBeFocused();
  await panel(page).getByRole("button", { name: "Insert as my own words" }).click();
  await expect(panel(page).locator("[data-draft-research-error]")).toContainText("Confirm the conversion first");
  await expect(markdown(page)).not.toHaveValue(/Private worry/);
  await panel(page).getByLabel(/Put this private note into my draft as my own words/).check();
  await panel(page).getByRole("button", { name: "Insert as my own words" }).click();
  await expect(markdown(page)).toHaveValue("Plato [Plato](/atlas/plato-person/) wrote.\n\nPrivate worry about the cave\n");
});

test("the panel works from the keyboard and closes with Escape back to its button", async ({ page }) => {
  await openNewPost(page);
  await useMarkdown(page, "Text.", 4);
  const toggle = page.getByRole("button", { name: "Research", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Search research")).toBeFocused();
  await page.keyboard.type("platonis");
  // Refresh is disabled, and so skipped by Tab, until the research has loaded.
  await expect(panel(page).getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect(item(page, "passage:cave")).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(item(page, "passage:cave")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).locator("#oba-draft-research-detail-title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("the open panel reflows at 320 pixels without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openNewPost(page);
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await item(page, "passage:cave").click();
  await expect(panel(page).getByRole("button", { name: "Insert quotation with citation" })).toBeVisible();
  const result = await page.evaluate(() => {
    const width = window.innerWidth;
    const clipped = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowX)) return true;
      }
      return false;
    };
    const offenders = [...document.querySelectorAll(".oba-draft-research *")]
      .filter((element) => element.getClientRects().length && element.getBoundingClientRect().right > width + 1 && !clipped(element))
      .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} right=${Math.round(element.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth - width, offenders };
  });
  expect(result.offenders).toEqual([]);
  expect(result.scroll).toBeLessThanOrEqual(1);
});
