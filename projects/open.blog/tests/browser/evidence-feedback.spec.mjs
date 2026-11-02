import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The evidence offer on a published reader page (#217, ADR 0116): a reader names the published
// claim, the evidence for it they question and a source the site publishes, from lists the build
// published, by keyboard; the block goes as version 2; a stance with nothing offered is refused on
// its own field; a site whose service does not store evidence yet gives the note to copy with the
// evidence; nothing private is listed; and the form fits 320px.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const ENDPOINT = "https://evidence.example/api";
const FEEDBACK_URL = `${ENDPOINT}/feedback`;
const PRIVATE = "PRIVATE-EVIDENCE-MARKER";
const POST = `---
title: Tides
date: 2026-10-20
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
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-evidence-feedback-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Evidence",
    url: "https://evidence-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    claimEvidence: { publish: true },
    engagement: { enabled: true, comments: false, analytics: false, feedback: true, evidence: true, endpoint: ENDPOINT },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
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

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

async function mockFeedback(page, answer = { status: 202, body: { status: "pending" } }) {
  const submissions = [];
  await page.route(FEEDBACK_URL, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    submissions.push(request.postDataJSON());
    await route.fulfill({ status: answer.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(answer.body) });
  });
  return submissions;
}

async function open(page) {
  await page.goto(`${origin}/tides/`);
  await page.waitForFunction(() => customElements.get("ob-passage-feedback") !== undefined);
  await expect(page.locator(".ob-passage-feedback-form")).toBeVisible();
}

const region = (page) => page.getByRole("region", { name: "Questions and corrections" });
const evidence = (page) => page.getByRole("group", { name: "Evidence (optional)" });

test("keyboard: a reader names the claim, the evidence they question and a source they offer, sent as version 2", async ({ page }) => {
  const submissions = await mockFeedback(page);
  await open(page);
  const form = region(page);
  await expect(evidence(page)).toBeHidden();
  await form.getByRole("radio", { name: "A section" }).check();
  await form.getByLabel("Section", { exact: true }).selectOption({ label: "Methods" });
  const kind = form.getByLabel("Kind of feedback");
  await kind.focus();
  await kind.selectOption("correction-suggestion");
  // The offer appears only for a suggested source or correction, with its purpose said.
  await expect(evidence(page)).toBeVisible();
  await expect(evidence(page)).toHaveAccessibleDescription(/nothing is checked, scored or counted/);
  await form.getByLabel("Your note", { exact: true }).fill("The harbour gauge shows less.");
  const claim = form.getByLabel("A claim in this post your note is about");
  await expect(claim.locator("option")).toHaveText(["No claim", "Claim 1: The tide rises three metres."]);
  const link = form.getByLabel("Evidence for that claim you question");
  await expect(link).toBeDisabled();
  await claim.focus();
  await claim.selectOption("tide-height");
  await expect(link).toBeEnabled();
  await link.selectOption("tide-height-noaa");
  const offered = form.getByLabel("A source this site publishes that you offer");
  await expect(offered.locator("option")).toHaveText(["No source", /^Admiralty tide tables/, /^NOAA tide tables/]);
  await expect(form.getByLabel("Where", { exact: true })).toBeDisabled();
  await offered.selectOption("admiralty-1990");
  await form.getByLabel("Where", { exact: true }).fill("40");
  // The stance is a native radio group moved with the arrow keys.
  const notSaying = form.getByRole("radio", { name: "I am not saying" });
  await notSaying.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(form.getByRole("radio", { name: "It contradicts the passage" })).toBeChecked();
  await form.getByRole("button", { name: "Send for review" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ob-passage-feedback-done")).toBeFocused();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    version: 2,
    kind: "correction-suggestion",
    body: "The harbour gauge shows less.",
    evidence: { claim: "tide-height", evidenceLink: "tide-height-noaa", source: "admiralty-1990", locators: [{ kind: "page", value: "40" }], stance: "contradicts" },
  });
  // Nothing private is on the page: only published claims, links and sources are listed.
  const html = await page.content();
  for (const secret of [PRIVATE, "secret-claim", "secret-link", "private-diary"]) expect(html).not.toContain(secret);
});

test("a stance with nothing offered is refused on its own field, and a question offers no evidence", async ({ page }) => {
  const submissions = await mockFeedback(page);
  await open(page);
  const form = region(page);
  await form.getByRole("radio", { name: "A section" }).check();
  await form.getByLabel("Kind of feedback").selectOption("correction-suggestion");
  await form.getByLabel("Your note", { exact: true }).fill("Something is off.");
  await form.getByRole("radio", { name: "It supports the passage" }).check();
  await form.getByRole("button", { name: "Send for review" }).click();
  const supports = form.getByRole("radio", { name: "It supports the passage" });
  await expect(supports).toBeFocused();
  await expect(supports).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("only when you offer one");
  expect(submissions).toHaveLength(0);
  await form.getByLabel("Kind of feedback").selectOption("question");
  await expect(evidence(page)).toBeHidden();
  await form.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-passage-feedback-done")).toBeFocused();
  expect(submissions[0].version).toBe(1);
  expect(submissions[0].evidence).toBeUndefined();
});

test("a site whose service does not store evidence yet gives the note to copy with its evidence", async ({ page }) => {
  await mockFeedback(page, { status: 422, body: { code: "unsupportedVersion", error: "this feedback submission is version 2" } });
  await open(page);
  const form = region(page);
  await form.getByLabel("Kind of feedback").selectOption("source-suggestion");
  await form.getByLabel("Your note", { exact: true }).fill("This table measured it.");
  await form.getByLabel("Link to the source").fill("https://example.org/tables");
  await form.getByLabel("A claim in this post your note is about").selectOption("tide-height");
  await form.getByRole("button", { name: "Send for review" }).click();
  const message = page.locator(".ob-passage-feedback-fallback-message");
  await expect(message).toBeFocused();
  await expect(message).toContainText("does not take evidence through the form");
  const copy = page.getByLabel("Your note, ready to send to the author");
  await expect(copy).toHaveValue(/Claim: tide-height/);
  await expect(copy).toHaveValue(/"version":2/);
});

test("at 320px the evidence offer fits without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockFeedback(page);
  await open(page);
  await page.getByLabel("Kind of feedback").selectOption("correction-suggestion");
  await page.getByLabel("A source this site publishes that you offer").selectOption("admiralty-1990");
  const overflow = await page.locator("#ob-feedback").evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const control of await page.locator(".ob-passage-feedback-evidence select, .ob-passage-feedback-evidence input").all()) {
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
});
