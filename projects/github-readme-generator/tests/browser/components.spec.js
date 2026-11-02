import { test, expect } from "@playwright/test";
async function start(page) {
  await page.route("https://**/*", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "Components", exact: true }).click();
}
test("search, favorite, preview source and insert component with undo", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("Search components", { exact: true }).fill("terminal");
  await expect(page.locator(".component-results article")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Favorite Terminal heading", exact: true })
    .click();
  await page
    .getByLabel("Library view", { exact: true })
    .selectOption("favorites");
  await expect(page.locator(".component-results article")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Preview Terminal heading", exact: true })
    .click();
  await page.getByLabel("Title", { exact: true }).fill("My work");
  await page
    .getByRole("button", { name: "Render preview", exact: true })
    .click();
  await expect(page.locator(".component-preview")).toContainText("My work");
  await page
    .getByRole("button", { name: "Insert component", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/## \$ My work/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).not.toHaveValue(/## \$ My work/);
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page.getByLabel("Library view", { exact: true }).selectOption("recent");
  await expect(page.locator(".component-results article")).toHaveCount(1);
});
test("saved snippet preserves source across reload and mobile dialog remains usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page.getByText("Save My Snippet", { exact: true }).click();
  await page.getByLabel("Snippet name", { exact: true }).fill("My raw snippet");
  const source = "# Mine\n\n{{untouched}} <script>example</script>";
  await page.getByLabel("Snippet Markdown", { exact: true }).fill(source);
  await page.getByRole("button", { name: "Save snippet locally" }).click();
  await page.getByLabel("Library view", { exact: true }).selectOption("saved");
  await page
    .getByRole("button", { name: "Preview My raw snippet", exact: true })
    .click();
  await expect(
    page.getByLabel("Component Markdown", { exact: true }),
  ).toHaveValue(source);
  await page
    .getByRole("button", { name: "Render preview", exact: true })
    .click();
  await expect(page.locator(".component-preview script")).toHaveCount(0);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page.getByLabel("Library view", { exact: true }).selectOption("saved");
  await expect(page.locator(".component-results article")).toHaveCount(1);
});

test("Widget Hub generates typing URLs without requests while typing and inserts a picture embed", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Widget Hub", exact: true }).click();
  await page
    .getByRole("button", { name: "Configure Typing SVG", exact: true })
    .click();
  let requests = 0;
  await page.route("https://readme-typing-svg.demolab.com/**", (r) => {
    requests++;
    return r.abort();
  });
  await page
    .getByLabel("Typing lines", { exact: true })
    .fill("Hello + Rust\nSnow 雪");
  await page
    .getByRole("button", { name: "Generate typing URL", exact: true })
    .click();
  await expect(page.getByLabel("Image URL", { exact: true })).toHaveValue(
    /lines=Hello/,
  );
  expect(requests).toBe(0);
  await page
    .getByRole("button", { name: "Favorite widget", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Favorite widget", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Load remote preview", exact: true })
    .click();
  await expect(page.locator(".widget-status")).toContainText(
    "Remote image failed",
  );
  await page
    .getByLabel("Dark image URL", { exact: true })
    .fill("https://example.com/dark.svg");
  await page.getByLabel("Alignment", { exact: true }).selectOption("center");
  await page
    .getByRole("button", { name: "Insert widget", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/<picture>/);
});
test("Metrics helper stays usable offline with attribution, copy fallback and no integration", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Widget Hub", exact: true }).click();
  await page
    .getByRole("button", { name: "Configure GitHub Metrics", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "GitHub Metrics", exact: true }),
  ).toHaveAttribute("href", "https://github.com/lowlighter/metrics");
  await page
    .getByLabel("Image URL", { exact: true })
    .fill("https://example.com/metrics.svg");
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Load remote preview", exact: true })
    .click();
  await expect(page.locator(".widget-status")).toContainText("Offline");
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
    .getByRole("button", { name: "Copy widget Markdown", exact: true })
    .click();
  await expect(
    page.getByLabel("Widget Markdown", { exact: true }),
  ).toBeFocused();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Insert widget", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("snippet packs preview, import examples, keep collisions, export and import in a fresh workspace", async ({
  page,
  browser,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Snippet packs", exact: true })
    .click();
  await page.getByLabel("Example pack", { exact: true }).selectOption("2");
  await page
    .getByRole("button", { name: "Review example pack", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Import Terminal Kit", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Collision policy", { exact: true }),
  ).toHaveValue("keep");
  await expect(
    page.getByLabel("Pack item Markdown", { exact: true }),
  ).toHaveValue(/whoami/);
  await page
    .getByRole("button", { name: "Import reviewed pack", exact: true })
    .click();
  await expect(page.locator(".pack-status")).toContainText("imported locally");
  await page.getByLabel("Example pack", { exact: true }).selectOption("2");
  await page
    .getByRole("button", { name: "Review example pack", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import reviewed pack", exact: true })
    .click();
  await page.getByLabel("Pack name", { exact: true }).fill("My Terminal Kit");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download all reusable snippets backup",
      exact: true,
    })
    .click();
  const file = await download;
  const fs = await import("node:fs/promises");
  const json = await fs.readFile(await file.path(), "utf8");
  expect(JSON.parse(json).snippets).toHaveLength(6);
  await page.keyboard.press("Escape");
  const freshContext = await browser.newContext();
  const fresh = await freshContext.newPage();
  await start(fresh);
  await fresh.keyboard.press("Escape");
  await fresh
    .getByRole("button", { name: "Snippet packs", exact: true })
    .click();
  await fresh.getByLabel("Snippet pack JSON", { exact: true }).fill(json);
  await fresh
    .getByRole("button", { name: "Review snippet pack", exact: true })
    .click();
  await fresh
    .getByRole("button", { name: "Import reviewed pack", exact: true })
    .click();
  await fresh.keyboard.press("Escape");
  await fresh.getByRole("button", { name: "Components", exact: true }).click();
  await fresh.getByLabel("Library view", { exact: true }).selectOption("saved");
  await expect(fresh.locator(".component-results article")).toHaveCount(6);
  await freshContext.close();
});
test("a delayed snippet-pack preload cannot replace a newer dialog", async ({
  page,
}) => {
  let release;
  const delayed = new Promise((resolve) => (release = resolve));
  await page.route(
    "**/src/components/snippet-pack-dialog.js*",
    async (route) => {
      await delayed;
      await route.continue();
    },
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page
    .getByRole("button", { name: "Snippet packs", exact: true })
    .click();
  await expect(page.getByText("Loading snippet-pack tools…")).toBeVisible();
  await page.locator("app-shell").evaluate((shell) => shell.openWidgets());
  await expect(
    page.getByRole("heading", { name: "Dynamic Widget Hub", exact: true }),
  ).toBeVisible();
  const loaded = page.waitForResponse((response) =>
    response.url().includes("/src/components/snippet-pack-dialog.js"),
  );
  release();
  await loaded;
  await expect(page.locator("snippet-pack-dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Dynamic Widget Hub", exact: true }),
  ).toBeVisible();
});
test("malicious pack metadata and storage failure leave reusable state unchanged", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Snippet packs", exact: true })
    .click();
  await page.getByLabel("Snippet pack JSON", { exact: true }).fill(
    JSON.stringify({
      version: 1,
      type: "readme-studio-snippet-pack",
      name: "<img src=x onerror=alert(1)>",
      snippets: [],
    }),
  );
  await page
    .getByRole("button", { name: "Review snippet pack", exact: true })
    .click();
  await expect(page.locator(".pack-status")).toContainText("plain text");
  await expect(page.locator(".pack-review img")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review example pack", exact: true })
    .click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
  });
  await page
    .getByRole("button", { name: "Import reviewed pack", exact: true })
    .click();
  await expect(page.locator(".pack-status")).toContainText(
    "Could not import pack",
  );
  expect(
    await page
      .locator("app-shell")
      .evaluate((el) => el.data.componentLibrary?.snippets.length || 0),
  ).toBe(0);
});

