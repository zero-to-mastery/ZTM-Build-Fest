import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// Accessible attributed perspective conversations (#224, ADRs 0137 and 0138). A published reader's
// reflection about one author's section, and that author's approved response, are static, labelled
// HTML after the author's own words: found by role and name with no CSS and no script, in reading
// order, the reader's and the author's told apart by text; a long conversation folded behind one
// native button only with script, and opened by a link into it; no sideways scrolling on the
// regions under test at 320px and 400% zoom, in print and with reduced motion; hostile text inert;
// answers off leaving the page as it was; feeds, llms files and portable copies carrying no
// conversation; and Admin's take-off notice for a withdrawn answer.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://conversations.example/api";
const HOSTILE = "<img src=x onerror=\"window.__xss = 1\"> <script>window.__xss = 2</script> & \"quoted\"";
const LONG = `${"unbroken".repeat(30)}-token`;

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const turn = (lane, lanes, author, key, text) => `<section class="ob-turn ob-lane-${lane} ob-turn-by-${key}">
<h2 class="ob-turn-author">${author}</h2>

${text}

</section>
`;
const arranged = (layout, lanes, turns) => `<div class="ob-reflection ob-reflection-${layout} ob-lanes-${lanes}">

${turns.map(([author, key, text], index) => `<div class="ob-round">

${turn(lanes === 1 ? 0 : index % lanes, lanes, author, key, text)}
</div>
`).join("\n")}
</div>
`;
const TURNS = [
  ["MINA", "mina", "The moon pulls the water, and the water answers it twice a day along the whole shore."],
  ["JOE", "joe", "It is also the sun."],
  ["MINA", "mina", "Neither explains the harbour."],
];
const CREDITS = JSON.stringify({
  version: 1,
  credits: [
    { contributor: "mina", roles: [{ vocabulary: "crossref", role: "author" }] },
    { contributor: "joe", roles: [{ vocabulary: "crossref", role: "author" }] },
  ],
});

let root;
let server;
let origin;

const post = (name, front, body) => {
  writeFileSync(join(root, "content", "posts", `${name}.md`), `---\ntitle: ${name}\ndate: 2026-10-20\n${front}---\n${body}`);
  writeFileSync(join(root, "content", "posts", `${name}.credits.json`), CREDITS);
};

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

/** What the build says of a post's author sections and passage revision, to write a published file against. */
function readTargets(slug) {
  const out = join(root, "pre");
  rmSync(out, { recursive: true, force: true });
  execFileSync(binary, ["build", "--root", root, "--out", out], { stdio: "pipe" });
  const html = readFileSync(join(out, slug, "index.html"), "utf8");
  const data = JSON.parse(html.match(/<script type="application\/json" id="ob-attributed-sections">([^<]*)<\/script>/)[1].replace(/\\u003c/g, "<"));
  const revision = html.match(/passage revision, <code>(p1:[0-9a-f]{32})<\/code>/)[1];
  return { sections: data.sections, revision };
}

const reflection = (n, targets, section, body, answer) => ({
  id: ID(n), post: `posts/${targets.slug}.md`, work: `/${targets.slug}/`, revision: targets.revision,
  target: { version: 1, kind: "section", section: targets.sections[section].anchor, digest: targets.sections[section].digest },
  body, received: `2026-10-${String(10 + n).padStart(2, "0")}`, approved: "2026-10-27",
  ...(answer ? { answer } : {}),
});
const reply = (n, body) => ({ id: ID(n), contributor: "mina", author: "MINA", body, received: "2026-10-26", approved: "2026-10-27" });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-author-conversations-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Conversations",
    url: "https://conversations-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    contributors: { mina: { name: "MINA" }, joe: { name: "JOE" } },
    engagement: { enabled: true, comments: false, analytics: false, endpoint: ENDPOINT, receipts: true, feedbackContact: "mailto:ada@conversations-site.example.org" },
    participation: { kinds: { "third-perspective": "open", "author-response": "open", "abuse-report": "open" } },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  post("shared-tides", "", arranged("sequential", 1, TURNS));
  post("lanes", "", arranged("side-by-side", 2, TURNS.slice(0, 2)));
  post("quiet", "participation:\n  - author-response: hidden\n", arranged("sequential", 1, TURNS));
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });

  // Publish against what the build says: MINA's first section has a reflection and the author's
  // response; JOE's has a long thread (folded with script); MINA's second has hostile and long text.
  const tides = { slug: "shared-tides", ...readTargets("shared-tides") };
  const lanes = { slug: "lanes", ...readTargets("lanes") };
  // The same body: where answers are hidden the build lists no sections, so it borrows these.
  const quiet = { ...tides, slug: "quiet" };
  const items = [
    reflection(1, tides, 0, "I read the harbour differently.", reply(2, "I meant the harbour, not the open sea.")),
    ...[3, 4, 5, 6].map((n) => reflection(n, tides, 1, `Reflection number ${n} about the sun.`)),
    reflection(7, tides, 2, HOSTILE, reply(8, HOSTILE)),
    reflection(9, tides, 2, `Long ${LONG}`),
    reflection(11, lanes, 0, `A reflection in a lane ${LONG}`, reply(12, `An answer in a lane ${LONG}`)),
    reflection(13, quiet, 0, "A reflection where answers are hidden.", reply(14, "A hidden answer.")),
  ];
  writeFileSync(join(root, "content", "third-perspectives.json"), JSON.stringify({ version: 2, items }, null, 2));
  rmSync(join(root, "pre"), { recursive: true, force: true });

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/shared-tides/`)).ok).toBe(true);
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

const conversation = (page, anchor) => page.locator(`#ob-by-${anchor} aside.ob-conversation`);

