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
    .locator('.workspace-tools [data-action="learning-studio"]')
    .click();
}

test("lessons explain bounded evidence without changing README source", async ({
  page,
}) => {
  const source =
    "# Tool\n\n## Usage\n\nRun it.\n\n## Usage examples\n\nMore.\n";
  await start(page, source);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Learning studio" }),
  ).toBeVisible();
  await dialog.getByLabel("Project type").selectOption("cli");
  await expect(dialog).toContainText("Unknown");
  await expect(dialog).toContainText("Not detected");
  await expect(dialog).toContainText("runtime behavior remain Unknown");
  await expect(dialog.getByLabel("Synthetic before")).not.toHaveValue("");
  await expect(dialog.getByLabel("Synthetic after")).not.toHaveValue("");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);
});

test("practice opens the exact observed heading in the real editor", async ({
  page,
}) => {
  const source =
    "# Tool\n\n## Installation\n\nInstall it.\n\n## Usage\n\nRun it.\n";
  await start(page, source);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project type").selectOption("cli");
  await dialog
    .locator('[data-lesson="usage"]')
    .getByRole("button", { name: "Practice in Markdown editor" })
    .click();
  await expect(dialog).toBeHidden();
  await expect(editor(page)).toBeFocused();
  const selection = await editor(page).evaluate((input) => ({
    value: input.value,
    selected: input.value.slice(input.selectionStart, input.selectionEnd),
  }));
  expect(selection).toEqual({ value: source, selected: "## Usage" });
  await expect(page.locator(".toast")).toContainText("No text was inserted");
});

test("checklist progress survives reload and exports ordinary Markdown", async ({
  page,
}) => {
  const source = "# Tool\n\n## Installation\n\nInstall it.\n";
  await start(page, source);
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project type").selectOption("cli");
  await dialog.getByLabel(/Explain installation/).check();
  await expect(dialog.getByRole("status")).toContainText("1/3");
  await page.reload();
  await expect(editor(page)).toHaveValue(source);
  await page
    .locator('.workspace-tools [data-action="learning-studio"]')
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project type").selectOption("cli");
  await expect(dialog.getByLabel(/Explain installation/)).toBeChecked();
  const downloadPromise = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Download ordinary Markdown checklist" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("cli-readme-checklist.md");
  await expect(editor(page)).toHaveValue(source);
});

test("corrupt progress fails safely and 320px layout does not overflow", async ({
  page,
}) => {
  const source = "# Tool\n";
  await start(page, source);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() =>
    localStorage.setItem("readme-studio-learning-progress-v1", "not-json"),
  );
  await page
    .locator('.workspace-tools [data-action="learning-studio"]')
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("unreadable");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);
});
