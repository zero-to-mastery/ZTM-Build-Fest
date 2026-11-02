import { test, expect } from "@playwright/test";

const sha = (c) => c.repeat(40);
// The first check in a page lazily loads the evidence modules, which can be
// slow on a cold dev server.
const firstRead = { timeout: 20_000 };
// Line 7 has a mismatch with a suggestion (a similar script), line 8 one
// without, and line 11 a link whose path differs from the repository's only
// in case.
const source = [
  "# Widget",
  "",
  "## Install",
  "",
  "```bash",
  "npm ci",
  "npm run test-unit",
  "npm run lint",
  "```",
  "",
  "See [usage](docs/usage.md) and [install](#install).",
  "",
].join("\n");
const packageJson = JSON.stringify({
  scripts: { build: "vite build", "test:unit": "vitest" },
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
    { path: "docs/Usage.md", type: "blob", sha: sha("7"), size: 20 },
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
const markdown = (page) =>
  page.evaluate(() => document.querySelector("app-shell").store.draft.markdown);
async function checkAndReview(page) {
  await page
    .locator(".workspace-tools")
    .getByRole("button", { name: "Drift check", exact: true })
    .click();
  const panel = page.locator("evidence-snapshots");
  await panel.getByRole("button", { name: "Run drift check" }).click();
  await expect(panel.locator("[data-drift-counts]")).toHaveText(
    "3 observed mismatches · 0 uncertain · 0 unknown · 2 matches",
    firstRead,
  );
  // Running the check alone never changes the Markdown.
  expect(await markdown(page)).toBe(source);
  const review = panel.getByRole("button", { name: "Review fixes (3 lines)" });
  await review.focus();
  await page.keyboard.press("Enter");
  const fixes = panel.locator("[data-fixes]");
  await expect(
    fixes.getByRole("heading", { name: "Review drift fixes" }),
  ).toBeFocused();
  return { panel, fixes };
}

test("reviews drift fixes by keyboard at 320px, applies only approved lines locally and undoes them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  const requests = [];
  page.on("request", (request) =>
    requests.push({ method: request.method(), url: request.url() }),
  );
  const { panel, fixes } = await checkAndReview(page);

  // Evidence and the exact change are shown for each line.
  const line7 = fixes.locator('[data-proposal="7"]');
  await expect(line7).toContainText('package.json has no "test-unit" script');
  await expect(line7).toContainText("Evidence file: package.json.");
  await expect(line7.locator("[data-fix-diff]")).toHaveText(
    "@@ line 7 @@\n-npm run test-unit\n+npm run test:unit",
  );
  const line8 = fixes.locator('[data-proposal="8"]');
  await expect(line8).toContainText("No suggestion from the evidence");
  await expect(line8.getByRole("checkbox")).toBeDisabled();
  const line11 = fixes.locator('[data-proposal="11"]');
  await expect(line11).toContainText("docs/Usage.md exists");

  // Nothing is approved until the author approves each change.
  const apply = fixes.locator("[data-fix-apply]");
  await expect(apply).toBeDisabled();
  await line7.getByRole("checkbox", { name: /line 7/ }).focus();
  await page.keyboard.press("Space");
  await line11.getByRole("checkbox", { name: /line 11/ }).focus();
  await page.keyboard.press("Space");
  await expect(fixes.locator("[data-fix-summary]")).toHaveText(
    "2 of 3 proposed changes approved.",
  );
  const expected = source
    .replace("npm run test-unit", "npm run test:unit")
    .replace("(docs/usage.md)", "(docs/Usage.md)");
  await expect(fixes.locator("[data-after]")).toHaveValue(expected);
  await expect(fixes.locator("[data-before]")).toHaveValue(source);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await expect(apply).toHaveText("Apply 2 approved changes");
  await apply.focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator("[data-status]")).toContainText(
    "Applied 2 reviewed changes to your Markdown",
  );
  await expect(panel.locator("[data-status]")).toContainText(
    "Nothing was published or written to GitHub",
  );
  expect(await markdown(page)).toBe(expected);
  // The stale result and its proposals are gone; checking again is next.
  await expect(panel.locator("[data-drift]")).toBeHidden();
  await expect(panel.locator("[data-fixes]")).toBeHidden();
  await expect(
    panel.getByRole("button", { name: "Run drift check" }),
  ).toBeFocused();

  // No write of any kind and no publishing step was started.
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(
    requests.filter((r) => /\/api\/|publish/i.test(new URL(r.url).pathname)),
  ).toEqual([]);
  await expect(page.locator("publish-dialog")).toHaveCount(0);

  // Undo restores the original Markdown exactly.
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "Workspace panes" })
    .getByRole("button", { name: "Markdown" })
    .click();
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await markdown(page)).toBe(source);
});

