import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// Starter layouts in the Landing page builder (ADR 0258, #338): choose, undo, reset and start from scratch,
// from the real binary and Admin Studio. Nothing existing is replaced without a yes.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

const landingFile = () => join(root, "content", "landing.json");
const stored = () => JSON.parse(readFileSync(landingFile(), "utf8"));
const seed = (sections) => writeFileSync(landingFile(), JSON.stringify({ format: "openblog-landing", version: 1, sections }));
const THREE = () => [
  { id: "hello", type: "welcome", heading: "Hello there", subheading: "A friendly place." },
  { id: "text", type: "rich-text", markdown: "About this blog." },
  { id: "latest", type: "latest-posts", heading: "Newest" },
];

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-landing-builder-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\n---\nA post.\n");
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Builder", url: "https://builder.example.org", author: { name: "Site Author" }, home: { heading: "Fresh writing", intro: "Welcome to my blog." } }));
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
  rmSync(landingFile(), { force: true });
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
});

async function openLanding(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/#/landing`);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
}

const order = (page) => page.locator("[data-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.section));
const startersPanel = (page) => page.locator("[data-landing-starters]");

test("a first visit offers the starting points and keeping the home page as it is changes nothing", async ({ page }) => {
  await openLanding(page);
  await expect(startersPanel(page).getByRole("heading", { name: "Start from a ready-made layout" })).toBeVisible();
  for (const name of ["Welcome", "Small business", "Portfolio", "Newsletter", "Start from scratch"]) {
    await expect(startersPanel(page).getByRole("button", { name })).toBeVisible();
  }
  await startersPanel(page).getByRole("button", { name: "Keep what my home page shows now" }).click();
  await expect(startersPanel(page)).toBeHidden();
  expect(await order(page)).toEqual(["intro", "latest", "series"]);
  expect(existsSync(landingFile())).toBe(false);
});

test("choosing a layout fills the page with sample sections, can be undone and saves like any edit", async ({ page }) => {
  await openLanding(page);
  await startersPanel(page).getByRole("button", { name: "Small business" }).click();
  await expect(page.locator("[data-landing-toast]")).toContainText("Your page now uses the Small business layout.");
  expect(await order(page)).toEqual(["sample-note", "welcome", "hours", "contact", "map"]);
  expect(existsSync(landingFile())).toBe(false);
  await expect(page.locator("[data-landing-dirty]")).toContainText("unsaved changes");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await order(page)).toEqual(["intro", "latest", "series"]);

  await page.getByRole("button", { name: "Choose a ready-made layout" }).click();
  await startersPanel(page).getByRole("button", { name: "Portfolio" }).click();
  // The site has one published post? It is a draft here, so the layout shows the latest posts instead.
  expect((await order(page)).slice(0, 2)).toEqual(["sample-note", "welcome"]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved");
  expect(stored().sections.map((section) => section.id)[0]).toBe("sample-note");
});

test("a stored page is never replaced without a yes, and Reset to default is always there", async ({ page }) => {
  writeFileSync(landingFile(), JSON.stringify({ format: "openblog-landing", version: 1, sections: [{ id: "mine", type: "rich-text", markdown: "My own words." }] }));
  await openLanding(page);
  await expect(startersPanel(page)).toBeHidden();
  await page.getByRole("button", { name: "Choose a ready-made layout" }).click();
  await startersPanel(page).getByRole("button", { name: "Newsletter" }).click();
  const confirm = page.locator("[data-landing-confirm]");
  await expect(confirm).toContainText("Replace your section with the Newsletter layout?");
  expect(await order(page)).toEqual(["mine"]);

  await confirm.getByRole("button", { name: "Keep what I have" }).click();
  expect(await order(page)).toEqual(["mine"]);

  await page.getByRole("button", { name: "Choose a ready-made layout" }).click();
  await startersPanel(page).getByRole("button", { name: "Newsletter" }).click();
  await confirm.getByRole("button", { name: "Replace my sections" }).click();
  expect(await order(page)).toEqual(["sample-note", "welcome", "about", "latest"]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await order(page)).toEqual(["mine"]);

  await page.getByRole("button", { name: "Reset to default" }).click();
  await page.locator("[data-landing-confirm]").getByRole("button", { name: "Replace my sections" }).click();
  expect(await order(page)).toEqual(["intro", "latest", "series"]);
  expect(stored().sections[0].id).toBe("mine");
});

test("Start from scratch gives an empty page and opens the section list", async ({ page }) => {
  await openLanding(page);
  await startersPanel(page).getByRole("button", { name: "Start from scratch" }).click();
  expect(await order(page)).toEqual([]);
  await expect(page.locator("#oba-landing-picker")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await order(page)).toEqual(["intro", "latest", "series"]);
});

test("the layout choices work by keyboard and fit a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openLanding(page);
  const panel = startersPanel(page);
  await expect(panel).toBeVisible();
  const overflow = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await panel.getByRole("button", { name: "Welcome" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Choose a ready-made layout" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-landing-toast]")).toContainText("Your page now uses the Welcome layout.");
});

