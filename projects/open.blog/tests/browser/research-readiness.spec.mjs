import { test, expect } from "@playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The research readiness report in the real Admin Studio (#194, ADR 0150): What will be public
// shows, under the projections, the one report the command line prints, with the same codes in
// the same order; the draft-side Research panel and "What this post makes public" show the same
// review for one draft; an acknowledgement is keyboard operable, keeps the finding listed and
// counted and is never called resolved; a failure of a file the build reads blocks, cannot be
// acknowledged and changes no file; and every region reflows at 320 pixels.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const LEAK = "ZqxLeak readiness sentinel words kept private";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Politeia" },
    {
      id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam",
      rights: { status: "publicDomain", note: LEAK },
      identifiers: [{ scheme: "url", value: "http://files.internal/ZqxLeakReadinessSegmentSentinelAbcdef" }],
    },
  ],
};
const NOTEBOOK = { version: 1, passages: [], notes: [{ id: "worry", kind: "question", text: LEAK }] };
const ATLAS = {
  version: 2,
  entries: [
    { id: "plato-person", kind: "person", label: "Plato", visibility: "approved" },
    { id: "the-good", kind: "concept", label: LEAK },
  ],
  relationships: [],
};
const BODY = "## Abstract\n\nThe cave educates [@slings, page 514].\n\nSee [Plato](/atlas/plato-person/) and [the Good](/atlas/the-good/).\n\n## References\n";
const POST = `---\ntitle: Cave\ndate: 2026-10-01\nprofile: research\ncitations: notes\n---\n\n${BODY}`;
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const FILES = ["sources.json", "notebook.json", "atlas.json"];
const researchBytes = () => FILES.map((name) => readFileSync(research(name), "utf8"));
const post = (name) => join(root, "content", "posts", name);
const usePreset = (preset, editorMode) => {
  const file = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, preset, density: "comfortable", editorMode, moduleOrder: MODULES, hiddenModules: [] }));
};
const cli = (...args) => {
  const run = spawnSync(binary, [...args, "--root", root], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout || "", stderr: run.stderr || "" };
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-research-readiness-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS));
  writeFileSync(post("cave.md"), POST);
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
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS));
  rmSync(research("acknowledgements.json"), { force: true });
  dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
});

async function signIn(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
}

const site = (page) => page.locator('[data-publication-review="site"]');
const findings = (region) => region.locator("[data-review-finding]");
const codeOf = (region, code) => region.locator(`[data-review-finding="${code}"]`);

