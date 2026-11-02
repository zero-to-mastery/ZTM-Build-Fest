import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  parseScenarios,
  scenarioBudget,
} from "../../scripts/usability-docs.mjs";

// Scripted runs of the Usability scenarios in docs/usability-scripts.md (ADR
// 0006). Each run follows the scenario's intended path with GitHub and remote
// images mocked, counts author actions through `act` and attaches
// {scenario, audience, completed, steps, keyboardOnly} as JSON. A run fails
// when the scenario stops completing or needs more actions than the budget
// recorded in the scripts doc. Scripted runs measure navigation cost; they
// are never participant results.
const scenarios = parseScenarios(
  readFileSync(new URL("../../docs/usability-scripts.md", import.meta.url), {
    encoding: "utf8",
  }),
);
const dialog = (page) => page.getByRole("dialog");
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
const nextSteps = (page) => page.getByRole("region", { name: "Next steps" });
const markdown = (page) =>
  page.evaluate(() => document.querySelector("app-shell").store.draft.markdown);
const drafts = (page) =>
  page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.name),
  );

// Wraps the author's actions so each click, key press and field entry counts
// as one step. Set-up and assertions use `page` directly and are not counted.
// Passing an earlier `act` as `tally` keeps one count across browser pages.
function actions(page, tally = { steps: 0, keyboardOnly: true }) {
  const step = (pointer = false) => {
    tally.steps++;
    if (pointer) tally.keyboardOnly = false;
  };
  const act = {
    get steps() {
      return tally.steps;
    },
    get keyboardOnly() {
      return tally.keyboardOnly;
    },
    tally,
    click: async (locator, options) => {
      step(true);
      await locator.click(options);
    },
    press: async (key) => {
      step();
      await page.keyboard.press(key);
    },
    // Typing a value is one field entry, as is choosing an option, a file
    // or a checkbox.
    type: async (text) => {
      step();
      await page.keyboard.type(text);
    },
    fill: async (locator, value) => {
      step(true);
      await locator.fill(value);
    },
    select: async (locator, value) => {
      step(true);
      await locator.selectOption(value);
    },
    upload: async (locator, files) => {
      step(true);
      await locator.setInputFiles(files);
    },
    check: async (locator) => {
      step(true);
      await locator.check();
    },
    // Moves focus one key press at a time until `target` has it.
    tabTo: async (target, key = "Tab", limit = 80) => {
      for (let i = 0; i < limit; i++) {
        if (await target.evaluate((e) => e === document.activeElement)) return;
        await act.press(key);
      }
      await expect(target).toBeFocused();
    },
    // Ctrl+K, a query and Enter: Search workspace runs its first result. The
    // author waits for the search field, as the run does.
    search: async (query) => {
      await act.press("Control+K");
      await expect(
        page.getByLabel("Search commands and content"),
      ).toBeFocused();
      await act.type(query);
      await act.press("Enter");
      await expect(page.locator("[data-search]")).toHaveCount(0);
    },
  };
  return act;
}

function scenario(id, title, run) {
  test(`${id}: ${title}`, async ({ page, browser }, testInfo) => {
    const budget = scenarioBudget(scenarios, id),
      { audience } = scenarios.find((s) => s.id === id),
      act = actions(page);
    let completed = false;
    try {
      await run({ page, browser, act });
      completed = true;
    } finally {
      await testInfo.attach(`usability-${id}.json`, {
        contentType: "application/json",
        body: JSON.stringify({
          scenario: id,
          audience,
          completed,
          steps: act.steps,
          budget,
          keyboardOnly: act.keyboardOnly,
        }),
      });
    }
    expect(
      act.steps,
      `${id} took ${act.steps} steps; its documented budget is ${budget}`,
    ).toBeLessThanOrEqual(budget);
  });
}

// Remote images never load and GitHub is never contacted unless a scenario
// mocks it; any other GitHub request fails the run.
test.beforeEach(async ({ page }) => {
  await page.route("https://img.shields.io/**", (r) => r.abort());
  await page.route("https://api.github.com/**", (r) => r.abort());
  await page.route("https://github.com/**", (r) => r.abort());
});
// Experienced scenarios start with a saved workspace from an earlier visit.
async function savedWorkspace(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await expect(dialog(page)).toBeHidden();
  await page.reload();
  await expect(editor(page)).toBeAttached();
  await expect(dialog(page)).toBeHidden();
}
async function download(page, trigger) {
  const event = page.waitForEvent("download");
  await trigger();
  const file = await event;
  return {
    name: file.suggestedFilename(),
    text: readFileSync(await file.path(), "utf8"),
  };
}

