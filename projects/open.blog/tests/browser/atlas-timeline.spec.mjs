import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The published Knowledge Atlas chronology (ADR 0099, ADR 0100), built and served by the real
// binary from a private atlas with competing, BCE, open, relative and unknown datings, a dated
// relationship, a hostile label, and private datings that must not appear. Covers the complete
// timeline without JavaScript, the <ob-atlas-timeline> filters from the keyboard under a strict
// content security policy, print, reduced motion, a 320px screen, and relative datings followed
// as trails both ways.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const HOSTILE = `<img src=x onerror="window.__atlasXss=1"> Πλάτων`;
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "nails-2002", kind: "work", title: "The People of Plato" },
    { id: "diogenes", kind: "work", title: "Lives of the Eminent Philosophers" },
    { id: "kahn-1996", kind: "work", title: "Plato and the Socratic Dialogue" },
  ],
};
const NOTEBOOK = { version: 1, passages: [], notes: [] };
const dating = (id, aspect, date, source, over = {}) => ({
  id, aspect, date, assertedBy: { kind: "source", source }, confidence: "plausible",
  evidence: [{ source, locators: [{ kind: "chapter", value: "3" }] }], visibility: "approved", ...over,
});
const ATLAS = {
  version: 2,
  entries: [
    {
      id: "plato", kind: "person", label: HOSTILE, visibility: "approved", dates: [
        dating("plato-birth-diogenes", "birth", { notBefore: { year: -428 }, notAfter: { year: -427 } }, "diogenes"),
        dating("plato-birth-nails", "birth", { at: { year: -424, circa: true } }, "nails-2002", { note: "Counts the archons differently." }),
        dating("plato-death", "death", { at: { year: -348, circa: true } }, "diogenes"),
        dating("plato-private-marker", "death", { at: { year: -347 } }, "diogenes", { visibility: "private", note: "PRIVATE-MARKER" }),
      ],
    },
    { id: "phaedo", kind: "work", label: "Phaedo", visibility: "approved", dates: [dating("phaedo-composition", "composition", { notAfter: { year: -360 } }, "kahn-1996")] },
    {
      id: "republic", kind: "work", label: "Republic", visibility: "approved", dates: [
        dating("republic-after-phaedo", "composition", { relative: { order: "after", entry: "phaedo", aspect: "composition" } }, "kahn-1996"),
        dating("republic-publication", "publication", { unknown: true }, "kahn-1996"),
      ],
    },
    { id: "academy", kind: "movement", label: "The Academy", visibility: "approved" },
    { id: "augustus", kind: "person", label: "Augustus", visibility: "approved", dates: [dating("augustus-death", "death", { at: { year: 14, month: 8, day: 19, calendar: "julian" } }, "nails-2002")] },
  ],
  relationships: [
    {
      id: "plato-member", kind: "member-of", from: "plato", to: "academy", assertedBy: { kind: "author" }, evidence: [{ source: "nails-2002" }], visibility: "approved",
      dates: [dating("plato-member-held", "span", { from: { year: -387 } }, "nails-2002")],
    },
  ],
};
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-atlas-timeline-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Atlas", url: "https://atlas.example.org", author: { name: "A" }, knowledgeAtlas: { publish: true } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "hello.md"), "---\ntitle: Hello\ndate: 2026-10-19\n---\nHello.\n");
  const research = join(root, ".openblog", "private", "research");
  mkdirSync(research, { recursive: true });
  writeFileSync(join(research, "sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(join(research, "notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(join(research, "atlas.json"), JSON.stringify(ATLAS));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/atlas/`)).ok).toBe(true);
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

/** Opens the atlas index under the strict policy, failing on any violation the timeline causes. */
async function openTimeline(page) {
  const violations = [];
  page.on("console", (message) => {
    const text = message.text();
    // The theme's inline colour-scheme script is refused by this policy, as on any strict site.
    if (/Content Security Policy/i.test(text) && !/inline script/i.test(text)) violations.push(text);
  });
  await page.route(`${origin}/atlas/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await page.goto(`${origin}/atlas/`);
  return violations;
}

const status = (page) => page.locator(".ob-atlas-timeline-status");
const rows = (page) => page.locator("li.ob-atlas-aspect");
const tools = (page) => page.locator(".ob-atlas-timeline-tools");
// How far the page's main content (the timeline, an entry's dates) pokes past the viewport or
// scrolls sideways, with what overflows. The site's own header and navigation belong to the
// theme, whose width depends on the platform's fonts, not to the atlas.
const mainOverflow = (page) =>
  page.evaluate(() => {
    const region = document.querySelector("main#main");
    const elements = [region, ...region.querySelectorAll("*")];
    const limit = window.innerWidth;
    const offenders = elements
      .filter((element) => element.getBoundingClientRect().right > limit + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}: ${Math.round(element.getBoundingClientRect().right)}px`);
    const widest = Math.max(...elements.map((element) => element.getBoundingClientRect().right));
    return { overflow: Math.max(widest - limit, region.scrollWidth - region.clientWidth), offenders };
  });

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the static timeline holds the complete ordered chronology with citations and uncertainty", async ({ page }) => {
    await page.goto(`${origin}/atlas/`);
    await expect(page.getByRole("heading", { level: 2, name: "Timeline" })).toBeVisible();
    await expect(tools(page)).toHaveCount(0);
    const periods = page.locator(".ob-atlas-period > h3");
    await expect(periods).toHaveText(["No earliest year stated (open start)", "5th century BCE", "4th century BCE", "1st century CE"]);
    await expect(page.locator(".ob-atlas-timeline [id^='atlas-d-']")).toHaveCount(8);
    const birth = page.locator("li.ob-atlas-aspect[data-aspect='birth']");
    await expect(birth.locator(".ob-meta").first()).toHaveText("2 competing datings, side by side. None is preferred.");
    await expect(birth.locator(".ob-atlas-date")).toHaveText(["between 428 BCE and 427 BCE", "c. 424 BCE"]);
    await expect(birth.locator("cite")).toHaveText(["Lives of the Eminent Philosophers, ch. 3", "The People of Plato, ch. 3"]);
    await expect(birth).toContainText("Counts the archons differently.");
    await expect(page.locator("#atlas-d-augustus-death .ob-atlas-date")).toHaveText("19 Aug 14 CE (julian)");
    await expect(page.locator("#atlas-d-republic-publication .ob-atlas-date")).toHaveText("unknown, as the dating party states");
    await expect(page.locator("body")).not.toContainText("PRIVATE-MARKER");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Knowledge Atlas");
    expect(await page.evaluate(() => window.__atlasXss)).toBeUndefined();
  });

  test("relative datings are trails that can be followed both ways", async ({ page }) => {
    await page.goto(`${origin}/atlas/republic/`);
    const step = page.locator("#atlas-d-republic-after-phaedo").getByRole("link", { name: "Phaedo" });
    await step.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/atlas/phaedo/#atlas-dates-composition`);
    await expect(page.getByRole("heading", { level: 3, name: "Dated relative to this entry" })).toBeVisible();
    const back = page.getByRole("link", { name: "Republic" }).last();
    await back.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/atlas/republic/#atlas-d-republic-after-phaedo`);
    await expect(page.locator("#atlas-d-republic-after-phaedo")).toContainText("Plato and the Socratic Dialogue, ch. 3");
  });
});

