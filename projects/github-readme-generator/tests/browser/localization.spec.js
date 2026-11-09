import { test, expect } from "@playwright/test";

const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });

async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}

async function documents(page) {
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  return page.locator("workspace-documents");
}

test("localized editions keep exact source, target paths and metadata through reload", async ({
  page,
}) => {
  const remote = [];
  page.on("request", (request) => {
    if (/api\.github\.com|githubusercontent\.com/.test(request.url()))
      remote.push(request.url());
  });
  await start(page);
  const sourceMarkdown = "# Project\r\n\r\n## Usage\r\n\r\nRun.\r\n";
  await page.evaluate(
    (markdown) => document.querySelector("app-shell").store.raw(markdown),
    sourceMarkdown,
  );
  let panel = await documents(page);
  await panel.getByLabel("Document group").selectOption("repository");
  await panel.getByLabel("Document repository").fill("owner/project");
  await panel.getByLabel("Document branch").fill("main");
  await panel.getByLabel("Document README path").fill("README.md");
  await panel.getByLabel("Document language").selectOption("en");
  await panel.getByRole("button", { name: "Save document settings" }).click();
  const sourceId = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.id,
  );

  panel = await documents(page);
  await panel.getByRole("button", { name: "New document" }).click();
  const translatedMarkdown = "# Proyecto\r\n\r\n## Uso\r\n\r\nEjecutar.\r\n";
  await page.evaluate(
    (markdown) => document.querySelector("app-shell").store.raw(markdown),
    translatedMarkdown,
  );
  panel = await documents(page);
  await panel.getByLabel("Document group").selectOption("repository");
  await panel.getByLabel("Document repository").fill("owner/project");
  await panel.getByLabel("Document branch").fill("main");
  await panel.getByLabel("Document README path").fill("docs/es/README.md");
  await panel.getByLabel("Document language").selectOption("es");
  await panel.getByLabel("Translation source").selectOption(sourceId);
  await panel.getByRole("button", { name: "Save document settings" }).click();

  const beforeReload = await page.evaluate(() => {
    const shell = document.querySelector("app-shell");
    return {
      markdown: shell.store.draft.markdown,
      settings: shell.store.draft.metadata.workspaceDocument,
    };
  });
  expect(beforeReload.markdown).toBe(translatedMarkdown);
  expect(beforeReload.settings).toMatchObject({
    target: {
      repository: "owner/project",
      branch: "main",
      path: "docs/es/README.md",
    },
    localization: { locale: "es", sourceDocumentId: sourceId },
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("app-shell").store.draft.markdown,
      ),
    )
    .toBe(translatedMarkdown);
  const afterReload = await page.evaluate(
    () =>
      document.querySelector("app-shell").store.draft.metadata
        .workspaceDocument,
  );
  expect(afterReload).toEqual(beforeReload.settings);
  expect(remote).toEqual([]);

  await page.evaluate(() =>
    document.querySelector("app-shell").mobile("health", false),
  );
  const health = page.locator("readme-health");
  await expect(health).toContainText("Language-sensitive guidance — Unknown");
  await expect(
    health.locator('[role="status"]').filter({
      hasText: "Language-sensitive guidance",
    }),
  ).toHaveCount(0);
  await health.getByLabel("Analysis view").selectOption("Structure");
  await expect(
    health.locator('[role="status"]').filter({
      hasText: "Language-sensitive guidance",
    }),
  ).toHaveCount(0);

  const count = await page.evaluate(
    () => document.querySelector("app-shell").data.drafts.length,
  );
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page.getByRole("button", { name: "Duplicate draft" }).click();
  await expect(page.locator(".toast")).toContainText("Nothing was saved");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.drafts.length,
    ),
  ).toBe(count);
});

