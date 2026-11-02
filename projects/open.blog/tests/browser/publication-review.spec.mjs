import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The research review before publication in the real Admin Studio (A8.3, ADR 0123 and ADR 0124):
// publishing a research post opens the review first; a citation the build would refuse blocks
// it and cannot be acknowledged; advisory findings never block, can be acknowledged from the
// keyboard and stay listed; every finding goes to its line, field or research object, keeping
// the unsaved draft; other posts publish exactly as before; and the review reflows at 320 pixels.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Politeia" },
    { id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam", rights: { status: "publicDomain", note: "ob-private-rights-note" } },
  ],
};
const NOTEBOOK = { version: 1, passages: [], notes: [{ id: "worry", kind: "question", text: "ob-private-note about the cave" }] };
const ATLAS = {
  version: 2,
  entries: [
    { id: "plato-person", kind: "person", label: "Plato", visibility: "approved" },
    { id: "the-good", kind: "concept", label: "ob-private-label The Good" },
  ],
  relationships: [],
};
const BODY = "## Abstract\n\nThe cave educates [@slings, page 514].\n\nSee [Plato](/atlas/plato-person/) and [the Good](/atlas/the-good/).\n\nAlso [@nobody].\n\n## References\n";
const POST = `---\ntitle: Cave\ndate: 2026-10-01\nprofile: research\ncitations: notes\ndraft: true\n---\n\n${BODY}`;
const PLAIN = "---\ntitle: Plain\ndate: 2026-10-01\ndraft: true\n---\n\nA plain post with [a link](/atlas/the-good/).\n";
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const researchBytes = () => ["sources.json", "notebook.json", "atlas.json"].map((name) => readFileSync(research(name), "utf8"));
const post = (name) => join(root, "content", "posts", name);
const usePreset = (preset, editorMode) => {
  const file = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, preset, density: "comfortable", editorMode, moduleOrder: MODULES, hiddenModules: [] }));
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-publication-review-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS));
  writeFileSync(post("cave.md"), POST);
  writeFileSync(post("plain.md"), PLAIN);
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
  writeFileSync(post("cave.md"), POST);
  writeFileSync(post("plain.md"), PLAIN);
  rmSync(research("acknowledgements.json"), { force: true });
  dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
});

async function openPost(page, name) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/#/edit/posts%2F${name}`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(name === "cave.md" ? "Cave" : "Plain");
}

const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });
const review = (page) => page.getByRole("dialog", { name: /^Research review/ });
const group = (page, name) => review(page).locator(`[data-review-group="${name}"]`);
const finding = (page, code) => review(page).locator(`[data-review-finding="${code}"]`);