scenario(
  "N1",
  "first profile README from Guided start to export",
  async ({ page, act }) => {
    await page.goto("/");
    await act.click(
      dialog(page).getByRole("button", { name: "Write my profile README" }),
    );
    await act.click(
      dialog(page).getByRole("button", {
        name: "Start from a profile template",
      }),
    );
    await act.click(dialog(page).getByRole("button", { name: /Minimal/ }));
    await expect(dialog(page)).toBeHidden();
    await act.click(
      nextSteps(page).getByRole("button", { name: "Edit your sections" }),
    );
    await act.click(page.locator(".block-open").first());
    await act.fill(page.getByLabel("Name", { exact: true }), "Ada Example");
    // The name is not saved to the README yet, so Export README asks (F1).
    await act.click(
      page
        .locator(".workspace-tools")
        .getByRole("button", { name: "Export README" }),
    );
    const file = await download(page, () =>
      act.click(
        dialog(page).getByRole("button", { name: "Save section and export" }),
      ),
    );
    expect(file.name).toBe("README.md");
    expect(file.text).toContain("Ada Example");
    expect(file.text).not.toContain("Your Name");
  },
);

const repositoryReadme =
  "# Widget\n\n![](docs/logo.png)\n\nA small command-line tool.\n\n## Install\n\nnpm i widget\n";

scenario(
  "N2",
  "import a repository README, split it and act on a Health finding",
  async ({ page, act }) => {
    await page.goto("/");
    await act.click(
      dialog(page).getByRole("button", { name: "Write a repository README" }),
    );
    await act.click(
      dialog(page).getByRole("button", { name: "Import existing README" }),
    );
    await act.click(
      dialog(page).getByRole("button", { name: "Local file", exact: true }),
    );
    await act.upload(page.locator("#file-import"), {
      name: "README.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(repositoryReadme),
    });
    await act.click(
      dialog(page).getByRole("button", { name: "Import as new draft" }),
    );
    await expect(dialog(page)).toBeHidden();
    await act.click(
      nextSteps(page).getByRole("button", { name: "Split into sections" }),
    );
    await act.click(dialog(page).locator("#apply-split"));
    await expect(dialog(page)).toBeHidden();
    await expect(page.locator(".block-row")).toHaveCount(2);
    await act.click(
      nextSteps(page).getByRole("button", { name: "README Health" }),
    );
    const health = page.locator("readme-health");
    await expect(health).toContainText("Image has empty alt text");
    await act.click(
      health
        .locator(".health-group", { hasText: "Image has empty alt text" })
        .getByRole("button", { name: /^Go to/ }),
    );
    await expect(editor(page)).toBeFocused();
    await act.type("![Widget logo](docs/logo.png)");
    expect(await markdown(page)).toBe(
      repositoryReadme.replace("![]", "![Widget logo]"),
    );
    await act.click(
      nextSteps(page).getByRole("button", { name: "README Health" }),
    );
    await expect(health).not.toContainText("Image has empty alt text");
  },
);

