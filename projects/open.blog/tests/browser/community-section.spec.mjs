import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The community section of a canonical page (#230, ADRs 0180 to 0184), in the real site served from
// real content files. The section is static HTML from `community-perspectives.json`: it reads with no
// JavaScript, as a labelled region with one list, with the fixed plural notice, each item marked as
// chosen by the editors; it is keyboard operable and screen-reader named; it counts, ranks and orders
// nothing by popularity; reader text is inert; it reflows at 320px and 400% zoom and prints; and the
// feeds and portable copies carry none of it.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://section.example/api";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOSTILE = "<img src=x onerror=alert(1)> <script>alert(2)</script>";
const LONG = "unbroken".repeat(40);
const NOTE = "Connects the tides to a shared rhythm.";
const POST = "---\ntitle: Tides\ndate: 2026-10-20\n---\nThe moon causes the tides.\n\nWe measured the tides twice a day.\n";
const SECTION = "#ob-community-perspectives";
let root;
let server;
let origin;
let revision;

/** The digest the build binds a feature to (ADR 0177): domain-separated BLAKE2s-256 of the exact text. */
function digestOf(body) {
  const bytes = Buffer.from(body, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return createHash("blake2s256").update(Buffer.from("openblog-featured-reflection-v1\0")).update(length).update(bytes).digest("hex");
}

const bodies = {
  1: `A reading of the tides. ${HOSTILE}\n\nA second paragraph ${LONG}.`,
  2: "The tides are a conversation with the moon.\n\nThey keep their own time.",
  3: `Long text ${LONG} ${LONG}`,
};
const categories = { 1: "connection", 2: "question" };
const published = (n, name) => ({
  id: ID(n), post: "posts/tides.md", work: "/tides/", revision,
  target: { version: 1, kind: "work" }, ...(categories[n] ? { category: categories[n] } : {}), body: bodies[n],
  received: "2026-10-26", approved: "2026-10-27", ...(name ? { name } : {}),
});
const feature = (n, day, context) => ({ id: ID(n), post: "posts/tides.md", revision: 1, digest: digestOf(bodies[n]), featured: day, ...(context ? { context } : {}) });
const thirdFile = (items) => writeFileSync(join(root, "content", "third-perspectives.json"), JSON.stringify({ version: 1, items }, null, 2));
const featuresFile = (items) => writeFileSync(join(root, "content", "community-perspectives.json"), JSON.stringify({ version: 1, items }, null, 2));
const publishAll = () => {
  thirdFile([published(1, "Mina Unique"), published(2), published(3)]);
  featuresFile([feature(2, "2026-10-29"), feature(1, "2026-10-28", NOTE), feature(3, "2026-10-30")]);
};

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-community-section-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Section",
    url: "https://section-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: false, analytics: false, feedback: true, receipts: true, endpoint: ENDPOINT },
    participation: { kinds: { "third-perspective": "locked" } },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
  // The passage revision a published reflection is written against, as the build says it.
  const out = join(root, "pre");
  execFileSync(binary, ["build", "--root", root, "--out", out], { stdio: "pipe" });
  revision = readFileSync(join(out, "tides", "index.html"), "utf8").match(/passage revision, <code>(p1:[0-9a-f]{32})<\/code>/)?.[1];
  rmSync(out, { recursive: true, force: true });
  expect(revision, "the build names the passage revision").toBeTruthy();
  publishAll();
  await start();
});

/** The site is read when the server starts, so a change to the content files needs a restart. */
async function start() {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/tides/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
}

async function stop() {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
}

test.afterAll(async () => {
  await stop();
  removeTree(root);
});

let dirty = false;
test.beforeEach(async () => {
  if (dirty) {
    publishAll();
    await stop();
    await start();
    dirty = false;
  }
});

/** Change the content files and serve them. */
async function republish(change) {
  change();
  dirty = true;
  await stop();
  await start();
}

const overflowOf = (page, selector) =>
  page.evaluate((selector) => {
    const region = document.querySelector(selector);
    const limit = document.documentElement.clientWidth;
    const elements = [region, ...region.querySelectorAll("*")];
    const offenders = elements.filter((element) => element.getBoundingClientRect().right > limit + 1).map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return { overflow: Math.max(region.scrollWidth - region.clientWidth, 0), offenders };
  }, selector);

