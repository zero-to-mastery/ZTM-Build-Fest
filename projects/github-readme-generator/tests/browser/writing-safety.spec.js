import { test, expect } from "@playwright/test";

test("provider switching clears credentials and disabled AI supports offline reviewed editing", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  await page.evaluate(() => {
    const app = document.querySelector("app-shell");
    app.store.raw("# Notes\n\nOriginal");
    app.editor.input.setSelectionRange(9, 17);
  });
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  const panel = page.locator("writing-assistant");
  await panel
    .getByLabel("Chat completions endpoint")
    .fill("https://writer.example/v1/chat/completions");
  await panel.locator("[data-key]").fill("credential-sentinel");
  await panel.locator("[data-consent]").check();
  await panel
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("local");
  await expect(panel.locator("[data-key]")).toHaveValue("");
  await expect(panel.locator("[data-key]")).toBeDisabled();
  await expect(panel.locator("[data-consent]")).not.toBeChecked();
  await expect(panel.locator("[data-destination]")).toContainText("loopback");
  await panel
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("disabled");
  await expect(
    panel.getByRole("button", { name: "Generate proposal" }),
  ).toBeDisabled();
  await expect(panel.locator("[data-destination]")).toContainText(
    "Nothing is transmitted",
  );
  await context.setOffline(true);
  await panel.getByLabel("Proposed", { exact: true }).fill("Manually revised");
  await panel.getByRole("button", { name: "Review diff", exact: true }).click();
  await panel.getByLabel("I reviewed Original, Proposed and Diff").check();
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe("# Notes\n\nManually revised");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "credential-sentinel",
  );
  await page
    .getByRole("button", { name: "Writing assistant", exact: true })
    .click();
  await expect(
    panel.getByRole("combobox", { name: "Provider", exact: true }),
  ).toHaveValue("disabled");
});
