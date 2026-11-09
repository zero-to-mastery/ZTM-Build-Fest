import { test, expect } from "@playwright/test";
const user = {
  login: "octocat",
  name: "Mona Octocat",
  bio: "I build useful things.",
  blog: "https://example.org",
  location: "Earth",
  company: "Example",
  followers: 42,
  following: 3,
  public_repos: 1,
  public_gists: 2,
  created_at: "2011-01-01T00:00:00Z",
};
test.beforeEach(async ({ page }) => {
  await page.route("https://img.shields.io/**", (r) => r.abort());
  await page.route("https://api.github.com/users/**", (r) =>
    r.fulfill({
      json: r.request().url().includes("/repos?")
        ? [
            {
              id: 1,
              name: "useful-tool",
              owner: { login: "octocat" },
              description: "A public project",
              language: "Rust",
              stargazers_count: 17,
              forks_count: 2,
            },
          ]
        : user,
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
});
async function lookup(page, value = "https://github.com/octocat") {
  await page.getByRole("button", { name: "Autofill from GitHub" }).click();
  await page.getByLabel("GitHub username or profile URL").fill(value);
  await page
    .getByRole("button", { name: "Look up profile", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply to current draft" }),
  ).toBeVisible();
}
test("autofills public profile, optional projects/languages, persists and refreshes without duplicates", async ({
  page,
}) => {
  await lookup(page);
  await page
    .getByLabel("Suggest up to three public projects", { exact: false })
    .check();
  await page
    .getByLabel("Add repository language summary", { exact: false })
    .check();
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  const editor = page.getByLabel("Markdown editor", { exact: true });
  await expect(editor).toHaveValue(/Mona Octocat/);
  await expect(editor).not.toHaveValue(/Your Name/);
  await expect(editor).toHaveValue(/\*\*Followers:\*\* 42/);
  await expect(editor).toHaveValue(/useful-tool/);
  await expect(editor).toHaveValue(/primary language in 1 repository/);
  await expect(page.locator("github-preview")).toContainText("Mona Octocat");
  await expect(page.locator(".save-status")).toHaveText("Saved locally");
  await page.reload();
  await expect(editor).toHaveValue(/Mona Octocat/);
  await lookup(page, "octocat");
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  expect(
    (await editor.inputValue()).match(/## GitHub at a Glance/g),
  ).toHaveLength(1);
});
test("preview does not mutate until applied and undo restores placeholders", async ({
  page,
}) => {
  const editor = page.getByLabel("Markdown editor", { exact: true });
  const original = await editor.inputValue();
  await lookup(page);
  await expect(editor).toHaveValue(original);
  if (test.info().project.name === "chromium")
    await page.screenshot({
      path: "docs/screenshots/github-autofill.png",
      fullPage: true,
    });
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await expect(editor).toHaveValue(/Mona Octocat/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor).toHaveValue(original);
});
test("raw placeholders update while manually written text is preserved", async ({
  page,
}) => {
  const editor = page.getByLabel("Markdown editor", { exact: true });
  await editor.fill(
    "# {{display_name}}\n\nMy exact prose.  \nGitHub: https://github.com/your-name\n",
  );
  await lookup(page, "@octocat");
  for (const name of [
    "Use public bio and profile details",
    "Fill public contact links",
    "Add GitHub stats snapshot",
  ])
    await page.getByLabel(name, { exact: false }).uncheck();
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await expect(editor).toHaveValue(
    "# Mona Octocat\n\nMy exact prose.  \nGitHub: https://github.com/octocat\n",
  );
});
test("lookup errors and partial repository results remain actionable", async ({
  page,
}) => {
  await page.route("https://api.github.com/users/**", (r) =>
    r.fulfill({ status: 404, json: { message: "Not Found" } }),
  );
  await page.getByRole("button", { name: "Autofill from GitHub" }).click();
  await page.getByLabel("GitHub username or profile URL").fill("missing");
  await page.getByRole("button", { name: "Look up profile" }).click();
  await expect(page.locator(".profile-status")).toContainText("not found");
  await page.route("https://api.github.com/users/**", (r) =>
    r.request().url().includes("/repos?")
      ? r.fulfill({ status: 403, json: {} })
      : r.fulfill({ json: { ...user, name: null, bio: null } }),
  );
  await page.getByLabel("GitHub username or profile URL").fill("octocat");
  await page.getByRole("button", { name: "Look up profile" }).click();
  await expect(page.locator(".profile-status")).toContainText("incomplete");
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await expect(page.getByLabel("Markdown editor", { exact: true })).toHaveValue(
    /# octocat/,
  );
});
test("mobile profile autofill fits the dialog", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await lookup(page);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await expect(page.locator("github-preview h1")).toHaveText("Mona Octocat");
});
test("keyboard lookup moves focus to choices and Escape cancels a pending request", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Autofill from GitHub" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("GitHub username or profile URL")).toBeFocused();
  await page.keyboard.type("octocat");
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Fill name and username placeholders", { exact: false }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Autofill from GitHub" }),
  ).toBeFocused();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let requested;
  const seen = new Promise((resolve) => (requested = resolve));
  await page.route("https://api.github.com/users/slow", async (r) => {
    requested();
    await gate;
    await r.fulfill({ json: { ...user, login: "slow" } }).catch(() => {});
  });
  await page.keyboard.press("Enter");
  await page.getByLabel("GitHub username or profile URL").fill("slow");
  await page.getByRole("button", { name: "Look up profile" }).click();
  await seen;
  await page.evaluate(
    () =>
      (window.pendingProfileSignal = document.querySelector(
        "github-profile-form",
      ).lookupController.signal),
  );
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.pendingProfileSignal.aborted))
    .toBe(true);
  release();
  await page.getByRole("button", { name: "Autofill from GitHub" }).click();
  await expect(page.locator(".profile-result")).toBeEmpty();
});
test("typing a new username cancels the old lookup and ignores stale results", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let requested;
  const seen = new Promise((resolve) => (requested = resolve));
  await page.route("https://api.github.com/users/slow", async (r) => {
    requested();
    await gate;
    await r
      .fulfill({ json: { ...user, name: "Stale Profile" } })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "Autofill from GitHub" }).click();
  await page.getByLabel("GitHub username or profile URL").fill("slow");
  await page.getByRole("button", { name: "Look up profile" }).click();
  await seen;
  await page.evaluate(
    () =>
      (window.pendingProfileSignal = document.querySelector(
        "github-profile-form",
      ).lookupController.signal),
  );
  await page.getByLabel("GitHub username or profile URL").fill("octocat");
  expect(await page.evaluate(() => window.pendingProfileSignal.aborted)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Look up profile" }).click();
  await expect(page.locator(".profile-result")).toContainText("Mona Octocat");
  release();
  await expect(page.locator(".profile-result")).not.toContainText(
    "Stale Profile",
  );
});
test("rejects an obsolete preview of the same draft without losing edits", async ({
  page,
}) => {
  await lookup(page);
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Changed after preview\n"),
  );
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await expect(page.locator(".toast")).toContainText(
    "draft changed since this preview",
  );
  await expect(page.getByLabel("Markdown editor", { exact: true })).toHaveValue(
    "# Changed after preview\n",
  );
  await expect(page.getByRole("dialog")).toBeVisible();
});
test("refreshes owned bio and website after reload and preserves manually edited text", async ({
  page,
}) => {
  await lookup(page);
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await page.reload();
  await page.route("https://api.github.com/users/octocat", (r) =>
    r.fulfill({
      json: {
        ...user,
        bio: "Updated GitHub bio",
        blog: "https://new.example.org",
      },
    }),
  );
  await lookup(page, "octocat");
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await expect(page.getByLabel("Markdown editor", { exact: true })).toHaveValue(
    /Updated GitHub bio/,
  );
  await expect(
    page.getByLabel("Markdown editor", { exact: true }),
  ).not.toHaveValue(/https:\/\/example.org/);
  await page.locator(".block-open").filter({ hasText: "Hero" }).click();
  await page
    .getByLabel("Introduction", { exact: true })
    .fill("My edited introduction");
  await page.getByRole("button", { name: "Save section" }).click();
  await lookup(page, "octocat");
  await page.getByRole("button", { name: "Apply to current draft" }).click();
  await expect(page.getByLabel("Markdown editor", { exact: true })).toHaveValue(
    /My edited introduction/,
  );
});
