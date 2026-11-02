import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

// The Social screen in Admin (ADR 0310, #369), from the real binary and the real Admin Studio, with
// the real hosted routes (netlify/lib/social-announcements.mjs) behind a local HTTP server over an
// in-memory stand-in for Supabase. No real network and no real provider: nothing is ever posted.
// It proves the whole path: the browser talks only to Admin, Admin checks the post and builds the
// link, the hosted routes store the UTC instant, and the screen is usable by keyboard and on a phone.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const load = (path) => import(pathToFileURL(join(repository, path)).href);
const password = randomBytes(24).toString("hex");
const ADMIN_KEY = `adm_${randomBytes(24).toString("hex")}`;
const WORKER_KEY = `wrk_${randomBytes(24).toString("hex")}`;
const SERVICE_KEY = `sb_secret_${randomBytes(24).toString("hex")}`;
const ZONE = "America/New_York";

let root;
let hosted;
let storage;
let on;
let off;
let sawKey = [];

test.use({ timezoneId: ZONE, locale: "en-US" });

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

async function startAdmin(env) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe", env: { ...process.env, ...env } });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
  return { origin, child };
}

async function stop(server) {
  if (server?.child && server.child.exitCode === null) {
    const stopped = once(server.child, "exit");
    server.child.kill();
    await stopped;
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-social-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Lantern", url: "https://blog.example.org", author: { name: "Site Author" } }));
  writeFileSync(join(root, "content", "posts", "2026-01-02-hello.md"), "---\ntitle: Hello lanterns\ndate: 2026-01-02\n---\nA post.\n");
  writeFileSync(join(root, "content", "posts", "2026-01-03-secret.md"), "---\ntitle: Secret unfinished idea\ndate: 2026-01-03\ndraft: true\n---\nHidden.\n");
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });

  // The hosted routes, exactly as deployed, over a fake Supabase, on a loopback port.
  const { createAnnouncements } = await load("netlify/lib/social-announcements.mjs");
  const { socialSettings } = await load("netlify/lib/social-scope.mjs");
  const { fakeStorage } = await load("tests/web/social-fake-storage.mjs");
  storage = fakeStorage();
  const settings = socialSettings({
    OPENBLOG_SOCIAL_ENABLED: "true",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: SERVICE_KEY,
    OPENBLOG_SITE_ID: "lantern-studios",
    OPENBLOG_SOCIAL_ADMIN_KEY: ADMIN_KEY,
    OPENBLOG_SOCIAL_WORKER_KEY: WORKER_KEY,
    OPENBLOG_SOCIAL_TOKEN_KEYS: `k1:${Buffer.alloc(32, 9).toString("base64")}`,
  });
  const handle = createAnnouncements({ settings, fetchImpl: storage.fetchImpl });
  hosted = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, "http://127.0.0.1");
    sawKey.push(request.headers.authorization === `Bearer ${ADMIN_KEY}` && request.headers["x-openblog-actor"] === "writer");
    const route = url.pathname.replace(/^\/social\//, "");
    const result = route === "status" ? { status: 200, body: { enabled: true, providers: [], problems: [] } } : await handle({ method: request.method, route,query: url.searchParams, headers: request.headers, body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined });
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  hosted.listen(0, "127.0.0.1");
  await once(hosted, "listening");
  const hostedPort = hosted.address().port;

  on = await startAdmin({ OPENBLOG_SOCIAL_ENABLED: "true", OPENBLOG_SOCIAL_ENDPOINT: `http://127.0.0.1:${hostedPort}/social`, OPENBLOG_SOCIAL_ADMIN_KEY: ADMIN_KEY });
  const cleared = { OPENBLOG_SOCIAL_ENABLED: "", OPENBLOG_SOCIAL_ENDPOINT: "", OPENBLOG_SOCIAL_ADMIN_KEY: "" };
  off = await startAdmin(cleared);
});

test.afterAll(async () => {
  await stop(on);
  await stop(off);
  hosted?.close();
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
  }
});

