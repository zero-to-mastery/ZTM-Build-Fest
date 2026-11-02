import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
async function start(page) {
  await page.route("https://**/*", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"/>',
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}
test("theme preview, apply, undo, and themed badge defaults", async ({
  page,
}) => {
  await start(page);
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const before = await editor.inputValue();
  await page.getByRole("button", { name: "Visual theme", exact: true }).click();
  await page
    .getByLabel("Built-in theme", { exact: true })
    .selectOption("workshop");
  await expect(editor).toHaveValue(before);
  await expect(page.locator(".theme-sample")).toContainText("Selected work");
  await page
    .getByRole("button", { name: "Apply visual theme", exact: true })
    .click();
  await expect(editor).toHaveValue(/✦/);
  await page.getByRole("button", { name: "Badge Studio", exact: true }).click();
  await expect(page.locator('[data-badge-field="color"]')).toHaveValue(
    "a84612",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor).toHaveValue(before);
});
test("theme controls fit mobile and invalid colors cannot apply", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page.getByRole("button", { name: "Visual theme", exact: true }).click();
  await page.getByLabel("accent hex", { exact: true }).fill("bad color");
  await expect(
    page.getByRole("button", { name: "Apply visual theme", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("accent hex", { exact: true }).fill("123456");
  await expect(
    page.getByRole("button", { name: "Apply visual theme", exact: true }),
  ).toBeEnabled();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("local theme-aware banners download safe SVG and insert portable markup", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "Banner Builder", exact: true })
    .click();
  await page.locator('[data-banner="name"]').fill("Ada 雪");
  await page.locator('[data-banner="title"]').fill("Systems developer");
  await page
    .getByRole("button", { name: "Suggest alt from name and title" })
    .click();
  await page
    .getByLabel("Banner style", { exact: true })
    .selectOption("constellation");
  await expect(page.locator("[data-banner-svg]")).toHaveValue(/Ada 雪/);
  await page
    .getByLabel("Banner preview mode", { exact: true })
    .selectOption("dark");
  await page
    .getByLabel("Banner preview width", { exact: true })
    .selectOption("320px");
  expect(
    await page
      .locator(".banner-preview")
      .evaluate((e) => e.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(320);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download banner-dark.svg", exact: true })
    .click();
  const asset = await download;
  expect(asset.suggestedFilename()).toBe("banner-dark.svg");
  const svg = await readFile(await asset.path(), "utf8");
  expect(svg).toContain("Ada 雪");
  expect(svg).not.toContain("<script");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Copy SVG source", exact: true })
    .click();
  await expect(page.locator("[data-banner-svg]")).toBeFocused();
  await page
    .getByRole("button", { name: "Insert banner markup", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/assets\/banner-light.svg/);
  await page
    .getByRole("button", { name: "Banner Builder", exact: true })
    .click();
  await expect(page.locator('[data-banner="name"]')).toHaveValue("Ada 雪");
});

test("banner asset manifest is deterministic and matches exported references", async ({
  page,
}) => {
  await start(page);
  const editor = page.getByRole("textbox", {
      name: "Markdown editor",
      exact: true,
    }),
    before = await editor.inputValue();
  await page
    .getByRole("button", { name: "Banner Builder", exact: true })
    .click();
  await page.getByLabel("Filename base", { exact: true }).fill("profile-hero");
  await page.getByLabel("Asset folder", { exact: true }).fill("docs/media");
  await expect(page.locator("[data-banner-manifest]")).toHaveValue(
    /readme-studio-asset-manifest/,
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download asset manifest", exact: true })
    .click();
  const asset = await download,
    manifest = JSON.parse(await readFile(await asset.path(), "utf8"));
  expect(asset.suggestedFilename()).toBe("readme-studio-assets.json");
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    type: "readme-studio-asset-manifest",
    generator: { type: "banner", version: 1 },
  });
  expect(manifest.assets.map((item) => item.path)).toEqual([
    "docs/media/profile-hero-dark.svg",
    "docs/media/profile-hero-light.svg",
  ]);
  for (const item of manifest.assets) {
    expect(item.fingerprint).toMatch(/^fnv1a32:[a-f0-9]{8}$/);
    expect(manifest.references.markdown).toContain(item.path);
  }
  expect(JSON.stringify(manifest)).not.toContain("<svg");
  await expect(editor).toHaveValue(before);
});

test("banner accessibility feedback covers alt, contrast and reduced-motion preview without editing source", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await start(page);
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const source = await editor.inputValue();
  await page.getByRole("button", { name: "Banner Builder" }).click();
  const review = page.getByRole("region", {
    name: "Banner accessibility review",
  });
  const announcement = page.locator(".banner-accessibility-status");
  await expect(review).toContainText(/Alt text.*descriptive/i);
  await expect(review).toContainText(/Light Primary text.*:1.*Pass/i);
  await expect(review).toContainText(/Dark Primary text.*:1.*Pass/i);
  await expect(review).not.toContainText(/Muted metadata/i);
  await page
    .getByLabel("Website / handle", { exact: true })
    .fill("example.test");
  await expect(review).toContainText(/Light Muted metadata.*:1/i);
  await page.getByLabel("Website / handle", { exact: true }).fill("");
  await expect(review).not.toContainText(/Muted metadata/i);
  await expect(announcement).toContainText(
    /Light Muted metadata.*no longer applies/i,
  );
  await page
    .getByLabel("Generate variants", { exact: true })
    .selectOption("light");
  await expect(announcement).toContainText(
    /Dark Primary text.*no longer applies to the current banner settings/i,
  );
  await expect(announcement).not.toContainText(/text is not rendered/i);
  await expect(review).toContainText(/static.*no animation/i);

  expect(
    await page
      .locator("button")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");

  await page.getByLabel("Banner alt text").fill("banner");
  await expect(review).toContainText(/generic/i);
  await expect(announcement).toContainText(/Alt text.*generic/i);
  await expect(announcement).not.toContainText(/Primary|motion/i);
  await page.getByLabel("Banner foreground hex").fill("ffffff");
  await page.getByLabel("Banner light hex").fill("ffffff");
  await expect(review).toContainText(/Light Primary text.*1\.0:1.*Review/i);
  await expect(page.locator(".banner-preview img")).toHaveAttribute(
    "alt",
    "banner",
  );
  expect(
    await page
      .locator(".banner-preview img")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  await expect(editor).toHaveValue(source);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(
    await page
      .locator("button")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).not.toBe("0s");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .locator(".workspace-tools")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByLabel("Reduce motion", { exact: true }).check();
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
  expect(
    await page
      .locator("button")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
  await expect(editor).toHaveValue(source);
});

test("section style overrides survive theme changes while Custom Markdown stays exact", async ({
  page,
}) => {
  await start(page);
  const custom = await page
    .locator("app-shell")
    .evaluate((el) => el.store.draft.blocks.filter((b) => b.type === "custom"));
  await page
    .getByRole("button", { name: "Section style", exact: true })
    .click();
  await page
    .getByLabel("Heading style", { exact: true })
    .selectOption("centered");
  await page.getByLabel("Divider style", { exact: true }).selectOption("dots");
  await page
    .getByLabel("Section preview width", { exact: true })
    .selectOption("320px");
  await expect(page.locator(".section-style-preview h1")).toHaveAttribute(
    "align",
    "center",
  );
  await page
    .getByRole("button", { name: "Save section style", exact: true })
    .click();
  await page.getByRole("button", { name: "Visual theme", exact: true }).click();
  await page.getByLabel("Built-in theme", { exact: true }).selectOption("nord");
  await page
    .getByRole("button", { name: "Apply visual theme", exact: true })
    .click();
  expect(
    await page
      .locator("app-shell")
      .evaluate((el) =>
        el.store.draft.blocks.filter((b) => b.type === "custom"),
      ),
  ).toEqual(custom);
  await page
    .getByRole("button", { name: "Section style", exact: true })
    .click();
  await expect(page.getByLabel("Heading style", { exact: true })).toHaveValue(
    "centered",
  );
  await expect(page.getByLabel("Divider style", { exact: true })).toHaveValue(
    "dots",
  );
});
test("callout, code, details and columns are available through the builder", async ({
  page,
}) => {
  await start(page);
  for (const [name, field, value] of [
    ["Callout", "Callout text", "Remember to test"],
    ["Collapsible Details", "Details Markdown", "Extra details"],
    ["Code Sample", "Code source", 'console.log("safe");'],
    ["Two Columns", "Left text", "Left column"],
  ]) {
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page
      .locator(".library-grid")
      .getByRole("button", { name: new RegExp(name) })
      .click();
    await page
      .locator("builder-form")
      .getByLabel(field, { exact: true })
      .fill(value);
    if (name === "Code Sample") {
      await expect(page.getByLabel("Code source status")).toHaveValue(
        "placeholder",
      );
      await page.locator('[data-path="collapsed"]').check();
      await page
        .locator("builder-form")
        .getByRole("button", { name: "Copy Markdown", exact: true })
        .click();
      await expect(page.locator("example-export-check")).toContainText(
        "1 placeholder",
      );
      await page.getByRole("button", { name: "Close dialog" }).click();
    }
    await page
      .locator("builder-form")
      .getByRole("button", { name: "Add to README", exact: true })
      .click();
  }
  const source = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await expect(source).toHaveValue(/> \[!NOTE\]/);
  await expect(source).toHaveValue(/<details>/);
  await expect(source).toHaveValue(/console.log/);
  await expect(source).toHaveValue(/readme-studio-example: placeholder/);
  await expect(source).toHaveValue(/Left column/);
  await page
    .locator(".block-row")
    .filter({ hasText: "Code Sample" })
    .getByRole("button", { name: /Copy/ })
    .click();
  await expect(page.locator("example-export-check")).toContainText(
    "1 placeholder",
  );
});

test("app color toggle synchronizes preview and picture sources without changing Markdown", async ({
  page,
}) => {
  await start(page);
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const source =
    '<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.svg"><img src="https://example.com/light.svg" alt="Theme"></picture>';
  await editor.fill(source);
  const appToggle = page.getByRole("button", {
    name: "Toggle color theme",
    exact: true,
  });
  const previewToggle = page.getByRole("button", {
    name: "Toggle preview color theme",
    exact: true,
  });
  await previewToggle.click();
  await appToggle.click();
  await expect(page.locator(".preview-paper")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  await expect(page.locator("github-preview source")).toHaveAttribute(
    "media",
    "all",
  );
  await appToggle.click();
  await expect(page.locator(".preview-paper")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await expect(page.locator("github-preview source")).toHaveAttribute(
    "media",
    "not all",
  );
  await appToggle.click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".preview-paper")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  await expect(page.locator("github-preview source")).toHaveAttribute(
    "media",
    "all",
  );
  await expect(editor).toHaveValue(source);
  await previewToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".preview-paper")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await expect(editor).toHaveValue(source);
});

test("app theme follows the device until the editor toggle sets a manual preference", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await start(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page
      .locator(".app-header")
      .getByRole("button", { name: "Toggle color theme", exact: true }),
  ).toHaveCount(0);

  const appToggle = page
    .locator(".editor-pane")
    .getByRole("button", { name: "Toggle color theme", exact: true });
  await appToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("saved visual themes can be managed, imported and backed up without touching source", async ({
  page,
}) => {
  await start(page);
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const source = await editor.inputValue();
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  await page.getByLabel("Preset name", { exact: true }).fill("My palette");
  await page
    .getByRole("button", { name: "Save current theme", exact: true })
    .click();
  const select = page.getByLabel("Saved preset", { exact: true });
  await select.selectOption({ label: "themes: My palette" });
  await page
    .getByRole("button", { name: "Duplicate preset", exact: true })
    .click();
  await expect(select.locator("option")).toHaveCount(3);
  await select.selectOption({ label: "themes: My palette (2)" });
  await page.getByLabel("Preset name", { exact: true }).fill("Renamed");
  await page
    .getByRole("button", { name: "Rename preset", exact: true })
    .click();
  await select.selectOption({ label: "themes: Renamed" });
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export preset", exact: true })
    .click();
  const file = await download;
  const exported = await readFile(await file.path(), "utf8");
  expect(JSON.parse(exported).type).toBe("readme-studio-theme");
  await page
    .getByText("Import themes, brand kits and visual presets", { exact: true })
    .click();
  await page.getByLabel("Visual preset JSON", { exact: true }).fill(exported);
  await page
    .getByRole("button", { name: "Review import", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Append reviewed presets", exact: true })
    .click();
  await expect(select.locator("option")).toHaveCount(4);
  await select.selectOption({ label: "themes: Renamed (2)" });
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete preset", exact: true })
    .click();
  await expect(select.locator("option")).toHaveCount(3);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(editor).toHaveValue(source);
  await page.reload();
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  await expect(select.locator("option")).toHaveCount(3);
  const library = await page
    .locator("app-shell")
    .evaluate((el) => el.data.visualLibrary);
  expect(library.themes.map((t) => t.name)).toEqual(["My palette", "Renamed"]);
});

test("visual gallery is keyboard usable at mobile width and applies reviewed presets offline", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  const review = page.getByRole("button", {
    name: "Review Workshop theme",
    exact: true,
  });
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Apply Workshop", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Preset apply mode", { exact: true }),
  ).toHaveValue("derived");
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Apply reviewed preset", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    await page
      .locator("app-shell")
      .evaluate((el) => el.store.draft.metadata.visualTheme.id),
  ).toBe("workshop");
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save brand kit", exact: true })
    .click();
  await expect(
    page.getByLabel("Saved preset", { exact: true }).locator("option"),
  ).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Visual presets", exact: true }),
  ).toBeFocused();
});

test("visual library save failure is visible and leaves the saved library intact", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  await page
    .getByRole("button", { name: "Save current theme", exact: true })
    .click();
  await expect(page.locator(".visual-library-status")).toContainText(
    /save|storage|quota/i,
  );
  await expect(
    page.getByLabel("Saved preset", { exact: true }).locator("option"),
  ).toHaveCount(1);
});

test("brand-kit tokens and safe logo references can be reviewed, edited, exported and restored", async ({
  page,
}) => {
  await start(page);
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const source = await editor.inputValue();
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  await page.getByLabel("Preset name", { exact: true }).fill("Acme kit");
  await page.getByRole("button", { name: "Save brand kit" }).click();
  await page
    .getByLabel("Saved preset", { exact: true })
    .selectOption({ label: "brand kits: Acme kit" });
  await page.getByRole("button", { name: "Edit brand kit tokens" }).click();
  await page.getByLabel("Accent color", { exact: true }).fill("123abc");
  await page.locator("[data-kit-pattern]").selectOption("grid");
  await page
    .getByLabel("Light logo URL or path", { exact: true })
    .fill("assets/acme-light.svg");
  await page
    .getByLabel("Dark logo URL or path", { exact: true })
    .fill("https://example.com/acme-dark.svg");
  await page.getByLabel("Logo alt text", { exact: true }).fill("Acme logo");
  await page.getByRole("button", { name: "Review brand kit edits" }).click();
  await expect(page.getByText(/Accent #123abc/)).toBeVisible();
  await expect(
    page.getByText("assets/acme-light.svg", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("https://example.com/acme-dark.svg", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save reviewed brand kit" }).click();
  await page
    .getByLabel("Saved preset", { exact: true })
    .selectOption({ label: "brand kits: Acme kit" });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export preset" }).click();
  const exported = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  expect(exported.type).toBe("readme-studio-brand-kit");
  expect(exported.version).toBe(2);
  expect(exported.theme.palette.accent).toBe("123abc");
  expect(exported.banner.pattern).toBe("grid");
  expect(exported.logo).toEqual({
    light: "assets/acme-light.svg",
    dark: "https://example.com/acme-dark.svg",
    alt: "Acme logo",
  });
  await page.getByRole("button", { name: "Review preset" }).click();
  await expect(
    page.getByLabel("README logo markup", { exact: true }),
  ).toHaveValue(/<picture>/);
  await expect(
    page.getByRole("button", { name: "Copy reviewed logo markup" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save current theme" }).click();
  expect(
    await page
      .locator("app-shell")
      .evaluate((el) => el.data.visualLibrary.bundles[0].logo),
  ).toEqual(exported.logo);
  await expect(editor).toHaveValue(source);
  await page.reload();
  const saved = await page
    .locator("app-shell")
    .evaluate((el) => el.data.visualLibrary.bundles[0]);
  expect(saved.logo.alt).toBe("Acme logo");
  expect(saved.theme.palette.accent).toBe("123abc");
});

test("brand-kit edits reject stale libraries and failed storage without overwriting", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  await page.getByRole("button", { name: "Save brand kit" }).click();
  const selected = page.getByLabel("Saved preset", { exact: true });
  await selected.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Edit brand kit tokens" }).click();
  await page.getByLabel("Accent color", { exact: true }).fill("123abc");
  await page.getByRole("button", { name: "Review brand kit edits" }).click();
  await page.locator("[data-kit-alignment]").selectOption("right");
  await expect(
    page.getByRole("button", { name: "Save reviewed brand kit" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Review brand kit edits" }).click();
  await page.locator("app-shell").evaluate((el) => {
    el.data.visualLibrary.bundles[0].name = "Changed elsewhere";
  });
  await page.getByRole("button", { name: "Save reviewed brand kit" }).click();
  await expect(page.locator(".visual-library-status")).toContainText(
    /changed.*reopen/i,
  );
  expect(
    await page
      .locator("app-shell")
      .evaluate((el) => el.data.visualLibrary.bundles[0].theme.palette.accent),
  ).not.toBe("123abc");

  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Visual presets", exact: true })
    .click();
  await selected.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Edit brand kit tokens" }).click();
  await page.getByLabel("Accent color", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "Review brand kit edits" }).click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "Save reviewed brand kit" }).click();
  await expect(page.locator(".visual-library-status")).toContainText(
    /save|storage|quota/i,
  );
  expect(
    await page
      .locator("app-shell")
      .evaluate((el) => el.data.visualLibrary.bundles[0].theme.palette.accent),
  ).not.toBe("654321");
});
