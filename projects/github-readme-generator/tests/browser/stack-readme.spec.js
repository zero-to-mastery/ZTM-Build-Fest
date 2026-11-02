import { test, expect } from "@playwright/test";

async function suggestions(page, { python = false } = {}) {
  await page.route("https://api.github.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/users/"))
      return route.fulfill({
        json: [
          {
            name: "app",
            full_name: "example/app",
            default_branch: "main",
            language: "JavaScript",
          },
        ],
      });
    if (url.includes("package.json")) {
      const source = JSON.stringify({
        name: "@example/app",
        packageManager: "pnpm@10.0.0",
        scripts: {
          test: "globalThis.executed=true",
          build: "globalThis.executed=true",
        },
        dependencies: { react: "19" },
        peerDependencies: { vue: "3" },
      });
      return route.fulfill({
        json: {
          type: "file",
          path: "package.json",
          size: Buffer.byteLength(source),
          encoding: "base64",
          content: Buffer.from(source).toString("base64"),
          sha: "a".repeat(40),
        },
      });
    }
    if (url.includes("pyproject.toml")) {
      const source = '[project]\nname="sample"';
      return route.fulfill({
        json: {
          type: "file",
          path: "pyproject.toml",
          size: Buffer.byteLength(source),
          encoding: "base64",
          content: Buffer.from(source).toString("base64"),
          sha: "b".repeat(40),
        },
      });
    }
    if (url.includes("requirements.txt")) {
      const source = "requests>=2";
      return route.fulfill({
        json: {
          type: "file",
          path: "requirements.txt",
          size: Buffer.byteLength(source),
          encoding: "base64",
          content: Buffer.from(source).toString("base64"),
          sha: "c".repeat(40),
        },
      });
    }
    return route.fulfill({
      json: (python
        ? ["pyproject.toml", "requirements.txt"]
        : ["package.json"]
      ).map((path) => ({ type: "file", path })),
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the sample profile" })
    .click();
  const before = await page.evaluate(() =>
    structuredClone(document.querySelector("app-shell").store.draft),
  );
  await page.getByRole("button", { name: "README audit", exact: true }).click();
  await page.getByLabel("GitHub username", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Load repositories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select all filtered repositories" })
    .click();
  await page
    .getByLabel("Allow read-only manifest analysis for this session")
    .check();
  await page
    .getByRole("button", { name: "Analyze selected manifests" })
    .click();
  await expect(page.locator("repository-audit [data-status]")).toContainText(
    "Manifest analysis complete",
  );
  await page.locator("stack-results summary").click();
  await page.getByRole("button", { name: "Review README suggestions" }).click();
  await expect(page.locator("stack-readme-review h1")).toBeVisible();
  return before;
}

test("reviewed suggestions preserve blocks, source, undo and reload at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const before = await suggestions(page);
  const review = page.locator("stack-readme-review");
  expect(await review.locator("[data-choice]:checked").count()).toBe(0);
  await review
    .getByRole("checkbox", { name: "Testing command", exact: true })
    .check();
  const confirmation = review.getByLabel(
    "I confirm Testing command is true for this repository.",
  );
  const testing = confirmation.locator("xpath=ancestor::section");
  await expect(testing.locator("[data-provenance]")).toContainText(
    /Testing command.*Manifest package\.json.*section scripts\.test.*Repository example\/app.*Project boundary: Repository root.*on main/,
  );
  await expect(testing.locator("[data-blob] .sr-only")).toHaveText(
    "SHA " + "a".repeat(40),
  );
  await expect(
    review.getByRole("button", { name: "Review exact diff" }),
  ).toBeDisabled();
  await confirmation.check();
  await review.getByRole("button", { name: "Review exact diff" }).click();
  const apply = review.getByRole("button", {
    name: "Append reviewed suggestions",
  });
  await expect(apply).toBeDisabled();
  await expect(review.locator("[data-after]")).toHaveValue(
    before.markdown + "\n\n## Testing\n\n```sh\npnpm run test\n```",
  );
  await review
    .getByLabel("I reviewed this exact change and each selected suggestion")
    .check();
  await review
    .getByLabel("Testing command Markdown", { exact: true })
    .fill("## Testing\n\nReviewed command: `pnpm run test`");
  await expect(confirmation).not.toBeChecked();
  await expect(review.locator("[data-review]")).toBeHidden();
  await confirmation.check();
  await review.getByRole("button", { name: "Review exact diff" }).click();
  await review
    .getByLabel("I reviewed this exact change and each selected suggestion")
    .check();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await apply.focus();
  await page.keyboard.press("Enter");
  const after = await page.evaluate(() =>
    structuredClone(document.querySelector("app-shell").store.draft),
  );
  expect(after.markdown).toBe(
    before.markdown + "\n\n## Testing\n\nReviewed command: `pnpm run test`",
  );
  expect(after.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
  expect(after.metadata).toEqual(before.metadata);
  expect(await page.evaluate(() => window.executed)).toBeUndefined();
  await page.evaluate(() => document.querySelector("app-shell").store.undo());
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe(before.markdown);
  await page.evaluate(() => document.querySelector("app-shell").store.redo());
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("app-shell").store?.draft.markdown,
      ),
    )
    .toBe(after.markdown);
});

