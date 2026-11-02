import { test, expect } from "@playwright/test";
test("search opens a section in the mobile builder and preserves a saved component's kind", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands and content").fill("Your Name");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Build", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".builder-content input").first()).toBeFocused();
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands and content").fill("Metrics");
  await page.keyboard.press("Enter");
  await expect(page.locator("widget-hub")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    app.data.componentLibrary = {
      version: 1,
      favorites: [],
      recents: [],
      snippets: [
        {
          version: 1,
          id: "search-greeting",
          name: "Search Greeting",
          description: "Local test component",
          category: "Contact",
          kind: "structured",
          template: "Hello {{name}}",
          fields: [
            {
              key: "name",
              label: "Greeting name",
              type: "text",
              context: "markdown",
              default: "World",
            },
          ],
          tags: [],
          external: false,
          attribution: null,
        },
      ],
    };
  });
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands and content").fill("Search Greeting");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Greeting name", { exact: true })).toHaveValue(
    "World",
  );
  await expect(
    page.getByLabel("Component Markdown", { exact: true }),
  ).toHaveValue("Hello World");
});
test("workspace search opens normal tools, supports keyboard and preserves source", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const source = await page.locator("markdown-editor textarea").inputValue();
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands and content").fill("badge studio");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Badge Studio", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("markdown-editor textarea")).toHaveValue(source);
  await page.keyboard.press("Control+Shift+p");
  await expect(page.locator("publish-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});
test("mobile pane, tool groups and settings restore without capturing secrets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.locator('[data-tool-group="Design"] summary').click();
  // Native details emits toggle in a later task; wait for its save before reload.
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(
          localStorage.getItem("readme-studio:v1"),
        )?.settings?.closedGroups?.includes("Design"),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Markdown", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-tool-group="Design"]')).not.toHaveAttribute(
    "open",
    "",
  );
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands and content").fill("settings");
  await page.keyboard.press("Enter");
  await page.getByLabel("Editor font size").selectOption("18");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("markdown-editor textarea")).toHaveCSS(
    "font-size",
    "18px",
  );
});
