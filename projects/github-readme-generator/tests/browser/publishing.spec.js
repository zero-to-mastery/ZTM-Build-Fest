import { test, expect } from "@playwright/test";
import { evaluatePreflight } from "../../src/publishing/preflight.js";
import { gitBlobSha } from "../../src/publishing/change-set.js";
const sha = "a".repeat(40),
  next = "b".repeat(40),
  // The Publish approval names the file count, target and change set.
  approval = /I reviewed \d+ file writes? to/;
async function setup(
  page,
  {
    exists = true,
    fail = false,
    stale = false,
    writable = true,
    assets = false,
    failAsset = false,
    staleAsset = false,
    noCrypto = false,
    access = {},
    preflightOffline = false,
    load = true,
    // When set, the README read returns remote.content with its real Git
    // blob SHA; tests may change remote.content between loads.
    remote = null,
    // Simulate a commit request whose response is lost. "written" updates
    // the mocked remote first; "not-written" drops the request outcome only.
    ambiguousOutcome = null,
    pullRequests = [],
    pullRequestAmbiguous = false,
    pullRequestStatus = null,
    pullRequestDuplicate = null,
    pullRequestsDelay = 0,
    pullRequestStatusDelay = 0,
  } = {},
) {
  const writes = [],
    prWrites = [],
    ops = [];
  let connected = false,
    ambiguousUsed = false,
    reads = 0,
    darkReads = 0;
  if (noCrypto)
    await page.addInitScript(() =>
      Object.defineProperty(Crypto.prototype, "subtle", {
        get: () => undefined,
      }),
    );
  await page.route("**/api/publishing/*", async (route) => {
    const op = route.request().url().split("/").at(-1);
    ops.push(op);
    if (op === "preflight" && preflightOffline) return route.abort("failed");
    let data = {};
    let status = 200;
    if (op === "session")
      data = {
        configured: true,
        connected,
        csrf: "test",
        identity: {
          login: "octocat",
          name: "Octo",
          avatar: "https://avatars.githubusercontent.com/u/1",
        },
      };
    if (op === "connect") data = { code: "ABCD-EFGH" };
    if (op === "poll") {
      connected = true;
      data = { connected: true };
    }
    if (op === "disconnect") connected = false;
    if (op === "repositories")
      data = {
        repositories: [
          {
            repository: "octocat/octocat",
            branch: "main",
            visibility: "public",
            writable,
            pullRequestsWritable: true,
          },
        ],
      };
    // The mocked server judges facts with the real evaluator; `access`
    // overrides individual facts (and may be changed mid-test).
    if (op === "preflight")
      data = evaluatePreflight(
        {
          configured: true,
          connected: true,
          allowWorkflows: false,
          target: route.request().postDataJSON(),
          installation: {
            permissions: {
              contents: writable ? "write" : "read",
              workflows: "read",
            },
          },
          repository: { push: true, archived: false, defaultBranch: "main" },
          branch: { protected: false, commitSha: sha },
          rules: [],
          ...access,
        },
        { kind: route.request().postDataJSON().kind },
      );
    if (op === "branch")
      data = {
        ...route.request().postDataJSON(),
        branch: route.request().postDataJSON().newBranch,
      };
    if (op === "pull-requests") {
      if (pullRequestsDelay)
        await new Promise((resolve) => setTimeout(resolve, pullRequestsDelay));
      data = { pullRequests };
    }
    if (op === "pull-request-check") {
      const input = route.request().postDataJSON(),
        selected = pullRequests.find((pull) => pull.number === input.number);
      data = { ...selected, mergeable: true };
    }
    if (op === "pull-request-status") {
      if (pullRequestStatusDelay)
        await new Promise((resolve) =>
          setTimeout(resolve, pullRequestStatusDelay),
        );
      data = { found: pullRequestStatus };
    }
    if (op === "pull-request") {
      const input = route.request().postDataJSON();
      prWrites.push(input);
      if (pullRequestAmbiguous) return route.abort("failed");
      if (pullRequestDuplicate) {
        status = 409;
        data = {
          error:
            "An open pull request already exists. No duplicate was created.",
          pullRequest: pullRequestDuplicate,
        };
      } else
        data = {
          number: 42,
          title: input.title,
          url: "https://github.com/octocat/octocat/pull/42",
          draft: true,
          head: input.head,
          headSha: input.headSha,
          base: input.base,
          baseSha: input.baseSha,
          mergeable: null,
        };
    }
    if (op === "read") {
      reads++;
      data = {
        ...route.request().postDataJSON(),
        content: stale && reads > 1 ? "# Remote change" : exists ? "# Old" : "",
        sha: stale && reads > 1 ? next : exists ? sha : null,
        commitSha: sha,
      };
      if (remote)
        Object.assign(data, {
          content: remote.content,
          sha: await gitBlobSha(remote.content),
        });
    }
    if (op === "read" && route.request().postDataJSON().kind === "asset") {
      // With staleAsset, the dark banner appears on GitHub after the review.
      const changed =
        staleAsset &&
        route.request().postDataJSON().path.endsWith("-dark.svg") &&
        ++darkReads > 1;
      data = {
        ...route.request().postDataJSON(),
        content: changed ? "<svg>remote</svg>" : "",
        sha: changed ? next : null,
        commitSha: sha,
      };
    }
    if (op === "commit") {
      const write = route.request().postDataJSON();
      writes.push(write);
      if (ambiguousOutcome && !ambiguousUsed) {
        ambiguousUsed = true;
        if (ambiguousOutcome === "written" && remote)
          remote.content = write.content;
        return route.abort("failed");
      }
      if (
        fail ||
        (failAsset && route.request().postDataJSON().path.endsWith("-dark.svg"))
      ) {
        status = 403;
        data =
          fail === "preflight"
            ? {
                error:
                  "Your GitHub account cannot push to octocat/octocat. Ask an owner for write access.",
                preflight: "user-push",
              }
            : {
                error:
                  "GitHub denied access: branch protection. Download remains available.",
              };
      } else
        data = {
          ...route.request().postDataJSON(),
          sha: next,
          commitSha: next,
        };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  if (await page.locator("[data-pane=markdown]").isVisible())
    await page.locator("[data-pane=markdown]").click();
  await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .fill("# New 🦀");
  if (assets)
    await page.locator("app-shell").evaluate(async (app) => {
      const { newBanner } = await import("/src/banners/banner-model.js");
      const { bannerMarkup } = await import("/src/banners/export.js");
      const { createBlock } = await import("/src/markdown/serialize.js");
      const banner = newBanner(),
        source = bannerMarkup(banner),
        block = createBlock("custom", { markdown: source });
      app.store.blocks([...app.store.draft.blocks, block], {
        ...app.store.draft.metadata,
        bannerSettings: banner,
        bannerReference: { blockId: block.id, source },
      });
    });
  await page
    .getByRole("button", { name: "Publish to GitHub", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await d.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(d).toContainText("ABCD-EFGH");
  await d.getByRole("button", { name: "Check authorization" }).click();
  await d.getByLabel("Target repository").selectOption("octocat/octocat");
  if (load) await d.getByRole("button", { name: "Load remote README" }).click();
  return { d, writes, prWrites, ops, access };
}
for (const exists of [true, false])
  test(`explicit review before ${exists ? "updating" : "creating"} README; source stays unchanged`, async ({
    page,
  }) => {
    const { d, writes } = await setup(page, { exists });
    expect(writes).toHaveLength(0);
    await expect(d.getByLabel("Prepared Markdown")).toHaveValue("# New 🦀");
    // Publish stays disabled until this exact change set is approved.
    await expect(
      d.getByRole("button", { name: "Confirm and publish README" }),
    ).toBeDisabled();
    await expect(d.locator('[data-entry="README.md"]')).toContainText(
      exists ? "update" : "create (new file)",
    );
    await d.getByLabel("Commit message").fill("Personal update");
    await expect(d.getByLabel(approval)).toBeEnabled();
    await d.getByLabel(approval).check();
    await d.getByRole("button", { name: "Confirm and publish README" }).click();
    await expect(d.locator("[data-status]")).toContainText("published");
    expect(writes).toHaveLength(1);
    expect(writes[0].sha).toBe(exists ? sha : null);
    expect(writes[0].message).toBe("Personal update");
    expect(writes[0].resultSha).toBe(await gitBlobSha(writes[0].content));
    // The change set ran: it cannot be approved again on this baseline.
    const box = d.locator("[data-confirm]");
    await expect(box).toBeDisabled();
    await expect(box).toHaveAccessibleName(
      /A publish attempt already ran on this remote baseline/,
    );
    await expect(
      d.getByRole("button", { name: "Confirm and publish README" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("textbox", { name: "Markdown editor", exact: true }),
    ).toHaveValue("# New 🦀");
    await d.getByRole("button", { name: "Disconnect GitHub" }).click();
    await expect(
      d.getByRole("button", { name: "Connect GitHub", exact: true }),
    ).toBeEnabled();
  });
test("failed publish preserves review and download at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const { d } = await setup(page, { fail: true });
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("branch protection");
  // GitHub's refusal routes the author to the new-branch review.
  await expect(d.locator("[data-new-branch-route]")).toHaveAttribute(
    "open",
    "",
  );
  await expect(d.getByLabel("Prepared Markdown")).toHaveValue("# New 🦀");
  const download = page.waitForEvent("download");
  await d.getByRole("button", { name: "Download README fallback" }).click();
  expect((await download).suggestedFilename()).toBe("README.md");
  expect(await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 2)).toBe(
    true,
  );
});
test("a lost successful response is reconciled as written without a duplicate write", async ({
  page,
}) => {
  const remote = { content: "# Old" },
    { d, writes } = await setup(page, {
      remote,
      ambiguousOutcome: "written",
    });
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("outcome");
  await expect(d.locator("[data-journal]")).toContainText("README.md: unknown");
  expect(writes).toHaveLength(1);
  await d.getByRole("button", { name: "Reconcile with GitHub" }).click();
  await expect(d.locator("[data-status]")).toContainText(
    "Reconciliation confirmed",
  );
  await expect(d.locator("[data-journal]")).toBeEmpty();
  await expect(d.locator("[data-result]")).toContainText(
    "not attribution to the commit",
  );
  await expect(d.locator("[data-result]")).not.toContainText(
    "Published commit",
  );
  await expect(d.locator("[data-history]")).toContainText(
    "reconciled at observed branch head",
  );
  expect(writes).toHaveLength(1);
});
test("a lost non-write is read first and retried only after new approval", async ({
  page,
}) => {
  const remote = { content: "# Old" },
    { d, writes } = await setup(page, {
      remote,
      ambiguousOutcome: "not-written",
    });
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("outcome");
  expect(writes).toHaveLength(1);
  await d.getByRole("button", { name: "Reconcile with GitHub" }).click();
  await expect(d.locator("[data-journal]")).toContainText(
    "README.md: not-written",
  );
  const retry = d.getByRole("button", { name: "Retry reconciled files" });
  await expect(retry).toBeDisabled();
  expect(writes).toHaveLength(1);
  await d.getByLabel(/approve retrying only files marked not-written/).check();
  await retry.click();
  await expect(d.locator("[data-status]")).toContainText("README published");
  expect(writes).toHaveLength(2);
});
test("malformed journal data is preserved, blocks writes, and must be downloaded before clearing", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "readme-studio-publish-journal-v1",
      '{"privateRecovery":"preserve exactly"}',
    ),
  );
  const { d, writes } = await setup(page);
  await expect(d.locator("[data-journal]")).toContainText(
    "Original recovery data was preserved",
  );
  const clear = d.getByRole("button", {
    name: "Clear downloaded Publish journal",
  });
  await expect(clear).toBeDisabled();
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("malformed");
  expect(writes).toHaveLength(0);
  const download = page.waitForEvent("download");
  await d
    .getByRole("button", { name: "Download original Publish journal" })
    .click();
  expect((await download).suggestedFilename()).toBe(
    "readme-studio-publish-journal-recovery.json",
  );
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(d.locator("[data-journal]")).toBeEmpty();
});
test("reload can reconcile but cannot replay content or retry without a fresh review", async ({
  page,
}) => {
  const remote = { content: "# Old" },
    { d, writes } = await setup(page, {
      remote,
      ambiguousOutcome: "not-written",
    });
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("outcome");
  expect(writes).toHaveLength(1);

  await page.reload();
  await page
    .getByRole("button", { name: "Publish to GitHub", exact: true })
    .click();
  const reopened = page.getByRole("dialog");
  await expect(reopened.locator("[data-journal]")).toContainText(
    "README.md: unknown",
  );
  await reopened.getByRole("button", { name: "Reconcile with GitHub" }).click();
  await expect(reopened.locator("[data-status]")).toContainText(
    "retry is unavailable",
  );
  await expect(
    reopened.getByRole("button", { name: "Retry reconciled files" }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(1);

  await reopened
    .getByRole("button", { name: "Clear reconciled journal and review fresh" })
    .click();
  await reopened
    .getByLabel("Target repository")
    .selectOption("octocat/octocat");
  await reopened.getByRole("button", { name: "Load remote README" }).click();
  await reopened.getByLabel(approval).check();
  await reopened
    .getByRole("button", { name: "Confirm and publish README" })
    .click();
  await expect(reopened.locator("[data-status]")).toContainText(
    "README published",
  );
  expect(writes).toHaveLength(2);
});

test("stale README requires explicit conflict resolution and fresh confirmation", async ({
  page,
}) => {
  const { d, writes } = await setup(page, { stale: true });
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText(
    "Remote README changed",
  );
  expect(writes).toHaveLength(0);
  // A Stale change set cannot be approved, even after a message edit.
  await expect(d.locator("[data-confirm]")).toBeDisabled();
  await d.getByLabel("Commit message").fill("Edited while stale");
  await expect(d.locator("[data-change-set-id]")).toContainText("Change set");
  await expect(d.locator("[data-confirm]")).toBeDisabled();
  await d.getByRole("button", { name: "Merge local and remote" }).click();
  await d.getByRole("button", { name: "Review merged README" }).click();
  await expect(d.locator("[data-status]")).toContainText("every conflict");
  await d.locator("[data-resolution]").selectOption("manual");
  await d.locator("[data-manual]").fill("# Resolved");
  await d.getByRole("button", { name: "Review merged README" }).click();
  await expect(d.getByLabel("Prepared Markdown")).toHaveValue("# Resolved");
  await expect(d.getByLabel(approval)).not.toBeChecked();
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("published");
  expect(writes[0].sha).toBe(next);
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue("# New 🦀");
  await d
    .getByText("Local publishing history and recovery", { exact: true })
    .click();
  await d
    .getByRole("button", { name: "Restore checkpoint as a new draft" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toHaveValue("# New 🦀");
});
test("dialog starts in Read-only mode with no publish control", async ({
  page,
}) => {
  const { d, ops } = await setup(page, { load: false });
  await expect(d.locator("[data-preflight] [role=status]")).toContainText(
    "Read-only mode",
  );
  await expect(d.getByLabel(approval)).toHaveCount(0);
  await expect(
    d.getByRole("button", { name: /Confirm and publish/ }),
  ).toHaveCount(0);
  expect(ops).not.toContain("preflight");
  // Loading is one explicit action: Preflight first, then the read.
  await d.getByRole("button", { name: "Load remote README" }).click();
  await expect(d.locator("[data-preflight] [role=status]")).toContainText(
    "Writable",
  );
  expect(ops.filter((op) => ["preflight", "read"].includes(op))).toEqual([
    "preflight",
    "read",
  ]);
  await expect(d.locator('[data-check="branch-rules"]')).toContainText("Pass");
  await expect(d.locator('[data-check="default-branch"]')).toContainText(
    "Warning",
  );
  await expect(
    d.getByRole("button", { name: "Confirm and publish README" }),
  ).toBeVisible();
});
test("read-only repository shows the failing check and no confirm control", async ({
  page,
}) => {
  const { d, writes, access } = await setup(page, { writable: false });
  const check = d.locator('[data-check="contents-permission"]');
  await expect(check).toContainText("Fail");
  await expect(check).toContainText("App grants Contents: read only");
  await expect(d.locator("[data-preflight] [role=status]")).toContainText(
    "Read-only mode",
  );
  // Remote content is still reviewable; write controls are not rendered.
  await expect(d.getByLabel("Prepared Markdown")).toHaveValue("# New 🦀");
  await expect(d.getByLabel(approval)).toHaveCount(0);
  await expect(
    d.getByRole("button", { name: "Confirm and publish README" }),
  ).toHaveCount(0);
  await expect(
    d.getByText("Publish on a new branch instead", { exact: true }),
  ).toHaveCount(0);
  await expect(
    d.getByRole("button", { name: "Download README fallback" }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
  // After the owner grants write access, an explicit re-check enables review.
  access.installation = { permissions: { contents: "write" } };
  await d.getByRole("button", { name: "Re-check access" }).click();
  await expect(check).toContainText("Pass");
  await expect(d.getByLabel(approval)).not.toBeChecked();
  await expect(
    d.getByRole("button", { name: "Confirm and publish README" }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});
test("the server's own Preflight refusal does not suggest the new-branch route", async ({
  page,
}) => {
  const { d } = await setup(page, { fail: "preflight" });
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("cannot push");
  await expect(d.locator("[data-status]")).not.toContainText(
    "Publish on a new branch instead",
  );
  await expect(d.locator("[data-new-branch-route]")).not.toHaveAttribute(
    "open",
    "",
  );
});
test("archived repository and missing branch keep the review read-only", async ({
  page,
}) => {
  const { d, access, ops } = await setup(page, {
    access: {
      repository: { push: true, archived: true, defaultBranch: "main" },
    },
  });
  await expect(d.locator('[data-check="not-archived"]')).toContainText("Fail");
  await expect(d.getByLabel(approval)).toHaveCount(0);
  // The server refuses branch creation in an archived repository too.
  await expect(d.locator("[data-new-branch-route]")).toHaveCount(0);
  access.repository = { push: true, archived: false, defaultBranch: "main" };
  access.branch = null;
  await d.getByLabel("Target branch").fill("missing");
  await d.getByRole("button", { name: "Load remote README" }).click();
  await expect(d.locator('[data-check="branch-exists"]')).toContainText(
    "Publish on a new branch",
  );
  await expect(d.locator("[data-status]")).toContainText(
    "Remote file not loaded",
  );
  // A missing branch is never loaded as if the README were new.
  expect(ops.filter((op) => op === "read")).toHaveLength(1);
  await expect(d.getByLabel("Prepared Markdown")).toHaveCount(0);
});
test("target change clears the Preflight and its publish control", async ({
  page,
}) => {
  const { d } = await setup(page);
  await expect(
    d.getByRole("button", { name: "Confirm and publish README" }),
  ).toBeVisible();
  await d.getByLabel("Target branch").fill("docs");
  await expect(d.locator("[data-preflight] [role=status]")).toContainText(
    "Read-only mode. Load the remote file",
  );
  await expect(d.locator("[data-check]")).toHaveCount(0);
  await expect(
    d.getByRole("button", { name: "Confirm and publish README" }),
  ).toHaveCount(0);
});
test("offline Preflight leaves every check unknown without loading or retrying", async ({
  page,
}) => {
  const { d, ops, writes } = await setup(page, { preflightOffline: true });
  await expect(d.locator('[data-check-status="unknown"]')).toHaveCount(10);
  await expect(d.locator('[data-check-status="pass"]')).toHaveCount(0);
  await expect(d.locator("[data-preflight] [role=status]")).toContainText(
    "local draft is safe",
  );
  expect(ops.filter((op) => op === "preflight")).toHaveLength(1);
  expect(ops).not.toContain("read");
  await expect(
    d.getByRole("button", { name: /Confirm and publish/ }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(0);
});
test("branch creation is explicit and does not commit a README", async ({
  page,
}) => {
  const { d, writes } = await setup(page);
  await d.getByText("Publish on a new branch instead", { exact: true }).click();
  await d.getByLabel("New branch name").fill("readme-studio/review");
  await d.getByLabel(/I confirm creating this branch/).check();
  await d.getByRole("button", { name: "Create branch for review" }).click();
  await expect(d.getByLabel("Target branch")).toHaveValue(
    "readme-studio/review",
  );
  await expect(d.locator("[data-status]")).toContainText("created");
  expect(writes).toHaveLength(0);
  await expect(d.getByLabel("Prepared Markdown")).not.toBeVisible();
});

test("selects and rechecks a compatible existing pull request before updating it", async ({
  page,
}) => {
  const selected = {
      number: 7,
      title: "Improve profile docs",
      url: "https://github.com/octocat/octocat/pull/7",
      draft: true,
      head: "docs/readme",
      headSha: sha,
      base: "main",
      baseSha: sha,
      mergeable: null,
    },
    { d, writes, ops } = await setup(page, {
      load: false,
      pullRequests: [selected],
    });
  await d
    .getByText("Update an existing documentation pull request", { exact: true })
    .click();
  await d
    .getByRole("button", { name: "Find compatible pull requests" })
    .click();
  await d.getByLabel("Compatible pull request").selectOption("7");
  await d
    .getByRole("button", { name: "Use selected pull request head" })
    .click();
  await expect(d.getByLabel("Target branch")).toHaveValue("docs/readme");
  await d.getByRole("button", { name: "Load remote README" }).click();
  await expect(d.locator("[data-selected-pr]")).toContainText("PR #7");
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(
    d.getByRole("link", { name: "View updated pull request #7" }),
  ).toBeVisible();
  expect(ops.indexOf("pull-request-check")).toBeLessThan(
    ops.lastIndexOf("commit"),
  );
  expect(writes).toHaveLength(1);
});

test("discards a delayed compatible-PR response after the target changes", async ({
  page,
}) => {
  const { d } = await setup(page, {
    load: false,
    pullRequestsDelay: 250,
    pullRequests: [
      {
        number: 7,
        title: "Old target PR",
        url: "https://github.com/octocat/octocat/pull/7",
        draft: true,
        head: "docs/readme",
        headSha: sha,
        base: "main",
        baseSha: sha,
      },
    ],
  });
  await d
    .getByText("Update an existing documentation pull request", { exact: true })
    .click();
  await d
    .getByRole("button", { name: "Find compatible pull requests" })
    .click();
  await d.getByLabel("Target branch").fill("other");
  await expect(d.locator("[data-status]")).toContainText(
    "Target changed while finding pull requests",
  );
  await expect(d.locator("[data-pr-picker]")).toBeEmpty();
});

test("creates a draft PR only after the new branch commit and exact PR review", async ({
  page,
}) => {
  const { d, writes, prWrites } = await setup(page);
  await d.getByText("Publish on a new branch instead", { exact: true }).click();
  await d.getByLabel("New branch name").fill("readme-studio/review");
  await d.getByLabel(/I confirm creating this branch/).check();
  await d.getByRole("button", { name: "Create branch for review" }).click();
  await d.getByRole("button", { name: "Load remote README" }).click();
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await d
    .getByText("Create a reviewed draft pull request", { exact: true })
    .click();
  await expect(
    d.getByRole("button", { name: "Create draft pull request" }),
  ).toBeDisabled();
  const prApproval = d.getByLabel(/I reviewed this exact title/),
    prSubmit = d.getByRole("button", { name: "Create draft pull request" });
  await prApproval.check();
  await d.getByLabel("Pull request title").fill("Improve profile README");
  await expect(prApproval).not.toBeChecked();
  await expect(prSubmit).toBeDisabled();
  await prApproval.check();
  await d.getByLabel("Pull request notes").fill("Reviewed exact changes.");
  await expect(prApproval).not.toBeChecked();
  await expect(prSubmit).toBeDisabled();
  await prApproval.check();
  await d.getByRole("button", { name: "Create draft pull request" }).click();
  await expect(d.getByRole("link", { name: "#42" })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(prWrites).toEqual([
    expect.objectContaining({
      repository: "octocat/octocat",
      head: "readme-studio/review",
      base: "main",
      headSha: next,
      baseSha: sha,
      confirmed: true,
    }),
  ]);
});

test("a lost draft-PR response is reconciled without a blind retry", async ({
  page,
}) => {
  const found = {
      number: 42,
      title: "Update README",
      url: "https://github.com/octocat/octocat/pull/42",
      draft: true,
      head: "readme-studio/review",
      headSha: next,
      base: "main",
      baseSha: sha,
      mergeable: null,
    },
    { d, prWrites } = await setup(page, {
      pullRequestAmbiguous: true,
      pullRequestStatus: found,
    });
  await d.getByText("Publish on a new branch instead", { exact: true }).click();
  await d.getByLabel("New branch name").fill("readme-studio/review");
  await d.getByLabel(/I confirm creating this branch/).check();
  await d.getByRole("button", { name: "Create branch for review" }).click();
  await d.getByRole("button", { name: "Load remote README" }).click();
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await d
    .getByText("Create a reviewed draft pull request", { exact: true })
    .click();
  await d.getByLabel(/I reviewed this exact title/).check();
  await d.getByRole("button", { name: "Create draft pull request" }).click();
  await expect(d.locator("[data-pr-journal]")).toContainText("unknown");
  expect(prWrites).toHaveLength(1);
  await d
    .locator("[data-pr-journal]")
    .getByRole("button", { name: "Reconcile with GitHub" })
    .click();
  await expect(d.locator("[data-pr-journal]")).toContainText(
    "View pull request #42",
  );
  expect(prWrites).toHaveLength(1);
});

test("a reconciled no-match needs download and confirmation before recovery can clear", async ({
  page,
}) => {
  const { d, prWrites } = await setup(page, {
    pullRequestAmbiguous: true,
    pullRequestStatusDelay: 250,
  });
  await d.getByText("Publish on a new branch instead", { exact: true }).click();
  await d.getByLabel("New branch name").fill("readme-studio/review");
  await d.getByLabel(/I confirm creating this branch/).check();
  await d.getByRole("button", { name: "Create branch for review" }).click();
  await d.getByRole("button", { name: "Load remote README" }).click();
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await d
    .getByText("Create a reviewed draft pull request", { exact: true })
    .click();
  await d.getByLabel(/I reviewed this exact title/).check();
  await d.getByRole("button", { name: "Create draft pull request" }).click();
  const reconcile = d
    .locator("[data-pr-journal]")
    .getByRole("button", { name: "Reconcile with GitHub" });
  await reconcile.click();
  const originalJournal = await page.evaluate(() => {
    const key = "readme-studio-pull-request-journal-v1",
      raw = localStorage.getItem(key),
      replacement = JSON.parse(raw);
    replacement.head = "another-branch";
    localStorage.setItem(key, JSON.stringify(replacement));
    return raw;
  });
  await expect(d.locator("[data-status]")).toContainText(
    "changed in another tab while reconciling",
  );
  await expect(d.getByText("another-branch", { exact: false })).toBeVisible();
  await page.evaluate((raw) => {
    localStorage.setItem("readme-studio-pull-request-journal-v1", raw);
  }, originalJournal);
  await reconcile.click();
  const clear = d.getByRole("button", { name: "Clear unmatched recovery" }),
    confirm = d.getByLabel(/I checked GitHub/);
  await expect(clear).toBeDisabled();
  await expect(confirm).toBeDisabled();
  const download = page.waitForEvent("download");
  await d.getByRole("button", { name: "Download unmatched recovery" }).click();
  expect((await download).suggestedFilename()).toBe(
    "readme-studio-unmatched-pull-request-recovery.json",
  );
  await confirm.check();
  await clear.click();
  await expect(d.locator("[data-pr-journal]")).toBeEmpty();
  await expect(d.locator("[data-status]")).toContainText(
    "No remote request was retried",
  );
  expect(prWrites).toHaveLength(1);
});

test("reports a non-draft duplicate as existing instead of newly created", async ({
  page,
}) => {
  const duplicate = {
      number: 9,
      title: "Existing README update",
      url: "https://github.com/octocat/octocat/pull/9",
      draft: false,
      head: "readme-studio/review",
      headSha: next,
      base: "main",
      baseSha: sha,
    },
    { d, prWrites } = await setup(page, {
      pullRequestDuplicate: duplicate,
    });
  await d.getByText("Publish on a new branch instead", { exact: true }).click();
  await d.getByLabel("New branch name").fill("readme-studio/review");
  await d.getByLabel(/I confirm creating this branch/).check();
  await d.getByRole("button", { name: "Create branch for review" }).click();
  await d.getByRole("button", { name: "Load remote README" }).click();
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await d
    .getByText("Create a reviewed draft pull request", { exact: true })
    .click();
  await d.getByLabel(/I reviewed this exact title/).check();
  await d.getByRole("button", { name: "Create draft pull request" }).click();
  await expect(d.locator("[data-status]")).toContainText(
    "Existing pull request #9 found",
  );
  await expect(d.locator("[data-pr-result]")).toContainText(
    "No duplicate was created",
  );
  await expect(d.locator("[data-pr-result]")).not.toContainText("draft");
  expect(prWrites).toHaveLength(1);
});

// Opens the review with the generated banner assets in the change set.
async function loadWithAssets(d) {
  await d
    .getByLabel("Include generated banner SVG files in this publishing plan")
    .check();
  await d
    .getByLabel(
      "Update only Studio-owned banner references in the prepared README",
    )
    .check();
  await d.getByRole("button", { name: "Load remote README" }).click();
  await expect(d.getByRole("heading", { name: "Change set" })).toBeVisible();
}
const entry = (d, path) => d.locator(`[data-entry="${path}"]`);
for (const failAsset of [false, true])
  test(`change set lists every file and partial=${failAsset} reports exact file outcomes`, async ({
    page,
  }) => {
    const { d, writes } = await setup(page, { assets: true, failAsset });
    await loadWithAssets(d);
    await expect(d.getByLabel("Prepared Markdown")).toHaveValue(
      /assets\/readme\/banner-light.svg/,
    );
    // Target, branch and base commit head the change set.
    await expect(d.locator("[data-change-set-target]")).toContainText(
      `octocat/octocat · branch main · base commit ${sha}`,
    );
    await expect(d.locator("[data-change-set]")).toContainText("Not atomic");
    // One row per File change, in execution order: assets first, README last.
    await expect(d.locator("[data-entry]")).toHaveCount(3);
    expect(
      await d
        .locator("[data-entry]")
        .evaluateAll((rows) => rows.map((r) => r.dataset.entry)),
    ).toEqual([
      "assets/readme/banner-light.svg",
      "assets/readme/banner-dark.svg",
      "README.md",
    ]);
    const light = entry(d, "assets/readme/banner-light.svg");
    await expect(light.locator("[data-entry-action]")).toHaveText(
      "create (new file)",
    );
    await expect(light.locator("[data-base-sha]")).toHaveText("none: new file");
    await expect(light.locator("[data-result-sha]")).toHaveText(
      /^[a-f0-9]{40}$/,
    );
    const readme = entry(d, "README.md");
    await expect(readme.locator("[data-entry-action]")).toHaveText("update");
    await expect(readme.locator("[data-base-sha]")).toHaveText(sha);
    // Asset diffs are expandable with the shared source-diff panes.
    await light.getByText("Diff for assets/readme/banner-light.svg").click();
    await expect(
      light.getByLabel("Generated assets/readme/banner-light.svg"),
    ).toHaveValue(/<svg/);
    await expect(d.getByLabel(approval)).toHaveAccessibleName(
      /I reviewed 3 file writes to octocat\/octocat on main \(change set [a-f0-9]{8}\)/,
    );
    expect(writes).toHaveLength(0);
    await d.getByLabel(approval).check();
    const id = (
      await d.locator("[data-change-set-id] code").last().textContent()
    ).trim();
    await d.getByRole("button", { name: "Confirm and publish README" }).click();
    if (failAsset) {
      await expect(d.locator("[data-status]")).toContainText(
        "Partial asset publish",
      );
      expect(writes.map((w) => w.path)).toEqual([
        "assets/readme/banner-light.svg",
        "assets/readme/banner-dark.svg",
      ]);
      await expect(d.locator("[data-change-set-results]")).toContainText(
        "banner-dark.svg: failed",
      );
      await expect(d.locator("[data-change-set-results]")).toContainText(
        "README.md: not attempted",
      );
      await expect(d.locator("[data-journal]")).toContainText(
        "banner-light.svg: written",
      );
      await expect(d.locator("[data-journal]")).toContainText(
        "banner-dark.svg: failed",
      );
      await expect(d.locator("[data-journal]")).toContainText(
        "README.md: not-attempted",
      );
    } else {
      await expect(d.locator("[data-status]")).toContainText(
        "README published",
      );
      expect(writes.map((w) => w.path)).toEqual([
        "assets/readme/banner-light.svg",
        "assets/readme/banner-dark.svg",
        "README.md",
      ]);
    }
    // Every write carries the reviewed SHAs and the approved change set id.
    for (const write of writes) {
      expect(write.changeSetId).toBe(id);
      expect(write.resultSha).toBe(await gitBlobSha(write.content));
      await expect(
        entry(d, write.path).locator("[data-result-sha]"),
      ).toHaveText(write.resultSha);
    }
    expect(writes[0].sha).toBeNull();
    // Approval covers one attempt only, even after a partial failure.
    await expect(d.locator("[data-confirm]")).not.toBeChecked();
    await expect(d.locator("[data-confirm]")).toBeDisabled();
    await expect(
      page.getByRole("textbox", { name: "Markdown editor", exact: true }),
    ).not.toHaveValue(/assets\/readme/);
  });
test("a README that already matches needs no write; only assets publish", async ({
  page,
}) => {
  const remote = { content: "# Old" },
    { d, writes } = await setup(page, { assets: true, load: false, remote });
  await loadWithAssets(d);
  // GitHub now holds exactly the prepared README; load it again.
  remote.content = await d.getByLabel("Prepared Markdown").inputValue();
  await d.getByRole("button", { name: "Load remote README" }).click();
  const readme = entry(d, "README.md");
  await expect(readme.locator("[data-entry-action]")).toHaveText(
    "unchanged: no write",
  );
  await expect(readme.locator("[data-base-sha]")).toHaveText(
    await gitBlobSha(remote.content),
  );
  await expect(readme.locator("[data-result-sha]")).toHaveText(
    await gitBlobSha(remote.content),
  );
  await expect(d.locator("[data-change-set-id]")).toContainText(
    "2 file writes, 1 unchanged",
  );
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText(
    "README needed no write",
  );
  expect(writes.map((w) => w.path)).toEqual([
    "assets/readme/banner-light.svg",
    "assets/readme/banner-dark.svg",
  ]);
  await expect(d.locator("[data-change-set-results]")).toContainText(
    "README.md: no write",
  );
  await expect(d.locator("[data-confirm]")).toBeDisabled();
});
test("an unchanged README has nothing to approve; a dropped remote BOM is named", async ({
  page,
}) => {
  const remote = { content: "# Old" },
    { d, writes } = await setup(page, { remote });
  remote.content = await d.getByLabel("Prepared Markdown").inputValue();
  await d.getByRole("button", { name: "Load remote README" }).click();
  const readme = entry(d, "README.md"),
    box = d.locator("[data-confirm]");
  await expect(readme.locator("[data-entry-action]")).toHaveText(
    "unchanged: no write",
  );
  await expect(box).toBeDisabled();
  await expect(box).toHaveAccessibleName(
    /Nothing to approve: every file already matches octocat\/octocat on main/,
  );
  await expect(
    d.getByRole("button", { name: "Confirm and publish README" }),
  ).toBeDisabled();
  await expect(readme.locator("[data-entry-bom]")).toHaveCount(0);
  // Same text behind a UTF-8 BOM on GitHub: publishing would drop the BOM,
  // so the entry is a write and says so.
  remote.content = `\uFEFF${remote.content}`;
  await d.getByRole("button", { name: "Load remote README" }).click();
  await expect(readme.locator("[data-entry-action]")).toHaveText("update");
  await expect(readme.locator("[data-entry-bom]")).toContainText(
    "Removed: the remote file starts with a UTF-8 byte order mark",
  );
  await expect(box).toBeEnabled();
  expect(writes).toHaveLength(0);
});
test("editing the commit message withdraws approval of the change set", async ({
  page,
}) => {
  const { d, writes } = await setup(page);
  const publish = d.getByRole("button", { name: "Confirm and publish README" }),
    // Its label changes with the change set, so locate it structurally.
    box = d.locator("[data-confirm]"),
    label = () => box.evaluate((el) => el.labels[0].textContent);
  await expect(box).toHaveAccessibleName(approval);
  await expect(publish).toBeDisabled();
  // Approval works from the keyboard.
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  await expect(publish).toBeEnabled();
  const before = await label();
  await d.getByLabel("Commit message").fill("Reworded message");
  await expect(box).not.toBeChecked();
  await expect(publish).toBeDisabled();
  await expect(d.locator("[data-status]")).toContainText(
    "Approve the new change set",
  );
  // The message is part of the change set, so its id changes.
  await expect.poll(label).not.toBe(before);
  // An empty message cannot form a change set at all.
  await d.getByLabel("Commit message").fill("");
  await expect(box).toBeDisabled();
  await expect(d.locator("[data-change-set-id]")).toContainText(
    "commit message",
  );
  expect(writes).toHaveLength(0);
  await d.getByLabel("Commit message").fill("Final message");
  await box.check();
  await publish.click();
  await expect(d.locator("[data-status]")).toContainText("published");
  expect(writes).toHaveLength(1);
  expect(writes[0].message).toBe("Final message");
  await expect(d.locator("[data-change-set-id]")).toContainText(
    writes[0].changeSetId.slice(0, 8),
  );
});
test("a stale asset blocks every write and needs a new approval", async ({
  page,
}) => {
  const { d, writes } = await setup(page, { assets: true, staleAsset: true });
  await loadWithAssets(d);
  const dark = entry(d, "assets/readme/banner-dark.svg"),
    id = d.locator("[data-change-set-id] code").last();
  await expect(dark.locator("[data-base-sha]")).toHaveText("none: new file");
  const before = await id.textContent();
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("Stale change set");
  await expect(
    d.getByRole("heading", { name: "Stale change set" }),
  ).toBeFocused();
  expect(writes).toHaveLength(0);
  // The new change set updates from the latest remote SHA and is unapproved.
  await expect(dark.locator("[data-base-sha]")).toHaveText(next);
  await expect(dark.locator("[data-entry-action]")).toHaveText("update");
  await expect(d.getByLabel(approval)).not.toBeChecked();
  await expect(
    d.getByRole("button", { name: "Confirm and publish README" }),
  ).toBeDisabled();
  await expect(id).not.toHaveText(before);
  await d.getByLabel(approval).check();
  await d.getByRole("button", { name: "Confirm and publish README" }).click();
  await expect(d.locator("[data-status]")).toContainText("README published");
  expect(writes.map((w) => [w.path, w.sha])).toEqual([
    ["assets/readme/banner-light.svg", null],
    ["assets/readme/banner-dark.svg", next],
    ["README.md", sha],
  ]);
});
test("without Web Crypto the review stays read-only with download", async ({
  page,
}) => {
  const { d, writes } = await setup(page, { noCrypto: true });
  await expect(d.getByLabel("Prepared Markdown")).toHaveValue("# New 🦀");
  await expect(d.locator("[data-read-only]")).toContainText(
    "cannot compute Git blob SHAs",
  );
  await expect(d.getByLabel(approval)).toHaveCount(0);
  await expect(
    d.getByRole("button", { name: /Confirm and publish/ }),
  ).toHaveCount(0);
  await expect(entry(d, "README.md").locator("[data-result-sha]")).toHaveText(
    "not computed",
  );
  await expect(
    d.getByRole("button", { name: "Download README fallback" }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});
