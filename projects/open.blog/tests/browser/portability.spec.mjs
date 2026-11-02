import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
let root;
let server;
let origin;
let source;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-browser-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  source = readFileSync(join(root, "content", "posts", "portable-lesson.md"), "utf8");
  execFileSync(binary, ["user", "add", "portability", "--root", root], {
    env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe",
  });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], {
    cwd: repository, stdio: "pipe",
  });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    const response = await fetch(`${origin}/admin/`);
    expect(response.ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  removeTree(root);
});

test("independent XML/JSON readers preserve feed semantics, absolute URLs, discovery, and canonical anchors", async ({ page }) => {
  await page.goto(origin);
  const feeds = await page.locator('link[rel="alternate"]').evaluateAll((links) =>
    links.map((link) => ({ type: link.type, href: link.getAttribute("href") })));
  expect(feeds.some((feed) => feed.type === "application/rss+xml")).toBe(true);
  expect(feeds.some((feed) => feed.type === "application/feed+json")).toBe(true);
  const result = await page.evaluate(async () => {
    const rssResponse = await fetch("/rss.xml");
    const jsonResponse = await fetch("/feed.json");
    const rss = new DOMParser().parseFromString(await rssResponse.text(), "application/xml");
    if (rss.querySelector("parsererror")) throw new Error("RSS is not well-formed XML");
    const feed = await jsonResponse.json();
    const item = rss.querySelector("item");
    const html = item.getElementsByTagNameNS("http://purl.org/rss/1.0/modules/content/", "encoded")[0]?.textContent
      || item.querySelector("description").textContent;
    const json = feed.items[0];
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = [...document.querySelectorAll("a[href],img[src]")].map((element) => element.getAttribute("href") || element.getAttribute("src"));
    return {
      html, json, text: document.body.textContent,
      count: rss.querySelectorAll("item").length, links,
      rssType: rssResponse.headers.get("content-type"),
      jsonType: jsonResponse.headers.get("content-type"),
    };
  });
  expect(result.rssType).toContain("xml");
  expect(result.jsonType).toContain("json");
  expect(result.count).toBe(1);
  expect(result.html).toBe(result.json.content_html);
  for (const fact of ["Alex Example", "What does the Rust example print?", "42", "Supporting study", "Join the discussion"]) {
    expect(result.text).toContain(fact);
    expect(result.json.content_text).toContain(fact);
  }
  expect(result.html).not.toMatch(/PRIVATE_|runner\.example\.org|discussion\.example\.org|<ob-|<script/i);
  for (const link of result.links) expect(link).toMatch(/^(https?:|mailto:|tel:)/);
  const canonical = new URL(result.json.url);
  await page.goto(`${origin}${canonical.pathname}`);
  for (const link of result.links.map((link) => new URL(link)).filter((link) => link.pathname === canonical.pathname && link.hash)) {
    await expect(page.locator(`[id="${decodeURIComponent(link.hash.slice(1))}"]`)).toHaveCount(1);
  }
  expect(result.links).toContain(`${result.json.url}#ob-discussion`);
  await expect(page.getByRole("region", { name: "Discussion", exact: true })).toHaveCount(1);
  expect(readFileSync(join(root, "content", "posts", "portable-lesson.md"), "utf8")).toBe(source);
});

