import { test, expect } from "@playwright/test";

for (const [name, component, filename] of [
  ["Badge Studio", "badge-studio", "badge-studio"],
  ["Project Studio", "project-studio", "project-studio"],
  ["Visual theme", "theme-studio", "theme-studio"],
  ["Banner Builder", "banner-builder", "banner-builder"],
  ["Compatibility Lab", "compatibility-lab", "analyzer"],
  ["Publish to GitHub", "publish-dialog", "publishing-setup"],
]) {
  test(`release review: ${name} is reachable and returns focus`, async ({
    page,
  }) => {
    await page.route("https://**/*", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"/>',
      }),
    );
    await page.route("**/api/publishing/session", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ configured: false }),
      }),
    );
    await page.goto("/");
    await page
      .getByRole("button", { name: "Explore the sample profile" })
      .click();
    const trigger = page
      .locator(".workspace-tools")
      .getByRole("button", { name, exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(component)).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    if (test.info().project.name === "chromium") {
      await page.screenshot({
        path: `docs/screenshots/${filename}.png`,
        fullPage: true,
      });
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
}

async function openSample(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}

test("a delayed publishing chunk restores the dialog label and content focus", async ({
  page,
}) => {
  let releaseChunk;
  await page.route("**/src/components/publish-dialog.js*", async (route) => {
    await new Promise((resolve) => {
      releaseChunk = resolve;
    });
    await route.continue();
  });
  await page.route("**/api/publishing/session", (route) =>
    route.fulfill({ json: { configured: false } }),
  );
  await openSample(page);

  await page.getByRole("button", { name: "Publish to GitHub" }).click();
  await expect(page.getByText("Loading publishing tools…")).toBeVisible();
  await expect.poll(() => Boolean(releaseChunk)).toBe(true);
  releaseChunk();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("aria-label", "Publish to GitHub");
  await expect(
    page.getByRole("button", { name: "Download README fallback" }),
  ).toBeFocused();
});

test("closing a publishing dialog before its chunk loads leaves it closed", async ({
  page,
}) => {
  let releaseChunk;
  await page.route("**/src/components/publish-dialog.js*", async (route) => {
    await new Promise((resolve) => {
      releaseChunk = resolve;
    });
    await route.continue();
  });
  await page.route("**/api/publishing/session", (route) =>
    route.fulfill({ json: { configured: false } }),
  );
  await openSample(page);
  const trigger = page.getByRole("button", { name: "Publish to GitHub" });

  await trigger.click();
  await expect(page.getByText("Loading publishing tools…")).toBeVisible();
  await expect.poll(() => Boolean(releaseChunk)).toBe(true);
  await page.keyboard.press("Escape");
  releaseChunk();

  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("a failed publishing chunk reports a visible load error", async ({
  page,
}) => {
  await page.route("**/src/components/publish-dialog.js*", (route) =>
    route.abort("failed"),
  );
  await openSample(page);

  await page.getByRole("button", { name: "Publish to GitHub" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "Publishing tools could not be loaded. Close this dialog and try again.",
  );
});
