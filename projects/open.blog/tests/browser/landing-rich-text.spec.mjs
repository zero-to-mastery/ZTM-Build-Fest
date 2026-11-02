import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// The Rich text landing section (ADR 0257, #330), from the real binary and the real Admin Studio:
// the Visual (word-processor) editor with a toolbar of words, saved as Markdown, with no Markdown
// toggle, no HTML and no control that accepts markup.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;

const landingFile = () => join(root, "content", "landing.json");
const stored = () => JSON.parse(readFileSync(landingFile(), "utf8"));
const seed = (markdown) => writeFileSync(landingFile(), JSON.stringify({ format: "openblog-landing", version: 1, sections: [{ id: "text", type: "rich-text", markdown }] }));
const savedMarkdown = () => stored().sections[0].markdown;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-landing-rich-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "one.md"), "---\ntitle: One\ndate: 2026-10-01\n---\nA post.\n");
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Rich", url: "https://rich.example.org", author: { name: "Site Author" }, home: { heading: "Fresh writing", intro: "Welcome to my blog." } }));
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

async function openText(page, markdown) {
  seed(markdown);
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${origin}/admin/#/landing`);
  await expect(page.getByRole("heading", { level: 2, name: "Sections" })).toBeVisible();
  await page.locator('[data-section="text"]').getByRole("button", { name: /^Edit/ }).click();
  await expect(editor(page)).toBeVisible();
}

const editor = (page) => page.locator("[data-rich-text]");
const tool = (page, name) => page.locator(`[data-rich="${name}"]`);
const saveAndRead = async (page) => {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  return savedMarkdown();
};
/** Select all of the text and replace it. */
async function typeOver(page, text) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

test("the toolbar has the named tools and the surface has no Markdown, HTML or text-area view", async ({ page }) => {
  await openText(page, "Hello there.");
  const names = await page.locator(".oba-landing-rich-toolbar button").allTextContents();
  expect(names).toEqual(["Paragraph", "Heading", "Bold", "Italic", "Link", "Bulleted list", "Numbered list", "Quote", "Image", "Undo", "Redo"]);
  await expect(page.getByRole("toolbar", { name: /formatting/ })).toBeVisible();
  const form = page.locator('[data-section="text"] .oba-landing-form');
  await expect(form.locator("textarea")).toHaveCount(0);
  await expect(form.getByRole("button", { name: /markdown|html|source|code/i })).toHaveCount(0);
  await expect(form.getByRole("textbox", { name: "Your text (optional)" })).toBeVisible();
  expect(await form.locator("input").count()).toBe(0);
});

test("headings, bold, italic, lists and quotes are made with the buttons and saved as Markdown", async ({ page }) => {
  await openText(page, "Welcome\n\nSome bold words\n\nSome italic words\n\nfirst\n\nA wise saying");
  const block = (index) => editor(page).locator(":scope > *").nth(index);
  await block(0).click();
  await tool(page, "heading").click();
  await expect(tool(page, "heading")).toHaveAttribute("aria-pressed", "true");
  await block(1).click({ clickCount: 3 });
  await tool(page, "bold").click();
  await expect(tool(page, "bold")).toHaveAttribute("aria-pressed", "true");
  await block(2).click({ clickCount: 3 });
  await tool(page, "italic").click();
  await block(3).click();
  await tool(page, "bulleted").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await editor(page).locator(":scope > *").last().click();
  await tool(page, "quote").click();
  await expect(tool(page, "quote")).toHaveAttribute("aria-pressed", "true");
  expect(await saveAndRead(page)).toBe("## Welcome\n\n**Some bold words**\n\n_Some italic words_\n\n- first\n- second\n\n> A wise saying");
});

