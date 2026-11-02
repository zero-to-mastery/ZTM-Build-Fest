import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Reading-path curation in the real Admin Studio (B4.2, ADR 0213): create, edit, reorder without
// drag, delete; only published targets offered and unpublished steps identified; required
// reasons and relationship labels; diagnostics and the public-projection preview; stale-save
// protection; source mode; labelled, keyboard-operable controls; and no sideways scrolling on the
// regions at 320px nor at 400% zoom, with a very long path.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const DRAFT_TITLE = "Secret draft title";
let root;
let server;
let origin;

const pathFile = (slug) => join(root, "content", "paths", `${slug}.json`);
const stored = (slug) => (existsSync(pathFile(slug)) ? readFileSync(pathFile(slug), "utf8") : null);
const post = (name, title, extra = "") => {
  writeFileSync(join(root, "content", "posts", `${name}.md`), `---\ntitle: ${title}\ndate: ${name === "later" ? "2099-01-01" : "2026-01-01"}\n${extra}---\nBody of ${title}.\n`);
};
const step = (id, slug, transition) => ({ id, target: { kind: "post", slug }, ...(transition ? { transition } : {}) });
const next = (why = "It continues the thread.") => ({ relationship: "next", why });
const writePath = (slug, value) => {
  mkdirSync(dirname(pathFile(slug)), { recursive: true });
  writeFileSync(pathFile(slug), JSON.stringify({ format: "openblog-reading-path", version: 1, ...value }, null, 2) + "\n");
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-reading-paths-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Paths test", url: "https://paths.example.org", author: { name: "Alex" } }));
  post("alpha", "Alpha post");
  post("bravo", "Bravo post");
  post("charlie", "Charlie post");
  post("drafty", DRAFT_TITLE, "draft: true\n");
  post("later", "Scheduled later");
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
  rmSync(join(root, "content", "paths"), { recursive: true, force: true });
  dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
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

const heading = (page) => page.locator("#oba-page-heading");
const status = (page) => page.locator(".oba-paths-status");
const stepHeadings = (page) => page.locator(".oba-paths-step-heading");
const stepNames = async (page) => (await page.locator(".oba-paths-step-title").allTextContents()).map((text) => text.trim());

async function overflow(page, selector = "body") {
  return page.evaluate((selector) => {
    const width = window.innerWidth;
    const clipped = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) return true;
      }
      return false;
    };
    const region = document.querySelector(selector) || document.body;
    const offenders = [...region.querySelectorAll("*")]
      .filter((element) => element.getClientRects().length && element.getBoundingClientRect().right > width + 1 && !clipped(element))
      .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${[...element.classList].join(".")} right=${Math.round(element.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth - width, offenders };
  }, selector);
}

async function addStep(page, optionText) {
  await page.getByLabel("Post or atlas entry", { exact: true }).selectOption({ label: optionText });
  await page.getByRole("button", { name: "Add step", exact: true }).click();
}

