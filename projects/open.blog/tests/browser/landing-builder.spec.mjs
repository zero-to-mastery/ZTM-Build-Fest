import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// The Landing page builder in Admin (ADR 0249, #316), from the real binary and the real Admin
// Studio: add, edit, reorder (buttons and keyboard), hide, delete and undo, inline validation in
// plain words, and no field anywhere that takes HTML or CSS.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

const landingFile = () => join(root, "content", "landing.json");
const stored = () => JSON.parse(readFileSync(landingFile(), "utf8"));
const seed = (sections) => writeFileSync(landingFile(), JSON.stringify({ format: "openblog-landing", version: 1, sections }));
const THREE = () => [
  { id: "hello", type: "welcome", heading: "Hello there", subheading: "A friendly place." },
  { id: "text", type: "rich-text", markdown: "About this blog." },
  { id: "latest", type: "latest-posts", heading: "Newest" },
];

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-landing-builder-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\n---\nA post.\n");
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Builder", url: "https://builder.example.org", author: { name: "Site Author" }, home: { heading: "Fresh writing", intro: "Welcome to my blog." } }));
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
  }
});

test.beforeEach(({ page }) => {
  rmSync(landingFile(), { force: true });
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
});

async function openLanding(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/#/landing`);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
}

const order = (page) => page.locator("[data-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.section));
const card = (page, id) => page.locator(`[data-section="${id}"]`);

test("a site with no landing page starts from what visitors see now and changes nothing until saved", async ({ page }) => {
  await openLanding(page);
  await expect(page.locator("[data-landing-legacy]")).toContainText("You have not built a landing page yet");
  expect(await order(page)).toEqual(["intro", "latest", "series"]);
  await expect(page.locator("[data-landing-count]")).toHaveText("3 of 40 sections");
  expect(existsSync(landingFile())).toBe(false);
});

test("Add a section lists every type in plain words with a sample, and adds the choice with a form", async ({ page }) => {
  await openLanding(page);
  await page.getByRole("button", { name: "Add a section" }).click();
  const picker = page.locator("#oba-landing-picker");
  await expect(picker.getByRole("heading", { name: "What would you like to add?" })).toBeVisible();
  await expect(picker.locator("[data-add-type]")).toHaveCount(15);
  await expect(picker.locator('[data-add-type="welcome"]')).toContainText("A big welcome with a button.");
  await expect(picker.locator('[data-add-type="welcome"]')).toContainText("For example:");
  await picker.locator('[data-add-type="rich-text"]').click();
  await expect(picker).toBeHidden();
  const added = card(page, "rich-text");
  await expect(added.getByRole("textbox", { name: "Your text (optional)" })).toBeFocused();
  await added.getByRole("textbox", { name: "Your text (optional)" }).fill("Hello from the builder.");
  await expect(added.locator(".oba-landing-card-summary")).toHaveText("Hello from the builder.");
  await added.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections.at(-1)).toEqual({ id: "rich-text", type: "rich-text", markdown: "Hello from the builder." });
});

test("Escape closes the picker and puts focus back on the button that opened it", async ({ page }) => {
  await openLanding(page);
  const add = page.getByRole("button", { name: "Add a section" });
  await add.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#oba-landing-picker")).toBeHidden();
  await expect(add).toBeFocused();
});

test("an edit form has typed inputs only: nothing takes HTML or CSS", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  for (const id of ["hello", "text", "latest"]) {
    await card(page, id).getByRole("button", { name: /^Edit/ }).click();
    const names = await card(page, id).locator("input, textarea, select").evaluateAll((nodes) => nodes.map((node) => `${node.id} ${node.name} ${node.type}`.toLowerCase()));
    for (const name of names) expect(name).not.toMatch(/html|css|style|script|markup/);
    await card(page, id).getByRole("button", { name: "Done" }).click();
  }
  await page.getByRole("button", { name: "Add a section" }).click();
  await expect(page.locator("#oba-landing-picker")).not.toContainText(/\bHTML\b|\bCSS\b/);
  // Markup typed into a text field stays text.
  await card(page, "text").getByRole("button", { name: /^Edit/ }).click();
  await card(page, "text").getByRole("textbox", { name: "Your text (optional)" }).fill("<script>window.__x=1</script> plain");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  // The text is kept as words; the editor only escapes the characters Markdown would read.
  expect(stored().sections[1].markdown).toBe("&lt;script>window.\\_\\_x=1&lt;/script> plain");
  expect(await page.evaluate(() => window.__x)).toBeUndefined();
});

test("a field explains what is wrong in plain words once it has been left, and Save refuses with the reason", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  const heading = card(page, "hello").getByLabel("Welcome heading");
  await heading.fill("");
  await expect(card(page, "hello").locator(".oba-field-error:not([hidden])")).toHaveCount(0);
  await heading.blur();
  await expect(card(page, "hello").locator(".oba-field-error:not([hidden])")).toHaveText("Welcome heading is needed. Fill it in before you save.");
  await expect(heading).toHaveAttribute("aria-invalid", "true");
  await expect(heading).toHaveAccessibleDescription(/Welcome heading is needed/);
  await expect(card(page, "hello").locator(".oba-landing-attention")).toHaveText("1 thing needs attention");
  const before = readFileSync(landingFile(), "utf8");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Nothing was saved: 1 thing needs attention");
  expect(readFileSync(landingFile(), "utf8")).toBe(before);
  await heading.fill("Hello again");
  await expect(card(page, "hello").locator(".oba-field-error:not([hidden])")).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections[0].heading).toBe("Hello again");
});

