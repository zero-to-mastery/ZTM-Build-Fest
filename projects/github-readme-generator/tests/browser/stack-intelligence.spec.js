import { test, expect } from "@playwright/test";
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
test("manifest analysis is opt-in, preserves drafts and labels repository evidence at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const calls = [];
  await page.route("https://api.github.com/**", async (route) => {
    const url = route.request().url();
    calls.push(url);
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          {
            name: "app",
            full_name: "example/app",
            default_branch: "main",
            language: "JavaScript",
          },
        ],
      });
    if (url.includes("package.json"))
      return route.fulfill({
        json: content(
          "package.json",
          JSON.stringify({
            dependencies: { react: "19" },
            devDependencies: { vitest: "4" },
            scripts: { postinstall: "window.stackExecuted=true" },
          }),
        ),
      });
    if (url.includes("Cargo.toml"))
      return route.fulfill({
        json: content("Cargo.toml", '[dependencies]\nserde = "1"'),
      });
    return route.fulfill({
      json: [
        { type: "file", path: "package.json" },
        { type: "file", path: "Cargo.toml" },
        { type: "file", path: "setup.py" },
      ],
    });
  });
  await open(page);
  const before = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.markdown,
  );
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  const analyze = page.getByRole("button", {
    name: "Analyze selected manifests",
  });
  await expect(analyze).toBeDisabled();
  expect(calls.every((url) => url.includes("/users/"))).toBe(true);
  await page
    .getByLabel("Allow read-only manifest analysis for this session")
    .check();
  await analyze.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Manifest analysis complete",
  );
  await expect(analyze).toBeFocused();
  await page.locator("stack-results summary").click();
  await expect(page.locator("stack-results")).toContainText(
    "Detected in selected repositories",
  );
  await expect(page.locator("stack-results")).toContainText("react");
  await expect(page.locator("stack-results")).toContainText("development");
  await expect(page.locator("stack-results")).toContainText("serde");
  expect(calls).toHaveLength(4);
  expect(await page.evaluate(() => window.stackExecuted)).toBeUndefined();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await analyze.click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Manifest analysis complete",
  );
  expect(calls).toHaveLength(4);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(before);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "README audit", exact: true }).click();
  await expect(
    page.getByLabel("Allow read-only manifest analysis for this session"),
  ).not.toBeChecked();
});
test("partial manifest failures retain evidence, show rate limits, and permit explicit fresh retry", async ({
  page,
}) => {
  let limited = true;
  await page.route("https://api.github.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          { name: "app", full_name: "example/app", default_branch: "main" },
        ],
      });
    if (url.includes("package.json"))
      return route.fulfill({
        json: content("package.json", '{"dependencies":{"react":"1"}}'),
      });
    if (url.includes("pyproject.toml")) {
      if (limited)
        return route.fulfill({
          status: 429,
          headers: { "retry-after": "60" },
          json: {},
        });
      return route.fulfill({
        json: content("pyproject.toml", '[project]\ndependencies=["requests"]'),
      });
    }
    return route.fulfill({
      json: [
        { type: "file", path: "package.json" },
        { type: "file", path: "pyproject.toml" },
      ],
    });
  });
  await open(page);
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
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "paused",
  );
  await page.locator("stack-results summary").click();
  await expect(page.locator("stack-results")).toContainText("Partial results");
  await expect(page.locator("stack-results")).toContainText("react");
  limited = false;
  await page.evaluate(async () => {
    const { auditClient } = await import("/src/repository-audit/github.js");
    auditClient.cooldown = 0;
  });
  await page.getByLabel("Fetch fresh manifests").check();
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "complete",
  );
  await page.locator("stack-results summary").click();
  await expect(page.locator("stack-results")).toContainText("requests");
});

test("cancellation and offline failures do not become absence or execute pending work", async ({
  page,
}) => {
  let pending;
  let offline = false;
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().url().includes("/users/"))
      return route.fulfill({
        json: [
          { name: "app", full_name: "example/app", default_branch: "main" },
        ],
      });
    if (offline) return route.abort("internetdisconnected");
    pending = route;
  });
  await open(page);
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
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole("button", { name: "Cancel audit", exact: true }).click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "cancelled",
  );
  await pending.fulfill({ json: [] }).catch(() => {});
  await expect(page.locator("stack-results summary")).toHaveCount(0);
  offline = true;
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "complete",
  );
  await page.locator("stack-results summary").click();
  await expect(page.locator("stack-results")).toContainText("Not assessed");
  await expect(page.locator("stack-results")).not.toContainText(
    "No supported root manifests found",
  );
});

