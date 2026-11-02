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

// The one moderation inbox (#225, ADR 0105). The hosted inbox is mocked at the Admin API (the real
// Admin keeps the hosted token, resolves each item's actor and sends only what that actor may
// see); everything else is the real Admin. Covers keyboard-only decisions on comments and passage
// feedback, a moved passage confirmed before approval, clarification and removal as their own
// decisions, reasons with guidance, conflicts and refusals, the coordinator's and contributing
// author's views, paging with focus, the kind filter, hostile text, a missing post, a failing
// provider, and 320px without horizontal scrolling.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://inbox.example/api";
const HOSTILE = "<img src=x onerror=alert(1)>";
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-moderation-inbox-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Inbox",
    url: "https://inbox-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: true, analytics: false, feedback: true, endpoint: ENDPOINT },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), "---\ntitle: Tides\ndate: 2026-10-20\n---\nThe moon causes the tides.\n");
  execFileSync(binary, ["user", "add", "writer", "--root", root], {
    env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe",
  });
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
    expect((await fetch(`${origin}/admin/`)).ok).toBe(true);
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

const DECLINE = [{ id: "spam", label: "Spam" }, { id: "off-topic", label: "Off topic" }, { id: "other", label: "Other" }];
const CLARIFY = [{ id: "unclear", label: "Unclear" }, { id: "needs-source", label: "Needs a source" }];
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const approve = { action: "approve", label: "Approve", reasons: [], guidance: "Shows the comment on its post." };
const reject = { action: "reject", label: "Reject", reasons: DECLINE, guidance: "Never shown. Comments are kept until you act." };

/** An inbox item as the Admin server describes it to the signed-in account. */
function inboxItem(n, extra = {}) {
  return {
    id: ID(n),
    source: "comment",
    kind: "comment",
    kindLabel: "Comment",
    status: "pending",
    statusLabel: "Pending",
    version: 3,
    revision: 1,
    reason: null,
    reasonLabel: null,
    receivedAt: "2026-10-26T10:00:00Z",
    moderatedAt: null,
    work: "/tides/",
    post: { title: "Tides", url: "/tides/", source: "posts/tides.md" },
    role: "site-admin",
    mode: "open",
    public: false,
    clarification: { askedAboutThisText: false, consent: false },
    body: `First comment. ${HOSTILE}`,
    details: {},
    reader: { name: "Grace", publishName: true },
    actions: [approve, reject],
    ...extra,
  };
}

function staleFeedback(n) {
  return inboxItem(n, {
    source: "feedback",
    kind: "correction-suggestion",
    kindLabel: "Suggested correction",
    body: "It was three times a day.",
    details: { suggestedText: "We measured three times a day." },
    reader: { publishName: false, name: "Private Reader" },
    clarification: { askedAboutThisText: false, consent: true },
    passage: { check: "stale", reason: "quoteNotFound", explanation: "Stale: the post changed after the reader saw it.", revisionSeen: "p1:11111111111111111111111111111111", revisionNow: "p1:22222222222222222222222222222222", acknowledge: true, quoted: "twice a day" },
    publicPreview: { work: "/tides/", revision: "p1:11111111111111111111111111111111", received: "2026-10-26", stale: true },
    published: false,
    actions: [
      { action: "approve", label: "Approve", reasons: [], guidance: "Publishes the reader’s words on the post as theirs, at this revision." },
      { action: "request-clarification", label: "Ask to clarify", reasons: CLARIFY, guidance: "Asks the reader, through their private receipt, to revise it; nothing is e-mailed." },
      { action: "reject", label: "Reject", reasons: DECLINE, guidance: "Never shown. Its text is due to be purged 30 days after this decision." },
    ],
  });
}

const page_ = (items, extra = {}) => ({ state: "pending", kind: "", protocol: "full", items, invalid: 0, next: null, ...extra });
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const queueStatus = (page) => page.locator(".oba-feedback-section").first().locator('p[role="status"]').first();