/** Choose Published in Settings, from the keyboard, and press Save. */
async function publish(page) {
  await page.keyboard.press("Alt+7");
  await page.getByRole("radio", { name: "Published", exact: true }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

test("a citation the build would refuse blocks publishing, cannot be acknowledged, and nothing is saved", async ({ page }) => {
  await openPost(page, "cave.md");
  const before = researchBytes();
  await publish(page);
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole("heading", { level: 2 })).toHaveText("Research review before publishing");
  await expect(review(page).getByRole("heading", { level: 2 })).toBeFocused();
  await expect(group(page, "blocking").getByRole("heading")).toHaveText("Must be fixed before publishing (1)");
  await expect(group(page, "blocking").locator("[data-review-finding]")).toHaveAttribute("data-review-finding", "citation-unresolved");
  await expect(finding(page, "citation-unresolved").getByRole("button", { name: /^Acknowledge/ })).toHaveCount(0);
  await expect(review(page).getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await expect(review(page).locator("[data-review-blocked]")).toContainText("Publishing waits until");
  // Prompts, never verdicts; nothing private rides along.
  await expect(review(page)).toContainText("never verdicts");
  await expect(review(page)).not.toContainText(/score|ob-private/i);
  // Escape keeps editing; nothing was written.
  await page.keyboard.press("Escape");
  await expect(review(page)).toHaveCount(0);
  expect(readFileSync(post("cave.md"), "utf8")).toBe(POST);
  expect(researchBytes()).toEqual(before);
  expect(existsSync(research("acknowledgements.json"))).toBe(false);
  expect(dialogs).toEqual([]);
});

test("advisory findings never block: one is acknowledged from the keyboard, stays listed, and the post publishes", async ({ page }) => {
  await openPost(page, "cave.md");
  await page.keyboard.press("Alt+1");
  await markdown(page).fill(BODY.replace("\n\nAlso [@nobody].", ""));
  await publish(page);
  await expect(review(page)).toBeVisible();
  await expect(group(page, "blocking")).toHaveCount(0);
  await expect(group(page, "detected").getByRole("heading")).toHaveText(/^Detected \(\d+\)$/);
  await expect(finding(page, "context-link-unpublished")).toContainText("the atlas entry `the-good` is not approved");
  await expect(group(page, "needs-review").locator('[data-review-finding="citation-location-review"]')).toHaveCount(1);
  const confirm = review(page).getByRole("button", { name: "Publish", exact: true });
  await expect(confirm).toBeEnabled();

  const acknowledge = finding(page, "context-link-unpublished").getByRole("button", { name: /^Acknowledge context-link-unpublished/ });
  await acknowledge.focus();
  await page.keyboard.press("Space");
  await expect(acknowledge).toHaveAttribute("aria-pressed", "true");
  await expect(review(page).getByRole("status")).toContainText("it is not resolved");
  await expect(review(page).getByRole("status")).toContainText("(1 acknowledged)");
  await expect(finding(page, "context-link-unpublished")).toContainText("stays listed and counted");
  await expect.poll(() => existsSync(research("acknowledgements.json"))).toBe(true);
  const stored = readFileSync(research("acknowledgements.json"), "utf8");
  expect(stored).toContain("context-link-unpublished");
  expect(stored).not.toMatch(/resolved|ob-private|note/);

  await confirm.click();
  await expect(review(page)).toHaveCount(0);
  await expect.poll(() => readFileSync(post("cave.md"), "utf8")).not.toContain("draft: true");

  // The acknowledgement is current the next time the review runs, and the finding is still there.
  await page.keyboard.press("Alt+9");
  await page.getByRole("button", { name: "Review research before publishing" }).click();
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole("heading", { level: 2 })).toHaveText("Research review");
  await expect(finding(page, "context-link-unpublished").getByRole("button", { name: /^Acknowledge/ })).toHaveAttribute("aria-pressed", "true");
  await expect(review(page).getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await review(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("each finding goes to its line or its research object, and the unsaved draft is kept", async ({ page }) => {
  await openPost(page, "cave.md");
  await publish(page);
  await finding(page, "citation-unresolved").getByRole("button", { name: /^Go to line \d+ of the draft$/ }).click();
  await expect(review(page)).toHaveCount(0);
  await expect(markdown(page)).toBeFocused();
  expect(await markdown(page).evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe("Also [@nobody].");
  expect(readFileSync(post("cave.md"), "utf8")).toBe(POST);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(review(page)).toBeVisible();
  await finding(page, "context-link-unpublished").getByRole("link", { name: "Open the atlas entry the-good" }).click();
  await expect(page).toHaveURL(/#\/research\/atlas\/the-good$/);
  await expect(page.locator("#oba-page-heading")).toHaveText("Knowledge Atlas");
  const draftItem = page.getByRole("navigation", { name: "Research workspace" }).locator('[data-research-panel="draft"]');
  await expect(draftItem.locator(".oba-research-kept")).toHaveText("Unsaved changes kept");
  await page.getByRole("navigation", { name: "Research workspace" }).getByRole("link", { name: "Draft", exact: true }).click();
  await expect(page).toHaveURL(/#\/edit\/posts%2Fcave\.md$/);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cave");
  await page.keyboard.press("Alt+7");
  await expect(page.getByRole("radio", { name: "Published", exact: true })).toBeChecked();
  expect(readFileSync(post("cave.md"), "utf8")).toBe(POST);
  expect(dialogs).toEqual([]);
});

test("a post outside the research capability publishes exactly as before", async ({ page }) => {
  const reviews = [];
  page.on("request", (request) => {
    if (request.url().includes("/admin/api/research/review")) reviews.push(request.url());
  });
  await openPost(page, "plain.md");
  await publish(page);
  await expect.poll(() => readFileSync(post("plain.md"), "utf8")).not.toContain("draft: true");
  await expect(review(page)).toHaveCount(0);
  expect(reviews).toEqual([]);
});

test("the review reflows at 320 pixels and every control is reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openPost(page, "cave.md");
  await publish(page);
  await expect(review(page)).toBeVisible();
  const overflow = await review(page).evaluate((element) => {
    const width = element.clientWidth;
    return [...element.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > element.getBoundingClientRect().right + 1)
      .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`)
      .concat(element.scrollWidth - width > 1 ? ["dialog scrolls sideways"] : []);
  });
  expect(overflow).toEqual([]);
  await review(page).getByRole("button", { name: "Keep editing", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(review(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeFocused();
});
