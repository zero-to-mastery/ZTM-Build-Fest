import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// Section commentary and author responses (#223, ADRs 0131 to 0135). Readers: a reflection about
// one author's section of a shared reflection, chosen by author and place from the build's own
// list and sent as an ordinary section target; the static text that names a section without
// JavaScript; a post that attributes nothing, and a post where answers are off, unchanged; the
// service refusing, rate limiting or absent, with the reflection and a copy kept; and 320px and
// 400% zoom without sideways scrolling on the region under test. Admin (the hosted inbox is mocked
// at the Admin API, as in the inbox spec): the offer to answer, only where the server made it,
// sent from the keyboard in plain text with errors kept on the form; an answer in the inbox with
// its moderators' view, an author's confirmed withdrawal, and 320px on the card.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://answers.example/api";
const FEEDBACK_URL = `${ENDPOINT}/feedback`;
const RECEIPT = "R".repeat(43);
const POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(ENDPOINT).origin}; img-src 'self' data:; object-src 'none'; base-uri 'none'`;

const turn = (lane, author, text) => `<div class="ob-round">

<section class="ob-turn ob-lane-${lane} ob-turn-by-${author.toLowerCase()}">
<h2 class="ob-turn-author">${author}</h2>

${text}

</section>

</div>
`;
const arranged = (turns) => `<div class="ob-reflection ob-reflection-sequential ob-lanes-1">

${turns.map(([author, text]) => turn(0, author, text)).join("\n")}
</div>
`;
const TURNS = [
  ["MINA", "The moon pulls the water, and the water answers it twice a day along the whole shore."],
  ["JOE", "It is also the sun."],
  ["MINA", "Neither explains the harbour."],
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

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-author-responses-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Answers",
    url: "https://answers-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    contributors: { mina: { name: "Mina" }, joe: { name: "Joe" } },
    engagement: { enabled: true, comments: false, analytics: false, endpoint: ENDPOINT, receipts: true, feedbackContact: "mailto:ada@answers-site.example.org" },
    participation: { kinds: { "third-perspective": "open", "author-response": "open" } },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  const post = (name, front, body, credits = true) => {
    writeFileSync(join(root, "content", "posts", `${name}.md`), `---\ntitle: ${name}\ndate: 2026-10-20\n${front}---\n${body}`);
    if (credits) writeFileSync(join(root, "content", "posts", `${name}.credits.json`), CREDITS);
  };
  post("shared-tides", "", arranged(TURNS));
  post("quiet", "participation:\n  - author-response: hidden\n", arranged(TURNS));
  post("plain", "", "The moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n", false);
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

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** Answers the hosted feedback route with each of `answers` in turn (the last repeats); "abort" drops the connection. */
async function mockService(page, answers = [{ status: 202, body: { status: "pending", receipt: RECEIPT } }]) {
  const submissions = [];
  await page.route(FEEDBACK_URL, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    submissions.push(request.postDataJSON());
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === "abort") {
      await route.abort("internetdisconnected");
      return;
    }
    await route.fulfill({ status: answer.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(answer.body) });
  });
  return { submissions };
}

function outsideRequests(page) {
  const outside = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && url.origin !== new URL(ENDPOINT).origin) outside.push(request.url());
  });
  return outside;
}

const region = (page) => page.getByRole("region", { name: "Offer a Third Perspective" });

async function open(page, path = "/shared-tides/") {
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => customElements.get("ob-third-perspective") !== undefined);
  await expect(page.locator(".ob-third-perspective-form")).toBeVisible();
}

/** The build's own list of author sections, as the page carries it. */
const listed = (page) => page.evaluate(() => JSON.parse(document.getElementById("ob-attributed-sections").textContent));

// ---- Readers

test("keyboard: a reader writes about one author's section, chosen by author and place, and it is sent as an ordinary section target", async ({ page }) => {
  const outside = outsideRequests(page);
  const service = await mockService(page);
  await open(page);
  const form = region(page);
  const sections = await listed(page);
  expect(sections.sections.map((section) => section.anchor)).toEqual(["ob-by-mina-0", "ob-by-joe-0", "ob-by-mina-1"]);

  const whole = form.getByRole("radio", { name: "The whole work" });
  await whole.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const author = form.getByRole("radio", { name: "One author’s section" });
  await expect(author).toBeChecked();
  const select = form.getByLabel("Author’s section", { exact: true });
  await expect(select.locator("option")).toHaveText([
    "MINA, section 1: “The moon pulls the water, and the water answers it twice a…”",
    "JOE, section 1: “It is also the sun.”",
    "MINA, section 2: “Neither explains the harbour.”",
  ]);
  await select.selectOption({ label: "MINA, section 2: “Neither explains the harbour.”" });
  await form.getByLabel("Your reflection", { exact: true }).fill("I read the harbour another way.");
  await form.getByRole("radio", { name: /^Yes, publish it/ }).check();
  await form.getByRole("button", { name: "Send for review" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ob-third-perspective-done")).toContainText("It is published only if a moderator approves it");
  await expect(page.locator(".ob-third-perspective-done")).toBeFocused();

  expect(service.submissions).toHaveLength(1);
  const sent = service.submissions[0];
  expect(sent.kind).toBe("third-perspective");
  expect(sent.target).toEqual({ version: 1, kind: "section", section: "ob-by-mina-1", digest: sections.sections[2].digest });
  expect(JSON.stringify(sent)).not.toMatch(/left|right|column|lane|excerpt|participant/);
  expect(outside).toEqual([]);
});

test("without JavaScript the region says how to name an author's section, and a post that attributes nothing is unchanged", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/shared-tides/`);
  await expect(page.locator(".ob-third-perspective-static")).toContainText("To write about one author’s section, name it by its author and its place among that author’s sections, such as “MINA, section 1”.");
  await page.goto(`${origin}/plain/`);
  await expect(page.locator(".ob-third-perspective-static")).not.toContainText("author’s section");
  await page.goto(`${origin}/quiet/`);
  await expect(page.locator(".ob-third-perspective-static")).not.toContainText("author’s section");
  await context.close();

  const withScript = await browser.newPage();
  for (const path of ["/plain/", "/quiet/"]) {
    await withScript.goto(`${origin}${path}`);
    await withScript.waitForFunction(() => customElements.get("ob-third-perspective") !== undefined);
    await expect(withScript.locator(".ob-third-perspective-form")).toBeVisible();
    await expect(withScript.getByRole("radio", { name: "One author’s section" })).toHaveCount(0);
    await expect(withScript.locator("#ob-attributed-sections")).toHaveCount(0);
  }
  await withScript.close();
});

