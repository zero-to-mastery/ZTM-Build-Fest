import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "../../src/badges/contrast.js";
const key = "readme-studio:v1";
const editor = (p) =>
  p.getByRole("textbox", { name: "Markdown editor", exact: true });
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}
const backup = {
  version: 1,
  createdAt: "2026-09-27T00:00:00Z",
  drafts: [
    {
      id: "collision",
      name: "Restored",
      markdown: "# Recovered\r\n  exact  ",
      metadata: {},
      blocks: [],
    },
  ],
  active: "collision",
  settings: { theme: "dark", preview: "375" },
};
async function restore(page, mode = "merge") {
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page
    .getByRole("button", { name: "Restore backup", exact: true })
    .click();
  await page.getByLabel("Workspace backup file").setInputFiles({
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator("#restore-status")).toContainText(
    "1 drafts · backup version 1",
  );
  await page.getByLabel("Restore mode", { exact: true }).selectOption(mode);
}
test.beforeEach(async ({ page }) => {
  await page.route("https://**/*", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" />',
    }),
  );
});
test("keyboard focus returns from dialogs and section reordering stays operable", async ({
  page,
}) => {
  await start(page);
  const trigger = page.getByRole("button", { name: "Manage drafts" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Draft name", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Rename", exact: true }),
  ).toBeFocused();
  for (let i = 0; i < 14; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.querySelector("dialog").contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Library", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Sections", exact: true }).click();
  const down = page.getByRole("button", {
    name: "Move Hero down",
    exact: true,
  });
  await down.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(
    await down.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Move Hero down", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page
    .getByRole("button", { name: "Delete this draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete draft", exact: true }).click();
  await expect(page.getByLabel("Current draft")).toBeFocused();
});
test("corrupted storage stays untouched and recovery/download remain available", async ({
  page,
}) => {
  await page.addInitScript((k) => localStorage.setItem(k, "{broken"), key);
  // Unreadable storage is not a first run: no Guided start covers the notice.
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator(".recovery-notice")).toContainText(
    "original storage is untouched",
  );
  await editor(page).fill("# Temporary work");
  await expect(page.locator("github-preview h1")).toHaveText("Temporary work");
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), key))
    .toBe("{broken");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download original recovery data" })
    .click();
  expect(readFileSync(await (await download).path(), "utf8")).toBe("{broken");
  const all = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download all drafts backup", exact: true })
    .click();
  const data = JSON.parse(readFileSync(await (await all).path(), "utf8"));
  expect(data.drafts[0].markdown).toBe("# Temporary work");
});
test("quota and unavailable storage show recovery without losing editor state", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException("Full", "QuotaExceededError");
    };
  });
  await start(page);
  await editor(page).fill("# Keep me");
  await expect(page.locator(".recovery-notice")).toContainText(
    "full or unavailable",
  );
  await expect(editor(page)).toHaveValue("# Keep me");
  await expect(page.locator(".save-status")).not.toHaveText("Saved locally");
  const download = page.waitForEvent("download");
  await page.locator(".workspace-tools [data-action=download]").click();
  expect(readFileSync(await (await download).path(), "utf8")).toBe("# Keep me");
});
test("unavailable storage reads open a temporary usable workspace", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = function () {
      throw new DOMException("Denied", "SecurityError");
    };
  });
  await start(page);
  await expect(page.locator(".recovery-notice")).toContainText(
    "temporary workspace",
  );
  await editor(page).fill("# Memory only");
  await expect(page.locator("github-preview h1")).toHaveText("Memory only");
  await expect(page.locator(".save-status")).not.toHaveText("Saved locally");
});
test("desktop resizing and collapsed panes retain reachable controls", async ({
  page,
}) => {
  await start(page);
  for (const width of [820, 1000, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(editor(page)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.getByRole("button", { name: "Collapse builder" }).click();
  await expect(page.locator(".builder-pane")).not.toBeVisible();
  await editor(page).fill("# Wide editor");
  await page.getByRole("button", { name: "Show builder", exact: true }).click();
  await expect(page.locator(".builder-pane")).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .locator(".library-grid")
    .getByRole("button", { name: "Social links", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Add social link", exact: false })
    .click();
  await expect(page.locator("builder-form")).toBeVisible();
});
test("backup restore previews, requires replacement confirmation, merges collisions and persists", async ({
  page,
}) => {
  await start(page);
  await restore(page, "replace");
  await page.locator("#apply-restore").click();
  await expect(page.locator("#restore-status")).toContainText(
    "Confirm replacing",
  );
  await page.locator("#restore-confirm").check();
  await page.locator("#apply-restore").click();
  await expect(page.getByLabel("Current draft")).toBeFocused();
  await expect(editor(page)).toHaveValue("# Recovered\n  exact  ");
  await page.reload();
  await expect(page.getByLabel("Current draft")).toContainText("Restored");
  await restore(page);
  await page.locator("#apply-restore").click();
  await expect(page.getByLabel("Current draft")).toContainText("Restored (2)");
  const data = await page.evaluate(
    (k) => JSON.parse(localStorage.getItem(k)),
    key,
  );
  expect(new Set(data.drafts.map((d) => d.id)).size).toBe(2);
  expect(data.drafts[0].markdown).toBe(backup.drafts[0].markdown);
});
test("rapid edits flush on draft switch and history stays scoped to its draft", async ({
  page,
}) => {
  await start(page);
  await editor(page).fill("# Final rapid state");
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page
    .getByRole("button", { name: "New blank draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue("");
  await page.getByLabel("Current draft").selectOption({ index: 0 });
  await expect(editor(page)).toHaveValue("# Final rapid state");
  await editor(page).fill("# Unload flush");
  await page.reload();
  await expect(editor(page)).toHaveValue("# Unload flush");
});
test("clipboard denial exposes selectable fallback; offline edit and export work", async ({
  page,
  context,
}) => {
  await start(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
      configurable: true,
    });
  });
  await editor(page).fill("# Offline source");
  await page
    .getByRole("button", { name: "Copy Markdown", exact: true })
    .click();
  await expect(page.getByLabel("Markdown to copy")).toHaveValue(
    "# Offline source",
  );
  await expect(page.getByLabel("Markdown to copy")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.route("https://api.github.com/**", (r) =>
    r.abort("internetdisconnected"),
  );
  await context.setOffline(true);
  await editor(page).fill("# Still editing");
  await expect(page.locator("github-preview h1")).toHaveText("Still editing");
  const event = page.waitForEvent("download");
  await page.locator(".workspace-tools [data-action=download]").click();
  expect(readFileSync(await (await event).path(), "utf8")).toBe(
    "# Still editing",
  );
  await page.locator(".workspace-tools [data-action=import]").click();
  await page.getByLabel("GitHub username or owner/repository").fill("ada");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(page.locator(".import-result")).toContainText("offline");
  await context.setOffline(false);
});
test("preview failure and global error preserve source and expose recovery actions", async ({
  page,
}) => {
  await start(page);
  await editor(page).fill("# Recoverable");
  await page.evaluate(() => {
    const preview = document.querySelector("github-preview");
    preview.anchors = () => {
      throw new Error("Injected preview failure");
    };
    document.querySelector("app-shell").refreshDocument();
  });
  await expect(page.locator("github-preview")).toContainText(
    "Preview could not be rendered",
  );
  await expect(editor(page)).toHaveValue("# Recoverable");
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent("error", { message: "Injected unexpected failure" }),
    ),
  );
  await expect(page.locator(".runtime-notice")).toContainText(
    "unexpected error",
  );
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download current draft", exact: true })
    .click();
  expect(readFileSync(await (await event).path(), "utf8")).toBe(
    "# Recoverable",
  );
});
test("malicious preview cannot execute and export remains exact", async ({
  page,
}) => {
  await start(page);
  const source = readFileSync("tests/fixtures/malicious-readme.md", "utf8");
  await editor(page).fill(source);
  await expect(page.locator("github-preview h1")).toHaveText(
    "Security fixture",
  );
  expect(await page.evaluate(() => window.compromised)).toBeUndefined();
  expect(
    await page
      .locator(
        "github-preview script,github-preview iframe,github-preview object,github-preview embed,github-preview form,github-preview button",
      )
      .count(),
  ).toBe(0);
  const event = page.waitForEvent("download");
  await page.locator(".workspace-tools [data-action=download]").click();
  expect(readFileSync(await (await event).path(), "utf8")).toBe(
    source.replace(/\r\n/g, "\n"),
  );
});
for (const [width, height] of [
  [320, 700],
  [375, 812],
  [390, 844],
  [430, 932],
  [768, 1024],
])
  test(`usable layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await start(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width <= 760) {
      await page.locator(".mobile-nav [data-pane=markdown]").click();
      await expect(editor(page)).toBeFocused();
      await editor(page).fill(
        "# Mobile\n\n```txt\n" + "long".repeat(100) + "\n```",
      );
      await page.locator(".mobile-nav [data-pane=preview]").click();
      await expect(page.locator(".preview-pane .pane-heading")).toBeFocused();
      await expect(page.locator("github-preview h1")).toHaveText("Mobile");
      await page.locator(".mobile-nav [data-pane=health]").click();
      await expect(page.locator("readme-health .stats")).toBeVisible();
    }
    await page.getByRole("button", { name: "Manage drafts" }).click();
    await page
      .getByLabel("Draft name", { exact: true })
      .fill("Long name ".repeat(25));
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const event = page.waitForEvent("download");
    await page.locator(".workspace-tools [data-action=download]").click();
    if (width <= 760)
      await page
        .locator("example-export-check")
        .getByRole("button", { name: "Export current source anyway" })
        .click();
    await event;
    await page.getByRole("button", { name: "Manage drafts" }).click();
    expect(
      await page
        .locator("dialog")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  });
test("reduced motion and preview themes do not mutate Markdown", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await start(page);
  const source =
    '<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.svg"><img src="https://example.com/light.svg" alt="Theme"></picture>';
  await editor(page).fill(source);
  await expect(page.locator("github-preview source")).toHaveAttribute(
    "media",
    "not all",
  );
  await page
    .getByRole("button", { name: "Toggle preview color theme" })
    .click();
  await expect(page.locator("github-preview source")).toHaveAttribute(
    "media",
    "all",
  );
  await expect(editor(page)).toHaveValue(source);
  await page
    .getByRole("button", { name: "Toggle color theme", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle preview color theme", exact: true })
    .click();
  await expect(page.locator(".preview-paper")).toHaveAttribute(
    "data-theme",
    "light",
  );
  expect(
    await page
      .locator(".preview-paper")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--bg").trim()),
  ).toBe("#fff");
  await expect(page.locator("github-preview source")).toHaveAttribute(
    "media",
    "not all",
  );
  await expect(editor(page)).toHaveValue(source);
  expect(
    await page
      .locator("button")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
});
test("Epic 10 reflow, theme contrast, live status and focus remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await start(page);
  await page.locator(".mobile-nav [data-pane=markdown]").click();
  const source = "# Accessible source\n\nExact local text.";
  await editor(page).focus();
  await editor(page).fill(source);
  await expect(page.locator(".save-announcement")).toHaveAttribute(
    "role",
    "status",
  );
  await expect(page.locator(".save-announcement")).toHaveText(
    "Draft saved locally.",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        ["--text", "--muted", "--accent", "--bg"].map((name) => [
          name,
          style.getPropertyValue(name).trim(),
        ]),
      );
    });
    expect(
      contrastRatio(colors["--text"], colors["--bg"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colors["--muted"], colors["--bg"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colors["--accent"], colors["--bg"]),
    ).toBeGreaterThanOrEqual(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  }

  const importButton = page.getByRole("button", { name: "Import" });
  await importButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Local file", exact: true }).click();
  await expect(page.getByLabel("README.md or text file")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(importButton).toBeFocused();
  await expect(editor(page)).toHaveValue(source);
});
for (const kb of [100, 250])
  test(`${kb} KB editing, preview, worker health, parsing and autosave complete`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60000);
    await start(page);
    let source =
      "# Large\n\n" +
      "Useful paragraph with [a link](https://example.com).\n\n".repeat(
        Math.ceil((kb * 1024) / 53),
      );
    const started = Date.now();
    const inputMs = await page.evaluate((markdown) => {
      const input = document.querySelector("markdown-editor textarea");
      const began = performance.now();
      input.value = markdown;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return performance.now() - began;
    }, source);
    await expect(page.locator("github-preview h1")).toHaveText("Large");
    const previewMs = Date.now() - started;
    await editor(page).focus();
    await page.keyboard.press("Control+End");
    const editStart = Date.now();
    await page.keyboard.insertText("x");
    const editMs = Date.now() - editStart;
    source += "x";
    await page.getByRole("button", { name: "Health", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (expected) =>
            document.querySelector("readme-health").completedSource ===
            expected,
          source,
        ),
      )
      .toBe(true);
    await expect(page.locator("readme-health .stats")).toBeVisible({
      timeout: 20000,
    });
    const healthMs = Date.now() - started - previewMs;
    await expect
      .poll(() =>
        page.evaluate(
          (k) => JSON.parse(localStorage.getItem(k)).drafts[0].markdown,
          key,
        ),
      )
      .toBe(source);
    const metrics = await page.evaluate(
      async ({ source, key }) => {
        const { detectSections } = await import("/src/markdown/sections.js");
        let start = performance.now();
        detectSections(source);
        const sectionMs = performance.now() - start;
        start = performance.now();
        document.querySelector("app-shell").save();
        return {
          sectionMs,
          saveMs: performance.now() - start,
          history: document.querySelector("app-shell").store.past.length,
        };
      },
      { source, key },
    );
    await testInfo.attach("performance.json", {
      body: JSON.stringify({
        kb,
        inputMs,
        editMs,
        previewMs,
        healthMs,
        ...metrics,
      }),
      contentType: "application/json",
    });
    expect(metrics.history).toBeLessThanOrEqual(80);
    console.info(
      JSON.stringify({
        engine: testInfo.project.name,
        kb,
        inputMs,
        editMs,
        previewMs,
        healthMs,
        ...metrics,
      }),
    );
  });