// ---- Without CSS or script: static, ordered, labelled

test("without JavaScript the conversation follows its section, in order, and says who wrote what", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/shared-tides/`);
  const section = page.locator("#ob-by-mina-0");
  await expect(section).toHaveCount(1);
  // Her words come first; the conversation is inside her own turn, after them.
  const order = await section.evaluate((turn) => {
    const prose = [...turn.querySelectorAll("p")].find((p) => p.textContent.startsWith("The moon pulls the water"));
    const aside = turn.querySelector("aside.ob-conversation");
    return { before: Boolean(prose.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING), inside: turn.contains(aside) };
  });
  expect(order).toEqual({ before: true, inside: true });
  // Found by role and accessible name, as a screen reader finds it.
  const aside = page.getByRole("complementary", { name: "Reader reflections on MINA’s section 1" }).first();
  await expect(aside).toBeVisible();
  const reader = aside.getByRole("article", { name: "Third Perspective from a reader" });
  const author = aside.getByRole("article", { name: "Author’s response from MINA" });
  await expect(reader).toContainText("I read the harbour differently.");
  await expect(author).toContainText("I meant the harbour, not the open sea.");
  await expect(author).toContainText("Written by the author of the section this answers");
  // The response is nested in the reflection it answers, for reply semantics, but the reflection's own words never say it was the author's.
  expect(await author.evaluate((response) => response.parentElement.classList.contains("ob-perspective"))).toBe(true);
  expect(await reader.evaluate((article) => [...article.children].filter((child) => child.tagName !== "ARTICLE").map((child) => child.textContent).join(" "))).not.toContain("Written by the author");
  // The headings descend h2 (turn), h3, h4, h5, and nothing is a heading level by colour.
  expect(await section.evaluate((turn) => [...turn.querySelectorAll("h2, h3, h4, h5")].slice(0, 4).map((h) => h.tagName))).toEqual(["H2", "H3", "H4", "H5"]);
  // The reader's article precedes the author's response in the document, so reading order is the conversation order.
  const sequence = await aside.evaluate((element) => [...element.querySelectorAll("article")].slice(0, 2).map((a) => a.className));
  expect(sequence).toEqual(["ob-perspective", "ob-author-response"]);
  // The canonical section points to it, and the link works from the keyboard without script.
  const pointer = page.locator("#ob-third-perspectives").getByRole("link", { name: /reflection about a section by MINA/ }).first();
  await expect(pointer).toBeVisible();
  await pointer.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#ob-conversation-ob-by-mina-0$/);
  await expect(page.locator("#ob-conversation-ob-by-mina-0")).toBeInViewport();
  // The report forms keep their static text, and nothing is a form without script.
  await expect(aside.getByText("To report this reflection as abusive, write to the author.")).toBeVisible();
  await expect(aside.getByText("To report this response as abusive, write to the author.")).toBeVisible();
  await expect(page.locator("#ob-by-mina-0 form")).toHaveCount(0);
  await context.close();
});

test("with no stylesheet the same order and names remain", async ({ page }) => {
  await page.route("**/*.css", (route) => route.abort());
  await page.goto(`${origin}/shared-tides/`);
  await expect(page.getByRole("article", { name: "Author’s response from MINA" }).first()).toBeVisible();
  const text = await page.locator("#ob-by-mina-0").innerText();
  expect(text.indexOf("The moon pulls the water")).toBeLessThan(text.indexOf("Reader reflections on MINA’s section 1"));
  expect(text.indexOf("Third Perspective from a reader")).toBeLessThan(text.indexOf("Author’s response from MINA"));
});

// ---- Progressive enhancement and keyboard

test("a long conversation is folded behind one native button only with script, and a link into it opens it", async ({ page }) => {
  await page.goto(`${origin}/shared-tides/`);
  await page.waitForFunction(() => customElements.get("ob-conversation") !== undefined);
  const joe = conversation(page, "joe-0");
  const button = joe.getByRole("button", { name: "Reader reflections on JOE’s section 1 (4)" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(joe.locator(".ob-conversation-list")).toBeHidden();
  // A short conversation is never folded, and the author's own words are never touched.
  await expect(conversation(page, "mina-0").getByRole("button")).toHaveCount(0);
  await expect(page.locator("#ob-by-joe-0").getByText("It is also the sun.", { exact: true })).toBeVisible();
  // Keyboard: Tab reaches the button, Enter opens it; the name stays the same and only aria-expanded changes.
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  const hide = joe.getByRole("button", { name: "Reader reflections on JOE’s section 1 (4)" });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(hide).toBeFocused();
  await expect(joe.getByRole("article", { name: "Third Perspective from a reader" })).toHaveCount(4);
  await page.keyboard.press("Space");
  await expect(joe.locator(".ob-conversation-list")).toBeHidden();
  // A link to a reflection inside the folded list opens it.
  await page.goto(`${origin}/shared-tides/#ob-perspective-${ID(5)}`);
  await page.waitForFunction(() => customElements.get("ob-conversation") !== undefined);
  await expect(joe.locator(".ob-conversation-list")).toBeVisible();
  await expect(page.locator(`#ob-perspective-${ID(5)}`)).toBeInViewport();
});

