import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Regression tests for the severity 1-2 Friction fixed from the Scripted run
// baseline and heuristic walkthrough in docs/usability-findings.md.
const dialog = (page) => page.getByRole("dialog");
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
const tools = (page) => page.locator(".workspace-tools");
const toast = (page) => page.getByRole("status").and(page.locator(".toast"));
const markdown = (page) =>
  page.evaluate(() => document.querySelector("app-shell").store.draft.markdown);
async function download(page, trigger) {
  const event = page.waitForEvent("download");
  await trigger();
  return readFileSync(await (await event).path(), "utf8");
}
// Records what Copy Markdown would put on the clipboard.
async function recordClipboard(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => (window.copied = text) },
    });
  });
}
async function start(page) {
  await page.route("https://**/*", (r) => r.abort());
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await expect(dialog(page)).toBeHidden();
}
// Opens the sample's Hero section and changes its name without saving.
async function editHero(page, name = "Ada Example") {
  await page.locator(".block-open").first().click();
  await page.getByLabel("Name", { exact: true }).fill(name);
}

test.describe("F1: unsaved section edits are never left out of an export silently", () => {
  test("Export README asks first; Keep editing and Export without these edits do what they say", async ({
    page,
  }) => {
    await start(page);
    const saved = await markdown(page);
    await editHero(page);
    const exportButton = tools(page).getByRole("button", {
      name: "Export README",
    });
    let downloads = 0;
    page.on("download", () => downloads++);
    await exportButton.click();
    await expect(dialog(page)).toHaveAccessibleName(
      "Save your section edits first?",
    );
    await expect(dialog(page)).toContainText(
      "The Hero section has edits that are not in your README yet. Export README uses only saved sections.",
    );
    await expect(
      dialog(page).getByRole("button", { name: "Save section and export" }),
    ).toBeFocused();
    await dialog(page).getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Save section", exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Ada Example",
    );
    expect(downloads).toBe(0);
    expect(await markdown(page)).toBe(saved);
    // Exporting without the edits exports the saved README and keeps them in
    // the form, still unsaved.
    await exportButton.click();
    const text = await download(page, () =>
      dialog(page)
        .getByRole("button", { name: "Export without these edits" })
        .click(),
    );
    expect(text).toBe(saved);
    await expect(exportButton).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Ada Example",
    );
    expect(await markdown(page)).toBe(saved);
  });

  test("keyboard: Ctrl+Shift+E in the form saves the section and exports it, with Undo", async ({
    page,
  }) => {
    await start(page);
    const saved = await markdown(page);
    await editHero(page);
    await page.keyboard.press("Control+Shift+E");
    await expect(
      dialog(page).getByRole("button", { name: "Save section and export" }),
    ).toBeFocused();
    const text = await download(page, () => page.keyboard.press("Enter"));
    expect(text).toContain("# Ada Example");
    expect(text).not.toContain("Your Name");
    expect(await markdown(page)).toBe(text);
    await expect(dialog(page)).toBeHidden();
    // The field that triggered the export is gone; focus lands on the saved
    // section, and the save is an ordinary step Undo reverses.
    await expect(page.locator(".block-open").first()).toBeFocused();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await markdown(page)).toBe(saved);
  });

  test("Copy Markdown asks too, and an unchanged form never asks", async ({
    page,
  }) => {
    await recordClipboard(page);
    await start(page);
    await page.locator(".block-open").first().click();
    // Opened but unchanged: nothing would be left out.
    await download(page, () =>
      tools(page).getByRole("button", { name: "Export README" }).click(),
    );
    await expect(dialog(page)).toBeHidden();
    await page.getByLabel("Name", { exact: true }).fill("Grace Example");
    await tools(page).getByRole("button", { name: "Copy Markdown" }).click();
    await expect(dialog(page)).toContainText(
      "Copy Markdown uses only saved sections.",
    );
    await dialog(page)
      .getByRole("button", { name: "Save section and copy" })
      .click();
    await expect(toast(page)).toHaveText("Markdown copied");
    expect(await page.evaluate(() => window.copied)).toBe(await markdown(page));
    expect(await markdown(page)).toContain("# Grace Example");
  });

  test("a section with invalid fields offers no save, and Keep editing returns to its fields", async ({
    page,
  }) => {
    await start(page);
    const saved = await markdown(page);
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page
      .locator(".library-grid")
      .getByRole("button", { name: /^\S*\s*Badge\s*\+$/ })
      .click();
    await page.getByLabel("Link URL", { exact: true }).fill("javascript:x");
    let downloads = 0;
    page.on("download", () => downloads++);
    await tools(page).getByRole("button", { name: "Export README" }).click();
    await expect(dialog(page)).toContainText(
      "Some of its fields need fixing before it can be saved.",
    );
    await expect(
      dialog(page).getByRole("button", { name: /and export$/ }),
    ).toHaveCount(0);
    await expect(
      dialog(page).getByRole("button", { name: "Export without these edits" }),
    ).toBeFocused();
    await dialog(page).getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.locator("builder-form input").first()).toBeFocused();
    await expect(page.getByLabel("Link URL", { exact: true })).toHaveValue(
      "javascript:x",
    );
    expect(downloads).toBe(0);
    expect(await markdown(page)).toBe(saved);
  });

  test("a form replaced behind the question is never reported as saved and exported", async ({
    page,
  }) => {
    await start(page);
    const saved = await markdown(page);
    await editHero(page);
    let downloads = 0;
    page.on("download", () => downloads++);
    await tools(page).getByRole("button", { name: "Export README" }).click();
    // The pane shortcut runs while the question is open and replaces the
    // builder content, and with it the form and its edits.
    await page.keyboard.press("Alt+4");
    await expect(page.locator("builder-form")).toHaveCount(0);
    await dialog(page)
      .getByRole("button", { name: "Save section and export" })
      .click();
    await expect(dialog(page)).toBeHidden();
    await expect(toast(page)).toHaveText(
      "The section form closed before its edits were saved, so nothing was saved and Export README did not run. Open the section again to redo the edits.",
    );
    expect(downloads).toBe(0);
    expect(await markdown(page)).toBe(saved);
  });

  test("Save Studio project and the draft backups ask too, and include the section once saved", async ({
    page,
  }) => {
    await start(page);
    const saved = await markdown(page);
    await editHero(page);
    // Save Studio project: save the section, then the project dialog opens.
    await page
      .getByRole("button", { name: "Save Studio project", exact: true })
      .click();
    await expect(dialog(page)).toContainText(
      "Save Studio project uses only saved sections.",
    );
    await dialog(page)
      .getByRole("button", { name: "Save section and continue" })
      .click();
    await expect(dialog(page)).toHaveAccessibleName("Save Studio project");
    const project = JSON.parse(
      await download(page, () =>
        dialog(page)
          .getByRole("button", { name: "Download Studio project" })
          .click(),
      ),
    );
    expect(project.document.markdown).toContain("# Ada Example");
    expect(await markdown(page)).toBe(project.document.markdown);
    await page.locator(".close-dialog").click();
    await expect(dialog(page)).toBeHidden();
    // Download all drafts backup without the new edits leaves them in the form.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await markdown(page)).toBe(saved);
    await editHero(page, "Grace Example");
    await page.getByRole("button", { name: "Manage drafts" }).click();
    await dialog(page)
      .getByRole("button", { name: "Download all drafts backup" })
      .click();
    await expect(dialog(page)).toContainText(
      "Download all drafts backup uses only saved sections.",
    );
    const backupFile = JSON.parse(
      await download(page, () =>
        dialog(page)
          .getByRole("button", { name: "Download without these edits" })
          .click(),
      ),
    );
    expect(JSON.stringify(backupFile)).not.toContain("Grace Example");
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Grace Example",
    );
    // Download draft backup: save the section, then download it.
    await page.getByRole("button", { name: "Manage drafts" }).click();
    await dialog(page)
      .getByRole("button", { name: "Download draft backup" })
      .click();
    await expect(dialog(page)).toContainText(
      "Download draft backup uses only saved sections.",
    );
    const draftFile = await download(page, () =>
      dialog(page)
        .getByRole("button", { name: "Save section and download" })
        .click(),
    );
    expect(draftFile).toContain("# Grace Example");
  });
});

