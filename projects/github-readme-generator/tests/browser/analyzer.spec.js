import { test, expect } from "@playwright/test";
test("Health views and source jumps preserve source and work by keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const source = "# Title\n\n### Skipped\n\n![](local.svg)";
  await editor.fill(source);
  await page.getByRole("button", { name: "Health", exact: true }).click();
  const health = page.locator("readme-health");
  await health.getByLabel("Analysis view").selectOption("Structure");
  await expect(health).toContainText("Heading level jumps");
  const jump = health
    .getByRole("button", { name: "Go to line 3, column 1" })
    .first();
  await jump.focus();
  await page.keyboard.press("Enter");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(source);
  expect(await editor.evaluate((e) => e.selectionStart)).toBe(
    source.indexOf("###"),
  );
});

test("repeated analysis preserves the focused issue control", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .fill("# Title\n\n### Skipped");
  await page.getByRole("button", { name: "Health", exact: true }).click();
  const health = page.locator("readme-health");
  await health.getByLabel("Analysis view").selectOption("Structure");
  const jump = health
    .getByRole("button", { name: "Go to line 3, column 1" })
    .first();
  await jump.focus();
  await health.evaluate((el) => el.display(el.analysis));
  await expect(jump).toBeFocused();
  await jump.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toBeFocused();
});

test("Health falls back when the optional WASM asset fails", async ({
  page,
}) => {
  await page.route("**/*.wasm", (route) => route.abort());
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill("# Fallback\n\n### Heading");
  await page.getByRole("button", { name: "Health", exact: true }).click();
  await expect(page.locator("readme-health")).toHaveAttribute(
    "data-engine",
    "JavaScript",
  );
  await expect(page.locator("readme-health")).toContainText(
    "Heading level jumps",
  );
  await expect(editor).toHaveValue("# Fallback\n\n### Heading");
});
test("Health loads the optional local WASM core", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Health", exact: true }).click();
  await expect(page.locator("readme-health")).toHaveAttribute(
    "data-engine",
    "WASM",
  );
});

test("Compatibility Lab explains risks, filters and jumps without changing source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const source =
    '# Title\n\n<script>alert(1)</script>\n\n<picture><source srcset="dark.svg"></picture>';
  await editor.fill(source);
  await page.getByRole("button", { name: "Health", exact: true }).click();
  await page
    .getByRole("button", { name: "GitHub Compatibility", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Compatibility view").selectOption("Unsafe");
  await expect(dialog).toContainText("Executable content");
  const jump = dialog
    .getByRole("button", { name: "Go to line 3, column 1" })
    .first();
  await jump.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(source);
  expect(await editor.evaluate((e) => e.selectionStart)).toBe(
    source.indexOf("<script>"),
  );
});
