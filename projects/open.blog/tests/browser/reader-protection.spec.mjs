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

// Engagement protection (#226, ADRs 0107 and 0108), in the real site and the real Admin, with the
// hosted function mocked at its routes (the reader's pages) and at the Admin API (the inbox).
// Covers the receipt shown once after a note is taken, agreeing to be asked, answering a
// clarification request and withdrawing a note by receipt, anonymous abuse reports under a
// published note and a comment, upholding a report and deleting a closed item's text in the
// inbox, the retention dry run before a confirmed run, keyboard use, live status, hostile text,
// no JavaScript and 320px without horizontal scrolling.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://protect.example/api";
const HOSTILE = "<img src=x onerror=alert(1)>";
const RECEIPT = "Rcpt_" + "a".repeat(38);
const NOTE_ID = "00000000-0000-4000-8000-0000000000b1";
const COMMENT_ID = "00000000-0000-4000-8000-0000000000c1";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-reader-protection-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Protection",
    url: "https://protect-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: true, analytics: false, feedback: true, receipts: true, endpoint: ENDPOINT },
    participation: { kinds: { "abuse-report": "open" } },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), "---\ntitle: Tides\ndate: 2026-10-20\n---\nThe moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n");
  writeFileSync(join(root, "content", "reader-feedback.json"), `${JSON.stringify({
    version: 1,
    items: [{
      id: NOTE_ID, post: "posts/tides.md", work: "/tides/", kind: "question", body: `Why the moon? ${HOSTILE}`,
      revision: "p1:00000000000000000000000000000000", target: { version: 1, kind: "work" }, received: "2026-10-26", approved: "2026-10-27",
    }],
  }, null, 2)}\n`);
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

const json = (route, status, body) => route.fulfill({
  status,
  contentType: "application/json",
  headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" },
  body: JSON.stringify(body),
});
const preflight = (route) => route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST" }, body: "" });

/**
 * The hosted function's public routes, recording what the page sends. `receipt` maps a receipt
 * action to its answer and `options.report` is the answer to a report; either may be changed
 * between requests, and an answer `{ abort: true }` drops the connection, as when the reader is
 * offline.
 */
async function mockHosted(page, options = {}) {
  const { receipt = {}, comments = [] } = options;
  const sent = { feedback: [], receipt: [], reports: [] };
  await page.route(`${ENDPOINT}/comments?**`, (route) => json(route, 200, { comments }));
  for (const name of ["feedback", "receipt", "reports"]) {
    await page.route(`${ENDPOINT}/${name}`, async (route) => {
      if (route.request().method() === "OPTIONS") return preflight(route);
      const body = JSON.parse(route.request().postData() || "{}");
      sent[name].push(body);
      if (name === "feedback") return json(route, 202, { id: ID(1), status: "pending", receivedAt: "2026-10-27T10:00:00Z", receipt: RECEIPT });
      const answer = name === "reports" ? options.report ?? { status: 202, body: { status: "pending" } } : receipt[body.action || "read"];
      if (answer?.abort) return route.abort("internetdisconnected");
      return answer ? json(route, answer.status ?? 200, answer.body) : json(route, 404, { error: "No note matches this receipt.", code: "unknownReceipt" });
    });
  }
  return sent;
}
// What the hosted function answers when a client is over its quota or its database is down, and a
// dropped connection.
const LIMITED = { status: 429, body: { error: "Too many requests from here. Please try again later.", code: "rateLimited" } };
const DOWN = { status: 502, body: { error: "The hosted data service is unavailable." } };
const OFFLINE = { abort: true };
const CONFLICT = (item) => ({ status: 409, body: { error: "Your note changed since you loaded it. Review it again.", code: "conflict", item } });
const RECEIPT_FAILURES = [
  [OFFLINE, "The service did not answer. Check your connection and try again."],
  [LIMITED, "Too many requests have come from here recently. Please try again later."],
  [DOWN, "Something went wrong. Please try again later, or write to the author."],
];

