import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio: the Add something dialog writes a piece's Markdown at the caret in both editor modes, at phone
// and desktop sizes, and the Visual editor shows the piece as an editable block (ADR 0254, #333).

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-pieces-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
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

async function openNewPost(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/#/new/posts`);
  await expect(page.getByRole("button", { name: "Add something" })).toBeVisible();
}

const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });
const visual = (page) => page.getByRole("textbox", { name: "Visual editor" });
const mode = (page, name) => page.getByRole("button", { name, exact: true });

async function useMarkdown(page, text, selection = [text.length, text.length]) {
  await mode(page, "Markdown").click();
  await markdown(page).fill(text);
  await markdown(page).evaluate((element, [start, end]) => element.setSelectionRange(start, end), selection);
}

for (const [name, viewport] of [["phone", { width: 320, height: 640 }], ["desktop", { width: 1280, height: 800 }]]) {
  test.describe(name, () => {
    test.use({ viewport });

    test("Add something inserts a piece in Markdown mode, refuses a bad one, and the preview shows it", async ({ page }) => {
      await openNewPost(page);
      await page.getByRole("textbox", { name: "Title", exact: true }).fill("Pieces");
      await useMarkdown(page, "First paragraph.\n\nLast paragraph.\n", [16, 16]);
      const trigger = page.getByRole("button", { name: "Add something" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Add something" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: /^Button/ })).toBeFocused();
      // Large touch targets.
      const box = await dialog.getByRole("button", { name: /^Video/ }).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      await dialog.getByRole("button", { name: /^Button/ }).click();
      await expect(dialog.getByRole("heading", { name: "Button", level: 3 })).toBeVisible();
      await dialog.getByLabel("Button text (required)").fill("Read more");
      await dialog.getByLabel("Where it goes (required)").fill("javascript:alert(1)");
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog.getByRole("alert")).toContainText("not allowed");
      await expect(markdown(page)).toHaveValue("First paragraph.\n\nLast paragraph.\n");
      await dialog.getByLabel("Where it goes (required)").fill("/about/");
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog).toBeHidden();
      await expect(markdown(page)).toHaveValue("First paragraph.\n\n```piece button\nlabel: Read more\nhref: /about/\n```\n\nLast paragraph.\n");
      await expect(markdown(page)).toBeFocused();

      // A video is a frame in the preview, with its plain link beside it.
      await page.getByRole("button", { name: "Add something" }).click();
      await dialog.getByRole("button", { name: /^Video/ }).click();
      await dialog.getByLabel("Video (required)").fill("https://youtu.be/dQw4w9WgXcQ");
      await dialog.getByLabel("Title (required)").fill("A short tour");
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog).toBeHidden();
      await expect(markdown(page)).toHaveValue(/```piece video\nprovider: youtube\nvideo: dQw4w9WgXcQ\ntitle: A short tour\n```/);
      await page.getByRole("button", { name: "Site preview", exact: true }).click();
      const preview = page.frameLocator('iframe[title="Preview"]');
      await expect(preview.locator("a.ob-home-button")).toHaveText("Read more");
      await expect(preview.locator('iframe[title="A short tour"][loading="lazy"]')).toHaveCount(1);
      await expect(preview.locator('figcaption a[href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]')).toBeVisible();
    });

    test("Add something inserts after the caret's block in Visual mode and shows as an editable piece", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, "First paragraph.\n\nLast paragraph.\n", [0, 0]);
      await mode(page, "Visual").click();
      await visual(page).locator("p").first().click({ position: { x: 4, y: 8 } });
      await page.getByRole("button", { name: "Add something" }).click();
      const dialog = page.getByRole("dialog", { name: "Add something" });
      await dialog.getByRole("button", { name: /^Opening hours/ }).click();
      await dialog.getByLabel("Days (required)").fill("Monday to Friday");
      await dialog.getByLabel("Hours (required)").fill("9am to 5pm");
      await dialog.getByRole("button", { name: "Add opening time" }).click();
      await dialog.getByLabel("Days (required)").nth(1).fill("Saturday");
      await dialog.getByLabel("Hours (required)").nth(1).fill("Closed");
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog).toBeHidden();
      const piece = visual(page).locator('section[aria-label="Piece block"]');
      await expect(piece).toHaveCount(1);
      await expect(visual(page)).toBeFocused();
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(
        "First paragraph.\n\n```piece hours\ndays: Monday to Friday\nhours: 9am to 5pm\ndays: Saturday\nhours: Closed\n```\n\nLast paragraph.\n",
      );
      // The piece can be edited with the same form.
      await mode(page, "Visual").click();
      await piece.getByRole("button", { name: "Edit piece" }).click();
      const form = piece.getByRole("group", { name: "Edit piece" });
      await form.getByLabel("Hours (required)").nth(1).fill("10am to 1pm");
      await form.getByRole("button", { name: "Apply" }).click();
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(/days: Saturday\nhours: 10am to 1pm\n```/);
    });

    test("the dialog works with Escape, restores focus and fits the phone width", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, "Untouched.", [2, 5]);
      await page.getByRole("button", { name: "Add something" }).click();
      const dialog = page.getByRole("dialog", { name: "Add something" });
      await dialog.getByRole("button", { name: /^Questions and answers/ }).click();
      const fits = await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= innerWidth);
      expect(fits).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(markdown(page)).toBeFocused();
      await expect(markdown(page)).toHaveValue("Untouched.");
      expect(await markdown(page).evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([2, 5]);
    });
  });
}
