import { test, expect } from "@playwright/test";

const editor = (page) =>
  page.getByRole("textbox", { name: "Markdown editor", exact: true });

async function sample(page) {
  await page.route("https://**/*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" />',
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
}

test("a Restorable Detachment is reviewed explicitly, refreshes stale source and undoes", async ({
  page,
}) => {
  await sample(page);
  const before = await editor(page).inputValue();
  const changed = before.replace(
    "Building thoughtful software, one commit at a time.",
    "Changed directly in Markdown.",
  );
  await editor(page).fill(changed);
  const review = page
    .locator(".block-row")
    .first()
    .getByRole("button", { name: /Review visual version/ });
  await expect(review).toBeVisible();

  await review.click();
  await expect(
    page.getByRole("heading", { name: "Ownership review" }),
  ).toBeVisible();
  await expect(page.getByLabel("Original — current Markdown")).toHaveValue(
    /Changed directly in Markdown/,
  );
  await expect(page.getByLabel("Proposed — visual version")).toHaveValue(
    /Building thoughtful software/,
  );
  await expect(
    page.getByRole("button", { name: "Keep my Markdown" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveValue(changed);

  await review.click();
  const changedAgain = changed.replace(
    "Changed directly in Markdown.",
    "Changed again while review is open.",
  );
  await page.locator("app-shell").evaluate((app, markdown) => {
    app.store.raw(markdown);
  }, changedAgain);
  await page.getByRole("button", { name: "Use visual version" }).click();
  await expect(page.locator("ownership-review [data-status]")).toContainText(
    "comparison has been refreshed",
  );
  await expect(page.getByLabel("Original — current Markdown")).toHaveValue(
    /Changed again while review is open/,
  );
  await expect(editor(page)).toHaveValue(changedAgain);

  await page.getByRole("button", { name: "Use visual version" }).click();
  await expect(editor(page)).toHaveValue(before);
  await expect(page.locator(".toast")).toHaveText(
    "Visual version applied. Undo restores your previous Markdown and ownership.",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue(changedAgain);
  await expect(review).toBeVisible();
});

test("a component detached after its visual form opened uses Ownership review", async ({
  page,
}) => {
  await sample(page);
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page
    .getByLabel("Search components", { exact: true })
    .fill("terminal heading");
  await page
    .getByRole("button", { name: "Preview Terminal heading", exact: true })
    .click();
  await page.getByLabel("Title", { exact: true }).fill("First heading");
  await page
    .getByRole("button", { name: "Insert component", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Edit visually: Terminal heading/ })
    .click();
  await page.locator('[data-custom-field="title"]').fill("Visual proposal");
  await page.locator("app-shell").evaluate((app) => {
    app.store.raw(
      app.store.draft.markdown.replace(
        "First heading",
        "Changed directly in Markdown",
      ),
    );
  });

  await page
    .getByRole("button", { name: "Save component changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ownership review" }),
  ).toBeVisible();
  await expect(page.getByLabel("Original — current Markdown")).toHaveValue(
    /Changed directly in Markdown/,
  );
  await expect(page.getByLabel("Proposed — visual version")).toHaveValue(
    /Visual proposal/,
  );
  await expect(
    page.getByRole("button", { name: "Keep my Markdown" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Use visual version" }).click();
  await expect(editor(page)).toHaveValue(/Visual proposal/);
  await expect(editor(page)).not.toHaveValue(/Changed directly in Markdown/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor(page)).toHaveValue(/Changed directly in Markdown/);
});

test("a stale builder save cannot overwrite a concurrent raw edit", async ({
  page,
}) => {
  await sample(page);
  await page.locator(".block-row .block-open").first().click();
  await expect(page.locator("builder-form")).toBeVisible();
  await page.locator("app-shell").evaluate((app) => {
    const proposed = structuredClone(app.querySelector("builder-form").value);
    proposed.settings.subtitle = "Visual builder proposal";
    app.store.raw(
      app.store.draft.markdown.replace(
        "Building thoughtful software, one commit at a time.",
        "Concurrent raw edit",
      ),
    );
    app.dispatchEvent(
      new CustomEvent("commit", { detail: proposed, bubbles: true }),
    );
  });

  await expect(
    page.getByRole("heading", { name: "Ownership review" }),
  ).toBeVisible();
  await expect(page.getByLabel("Original — current Markdown")).toHaveValue(
    /Concurrent raw edit/,
  );
  await expect(page.getByLabel("Proposed — visual version")).toHaveValue(
    /Visual builder proposal/,
  );
  await expect(editor(page)).toHaveValue(/Concurrent raw edit/);
  await page.getByRole("button", { name: "Keep my Markdown" }).click();
  await expect(editor(page)).toHaveValue(/Concurrent raw edit/);
  await expect(editor(page)).not.toHaveValue(/Visual builder proposal/);
});