const noteItem = (extra = {}) => ({ kind: "question", status: "pending", version: 1, work: "/tides/", receivedAt: "2026-10-27T10:00:00Z", clarification: null, consent: false, published: false, purged: false, body: "How was it measured?", details: {}, ...extra });

test("a note's receipt is shown once, copied by keyboard, and records consent to be asked", async ({ page }) => {
  const sent = await mockHosted(page, { receipt: { consent: { body: { item: noteItem({ consent: true }) } } } });
  await page.goto(`${origin}/tides/`);
  const region = page.locator("#ob-feedback");
  await region.getByLabel("Kind of feedback").selectOption("question");
  await region.getByLabel("Your note", { exact: true }).fill("How was it measured?");
  await region.getByRole("button", { name: "Send for review" }).focus();
  await page.keyboard.press("Enter");
  await expect(region.getByText("Keep the receipt below.", { exact: false })).toBeFocused();
  const panel = region.getByRole("region", { name: "Your private receipt" });
  await expect(panel.getByLabel("Receipt", { exact: true })).toHaveValue(RECEIPT);
  await expect(panel.getByText("nothing is e-mailed to you", { exact: false })).toBeVisible();
  const consent = panel.getByLabel("The author may ask me to clarify this note through this receipt");
  await consent.focus();
  await page.keyboard.press("Space");
  await expect(panel.getByRole("status")).toHaveText("Saved: the author may ask you to clarify this note.");
  expect(sent.receipt.at(-1)).toEqual({ receipt: RECEIPT, action: "consent", consent: true, expectedVersion: 1 });
  // The receipt is never kept in the browser.
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
});

