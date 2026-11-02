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

// Correction decisions in the Moderation inbox (#217, ADRs 0116 and 0117). The hosted inbox is
// mocked at the Admin API (the real Admin resolves each item's actor, checks the decision and
// lists the post's revision notes and evidence links); everything else is the real Admin. Covers
// how an item stands before and after the author decides, the reader's evidence compared with the
// claim it names, duplicate cues that never count, the "Record decision" form by keyboard with
// each missing field announced on its own control, a revision note added as its own step, a
// conflict that reloads, a viewer who may not decide, and 320px.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://decisions.example/api";
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-correction-decisions-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Decisions",
    url: "https://decisions-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: false, analytics: false, feedback: true, evidence: true, endpoint: ENDPOINT },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), "---\ntitle: Tides\ndate: 2026-10-20\n---\nThe tide rises three metres.\n");
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

const ID = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OUTCOMES = [
  { id: "accepted-as-correction", label: "Accept as a correction", guidance: "The post was in error and you changed it.", accepted: true },
  { id: "accepted-as-clarification", label: "Accept as a clarification", guidance: "Not an error, but unclear.", accepted: true },
  { id: "accepted-as-evidence", label: "Add the source as evidence", guidance: "You recorded the reader’s source as evidence.", accepted: true },
  { id: "declined", label: "Decline", guidance: "You considered it and made no change.", accepted: false },
  { id: "already-addressed", label: "Already addressed", guidance: "The post already reflected it.", accepted: false },
];
const NOTE = "2026-10-27 tide-height: Corrected the height after a reader’s note.";

/** A suggested correction as the Admin server describes it to the site Admin, with "Record decision". */
function suggestion(n, extra = {}) {
  return {
    id: ID(n),
    source: "feedback",
    kind: "correction-suggestion",
    kindLabel: "Suggested correction",
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
    body: "The harbour gauge shows less. <img src=x onerror=alert(1)>",
    details: {},
    reader: { publishName: false },
    passage: { check: "current", explanation: "Current: the reader saw the revision that is published now.", revisionSeen: "p1:11111111111111111111111111111111", acknowledge: false },
    published: false,
    actions: [{ action: "approve", label: "Approve", reasons: [], guidance: "Publishes the reader’s words on the post as theirs, at this revision." }],
    standing: { id: "challenged-citation", label: "Questioned citation", decided: false, correction: false },
    evidence: {
      stale: false,
      claim: { id: "tide-height", published: true, label: "Claim 1", statement: "The tide rises three metres.", url: "/tides/#claim-tide-height", links: [{ id: "tide-height-noaa", relation: "supports", label: "Supported by NOAA tide tables (2020)" }] },
      evidenceLink: { id: "tide-height-noaa", published: true, label: "Supported by NOAA tide tables (2020)" },
      source: { id: "admiralty-1990", published: true, label: "Admiralty tide tables (1990)" },
      locators: [{ kind: "page", value: "40" }],
      stance: "contradicts",
      stanceLabel: "The reader says it contradicts the passage",
    },
    decisions: [],
    similar: [{ id: ID(n + 1), source: "feedback", kindLabel: "Suggested correction", receivedAt: "2026-10-26T11:00:00Z", reason: "the same passage" }],
    recordDecision: {
      label: "Record decision",
      guidance: "Records what you concluded about your work.",
      expectedDecisions: 0,
      itemRevision: 1,
      outcomes: OUTCOMES,
      extents: [{ id: "full", label: "All of it" }, { id: "partial", label: "Part of it (say which in your rationale)" }],
      declineReasons: [{ id: "maintains-reading", label: "The author keeps the passage as written" }, { id: "other", label: "Another reason, given by the author" }],
      post: "posts/tides.md",
      revisionNotes: [NOTE],
      claimEvidence: [{ claim: "tide-height", link: "tide-height-admiralty", label: "tide-height → tide-height-admiralty (contradicts, admiralty-1990)" }],
    },
    ...extra,
  };
}

const page_ = (items, extra = {}) => ({ state: "pending", kind: "", protocol: "full", items, invalid: 0, next: null, ...extra });
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const queueStatus = (page) => page.locator(".oba-feedback-section").first().locator('p[role="status"]').first();

