import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio at 400px: choosing the Job profile shows the job form and gives an empty draft the four
// scaffold headings; the answers are saved as the nested `job` mapping; leaving the profile keeps the Markdown (ADR 0287).

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
let root;
let server;
let origin;

test.use({ viewport: { width: 400, height: 800 } });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-job-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  const config = join(root, "openblog.json");
  writeFileSync(config, readFileSync(config, "utf8").replace("{\n", '{\n  "extraTrades": ["fencing"],\n'));
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

async function openNewPost(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/#/new/posts`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
}

async function openSettings(page) {
  const target = page.locator('[data-pane-target="settings"]');
  if (!(await target.isVisible())) await page.locator(".oba-editor-advanced > summary").click();
  await target.click();
  await expect(page.locator('[data-pane="settings"]')).toBeVisible();
}

const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });

// No control or region is wider than the viewport (a small tolerance, never tuned to one platform's fonts).
async function expectNoOverflow(page, selector) {
  const wider = await page.locator(selector).evaluate((region) => {
    const limit = document.documentElement.clientWidth + 2;
    const offenders = [region, ...region.querySelectorAll("*")].filter((node) => node.getBoundingClientRect().right > limit);
    return offenders.map((node) => `${node.tagName}.${node.className}`);
  });
  expect(wider).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)).toBe(true);
}

test("Job mode shows a labelled form that fits 400px and scaffolds an empty body once", async ({ page }) => {
  await openNewPost(page);
  await openSettings(page);
  const form = page.locator("[data-job-form]");
  await expect(form).toBeHidden();
  await page.getByLabel("Content profile").selectOption("job");
  await expect(form).toBeVisible();

  for (const label of ["Trade", "Service", "Town", "Region or state", "Started", "Finished", "Price range", "Add before photos", "Add after photos"]) {
    await expect(form.getByLabel(label, { exact: true })).toBeVisible();
  }
  // Bundled and site-level trades; today's date is offered for a new job.
  const trades = await form.getByLabel("Trade", { exact: true }).locator("option").allTextContents();
  expect(trades).toEqual(expect.arrayContaining(["flooring", "hvac", "fencing"]));
  await expect(form.getByLabel("Started", { exact: true })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);

  for (const control of await form.locator("input[type=text], input[type=date], select").all()) {
    expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(43);
  }
  await expectNoOverflow(page, "[data-job-form]");

  await page.locator('[data-pane-target="write"]').click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(markdown(page)).toHaveValue("## Problem\n\n## What we found\n\n## What we did\n\n## Result\n\n");

  // Choosing the profile again never overwrites words that are there.
  await markdown(page).fill("## Problem\n\nA squeaky floor.\n");
  await openSettings(page);
  await page.getByLabel("Content profile").selectOption("article");
  await expect(form).toBeHidden();
  await page.getByLabel("Content profile").selectOption("job");
  await page.locator('[data-pane-target="write"]').click();
  await expect(markdown(page)).toHaveValue("## Problem\n\nA squeaky floor.\n");
});

test("the visual editor keeps the scaffold as ordinary headings that can be changed", async ({ page }) => {
  await openNewPost(page);
  await openSettings(page);
  await page.getByLabel("Content profile").selectOption("job");
  await page.locator('[data-pane-target="write"]').click();
  await page.getByRole("button", { name: "Visual", exact: true }).click();
  const visual = page.getByRole("textbox", { name: "Visual editor" });
  await expect(visual.getByRole("heading", { level: 2 })).toHaveText(["Problem", "What we found", "What we did", "Result"]);
  await visual.getByRole("heading", { name: "Result" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and aftercare");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(markdown(page)).toHaveValue(/## Result and aftercare/);
});

test("a job is saved as a nested mapping, reopens with its answers, and leaving the profile keeps the Markdown", async ({ page }) => {
  await openNewPost(page);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Oak floor in Maple Falls");
  await openSettings(page);
  await page.getByLabel("Content profile").selectOption("job");
  const form = page.locator("[data-job-form]");

  await form.getByRole("button", { name: "Check this job" }).click();
  const problems = form.locator(".oba-job-problems");
  await expect(problems).toContainText("job.trade");
  await expect(problems).toContainText("job.place.town");

  await form.getByLabel("Trade", { exact: true }).selectOption("flooring");
  await form.getByLabel("Service", { exact: true }).fill("hardwood-install");
  await form.getByLabel("Town", { exact: true }).fill("Maple Falls");
  await form.getByLabel("Region or state", { exact: true }).fill("WA");
  await form.getByLabel("Started", { exact: true }).fill("2026-10-14");
  await form.getByLabel("Finished", { exact: true }).fill("2026-10-16");
  await form.getByLabel("Price range", { exact: true }).selectOption("2k-10k");
  await form.getByLabel("Add before photos", { exact: true }).setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
  await expect(form.locator('[data-job-group="before"] li')).toHaveCount(1);
  await form.getByLabel("Add after photos", { exact: true }).setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
  await expect(form.locator('[data-job-group="after"] li')).toHaveCount(1);
  await expectNoOverflow(page, "[data-job-form]");

  await form.getByRole("button", { name: "Check this job" }).click();
  await expect(form.getByRole("status").last()).toContainText("everything it needs");

  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();

  const posts = join(root, "content", "posts");
  const saved = readdirSync(posts).filter((name) => name.endsWith("oak-floor-in-maple-falls.md"));
  expect(saved).toHaveLength(1);
  const text = readFileSync(join(posts, saved[0]), "utf8");
  expect(text).toMatch(/profile: job/);
  expect(text).toMatch(/job:\n  costBand: 2k-10k\n  finished: 2026-10-16\n  media:\n    after:\n      - \/\S+\n    before:\n      - \/\S+\n  place:\n    region: WA\n    town: Maple Falls\n  service: hardwood-install\n  started: 2026-10-14\n  trade: flooring\n/);
  expect(text).toContain("## Problem");

  await page.reload();
  await openSettings(page);
  const reopened = page.locator("[data-job-form]");
  await expect(reopened.getByLabel("Town", { exact: true })).toHaveValue("Maple Falls");
  await expect(reopened.getByLabel("Trade", { exact: true })).toHaveValue("flooring");
  await expect(reopened.getByLabel("Price range", { exact: true })).toHaveValue("2k-10k");
  await expect(reopened.locator('[data-job-group="before"] li')).toHaveCount(1);
  await reopened.getByRole("button", { name: /^Remove before photo 1/ }).click();
  await expect(reopened.locator('[data-job-group="before"] li')).toHaveCount(0);

  // Switching away from Job hides the form and leaves the body exactly as written.
  await page.locator('[data-pane-target="write"]').click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const body = await markdown(page).inputValue();
  await openSettings(page);
  await page.getByLabel("Content profile").selectOption("article");
  await expect(reopened).toBeHidden();
  await page.locator('[data-pane-target="write"]').click();
  await expect(markdown(page)).toHaveValue(body);
});