test("a refusing, rate limiting or absent service keeps the reflection and offers a copy that names the author", async ({ page }) => {
  await mockService(page, [{ status: 429, body: { error: "Too much feedback from here. Please try again later.", code: "rateLimited" } }, "abort"]);
  await open(page);
  const form = region(page);
  await form.getByRole("radio", { name: "One author’s section" }).check();
  await form.getByLabel("Author’s section", { exact: true }).selectOption({ index: 1 });
  await form.getByLabel("Your reflection", { exact: true }).fill("It is the sun, mostly.");
  await form.getByRole("radio", { name: /^Yes, publish it/ }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-third-perspective-fallback-message")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(form.getByLabel("Your reflection", { exact: true })).toHaveValue("It is the sun, mostly.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("Your reflection, ready to send to the author")).toHaveValue(/About: One author’s section: by joe, section 1/);
  const copy = await page.getByLabel("Your reflection, ready to send to the author").inputValue();
  expect(copy.split("open.blog Third Perspective record")[0]).not.toMatch(/ob-by-/);
  expect(copy).toContain('"section":"ob-by-joe-0"');
});

test("it works under a strict content security policy, with the list as data and nothing outside the page", async ({ page }) => {
  await page.route(`${origin}/shared-tides/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const outside = outsideRequests(page);
  const service = await mockService(page);
  await open(page);
  const before = await page.evaluate(() => window.__violations.slice());
  const form = region(page);
  await form.getByRole("radio", { name: "One author’s section" }).check();
  await form.getByLabel("Your reflection", { exact: true }).fill("Under a strict policy.");
  await form.getByRole("radio", { name: /^Yes, publish it/ }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-third-perspective-done")).toBeVisible();
  expect(await page.evaluate(() => window.__violations.slice())).toEqual(before);
  expect(service.submissions[0].target.section).toBe("ob-by-mina-0");
  expect(outside).toEqual([]);
});

for (const [name, viewport, zoom] of [["320px", { width: 320, height: 640 }, 1], ["400% zoom", { width: 1280, height: 800 }, 4]]) {
  test(`at ${name} the region and its author-section choice reflow without scrolling sideways`, async ({ page }) => {
    await page.setViewportSize(zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockService(page);
    await open(page);
    const box = page.locator("#ob-third-perspective");
    const overflow = await box.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const width = page.viewportSize().width;
    const regionBox = await box.boundingBox();
    expect(regionBox.x + regionBox.width).toBeLessThanOrEqual(width);
    for (const label of ["Author’s section", "Your reflection", "Section"]) {
      const control = await page.getByLabel(label, { exact: true }).boundingBox();
      expect(control.x).toBeGreaterThanOrEqual(0);
      expect(control.x + control.width).toBeLessThanOrEqual(width);
    }
    const radio = await page.getByLabel("One author’s section", { exact: true }).boundingBox();
    expect(radio.x + radio.width).toBeLessThanOrEqual(width);
    // Every option's text is long, and none of it widens the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll("#ob-third-perspective *")].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1).map((element) => element.tagName))).toEqual([]);
  });
}

// ---- Admin

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

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const inbox = (items, extra = {}) => ({ state: "approved", kind: "", protocol: "protected", items, invalid: 0, next: null, ...extra });
const queueStatus = (page) => page.locator(".oba-feedback-section").first().locator('p[role="status"]').first();
const SECTION = { contributor: "mina", author: "MINA", standing: { state: "current", moved: false } };

function reflection(n, extra = {}) {
  return {
    id: ID(n), source: "feedback", kind: "third-perspective", kindLabel: "Third Perspective", status: "approved", statusLabel: "Approved", version: 3, revision: 1,
    reason: null, reasonLabel: null, receivedAt: "2026-10-26T10:00:00Z", moderatedAt: "2026-10-26T11:00:00Z", work: "/shared-tides/",
    post: { title: "Tides together", url: "/shared-tides/", source: "posts/shared-tides.md" }, role: "contributing-author", mode: "open", public: true,
    clarification: { askedAboutThisText: false, consent: false }, body: "I read the harbour <b>differently</b>.", details: {},
    reader: { publishName: false }, actions: [], published: false, mayBeShown: true,
    perspective: { about: "section", section: "ob-by-mina-0", check: "current", revision: 1, consent: { number: 1, publish: true, showName: false, clarification: false, feature: false }, attributed: { contributor: "mina", standing: SECTION.standing, author: "MINA" } },
    ...extra,
  };
}

function answer(n, extra = {}) {
  return {
    id: ID(n), source: "feedback", kind: "author-response", kindLabel: "Author response", status: "pending", statusLabel: "Pending", version: 1, revision: 1,
    reason: null, reasonLabel: null, receivedAt: "2026-10-27T10:00:00Z", moderatedAt: null, work: "/shared-tides/",
    post: { title: "Tides together", url: "/shared-tides/", source: "posts/shared-tides.md" }, role: "coordinator", mode: "open", public: false,
    clarification: { askedAboutThisText: false, consent: false }, body: "I meant the harbour, not the open sea. <img src=x onerror=alert(1)>", details: {},
    reader: { publishName: false },
    response: { parent: ID(1), contributor: "mina", author: "MINA", standing: SECTION.standing, section: "ob-by-mina-0", mine: false, withdrawable: false },
    actions: [{ action: "approve", label: "Approve", reasons: [], guidance: "Approves exactly this answer, to be shown as the section author’s own words." }],
    ...extra,
  };
}

test("an author is offered the form only where the server offered it, and sends a plain-text answer from the keyboard", async ({ page }) => {
  const offered = reflection(1, { answerAs: SECTION });
  const other = reflection(2);
  const sent = [];
  let reply = { status: 200, body: { ok: true, answer: { id: ID(9), status: "pending" } } };
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, inbox([offered, other])));
  await page.route(`${origin}/admin/api/engagement/author-response`, async (route) => {
    expect(route.request().method()).toBe("POST");
    sent.push(route.request().postDataJSON());
    return json(route, reply.status, reply.body);
  });
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved`);
  const card = page.locator(`[data-moderation-id="${ID(1)}"]`);
  await expect(card.getByText("About one author’s section by MINA.")).toBeVisible();
  await expect(card.getByText("I read the harbour <b>differently</b>.")).toBeVisible();
  await expect(card.locator("b")).toHaveCount(0);
  // Only the offered card has a form, labelled, described and in plain text.
  await expect(page.locator("[data-answer-form]")).toHaveCount(1);
  await expect(page.locator(`[data-moderation-id="${ID(2)}"] [data-answer-form]`)).toHaveCount(0);
  await expect(card.getByRole("heading", { name: "Answer as MINA", level: 4 })).toBeVisible();
  const text = card.getByLabel("Your answer, in plain text", { exact: true });
  await expect(text).toHaveAccessibleDescription(/once a coordinator approves it\. You cannot approve it yourself/);

  // An empty answer is refused where it is written, and focus stays there.
  await card.getByRole("button", { name: "Send my answer for review" }).focus();
  await page.keyboard.press("Enter");
  await expect(card.getByText("Write your answer first.")).toBeVisible();
  await expect(text).toBeFocused();
  expect(sent).toHaveLength(0);

  // A refusal keeps what was written and says why.
  reply = { status: 403, body: { error: "You cannot answer this reflection as its author.", code: "denied" } };
  await text.fill("I meant the harbour.");
  await card.getByRole("button", { name: "Send my answer for review" }).click();
  await expect(card.getByText("You cannot answer this reflection as its author.")).toBeVisible();
  await expect(text).toHaveValue("I meant the harbour.");
  await expect(text).toBeFocused();

  // A conflict reloads the list, and says so.
  reply = { status: 409, body: { error: "That reflection changed since you loaded it. Review it again before answering.", code: "conflict" } };
  await card.getByRole("button", { name: "Send my answer for review" }).click();
  await expect(queueStatus(page)).toContainText("That reflection changed since you loaded it.");

  // Sending: the request names the reflection, its version and the words, and nothing about who.
  reply = { status: 200, body: { ok: true, answer: { id: ID(9), status: "pending" } } };
  const again = page.locator(`[data-moderation-id="${ID(1)}"]`);
  await again.getByLabel("Your answer, in plain text", { exact: true }).fill("I meant the harbour, not the open sea.");
  await again.getByRole("button", { name: "Send my answer for review" }).click();
  await expect(queueStatus(page)).toHaveText("Your answer was sent. It waits for a coordinator’s approval; nothing was shown or e-mailed.");
  await expect(queueStatus(page)).toBeFocused();
  expect(sent.at(-1)).toEqual({ parent: ID(1), parentVersion: 3, body: "I meant the harbour, not the open sea." });
  expect(dialogs).toEqual([]);
});