const backup = (markdown) =>
  JSON.stringify({
    version: 1,
    drafts: [
      { id: "notes", name: "Notes", markdown: "# Notes\n", blocks: [] },
      { id: "kept", name: "Kept safe", markdown, blocks: [] },
    ],
    active: "kept",
  });

test("F2: a merge restore opens the backup's active draft and keeps the others", async ({
  page,
}) => {
  await start(page);
  const before = await markdown(page);
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await dialog(page).getByRole("button", { name: "Restore backup" }).click();
  await page.getByLabel("Workspace backup file").setInputFiles({
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup("# Kept safe\n\nMy own words.\n")),
  });
  await expect(page.getByLabel("Restore mode")).toHaveValue("merge");
  await page.locator("#apply-restore").click();
  await expect(dialog(page)).toBeHidden();
  await expect(editor(page)).toHaveValue("# Kept safe\n\nMy own words.\n");
  await expect(toast(page)).toHaveText(
    "Workspace backup restored. Opened Kept safe; your other drafts are still under Current draft.",
  );
  await expect(page.getByLabel("Current draft")).toBeFocused();
  const names = await page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.name),
  );
  expect(names).toEqual(["My developer profile", "Notes", "Kept safe"]);
  // Nothing local was replaced, and the choice survives a reload.
  await page.getByLabel("Current draft").selectOption({
    label: "My developer profile",
  });
  await expect(editor(page)).toHaveValue(before);
  await page.getByLabel("Current draft").selectOption({ label: "Kept safe" });
  await page.reload();
  await expect(editor(page)).toHaveValue("# Kept safe\n\nMy own words.\n");
});

