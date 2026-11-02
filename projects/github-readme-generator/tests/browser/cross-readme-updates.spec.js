import { test, expect } from "@playwright/test";

test("eight affected READMEs show diffs and only chosen recipients update", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate(async () => {
    const { newDraft } = await import("/src/state/drafts.js");
    const { emptyShared, saveShared, planShared } =
      await import("/src/workspace/shared-components.js");
    const app = document.querySelector("app-shell");
    const old = saveShared(emptyShared(), {
      name: "Testing Stack",
      markdown: "## Testing\nOld tools",
    });
    const drafts = Array.from({ length: 8 }, (_, i) => {
      const draft = newDraft(`Repository ${i + 1}`);
      const entry = planShared([draft], old.items[0], [draft.id], "insert")
        .entries[0];
      return { ...draft, markdown: entry.markdown, blocks: entry.blocks };
    });
    app.data.sharedComponents = saveShared(old, {
      ...old.items[0],
      markdown: "## Testing\nVitest and Playwright",
    });
    app.data.drafts.push(...drafts);
    app.draftOptions();
    app.save();
  });
  await page
    .getByRole("button", { name: "Cross-README updates", exact: true })
    .click();
  const panel = page.locator("shared-components");
  await panel
    .getByRole("combobox", { name: "Shared definition", exact: true })
    .selectOption({ label: "Testing Stack · revision 2" });
  await panel.getByRole("button", { name: "Preview across workspace" }).click();
  await expect(panel.locator("[data-impact]")).toContainText(
    "Affected: 8 READMEs · Selected: 0",
  );
  await expect(panel.locator("[data-entry]")).toHaveCount(8);
  await expect(panel.locator("[data-after]").first()).toHaveValue(
    "## Testing\nVitest and Playwright",
  );
  await expect(
    panel.getByRole("button", { name: "Apply reviewed changes" }),
  ).toBeDisabled();
  await panel.getByLabel("Update Repository 2", { exact: true }).check();
  await panel.getByLabel("I reviewed all selected document diffs").check();
  await panel.getByLabel("Update Repository 6", { exact: true }).check();
  await expect(
    panel.getByLabel("I reviewed all selected document diffs"),
  ).not.toBeChecked();
  await expect(panel.locator("[data-impact]")).toContainText("Selected: 2");
  await panel.getByLabel("I reviewed all selected document diffs").check();
  await panel.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(panel.locator("[data-status]")).toContainText("2 document(s)");
  const sources = await page.evaluate(() =>
    document
      .querySelector("app-shell")
      .data.drafts.slice(1)
      .map((d) => d.markdown),
  );
  sources.forEach((source, i) =>
    expect(source).toBe(
      [1, 5].includes(i)
        ? "## Testing\nVitest and Playwright"
        : "## Testing\nOld tools",
    ),
  );
  await panel
    .getByRole("combobox", { name: "Shared definition", exact: true })
    .selectOption({ label: "Testing Stack · revision 2" });
  await panel.getByRole("button", { name: "Preview across workspace" }).click();
  await expect(panel.locator("[data-impact]")).toContainText(
    "Affected: 6 READMEs · Selected: 0",
  );
  await page.keyboard.press("Escape");
  await page.reload();
  expect(
    await page.evaluate(() =>
      document
        .querySelector("app-shell")
        .data.drafts.slice(1)
        .map((d) => d.markdown),
    ),
  ).toEqual(sources);
});
