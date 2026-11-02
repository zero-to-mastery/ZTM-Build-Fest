import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Services screen at 400px (ADR 0313): the list and the form fit the screen, every control is
// at least 44px tall and named, the question list adds, moves and removes entries from the keyboard, problems
// are said beside their fields, and a save writes the services/ file and reaches the built site.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

test.use({ viewport: { width: 400, height: 800 } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-services-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
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

async function signedIn(page, hash) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/${hash}`);
}

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

async function expectTouchTargets(page) {
  for (const control of await page.locator("[data-services-screen] input:not([type=checkbox]), [data-services-screen] select, [data-services-screen] textarea, [data-services-screen] button, [data-services-screen] a.oba-btn").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box.height, await control.evaluate((node) => node.getAttribute("aria-label") || node.id || node.textContent)).toBeGreaterThanOrEqual(43);
  }
  for (const box of await page.locator("[data-services-screen] input[type=checkbox]").all()) {
    expect(await box.evaluate((node) => node.closest("label").getBoundingClientRect().height)).toBeGreaterThanOrEqual(43);
  }
}

// A question's own fields (the move and remove buttons carry the word "question" in their names, so match exactly).
const entry = (page, index) => ({
  getByLabel: (name) => page.locator(`[data-faq-entry="${index}"]`).getByLabel(name, { exact: true }),
});
const status = (page) => page.locator("[data-services-status]");
const file = (name) => join(root, "content", "services", name);

test("an empty list invites a first service and the form fits 400px with 44px, named controls", async ({ page }) => {
  await signedIn(page, "#/services");
  await expect(page.locator('[data-services-screen="list"]')).toBeVisible();
  await expect(page.locator("[data-services-empty]")).toContainText("No services yet");
  await expectNoOverflow(page, "[data-services-screen]");
  await expectTouchTargets(page);

  await page.getByRole("link", { name: "Add a service" }).click();
  await expect(page.locator('[data-services-screen="form"]')).toBeVisible();
  for (const label of ["Name", "Id", "Summary", "Starting price band", "Typical timeline", "Page text", "Keep this as a draft"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  expect(await page.getByLabel("Starting price band", { exact: true }).locator("option").allTextContents()).toEqual([
    "Do not show a price", "Under $500", "$500 to $2,000", "$2,000 to $10,000", "$10,000 to $50,000", "Over $50,000", "Ask for a quote",
  ]);
  await expectNoOverflow(page, "[data-services-screen]");
  await expectTouchTargets(page);
  await page.getByRole("button", { name: "Save service" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Save service" })).toBeVisible();
});

test("incomplete entries are said beside their fields, in words, and nothing is saved", async ({ page }) => {
  await signedIn(page, "#/services/new");
  await page.getByLabel("Name", { exact: true }).fill("Hardwood installation");
  await expect(page.getByLabel("Id", { exact: true })).toHaveValue("hardwood-installation");
  await page.getByRole("button", { name: "Add a question" }).click();
  await expect(entry(page, 0).getByLabel("Question")).toBeFocused();
  await entry(page, 0).getByLabel("Question").fill("Do I have to move out?");
  await page.getByRole("button", { name: "Save service" }).click();

  await expect(status(page)).toContainText("2 things need fixing");
  await expect(page.locator('[data-problem-for="summary"]')).toContainText("Add the service's summary");
  await expect(page.locator('[data-problem-for="faq-0"]')).toContainText("Add an answer");
  await expect(page.getByLabel("Summary", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Summary", { exact: true })).toBeFocused();
  await expectNoOverflow(page, "[data-services-screen]");
  expect(existsSync(file("hardwood-installation.md"))).toBe(false);
});

test("a service with questions is saved, written as a list of questions, and reaches the site", async ({ page }) => {
  await signedIn(page, "#/services/new");
  await page.getByLabel("Name", { exact: true }).fill("Hardwood installation");
  await page.getByLabel("Id", { exact: true }).fill("hardwood-install");
  await page.getByLabel("Summary", { exact: true }).fill("Solid oak or maple floors, nailed and finished on site.");
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("Included item 1", { exact: true }).fill("Removing the old floor");
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("Included item 2", { exact: true }).fill("Two coats of finish");
  await page.getByLabel("Starting price band", { exact: true }).selectOption("2k-10k");
  await page.getByLabel("Typical timeline", { exact: true }).fill("2 to 4 days");

  await page.getByRole("button", { name: "Add a question" }).click();
  await entry(page, 0).getByLabel("Question").fill("Can you match my existing floor?");
  await entry(page, 0).getByLabel("Answer").fill("Usually: we bring samples so you can compare them in your own light.");
  await page.getByRole("button", { name: "Add a question" }).click();
  await entry(page, 1).getByLabel("Question").fill("Do I have to move out?");
  await entry(page, 1).getByLabel("Answer").fill("No. We work one room at a time.");
  await page.getByRole("button", { name: "Add a question" }).click();
  await entry(page, 2).getByLabel("Question").fill("A question I will remove");
  await entry(page, 2).getByLabel("Answer").fill("Gone.");
  // Move the second question to the top, then remove the third.
  await page.getByRole("button", { name: "Move question 2 up" }).click();
  await page.getByRole("button", { name: "Remove question 3" }).click();
  await expect(page.locator("[data-faq-entry]")).toHaveCount(2);
  await expect(entry(page, 0).getByLabel("Question")).toHaveValue("Do I have to move out?");
  await page.getByLabel("Page text", { exact: true }).fill("We install hardwood floors.");
  await expectNoOverflow(page, "[data-services-screen]");
  await expectTouchTargets(page);

  await page.getByRole("button", { name: "Save service" }).click();
  await expect(status(page)).toContainText("Saved.");
  await expect(page).toHaveURL(/#\/services\/edit\/services%2Fhardwood-install\.md$/);
  await expect(page.getByLabel("Id", { exact: true })).toHaveAttribute("readonly", "");

  const text = readFileSync(file("hardwood-install.md"), "utf8");
  expect(text).toContain("version: 1");
  expect(text).toContain("faq:\n  - question: Do I have to move out?\n    answer: No. We work one room at a time.\n  - question: Can you match my existing floor?\n    answer: \"Usually: we bring samples so you can compare them in your own light.\"\n");
  expect(text).not.toContain("I will remove");
  expect(text).toContain("priceBand: 2k-10k");

  const index = await (await fetch(`${origin}/services/`)).text();
  expect(index).toContain("Hardwood installation");
  expect(index).toContain("$2,000 to $10,000");
  const servicePage = await (await fetch(`${origin}/services/hardwood-install/`)).text();
  expect(servicePage).toContain("Frequently asked questions");
  expect(servicePage).toContain("Do I have to move out?");
  expect(servicePage).toContain('"@type":"FAQPage"');
  expect(servicePage).toContain("We install hardwood floors.");
});

test("a saved service comes back on reload, keeps unknown keys, and shows in the list", async ({ page }) => {
  const path = file("hardwood-install.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("---\n\n", "future: kept\n---\n\n"));
  await signedIn(page, "#/services");
  await expect(page.locator("[data-service-row]")).toHaveCount(1);
  await expectNoOverflow(page, "[data-services-screen]");
  await expectTouchTargets(page);
  await page.getByRole("link", { name: "Hardwood installation" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Hardwood installation");
  await expect(page.getByLabel("Starting price band", { exact: true })).toHaveValue("2k-10k");
  await expect(page.locator("[data-faq-entry]")).toHaveCount(2);
  await expect(page.getByLabel("Included item 2", { exact: true })).toHaveValue("Two coats of finish");

  await entry(page, 1).getByLabel("Answer").fill("Usually, and we bring samples.");
  await expect(page.locator("[data-services-dirty]")).toContainText("unsaved");
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(status(page)).toContainText("Saved.");
  await expect(page.locator("[data-services-dirty]")).toContainText("All changes saved");
  const text = readFileSync(path, "utf8");
  expect(text).toContain("future: kept");
  expect(text).toContain("answer: Usually, and we bring samples.");
  await page.reload();
  await expect(entry(page, 1).getByLabel("Answer")).toHaveValue("Usually, and we bring samples.");
});

test("a very long unbroken name and question still fit 400px", async ({ page }) => {
  await signedIn(page, "#/services/new");
  const long = "Supercalifragilisticexpialidocious".repeat(3);
  await page.getByLabel("Name", { exact: true }).fill(long);
  await page.getByLabel("Summary", { exact: true }).fill(long);
  await page.getByRole("button", { name: "Add a question" }).click();
  await entry(page, 0).getByLabel("Question").fill(long);
  await entry(page, 0).getByLabel("Answer").fill(long.repeat(3));
  await expectNoOverflow(page, "[data-services-screen]");
});

test("a stale save keeps the edits and offers to reload; a delete asks first and removes the page", async ({ page }) => {
  await signedIn(page, `#/services/edit/${encodeURIComponent("services/hardwood-install.md")}`);
  await page.getByLabel("Typical timeline", { exact: true }).fill("3 to 5 days");
  const path = file("hardwood-install.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(page.locator("[data-services-conflict]")).toBeVisible();
  await expect(page.getByLabel("Typical timeline", { exact: true })).toHaveValue("3 to 5 days");
  await page.getByRole("button", { name: "Reload this service" }).click();
  await expect(page.getByLabel("Typical timeline", { exact: true })).toHaveValue("2 to 4 days");

  await page.getByRole("button", { name: "Delete this service" }).click();
  await expect(page.locator("[data-services-delete-confirm]")).toBeVisible();
  await page.getByRole("button", { name: "Keep it" }).click();
  expect(existsSync(path)).toBe(true);
  await page.getByRole("button", { name: "Delete this service" }).click();
  await page.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(page).toHaveURL(/#\/services$/);
  expect(existsSync(path)).toBe(false);
  await expect(page.locator("[data-services-empty]")).toBeVisible();
});