test("an address and an email are checked as they are typed, with the fix in words", async ({ page }) => {
  seed([{ id: "go", type: "buttons", items: [{ label: "Read", href: "/archive/", style: "primary" }] }, { id: "c", type: "contact", email: "me@example.com" }]);
  await openLanding(page);
  await card(page, "go").getByRole("button", { name: /^Edit/ }).click();
  const href = card(page, "go").getByLabel("Where it goes");
  await expect(href).toHaveAttribute("type", "url");
  await href.fill("http://example.com");
  await href.blur();
  await expect(card(page, "go").locator(".oba-field-error:not([hidden])")).toHaveText("Use https:// rather than http://.");
  await card(page, "c").getByRole("button", { name: /^Edit/ }).click();
  await expect(card(page, "c").getByLabel("Email (optional)")).toHaveAttribute("type", "email");
  await expect(card(page, "c").getByLabel("Phone number (optional)")).toHaveAttribute("type", "tel");
  const email = card(page, "c").getByLabel("Email (optional)");
  await email.fill("not-an-email");
  await email.blur();
  await expect(card(page, "c").locator(".oba-field-error:not([hidden])")).toHaveText("That does not look like an email address. Write it like name@example.com.");
});

test("sections move with real buttons, with the keyboard, and the result is announced", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  const down = (id) => card(page, id).locator('[data-action="move-down"]');
  const up = (id) => card(page, id).locator('[data-action="move-up"]');
  await expect(up("hello")).toBeDisabled();
  await expect(down("latest")).toBeDisabled();
  await expect(down("hello")).toHaveAccessibleName("Move down, Welcome banner “Hello there” (section 1 of 3)");
  await down("hello").click();
  expect(await order(page)).toEqual(["text", "hello", "latest"]);
  await expect(page.locator("[data-landing-status]")).toHaveText("Welcome banner moved down to position 2 of 3.");
  await expect(down("hello")).toBeFocused();
  // The keyboard alone: Tab to a button and press Enter or Space.
  await down("hello").focus();
  await page.keyboard.press("Enter");
  expect(await order(page)).toEqual(["text", "latest", "hello"]);
  // At the end of the list Move down is disabled, so focus passes to Move up.
  await expect(up("hello")).toBeFocused();
  await page.keyboard.press("Space");
  expect(await order(page)).toEqual(["text", "hello", "latest"]);
  // Alt with the arrow keys moves the focused card too.
  await up("hello").focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await order(page)).toEqual(["hello", "text", "latest"]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections.map((section) => section.id)).toEqual(["hello", "text", "latest"]);
});

test("hide keeps a section and says so; show brings it back", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  const hide = card(page, "text").locator('[data-action="hide"]');
  await expect(hide).toHaveText("Hide");
  await hide.click();
  await expect(card(page, "text")).toContainText("hidden from visitors");
  await expect(hide).toHaveText("Show");
  await expect(hide).toHaveAttribute("aria-pressed", "true");
  await expect(hide).toBeFocused();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections[1].hidden).toBe(true);
  await hide.click();
  await expect(page.locator("[data-landing-status]")).toContainText("is shown to visitors again");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections[1].hidden).toBeUndefined();
});

test("delete is undone into the same place, by button or after moving on", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  await card(page, "text").locator('[data-action="delete"]').click();
  expect(await order(page)).toEqual(["hello", "latest"]);
  await expect(page.locator("[data-landing-toast]")).toContainText("Deleted Text");
  // Focus moves to the card that took its place.
  await expect(card(page, "latest").getByRole("button", { name: /^Edit/ })).toBeFocused();
  await page.locator('[data-landing-toast] [data-action="undo"]').click();
  expect(await order(page)).toEqual(["hello", "text", "latest"]);
  await expect(page.locator("[data-landing-toast]")).toBeHidden();
  await expect(card(page, "text").getByRole("button", { name: /^Edit/ })).toBeFocused();
  // Nothing was written by any of that.
  expect(stored().sections.map((section) => section.id)).toEqual(["hello", "text", "latest"]);
  // Deleting the last card moves focus to Add a section; Dismiss keeps the deletion.
  await card(page, "latest").locator('[data-action="delete"]').click();
  await card(page, "text").locator('[data-action="delete"]').click();
  await card(page, "hello").locator('[data-action="delete"]').click();
  await expect(page.getByRole("button", { name: "Add a section" })).toBeFocused();
  await expect(page.locator("[data-landing-empty]")).toBeVisible();
  await page.locator('[data-landing-toast] [data-action="dismiss-undo"]').click();
  await expect(page.locator("[data-landing-toast]")).toBeHidden();
  expect(await order(page)).toEqual([]);
});