test("direct dependency results normalize all ecosystems and preserve kinds and repository association", async ({
  page,
}) => {
  const files = {
    "package.json": JSON.stringify({
      dependencies: { alias: "npm:@scope/real@1" },
      devDependencies: { vitest: "1" },
      peerDependencies: { "@scope/real": "1" },
    }),
    "Cargo.toml":
      '[dependencies]\nserde="1"\n[build-dependencies]\ncc="1"\n[workspace.dependencies]\nunused="1"',
    "pyproject.toml":
      '[project]\ndependencies=["Some_Pkg>=1"]\n[build-system]\nrequires=["setuptools"]',
    "requirements.txt": "some-pkg==1",
    "go.mod":
      "require example.org/Direct v1.0.0\nrequire example.org/transitive v1.0.0 // indirect",
  };
  let reads = 0;
  await page.route("https://api.github.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          { name: "app", full_name: "Example/app", default_branch: "main" },
        ],
      });
    reads++;
    const path = decodeURIComponent(
      new URL(url).pathname.split("/contents/")[1] || "",
    );
    return route.fulfill({
      json: path
        ? content(path, files[path])
        : Object.keys(files).map((path) => ({ type: "file", path })),
    });
  });
  await open(page);
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
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "complete",
  );
  await page.locator("stack-results summary").click();
  const dependencies = page.locator("[data-dependencies] > li");
  await expect(dependencies).toHaveCount(8);
  await expect(dependencies.filter({ hasText: "some-pkg" })).toHaveCount(1);
  await expect(dependencies.filter({ hasText: "some-pkg" })).toContainText(
    "pyproject.toml",
  );
  await expect(dependencies.filter({ hasText: "some-pkg" })).toContainText(
    "requirements.txt",
  );
  await expect(dependencies.filter({ hasText: "@scope/real" })).toHaveCount(2);
  await expect(dependencies.filter({ hasText: "setuptools" })).toContainText(
    "python · build · example/app",
  );
  await expect(
    dependencies.filter({ hasText: "example.org/Direct" }),
  ).toContainText("go · runtime · example/app");
  await expect(page.locator("[data-dependencies]")).not.toContainText(
    "transitive",
  );
  await expect(page.locator("[data-dependencies]")).not.toContainText("unused");
  expect(reads).toBe(6);
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "complete",
  );
  expect(reads).toBe(6);
});

test("Stack DNA groups selected repositories, filters categories and exposes keyboard evidence at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  let calls = 0;
  await page.route("https://api.github.com/**", async (route) => {
    calls++;
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          {
            name: "web",
            full_name: "example/web",
            default_branch: "main",
            language: "TypeScript",
          },
          {
            name: "native",
            full_name: "example/native",
            default_branch: "main",
            language: "Rust",
          },
        ],
      });
    const native = url.includes("/native/");
    const path = native ? "Cargo.toml" : "package.json";
    if (url.includes(path))
      return route.fulfill({
        json: content(
          path,
          native
            ? '[dependencies]\nwasm-bindgen="1"'
            : JSON.stringify({
                engines: { node: ">=22" },
                dependencies: {
                  react: "1",
                  pg: "1",
                  mongoose: "1",
                  unknown_tool: "1",
                },
                devDependencies: {
                  vitest: "1",
                  "@playwright/test": "1",
                  "@testing-library/react": "1",
                  vite: "1",
                },
              }),
        ),
      });
    return route.fulfill({ json: [{ type: "file", path }] });
  });
  await open(page);
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
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "complete",
  );
  const dna = page.locator("stack-dna");
  await expect(dna.locator('[data-dna-group="Core"]')).toContainText("React");
  await expect(dna.locator('[data-dna-group="Core"]')).toContainText("Node.js");
  await expect(dna.locator('[data-dna-group="Core"]')).toContainText("Rust");
  await expect(dna.locator('[data-dna-group="Data"]')).toContainText(
    "PostgreSQL",
  );
  await expect(dna.locator('[data-dna-group="Data"]')).toContainText("MongoDB");
  await expect(dna.locator('[data-dna-group="Build"]')).toContainText("Vite");
  await expect(dna).not.toContainText("GitHub Actions");
  expect(calls).toBe(5);
  await page.getByLabel("Stack DNA category").selectOption("Testing");
  await expect(dna.locator("[data-dna-group]")).toHaveCount(1);
  await expect(dna).toContainText("RTL");
  const vitest = dna.getByRole("button", { name: "Vitest", exact: true });
  await vitest.focus();
  await page.keyboard.press("Enter");
  await expect(
    dna.getByRole("heading", { name: "Vitest evidence" }),
  ).toBeFocused();
  await expect(dna.locator("[data-dna-evidence]")).toContainText("example/web");
  await expect(dna.locator("[data-dna-evidence]")).toContainText("development");
  await expect(dna.locator("[data-dna-evidence]")).toContainText(
    "package.json",
  );
  await dna.getByRole("button", { name: "Close technology evidence" }).click();
  await expect(vitest).toBeFocused();
  await page.getByLabel("Stack DNA category").selectOption("Unknown");
  await expect(dna).toContainText("unknown_tool (node)");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page
    .getByRole("checkbox", { name: "Select example/native", exact: true })
    .uncheck();
  await expect(
    dna.getByRole("button", { name: "Rust", exact: true }),
  ).toHaveCount(0);
  await expect(
    dna.getByRole("button", { name: "React", exact: true }),
  ).toHaveCount(1);
  expect(calls).toBe(5);
});
