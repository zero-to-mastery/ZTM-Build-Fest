import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const guide = (page) =>
  page.evaluate(() => document.querySelector("app-shell").data.guide);
const stored = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("readme-studio:v1") || "null"),
  );
const dialog = (page) => page.getByRole("dialog");
const goal = (page, name) =>
  dialog(page).getByRole("button", { name, exact: true });
// Guided start itself never contacts GitHub; record anything that tries.
function watchGitHub(page) {
  const requests = [];
  page.on("request", (r) => {
    if (/github\.com|githubusercontent\.com/.test(r.url()))
      requests.push(r.url());
  });
  return requests;
}

test("first run asks for a Goal, keeps every Start path and states where work is kept", async ({
  page,
}) => {
  const requests = watchGitHub(page);
  await page.goto("/");
  await expect(dialog(page)).toHaveAccessibleName(
    "What do you want to do first?",
  );
  await expect(
    dialog(page).getByRole("heading", {
      level: 1,
      name: "What do you want to do first?",
    }),
  ).toBeVisible();
  const goals = dialog(page).getByRole("list", { name: "Goals" });
  await expect(goals.getByRole("button")).toHaveCount(3);
  await expect(goal(page, "Write my profile README")).toBeFocused();
  await expect(
    goal(page, "Write my profile README"),
  ).toHaveAccessibleDescription(
    "Introduce yourself on your GitHub profile page.",
  );
  await expect(
    goal(page, "Write a repository README"),
  ).toHaveAccessibleDescription(/install it and how to use it/);
  await expect(
    goal(page, "Audit my repository READMEs"),
  ).toHaveAccessibleDescription(/Needs a GitHub connection/);
  // Earlier Start paths keep their existing names.
  const paths = dialog(page).getByRole("region", {
    name: "Other ways to start",
  });
  for (const name of [
    "Start from a template",
    "Autofill from GitHub",
    "Import GitHub README",
    "Open Studio project",
    "Start blank",
    "Explore the sample profile",
  ])
    await expect(paths.getByRole("button", { name })).toBeVisible();
  const locality = dialog(page).getByRole("region", {
    name: "Where your work is kept",
  });
  await expect(locality).toContainText("saved only in this browser");
  await expect(locality).toContainText("not encrypted");
  await expect(locality).toContainText("download a backup");
  // Every GitHub-contacting flow in docs/privacy.md is named, not just three.
  await expect(locality).toContainText(
    "GitHub is contacted only when you choose a GitHub action",
  );
  for (const flow of [
    "import",
    "autofill",
    "audit",
    "repository lookup",
    "refresh and link checks",
    "evidence and drift checks",
    "publishing",
  ])
    await expect(locality).toContainText(flow);
  await expect(locality).not.toContainText("import, autofill or audit");
  // Every way Markdown or a request leaves the browser is stated, not only
  // GitHub: link checks reach third-party sites and the opt-in Writing
  // Assistant sends reviewed text to its provider.
  await expect(locality).not.toContainText("not uploaded");
  await expect(locality).toContainText(
    "Link checks also contact the sites your links point to.",
  );
  await expect(locality).toContainText(
    "your Markdown is sent only when you publish it, or when you review and send text to the optional Writing assistant's provider",
  );
  await expect(locality).toContainText(
    "Nothing is published without its own review.",
  );
  await expect(
    locality.getByRole("link", { name: "Privacy details" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/mnichols08/readme-studio/blob/main/docs/privacy.md",
  );
  await expect(locality).not.toContainText("temporary workspace");
  // Nothing is chosen until the author picks a Goal.
  expect((await guide(page)).goal).toBeNull();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  expect(requests).toEqual([]);
});

test("keyboard Goal choice moves to its step, Back restores focus and the Goal is saved", async ({
  page,
}) => {
  const requests = watchGitHub(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await expect(goal(page, "Write my profile README")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(goal(page, "Write a repository README")).toBeFocused();
  await page.keyboard.press("Enter");
  const heading = dialog(page).getByRole("heading", {
    level: 1,
    name: "Start a repository README",
  });
  await expect(heading).toBeFocused();
  await expect(dialog(page)).toHaveAccessibleName("Start a repository README");
  for (const name of [
    "Build a repository README",
    "Import existing README",
    "Start a blank repository README",
  ])
    await expect(
      dialog(page).getByRole("button", { name, exact: true }),
    ).toBeVisible();
  expect(await guide(page)).toEqual({
    version: 1,
    goal: "repository",
    nextSteps: true,
  });
  expect((await stored(page)).guide.goal).toBe("repository");
  await dialog(page).getByRole("button", { name: "Back" }).click();
  await expect(goal(page, "Write a repository README")).toBeFocused();
  await expect(goal(page, "Write a repository README")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.keyboard.press("Shift+Tab");
  await expect(goal(page, "Write my profile README")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog(page).getByRole("heading", { name: "Start your profile README" }),
  ).toBeFocused();
  expect((await stored(page)).guide.goal).toBe("profile");
  // A Goal never changes a document.
  const before = await page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.markdown),
  );
  expect(before).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  expect(
    await page.evaluate(() =>
      document.querySelector("app-shell").data.drafts.map((d) => d.markdown),
    ),
  ).toEqual(before);
  // A saved workspace never reopens Guided start by itself.
  await page.reload();
  await expect(page.getByLabel("Current draft")).toBeVisible();
  await expect(dialog(page)).toBeHidden();
  // Reopening marks the saved Goal and focuses it.
  await page.getByRole("button", { name: "Search workspace" }).click();
  await page.getByLabel("Search commands and content").fill("guided start");
  await page.keyboard.press("Enter");
  await expect(goal(page, "Write my profile README")).toBeFocused();
  await expect(goal(page, "Write my profile README")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(
    goal(page, "Write my profile README"),
  ).toHaveAccessibleDescription(/Your current goal/);
  await expect(goal(page, "Audit my repository READMEs")).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Search workspace" }),
  ).toBeFocused();
  expect(requests).toEqual([]);
});

test("each Goal step opens the existing flow or a blank document of its kind", async ({
  page,
}) => {
  await page.route("https://api.github.com/**", (r) => r.abort());
  await page.goto("/");
  await goal(page, "Write my profile README").click();
  await dialog(page)
    .getByRole("button", { name: "Start a blank profile README" })
    .click();
  await expect(dialog(page)).toBeHidden();
  let active = await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    return { draft: app.store.draft, count: app.data.drafts.length };
  });
  expect(active.count).toBe(2);
  expect(active.draft.name).toBe("Profile README");
  expect(active.draft.markdown).toBe("");
  expect(active.draft.metadata.workspaceDocument).toEqual({
    version: 1,
    kind: "profile",
    target: null,
  });
  await expect(
    page.getByLabel("Current draft").locator("optgroup[label=Profile] option"),
  ).toHaveCount(2);

  const reopen = async (name) => {
    if (await dialog(page).isVisible()) {
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeHidden();
    }
    await page.locator('.workspace-tools [data-action="guided-start"]').click();
    await goal(page, name).click();
  };
  await reopen("Write a repository README");
  await dialog(page)
    .getByRole("button", { name: "Start a blank repository README" })
    .click();
  active = await page.evaluate(
    () => document.querySelector("app-shell").store.draft,
  );
  expect(active.name).toBe("Repository README");
  expect(active.metadata.workspaceDocument).toEqual({
    version: 1,
    kind: "repository",
    target: null,
  });
  await expect(
    page
      .getByLabel("Current draft")
      .locator("optgroup[label=Repositories] option"),
  ).toHaveCount(1);

  await reopen("Write a repository README");
  await dialog(page)
    .getByRole("button", { name: "Import existing README" })
    .click();
  await expect(
    dialog(page).getByRole("heading", { name: "Import README" }),
  ).toBeVisible();
  await reopen("Write a repository README");
  await dialog(page)
    .getByRole("button", { name: "Build a repository README" })
    .click();
  await expect(
    dialog(page).getByRole("heading", { name: "Repository README builder" }),
  ).toBeVisible();
  await reopen("Write my profile README");
  await dialog(page)
    .getByRole("button", { name: "Autofill from GitHub" })
    .click();
  await expect(page.getByLabel("GitHub username or profile URL")).toBeFocused();
  await reopen("Write my profile README");
  await dialog(page)
    .getByRole("button", { name: "Start from a profile template" })
    .click();
  await expect(
    dialog(page).getByRole("heading", { name: "Choose your structure." }),
  ).toBeVisible();
  await reopen("Audit my repository READMEs");
  await expect(
    dialog(page).getByRole("heading", {
      name: "Audit your repository READMEs",
    }),
  ).toBeFocused();
  await expect(
    dialog(page).getByRole("button", { name: "Import existing README" }),
  ).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Open README audit" }).click();
  await expect(page.getByLabel("GitHub username")).toBeFocused();
  // Opening tools from Guided start changed no document.
  expect(
    await page.evaluate(() =>
      document.querySelector("app-shell").data.drafts.map((d) => d.markdown),
    ),
  ).toEqual([expect.stringContaining("#"), "", ""]);
  expect((await guide(page)).goal).toBe("audit");
});

test("Start from a profile template focuses a profile template, not the repository builder", async ({
  page,
}) => {
  await page.goto("/");
  await expect(goal(page, "Write my profile README")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog(page).getByRole("heading", { name: "Start your profile README" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Start from a profile template" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog(page).getByRole("heading", { name: "Choose your structure." }),
  ).toBeVisible();
  const first = dialog(page).locator("[data-template]").first();
  await expect(first).toBeFocused();
  // Focus stays there after the dialog's own focus fallback has run.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r())),
  );
  await expect(first).toBeFocused();
  await expect(
    dialog(page).getByRole("button", { name: "Build a repository README" }),
  ).not.toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeHidden();
  expect((await drafts(page)).map((d) => d.name)).toEqual([
    "My developer profile",
    "Minimal",
  ]);
});

test("offline, the audit stays focusable but unavailable and offers local ways to begin", async ({
  page,
  context,
}) => {
  const requests = watchGitHub(page);
  await page.goto("/");
  await context.setOffline(true);
  await goal(page, "Audit my repository READMEs").click();
  const audit = dialog(page).getByRole("button", {
    name: "Open README audit",
  });
  await expect(audit).toHaveAttribute("aria-disabled", "true");
  await expect(audit).toHaveAccessibleDescription(/You are offline/);
  await audit.focus();
  await expect(audit).toBeFocused();
  await page.keyboard.press("Enter");
  // Playwright refuses to click an aria-disabled button; a pointer still can.
  await audit.click({ force: true });
  await expect(
    dialog(page).getByRole("heading", {
      name: "Audit your repository READMEs",
    }),
  ).toBeVisible();
  await expect(page.locator("repository-audit")).toHaveCount(0);
  // Back online while the step is open: the button is still announced as
  // unavailable, so activating it must still do nothing.
  await context.setOffline(false);
  await expect(audit).toHaveAttribute("aria-disabled", "true");
  await audit.focus();
  await page.keyboard.press("Enter");
  await audit.click({ force: true });
  await expect(page.locator("repository-audit")).toHaveCount(0);
  await expect(
    dialog(page).getByRole("heading", {
      name: "Audit your repository READMEs",
    }),
  ).toBeVisible();
  await context.setOffline(true);
  await audit.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Import existing README" }),
  ).toBeFocused();
  await dialog(page)
    .getByRole("button", { name: "Start a blank repository README" })
    .click();
  await expect(dialog(page)).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        document.querySelector("app-shell").store.draft.metadata
          .workspaceDocument.kind,
    ),
  ).toBe("repository");
  await context.setOffline(false);
  await page.locator('.workspace-tools [data-action="guided-start"]').click();
  await goal(page, "Audit my repository READMEs").click();
  await expect(
    dialog(page).getByRole("button", { name: "Open README audit" }),
  ).not.toHaveAttribute("aria-disabled");
  expect(requests).toEqual([]);
});

