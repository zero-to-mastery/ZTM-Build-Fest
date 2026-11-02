import { test, expect } from "@playwright/test";
const current = (page) =>
  page.evaluate(() => document.querySelector("app-shell").store.draft.markdown);
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}
test("documents retain independent targets, undo and source through switching and reload at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Profile"),
  );
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  const panel = page.locator("workspace-documents");
  await panel.getByLabel("Document repository").fill("example/example");
  await panel.getByLabel("Document branch").fill("main");
  await panel.getByRole("button", { name: "Save document settings" }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await panel
    .getByRole("button", { name: "New document", exact: true })
    .click();
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Game"),
  );
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await panel.getByLabel("Document group").selectOption("repository");
  await panel.getByLabel("Document repository").fill("example/game");
  await panel.getByLabel("Document branch").fill("develop");
  await panel.getByLabel("Document README path").fill("docs/README.md");
  await panel.getByRole("button", { name: "Save document settings" }).click();
  const ids = await page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.id),
  );
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Game edited"),
  );
  await page.getByLabel("Current draft").selectOption(ids[0]);
  expect(await current(page)).toBe("# Profile");
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Profile edited"),
  );
  await page.getByLabel("Current draft").selectOption(ids[1]);
  await page.locator('[data-pane="markdown"]').click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await current(page)).toBe("# Game");
  await page.getByLabel("Current draft").selectOption(ids[0]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await current(page)).toBe("# Profile");
  await page.getByLabel("Current draft").selectOption(ids[1]);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await current(page)).toBe("# Game edited");
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await panel.getByLabel("Find document").fill("example/example");
  await panel.locator("[data-document]").focus();
  await page.keyboard.press("Enter");
  expect(await current(page)).toBe("# Profile");
  await expect(page.getByLabel("Current draft")).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  expect(await current(page)).toBe("# Profile");
  await page.getByLabel("Current draft").selectOption(ids[1]);
  expect(await current(page)).toBe("# Game edited");
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(panel.getByLabel("Document repository")).toHaveValue(
    "example/game",
  );
  await expect(panel.getByLabel("Document branch")).toHaveValue("develop");
  await expect(panel.getByLabel("Document README path")).toHaveValue(
    "docs/README.md",
  );
});

