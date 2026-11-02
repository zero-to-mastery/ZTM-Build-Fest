import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
export async function start(page) {
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
  await page
    .getByRole("button", { name: "Project Studio", exact: true })
    .click();
}
test("manual project, role, highlights, tech, badges, save and undo", async ({
  page,
}) => {
  await start(page);
  const source = await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const entry = page.locator(".project-entry").last();
  await entry.getByLabel("Project name", { exact: true }).fill("Useful CLI");
  await entry
    .getByLabel("Role — What did you personally contribute?")
    .fill("Testing Lead");
  await entry
    .getByLabel("Description — What does the project do?")
    .fill("Validates deployment configurations.");
  await entry
    .getByLabel("Repository URL", { exact: true })
    .fill("https://github.com/owner/cli");
  await entry
    .getByRole("button", { name: "Add engineering highlight" })
    .click();
  await entry.getByLabel("Highlight title", { exact: true }).fill("Testing");
  await entry
    .getByLabel("Highlight description", { exact: true })
    .fill("Exercised failure paths with integration tests.");
  await entry.getByLabel("Search or enter technology").fill("Rust");
  await entry
    .locator(".project-tech-results")
    .getByRole("button", { name: "Rust", exact: true })
    .click();
  await expect(page.locator(".project-preview")).toContainText("Testing Lead");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(source);
  await page
    .getByRole("button", { name: "Save showcase", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/Useful CLI/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(source);
});
test("project reorder, duplication, and mobile dialog remain operable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const entry = page.locator(".project-entry").last();
  await entry
    .getByLabel("Project name", { exact: true })
    .fill("Mobile project");
  const count = await page.locator(".project-entry").count();
  await entry
    .getByRole("button", { name: `Move project up ${count}`, exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .locator(".project-entry")
      .nth(count - 2)
      .locator("summary"),
  ).toBeFocused();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Save showcase", exact: true })
    .click();
});
test("review GitHub project import, refresh manual fields and confirm duplicates", async ({
  page,
}) => {
  await start(page);
  let description = "Repository description";
  await page.route("https://api.github.com/repos/owner/tool", (r) =>
    r.fulfill({
      json: {
        name: "tool",
        full_name: "owner/tool",
        description,
        homepage: "https://example.com",
        language: "Rust",
        topics: ["rust"],
        archived: true,
        stargazers_count: 8,
        forks_count: 1,
      },
    }),
  );
  const source = await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .inputValue();
  await page
    .getByRole("button", { name: "Import GitHub projects", exact: true })
    .click();
  await page.getByLabel("Repository (owner/repository)").fill("owner/tool");
  await page
    .getByRole("button", { name: "Look up repository", exact: true })
    .click();
  await expect(page.locator(".project-import-review")).toContainText(
    "Stars: 8",
  );
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(source);
  await page.getByLabel("Apply status", { exact: true }).check();
  await page.getByLabel("Apply technologies", { exact: true }).check();
  await page.getByRole("button", { name: "Apply reviewed projects" }).click();
  const entry = page.locator(".project-entry").last();
  await expect(entry.getByLabel("Live demo URL", { exact: true })).toHaveValue(
    "https://example.com",
  );
  await expect(entry.getByLabel("Project status", { exact: true })).toHaveValue(
    "Archived",
  );
  await entry
    .getByLabel("Description — What does the project do?")
    .fill("My authored explanation");
  description = "Updated upstream";
  await entry
    .getByRole("button", { name: "Refresh from GitHub", exact: true })
    .click();
  await expect(page.locator(".project-import-review")).toContainText(
    "Updated upstream",
  );
  await page.getByRole("button", { name: "Apply reviewed projects" }).click();
  await expect(
    page
      .locator(".project-entry")
      .last()
      .getByLabel("Description — What does the project do?"),
  ).toHaveValue("My authored explanation");
  await page
    .getByRole("button", { name: "Import GitHub projects", exact: true })
    .click();
  await page.getByLabel("Repository (owner/repository)").fill("owner/tool");
  await page
    .getByRole("button", { name: "Look up repository", exact: true })
    .click();
  await expect(page.locator(".project-import-review")).toContainText(
    "already included",
  );
  await page.getByRole("button", { name: "Apply reviewed projects" }).click();
  await expect(page.locator(".project-fetch-status")).toContainText(
    "Confirm the duplicate",
  );
  await page.getByLabel("I confirm adding a duplicate repository").check();
  await page.getByRole("button", { name: "Apply reviewed projects" }).click();
  await page
    .getByRole("button", { name: "Save showcase", exact: true })
    .click();
});
test("multi-repo selector keeps successful imports on partial failure", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    document.querySelector("project-studio").availableRepositories = [
      {
        full_name: "owner/good",
        description: "Useful",
        language: "Rust",
        archived: false,
        fork: false,
        updated_at: "2026-01-01",
      },
      {
        full_name: "owner/missing",
        description: "Unavailable",
        language: "Rust",
        archived: false,
        fork: false,
        updated_at: "2025-01-01",
      },
    ];
  });
  await page.route("https://api.github.com/repos/owner/**", (r) =>
    r.request().url().endsWith("missing")
      ? r.fulfill({ status: 404, json: { message: "Not Found" } })
      : r.fulfill({
          json: {
            name: "good",
            full_name: "owner/good",
            description: "Useful",
            language: "Rust",
          },
        }),
  );
  await page
    .getByRole("button", { name: "Import GitHub projects", exact: true })
    .click();
  await page
    .getByLabel("Repository language", { exact: true })
    .selectOption("Rust");
  await page.locator("[data-repo-choice]").first().check();
  await page.locator("[data-repo-choice]").last().check();
  await page
    .getByRole("button", { name: "Review selected repositories" })
    .click();
  await expect(page.locator(".project-fetch-status")).toContainText(
    "2 repositories requested · 1 ready for review · 1 unavailable",
  );
  await page.getByRole("button", { name: "Apply reviewed projects" }).click();
  await expect(page.locator(".project-status")).toContainText(
    "1 applied · 1 unavailable",
  );
});

