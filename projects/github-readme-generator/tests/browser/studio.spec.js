import { test, expect } from "@playwright/test";
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}
async function library(page, name) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .locator(".library-grid")
    .getByRole("button", { name, exact: false })
    .click();
}
async function add(page) {
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
}
test.beforeEach(async ({ page }) => {
  await page.route("https://img.shields.io/**", (r) => {
    const name = decodeURIComponent(
      new URL(r.request().url()).pathname.split("/").at(-1),
    )
      .split("-")[0]
      .replace(/_/g, " ")
      .replace(/[<>&"]/g, "");
    return r.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${name.length * 7 + 20}" height="20"><rect width="100%" height="20" rx="3" fill="#6558d3"/><text x="10" y="14" fill="white" font-family="sans-serif" font-size="11">${name}</text></svg>`,
    });
  });
  await page.route("https://example.com/**", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="10" y="25">Example image</text></svg>',
    }),
  );
});
test("raw editing, sanitization, history, section preservation, autosave and download", async ({
  page,
}) => {
  await start(page);
  const raw =
    "# Hello 🌍\n\n<details><summary>More</summary>Yes</details>\n\n<script>window.compromised=true</script>\n\n![Missing]()";
  await editor(page).fill(raw);
  await expect(page.locator("github-preview h1")).toHaveText("Hello 🌍");
  expect(await page.evaluate(() => window.compromised)).toBeUndefined();
  await expect(page.locator(".save-status")).toHaveText("Saved locally");
  await page.reload();
  await expect(editor(page)).toHaveValue(raw);
  await library(page, "Divider");
  await add(page);
  await expect(editor(page)).toHaveValue(raw + "\n\n---");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue(raw);
  await page.getByRole("button", { name: "Health", exact: true }).click();
  await expect(page.locator("readme-health")).toContainText("Script tags");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export README" }).click();
  expect((await download).suggestedFilename()).toBe("README.md");
});
test("showcase acceptance journey through every major builder", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start from a template" })
    .click();
  await page
    .getByRole("button", { name: "Developer Showcase", exact: false })
    .click();
  await page.locator(".block-open").filter({ hasText: "Hero" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Alex Developer");
  await page
    .getByLabel("Introduction", { exact: true })
    .fill("I build useful tools.");
  await page.getByRole("button", { name: "Save section" }).click();
  await library(page, "Tech Stack");
  for (const name of ["React", "Node.js", "Rust"])
    await page
      .locator(".catalog")
      .getByRole("button", { name: new RegExp("^" + name.replace(".", "\\.")) })
      .click();
  await add(page);
  await expect(editor(page)).toHaveValue(/Node\.js/);
  await library(page, "Social Links");
  await page.getByRole("button", { name: "Add social link" }).click();
  await page
    .getByLabel("Destination", { exact: true })
    .selectOption("LinkedIn");
  await page
    .getByLabel("URL (https:// or mailto:)")
    .fill("https://linkedin.com/in/example");
  await page.getByRole("button", { name: "Add social link" }).click();
  await page
    .getByLabel("Destination", { exact: true })
    .nth(1)
    .selectOption("Portfolio");
  await page
    .getByLabel("URL (https:// or mailto:)")
    .nth(1)
    .fill("https://example.com");
  await add(page);
  await library(page, "Projects");
  for (const name of ["Project Alpha", "Project Beta"]) {
    await page.getByRole("button", { name: "Add project entry" }).click();
    await page.getByLabel("Project name", { exact: true }).last().fill(name);
    await page
      .getByLabel("Engineering highlights (one per line)")
      .last()
      .fill("Accessible by design\nWorks offline");
  }
  await add(page);
  await library(page, "Dynamic Widgets");
  await page
    .getByLabel("Image URL", { exact: true })
    .fill("https://example.com/constellation.svg");
  await add(page);
  await library(page, "Light / Dark Image");
  await page
    .getByLabel("Light image URL")
    .fill("https://example.com/light.svg");
  await page.getByLabel("Dark image URL").fill("https://example.com/dark.svg");
  await page.getByLabel("Alt text", { exact: true }).fill("My banner");
  await add(page);
  await expect(page.locator("github-preview")).toContainText("Alex Developer");
  await expect(page.locator("github-preview")).toContainText("Project Beta");
  await expect(page.locator("github-preview picture")).toHaveCount(1);
  await expect(editor(page)).toHaveValue(/constellation\.svg/);
  await page.getByLabel("Preview size").selectOption("375");
  await expect(page.locator(".preview-paper")).toHaveCSS("max-width", "375px");
  const md = await editor(page).inputValue();
  await editor(page).fill(md + "\n\nManual final touch.");
  await expect(page.locator(".save-status")).toHaveText("Saved locally");
  await page.reload();
  await expect(editor(page)).toHaveValue(md + "\n\nManual final touch.");
});
test("badge builder, row editing and theme preview", async ({ page }) => {
  await start(page);
  await library(page, "Badge Row");
  await page.getByRole("button", { name: "Add badge to row" }).click();
  await page.getByLabel("Label", { exact: true }).fill("Build");
  await page.getByLabel("Message", { exact: true }).fill("passing");
  await page.getByLabel("Dark mode background color").fill("111111");
  await page.getByRole("button", { name: "Duplicate entry" }).click();
  await expect(page.getByLabel("Label", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Remove entry" }).last().click();
  await add(page);
  await expect(editor(page)).toHaveValue(/prefers-color-scheme: dark/);
  await page
    .getByRole("button", { name: "Toggle preview color theme" })
    .click();
  await expect(page.locator("github-preview source")).toHaveAttribute(
    "media",
    "all",
  );
  await library(page, "Badge +");
  await page.getByLabel("Label", { exact: true }).fill("Status");
  await add(page);
  await expect(editor(page)).toHaveValue(/Status/);
});
test("GitHub import uses mock API, handles errors, and retains Markdown", async ({
  page,
}) => {
  await page.route("https://api.github.com/repos/**", (route) =>
    route.request().url().includes("missing")
      ? route.fulfill({ status: 404, body: "{}" })
      : route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            route.request().url().includes("/readme")
              ? {
                  path: "README.md",
                  sha: "abc",
                  size: Buffer.byteLength(
                    "# Imported\n\nOriginal  formatting.\n",
                  ),
                  encoding: "base64",
                  content: Buffer.from(
                    "# Imported\n\nOriginal  formatting.\n",
                  ).toString("base64"),
                }
              : { default_branch: "main" },
          ),
        }),
  );
  await start(page);
  await page
    .getByRole("button", { name: "Import", exact: false })
    .first()
    .click();
  await page.getByLabel("GitHub username or owner/repository").fill("missing");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(page.locator(".import-result")).toContainText(
    "Repository not found",
  );
  await page.getByLabel("GitHub username or owner/repository").fill("example");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page.getByRole("button", { name: "Import as new draft" }).click();
  await expect(editor(page)).toHaveValue(
    "# Imported\n\nOriginal  formatting.\n",
  );
  await expect(page.locator("github-preview h1")).toHaveText("Imported");
});
test("draft management and local file import", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page.getByLabel("Draft name").fill("Professional");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByLabel("Current draft")).toContainText("Professional");
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page
    .getByRole("button", { name: "Duplicate draft", exact: true })
    .click();
  await expect(page.getByLabel("Current draft")).toContainText(
    "Professional copy",
  );
  await page
    .getByRole("button", { name: "Import", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "Local file", exact: true }).click();
  await page.locator("#file-import").setInputFiles({
    name: "README.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Local file\n"),
  });
  await page.getByRole("button", { name: "Import as new draft" }).click();
  await expect(editor(page)).toHaveValue("# Local file\n");
});
test("mobile panes do not squeeze editor and preview together", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await expect(page.locator(".builder-pane")).toBeVisible();
  await expect(page.locator(".editor-pane")).not.toBeVisible();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Markdown", exact: true })
    .click();
  await editor(page).fill("# Mobile");
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await expect(page.locator("github-preview h1")).toHaveText("Mobile");
  await expect(page.locator(".editor-pane")).not.toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
test("large document stays editable and section splitting is lossless", async ({
  page,
}) => {
  await start(page);
  const md =
    "# Large\n\n" +
    "A paragraph with Unicode 🌍 and a [link](https://example.com).\n\n".repeat(
      1800,
    ) +
    "## Last\n\nKeep  spaces.\n";
  const latency = await page.evaluate(
    (markdown) =>
      new Promise((resolve) => {
        const start = performance.now();
        const preview = document.querySelector("github-preview");
        const observer = new MutationObserver(() => {
          if (preview.querySelector("h2")?.textContent === "Last") {
            observer.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - start));
          }
        });
        observer.observe(preview, { childList: true, subtree: true });
        const input = document.querySelector("markdown-editor textarea");
        input.value = markdown;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    md,
  );
  console.info(`100 KB preview update: ${Math.round(latency)}ms`);
  expect(latency).toBeLessThan(5000);
  await expect(
    page
      .locator("github-preview")
      .getByRole("heading", { name: "Last", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Split into sections", exact: true })
    .click();
  await page.locator("#apply-split").click();
  await expect(editor(page)).toHaveValue(md);
  await expect(page.locator(".block-row")).toHaveCount(2);
});
test("capture release workspace screenshots", async ({ page }) => {
  await start(page);
  await expect(page.locator("github-preview h1")).toBeVisible();
  if (test.info().project.name === "chromium")
    await page.screenshot({
      path: "docs/screenshots/studio-desktop.png",
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  if (test.info().project.name === "chromium")
    await page.screenshot({
      path: "docs/screenshots/studio-mobile.png",
      fullPage: true,
    });
});
test("raw block controls still work after repeated edits and keyboard reordering", async ({
  page,
}) => {
  await start(page);
  await editor(page).fill("# First edit");
  await editor(page).fill("# Second edit");
  await page.locator(".block-open").click();
  await expect(page.getByLabel("Custom Markdown", { exact: true })).toHaveValue(
    "# Second edit",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await library(page, "Divider");
  await add(page);
  await page
    .getByRole("button", { name: "Move Divider up", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveValue("---\n\n# Second edit");
});