test("a path is created from published posts only, with a required relationship and reason", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openAdmin(page, "#/paths");
  await expect(heading(page)).toHaveText("Reading paths");
  await expect(page.locator("[data-paths-empty]")).toBeVisible();
  await expect(page.locator("[data-paths-switch=off]")).toContainText("does not publish reading paths yet");
  await page.getByRole("link", { name: "New reading path" }).click();
  await expect(page).toHaveURL(/#\/paths\/new$/);

  // Only published posts are offered: no draft, no scheduled post.
  const picker = page.getByLabel("Post or atlas entry", { exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).not.toHaveCount(0);
  const options = await picker.locator("option").allTextContents();
  expect(options).toEqual(expect.arrayContaining(["Alpha post", "Bravo post", "Charlie post"]));
  expect(options.join("|")).not.toContain(DRAFT_TITLE);
  expect(options.join("|")).not.toContain("Scheduled later");

  await page.getByLabel("Title (required)").fill("A first tour");
  await page.getByLabel("Address name").fill("first-tour");
  await addStep(page, "Alpha post");
  await addStep(page, "Bravo post");
  await expect(stepHeadings(page)).toHaveCount(2);
  // Added steps leave the picker.
  await expect(picker.locator("option", { hasText: "Alpha post" })).toHaveCount(0);

  // The second step needs how it relates and why: saving without them writes nothing.
  await page.getByRole("button", { name: "Save reading path" }).click();
  await expect(page.locator("#oba-paths-problems-heading")).toBeFocused();
  await expect(page.locator(".oba-paths-problems")).toContainText("Choose how this step relates");
  await expect(page.locator(".oba-paths-problems")).toContainText("Say why this step follows");
  expect(stored("first-tour")).toBeNull();
  await expect(page.locator("#oba-paths-step-1-relationship")).toHaveAttribute("aria-required", "true");

  await page.locator("#oba-paths-step-1-relationship").selectOption("builds-on");
  await page.locator("#oba-paths-step-1-why").fill("Bravo takes Alpha's idea further.");
  await page.getByRole("button", { name: "Save reading path" }).click();
  await expect(status(page)).toHaveText("Saved.");
  await expect(page).toHaveURL(/#\/paths\/edit\/first-tour$/);
  const text = stored("first-tour");
  expect(text).toContain('"title": "A first tour"');
  expect(text).toContain('"relationship": "builds-on"');
  expect(text.endsWith("}\n")).toBe(true);
  expect(readdirSync(join(root, "content", "paths"))).toEqual(["first-tour.json"]);

  // The preview is the public projection: positions, the relationship in words, the reason.
  const preview = page.locator(".oba-paths-preview");
  await expect(preview).toContainText("This path is a draft");
  await expect(preview.locator(".oba-paths-preview-step")).toHaveCount(2);
  await expect(preview.locator(".oba-paths-preview-reason")).toContainText("Builds on the step it follows (step 1): Bravo takes Alpha's idea further.");
  expect(dialogs).toEqual([]);
});

test("steps are reordered with the keyboard alone, with focus kept and the move announced", async ({ page }) => {
  writePath("trio", { title: "Trio", status: "draft", steps: [step("a", "alpha"), step("b", "bravo", next("B after A.")), step("c", "charlie", next("C after B."))] });
  await openAdmin(page, "#/paths/edit/trio");
  await expect(stepHeadings(page)).toHaveCount(3);
  expect(await stepNames(page)).toEqual(["Alpha post", "Bravo post", "Charlie post"]);
  // Reach the third step's Move up control by Tab, and press it.
  const up = page.getByRole("button", { name: "Move Charlie post up, to position 2" });
  await up.focus();
  await page.keyboard.press("Enter");
  expect(await stepNames(page)).toEqual(["Alpha post", "Charlie post", "Bravo post"]);
  await expect(status(page)).toHaveText("Moved Charlie post to position 2 of 3.");
  // Focus stays on the same control for the same step, now at position 2.
  await expect(page.getByRole("button", { name: "Move Charlie post up, to position 1" })).toBeFocused();
  await page.keyboard.press("Space");
  expect(await stepNames(page)).toEqual(["Charlie post", "Alpha post", "Bravo post"]);
  // The step now first follows nothing: it shows no transition fields, and says what it holds.
  await expect(page.locator("#oba-paths-step-0-why")).toHaveCount(0);
  await expect(page.locator("[data-held-transition]")).toContainText("not saved while it is first");
  // Moving it back down restores what was written for it, because the editor held it in memory.
  await page.getByRole("button", { name: /^Move Charlie post down/ }).click();
  await expect(page.locator("#oba-paths-step-1-why")).toHaveValue("C after B.");
  await expect(page.locator("[data-held-transition]")).toHaveCount(0);
  await page.getByRole("button", { name: /^Move Charlie post up/ }).click();
  // Alpha, now second, needs a relationship and reason of its own before saving.
  await page.getByRole("button", { name: "Save reading path" }).click();
  await expect(page.locator(".oba-paths-problems")).toContainText("Step 2");
  await page.locator("#oba-paths-step-1-relationship").selectOption("next");
  await page.locator("#oba-paths-step-1-why").fill("Alpha follows Charlie here.");
  await page.getByRole("button", { name: "Save reading path" }).click();
  await expect(status(page)).toHaveText("Saved.");
  const saved = JSON.parse(stored("trio"));
  expect(saved.steps.map((s) => s.id)).toEqual(["c", "a", "b"]);
  expect(saved.steps[0].transition).toBeUndefined();
  // The first step's controls: no way to move it up; the last cannot move down.
  await expect(page.getByRole("button", { name: /^Move Charlie post up/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Move Bravo post down/ })).toBeDisabled();
});

test("draft, scheduled, missing and private steps are identified, and the preview and diagnostics follow production", async ({ page }) => {
  writePath("flags", {
    title: "Flags",
    status: "published",
    steps: [
      step("a", "alpha"),
      step("d", "drafty", next()),
      step("l", "later", next()),
      step("m", "no-such-post", next()),
      step("b", "bravo", next()),
    ],
  });
  await openAdmin(page, "#/paths/edit/flags");
  await expect(stepHeadings(page)).toHaveCount(5);
  const states = await page.locator(".oba-paths-state").allTextContents();
  expect(states).toEqual([
    "Published",
    "Draft: readers will not see this step",
    "Scheduled: not public yet, readers will not see this step",
    "Not found: readers will not see this step",
    "Published",
  ]);
  // The author sees their own draft's title in the editor; readers' projection never does.
  await expect(page.locator(".oba-paths-step-title").nth(1)).toHaveText(DRAFT_TITLE);
  const preview = page.locator(".oba-paths-preview");
  await expect(preview.locator("[data-paths-withheld]")).toContainText("would not be published");
  await expect(preview).not.toContainText(DRAFT_TITLE);
  await expect(preview.locator("[data-paths-diagnostics]")).toContainText("is not published, so the step is left out");
  await expect(preview.locator("[data-paths-diagnostics]")).toContainText("Readers are never told");
  // The list says it is not shown to readers.
  await page.goto(`${origin}/admin/#/paths`);
  await expect(page.locator('[data-path="flags"]')).toContainText("not shown to readers yet");
});

test("the preview shows the public projection of unsaved edits, and optional steps follow the last required one", async ({ page }) => {
  writePath("opt", { title: "Opt", status: "published", steps: [step("a", "alpha"), { ...step("b", "bravo", next("B.")), optional: true }, step("c", "charlie", { relationship: "builds-on", why: "C builds on A." })] });
  await openAdmin(page, "#/paths/edit/opt");
  const preview = page.locator(".oba-paths-preview");
  await expect(preview.locator(".oba-paths-preview-step")).toHaveCount(3);
  await expect(preview.locator(".oba-paths-preview-reason").nth(1)).toContainText("(step 1)");
  await expect(page.locator("#oba-paths-step-2-follows")).toContainText("It follows step 1: Alpha post");
  // An edit changes the preview without saving.
  await page.locator("#oba-paths-step-2-why").fill("Now it says something else.");
  await expect(preview.locator(".oba-paths-preview-reason").nth(1)).toContainText("Now it says something else.");
  expect(JSON.parse(stored("opt")).steps[2].transition.why).toBe("C builds on A.");
});

test("a stale save is refused with the newer copy offered, and nothing on disk changes", async ({ page }) => {
  writePath("stale", { title: "Stale", status: "draft", steps: [step("a", "alpha")] });
  await openAdmin(page, "#/paths/edit/stale");
  await expect(page.getByLabel("Title (required)")).toHaveValue("Stale");
  await page.getByLabel("Title (required)").fill("My edit");
  // Someone edits the file on disk meanwhile.
  writePath("stale", { title: "Edited elsewhere", status: "draft", steps: [step("a", "alpha")] });
  const disk = stored("stale");
  await page.getByRole("button", { name: "Save reading path" }).click();
  await expect(page.locator(".oba-paths-conflict")).toContainText("changed somewhere else");
  expect(stored("stale")).toBe(disk);
  await page.getByRole("button", { name: "Load the newer version and discard my edits" }).click();
  await expect(page.getByLabel("Title (required)")).toHaveValue("Edited elsewhere");
  expect(stored("stale")).toBe(disk);
});

test("source mode shows the canonical file, keeps fields it does not know, and refuses invalid source", async ({ page }) => {
  writePath("src", { title: "Src", status: "draft", steps: [step("a", "alpha"), step("b", "bravo", next())], "x-future": { kept: [1, 2] } });
  await openAdmin(page, "#/paths/edit/src");
  await page.getByRole("button", { name: "Edit as source" }).click();
  const source = page.getByLabel("Reading path source (JSON)");
  await expect(source).toBeVisible();
  expect(await source.inputValue()).toContain('"x-future"');
  // Edit the title in the source and save: canonical and the unknown field kept.
  await source.fill((await source.inputValue()).replace('"title": "Src"', '"title": "Src, edited"'));
  await page.getByRole("button", { name: "Save reading path" }).click();
  await expect(status(page)).toHaveText("Saved.");
  const text = stored("src");
  expect(text).toContain('"title": "Src, edited"');
  expect(text).toContain('"x-future"');
  expect(text.indexOf('"steps"')).toBeLessThan(text.indexOf('"x-future"'));
  // Invalid source is refused with scoped problems; the file is unchanged.
  const before = stored("src");
  await source.fill('{"format": "openblog-reading-path", "version": 1, "title": "T", "title": "again"}');
  await page.getByRole("button", { name: "Save reading path" }).click();
  await expect(page.locator(".oba-paths-problems")).toContainText("repeats the field `title`");
  expect(stored("src")).toBe(before);
  // Back to the form needs valid source and says so.
  await page.getByRole("button", { name: "Back to the form" }).click();
  await expect(page.locator(".oba-paths-problems")).toBeVisible();
  await expect(page.locator(".oba-paths-source")).toBeVisible();
});

test("a path moves to the trash after confirmation", async ({ page }) => {
  writePath("gone", { title: "Gone", status: "draft", steps: [step("a", "alpha")] });
  await openAdmin(page, "#/paths/edit/gone");
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page).toHaveURL(/#\/paths$/);
  expect(dialogs.map((d) => d.type)).toEqual(["confirm"]);
  expect(stored("gone")).toBeNull();
  expect(readdirSync(join(root, ".openblog", "trash")).some((name) => name.includes("paths_gone"))).toBe(true);
});

test("every control has a name, the page has one heading and landmarks, and a long path stays usable", async ({ page }) => {
  const posts = [];
  for (let i = 0; i < 40; i += 1) {
    post(`long-${i}`, `Long post number ${i}`);
    posts.push(i);
  }
  writePath("long", { title: "Long", status: "draft", steps: posts.map((i) => step(`s${i}`, `long-${i}`, i ? next(`Step ${i} follows.`) : null)) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAdmin(page, "#/paths/edit/long");
  await expect(stepHeadings(page)).toHaveCount(40);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  const unnamed = await page.evaluate(() => {
    const named = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim() !== "" || (el.labels && el.labels.length > 0) || el.getAttribute("aria-labelledby");
    return [...document.querySelectorAll("main button, main select, main textarea, main input")].filter((el) => !named(el)).map((el) => el.outerHTML.slice(0, 80));
  });
  expect(unnamed).toEqual([]);
  // Each step's controls are a labelled group; the reorder buttons name the step and the target position.
  await expect(page.getByRole("group", { name: "Order of step 3", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Long post number 2 down, to position 4" })).toBeEnabled();
  await page.getByRole("button", { name: "Move Long post number 2 down, to position 4" }).click();
  expect((await stepNames(page)).slice(0, 4)).toEqual(["Long post number 0", "Long post number 1", "Long post number 3", "Long post number 2"]);
});

for (const [name, viewport, zoom] of [["320px", { width: 320, height: 640 }, 1], ["400% zoom", { width: 1280, height: 800 }, 4]]) {
  test(`the editor, the list and the preview do not overflow at ${name}, with a long unbroken title and reason`, async ({ page }) => {
    const long = "L".repeat(110);
    writePath("wide", {
      title: long,
      summary: "S".repeat(200),
      status: "published",
      steps: [step("a", "alpha"), step("b", "bravo", next("W".repeat(300))), { ...step("c", "charlie", next("V".repeat(300))), rationale: "R".repeat(300) }],
    });
    await page.setViewportSize(zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom });
    await openAdmin(page, "#/paths");
    await expect(page.locator('[data-path="wide"]')).toBeVisible();
    const list = await overflow(page, ".oba-paths-list");
    expect(list.offenders, JSON.stringify(list)).toEqual([]);
    await page.goto(`${origin}/admin/#/paths/edit/wide`);
    await expect(stepHeadings(page)).toHaveCount(3);
    for (const selector of [".oba-paths-layout", ".oba-paths-form", ".oba-paths-preview", ".oba-paths-steps"]) {
      const result = await overflow(page, selector);
      expect(result.offenders, `${selector}: ${JSON.stringify(result)}`).toEqual([]);
    }
    const whole = await overflow(page);
    expect(whole.scroll, JSON.stringify(whole)).toBeLessThanOrEqual(1);
    // Source mode too.
    await page.getByRole("button", { name: "Edit as source" }).click();
    await expect(page.getByLabel("Reading path source (JSON)")).toBeVisible();
    const source = await overflow(page, ".oba-paths-source");
    expect(source.offenders, JSON.stringify(source)).toEqual([]);
    expect((await overflow(page)).scroll).toBeLessThanOrEqual(1);
  });
}
