import { test, expect } from "@playwright/test";
const endpoint = "https://compare.example/v1/chat/completions";
const source =
  "# Demo\n\nLong technical notes about a CLI.\n\n## Keep\nUntouched.";
async function open(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate((source) => {
    const app = document.querySelector("app-shell");
    app.store.raw(source);
    const start = source.indexOf("Long");
    app.editor.input.setSelectionRange(
      start,
      start + "Long technical notes about a CLI.".length,
    );
  }, source);
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  const panel = page.locator("writing-assistant");
  await panel
    .getByRole("combobox", { name: "Generation mode", exact: true })
    .selectOption("compare");
  await panel
    .getByRole("combobox", { name: "Writing action", exact: true })
    .selectOption("summary");
  await panel.getByLabel("Chat completions endpoint").fill(endpoint);
  await panel.getByLabel("Model identifier").fill("test-model");
  await panel.locator("[data-consent]").check();
  return panel;
}
test("three previewed variants compare side by side, selection stages and Apply stays reviewed", async ({
  page,
}) => {
  const calls = [];
  await page.route(endpoint, (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    const text = body.messages[0].content.includes("Alternative style: Concise")
      ? "CLI formatter."
      : body.messages[0].content.includes("Alternative style: Technical")
        ? "A command-line text formatter."
        : "A friendly tool for formatting text.";
    return route.fulfill({
      json: {
        choices: [{ finish_reason: "stop", message: { content: text } }],
      },
    });
  });
  const panel = await open(page);
  const preview = JSON.parse(
    await panel.locator("[data-request]").inputValue(),
  );
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect(panel.locator("[data-status]")).toContainText("3 of 3");
  expect(calls.map((c) => c.messages)).toEqual(preview.map((p) => p.messages));
  await expect(panel.getByLabel("Proposed", { exact: true })).toHaveValue("");
  const boxes = await panel
    .locator(".writing-comparison-grid section")
    .evaluateAll((els) =>
      els.map((el) => ({
        x: el.getBoundingClientRect().x,
        y: el.getBoundingClientRect().y,
      })),
    );
  expect(boxes[0].y).toBe(boxes[1].y);
  expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
  await panel.getByRole("button", { name: "Use Friendly" }).focus();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);
  await panel.getByRole("button", { name: "Review diff", exact: true }).click();
  await panel.getByLabel("I reviewed Original, Proposed and Diff").check();
  await panel.getByRole("button", { name: "Use Concise" }).click();
  await expect(panel.locator("[data-review-panel]")).toBeHidden();
  await panel.getByRole("button", { name: "Review diff", exact: true }).click();
  await panel.getByLabel("I reviewed Original, Proposed and Diff").check();
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source.replace("Long technical notes about a CLI.", "CLI formatter."));
  await page.evaluate(() => document.querySelector("app-shell").store.undo());
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);
});
test("partial failure keeps completed versions at mobile width and stops further requests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  let calls = 0;
  await page.route(endpoint, (route) => {
    calls++;
    return calls === 1
      ? route.fulfill({
          json: {
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Partial success" },
              },
            ],
          },
        })
      : route.fulfill({ status: 429 });
  });
  const panel = await open(page);
  await panel.getByRole("button", { name: "Generate proposal" }).click();
  await expect(panel.locator("[data-status]")).toContainText("1 of 3");
  expect(calls).toBe(2);
  await expect(
    panel.getByRole("button", { name: "Use Concise" }),
  ).toBeEnabled();
  await expect(
    panel.getByRole("button", { name: "Use Technical" }),
  ).toBeDisabled();
  await expect(panel.locator("writing-comparison")).toContainText(
    "limit reached",
  );
  const positions = await panel
    .locator(".writing-comparison-grid section")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
  expect(positions[1]).toBeGreaterThan(positions[0]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await panel.getByRole("button", { name: "Use Concise" }).click();
  await expect(panel.getByLabel("Proposed", { exact: true })).toHaveValue(
    "Partial success",
  );
  await panel
    .getByLabel("Optional factual notes or instructions")
    .fill("Changed input");
  await expect(panel.locator("writing-comparison")).toBeHidden();
  await expect(panel.locator("[data-consent]")).not.toBeChecked();
});