test("blocked storage says the workspace is temporary and the Goal stays in memory", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = function () {
      throw new DOMException("Denied", "SecurityError");
    };
  });
  await page.goto("/");
  const locality = dialog(page).getByRole("region", {
    name: "Where your work is kept",
  });
  await expect(locality).toContainText("temporary workspace");
  await expect(locality).toContainText("Browser storage is unavailable");
  await expect(locality).not.toContainText("could not be read");
  await expect(locality).not.toContainText("saved only in this browser");
  await goal(page, "Write my profile README").click();
  expect((await guide(page)).goal).toBe("profile");
  await page.keyboard.press("Escape");
  await expect(page.locator(".save-status")).toHaveText(
    "Temporary workspace · export to keep work",
  );
});

test("an unreadable saved workspace skips the automatic Guided start and points to recovery data", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("readme-studio:v1", "{not json at all");
      sessionStorage.setItem("seeded", "1");
    }
  });
  await page.goto("/");
  // The recovery notice is not hidden behind a modal first run.
  await expect(page.locator(".recovery-notice")).toContainText(
    "Saved workspace could not be read",
  );
  await expect(dialog(page)).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Download original recovery data" }),
  ).toBeVisible();
  // Opened by hand, the Locality statement names the real problem.
  await page.locator('.workspace-tools [data-action="guided-start"]').click();
  const locality = dialog(page).getByRole("region", {
    name: "Where your work is kept",
  });
  await expect(locality).toContainText("saved workspace could not be read");
  await expect(locality).toContainText("original is left untouched");
  await expect(locality).toContainText("Download original recovery data");
  await expect(locality).not.toContainText("Browser storage is unavailable");
  await expect(locality).not.toContainText("saved only in this browser");
  await goal(page, "Write my profile README").click();
  expect((await guide(page)).goal).toBe("profile");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  // Nothing was written over the original.
  expect(
    await page.evaluate(() => localStorage.getItem("readme-studio:v1")),
  ).toBe("{not json at all");
});

