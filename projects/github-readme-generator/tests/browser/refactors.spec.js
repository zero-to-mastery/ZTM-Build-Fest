import { test, expect } from "@playwright/test";
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
async function start(page, source) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await editor(page).fill(source);
}
async function open(page) {
  await page.getByRole("button", { name: "Health", exact: true }).click();
  await page
    .getByRole("button", { name: "Safe refactors", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Review selected refactors",
      exact: true,
    }),
  ).toBeEnabled();
  return page.getByRole("dialog");
}
test("refactors require a combined diff, preserve cancel, apply once and undo", async ({
  page,
}) => {
  const source = "# Title\n\n### Heading\n\n![](local.svg)";
  await start(page, source);
  let dialog = await open(page);
  await dialog.getByLabel(/Normalize heading hierarchy/).check();
  await dialog.getByLabel(/Add alt-text placeholders/).check();
  await dialog
    .getByRole("button", { name: "Review selected refactors", exact: true })
    .click();
  await expect(dialog.getByLabel("Before refactor")).toHaveValue(source);
  await expect(dialog.getByLabel("After refactor")).toHaveValue(
    "# Title\n\n## Heading\n\n![TODO: describe image](local.svg)",
  );
  await expect(dialog.getByLabel("Refactor diff")).toContainText(
    "Normalize heading hierarchy",
  );
  await expect(editor(page)).toHaveValue(source);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor(page)).toHaveValue(source);
  dialog = await open(page);
  await dialog.getByLabel(/Normalize heading hierarchy/).check();
  await dialog.getByLabel(/Add alt-text placeholders/).check();
  await dialog
    .getByRole("button", { name: "Review selected refactors", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Apply reviewed refactors", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(editor(page)).toHaveValue(/## Heading/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue(source);
});
test("overlapping fixes require sequential review and stale drafts cannot apply", async ({
  page,
}) => {
  await start(page, "# Title\n\n### Empty\n");
  const dialog = await open(page);
  await dialog.getByLabel(/Normalize heading hierarchy/).check();
  await dialog.getByLabel(/Remove empty headings and sections/).check();
  await dialog
    .getByRole("button", { name: "Review selected refactors", exact: true })
    .click();
  await expect(dialog.locator("[data-status]")).toContainText("overlap");
  await expect(
    dialog.getByRole("button", { name: "Apply reviewed refactors" }),
  ).not.toBeVisible();
  await dialog.getByLabel(/Remove empty headings and sections/).uncheck();
  await dialog
    .getByRole("button", { name: "Review selected refactors", exact: true })
    .click();
  await expect(dialog.getByLabel("After refactor")).toBeVisible();
  await page
    .locator("app-shell")
    .evaluate((app) => app.store.raw("# New source"));
  await dialog
    .getByRole("button", { name: "Apply reviewed refactors" })
    .click();
  await expect(dialog.locator("[data-status]")).toContainText("draft changed");
  await expect(editor(page)).toHaveValue("# New source");
});
test("offline refactor review fits 320px and selection changes invalidate the diff", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await editor(page).fill("# Title\n\n### Heading\n\nText");
  let dialog = await open(page);
  await dialog.getByLabel(/Normalize heading hierarchy/).check();
  await dialog
    .getByRole("button", { name: "Review selected refactors" })
    .click();
  await expect(dialog.getByLabel("After refactor")).toBeVisible();
  await context.setOffline(true);
  await dialog.getByLabel("Badge row output").selectOption("center");
  await expect(
    dialog.getByRole("button", { name: "Apply reviewed refactors" }),
  ).not.toBeVisible();
  await dialog
    .getByRole("button", { name: "Review selected refactors" })
    .click();
  await expect(dialog.getByLabel("After refactor")).toBeVisible();
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await dialog
    .getByRole("button", { name: "Apply reviewed refactors" })
    .click();
  await expect(editor(page)).toHaveValue("# Title\n\n## Heading\n\nText");
});
test("changing badge output mode refreshes eligibility without losing selections", async ({
  page,
}) => {
  const source =
    "![A](https://img.shields.io/badge/A-blue) ![B](https://img.shields.io/badge/B-red)";
  await start(page, source);
  const dialog = await open(page);
  await expect(dialog.getByLabel(/Consolidate badge rows/)).toBeDisabled();
  await dialog.getByLabel("Badge row output").selectOption("center");
  await expect(dialog.getByLabel(/Consolidate badge rows/)).toBeEnabled();
  await dialog.getByLabel(/Consolidate badge rows/).check();
  await dialog
    .getByRole("button", { name: "Review selected refactors" })
    .click();
  await expect(dialog.getByLabel("After refactor")).toHaveValue(
    /<p align="center">/,
  );
  await dialog.getByLabel("Badge row output").selectOption("paragraph");
  await expect(dialog.getByLabel(/Consolidate badge rows/)).toBeChecked();
  await dialog
    .getByRole("button", { name: "Review selected refactors" })
    .click();
  await expect(dialog.getByLabel("After refactor")).toHaveValue(/^<p><img/);
  await expect(editor(page)).toHaveValue(source);
});
test("refactors in two places keep the builder section between them (#77)", async ({
  page,
}) => {
  await start(page, "");
  await page.locator("app-shell").evaluate((app) =>
    app.store.blocks([
      {
        id: "intro",
        type: "custom",
        settings: { markdown: "# Title\n\n### Heading" },
      },
      { id: "rule", type: "divider", settings: {} },
      { id: "image", type: "custom", settings: { markdown: "![](local.svg)" } },
    ]),
  );
  const source = "# Title\n\n### Heading\n\n---\n\n![](local.svg)";
  await expect(editor(page)).toHaveValue(source);
  const dialog = await open(page);
  await expect(dialog).toContainText(
    "Untouched sections keep their ownership.",
  );
  await dialog.getByLabel(/Normalize heading hierarchy/).check();
  await dialog.getByLabel(/Add alt-text placeholders/).check();
  await dialog
    .getByRole("button", { name: "Review selected refactors", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Apply reviewed refactors", exact: true })
    .click();
  await expect(editor(page)).toHaveValue(
    "# Title\n\n## Heading\n\n---\n\n![TODO: describe image](local.svg)",
  );
  await expect(page.locator(".toast")).toHaveText(
    "Reviewed refactors applied. Undo restores source and builder ownership.",
  );
  const blocks = await page
    .locator("app-shell")
    .evaluate((app) => app.store.draft.blocks.map((b) => [b.id, b.type]));
  expect(blocks).toEqual([
    ["intro", "custom"],
    ["rule", "divider"],
    ["image", "custom"],
  ]);
});
