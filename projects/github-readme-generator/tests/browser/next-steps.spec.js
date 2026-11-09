import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const panel = (page) => page.getByRole("region", { name: "Next steps" });
const steps = (page) => panel(page).getByRole("list").getByRole("button");
const step = (page, name) =>
  panel(page).getByRole("button", { name, exact: true });
const dialog = (page) => page.getByRole("dialog");
const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
const blockRows = (page) => page.locator(".block-row");
const toast = (page) => page.getByRole("status").and(page.locator(".toast"));
const imported = "# Widget\n\nA small tool.\n\n## Install\n\nnpm i widget\n";
// Next steps never contact GitHub by themselves; record anything that does.
function watchGitHub(page) {
  const requests = [];
  page.on("request", (r) => {
    if (/github\.com|githubusercontent\.com/.test(r.url()))
      requests.push(r.url());
  });
  return requests;
}
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await expect(dialog(page)).toBeHidden();
}
async function importLocal(page, markdown = imported, mode = "new") {
  await page.locator(".workspace-tools [data-action=import]").click();
  await page.getByRole("button", { name: "Local file", exact: true }).click();
  await page.getByLabel("Import mode", { exact: true }).selectOption(mode);
  await page.locator("#file-import").setInputFiles({
    name: "README.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
  if (mode === "replace")
    await dialog(page)
      .getByLabel("I confirm replacing the current draft")
      .check();
  await dialog(page).locator("#apply-import").click();
  await expect(dialog(page)).toBeHidden();
}
async function profileTemplate(page) {
  await page.locator(".workspace-tools [data-action=templates]").click();
  await dialog(page)
    .getByRole("button", { name: /Minimal/ })
    .click();
  await expect(dialog(page)).toBeHidden();
}
// Moves focus with the keyboard only, one key press at a time.
async function pressUntilFocused(page, key, target, limit = 80) {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((e) => e === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}
test.beforeEach(async ({ page }) => {
  await page.route("https://img.shields.io/**", (route) => route.abort());
});

test("no Next steps before an Arrival; a profile template shows them without moving focus", async ({
  page,
}) => {
  const requests = watchGitHub(page);
  await start(page);
  await expect(panel(page)).toBeHidden();
  const trigger = page.locator(".workspace-tools [data-action=templates]");
  await profileTemplate(page);
  await expect(panel(page)).toBeVisible();
  // The dialog returned focus to its trigger; the panel took none.
  await expect(trigger).toBeFocused();
  await expect(panel(page)).not.toHaveAttribute("aria-live");
  await expect(panel(page)).not.toHaveAttribute("role", "status");
  // The usual notification announces the new draft instead.
  await expect(toast(page)).toHaveText(
    "Minimal template opened as a new local draft.",
  );
  await expect(steps(page)).toHaveText([
    "Edit your sections",
    "Autofill from GitHub",
    "Preview README",
  ]);
  await expect(panel(page)).toContainText(
    "Started a new local draft from a template.",
  );
  await expect(step(page, "Edit your sections")).toHaveAccessibleDescription(
    /yours to rewrite/,
  );
  // Edit your sections opens the Sections tab of the builder.
  await step(page, "Edit your sections").click();
  await expect(
    page.locator(".builder-content").getByRole("heading", {
      name: /Your sections/,
    }),
  ).toBeFocused();
  // Preview opens the preview pane; no dialog, no network.
  await step(page, "Preview README").click();
  await expect(page.locator(".preview-pane .pane-heading")).toBeFocused();
  // Advanced controls stay one step away.
  await panel(page).getByRole("button", { name: "All tools" }).click();
  await expect(dialog(page)).toHaveAccessibleName("Search workspace");
  await page.keyboard.press("Escape");
  await expect(
    panel(page).getByRole("button", { name: "All tools" }),
  ).toBeFocused();
  expect(requests).toEqual([]);
  // The Arrival is never written to storage.
  expect(
    await page.evaluate(() => localStorage.getItem("readme-studio:v1")),
  ).not.toMatch(/arrival|nextStep[^s]/i);
});

test("keyboard only: import, then Split into sections; Escape returns to the step and Undo still works", async ({
  page,
}) => {
  await start(page);
  await importLocal(page);
  await expect(editor(page)).toBeFocused();
  await expect(steps(page)).toHaveText([
    "Split into sections",
    "README Health",
    "Preview README",
  ]);
  await expect(panel(page)).toContainText(
    "Imported into a new local draft. The file is unchanged.",
  );
  await expect(blockRows(page)).toHaveCount(1);
  const split = step(page, "Split into sections");
  await pressUntilFocused(page, "Shift+Tab", split);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveAccessibleName("Split into sections");
  // Closing the tool returns focus to the step that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(split).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  const apply = dialog(page).locator("#apply-split");
  await pressUntilFocused(page, "Tab", apply, 10);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeHidden();
  await expect(blockRows(page)).toHaveCount(2);
  await expect(editor(page)).toHaveValue(imported);
  // The split changed the block shape, so the steps follow; the panel stays.
  await expect(steps(page)).toHaveText([
    "Preview README",
    "README Health",
    "Compatibility Lab",
  ]);
  // The tool's own Undo still restores the single imported block, and the
  // steps follow the document back without a dialog closing.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(blockRows(page)).toHaveCount(1);
  await expect(editor(page)).toHaveValue(imported);
  await expect(steps(page)).toHaveText([
    "Split into sections",
    "README Health",
    "Preview README",
  ]);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(blockRows(page)).toHaveCount(2);
  await expect(steps(page)).toHaveText([
    "Preview README",
    "README Health",
    "Compatibility Lab",
  ]);
});

test("undoing a replacing import removes the panel that described it", async ({
  page,
}) => {
  await start(page);
  const before = await blockRows(page).count();
  expect(before).toBeGreaterThan(1);
  await importLocal(page, "Just one paragraph.\n", "replace");
  await expect(blockRows(page)).toHaveCount(1);
  await expect(steps(page)).toHaveText([
    "Split into sections",
    "README Health",
    "Preview README",
  ]);
  await expect(panel(page)).toContainText(
    "Replaced this draft with the import.",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(blockRows(page)).toHaveCount(before);
  await expect(panel(page)).toBeHidden();
});

test("a save that fails after startup makes the last step Export README", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  await profileTemplate(page);
  await expect(page.locator(".save-status")).toHaveText(
    "Save failed · export to keep work",
  );
  await expect(steps(page)).toHaveText([
    "Edit your sections",
    "Autofill from GitHub",
    "Export README",
  ]);
});

test("a step's dialog returns focus to the step; Hide focuses the editor and a draft switch or reload clears the panel", async ({
  page,
}) => {
  await start(page);
  await importLocal(page, imported, "append");
  await expect(steps(page)).toHaveText([
    "Preview README",
    "README Health",
    "Compatibility Lab",
  ]);
  await expect(panel(page)).toContainText(
    "Appended the import to this draft. Undo restores the previous version.",
  );
  await step(page, "Compatibility Lab").click();
  await expect(dialog(page)).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(step(page, "Compatibility Lab")).toBeFocused();
  await panel(page).getByRole("button", { name: "Hide", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await expect(editor(page)).toBeFocused();
  // A new Arrival shows the panel again; switching drafts forgets it.
  await importLocal(page);
  await expect(panel(page)).toBeVisible();
  const drafts = await page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.id),
  );
  await page.getByLabel("Current draft").selectOption(drafts[0]);
  await expect(panel(page)).toBeHidden();
  await page.getByLabel("Current draft").selectOption(drafts.at(-1));
  await expect(panel(page)).toBeHidden();
  // A reload forgets the Arrival too: it lives only in memory.
  await importLocal(page);
  await expect(panel(page)).toBeVisible();
  await page.reload();
  await expect(editor(page)).toHaveValue(imported);
  await expect(panel(page)).toBeHidden();
});

test("GitHub import and re-import show their steps with GitHub mocked", async ({
  page,
}) => {
  let content = imported,
    sha = "one";
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/readme")
        ? {
            path: "README.md",
            sha,
            size: Buffer.byteLength(content),
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          }
        : { default_branch: "main" },
    }),
  );
  await start(page);
  await page.locator(".workspace-tools [data-action=import]").click();
  await page
    .getByLabel("GitHub username or owner/repository")
    .fill("ada/widget");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page.getByRole("button", { name: "Import as new draft" }).click();
  await expect(dialog(page)).toBeHidden();
  // The import set a repository target, so a read-only drift check is offered.
  await expect(steps(page)).toHaveText([
    "Split into sections",
    "README Health",
    "Drift check",
  ]);
  await expect(panel(page)).toContainText(
    "Imported into a new local draft. Nothing changed on GitHub.",
  );
  content = `${imported}\n## Usage\n\nwidget run\n`;
  sha = "two";
  await page
    .getByRole("button", { name: "Re-import current GitHub README" })
    .click();
  await expect(page.locator(".import-result")).toHaveText(
    "Remote README has changed",
  );
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  for (const select of await page.getByLabel(/^Action for imported/).all())
    await select.selectOption("keep");
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  await page.getByRole("button", { name: "Apply merge", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(steps(page)).toHaveText([
    "Preview README",
    "README Health",
    "Compatibility Lab",
  ]);
  await expect(panel(page)).toContainText("Merged the import into this draft.");
});

test("an audit Arrival offers Health and the Attention Queue with GitHub mocked", async ({
  page,
}) => {
  const source = "# Notes\n\nA notes application with local exports.\n";
  await page.route("https://api.github.com/**", (route) => {
    if (route.request().url().includes("/users/"))
      return route.fulfill({
        json: [
          {
            name: "notes",
            full_name: "example/notes",
            owner: { login: "example" },
            default_branch: "main",
            language: "Rust",
            pushed_at: "2026-09-27T00:00:00Z",
            updated_at: "2026-09-28T00:00:00Z",
          },
        ],
      });
    return route.fulfill({
      json: {
        path: "README.md",
        sha: "a".repeat(40),
        size: Buffer.byteLength(source),
        encoding: "base64",
        content: Buffer.from(source).toString("base64"),
      },
    });
  });
  await start(page);
  await page.getByRole("button", { name: "README audit", exact: true }).click();
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByRole("button", { name: "Audit selected", exact: true })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Audit complete: 1 of 1",
  );
  await page.getByRole("button", { name: "Improve README" }).click();
  await page
    .getByRole("button", { name: "Open existing README unchanged" })
    .click();
  await expect(dialog(page)).toBeHidden();
  await expect(steps(page)).toHaveText([
    "README Health",
    "Drift check",
    "README Attention Queue",
  ]);
  await expect(panel(page)).toContainText(
    "Opened from the README audit in a new local draft. Nothing changed on GitHub.",
  );
  // The queue step reopens the audit's queue view, then returns to the step.
  await step(page, "README Attention Queue").click();
  await expect(dialog(page).locator("repository-audit")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(step(page, "README Attention Queue")).toBeFocused();
});

test("a blank start from Guided start offers ways to fill it", async ({
  page,
}) => {
  await page.goto("/");
  await dialog(page)
    .getByRole("button", { name: "Write my profile README", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", { name: "Start a blank profile README" })
    .click();
  await expect(dialog(page)).toBeHidden();
  await expect(steps(page)).toHaveText([
    "Add a section",
    "Start from a template",
    "Import existing README",
  ]);
  await expect(panel(page)).toContainText("Started a blank local draft.");
  await expect(toast(page)).toHaveText("Blank draft created.");
  await step(page, "Add a section").click();
  await expect(
    page.locator(".builder-content").getByRole("heading", {
      name: /Build your story/,
    }),
  ).toBeFocused();
  await step(page, "Import existing README").click();
  await expect(
    dialog(page).getByRole("heading", { name: "Import README" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(step(page, "Import existing README")).toBeFocused();
});

test("offline hides GitHub steps and says so; they return online", async ({
  page,
  context,
}) => {
  await start(page);
  await context.setOffline(true);
  await profileTemplate(page);
  await expect(steps(page)).toHaveText([
    "Edit your sections",
    "Preview README",
  ]);
  const note = panel(page).getByText("GitHub steps are hidden while offline.");
  await expect(note).toBeVisible();
  await context.setOffline(false);
  await expect(steps(page)).toHaveText([
    "Edit your sections",
    "Autofill from GitHub",
    "Preview README",
  ]);
  await expect(note).toBeHidden();
});

test("turning Next steps off in Settings means no panel, and the choice is saved", async ({
  page,
}) => {
  await start(page);
  await profileTemplate(page);
  await expect(panel(page)).toBeVisible();
  await page.locator(".workspace-tools [data-action=settings]").click();
  const toggle = dialog(page).getByLabel(
    "Show next steps after imports, audits and templates",
  );
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await importLocal(page);
  await expect(panel(page)).toBeHidden();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("readme-studio:v1")),
  );
  expect(stored.guide.nextSteps).toBe(false);
  // A workspace preference, never a setting copied into projects.
  expect(stored.settings).not.toHaveProperty("nextSteps");
  await page.reload();
  await page.locator(".workspace-tools [data-action=settings]").click();
  await expect(
    dialog(page).getByLabel(
      "Show next steps after imports, audits and templates",
    ),
  ).not.toBeChecked();
  await dialog(page)
    .getByLabel("Show next steps after imports, audits and templates")
    .check();
  await page.keyboard.press("Escape");
  await profileTemplate(page);
  await expect(panel(page)).toBeVisible();
});

test("at 375px the panel sits above the panes without horizontal scroll and Hide focuses the draft select", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await start(page);
  await profileTemplate(page);
  await expect(panel(page)).toBeVisible();
  const box = await panel(page).boundingBox();
  const nav = await page
    .getByRole("navigation", { name: "Workspace panes" })
    .boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(nav.y + 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const button of await panel(page).getByRole("button").all())
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  if (test.info().project.name === "chromium")
    await panel(page).screenshot({ path: "docs/screenshots/next-steps.png" });
  // On the Build pane the editor is not visible, so Hide focuses the draft
  // select instead.
  await panel(page).getByRole("button", { name: "Hide", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.getByLabel("Current draft")).toBeFocused();
});

test("opening a Studio project is an import Arrival from the project file", async ({
  page,
}) => {
  await start(page);
  await page.locator(".workspace-tools [data-action=save-project]").click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download Studio project", exact: true })
    .click();
  const raw = readFileSync(await (await event).path(), "utf8");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await page.locator(".workspace-tools [data-action=open-project]").click();
  await page.getByLabel("Studio project file").setInputFiles({
    name: "profile.readme-studio.json",
    mimeType: "application/json",
    buffer: Buffer.from(raw),
  });
  await page
    .getByRole("button", { name: "Open as new draft", exact: true })
    .click();
  await expect(dialog(page)).toBeHidden();
  await expect(panel(page)).toContainText(
    "Studio project opened as a new local draft. The project file is unchanged.",
  );
  await expect(steps(page)).toHaveText([
    "Preview README",
    "README Health",
    "Compatibility Lab",
  ]);
});

test("restoring a workspace backup forgets the Arrival", async ({ page }) => {
  await start(page);
  await profileTemplate(page);
  await expect(panel(page)).toBeVisible();
  await page.locator(".workspace-tools [data-action=settings]").click();
  const event = page.waitForEvent("download");
  await dialog(page)
    .getByRole("button", { name: "Download all drafts backup" })
    .click();
  const raw = readFileSync(await (await event).path(), "utf8");
  expect(raw).not.toMatch(/"arrival"/);
  await dialog(page).getByRole("button", { name: "Restore backup" }).click();
  await page.getByLabel("Workspace backup file").setInputFiles({
    name: "readme-studio-workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(raw),
  });
  await page.getByLabel("Restore mode").selectOption("replace");
  await page.locator("#restore-confirm").check();
  await page.locator("#apply-restore").click();
  await expect(dialog(page)).toBeHidden();
  await expect(panel(page)).toBeHidden();
});

test("a repository template offers Set repository target; once set, the step in its place takes focus", async ({
  page,
}) => {
  const requests = watchGitHub(page);
  await start(page);
  await page
    .getByRole("button", { name: "Repository README", exact: true })
    .click();
  await page.getByLabel("Repository name", { exact: true }).fill("widget");
  await page.getByRole("button", { name: "Create repository README" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(steps(page)).toHaveText([
    "Replace writing prompts",
    "README Health",
    "Set repository target",
  ]);
  await step(page, "Set repository target").click();
  await expect(dialog(page)).toHaveAccessibleName("Workspace documents");
  await dialog(page).getByLabel("Document group").selectOption("repository");
  await dialog(page).getByLabel("Document repository").fill("ada/widget");
  await dialog(page).getByLabel("Document branch").fill("main");
  await dialog(page)
    .getByRole("button", { name: "Save document settings" })
    .click();
  await expect(dialog(page)).toBeHidden();
  // The document now has a target, so Preview README replaces the step and
  // receives the focus the closing dialog returns.
  await expect(steps(page)).toHaveText([
    "Replace writing prompts",
    "README Health",
    "Preview README",
  ]);
  await expect(step(page, "Preview README")).toBeFocused();
  await step(page, "Replace writing prompts").click();
  await expect(
    page.locator(".builder-content").getByRole("heading", {
      name: /Your sections/,
    }),
  ).toBeFocused();
  expect(requests).toEqual([]);
});
