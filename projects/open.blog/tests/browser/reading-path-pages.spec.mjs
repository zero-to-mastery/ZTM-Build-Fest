import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Reading-path pages (ADR 0215, #78), built and served by the real binary. Without JavaScript a path
// is a complete ordered list: every step links to its post, says in the author's words how it
// relates to the step it follows, and has previous and next links. With it, optional progress is
// kept in this browser only: native checkboxes, a status line, a link to where to continue and a
// reset that moves focus somewhere that exists. Storage that is refused or damaged leaves the path
// reading as it did; drafts and unlisted paths do not appear; and the page does not overflow 320px.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const DRAFT = "PRIVATE-DRAFT-STEP-MARKER";
const LONG = "an_extraordinarily_long_unbroken_reason_for_following_the_step_that_must_wrap_instead_of_overflowing_a_small_screen_at_all";
const KEY = "openblog:reading-path:cave-route";

const stepOf = (id, slug, extra = {}) => ({ id, target: { kind: "post", slug }, ...extra });
const then = (relationship, why) => ({ transition: { relationship, why } });
const PATHS = {
  "cave-route": {
    format: "openblog-reading-path", version: 1, title: "From the cave", summary: "A short route.", status: "published",
    steps: [
      stepOf("a", "cave"),
      stepOf("b", "shadows", then("builds-on", "It takes the image further.")),
      stepOf("c", "aside", { optional: true, difficulty: "advanced", ...then("contrasts-with", LONG) }),
      stepOf("d", "sun", then("next", "Simply the next read.")),
      stepOf("e", "hidden", then("next", `${DRAFT} reason`)),
    ],
  },
  "quiet-route": {
    format: "openblog-reading-path", version: 1, title: "Quiet route", status: "published", listed: false,
    steps: [stepOf("a", "cave"), stepOf("b", "sun", then("next", "Next."))],
  },
};

let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-reading-paths-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Paths", url: "https://paths.example.org", author: { name: "Site Author" }, readingPaths: { publish: true } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  mkdirSync(join(root, "content", "paths"), { recursive: true });
  for (const [slug, title, extra] of [
    ["cave", "The cave", ""], ["shadows", "Shadows", ""], ["aside", "An aside", ""], ["sun", "The sun", ""],
    ["hidden", `${DRAFT} title`, "draft: true\n"],
  ]) {
    writeFileSync(join(root, "content", "posts", `${slug}.md`), `---\ntitle: ${title}\ndate: 2026-10-19\n${extra}---\nA post.\n`);
  }
  for (const [slug, path] of Object.entries(PATHS)) {
    writeFileSync(join(root, "content", "paths", `${slug}.json`), JSON.stringify(path));
  }
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
    expect((await fetch(`${origin}/paths/cave-route/`)).ok).toBe(true);
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

const open = (page) => page.goto(`${origin}/paths/cave-route/`);
const steps = (page) => page.locator("ol.ob-path-steps > li");
const status = (page) => page.locator(".ob-path-status");

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the path is a complete ordered list with transitions, links and previous and next", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "From the cave" })).toBeVisible();
    // The draft step is left out whole (it is the last step), and leaves no trace.
    await expect(steps(page)).toHaveCount(4);
    await expect(page.locator("body")).not.toContainText(DRAFT);
    await expect(steps(page).nth(0).getByRole("link", { name: "The cave" })).toHaveAttribute("href", "/posts/cave/");
    await expect(steps(page).nth(1)).toContainText("Builds on the step it follows");
    await expect(steps(page).nth(1)).toContainText("It takes the image further.");
    // The step after an optional one follows the last required step.
    await expect(steps(page).nth(3)).toContainText("Comes next, with no further relationship claimed");
    await expect(steps(page).nth(3).getByRole("link", { name: /^1, The cave$|^2, Shadows$/ })).toHaveCount(1);
    await expect(steps(page).nth(2)).toContainText("optional: you can skip it");
    await expect(steps(page).nth(0)).toContainText("First step");
    await expect(steps(page).nth(3)).toContainText("End of the path");
    await expect(steps(page).nth(1).getByRole("link", { name: /^Next: step 3/ })).toHaveAttribute("href", "#step-3");
    await expect(steps(page).nth(1).getByRole("link", { name: /^Previous: step 1/ })).toHaveAttribute("href", "#step-1");
    // No controls are offered without the component.
    await expect(page.locator("input[type=checkbox]")).toHaveCount(0);
    await expect(page.locator(".ob-path-tools")).toHaveCount(0);
  });

  test("the index lists only listed paths and the unlisted one still has its page", async ({ page }) => {
    await page.goto(`${origin}/paths/`);
    await expect(page.getByRole("link", { name: "From the cave" })).toHaveAttribute("href", "/paths/cave-route/");
    await expect(page.locator("body")).not.toContainText("Quiet route");
    expect((await page.goto(`${origin}/paths/quiet-route/`))?.ok()).toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: "Quiet route" })).toBeVisible();
    const sitemap = await (await page.request.get(`${origin}/sitemap.xml`)).text();
    expect(sitemap).toContain("/paths/cave-route/");
    expect(sitemap).not.toContain("quiet-route");
  });
});

