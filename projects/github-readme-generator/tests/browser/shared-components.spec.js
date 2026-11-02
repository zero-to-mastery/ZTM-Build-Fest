import { test, expect } from "@playwright/test";
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    app.store.raw("# First");
    app.addDraft("Second", []);
    app.store.raw("# Second");
  });
  await page
    .getByRole("button", { name: "Shared components", exact: true })
    .click();
  return page.locator("shared-components");
}
const sources = (page) =>
  page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.markdown),
  );
async function save(panel, text = "## Security\nContact the security team.") {
  await panel.getByLabel("Shared component name").fill("Security footer");
  await panel.getByLabel("Shared Markdown", { exact: true }).fill(text);
  await panel
    .getByRole("button", { name: "Save shared definition", exact: true })
    .click();
  await expect(panel.locator("[data-status]")).toContainText(
    "No README was changed",
  );
}
async function all(panel) {
  for (const box of await panel.locator("[data-document]").all())
    await box.check();
}
async function apply(panel) {
  await panel.getByLabel("I reviewed all selected document diffs").check();
  await panel.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(panel.locator("[data-status]")).toContainText(
    "Applied reviewed changes",
  );
}
test("shared definitions update two documents only after preview and preserve independent undo at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const panel = await start(page);
  const original = await sources(page);
  await save(panel);
  expect(await sources(page)).toEqual(original);
  await all(panel);
  await panel
    .getByRole("button", { name: "Preview insertion", exact: true })
    .click();
  await expect(panel.locator("[data-entry]")).toHaveCount(2);
  await expect(
    panel.getByRole("button", { name: "Apply reviewed changes" }),
  ).toBeDisabled();
  expect(await sources(page)).toEqual(original);
  await apply(panel);
  const inserted = await sources(page);
  expect(inserted.every((s) => s.includes("Contact the security team"))).toBe(
    true,
  );
  await panel
    .getByRole("combobox", { name: "Shared definition", exact: true })
    .selectOption({ label: "Security footer · revision 1" });
  await save(panel, "## Security\nUse our private reporting channel.");
  expect(await sources(page)).toEqual(inserted);
  await all(panel);
  await panel.getByRole("button", { name: "Preview linked updates" }).click();
  await expect(panel.locator("[data-entry]")).toHaveCount(2);
  await apply(panel);
  expect(
    (await sources(page)).every((s) => s.includes("private reporting")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await page.locator('[data-pane="markdown"]').click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await sources(page))[1]).toBe(inserted[1]);
  await page.getByLabel("Current draft").selectOption({ index: 0 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await sources(page)).toEqual(inserted);
  await page.reload();
  await page
    .getByRole("button", { name: "Shared components", exact: true })
    .click();
  await panel
    .getByRole("combobox", { name: "Shared definition", exact: true })
    .selectOption({ label: "Security footer · revision 2" });
  await expect(
    panel.getByLabel("Shared Markdown", { exact: true }),
  ).toHaveValue(/private reporting/);
  expect(await sources(page)).toEqual(inserted);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("stale multi-document preview and failed persistence leave every source unchanged", async ({
  page,
}) => {
  const panel = await start(page);
  await save(panel);
  await all(panel);
  await panel
    .getByRole("button", { name: "Preview insertion", exact: true })
    .click();
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Local edit"),
  );
  const changed = await sources(page);
  await panel.getByLabel("I reviewed all selected document diffs").check();
  await panel.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(panel.locator("[data-status]")).toContainText(
    "document changed",
  );
  expect(await sources(page)).toEqual(changed);
  await panel
    .getByRole("button", { name: "Preview insertion", exact: true })
    .click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Full", "QuotaExceededError");
    };
  });
  await panel.getByLabel("I reviewed all selected document diffs").check();
  await panel.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(panel.locator("[data-status]")).toContainText("Full");
  expect(await sources(page)).toEqual(changed);
});