test("repository worksets save, export, restore and expose missing repositories without network writes", async ({
  page,
}) => {
  const remoteRequests = [];
  page.on("request", (request) => {
    if (/api\.github\.com|githubusercontent\.com/.test(request.url()))
      remoteRequests.push(request.url());
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  let documents = page.locator("workspace-documents");
  await documents.getByLabel("Document group").selectOption("repository");
  await documents.getByLabel("Document repository").fill("Ada/Tools");
  await documents.getByLabel("Document branch").fill("main");
  await documents
    .getByRole("button", { name: "Save document settings" })
    .click();

  await page
    .getByRole("button", { name: "Repository worksets", exact: true })
    .click();
  let worksets = page.locator("repository-worksets");
  await worksets.getByLabel("Workset name").fill("Release sweep");
  await worksets.getByRole("checkbox", { name: "ada/tools" }).check();
  await worksets.getByLabel("Additional repositories").fill("ada/missing");
  await worksets.getByRole("button", { name: "Save workset" }).click();
  await expect(worksets.getByLabel("Selected workset")).toBeFocused();
  await expect(worksets).toContainText("ada/tools");
  await expect(worksets).toContainText("ada/missing");
  await expect(worksets).toContainText("Missing locally");

  await worksets.getByText("Portable backup", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await worksets
    .getByRole("button", { name: "Download selected workset" })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const pack = JSON.parse(Buffer.concat(chunks).toString());
  expect(pack).toMatchObject({
    kind: "readme-studio-repository-worksets",
    version: 1,
    worksets: [
      {
        name: "Release sweep",
        repositories: ["ada/tools", "ada/missing"],
      },
    ],
  });
  expect(JSON.stringify(pack)).not.toMatch(/token|authorization|password/i);

  await page.reload();
  await page
    .getByRole("button", { name: "Repository worksets", exact: true })
    .click();
  worksets = page.locator("repository-worksets");
  await expect(worksets.getByLabel("Selected workset")).toHaveValue(
    await worksets.getByLabel("Selected workset").inputValue(),
  );
  await worksets
    .getByRole("button", { name: "Delete selected workset" })
    .click();
  await expect(
    worksets.getByRole("button", { name: "Keep workset" }),
  ).toBeFocused();
  await worksets.getByRole("button", { name: "Keep workset" }).click();
  await expect(
    worksets.getByRole("button", { name: "Delete selected workset" }),
  ).toBeFocused();
  await expect(worksets).toContainText("Release sweep");
  await worksets
    .getByRole("button", { name: "Delete selected workset" })
    .click();
  await worksets.getByRole("button", { name: "Delete Release sweep" }).click();
  await expect(worksets.getByLabel("Workset name")).toBeFocused();
  await expect(worksets).toContainText("No saved worksets");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.drafts.length,
    ),
  ).toBe(1);

  await worksets.getByText("Portable backup", { exact: true }).click();
  await worksets.getByLabel("Workset JSON").fill(JSON.stringify(pack));
  await worksets.getByRole("button", { name: "Review import" }).click();
  await expect(
    worksets.getByRole("heading", { name: "Import review" }),
  ).toBeFocused();
  await worksets.getByLabel("I reviewed these repository identifiers").check();
  await worksets
    .getByRole("button", { name: "Import reviewed worksets" })
    .click();
  await expect(worksets.getByLabel("Selected workset")).toBeFocused();
  await expect(worksets).toContainText("Release sweep");
  await expect(worksets).toContainText("Missing locally");
  await page.evaluate(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException("Full", "QuotaExceededError");
    };
  });
  await worksets.getByLabel("Workset name").fill("Must not appear");
  await worksets.getByLabel("Additional repositories").fill("ada/no-space");
  await worksets.getByRole("button", { name: "Save workset" }).click();
  await expect(worksets.locator("[data-status]")).toContainText(
    "Could not save workset",
  );
  expect(
    await page.evaluate(
      () =>
        document.querySelector("app-shell").data.repositoryWorksets.items
          .length,
    ),
  ).toBe(1);
  expect(remoteRequests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("audit opening reuses local work and Health analyzes only the selected document", async ({
  page,
}) => {
  await start(page);
  const openAudit = (source, builder = false) =>
    page.evaluate(
      ({ source, builder }) => {
        document.querySelector("app-shell").dispatchEvent(
          new CustomEvent("audit-improve", {
            detail: {
              repo: {
                full_name: "example/game",
                name: "game",
                default_branch: "main",
              },
              readme: { source, path: "README.md", sha: "a".repeat(40) },
              builder,
            },
          }),
        );
      },
      { source, builder },
    );
  await openAudit("# Imported");
  await page.evaluate(() =>
    document
      .querySelector("app-shell")
      .store.raw("# Local edits\n\n<script>alert(1)</script>"),
  );
  const ids = await page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((d) => d.id),
  );
  await page.getByLabel("Current draft").selectOption(ids[0]);
  await openAudit("# Changed remotely", true);
  expect(await current(page)).toContain("# Local edits");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.drafts.length,
    ),
  ).toBe(2);
  // The Next steps panel offers README Health too; use the workspace tool.
  await page
    .getByRole("navigation", { name: "Workspace tools" })
    .getByRole("button", { name: "README Health", exact: true })
    .click();
  await expect
    .poll(() =>
      page.locator("readme-health").evaluate((el) => el.analyzedSource),
    )
    .toBe("# Local edits\n\n<script>alert(1)</script>");
  await page.getByLabel("Current draft").selectOption(ids[0]);
  const profile = await current(page);
  await expect
    .poll(() =>
      page.locator("readme-health").evaluate((el) => el.analyzedSource),
    )
    .toBe(profile);
  await expect(page.locator("readme-health")).not.toContainText(
    "Analyzing README…",
  );
});

test("creates only the exact reviewed documentation suite and persists it locally", async ({
  page,
}) => {
  const githubRequests = [];
  page.on("request", (request) => {
    if (/github\.com|githubusercontent\.com/.test(request.url()))
      githubRequests.push(request.url());
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Existing exact source"),
  );
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page
    .locator("workspace-documents")
    .getByRole("button", { name: "Create documentation suite" })
    .click();
  const suite = page.locator("documentation-suite");
  await expect(suite.getByLabel("Suite project type")).toBeFocused();
  await suite.getByLabel("Suite project type").selectOption("api");
  await expect(suite.locator("[data-document]:checked")).toHaveCount(0);
  await suite
    .getByRole("checkbox", { name: /Project README — README\.md/ })
    .check();
  await suite
    .getByRole("checkbox", { name: /API reference — docs\/API\.md/ })
    .check();
  await suite.getByRole("button", { name: "Review exact suite" }).click();
  await expect(
    suite.getByRole("heading", { name: "Exact suite review" }),
  ).toBeFocused();
  await expect(suite.locator("[data-exact]")).toContainText("docs/API.md");

  await suite
    .getByLabel("API reference starting Markdown")
    .fill("# Reviewed API\n\nDescribe the verified endpoints.\n");
  await expect(suite.locator("[data-exact]")).toBeHidden();
  await suite.getByRole("button", { name: "Review exact suite" }).click();
  await suite
    .getByLabel(
      "I reviewed every selected path and its exact starting Markdown.",
    )
    .check();
  await suite
    .getByRole("button", { name: "Create reviewed local documents" })
    .click();

  const documents = await page.evaluate(() =>
    document.querySelector("app-shell").data.drafts.map((draft) => ({
      markdown: draft.markdown,
      suite: draft.metadata.documentationSuite || null,
      kind: draft.metadata.workspaceDocument?.kind,
    })),
  );
  expect(documents).toHaveLength(3);
  expect(documents[0].markdown).toBe("# Existing exact source");
  expect(documents.slice(1).map((item) => item.suite.path)).toEqual([
    "README.md",
    "docs/API.md",
  ]);
  expect(documents[2].markdown).toBe(
    "# Reviewed API\n\nDescribe the verified endpoints.\n",
  );
  expect(documents.slice(1).every((item) => item.kind === "local")).toBe(true);
  expect(githubRequests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.reload();
  await expect
    .poll(() => current(page))
    .toBe("# Reviewed API\n\nDescribe the verified endpoints.\n");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("readme-studio:v1")).drafts.map(
        (draft) => draft.metadata.documentationSuite?.path,
      ),
    ),
  ).toEqual([undefined, "README.md", "docs/API.md"]);
});

