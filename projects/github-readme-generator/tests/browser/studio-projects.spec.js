import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const remoteImage = (route) =>
  route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"/>',
  });
test.beforeEach(async ({ page }) => page.route("https://**/*", remoteImage));
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
test("portable project downloads, reopens in another browser and preserves source", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const source = "# Portable 🌍\n\n<!-- exact -->\n";
  await editor(page).fill(source);
  await page
    .getByRole("button", { name: "Save Studio project", exact: true })
    .click();
  await page.getByLabel("Project file name").fill("Portable example");
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download Studio project", exact: true })
    .click();
  const file = await event,
    raw = readFileSync(await file.path(), "utf8");
  expect(file.suggestedFilename()).toBe("Portable example.readme-studio.json");
  expect(JSON.parse(raw).document.markdown).toBe(source);
  const context = await browser.newContext();
  await context.route("https://**/*", remoteImage);
  const other = await context.newPage();
  await other.goto("/");
  await other
    .getByRole("dialog")
    .getByRole("button", { name: "Open Studio project" })
    .click();
  await other.getByLabel("Studio project file").setInputFiles({
    name: "portable.readme-studio.json",
    mimeType: "application/json",
    buffer: Buffer.from(raw),
  });
  await expect(
    other.getByRole("heading", { name: "Portable example", exact: true }),
  ).toBeVisible();
  await other
    .getByRole("button", { name: "Open as new draft", exact: true })
    .click();
  await expect(editor(other)).toHaveValue(source);
  await other.reload();
  await expect(editor(other)).toHaveValue(source);
  await context.close();
});
test("future and corrupted project metadata recover Markdown without replacing the current draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page
    .getByRole("button", { name: "Open Studio project", exact: true })
    .click();
  const raw = {
    schemaVersion: 999,
    name: "Future",
    document: { markdown: "# Future source\r\n" },
  };
  await page.getByLabel("Studio project file").setInputFiles({
    name: "future.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(raw)),
  });
  await expect(page.getByRole("dialog")).toContainText(
    "Unsupported project schema",
  );
  await page
    .getByRole("button", { name: "Open Markdown only", exact: true })
    .click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(editor(page)).toHaveValue("# Future source\n");
  expect(await page.locator("#draft-select option").count()).toBe(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});
