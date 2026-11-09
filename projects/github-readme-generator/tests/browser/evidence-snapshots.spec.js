import { test, expect } from "@playwright/test";

const sha = (c) => c.repeat(40);
// The first capture in a page lazily loads the evidence modules, which can be
// slow on a cold dev server.
const firstRead = { timeout: 20_000 };
const source =
  "# Widget\n\nSee [usage](docs/usage.md) and [planned](docs/planned.md).\n";
const files = (changed = false) => ({
  sha: sha("2"),
  truncated: false,
  tree: [
    { path: "README.md", type: "blob", sha: sha("3") },
    { path: "package.json", type: "blob", sha: changed ? sha("e") : sha("4") },
    { path: "docs/usage.md", type: "blob", sha: sha("6") },
  ],
});
async function mockGitHub(page, { tree = files(), head = sha("1") } = {}) {
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/commits?"))
      return route.fulfill({
        json: [{ sha: head, commit: { tree: { sha: sha("2") } } }],
      });
    if (url.includes("/git/trees/"))
      return typeof tree === "number"
        ? route.fulfill({ status: tree, json: {} })
        : route.fulfill({ json: tree });
    return route.fulfill({ status: 404, json: {} });
  });
}
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate(
    (markdown) => document.querySelector("app-shell").store.raw(markdown),
    source,
  );
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  const documents = page.locator("workspace-documents");
  await documents.getByLabel("Document group").selectOption("repository");
  await documents.getByLabel("Document repository").fill("example/widget");
  await documents.getByLabel("Document branch").fill("main");
  await documents
    .getByRole("button", { name: "Save document settings" })
    .click();
  await mockGitHub(page);
}
const open = (page) =>
  page
    .locator(".workspace-tools")
    .getByRole("button", { name: "Evidence snapshots", exact: true })
    .click();
const stored = (page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("readme-studio:v1")).evidenceSnapshots
        ?.items || [],
  );
const markdown = (page) =>
  page.evaluate(() => document.querySelector("app-shell").store.draft.markdown);

test("captures, pins a Baseline and runs a read-only change check by keyboard at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  const requests = [];
  page.on("request", (request) =>
    requests.push({ method: request.method(), url: request.url() }),
  );
  await open(page);
  const panel = page.locator("evidence-snapshots");
  await expect(panel).toContainText("No evidence snapshots for this document");
  await expect(panel).toContainText("example/widget · branch main · README.md");
  await panel
    .getByRole("button", { name: "Capture evidence snapshot" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator("[data-status]")).toContainText(
    "Snapshot captured. Your Markdown is unchanged.",
    firstRead,
  );
  await expect(
    panel.getByRole("button", { name: "Capture evidence snapshot" }),
  ).toBeFocused();
  expect(await markdown(page)).toBe(source);
  const item = panel.locator("[data-snapshot]").first();
  await expect(item.locator("[data-labels]")).toContainText("Partial snapshot");
  await expect(item.locator("[data-labels]")).toContainText(
    "Markdown unchanged since capture",
  );
  await expect(item).toContainText("Branch head 1111111");
  await expect(item).toContainText("README revision 3333333");
  await item.getByText("Evidence files (4)").click();
  await expect(item.locator("tbody tr")).toHaveCount(4);
  await expect(item).toContainText("docs/planned.md");
  await expect(item).toContainText("Missing on GitHub");

  await item.getByRole("button", { name: "Pin as Baseline" }).focus();
  await page.keyboard.press("Enter");
  const pinned = panel.locator("[data-snapshot]").first();
  await expect(pinned.locator("[data-labels]")).toContainText("Baseline");
  await expect(
    pinned.getByRole("button", { name: "Unpin Baseline" }),
  ).toBeFocused();
  expect((await stored(page))[0].baseline).toBe(true);

  await page.reload();
  await mockGitHub(page, { tree: files(true), head: sha("9") });
  await open(page);
  await expect(
    panel.locator("[data-snapshot]").first().locator("[data-labels]"),
  ).toContainText("Baseline");
  const before = await page.evaluate(() =>
    localStorage.getItem("readme-studio:v1"),
  );
  await panel
    .locator("[data-snapshot]")
    .first()
    .getByRole("button", { name: "Run change check" })
    .click();
  const check = panel.locator("[data-check]");
  await expect(
    check.getByRole("heading", { name: "Change check" }),
  ).toBeFocused();
  await expect(check).toContainText("Branch head changed: 1111111 → 9999999");
  await expect(check.locator("[data-counts]")).toHaveText(
    "1 changed · 0 added · 0 removed · 0 unknown · 3 unchanged",
  );
  await expect(check.locator('[data-result="changed"]')).toContainText(
    "package.json",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("readme-studio:v1")),
  ).toBe(before);
  expect(
    requests.filter(
      (r) => r.url.startsWith("https://api.github.com/") && r.method !== "GET",
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Widget, edited locally"),
  );
  await open(page);
  await expect(panel.locator("[data-snapshot]").first()).toContainText(
    "Markdown edited since capture",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page
    .locator("workspace-documents")
    .getByLabel("Document branch")
    .fill("next");
  await page
    .locator("workspace-documents")
    .getByRole("button", { name: "Save document settings" })
    .click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page
    .locator("workspace-documents")
    .getByRole("button", { name: "Evidence snapshots", exact: true })
    .click();
  const different = panel.locator("[data-snapshot]").first();
  await expect(different.locator("[data-labels]")).toContainText(
    "Different target",
  );
  await expect(
    different.getByRole("button", { name: "Run change check" }),
  ).toBeDisabled();
  await expect(different).toContainText(
    "Captured for example/widget · branch main · README.md",
  );
});

test("failed, partial, offline and cancelled captures keep existing snapshots; retention keeps the Baseline", async ({
  page,
  context,
}) => {
  await start(page);
  await open(page);
  const panel = page.locator("evidence-snapshots");
  const capture = () =>
    panel.getByRole("button", { name: "Capture evidence snapshot" }).click();
  await capture();
  await expect(panel.locator("[data-snapshot]")).toHaveCount(1, firstRead);
  await panel.getByRole("button", { name: "Pin as Baseline" }).click();

  await mockGitHub(page, { tree: 500 });
  await capture();
  await expect(panel.locator("[data-status]")).toContainText(
    "Partial snapshot: the repository tree was not fully read.",
  );
  const partial = panel.locator("[data-snapshot]").first();
  await expect(partial).toContainText("README revision unknown");
  await expect(partial).toContainText("not treated as drift");
  expect(await stored(page)).toHaveLength(2);

  await context.setOffline(true);
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await capture();
  await expect(panel.locator("[data-status]")).toContainText(
    "Capture failed: You are offline.",
  );
  await expect(panel.locator("[data-status]")).toContainText(
    "Nothing was saved; existing snapshots are unchanged.",
  );
  await expect(panel.locator("[data-snapshot]")).toHaveCount(2);
  expect(await stored(page)).toHaveLength(2);
  await page.keyboard.press("Escape");
  await open(page);
  await expect(panel.locator("[data-snapshot]")).toHaveCount(2);
  await context.setOffline(false);

  let release;
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", async (route) => {
    await new Promise((resolve) => (release = resolve));
    await route.fulfill({ status: 503, json: {} }).catch(() => {});
  });
  await capture();
  await expect(panel.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel.locator("[data-status]")).toContainText(
    "Capture cancelled. Nothing was saved",
  );
  release?.();
  expect(await stored(page)).toHaveLength(2);

  await mockGitHub(page);
  for (let i = 0; i < 5; i++) {
    await capture();
    await expect(panel.locator("[data-status]")).toContainText(
      "Snapshot captured.",
    );
  }
  await expect(panel.locator("[data-status]")).toContainText(
    "Retention removed 1 older snapshot(s).",
  );
  const kept = await stored(page);
  expect(kept).toHaveLength(6);
  expect(kept.filter((item) => item.baseline)).toHaveLength(1);
  expect(kept.some((item) => item.tree === "failed")).toBe(false);
  expect(await markdown(page)).toBe(source);
});

