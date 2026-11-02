import { test, expect } from "@playwright/test";
const source =
  "\ufeff# Audit café\r\n\r\nThis repository contains a practical notes application with accessible controls and useful local exports for people working offline without sending their content to a remote service.\r\n";
const metadata = (name, extra = {}) => ({
  name,
  full_name: `example/${name}`,
  owner: { login: "example" },
  default_branch: "main",
  language: "Rust",
  pushed_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-28T00:00:00Z",
  ...extra,
});
const file = (text = source) => ({
  path: "README.md",
  sha: "a".repeat(40),
  size: Buffer.byteLength(text),
  encoding: "base64",
  content: Buffer.from(text).toString("base64"),
});
async function open(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.getByRole("button", { name: "README audit", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Repository README audit" }),
  ).toBeVisible();
  await expect(page.locator("readme-attention-queue")).not.toBeVisible();
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
}
test.beforeEach(async ({ page }) => {
  await page.route("https://img.shields.io/**", (route) => route.abort());
});

test("captures explicit local audit snapshots and compares only fresh observations", async ({
  page,
}) => {
  let version = 1;
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({ json: [metadata("snapshots")] });
    const text =
      version === 1
        ? "# Tool\n\nTODO: replace this placeholder with project documentation."
        : "# Tool\n\nThis template provides a minimal setup to get React working in Vite with official plugins.";
    return route.fulfill({
      json: { ...file(text), sha: (version === 1 ? "a" : "b").repeat(40) },
    });
  });
  await open(page);
  const history = page.locator("audit-snapshot-history");
  await expect(history).toContainText("does not fetch, re-audit, monitor");
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await history
    .getByRole("button", { name: "Capture current audit results" })
    .click();
  await expect(history.getByRole("status")).toContainText(
    "Captured 1 audit results locally",
  );

  version = 2;
  await page.getByLabel("Fetch fresh README content").check();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await history
    .getByRole("button", { name: "Capture current audit results" })
    .click();
  await history
    .getByRole("button", { name: "Capture current audit results" })
    .click();
  await history.getByRole("button", { name: "Compare snapshots" }).click();
  await expect(history).toContainText("Added (1)");
  await expect(history).toContainText("Replace Vite starter text");
  await expect(history).toContainText("Resolved (1)");
  await expect(history).toContainText("Review TODO text");
  await expect(history).toContainText("This is not live monitoring");

  const deleteSnapshot = history.getByRole("button", {
    name: /Delete audit snapshot from/,
  });
  await deleteSnapshot.first().click();
  await expect(deleteSnapshot).toHaveCount(2);
  await expect(deleteSnapshot.first()).toBeFocused();
  await expect(history.locator("[data-diff]")).toBeEmpty();
  await expect(history.getByRole("status")).toContainText(
    "Current audit results are unchanged",
  );
});

test("selected audit distinguishes states, reuses cache and improves exact source in a new draft", async ({
  page,
}) => {
  let reads = 0;
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          metadata("notes"),
          metadata("missing"),
          metadata("tiny"),
          metadata("archived", { archived: true }),
          metadata("fork", { fork: true }),
        ],
      });
    reads++;
    return route.fulfill(
      url.includes("/missing/")
        ? { status: 404, json: {} }
        : { json: file(url.includes("/tiny/") ? "# Tiny\nTODO" : source) },
    );
  });
  await open(page);
  await expect(page.locator("repository-audit [data-count]")).toHaveText(
    "3 included of 5 loaded · 0 selected",
  );
  expect(reads).toBe(0);
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete: 3 of 3",
  );
  await expect(page.locator("repository-audit")).toContainText(
    "Missing README",
  );
  await expect(page.locator("repository-audit")).toContainText("Stub README");
  await expect(page.locator("repository-audit")).toContainText(
    "Minimal for a Generic Repository",
  );
  if (test.info().project.name === "chromium")
    await page.screenshot({
      path: "docs/screenshots/repository-audit.png",
      fullPage: true,
    });
  expect(reads).toBe(3);
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete: 3 of 3",
  );
  expect(reads).toBe(3);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "README audit", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("repository-audit")).toContainText(
    "Minimal for a Generic Repository",
  );
  const row = page
    .locator("repository-audit tr")
    .filter({ has: page.getByLabel("Select example/notes", { exact: true }) });
  await expect(
    row.getByRole("link", { name: "Open README", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/notes/blob/main/README.md",
  );
  await row.getByRole("button", { name: "Improve README" }).click();
  await page
    .getByRole("button", { name: "Open existing README unchanged" })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await page.locator("#draft-select option").count()).toBe(2);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);
  expect(reads).toBe(3);
});

