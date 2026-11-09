import { test, expect } from "@playwright/test";

const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });

async function start(page, source) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await editor(page).fill(source);
  await expect(page.locator(".save-status")).toHaveText("Saved locally", {
    timeout: 5_000,
  });
  await page
    .locator('.workspace-tools [data-action="audience-review"]')
    .click();
}

test("audience evidence is advisory and analysis preserves source", async ({
  page,
}) => {
  const source =
    "# Tool\n\n## Usage\n\nRun it.\n\n## Installation\n\nInstall it.\n";
  await start(page, source);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Audience review" }),
  ).toBeVisible();
  await expect(dialog).toContainText("End user");
  await expect(dialog).toContainText("Observed");
  await expect(dialog).toContainText("Not detected");
  await expect(dialog.locator("[data-score], meter, progress")).toHaveCount(0);
  await expect(page.locator("markdown-editor textarea")).toHaveValue(source);
});

test("exact reviewed order applies once and Undo restores source", async ({
  page,
}) => {
  const source =
    "# Tool\n\n## Usage\n\nRun it.\n\n## Installation\n\nInstall it.\n";
  await start(page, source);
  const dialog = page.getByRole("dialog");
  const apply = dialog.getByRole("button", {
    name: "Apply reviewed section order",
  });
  await expect(apply).toBeDisabled();
  await dialog
    .getByLabel("I reviewed and approve this exact section order")
    .check();
  await apply.click();
  await expect(editor(page)).toHaveValue(
    "# Tool\n\n## Installation\n\nInstall it.\n## Usage\n\nRun it.\n\n",
  );
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(editor(page)).toHaveValue(source);
});

test("ambiguous hierarchy is refused and narrow layout does not overflow", async ({
  page,
}) => {
  const source = "# Tool\n\n## Usage\n\nOne.\n\n## Usage\n\nTwo.\n";
  await start(page, source);
  await page.setViewportSize({ width: 320, height: 700 });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("missing, repeated, or ambiguous");
  await expect(
    dialog.getByRole("button", { name: "Apply reviewed section order" }),
  ).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await expect(page.locator("markdown-editor textarea")).toHaveValue(source);
});

test("a stale draft cannot receive a previously reviewed order", async ({
  page,
}) => {
  const source =
    "# Tool\n\n## Usage\n\nRun it.\n\n## Installation\n\nInstall it.\n";
  await start(page, source);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("I reviewed and approve this exact section order")
    .check();
  const changed = `${source}\nLocal edit.`;
  await page.evaluate(
    (markdown) => document.querySelector("app-shell").store.raw(markdown),
    changed,
  );
  await dialog
    .getByRole("button", { name: "Apply reviewed section order" })
    .click();
  await expect(dialog.getByRole("status")).toContainText("draft changed", {
    ignoreCase: true,
  });
  await expect(page.locator("markdown-editor textarea")).toHaveValue(changed);
});