const auditedReadme = "# Notes\n\nA notes application with local exports.\n";
scenario(
  "N3",
  "audit public READMEs and open one to improve",
  async ({ page, act }) => {
    await page.unroute("https://api.github.com/**");
    await page.route("https://api.github.com/**", (route) =>
      route.fulfill({
        json: route.request().url().includes("/users/")
          ? [
              {
                name: "notes",
                full_name: "example/notes",
                owner: { login: "example" },
                default_branch: "main",
                language: "Rust",
                pushed_at: "2026-09-27T00:00:00Z",
                updated_at: "2026-09-28T00:00:00Z",
              },
            ]
          : {
              path: "README.md",
              sha: "a".repeat(40),
              size: Buffer.byteLength(auditedReadme),
              encoding: "base64",
              content: Buffer.from(auditedReadme).toString("base64"),
            },
      }),
    );
    await page.goto("/");
    await act.click(
      dialog(page).getByRole("button", { name: "Audit my repository READMEs" }),
    );
    await act.click(
      dialog(page).getByRole("button", { name: "Open README audit" }),
    );
    await act.fill(
      page.getByLabel("GitHub username", { exact: true }),
      "example",
    );
    await act.click(
      page.getByRole("button", { name: "Load repositories", exact: true }),
    );
    await act.click(
      page.getByRole("button", { name: "Select all filtered repositories" }),
    );
    await act.click(
      page.getByRole("button", { name: "Audit selected", exact: true }),
    );
    await expect(page.locator("repository-audit [data-status]")).toContainText(
      "Audit complete: 1 of 1",
    );
    await act.click(page.getByRole("button", { name: "Improve README" }));
    await act.click(
      page.getByRole("button", { name: "Open existing README unchanged" }),
    );
    await expect(dialog(page)).toBeHidden();
    expect(await markdown(page)).toBe(auditedReadme);
    await expect(nextSteps(page)).toContainText(
      "Opened from the README audit in a new local draft.",
    );
  },
);

scenario(
  "N4",
  "back up the workspace and recover it in a fresh browser",
  async ({ page, browser, act }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Explore the sample profile" })
      .click();
    await editor(page).fill("# Kept safe\n\nMy own words.\n");
    const backup = await download(page, async () => {
      await act.click(
        page.locator(".workspace-tools").getByRole("button", {
          name: "Settings",
        }),
      );
      await act.click(
        dialog(page).getByRole("button", {
          name: "Download all drafts backup",
        }),
      );
    });
    expect(backup.name).toBe("readme-studio-workspace.json");
    // Browser data is lost: a fresh browser has no saved workspace.
    const fresh = await browser.newContext();
    try {
      const other = await fresh.newPage();
      await other.route("https://**/*", (r) => r.abort());
      // The same author, so the same count.
      const again = actions(other, act.tally);
      await other.goto("/");
      await expect(dialog(other)).toHaveAccessibleName(
        "What do you want to do first?",
      );
      // Guided start offers the restore itself (F3).
      await again.click(
        dialog(other).getByRole("button", { name: "Restore a backup" }),
      );
      await again.upload(other.getByLabel("Workspace backup file"), {
        name: backup.name,
        mimeType: "application/json",
        buffer: Buffer.from(backup.text),
      });
      await again.click(other.locator("#apply-restore"));
      await expect(dialog(other)).toBeHidden();
      // The restored draft is the one shown, not the new sample (F2).
      await expect(editor(other)).toHaveValue("# Kept safe\n\nMy own words.\n");
    } finally {
      await fresh.close();
    }
  },
);

scenario(
  "E1",
  "keyboard only: Search workspace to Badge Studio, add a badge and export",
  async ({ page, act }) => {
    await savedWorkspace(page);
    const before = await markdown(page);
    await act.search("badge studio");
    const studio = page.locator("badge-studio");
    // Badge Studio places focus itself before the author starts tabbing.
    await expect(studio.locator(":focus")).toHaveCount(1);
    await act.tabTo(studio.getByLabel("Search logos"));
    await act.type("react");
    await act.tabTo(
      studio
        .locator(".logo-results")
        .getByRole("button", { name: "React", exact: true }),
    );
    await act.press("Enter");
    await act.tabTo(
      studio.getByRole("button", { name: "Add to README", exact: true }),
    );
    await act.press("Enter");
    expect(await markdown(page)).toContain("logo=react");
    const file = await download(page, () => act.press("Control+Shift+E"));
    expect(file.text).toContain("logo=react");
    expect(file.text).toContain(before.split("\n")[0]);
    expect(act.keyboardOnly).toBe(true);
  },
);

