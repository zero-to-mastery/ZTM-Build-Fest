import { test, expect } from "@playwright/test";

test("repository templates are accessible from Create and produce editable local sections at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page
    .getByRole("button", { name: "Repository README", exact: true })
    .click();
  await expect(page.getByLabel("Repository template")).toBeFocused();
  await expect(
    page.getByLabel("Repository template").locator("option"),
  ).toHaveCount(12);
  await page.getByLabel("Repository template").selectOption("rust-crate");
  await page.getByLabel("Repository name", { exact: true }).fill("my-crate");
  await page.getByLabel("Repository description").fill("A small parser.");
  await page.getByLabel("Features", { exact: true }).uncheck();
  await page.getByText("Review generated Markdown", { exact: true }).click();
  await expect(page.getByLabel("Generated repository README")).toHaveValue(
    /## Minimum Rust version/,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "Create repository README" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const draft = await page.evaluate(
    () => document.querySelector("app-shell").store.draft,
  );
  expect(draft.markdown).toContain("# my-crate");
  expect(draft.markdown).not.toContain("## Features");
  expect(draft.metadata.repositoryReadme.templateId).toBe("rust-crate");
  expect(draft.blocks.length).toBeGreaterThan(2);
  await expect(page.locator(".workspace")).toHaveAttribute(
    "data-mobile",
    "build",
  );
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByLabel("Documentation project type")).toHaveValue(
    "rust-crate",
  );
  await expect(page.locator("[data-recommended]")).toContainText(
    "Cargo Dependency",
  );
});

test("Queue Improve README opens the suggested template with reviewed context and preserves original source", async ({
  page,
}) => {
  const source = "\ufeff# My Game\r\n\r\nMy existing notes.\r\n";
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill(
      route.request().url().includes("/users/")
        ? {
            json: [
              {
                name: "my-game",
                full_name: "example/my-game",
                description: "Local puzzle game",
                homepage: "https://example.org",
                language: "Rust",
                topics: ["game"],
                default_branch: "main",
                pushed_at: new Date().toISOString(),
              },
            ],
          }
        : {
            json: {
              path: "README.md",
              sha: "a".repeat(40),
              encoding: "base64",
              size: Buffer.byteLength(source),
              content: Buffer.from(source).toString("base64"),
            },
          },
    ),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page
    .getByRole("button", { name: "README Attention Queue", exact: true })
    .click();
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-count]")).toContainText(
    "1 included",
  );
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete",
  );
  await page
    .getByRole("button", { name: "Improve README", exact: true })
    .click();
  await expect(page.getByLabel("Repository template")).toHaveValue("game");
  await expect(page.getByLabel("Repository name", { exact: true })).toHaveValue(
    "my-game",
  );
  await expect(page.getByLabel("Repository description")).toHaveValue(
    "Local puzzle game",
  );
  await expect(
    page.getByLabel("Primary language", { exact: true }),
  ).toHaveValue("Rust");
  await expect(page.getByLabel("Repository topics")).toHaveValue("game");
  await page.getByLabel("Repository homepage").fill("");
  await page.getByLabel("Gameplay", { exact: true }).uncheck();
  await expect(
    page.getByRole("button", { name: "Create repository README" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByLabel("I reviewed the diff and approve this exact result")
    .check();

  await page.getByRole("button", { name: "Create repository README" }).click();
  const draft = await page.evaluate(
    () => document.querySelector("app-shell").store.draft,
  );
  expect(draft.blocks[0].settings.markdown).toBe(source);
  expect(draft.markdown.startsWith(source)).toBe(true);
  expect(draft.markdown).toContain("## Controls");
  expect(draft.markdown).not.toContain("https://example.org");
  expect(draft.metadata.repositoryReadme.reviewed.projectType).toBe("game");
  expect(draft.metadata.repositoryReadme.reviewed.homepage).toBe("");
});

test("imported README requires fresh keyboard diff approval and has a safe mobile preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page
    .getByRole("button", { name: "Repository README", exact: true })
    .click();
  await page.getByLabel("Repository name", { exact: true }).fill("Imported");
  await page.getByText("Import existing README", { exact: true }).click();
  const source =
    "# Existing\n\n## Setup\n\nInstall using your preferred package manager here.\n\n<script>window.templateInjected=true</script>\n";
  await page.getByLabel("Paste existing Markdown").fill(source);
  await page
    .getByRole("button", { name: "Use pasted README", exact: true })
    .click();
  await expect(page.getByLabel("Setup", { exact: true })).not.toBeChecked();
  const create = page.getByRole("button", {
    name: "Create repository README",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await page.getByText("Responsive rendered preview", { exact: true }).click();
  await page.getByLabel("Builder preview width").selectOption("320");
  await page.getByLabel("Builder preview theme").selectOption("dark");
  await expect(page.locator("[data-builder-paper]")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  expect(await page.evaluate(() => window.templateInjected)).toBeUndefined();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review README changes" }),
  ).toBeFocused();
  await expect(page.getByLabel("Existing README source")).toHaveValue(source);
  const confirm = page.getByLabel(
    "I reviewed the diff and approve this exact result",
  );
  await confirm.focus();
  await page.keyboard.press("Space");
  await expect(create).toBeEnabled();
  await page.getByLabel("Repository description").fill("Revised context");
  await expect(create).toBeDisabled();
  await expect(page.locator("[data-review-panel]")).toBeHidden();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await confirm.check();
  await create.click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toMatch(/^# Existing/);
});

test("replacement requires review and local file can instead open unchanged", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page
    .getByRole("button", { name: "Repository README", exact: true })
    .click();
  await page.getByLabel("Repository name", { exact: true }).fill("Local");
  await page.getByText("Import existing README", { exact: true }).click();
  const source = "\ufeff# Preserve\r\n\r\nExact source  \r\n";
  await page.locator("[data-file]").setInputFiles({
    name: "README.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(source),
  });
  await expect(
    page.locator("repository-readme-builder [role=status]"),
  ).toContainText("imported");
  await page.getByLabel("Keep existing README verbatim").uncheck();
  await expect(
    page.getByRole("button", { name: "Create repository README" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(page.locator("[data-review-warning]")).toContainText(
    "Replacement",
  );
  await expect(page.getByLabel("Existing README source")).toHaveValue(
    source.replace(/\r\n/g, "\n"),
  );
  await page
    .getByRole("button", { name: "Open existing README unchanged" })
    .click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);
});

test("current draft import is temporary, invalid files preserve source, and Escape returns focus", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const before = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.markdown,
  );
  const trigger = page.getByRole("button", {
    name: "Repository README",
    exact: true,
  });
  await trigger.click();
  await page.getByText("Import existing README", { exact: true }).click();
  await page
    .getByRole("button", { name: "Use current draft as existing README" })
    .click();
  await page.getByLabel("Repository name", { exact: true }).fill("Review");
  await page.locator("[data-file]").setInputFiles({
    name: "broken.md",
    mimeType: "text/markdown",
    buffer: Buffer.from([255, 254]),
  });
  await expect(
    page.locator("repository-readme-builder [role=status]"),
  ).toContainText("valid UTF-8");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(page.getByLabel("Existing README source")).toHaveValue(before);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(before);
});