test("comments and passage feedback are decided from the keyboard in one list", async ({ page }) => {
  let items = [inboxItem(1), staleFeedback(2)];
  const changes = [];
  let answer = null;
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await page.route(`${origin}/admin/api/engagement/moderation`, async (route) => {
    expect(route.request().method()).toBe("PATCH");
    const body = route.request().postDataJSON();
    changes.push(body);
    if (answer) return json(route, answer.status, answer.body);
    items = items.filter((item) => item.id !== body.id);
    return json(route, 200, { item: { id: body.id, status: "approved" }, published: false, publishError: null });
  });
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  await expect(page.getByRole("heading", { name: "Moderation queue", level: 2 })).toBeVisible();
  await expect(queueStatus(page)).toHaveText("2 pending items.");
  await expect(page.getByRole("link", { name: "Pending", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Moderation inbox", exact: true })).toHaveAttribute("aria-current", "page");

  const comment = page.locator(`[data-moderation-id="${ID(1)}"]`);
  await expect(comment.getByRole("heading", { name: "Comment on “Tides”", level: 3 })).toBeVisible();
  await expect(comment.getByText(`First comment. ${HOSTILE}`)).toBeVisible();
  await expect(comment.locator("img")).toHaveCount(0);
  await expect(comment.getByText("From Grace, shown with the comment.")).toBeVisible();
  await expect(comment.getByText("You moderate this as the site Admin.")).toBeVisible();
  // Each decision's guidance is its description.
  await expect(comment.getByRole("button", { name: "Approve", exact: true })).toHaveAccessibleDescription("Shows the comment on its post.");

  // Feedback whose passage moved: approval waits for the confirmation, with focus on it.
  const note = page.locator(`[data-moderation-id="${ID(2)}"]`);
  await expect(note.locator('.oba-feedback-passage[data-check="stale"]')).toContainText("Stale.");
  await expect(note.getByText("The name stays private", { exact: false })).toBeVisible();
  await note.getByRole("button", { name: "Approve", exact: true }).focus();
  await page.keyboard.press("Enter");
  const confirm = note.getByRole("checkbox", { name: /I have read the passage as it is published now/ });
  await expect(confirm).toBeFocused();
  expect(changes).toHaveLength(0);

  // Asking to clarify is its own decision, with its own reasons, never an approval.
  await note.getByRole("button", { name: "Ask to clarify", exact: true }).focus();
  await page.keyboard.press("Enter");
  const why = note.getByLabel("Reason to ask to clarify");
  await expect(why).toBeFocused();
  await why.selectOption("needs-source");
  await note.getByRole("button", { name: "Ask to clarify", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toHaveText("Asked the reader to clarify. Nothing was published or e-mailed.");
  await expect(queueStatus(page)).toBeFocused();
  expect(changes[0]).toEqual({ source: "feedback", id: ID(2), action: "request-clarification", from: "pending", version: 3, reason: "needs-source" });

  // A conflict reloads the list and says so; a refusal says so on the card.
  answer = { status: 409, body: { error: "This item changed since you loaded it. Review it again before acting.", code: "conflict", item: null } };
  await comment.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(queueStatus(page)).toContainText("This item changed since you loaded it.");
  expect(changes[1]).toEqual({ source: "comment", id: ID(1), action: "approve", from: "pending", version: 3 });
  answer = { status: 403, body: { error: "You cannot take this decision on this item.", code: "denied" } };
  const again = page.locator(`[data-moderation-id="${ID(1)}"]`);
  await again.getByLabel("Reason to reject").selectOption("spam");
  await again.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(again.getByText("You cannot take this decision on this item.")).toBeVisible();
  answer = null;
  await again.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(queueStatus(page)).toHaveText("Approved. The comment is shown on “Tides”.");
  await expect(page.locator("[data-moderation-id]")).toHaveCount(0);
  await expect(queueStatus(page)).toBeFocused();
  expect(dialogs).toEqual([]);
});

test("a coordinator never sees a private name or a reopen, and a contributing author decides nothing", async ({ page }) => {
  const items = [
    inboxItem(3, { status: "removed", statusLabel: "Removed", reasonLabel: "Spam", role: "coordinator", source: "feedback", kind: "question", kindLabel: "Question", reader: { publishName: false, private: true }, actions: [], published: null, passage: { check: "current", explanation: "Current.", revisionSeen: "p1:22222222222222222222222222222222", acknowledge: false } }),
    inboxItem(4, { status: "removed", statusLabel: "Removed", role: "contributing-author", actions: [] }),
  ];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items, { state: "removed" })));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/removed`);
  const coordinator = page.locator(`[data-moderation-id="${ID(3)}"]`);
  await expect(coordinator.getByText("You moderate this as a coordinator", { exact: false })).toBeVisible();
  await expect(coordinator.getByText("The reader gave a name that only the site Admin can see.")).toBeVisible();
  await expect(coordinator.getByRole("button", { name: "Reopen" })).toHaveCount(0);
  await expect(coordinator.getByText("No decision is open to you on this item.")).toBeVisible();
  await expect(coordinator.getByRole("button", { name: /Publish on the post|Take it off/ })).toHaveCount(0);
  const author = page.locator(`[data-moderation-id="${ID(4)}"]`);
  await expect(author.getByText("You can read this as a contributing author of the work.", { exact: false })).toBeVisible();
  await expect(author.getByRole("button")).toHaveCount(0);
});

test("pages load more with focus on the first new item, and the kind filter is a labelled form", async ({ page }) => {
  const requests = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => {
    const url = new URL(route.request().url());
    requests.push(Object.fromEntries(url.searchParams));
    if (url.searchParams.get("after")) return json(route, 200, page_([inboxItem(6, { body: "Second page." })]));
    if (url.searchParams.get("kind") === "question") return json(route, 200, page_([], { kind: "question" }));
    return json(route, 200, page_([inboxItem(5)], { next: `2026-10-26T10:00:00.000000Z~${ID(5)}`, invalid: 1 }));
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  await expect(queueStatus(page)).toHaveText("1 pending item. More are listed after these. 1 item was not valid and is not shown.");
  const more = page.getByRole("button", { name: "Show more", exact: true });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Comment on “Tides”", level: 3 }).nth(1)).toBeFocused();
  await expect(page.locator("[data-moderation-id]")).toHaveCount(2);
  await expect(more).toBeHidden();
  expect(requests.at(-1)).toEqual({ state: "pending", after: `2026-10-26T10:00:00.000000Z~${ID(5)}` });

  const kind = page.getByLabel("Kind", { exact: true });
  await kind.focus();
  await kind.selectOption("question");
  await page.getByRole("button", { name: "Show", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/moderation\/pending\?kind=question$/);
  await expect(queueStatus(page)).toHaveText("No pending items.");
  expect(requests.at(-1)).toEqual({ state: "pending", kind: "question" });
  await expect(page.getByLabel("Kind", { exact: true })).toHaveValue("question");
});

test("clarification, a missing post and a failing provider are each explained", async ({ page }) => {
  let failing = false;
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => {
    if (failing) return json(route, 502, { error: "Hosted engagement request failed" });
    return json(route, 200, page_([
      inboxItem(7, { status: "clarification", statusLabel: "Waiting for clarification", source: "feedback", kind: "question", kindLabel: "Question", clarification: { askedAboutThisText: true, consent: true }, actions: [reject], reader: { publishName: false }, published: null }),
      inboxItem(8, { post: null, work: "/gone/", status: "approved", statusLabel: "Approved", actions: [{ action: "remove", label: "Remove from the post", reasons: DECLINE, guidance: "Takes it off the post." }] }),
    ], { state: "clarification" }));
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/clarification`);
  await expect(page.getByText("These wait for the reader’s answer through their private receipt.", { exact: false })).toBeVisible();
  const waiting = page.locator(`[data-moderation-id="${ID(7)}"]`);
  await expect(waiting.getByText("A clarification was asked about this text. It can never be approved", { exact: false })).toBeVisible();
  await expect(waiting.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const gone = page.locator(`[data-moderation-id="${ID(8)}"]`);
  await expect(gone.getByRole("heading", { name: "Comment on /gone/", level: 3 })).toBeVisible();
  await expect(gone.getByText("No post has this address now", { exact: false })).toBeVisible();
  await expect(gone.getByLabel("Reason to remove from the post")).toBeVisible();

  failing = true;
  await page.getByRole("link", { name: "Rejected", exact: true }).click();
  await expect(queueStatus(page)).toHaveText("The inbox could not be loaded. Hosted engagement request failed");
  await expect(page.locator("[data-moderation-id]")).toHaveCount(0);
});

test("the inbox reflows at 320px with every control reachable", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([staleFeedback(9), inboxItem(10, { body: "x".repeat(400) })])));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  await expect(queueStatus(page)).toHaveText("2 pending items.");
  // The inbox's own content never scrolls sideways: its sections, cards, state links and every
  // control fit the 320px viewport (the Admin header is outside this view).
  const wide = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".oba-feedback-section, .oba-feedback-section *")]
      .filter((element) => element.getBoundingClientRect().right > width + 1 || element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
      .map((element) => element.className || element.tagName);
  });
  expect(wide).toEqual([]);
  for (const control of await page.locator(".oba-moderation-states a, .oba-moderation-filter select, .oba-moderation-item button, .oba-moderation-item select, .oba-moderation-item input").all()) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(321);
  }
  await context.close();
});