test("lists add and remove rows with real buttons and keep their labels", async ({ page }) => {
  seed([{ id: "faq", type: "faq", items: [{ question: "Is it free?", answer: "Yes." }] }]);
  await openLanding(page);
  await card(page, "faq").getByRole("button", { name: /^Edit/ }).click();
  await card(page, "faq").getByRole("button", { name: "Add another question" }).click();
  await expect(card(page, "faq").getByLabel("Question", { exact: true })).toHaveCount(2);
  await card(page, "faq").getByLabel("Question", { exact: true }).nth(1).fill("Why?");
  await card(page, "faq").getByLabel("Answer", { exact: true }).nth(1).fill("Because.");
  await card(page, "faq").getByRole("button", { name: "Remove Question 1" }).click();
  await expect(card(page, "faq").getByLabel("Question", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections[0].items).toEqual([{ question: "Why?", answer: "Because." }]);
});

test("a featured post is chosen from the published posts by name", async ({ page }) => {
  await openLanding(page);
  await page.getByRole("button", { name: "Add a section" }).click();
  await page.locator('[data-add-type="featured-post"]').click();
  const pick = card(page, "featured-post").getByLabel("Which post");
  await expect(pick).toHaveJSProperty("tagName", "SELECT");
  await pick.selectOption({ label: "One" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections.at(-1)).toMatchObject({ type: "featured-post", post: "one" });
});

// ----- the live preview (ADR 0250, #327)

const preview = (page) => page.frameLocator("[data-landing-frame]");
const watchRequests = (page) => {
  const seen = [];
  page.on("request", (request) => seen.push({ method: request.method(), url: request.url() }));
  return seen;
};

test.describe("preview beside the builder on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("shows unsaved edits within a second or two, matches the built page, and writes nothing", async ({ page }) => {
    seed(THREE());
    const before = readFileSync(landingFile(), "utf8");
    const seen = watchRequests(page);
    await openLanding(page);
    await expect(page.locator("[data-landing-side]")).toBeVisible();
    await expect(preview(page).getByRole("heading", { name: "Hello there" })).toBeVisible();
    // An unsaved edit appears in the preview.
    await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
    await card(page, "hello").getByLabel("Welcome heading").fill("A brand new welcome");
    await expect(preview(page).getByRole("heading", { name: "A brand new welcome" })).toBeVisible({ timeout: 2500 });
    // A moved section changes the order in the preview.
    await card(page, "hello").getByRole("button", { name: "Done" }).click();
    await card(page, "hello").locator('[data-action="move-down"]').click();
    await expect.poll(async () => preview(page).locator(".ob-home-section").evaluateAll((nodes) => nodes.map((node) => node.id)), { timeout: 2500 }).toEqual(["ob-home-text", "ob-home-hello", "ob-home-latest"]);
    // Nothing is stored and nothing was saved or published to get here.
    expect(readFileSync(landingFile(), "utf8")).toBe(before);
    expect(seen.filter((r) => r.url.includes("/admin/api/") && !["GET", "POST"].includes(r.method))).toEqual([]);
    expect(seen.filter((r) => r.method === "POST" && !/\/admin\/api\/(landing\/preview|login)$/.test(r.url))).toEqual([]);
    // Parity: once saved, the built home page has the same sections in the same order and text.
    const shown = await preview(page).locator(".ob-home-section").evaluateAll((nodes) => nodes.map((node) => ({ id: node.id, text: node.innerText.replace(/\s+/g, "") })));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
    const html = await (await page.request.get(`${origin}/`)).text();
    const built = await page.evaluate((markup) => {
      const doc = new DOMParser().parseFromString(markup, "text/html");
      return [...doc.querySelectorAll(".ob-home-section")].map((node) => ({ id: node.id, text: node.textContent.replace(/\s+/g, "") }));
    }, html);
    expect(built.map((section) => section.id)).toEqual(shown.map((section) => section.id));
    expect(built.map((section) => section.id)).toEqual(["ob-home-text", "ob-home-hello", "ob-home-latest"]);
    for (const [index, section] of shown.entries()) expect(built[index].text).toBe(section.text);
  });

  test("the preview is open beside the builder from the start, and Hide preview and Preview toggle it", async ({ page }) => {
    seed(THREE());
    await openLanding(page);
    const toggle = page.locator('[data-action="preview"]');
    await expect(toggle).toHaveText("Hide preview");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-landing-side]")).toBeVisible();
    const builder = await page.locator(".oba-landing").boundingBox();
    const side = await page.locator("[data-landing-side]").boundingBox();
    expect(side.x).toBeGreaterThan(builder.x + builder.width - 2);
    await toggle.click();
    await expect(page.locator("[data-landing-side]")).toBeHidden();
    await expect(toggle).toHaveText("Preview");
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(page.locator("[data-landing-side]")).toBeVisible();
    await expect(preview(page).getByRole("heading", { name: "Hello there" })).toBeVisible();
  });

  test("the size switch is keyboard operable, announces the active size and scales the frame", async ({ page }) => {
    seed(THREE());
    await openLanding(page);
    await expect(page.locator("[data-landing-side]")).toBeVisible();
    const group = page.getByRole("group", { name: "Preview size" });
    await expect(group.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true");
    const frame = page.locator("[data-landing-frame]");
    await expect(frame).toHaveCSS("width", "375px");
    await group.getByRole("button", { name: "Tablet" }).focus();
    await page.keyboard.press("Enter");
    await expect(group.getByRole("button", { name: "Tablet" })).toHaveAttribute("aria-pressed", "true");
    await expect(group.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-preview-status]")).toHaveText("Tablet view, 768 pixels wide.");
    await expect(frame).toHaveCSS("width", "768px");
    await expect(frame).toHaveAccessibleName(/tablet view/);
    await group.getByRole("button", { name: "Desktop" }).focus();
    await page.keyboard.press("Space");
    await expect(page.locator("[data-preview-status]")).toHaveText("Desktop view, 1280 pixels wide.");
    // The frame is scaled to the space it has, so it never grows wider than its column.
    const box = await page.locator(".oba-landing-stage").boundingBox();
    const framed = await frame.boundingBox();
    expect(framed.width).toBeLessThanOrEqual(box.width + 1);
    await expect(preview(page).getByRole("heading", { name: "Hello there" })).toBeVisible();
  });

  test("a section that is not complete yet is left out of the preview, and the preview says so", async ({ page }) => {
    seed(THREE());
    await openLanding(page);
    await expect(page.locator("[data-landing-side]")).toBeVisible();
    await page.getByRole("button", { name: "Add a section" }).click();
    await page.locator('[data-add-type="image"]').click();
    await expect(page.locator("[data-preview-note]")).toHaveText("1 section needs attention and is left out of this preview. Open it and fix what is marked to see it here.", { timeout: 2500 });
    await expect(preview(page).getByRole("heading", { name: "Hello there" })).toBeVisible();
  });

  test("the preview loads nothing from outside this site and runs no scripts", async ({ page }) => {
    seed([{ id: "text", type: "rich-text", markdown: "<script>window.top.__pwned = 1</script> plain" }, ...THREE().slice(2)]);
    const seen = watchRequests(page);
    await openLanding(page);
    await expect(page.locator("[data-landing-side]")).toBeVisible();
    await expect(preview(page).locator("#ob-home-text")).toBeVisible();
    await expect(preview(page).locator("#ob-home-text")).toContainText("<script>window.top.__pwned = 1</script>");
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    const outside = seen.filter((request) => /^https?:/.test(request.url) && !request.url.startsWith(origin));
    expect(outside).toEqual([]);
  });
});

