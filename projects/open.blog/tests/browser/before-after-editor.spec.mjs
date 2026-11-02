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

// The real Admin Studio: Add something offers Before and after, takes two pictures (typed or chosen) with
// their descriptions, shows the engine's refusals inside the dialog, and writes the `compare` fence in both
// editor modes, at 400px and on a desktop (ADR 0291, #498).

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-compare-editor-"));
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

const fits = (dialog) =>
  dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= innerWidth + 1);

for (const [name, viewport] of [["phone at 400px", { width: 400, height: 800 }], ["desktop", { width: 1280, height: 800 }]]) {
  test.describe(name, () => {
    test.use({ viewport });

    test("Before and after is added in Markdown mode, with errors shown inline and a chosen file", async ({ page }) => {
      await openNewPost(page);
      await page.getByRole("textbox", { name: "Title", exact: true }).fill("Floor");
      await useMarkdown(page, "First paragraph.\n\nLast paragraph.\n", [16, 16]);
      await page.getByRole("button", { name: "Add something" }).click();
      const dialog = page.getByRole("dialog", { name: "Add something" });
      const choice = dialog.getByRole("button", { name: /^Before and after/ });
      await expect(choice).toBeVisible();
      expect((await choice.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await choice.click();
      await expect(dialog.getByRole("heading", { name: "Before and after", level: 3 })).toBeVisible();

      // Nothing filled in: the engine says what is missing, in the dialog, and the draft is untouched.
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog.getByRole("alert")).toContainText("the before picture is missing");
      await expect(dialog.getByRole("alert")).toContainText("the after picture is missing");
      await expect(markdown(page)).toHaveValue("First paragraph.\n\nLast paragraph.\n");

      // Pictures: one chosen from disk (uploaded by Admin), one typed.
      await dialog.locator('input[data-picture-for="before"]').setInputFiles({ name: "floor-before.png", mimeType: "image/png", buffer: PNG });
      await expect(dialog.getByLabel("Before picture (required)")).toHaveValue(/^\/images\/.*floor-before.*\.png$/);
      await dialog.getByLabel("After picture (required)").fill("/images/floor-after.png");
      await dialog.getByLabel("Before description (required)").fill("The old floor, stained along the door");
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog.getByRole("alert")).toContainText("the after picture needs a description");
      await expect(dialog.getByRole("alert")).not.toContainText("before picture");
      await expect(markdown(page)).toHaveValue("First paragraph.\n\nLast paragraph.\n");
      expect(await fits(dialog)).toBe(true);

      await dialog.getByLabel("After description (required)").fill("The same floor, sanded and sealed");
      await dialog.getByLabel("After caption").fill("Finished");
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog).toBeHidden();
      await expect(markdown(page)).toHaveValue(
        /^First paragraph\.\n\n```compare\nbefore: \/images\/.*floor-before.*\.png\nbefore-alt: The old floor, stained along the door\nafter: \/images\/floor-after\.png\nafter-alt: The same floor, sanded and sealed\nafter-caption: Finished\n```\n\nLast paragraph\.\n$/,
      );
      await expect(markdown(page)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    });

    test("in Visual mode the pair is an editable block that keeps its fence", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, "First paragraph.\n\nLast paragraph.\n", [0, 0]);
      await mode(page, "Visual").click();
      await visual(page).locator("p").first().click({ position: { x: 4, y: 8 } });
      await page.getByRole("button", { name: "Add something" }).click();
      const dialog = page.getByRole("dialog", { name: "Add something" });
      await dialog.getByRole("button", { name: /^Before and after/ }).click();
      await dialog.getByLabel("Before picture (required)").fill("/images/a.png");
      await dialog.getByLabel("Before description (required)").fill("A");
      await dialog.getByLabel("After picture (required)").fill("/images/b.png");
      await dialog.getByLabel("After description (required)").fill("B");
      await dialog.getByRole("button", { name: "Insert" }).click();
      await expect(dialog).toBeHidden();
      const block = visual(page).locator('section[aria-label="Before and after block"]');
      await expect(block).toHaveCount(1);
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(
        "First paragraph.\n\n```compare\nbefore: /images/a.png\nbefore-alt: A\nafter: /images/b.png\nafter-alt: B\n```\n\nLast paragraph.\n",
      );
      await mode(page, "Visual").click();
      await block.getByRole("button", { name: "Edit before and after" }).click();
      const form = block.getByRole("group", { name: "Edit before and after" });
      await form.getByLabel("After caption").fill("Done");
      await form.getByRole("button", { name: "Apply" }).click();
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(/after-alt: B\nafter-caption: Done\n```/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    });
  });
}