test("the visible focus ring and the reduced-motion preference leave nothing animated", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/shared-tides/`);
  await page.waitForFunction(() => customElements.get("ob-conversation") !== undefined);
  const toggle = conversation(page, "joe-0").getByRole("button");
  await toggle.focus();
  const outline = await toggle.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
  const moving = await page.evaluate(() => [...document.querySelectorAll(".ob-conversation, .ob-conversation *")].filter((element) => {
    const style = getComputedStyle(element);
    return style.animationName !== "none" || parseFloat(style.transitionDuration) > 0;
  }).length);
  expect(moving).toBe(0);
});

// ---- Reflow, zoom and print

for (const [name, width, height] of [["320px", 320, 640], ["400% zoom (320px wide, 256px tall)", 320, 256]]) {
  test(`at ${name} no conversation scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/shared-tides/`);
    await page.waitForFunction(() => customElements.get("ob-conversation") !== undefined);
    await page.goto(`${origin}/shared-tides/#ob-by-mina-1`);
    for (const selector of ["aside.ob-conversation", "#ob-third-perspectives"]) {
      const overflow = await page.locator(selector).evaluateAll((elements) => elements.map((element) => element.scrollWidth - element.clientWidth));
      expect(Math.max(...overflow, 0), selector).toBeLessThanOrEqual(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Nothing inside a conversation reaches past the edge of the viewport.
    expect(await page.evaluate(() => [...document.querySelectorAll("aside.ob-conversation *")].filter((element) => {
      if (element.closest("[hidden]")) return false;
      return element.getBoundingClientRect().right > window.innerWidth + 1;
    }).map((element) => element.tagName))).toEqual([]);
    // The long unbroken token wraps inside its own article.
    const long = page.locator("#ob-by-mina-1 article.ob-perspective", { hasText: LONG });
    const box = await long.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // The text is still reachable by role at this size.
    await expect(page.locator("#ob-by-mina-0").getByRole("article", { name: "Author’s response from MINA" })).toBeAttached();
  });
}

