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

// The real Admin Studio: callouts, tables, task lists, embeds and pieces are edited with forms in
// the Visual editor, at phone and desktop sizes (ADR 0254, #332).

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
  await expect(page.getByRole("button", { name: "Cite a source" })).toBeVisible();
}

const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });
const visual = (page) => page.getByRole("textbox", { name: "Visual editor" });
const mode = (page, name) => page.getByRole("button", { name, exact: true });

async function useMarkdown(page, text, selection = [text.length, text.length]) {
  await mode(page, "Markdown").click();
  await markdown(page).fill(text);
  await markdown(page).evaluate((element, [start, end]) => element.setSelectionRange(start, end), selection);
}

const DRAFT = [
  "Intro paragraph.",
  "> [!NOTE]\n> Remember the salt.",
  "| Name | Qty |\n| :--- | ---: |\n| Flour | 2 |",
  "- [ ] Buy flour\n- [x] Preheat",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "```piece hours\nnote: Closed on holidays.\ndays: Mon\nhours: 9 to 5\n```",
  "```quiz\nWhich?\n- [x] This\n- [ ] That\n```",
  "<div class=\"raw\">raw html</div>",
  "End.",
].join("\n\n") + "\n";

for (const [name, viewport] of [["phone", { width: 320, height: 640 }], ["desktop", { width: 1280, height: 800 }]]) {
  test.describe(name, () => {
    test.use({ viewport });

    test("unedited blocks round-trip byte for byte and each editable one announces its type", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, DRAFT, [0, 0]);
      await mode(page, "Visual").click();
      for (const type of ["Callout", "Table", "Task list", "Embedded media", "Piece"]) {
        const card = visual(page).locator(`section[aria-label="${type} block"]`);
        await expect(card).toHaveCount(1);
        await expect(card.getByRole("button", { name: `Edit ${type.toLowerCase()}`, exact: true })).toBeVisible();
      }
      // A knowledge check and raw HTML stay protected with no form.
      await expect(visual(page).locator('section[aria-label="Knowledge check block"] [data-block-edit]')).toHaveCount(0);
      await expect(visual(page).locator('section[aria-label="Raw HTML block"] [data-block-edit]')).toHaveCount(0);
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(DRAFT);
    });

    test("a callout, a task list and an embed are edited with forms and write the Markdown they use today", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, DRAFT, [0, 0]);
      await mode(page, "Visual").click();

      const callout = visual(page).locator('section[aria-label="Callout block"]');
      await callout.getByRole("button", { name: "Edit callout" }).click();
      const form = callout.getByRole("group", { name: "Edit callout" });
      await expect(form.getByLabel("Kind of callout")).toBeFocused();
      await form.getByLabel("Kind of callout").selectOption("WARNING");
      await form.getByLabel("Callout text").fill("Hot pan.\n\nReally hot.");
      await form.getByRole("button", { name: "Apply" }).click();
      await expect(callout.getByRole("button", { name: "Edit callout" })).toBeFocused();

      const tasks = visual(page).locator('section[aria-label="Task list block"]');
      await tasks.getByRole("button", { name: "Edit task list" }).click();
      const taskForm = tasks.getByRole("group", { name: "Edit task list" });
      await taskForm.getByLabel("Item 1 done").check();
      await taskForm.getByRole("button", { name: "Add item" }).click();
      await page.keyboard.type("Rest the dough");
      await taskForm.getByRole("button", { name: "Remove item 2" }).click();
      await expect(taskForm.getByRole("status")).toContainText("Item 2 removed.");
      await taskForm.getByRole("button", { name: "Apply" }).click();

      const embed = visual(page).locator('section[aria-label="Embedded media block"]');
      await embed.getByRole("button", { name: "Edit embedded media" }).click();
      const embedForm = embed.getByRole("group", { name: "Edit embedded media" });
      await embedForm.getByLabel("Embed from").selectOption("codepen");
      await embedForm.getByRole("button", { name: "Apply" }).click();
      await expect(embedForm.getByRole("alert")).toContainText("not a CodePen address");
      await embedForm.getByLabel("Address").fill("https://codepen.io/ada/pen/abc123");
      await embedForm.getByRole("button", { name: "Apply" }).click();

      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(
        DRAFT
          .replace("> [!NOTE]\n> Remember the salt.", "> [!WARNING]\n> Hot pan.\n>\n> Really hot.")
          .replace("- [ ] Buy flour\n- [x] Preheat", "- [x] Buy flour\n- [ ] Rest the dough")
          .replace("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://codepen.io/ada/pen/abc123"),
      );
    });

    test("a table gains and loses rows and columns from the keyboard", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, DRAFT, [0, 0]);
      await mode(page, "Visual").click();
      const table = visual(page).locator('section[aria-label="Table block"]');
      await table.getByRole("button", { name: "Edit table" }).click();
      const form = table.getByRole("group", { name: "Edit table" });
      await form.getByRole("button", { name: "Add column" }).click();
      await page.keyboard.type("Note");
      await form.getByRole("button", { name: "Add row" }).click();
      await page.keyboard.type("Salt");
      await form.getByLabel("Row 2, column 2").fill("1");
      await form.getByLabel("Row 2, column 3").fill("a|b");
      await form.getByRole("button", { name: "Remove row 1" }).click();
      await expect(form.getByRole("status")).toContainText("Row 1 removed.");
      // The form never overflows the phone-width page.
      const fits = await table.evaluate((card) => card.scrollWidth <= card.clientWidth + 1);
      expect(fits).toBe(true);
      await form.getByRole("button", { name: "Apply" }).click();
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(
        DRAFT.replace("| Name | Qty |\n| :--- | ---: |\n| Flour | 2 |", "| Name | Qty | Note |\n| :--- | ---: | --- |\n| Salt | 1 | a\\|b |"),
      );
    });

    test("cancel and an unchanged Apply leave the draft exactly as it was", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, DRAFT, [0, 0]);
      await mode(page, "Visual").click();
      const callout = visual(page).locator('section[aria-label="Callout block"]');
      await callout.getByRole("button", { name: "Edit callout" }).click();
      await callout.getByLabel("Callout text").fill("changed");
      await page.keyboard.press("Escape");
      await expect(callout.getByRole("button", { name: "Edit callout" })).toBeFocused();
      await callout.getByRole("button", { name: "Edit callout" }).click();
      await callout.getByRole("button", { name: "Apply" }).click();
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(DRAFT);
    });

    test("sources the forms would rewrite stay protected, and a piece Apply with no change keeps its bytes", async ({ page }) => {
      const odd = [
        "|a|b|\n|---|---|\n|1|2|",
        "* [ ] star item",
        "```piece hours\nnote: x\nbogus: y\n```",
        "```piece hours\nnote:   spaced   \ndays: Mon\nhours: 9 to 5\n```",
        "> [!NOTE]\n> Fine.",
        "End.",
      ].join("\n\n") + "\n";
      await openNewPost(page);
      await useMarkdown(page, odd, [0, 0]);
      await mode(page, "Visual").click();
      await expect(visual(page).locator('section[aria-label="Table block"] [data-block-edit]')).toHaveCount(0);
      await expect(visual(page).locator('section[aria-label="Task list block"] [data-block-edit]')).toHaveCount(0);
      const pieces = visual(page).locator('section[aria-label="Piece block"]');
      await expect(pieces).toHaveCount(2);
      await expect(pieces.nth(0).locator("[data-block-edit]")).toHaveCount(0);
      await pieces.nth(1).getByRole("button", { name: "Edit piece" }).click();
      await pieces.nth(1).getByRole("button", { name: "Apply" }).click();
      await mode(page, "Markdown").click();
      await expect(markdown(page)).toHaveValue(odd);
    });

    test("HTML typed into a callout is refused with a message", async ({ page }) => {
      await openNewPost(page);
      await useMarkdown(page, "> [!NOTE]\n> Fine.\n", [0, 0]);
      await mode(page, "Visual").click();
      const callout = visual(page).locator('section[aria-label="Callout block"]');
      await callout.getByRole("button", { name: "Edit callout" }).click();
      await callout.getByLabel("Callout text").fill("<script>alert(1)</script>");
      await callout.getByRole("button", { name: "Apply" }).click();
      await expect(callout.getByRole("alert")).toContainText("HTML tags are not allowed");
    });
  });
}