test("a numbered list is made from typed lines", async ({ page }) => {
  await openText(page, "x");
  await typeOver(page, "one");
  await tool(page, "numbered").click();
  await expect(tool(page, "numbered")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  expect(await saveAndRead(page)).toBe("1. one\n2. two");
});

test("Paragraph turns a heading back into a paragraph", async ({ page }) => {
  await openText(page, "## A heading");
  await editor(page).locator("h2").click();
  await tool(page, "paragraph").click();
  expect(await saveAndRead(page)).toBe("A heading");
});

test("Link asks in words, refuses a bad address, and links the selected words", async ({ page }) => {
  await openText(page, "Visit my archive today");
  await editor(page).click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("Shift+ArrowRight");
  await tool(page, "link").click();
  const panel = page.locator('[data-rich-panel="link"]');
  await expect(panel.getByLabel("Where the link goes")).toBeFocused();
  await panel.getByLabel("Where the link goes").fill("javascript:alert(1)");
  await panel.getByRole("button", { name: "Add link" }).click();
  await expect(panel).toContainText("not allowed");
  await panel.getByLabel("Where the link goes").fill("/archive/");
  await panel.getByLabel("Where the link goes").press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(editor(page).locator("a")).toHaveAttribute("href", "/archive/");
  await expect(editor(page)).toBeFocused();
  expect(await saveAndRead(page)).toBe("Visit [my archive](/archive/) today");
});

test("a link with no words selected asks for the words to show, and Remove link takes it away", async ({ page }) => {
  await openText(page, "Start");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" ");
  await tool(page, "link").click();
  const panel = page.locator('[data-rich-panel="link"]');
  await panel.getByRole("button", { name: "Add link" }).click();
  await expect(panel).toContainText("Enter where the link goes");
  await panel.getByLabel("Words to show for the link").fill("my site");
  await panel.getByLabel("Where the link goes").fill("https://example.com/");
  await panel.getByRole("button", { name: "Add link" }).click();
  expect(await saveAndRead(page)).toContain("[my site](https://example.com/)");
  await editor(page).locator("a").click();
  await tool(page, "link").click();
  await page.locator('[data-rich-panel="link"]').getByRole("button", { name: "Remove link" }).click();
  await expect(editor(page).locator("a")).toHaveCount(0);
  expect(await saveAndRead(page)).not.toContain("](");
});

test("an image needs an address and a description", async ({ page }) => {
  await openText(page, "Look:");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await tool(page, "image").click();
  const panel = page.locator('[data-rich-panel="image"]');
  await panel.getByLabel("Where the picture is").fill("https://example.com/tea.png");
  await panel.getByRole("button", { name: "Add image" }).click();
  await expect(panel).toContainText("Describe the picture");
  expect(await editor(page).locator("img").count()).toBe(0);
  await panel.getByLabel("Describe the picture (needed)").fill("A cup of tea");
  await panel.getByLabel("Describe the picture (needed)").press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(editor(page).locator("img")).toHaveAttribute("alt", "A cup of tea");
  expect(await saveAndRead(page)).toBe("Look:![A cup of tea](https://example.com/tea.png)");
});

test("a picture without a description in older text is flagged before it can be saved", async ({ page }) => {
  await openText(page, "A picture: ![](https://example.com/x.png)");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Nothing was saved");
  await expect(page.locator('[data-section="text"]')).toContainText("Every picture needs a description");
});

test("Undo and Redo take a change back and forward", async ({ page }) => {
  await openText(page, "Plain words");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await tool(page, "bold").click();
  await expect(editor(page).locator("b, strong")).toHaveCount(1);
  await tool(page, "undo").click();
  await expect(editor(page).locator("b, strong")).toHaveCount(0);
  await tool(page, "redo").click();
  await expect(editor(page).locator("b, strong")).toHaveCount(1);
  expect(await saveAndRead(page)).toBe("**Plain words**");
});

test("existing text shows as formatted text and saving without a change keeps it byte for byte", async ({ page }) => {
  const markdown = "## Hi\n\nSome **bold** and _italic_ and [a link](https://example.com/) here.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n![Tea](https://example.com/t.png)";
  await openText(page, markdown);
  const surface = editor(page);
  await expect(surface.locator("h2")).toHaveText("Hi");
  await expect(surface.locator("strong")).toHaveText("bold");
  await expect(surface.locator("em")).toHaveText("italic");
  await expect(surface.locator("a")).toHaveAttribute("href", "https://example.com/");
  await expect(surface.locator("ul li")).toHaveCount(2);
  await expect(surface.locator("ol li")).toHaveCount(2);
  await expect(surface.locator("blockquote")).toHaveText("quoted");
  await expect(surface.locator("img")).toHaveAttribute("alt", "Tea");
  // Opening it and moving about writes nothing.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-landing-status]")).toContainText("Saved.");
  expect(savedMarkdown()).toBe(markdown);
});