test("the Goal is in all-drafts backups but never in README, draft JSON or project exports", async ({
  page,
}) => {
  await page.goto("/");
  await goal(page, "Write a repository README").click();
  await page.keyboard.press("Escape");
  const text = async (trigger) => {
    const download = page.waitForEvent("download");
    await trigger();
    return readFileSync(await (await download).path(), "utf8");
  };
  await page.getByRole("button", { name: "Manage drafts" }).click();
  const backup = JSON.parse(
    await text(() =>
      dialog(page)
        .getByRole("button", { name: "Download all drafts backup" })
        .click(),
    ),
  );
  await page.keyboard.press("Escape");
  expect(backup.guide).toEqual({
    version: 1,
    goal: "repository",
    nextSteps: true,
  });
  const readme = await text(() =>
    page.locator('.workspace-tools [data-action="download"]').click(),
  );
  expect(readme).toBe(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  );
  expect(readme).not.toContain('"guide"');
  await page.getByRole("button", { name: "Manage drafts" }).click();
  const draft = await text(() =>
    page.getByRole("button", { name: "Download draft backup" }).click(),
  );
  expect(draft).not.toContain('"guide"');
  await page.keyboard.press("Escape");
  await page.locator('.workspace-tools [data-action="save-project"]').click();
  await dialog(page)
    .getByLabel("Include reusable libraries", { exact: false })
    .check();
  const project = await text(() =>
    dialog(page)
      .getByRole("button", { name: "Download Studio project" })
      .click(),
  );
  expect(JSON.parse(project).schemaVersion).toBe(1);
  expect(project).not.toContain('"guide"');
  expect(project).not.toContain('"nextSteps"');
});

