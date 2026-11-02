import { test, expect } from "@playwright/test";
async function start(page, count = 3) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: {
        path: "README.md",
        sha: "a".repeat(40),
        encoding: "base64",
        content: Buffer.from("# Existing source\n").toString("base64"),
        size: 18,
      },
    }),
  );
  await page.evaluate(
    (count) =>
      document.querySelector("app-shell").dispatchEvent(
        new CustomEvent("batch-review-start", {
          detail: Array.from({ length: count }, (_, i) => ({
            full_name: `example/repo-${i}`,
            default_branch: "main",
          })),
        }),
      ),
    count,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector("app-shell").store.draft.metadata.repository,
      ),
    )
    .toBe("example/repo-0");
}
test("twelve-item review resumes locally and explicitly advances without publishing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page, 12);
  await expect(page.locator(".batch-bar")).toContainText("12 READMEs pending");
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Locally improved"),
  );
  await page
    .locator(".batch-bar")
    .getByRole("button", { name: "Mark reviewed & improve next" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector("app-shell").store.draft.metadata.repository,
      ),
    )
    .toBe("example/repo-1");
  await expect(page.locator(".batch-bar")).toContainText("11 READMEs pending");
  await page.reload();
  await expect(page.locator(".batch-bar")).toContainText("11 READMEs pending");
  await page.getByRole("button", { name: "Batch review", exact: true }).click();
  const panel = page.locator("batch-review");
  await panel
    .getByRole("button", { name: "Open example/repo-0", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe("# Locally improved");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.reviewBatch.items[0].state,
    ),
  ).toBe("reviewed");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("common contributing section opens selected sources and requires every resulting diff before insertion", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Batch review", exact: true }).click();
  const batch = page.locator("batch-review");
  await batch.getByLabel("Include example/repo-0", { exact: true }).check();
  await batch.getByLabel("Include example/repo-2", { exact: true }).check();
  await batch
    .getByRole("button", {
      name: "Prepare common section for selected repositories",
    })
    .click();
  const shared = page.locator("shared-components");
  await expect(shared.getByLabel("Shared component name")).toHaveValue(
    "Contributing footer",
  );
  await shared
    .getByLabel("Shared Markdown", { exact: true })
    .fill("## Contributing\nPlease open an issue before proposing changes.");
  await shared.getByRole("button", { name: "Save shared definition" }).click();
  expect(
    await page.evaluate(() =>
      document
        .querySelector("app-shell")
        .data.drafts.some((d) => d.markdown.includes("Please open an issue")),
    ),
  ).toBe(false);
  await shared
    .getByRole("button", { name: "Preview insertion", exact: true })
    .click();
  await expect(shared.locator("[data-entry]")).toHaveCount(2);
  await expect(
    shared.getByRole("button", { name: "Apply reviewed changes" }),
  ).toBeDisabled();
  await shared
    .getByRole("checkbox", { name: "Update repo-2 README" })
    .uncheck();
  await expect(shared.locator("[data-impact]")).toContainText(
    "Affected: 2 READMEs · Selected: 1",
  );
  const excludedSource =
    "# Excluded local edit\r\n\r\nKeep this byte-exact.\r\n";
  await page.evaluate(async (source) => {
    const app = document.querySelector("app-shell"),
      draft = app.data.drafts.find(
        (item) => item.metadata.repository === "example/repo-2",
      ),
      { createBlock } = await import("/src/markdown/serialize.js");
    draft.markdown = source;
    draft.blocks = [createBlock("custom", { markdown: source })];
    draft.updated = Date.now();
    app.save();
  }, excludedSource);
  await shared.getByLabel("I reviewed all selected document diffs").check();
  await shared.getByRole("button", { name: "Apply reviewed changes" }).click();
  const changed = await page.evaluate(() =>
    document
      .querySelector("app-shell")
      .data.drafts.filter((d) => d.markdown.includes("Please open an issue"))
      .map((d) => d.metadata.repository),
  );
  expect(changed).toEqual(["example/repo-0"]);
  const excluded = () =>
    page.evaluate(
      () =>
        document
          .querySelector("app-shell")
          .data.drafts.find(
            (draft) => draft.metadata.repository === "example/repo-2",
          ).markdown,
    );
  expect(await excluded()).toBe(excludedSource);
  await page.reload();
  await expect.poll(excluded).toBe(excludedSource);
  expect(
    await page.evaluate(() =>
      document
        .querySelector("app-shell")
        .data.reviewBatch.items.every((item) => item.state === "pending"),
    ),
  ).toBe(true);
});

test("failed next fetch retains progress and skips only the failed current item", async ({
  page,
}) => {
  await start(page);
  await page.route(
    "https://api.github.com/repos/example/repo-1/readme*",
    (route) => route.fulfill({ status: 503, json: {} }),
  );
  await page
    .locator(".batch-bar")
    .getByRole("button", { name: "Mark reviewed & improve next" })
    .click();
  const panel = page.locator("batch-review");
  await expect(panel.locator("[data-status]")).toContainText(
    "Previously opened sources remain available",
  );
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.reviewBatch.current,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.metadata.repository,
    ),
  ).toBe("example/repo-0");
  await panel
    .getByRole("button", { name: "Skip current & improve next" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector("app-shell").store.draft.metadata.repository,
      ),
    )
    .toBe("example/repo-2");
  expect(
    await page.evaluate(() =>
      document
        .querySelector("app-shell")
        .data.reviewBatch.items.map((item) => item.state),
    ),
  ).toEqual(["reviewed", "skipped", "pending"]);
});

test("recovered batches detect local conflicts without fetching or replaying a publish", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    app.store.raw("# Changed after the batch checkpoint\r\n");
    app.save();
  });
  await page.reload();
  let githubRequests = 0;
  page.on("request", (request) => {
    if (request.url().startsWith("https://api.github.com/")) githubRequests++;
  });
  await page.route("https://api.github.com/**", (route) => route.abort());
  await page.getByRole("button", { name: "Batch review", exact: true }).click();
  const panel = page.locator("batch-review");
  await expect(panel).toContainText("Recovery review");
  await expect(panel).toContainText("Changed since last opened");
  expect(githubRequests).toBe(0);
  await panel
    .getByRole("button", { name: "Mark reviewed & improve next" })
    .click();
  await expect(panel.locator("[data-status]")).toContainText(
    "Reopen the current batch document",
  );
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").data.reviewBatch.items[0].state,
    ),
  ).toBe("pending");
  expect(githubRequests).toBe(0);
  await panel
    .getByRole("button", { name: "Open example/repo-0", exact: true })
    .click();
  expect(githubRequests).toBe(0);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe("# Changed after the batch checkpoint\r\n");
});
