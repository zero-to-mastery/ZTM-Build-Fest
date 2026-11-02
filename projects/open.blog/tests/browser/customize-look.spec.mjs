import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// The Customize look screen in Admin (ADR 0256, #350), from the real binary and the real Admin
// Studio: choices only (no field takes text), a preview built from the unsaved look, per-control
// defaults, reset and undo, contrast notes, themes that honor fewer controls, conflict recovery,
// and a phone-sized layout.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

const configFile = () => join(root, "openblog.json");
const config = () => JSON.parse(readFileSync(configFile(), "utf8"));
const baseConfig = (extra = {}) => ({ title: "Looks", url: "https://looks.example.org", author: { name: "Site Author" }, ...extra });
const writeConfig = (value) => writeFileSync(configFile(), JSON.stringify(value));

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-customize-look-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  mkdirSync(join(root, "themes", "narrow"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\n---\nA post.\n");
  writeFileSync(join(root, "themes", "narrow", "theme.json"), JSON.stringify({ label: "Narrow", extends: "base", customizable: ["accent", "textSize"] }));
  writeConfig(baseConfig());
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
  writeConfig(baseConfig());
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
});

async function openLook(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${origin}/admin/#/look`);
  await expect(page.locator("[data-look-screen]")).toBeVisible();
}

const control = (page, id) => page.locator(`[data-control="${id}"].oba-look-control`);
const choose = (page, id, choice) => control(page, id).locator(`input[data-choice="${choice}"]`).check();
const saveButton = (page) => page.locator('[data-landing-bar] [data-action="save"]');
const status = (page) => page.locator("[data-look-status]");
const frame = (page) => page.frameLocator("[data-landing-frame]");

test("the screen offers looks and plain controls and no field that takes text", async ({ page }) => {
  await openLook(page);
  await expect(page.locator("main h2, main .oba-workspace-title").first()).toBeVisible();
  await expect(control(page, "palette").locator("input[type=radio]")).toHaveCount(8);
  for (const id of ["accent", "fontStyle", "textSize", "roundness", "spacing", "pageWidth", "headingWeight"]) {
    await expect(control(page, id)).toBeVisible();
    await expect(control(page, id).getByRole("button", { name: `back to theme default`, exact: false })).toBeDisabled();
  }
  await expect(control(page, "textSize").locator("input[type=radio]")).toHaveCount(4);
  // Nothing on the screen accepts typed text, markup or CSS.
  const typed = await page.locator("[data-look-screen] :is(textarea, select, input:not([type=radio]):not([type=color]), [contenteditable])").count();
  expect(typed).toBe(0);
  expect(await page.locator("[data-look-screen] input[type=color]").count()).toBe(1);
  await expect(control(page, "textSize").locator("[data-look-summary]")).toHaveText("Using the theme's own text size.");
});

test("choices change the preview, which is built from the unsaved look and writes nothing until Save", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLook(page);
  const before = readFileSync(configFile(), "utf8");
  await expect(page.locator("[data-preview-update]")).toContainText("unsaved choices");
  await choose(page, "textSize", "extra-large");
  await choose(page, "roundness", "round");
  await expect(control(page, "textSize").locator("[data-look-summary]")).toHaveText("Chosen: Extra large.");
  await expect(status(page)).toContainText("Not saved yet");
  await expect(page.locator("[data-look-dirty]")).toContainText("unsaved changes");
  await expect(async () => {
    const css = await frame(page).locator("style").first().textContent();
    expect(css).toContain("--ob-radius");
  }).toPass();
  expect(readFileSync(configFile(), "utf8")).toBe(before);
  await saveButton(page).click();
  await expect(status(page)).toContainText("Saved.");
  expect(config().appearance).toEqual({ version: 1, textSize: "extra-large", roundness: "round" });
  await expect(page.locator("[data-look-dirty]")).toContainText("All changes saved");
});

test("a look sets colors and font, a swatch or the picker sets the main color, and the preview shows light and dark", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLook(page);
  await choose(page, "palette", "warm");
  await expect(control(page, "fontStyle").locator("[data-look-summary]")).toContainText("Chosen:");
  await control(page, "accent").getByText("Teal", { exact: true }).click();
  await expect(control(page, "accent").locator("[data-look-summary]")).toHaveText("Chosen: Teal.");
  await page.locator("[data-look-picker]").fill("#aa2244");
  await expect(control(page, "accent").locator("[data-look-summary]")).toHaveText("Chosen: #aa2244.");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(frame(page).locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(frame(page).locator("html")).toHaveAttribute("data-theme", "light");
  await saveButton(page).click();
  await expect(status(page)).toContainText("Saved.");
  expect(config().appearance.palette).toBe("warm");
  expect(config().appearance.accent).toBe("#aa2244");
});