test("a receipt answers a clarification request and then withdraws the note, confirmed first", async ({ page }) => {
  const asked = noteItem({ status: "clarification", version: 2, clarification: { reason: "needs-source" }, consent: true, body: `Old words ${HOSTILE}` });
  const sent = await mockHosted(page, {
    receipt: {
      read: { body: { item: asked } },
      clarify: { body: { item: noteItem({ version: 3, body: "Clearer words." }) } },
      withdraw: { body: { item: noteItem({ status: "withdrawn", version: 5, purged: true, body: undefined }) } },
    },
  });
  await page.goto(`${origin}/tides/`);
  const manage = page.locator(".ob-receipt-manage");
  await manage.locator("summary").focus();
  await page.keyboard.press("Enter");
  const input = manage.getByLabel("Your receipt");
  await input.fill("not a receipt");
  await manage.getByRole("button", { name: "Look up my note" }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.fill(RECEIPT);
  await input.press("Enter");
  await expect(manage.getByRole("heading", { name: "Your note", level: 3 })).toBeFocused();
  await expect(manage.getByText("because it needs a source", { exact: false })).toBeVisible();
  await expect(manage.locator("blockquote")).toHaveText(`Old words ${HOSTILE}`);
  await expect(manage.locator("blockquote img")).toHaveCount(0);
  await manage.getByLabel("Your clarified note").fill("Clearer words.");
  await manage.getByRole("button", { name: "Send my clarified note" }).click();
  await expect(manage.getByRole("status").first()).toHaveText("Thank you. Your clarified note was sent for review.");
  expect(sent.receipt.at(-1)).toEqual({ receipt: RECEIPT, action: "clarify", expectedVersion: 2, body: "Clearer words." });

  // Withdrawing needs its own confirmation.
  const withdraw = manage.getByRole("button", { name: "Withdraw and delete my note" });
  await withdraw.click();
  await expect(manage.getByLabel("I want this note’s text and my name deleted. This cannot be undone.")).toBeFocused();
  expect(sent.receipt.filter((body) => body.action === "withdraw")).toHaveLength(0);
  await page.keyboard.press("Space");
  await withdraw.click();
  await expect(manage.getByRole("status").first()).toHaveText("Your note was withdrawn and its text and your name deleted.");
  await expect(manage.getByText("You withdrew it. Its text and your name were deleted", { exact: false })).toBeVisible();
  await expect(manage.getByRole("button", { name: "Withdraw and delete my note" })).toHaveCount(0);
  expect(sent.receipt.at(-1)).toEqual({ receipt: RECEIPT, action: "withdraw", expectedVersion: 3 });
});

test("a published note and a comment can be reported anonymously, with a ground chosen first", async ({ page }) => {
  const sent = await mockHosted(page, { comments: [{ id: COMMENT_ID, authorName: "Grace", body: `Rude ${HOSTILE}`, createdAt: "2026-10-26T10:00:00Z" }] });
  await page.goto(`${origin}/tides/`);
  const note = page.locator(`#ob-reader-note-${NOTE_ID}`);
  await note.getByText("Report this note").click();
  const send = note.getByRole("button", { name: "Send report" });
  await send.click();
  await expect(note.getByRole("radio", { name: "Spam" })).toBeFocused();
  await expect(note.getByText("Choose why you are reporting it.").first()).toBeVisible();
  await note.getByRole("radio", { name: "Abusive" }).check();
  await note.getByLabel("Anything the author should know (optional)").fill("  Targets a person.  ");
  await send.click();
  await expect(note.getByRole("status")).toHaveText("Thank you. Your report was sent to the author, who reviews every report. It is not published.");
  await expect(note.getByRole("status")).toBeFocused();
  expect(sent.reports).toEqual([{ source: "feedback", id: NOTE_ID, ground: "abusive", body: "Targets a person." }]);

  const discussion = page.locator("ob-comments");
  await expect(discussion.getByText(`Rude ${HOSTILE}`)).toBeVisible();
  await expect(discussion.locator("img")).toHaveCount(0);
  await discussion.getByText("Report this comment").click();
  await discussion.getByRole("radio", { name: "Spam" }).check();
  await discussion.getByRole("button", { name: "Send report" }).click();
  await expect(discussion.getByText("Thank you. Your report was sent", { exact: false })).toBeVisible();
  expect(sent.reports.at(-1)).toEqual({ source: "comment", id: COMMENT_ID, ground: "spam" });
});

test("a receipt lookup that fails says why in the live status and takes the reader there", async ({ page }) => {
  const answers = {};
  await mockHosted(page, { receipt: answers });
  await page.goto(`${origin}/tides/`);
  const manage = page.locator(".ob-receipt-manage");
  await manage.locator("summary").click();
  const input = manage.getByLabel("Your receipt");
  const status = manage.getByRole("status").first();
  for (const [answer, message] of RECEIPT_FAILURES) {
    answers.read = answer;
    await input.fill(RECEIPT);
    await input.press("Enter");
    await expect(status).toHaveText(message);
    await expect(status).toBeFocused();
    await expect(manage.getByRole("heading", { name: "Your note" })).toHaveCount(0);
  }
});

test("receipt actions that fail or meet a changed note say so, keep the reader's place and never lose their words", async ({ page }) => {
  const asked = noteItem({ status: "clarification", version: 2, clarification: { reason: "unclear" }, consent: true, body: "Old words." });
  const answers = { read: { body: { item: asked } } };
  const sent = await mockHosted(page, { receipt: answers });
  await page.goto(`${origin}/tides/`);
  const manage = page.locator(".ob-receipt-manage");
  await manage.locator("summary").click();
  await manage.getByLabel("Your receipt").fill(RECEIPT);
  await manage.getByRole("button", { name: "Look up my note" }).click();
  await expect(manage.getByRole("heading", { name: "Your note", level: 3 })).toBeFocused();
  const status = manage.getByRole("status").first();

  // A clarification that cannot be sent keeps the answer, with focus on it.
  const answer = manage.getByLabel("Your clarified note");
  await answer.fill("Clearer words.");
  for (const [reply, message] of RECEIPT_FAILURES) {
    answers.clarify = reply;
    await manage.getByRole("button", { name: "Send my clarified note" }).click();
    await expect(status).toHaveText(message);
    await expect(answer).toBeFocused();
    await expect(answer).toHaveValue("Clearer words.");
  }
  // The author decided meanwhile: the note is shown as it is now, and nothing is sent over it.
  answers.clarify = CONFLICT(noteItem({ status: "rejected", version: 3, body: "Old words." }));
  await manage.getByRole("button", { name: "Send my clarified note" }).click();
  await expect(status).toHaveText("Your note changed since you looked it up. Here it is as it is now.");
  await expect(status).toBeFocused();
  await expect(manage.getByText("The author decided not to publish it.")).toBeVisible();
  await expect(manage.getByLabel("Your clarified note")).toHaveCount(0);

  // Withdrawing that fails says why and takes the reader there; a changed note is shown again.
  await manage.getByLabel("I want this note’s text and my name deleted. This cannot be undone.").check();
  const withdraw = manage.getByRole("button", { name: "Withdraw and delete my note" });
  for (const [reply, message] of RECEIPT_FAILURES) {
    answers.withdraw = reply;
    await withdraw.click();
    await expect(status).toHaveText(message);
    await expect(status).toBeFocused();
    await expect(withdraw).toBeEnabled();
  }
  answers.withdraw = CONFLICT(noteItem({ status: "removed", version: 4, body: "Old words." }));
  await withdraw.click();
  await expect(status).toHaveText("Your note changed since you looked it up. Here it is as it is now.");
  await expect(status).toBeFocused();
  await expect(manage.getByText("The author took it off the post.")).toBeVisible();
  expect(sent.receipt.filter((body) => body.action === "withdraw").map((body) => body.expectedVersion)).toEqual([3, 3, 3, 3]);
});

test("agreeing to be asked that fails says why, keeps the box as it was and focus on it", async ({ page }) => {
  const answers = {};
  await mockHosted(page, { receipt: answers });
  await page.goto(`${origin}/tides/`);
  const region = page.locator("#ob-feedback");
  await region.getByLabel("Kind of feedback").selectOption("question");
  await region.getByLabel("Your note", { exact: true }).fill("How was it measured?");
  await region.getByRole("button", { name: "Send for review" }).click();
  const panel = region.getByRole("region", { name: "Your private receipt" });
  const consent = panel.getByLabel("The author may ask me to clarify this note through this receipt");
  const status = panel.getByRole("status");
  for (const [reply, message] of [
    ...RECEIPT_FAILURES,
    [CONFLICT(noteItem({ status: "rejected", version: 2 })), "Your note changed since you sent it, so this was not saved. Try again."],
  ]) {
    answers.consent = reply;
    await consent.focus();
    await page.keyboard.press("Space");
    await expect(status).toHaveText(message);
    await expect(consent).not.toBeChecked();
    await expect(consent).toBeFocused();
  }
});

test("a report that cannot be sent says why, keeps the form and focus on the status, and can be sent again", async ({ page }) => {
  const hosted = { report: OFFLINE };
  const sent = await mockHosted(page, hosted);
  await page.goto(`${origin}/tides/`);
  const note = page.locator(`#ob-reader-note-${NOTE_ID}`);
  await note.getByText("Report this note").click();
  await note.getByRole("radio", { name: "Spam" }).check();
  const send = note.getByRole("button", { name: "Send report" });
  const status = note.getByRole("status");
  for (const [reply, message] of [
    [OFFLINE, "Your report could not be sent: the service did not answer. You can write to the author instead."],
    [LIMITED, "Too many reports have come from here recently. Please try again later."],
    [DOWN, "Your report could not be sent. You can write to the author instead."],
  ]) {
    hosted.report = reply;
    await send.click();
    await expect(status).toHaveText(message);
    await expect(status).toBeFocused();
    await expect(send).toBeVisible();
    await expect(note.getByRole("radio", { name: "Spam" })).toBeChecked();
  }
  hosted.report = null;
  await send.click();
  await expect(status).toHaveText("Thank you. Your report was sent to the author, who reviews every report. It is not published.");
  await expect(status).toBeFocused();
  expect(sent.reports).toHaveLength(4);
});

// How far the post's main content (the notes, the report forms, the receipt form) pokes past the
// viewport or scrolls sideways, with what overflows. The site's own header and navigation belong
// to the theme, whose width depends on the platform's fonts, not to these forms.
const mainOverflow = (page) =>
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

test("without JavaScript the page says how to report and to send a note, and fits 320px", async ({ browser }) => {
  const still = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 800 } });
  const page = await still.newPage();
  await page.goto(`${origin}/tides/`);
  await expect(page.getByText("To report this note as abusive, write to the author.")).toBeVisible();
  await expect(page.getByText("The feedback form needs JavaScript", { exact: false })).toBeVisible();
  const still320 = await mainOverflow(page);
  expect(still320.overflow, still320.offenders.join(", ")).toBeLessThanOrEqual(1);
  await still.close();
  const narrow = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const live = await narrow.newPage();
  await mockHosted(live);
  await live.goto(`${origin}/tides/`);
  await live.locator(`#ob-reader-note-${NOTE_ID}`).getByText("Report this note").click();
  await live.locator(".ob-receipt-manage summary").click();
  const live320 = await mainOverflow(live);
  expect(live320.overflow, live320.offenders.join(", ")).toBeLessThanOrEqual(1);
  await narrow.close();
});

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