test("a stale review or failed batch write creates no suite document", async ({
  page,
}) => {
  await start(page);
  const openReviewedSuite = async () => {
    await page.getByRole("button", { name: "Documents", exact: true }).click();
    await page
      .locator("workspace-documents")
      .getByRole("button", { name: "Create documentation suite" })
      .click();
    const suite = page.locator("documentation-suite");
    await suite
      .getByRole("checkbox", { name: /Project README — README\.md/ })
      .check();
    await suite.getByRole("button", { name: "Review exact suite" }).click();
    await suite
      .getByLabel(
        "I reviewed every selected path and its exact starting Markdown.",
      )
      .check();
    return suite;
  };

  let suite = await openReviewedSuite();
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Changed after review"),
  );
  await suite
    .getByRole("button", { name: "Create reviewed local documents" })
    .click();
  await expect(suite.locator("[data-status]")).toContainText(
    "The workspace changed",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("app-shell").data.drafts.length,
      ),
    )
    .toBe(1);

  await page.getByRole("button", { name: "Close dialog" }).click();
  suite = await openReviewedSuite();
  await page.evaluate(() => {
    document.querySelector("app-shell").store.draft.name = "README.md";
  });
  await suite
    .getByRole("button", { name: "Create reviewed local documents" })
    .click();
  await expect(suite.locator("[data-status]")).toContainText(
    "The workspace changed",
  );
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.drafts.length,
    ),
  ).toBe(1);

  await page.getByRole("button", { name: "Close dialog" }).click();
  suite = await openReviewedSuite();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "readme-studio:v1")
        throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await suite
    .getByRole("button", { name: "Create reviewed local documents" })
    .click();
  await expect(suite.locator("[data-status]")).toContainText(
    "No documents were created",
  );
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.drafts.length,
    ),
  ).toBe(1);
});

test("checks workspace navigation before export without changing source", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => {
    if (/github\.com|githubusercontent\.com/.test(request.url()))
      requests.push(request.url());
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  const ids = await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    const first = app.store.draft;
    first.metadata.documentationSuite = {
      version: 1,
      projectType: "api",
      id: "readme",
      path: "README.md",
    };
    app.store.raw("# Home\n\n[API](docs/API.md#tokens)");
    const api = app.addDraft("docs/API.md", []);
    app.store.draft.metadata.documentationSuite = {
      version: 1,
      projectType: "api",
      id: "api",
      path: "docs/API.md",
    };
    app.store.raw("# API\n\n## Authentication");
    return [first.id, api.id];
  });
  await page.getByLabel("Current draft").selectOption(ids[0]);
  const source = "# Home\n\n[API](docs/API.md#tokens)";
  expect(await current(page)).toBe(source);

  await page.getByRole("button", { name: "Export README" }).click();
  const check = page.locator("document-link-check");
  await expect(
    check.getByRole("heading", { name: "Document link check" }),
  ).toBeFocused();
  await expect(check).toContainText("Missing anchor");
  expect(await current(page)).toBe(source);

  await page.evaluate(
    (id) => document.querySelector("app-shell").load(id),
    ids[1],
  );
  await check
    .getByRole("button", { name: "Export current source anyway" })
    .click();
  await expect(check.locator("[data-status]")).toContainText(
    "workspace changed",
  );

  await page.evaluate(([sourceId, targetId]) => {
    const app = document.querySelector("app-shell");
    const target = app.data.drafts.find((draft) => draft.id === targetId);
    target.markdown = "# API\n\n## Authentication\n\n## Tokens";
    app.load(sourceId);
  }, ids);

  await page.getByRole("button", { name: "Close dialog" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export README" }).click();
  await download;
  await expect(check).not.toBeVisible();

  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page
    .locator("workspace-documents")
    .getByRole("button", { name: "Check document links" })
    .click();
  await expect(page.locator("document-link-check")).toContainText(
    "No unresolved workspace document links",
  );
  expect(requests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate((id) => {
    const draft = document
      .querySelector("app-shell")
      .data.drafts.find((item) => item.id === id);
    draft.metadata.documentationSuite.path = "docs/REFERENCE.md";
  }, ids[1]);
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page
    .locator("workspace-documents")
    .getByRole("button", { name: "Check document links" })
    .click();
  await expect(page.locator("document-link-check")).toContainText(
    "Missing document",
  );
});