test.describe("preview as a full-screen sheet on a phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("opens over the builder with an obvious Back, keeps focus inside, and returns focus", async ({ page }) => {
    seed(THREE());
    const before = readFileSync(landingFile(), "utf8");
    await openLanding(page);
    const open = page.getByRole("button", { name: "Preview", exact: true });
    await open.click();
    const sheet = page.locator("[data-landing-sheet]");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Preview" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Back to editing" })).toBeFocused();
    await expect(page.locator("[data-landing-side]")).toBeHidden();
    await expect(preview(page).getByRole("heading", { name: "Hello there" })).toBeVisible();
    // The sheet fills the screen and the frame fits without sideways scrolling.
    const box = await sheet.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(374);
    expect(box.height).toBeGreaterThanOrEqual(660);
    expect(await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.getByRole("group", { name: "Preview size" }).getByRole("button", { name: "Desktop" }).click();
    expect(await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    // Tab never reaches the builder behind the sheet: focus is in the sheet, or has left the page.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => {
        const active = document.activeElement;
        return !active || active === document.body || Boolean(active.closest("[data-landing-sheet]"));
      })).toBe(true);
    }
    await page.locator("[data-landing-sheet]").getByRole("button", { name: "Back to editing" }).focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();
    // Back works too, and nothing was stored.
    await open.click();
    await sheet.getByRole("button", { name: "Back to editing" }).click();
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();
    expect(readFileSync(landingFile(), "utf8")).toBe(before);
  });
});

// ----- phone-first layout, touch targets and the persistent action bar (ADR 0251, #328)

const LONG = "an_extraordinarily_long_unbroken_word_that_must_wrap_instead_of_overflowing_a_small_screen_at_all_even_at_320";
const EVERY_TYPE = () => [
  { id: "hello", type: "welcome", heading: `Welcome ${LONG}`, subheading: "A friendly place to read.", image: { src: "/hero.svg", alt: "A hand-drawn door" }, button: { label: "Start reading", href: "/one/" } },
  { id: "text", type: "rich-text", markdown: `## About\n\nSome *rich* text and ${LONG}.` },
  { id: "latest", type: "latest-posts", heading: "Newest", count: 3 },
  { id: "series", type: "series", heading: "Series" },
  { id: "pick", type: "featured-post", post: "one", heading: "Start here" },
  { id: "go", type: "buttons", items: [{ label: "Email me", href: "mailto:me@example.com" }, { label: "Docs", href: "https://example.com/docs", style: "secondary" }] },
  { id: "pic", type: "image", src: "/hero.svg", alt: "A hand-drawn door", caption: "The door" },
  { id: "vid", type: "video", provider: "youtube", video: "dQw4w9WgXcQ", title: "A short tour" },
  { id: "where", type: "map", provider: "openstreetmap", label: "12 High Street", lat: 51.5, lon: -0.12 },
  { id: "hours", type: "opening-hours", rows: [{ days: "Monday to Friday", hours: "9am to 5pm" }], note: "Closed on holidays" },
  { id: "contact", type: "contact", email: "me@example.com", phone: "+1 555 010 0100", address: `12 High Street ${LONG}` },
  { id: "social", type: "social-links", items: [{ label: "Mastodon", href: "https://example.social/@me" }] },
  { id: "faq", type: "faq", items: [{ question: "Is it free?", answer: "Yes, **always**." }] },
  { id: "note", type: "callout", tone: "warning", title: "Heads up", body: "Open late on Fridays." },
];

/** Open each card's editor in turn (one is open at a time) and run `check` with the form showing. */
async function eachEditor(page, check) {
  const count = await page.locator('[data-action="edit"]').count();
  for (let i = 0; i < count; i += 1) {
    await page.locator('[data-action="edit"]').nth(i).click();
    await check(i);
    await page.locator('[data-action="edit"]').nth(i).click();
  }
}

