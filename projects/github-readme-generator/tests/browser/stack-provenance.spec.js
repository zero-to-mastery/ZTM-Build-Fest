import { test, expect } from "@playwright/test";

const SHA = "f".repeat(40);
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
    sha: SHA,
  };
}
// Routes api.github.com: one repository with the given root files. A file
// mapped to a number answers with that HTTP status instead. `list.pushedAt`
// is read on every repository list request, so a test can report a later push.
async function routeGitHub(page, files, list = {}) {
  const calls = [];
  await page.route("https://api.github.com/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname + url.search);
    if (url.pathname.startsWith("/users/"))
      return route.fulfill({
        json: [
          {
            name: "app",
            full_name: "example/app",
            default_branch: "main",
            language: "",
            pushed_at: list.pushedAt ?? "",
          },
        ],
      });
    const path = decodeURIComponent(url.pathname.split("/contents/")[1] || "");
    if (!path)
      return route.fulfill({
        json: Object.keys(files).map((name) => ({ type: "file", path: name })),
      });
    if (typeof files[path] === "number")
      return route.fulfill({
        status: files[path],
        json: { message: "Server error" },
      });
    return route.fulfill({ json: content(path, files[path]) });
  });
  return calls;
}
async function analyze(page) {
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByLabel("Allow read-only manifest analysis for this session")
    .check();
  const button = page.getByRole("button", {
    name: "Analyze selected manifests",
  });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Manifest analysis",
  );
}
async function expand(page) {
  const summary = page.locator("stack-results details > summary").first();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("stack-results [data-stack-body]")).not.toBeEmpty();
}
const noOverflow = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

test("a partial record lists unread manifests as unknown beside provenance at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const calls = await routeGitHub(page, {
    "package.json": JSON.stringify({
      dependencies: { react: "19" },
      peerDependencies: { vue: "3" },
    }),
    "Cargo.toml": 500,
  });
  await open(page);
  const before = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.markdown,
  );
  await analyze(page);
  await expect(page.locator("stack-results summary").first()).toHaveText(
    "example/app — Partial results",
  );
  await expand(page);
  const results = page.locator("stack-results");
  const uncertain = results.locator("[data-uncertain]");
  await expect(
    uncertain.getByRole("heading", { name: "Uncertain stack results (2)" }),
  ).toBeVisible();
  await expect(uncertain.locator("li")).toHaveCount(2);
  await expect(
    uncertain.locator("li").filter({ hasText: "vue" }),
  ).toContainText("package.json · peerDependencies · basis: conditional");
  await expect(
    uncertain.locator("li").filter({ hasText: "Cargo.toml" }),
  ).toContainText("Not read — unknown");
  await expect(results.locator("[data-not-read]")).toContainText("Cargo.toml");
  // Uncertain declarations stay in place; explicit ones carry provenance too.
  const react = results
    .locator("[data-dependencies] > li")
    .filter({ hasText: "react" });
  await expect(react).toContainText(
    "package.json · dependencies · basis: explicit · observed",
  );
  await expect(react).toContainText("on main · blob fffffff");
  // The full SHA is screen-reader text, not only a title.
  const blob = react.locator(`[title="Blob SHA ${SHA}"]`);
  await expect(blob.locator(".sr-only")).toHaveText(`SHA ${SHA}`);
  await expect(blob.locator('[aria-hidden="true"]')).toHaveText("fffffff");
  await expect(
    results.locator("[data-dependencies] > li").filter({ hasText: "vue" }),
  ).toHaveCount(1);
  await expect(results.locator("[data-basis-legend]")).toContainText(
    "conditional",
  );
  await expect(results.locator("[data-stale]")).toHaveCount(0);
  await expect(results).not.toContainText("absent");
  await noOverflow(page);
  expect(calls.filter((c) => c.includes("/contents/"))).toHaveLength(3);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(before);
});