/** Elements of `region` whose box ends right of it, or a region that scrolls sideways, by name. */
const overflowing = (region) =>
  region.evaluate((element) => {
    const edge = element.getBoundingClientRect().right;
    return [...element.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > edge + 1)
      .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}${node.id ? `#${node.id}` : ""}`)
      .concat(element.scrollWidth - element.clientWidth > 1 ? ["the region scrolls sideways"] : [])
      .concat(element.getBoundingClientRect().right > window.innerWidth + 1 ? ["the region is wider than the window"] : []);
  });

/** `[validator: code]` of each finding the command line lists, in the order it lists them. */
const terminalCodes = (stderr) =>
  stderr
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.startsWith("research ") && line.endsWith("]"))
    .map((line) => line.slice(line.lastIndexOf("[") + 1, -1));

test("What will be public lists the report the command line prints, with the same codes in the same order", async ({ page }) => {
  await signIn(page);
  const before = researchBytes();
  await page.goto(`${origin}/admin/#/research/public`);
  await expect(site(page)).toBeVisible();
  // Under the panel's h2 the checks are an h3 and their groups h4.
  await expect(site(page).getByRole("heading", { level: 3, name: "Research checks" })).toBeVisible();
  await expect(site(page).locator("[data-review-group] > h4").first()).toBeVisible();
  const shown = await findings(site(page)).evaluateAll((nodes) => nodes.map((node) => node.dataset.reviewFinding));
  expect(shown).toEqual(expect.arrayContaining(["context-link-unpublished", "citation-identifier-unpublished"]));

  // The terminal's own list: the same codes, in the same order, from the same files.
  const checked = cli("check");
  expect(checked.status).toBe(0);
  const json = cli("check", "--json");
  expect(json.status).toBe(0);
  const report = JSON.parse(json.stdout);
  const fromJson = report.groups.flatMap((group) => group.findings.map((position) => report.findings[position].code));
  expect(shown).toEqual(fromJson);
  expect(terminalCodes(checked.stderr).map((code) => code.split(": ")[1])).toEqual(fromJson);
  await expect(site(page).locator("[data-review-status]")).toHaveText(
    checked.stderr.replace(/\r\n/g, "\n").split("\n").find((line) => line.startsWith("Research checks: ")).slice("Research checks: ".length),
  );
  // The report names the post and its line, and opens where it is repaired.
  const context = codeOf(site(page), "context-link-unpublished");
  await expect(context.locator("[data-review-place]")).toHaveText(/^posts\/cave\.md:\d+(:\d+)?$/);
  await expect(context.getByRole("link", { name: "Open the post posts/cave.md" })).toHaveAttribute("href", "#/edit/posts%2Fcave.md");
  await expect(context.getByRole("link", { name: "Open the atlas entry the-good" })).toHaveAttribute("href", "#/research/atlas/the-good");
  // Nothing private, nothing scored, nothing written.
  await expect(site(page)).not.toContainText("ZqxLeak");
  await expect(site(page)).not.toContainText(/score|\bpassed\b|ready to publish|\d+%/i);
  expect(researchBytes()).toEqual(before);
  expect(dialogs).toEqual([]);
});

