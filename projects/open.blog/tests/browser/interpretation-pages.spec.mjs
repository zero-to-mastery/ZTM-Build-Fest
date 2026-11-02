import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Interpretation comparison pages (ADR 0232, #90), built and served by the real binary. Without
// JavaScript a comparison is a complete static page: who advances each interpretation, how they
// relate, and every explanation level as a section reachable by link. With it, a level selector
// narrows the explanations without ever touching the interpretations or their evidence, is keyboard
// operable with pressed states, and print shows every level. Drafts and private sources leave no trace.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const DRAFT = "PRIVATE-DRAFT-COMPARISON-MARKER";
const SECRET = "secret-source-marker";
const LONG = "an_extraordinarily_long_unbroken_statement_that_must_wrap_instead_of_overflowing_a_small_screen_at_all";

const COMPARISON = {
  format: "openblog-interpretation-comparison", version: 1, title: "What the cave stands for",
  subject: "Readings of the cave image.", status: "published",
  interpretations: [
    { id: "political", attribution: { kind: "named", name: "A political reading", certainty: "attributed" },
      statement: `The cave is a picture of a city. ${LONG}`, evidence: [{ link: "l1" }],
      uncertainty: "The text never says so." },
    { id: "epistemic", attribution: { kind: "source", source: "plato" }, statement: "قراءة معرفية للكهف.", language: "ar" },
    { id: "hidden", attribution: { kind: "source", source: SECRET }, statement: `${DRAFT} statement` },
  ],
  relations: [{ from: "political", to: "epistemic", kind: "differs-from", note: "Different scales." }],
  explanations: [
    { id: "x1", level: "beginner", text: "Imagine people who only see shadows." },
    { id: "x2", level: "student", about: "political", text: "A student's view of the city reading.", evidence: [{ link: "l1" }] },
    { id: "x3", level: "scholarly", text: "Both readings are attested." },
  ],
};

// The same comparison with explanations that name the reading modes they are offered in (ADR 0235, #219).
const MODES = {
  ...COMPARISON, title: "Cave readings by mode",
  explanations: [
    { id: "x1", level: "beginner", text: "Imagine people who only see shadows.", language: "en", revision: 2, authors: ["Ada", "Grace"] },
    { id: "x1fr", level: "beginner", text: "Imaginez des gens qui ne voient que des ombres.", language: "fr", translationOf: "x1" },
    { id: "x2", level: "beginner", text: "A deep-dive-only note for beginners.", modes: ["deep-dive"] },
    { id: "x3", level: "scholarly", text: "Both readings are attested.", modes: ["deep-dive"] },
    { id: "x4", level: "student", text: "A guided-only student note.", modes: ["guided"], prerequisite: "What an allegory is" },
  ],
};

let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-interpretations-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Interpretations", url: "https://interp.example.org", author: { name: "Site Author" },
    interpretations: { publish: true }, claimEvidence: { publish: true },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  mkdirSync(join(root, "content", "comparisons"), { recursive: true });
  mkdirSync(join(root, ".openblog", "private", "research"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "cave.md"), "---\ntitle: The cave\ndate: 2026-10-19\n---\nA post.\n");
  writeFileSync(join(root, ".openblog", "private", "research", "sources.json"), JSON.stringify({
    version: 1, sources: [
      { id: "plato", kind: "work", title: "Politeia", issued: "2003" },
      { id: SECRET, kind: "work", title: `${SECRET} title` },
    ],
  }));
  writeFileSync(join(root, ".openblog", "private", "research", "claims.json"), JSON.stringify({
    version: 1,
    claims: [{ id: "c1", post: "cave", statement: "Cities mistake custom for the world.", visibility: "approved" }],
    links: [{ id: "l1", claim: "c1", relation: "supports", visibility: "approved", evidence: { source: "plato" } }],
  }));
  writeFileSync(join(root, "content", "comparisons", "cave.json"), JSON.stringify(COMPARISON));
  writeFileSync(join(root, "content", "comparisons", "modes.json"), JSON.stringify(MODES));
  writeFileSync(join(root, "content", "comparisons", "draft.json"), JSON.stringify({ ...COMPARISON, status: "draft", title: `${DRAFT} title` }));
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
    expect((await fetch(`${origin}/interpretations/cave/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  if (root) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 300));
      }
    }
  }
});

const open = (page) => page.goto(`${origin}/interpretations/cave/`);
const levels = (page) => page.locator("section.ob-level");

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the comparison is complete: attribution, evidence, relations and every level", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "What the cave stands for" })).toBeVisible();
    const items = page.locator("ol.ob-interp-list > li");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Advanced by A political reading");
    await expect(items.nth(0)).toContainText("Cities mistake custom for the world.");
    await expect(items.nth(0)).toContainText("Politeia");
    await expect(items.nth(1)).toContainText("Advanced in Politeia");
    await expect(page.locator("#relations")).toContainText("differs from");
    // Every level is on the page and reachable by link.
    await expect(levels(page)).toHaveCount(3);
    for (const name of ["Beginner", "Student", "Scholarly"]) {
      await expect(page.getByRole("navigation", { name: "Explanation levels" }).getByRole("link", { name })).toBeVisible();
    }
    await expect(page.locator("#level-student")).toContainText("A student's view of the city reading.");
    await expect(page.locator("#level-student").getByRole("link", { name: /About interpretation 1/ })).toHaveAttribute("href", "#i-political");
    await expect(page.locator(".ob-level-switch")).toHaveCount(0);
    // Nothing private leaves a trace.
    const html = await page.content();
    expect(html).not.toContain(DRAFT);
    expect(html).not.toContain(SECRET);
  });

  test("the index lists the comparison, and a draft or raw file is not served", async ({ page }) => {
    await page.goto(`${origin}/interpretations/`);
    await expect(page.getByRole("link", { name: "What the cave stands for" })).toHaveAttribute("href", "/interpretations/cave/");
    await expect(page.locator("body")).not.toContainText(DRAFT);
    expect((await page.request.get(`${origin}/interpretations/draft/`)).status()).toBe(404);
    expect((await page.request.get(`${origin}/content/comparisons/cave.json`)).status()).toBe(404);
    const sitemap = await (await page.request.get(`${origin}/sitemap.xml`)).text();
    expect(sitemap).toContain("/interpretations/cave/");
    expect(sitemap).not.toContain("draft");
  });
});

test.describe("with JavaScript", () => {
  test("choosing a level narrows the explanations and never changes the evidence", async ({ page }) => {
    await open(page);
    const group = page.getByRole("group", { name: "Explanation level" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("button", { name: "All levels" })).toHaveAttribute("aria-pressed", "true");
    await expect(levels(page)).toHaveCount(3);
    const evidenceBefore = await page.locator("#interpretations").innerText();
    // Evidence is never inside a level, so no choice can swap one list for another.
    await expect(page.locator("section.ob-level .ob-interp-evidence")).toHaveCount(0);
    const allEvidence = () => page.locator(".ob-interp-evidence").evaluateAll((lists) => lists.filter((l) => l.offsetParent !== null).map((l) => l.innerText));
    const evidenceLists = await allEvidence();
    expect(evidenceLists.length).toBeGreaterThan(0);

    const student = group.getByRole("button", { name: "Student" });
    await student.focus();
    await page.keyboard.press("Enter");
    await expect(student).toHaveAttribute("aria-pressed", "true");
    await expect(student).toBeFocused();
    await expect(page.locator("#level-student")).toBeVisible();
    await expect(page.locator("#level-beginner")).toBeHidden();
    await expect(page.locator("#level-scholarly")).toBeHidden();
    await expect(page.locator(".ob-level-status")).toContainText("student explanations");
    expect(await page.locator("#interpretations").innerText()).toBe(evidenceBefore);

    await group.getByRole("button", { name: "Scholarly" }).press("Space");
    await expect(page.locator("#level-scholarly")).toBeVisible();
    await expect(page.locator("#level-student")).toBeHidden();
    expect(await page.locator("#interpretations").innerText()).toBe(evidenceBefore);
    expect(await allEvidence()).toEqual(evidenceLists);

    await group.getByRole("button", { name: "All levels" }).click();
    await expect(levels(page)).toHaveCount(3);
    for (const level of ["beginner", "student", "scholarly"]) await expect(page.locator(`#level-${level}`)).toBeVisible();
  });

  test("a link to a level or to an explanation inside a hidden level shows it", async ({ page }) => {
    await page.goto(`${origin}/interpretations/cave/#level-scholarly`);
    await expect(page.locator("#level-scholarly")).toBeVisible();
    await expect(page.locator("#level-beginner")).toBeHidden();
    await page.evaluate(() => { location.hash = "#x-x1"; });
    await expect(page.locator("#level-beginner")).toBeVisible();
  });

  test("print shows every level", async ({ page }) => {
    await open(page);
    await page.getByRole("group", { name: "Explanation level" }).getByRole("button", { name: "Beginner" }).click();
    await expect(page.locator("#level-student")).toBeHidden();
    await page.emulateMedia({ media: "print" });
    for (const level of ["beginner", "student", "scholarly"]) await expect(page.locator(`#level-${level}`)).toBeVisible();
    await expect(page.locator(".ob-level-switch")).toBeHidden();
  });

  test("the page does not overflow at 320px, with a long unbroken statement", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page);
    await expect(page.getByRole("group", { name: "Explanation level" })).toBeVisible();
    const measured = await page.evaluate(() => {
      const region = document.querySelector(".ob-interpretation-comparison");
      const widest = Math.max(...[region, ...region.querySelectorAll("*")].map((element) => element.getBoundingClientRect().right));
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        content: Math.max(widest - window.innerWidth, region.scrollWidth - region.clientWidth),
      };
    });
    expect(measured.page).toBeLessThanOrEqual(0);
    expect(measured.content).toBeLessThanOrEqual(0);
  });
});