const UPHOLD = [{ id: "abusive", label: "Abusive" }, { id: "spam", label: "Spam" }];
function reportItem(extra = {}) {
  return {
    id: ID(7), source: "report", kind: "abuse-report", kindLabel: "Abuse report", status: "pending", statusLabel: "Pending", version: 1, revision: 1,
    reason: null, reasonLabel: null, receivedAt: "2026-10-26T10:00:00Z", moderatedAt: null, work: "/tides/",
    post: { title: "Tides", url: "/tides/", source: "posts/tides.md" }, role: "site-admin", mode: "open", public: false,
    clarification: { askedAboutThisText: false, consent: false }, body: `Report text ${HOSTILE}`, details: {}, reader: { publishName: false },
    report: { ground: "abusive", groundLabel: "Abusive" },
    target: { source: "comment", id: COMMENT_ID, kind: "comment", kindLabel: "Comment", status: "approved", statusLabel: "Approved", authorName: "Grace", body: `Rude ${HOSTILE}` },
    actions: [
      { action: "reject", label: "Reject", reasons: [{ id: "no-action", label: "No action needed" }], guidance: "Dismisses the report; the reported item is not changed." },
      { action: "uphold-report", label: "Uphold the report", reasons: UPHOLD, guidance: "Takes the reported item off its post in the same decision, with this reason." },
    ],
    ...extra,
  };
}
const page_ = (items) => ({ state: "pending", kind: "", protocol: "protected", items, invalid: 0, next: null });

