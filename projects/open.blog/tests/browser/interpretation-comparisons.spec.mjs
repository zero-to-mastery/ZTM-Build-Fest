import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Interpretation comparisons in the real Admin Studio (B7.2, ADR 0231): attributed readings,
// evidence states (missing evidence is shown and never blocks), AI drafts that stay drafts until
// the Approve action and are withdrawn by editing, revocation, source mode, stale-save conflicts,
// keyboard operation, and no sideways scrolling at 320px.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const AI_TEXT = "A beginner picture of shadows on a wall.";
let root;
let server;
let origin;

const file = (slug) => join(root, "content", "comparisons", `${slug}.json`);
const stored = (slug) => (existsSync(file(slug)) ? readFileSync(file(slug), "utf8") : null);
const writeComparison = (slug, value) => {
  mkdirSync(dirname(file(slug)), { recursive: true });
  writeFileSync(file(slug), JSON.stringify({ format: "openblog-interpretation-comparison", version: 1, ...value }, null, 2) + "\n");
};
const named = (id, name, statement) => ({ id, attribution: { kind: "named", name }, statement });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-comparisons-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  mkdirSync(join(root, ".openblog", "private", "research"), { recursive: true });
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Comparisons test", url: "https://cmp.example.org", author: { name: "Alex" } }));
  writeFileSync(join(root, ".openblog", "private", "research", "sources.json"), JSON.stringify({ version: 1, sources: [{ id: "plato", kind: "work", title: "Politeia" }] }));
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
  removeTree(root);
});

test.beforeEach(({ page }) => {
  rmSync(join(root, "content", "comparisons"), { recursive: true, force: true });
  page.on("dialog", (dialog) => dialog.accept());
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

const status = (page) => page.locator(".oba-paths-status");
const item = (page, id) => page.locator(`[data-item-id="${id}"]`);

async function overflow(page, selector) {
  return page.evaluate((selector) => {
    const width = window.innerWidth;
    const clipped = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowX)) return true;
      }
      return false;
    };
    const region = document.querySelector(selector) || document.body;
    const offenders = [...region.querySelectorAll("*")]
      .filter((element) => element.getClientRects().length && element.getBoundingClientRect().right > width + 1 && !clipped(element))
      .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);
    return { scroll: document.documentElement.scrollWidth - width, offenders };
  }, selector);
}

async function twoReadings(page) {
  await page.getByLabel("Title (required)", { exact: true }).fill("The cave");
  await page.getByLabel("Address name", { exact: true }).fill("cave");
  await page.getByLabel("What the readings are about, in neutral words (required)").fill("Readings of the cave image");
  for (const [index, name] of ["A political reading", "An epistemic reading"].entries()) {
    await page.getByRole("button", { name: "Add an interpretation", exact: true }).click();
    const card = page.locator(".oba-cmp-items > ol").first().locator("> li").nth(index);
    await card.getByLabel("Name (required)").fill(name);
    await card.getByLabel("What this reading holds, in your words (required)").fill(`${name} holds something.`);
  }
}

test("an AI draft stays a draft until Approve, editing withdraws the approval, and Withdraw returns it to draft", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openAdmin(page, "#/comparisons/new");
  await twoReadings(page);
  await page.getByLabel("Level of the explanation to add").selectOption("beginner");
  await page.getByRole("button", { name: "Add an explanation", exact: true }).click();
  const explanation = page.locator('ol[aria-label="Explanations"] > li').first();
  await explanation.getByLabel("Explanation (required)").fill(AI_TEXT);
  await explanation.getByLabel("An AI tool drafted this text").check();
  await explanation.getByLabel("Which AI tool drafted this text (required)").fill("a writing assistant");
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(status(page)).toHaveText("Saved.");
  expect(stored("cave")).toContain("ai-draft");
  expect(stored("cave")).not.toContain("approval");
  // Readers do not see the AI text, and the author is told why.
  await expect(page.locator("[data-cmp-left-out]")).toContainText("AI draft not approved");
  await expect(page.locator(".oba-cmp-preview")).not.toContainText(AI_TEXT);
  // Approve by keyboard: the button is reachable and named for what it does.
  const approve = page.getByRole("button", { name: "Approve this exact text", exact: true });
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Approved the exact text");
  expect(stored("cave")).toContain('"approval"');
  expect(stored("cave")).toContain('"by": "writer"');
  await expect(page.locator(".oba-cmp-preview")).toContainText(AI_TEXT);
  await expect(page.locator(".oba-cmp-preview")).toContainText("AI-assisted draft (a writing assistant), approved by the author");
  // Editing the approved text withdraws the approval and says so.
  await explanation.getByLabel("Explanation (required)").fill(`${AI_TEXT} Edited.`);
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(status(page)).toContainText("approval was withdrawn");
  expect(stored("cave")).not.toContain('"approval"');
  await expect(page.locator(".oba-cmp-preview")).not.toContainText("Edited.");
  // Approve again, publish, then withdraw: a published comparison must return to draft.
  await page.getByRole("button", { name: "Approve this exact text", exact: true }).click();
  await expect(status(page)).toContainText("Approved");
  await page.getByLabel("Status", { exact: true }).selectOption("published");
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(status(page)).toHaveText("Saved.");
  expect(stored("cave")).toContain('"status": "published"');
  await page.getByRole("button", { name: "Withdraw approval", exact: true }).click();
  await expect(status(page)).toContainText("Withdrew the approval");
  expect(stored("cave")).toContain('"status": "draft"');
  expect(stored("cave")).not.toContain('"approval"');
});

