import { test, expect } from "@playwright/test";
async function start(page) {
  await page.route("https://**/*", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    }),
  );
  await page.route("https://api.github.com/repos/ada/*", (r) =>
    r.fulfill({
      json: {
        name: r.request().url().split("/").at(-1),
        full_name: "ada/" + r.request().url().split("/").at(-1),
        description: "A public project",
        language: "JavaScript",
        topics: ["react", "pwa"],
        homepage: "https://example.com",
        stargazers_count: 5,
        default_branch: "main",
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}
test("repository lookup, multi-select, reviewed insertion, ownership and undo", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  for (const name of ["one", "two"]) {
    await page.getByLabel("Repository owner/name").fill("ada/" + name);
    await page
      .getByRole("button", { name: "Look up public repository", exact: true })
      .click();
    await expect(
      page.locator("repository-authoring [role=status]"),
    ).toContainText("Repository loaded");
  }
  await expect(page.locator("repository-authoring [data-count]")).toContainText(
    "2 selected",
  );
  await page.getByLabel("Repository list layout").selectOption("table");
  await page.getByRole("button", { name: "Preview selected output" }).click();
  await expect(page.getByLabel("Repository generated Markdown")).toHaveValue(
    /ada\/one/,
  );
  await page.getByRole("button", { name: "Apply reviewed output" }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/Selected Repositories/);
  expect(
    await page
      .locator("app-shell")
      .evaluate(
        (e) => e.store.draft.blocks.at(-1).githubGenerated.repositories,
      ),
  ).toEqual(["ada/one", "ada/two"]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).not.toHaveValue(/Selected Repositories/);
});
test("repository picker fits mobile and cached context stays usable offline", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator("app-shell").evaluate((e) => {
    e.store.draft.metadata.repositoryContext = [
      {
        fullName: "ada/demo",
        name: "demo",
        owner: "ada",
        language: "Rust",
        topics: [],
        visibility: "public",
      },
    ];
  });
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  await page.locator('[data-repo="ada/demo"]').check();
  await page.getByLabel("Authoring action").selectOption("projects");
  await page.getByRole("button", { name: "Preview selected output" }).click();
  await expect(page.getByLabel("Repository generated Markdown")).toHaveValue(
    /demo/,
  );
  expect(
    await page
      .locator("dialog")
      .evaluate((e) => e.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Repositories", exact: true }),
  ).toBeFocused();
});

test("profile opportunities dismiss per draft and public links require review", async ({
  page,
}) => {
  await start(page);
  await page.locator("app-shell").evaluate((e) => {
    e.store.raw("# Ada");
    e.store.draft.metadata.githubProfile = {
      snapshot: { website: "https://example.com", email: "public@example.com" },
    };
  });
  await page
    .getByRole("button", { name: "Profile Intelligence", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Dismiss Consider an About section",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Consider an About section" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Review public links" }).click();
  await expect(page.getByLabel("Contact Markdown")).toHaveValue(
    /public@example.com/,
  );
  await page.getByRole("button", { name: "Add selected links" }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(/mailto:public@example.com/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue("# Ada");
  await page
    .getByRole("button", { name: "Profile Intelligence", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Consider an About section" }),
  ).toHaveCount(0);
});

test("link scan is explicit, reports partial failures and never changes export source", async ({
  page,
}) => {
  await start(page);
  let calls = 0;
  await page.route("https://health.example/**", (r) => {
    if (r.request().method() === "HEAD") calls++;
    return r.fulfill({
      status: r.request().url().endsWith("/missing") ? 404 : 200,
      contentType: "image/png",
      body: "",
    });
  });
  await page
    .locator("app-shell")
    .evaluate((e) =>
      e.store.raw(
        "[site](https://health.example/ok)\n![image](https://health.example/missing)",
      ),
    );
  await page.getByRole("button", { name: "Check links", exact: true }).click();
  expect(calls).toBe(0);
  const before = calls;
  await expect(page.locator("repository-health [role=status]")).toContainText(
    "no requests started",
  );
  expect(calls).toBe(before);
  await page
    .locator("repository-health")
    .getByRole("button", { name: "Check links", exact: true })
    .click();
  await expect(page.locator("repository-health [role=status]")).toContainText(
    "Link check complete",
  );
  await expect(page.locator("repository-health")).toContainText("reachable");
  await expect(page.locator("repository-health")).toContainText("not found");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue(
    "[site](https://health.example/ok)\n![image](https://health.example/missing)",
  );
});

async function seedGenerated(page) {
  await page.locator("app-shell").evaluate(async (e) => {
    const { authorRepositories, repositoryContext } =
      await import("/src/github/repository-context.js");
    const b = authorRepositories(
      [
        repositoryContext({
          name: "one",
          full_name: "ada/one",
          description: "Old source",
          homepage: "https://old.example",
          topics: [],
        }),
      ],
      { action: "projects" },
    );
    b.settings.items[0].description = "My manual description";
    e.store.blocks([b]);
  });
}
test("refresh reviews remote changes, preserves manual fields, applies once and undoes", async ({
  page,
}) => {
  await start(page);
  await seedGenerated(page);
  const editor = page.getByRole("textbox", {
      name: "Markdown editor",
      exact: true,
    }),
    before = await editor.inputValue();
  await page
    .getByRole("button", { name: "Refresh GitHub data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh selected", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review refresh changes" }),
  ).toBeVisible();
  await expect(page.locator("refresh-center")).toContainText(
    "Manual project.description preserved",
  );
  await expect(editor).toHaveValue(before);
  await page.getByRole("button", { name: "Apply reviewed refresh" }).click();
  await expect(editor).toHaveValue(/My manual description/);
  await expect(editor).toHaveValue(/https:\/\/example.com/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor).toHaveValue(before);
});
test("raw detachment is explicit, recreation appends and offline refresh fails gracefully", async ({
  page,
}) => {
  await start(page);
  await seedGenerated(page);
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill("MY MANUAL README");
  await page
    .getByRole("button", { name: "Refresh GitHub data", exact: true })
    .click();
  await expect(page.locator("refresh-center")).toContainText(
    "no longer refreshable",
  );
  await page
    .getByLabel(
      "Recreate generated version (append, preserve current Markdown)",
    )
    .check();
  await page
    .getByRole("button", { name: "Refresh selected", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review refresh changes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply reviewed refresh" }).click();
  await expect(editor).toHaveValue(/^MY MANUAL README/);
  await expect(editor).toHaveValue(/Recreated project/);
  await page
    .getByRole("button", { name: "Refresh GitHub data", exact: true })
    .click();
  await page.context().setOffline(true);
  await page
    .getByRole("button", { name: "Refresh selected", exact: true })
    .click();
  await expect(page.locator("refresh-center [role=status]")).toContainText(
    "unavailable offline",
  );
});
test("stale refresh review cannot overwrite newer draft changes", async ({
  page,
}) => {
  await start(page);
  await seedGenerated(page);
  await page
    .getByRole("button", { name: "Refresh GitHub data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh selected", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review refresh changes" }),
  ).toBeVisible();
  await page.locator("app-shell").evaluate((e) => e.store.raw("NEWER EDIT"));
  await page.getByRole("button", { name: "Apply reviewed refresh" }).click();
  await expect(page.locator(".toast")).toContainText("Draft changed");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue("NEWER EDIT");
});
