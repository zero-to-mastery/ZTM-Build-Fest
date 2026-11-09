import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
const current =
  "# Hello\n\nLocal introduction.\n\n## About\n\nKeep local.\n\n## Stats\n\n![Snake](./snake.svg)\n";
const remote =
  "# Hello\n\nRemote introduction.\n\n## About Me\n\nKeep local.\n\n## Stats\n\n![Snake](./snake.svg)\n";
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}
async function open(page) {
  await page.locator(".workspace-tools [data-action=import]").click();
}
async function local(page, markdown, mode = "new", backup = false) {
  await open(page);
  await page
    .getByRole("button", {
      name: backup ? "Studio backup" : "Local file",
      exact: true,
    })
    .click();
  await page.getByLabel("Import mode", { exact: true }).selectOption(mode);
  await page.locator("#file-import").setInputFiles({
    name: backup ? "draft.json" : "README.md",
    mimeType: backup ? "application/json" : "text/markdown",
    buffer: Buffer.from(markdown),
  });
  await expect(
    page.getByRole("heading", { name: "README found", exact: true }),
  ).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("https://api.github.com/"))
      return route.fulfill({ status: 500, body: "{}" });
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" />',
    });
  });
});
test("GitHub import, exact export, split, re-import merge, undo and source versions", async ({
  page,
}) => {
  let content = current,
    sha = "one";
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/readme")
        ? {
            path: "docs/README.MD",
            sha,
            size: Buffer.byteLength(content),
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          }
        : { default_branch: "main" },
    }),
  );
  await start(page);
  const before = await editor(page).inputValue();
  await open(page);
  await page
    .getByLabel("GitHub username or owner/repository")
    .fill("https://github.com/ada/tools");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "README found" }),
  ).toBeFocused();
  await expect(editor(page)).toHaveValue(before);
  await expect(page.locator(".import-review")).toContainText("3 headings");
  await expect(page.getByLabel("Import mode", { exact: true })).toHaveValue(
    "new",
  );
  await page.getByRole("button", { name: "Import as new draft" }).click();
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveValue(current);
  await expect(page.locator("github-preview img")).toHaveAttribute(
    "src",
    "https://raw.githubusercontent.com/ada/tools/main/docs/snake.svg",
  );
  // The Next steps panel offers the same split; use the builder's button.
  await page
    .getByRole("complementary", { name: "Builder" })
    .getByRole("button", { name: "Split into sections", exact: true })
    .click();
  await page.getByLabel("Split by").selectOption("h1");
  await expect(page.locator("#split-summary p")).toHaveCount(1);
  await page.getByLabel("Split by").selectOption("both");
  await page.locator("#apply-split").click();
  await expect(page.locator(".block-row")).toHaveCount(3);
  await expect(editor(page)).toHaveValue(current);
  await page
    .getByRole("button", { name: "Re-import current GitHub README" })
    .click();
  await expect(page.locator(".import-result")).toHaveText("No remote changes");
  await expect(page.getByLabel("Import mode", { exact: true })).toHaveValue(
    "merge",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  content = remote;
  sha = "two";
  await page
    .getByRole("button", { name: "Re-import current GitHub README" })
    .click();
  await expect(page.locator(".import-result")).toHaveText(
    "Remote README has changed",
  );
  await expect(page.locator(".merge-body")).toContainText("Possible duplicate");
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  await expect(page.locator(".import-result")).toContainText(
    "Choose an action for every",
  );
  await page
    .getByLabel("Action for imported section 1", { exact: true })
    .selectOption("use");
  await page
    .getByLabel("Target for imported section 1", { exact: true })
    .selectOption("0");
  await page
    .getByLabel("Action for imported section 2", { exact: true })
    .selectOption("keep");
  await page
    .getByLabel("Action for imported section 3", { exact: true })
    .selectOption("keep");
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Resulting Markdown" }),
  ).toBeFocused();
  await expect(editor(page)).toHaveValue(current);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByLabel("Action for imported section 1", { exact: true }),
  ).toHaveValue("use");
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  if (test.info().project.name === "chromium")
    await page.screenshot({ path: "docs/screenshots/import-merge.png" });
  await page.getByRole("button", { name: "Apply merge", exact: true }).click();
  const merged = current.replace("Local introduction.", "Remote introduction.");
  await expect(editor(page)).toHaveValue(merged);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue(current);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(editor(page)).toHaveValue(merged);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export README" }).click();
  const download = await pending;
  expect(readFileSync(await download.path(), "utf8")).toBe(merged);
  await page.reload();
  await expect(editor(page)).toHaveValue(merged);
  await expect(page.locator("github-preview img")).toHaveAttribute(
    "src",
    "https://raw.githubusercontent.com/ada/tools/main/docs/snake.svg",
  );
});
test("local replacement requires confirmation; append and replace undo in one step", async ({
  page,
}) => {
  await start(page);
  await editor(page).fill("## Original\nKeep me");
  await local(page, "## Local\n![Local](./missing.png)", "replace");
  await page
    .getByRole("button", { name: "Replace current draft", exact: true })
    .click();
  await expect(
    page.getByLabel("I confirm replacing the current draft"),
  ).toBeFocused();
  await expect(editor(page)).toHaveValue("## Original\nKeep me");
  await page.getByLabel("I confirm replacing the current draft").check();
  await page
    .getByRole("button", { name: "Replace current draft", exact: true })
    .click();
  await expect(page.locator("github-preview")).toContainText(
    "Relative image cannot be previewed",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue("## Original\nKeep me");
  await local(page, "## Appended\nexact  text", "append");
  await page
    .getByRole("button", { name: "Append to current draft", exact: true })
    .click();
  await expect(editor(page)).toHaveValue(
    "## Original\nKeep me\n\n## Appended\nexact  text",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue("## Original\nKeep me");
});
test("Studio backup preserves blocks, source metadata and generated ownership", async ({
  page,
}) => {
  await start(page);
  const md = "## Stats\n\nOwned snapshot";
  const backup = {
    name: "Backup",
    markdown: md,
    metadata: {
      importSource: {
        type: "github",
        owner: "ada",
        repository: "tools",
        ref: "main",
        readmePath: "README.md",
        sha: "one",
      },
      githubProfile: { login: "ada", sections: { stats: true } },
    },
    blocks: [
      {
        id: "old",
        type: "custom",
        settings: { markdown: md },
        profileAutofill: { kind: "stats", markdown: md },
      },
    ],
  };
  await local(page, JSON.stringify(backup), "new", true);
  await page.getByRole("button", { name: "Import as new draft" }).click();
  await expect(
    page.getByRole("button", { name: "Re-import current GitHub README" }),
  ).toBeVisible();
  const saved = await page.evaluate(
    () => document.querySelector("app-shell").store.draft,
  );
  expect(saved.metadata).toEqual(backup.metadata);
  expect(saved.blocks[0].profileAutofill).toEqual(
    backup.blocks[0].profileAutofill,
  );
  expect(saved.blocks[0].id).not.toBe("old");
});
test("changed draft rejects obsolete import review without overwriting edits", async ({
  page,
}) => {
  await start(page);
  await local(page, "# Imported", "append");
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Newer edit"),
  );
  await page
    .getByRole("button", { name: "Append to current draft", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("draft changed");
  await expect(editor(page)).toHaveValue("# Newer edit");
});
test("keyboard merge decisions, local anchors and mobile layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await local(page, "# Title\n[Jump](#usage)\n\n## Usage\nText");
  await page.getByRole("button", { name: "Import as new draft" }).click();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  const anchor = page.locator("github-preview a");
  await expect(anchor).toHaveAttribute("href", "#usage");
  await anchor.click();
  await expect(page).toHaveURL(/\/$/);
  await local(page, "## Usage\nNew text", "merge");
  const choice = page.getByLabel("Action for imported section 1", {
    exact: true,
  });
  await choice.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(choice).toHaveValue("keep");
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Resulting Markdown" }),
  ).toBeFocused();
  expect(
    await page
      .locator("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog")).not.toBeVisible();
});
test("source input changes cancel stale requests and closing aborts a pending import", async ({
  page,
}) => {
  let pending;
  await page.route("https://api.github.com/repos/**", async (route) => {
    await new Promise((resolve) => (pending = resolve));
    await route.fulfill({ json: { default_branch: "main" } }).catch(() => {});
  });
  await start(page);
  await open(page);
  const input = page.getByLabel("GitHub username or owner/repository");
  await input.fill("ada");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(page.locator(".import-result")).toHaveText("Fetching README…");
  await expect.poll(() => !!pending).toBe(true);
  await input.fill("different");
  pending();
  await expect(page.locator(".import-review")).toBeEmpty();
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog")).not.toBeVisible();
  pending?.();
});
