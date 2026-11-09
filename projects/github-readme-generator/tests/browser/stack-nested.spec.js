import { test, expect } from "@playwright/test";

const HEAD = "c".repeat(40),
  TREE = "d".repeat(40);
async function open(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "README audit", exact: true }).click();
}
function content(path, source) {
  return {
    type: "file",
    path,
    size: Buffer.byteLength(source),
    encoding: "base64",
    content: Buffer.from(source).toString("base64"),
    sha: "a".repeat(40),
  };
}
const files = {
  "package.json": JSON.stringify({
    workspaces: ["packages/*"],
    devDependencies: { vitest: "4" },
  }),
  "packages/web/package.json": JSON.stringify({
    dependencies: { react: "19" },
  }),
  "docs/site/requirements.txt": "mkdocs\n",
  "node_modules/left-pad/package.json": "{}",
};
function tree() {
  const entries = new Map();
  for (const [path, source] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      entries.set(dir, { path: dir, type: "tree", mode: "040000", sha: TREE });
    }
    entries.set(path, {
      path,
      type: "blob",
      mode: "100644",
      size: Buffer.byteLength(source),
      sha: "a".repeat(40),
    });
  }
  return [...entries.values()];
}
async function routeGitHub(page, repositories = 1) {
  const calls = [];
  await page.route("https://api.github.com/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname + url.search);
    if (url.pathname.startsWith("/users/"))
      return route.fulfill({
        json: Array.from({ length: repositories }, (_, i) => ({
          name: i ? "app" + i : "mono",
          full_name: i ? "example/app" + i : "example/mono",
          default_branch: "main",
          language: "TypeScript",
        })),
      });
    if (url.pathname.endsWith("/commits"))
      return route.fulfill({
        json: [{ sha: HEAD, commit: { tree: { sha: TREE } } }],
      });
    if (url.pathname.includes("/git/trees/"))
      return route.fulfill({ json: { tree: tree(), truncated: false } });
    const prefix = "/repos/example/mono/contents/";
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!path)
      return route.fulfill({
        json: [{ type: "file", path: "package.json", size: 10 }],
      });
    if (files[path]) return route.fulfill({ json: content(path, files[path]) });
    return route.fulfill({ status: 404, json: { message: "Not Found" } });
  });
  return calls;
}
async function load(page) {
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
}

test("nested manifests need their own consent; off reads no tree", async ({
  page,
}) => {
  const calls = await routeGitHub(page);
  await open(page);
  await load(page);
  const consent = page.getByLabel(
    "Allow read-only manifest analysis for this session",
  );
  const nested = page.getByLabel("Include nested manifests (monorepo)");
  await expect(nested).toBeDisabled();
  await expect(nested).not.toBeChecked();
  await expect(page.locator("repository-audit")).toContainText(
    "Up to 24 requests per repository; at most 25 repositories per nested run.",
  );
  await consent.check();
  await expect(nested).toBeEnabled();
  await expect(nested).not.toBeChecked();
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Manifest analysis complete",
  );
  expect(calls.some((c) => c.includes("/git/trees/"))).toBe(false);
  expect(calls.some((c) => c.includes("/commits"))).toBe(false);
  expect(calls.filter((c) => c.includes("/contents/"))).toEqual([
    "/repos/example/mono/contents/?ref=main",
    "/repos/example/mono/contents/package.json?ref=main",
  ]);
  // Turning nested on and then withdrawing manifest consent clears both.
  await nested.check();
  await consent.uncheck();
  await expect(nested).not.toBeChecked();
  await expect(nested).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "README audit", exact: true }).click();
  await expect(
    page.getByLabel("Include nested manifests (monorepo)"),
  ).not.toBeChecked();
});

test("nested discovery groups project boundaries at 320px with keyboard access", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const calls = await routeGitHub(page);
  await open(page);
  const before = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.markdown,
  );
  await load(page);
  await page
    .getByLabel("Allow read-only manifest analysis for this session")
    .check();
  const nested = page.getByLabel("Include nested manifests (monorepo)");
  await nested.focus();
  await page.keyboard.press("Space");
  await expect(nested).toBeChecked();
  const analyze = page.getByRole("button", {
    name: "Analyze selected manifests",
  });
  await analyze.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Manifest analysis complete",
  );
  expect(calls.filter((c) => c.includes("/git/trees/"))).toHaveLength(1);
  expect(calls.some((c) => c.includes("node_modules"))).toBe(false);
  expect(calls.length).toBeLessThanOrEqual(1 + 24);
  const summary = page.locator("stack-results summary").first();
  await summary.focus();
  await page.keyboard.press("Enter");
  const projects = page.locator("[data-stack-projects]");
  await expect(projects).toBeVisible();
  await expect(projects).toContainText("Repository root");
  await expect(projects).toContainText(
    "Workspace members (declared by package.json workspaces)",
  );
  await expect(projects).toContainText(
    "Nested projects (not declared by a workspace)",
  );
  await expect(projects.locator("[data-project-group=member]")).toContainText(
    "packages/web",
  );
  await expect(projects.locator("[data-project-group=nested]")).toContainText(
    "docs/site",
  );
  await expect(projects.locator("[data-discovery-summary]")).toContainText(
    "4 manifests found, 3 read, 1 not read.",
  );
  await expect(projects.locator("[data-not-read]")).toContainText(
    "node_modules/left-pad/package.json — excluded directory (limit); not read",
  );
  await expect(
    page.locator('[data-dependencies][data-project="packages/web"]'),
  ).toContainText("react");
  await expect(
    page.locator('[data-dependencies][data-project="docs/site"]'),
  ).toContainText("mkdocs");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(before);
});

test("nested discovery refuses more than 25 repositories without reading", async ({
  page,
}) => {
  const calls = await routeGitHub(page, 26);
  await open(page);
  await load(page);
  await page
    .getByLabel("Allow read-only manifest analysis for this session")
    .check();
  await page.getByLabel("Include nested manifests (monorepo)").check();
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "at most 25 repositories per run; 26 are selected",
  );
  expect(calls.every((c) => c.startsWith("/users/"))).toBe(true);
  await page.getByLabel("Include nested manifests (monorepo)").uncheck();
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Manifest analysis complete",
  );
});