test("stale draft cannot be overwritten and escape discards review", async ({
  page,
}) => {
  await suggestions(page);
  const review = page.locator("stack-readme-review");
  await review
    .getByRole("checkbox", { name: "Detected stack section", exact: true })
    .check();
  await review
    .getByLabel("I confirm Detected stack section is true for this repository.")
    .check();
  await review.getByRole("button", { name: "Review exact diff" }).click();
  await review
    .getByLabel("I reviewed this exact change and each selected suggestion")
    .check();
  await page.evaluate(() =>
    document.querySelector("app-shell").store.raw("# Newer source"),
  );
  await review
    .getByRole("button", { name: "Append reviewed suggestions" })
    .click();
  await expect(review.locator("[data-status]")).toContainText("draft changed");
  expect(
    await page.evaluate(
      () => document.querySelector("app-shell").store.draft.markdown,
    ),
  ).toBe("# Newer source");
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "README audit", exact: true }),
  ).toBeFocused();
});

test("technologies with only uncertain evidence are offered separately with their basis", async ({
  page,
}) => {
  await suggestions(page);
  const review = page.locator("stack-readme-review");
  const stack = review.locator("section").filter({
    has: page.getByRole("checkbox", {
      name: "Detected stack section",
      exact: true,
    }),
  });
  await expect(
    stack.getByLabel("Detected stack section Markdown", { exact: true }),
  ).toHaveValue("## Detected stack\n\n- Core: JavaScript · React");
  await expect(stack).toContainText("React: Manifest package.json");
  await expect(stack).toContainText("section dependencies · basis: explicit");
  await expect(stack).not.toContainText("Vue:");
  await expect(
    review.getByRole("checkbox", { name: "Vue badge", exact: true }),
  ).toHaveCount(0);
  const uncertain = review.locator("section").filter({
    has: page.getByRole("checkbox", {
      name: "Technologies with only uncertain evidence",
      exact: true,
    }),
  });
  await expect(uncertain).toContainText(
    "Vue: Manifest package.json · section peerDependencies · basis: conditional",
  );
  await expect(uncertain).toContainText(
    "every declaration of Vue is conditional or ambiguous",
  );
  await expect(
    review.getByRole("checkbox", {
      name: "Technologies with only uncertain evidence",
      exact: true,
    }),
  ).not.toBeChecked();
});

test("duplicate Python suggestion titles have Manifest-specific accessible names", async ({
  page,
}) => {
  await suggestions(page, { python: true });
  const review = page.locator("stack-readme-review");
  for (const manifest of ["pyproject.toml", "requirements.txt"]) {
    await expect(
      review.getByRole("checkbox", {
        name: `Python package manager suggestion — ${manifest}`,
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      review.getByLabel(
        `I confirm Python package manager suggestion — ${manifest} is true for this repository.`,
      ),
    ).toHaveCount(1);
    await expect(
      review.getByLabel(
        `Python package manager suggestion — ${manifest} Markdown`,
        { exact: true },
      ),
    ).toHaveCount(1);
  }
});
