import { test, expect } from "@playwright/test";
const endpoint = "https://context.example/v1/chat/completions";
async function open(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate(async () => {
    const app = document.querySelector("app-shell");
    app.store.raw(
      "# Public\nSelected words.\n\n## Private\nUNSELECTED_SECTION",
    );
    app.store.draft.metadata = {
      githubProfile: {
        snapshot: {
          login: "example",
          bio: "Builds text tools",
          token: "HIDDEN_TOKEN",
          email: "PRIVATE_EMAIL",
        },
      },
      repositoryReadme: {
        templateId: "cli",
        reviewed: {
          name: "Formatter",
          description: "Formats text",
          token: "HIDDEN_TOKEN",
        },
      },
    };
    app.editor.input.setSelectionRange(9, 24);
    const { auditSession } = await import("/src/repository-audit/github.js");
    auditSession.repositories = [
      {
        full_name: "example/one",
        description: "A formatter",
        token: "HIDDEN_TOKEN",
      },
      { full_name: "example/two", description: "UNSELECTED_REPO" },
    ];
    auditSession.stackResults = new Map([
      [
        "example/one",
        {
          repository: "example/one",
          status: "read",
          checkedAt: 1,
          language: "Rust",
          dependencies: [],
          manifests: [],
        },
      ],
      [
        "example/two",
        {
          repository: "example/two",
          status: "read",
          language: "Go",
          dependencies: [],
          manifests: [],
        },
      ],
    ]);
  });
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  const panel = page.locator("writing-assistant");
  await expect(panel.locator("h1")).toBeVisible();
  return panel;
}
async function connection(panel) {
  await panel.getByLabel("Chat completions endpoint").fill(endpoint);
  await panel.getByLabel("Model identifier").fill("test-model");
  await panel.locator("[data-consent]").check();
}
test("all seven sources are opt-in and the exact displayed messages equal the request at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  let sent;
  await page.route(endpoint, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({
      json: {
        choices: [
          { finish_reason: "stop", message: { content: "Reviewed wording." } },
        ],
      },
    });
  });
  const panel = await open(page);
  expect(await panel.locator("[data-context-choice]:checked").count()).toBe(0);
  const initial = JSON.parse(
    await panel.locator("[data-request]").inputValue(),
  );
  expect(JSON.parse(initial[1].content).context).toBeUndefined();
  await panel
    .getByRole("combobox", { name: "Context repository", exact: true })
    .selectOption({ label: "example/one" });
  for (const name of [
    "GitHub profile",
    "Selected repository",
    "Project type",
    "Stack DNA",
    "Project metadata",
    "Selected section",
    "Current writing style",
  ])
    await panel.getByLabel(`Include ${name}`, { exact: true }).check();
  await panel
    .getByLabel("Current writing style context", { exact: true })
    .fill("Friendly, concise sentences.");
  await connection(panel);
  const preview = await panel.locator("[data-request]").inputValue();
  expect(preview).not.toMatch(
    /HIDDEN_TOKEN|PRIVATE_EMAIL|UNSELECTED_REPO|UNSELECTED_SECTION/,
  );
  expect(JSON.parse(JSON.parse(preview)[1].content).context).toHaveLength(7);
  expect(preview).toContain("not proficiency");
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect(panel.locator("[data-status]")).toContainText("Proposal ready");
  expect(sent.messages).toEqual(JSON.parse(preview));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toContain("Selected words.");
});
test("context changes invalidate send consent and diff approval, and previews stay inert", async ({
  page,
}) => {
  const panel = await open(page);
  await panel
    .getByLabel("GitHub profile context", { exact: true })
    .fill("<script>window.contextExecuted=true</script>");
  await panel.getByLabel("Include GitHub profile", { exact: true }).check();
  await connection(panel);
  await panel.getByLabel("Proposed", { exact: true }).fill("Edited words.");
  await panel.getByRole("button", { name: "Review diff", exact: true }).click();
  await panel.getByLabel("I reviewed Original, Proposed and Diff").check();
  await connection(panel);
  await panel.getByLabel("Include GitHub profile", { exact: true }).uncheck();
  await expect(panel.locator("[data-consent]")).not.toBeChecked();
  await expect(panel.locator("[data-review-panel]")).toBeHidden();
  expect(await panel.locator("[data-request]").inputValue()).not.toContain(
    "contextExecuted",
  );
  expect(await page.evaluate(() => window.contextExecuted)).toBeUndefined();
  await expect(panel.locator("script")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  expect(await panel.locator("[data-context-choice]:checked").count()).toBe(0);
});