test("without JavaScript the section is a labelled region with the fixed notice and one list", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/tides/`);
  const region = page.getByRole("region", { name: "Community perspectives" });
  await expect(region).toBeVisible();
  await expect(region.getByRole("heading", { name: "Community perspectives", level: 2 })).toBeVisible();
  await expect(region.locator(".ob-community-notice")).toHaveText(/^The editors chose these reflections to feature\. Each is one reader.s view: featuring a reflection is an editorial choice, not a vote, and it does not mean the authors, the editors or the community agree with it\.$/);
  await expect(region.getByRole("list")).toHaveCount(1);
  await expect(region.getByRole("listitem")).toHaveCount(3);
  await expect(region.locator("ol")).toHaveCount(0);
  // By the day each was featured, not by anything a reader did.
  const headings = await region.getByRole("heading", { level: 3 }).allTextContents();
  expect(headings).toEqual(["Third Perspective from Mina Unique, a reader", "Third Perspective from a reader", "Third Perspective from a reader"]);
  await expect(region.getByText("Chosen by the editors")).toHaveCount(3);
  await expect(region.getByText("Note from the editors:")).toHaveCount(1);
  await expect(region).toContainText(NOTE);
  await expect(region.locator("script, form, input, button, textarea")).toHaveCount(0);
  await context.close();
});

test("screen readers get named regions, articles and a link back to the reflection's own list entry", async ({ page }) => {
  await page.goto(`${origin}/tides/`);
  const region = page.getByRole("region", { name: "Community perspectives" });
  for (const name of ["Third Perspective from Mina Unique, a reader", "Third Perspective from a reader"]) {
    await expect(region.getByRole("article", { name }).first()).toBeVisible();
  }
  // Each article is named by its own heading, and its id is not the reflection's id in the list.
  const articles = await region.getByRole("article").evaluateAll((nodes) => nodes.map((node) => ({ id: node.id, labelled: node.getAttribute("aria-labelledby"), heading: document.getElementById(node.getAttribute("aria-labelledby"))?.tagName })));
  expect(articles.map((entry) => entry.heading)).toEqual(["H3", "H3", "H3"]);
  expect(articles.every((entry) => entry.id.startsWith("ob-feature-"))).toBe(true);
  const ids = await page.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size, "no duplicate ids on the page").toBe(ids.length);
  await expect(page.locator(`#ob-perspective-${ID(1)}`)).toHaveCount(1);
  await expect(page.locator(`#ob-feature-${ID(1)}`)).toHaveCount(1);
  // The status is text, not colour; nothing here announces by itself.
  await expect(region.locator("[aria-live], [role='status'], [role='alert']")).toHaveCount(0);
  const snapshot = await region.ariaSnapshot();
  expect(snapshot).toContain("Community perspectives");
  expect(snapshot).toMatch(/list/);
  expect(snapshot).not.toMatch(/\b\d+ (readers|people|likes|votes)\b/i);
});

test("it is keyboard operable: Tab reaches the link to the reflection, Enter follows it, focus is visible", async ({ page }) => {
  await page.goto(`${origin}/tides/`);
  const target = page.locator(`${SECTION} a[href="#ob-perspective-${ID(1)}"]`);
  await expect(target).toHaveCount(1);
  // Tab from the top of the page until the link has focus: nothing before it traps focus.
  let reached = false;
  for (let step = 0; step < 300 && !reached; step += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate((id) => document.activeElement?.getAttribute("href") === `#ob-perspective-${id}` && document.activeElement.closest("#ob-community-perspectives") !== null, ID(1));
  }
  expect(reached, "Tab reaches the section's link").toBe(true);
  const outline = await target.evaluate((node) => getComputedStyle(node).outlineStyle);
  expect(outline, "a visible focus indicator").not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#ob-perspective-${ID(1)}$`));
  const entry = page.locator(`#ob-perspective-${ID(1)}`);
  await expect(entry).toBeInViewport();
  expect(await entry.evaluate((node) => getComputedStyle(node).outlineStyle), "the target is marked").not.toBe("none");
  // Tab onward leaves the section without a trap.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBeTruthy();
});

test("nothing counts, ranks or claims agreement, and the editors' note is labelled as theirs", async ({ page }) => {
  await page.goto(`${origin}/tides/`);
  const region = page.locator(SECTION);
  const text = (await region.innerText()).replace(/not a vote/g, "");
  expect(text).not.toMatch(/popular|rank|score|upvote|\blikes?\b|reactions?|trending|\bmost\b|\btop\b|\bbest\b/i);
  expect(text).not.toMatch(/\b\d+\s+(readers?|people|likes?|votes?|reflections?|responses?)\b/i);
  expect(text).not.toMatch(/\d+ of \d+/);
  await expect(region.locator(".ob-feature-note")).toHaveText(`Note from the editors: ${NOTE}`);
  await expect(region.locator(".ob-feature-provenance").first()).toContainText("approved by the editors");
  await expect(region.locator(".ob-feature-provenance").first()).toContainText("with the reader's separate permission");
});

test("reflections of different prompts are each shown with their own prompt, never grouped or ranked by it", async ({ page }) => {
  await page.goto(`${origin}/tides/`);
  const meta = (n) => page.locator(`#ob-feature-${ID(n)} .ob-perspective-meta`);
  await expect(meta(1)).toContainText("Prompt: A connection");
  await expect(meta(2)).toContainText("Prompt: A question");
  await expect(meta(3)).not.toContainText("Prompt:");
  // Order is the day featured (28th, 29th, 30th), whatever the prompt.
  const order = await page.locator(`${SECTION} article`).evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(order).toEqual([ID(1), ID(2), ID(3)].map((id) => `ob-feature-${id}`));
  await expect(page.locator(`${SECTION} h4, ${SECTION} [role="group"]`)).toHaveCount(0);
});