/** The things a person taps or types in, in the builder and the bar, that are on screen. */
const controls = (page) =>
  page.evaluate(() => {
    const regions = [...document.querySelectorAll(".oba-landing, .oba-landing-bar, [data-landing-side]")];
    const found = [];
    for (const region of regions) {
      for (const node of region.querySelectorAll("button, input, select, textarea, a[href]")) {
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height || node.closest("[hidden]")) continue;
        const labelled = node.matches("button, a") ? Boolean((node.getAttribute("aria-label") || node.textContent || "").trim()) : (node.labels?.length || 0) > 0 || Boolean(node.getAttribute("aria-label"));
        found.push({ tag: node.tagName.toLowerCase(), name: (node.getAttribute("aria-label") || node.textContent || node.id).trim().slice(0, 40), width: box.width, height: box.height, right: box.right, labelled });
      }
    }
    return found;
  });

const sideways = (page) =>
  page.evaluate(() => {
    const regions = [...document.querySelectorAll(".oba-landing-layout, .oba-landing-bar")];
    const width = document.documentElement.clientWidth;
    let widest = 0;
    let culprit = "";
    for (const region of regions) for (const node of region.querySelectorAll("*")) {
      if (node.closest("[data-landing-frame], iframe")) continue;
      const box = node.getBoundingClientRect();
      if (box.width && box.right > widest) {
        widest = box.right;
        culprit = `${node.tagName.toLowerCase()}.${node.className} ${(node.textContent || "").trim().slice(0, 30)}`;
      }
    }
    const wide = [...document.querySelectorAll(".oba-landing-layout *, .oba-landing-bar *")].filter((node) => !node.closest("iframe") && node.scrollWidth - node.clientWidth > 1 && getComputedStyle(node).overflowX === "visible").map((node) => `${node.tagName.toLowerCase()}.${node.className} +${node.scrollWidth - node.clientWidth}`);
    return { overflow: Math.max(...regions.map((region) => region.scrollWidth - region.clientWidth)), widest: widest - width, culprit: `${culprit} :: ${wide.slice(0, 4).join(" | ")}`, page: document.documentElement.scrollWidth - width };
  });

const SIZES = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "landscape 667x375", width: 667, height: 375 },
];

for (const size of SIZES) {
  test(`at ${size.name} nothing scrolls sideways, every control is at least 44px and named, and the bar is reachable`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    seed(EVERY_TYPE());
    await openLanding(page);
    let seen = 0;
    await eachEditor(page, async (index) => {
      const found = await controls(page);
      seen += found.length;
      for (const control of found) {
        expect(control.height, `card ${index}: ${control.tag} "${control.name}" height`).toBeGreaterThanOrEqual(43.5);
        expect(control.width, `card ${index}: ${control.tag} "${control.name}" width`).toBeGreaterThanOrEqual(43.5);
        expect(control.labelled, `card ${index}: ${control.tag} "${control.name}" has a name`).toBe(true);
      }
      const { overflow, widest, culprit } = await sideways(page);
      expect(overflow, `card ${index}: region scroll ${culprit}`).toBeLessThanOrEqual(0);
      expect(widest, `card ${index}: widest element past the screen edge: ${culprit}`).toBeLessThanOrEqual(1);
    });
    expect(seen).toBeGreaterThan(200);
    // The bar is always within reach: fixed to the bottom of a tall screen, in the flow of a short one.
    const bar = page.locator("[data-landing-bar]");
    await bar.scrollIntoViewIfNeeded();
    const box = await bar.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
    for (const name of ["Preview", "Hide preview", "Save", "Publish"]) {
      if (await bar.getByRole("button", { name, exact: true }).count()) await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(bar.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  });
}

test("on a tall phone screen the bar stays at the bottom while the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  seed(EVERY_TYPE());
  await openLanding(page);
  const bar = page.locator("[data-landing-bar]");
  const bottom = async () => (await bar.boundingBox()).y + (await bar.boundingBox()).height;
  expect(await bottom()).toBeGreaterThan(660);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  expect(await bottom()).toBeGreaterThan(660);
  expect(await bottom()).toBeLessThanOrEqual(668);
  await expect(bar.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
});

test("the bar never covers the field being edited, wherever it sits on the page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  seed(EVERY_TYPE());
  await openLanding(page);
  let checked = 0;
  await eachEditor(page, async () => {
    const fields = page.locator(".oba-landing-form").locator("input, select, textarea");
    const total = await fields.count();
    for (let i = 0; i < total; i += 1) {
      await fields.nth(i).focus();
      await page.waitForTimeout(40);
      const covered = await page.evaluate(() => {
        const bar = document.querySelector("[data-landing-bar]").getBoundingClientRect();
        const field = document.activeElement.getBoundingClientRect();
        return field.bottom - bar.top;
      });
      expect(covered, `field ${i} sits above the bar`).toBeLessThanOrEqual(1);
      checked += 1;
    }
  });
  expect(checked).toBeGreaterThan(30);
});

