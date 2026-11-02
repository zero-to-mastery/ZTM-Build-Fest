import { test, expect } from "@playwright/test";
const endpoint = "https://writer.example/v1/chat/completions";
const source =
  "# Example\n\nThis are selected notes.\n\n## Private\nDo not send this part.";
async function open(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate((markdown) => {
    const app = document.querySelector("app-shell");
    app.store.raw(markdown);
    const start = markdown.indexOf("This are");
    app.editor.input.setSelectionRange(
      start,
      start + "This are selected notes.".length,
    );
  }, source);
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  await expect(page.locator("writing-assistant h1")).toBeVisible();
  return page.locator("writing-assistant");
}
async function configure(panel) {
  await panel.getByLabel("Chat completions endpoint").fill(endpoint);
  await panel.getByLabel("Model identifier").fill("local-test-model");
  await panel
    .getByLabel("API key (optional for local models)")
    .fill("memory-secret");
  await panel
    .getByLabel(
      "Send the displayed messages and selected context to this endpoint when I choose Generate",
    )
    .check();
}
async function review(panel) {
  await panel.getByRole("button", { name: "Review diff", exact: true }).click();
  await panel.getByLabel("I reviewed Original, Proposed and Diff").check();
}
const current = (page) =>
  page.evaluate(() => document.querySelector("app-shell").store.draft.markdown);
const completion = (content) => ({
  choices: [{ finish_reason: "stop", message: { content } }],
});

test("AI sends only the selection, requires a diff, preserves surrounding source and keeps keys out of storage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const calls = [];
  await page.route(endpoint, (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ json: completion("These are selected notes.") });
  });
  const panel = await open(page);
  await expect(panel.getByLabel("Original", { exact: true })).toHaveValue(
    "This are selected notes.",
  );
  expect(await panel.locator("[data-action-choice] option").count()).toBe(10);
  expect(calls).toHaveLength(0);
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect(panel.locator("[data-status]")).toContainText("Confirm");
  expect(calls).toHaveLength(0);
  await configure(panel);
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect(panel.getByLabel("Proposed", { exact: true })).toHaveValue(
    "These are selected notes.",
  );
  await expect(panel.locator("[data-claim-review]")).toContainText(
    "confirm 1 flagged statement",
  );
  await expect(panel.locator("[data-claim-review]")).toContainText(
    "Approved evidence: Original",
  );
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain("Do not send");
  expect(await current(page)).toBe(source);
  await review(panel);
  await panel
    .getByLabel("Proposed", { exact: true })
    .fill("These are reviewed notes.");
  await expect(panel.locator("[data-review-panel]")).toBeHidden();
  await review(panel);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await panel.getByRole("button", { name: "Apply", exact: true }).focus();
  await page.keyboard.press("Enter");
  const result = source.replace(
    "This are selected notes.",
    "These are reviewed notes.",
  );
  expect(await current(page)).toBe(result);
  await page.evaluate(() => document.querySelector("app-shell").store.undo());
  expect(await current(page)).toBe(source);
  await page.evaluate(() => document.querySelector("app-shell").store.redo());
  expect(await current(page)).toBe(result);
  expect(
    await page.evaluate(
      () =>
        JSON.stringify(document.querySelector("app-shell").data) +
        JSON.stringify({ ...localStorage }),
    ),
  ).not.toContain("memory-secret");
  await page.reload();
  await expect.poll(() => current(page)).toBe(result);
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  await expect(
    page.getByLabel("API key (optional for local models)"),
  ).toHaveValue("");
});

test("manual proposals work offline, preserve sections and block stale drafts", async ({
  page,
  context,
}) => {
  const panel = await open(page);
  await context.setOffline(true);
  await panel
    .getByLabel("Content to edit")
    .selectOption({ label: "Section: Private" });
  await expect(panel.getByLabel("Original", { exact: true })).toHaveValue(
    "## Private\nDo not send this part.",
  );
  await panel
    .getByLabel("Proposed", { exact: true })
    .fill("## Private\nReviewed locally.");
  await review(panel);
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# New source"),
  );
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(panel.locator("[data-status]")).toContainText("draft changed");
  expect(await current(page)).toBe("# New source");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Writing assistant", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  await panel.getByLabel("Proposed", { exact: true }).fill("# Local update");
  await review(panel);
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  expect(await current(page)).toBe("# Local update");
});

test("failures and cancellation preserve the draft and prevent late proposals", async ({
  page,
}) => {
  let calls = 0;
  await page.route(endpoint, async (route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({ status: 429, body: "sensitive provider payload" });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ json: completion("Late response") }).catch(() => {});
  });
  const panel = await open(page);
  await configure(panel);
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect(panel.locator("[data-status]")).toContainText("limit reached");
  await expect(panel).not.toContainText("sensitive provider payload");
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect.poll(() => calls).toBe(2);
  await panel.getByRole("button", { name: "Cancel request" }).click();
  await expect(panel.locator("[data-status]")).toContainText("cancelled");
  await expect(
    panel.getByLabel("API key (optional for local models)"),
  ).toHaveValue("");
  await expect(panel.locator("[data-consent]")).not.toBeChecked();
  await expect(panel.locator("[data-request]")).toHaveValue("");
  await panel
    .getByLabel("Proposed", { exact: true })
    .fill("Keep this local proposal");
  await page.waitForTimeout(1400);
  await expect(panel.getByLabel("Proposed", { exact: true })).toHaveValue(
    "Keep this local proposal",
  );
  expect(await current(page)).toBe(source);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  await expect(
    page.getByLabel("API key (optional for local models)"),
  ).toHaveValue("");
  await panel
    .getByLabel("Chat completions endpoint")
    .fill("https://other.example/v1/chat/completions");
  await expect(
    panel.getByLabel("API key (optional for local models)"),
  ).toHaveValue("");
  await expect(panel.locator("[data-consent]")).not.toBeChecked();
});

test("Draft section uses notes at the cursor and hostile output stays inert during review", async ({
  page,
}) => {
  let sent;
  await page.route(endpoint, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({
      json: completion(
        "<script>window.aiExecuted=true</script>\n## New section\nReviewed facts.",
      ),
    });
  });
  const panel = await open(page);
  await panel
    .getByLabel("Content to edit")
    .selectOption({ label: "New section at cursor" });
  await panel.getByLabel("Writing action").selectOption("draft");
  await panel
    .getByLabel("Optional factual notes or instructions")
    .fill("A small CLI for formatting text.");
  await configure(panel);
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect(panel.locator("[data-status]")).toContainText("Proposal ready");
  await expect(panel.locator("[data-claim-review]")).toContainText(
    "flagged statement",
  );
  await expect(panel.locator("[data-claim-review]")).toContainText(
    "Reviewed facts",
  );
  expect(JSON.parse(sent.messages[1].content)).toEqual({
    original: "",
    notes: "A small CLI for formatting text.",
  });
  await review(panel);
  expect(await page.evaluate(() => window.aiExecuted)).toBeUndefined();
  await expect(panel.locator("script")).toHaveCount(0);
  expect(await current(page)).toBe(source);
});