test("a moderator reads an answer as the author's words, and an author takes their own back after confirming", async ({ page }) => {
  const coordinator = answer(3);
  const mine = answer(4, { role: "contributing-author", actions: [], response: { parent: ID(1), contributor: "mina", author: "MINA", standing: SECTION.standing, section: "ob-by-mina-0", mine: true, withdrawable: true } });
  const withdrawn = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, inbox([coordinator, mine], { state: "pending" })));
  await page.route(`${origin}/admin/api/engagement/author-response`, async (route) => {
    expect(route.request().method()).toBe("PATCH");
    withdrawn.push(route.request().postDataJSON());
    return json(route, 200, { ok: true, item: { id: ID(4), status: "withdrawn" } });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  const card = page.locator(`[data-moderation-id="${ID(3)}"]`);
  await expect(card.getByRole("heading", { name: "The author’s answer", level: 4 })).toBeVisible();
  await expect(card.getByText("Written by MINA, the author of the section the reader’s reflection is about; the section is still published as the reader read it.")).toBeVisible();
  await expect(card.getByText("never approved by the account that wrote it", { exact: false })).toBeVisible();
  await expect(card.getByText("I meant the harbour, not the open sea. <img src=x onerror=alert(1)>")).toBeVisible();
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card.getByText("From an anonymous reader.")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Take my answer back" })).toHaveCount(0);

  const own = page.locator(`[data-moderation-id="${ID(4)}"]`);
  await expect(own.getByText("This is your own answer.")).toBeVisible();
  await expect(own.getByRole("button", { name: "Approve" })).toHaveCount(0);
  // Taking it back needs its own confirmation first, with focus on it.
  await own.getByRole("button", { name: "Take my answer back" }).focus();
  await page.keyboard.press("Enter");
  await expect(own.getByRole("checkbox", { name: /I understand that my answer is taken off the post for good/ })).toBeFocused();
  expect(withdrawn).toHaveLength(0);
  await own.getByRole("checkbox", { name: /I understand/ }).check();
  await own.getByRole("button", { name: "Take my answer back" }).click();
  await expect(queueStatus(page)).toHaveText("Your answer was taken back. It is not shown anywhere.");
  expect(withdrawn).toEqual([{ id: ID(4), version: 1 }]);
});

test("an answer's card reflows at 320px without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const long = "A very long answer with a very long unbroken token " + "x".repeat(200);
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, inbox([
    reflection(1, { answerAs: SECTION, body: long }),
    answer(3, { body: long, response: { parent: ID(1), contributor: "mina", author: "MINA", standing: { state: "stale", reason: "section-changed-or-removed" }, section: "ob-by-mina-0", mine: true, withdrawable: true, account: "mina-admin" } }),
  ])));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved`);
  const card = page.locator(`[data-moderation-id="${ID(3)}"]`);
  await expect(card).toBeVisible();
  for (const selector of [`[data-moderation-id="${ID(1)}"]`, `[data-moderation-id="${ID(3)}"]`]) {
    const box = page.locator(selector);
    const overflow = await box.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, selector).toBeLessThanOrEqual(0);
    const bounds = await box.boundingBox();
    expect(bounds.x + bounds.width, selector).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const form = page.locator(`[data-moderation-id="${ID(1)}"] [data-answer-form]`);
  const textarea = await form.getByLabel("Your answer, in plain text", { exact: true }).boundingBox();
  expect(textarea.x + textarea.width).toBeLessThanOrEqual(320);
});