test("the bar rides above the on-screen keyboard when the visual viewport shrinks", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  seed(THREE());
  await openLanding(page);
  const bar = page.locator("[data-landing-bar]");
  // A keyboard covers the bottom of the layout viewport: simulate the visual viewport shrinking.
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    Object.defineProperty(viewport, "height", { configurable: true, value: 667 - 300 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => (await bar.boundingBox()).y + (await bar.boundingBox()).height).toBeLessThanOrEqual(667 - 300 + 1);
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    Object.defineProperty(viewport, "height", { configurable: true, value: 667 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => (await bar.boundingBox()).y + (await bar.boundingBox()).height).toBeGreaterThan(660);
});

// Text-only enlargement to 200% (WCAG 1.4.4). 400% is reflow: a 1280px page at 400% zoom is 320px wide, tested below (1.4.10).
for (const scale of [200]) {
  test(`with text at ${scale}% on a 320px screen every control is reachable and nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    seed(EVERY_TYPE());
    await openLanding(page);
    await page.evaluate((percent) => { document.documentElement.style.fontSize = `${percent}%`; }, scale);
    await eachEditor(page, async (index) => {
      const { overflow, widest, culprit } = await sideways(page);
      expect(overflow, `card ${index}: region scroll ${culprit}`).toBeLessThanOrEqual(0);
      expect(widest, `card ${index}: widest element past the screen edge: ${culprit}`).toBeLessThanOrEqual(1);
      for (const control of await controls(page)) expect(control.height, `card ${index}: ${control.name} height`).toBeGreaterThanOrEqual(43.5);
    });
    // The bar never fills a screen that large text leaves little room on: it is in the flow then.
    await page.locator("[data-landing-bar]").getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.locator("[data-landing-bar]").getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  });
}

test("a 1280x1024 page at 400% zoom is a 320px page and still works", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 256 } });
  const page = await context.newPage();
  seed(EVERY_TYPE());
  await openLanding(page);
  await eachEditor(page, async (index) => {
    const { overflow, widest, culprit } = await sideways(page);
    expect(overflow, `card ${index}`).toBeLessThanOrEqual(0);
    expect(widest, `card ${index}: ${culprit}`).toBeLessThanOrEqual(1);
  });
  await page.locator("[data-landing-bar]").getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.locator("[data-landing-bar]").getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await context.close();
});

test("the builder asks for the right keyboard and has no hover-only control", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  seed([EVERY_TYPE()[0], EVERY_TYPE()[10], EVERY_TYPE()[2]].map((section) => ({ ...section, id: section.type === "welcome" ? "hello" : section.type === "contact" ? "contact" : "latest" })));
  await openLanding(page);
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  await expect(card(page, "hello").getByLabel("Where it goes")).toHaveAttribute("type", "url");
  await expect(card(page, "hello").getByLabel("Where it goes")).toHaveAttribute("inputmode", "url");
  await expect(card(page, "hello").getByLabel("Picture address")).toHaveAttribute("type", "url");
  await card(page, "contact").getByRole("button", { name: /^Edit/ }).click();
  await expect(card(page, "contact").getByLabel("Email (optional)")).toHaveAttribute("type", "email");
  await expect(card(page, "contact").getByLabel("Email (optional)")).toHaveAttribute("inputmode", "email");
  await expect(card(page, "contact").getByLabel("Phone number (optional)")).toHaveAttribute("type", "tel");
  await card(page, "latest").getByRole("button", { name: /^Edit/ }).click();
  await expect(card(page, "latest").getByLabel("How many posts (optional)")).toHaveAttribute("type", "number");
  await expect(card(page, "latest").getByLabel("How many posts (optional)")).toHaveAttribute("inputmode", "numeric");
  // Nothing appears only on hover: every control is visible before the pointer goes near it.
  const hiddenUntilHover = await page.evaluate(() => [...document.querySelectorAll(".oba-landing button, .oba-landing-bar button")].filter((node) => {
    const style = getComputedStyle(node);
    return style.visibility === "hidden" || Number(style.opacity) < 0.5 && !node.disabled;
  }).length);
  expect(hiddenUntilHover).toBe(0);
});

test("reduced motion turns the builder's transitions off", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  seed(THREE());
  await openLanding(page);
  const timing = await page.evaluate(() => {
    const button = document.querySelector(".oba-landing-card .oba-btn");
    const style = getComputedStyle(button);
    return { transition: style.transitionDuration, transform: style.transform };
  });
  expect(timing.transition).toBe("0s");
  await page.locator(".oba-landing-card .oba-btn").first().hover();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".oba-landing-card .oba-btn")).transform)).toBe("none");
});

test("Publish says why it is off when the site is not a git repository, and the bar still saves", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  const publish = page.locator('[data-landing-bar] [data-action="publish"]');
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription(/not a git repository/);
  await expect(page.locator(".oba-landing-publish-note")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
});

test("Publish saves what is unsaved first, then publishes, and says what happened", async ({ page }) => {
  seed(THREE());
  const calls = [];
  await page.route("**/admin/api/publish", async (route) => {
    const request = route.request();
    calls.push(request.method());
    if (request.method() === "GET") await route.fulfill({ json: { repo: true, remote: "origin", changed: [], drafts: [], ahead: 0, behind: 0, auto: false } });
    else await route.fulfill({ json: { ok: true, message: "Published 1 change.", commit: "abc1234", pushed: true, committed: true, drafts: [] } });
  });
  await openLanding(page);
  const publish = page.locator('[data-landing-bar] [data-action="publish"]');
  await expect(publish).toBeEnabled();
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  await card(page, "hello").getByLabel("Welcome heading").fill("Published heading");
  await publish.click();
  await expect(page.locator("[data-landing-status]")).toHaveText("Published 1 change.");
  expect(stored().sections[0].heading).toBe("Published heading");
  expect(calls.filter((method) => method === "POST")).toEqual(["POST"]);
  // An invalid page is not published.
  await card(page, "hello").getByLabel("Welcome heading").fill("");
  await publish.click();
  await expect(page.locator("[data-landing-status]")).toContainText("Nothing was saved");
  expect(calls.filter((method) => method === "POST")).toEqual(["POST"]);
});

test("edits typed while a save is in flight are kept, still unsaved, and not overwritten", async ({ page }) => {
  seed(THREE());
  let release;
  const gate = new Promise((resolveGate) => (release = resolveGate));
  await page.route("**/admin/api/landing", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await openLanding(page);
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  const heading = card(page, "hello").getByLabel("Welcome heading");
  await heading.fill("First heading");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toHaveText("Saving…");
  await heading.fill("Typed while saving");
  release();
  await expect(page.locator("[data-landing-status]")).toContainText("still unsaved");
  await expect(page.locator("[data-landing-dirty]")).toContainText("unsaved changes");
  await expect(card(page, "hello").getByLabel("Welcome heading")).toHaveValue("Typed while saving");
  expect(stored().sections[0].heading).toBe("First heading");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(stored().sections[0].heading).toBe("Typed while saving");
});

test("Publish stops and keeps the build error when the saved page does not build", async ({ page }) => {
  seed(THREE());
  let publishes = 0;
  await page.route("**/admin/api/publish", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { repo: true, remote: "origin", changed: [], drafts: [], ahead: 0, behind: 0, auto: false } });
    publishes += 1;
    return route.fulfill({ json: { ok: true, message: "Published.", commit: "abc1234", pushed: true, committed: true, drafts: [] } });
  });
  await page.route("**/admin/api/landing", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, build: { ok: false, error: "template exploded" } } });
  });
  await openLanding(page);
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  await card(page, "hello").getByLabel("Welcome heading").fill("Does not build");
  await page.locator('[data-landing-bar] [data-action="publish"]').click();
  await expect(page.locator("[data-landing-status]")).toContainText("could not be rebuilt yet: template exploded");
  expect(publishes).toBe(0);
});


// ----- never lose work: local drafts, the leave guard and conflict recovery (ADR 0252, #329)

const DRAFT_KEY = "ob-landing-draft:writer";
const draftOf = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), DRAFT_KEY);
const status = (page) => page.locator("[data-landing-status]");
const save = (page) => page.getByRole("button", { name: "Save", exact: true });

async function editHeading(page, text) {
  await card(page, "hello").getByRole("button", { name: /^Edit/ }).click();
  await card(page, "hello").getByLabel("Welcome heading").fill(text);
}

test("a reload offers the unsaved changes back, and restoring them keeps them unsaved until Save", async ({ page }) => {
  seed(THREE());
  await openLanding(page);
  await editHeading(page, "Typed but never saved");
  await expect.poll(() => draftOf(page)).toMatchObject({ v: 1 });
  await expect(page.locator(".oba-landing-dirty")).toContainText("A copy is kept on this device");
  // Leaving a page with unsaved work is warned about; here the owner accepts, as a reload does.
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  const offer = page.locator("[data-landing-restore]");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Restore your unsaved changes?");
  // Nothing is applied unasked.
  await expect(card(page, "hello").locator(".oba-landing-card-summary")).toHaveText("Hello there");
  await offer.getByRole("button", { name: "Restore your unsaved changes" }).click();
  await expect(offer).toBeHidden();
  await expect(card(page, "hello").locator(".oba-landing-card-summary")).toHaveText("Typed but never saved");
  await expect(page.locator(".oba-landing-dirty")).toContainText("You have unsaved changes");
  expect(stored().sections[0].heading).toBe("Hello there");
  await save(page).click();
  await expect(status(page)).toContainText("Saved.");
  expect(stored().sections[0].heading).toBe("Typed but never saved");
  expect(await draftOf(page)).toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  await expect(page.locator("[data-landing-restore]")).toBeHidden();
});

test("a closed or crashed tab leaves the draft for the next one, and it can be thrown away", async ({ page, context }) => {
  seed(THREE());
  await openLanding(page);
  await card(page, "text").locator('[data-action="delete"]').click();
  await expect.poll(() => draftOf(page)).toMatchObject({ v: 1 });
  await page.close({ runBeforeUnload: false });
  const next = await context.newPage();
  await next.goto(`${origin}/admin/#/landing`);
  await expect(next.locator("[data-landing-restore]")).toBeVisible();
  await next.locator("[data-landing-restore]").getByRole("button", { name: "Discard them" }).click();
  await expect(next.locator("[data-landing-restore]")).toBeHidden();
  expect(await draftOf(next)).toBeNull();
  await expect(next.locator("[data-landing-status]")).toHaveText("Threw away the unsaved changes.");
  expect(await order(next)).toEqual(["hello", "text", "latest"]);
});

test("leaving with unsaved changes is warned about, and the work is still there if you stay or come back", async ({ page }) => {
  page.removeAllListeners("dialog");
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    if (dialogs.length === 1) await dialog.dismiss();
    else await dialog.accept();
  });
  seed(THREE());
  await openLanding(page);
  // Nothing unsaved: no warning, closing the page is not blocked.
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  await editHeading(page, "Half written");
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  // Moving to another part of Admin asks first; staying keeps everything.
  await page.getByRole("link", { name: "Pages", exact: true }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(/unsaved/i);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  await expect(card(page, "hello").getByLabel("Welcome heading")).toHaveValue("Half written");
  // Leaving anyway still keeps a copy on this device.
  await page.getByRole("link", { name: "Pages", exact: true }).click();
  await expect.poll(() => dialogs.length).toBe(2);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeHidden();
  await page.goto(`${origin}/admin/#/landing`);
  await expect(page.locator("[data-landing-restore]")).toBeVisible();
  // Once saved, leaving asks nothing.
  await page.locator("[data-landing-restore]").getByRole("button", { name: "Restore your unsaved changes" }).click();
  await save(page).click();
  await expect(status(page)).toContainText("Saved.");
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});