test("portable HTML works without scripts or CSS, in print, and with keyboard/reduced-motion/mobile views", async ({ browser, request }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: "reduce", viewport: { width: 320, height: 800 } });
  const page = await context.newPage();
  try {
    const feed = await (await request.get(`${origin}/feed.json`)).json();
    const html = feed.items[0].content_html;
    await page.setContent(`<!doctype html><html lang="en"><title>Portable lesson</title><body><main>${html}</main></body></html>`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText("Supporting study", { exact: false }).first()).toBeVisible();
    const discussion = page.getByRole("link", { name: /Join the discussion/ });
    await expect(discussion).toBeVisible();
    await discussion.focus();
    await expect(discussion).toBeFocused();
    await page.keyboard.press("Tab");
    await page.emulateMedia({ media: "print" });
    await expect(page.getByText(/Answer:/).first()).toBeVisible();
    await expect(page.locator("script,iframe,ob-quiz,ob-web-sandbox")).toHaveCount(0);
    await expect(page.locator("pre code")).not.toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("authenticated unsaved previews group losses, copy/download exact output, and navigate source without saving", async ({ page, context }) => {
  await page.goto(`${origin}/admin/`);
  await page.getByLabel("Username", { exact: true }).fill("portability");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: /A lesson that travels/ }).click();
  await page.getByRole("button", { name: "Site preview", exact: true }).click();
  const mode = page.getByLabel("Preview representation or destination");
  await mode.selectOption("destination:ghost");
  await expect(page.getByText(/Ghost source=html converts.*lossy/).first()).toBeVisible();
  await expect(page.getByText(/Ghost receives hosted image references only/)).toBeVisible();
  await expect(page.getByText(/adapter limitation, not a provider tag-count limit/)).toBeVisible();
  await mode.selectOption("destination:wordpress");
  await expect(page.getByText(/WordPress core cannot set an external canonical URL/).first()).toBeVisible();
  await mode.selectOption("destination:hashnode");
  await expect(page.getByText(/Hashnode receives hosted image references only/)).toBeVisible();
  await expect(page.getByText(/Ghost receives hosted image references only/)).toHaveCount(0);
  await mode.selectOption("portable-text");
  await expect(page.getByText(/receives hosted image references only/)).toHaveCount(0);
  await page.getByRole("button", { name: "Acknowledge this warning", exact: true }).first().click();
  await expect(page.getByText("Acknowledged for this revision.", { exact: true }).first()).toBeVisible();
  await mode.selectOption("portable-markdown");
  await expect(page.getByText("Acknowledged for this revision.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Write", exact: true }).click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const body = page.getByRole("textbox", { name: "Markdown", exact: true });
  const unsaved = `Unsaved browser regression 😀\n\n${await body.inputValue()}\n\nLiteral example: \`<script>not executable</script>\`\n`;
  await body.fill(unsaved);
  await page.getByRole("button", { name: "Site preview", exact: true }).click();
  await mode.selectOption("portable-text");
  const output = page.getByLabel("Portable text preview", { exact: true });
  await expect(output).toBeVisible();
  await expect(page.getByText(/knowledge-check · Gracefully transformed/).first()).toBeVisible();
  await expect(page.getByText(/Scoring, retries and saved attempts remain/).first()).toBeVisible();
  const expected = await output.textContent();
  expect(expected).toContain("Unsaved browser regression");
  expect(expected).toContain("<script>not executable</script>");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download portable output" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("portable-preview.txt");
  expect(readFileSync(await download.path(), "utf8")).toBe(expected);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy portable output" }).click();
  await expect(page.getByText("Portable output copied; source unchanged.", { exact: true })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.replace(/\r\n/g, "\n")).toBe(expected);
  await page.getByRole("button", { name: "Acknowledge this warning", exact: true }).first().click();
  await expect(page.getByText(/Acknowledgement failed: The source changed/)).toBeVisible();
  await expect(page.getByText("Acknowledged for this revision.", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/previous portability acknowledgement is stale/)).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  const tools = page.locator(".oba-preview-tools");
  expect(await tools.evaluateAll((elements) => elements.every((element) =>
    element.scrollWidth <= element.clientWidth
      && element.getBoundingClientRect().right <= window.innerWidth))).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: /Edit source at line/ }).first().click();
  await expect(body).toBeFocused();
  await expect(body).toHaveValue(unsaved);
  expect(await body.evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd))).toContain("```quiz");
  await expect(page.getByText(/Editing portability source at line.*Unsaved content is unchanged/)).toBeAttached();
  await page.getByRole("button", { name: "Site preview", exact: true }).click();
  await page.route("**/admin/api/preview", (route) => route.fulfill({
    status: 422, contentType: "application/json", body: JSON.stringify({ error: "Preview regression: invalid capability" }),
  }));
  await page.getByRole("button", { name: "Write", exact: true }).click();
  await body.fill(`${unsaved}\nAnother unsaved edit.`);
  await page.getByRole("button", { name: "Site preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download portable output" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy portable output" })).toBeDisabled();
  await expect(page.getByText(/Preview regression: invalid capability/)).toBeVisible();
  expect(readFileSync(join(root, "content", "posts", "portable-lesson.md"), "utf8")).toBe(source);
});