test("F3: Guided start offers Restore a backup by keyboard, and a damaged backup changes nothing", async ({
  page,
}) => {
  await page.route("https://**/*", (r) => r.abort());
  await page.goto("/");
  const paths = dialog(page).getByRole("region", {
    name: "Other ways to start",
  });
  const restore = paths.getByRole("button", { name: "Restore a backup" });
  await expect(restore).toBeVisible();
  for (let i = 0; i < 20; i++) {
    if (await restore.evaluate((e) => e === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(restore).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveAccessibleName("Restore workspace backup");
  const before = await markdown(page);
  await page.getByLabel("Workspace backup file").setInputFiles({
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not a backup"),
  });
  await expect(page.locator("#restore-status")).not.toBeEmpty();
  await expect(page.locator("#apply-restore")).toHaveCount(0);
  expect(await markdown(page)).toBe(before);
  // A valid backup restores from the same dialog.
  await page.getByLabel("Workspace backup file").setInputFiles({
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup("# From the backup\n")),
  });
  await page.locator("#apply-restore").click();
  await expect(dialog(page)).toBeHidden();
  await expect(editor(page)).toHaveValue("# From the backup\n");
  // Earlier Start paths keep their names beside it.
  await page.locator('.workspace-tools [data-action="guided-start"]').click();
  for (const name of [
    "Start from a template",
    "Autofill from GitHub",
    "Import GitHub README",
    "Open Studio project",
    "Start blank",
    "Restore a backup",
  ])
    await expect(
      dialog(page)
        .getByRole("region", { name: "Other ways to start" })
        .getByRole("button", { name }),
    ).toBeVisible();
});