test.describe("with JavaScript", () => {
  test("progress is optional, labelled, kept in this browser and resettable by keyboard", async ({ page }) => {
    await open(page);
    const tools = page.getByRole("group", { name: "Your progress on this path" });
    await expect(tools).toBeVisible();
    await expect(status(page)).toContainText("not marked any step as read");
    await expect(tools.getByRole("button", { name: "Reset progress" })).toBeHidden();

    const first = page.getByRole("checkbox", { name: "Mark step 1, The cave, as read" });
    await first.focus();
    await page.keyboard.press("Space");
    await expect(first).toBeChecked();
    await expect(status(page)).toContainText("1 of 3 steps read");
    await expect(page.getByRole("link", { name: "Continue at step 2, Shadows" })).toHaveAttribute("href", "#step-2");
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe('{"version":1,"read":["post:cave"]}');

    // Optional steps may be read without counting toward the end.
    await page.getByRole("checkbox", { name: /Mark step 3, An aside/ }).check();
    await expect(status(page)).toContainText("1 of 3 steps read, and 1 of 1 optional step");

    // It persists across a reload.
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Mark step 1, The cave, as read" })).toBeChecked();

    // Reset by keyboard: nothing remains, storage is cleared, and focus lands on something that exists.
    const reset = page.getByRole("button", { name: "Reset progress" });
    await reset.focus();
    await page.keyboard.press("Enter");
    await expect(status(page)).toContainText("not marked any step as read");
    await expect(first).not.toBeChecked();
    await expect(status(page)).toBeFocused();
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull();
  });

  test("damaged stored data is ignored and left alone until the reader changes something", async ({ page }) => {
    await page.addInitScript((key) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(key, '{"version":1,"read":["post:gone","x"],"extra":{}}');
        sessionStorage.setItem("seeded", "1");
      }
    }, KEY);
    await open(page);
    await expect(status(page)).toContainText("not marked any step as read");
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toContain("post:gone");
    await page.getByRole("checkbox", { name: "Mark step 2, Shadows, as read" }).check();
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe('{"version":1,"read":["post:shadows"]}');
  });

  test("when storage is refused the path says so and reads the same", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
    });
    await open(page);
    await expect(status(page)).toContainText("Progress cannot be saved in this browser");
    await expect(page.locator("input[type=checkbox]")).toHaveCount(0);
    await expect(steps(page)).toHaveCount(4);
  });

  test("a write that fails is said, and the page keeps working", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
    });
    await page.getByRole("checkbox", { name: "Mark step 1, The cave, as read" }).check();
    await expect(status(page)).toContainText("did not let the change be saved");
    await expect(page.getByRole("checkbox", { name: "Mark step 1, The cave, as read" })).toBeChecked();
  });

  test("print leaves the controls out and keeps every step", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("group", { name: "Your progress on this path" })).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".ob-path-tools")).toBeHidden();
    await expect(page.locator(".ob-path-progress").first()).toBeHidden();
    await expect(steps(page)).toHaveCount(4);
    await expect(steps(page).nth(3)).toBeVisible();
  });

  test("the path does not overflow at 320px, with a long unbroken reason", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page);
    await expect(page.getByRole("group", { name: "Your progress on this path" })).toBeVisible();
    const measured = await page.evaluate(() => {
      const region = document.querySelector("ob-reading-path");
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
