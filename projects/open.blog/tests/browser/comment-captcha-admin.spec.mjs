import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// Admin -> Analytics comment captcha settings (#307): hidden under advanced until engagement is
// on, a provider/site key/scope form with read-only environment-variable guidance, no secret
// field, and a save that survives a reload. The real Admin and its real settings route.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-captcha-admin-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Captcha admin", url: "https://captcha-admin.example.org", postPath: "/{slug}/", author: { name: "A" } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-20\n---\nText.\n");
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

async function openAnalytics(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/#/analytics`);
  await expect(page.getByRole("heading", { name: "Hosted comments and analytics" })).toBeVisible();
}

test("enable, save and reload the comment captcha without any secret field", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 });
  await openAnalytics(page);
  const panel = page.locator('[data-captcha="panel"]');
  await expect(panel).toBeHidden();
  await page.getByLabel("Enable hosted engagement").check();
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  await expect(panel).toContainText("OPENBLOG_TURNSTILE_SECRET");
  await expect(panel).toContainText("OPENBLOG_CAPTCHA_SESSION_SECRET");
  await expect(panel).toContainText("OPENBLOG_CAPTCHA_SCOPE=every-comment");
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);

  await page.locator('input[type="url"]').fill("https://captcha-admin.example.org/api");
  await page.getByLabel("Provider").selectOption("turnstile");
  const save = page.getByRole("button", { name: "Save hosted settings" });
  await page.getByLabel("Turnstile public site key").fill("");
  await save.click();
  await expect(page.locator('[role="status"]').filter({ hasText: "siteKey is required" })).toBeVisible();
  expect(JSON.parse(readFileSync(join(root, "openblog.json"), "utf8")).engagement?.captcha).toBeUndefined();

  await page.getByLabel("Turnstile public site key").fill("0x4AAAAAAA-public_key");
  await page.getByLabel("How often to verify").selectOption("every-comment");
  await save.click();
  await expect(page.locator('[role="status"]').filter({ hasText: "Rebuild or publish" })).toBeVisible();
  const saved = JSON.parse(readFileSync(join(root, "openblog.json"), "utf8"));
  expect(saved.engagement.captcha).toEqual({ provider: "turnstile", siteKey: "0x4AAAAAAA-public_key", scope: "every-comment" });
  expect(JSON.stringify(saved)).not.toMatch(/secret/i);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Hosted comments and analytics" })).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(page.getByLabel("Provider")).toHaveValue("turnstile");
  await expect(page.getByLabel("Turnstile public site key")).toHaveValue("0x4AAAAAAA-public_key");
  await expect(page.getByLabel("How often to verify")).toHaveValue("every-comment");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);

  await page.getByLabel("Provider").selectOption("off");
  await page.getByLabel("Turnstile public site key").fill("");
  await page.getByLabel("How often to verify").selectOption("session");
  await save.click();
  await expect(page.locator('[role="status"]').filter({ hasText: "Rebuild or publish" })).toBeVisible();
  expect(JSON.parse(readFileSync(join(root, "openblog.json"), "utf8")).engagement.captcha).toBeUndefined();
});
