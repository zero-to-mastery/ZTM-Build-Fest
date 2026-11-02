import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// The epic's ease bar (#314, #341), end to end from the real binary: on a 375px phone change the headline,
// add a button, pick an accent and a font style, preview and publish with no code in sight, then read the
// built home page with and without JavaScript. Also keyboard only, 400% text, reduced motion and a scan
// that no Admin screen for this feature takes HTML or CSS. Overflow is measured on the region under test
// with a tolerance, because Linux CI fonts are wider than Windows ones.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

const landingFile = () => join(root, "content", "landing.json");
const configFile = () => join(root, "openblog.json");
const stored = () => JSON.parse(readFileSync(landingFile(), "utf8"));
const config = () => JSON.parse(readFileSync(configFile(), "utf8"));
const baseConfig = () => ({ title: "Journey", url: "https://journey.example.org", author: { name: "Site Author" } });
const seed = () => writeFileSync(landingFile(), JSON.stringify({ format: "openblog-landing", version: 1, sections: [
  { id: "hello", type: "welcome", heading: "Hello there", subheading: "A friendly place." },
  { id: "latest", type: "latest-posts", heading: "Newest" },
] }));

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-landing-journey-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\n---\nA post.\n");
  writeFileSync(configFile(), JSON.stringify(baseConfig()));
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
    expect((await fetch(`${origin}/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
  }
});

test.beforeEach(({ page }) => {
  writeFileSync(configFile(), JSON.stringify(baseConfig()));
  seed();
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
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
  await page.evaluate(() => localStorage.clear());
}

async function openLanding(page) {
  await signIn(page);
  await page.goto(`${origin}/admin/#/landing`);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
}

async function openLook(page) {
  await page.goto(`${origin}/admin/#/look`);
  await expect(page.locator("[data-look-screen]")).toBeVisible();
}

const card = (page, id) => page.locator(`[data-section="${id}"]`);
const bar = (page) => page.locator("[data-landing-bar]");
const control = (page, id) => page.locator(`[data-control="${id}"].oba-look-control`);

/** Markup or style rules that an owner should never be shown on these screens. */
async function visibleCode(page, selector) {
  return page.locator(selector).first().evaluate((node) => {
    const words = node.innerText;
    return {
      tag: /<\/?[a-z][a-z0-9-]*[\s>/]/i.test(words),
      rule: /[a-z-]+\s*:\s*[^;\s]+\s*;|\{[^}]*:[^}]*\}/i.test(words),
    };
  });
}

test("on a 375px phone: change the headline, add a button, pick an accent and a font, preview and publish, no code visible", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 375, height: 667 });
  const calls = [];
  await page.route("**/admin/api/publish", async (route) => {
    const request = route.request();
    calls.push(request.method());
    if (request.method() === "GET") await route.fulfill({ json: { repo: true, remote: "origin", changed: [], drafts: [], ahead: 0, behind: 0, auto: false } });
    else await route.fulfill({ json: { ok: true, message: "Published 2 changes.", commit: "abc1234", pushed: true, committed: true, drafts: [] } });
  });
  await openLanding(page);

  // The headline and a button.
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  await card(page, "hello").getByLabel("Welcome heading").fill("Fresh from my phone");
  await card(page, "hello").getByRole("button", { name: "Add a button" }).click();
  await expect(card(page, "hello").getByLabel("What the button says")).toHaveValue("Read the blog");
  expect(await visibleCode(page, "main")).toEqual({ tag: false, rule: false });
  await card(page, "hello").getByRole("button", { name: "Done" }).click();

  // Preview on the phone, then back, then save.
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const sheet = page.locator("[data-landing-sheet]");
  await expect(sheet).toBeVisible();
  const frame = page.frameLocator("[data-landing-frame]");
  await expect(frame.getByRole("heading", { name: "Fresh from my phone" })).toBeVisible();
  await expect(frame.getByRole("link", { name: "Read the blog" })).toBeVisible();
  await sheet.getByRole("button", { name: "Back to editing" }).click();
  await expect(sheet).toBeHidden();
  await bar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections[0].heading).toBe("Fresh from my phone");
  expect(stored().sections[0].button).toMatchObject({ label: "Read the blog" });

  // Customize look: an accent swatch and a font style, picked by name.
  await openLook(page);
  await control(page, "accent").getByText("Teal", { exact: true }).click();
  await control(page, "fontStyle").getByText("Classic", { exact: true }).click();
  expect(await visibleCode(page, "[data-look-screen]")).toEqual({ tag: false, rule: false });
  const overflow = await page.locator("[data-look-screen]").evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator("[data-look-sheet]")).toBeVisible();
  await page.getByRole("button", { name: "Back to choosing" }).click();
  await bar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-look-status]")).toContainText("Saved.");
  expect(config().appearance).toMatchObject({ version: 1, fontStyle: "classic-serif" });
  expect(config().appearance.accent).toMatch(/^#[0-9a-f]{6}$/);

  // Publish from the same bar.
  const publish = bar(page).locator('[data-action="publish"]');
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.locator("[data-look-status]")).toContainText("Published");
  expect(calls).toContain("POST");

  // The built home page shows the change.
  const home = await (await fetch(`${origin}/`)).text();
  expect(home).toContain("Fresh from my phone");
  expect(home).toContain("Read the blog");
});