test("a newer push in the repository list marks the result Stale without requests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  // The local clock runs behind GitHub: the list already reports a push five
  // minutes "later" than local time when the scan starts.
  const start = new Date("2026-03-01T12:00:00Z");
  await page.clock.setFixedTime(start);
  const list = { pushedAt: "2026-03-01T12:05:00Z" };
  const calls = await routeGitHub(
    page,
    {
      "package.json": JSON.stringify({
        dependencies: { react: "19" },
        peerDependencies: { vue: "3" },
      }),
      "requirements.txt": "flask\n",
    },
    list,
  );
  await open(page);
  await analyze(page);
  // Same pushed_at as when the scan started: fresh, whatever the clock says.
  await expect(page.locator("stack-results summary").first()).toHaveText(
    "example/app — Manifests read",
  );
  // A real push after the scan, seen when the list is loaded again after
  // its five-minute cache.
  list.pushedAt = "2026-03-01T12:20:00Z";
  await page.clock.setFixedTime(new Date(start.getTime() + 6 * 60 * 1000));
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await expect(page.locator("stack-results summary").first()).toHaveText(
    "example/app — Manifests read — Stale",
  );
  const count = calls.length;
  await expand(page);
  const stale = page.locator("stack-results [data-stale]");
  await expect(stale).toContainText("Stale: repository pushed after this scan");
  await expect(stale).not.toContainText("more than 24 hours");
  await expect(stale).toContainText("Fetch fresh manifests");
  const uncertain = page.locator("stack-results [data-uncertain]");
  await expect(
    uncertain.getByRole("heading", { name: "Uncertain stack results (2)" }),
  ).toBeVisible();
  await expect(
    uncertain.locator("li").filter({ hasText: "flask" }),
  ).toContainText("basis: ambiguous");
  await expect(
    uncertain.locator("li").filter({ hasText: "flask" }),
  ).toContainText("may be freeze output");
  // Stack DNA labels technologies with only uncertain evidence and shows the
  // same provenance; focus returns to the technology on close.
  const dna = page.locator("stack-dna");
  const vue = dna.getByRole("button", {
    name: "Vue (only uncertain evidence)",
    exact: true,
  });
  await expect(
    dna.getByRole("button", { name: "React", exact: true }),
  ).toBeVisible();
  await vue.focus();
  await page.keyboard.press("Enter");
  const evidence = dna.locator("[data-dna-evidence]");
  await expect(
    dna.getByRole("heading", { name: "Vue evidence" }),
  ).toBeFocused();
  await expect(evidence).toContainText("Only uncertain evidence");
  await expect(evidence).toContainText(
    "package.json · peerDependencies · basis: conditional",
  );
  await expect(evidence).toContainText("on main · blob fffffff");
  await dna.getByRole("button", { name: "Close technology evidence" }).focus();
  await page.keyboard.press("Enter");
  await expect(vue).toBeFocused();
  await noOverflow(page);
  expect(calls.length).toBe(count);
});

test("a result observed more than 24 hours ago is Stale when shown again", async ({
  page,
}) => {
  const start = new Date("2026-03-01T12:00:00Z");
  await page.clock.setFixedTime(start);
  const calls = await routeGitHub(
    page,
    { "package.json": JSON.stringify({ dependencies: { react: "19" } }) },
    { pushedAt: "2026-02-01T00:00:00Z" },
  );
  await open(page);
  await analyze(page);
  await expect(page.locator("stack-results summary").first()).toHaveText(
    "example/app — Manifests read",
  );
  const count = calls.length;
  await page.clock.setFixedTime(new Date(start.getTime() + 25 * 3600 * 1000));
  // Results are re-rendered when the selection changes; no timer or refetch.
  const select = page.getByRole("checkbox", {
    name: "Select example/app",
    exact: true,
  });
  await select.uncheck();
  await select.check();
  await expect(page.locator("stack-results summary").first()).toHaveText(
    "example/app — Manifests read — Stale",
  );
  await expand(page);
  await expect(page.locator("stack-results [data-stale]")).toContainText(
    "Stale: observed more than 24 hours ago",
  );
  await expect(page.locator("stack-results [data-uncertain]")).toContainText(
    "Uncertain stack results (0)",
  );
  expect(calls.length).toBe(count);
});