test("a Third Perspective's card shows its consent and credit hint, and its approval names what was seen", async ({ page }) => {
  const perspective = inboxItem(9, {
    source: "feedback",
    kind: "third-perspective",
    kindLabel: "Third Perspective",
    revision: 2,
    body: `Tides as one conversation. ${HOSTILE}`,
    details: { category: "connection", categoryLabel: "A connection", prompt: "What does this bring to mind: another work, idea or source?" },
    reader: { name: "A", publishName: true },
    clarification: { askedAboutThisText: false, consent: true },
    perspective: { about: "section", section: "methods", check: "current", revision: 2, consent: { number: 3, publish: true, showName: true, clarification: true, feature: false }, approvedConsent: null, nameMatchesCredit: true, channel: "hosted" },
    perspectivePreview: { heading: "Third Perspective from a reader", name: null, about: "section", section: "methods", stale: false, received: "2026-10-26" },
    publicPreview: null,
    published: null,
    actions: [
      { action: "approve", label: "Approve", reasons: [], guidance: "Approves exactly this text under the consent the reader gives now, to be shown on the post as a reader’s reflection, never as yours." },
      { action: "reject", label: "Reject", reasons: DECLINE, guidance: "Never shown." },
    ],
  });
  let items = [perspective];
  const changes = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items, { kind: "third-perspective" })));
  await page.route(`${origin}/admin/api/engagement/moderation`, async (route) => {
    const body = route.request().postDataJSON();
    changes.push(body);
    items = [];
    return json(route, 200, { item: { id: body.id, status: "approved" }, published: false, publishError: null });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/pending?kind=third-perspective`);
  await expect(page.getByLabel("Kind", { exact: true })).toHaveValue("third-perspective");
  const card = page.locator(`[data-moderation-id="${ID(9)}"]`);
  await expect(card.getByRole("heading", { name: "Third Perspective on “Tides”", level: 3 })).toBeVisible();
  await expect(card.getByRole("heading", { name: "The reader’s reflection", level: 4 })).toBeVisible();
  await expect(card.getByText(`Tides as one conversation. ${HOSTILE}`)).toBeVisible();
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card.getByText("About the section #methods.")).toBeVisible();
  await expect(card.getByText("Prompt: A connection", { exact: false })).toBeVisible();
  await expect(card.getByText("Consent record 3: the reader agrees to publish it with their name, if you approve it", { exact: false })).toBeVisible();
  await expect(card.getByText("matches a name this work credits", { exact: false })).toBeVisible();
  await expect(card.getByText("If approved, it is shown as “Third Perspective from a reader”", { exact: false })).toBeVisible();
  await card.getByRole("button", { name: "Approve", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toContainText("consent record 3, as a reader’s reflection on “Tides”");
  expect(changes).toEqual([{ source: "feedback", id: ID(9), action: "approve", from: "pending", version: 3, seenRevision: 2, seenConsent: 3 }]);
});

test("a reflection the reader withdrew is taken off its post from its card, by the site Admin", async ({ page }) => {
  const withdrawn = inboxItem(11, {
    source: "feedback",
    kind: "third-perspective",
    kindLabel: "Third Perspective",
    status: "withdrawn",
    statusLabel: "Withdrawn",
    purged: true,
    body: null,
    details: {},
    reader: { publishName: false },
    published: true,
    mayBeShown: false,
    nameOutOfDate: false,
    actions: [],
  });
  let items = [withdrawn];
  const synced = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items, { state: "withdrawn", kind: "third-perspective" })));
  await page.route(`${origin}/admin/api/engagement/third-perspectives/unpublish`, async (route) => {
    synced.push(route.request().postDataJSON());
    items = [{ ...withdrawn, published: false }];
    return json(route, 200, { published: false, build: { ok: true, posts: 1 } });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/withdrawn?kind=third-perspective`);
  const card = page.locator(`[data-moderation-id="${ID(11)}"]`);
  await expect(card.getByText("The reader withdrew this reflection through their receipt", { exact: false })).toBeVisible();
  const button = card.getByRole("button", { name: "Take it off the post" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toContainText("Taken off “Tides”.");
  expect(synced).toEqual([{ id: ID(11) }]);
  await expect(page.locator(`[data-moderation-id="${ID(11)}"]`).getByRole("button", { name: "Take it off the post" })).toHaveCount(0);
});

test("published reflections that must come off are counted on every tab, and taken off from the banner", async ({ page }) => {
  let audit = {
    checked: 2,
    truncated: false,
    mustComeOff: [{ id: ID(21), post: "posts/tides.md" }],
    unknown: [{ id: ID(22), post: "posts/tides.md" }],
  };
  const synced = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([], { state: new URL(route.request().url()).searchParams.get("state") })));
  await page.route(`${origin}/admin/api/engagement/third-perspectives/published`, (route) => json(route, 200, audit));
  await page.route(`${origin}/admin/api/engagement/third-perspectives/unpublish`, async (route) => {
    synced.push(route.request().postDataJSON());
    audit = { ...audit, mustComeOff: [] };
    return json(route, 200, { published: false, build: { ok: true, posts: 1 } });
  });
  await signIn(page);
  // Pending, with no card for it, and under another filter: the banner is on every tab.
  for (const hash of ["pending", "approved", "withdrawn?kind=third-perspective"]) {
    await page.goto(`${origin}/admin/#/moderation/${hash}`);
    await expect(page.locator('[data-perspective-notice="mustComeOff"]')).toContainText("1 published reflection must come off its post");
    await expect(page.locator('[data-perspective-notice="unknown"]')).toContainText("cannot be checked against the hosted copy");
  }
  // The Withdrawn tab no longer says these were never published.
  await expect(page.getByText("never published", { exact: false })).toHaveCount(0);
  await expect(page.getByText("stays on its post until you take it off", { exact: false })).toBeVisible();
  // Keyboard: take it off from the banner.
  const button = page.locator('[data-perspective-notice="mustComeOff"]').getByRole("button", { name: "Take it off the post" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toContainText("Taken off its post.");
  expect(synced).toEqual([{ id: ID(21) }]);
  await expect(page.locator('[data-perspective-notice="mustComeOff"]')).toHaveCount(0);
  await expect(page.locator('[data-perspective-notice="unknown"]')).toBeVisible();
});