test("archive/fork options and missing README improvement work by keyboard at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill(
      route.request().url().includes("/users/")
        ? {
            json: [
              metadata("old", { archived: true }),
              metadata("fork", { fork: true }),
            ],
          }
        : { status: 404, json: {} },
    ),
  );
  await open(page);
  await page.getByLabel("Include archived repositories").check();
  await page.getByLabel("Include forks", { exact: true }).check();
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete: 2 of 2",
  );
  await expect(page.locator("repository-audit")).toContainText("Archived");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.locator("repository-audit [data-improve]").first().click();
  await page
    .getByRole("button", { name: "Open existing README unchanged" })
    .click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe("");
});

test("100 repositories use bounded rendering and survive partial/rate-limit failures", async ({
  page,
}) => {
  let reads = 0,
    phase = "partial";
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: Array.from({ length: 100 }, (_, i) => metadata(`repo-${i}`)),
        headers: {
          Link: '<https://api.github.com/users/example/repos?page=2>; rel="next"',
        },
      });
    reads++;
    if (phase === "limited")
      return route.fulfill({
        status: 429,
        headers: { "retry-after": "60" },
        json: {},
      });
    return route.fulfill(
      phase === "partial" && url.includes("/repo-7/")
        ? { status: 500, json: {} }
        : { json: file("# Small\n\n" + source) },
    );
  });
  await open(page);
  await expect(page.locator("repository-audit tbody tr")).toHaveCount(25);
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "100 of 100 checked; 1 not assessed",
    { timeout: 30000 },
  );
  expect(reads).toBe(100);
  await expect(page.locator("repository-audit")).toContainText(
    "GitHub request failed (500)",
  );
  phase = "resume";
  await page.evaluate(() => {
    const resumedTime = Date.now() + 3600000;
    Date.now = () => resumedTime;
  });
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "100 of 100 checked; 0 not assessed",
  );
  expect(reads).toBe(101); // Only the failed row is retried even after source-cache expiry.
  await page
    .locator("repository-audit")
    .getByRole("button", { name: "README Attention Queue", exact: true })
    .click();
  const queue = page.locator("readme-attention-queue");
  await expect(queue.locator("[data-item]")).toHaveCount(25);
  await expect(queue).toContainText("100 matching");
  await queue
    .getByRole("button", { name: "Next queue page", exact: true })
    .click();
  await expect(queue.locator("[data-queue-page]")).toContainText("Page 2 of 4");
  expect(reads).toBe(101);
  await page
    .locator("repository-audit")
    .getByRole("button", { name: "Audit results", exact: true })
    .click();
  await page.getByRole("button", { name: "Next results", exact: true }).click();
  await expect(page.locator("repository-audit [data-page]")).toContainText(
    "Page 2 of 4",
  );
  phase = "limited";
  await page.getByLabel("Fetch fresh README content").check();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit paused",
  );
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "rate limit reached",
  );
  expect(reads).toBeLessThanOrEqual(104);
});

test("closing cancels pending work; offline failures do not become missing READMEs", async ({
  page,
}) => {
  let reads = 0;
  await page.route("https://api.github.com/**", async (route) => {
    if (route.request().url().includes("/users/"))
      return route.fulfill({
        json: Array.from({ length: 10 }, (_, i) => metadata(`r${i}`)),
      });
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.abort().catch(() => {});
  });
  await open(page);
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.waitForTimeout(600);
  expect(reads).toBeLessThanOrEqual(3);
  await page.getByRole("button", { name: "README audit", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page.getByLabel("Select example/r0", { exact: true }).check();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "1 not assessed",
  );
  await expect(page.locator("repository-audit tbody")).not.toContainText(
    "Missing README",
  );
});

test("analysis falls back if Worker creation fails", async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw Error("Worker unavailable");
      }
    };
  });
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/users/")
        ? [metadata("fallback", { topics: ["game"] })]
        : file(),
    }),
  );
  await open(page);
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete: 1 of 1",
  );
  await expect(page.locator("repository-audit")).toContainText(
    "Minimal for a Game",
  );
});