test("a color that is hard to read is adjusted and the screen says so in words", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLook(page);
  await page.locator("[data-look-picker]").fill("#fff7a8");
  const notes = page.locator("[data-look-adjustments]");
  await expect(notes).toBeVisible();
  await expect(notes).toContainText("easy to read");
});

test("Back to theme default, Reset everything and Undo", async ({ page }) => {
  await openLook(page);
  await choose(page, "spacing", "airy");
  await choose(page, "pageWidth", "wide");
  const spacingDefault = control(page, "spacing").getByRole("button", { name: "Spacing: back to theme default" });
  await expect(spacingDefault).toBeEnabled();
  await spacingDefault.click();
  await expect(control(page, "spacing").locator("[data-look-summary]")).toHaveText("Using the theme's own spacing.");
  await expect(spacingDefault).toBeDisabled();
  await expect(control(page, "pageWidth").locator("[data-look-summary]")).toHaveText("Chosen: Wide.");
  await page.getByRole("button", { name: "Reset everything" }).click();
  await expect(control(page, "pageWidth").locator("[data-look-summary]")).toHaveText("Using the theme's own page width.");
  await expect(page.getByRole("button", { name: "Reset everything" })).toBeDisabled();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(control(page, "pageWidth").locator("[data-look-summary]")).toHaveText("Chosen: Wide.");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(control(page, "spacing").locator("[data-look-summary]")).toHaveText("Chosen: Roomy.");
  // Reset, save, and the stored look goes back to the theme's own.
  await page.getByRole("button", { name: "Reset everything" }).click();
  await saveButton(page).click();
  await expect(status(page)).toContainText("Saved.");
  expect(config().appearance).toBeUndefined();
});

test("it works from the keyboard with names and state a screen reader can read", async ({ page }) => {
  await openLook(page);
  const group = control(page, "textSize");
  await expect(group.getByRole("group", { name: "Text size" }).or(page.getByRole("group", { name: "Text size" }))).toBeVisible();
  await group.locator("input[data-choice='small']").focus();
  await page.keyboard.press("Space");
  await expect(group.getByRole("radio", { name: /Small/ })).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(group.getByRole("radio", { name: /Medium/ })).toBeChecked();
  await expect(group.getByRole("radio", { name: /Medium/ })).toBeFocused();
  // Every control is reachable and has an accessible name.
  const unnamed = await page.locator("[data-look-screen] :is(input, button)").evaluateAll((nodes) =>
    nodes.filter((node) => !(node.labels?.length || node.getAttribute("aria-label") || node.textContent.trim())).length,
  );
  expect(unnamed).toBe(0);
  await expect(page.getByRole("button", { name: "Textsize" }).first()).toHaveCount(0);
});

test("a theme that honors fewer controls shows only those, and says why", async ({ page }) => {
  writeConfig(baseConfig({ theme: "narrow" }));
  await openLook(page);
  await expect(page.locator("[data-look-screen] .oba-look-control")).toHaveCount(2);
  await expect(control(page, "accent")).toBeVisible();
  await expect(control(page, "textSize")).toBeVisible();
  await expect(control(page, "palette")).toHaveCount(0);
  await expect(page.locator("[data-look-note]")).toContainText("The Narrow theme has its own design for");
});

test("a save that finds a newer look asks and never overwrites it", async ({ page }) => {
  writeConfig(baseConfig({ appearance: { version: 1, roundness: "soft" } }));
  await openLook(page);
  await choose(page, "textSize", "large");
  const newer = { ...baseConfig(), appearance: { version: 1, roundness: "square", spacing: "airy" } };
  writeConfig(newer);
  const onDisk = readFileSync(configFile(), "utf8");
  await saveButton(page).click();
  const box = page.locator("[data-look-conflict]");
  await expect(box).toBeVisible();
  await expect(box.getByRole("heading", { name: "Your look was changed somewhere else" })).toBeFocused();
  expect(readFileSync(configFile(), "utf8")).toBe(onDisk);
  await box.getByRole("button", { name: "Compare" }).click();
  const differences = box.locator("[data-look-differences]");
  await expect(differences).toContainText("Corners: yours is Soft; the newer look has Square.");
  await expect(differences).toContainText("Spacing: yours is the theme's own; the newer look has Roomy.");
  await box.getByRole("button", { name: "Keep mine" }).click();
  await expect(box).toBeHidden();
  expect(readFileSync(configFile(), "utf8")).toBe(onDisk);
  await saveButton(page).click();
  await expect(status(page)).toContainText("Saved.");
  expect(config().appearance).toEqual({ version: 1, roundness: "soft", textSize: "large" });
});