// A repository README whose `npm run test-unit` no longer matches the
// repository's `test:unit` script; GitHub is mocked read-only.
const driftReadme = "# Widget\n\n## Test\n\n```bash\nnpm run test-unit\n```\n";
const sha = (c) => c.repeat(40);
const packageJson = JSON.stringify({ scripts: { "test:unit": "vitest" } });
async function mockRepository(page) {
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (route.request().method() !== "GET")
      return route.fulfill({ status: 405, json: {} });
    if (url.includes("/commits?"))
      return route.fulfill({
        json: [{ sha: sha("1"), commit: { tree: { sha: sha("2") } } }],
      });
    if (url.includes("/git/trees/"))
      return route.fulfill({
        json: {
          sha: sha("2"),
          truncated: false,
          tree: [
            { path: "README.md", type: "blob", sha: sha("3"), size: 10 },
            { path: "package.json", type: "blob", sha: sha("4"), size: 40 },
          ],
        },
      });
    if (url.endsWith(`/git/blobs/${sha("4")}`))
      return route.fulfill({
        json: {
          encoding: "base64",
          size: Buffer.byteLength(packageJson),
          content: Buffer.from(packageJson).toString("base64"),
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
}

scenario(
  "E2",
  "set a target, run a drift check and review a fix",
  async ({ page, act }) => {
    await savedWorkspace(page);
    await page.evaluate(
      (text) => document.querySelector("app-shell").store.raw(text),
      driftReadme,
    );
    await page.reload();
    await expect(editor(page)).toHaveValue(driftReadme);
    await mockRepository(page);
    // "Nothing was written to GitHub" is checked on the wire, not only in
    // the status text: any write request to a GitHub host fails the run.
    const writes = [];
    page.on("request", (request) => {
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
        /^https:\/\/([\w-]+\.)*github(usercontent)?\.com\//.test(request.url())
      )
        writes.push(`${request.method()} ${request.url()}`);
    });
    await act.search("drift check");
    await act.click(
      dialog(page).getByRole("button", { name: "Set document target" }),
    );
    const documents = page.locator("workspace-documents");
    await act.select(documents.getByLabel("Document group"), "repository");
    await act.fill(documents.getByLabel("Document repository"), "ada/widget");
    await act.fill(documents.getByLabel("Document branch"), "main");
    await act.click(
      documents.getByRole("button", { name: "Save document settings" }),
    );
    await act.search("drift check");
    const panel = page.locator("evidence-snapshots");
    await act.click(panel.getByRole("button", { name: "Run drift check" }));
    await expect(panel.locator("[data-drift-counts]")).toContainText(
      "1 observed mismatch",
      { timeout: 20_000 },
    );
    await act.click(panel.getByRole("button", { name: /^Review fixes/ }));
    await act.check(panel.locator('[data-proposal="6"]').getByRole("checkbox"));
    await act.click(panel.locator("[data-fix-apply]"));
    await expect(panel.locator("[data-status]")).toContainText(
      "Nothing was published or written to GitHub",
    );
    expect(await markdown(page)).toBe(
      driftReadme.replace("test-unit", "test:unit"),
    );
    expect(writes).toEqual([]);
  },
);

scenario(
  "E3",
  "switch documents, use and hide Next steps, reopen Guided start",
  async ({ page, act }) => {
    await savedWorkspace(page);
    await page.locator('.workspace-tools [data-action="guided-start"]').click();
    await dialog(page)
      .getByRole("button", { name: "Write a repository README" })
      .click();
    await dialog(page)
      .getByRole("button", { name: "Start a blank repository README" })
      .click();
    await page.reload();
    await expect(page.getByLabel("Current draft")).toHaveValue(/.+/);
    const ids = await page.evaluate(() =>
      document.querySelector("app-shell").data.drafts.map((d) => d.id),
    );
    await act.select(page.getByLabel("Current draft"), ids[0]);
    await act.search("templates");
    await act.click(dialog(page).getByRole("button", { name: /Minimal/ }));
    await expect(dialog(page)).toBeHidden();
    await act.click(
      nextSteps(page).getByRole("button", { name: "Preview README" }),
    );
    await expect(page.locator(".preview-pane .pane-heading")).toBeFocused();
    await act.click(nextSteps(page).getByRole("button", { name: "Hide" }));
    await expect(nextSteps(page)).toBeHidden();
    await act.search("guided start");
    const current = dialog(page).getByRole("button", {
      name: "Write a repository README",
    });
    await expect(current).toBeFocused();
    await expect(current).toHaveAttribute("aria-current", "true");
    expect(await drafts(page)).toHaveLength(3);
  },
);