test("every toolbar construct round-trips through Markdown without loss", async ({ page }) => {
  await openText(page, "x");
  const results = await page.evaluate(async () => {
    const { landingRichRoundTrip } = await import("/admin/admin.js");
    const samples = [
      "Plain words.",
      "## A heading",
      "**bold**",
      "_italic_",
      "[a link](https://example.com/)",
      "[a page](/archive/)",
      "- one\n- two",
      "1. one\n2. two",
      "> a quote",
      "![alt text](https://example.com/p.png)",
      "## Title\n\nA paragraph with **bold**, _italic_ and [a link](/x/).\n\n- item\n- item\n\n> quote",
      "Line one\nline two",
      "Stars \\* and \\_ underscores stay words",
      "<b>not markup</b> and <script>x</script>",
    ];
    return samples.map((sample) => [sample, landingRichRoundTrip(sample)]);
  });
  for (const [before, after] of results) expect(after, before).toBe(before);
});

test("markup typed or pasted stays words, and nothing else rides along on a paste", async ({ page }) => {
  await openText(page, "x");
  await typeOver(page, "<b>bold</b> & <script>window.__x = 1</script>");
  await editor(page).evaluate((node) => {
    const data = new DataTransfer();
    data.setData("text/html", '<p style="color:red"><b onclick="window.__y=1">pasted</b><script>window.__z=1</script></p>');
    data.setData("text/plain", " pasted words");
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor(page)).toContainText("pasted");
  expect(await editor(page).locator("script, [onclick], [style], b").count()).toBe(0);
  const markdown = await saveAndRead(page);
  expect(markdown).toContain("&lt;b>bold&lt;/b> & &lt;script>window.\\_\\_x = 1&lt;/script>");
  expect(markdown).toContain("**pasted**");
  expect(markdown).not.toMatch(/<\/?[a-z]/i);
  expect(markdown).not.toContain("onclick");
  const page2 = await page.evaluate(() => [window.__x, window.__y, window.__z]);
  expect(page2).toEqual([undefined, undefined, undefined]);
});

test("the saved page shows the formatting to visitors", async ({ page }) => {
  await openText(page, "Bold news");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await tool(page, "bold").click();
  await saveAndRead(page);
  const home = await (await fetch(`${origin}/`)).text();
  expect(home).toMatch(/<strong>Bold news<\/strong>/);
});

test("it works from the keyboard: the toolbar is one tab stop with arrow keys, and buttons say when they are on", async ({ page }) => {
  await openText(page, "Words");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  // Shift+Tab goes from the text back to the toolbar, which is a single stop.
  await page.keyboard.press("Shift+Tab");
  await expect(tool(page, "paragraph")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(tool(page, "bold")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(editor(page).locator("b, strong")).toHaveCount(1);
  await expect(tool(page, "bold")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("End");
  await expect(tool(page, "redo")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tool(page, "paragraph")).toBeFocused();
  const unnamed = await page.locator(".oba-landing-rich-toolbar button").evaluateAll((nodes) => nodes.filter((node) => !node.textContent.trim()).length);
  expect(unnamed).toBe(0);
});

test("on a phone the toolbar is touch sized, wraps without sideways scroll and stays in view", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openText(page, Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some words to make the text long.`).join("\n\n"));
  const small = await page.locator(".oba-landing-rich-toolbar button").evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().height < 44 || node.getBoundingClientRect().width < 44).length);
  expect(small).toBe(0);
  const overflow = await page.locator('[data-section="text"]').evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const page320 = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(page320).toBeLessThanOrEqual(0);
  // Scrolled into the middle of a long text, the toolbar is still on screen.
  await editor(page).locator("p").nth(30).scrollIntoViewIfNeeded();
  await expect(tool(page, "bold")).toBeInViewport();
});

test("block tools and dragging leave a preserved card where it is", async ({ page }) => {
  const markdown = "Before the card.\n\n| a | b |\n| --- | --- |\n| keep | this |\n\nAfter the card.";
  await openText(page, markdown);
  await expect(editor(page).locator(".oba-protected-block")).toHaveCount(1);
  const shape = () => editor(page).evaluate((node) => [...node.children].map((child) => `${child.tagName}:${child.classList.contains("oba-protected-block")}:${child.textContent.slice(0, 20)}`));
  const before = await shape();
  for (const name of ["heading", "quote", "bulleted", "numbered"]) {
    await editor(page).locator("p").first().click();
    await page.keyboard.press("ControlOrMeta+A");
    await tool(page, name).click();
    await expect(page.locator("[data-rich-status]")).toHaveText("Select text outside the kept cards only.");
    expect(await shape(), name).toEqual(before);
  }
  // A drop is not accepted either.
  const prevented = await editor(page).evaluate((node) => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  expect(await saveAndRead(page)).toBe(markdown);
});