test("ineligible documents explain the target and storage failures save nothing", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page
    .locator("workspace-documents")
    .getByRole("button", { name: "New document", exact: true })
    .click();
  await open(page);
  const panel = page.locator("evidence-snapshots");
  await expect(panel).toContainText("cannot be captured");
  await expect(
    panel.getByRole("button", { name: "Capture evidence snapshot" }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Set document target" }).click();
  await expect(page.locator("workspace-documents")).toBeVisible();
  await page.keyboard.press("Escape");

  const ids = await page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.id),
  );
  await page.getByLabel("Current draft").selectOption(ids[0]);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreSetItem = () => (Storage.prototype.setItem = original);
    Storage.prototype.setItem = function (key, value) {
      if (key === "readme-studio:v1" && value.includes('"sourceHash"'))
        throw new DOMException("Quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await open(page);
  await panel
    .getByRole("button", { name: "Capture evidence snapshot" })
    .click();
  await expect(panel.locator("[data-status]")).toContainText(
    "Capture failed: Browser storage is full or unavailable",
    firstRead,
  );
  await expect(panel.locator("[data-snapshot]")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        document.querySelector("app-shell").data.evidenceSnapshots?.items
          .length ?? 0,
    ),
  ).toBe(0);
  // A failure while saving must not leave the panel stuck busy.
  const captureButton = panel.getByRole("button", {
    name: "Capture evidence snapshot",
  });
  await expect(captureButton).toBeEnabled();
  await expect(captureButton).toBeFocused();
  await expect(panel.locator("[data-cancel]")).toBeHidden();
  await page.evaluate(() => window.restoreSetItem());
  await captureButton.click();
  await expect(panel.locator("[data-status]")).toContainText(
    "Snapshot captured.",
  );
  await expect(panel.locator("[data-snapshot]")).toHaveCount(1);
});

test("deleting a draft warns that its evidence snapshots and Baseline go too", async ({
  page,
}) => {
  await start(page);
  await open(page);
  const panel = page.locator("evidence-snapshots");
  await panel
    .getByRole("button", { name: "Capture evidence snapshot" })
    .click();
  await expect(panel.locator("[data-snapshot]")).toHaveCount(1, firstRead);
  await panel.getByRole("button", { name: "Pin as Baseline" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Manage drafts" }).click();
  await page.getByRole("button", { name: "Delete this draft" }).click();
  await expect(page.locator("[data-delete-evidence]")).toContainText(
    "1 evidence snapshot(s), including its Baseline",
  );
  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect.poll(() => stored(page)).toHaveLength(0);
});