test("the timeline filters from the keyboard, whole aspects only, and goes to a period", async ({ page }) => {
  const violations = await openTimeline(page);
  await expect(tools(page)).toHaveCount(1);
  await expect(status(page)).toHaveText("Showing 7 of 7 dated aspects (8 of 8 datings). Every aspect shown keeps all its datings, their evidence and their notes.");
  const show = page.getByLabel("Show", { exact: true });
  await show.focus();
  await show.selectOption("birth");
  await expect(status(page)).toHaveText("Showing 1 of 7 dated aspects (2 of 8 datings); birth only. Every aspect shown keeps all its datings, their evidence and their notes.");
  await expect(rows(page).filter({ visible: true })).toHaveCount(1);
  const birth = page.locator("li.ob-atlas-aspect[data-aspect='birth']");
  await expect(birth.locator(".ob-atlas-dating").filter({ visible: true })).toHaveCount(2);
  await expect(birth.locator("cite").nth(1)).toBeVisible();
  await expect(birth.getByText("Counts the archons differently.")).toBeVisible();
  await expect(page.locator("#atlas-period-bce-4")).toBeHidden();
  await expect(page.locator(".ob-atlas-trail")).toBeVisible();

  await show.selectOption("");
  const competing = page.getByLabel("Only aspects with competing datings");
  await competing.focus();
  await page.keyboard.press("Space");
  await expect(competing).toBeChecked();
  await expect(status(page)).toContainText("Showing 1 of 7 dated aspects (2 of 8 datings); only aspects with competing datings.");
  await page.keyboard.press("Space");
  await expect(status(page)).toContainText("Showing 7 of 7");

  await page.getByLabel("Period", { exact: true }).selectOption("atlas-period-ce-1");
  await page.getByRole("button", { name: "Go to period" }).click();
  await expect(page.locator("#atlas-period-ce-1")).toBeFocused();
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => window.__atlasXss)).toBeUndefined();
});

