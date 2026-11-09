import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
});
test("project selection changes recommendations without rewriting source and CLI flags reopen", async ({
  page,
}) => {
  const source = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.markdown,
  );
  await page.getByLabel("Documentation project type").selectOption("cli");
  await expect(page.getByLabel("Documentation project type")).toBeFocused();
  await expect(page.locator("[data-recommended]")).toContainText(
    "CLI Reference",
  );
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);
  await page.locator('[data-block-type="doc-cli"]').click();
  await page
    .getByLabel("Command syntax", { exact: true })
    .fill("tool [options]");
  await page.getByRole("button", { name: "Add flag or option" }).click();
  await page.getByLabel("Flag or option", { exact: true }).fill("--verbose");
  await page
    .getByLabel("Option description", { exact: true })
    .fill("Print details");
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  await page
    .locator(".block-open")
    .filter({ hasText: "CLI Reference" })
    .click();
  await expect(page.getByLabel("Flag or option", { exact: true })).toHaveValue(
    "--verbose",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByLabel("Documentation project type")).toHaveValue(
    "cli",
  );
});
test("API endpoint fields and parameter rows produce editable Markdown", async ({
  page,
}) => {
  await page.getByLabel("Documentation project type").selectOption("api");
  await page.locator('[data-block-type="doc-endpoint"]').click();
  await expect(page.locator("builder-form")).toContainText("never real tokens");
  await page.getByLabel("HTTP method", { exact: true }).fill("GET");
  await page.getByLabel("Endpoint path", { exact: true }).fill("/items/{id}");
  await page
    .getByLabel("Request example", { exact: true })
    .fill("GET /items/123 HTTP/1.1");
  await page
    .getByLabel("Response example", { exact: true })
    .fill("HTTP/1.1 200 OK");
  await page.getByRole("button", { name: "Add parameter" }).click();
  await page.getByLabel("Parameter name", { exact: true }).fill("id");
  await page.getByLabel("Parameter location", { exact: true }).fill("path");
  await page.getByLabel("Required", { exact: true }).check();
  await page.getByLabel("Parameter type", { exact: true }).fill("string");
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toContain("| id | path | Yes | string |");
});
test("game screenshots require alt text and controls work at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByLabel("Documentation project type").selectOption("game");
  await expect(page.locator("[data-recommended]")).toContainText(
    "Save and Data Behavior",
  );
  await page.locator('[data-block-type="doc-screenshots"]').click();
  await page.getByRole("button", { name: "Add screenshot" }).click();
  await page.getByLabel("Image URL or repository path").fill("images/game.png");
  await expect(
    page.getByRole("button", { name: "Add to README", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Screenshot alt text")
    .fill("Puzzle board with three tiles");
  await expect(
    page.getByRole("button", { name: "Add to README", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toContain("![Puzzle board with three tiles](images/game.png)");
});