test("layout presets, themed screenshots, mobile preview and clipboard fallback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await start(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const entry = page.locator(".project-entry").last();
  await entry.getByLabel("Project name", { exact: true }).fill("Layout demo");
  await entry
    .getByLabel("Image URL", { exact: true })
    .fill("https://example.com/light.png");
  await entry
    .getByLabel("Dark image URL", { exact: true })
    .fill("https://example.com/dark.png");
  await entry
    .getByLabel("Image alt text", { exact: true })
    .fill("Project overview");
  await page
    .getByLabel("Layout preset", { exact: true })
    .selectOption("Visual");
  await expect(page.locator(".project-preview table").first()).toBeVisible();
  await expect(page.locator(".project-preview source").last()).toHaveAttribute(
    "media",
    "(prefers-color-scheme: dark)",
  );
  await page.getByLabel("Project preview width").selectOption("320px");
  expect(
    await page
      .locator(".project-preview")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(320);
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
  await entry.getByRole("button", { name: /Copy project Markdown/ }).click();
  await expect(page.getByLabel("Copy project Markdown fallback")).toHaveValue(
    /Layout demo/,
  );
  await expect(page.getByLabel("Copy project Markdown fallback")).toBeFocused();
  await page
    .getByLabel("Showcase layout", { exact: true })
    .selectOption("case-study");
  await entry.getByLabel("Case study: problem").fill("Repeated work");
  await expect(page.locator(".project-preview")).toContainText("Repeated work");
  await page
    .getByRole("button", { name: "Save showcase", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Markdown editor",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveValue(/#### Problem/);
});

test("project packs validate, append with collision handling, export and remain reusable", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const entry = page.locator(".project-entry").last();
  await entry
    .getByLabel("Project name", { exact: true })
    .fill("Reusable project");
  await entry
    .getByLabel("Description — What does the project do?")
    .fill("Shared project description");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export project pack", exact: true })
    .click();
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toBe("projects.showcase.json");
  const exported = JSON.parse(await readFile(await downloaded.path(), "utf8"));
  const pack = { ...exported, projects: exported.projects.slice(-1) };
  await page.locator(".project-pack-tools summary").click();
  await page
    .getByLabel("Project pack JSON", { exact: true })
    .fill('{"version":99}');
  await page
    .getByRole("button", { name: "Review project pack", exact: true })
    .click();
  await expect(page.locator(".project-pack-review")).toContainText(
    "Invalid project pack",
  );
  await page
    .getByLabel("Project pack JSON", { exact: true })
    .fill(JSON.stringify(pack));
  await page
    .getByRole("button", { name: "Review project pack", exact: true })
    .click();
  await expect(page.locator(".project-pack-review")).toContainText(
    "1 projects",
  );
  await page
    .getByRole("button", { name: "Append reviewed projects", exact: true })
    .click();
  await expect(
    page.locator(".project-entry").last().locator("summary"),
  ).toContainText("Reusable project (2)");
  expect(
    await page
      .locator("project-studio")
      .evaluate(
        (el) =>
          new Set(el.value.items.map((p) => p.id)).size ===
          el.value.items.length,
      ),
  ).toBe(true);
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(page.locator(".project-entry[open]")).toHaveCount(0);
  await page
    .getByLabel("Search projects (name, technology, status, repository)")
    .fill("Reusable");
  await expect(page.locator(".project-entry:visible")).toHaveCount(2);
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await page
    .getByRole("button", { name: "Save showcase", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/Reusable project \(2\)/);
});
for (const count of [10, 25, 50, 100])
  test(`${count} projects defer closed forms and screenshots and remain editable`, async ({
    page,
  }) => {
    await start(page);
    await page.locator("project-studio").evaluate(async (el, count) => {
      const { normalizeProject } =
        await import("/src/projects/project-model.js");
      el.settings = {
        title: "Large showcase",
        layout: "detailed",
        items: Array.from({ length: count }, (_, i) =>
          normalizeProject({
            schemaVersion: 1,
            name: `Project ${i}`,
            description: "Description",
            role: "Developer",
            imageUrl: `https://example.com/project-shot-${i}.png`,
            imageAlt: `Project ${i} screenshot`,
            technologies: ["Rust"],
            highlights: [{ title: "Testing", description: "Failure paths" }],
          }),
        ),
      };
    }, count);
    await expect(page.locator(".project-entry")).toHaveCount(count);
    await expect(page.locator(".project-entry > fieldset")).toHaveCount(1);
    await expect(
      page.locator('.project-preview img[src*="project-shot-"]'),
    ).toHaveCount(1);
    await page
      .locator(".project-entry")
      .first()
      .getByLabel("Project name", { exact: true })
      .fill("Edited large showcase");
    await expect(page.locator(".project-preview")).toContainText(
      "Edited large showcase",
    );
    await page.locator(".project-entry").last().locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".project-entry > fieldset")).toHaveCount(2);
    await page
      .locator(".project-entry")
      .last()
      .getByRole("button", { name: `Move project up ${count}`, exact: true })
      .click();
    await expect(
      page
        .locator(".project-entry")
        .nth(count - 2)
        .locator("summary"),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Save showcase", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Markdown editor", exact: true }),
    ).toHaveValue(/Edited large showcase/);
  });