test("a report is upheld from the keyboard, and a closed item's text is deleted only once confirmed", async ({ page }) => {
  let items = [reportItem()];
  const changes = [];
  await page.route("**/admin/api/engagement/moderation?**", (route) => json(route, 200, page_(items)));
  await page.route("**/admin/api/engagement/moderation", async (route) => {
    const body = JSON.parse(route.request().postData());
    changes.push(body);
    if (body.action === "uphold-report") {
      items = [reportItem({
        status: "rejected", statusLabel: "Rejected", version: 2, actions: [
          { action: "erase", label: "Delete its text and name", reasons: [], guidance: "For a reader who asked you to delete what they sent.", confirm: "I understand that the text and name are deleted for good." },
        ],
      })];
      return json(route, 200, { item: items[0], published: false, removedTarget: true });
    }
    items = [reportItem({ status: "rejected", statusLabel: "Rejected", version: 3, purged: true, body: null, actions: [] })];
    return json(route, 200, { item: items[0], published: false });
  });
  await page.route("**/admin/api/engagement/feedback/published", (route) => json(route, 200, { etag: "absent", items: [] }));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/pending?kind=abuse-report`);
  const card = page.locator(`[data-moderation-id="${ID(7)}"]`);
  await expect(card.getByRole("heading", { name: "Abuse report on “Tides”", level: 3 })).toBeVisible();
  await expect(card.getByText("Reports are anonymous", { exact: false })).toBeVisible();
  await expect(card.getByText(`Rude ${HOSTILE}`)).toBeVisible();
  await expect(card.locator("img")).toHaveCount(0);
  const uphold = card.getByRole("button", { name: "Uphold the report" });
  await uphold.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByLabel("Reason to uphold the report")).toBeFocused();
  await card.getByLabel("Reason to uphold the report").selectOption("abusive");
  await uphold.click();
  await expect(page.getByText("Report upheld. The reported item was removed from “Tides”.")).toBeVisible();
  expect(changes[0]).toEqual({ source: "report", id: ID(7), action: "uphold-report", from: "pending", version: 1, reason: "abusive" });

  const erase = page.locator(`[data-moderation-id="${ID(7)}"]`).getByRole("button", { name: "Delete its text and name" });
  await erase.click();
  await expect(page.getByLabel("I understand that the text and name are deleted for good.")).toBeFocused();
  expect(changes).toHaveLength(1);
  await page.keyboard.press("Space");
  await erase.click();
  await expect(page.getByText("Its text and name were deleted. Only the private record of decisions remains.")).toBeVisible();
  expect(changes[1]).toEqual({ source: "report", id: ID(7), action: "erase", from: "rejected", version: 2 });
  await expect(page.getByText("Its text, details and any name were deleted.", { exact: false })).toBeVisible();
});

test("retention shows a dry run first and runs only once confirmed", async ({ page }) => {
  let ran = null;
  await page.route("**/admin/api/engagement/moderation?**", (route) => json(route, 200, page_([])));
  await page.route("**/admin/api/engagement/feedback/published", (route) => json(route, 200, { etag: "absent", items: [] }));
  await page.route("**/admin/api/engagement/retention", async (route) => {
    if (route.request().method() === "GET") {
      return json(route, 200, {
        asOf: "2026-10-27T10:00:00Z",
        periods: { pendingDays: 90, clarificationDays: 30, closedDays: 30, auditDays: 365, comments: false },
        summary: [{ step: "purge-content", kind: "question", kindLabel: "Question", count: 1 }],
        items: [{ source: "feedback", id: ID(9), kind: "question", kindLabel: "Question", status: "rejected", statusLabel: "Rejected", since: "2026-08-01T00:00:00Z", step: "purge-content", work: "/tides/" }],
        audit: { comment: 0, feedback: 2, report: 0 }, truncated: false, skipped: 0,
      });
    }
    ran = JSON.parse(route.request().postData());
    return json(route, 200, { expired: 0, purged: 1, skipped: 0, auditDeleted: 2, more: false });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/pending`);
  const section = page.getByRole("region", { name: "Retention" });
  await section.getByRole("button", { name: "Check what retention would do" }).click();
  await expect(section.getByText("1 question item would have their text, details and names deleted.")).toBeVisible();
  await expect(section.getByText("2 private records of decisions older than 365 days would be deleted.")).toBeVisible();
  await expect(section.getByText("Comments are kept until you act", { exact: false })).toBeVisible();
  await expect(section.getByRole("status")).toBeFocused();
  const run = section.getByRole("button", { name: "Run retention now" });
  await run.click();
  await expect(section.getByLabel("I understand that purged text, details and names cannot be recovered.")).toBeFocused();
  expect(ran).toBeNull();
  await page.keyboard.press("Space");
  await section.getByLabel(/Also delete private records of decisions older than 365 days/).uncheck();
  await run.click();
  await expect(section.getByRole("status")).toHaveText("Retention ran: 0 expired, 1 purged, 2 old records deleted.");
  expect(ran).toEqual({ asOf: "2026-10-27T10:00:00Z", audit: false });
});