// ---------------------------------------------------------------- the short tour and plain-language help (ADR 0259, #339)

const tour = (page) => page.locator("[data-landing-tour]");

async function pageWithStoredLanding(page) {
  writeFileSync(landingFile(), JSON.stringify({ format: "openblog-landing", version: 1, sections: [{ id: "mine", type: "rich-text", markdown: "My own words." }] }));
  await openLanding(page);
}

test("the tour has three steps, works by keyboard, can be skipped and never comes back", async ({ page }) => {
  await pageWithStoredLanding(page);
  await expect(tour(page)).toBeVisible();
  await expect(tour(page).getByRole("heading", { level: 3 })).toHaveText("Step 1 of 3: Your page is a list of sections");
  await tour(page).getByRole("button", { name: "Next" }).focus();
  await page.keyboard.press("Enter");
  const heading = tour(page).getByRole("heading", { level: 3 });
  await expect(heading).toHaveText("Step 2 of 3: Change a section");
  await expect(heading).toBeFocused();
  await expect(heading).toHaveAccessibleDescription(/Choose Edit on a card/);
  await tour(page).getByRole("button", { name: "Back" }).click();
  await expect(heading).toContainText("Step 1 of 3");
  await tour(page).getByRole("button", { name: "Next" }).click();
  await tour(page).getByRole("button", { name: "Next" }).click();
  await expect(heading).toContainText("Step 3 of 3");
  await expect(tour(page).getByRole("button", { name: "Finish the tour" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tour(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Add a section" })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  await expect(tour(page)).toBeHidden();
  await page.goto(`${origin}/admin/#/overview`);
  await page.goto(`${origin}/admin/#/landing`);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  await expect(tour(page)).toBeHidden();
});

test("Skip the tour closes it for good, and a first visit waits until the layouts are chosen or put away", async ({ page }) => {
  await openLanding(page);
  await expect(startersPanel(page)).toBeVisible();
  await expect(tour(page)).toBeHidden();
  await startersPanel(page).getByRole("button", { name: "Keep what my home page shows now" }).click();
  await expect(tour(page)).toBeVisible();
  await tour(page).getByRole("button", { name: "Skip the tour" }).click();
  await expect(tour(page)).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  await expect(tour(page)).toBeHidden();
});

test("the tour does not animate under reduced motion and stays inside a phone screen", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 640 });
  await pageWithStoredLanding(page);
  await expect(tour(page)).toBeVisible();
  const facts = await tour(page).evaluate((node) => ({ over: node.scrollWidth - node.clientWidth, animation: getComputedStyle(node).animationName, transition: getComputedStyle(node).transitionDuration }));
  expect(facts.over).toBeLessThanOrEqual(1);
  expect(facts.animation).toBe("none");
  expect(parseFloat(facts.transition)).toBe(0);
});

test("an empty page says what to do, and Help explains the words in plain language", async ({ page }) => {
  await pageWithStoredLanding(page);
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("[data-landing-empty]")).toBeVisible();
  await expect(page.locator("[data-landing-empty]")).toContainText("Choose a ready-made layout to start from, or choose Add a section");
  const help = page.locator("[data-landing-help]");
  await help.locator("summary").click();
  await expect(help.getByText("Publish (make it live)", { exact: true })).toBeVisible();
  await expect(help.getByText("Web address", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveAttribute("title", /make your saved page live/);
});

// ---------------------------------------------------------------- a layout Undo never outlives the work it would overwrite

test("a layout Undo is gone once the newer page or the restored draft replaces the sections, and layouts wait for the restore offer", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  await page.getByRole("button", { name: "Choose a ready-made layout" }).click();
  await startersPanel(page).getByRole("button", { name: "Portfolio" }).click();
  await page.locator("[data-landing-confirm]").getByRole("button", { name: "Replace my sections" }).click();
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  const portfolio = await order(page);
  // Someone saves a different page elsewhere, so the next Save finds a conflict.
  seed([{ id: "elsewhere", type: "rich-text", markdown: "Written on another device." }]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const box = page.locator("[data-landing-conflict]");
  await expect(box).toBeVisible();
  await box.getByRole("button", { name: "Use the newer version" }).click();
  expect(await order(page)).toEqual(["elsewhere"]);
  await expect(undo).toHaveCount(0);
  await expect(page.locator("[data-landing-toast]")).toBeHidden();
  // While the restore offer waits, the layout choices are off.
  const offer = page.locator("[data-landing-restore]");
  await expect(offer).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a ready-made layout" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reset to default" })).toBeDisabled();
  await offer.getByRole("button", { name: "Restore your unsaved changes" }).click();
  expect(await order(page)).toEqual(portfolio);
  await expect(undo).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a ready-made layout" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reset to default" })).toBeEnabled();
});