const inMode = async (page, mode) => {
  await page.addInitScript((value) => { try { localStorage.setItem("ob-reading-mode", value); } catch {} }, mode);
  await page.goto(`${origin}/interpretations/modes/`);
};
const buttons = (page) => page.getByRole("group", { name: "Explanation level" }).getByRole("button");

test.describe("explanations and reading modes", () => {
  test("without JavaScript every explanation is on the page with its labels", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${origin}/interpretations/modes/`);
    for (const id of ["x1", "x1fr", "x2", "x3", "x4"]) await expect(page.locator(`#x-${id}`)).toBeVisible();
    await expect(page.locator("#x-x1")).toContainText("Revision 2.");
    await expect(page.locator("#x-x1")).toContainText("Written by Ada, Grace.");
    await expect(page.locator("#x-x1fr")).toHaveAttribute("lang", "fr");
    await expect(page.locator("#x-x1fr a[href='#x-x1']")).toBeVisible();
    await expect(page.locator("#x-x3")).toHaveAttribute("data-modes", "deep-dive");
    await context.close();
  });

  test("standard mode and an unset or blocked store show every level and explanation", async ({ page }) => {
    await inMode(page, "standard");
    await expect(buttons(page)).toHaveText(["All levels", "Beginner", "Student", "Scholarly"]);
    for (const id of ["x1", "x2", "x3", "x4"]) await expect(page.locator(`#x-${id}`)).toBeVisible();
    await expect(page.locator(".ob-level-mode-note")).toHaveCount(0);
  });

  test("a blocked store reads as standard", async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } }); });
    await page.goto(`${origin}/interpretations/modes/`);
    await expect(buttons(page)).toHaveText(["All levels", "Beginner", "Student", "Scholarly"]);
    await expect(page.locator("#x-x2")).toBeVisible();
  });

  test("guided mode leaves out deep-dive explanations and offers no control for an empty level", async ({ page }) => {
    await inMode(page, "guided");
    const evidence = await page.locator("#interpretations").innerText();
    await expect(buttons(page)).toHaveText(["All levels", "Beginner", "Student"]);
    await expect(page.locator("#x-x1")).toBeVisible();
    await expect(page.locator("#x-x2")).toBeHidden();
    await expect(page.locator("#x-x4")).toBeVisible();
    await expect(page.locator("#level-scholarly")).toBeHidden();
    await expect(page.locator(".ob-level-links a[href='#level-scholarly']")).toBeHidden();
    await expect(page.locator(".ob-level-mode-note")).toContainText("leaves them out");
    await buttons(page).filter({ hasText: "Student" }).click();
    await expect(page.locator("#level-beginner")).toBeHidden();
    expect(await page.locator("#interpretations").innerText()).toBe(evidence);
  });

  test("deep-dive mode shows guided and deep-dive explanations, like every supplement", async ({ page }) => {
    await inMode(page, "deep-dive");
    await expect(buttons(page)).toHaveText(["All levels", "Beginner", "Student", "Scholarly"]);
    for (const id of ["x1", "x2", "x3", "x4"]) await expect(page.locator(`#x-${id}`)).toBeVisible();
    await expect(page.locator(".ob-level-mode-note")).toHaveCount(0);
  });

  test("the note's button shows every explanation on the page without changing the saved mode", async ({ page }) => {
    await inMode(page, "guided");
    await expect(page.locator("#x-x2")).toBeHidden();
    await page.getByRole("button", { name: "Show all explanations" }).click();
    for (const id of ["x1", "x2", "x3", "x4"]) await expect(page.locator(`#x-${id}`)).toBeVisible();
    await expect(buttons(page)).toHaveText(["All levels", "Beginner", "Student", "Scholarly"]);
    expect(await page.evaluate(() => localStorage.getItem("ob-reading-mode"))).toBe("guided");
    await page.getByRole("button", { name: "Follow my reading mode again" }).click();
    await expect(page.locator("#x-x2")).toBeHidden();
  });

  test("a link to a level the mode emptied shows that level", async ({ page }) => {
    await inMode(page, "guided");
    await expect(page.locator("#level-scholarly")).toBeHidden();
    await page.evaluate(() => { location.hash = "#level-scholarly"; });
    await expect(page.locator("#level-scholarly")).toBeVisible();
    await expect(page.locator("#x-x3")).toBeVisible();
  });

  test("a link into an explanation the mode left out shows it", async ({ page }) => {
    await inMode(page, "guided");
    await expect(page.locator("#x-x3")).toBeHidden();
    await page.evaluate(() => { location.hash = "#x-x3"; });
    await expect(page.locator("#x-x3")).toBeVisible();
  });
});