test.beforeEach(({ page }) => {
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
  storage.posts.length = 0;
  sawKey = [];
});

async function signIn(page, origin) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
}

async function openSocial(page) {
  await signIn(page, on.origin);
  await page.getByRole("link", { name: "Announcements", exact: true }).click();
  await expect(page.locator("[data-social-screen]")).toBeVisible();
  await expect(page.getByLabel("Destination", { exact: true })).toBeEnabled();
}

// A local date and time `days` ahead at 09:30 in the browser's zone, as a datetime-local value.
function localValue(days) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(Date.now() + days * 86400000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T09:30`;
}
const inZone = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

async function compose(page, { caption = "Lanterns are lit: a new post is up.", days = 3 } = {}) {
  await page.getByLabel("Destination", { exact: true }).selectOption({ label: "Mikey Nichols (LinkedIn profile)" });
  await page.getByLabel("Post to announce", { exact: true }).selectOption({ label: "Hello lanterns" });
  await page.getByLabel("Caption", { exact: true }).fill(caption);
  await page.getByLabel(/^Date and time/).fill(localValue(days));
}

test("the Social tab exists only where social publishing is set up", async ({ page }) => {
  await signIn(page, off.origin);
  await expect(page.locator('[data-action="logout"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "Announcements", exact: true })).toHaveCount(0);
  await page.goto(`${off.origin}/admin/#/announcements`);
  await expect(page.locator("[data-social-load-error]")).toContainText("not configured");
  await expect(page.getByRole("link", { name: "Announcements", exact: true })).toHaveCount(1); // open on the route, so it is marked
});

test("an announcement is composed, previewed in the author's zone, scheduled, edited and canceled", async ({ page }) => {
  await openSocial(page);
  await expect(page.getByLabel("Post to announce", { exact: true })).toContainText("Hello lanterns");
  await expect(page.getByRole("option", { name: /Secret unfinished idea - Only a published post can be announced/ })).toBeDisabled();

  await compose(page);
  const preview = page.locator("[data-social-preview]");
  await expect(preview.locator("[data-preview-caption]")).toHaveText("Lanterns are lit: a new post is up.");
  await expect(preview.locator("[data-preview-link]")).toHaveText("https://blog.example.org/posts/hello/");
  await expect(preview.locator("[data-preview-when]")).toContainText("09:30");
  await expect(page.locator("[data-social-count]")).toHaveText("35 of 3000 characters");

  await page.getByRole("button", { name: "Schedule announcement" }).click();
  await expect(page.locator("[data-social-status]")).toContainText("Scheduled for");
  const row = page.locator("[data-announcement]").first();
  await expect(row.locator("[data-status-badge]")).toContainText("Scheduled");
  await expect(row.locator("[data-row-caption]")).toHaveText("Lanterns are lit: a new post is up.");
  expect(storage.posts).toHaveLength(1);
  expect(storage.posts[0].canonical_url).toBe("https://blog.example.org/posts/hello/");
  expect(storage.posts[0].scheduled_for).toMatch(/Z$/);
  expect(inZone(storage.posts[0].scheduled_for)).toBe("09:30");
  expect(storage.posts[0].created_by).toBe("writer");
  expect(sawKey.every(Boolean)).toBe(true);
  await expect(page.getByLabel("Caption", { exact: true })).toHaveValue("");

  // Edit the caption: the change names the version, and the row shows the new words.
  await row.getByRole("button", { name: /^Edit the announcement/ }).click();
  const editor = row.locator('[data-mode="edit"]');
  await editor.getByLabel("Caption").fill("Better words for the same post.");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("[data-social-status]")).toContainText("Saved");
  await expect(page.locator("[data-announcement]").first().locator("[data-row-caption]")).toHaveText("Better words for the same post.");
  expect(storage.posts[0].version).toBe(2);

  // Cancel asks first and keeps by default.
  const again = page.locator("[data-announcement]").first();
  await again.getByRole("button", { name: /^Cancel the announcement/ }).click();
  await expect(again.getByRole("button", { name: "Keep it" })).toBeFocused();
  await again.getByRole("button", { name: "Keep it" }).click();
  expect(storage.posts[0].status).toBe("scheduled");
  await again.getByRole("button", { name: /^Cancel the announcement/ }).click();
  await again.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page.locator("[data-social-status]")).toHaveText("Canceled. It will not be posted.");
  await expect(page.locator("[data-announcement]").first().locator("[data-status-badge]")).toContainText("Canceled");
  await expect(page.locator("[data-announcement]").first().getByRole("button", { name: /Edit the announcement/ })).toHaveCount(0);
  expect(storage.posts[0].status).toBe("canceled");
});