test("an acknowledgement is keyboard operable, keeps the finding listed and counted, and is never called resolved", async ({ page }) => {
  await signIn(page);
  await page.goto(`${origin}/admin/#/research/public`);
  await expect(findings(site(page)).first()).toBeVisible();
  const before = await findings(site(page)).count();
  const context = codeOf(site(page), "context-link-unpublished");
  const toggle = context.getByRole("button", { name: /^Acknowledge context-link-unpublished/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(site(page).locator("[data-review-status]")).toContainText("it is not resolved");
  await expect(context.locator("[data-review-acknowledgement]")).toContainText("stays listed and counted");
  await expect(findings(site(page))).toHaveCount(before);
  expect(existsSync(research("acknowledgements.json"))).toBe(true);
  // It survives a refresh, and the command line says so in the same words.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(codeOf(site(page), "context-link-unpublished").getByRole("button", { name: /^Acknowledge/ })).toHaveAttribute("aria-pressed", "true");
  const checked = cli("check");
  expect(checked.stderr).toMatch(/research detected \(acknowledged\): posts\/cave\.md:\d+/);
  expect(checked.stderr.toLowerCase()).not.toMatch(/\(resolved\)|: resolved/);
  // Withdrawing is a toggle too.
  const again = codeOf(site(page), "context-link-unpublished").getByRole("button", { name: /^Acknowledge/ });
  await again.focus();
  await page.keyboard.press("Enter");
  await expect(again).toHaveAttribute("aria-pressed", "false");
  // Changing the link makes the old acknowledgement stale, and a stale one counts for nothing.
  await again.click();
  await expect(again).toHaveAttribute("aria-pressed", "true");
  writeFileSync(post("cave.md"), POST.replace("/atlas/the-good/", "/atlas/the-good/#dates"));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const stale = codeOf(site(page), "context-link-unpublished");
  await expect(stale.locator("[data-review-acknowledgement]")).toContainText("changed since");
  await expect(stale.getByRole("button", { name: /^Acknowledge/ })).toHaveAttribute("aria-pressed", "false");
});

test("one post's checks appear beside what it makes public and in the draft-side Research panel", async ({ page }) => {
  await signIn(page);
  await page.goto(`${origin}/admin/#/edit/posts%2Fcave.md`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cave");
  const before = researchBytes();
  // The draft-side panel counts the checks and opens the same review.
  await page.keyboard.press("Alt+1");
  const toggle = page.getByRole("button", { name: "Research", exact: true });
  await toggle.click();
  const panel = page.getByRole("complementary", { name: "Research" });
  const line = panel.locator("[data-draft-research-checks-line]");
  await expect(line).toHaveText(/Detected: \d+\. Potential: \d+\. Needs review: \d+\./);
  await expect(line).not.toContainText(/score|ready|passed|resolved/i);
  const open = panel.getByRole("button", { name: "Review research checks", exact: true });
  await open.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /^Research review/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-review-finding="context-link-unpublished"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // What this post makes public carries the same review, embedded.
  await page.keyboard.press("Alt+9");
  await page.getByRole("button", { name: "What this post makes public", exact: true }).click();
  const embedded = page.locator('[data-publication-review="embedded"]');
  await expect(embedded).toBeVisible();
  await expect(embedded.getByRole("heading", { level: 4, name: "Research checks" })).toBeVisible();
  await expect(embedded.locator('[data-review-finding="context-link-unpublished"]')).toContainText("line");
  await expect(embedded.locator("[data-review-confirm], [data-review-cancel]")).toHaveCount(0);
  await expect(embedded).not.toContainText("ZqxLeak");
  expect(readFileSync(post("cave.md"), "utf8")).toBe(POST);
  expect(researchBytes()).toEqual(before);
  expect(dialogs).toEqual([]);
});

test("a failure of a file the build reads blocks, cannot be acknowledged, and changes no file", async ({ page }) => {
  await signIn(page);
  writeFileSync(research("atlas.json"), "{ not json");
  const before = researchBytes();
  await page.goto(`${origin}/admin/#/research/public`);
  const blocking = site(page).locator('[data-review-group="blocking"]');
  await expect(blocking).toBeVisible();
  await expect(blocking.getByRole("heading", { level: 4 })).toHaveText(/^Must be fixed before publishing \(\d+\)$/);
  await expect(blocking).toContainText("The next build would refuse these");
  const entry = blocking.locator("[data-review-finding]").first();
  await expect(entry).toHaveAttribute("data-review-gate", "refuses");
  await expect(entry.getByRole("button", { name: /^Acknowledge/ })).toHaveCount(0);
  await expect(entry).toContainText("cannot be acknowledged");
  await expect(entry.getByRole("link", { name: "Open the Knowledge Atlas" })).toHaveAttribute("href", "#/research/atlas");
  const json = cli("check", "--json");
  expect(json.status).not.toBe(0);
  const report = JSON.parse(json.stdout);
  expect(report.groups[0].name).toBe("blocking");
  const out = join(root, "dist-readiness");
  const refused = cli("build", "--out", out);
  expect(refused.status).not.toBe(0);
  expect(existsSync(out), "a refused build writes nothing").toBe(false);
  expect(researchBytes()).toEqual(before);
});

test("every region reflows at 320 pixels without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await signIn(page);
  await page.goto(`${origin}/admin/#/research/public`);
  await expect(site(page)).toBeVisible();
  await expect(findings(site(page)).first()).toBeVisible();
  expect(await overflowing(site(page))).toEqual([]);
  expect(await overflowing(page.locator(".oba-boundary-panel"))).toEqual([]);

  await page.goto(`${origin}/admin/#/edit/posts%2Fcave.md`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cave");
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Research" });
  await expect(panel.locator("[data-draft-research-checks-line]")).toHaveText(/Detected:/);
  expect(await overflowing(panel)).toEqual([]);
  await page.keyboard.press("Alt+9");
  await page.getByRole("button", { name: "What this post makes public", exact: true }).click();
  const embedded = page.locator('[data-publication-review="embedded"]');
  await expect(embedded).toBeVisible();
  expect(await overflowing(embedded)).toEqual([]);
  expect(await overflowing(page.locator("[data-boundary-post]"))).toEqual([]);
});