test("the author records a correction by keyboard, each missing field named on its own control", async ({ page }) => {
  let items = [suggestion(1), suggestion(2, { similar: [{ id: ID(1), source: "feedback", kindLabel: "Suggested correction", receivedAt: "2026-10-26T10:00:00Z", reason: "the same passage" }] })];
  const decisions = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await page.route(`${origin}/admin/api/engagement/moderation/decision`, async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON();
    decisions.push(body);
    const decided = { version: 1, item: body.id, sequence: 1, outcome: body.outcome, extent: body.extent, label: "Correction", revisionNote: body.revisionNote, itemRevision: 1, passageCheck: "current", decided: body.decided, decidedBy: { role: "site-admin", account: "writer" }, inForce: true };
    items = items.map((item) => (item.id === body.id
      ? { ...item, standing: { id: "accepted-as-correction", label: "Correction", decided: true, correction: true }, decisions: [decided], recordDecision: { ...item.recordDecision, expectedDecisions: 1 } }
      : item));
    return json(route, 200, { item: null, decision: { outcome: body.outcome, label: "Correction", sequence: 1 }, outcomePublished: true });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  await expect(queueStatus(page)).toHaveText("2 pending items.");
  const card = page.locator(`[data-moderation-id="${ID(1)}"]`);
  // Before the author decides, it is the reader's suggestion: never a correction.
  await expect(card.locator(".oba-feedback-standing")).toHaveText("Stands as: Questioned citation (the reader’s suggestion; you have not decided)");
  await expect(card.getByText("Correction", { exact: true })).toHaveCount(0);
  await expect(card.locator("img")).toHaveCount(0);
  // The reader's evidence, compared with what the post publishes for the claim.
  const evidence = card.locator(".oba-feedback-evidence");
  await expect(evidence).toContainText("Claim: Claim 1, “The tide rises three metres.”.");
  await expect(evidence).toContainText("Source the reader offers: Admiralty tide tables (1990), at page 40.");
  await expect(evidence).toContainText("The reader says it contradicts the passage.");
  await evidence.getByText("Compare with the evidence published for Claim 1").click();
  await expect(evidence.getByText("Supported by NOAA tide tables (2020)").last()).toBeVisible();
  // A duplicate cue links to the other item and counts nothing.
  const cue = card.getByRole("link", { name: /Suggested correction received/ });
  await expect(cue).toBeVisible();
  await cue.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-moderation-id="${ID(2)}"] h3`)).toBeFocused();

  // Record decision is a disclosure beside moderation, opened from the keyboard.
  const summary = card.locator("summary", { hasText: "Record decision" });
  await summary.focus();
  await page.keyboard.press("Enter");
  const send = card.getByRole("button", { name: "Record decision", exact: true });
  await send.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("radio", { name: "Accept as a correction" })).toBeFocused();
  await expect(card.locator('[role="alert"]')).toHaveText("Choose what you decided.");
  await expect(card.getByRole("radio", { name: "Accept as a correction" })).toHaveAccessibleDescription("The post was in error and you changed it.");
  await page.keyboard.press("Space");
  await expect(card.getByRole("group", { name: "How much of it?" })).toBeVisible();
  await expect(card.getByLabel("Your reason for declining")).toBeHidden();
  await send.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("radio", { name: "All of it" })).toBeFocused();
  await page.keyboard.press("Space");
  await send.focus();
  await page.keyboard.press("Enter");
  const note = card.getByLabel("The post’s revision note");
  await expect(note).toBeFocused();
  await note.selectOption(NOTE);
  expect(decisions).toHaveLength(0);
  await send.focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toHaveText(/^Decision recorded: Correction\. The post, its citations and the Source Library were not changed/);
  await expect(queueStatus(page)).toContainText("The outcome now shows on the published note.");
  await expect(queueStatus(page)).toBeFocused();
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toEqual({
    id: ID(1), expectedDecisions: 0, itemRevision: 1, outcome: "accepted-as-correction", extent: "full", decided: decisions[0].decided,
    revisionNote: { post: "posts/tides.md", note: NOTE },
  });
  expect(decisions[0].decided).toMatch(/^\d{4}-\d\d-\d\d$/);
  // Now, and only now, the author's decision labels it, with its history.
  const decided = page.locator(`[data-moderation-id="${ID(1)}"]`);
  await expect(decided.locator(".oba-feedback-standing")).toHaveText("Stands as: Correction (your decision)");
  await decided.getByText("Your decisions (1)").click();
  await expect(decided.locator(".oba-feedback-decisions")).toContainText("Correction (in full)");
});

test("declining needs the author's reason and rationale; a conflict reloads and a refusal stays on the card", async ({ page }) => {
  const items = [suggestion(5)];
  let answer = { status: 422, body: { error: "The post’s revision notes do not hold that note. Add it to the post first, then choose it.", code: "revisionNoteNotFound" } };
  const decisions = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await page.route(`${origin}/admin/api/engagement/moderation/decision`, async (route) => {
    decisions.push(route.request().postDataJSON());
    return json(route, answer.status, answer.body);
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  const card = page.locator(`[data-moderation-id="${ID(5)}"]`);
  await card.locator("summary", { hasText: "Record decision" }).click();
  await card.getByRole("radio", { name: "Decline" }).check();
  await expect(card.getByRole("group", { name: "How much of it?" })).toBeHidden();
  await expect(card.getByLabel("The post’s revision note")).toBeHidden();
  const send = card.getByRole("button", { name: "Record decision", exact: true });
  await send.click();
  await expect(card.getByLabel("Your reason for declining")).toBeFocused();
  await card.getByLabel("Your reason for declining").selectOption("maintains-reading");
  await send.click();
  await expect(card.getByRole("textbox", { name: "Your rationale" })).toBeFocused();
  await card.getByRole("textbox", { name: "Your rationale" }).fill("The gauge measured a neap tide.");
  await send.click();
  await expect(card.locator('[role="alert"]')).toHaveText(answer.body.error);
  await expect(send).toBeFocused();
  expect(decisions.at(-1)).toEqual({ id: ID(5), expectedDecisions: 0, itemRevision: 1, outcome: "declined", declineReason: "maintains-reading", rationale: "The gauge measured a neap tide.", decided: decisions.at(-1).decided });
  answer = { status: 409, body: { error: "Someone decided on this item, or it changed, since you loaded it. Review it again before deciding.", code: "conflict", item: null } };
  await send.click();
  await expect(queueStatus(page)).toContainText("Someone decided on this item");
  await expect(queueStatus(page)).toContainText("The list was reloaded.");
});

test("a revision note is added as its own step, and a viewer who may not decide gets no form", async ({ page }) => {
  const notes = [];
  const items = [
    suggestion(7, { recordDecision: { ...suggestion(7).recordDecision, revisionNotes: [] } }),
    suggestion(8, { role: "contributing-author", actions: [], recordDecision: undefined }),
  ];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await page.route(`${origin}/admin/api/engagement/feedback/revision-note`, async (route) => {
    notes.push(route.request().postDataJSON());
    return json(route, 200, { post: "posts/tides.md", etag: "x", build: null });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  const card = page.locator(`[data-moderation-id="${ID(7)}"]`);
  await card.locator("summary", { hasText: "Record decision" }).click();
  await card.getByRole("radio", { name: "Accept as a clarification" }).check();
  await expect(card.getByText("This post has no revision notes yet.", { exact: false })).toBeVisible();
  await card.locator("summary", { hasText: "Add a revision note to the post" }).click();
  await card.getByLabel("What changed").fill("Corrected the height.");
  await card.getByLabel("Claim id (optional)").fill("tide-height");
  await card.getByRole("button", { name: "Add revision note" }).click();
  await expect(queueStatus(page)).toContainText("Revision note added to the post’s front matter.");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ post: "posts/tides.md", claim: "tide-height", note: "Corrected the height." });
  const author = page.locator(`[data-moderation-id="${ID(8)}"]`);
  await expect(author.locator("summary", { hasText: "Record decision" })).toHaveCount(0);
  await expect(author.locator(".oba-feedback-standing")).toContainText("Questioned citation");
});

test("the decision form reflows at 320px with every control reachable", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([suggestion(9)])));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  const card = page.locator(`[data-moderation-id="${ID(9)}"]`);
  await card.locator("summary", { hasText: "Record decision" }).click();
  await card.getByRole("radio", { name: "Add the source as evidence" }).check();
  const wide = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".oba-feedback-section, .oba-feedback-section *")]
      .filter((element) => element.getBoundingClientRect().right > width + 1 || element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
      .map((element) => element.className || element.tagName);
  });
  expect(wide).toEqual([]);
  for (const control of await card.locator(".oba-decision input:visible, .oba-decision select:visible, .oba-decision textarea:visible, .oba-decision button:visible").all()) {
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(321);
  }
  await context.close();
});

test("a decision names the text revision the author read, and a clarified item is reloaded before it can be decided", async ({ page }) => {
  const read = (revision) => suggestion(9, { revision, recordDecision: { ...suggestion(9).recordDecision, itemRevision: revision } });
  let items = [read(1)];
  const decisions = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await page.route(`${origin}/admin/api/engagement/moderation/decision`, async (route) => {
    const body = route.request().postDataJSON();
    decisions.push(body);
    if (body.itemRevision !== 2) {
      // The reader answered a clarification after the author looked: the text is revision 2 now.
      items = [read(2)];
      return json(route, 409, { error: "Someone decided on this item, or it changed, since you loaded it. Review it again before deciding.", code: "conflict", item: items[0] });
    }
    return json(route, 200, { item: null, decision: { outcome: body.outcome, label: "Declined", sequence: 1 } });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation`);
  const card = () => page.locator(`[data-moderation-id="${ID(9)}"]`);
  const decline = async () => {
    await card().locator("summary", { hasText: "Record decision" }).click();
    await card().getByRole("radio", { name: "Decline" }).check();
    await card().getByLabel("Your reason for declining").selectOption("maintains-reading");
    await card().getByRole("textbox", { name: "Your rationale" }).fill("The gauge measured a neap tide.");
    await card().getByRole("button", { name: "Record decision", exact: true }).click();
  };
  await decline();
  await expect(queueStatus(page)).toContainText("The list was reloaded.");
  expect(decisions).toHaveLength(1);
  expect(decisions[0].itemRevision).toBe(1);
  // Nothing was recorded against the old text: the form is fresh, and the next send carries revision 2.
  await expect(card().locator("details.oba-decision")).not.toHaveAttribute("open", "");
  await decline();
  await expect(queueStatus(page)).toContainText("Decision recorded");
  expect(decisions).toHaveLength(2);
  expect(decisions[1].itemRevision).toBe(2);
});