test("Use the newer look puts your changes away so they can be restored", async ({ page }) => {
  await openLook(page);
  await choose(page, "textSize", "large");
  writeConfig({ ...baseConfig(), appearance: { version: 1, spacing: "airy" } });
  await saveButton(page).click();
  const box = page.locator("[data-look-conflict]");
  await box.getByRole("button", { name: "Use the newer look" }).click();
  await expect(control(page, "spacing").locator("[data-look-summary]")).toHaveText("Chosen: Roomy.");
  await expect(control(page, "textSize").locator("[data-look-summary]")).toHaveText("Using the theme's own text size.");
  const offer = page.locator("[data-look-restore]");
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Restore your unsaved changes" }).click();
  await expect(control(page, "textSize").locator("[data-look-summary]")).toHaveText("Chosen: Large.");
});

test("unsaved choices are kept on the device and offered back after a reload", async ({ page }) => {
  // Leaving with unsaved choices asks first (the leave guard); this test leaves on purpose.
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.accept());
  await openLook(page);
  await choose(page, "headingWeight", "bold");
  await expect(async () => {
    expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("ob-look-draft:")))).toBe(true);
  }).toPass();
  await page.reload();
  const offer = page.locator("[data-look-restore]");
  await expect(offer).toBeVisible();
  await expect(control(page, "headingWeight").locator("[data-look-summary]")).toHaveText("Using the theme's own heading weight.");
  await offer.getByRole("button", { name: "Restore your unsaved changes" }).click();
  await expect(control(page, "headingWeight").locator("[data-look-summary]")).toHaveText("Chosen: Bold.");
  expect(existsSync(configFile())).toBe(true);
  expect(config().appearance).toBeUndefined();
});

test("a choice made while a save is running stays unsaved", async ({ page }) => {
  await openLook(page);
  await page.route("**/admin/api/look", async (route) => {
    if (route.request().method() === "PUT") await new Promise((done) => setTimeout(done, 600));
    await route.continue();
  });
  await choose(page, "textSize", "large");
  await saveButton(page).click();
  await choose(page, "roundness", "round");
  await expect(status(page)).toContainText("still unsaved");
  expect(config().appearance).toEqual({ version: 1, textSize: "large" });
  await expect(control(page, "roundness").locator("[data-look-summary]")).toHaveText("Chosen: Round.");
  await expect(page.locator("[data-look-dirty]")).toContainText("unsaved changes");
});

test("Make it live stops when the site could not be rebuilt", async ({ page }) => {
  await openLook(page);
  await page.route("**/admin/api/look", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, buildError: "the build is broken" } });
  });
  let published = false;
  await page.route("**/admin/api/publish", async (route) => {
    if (route.request().method() === "POST") published = true;
    await route.continue();
  });
  await choose(page, "textSize", "large");
  await page.locator('[data-landing-bar] [data-action="publish"]').evaluate((node) => { node.disabled = false; });
  await page.locator('[data-landing-bar] [data-action="publish"]').click();
  await expect(status(page)).toContainText("could not be rebuilt");
  expect(published).toBe(false);
});

test("on a phone the screen is one column with big targets, a sticky bar and no sideways scroll", async ({ page }) => {
  // Leaving with unsaved choices asks first (the leave guard); this test leaves on purpose.
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.accept());
  for (const width of [320, 400]) {
    await page.setViewportSize({ width, height: 640 });
    await openLook(page);
    const metrics = await page.evaluate(() => {
      const region = document.querySelector("[data-look-screen]");
      const options = [...region.querySelectorAll(".oba-look-option")];
      const small = options.filter((node) => node.getBoundingClientRect().height < 44).length;
      const buttons = [...document.querySelectorAll("[data-look-screen] button, [data-landing-bar] button")].filter((node) => node.getBoundingClientRect().height < 44).length;
      return { overflow: region.scrollWidth - region.clientWidth, page: document.documentElement.scrollWidth - innerWidth, small, buttons };
    });
    expect(metrics.overflow, `region at ${width}`).toBeLessThanOrEqual(0);
    expect(metrics.small).toBe(0);
    expect(metrics.buttons).toBe(0);
    const bar = page.locator("[data-landing-bar]");
    await expect(bar).toBeInViewport();
    await choose(page, "textSize", "large");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const sheet = page.locator("[data-look-sheet]");
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(page.locator("[data-preview-update]")).toContainText("unsaved choices");
    await page.getByRole("button", { name: "Back to choosing" }).click();
    await expect(sheet).toBeHidden();
  }
});

test("it is reachable from Appearance and the tabs", async ({ page }) => {
  await openLook(page);
  await page.goto(`${origin}/admin/#/appearance`);
  await page.locator('[data-action="customize-look"]').click();
  await expect(page.locator("[data-look-screen]")).toBeVisible();
  await expect(page.getByRole("link", { name: "Customize look" }).first()).toHaveAttribute("aria-current", "page");
});
