import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
// Source-preserving raw edits (#77): typing in one section never detaches a
// builder section elsewhere, and a Detachment is announced and visible.
const fixture = readFileSync("tests/fixtures/round-trip/html.md", "utf8");
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
async function typeAt(page, position, text) {
  await editor(page).evaluate((el, at) => {
    el.focus();
    el.setSelectionRange(at, at);
  }, position);
  await page.keyboard.type(text);
}
test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" />',
    }),
  );
});
test("raw edits keep untouched builder sections visual and announce detachment", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.locator(".workspace-tools [data-action=import]").click();
  await page.getByRole("button", { name: "Local file", exact: true }).click();
  await page.getByLabel("Import mode", { exact: true }).selectOption("new");
  await page.locator("#file-import").setInputFiles({
    name: "README.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(fixture),
  });
  await page.getByRole("button", { name: "Import as new draft" }).click();
  await expect(editor(page)).toHaveValue(fixture);
  // The Next steps panel offers the same split; use the builder's button.
  await page
    .getByRole("complementary", { name: "Builder" })
    .getByRole("button", { name: "Split into sections", exact: true })
    .click();
  await page.locator("#apply-split").click();
  const sections = await page.locator(".block-row").count();
  expect(sections).toBeGreaterThan(1);

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .locator(".library-grid")
    .getByRole("button", { name: "Divider" })
    .click();
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  const built = await editor(page).inputValue();
  expect(built.startsWith(fixture)).toBe(true);
  await page.getByRole("button", { name: "Sections", exact: true }).click();
  const rows = page.locator(".block-row");
  await expect(rows).toHaveCount(sections + 1);
  const divider = rows.last();
  await expect(divider).toContainText("Divider");

  // Type inside a different (Custom Markdown) section.
  const at = built.indexOf("Inline ") + "Inline ".length;
  await typeAt(page, at, "very ");
  const edited = built.slice(0, at) + "very " + built.slice(at);
  await expect(editor(page)).toHaveValue(edited);
  await expect(editor(page)).toBeFocused();
  await expect(rows).toHaveCount(sections + 1);
  await expect(divider).not.toContainText("Detached");
  await expect(page.locator(".toast")).not.toContainText("detached");
  await divider.locator(".block-open").click();
  await expect(page.locator("builder-form")).toBeVisible();
  await page.getByRole("button", { name: "Sections", exact: true }).click();

  // Exported Markdown equals the fixture plus the builder output and the edit.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export README" }).click();
  const file = await (await download).path();
  expect(readFileSync(file, "utf8")).toBe(edited);

  // Typing inside the builder section detaches only that section.
  await typeAt(page, edited.length - 1, "x");
  await expect(page.locator(".toast")).toHaveText(
    "Raw edit detached: Divider (builder). Undo restores visual ownership.",
  );
  await expect(page.locator(".toast")).toHaveAttribute("role", "status");
  await expect(editor(page)).toBeFocused();
  await expect(rows.last()).toContainText("Detached from Divider");
  await expect(rows).toHaveCount(sections + 1);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue(edited);
  await expect(rows.last()).not.toContainText("Detached");
});
test("saving a builder form keeps blank lines typed before its section", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .locator(".library-grid")
    .getByRole("button", { name: "Divider" })
    .click();
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  const built = await editor(page).inputValue();
  expect(built.endsWith("\n\n---")).toBe(true);

  // A form holds a copy of its section taken when it opened. A raw edit to the
  // blank lines before that section keeps the section's ID, so saving the copy
  // afterwards must not write back the old Seam.
  const saved = await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    const form = structuredClone(app.store.draft.blocks.at(-1));
    const md = app.store.draft.markdown;
    app.store.raw(md.slice(0, -3) + "\n---");
    const kept = app.store.draft.blocks.at(-1).id === form.id;
    app.dispatchEvent(
      new CustomEvent("commit", { detail: form, bubbles: true }),
    );
    return { kept, markdown: app.store.draft.markdown };
  });
  expect(saved).toEqual({ kept: true, markdown: built.slice(0, -3) + "\n---" });
  await expect(page.locator(".toast")).toHaveText("Section saved to README");
  await expect(editor(page)).toHaveValue(built.slice(0, -3) + "\n---");
});
test("typing after the sample hero subtitle by keyboard detaches the hero", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const subtitle = "Building thoughtful software, one commit at a time.";
  const before = await editor(page).inputValue();
  const end = before.indexOf(subtitle) + subtitle.length;
  expect(before).toContain(subtitle);
  const hero = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.blocks[0],
  );
  expect(hero.type).toBe("hero");
  // The editor runs a raw edit per key: the space lands in the Seam after the
  // hero, the letters after it, on the hero's last line.
  await typeAt(page, end, " more");
  await expect(editor(page)).toHaveValue(
    before.slice(0, end) + " more" + before.slice(end),
  );
  await expect(editor(page)).toBeFocused();
  await expect(page.locator(".toast")).toHaveText(
    "Raw edit detached: Your Name (builder). Undo restores visual ownership.",
  );
  await expect(page.locator(".block-row").first()).toContainText(
    "Detached from Your Name",
  );
  const state = await page.evaluate((id) => {
    const { draft } = document.querySelector("app-shell").store;
    return {
      owned: draft.blocks.some((b) => b.id === id),
      records: draft.metadata.detachments.map((r) => r.previousBlockIds),
      first: draft.blocks[0].type,
    };
  }, hero.id);
  expect(state).toEqual({
    owned: false,
    records: [[hero.id]],
    first: "custom",
  });
});
