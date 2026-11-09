import { test, expect } from "@playwright/test";
const prose =
  "This project explores several practical ways to render a small game while keeping controls accessible and preserving local progress for players on different devices.";
const basic =
  prose +
  "\n\n## Controls\n\nPress the arrow keys to move around the world and discover hidden objects.\n\n## Gameplay\n\nCollect items and complete the stages to unlock more of the world.";
const repo = (name, extra = {}) => ({
  name,
  full_name: `example/${name}`,
  owner: { login: "example" },
  default_branch: "main",
  topics: ["game"],
  language: "Rust",
  pushed_at: new Date(Date.now() - 3 * 86400000).toISOString(),
  ...extra,
});
const file = (source, sha = "a".repeat(40)) => ({
  path: "README.md",
  sha,
  size: Buffer.byteLength(source),
  encoding: "base64",
  content: Buffer.from(source).toString("base64"),
});
async function audit(page, first = true) {
  if (first) {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Explore the sample profile" })
      .click();
  }
  await page
    .getByRole("button", { name: "README Attention Queue", exact: true })
    .click();
  await expect(
    page.locator("repository-audit [data-audit-results]"),
  ).not.toBeVisible();
  await expect(page.locator("readme-attention-queue")).toBeVisible();
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-count]")).toContainText(
    "loaded",
  );
}
async function scan(page) {
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete",
  );
}
test.beforeEach(async ({ page }) => {
  await page.route("https://img.shields.io/**", (route) => route.abort());
});

test("attention tiers, combined filters and next/source actions work at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  let reads = 0;
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          repo("game", {
            stargazers_count: 5,
            homepage: "https://example.org",
          }),
          repo("missing"),
          repo("basic"),
          repo("archive", { archived: true, language: "Python" }),
          repo("old", { pushed_at: "2020-01-01T00:00:00Z" }),
        ],
      });
    reads++;
    return route.fulfill(
      url.includes("/missing/")
        ? { status: 404, json: {} }
        : { json: file(url.includes("/basic/") ? basic : prose) },
    );
  });
  await audit(page);
  const queue = page.locator("readme-attention-queue");
  await expect(queue).toBeVisible();
  await page.getByLabel("Include archived repositories").check();
  await scan(page);
  await expect(queue.locator("[data-item]")).toHaveCount(4);
  await expect(queue.locator("[data-item]").first()).toContainText(
    "example/missing",
  );
  await expect(queue).toContainText("High attention");
  await expect(queue).toContainText("Medium attention");
  await expect(queue).toContainText("Low attention");
  await expect(queue).toContainText(
    "Game controls not detected. Commonly useful for this project type.",
  );
  await queue
    .getByLabel("Attention priority", { exact: true })
    .selectOption("high");
  await queue
    .getByLabel("Active only (pushed within 30 days)", { exact: true })
    .check();
  await queue
    .getByLabel("Queue language", { exact: true })
    .selectOption("Rust");
  await queue
    .getByLabel("Queue project type", { exact: true })
    .selectOption("game");
  await queue.getByLabel("Minimum stars", { exact: true }).fill("5");
  await queue.getByLabel("Minimum stars", { exact: true }).press("Tab");
  await queue.getByLabel("Pushed recently", { exact: true }).selectOption("30");
  await expect(queue.locator("[data-item]")).toHaveCount(1);
  await expect(queue.locator("[data-item]")).toContainText("example/game");
  await queue.getByLabel("Missing only", { exact: true }).check();
  await expect(queue.locator("[data-item]")).toHaveCount(0);
  await queue.getByRole("button", { name: "Reset queue filters" }).click();
  await queue
    .getByLabel("Archived repositories", { exact: true })
    .selectOption("only");
  await expect(queue.locator("[data-item]")).toHaveCount(1);
  await expect(queue.locator("[data-item]")).toContainText("example/archive");
  expect(reads).toBe(5);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await queue.getByRole("button", { name: "Reset queue filters" }).click();
  await queue
    .getByRole("button", { name: "Improve next", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".batch-bar")).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe("");
  await page
    .getByRole("button", { name: "README Attention Queue", exact: true })
    .click();
  await queue
    .locator("[data-item]")
    .filter({
      has: page.getByRole("heading", { name: "example/game", exact: true }),
    })
    .getByRole("button", { name: "Open in Studio" })
    .click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(prose);
  expect(reads).toBe(5);
});

