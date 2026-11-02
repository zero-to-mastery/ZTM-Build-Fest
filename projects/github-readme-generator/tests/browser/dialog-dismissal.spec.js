import { test, expect } from "@playwright/test";
async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}
test("Escape and outside clicks close dialogs and return focus without dismissing content clicks or drags", async ({
  page,
}) => {
  await start(page);
  const trigger = page.getByRole("button", { name: "Manage drafts" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const bounds = await dialog.boundingBox();
  await page.mouse.click(bounds.x + 5, bounds.y + 5);
  await expect(dialog).toBeVisible();
  const input = await dialog
    .getByLabel("Draft name", { exact: true })
    .boundingBox();
  await page.mouse.move(input.x + 10, input.y + 10);
  await page.mouse.down();
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});
test("outside dismissal respects unsaved edits on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await start(page);
  const trigger = page.getByRole("button", {
    name: "Visual theme",
    exact: true,
  });
  await trigger.click();
  await page.getByLabel("accent hex", { exact: true }).fill("123456");
  page.once("dialog", (d) => d.dismiss());
  await page.mouse.click(2, 2);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("accent hex", { exact: true })).toHaveValue(
    "123456",
  );
  page.once("dialog", (d) => d.accept());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(trigger).toBeFocused();
});