test("project type overrides update cached evidence, retain keyboard focus and reset explicitly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  let reads = 0;
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/users/")) {
      const owner = url.includes("/another/") ? "another" : "example";
      return route.fulfill({
        json: [
          metadata("tool", {
            topics: ["cli"],
            full_name: `${owner}/tool`,
            owner: { login: owner },
          }),
        ],
      });
    }
    reads++;
    return route.fulfill({ json: file() });
  });
  await open(page);
  const type = page.getByLabel("Project type for example/tool", {
    exact: true,
  });
  await expect(type.locator("option")).toHaveCount(15);
  await expect(page.locator("repository-audit")).toContainText(
    "Suggested type: CLI",
  );
  await expect(page.locator("repository-audit")).toContainText(
    "Repository topic “cli”",
  );
  await type.selectOption("experiment");
  await page.getByLabel("Select example/tool", { exact: true }).check();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit")).toContainText(
    "Basic for an Experiment",
  );
  expect(reads).toBe(1);
  await type.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(type).toHaveValue("web-app");
  await expect(type).toBeFocused();
  await expect(page.locator("repository-audit")).toContainText(
    "Minimal for a Web App",
  );
  await expect(page.locator("repository-audit")).toContainText(
    "Deployment: not detected. Commonly useful for this project type.",
  );
  await expect(page.locator("repository-audit")).toContainText(
    "Suggested type: CLI",
  );
  expect(reads).toBe(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  // Leave the native select popup before dismissing the containing dialog.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "README audit", exact: true }).click();
  await expect(type).toHaveValue("web-app");
  await page.getByLabel("Fetch fresh README content").check();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete: 1 of 1",
  );
  await expect(type).toHaveValue("web-app");
  expect(reads).toBe(2);
  await type.selectOption("auto");
  await expect(page.locator("repository-audit")).toContainText(
    "Minimal for a CLI",
  );
  expect(reads).toBe(2);
  await type.selectOption("experiment");
  await page.getByLabel("GitHub username", { exact: true }).fill("another");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await expect(
    page.getByLabel("Project type for another/tool", { exact: true }),
  ).toHaveValue("auto");
  expect(
    await page
      .locator("repository-audit")
      .evaluate((el) => el.state.typeOverrides.size),
  ).toBe(0);
});

test("optional history and link review preserves assessments and explains uncertain resources", async ({
  page,
}) => {
  const current = Date.now();
  let historyCalls = 0,
    linkCalls = 0;
  await page.route("https://api.github.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/users/"))
      return route.fulfill({ json: [metadata("review")] });
    if (url.pathname.endsWith("/commits")) {
      historyCalls++;
      return route.fulfill({
        json: url.searchParams.has("path")
          ? [
              {
                commit: {
                  committer: {
                    date: new Date(current - 200 * 86400000).toISOString(),
                  },
                },
              },
            ]
          : Array.from({ length: 10 }, (_, i) => ({
              sha: String(i),
              commit: {
                committer: {
                  date: new Date(current - i * 86400000).toISOString(),
                },
              },
            })),
      });
    }
    return route.fulfill({
      json: file(
        "# your-project-name\n\nTODO: add project details.\n\n![Diagram](https://audit-test.example/missing.png)\n[Website](https://audit-test.example/blocked)",
      ),
    });
  });
  await page.route("https://audit-test.example/**", (route) => {
    linkCalls++;
    return route.request().url().includes("blocked")
      ? route.abort()
      : route.fulfill({ status: 404, body: "" });
  });
  await open(page);
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete",
  );
  await expect(page.locator("[data-audit-results]")).toContainText(
    "Possible template placeholder",
  );
  expect(historyCalls).toBe(0);
  expect(linkCalls).toBe(0);
  await page.getByRole("button", { name: "Check history and links" }).click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "checks complete",
  );
  await expect(page.locator("[data-audit-results]")).toContainText(
    "README may need review",
  );
  await expect(page.locator("[data-audit-results]")).toContainText(
    "Image unavailable",
  );
  await expect(page.locator("[data-audit-results]")).toContainText(
    "1 unverifiable",
  );
  await expect(
    page.getByRole("button", { name: "Check history and links" }),
  ).toBeFocused();
  // Link evidence cites when the check ran, not when the audit read the README.
  const plan = page.locator("[data-audit-results] improvement-plan");
  await plan.locator("summary").click();
  const image = plan
    .locator("li[data-rec]")
    .filter({ hasText: "Review unavailable image" });
  await expect(image).toContainText("HTTP 404/410 at check time");
  await expect(image).toContainText(/Checked \d{4}-\d\d-\d\dT/);
  await expect(image).not.toContainText("Observed");
  await expect(
    plan.locator("li[data-rec]").filter({ hasText: "Review TODO text" }),
  ).toContainText(/Observed \d{4}-\d\d-\d\dT/);
  expect(historyCalls).toBe(2);
  expect(linkCalls).toBe(2);
  await page.getByRole("button", { name: "Check history and links" }).click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "checks complete",
  );
  expect(historyCalls).toBe(2);
  expect(linkCalls).toBe(2);
});

