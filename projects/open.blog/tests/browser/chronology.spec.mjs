import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio, the real Knowledge Atlas API and the real chronology index (core
// validation, revision-checked store) over an atlas with competing, BCE, open, relative and
// unknown datings. Covers keyboard-only dating authoring, the textual chronology explorer and
// its filters, check prompts that land on the dating, keeping a draft after a conflict, reduced
// motion, high zoom, narrow screens and an empty timeline.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const HOSTILE = "<img src=x onerror=alert(1)> Πλάτων";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato-republic", kind: "work", title: "Πολιτεία" },
    { id: "nails-2002", kind: "work", title: "The People of Plato" },
  ],
};
const NOTEBOOK = { version: 1, passages: [], notes: [] };
const dating = (id, aspect, date, over = {}) => ({ id, aspect, date, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private", ...over });
const ATLAS = (dated = true) => ({
  version: 2,
  entries: [
    {
      id: "plato", kind: "person", label: HOSTILE, visibility: "private",
      dates: dated
        ? [
            dating("plato-born-a", "birth", { at: { year: -428, circa: true } }, { assertedBy: { kind: "source", source: "nails-2002" }, unsourced: undefined, evidence: [{ source: "nails-2002" }], confidence: "plausible" }),
            dating("plato-born-b", "birth", { at: { year: -427 } }),
            dating("plato-died", "death", { notAfter: { century: -6 } }),
          ]
        : [],
    },
    {
      id: "politeia", kind: "work", label: "Politeia", source: "plato-republic", visibility: "private",
      dates: dated
        ? [
            dating("politeia-composed", "composition", { notBefore: { year: -380, circa: true } }),
            dating("politeia-after", "composition", { relative: { order: "after", entry: "plato", aspect: "birth" } }),
          ]
        : [],
    },
    { id: "good", kind: "concept", label: "The Good", visibility: "private", dates: dated ? [dating("good-unknown", "emergence", { unknown: true })] : [] },
  ],
  relationships: [],
});
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const writeResearch = (atlas = ATLAS()) => {
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(atlas));
};
const storedAtlas = () => JSON.parse(readFileSync(research("atlas.json"), "utf8"));

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-chronology-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeResearch();
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

test.beforeEach(() => writeResearch());

async function openAdmin(page, hash) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/${hash}`);
}

const heading = (page) => page.locator("#oba-atlas-heading");
const status = (page) => page.locator("[data-chronology-status]");
const press = async (page, locator, key = "Enter") => {
  await locator.focus();
  await page.keyboard.press(key);
};

async function openChronology(page) {
  await openAdmin(page, "#/atlas");
  const button = page.getByRole("button", { name: "Chronology", exact: true });
  await expect(button).toBeVisible();
  await press(page, button);
  await expect(heading(page)).toHaveText("Chronology");
  await expect(heading(page)).toBeFocused();
}

/** How far anything in the atlas region (lists, explorer and editor) pokes past the viewport, or scrolls sideways. */
const overflow = (page) =>
  page.evaluate(() => {
    const region = document.querySelector("#oba-atlas-lists");
    const widest = Math.max(...[region, ...region.querySelectorAll("*")].map((element) => element.getBoundingClientRect().right));
    return Math.max(widest - window.innerWidth, region.scrollWidth - region.clientWidth);
  });
// The whole page, header included, never scrolls sideways.
const pageFits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("a BCE dating is authored on an entry from the keyboard alone and stored at its stated precision", async ({ page }) => {
  writeResearch(ATLAS(false));
  await openAdmin(page, "#/atlas/plato");
  await expect(heading(page)).toHaveText(HOSTILE);
  await press(page, page.getByRole("button", { name: "Add a dating", exact: true }));
  const aspect = page.getByLabel("What it dates");
  await expect(aspect).toBeFocused();
  await expect(aspect.locator("option")).toHaveText(["Span (a lifetime, a duration, or when it held)", "Birth", "Death", "Activity (floruit)"]);
  await aspect.selectOption("birth");
  await expect(page.locator("#oba-atlas-entry-dating-0-id")).toHaveValue("plato-birth");
  await expect(page.locator("#oba-atlas-entry-dating-0-form-range")).toBeDisabled();
  await press(page, page.locator("#oba-atlas-entry-dating-0-form-window"), "Space");
  await expect(page.locator("#oba-atlas-entry-dating-0-form-window")).toBeChecked();
  await page.locator("#oba-atlas-entry-dating-0-not-before-precision").selectOption("decade");
  await page.locator("#oba-atlas-entry-dating-0-not-before-value").focus();
  await page.keyboard.type("420");
  await page.keyboard.press("Tab");
  await expect(page.locator("#oba-atlas-entry-dating-0-not-before-era")).toBeFocused();
  await page.locator("#oba-atlas-entry-dating-0-not-before-era").selectOption("bce");
  await expect(page.locator("#oba-atlas-entry-dating-0-reads")).toHaveText("Reads: not before the 420s BCE");
  await press(page, page.locator("#oba-atlas-entry-dating-0-unsourced"), "Space");
  await expect(page.locator("#oba-atlas-entry-dating-0-unsourced")).toBeChecked();
  await page.locator("#oba-atlas-entry-dating-0-note").fill("Reckoned from his age at death.");
  await press(page, page.getByRole("button", { name: "Save changes", exact: true }));
  await expect(page.getByText("Entry saved to the private atlas.")).toBeVisible();
  const saved = storedAtlas().entries.find((entry) => entry.id === "plato").dates;
  expect(saved).toEqual([
    { id: "plato-birth", aspect: "birth", date: { notBefore: { decade: -420 } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, note: "Reckoned from his age at death.", visibility: "private" },
  ]);
  // The entry's own chronology reads it back as stated.
  await expect(page.locator("[data-atlas-chronology-of]")).toContainText("not before the 420s BCE");
});

test("a refused dating is scoped to its field and leaves the file unchanged", async ({ page }) => {
  writeResearch(ATLAS(false));
  await openAdmin(page, "#/atlas/politeia");
  await press(page, page.getByRole("button", { name: "Add a dating", exact: true }));
  await page.locator("#oba-atlas-entry-dating-0-aspect").selectOption("composition");
  await press(page, page.locator("#oba-atlas-entry-dating-0-form-relative"), "Space");
  await page.locator("#oba-atlas-entry-dating-0-relative-entry").selectOption("politeia");
  await page.locator("#oba-atlas-entry-dating-0-relative-aspect").selectOption("composition");
  await page.locator("#oba-atlas-entry-dating-0-unsourced").check();
  const before = readFileSync(research("atlas.json"), "utf8");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("#oba-atlas-entry-error")).toContainText("cannot be dated against the aspect it dates");
  await expect(page.locator("#oba-atlas-entry-dating-0-relative-aspect")).toBeFocused();
  await expect(page.locator("#oba-atlas-entry-dating-0-relative-aspect")).toHaveAttribute("aria-invalid", "true");
  expect(readFileSync(research("atlas.json"), "utf8")).toBe(before);
});

test("the chronology explorer lists competing datings side by side, filters from the keyboard, and links prompts to the dating", async ({ page }) => {
  await openChronology(page);
  await expect(status(page)).toHaveText("Showing 4 of 4 dated aspects (6 of 6 datings); grouped by the century each begins in.");
  await expect(page.getByRole("status").filter({ hasText: "Showing" })).toHaveCount(1);
  const timeline = page.locator("[data-chronology-timeline]");
  await expect(timeline.getByRole("heading", { level: 4 })).toHaveText(["No earliest point stated (open start) (1 dated aspect)", "5th century BCE (1 dated aspect)", "4th century BCE (1 dated aspect)"]);
  const births = page.locator('[data-chronology-row="entries:plato:birth"]');
  await expect(births).toContainText("2 competing datings, side by side. None is preferred");
  const competing = births.locator("[data-chronology-dating]");
  await expect(competing).toHaveCount(2);
  await expect(competing.nth(0)).toContainText("c. 428 BCE");
  await expect(competing.nth(0)).toContainText("Dated by the source The People of Plato");
  await expect(competing.nth(1)).toContainText("427 BCE");
  // Side by side on a wide screen: both datings start on the same line.
  // Both boxes come from one layout pass, so a reflow elsewhere on the page cannot fall between them.
  const [first, second] = await competing.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  expect(Math.abs(first.y - second.y)).toBeLessThan(2);
  expect(second.x).toBeGreaterThan(first.x);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator("[data-chronology-unplaced]")).toContainText("Unknown, as the party states");
  await expect(page.locator("[data-chronology-relative]")).toContainText("Composition of Politeia: after the birth of");
  await expect(timeline).not.toContainText(/consensus|agreed|established|most likely/i);

  // Filters and zoom are form controls, operated from the keyboard, with their state in words.
  await page.getByLabel("From year").focus();
  await page.keyboard.type("430");
  await page.getByLabel("To year").focus();
  await page.keyboard.type("428");
  await page.getByLabel("To era").selectOption("bce");
  await page.getByLabel("Group by (zoom)").selectOption("decade");
  await expect(status(page)).toHaveText("Showing 2 of 4 dated aspects (3 of 6 datings); from 430 BCE; to 428 BCE; grouped by the decade each begins in.");
  await expect(timeline.getByRole("heading", { level: 4 })).toHaveText(["the 420s BCE (1 dated aspect)"]);
  const outside = page.locator('[data-chronology-dating="plato-born-b"]');
  await expect(outside).toContainText("Outside the time window; listed because a competing dating falls inside it");
  await press(page, page.getByRole("button", { name: "Clear filters" }));
  await expect(page.getByLabel("Entry or relationship")).toBeFocused();
  await expect(status(page)).toContainText("Showing 4 of 4 dated aspects");

  const prompts = page.locator("[data-chronology-prompts]");
  await expect(prompts.getByRole("heading")).toHaveText("Datings to check (2)");
  await expect(prompts).toContainText("check the values against the cited evidence");
  await press(page, prompts.getByRole("button", { name: "Check dating plato-died of" }).first());
  await expect(heading(page)).toHaveText(HOSTILE);
  await expect(page.locator("#oba-atlas-entry-dating-2")).toBeFocused();
  expect(storedAtlas()).toEqual(JSON.parse(JSON.stringify(ATLAS())), "exploring never writes");
});

test("keeping a draft after a conflict keeps datings changed and added elsewhere", async ({ page }) => {
  await openAdmin(page, "#/atlas/plato");
  await expect(heading(page)).toHaveText(HOSTILE);
  await page.locator("#oba-atlas-entry-dating-1-note").fill("My doubt.");
  // Elsewhere: a field is added to a dating, and a new dating is recorded.
  const elsewhere = storedAtlas();
  const plato = elsewhere.entries.find((entry) => entry.id === "plato");
  plato.dates[0].shelf = "elsewhere";
  plato.dates.unshift(dating("plato-born-c", "birth", { at: { year: -429 } }));
  writeFileSync(research("atlas.json"), JSON.stringify(elsewhere));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("[data-atlas-conflict]")).toBeVisible();
  await press(page, page.getByRole("button", { name: "Keep my draft" }));
  await expect(page.getByText("1 dating added elsewhere was added to your draft.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Entry saved to the private atlas.")).toBeVisible();
  const saved = storedAtlas().entries.find((entry) => entry.id === "plato").dates;
  expect(saved.map((item) => item.id).sort()).toEqual(["plato-born-a", "plato-born-b", "plato-born-c", "plato-died"]);
  expect(saved.find((item) => item.id === "plato-born-a").shelf).toBe("elsewhere");
  expect(saved.find((item) => item.id === "plato-born-b").note).toBe("My doubt.");
});

test("the chronology works at high zoom and on a phone without sideways scrolling, and adds no motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // 400% zoom of a 1280px window leaves a 320 CSS pixel viewport.
  await page.setViewportSize({ width: 320, height: 720 });
  await openChronology(page);
  await expect(status(page)).toContainText("Showing 4 of 4");
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(await pageFits(page)).toBe(true);
  // Competing datings stack into one column rather than squeezing.
  const competing = page.locator('[data-chronology-row="entries:plato:birth"] [data-chronology-dating]');
  await expect(competing.nth(1)).toBeVisible();
  // Both boxes come from one layout pass, so a reflow elsewhere on the page cannot fall between them.
  const [first, second] = await competing.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  expect(second.y).toBeGreaterThan(first.y);
  const motion = await page.evaluate(() =>
    [...document.querySelectorAll("#oba-atlas-lists *")].filter((element) => {
      const style = getComputedStyle(element);
      return parseFloat(style.transitionDuration) > 0 || parseFloat(style.animationDuration) > 0;
    }).length,
  );
  expect(motion).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, "#/atlas/plato");
  await expect(heading(page)).toHaveText(HOSTILE);
  await page.getByRole("button", { name: "Add a dating", exact: true }).click();
  await page.locator("#oba-atlas-entry-dating-3-at-precision").selectOption("day");
  await expect(page.locator("#oba-atlas-entry-dating-3-at-month")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(await pageFits(page)).toBe(true);
});

test("an atlas without datings shows an empty timeline that says so", async ({ page }) => {
  writeResearch(ATLAS(false));
  await openChronology(page);
  await expect(status(page)).toHaveText("Showing 0 of 0 dated aspects (0 of 0 datings); grouped by the century each begins in.");
  await expect(page.locator("[data-chronology-empty]")).toHaveText(/^No datings yet\./);
  await expect(page.locator("[data-chronology-prompts]")).toContainText("Nothing to check");
});