test("the built home page reads the same with JavaScript off", async ({ page, browser }) => {
  await openLanding(page);
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  await card(page, "hello").getByLabel("Welcome heading").fill("Readable without scripts");
  await bar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 667 } });
  const plain = await context.newPage();
  await plain.goto(`${origin}/`);
  await expect(plain.getByRole("heading", { name: "Readable without scripts" })).toBeVisible();
  await expect(plain.getByText("A friendly place.")).toBeVisible();
  expect(await plain.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
  await context.close();
});

test("the landing page and Customize look can be used from the keyboard alone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLanding(page);
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).focus();
  await page.keyboard.press("Enter");
  await expect(card(page, "hello").getByLabel("Welcome heading")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Typed without a mouse");
  await card(page, "hello").getByRole("button", { name: "Done" }).focus();
  await page.keyboard.press("Space");
  const save = bar(page).getByRole("button", { name: "Save", exact: true });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections[0].heading).toBe("Typed without a mouse");

  await openLook(page);
  const radios = control(page, "fontStyle").locator("input[type=radio]");
  await radios.first().focus();
  await page.keyboard.press("ArrowRight");
  const picked = await control(page, "fontStyle").locator("input[type=radio]:checked").getAttribute("data-choice");
  expect(picked).toBeTruthy();
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-look-status]")).toContainText("Saved.");
  expect(config().appearance.fontStyle).toBe(picked);
});

// The landing builder's own 200% and 400% passes are in landing-builder.spec.mjs; this covers Customize look.
test("Customize look with text at 200% on 320px and on a 1280px page at 400% zoom does not scroll sideways", async ({ browser }) => {
  for (const [viewport, percent] of [[{ width: 320, height: 568 }, 200], [{ width: 320, height: 256 }, 100]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await signIn(page);
    await openLook(page);
    await page.evaluate((value) => { document.documentElement.style.fontSize = `${value}%`; }, percent);
    const overflow = await page.locator("[data-look-screen]").evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow, `${viewport.width}x${viewport.height} at ${percent}%`).toBeLessThanOrEqual(2);
    await bar(page).getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
    await expect(bar(page).getByRole("button", { name: "Save", exact: true })).toBeInViewport();
    await context.close();
  }
});

test("reduced motion turns transitions off on the landing page and Customize look", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLanding(page);
  const moving = () => page.evaluate(() => [...document.querySelectorAll("main button, main label, [data-landing-bar]")]
    .filter((node) => {
      const style = getComputedStyle(node);
      return parseFloat(style.transitionDuration) > 0.01 || (style.animationName !== "none" && parseFloat(style.animationDuration) > 0.01);
    }).length);
  expect(await moving()).toBe(0);
  await openLook(page);
  expect(await moving()).toBe(0);
});

test("no Admin screen for the landing page, its section picker or Customize look takes HTML or CSS", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await openLook(page);
  expect(await page.locator("[data-look-screen] :is(textarea, select, [contenteditable], input:not([type=radio]):not([type=color]))").count()).toBe(0);
  await page.goto(`${origin}/admin/#/landing`);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  const forbidden = /(html|css|style|script|markup)/;
  await page.locator('[data-action="add-section"]').click();
  await expect(page.locator("#oba-landing-picker")).toBeVisible();
  const types = await page.locator("#oba-landing-picker [data-add-type]").evaluateAll((nodes) => nodes.map((node) => node.dataset.addType));
  expect(types.length).toBeGreaterThan(10);
  for (const [index, type] of types.entries()) {
    if (index > 0) {
      // The page can still be settling after the last add, so open the picker until it stays open.
      await expect(async () => {
        if (!(await page.locator("#oba-landing-picker").isVisible())) await page.locator('[data-action="add-section"]').click();
        await expect(page.locator("#oba-landing-picker")).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 10000 });
    }
    await page.locator(`#oba-landing-picker [data-add-type="${type}"]`).click();
    await expect(page.locator("#oba-landing-picker")).toBeHidden();
    const added = page.locator("[data-section]").last();
    const fields = await added.locator("input, textarea, select, [contenteditable]").evaluateAll((nodes) => nodes.map((node) => `${node.id} ${node.name} ${node.getAttribute("aria-label") || ""}`.toLowerCase()));
    for (const field of fields) expect(field, type).not.toMatch(forbidden);
  }
});
