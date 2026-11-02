import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Published correction outcomes (#218, ADR 0119) on a real built site: a published suggested
// correction shows what the author decided, the revision it was about, and links to the change
// the post's own revision notes record and to the evidence link the author recorded; a suggestion
// nobody decided reads as unresolved; evidence the post no longer publishes is said, not linked;
// hostile text is text; nothing needs JavaScript; the region fits 320px; and the feed carries the
// outcomes with the canonical discussion link but never a note's words or anything private.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const PRIVATE = "PRIVATE-OUTCOME-MARKER";
const HOSTILE = "<img src=x onerror=alert(1)>";
const SITE = "https://outcomes-site.example.org";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REVISION = "p1:00000000000000000000000000000000";
const NOTE = "2026-10-27 tide-height: Corrected the tide height from 3 m to 3.1 m after a reader's note.";
const POST = `---
title: Tides
date: 2026-10-20
evidenceRevisions:
  - "${NOTE}"
---
The tide rises three metres at the harbour.

## Methods

We measured the tides twice a day.
`;
const LIBRARY = { version: 1, sources: [
  { id: "noaa-2020", kind: "work", title: "NOAA tide tables", issued: "2020" },
  { id: "admiralty-1990", kind: "work", title: "Admiralty tide tables", issued: "1990" },
  { id: "private-diary", kind: "work", title: `${PRIVATE} diary` },
] };
const CLAIMS = { version: 1,
  claims: [
    { id: "tide-height", post: "tides", statement: "The tide rises three metres.", visibility: "approved" },
    { id: "secret-claim", post: "tides", statement: `${PRIVATE} claim`, visibility: "private" },
  ],
  links: [
    { id: "tide-height-noaa", claim: "tide-height", relation: "supports", visibility: "approved", evidence: { source: "noaa-2020" }, confidence: "plausible" },
    { id: "tide-height-admiralty", claim: "tide-height", relation: "contradicts", visibility: "approved", evidence: { source: "admiralty-1990" }, confidence: "plausible" },
    { id: "secret-link", claim: "secret-claim", relation: "supports", visibility: "approved", evidence: { source: "private-diary" }, confidence: "plausible" },
  ] };
const item = (n, kind, body, extra = {}) => ({
  id: ID(n), post: "posts/tides.md", work: "/tides/", kind, body, revision: REVISION,
  target: kind === "question" ? { version: 1, kind: "work" } : { version: 1, kind: "section", section: "methods" },
  received: "2026-10-26", approved: "2026-10-27",
  ...(kind === "correction-suggestion" ? { details: { suggestedText: "Three point one metres." } } : {}),
  ...(kind === "source-suggestion" ? { details: { sourceUrl: "https://example.org/gauge" } } : {}),
  ...extra,
});
const FILE = { version: 2, items: [
  item(1, "correction-suggestion", "The harbour gauge shows less.", {
    name: "Ada",
    decision: { outcome: "accepted-as-correction", extent: "full", revisionNote: NOTE, rationale: `The gauge was right. ${HOSTILE}`, decided: "2026-10-27", superseded: 0 },
  }),
  item(2, "source-suggestion", "The Admiralty tables disagree.", {
    decision: { outcome: "accepted-as-evidence", extent: "full", revisionNote: NOTE, claimEvidence: { claim: "tide-height", link: "tide-height-admiralty" }, decided: "2026-10-27", superseded: 1 },
  }),
  item(3, "correction-suggestion", "It is two metres.", {
    decision: { outcome: "declined", declineReason: "maintains-reading", rationale: "The survey measured a neap tide.", decided: "2026-10-27", superseded: 0 },
  }),
  item(4, "source-suggestion", "A source nobody has decided on."),
  item(5, "question", "Why metres?"),
  item(6, "source-suggestion", "A link the author since withdrew.", {
    decision: { outcome: "accepted-as-evidence", extent: "full", revisionNote: NOTE, claimEvidence: { claim: "tide-height", link: "gone-link" }, decided: "2026-10-27", superseded: 0 },
  }),
] };
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-correction-outcomes-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Outcomes",
    url: SITE,
    postPath: "/{slug}/",
    author: { name: "A" },
    claimEvidence: { publish: true },
    feeds: { fullContent: true },
    engagement: { enabled: true, comments: false, analytics: false, feedback: true, evidence: true, endpoint: "https://outcomes.example/api" },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
  writeFileSync(join(root, "content", "reader-feedback.json"), `${JSON.stringify(FILE, null, 2)}\n`);
  const research = join(root, ".openblog", "private", "research");
  mkdirSync(research, { recursive: true });
  writeFileSync(join(research, "sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(join(research, "claims.json"), JSON.stringify(CLAIMS));
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
    expect((await fetch(`${origin}/tides/`)).ok).toBe(true);
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

const notes = (page) => page.locator("#ob-reader-feedback");
const note = (page, n) => page.locator(`#ob-reader-note-${ID(n)}`);

test("without JavaScript each note says what the author decided, what changed and which evidence, by keyboard", async ({ browser }) => {
  // Reduced motion turns off the page's smooth scrolling, so landing on a target is checked without
  // racing the scroll animation on a busy runner.
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${origin}/tides/`);
  await expect(notes(page)).toBeVisible();
  // A correction: the author's decision named in a heading, with its day, the revision it is
  // about, and the change the post's own revision notes record.
  const correction = note(page, 1);
  await expect(correction.getByRole("heading", { level: 4, name: "Author’s decision: Correction 2026-10-27" })).toBeVisible();
  await expect(correction).toContainText("The author accepted this as a correction in full and changed the post.");
  await expect(correction).toContainText(`Affected revision: ${REVISION}`);
  await expect(correction).toContainText("From Ada");
  const change = correction.getByRole("link", { name: /Corrected the tide height from 3 m to 3\.1 m/ });
  await expect(change).toHaveAttribute("href", /^#revision-notes/);
  // Keyboard: the link is reachable and lands on the post's own revision notes.
  await change.focus();
  await expect(change).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#revision-notes/);
  await expect(page.getByRole("heading", { name: "Revision notes" })).toBeInViewport();
  // Added as evidence: the recorded evidence link, linked to its claim, labelled by its relation.
  const added = note(page, 2);
  await expect(added.getByRole("heading", { level: 4, name: /^Author’s decision: Added as evidence/ })).toBeVisible();
  const evidence = added.getByRole("link", { name: "Claim 1", exact: true });
  await expect(evidence).toBeVisible();
  await expect(added).toContainText("Contradicted by Admiralty tide tables. 1990.");
  await evidence.focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).hash).toMatch(/^#claim-1/);
  // Declined: the author's ground and rationale, and no change claimed.
  const declined = note(page, 3);
  await expect(declined).toContainText("Author’s decision: Declined by the author");
  await expect(declined).toContainText("Reason: The author keeps the passage as written.");
  await expect(declined).toContainText("The survey measured a neap tide.");
  await expect(declined).not.toContainText("What changed");
  // Nothing but the author's own acceptance ever says "Correction".
  for (const n of [2, 3, 4, 5, 6]) await expect(note(page, n).getByText("Correction", { exact: true })).toHaveCount(0);
  // Undecided: unresolved, and said to be a suggestion rather than a settled fact; a question
  // has no outcome at all.
  const undecided = note(page, 4);
  await expect(undecided.getByRole("heading", { level: 4, name: "Unresolved: not yet decided by the author" })).toBeVisible();
  await expect(undecided).toContainText("It is a reader’s suggestion, not a settled correction.");
  await expect(note(page, 5).locator(".ob-reader-note-outcome")).toHaveCount(0);
  // Evidence the post no longer publishes is said, never linked.
  const withdrawn = note(page, 6);
  await expect(withdrawn).toContainText("The evidence the author recorded is not published on this page.");
  await expect(withdrawn.getByRole("link", { name: "Claim 1", exact: true })).toHaveCount(0);
  await context.close();
});

test("the author's and the reader's words are text, never markup, and nothing private is on the page", async ({ page }) => {
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await page.goto(`${origin}/tides/`);
  await expect(notes(page)).toBeVisible();
  await expect(notes(page).locator("img")).toHaveCount(0);
  await expect(note(page, 1)).toContainText(HOSTILE);
  expect(dialogs).toEqual([]);
  const html = await page.content();
  for (const private_ of [PRIVATE, "decidedBy", "site-admin", "passageCheck", "@moderation-token"]) expect(html).not.toContain(private_);
});

test("the region fits a 320px phone without scrolling sideways, and keeps its own focus indication", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${origin}/tides/`);
  const region = notes(page);
  await expect(region).toBeVisible();
  // The region under test, not the page header: nothing in it is wider than the screen.
  const overflow = await region.evaluate((element) => {
    const limit = document.documentElement.clientWidth;
    const wide = [...element.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > limit + 1).map((child) => child.tagName);
    return { scroll: element.scrollWidth - element.clientWidth, wide };
  });
  expect(overflow).toEqual({ scroll: 0, wide: [] });
  const link = note(page, 1).getByRole("link", { name: /Corrected the tide height/ });
  await link.focus();
  const outline = await link.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
});

test("reduced motion changes nothing: the outcomes are static content", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${origin}/tides/`);
  const before = await note(page, 1).locator(".ob-reader-note-outcome").innerText();
  await page.waitForTimeout(200);
  expect(await note(page, 1).locator(".ob-reader-note-outcome").innerText()).toBe(before);
  await context.close();
});

test("the feed carries each outcome with the canonical discussion, and never a note's words or anything private", async () => {
  const feed = await (await fetch(`${origin}/feed.json`)).text();
  const rss = await (await fetch(`${origin}/rss.xml`)).text();
  for (const [name, text] of [["feed.json", feed], ["rss.xml", rss]]) {
    expect(text, name).toContain("Reader suggestions and the author");
    expect(text, name).toContain(`${SITE}/tides/#ob-reader-note-${ID(1)}`);
    for (const words of ["The harbour gauge shows less.", "It is two metres.", "Why metres?", "A source nobody has decided on."]) expect(text, `${name}: ${words}`).not.toContain(words);
    for (const private_ of [PRIVATE, "decidedBy", "site-admin", "passageCheck"]) expect(text, `${name}: ${private_}`).not.toContain(private_);
  }
  expect(JSON.parse(feed).items.some((entry) => /Author’s decision: Correction/.test(entry.content_html || entry.content_text || ""))).toBe(true);
  // The reader named Ada; the others did not agree to a name, so none appears with them.
  expect(feed).toContain("From Ada");
});