test("intentionally minimal survives reload, returns after changed README, and deferred items can be restored", async ({
  page,
}) => {
  let sha = "a".repeat(40);
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("small")]
        : file(prose + (sha.startsWith("b") ? " Updated." : ""), sha),
    }),
  );
  await audit(page);
  await scan(page);
  const queue = page.locator("readme-attention-queue");
  await queue
    .getByRole("button", { name: "Mark intentionally minimal", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(queue.locator("[data-item]")).toHaveCount(0);
  await expect(
    queue.getByRole("heading", { name: "README Attention Queue", exact: true }),
  ).toBeFocused();
  await page.reload();
  await audit(page, false);
  await scan(page);
  await expect(queue.locator("[data-item]")).toHaveCount(0);
  await queue
    .getByLabel("Queue visibility", { exact: true })
    .selectOption("only");
  await expect(queue).toContainText(
    "Intentionally minimal for this README revision",
  );
  await queue.getByLabel("Queue visibility", { exact: true }).selectOption("");
  sha = "b".repeat(40);
  await page.getByLabel("Fetch fresh README content").check();
  await scan(page);
  await expect(queue.locator("[data-item]")).toHaveCount(1);
  await queue
    .getByRole("button", { name: "Ignore for now", exact: true })
    .click();
  await expect(queue.locator("[data-item]")).toHaveCount(0);
  await queue
    .getByLabel("Queue visibility", { exact: true })
    .selectOption("only");
  await expect(queue).toContainText("Ignored until");
  await queue
    .getByRole("button", { name: "Return to queue", exact: true })
    .click();
  await queue.getByLabel("Queue visibility", { exact: true }).selectOption("");
  await expect(queue.locator("[data-item]")).toHaveCount(1);
  // A manual Experiment override makes this short substantive README appropriate.
  await page
    .locator("repository-audit")
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  await expect(queue).not.toBeVisible();
  await page
    .getByLabel("Project type for example/small", { exact: true })
    .selectOption("experiment");
  await page
    .locator("repository-audit")
    .getByRole("button", { name: "README Attention Queue", exact: true })
    .click();
  await expect(queue.locator("[data-item]")).toHaveCount(0);
  await expect(queue).toContainText("1 without current attention signals");
});

test("queue decisions and other-tab changes refresh the audit-row improvement plan", async ({
  page,
}) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("small")]
        : file(prose),
    }),
  );
  await audit(page);
  await scan(page);
  const queue = page.locator("readme-attention-queue");
  const view = (name) =>
    page
      .locator("repository-audit")
      .getByRole("button", { name, exact: true })
      .click();
  const plan = page.locator("[data-audit-results] improvement-plan");
  const thin = plan
    .locator("li[data-rec]")
    .filter({ hasText: "Expand the README" });
  const note = "Marked intentionally minimal for this README revision.";
  const mark = thin.getByRole("button", {
    name: "Mark intentionally minimal",
  });
  // Open the row plan first so later queue decisions must redraw it.
  await view("Audit results");
  await plan.locator("summary").click();
  await expect(mark).toBeVisible();
  await view("README Attention Queue");
  await queue
    .getByRole("button", { name: "Mark intentionally minimal", exact: true })
    .click();
  await expect(queue.locator("[data-item]")).toHaveCount(0);
  await view("Audit results");
  await expect(thin).toContainText(note);
  await expect(mark).toHaveCount(0);
  const minimal = await page.evaluate(() =>
    localStorage.getItem("readme-studio:audit-decisions:v1"),
  );
  await view("README Attention Queue");
  await queue
    .getByLabel("Queue visibility", { exact: true })
    .selectOption("only");
  await queue
    .getByRole("button", { name: "Return to queue", exact: true })
    .click();
  await view("Audit results");
  await expect(thin).not.toContainText(note);
  await expect(mark).toBeVisible();
  // Another tab marks it minimal again.
  await page.evaluate((value) => {
    localStorage.setItem("readme-studio:audit-decisions:v1", value);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "readme-studio:audit-decisions:v1",
      }),
    );
  }, minimal);
  await expect(thin).toContainText(note);
  await expect(mark).toHaveCount(0);
});