test.describe("a save that finds a newer page", () => {
  const newer = () => seed([{ id: "hello", type: "welcome", heading: "Written on another device" }, { id: "text", type: "rich-text", markdown: "About this blog." }, { id: "added", type: "callout", tone: "info", body: "Added elsewhere" }]);

  test("never overwrites silently: Compare lists the differences, and Keep mine replaces the newer page only when asked", async ({ page }) => {
    seed(THREE());
    await openLanding(page);
    await editHeading(page, "Written on this device");
    newer();
    const onDisk = readFileSync(landingFile(), "utf8");
    await save(page).click();
    const box = page.locator("[data-landing-conflict]");
    await expect(box).toBeVisible();
    await expect(box.getByRole("heading", { name: "This page was changed somewhere else" })).toBeFocused();
    await expect(box.getByRole("button", { name: "Keep mine" })).toBeVisible();
    await expect(box.getByRole("button", { name: "Use the newer version" })).toBeVisible();
    await expect(box.getByRole("button", { name: "Compare" })).toBeVisible();
    await expect(status(page)).toContainText("Nothing was saved");
    expect(readFileSync(landingFile(), "utf8")).toBe(onDisk);
    // Compare says what differs, in words.
    await box.getByRole("button", { name: "Compare" }).click();
    const differences = box.locator("[data-landing-differences]");
    await expect(differences).toContainText("Welcome banner differs. Yours: Written on this device. Newer: Written on another device.");
    await expect(differences).toContainText("Notice is only in the newer version");
    await expect(differences).toContainText("Latest posts is only in your version");
    await expect(box.getByRole("button", { name: "Compare" })).toHaveAttribute("aria-expanded", "true");
    expect(readFileSync(landingFile(), "utf8")).toBe(onDisk);
    // Keep mine changes nothing by itself ...
    await box.getByRole("button", { name: "Keep mine" }).click();
    await expect(box).toBeHidden();
    expect(readFileSync(landingFile(), "utf8")).toBe(onDisk);
    // ... and the next Save is the owner's deliberate choice.
    await save(page).click();
    await expect(status(page)).toContainText("Saved.");
    expect(stored().sections.map((section) => section.id)).toEqual(["hello", "text", "latest"]);
    expect(stored().sections[0].heading).toBe("Written on this device");
  });

  test("Use the newer version loads it and puts your changes away so they can be restored", async ({ page }) => {
    seed(THREE());
    await openLanding(page);
    await editHeading(page, "Written on this device");
    newer();
    await save(page).click();
    const box = page.locator("[data-landing-conflict]");
    await box.getByRole("button", { name: "Use the newer version" }).click();
    await expect(box).toBeHidden();
    expect(await order(page)).toEqual(["hello", "text", "added"]);
    await expect(card(page, "hello").locator(".oba-landing-card-summary")).toHaveText("Written on another device");
    await expect(page.locator(".oba-landing-dirty")).toContainText("All changes saved");
    const offer = page.locator("[data-landing-restore]");
    await expect(offer).toBeVisible();
    await expect(offer.getByRole("button", { name: "Restore your unsaved changes" })).toBeFocused();
    // Your version comes back whole and, because it is based on the newer page, saves without another conflict.
    await offer.getByRole("button", { name: "Restore your unsaved changes" }).click();
    await expect(card(page, "hello").locator(".oba-landing-card-summary")).toHaveText("Written on this device");
    await save(page).click();
    await expect(status(page)).toContainText("Saved.");
    expect(stored().sections[0].heading).toBe("Written on this device");
  });
});

