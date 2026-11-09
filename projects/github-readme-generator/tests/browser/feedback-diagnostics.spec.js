import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });

async function start(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}

test("feedback export is explicit, local-only, redacted and source-preserving", async ({
  page,
}) => {
  await start(page);
  const source = "# Private project\n\nKeep this exact.";
  await editor(page).fill(source);
  await expect(page.locator(".save-status")).toHaveText("Saved locally", {
    timeout: 5_000,
  });
  const before = await page.evaluate(() =>
    localStorage.getItem("readme-studio:v1"),
  );
  const requests = [];
  page.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );

  await page
    .locator('.workspace-tools [data-action="feedback-diagnostics"]')
    .click();
  const dialog = page.getByRole("dialog");
  const review = dialog.getByRole("button", {
    name: "Review local diagnostic",
  });
  const download = dialog.getByRole("button", {
    name: "Download redacted diagnostic",
  });
  await expect(review).toBeDisabled();
  await expect(download).toBeDisabled();
  await expect(dialog).toContainText("Nothing is sent");

  await dialog.getByLabel("I choose to create a local diagnostic").check();
  await dialog.getByLabel("Task").selectOption("offline-recovery");
  await dialog.getByLabel("Outcome").selectOption("completed-with-friction");
  await dialog.getByLabel("Recovery wording").check();
  await review.click();
  await expect(dialog).toContainText("accepts no free text");
  await expect(dialog.locator("pre")).not.toContainText("Private project");
  await expect(download).toBeEnabled();

  const event = page.waitForEvent("download");
  await download.click();
  const report = JSON.parse(readFileSync(await (await event).path(), "utf8"));
  expect(report.feedback).toMatchObject({
    scenario: "offline-recovery",
    outcome: "completed-with-friction",
    friction: ["recovery-copy"],
  });
  expect(JSON.stringify(report)).not.toContain("Private project");
  expect(JSON.stringify(report)).not.toContain("example.com");
  expect(await editor(page).inputValue()).toBe(source);
  expect(
    await page.evaluate(() => localStorage.getItem("readme-studio:v1")),
  ).toBe(before);
  expect(
    requests.filter(
      (request) =>
        request.method !== "GET" ||
        new URL(request.url).origin !== new URL(page.url()).origin,
    ),
  ).toEqual([]);
});

test("closing feedback without opting in creates no report or persistent state", async ({
  page,
}) => {
  await start(page);
  const before = await page.evaluate(() =>
    localStorage.getItem("readme-studio:v1"),
  );
  await page
    .locator('.workspace-tools [data-action="feedback-diagnostics"]')
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(
    await page.evaluate(() => localStorage.getItem("readme-studio:v1")),
  ).toBe(before);
});