test("damaged and unwritable attention storage stays visible and does not lose drafts or falsely suppress items", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("readme-studio:attention:v1", "damaged"),
  );
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("small")]
        : file(prose),
    }),
  );
  await audit(page);
  await scan(page);
  const queue = page.locator("readme-attention-queue");
  await expect(queue).toContainText("Original storage is untouched");
  await expect(
    queue.getByRole("button", {
      name: "Mark intentionally minimal",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("readme-studio:attention:v1"),
    ),
  ).toBe("damaged");
  const download = page.waitForEvent("download");
  await queue
    .getByRole("button", { name: "Download legacy attention recovery data" })
    .click();
  expect((await download).suggestedFilename()).toBe(
    "readme-attention-recovery.json",
  );
  await queue
    .getByRole("button", {
      name: "Start fresh with audit decisions",
      exact: true,
    })
    .click();
  await expect(queue).toContainText("start fresh");
  await queue
    .getByLabel(
      "I want to start fresh without changing the damaged legacy attention data",
    )
    .check();
  await queue
    .getByRole("button", {
      name: "Start fresh with audit decisions",
      exact: true,
    })
    .click();
  await expect(
    queue.getByRole("button", {
      name: "Mark intentionally minimal",
      exact: true,
    }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "readme-studio:audit-decisions:v1")
        throw new DOMException("Quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await queue
    .getByRole("button", { name: "Ignore for now", exact: true })
    .click();
  await expect(queue).toContainText("Your decision was not applied");
  await expect(queue.locator("[data-item]")).toHaveCount(1);
});

test("one failed pre-audit type save remains visible after another succeeds", async ({
  page,
}) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("unsaved-a"), repo("unsaved-b")]
        : file(basic),
    }),
  );
  await audit(page);
  const auditPanel = page.locator("repository-audit");
  await auditPanel
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  const types = ["unsaved-a", "unsaved-b"].map((name) =>
    page.getByLabel(`Project type for example/${name}`, { exact: true }),
  );
  for (const type of types) await type.selectOption("web-app");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failed = false;
    window.restoreAuditDecisionStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "readme-studio:audit-decisions:v1" && !failed) {
        failed = true;
        throw new DOMException("Quota", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();

  await expect(auditPanel.locator("[data-status]")).toContainText(
    "Your decision was not applied",
  );
  expect(
    (await Promise.all(types.map((type) => type.inputValue()))).sort(),
  ).toEqual(["auto", "web-app"]);
  await page.evaluate(() => window.restoreAuditDecisionStorage());
  for (const type of types) await type.selectOption("api");
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(auditPanel.locator("[data-status]")).toContainText(
    "Audit complete",
  );
  await expect(auditPanel.locator("[data-status]")).not.toContainText(
    "Your decision was not applied",
  );
});