const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });
const drafts = (page) =>
  page.evaluate(() =>
    document
      .querySelector("app-shell")
      .data.drafts.map((d) => ({ name: d.name, markdown: d.markdown })),
  );
// Loads a synthetic local README in the open import dialog and imports it as a
// new draft, checking the preview leaves the current draft alone.
async function importLocal(page, markdown) {
  const before = await drafts(page);
  await dialog(page)
    .getByRole("button", { name: "Local file", exact: true })
    .click();
  await expect(
    dialog(page).getByLabel("Import mode", { exact: true }),
  ).toHaveValue("new");
  await page.locator("#file-import").setInputFiles({
    name: "README.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
  await expect(
    dialog(page).getByRole("heading", { name: "README found", exact: true }),
  ).toBeVisible();
  expect(await drafts(page)).toEqual(before);
  await dialog(page)
    .getByRole("button", { name: "Import as new draft" })
    .click();
  await expect(dialog(page)).toBeHidden();
  await expect(editor(page)).toHaveValue(markdown);
  const after = await drafts(page);
  expect(after).toHaveLength(before.length + 1);
  expect(after.slice(0, before.length)).toEqual(before);
}

test("import journey: a local README imported from Guided start becomes a new draft", async ({
  page,
}) => {
  const requests = watchGitHub(page);
  await page.goto("/");
  await goal(page, "Write a repository README").click();
  await dialog(page)
    .getByRole("button", { name: "Import existing README", exact: true })
    .click();
  await expect(
    dialog(page).getByRole("heading", { name: "Import README" }),
  ).toBeVisible();
  await importLocal(page, "# Widget\n\nA tool.\n\n## Install\n\nnpm i\n");
  // The earlier Start path reaches the same import under its existing name.
  await page.locator('.workspace-tools [data-action="guided-start"]').click();
  await dialog(page)
    .getByRole("region", { name: "Other ways to start" })
    .getByRole("button", { name: "Import GitHub README" })
    .click();
  await importLocal(page, "# Second\n\nAnother local README.\n");
  expect(await drafts(page)).toHaveLength(3);
  expect(requests).toEqual([]);
});

test("offline, the audit's Import existing README fallback imports a local file", async ({
  page,
  context,
  browserName,
}) => {
  const requests = watchGitHub(page);
  await page.goto("/");
  await context.setOffline(true);
  await goal(page, "Audit my repository READMEs").click();
  await dialog(page)
    .getByRole("button", { name: "Import existing README", exact: true })
    .click();
  await expect(
    dialog(page).getByRole("heading", { name: "Import README" }),
  ).toBeVisible();
  // Playwright's WebKit offline emulation also fails local File reads ("The
  // I/O read operation failed."), through this path and plain Create → Import
  // alike (see docs/offline.md on WebKit emulation). The offline fallback is
  // reached offline above; on WebKit only, the local read runs back online.
  // Chromium and Firefox keep the whole import offline.
  if (browserName === "webkit") await context.setOffline(false);
  await importLocal(page, "# Offline\n\nImported without a connection.\n");
  expect((await guide(page)).goal).toBe("audit");
  expect(requests).toEqual([]);
});

test("Explore the sample profile closes on first run and adds a copy when reopened", async ({
  page,
}) => {
  await page.goto("/");
  await dialog(page)
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await expect(dialog(page)).toBeHidden();
  const first = await drafts(page);
  expect(first.map((d) => d.name)).toEqual(["My developer profile"]);
  await page.locator('.workspace-tools [data-action="guided-start"]').click();
  await dialog(page)
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await expect(dialog(page)).toBeHidden();
  const after = await drafts(page);
  expect(after.map((d) => d.name)).toEqual([
    "My developer profile",
    "My developer profile (2)",
  ]);
  expect(after[1].markdown).toBe(first[0].markdown);
  expect(
    await page.evaluate(
      () =>
        document.querySelector("app-shell").store.draft.metadata
          .workspaceDocument,
    ),
  ).toEqual({ version: 1, kind: "profile", target: null });
  await expect(
    page.getByLabel("Current draft").locator("optgroup[label=Profile] option"),
  ).toHaveCount(2);
});