test("explicit link checking, Health guidance, offline editing and safe project metadata", async ({
  page,
  context,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const entry = page.locator(".project-entry").last();
  await entry
    .getByLabel("Project name", { exact: true })
    .fill("<script>window.projectAttack=1</script>");
  await entry
    .getByLabel("Image URL", { exact: true })
    .fill("https://example.com/screen.png");
  await entry
    .getByLabel("Live demo URL", { exact: true })
    .fill("https://link-check.example/missing");
  await page.route("https://link-check.example/**", (r) =>
    r.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } }),
  );
  await page.getByText("Check project links", { exact: true }).click();
  await page
    .getByRole("button", { name: "Check links now", exact: true })
    .click();
  await expect(page.locator(".project-link-results")).toContainText(
    "unavailable",
  );
  await page.getByText("Project guidance", { exact: true }).click();
  await expect(page.locator(".project-guidance")).toContainText("alt text");
  expect(await page.evaluate(() => window.projectAttack)).toBeUndefined();
  await context.setOffline(true);
  await entry
    .getByLabel("Description — What does the project do?")
    .fill("Local edits still work.");
  await expect(page.locator(".project-preview")).toContainText(
    "Local edits still work.",
  );
  await page
    .getByRole("button", { name: "Save showcase", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/Local edits still work/);
});

test("individual badges and collection copies stay attached to project output", async ({
  page,
}) => {
  await start(page);
  await page.locator("project-studio").evaluate((el) => {
    el.collections = [
      {
        id: "ci",
        name: "CI Collection",
        badges: [
          {
            label: "Tests",
            message: "passing",
            alt: "Test status",
            color: "green",
          },
        ],
      },
    ];
    el.draw();
  });
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const entry = page.locator(".project-entry").last();
  await entry.getByLabel("Project name", { exact: true }).fill("Badge project");
  await entry
    .getByLabel("Saved badge collection", { exact: true })
    .selectOption("ci");
  await entry
    .getByRole("button", { name: "Attach collection copy", exact: true })
    .click();
  await entry
    .getByRole("button", { name: "Create individual badge", exact: true })
    .click();
  const composer = page.locator(".project-badge-composer badge-studio");
  await composer.getByLabel("Label", { exact: true }).fill("Release");
  await composer
    .getByRole("button", { name: "Attach badge to project", exact: true })
    .click();
  await expect(
    entry.getByRole("button", { name: /Remove project badge/ }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Save showcase", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/shields.io\/badge\/Tests-passing/);
  await page.reload();
  await page
    .getByRole("button", { name: "Project Studio", exact: true })
    .click();
  await page.locator(".project-entry").last().locator("summary").click();
  await expect(
    page
      .locator(".project-entry")
      .last()
      .getByRole("button", { name: /Remove project badge/ }),
  ).toHaveCount(2);
});