test("rejects reviewed fixes when the Markdown changed since the check and never proposes unknown findings", async ({
  page,
}) => {
  await start(page);
  const { panel, fixes } = await checkAndReview(page);
  await fixes.locator('[data-proposal="7"]').getByRole("checkbox").check();
  // An edit made after the check, for example in another flow.
  const edited = source.replace("# Widget", "# Widget, edited");
  await page.evaluate(
    (text) => document.querySelector("app-shell").store.raw(text),
    edited,
  );
  await fixes.locator("[data-fix-apply]").click();
  await expect(panel.locator("[data-status]")).toContainText(
    "Your Markdown changed since the drift check, so the reviewed changes were not applied.",
  );
  await expect(panel.locator("[data-status]")).toContainText(
    "Your Markdown is unchanged.",
  );
  // The manual edit is kept and the stale proposals are gone.
  expect(await markdown(page)).toBe(edited);
  await expect(panel.locator("[data-fixes]")).toBeHidden();
  await expect(
    panel.getByRole("button", { name: "Run drift check" }),
  ).toBeFocused();

  // An uncertain or unknown result is never applied by default: when the
  // tree cannot be read, every repository claim is unknown and no fixes are
  // offered.
  await page.evaluate(
    (text) => document.querySelector("app-shell").store.raw(text),
    source,
  );
  await mockGitHub(page, { trees: 500 });
  await panel.getByRole("button", { name: "Run drift check" }).click();
  await expect(panel.locator("[data-drift-partial]")).toContainText("not read");
  await expect(panel.getByRole("button", { name: /Review fixes/ })).toHaveCount(
    0,
  );
  expect(await markdown(page)).toBe(source);
});

test("discarding proposals or failing a new check applies nothing", async ({
  page,
  context,
}) => {
  await start(page);
  const { panel, fixes } = await checkAndReview(page);
  await fixes.locator('[data-proposal="11"]').getByRole("checkbox").check();
  await fixes.getByRole("button", { name: "Discard proposals" }).click();
  await expect(panel.locator("[data-status]")).toContainText(
    "Fix proposals discarded. Your Markdown is unchanged.",
  );
  await expect(
    panel.getByRole("button", { name: "Review fixes (3 lines)" }),
  ).toBeFocused();
  // Reopening starts again from unapproved proposals.
  await page.keyboard.press("Enter");
  await expect(fixes.locator("[data-fix-apply]")).toBeDisabled();
  await fixes.locator('[data-proposal="11"]').getByRole("checkbox").check();

  // Going offline and re-running clears the review instead of leaving
  // proposals for a result that is no longer shown.
  await context.setOffline(true);
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await panel.getByRole("button", { name: "Run drift check" }).click();
  await expect(panel.locator("[data-status]")).toContainText(
    "Drift check failed: You are offline.",
  );
  await expect(panel.locator("[data-fixes]")).toBeHidden();
  await expect(panel.locator("[data-fix-apply]")).toHaveCount(0);
  await context.setOffline(false);
  expect(await markdown(page)).toBe(source);
});

test("rejects reviewed fixes when the document's target changed since the check", async ({
  page,
}) => {
  await start(page);
  const { panel, fixes } = await checkAndReview(page);
  await fixes.locator('[data-proposal="7"]').getByRole("checkbox").check();
  // The target is retargeted after the check, for example from Documents;
  // the Markdown itself is unchanged.
  await page.evaluate(() => {
    const { metadata } = document.querySelector("app-shell").store.draft;
    metadata.workspaceDocument.target = {
      ...metadata.workspaceDocument.target,
      branch: "release",
    };
  });
  await fixes.locator("[data-fix-apply]").click();
  await expect(panel.locator("[data-status]")).toContainText(
    "The document or its target changed since the drift check, so the reviewed changes were not applied.",
  );
  await expect(panel.locator("[data-status]")).toContainText(
    "Your Markdown is unchanged.",
  );
  expect(await markdown(page)).toBe(source);
  await expect(panel.locator("[data-fixes]")).toBeHidden();
  await expect(
    panel.getByRole("button", { name: "Run drift check" }),
  ).toBeFocused();
});

test("says before Apply that changed builder sections detach, keeps untouched sections, and Undo restores", async ({
  page,
}) => {
  // The sample profile's builder sections plus one Custom Markdown block
  // with a drifting command.
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const types = () =>
    page.evaluate(() =>
      document
        .querySelector("app-shell")
        .store.draft.blocks.map((block) => block.type),
    );
  await page.evaluate(() => {
    const { store } = document.querySelector("app-shell");
    store.blocks([
      ...structuredClone(store.draft.blocks),
      {
        id: "drift-command",
        type: "custom",
        settings: { markdown: "```bash\nnpm run test-unit\n```" },
      },
    ]);
  });
  const before = await types();
  expect(before.filter((type) => type !== "custom").length).toBeGreaterThan(0);
  const original = await markdown(page);
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

  await page
    .locator(".workspace-tools")
    .getByRole("button", { name: "Drift check", exact: true })
    .click();
  const panel = page.locator("evidence-snapshots");
  await panel.getByRole("button", { name: "Run drift check" }).click();
  await panel.getByRole("button", { name: /Review fixes/ }).click(firstRead);
  const fixes = panel.locator("[data-fixes]");
  await expect(fixes.locator("[data-fix-builder]")).toContainText(
    "Applying detaches any builder section, component or generated content whose lines change",
  );
  const proposal = fixes
    .locator("[data-proposal]")
    .filter({ hasText: "npm run test-unit" });
  await proposal.getByRole("checkbox").check();
  await fixes.locator("[data-fix-apply]").click();
  // The fix touched only the Custom Markdown block: every builder section
  // keeps its ownership and nothing is reported as detached.
  await expect(panel.locator("[data-status]")).toContainText(
    "Undo in the editor restores the previous Markdown.",
  );
  await expect(panel.locator("[data-status]")).not.toContainText(
    "Custom Markdown",
  );
  expect(await types()).toEqual(before);
  expect(await markdown(page)).toBe(
    original.replace("npm run test-unit", "npm run test:unit"),
  );

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await types()).toEqual(before);
  expect(await markdown(page)).toBe(original);
});