test("improvement plans explain evidence, move focus after Skip and Dismiss, and drop dismissed gaps from the queue at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("swing")]
        : file(prose),
    }),
  );
  await audit(page);
  await scan(page);
  const queue = page.locator("readme-attention-queue");
  const item = queue.locator("[data-item]").first();
  const summary = item.locator("improvement-plan summary");
  await expect(summary).toHaveText("Improvement plan · 6 recommendations");
  await summary.focus();
  await page.keyboard.press("Enter");
  const plan = item.locator("improvement-plan");
  await expect(plan).toContainText("Based on README revision aaaaaaa read");
  await expect(plan).toContainText("Recommendations are advisory");
  await expect(plan.getByRole("heading", { name: "Start here" })).toBeVisible();
  const controls = plan
    .locator("li[data-rec]")
    .filter({ hasText: "Add a Controls section" });
  await expect(controls).toContainText(
    "Controls: no populated heading matched",
  );
  await expect(controls).toContainText("type from repository topic “game”");
  await expect(controls).toContainText("README revision aaaaaaa");
  await controls.getByRole("button", { name: "Skip", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(queue.locator("[data-queue-status]")).toContainText(
    "Skipped “Add a Controls section” for example/swing",
  );
  // Focus moves to the recommendation that took the skipped one's place.
  const setup = plan
    .locator("li[data-rec]")
    .filter({ hasText: "Add setup or how-to-run instructions" });
  await expect(
    setup.getByRole("button", { name: "Improve README", exact: true }),
  ).toBeFocused();
  await expect(plan).toContainText("Skipped (1)");
  await expect(summary).toHaveText("Improvement plan · 5 recommendations");
  // Skip never changes the queue.
  await expect(item).toContainText("Game controls not detected");
  await setup
    .getByRole("button", {
      name: "Dismiss for this README revision",
      exact: true,
    })
    .click();
  await expect(item).not.toContainText(
    "Build/run or setup instructions not detected",
  );
  await expect(queue.locator("[data-queue-count]")).toContainText(
    "1 recommendation dismissed",
  );
  await expect(
    plan
      .locator("li[data-rec]")
      .filter({ hasText: "Add a Gameplay section" })
      .getByRole("button", { name: "Improve README", exact: true }),
  ).toBeFocused();
  await expect(plan).toContainText("Dismissed for this README revision (1)");
  // Thin READMEs offer Intentionally minimal instead of Dismiss.
  const thin = plan
    .locator("li[data-rec]")
    .filter({ hasText: "Expand the README" });
  await expect(
    thin.getByRole("button", { name: "Mark intentionally minimal" }),
  ).toBeVisible();
  await expect(
    thin.getByRole("button", { name: "Dismiss for this README revision" }),
  ).toHaveCount(0);
  await plan
    .getByRole("button", {
      name: "Restore Add setup or how-to-run instructions",
    })
    .click();
  await expect(item).toContainText(
    "Build/run or setup instructions not detected",
  );
  await expect(
    plan
      .locator("li[data-rec]")
      .filter({ hasText: "Add setup or how-to-run instructions" })
      .getByRole("button", { name: "Improve README", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await thin
    .getByRole("button", { name: "Improve README", exact: true })
    .click();
  await expect(page.getByLabel("Repository template")).toHaveValue("game");
});

test("dismissing every key gap removes the item from the queue and the plan says so", async ({
  page,
}) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("basic")]
        : file(basic),
    }),
  );
  await audit(page);
  await scan(page);
  const queue = page.locator("readme-attention-queue");
  await expect(queue.locator("[data-item]")).toHaveCount(1);
  const plan = queue.locator("improvement-plan");
  await plan.locator("summary").click();
  await expect(plan).toContainText("Add Build instructions");
  if (test.info().project.name === "chromium")
    await plan.screenshot({ path: "docs/screenshots/improvement-plan.png" });
  for (const title of [
    "Add setup or how-to-run instructions",
    "Add Build instructions",
  ])
    await plan
      .locator("li[data-rec]")
      .filter({ hasText: title })
      .getByRole("button", { name: "Dismiss for this README revision" })
      .click();
  await expect(queue.locator("[data-item]")).toHaveCount(0);
  await expect(
    queue.getByRole("heading", { name: "README Attention Queue", exact: true }),
  ).toBeFocused();
  await expect(queue.locator("[data-queue-count]")).toContainText(
    "2 recommendations dismissed",
  );
  // Audit results still show the plan with the dismissed recommendations.
  await page
    .locator("repository-audit")
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  const rowPlan = page.locator("repository-audit tbody improvement-plan");
  await rowPlan.locator("summary").click();
  await expect(rowPlan).toContainText("Dismissed for this README revision (2)");
});

