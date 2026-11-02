import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const editor = (p) =>
  p.getByRole("textbox", { name: "Markdown editor", exact: true });
test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", (r) => r.abort());
});
test("Worker failure falls back for Health and reviewed refactors without losing source", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw Error("Worker blocked for test");
      }
    };
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const source = "# Title\n\n### Details\n\nText";
  await editor(page).fill(source);
  await page.getByRole("button", { name: "Health", exact: true }).click();
  await expect(page.locator("readme-health .stats")).toBeVisible();
  await expect(page.locator("readme-health")).toHaveAttribute(
    "data-engine",
    "JavaScript",
  );
  await expect(editor(page)).toHaveValue(source);
  await page
    .getByRole("navigation", { name: "Workspace tools" })
    .getByRole("button", { name: "Safe refactors", exact: true })
    .click();
  await page.getByLabel(/Normalize heading hierarchy/).check();
  await page
    .getByRole("button", { name: "Review selected refactors", exact: true })
    .click();
  await expect(page.getByLabel("After refactor")).toHaveValue(
    "# Title\n\n## Details\n\nText",
  );
  await expect(editor(page)).toHaveValue(source);
  await page
    .getByRole("button", { name: "Apply reviewed refactors", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue(source);
});
for (const kb of [500, 1024])
  test(`${kb} KB preview, analysis, project serialization and export complete`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Explore the sample profile" })
      .click();
    const source =
      "# Large source\n\n" +
      "Text with **emphasis** and a local [link](#large-source).\n\n".repeat(
        Math.ceil((kb * 1024) / 58),
      );
    await page.evaluate((source) => {
      const input = document.querySelector("markdown-editor textarea");
      input.value = source;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, source);
    await expect(page.locator("github-preview h1")).toHaveText("Large source");
    await editor(page).press("End");
    await editor(page).press("!");
    await page.keyboard.press("Control+s");
    await page.getByRole("button", { name: "Health", exact: true }).click();
    await expect(page.locator("readme-health .stats")).toBeVisible({
      timeout: 60000,
    });
    const expected = await editor(page).inputValue();
    await page
      .getByRole("button", { name: "Save Studio project", exact: true })
      .click();
    const event = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download Studio project", exact: true })
      .click();
    const project = JSON.parse(
      readFileSync(await (await event).path(), "utf8"),
    );
    expect(project.document.markdown).toBe(expected);
  });
test("360px dialogs, search and exports remain keyboard reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands and content").fill("save studio");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Project file name")).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await editor(page).fill("# Mobile");
  const event = page.waitForEvent("download");
  await page.keyboard.press("Control+Shift+e");
  expect(readFileSync(await (await event).path(), "utf8")).toBe("# Mobile");
});
