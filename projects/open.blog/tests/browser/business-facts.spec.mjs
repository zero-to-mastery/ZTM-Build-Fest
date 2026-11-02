import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Business facts screen at 400px (ADR 0307): every control is reachable and at least 44px tall,
// the hours editor has no sideways scroll, problems are said beside the field, and a save changes only the
// `business` member of openblog.json (every other key stays where it was) and reaches the built site.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;
let before;

test.use({ viewport: { width: 400, height: 800 } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-business-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  const config = join(root, "openblog.json");
  // Not alphabetical, with the owner's own layout: a save must not rearrange it.
  const parsed = JSON.parse(readFileSync(config, "utf8"));
  const ordered = { url: parsed.url ?? "https://example.com", title: parsed.title ?? "Site", ...parsed, extraTrades: ["fencing"] };
  writeFileSync(config, `${JSON.stringify(ordered, null, 2)}\n`);
  before = readFileSync(config, "utf8");
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

async function openBusiness(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/#/business`);
  await expect(page.locator("[data-business-screen]")).toBeVisible();
  await expect(page.getByLabel("Name customers know you by")).toBeVisible();
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

const day = (page, name) => page.locator(`[data-business-day="${name}"]`);

test("the form and the hours editor fit 400px with 44px controls and every control labelled", async ({ page }) => {
  await openBusiness(page);
  for (const label of ["Name customers know you by", "Legal name", "Your trade", "Year you started", "Phone", "Email", "License number", "Who issued it", "We are insured"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  for (const name of ["Cash", "Check", "Credit card", "Debit card", "Bank transfer", "Mobile payment", "Financing"]) {
    await expect(page.getByLabel(name, { exact: true })).toBeVisible();
  }
  await expect(page.locator("[data-business-day]")).toHaveCount(7);
  // The site's own trade is offered beside the bundled ones.
  expect(await page.getByLabel("Your trade", { exact: true }).locator("option").allTextContents()).toEqual(expect.arrayContaining(["flooring", "fencing"]));

  // Open Monday so its times show, then measure everything on the screen.
  await day(page, "monday").getByLabel("Hours").selectOption("open");
  await expect(day(page, "monday").getByLabel("Opens")).toBeVisible();
  await expect(day(page, "monday").getByLabel("Closes")).toBeVisible();
  for (const control of await page.locator("[data-business-screen] input:not([type=checkbox]), [data-business-screen] select, [data-business-screen] button").all()) {
    if (!(await control.isVisible())) continue;
    expect((await control.boundingBox()).height, await control.evaluate((n) => n.id || n.textContent)).toBeGreaterThanOrEqual(43);
  }
  for (const box of await page.locator("[data-business-screen] input[type=checkbox]").all()) {
    const target = await box.evaluate((n) => n.closest("label").getBoundingClientRect().height);
    expect(target).toBeGreaterThanOrEqual(43);
  }
  await expectNoOverflow(page, "[data-business-screen]");
  // The save button can be reached by scrolling.
  await page.getByRole("button", { name: "Save business facts" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Save business facts" })).toBeVisible();
});

test("a bad phone and a backwards day are said beside their fields, in words, and nothing is saved", async ({ page }) => {
  await openBusiness(page);
  await page.getByLabel("Phone", { exact: true }).fill("call us");
  await page.getByLabel("Email", { exact: true }).fill("not an email");
  await day(page, "tuesday").getByLabel("Hours").selectOption("open");
  await day(page, "tuesday").getByLabel("Opens").fill("18:00");
  await day(page, "tuesday").getByLabel("Closes").fill("09:00");
  await page.getByRole("button", { name: "Save business facts" }).click();

  await expect(page.locator("[data-business-status]")).toContainText("3 things need fixing");
  await expect(page.locator('[data-problem-for="phone"]')).toContainText("country code");
  await expect(page.locator('[data-problem-for="email"]')).toContainText("office@example.com");
  await expect(page.locator('[data-problem-for="hours-tuesday"]')).toContainText("Tuesday: closing time must be after the opening time");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Phone", { exact: true })).toBeFocused();
  await expectNoOverflow(page, "[data-business-screen]");
  expect(readFileSync(join(root, "openblog.json"), "utf8")).toBe(before);

  // Correcting them clears the messages and saves.
  await page.getByLabel("Phone", { exact: true }).fill("(360) 555-0142");
  await page.getByLabel("Email", { exact: true }).fill("office@example.com");
  await day(page, "tuesday").getByLabel("Opens").fill("08:00");
  await day(page, "tuesday").getByLabel("Closes").fill("17:00");
  await page.getByRole("button", { name: "Save business facts" }).click();
  await expect(page.locator("[data-business-status]")).toContainText("Saved.");
  await expect(page.locator('[data-problem-for="phone"]')).toBeHidden();
});

test("the saved facts reach the site, the file keeps every other key in place, and they come back on reload", async ({ page }) => {
  await openBusiness(page);
  await page.getByLabel("Name customers know you by").fill("Maple Falls Flooring");
  await page.getByLabel("Your trade", { exact: true }).selectOption("flooring");
  await page.getByLabel("Phone", { exact: true }).fill("(360) 555-0142");
  await page.getByLabel("License number", { exact: true }).fill("MAPLEF*123");
  await page.getByLabel("We are insured").check();
  await page.getByLabel("Cash", { exact: true }).check();
  await day(page, "monday").getByLabel("Hours").selectOption("open");
  await day(page, "monday").getByLabel("Opens").fill("08:00");
  await day(page, "monday").getByLabel("Closes").fill("17:00");
  await page.getByRole("button", { name: "Copy Monday to Tuesday through Friday" }).click();
  await day(page, "sunday").getByLabel("Hours").selectOption("closed");
  await expect(day(page, "sunday").getByLabel("Opens")).toBeHidden();
  await page.getByRole("button", { name: "Save business facts" }).click();
  await expect(page.locator("[data-business-status]")).toContainText("Saved.");
  await expectNoOverflow(page, "[data-business-screen]");

  const text = readFileSync(join(root, "openblog.json"), "utf8");
  const stored = JSON.parse(text);
  expect(stored.business).toMatchObject({ phone: "+13605550142", trade: "flooring", insured: true, licenseNumber: "MAPLEF*123", paymentMethods: ["cash"] });
  expect(stored.business.hours.friday).toEqual({ open: "08:00", close: "17:00" });
  expect(stored.business.hours.sunday).toEqual({ closed: true });
  // Nothing else moved: the file up to the new member is the file as it was.
  const kept = before.trimEnd().replace(/\n}$/, "");
  expect(text.startsWith(kept)).toBe(true);
  expect(Object.keys(stored).at(-1)).toBe("business");

  // The built site shows the same facts in the footer and as structured data.
  const home = await (await fetch(`${origin}/`)).text();
  expect(home).toContain("(360) 555-0142");
  expect(home).toContain("Licensed and insured");
  expect(home).toContain('"telephone":"+13605550142"');
  expect(home).toContain('"@type":"HomeAndConstructionBusiness"');

  await page.reload();
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue("+13605550142");
  await expect(day(page, "friday").getByLabel("Hours")).toHaveValue("open");
  await expect(day(page, "sunday").getByLabel("Hours")).toHaveValue("closed");
  await expect(page.getByLabel("We are insured")).toBeChecked();
});

test("unsaved facts are noticed, and a stale save keeps the edits and offers to reload", async ({ page }) => {
  await openBusiness(page);
  await page.getByLabel("Legal name", { exact: true }).fill("Maple Falls Flooring LLC");
  await expect(page.locator("[data-business-dirty]")).toContainText("unsaved");
  // Another session changes the block meanwhile.
  const config = join(root, "openblog.json");
  const next = JSON.parse(readFileSync(config, "utf8"));
  next.business.displayName = "Changed elsewhere";
  writeFileSync(config, `${JSON.stringify(next, null, 2)}\n`);
  await page.getByRole("button", { name: "Save business facts" }).click();
  await expect(page.locator("[data-business-conflict]")).toBeVisible();
  await expect(page.getByLabel("Legal name", { exact: true })).toHaveValue("Maple Falls Flooring LLC");
  await page.getByRole("button", { name: "Reload the latest facts" }).click();
  await expect(page.getByLabel("Name customers know you by")).toHaveValue("Changed elsewhere");
  await expectNoOverflow(page, "[data-business-screen]");
});