test("reset clears a pending pre-audit type as well as the saved type", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "readme-studio:audit-decisions:v1",
      JSON.stringify({
        version: 1,
        repositories: [
          {
            repository: "example/reset-type",
            projectType: {
              id: "web-app",
              observedRevision: `sha:${"a".repeat(40)}`,
            },
            dismissals: [],
          },
        ],
      }),
    ),
  );
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("reset-type")]
        : file(basic),
    }),
  );
  await audit(page);
  const auditPanel = page.locator("repository-audit");
  await auditPanel
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  const type = page.getByLabel("Project type for example/reset-type", {
    exact: true,
  });
  await expect(type).toHaveValue("web-app");
  await type.selectOption("api");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreAuditDecisionStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "readme-studio:audit-decisions:v1")
        throw new DOMException("Quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await auditPanel
    .getByRole("button", {
      name: "Reset saved audit decisions for example/reset-type",
    })
    .click();
  await expect(type).toHaveValue("api");
  await expect(auditPanel.locator("[data-status]")).toContainText(
    "Your decision was not applied",
  );
  await page.evaluate(() => window.restoreAuditDecisionStorage());
  await auditPanel
    .getByRole("button", {
      name: "Reset saved audit decisions for example/reset-type",
    })
    .click();

  await scan(page);

  await expect(type).toHaveValue("auto");
  await expect(auditPanel.locator("[data-status]")).not.toContainText(
    "before saving a project type",
  );
});

test("saved project type and dismissal survive reload for the same README revision", async ({
  page,
}) => {
  let sha = "a".repeat(40);
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [repo("saved")]
        : file(basic, sha),
    }),
  );
  await audit(page);
  await scan(page);
  const auditPanel = page.locator("repository-audit");
  const queue = page.locator("readme-attention-queue");
  const plan = queue.locator("improvement-plan");
  await plan.locator("summary").click();
  await plan
    .locator("li[data-rec]")
    .filter({ hasText: "Add setup or how-to-run instructions" })
    .getByRole("button", { name: /Dismiss/ })
    .click();
  await auditPanel
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  await page
    .getByLabel("Project type for example/saved", { exact: true })
    .selectOption("web-app");

  await page.keyboard.press("Escape");
  await page.reload();
  await page
    .getByRole("button", { name: "README Attention Queue", exact: true })
    .click();
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await auditPanel
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  const reloadedType = page.getByLabel("Project type for example/saved", {
    exact: true,
  });
  await expect(reloadedType).toHaveValue("web-app");
  await reloadedType.selectOption("api");
  await scan(page);

  await expect(reloadedType).toHaveValue("api");
  await auditPanel
    .getByRole("button", { name: "README Attention Queue", exact: true })
    .click();
  await queue.locator("improvement-plan summary").click();
  await expect(queue.locator("improvement-plan")).toContainText(
    "Dismissed for this README revision (1)",
  );

  await auditPanel
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  sha = "b".repeat(40);
  await page.getByLabel("Fetch fresh README content").check();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  const type = page.getByLabel("Project type for example/saved", {
    exact: true,
  });
  await expect(type).toHaveValue("api");
  await expect(auditPanel).toContainText(
    "Manual override saved on this device for this repository",
  );
  const rowPlan = auditPanel.locator("tbody improvement-plan");
  await rowPlan.locator("summary").click();
  await expect(rowPlan).toContainText(
    "Dismissed for an earlier README revision",
  );

  await auditPanel
    .getByRole("button", {
      name: "Reset saved audit decisions for example/saved",
    })
    .click();
  await expect(auditPanel).not.toContainText(
    "Manual override saved on this device for this repository",
  );
  await expect(rowPlan).not.toContainText(
    "Dismissed for an earlier README revision",
  );
});
