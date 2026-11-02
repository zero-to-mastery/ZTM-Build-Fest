import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Concept links in an article (ADR 0172, #73), built and served by the real binary from a private
// atlas and a post that links some words to atlas entries. A published entry is an ordinary link
// that works without JavaScript and from the keyboard; an unknown, private, withdrawn or malformed
// one is the author's own words as plain text; repeated words are linked only where the author
// linked them; nothing private leaks; and the prose reflows at a 320px screen under a strict
// content security policy.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
const PRIVATE = "PRIVATE-CONCEPT-MARKER";
const LONG_LABEL = "the extraordinarily long and unbroken allegoryofthecaveandtheshadowsonthewallthatthe prisoners mistake for the whole of reality";
const LIBRARY = { version: 1, sources: [{ id: "plato-republic", kind: "work", title: "Politeia" }] };
const NOTEBOOK = { version: 1, passages: [], notes: [] };
const entry = (id, kind, label, visibility, extra = {}) => ({ id, kind, label, visibility, ...extra });
const ATLAS = {
  version: 2,
  entries: [
    entry("plato", "person", "Plato", "approved", { summary: "An Athenian philosopher." }),
    entry("allegory-of-the-cave", "concept", "Allegory of the cave", "approved", { summary: "Prisoners and shadows." }),
    entry("secret", "concept", `${PRIVATE} label`, "private", { summary: `${PRIVATE} summary` }),
  ],
  relationships: [],
};
const BODY = [
  `Long ago, [Plato](atlas:plato) described ${"[" + LONG_LABEL + "]"}(atlas:allegory-of-the-cave).`,
  "",
  "A [hidden idea](atlas:secret), a [lost cause](atlas:withdrawn) and a [typo](atlas:Plato) stay plain.",
  "",
  "Plato is mentioned again here, and the allegory of the cave too, and neither is linked.",
  "",
].join("\n");
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-concept-links-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Concepts", url: "https://concepts.example.org", author: { name: "A" }, knowledgeAtlas: { publish: true } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "cave.md"), `---\ntitle: The cave\ndate: 2026-10-19\n---\n${BODY}`);
  const research = join(root, ".openblog", "private", "research");
  mkdirSync(research, { recursive: true });
  writeFileSync(join(research, "sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(join(research, "notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(join(research, "atlas.json"), JSON.stringify(ATLAS));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/posts/cave/`)).ok).toBe(true);
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

const prose = (page) => page.locator("main#main");
// How far the article's own content pokes past the viewport or scrolls sideways. The site's header
// and navigation belong to the theme, whose width depends on the platform's fonts.
const overflow = (page) =>
  page.evaluate(() => {
    const region = document.querySelector("main#main");
    const elements = [region, ...region.querySelectorAll("*")];
    const limit = window.innerWidth;
    const offenders = elements
      .filter((element) => element.getBoundingClientRect().right > limit + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}: ${Math.round(element.getBoundingClientRect().right)}px`);
    const widest = Math.max(...elements.map((element) => element.getBoundingClientRect().right));
    return { overflow: Math.max(widest - limit, region.scrollWidth - region.clientWidth), offenders };
  });

async function expectLinksAndPlainText(page) {
  const links = prose(page).locator("a.ob-concept");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveText("Plato (atlas entry)");
  await expect(links.nth(0)).toHaveAccessibleName("Plato (atlas entry)");
  await expect(links.nth(0)).toHaveAttribute("href", "/atlas/plato/");
  await expect(links.nth(0)).toHaveAttribute("data-atlas-kind", "person");
  await expect(links.nth(1)).toHaveText(`${LONG_LABEL} (atlas entry)`);
  await expect(links.nth(1)).toHaveAttribute("href", "/atlas/allegory-of-the-cave/");
  // Unavailable ids are the author's words, with no link, no scheme and no hint that an entry exists.
  for (const words of ["hidden idea", "lost cause", "typo"]) {
    await expect(prose(page)).toContainText(words);
    await expect(prose(page).getByRole("link", { name: words })).toHaveCount(0);
  }
  // A repeated word is linked only where the author linked it.
  await expect(prose(page)).toContainText("Plato is mentioned again here, and the allegory of the cave too, and neither is linked.");
  const html = await page.content();
  for (const gone of ["atlas:", "atlas/secret", "atlas/withdrawn", PRIVATE, "ob-concept data-id"]) expect(html, gone).not.toContain(gone);
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the links are ordinary links and the rest is plain text", async ({ page }) => {
    await page.goto(`${origin}/posts/cave/`);
    await expectLinksAndPlainText(page);
  });

  test("a link is followed from the keyboard to the entry page", async ({ page }) => {
    await page.goto(`${origin}/posts/cave/`);
    const link = prose(page).locator("a.ob-concept").first();
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/atlas/plato/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plato");
  });
});

test("under a strict content security policy the links work and the prose does not overflow a 320px screen", async ({ page }) => {
  const violations = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy/i.test(text) && !/inline script/i.test(text)) violations.push(text);
  });
  await page.route(`${origin}/posts/cave/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${origin}/posts/cave/`);
  await expectLinksAndPlainText(page);
  const measured = await overflow(page);
  expect(measured.offenders, JSON.stringify(measured)).toEqual([]);
  expect(measured.overflow).toBeLessThanOrEqual(1);
  expect(violations).toEqual([]);
});

test("nothing private is on the entry pages or in the atlas data the post links to", async ({ page }) => {
  for (const path of ["/atlas/", "/atlas/plato/", "/atlas.json", "/atlas-query.json", "/search/", "/feed.xml"]) {
    const response = await page.request.get(`${origin}${path}`);
    const text = await response.text();
    expect(text, path).not.toContain(PRIVATE);
    expect(text, path).not.toContain("atlas:secret");
  }
});