test("in a side-by-side lane the conversation stays inside its own turn and its words never move", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/lanes/`);
  const turnBox = await page.locator("#ob-by-mina-0").boundingBox();
  const aside = await conversation(page, "mina-0").boundingBox();
  expect(aside.x).toBeGreaterThanOrEqual(turnBox.x - 1);
  expect(aside.x + aside.width).toBeLessThanOrEqual(turnBox.x + turnBox.width + 1);
  expect(await conversation(page, "mina-0").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
  // The other lane's turn begins at its own top, beside, not under, the conversation.
  const other = await page.locator("#ob-by-joe-0").boundingBox();
  expect(other.x).toBeGreaterThan(turnBox.x + turnBox.width - 1);
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("in print every reflection is on the page, the folding button is not, and the author's response keeps its label", async ({ page }) => {
  await page.goto(`${origin}/shared-tides/`);
  await page.waitForFunction(() => customElements.get("ob-conversation") !== undefined);
  await page.emulateMedia({ media: "print" });
  const joe = conversation(page, "joe-0");
  await expect(joe.locator(".ob-conversation-list")).toBeVisible();
  await expect(joe.locator(".ob-conversation-toggle")).toBeHidden();
  await expect(joe.getByRole("article", { name: "Third Perspective from a reader" })).toHaveCount(4);
  await expect(page.getByRole("article", { name: "Author’s response from MINA" }).first()).toBeVisible();
  await expect(page.locator("aside.ob-conversation ob-abuse-report").first()).toBeHidden();
});

// ---- Hostile text, answers off, and what leaves the page

test("hostile reader and author text is shown as text and runs nothing", async ({ page }) => {
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await page.goto(`${origin}/shared-tides/`);
  await page.waitForFunction(() => customElements.get("ob-conversation") !== undefined);
  const section = page.locator("#ob-by-mina-1");
  await expect(section.getByText("<script>window.__xss = 2</script>", { exact: false }).first()).toBeVisible();
  await expect(section.locator("article img, article script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test("where answers are hidden the page has no anchors, no conversation and no answer", async ({ page }) => {
  await page.goto(`${origin}/quiet/`);
  await expect(page.locator('[id^="ob-by-"]')).toHaveCount(0);
  await expect(page.locator(".ob-conversation, .ob-author-response")).toHaveCount(0);
  await expect(page.getByText("A hidden answer.")).toHaveCount(0);
  // The reflection itself is still listed, as before answers existed.
  await expect(page.locator("#ob-third-perspectives").getByText("A reflection where answers are hidden.")).toBeVisible();
});

test("feeds, llms files, search data and portable copies carry no conversation, only the canonical link", async ({ page }) => {
  const secrets = ["I meant the harbour, not the open sea", "I read the harbour differently", "Author’s response from MINA", "ob-conversation", ID(2), "Reflection number 3"];
  // Every one of these is written by the build, so a missing one is a failure, never skipped.
  const paths = ["/rss.xml", "/feed.json", "/llms.txt", "/llms-full.txt", "/sitemap.xml", "/search.json"];
  for (const path of paths) {
    const response = await page.request.get(`${origin}${path}`);
    expect(response.ok(), `${path} exists`).toBe(true);
    const body = await response.text();
    for (const secret of secrets) expect(body, `${secret} in ${path}`).not.toContain(secret);
  }
  const llms = await (await page.request.get(`${origin}/llms-full.txt`)).text();
  expect(llms).toContain("Third Perspectives");
});

// ---- Admin: take-off for a withdrawn answer

async function signIn(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
}
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const queueStatus = (page) => page.locator(".oba-feedback-section").first().locator('p[role="status"]').first();

test("Admin counts a published answer that must come off, apart from the reflection, and takes it off from the keyboard", async ({ page }) => {
  let audit = { checked: 1, truncated: false, mustComeOff: [], unknown: [], answersMustComeOff: [{ id: ID(2), post: "posts/shared-tides.md", parent: ID(1) }] };
  const taken = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, { state: new URL(route.request().url()).searchParams.get("state"), kind: "", protocol: "protected", items: [], invalid: 0, next: null }));
  await page.route(`${origin}/admin/api/engagement/third-perspectives/published`, (route) => json(route, 200, audit));
  await page.route(`${origin}/admin/api/engagement/author-responses/unpublish`, async (route) => {
    taken.push(route.request().postDataJSON());
    audit = { ...audit, answersMustComeOff: [] };
    return json(route, 200, { published: false, build: { ok: true, posts: 1 } });
  });
  await signIn(page);
  for (const hash of ["pending", "approved"]) {
    await page.goto(`${origin}/admin/#/moderation/${hash}`);
    const notice = page.locator('[data-perspective-notice="answersMustComeOff"]');
    await expect(notice).toContainText("1 published author response must come off its post");
    await expect(notice).toContainText("The reader’s reflection stays.");
    await expect(notice).toHaveAttribute("role", "alert");
  }
  await expect(page.locator('[data-perspective-notice="mustComeOff"]')).toHaveCount(0);
  const button = page.locator('[data-perspective-notice="answersMustComeOff"]').getByRole("button", { name: "Take the answer off the post" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toContainText("Taken off its post.");
  expect(taken).toEqual([{ id: ID(2) }]);
  await expect(page.locator('[data-perspective-notice="answersMustComeOff"]')).toHaveCount(0);
});