test("a named and an anonymous reflection are each shown as published, and reader text is inert", async ({ page }) => {
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await page.goto(`${origin}/tides/`);
  const region = page.locator(SECTION);
  await expect(page.locator(`#ob-feature-${ID(1)}`)).toContainText("Mina Unique");
  await expect(page.locator(`#ob-feature-${ID(2)}`)).not.toContainText("Mina");
  await expect(page.locator(`#ob-feature-${ID(2)} h3`)).toHaveText("Third Perspective from a reader");
  // The hostile words are text.
  await expect(page.locator(`#ob-feature-${ID(1)}`)).toContainText("<img src=x onerror=alert(1)>");
  await expect(region.locator("img, script")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(dialogs).toEqual([]);
});

test("a feature that no longer stands is simply absent, with no gap, count or tombstone", async ({ page }) => {
  // The editors take one off: the other two remain and nothing says one is missing.
  await republish(() => featuresFile([feature(2, "2026-10-29"), feature(1, "2026-10-28", NOTE)]));
  await page.goto(`${origin}/tides/`);
  await expect(page.locator(`${SECTION} li`)).toHaveCount(2);
  await expect(page.locator(SECTION)).not.toContainText(/removed|withdrawn|taken off|no longer|was featured|\b3\b/i);
  // The reader withdraws a reflection: it leaves the Third Perspectives file and its feature goes with it.
  await republish(() => thirdFile([published(1, "Mina Unique"), published(3)]));
  await page.goto(`${origin}/tides/`);
  await expect(page.locator(`${SECTION} li`)).toHaveCount(1);
  await expect(page.locator(`#ob-feature-${ID(2)}`)).toHaveCount(0);
  await expect(page.locator(`#ob-perspective-${ID(2)}`)).toHaveCount(0);
  // Nothing featured: no section, no landmark, no notice.
  await republish(() => featuresFile([]));
  await page.goto(`${origin}/tides/`);
  await expect(page.locator(SECTION)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Community perspectives" })).toHaveCount(0);
  await expect(page.getByText("The editors chose these reflections to feature")).toHaveCount(0);
});

test("the feeds, the portable copy and the llms file carry the canonical link and none of the featured words", async () => {
  for (const path of ["rss.xml", "feed.json", "llms-full.txt", "llms.txt", "search.json", "index.json"]) {
    const response = await fetch(`${origin}/${path}`);
    if (!response.ok) {
      expect(["feed.json", "llms.txt", "search.json", "index.json"], `${path} is a file this site has`).toContain(path);
      continue;
    }
    const body = await response.text();
    for (const secret of [NOTE, "Mina Unique", "conversation with the moon", "Chosen by the editors", "ob-feature-", ID(1), ID(2), ID(3), LONG]) {
      expect(body.includes(secret), `${secret} in ${path}`).toBe(false);
    }
  }
  const llms = await (await fetch(`${origin}/llms-full.txt`)).text();
  expect(llms).toContain("Third Perspectives: on the canonical page");
});

test("the section reflows at 320px and 400% zoom, in forced colours and in print", async ({ browser }) => {
  for (const viewport of [{ width: 320, height: 800 }, { width: 1280 / 4, height: 800 / 4 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${origin}/tides/`);
    const measured = await overflowOf(page, SECTION);
    expect(measured.overflow, `${viewport.width}px: ${measured.offenders.join(", ")}`).toBeLessThanOrEqual(1);
    expect(measured.offenders, `${viewport.width}px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no sideways page scroll").toBeLessThanOrEqual(1);
    for (const link of await page.locator(`${SECTION} a`).all()) {
      const box = await link.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    await context.close();
  }
  const forced = await browser.newContext({ forcedColors: "active", viewport: { width: 320, height: 800 } });
  const forcedPage = await forced.newPage();
  await forcedPage.goto(`${origin}/tides/`);
  await expect(forcedPage.locator(SECTION)).toBeVisible();
  await expect(forcedPage.locator(`${SECTION} .ob-feature`).first()).toBeVisible();
  expect((await overflowOf(forcedPage, SECTION)).offenders).toEqual([]);
  await forced.close();
  const printed = await browser.newContext();
  const printPage = await printed.newPage();
  await printPage.goto(`${origin}/tides/`);
  await printPage.emulateMedia({ media: "print" });
  await expect(printPage.locator(SECTION)).toBeVisible();
  expect(await printPage.locator(`${SECTION} .ob-feature`).first().evaluate((node) => getComputedStyle(node).breakInside)).toBe("avoid");
  await expect(printPage.locator(`${SECTION} .ob-feature`)).toHaveCount(3);
  await printed.close();
});
