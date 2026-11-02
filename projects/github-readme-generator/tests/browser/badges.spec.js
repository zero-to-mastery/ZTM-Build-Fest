import { test, expect } from "@playwright/test";
async function start(page) {
  await page.route("https://**/*", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" />',
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Badge Studio", exact: true }).click();
}
test("build a React pair and insert without overwriting the selected source", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("Search logos").fill("react");
  await page
    .locator(".logo-results")
    .getByRole("button", { name: "React", exact: true })
    .click();
  await page.getByLabel("Light / dark badge pair").check();
  await expect(
    page.getByLabel("Generated Markdown", { exact: true }),
  ).toHaveValue(/<picture>/);
  const original = await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .inputValue();
  await page
    .locator("badge-studio")
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  const output = await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .inputValue();
  expect(output).toContain(original);
  expect(output).toContain("<picture>");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(original);
});
test("invalid link is explained and mobile studio fits", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page
    .getByLabel("Link URL", { exact: true })
    .fill("javascript:alert(1)");
  await expect(page.locator(".badge-status")).toContainText("safe");
  await expect(page.locator("[data-insert-badge]")).toBeDisabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Badge Studio", exact: true }),
  ).toBeFocused();
});
test("save, export, import and reuse a collection with keyboard row controls", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("Search logos").fill("React");
  await page
    .locator(".logo-results")
    .getByRole("button", { name: "React", exact: true })
    .click();
  await page
    .getByLabel("New collection name", { exact: true })
    .fill("Frontend");
  await page
    .getByRole("button", { name: "Save badge to collection", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await expect(page.getByLabel("Collection name", { exact: true })).toHaveValue(
    "Frontend",
  );
  await page
    .getByRole("button", { name: "Duplicate badge 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Move up 2", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export collection", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("Frontend.collection.json");
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("readme-studio:v1")).badgeCollections
        .items[0],
  );
  await page.getByLabel("Import collection JSON").setInputFiles({
    name: "collection.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.getByLabel("Collection name", { exact: true })).toHaveValue(
    "Frontend (2)",
  );
  await page
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  await page.getByLabel("Collection preview width").selectOption("320");
  await page
    .getByRole("button", { name: "Insert collection into README", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/<img src="https:\/\/img.shields.io/);
  await page.reload();
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await expect(page.locator(".collection-list button")).toHaveCount(2);
});
test("configure dynamic workflow and scoped npm helpers without typing requests", async ({
  page,
}) => {
  await start(page);
  await page
    .getByText("Dynamic badge helpers", { exact: true })
    .first()
    .click();
  await page
    .getByLabel("Badge helper", { exact: true })
    .selectOption("github-workflow");
  await page
    .getByLabel("GitHub repository (owner/repository)")
    .fill("owner/repo");
  await page.getByLabel("Workflow file or name").fill("ci.yml");
  await page.getByLabel("Branch (optional)").fill("feature/badges");
  await page
    .getByRole("button", { name: "Generate dynamic badge", exact: true })
    .click();
  await expect(
    page.getByLabel("Generated Markdown", { exact: true }),
  ).toHaveValue(/github\/actions\/workflow\/status\/owner\/repo\/ci.yml/);
  await page
    .getByLabel("Link URL", { exact: true })
    .fill("https://example.com/actions");
  await expect(
    page.getByLabel("Generated Markdown", { exact: true }),
  ).toHaveValue(/example.com\/actions/);
  await page
    .getByText("Dynamic badge helpers", { exact: true })
    .first()
    .click();
  await page.getByLabel("Search badge helpers").fill("npm");
  await page
    .getByLabel("Badge helper", { exact: true })
    .selectOption("npm-version");
  await page.getByLabel("npm package name").fill("@scope/package");
  await page
    .getByRole("button", { name: "Generate dynamic badge", exact: true })
    .click();
  await expect(
    page.getByLabel("Final Shields URL", { exact: true }),
  ).toHaveValue(/npm\/v\/%40scope\/package/);
});
test("badge copy fallback and offline generation preserve composer state", async ({
  page,
  context,
}) => {
  await start(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await page
    .getByLabel("Alt text", { exact: true })
    .fill("My accessible badge");
  await page
    .locator("badge-studio")
    .getByRole("button", { name: "Copy Markdown", exact: true })
    .click();
  await expect(
    page.getByLabel("Generated Markdown", { exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("Alt text", { exact: true })).toHaveValue(
    "My accessible badge",
  );
  await expect(page.locator(".badge-status")).toContainText(
    "Clipboard unavailable",
  );
  await context.setOffline(true);
  await page.getByLabel("Message", { exact: true }).fill("offline");
  await expect(page.locator(".badge-status")).toContainText(
    /Offline|Remote preview unavailable/,
  );
  await expect(
    page.getByLabel("Generated Markdown", { exact: true }),
  ).toHaveValue(/offline/);
  await page.getByLabel("Message color", { exact: true }).fill("#fff");
  await page.getByLabel("Alt text", { exact: true }).fill("badge");
  await expect(page.locator(".badge-advice")).toContainText("meaningful alt");
  await expect(page.locator(".badge-advice")).toContainText("hard to read");
  await expect(page.locator("[data-insert-badge]")).toBeEnabled();
});
test("theme collection journey is reusable across drafts and editable with keyboard", async ({
  page,
}) => {
  await start(page);
  for (const [index, name] of [
    "React",
    "Node.js",
    "Rust",
    "WebAssembly",
  ].entries()) {
    await page.getByLabel("Search logos").fill(name);
    await page
      .locator(".logo-results")
      .getByRole("button", { name, exact: true })
      .click();
    if (index === 0) await page.getByLabel("Light / dark badge pair").check();
    if (index === 0)
      await page
        .getByLabel("New collection name", { exact: true })
        .fill("Frontend");
    else
      await page
        .getByLabel("Save badge to collection", { exact: true })
        .selectOption({ label: "Frontend" });
    await page
      .getByRole("button", { name: "Save badge to collection", exact: true })
      .click();
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await expect(page.locator(".collection-badges li")).toHaveCount(4);
  await page.getByRole("button", { name: "Edit badge 2", exact: true }).click();
  await page
    .locator(".collection-composer")
    .getByLabel("Message color", { exact: true })
    .fill("#123456");
  await page
    .getByRole("button", { name: "Use badge in collection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Insert collection into README", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await expect(editor).toHaveValue(/<picture>/);
  await expect(editor).toHaveValue(/WebAssembly/);
  const first = await editor.inputValue();
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page
    .getByRole("button", { name: "New blank draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await page
    .getByRole("button", { name: "Insert collection into README", exact: true })
    .click();
  await expect(editor).toHaveValue(/123456/);
  await page
    .getByLabel("Current draft", { exact: true })
    .selectOption({ label: "My developer profile" });
  await expect(editor).toHaveValue(first);
});
test("large collection previews stay bounded and unsaved edits can be kept", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  const data = {
    version: 1,
    type: "badge-collection",
    name: "Large",
    badges: Array.from({ length: 200 }, (_, i) => ({
      label: `Tool ${i}`,
      alt: `Tool ${i}`,
      logo: "react",
      color: "20232A",
    })),
  };
  await page.getByLabel("Import collection JSON").setInputFiles({
    name: "large.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await expect(page.locator(".collection-badges li")).toHaveCount(200);
  expect(
    await page.locator(".collection-preview img").count(),
  ).toBeLessThanOrEqual(20);
  await page.getByLabel("Collection preview width").selectOption("320");
  await expect(page.locator(".collection-advice")).toContainText(
    "Repeated technology",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
test("malformed collection storage recovers drafts without silently rewriting originals", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  const original = await page.evaluate(() => {
    const key = "readme-studio:v1",
      data = JSON.parse(localStorage.getItem(key));
    data.badgeCollections = {
      version: 1,
      items: [
        {
          version: 1,
          type: "badge-collection",
          id: "collection",
          name: "Recovered",
          badges: [
            { label: "React", logo: "react", color: "blue" },
            { label: "Bad", link: "javascript:bad" },
          ],
        },
      ],
    };
    const raw = JSON.stringify(data);
    localStorage.setItem(key, raw);
    return raw;
  });
  await page.addInitScript(
    (raw) => localStorage.setItem("readme-studio:v1", raw),
    original,
  );
  await page.reload();
  await expect(page.locator(".recovery-notice")).toContainText(
    "original storage is untouched",
  );
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await expect(page.locator(".collection-badges li")).toHaveCount(1);
  expect(
    await page.evaluate(() => localStorage.getItem("readme-studio:v1")),
  ).toBe(original);
  await page
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  await expect(page.locator("[data-collection-status]")).toContainText(
    "Storage recovery is active",
  );
});
test("collection preview fits mobile and screenshot documents Badge Studio", async ({
  page,
}, info) => {
  await start(page);
  await page.getByLabel("Search logos").fill("React");
  await page
    .locator(".logo-results")
    .getByRole("button", { name: "React", exact: true })
    .click();
  await page.getByLabel("Light / dark badge pair").check();
  if (info.project.name === "chromium")
    await page.screenshot({ path: "test-results/badge-studio-desktop.png" });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page
      .getByRole("dialog")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page.locator("[data-insert-badge]").scrollIntoViewIfNeeded();
  if (info.project.name === "chromium")
    await page.screenshot({ path: "test-results/badge-studio-mobile.png" });
});
test("stack categories and workspace backups retain independent collections", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  await page
    .locator('[data-block-action="edit"]')
    .filter({ hasText: "Tech Stack" })
    .click();
  const category = page.locator("[data-save-category]");
  await category.selectOption({ index: 0 });
  const name = await category.inputValue();
  await page
    .getByRole("button", { name: "Save category as collection", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Insert saved collection into stack",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Collection name", { exact: true })).toHaveValue(
    name,
  );
  await page
    .getByRole("button", { name: "Insert collection into README", exact: true })
    .click();
  const saved = await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    app.save();
    return structuredClone(app.data);
  });
  const before = saved.badgeCollections.items[0].badges.length;
  expect(before).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Manage drafts" }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download all drafts backup", exact: true })
    .click();
  const stream = await (await download).createReadStream(),
    chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString());
  expect(backup.badgeCollections.items[0].badges).toHaveLength(before);
  await page
    .getByRole("button", { name: "Restore backup", exact: true })
    .click();
  await page.getByLabel("Workspace backup file").setInputFiles({
    name: "all.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator("#restore-status")).toContainText(
    "1 badge collections",
  );
  await page.locator("#apply-restore").click();
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await expect(page.locator(".collection-list button")).toHaveCount(2);
  const stored = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("readme-studio:v1")).badgeCollections
        .items,
  );
  expect(new Set(stored.map((c) => c.id)).size).toBe(2);
  expect(stored[1].name).toBe(`${name} (2)`);
});