test("print shows the whole timeline without its filters", async ({ page }) => {
  await openTimeline(page);
  await page.getByLabel("Show", { exact: true }).selectOption("death");
  await expect(status(page)).toContainText("Showing 2 of 7");
  await page.emulateMedia({ media: "print" });
  await expect(tools(page)).toBeHidden();
  await expect(rows(page).filter({ visible: true })).toHaveCount(7);
  await expect(page.locator(".ob-atlas-timeline cite").filter({ visible: true })).toHaveCount(8);
  await page.emulateMedia({ media: "screen" });
  await expect(rows(page).filter({ visible: true })).toHaveCount(2);
});

test("on a 320px screen with reduced motion nothing scrolls sideways or moves, and competing datings stack", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  await openTimeline(page);
  await expect(tools(page)).toHaveCount(1);
  const timeline = await mainOverflow(page);
  expect(timeline.overflow, timeline.offenders.join(", ")).toBeLessThanOrEqual(1);
  const competing = page.locator("li.ob-atlas-aspect[data-aspect='birth'] .ob-atlas-dating");
  await expect(competing.nth(1)).toBeVisible();
  // Both boxes come from one layout pass, so a reflow elsewhere on the page cannot fall between them.
  const [first, second] = await competing.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  expect(second.y).toBeGreaterThan(first.y);
  const motion = await page.evaluate(() =>
    [...document.querySelectorAll("ob-atlas-timeline *")].filter((element) => {
      const style = getComputedStyle(element);
      return parseFloat(style.transitionDuration) > 0 || parseFloat(style.animationDuration) > 0;
    }).length,
  );
  expect(motion).toBe(0);
  await page.goto(`${origin}/atlas/plato/`);
  await expect(page.getByRole("heading", { level: 2, name: "Dates" })).toBeVisible();
  const entry = await mainOverflow(page);
  expect(entry.overflow, entry.offenders.join(", ")).toBeLessThanOrEqual(1);
});

test("on a wide screen competing datings sit side by side, and reconnecting enhances once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openTimeline(page);
  const competing = page.locator("li.ob-atlas-aspect[data-aspect='birth'] .ob-atlas-dating");
  await expect(competing.nth(1)).toBeVisible();
  // Both boxes come from one layout pass, so a reflow elsewhere on the page cannot fall between them.
  const [first, second] = await competing.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  expect(Math.abs(second.y - first.y)).toBeLessThan(2);
  expect(second.x).toBeGreaterThan(first.x);
  await page.getByLabel("Show", { exact: true }).selectOption("birth");
  await expect(rows(page).filter({ visible: true })).toHaveCount(1);
  await page.evaluate(() => {
    const element = document.querySelector("ob-atlas-timeline");
    const parent = element.parentNode;
    const next = element.nextSibling;
    element.remove();
    parent.insertBefore(element, next);
  });
  await expect(tools(page)).toHaveCount(1);
  await expect(rows(page).filter({ visible: true })).toHaveCount(7);
  await expect(status(page)).toContainText("Showing 7 of 7");
});