test("problems are explained beside the fields and nothing is sent until it is right", async ({ page }) => {
  await openSocial(page);
  await page.getByRole("button", { name: "Schedule announcement" }).click();
  const problems = page.locator("[data-social-problems]");
  await expect(problems).toBeFocused();
  await expect(problems).toContainText("There are 4 things to fix");
  await expect(page.locator('[data-error-for="caption"]')).toHaveText("Write a caption.");
  expect(storage.posts).toHaveLength(0);
  // Following a problem moves to its field.
  await problems.getByRole("link", { name: "Write a caption." }).click();
  await expect(page.getByLabel("Caption", { exact: true })).toBeFocused();

  // A time in the past is refused by the server's rules, shown beside the time field.
  await compose(page, { days: -2 });
  await page.getByRole("button", { name: "Schedule announcement" }).click();
  await expect(page.locator('[data-error-for="time"]')).toContainText("at least a minute from now");
  expect(storage.posts).toHaveLength(0);
});

test("a double submit of one announcement schedules it once", async ({ page }) => {
  await openSocial(page);
  await compose(page);
  const button = page.getByRole("button", { name: "Schedule announcement" });
  await button.dblclick();
  await expect(page.locator("[data-announcement]")).toHaveCount(1);
  expect(storage.posts).toHaveLength(1);
});

test("the keyboard reaches every control in order and operates the form", async ({ page }) => {
  await openSocial(page);
  await page.getByLabel("Destination", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Post to announce", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Caption", { exact: true })).toBeFocused();
  await page.keyboard.type("Typed with the keyboard");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/^Date and time/)).toBeFocused();
  await page.getByLabel(/^Date and time/).fill(localValue(4));
  await page.getByLabel("Destination", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Post to announce", { exact: true }).selectOption({ label: "Hello lanterns" });
  await page.getByLabel("Caption", { exact: true }).press("Control+Enter").catch(() => {});
  await page.getByRole("button", { name: "Schedule announcement" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-announcement]")).toHaveCount(1);
  expect(storage.posts[0].body).toBe("Typed with the keyboard");
});