test.describe("when the device will not keep a draft", () => {
  test("editing, saving and coming back within the visit all still work", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    });
    const page = await context.newPage();
    seed(THREE());
    await openLanding(page);
    await editHeading(page, "Kept in memory only");
    await expect(page.locator(".oba-landing-dirty")).toContainText("This device would not keep a copy", { timeout: 3000 });
    // Leaving to another part of Admin and coming back in the same visit restores from memory.
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("link", { name: "Pages", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeHidden();
    await page.getByRole("link", { name: "Landing page", exact: true }).click();
    await expect(page.locator("[data-landing-restore]")).toBeVisible();
    await page.locator("[data-landing-restore]").getByRole("button", { name: "Restore your unsaved changes" }).click();
    await expect(card(page, "hello").locator(".oba-landing-card-summary")).toHaveText("Kept in memory only");
    await save(page).click();
    await expect(status(page)).toContainText("Saved.");
    expect(stored().sections[0].heading).toBe("Kept in memory only");
    await context.close();
  });
});

test("a lost connection keeps the work and says so, and Save works again when it is back", async ({ page, context }) => {
  seed(THREE());
  await openLanding(page);
  await editHeading(page, "Typed offline");
  await context.setOffline(true);
  await save(page).click();
  await expect(status(page)).toContainText("Could not reach the server. Your changes are kept on this device.");
  await expect(save(page)).toBeEnabled();
  await expect(page.locator(".oba-landing-dirty")).toContainText("You have unsaved changes");
  await expect.poll(() => draftOf(page)).toMatchObject({ v: 1 });
  expect(stored().sections[0].heading).toBe("Hello there");
  await context.setOffline(false);
  await save(page).click();
  await expect(status(page)).toContainText("Saved.");
  expect(stored().sections[0].heading).toBe("Typed offline");
});
