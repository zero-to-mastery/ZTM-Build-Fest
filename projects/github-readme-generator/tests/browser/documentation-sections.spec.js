import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
async function open(page, type) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.locator(`[data-block-type="${type}"]`).click();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
});
test("installation and testing sections remain editable and support undo", async ({
  page,
}) => {
  await open(page, "doc-installation");
  await page
    .getByLabel("Section heading", { exact: true })
    .fill("Install locally");
  await page.getByLabel("Package manager", { exact: true }).fill("pnpm");
  await page
    .getByLabel("Install command", { exact: true })
    .fill("pnpm add actual-package");
  await expect(page.getByLabel("Install command status")).toHaveValue(
    "placeholder",
  );
  await page.getByLabel("Install command status").selectOption("verified");
  await page
    .getByLabel("Install command verification note or evidence")
    .fill("Matched the package manifest install guidance.");
  await page
    .getByLabel("Prerequisites", { exact: true })
    .fill("Confirm your runtime version first.");
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  await page
    .locator(".block-open")
    .filter({ hasText: "Install locally" })
    .click();
  await expect(page.getByLabel("Install command", { exact: true })).toHaveValue(
    "pnpm add actual-package",
  );
  await page
    .getByLabel("Install command", { exact: true })
    .fill("pnpm add actual-package@latest");
  await expect(page.getByLabel("Install command status")).toHaveValue(
    "placeholder",
  );
  await page.getByLabel("Install command status").selectOption("verified");
  await page
    .getByLabel("Install command verification note or evidence")
    .fill("Rechecked against the package manifest.");
  await page
    .getByLabel("Additional notes", { exact: true })
    .fill("Use your own registry if required.");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await open(page, "doc-testing");
  await page.getByLabel("Test commands", { exact: true }).fill("npm test");
  await page.getByLabel("Test types (one per line)").fill("Unit\nBrowser");
  await page.getByLabel("Coverage notes").fill("Measured locally.");
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  const source = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.markdown,
  );
  expect(source).toContain("```sh\nnpm test\n```");
  expect(source).toContain("readme-studio-example: verified");
  expect(source).toContain("readme-studio-example: placeholder");
  expect(source).toContain("- Unit\n- Browser");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).not.toContain("### Test commands");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(source);

  await page.evaluate(
    (value) => document.querySelector("app-shell").store.raw(value),
    source.replace("pnpm add actual-package@latest", "pnpm add other-package"),
  );
  await page.getByRole("button", { name: "Export README" }).click();
  await expect(page.locator("example-export-check")).toContainText(
    "1 stale provenance claim",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate(
    (value) => document.querySelector("app-shell").store.raw(value),
    source,
  );

  await page
    .locator(".block-row")
    .filter({ hasText: "Testing" })
    .getByRole("button", { name: /Copy/ })
    .click();
  await expect(page.locator("example-export-check")).toContainText(
    "1 placeholder",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("button", { name: "Export README" }).click();
  const review = page.locator("example-export-check");
  await expect(
    review.getByRole("heading", { name: "Review example provenance" }),
  ).toBeFocused();
  await expect(review).toContainText("1 placeholder");
  await page.evaluate(() =>
    document
      .querySelector("app-shell")
      .store.raw(
        document.querySelector("app-shell").store.draft.markdown + "\n",
      ),
  );
  await review
    .getByRole("button", { name: "Export current source anyway" })
    .click();
  await expect(review.locator("[data-status]")).toContainText("source changed");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate(
    (value) => document.querySelector("app-shell").store.raw(value),
    source,
  );
  await page.getByRole("button", { name: "Export README" }).click();
  const download = page.waitForEvent("download");
  await page
    .locator("example-export-check")
    .getByRole("button", { name: "Export current source anyway" })
    .click();
  expect(readFileSync(await (await download).path(), "utf8")).toBe(source);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => Promise.reject(Error("Denied")) },
      configurable: true,
    });
  });
  await page
    .getByRole("button", { name: "Copy Markdown", exact: true })
    .click();
  await page
    .locator("example-export-check")
    .getByRole("button", { name: "Copy current source anyway" })
    .click();
  await expect(page.getByLabel("Markdown to copy")).toHaveValue(source);
});
test("environment rows support keyboard ordering and placeholder guidance at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page, "doc-environment");
  await expect(page.locator("builder-form")).toContainText(
    "Never paste real secrets here",
  );
  await page.getByRole("button", { name: "Add environment variable" }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("API_TOKEN");
  await page.getByLabel("Required", { exact: true }).check();
  await page
    .getByLabel("Variable description", { exact: true })
    .fill("Token for local development");
  await page
    .getByLabel("Example placeholder (never a real secret)")
    .fill("YOUR_API_TOKEN");
  await page.getByRole("button", { name: "Add environment variable" }).click();
  await page.getByLabel("Variable name", { exact: true }).nth(1).fill("PORT");
  await page
    .getByLabel("Example placeholder (never a real secret)")
    .nth(1)
    .fill("3000");
  await page.getByRole("button", { name: "Move entry 2 up" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Variable name", { exact: true }).first(),
  ).toHaveValue("PORT");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page
    .getByRole("button", { name: "Add to README", exact: true })
    .click();
  const source = await page.evaluate(
    () => document.querySelector("app-shell").store.draft.markdown,
  );
  expect(source.indexOf("| PORT |")).toBeLessThan(
    source.indexOf("| API\\_TOKEN |"),
  );
  expect(source).toContain("Keep real secrets outside version control");
  await page
    .locator(".block-open")
    .filter({ hasText: "Environment Variables" })
    .click();
  await page
    .getByRole("button", { name: "Remove entry", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Variable name", { exact: true })).toHaveCount(
    1,
  );
});