test("on a phone the screen fits without sideways scrolling and buttons are easy to hit", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openSocial(page);
  await compose(page, { caption: `A long caption that keeps going so it has to wrap: ${"lantern ".repeat(60)}` });
  await page.getByRole("button", { name: "Schedule announcement" }).click();
  await expect(page.locator("[data-announcement]")).toHaveCount(1);
  const fit = await page.locator("[data-social-screen]").evaluate((screen) => ({
    screen: screen.scrollWidth <= screen.clientWidth + 1,
    rows: [...screen.querySelectorAll("[data-announcement]")].every((row) => row.scrollWidth <= row.clientWidth + 1),
    page: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  }));
  expect(fit).toEqual({ screen: true, rows: true, page: true });
  for (const name of [/^Edit the announcement/, /^Cancel the announcement/]) {
    const box = await page.locator("[data-announcement]").first().getByRole("button", { name }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test("a worker that claimed the announcement wins: the screen refreshes and says so", async ({ page }) => {
  await openSocial(page);
  await compose(page);
  await page.getByRole("button", { name: "Schedule announcement" }).click();
  await expect(page.locator("[data-announcement]")).toHaveCount(1);
  // The delivery worker claims it behind the author's back.
  Object.assign(storage.posts[0], { status: "claimed", version: 2, claimed_by: "@worker" });
  const row = page.locator("[data-announcement]").first();
  await row.getByRole("button", { name: /^Cancel the announcement/ }).click();
  await row.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page.locator("[data-social-status]")).toContainText("refreshed");
  await expect(page.locator("[data-announcement]").first().locator("[data-status-badge]")).toContainText("Sending");
  await expect(page.locator("[data-announcement]").first().locator("[data-row-locked]")).toContainText("no longer be changed");
  expect(storage.posts[0].status).toBe("claimed");
});

test("no key or token reaches the browser", async ({ page }) => {
  const seen = [];
  page.on("response", async (response) => {
    if (response.url().includes("/admin/api/social/")) seen.push(await response.text());
  });
  await openSocial(page);
  await compose(page);
  await page.getByRole("button", { name: "Schedule announcement" }).click();
  await expect(page.locator("[data-announcement]")).toHaveCount(1);
  const everything = seen.join("\n") + (await page.content());
  for (const secret of [ADMIN_KEY, WORKER_KEY, SERVICE_KEY, "claimed_by", "idempotency"]) expect(everything).not.toContain(secret);
});

test("a failed announcement says why, asks before trying again, and fits a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSocial(page);
  await compose(page);
  await page.getByRole("button", { name: "Schedule announcement" }).click();
  await expect(page.locator("[data-announcement]")).toHaveCount(1);
  // The worker used up the attempts behind the author's back (ADR 0318).
  Object.assign(storage.posts[0], { status: "failed", version: 5, attempt_count: 3, last_error_code: "attempts-exhausted" });
  await page.reload();
  await expect(page.locator("[data-social-screen]")).toBeVisible();
  const row = page.locator("[data-announcement]").first();
  await expect(row.locator("[data-status-badge]")).toContainText("Failed");
  await expect(row.locator("[data-row-error]")).toContainText("allowed number of times");
  const retry = row.getByRole("button", { name: /^Try again: the announcement of/ });
  await expect(retry).toHaveAttribute("aria-expanded", "false");
  expect((await retry.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(row.getByRole("button", { name: "Yes, try again" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Yes, try again" })).toBeFocused();
  const fit = await page.locator("[data-social-screen]").evaluate((screen) => ({
    screen: screen.scrollWidth <= screen.clientWidth + 1,
    rows: [...screen.querySelectorAll("[data-announcement]")].every((item) => item.scrollWidth <= item.clientWidth + 1),
    page: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  }));
  expect(fit).toEqual({ screen: true, rows: true, page: true });
  expect(storage.posts[0].status).toBe("failed");
  await row.getByRole("button", { name: "Yes, try again" }).click();
  await expect(page.locator("[data-social-status]")).toContainText("Back in the queue");
  await expect(page.locator("[data-announcement]").first().locator("[data-status-badge]")).toContainText("Scheduled");
  expect(storage.posts[0].status).toBe("scheduled");
  expect(storage.posts[0].attempt_floor).toBe(3);
});

test("checking an unknown result moves focus into a labelled choice", async ({ page }) => {
  await openSocial(page);
  await compose(page);
  await page.getByRole("button", { name: "Schedule announcement" }).click();
  await expect(page.locator("[data-announcement]")).toHaveCount(1);
  Object.assign(storage.posts[0], { status: "unknown", version: 5, attempt_count: 1, last_error_code: "unknown-outcome" });
  await page.reload();
  const row = page.locator("[data-announcement]").first();
  const check = row.getByRole("button", { name: /^Check the result of the announcement of/ });
  await check.focus();
  await page.keyboard.press("Enter");
  await expect(row.getByRole("radio", { name: "It was posted" })).toBeFocused();
  await expect(row.getByRole("group", { name: "What did you find?" })).toBeVisible();
});