test("translation drift is conservative, stale-safe and usable at 320px", async ({
  page,
}) => {
  await start(page);
  const initial = "# Project\n\n## Usage\n\nRun.\n";
  await editor(page).fill(initial);
  let panel = await documents(page);
  await panel.getByLabel("Document group").selectOption("repository");
  await panel.getByLabel("Document repository").fill("owner/project");
  await panel.getByLabel("Document branch").fill("main");
  await panel.getByLabel("Document language").selectOption("en");
  await panel.getByRole("button", { name: "Save document settings" }).click();
  const sourceId = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.id,
  );
  panel = await documents(page);
  await panel.getByRole("button", { name: "New document" }).click();
  const translated = "# Proyecto\n\n## Uso\n\nEjecutar.\n";
  await editor(page).fill(translated);
  panel = await documents(page);
  await panel.getByLabel("Document group").selectOption("repository");
  await panel.getByLabel("Document repository").fill("owner/project");
  await panel.getByLabel("Document branch").fill("main");
  await panel.getByLabel("Document README path").fill("docs/es/README.md");
  await panel.getByLabel("Document language").selectOption("es");
  await panel.getByLabel("Translation source").selectOption(sourceId);
  await panel.getByRole("button", { name: "Save document settings" }).click();
  const translationId = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.id,
  );
  await page.getByLabel("Current draft").selectOption(sourceId);
  await editor(page).fill(
    "# Project\n\n## Usage\n\nRun differently.\n\n## Usage\n\nAnother.\n",
  );
  await page.getByLabel("Current draft").selectOption(translationId);
  await page.setViewportSize({ width: 320, height: 700 });
  await page
    .locator('.workspace-tools [data-action="translation-review"]')
    .click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Language-sensitive guidance — Unknown");
  await expect(dialog).toContainText("Repeated or missing section identity");
  await expect(
    dialog.locator('[data-translation-state="unknown"]'),
  ).toHaveCount(1);
  await dialog
    .getByLabel(
      "I manually reviewed these source changes against this translation",
    )
    .focus();
  await page.keyboard.press("Space");
  const oldRevision = await page.evaluate(
    () =>
      document.querySelector("app-shell").store.draft.metadata.workspaceDocument
        .localization.source.revision,
  );
  await page.evaluate((id) => {
    const shell = document.querySelector("app-shell");
    shell.data.drafts.find((draft) => draft.id === id).markdown += "\nChanged";
  }, sourceId);
  await dialog
    .getByRole("button", { name: "Mark current source revision reviewed" })
    .click();
  await expect(page.locator(".toast")).toContainText("changed");
  expect(
    await page.evaluate(
      () =>
        document.querySelector("app-shell").store.draft.metadata
          .workspaceDocument.localization.source.revision,
    ),
  ).toBe(oldRevision);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .locator('.workspace-tools [data-action="translation-review"]')
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel(
      "I manually reviewed these source changes against this translation",
    )
    .focus();
  await page.keyboard.press("Space");
  await page.evaluate(() => {
    window.originalLocalizationSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("simulated quota failure");
    };
  });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    "could not be saved. Nothing changed",
  );
  expect(
    await page.evaluate(
      () =>
        document.querySelector("app-shell").store.draft.metadata
          .workspaceDocument.localization.source.revision,
    ),
  ).toBe(oldRevision);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.originalLocalizationSetItem;
  });
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast")).toContainText("marked reviewed locally");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(translated);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  await page.context().setOffline(true);
  const reviewButton = page.locator(
    '.workspace-tools [data-action="translation-review"]',
  );
  await reviewButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText(
    "Language-sensitive guidance — Unknown",
  );
  await page.context().setOffline(false);
});

test("translation review fails closed for a missing source and lazy-load failure", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(async () => {
    const shell = document.querySelector("app-shell");
    const source = shell.store.draft;
    source.metadata.workspaceDocument = {
      version: 1,
      kind: "local",
      target: null,
      localization: null,
    };
    const translation = structuredClone(source);
    translation.id = crypto.randomUUID();
    translation.name = "Missing source translation";
    const { localizationSettings } = await import("/src/localization/model.js");
    translation.metadata.workspaceDocument.localization = localizationSettings(
      "es",
      source,
    );
    shell.data.drafts.push(translation);
    shell.load(translation.id);
    shell.data.drafts = shell.data.drafts.filter(
      (draft) => draft.id !== source.id,
    );
  });
  await page
    .locator('.workspace-tools [data-action="translation-review"]')
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("linked source document is unavailable");
  await expect(dialog.locator("[data-translation-approve]")).toHaveCount(0);
  await expect(editor(page)).not.toHaveValue("");

  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.route("**/src/localization/dialog.js*", (route) => route.abort());
  await page.reload();
  await page
    .locator('.workspace-tools [data-action="translation-review"]')
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Translation review could not load",
  );
  await expect(editor(page)).not.toHaveValue("");
});