test("missing evidence is shown in words and never blocks saving honest uncertainty", async ({ page }) => {
  writeComparison("cave", {
    title: "The cave",
    subject: "Readings",
    interpretations: [
      { ...named("one", "Reader one", "A reading."), evidence: [{ source: "plato", locator: "514a" }, { link: "ghost" }], uncertainty: "Nobody knows." },
      named("two", "Reader two", "Another reading."),
    ],
  });
  await openAdmin(page, "#/comparisons/edit/cave");
  const first = item(page, "one");
  await expect(first.locator('[data-evidence="plato"]')).toContainText("Private");
  await expect(first.locator('[data-evidence="ghost"]')).toContainText("Not found in your research library");
  await expect(item(page, "two").locator("[data-no-evidence]")).toBeVisible();
  await expect(page.locator("[data-cmp-notes]")).toContainText("one:");
  // Link a source from the picker with the keyboard, then save despite the missing reference.
  await item(page, "two").getByLabel("Link evidence", { exact: true }).selectOption({ label: "Politeia" });
  await item(page, "two").getByRole("button", { name: "Link evidence", exact: true }).click();
  await expect(item(page, "two").locator('[data-evidence="plato"]')).toBeVisible();
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(status(page)).toHaveText("Saved.");
  expect(stored("cave")).toContain('"link": "ghost"');
});

test("an interpretation without attribution is refused before anything is written", async ({ page }) => {
  await openAdmin(page, "#/comparisons/new");
  await twoReadings(page);
  await page.locator('ol[aria-label="Interpretations"] > li').first().getByLabel("Name (required)").fill("");
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(page.locator(".oba-paths-problems")).toContainText("Say who held this reading");
  expect(stored("cave")).toBeNull();
  // An explicit unknown author is honest and saves.
  const card = page.locator('ol[aria-label="Interpretations"] > li').first();
  await card.getByLabel("Who held this reading").selectOption("anonymous");
  await page.locator('ol[aria-label="Interpretations"] > li').first().getByLabel("Describe the unknown author (required)").fill("An unknown commentator");
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(status(page)).toHaveText("Saved.");
});

test("a save made against a stale revision keeps the draft and offers the newer copy", async ({ page }) => {
  writeComparison("cave", { title: "The cave", subject: "Readings", interpretations: [named("one", "A", "First."), named("two", "B", "Second.")] });
  await openAdmin(page, "#/comparisons/edit/cave");
  await expect(page.getByLabel("Title (required)", { exact: true })).toHaveValue("The cave");
  writeComparison("cave", { title: "Changed elsewhere", subject: "Readings", interpretations: [named("one", "A", "First."), named("two", "B", "Second.")] });
  await page.getByLabel("Title (required)", { exact: true }).fill("Mine");
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(page.locator(".oba-paths-conflict")).toContainText("changed somewhere else");
  expect(stored("cave")).toContain("Changed elsewhere");
  await page.getByRole("button", { name: "Load the newer version and discard my edits" }).click();
  await expect(page.getByLabel("Title (required)", { exact: true })).toHaveValue("Changed elsewhere");
});

test("source mode keeps fields this release does not know and refuses a verdict", async ({ page }) => {
  writeComparison("cave", { title: "The cave", subject: "Readings", "x-note": "kept", interpretations: [named("one", "A", "First."), named("two", "B", "Second.")] });
  await openAdmin(page, "#/comparisons/edit/cave");
  await page.getByRole("button", { name: "Edit as source", exact: true }).click();
  const source = page.getByLabel("Comparison source (JSON)");
  await expect(source).toHaveValue(/x-note/);
  const bad = JSON.parse(await source.inputValue());
  bad.interpretations[0].verdict = "correct";
  await source.fill(JSON.stringify(bad));
  await page.getByRole("button", { name: "Save comparison", exact: true }).click();
  await expect(page.locator(".oba-paths-problems")).toBeVisible();
  expect(stored("cave")).not.toContain("verdict");
  expect(stored("cave")).toContain("x-note");
});

test("the editor reflows at 320px with no sideways scrolling", async ({ page }) => {
  writeComparison("cave", {
    title: "A comparison with a very long title that must wrap rather than overflow the small screen",
    subject: "Readings",
    interpretations: [
      { ...named("one", "Reader with a very long name that keeps going and going", "A reading."), evidence: [{ link: "a-very-long-evidence-link-identifier-that-keeps-going" }] },
      named("two", "B", "Second."),
    ],
    explanations: [{ id: "easy", level: "beginner", text: "Explained.", origin: { kind: "ai-draft", tool: "an assistant with a rather long label" } }],
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await openAdmin(page, "#/comparisons/edit/cave");
  await expect(page.locator(".oba-cmp-form")).toBeVisible();
  const result = await overflow(page, ".oba-workspace-content");
  expect(result.offenders).toEqual([]);
  expect(result.scroll).toBeLessThanOrEqual(1);
});