test("audit rows open improvement plans by keyboard, offline, with evidence, empty and not-assessed states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const paragraph = (topic) =>
    `The ${topic} part explains clearly how people prepare their machines, which tools they need, where the files live, and why each choice keeps the project predictable for new contributors arriving later.`;
  const complete = [
    "# Notes tool",
    paragraph("overview"),
    paragraph("purpose"),
    "## Installation",
    `${paragraph("installation")} Install it with the package manager before you continue.`,
    "```sh\nnpm install notes-tool\n```",
    "## Usage",
    `${paragraph("usage")} Run the command from any folder that contains notes.`,
    "## Links",
    `${paragraph("links")} Read the [full guide](https://example.org/guide) for more detail.`,
    paragraph("closing"),
    paragraph("support"),
  ].join("\n\n");
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          metadata("cli-notes", { topics: ["cli"] }),
          metadata("complete"),
          metadata("offline"),
          metadata("unversioned", { topics: ["cli"] }),
        ],
      });
    if (url.includes("/offline/")) return route.abort();
    if (url.includes("/complete/"))
      return route.fulfill({ json: file(complete) });
    if (url.includes("/unversioned/"))
      return route.fulfill({ json: { ...file(), sha: "" } });
    return route.fulfill({ json: file() });
  });
  await open(page);
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete: 4 of 4",
  );
  const row = (name) =>
    page.locator("repository-audit tr").filter({
      has: page.getByLabel(`Select example/${name}`, { exact: true }),
    });
  // Plans are built from session results only.
  await page.context().setOffline(true);
  const plan = row("cli-notes").locator("improvement-plan");
  await plan.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(plan).toContainText("Based on README revision aaaaaaa read");
  const installation = plan
    .locator("li[data-rec]")
    .filter({ hasText: "Add an Installation section" });
  await expect(installation).toContainText(
    "Installation: no populated heading matched",
  );
  await expect(installation).toContainText(
    "Key topic for CLI (type from repository topic “cli”)",
  );
  await expect(
    installation.getByRole("link", { name: "Open README on GitHub" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/cli-notes/blob/main/README.md",
  );
  await installation
    .getByRole("button", {
      name: "Dismiss for this README revision",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Dismissed “Add an Installation section” for example/cli-notes on this device for README revision aaaaaaa",
  );
  await expect(
    plan
      .locator("li[data-rec]")
      .filter({ hasText: "Add a Commands section" })
      .getByRole("button", { name: "Improve README", exact: true }),
  ).toBeFocused();
  await expect(plan).toContainText("Dismissed for this README revision (1)");
  // Skipping the last recommendation moves focus to the summary.
  const last = plan.locator("li[data-rec]").last();
  await last.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(plan.locator("summary")).toBeFocused();

  const unversioned = row("unversioned").locator("improvement-plan");
  await unversioned.locator("summary").click();
  await expect(
    unversioned
      .getByRole("button", { name: "Dismiss for this README revision" })
      .first(),
  ).toBeDisabled();
  await expect(unversioned).toContainText(
    "Refresh the audit to obtain a README revision",
  );
  const empty = row("complete").locator("improvement-plan");
  await expect(empty.locator("summary")).toHaveText(
    "Improvement plan · 0 recommendations",
  );
  await empty.locator("summary").click();
  await expect(empty).toContainText(
    "No recommendations from the current evidence. This is not a quality verdict.",
  );
  const failed = row("offline").locator("improvement-plan");
  await expect(failed.locator("summary")).toHaveText(
    "Improvement plan · not assessed",
  );
  await failed.locator("summary").click();
  await expect(failed).toContainText(
    "Not assessed - audit this repository to build a plan.",
  );
  await expect(row("offline")).not.toContainText("Missing README");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.context().setOffline(false);
  await plan
    .locator("li[data-rec]")
    .first()
    .getByRole("button", { name: "Improve README", exact: true })
    .click();
  await expect(page.getByLabel("Repository template")).toBeVisible();
});