test("extension packs expose provenance and capabilities, import offline, and reject executable manifests", async ({
  page,
  context,
}) => {
  await start(page);
  const sourceBefore = await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .inputValue();
  await page.keyboard.press("Escape");
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Snippet packs", exact: true })
    .click();
  const pack = {
    version: 2,
    type: "readme-studio-snippet-pack",
    name: "Reviewed extensions",
    author: "Ada",
    homepage: "https://example.com/kit",
    snippets: [],
    badgeCollections: [],
    extensions: [
      {
        version: 1,
        type: "readme-studio-extension-manifest",
        name: "Release cards",
        description: "Declarative release Markdown",
        publisher: {
          name: "Ada",
          url: "https://example.com/extensions",
        },
        capabilities: ["render-markdown", "external-media"],
        entries: [
          {
            version: 1,
            id: "release-card",
            name: "Release card",
            category: "Utilities",
            description: "A portable release heading",
            kind: "custom",
            fields: [],
            tags: ["release"],
            template:
              "## Release\n\n![Status](https://cdn.example.com/status.svg)",
          },
        ],
      },
    ],
  };
  await page
    .getByLabel("Snippet pack JSON", { exact: true })
    .fill(JSON.stringify(pack));
  await page
    .getByRole("button", { name: "Review snippet pack", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Import Reviewed extensions",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    page.getByText("Import trust review", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Source: Pasted JSON · Author: Ada/),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Claimed extension publishers: Ada — https:\/\/example.com\/extensions/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/external-media, render-markdown/)).toBeVisible();
  await expect(page.getByText(/cannot load or evaluate scripts/)).toBeVisible();
  await expect(
    page.getByText("https://cdn.example.com/status.svg", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import reviewed pack", exact: true })
    .click();
  await expect(page.locator(".pack-status")).toContainText("imported locally");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(sourceBefore);
  expect(
    await page
      .locator("app-shell")
      .evaluate(
        (el) =>
          el.data.componentLibrary.snippets.find(
            (snippet) => snippet.name === "Release card",
          )?.template,
      ),
  ).toBe("## Release\n\n![Status](https://cdn.example.com/status.svg)");

  pack.extensions[0].script = "globalThis.extensionExecuted = true";
  await page
    .getByLabel("Snippet pack JSON", { exact: true })
    .fill(JSON.stringify(pack));
  await page
    .getByRole("button", { name: "Review snippet pack", exact: true })
    .click();
  await expect(page.locator(".pack-status")).toContainText(
    "cannot include executable",
  );
  expect(
    await page.evaluate(() => globalThis.extensionExecuted),
  ).toBeUndefined();
  await context.setOffline(false);
});

test("component customizer saves presets, duplicates independently and detaches on manual source editing", async ({
  page,
}) => {
  await start(page);
  await page
    .getByLabel("Search components", { exact: true })
    .fill("terminal heading");
  await page
    .getByRole("button", { name: "Preview Terminal heading", exact: true })
    .click();
  await page.getByLabel("Title", { exact: true }).fill("First heading");
  await page
    .getByRole("button", { name: "Insert component", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Edit visually: Terminal heading/ })
    .click();
  await page.locator('[data-custom-field="title"]').fill("Configured heading");
  await page
    .getByLabel("Component preset name", { exact: true })
    .fill("My Terminal Header");
  await page
    .getByRole("button", {
      name: "Save configured component preset",
      exact: true,
    })
    .click();
  await expect(page.locator(".customizer-status")).toContainText(
    "saved locally",
  );
  await page
    .getByRole("button", {
      name: "Duplicate configured component",
      exact: true,
    })
    .click();
  const instances = await page
    .locator("app-shell")
    .evaluate((el) =>
      el.store.draft.blocks.filter((b) => b.type === "component"),
    );
  expect(instances).toHaveLength(2);
  expect(instances[0].settings.markdown).toContain("First heading");
  expect(instances[1].settings.markdown).toContain("Configured heading");
  expect(instances[0].id).not.toBe(instances[1].id);
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const source = await editor.inputValue();
  const types = () =>
    page
      .locator("app-shell")
      .evaluate((el) => el.store.draft.blocks.map((b) => b.type));
  // Appending after the components keeps them visual.
  await editor.fill(source + "\nManual addition");
  expect((await types()).filter((t) => t === "component")).toHaveLength(2);
  // Editing inside one component detaches only that component.
  await editor.fill(
    source.replace("First heading", "First heading edited") +
      "\nManual addition",
  );
  await expect(page.locator(".toast")).toContainText("(component)");
  await expect(page.locator(".toast")).toContainText(
    "Undo restores visual ownership",
  );
  expect((await types()).filter((t) => t === "component")).toHaveLength(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(
    await page
      .locator("app-shell")
      .evaluate(
        (el) =>
          el.store.draft.blocks.filter((b) => b.type === "component").length,
      ),
  ).toBe(2);
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page.getByLabel("Library view", { exact: true }).selectOption("saved");
  await page
    .getByRole("button", { name: "Preview My Terminal Header", exact: true })
    .click();
  await expect(
    page.getByLabel("Component Markdown", { exact: true }),
  ).toHaveValue("## $ Configured heading");
});
test("modified component source requires explicit diff confirmation before visual replacement", async ({
  page,
}) => {
  await start(page);
  await page
    .getByLabel("Search components", { exact: true })
    .fill("terminal heading");
  await page
    .getByRole("button", { name: "Preview Terminal heading", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Insert component", exact: true })
    .click();
  await page.locator("app-shell").evaluate((el) => {
    const blocks = structuredClone(el.store.draft.blocks);
    blocks.find((b) => b.type === "component").settings.markdown +=
      "\nMANUAL NOTE";
    el.store.blocks(blocks);
  });
  await page
    .getByRole("button", { name: /Edit visually: Terminal heading/ })
    .click();
  await expect(
    page.getByLabel("Current Markdown", { exact: true }),
  ).toHaveValue(/MANUAL NOTE/);
  await page.locator('[data-custom-field="title"]').fill("Reviewed");
  await page
    .getByRole("button", { name: "Save component changes", exact: true })
    .click();
  await expect(page.locator(".customizer-status")).toContainText(
    "confirm replacement",
  );
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/MANUAL NOTE/);
  await page
    .getByLabel("Replace current source with generated Markdown", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Save component changes", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/## \$ Reviewed/);
});
test("widget and badge components reopen their specific forms and save without changing sibling source", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Widget Hub", exact: true }).click();
  await page
    .getByRole("button", { name: "Configure Typing SVG", exact: true })
    .click();
  await page.getByLabel("Typing lines", { exact: true }).fill("First line");
  await page
    .getByRole("button", { name: "Generate typing URL", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Insert widget", exact: true })
    .click();
  await page.getByRole("button", { name: /Edit visually: Typing SVG/ }).click();
  await expect(page.getByLabel("Typing lines", { exact: true })).toHaveValue(
    "First line",
  );
  await page.getByLabel("Typing lines", { exact: true }).fill("Second line");
  await page
    .getByRole("button", { name: "Generate typing URL", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save component changes", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/lines=Second\+line/);
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page
    .getByLabel("Search components", { exact: true })
    .fill("technology row");
  await page
    .getByRole("button", { name: "Preview Technology row", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Insert component", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Edit visually: Technology row/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Badge row settings", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-new-collection]")).not.toBeVisible();
  await page.getByRole("button", { name: "Edit badge 1", exact: true }).click();
  await page.locator('[data-badge-field="label"]').fill("Custom tech");
  await page
    .getByRole("button", { name: "Use badge in collection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add badge to collection", exact: true }),
  ).toBeFocused();
  const count = await page.locator(".collection-badges > li").count();
  await page
    .getByRole("button", { name: "Duplicate badge 1", exact: true })
    .click();
  await expect(page.locator(".collection-badges > li")).toHaveCount(count + 1);
  await page
    .getByRole("button", { name: "Save component changes", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/lines=Second\+line/);
});
test("large component libraries render bounded cards, support keyboard search and rename/delete safely", async ({
  page,
}) => {
  await start(page);
  await page.locator("app-shell").evaluate((el) => {
    el.saveComponentLibrary({
      library: {
        version: 1,
        favorites: [],
        recents: [],
        snippets: Array.from({ length: 200 }, (_, i) => ({
          version: 1,
          id: `saved-${i}`,
          name: `My snippet ${i}`,
          description: "Local source",
          category: "Utilities",
          kind: "custom",
          fields: [],
          tags: ["large"],
          template: `## Item ${i}`,
        })),
      },
    });
  });
  await page.getByLabel("Library view", { exact: true }).selectOption("saved");
  await expect(page.locator(".component-results article")).toHaveCount(40);
  await expect(page.locator(".component-results img")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show more components", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".component-results article")).toHaveCount(80);
  await page
    .getByLabel("Search components", { exact: true })
    .fill("My snippet 199");
  await expect(page.locator(".component-results article")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Preview My snippet 199", exact: true })
    .click();
  await page
    .getByLabel("Saved component name", { exact: true })
    .fill("Renamed snippet");
  await page
    .getByRole("button", { name: "Rename saved component", exact: true })
    .click();
  await page
    .getByLabel("Search components", { exact: true })
    .fill("Renamed snippet");
  await page
    .getByRole("button", { name: "Preview Renamed snippet", exact: true })
    .click();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete saved component", exact: true })
    .click();
  await expect(
    page.getByLabel("Search components", { exact: true }),
  ).toBeFocused();
  await expect(page.locator(".component-results article")).toHaveCount(0);
});
