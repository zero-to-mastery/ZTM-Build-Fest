import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Suggestions for future work on a published reader page (#227, ADRs 0152 to 0157): keyboard use
// through native radio groups, a closed set of kinds, a question that is words only, optional
// source details, consent for a shown name and for contact, announced errors with focus on the
// field, an explicit pending state and a double submit that waits, success with the receipt, network
// loss and a failing service keeping the suggestion with retry and copy, a static site that shows
// only its configured contact, 320px and 400% zoom without sideways scrolling, a strict content
// security policy, no requests beyond the configured endpoint, and the page without JavaScript or
// on a locked post. Nothing says a suggestion is published, counted or ranked.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const ENDPOINT = "https://suggestions.example/api";
const RECEIPT = "S".repeat(43);
const POST = `---
title: Tides
date: 2026-10-20
---
The moon causes the tides. The sun matters too.

## Methods

We measured the tides twice a day.
`;
const POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(ENDPOINT).origin}; img-src 'self' data:; object-src 'none'; base-uri 'none'`;
const servers = [];
let hosted;
let plain;

async function startSite(config) {
  const root = mkdtempSync(join(tmpdir(), "openblog-future-suggestion-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Suggestions",
    url: "https://suggestions-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    ...config,
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
  writeFileSync(join(root, "content", "posts", "closed.md"), "---\ntitle: Closed\ndate: 2026-10-19\nparticipation:\n  - future-suggestion: locked\n---\nClosed text.\n");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/tides/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
  servers.push({ server, root });
  return origin;
}

test.beforeAll(async () => {
  hosted = await startSite({
    engagement: { enabled: true, comments: false, analytics: false, endpoint: ENDPOINT, receipts: true, feedbackContact: "mailto:ada@suggestions-site.example.org" },
    participation: { kinds: { "future-suggestion": "open" } },
  });
  plain = await startSite({
    engagement: { feedbackContact: "https://suggestions-site.example.org/contact/" },
    participation: { kinds: { "future-suggestion": "open" } },
  });
});

test.afterAll(async () => {
  for (const { server, root } of servers) {
    if (server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
    removeTree(root);
  }
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * Answers the hosted function's feedback route with each of `answers` in turn (the last one
 * repeats); an answer of "abort" drops the connection. `hold` delays answers until released.
 */
async function mockService(page, answers = [{ status: 202, body: { status: "pending", receipt: RECEIPT } }], { hold = false } = {}) {
  const submissions = [];
  const urls = [];
  let release = () => {};
  const held = hold ? new Promise((done) => (release = done)) : Promise.resolve();
  await page.route(`${ENDPOINT}/feedback?**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    submissions.push(request.postDataJSON());
    urls.push(request.url());
    await held;
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === "abort") {
      await route.abort("internetdisconnected");
      return;
    }
    await route.fulfill({ status: answer.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(answer.body) });
  });
  return { submissions, urls, release: () => release() };
}

function outsideRequests(page, origin) {
  const outside = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && url.origin !== new URL(ENDPOINT).origin) outside.push(request.url());
  });
  return outside;
}

const region = (page) => page.getByRole("region", { name: "Suggest something for future work" });

async function open(page) {
  await page.goto(`${hosted}/tides/`);
  await page.waitForFunction(() => customElements.get("ob-future-suggestion") !== undefined);
  await expect(page.locator(".ob-future-suggestion-form")).toBeVisible();
}

test("keyboard: a reader chooses a kind, writes, adds the source and their own choices, sends it, and hears each state", async ({ page }) => {
  const outside = outsideRequests(page, hosted);
  const service = await mockService(page, undefined, { hold: true });
  await open(page);
  const form = region(page);
  await expect(page.locator(".ob-future-suggestion-static")).toHaveCount(0);
  // A closed set of kinds in a native radio group; the first is checked and arrows move through it.
  const question = form.getByRole("radio", { name: "Question for a future piece" });
  await question.focus();
  await expect(question).toBeChecked();
  await page.keyboard.press("ArrowDown");
  const text = form.getByRole("radio", { name: "Text to read" });
  await expect(text).toBeChecked();
  await expect(form.getByLabel("Why it is worth reading", { exact: true })).toBeVisible();
  await form.getByLabel("Why it is worth reading", { exact: true }).fill("Her letters from the 1850 survey would help with the tide tables.");
  await form.getByLabel("Link", { exact: true }).fill("https://Example.org/letters");
  await form.getByLabel("Title", { exact: true }).fill("The survey letters");
  await form.getByLabel("Creators", { exact: true }).fill("A. Surveyor\nB. Cartographer");
  await form.getByLabel("Year", { exact: true }).fill("c. 1850");
  await form.getByLabel("Identifier", { exact: true }).selectOption({ label: "DOI" });
  await form.getByLabel("Identifier value", { exact: true }).fill("10.1234/example");
  await form.getByRole("checkbox", { name: "It is about this article" }).check();
  // Nothing about the reader is checked for them.
  const credit = form.getByRole("checkbox", { name: "You may thank me by this name" });
  const follow = form.getByRole("checkbox", { name: "You may contact me at this address about this suggestion" });
  await expect(credit).not.toBeChecked();
  await expect(follow).not.toBeChecked();
  await form.getByLabel("Name", { exact: true }).fill("Ada");
  await form.getByLabel("E-mail address", { exact: true }).fill("ada@example.org");
  await follow.check();
  await form.getByRole("button", { name: "Send to the editors" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ob-future-suggestion-form")).toHaveAttribute("aria-busy", "true");
  await expect(form.getByRole("button", { name: "Sending…" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".ob-future-suggestion-status")).toHaveText("Sending your suggestion…");
  // A second press while sending waits.
  await page.keyboard.press("Enter");
  service.release();
  await expect(page.locator(".ob-future-suggestion-status")).toHaveText("Sent to the editors.");
  const done = page.locator(".ob-future-suggestion-done");
  await expect(done).toBeFocused();
  await expect(done).toContainText("never published");
  await expect(done).not.toContainText("approved");
  expect(service.submissions).toHaveLength(1);
  expect(service.urls[0]).toBe(`${ENDPOINT}/feedback?work=${encodeURIComponent("/tides/")}`);
  expect(service.submissions[0]).toEqual({
    version: 1,
    kind: "future-suggestion",
    type: "text",
    text: "Her letters from the 1850 survey would help with the tide tables.",
    url: "https://example.org/letters",
    hints: {
      title: "The survey letters",
      creators: ["A. Surveyor", "B. Cartographer"],
      year: "c. 1850",
      identifiers: [{ scheme: "doi", value: "10.1234/example" }],
    },
    about: { article: "/tides/" },
    attribution: { name: "Ada", publishName: false },
    contact: { address: "ada@example.org", followUp: true },
  });
  for (const field of ["rank", "rating", "score", "vote", "count"]) expect(service.submissions[0][field]).toBeUndefined();
  // The receipt is shown once, and says nothing about publication.
  await expect(page.getByRole("textbox", { name: "Receipt" })).toHaveValue(RECEIPT);
  await expect(page.getByRole("checkbox", { name: "The author may ask me to clarify this suggestion through this receipt" })).not.toBeChecked();
  await expect(page.getByRole("heading", { name: "Suggest something for future work" })).toBeVisible();
  expect(outside).toEqual([]);
});

test("a question is words only: its source controls are out of reach and nothing about a source is sent", async ({ page }) => {
  const service = await mockService(page);
  await open(page);
  const form = region(page);
  await form.getByRole("radio", { name: "Text to read" }).check();
  await form.getByLabel("Link", { exact: true }).fill("https://example.org/a");
  await form.getByRole("radio", { name: "Question for a future piece" }).check();
  await expect(form.getByLabel("Link", { exact: true })).toBeHidden();
  await expect(form.getByLabel("Your question", { exact: true })).toBeVisible();
  await form.getByLabel("Your question", { exact: true }).fill("What did the 1850 survey leave out?");
  await form.getByRole("button", { name: "Send to the editors" }).click();
  await expect(page.locator(".ob-future-suggestion-done")).toBeFocused();
  expect(service.submissions[0]).toEqual({ version: 1, kind: "future-suggestion", type: "question", text: "What did the 1850 survey leave out?" });
});

test("errors are announced on their field with focus there, and nothing is sent", async ({ page }) => {
  const service = await mockService(page);
  await open(page);
  const form = region(page);
  const send = form.getByRole("button", { name: "Send to the editors" });
  await send.click();
  const words = form.getByLabel("Your question", { exact: true });
  await expect(words).toBeFocused();
  await expect(words).toHaveAttribute("aria-invalid", "true");
  await expect(words).toHaveAccessibleDescription(/Write your suggestion in plain text of up to 2,000 characters/);
  await expect(form.getByRole("alert")).toContainText("Write your suggestion in plain text");
  await form.getByRole("radio", { name: "Video to watch" }).check();
  await form.getByLabel("Why it is worth watching", { exact: true }).fill("A recording of the survey.");
  // A link that is not public is refused on the link field.
  for (const link of ["http://192.168.1.1/x", "https://localhost/x", "javascript:alert(1)", "https://example.org/?access_token=abc"]) {
    await form.getByLabel("Link", { exact: true }).fill(link);
    await send.click();
    const field = form.getByLabel("Link", { exact: true });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("alert")).toContainText("public web page");
  }
  await form.getByLabel("Link", { exact: true }).fill("");
  // Agreeing to be thanked by a name needs a name.
  const credit = form.getByRole("checkbox", { name: "You may thank me by this name" });
  await credit.check();
  await send.click();
  await expect(credit).toBeFocused();
  await expect(credit).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByRole("alert")).toContainText("Enter your name to be thanked by it");
  await credit.uncheck();
  // Contact needs the reader's agreement, and a half-filled identifier is theirs to fix.
  await form.getByLabel("E-mail address", { exact: true }).fill("ada@example.org");
  await send.click();
  const follow = form.getByRole("checkbox", { name: "You may contact me at this address about this suggestion" });
  await expect(follow).toBeFocused();
  await expect(form.getByRole("alert")).toContainText("Agree to be contacted");
  await form.getByLabel("E-mail address", { exact: true }).fill("not an address");
  await follow.check();
  await send.click();
  await expect(form.getByLabel("E-mail address", { exact: true })).toBeFocused();
  await form.getByLabel("E-mail address", { exact: true }).fill("");
  await follow.uncheck();
  await form.getByLabel("Identifier", { exact: true }).selectOption({ label: "ISBN" });
  await send.click();
  // The control left empty is the one marked, not the title.
  await expect(form.getByLabel("Identifier value", { exact: true })).toBeFocused();
  await expect(form.getByLabel("Identifier value", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByLabel("Title", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
  await expect(form.getByRole("alert")).toContainText("Choose the kind of identifier and give its value");
  await form.getByLabel("Identifier", { exact: true }).selectOption({ label: "None" });
  // A detail the shared rule refuses is marked on the first detail the reader filled in, and keeps its own description.
  await form.getByLabel("Year", { exact: true }).fill("x".repeat(40));
  await send.click();
  const year = form.getByLabel("Year", { exact: true });
  await expect(year).toBeFocused();
  await expect(year).toHaveAttribute("aria-invalid", "true");
  await expect(year).toHaveAccessibleDescription(/Check the details/);
  await expect(form.getByLabel("Title", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
  await year.fill("");
  // The optional article box is described by its hint.
  await expect(form.getByRole("checkbox", { name: "It is about this article" })).toHaveAccessibleDescription(/which article led you/);
  expect(service.submissions).toEqual([]);
});

test("network loss keeps the suggestion, offers a retry that sends it, and a copy with the contact", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const service = await mockService(page, ["abort", { status: 202, body: { status: "pending", receipt: RECEIPT } }]);
  await open(page);
  const form = region(page);
  await form.getByLabel("Your question", { exact: true }).fill("Is the second rise <b>real</b>?");
  await form.getByRole("button", { name: "Send to the editors" }).click();
  const message = page.locator(".ob-future-suggestion-fallback-message");
  await expect(message).toBeFocused();
  await expect(message).toContainText("Nothing you wrote was lost");
  await expect(form.getByLabel("Your question", { exact: true })).toHaveValue("Is the second rise <b>real</b>?");
  const copy = page.getByLabel("Your suggestion, ready to send to the author");
  await expect(copy).toHaveValue(/^Suggestion for future work \(Question for a future piece\) from https:\/\/suggestions-site\.example\.org\/tides\//);
  await expect(copy).toHaveValue(/open\.blog suggestion record/);
  await page.getByRole("button", { name: "Copy suggestion" }).click();
  await expect(page.locator(".ob-future-suggestion-status")).toHaveText(/copied|selected/);
  await expect(page.getByRole("link", { name: "Write to the author" })).toHaveAttribute("href", /^mailto:ada@suggestions-site\.example\.org\?subject=/);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".ob-future-suggestion-done")).toBeFocused();
  expect(service.submissions).toHaveLength(2);
  expect(service.submissions[1]).toEqual(service.submissions[0]);
  await expect(page.locator(".ob-prose b")).toHaveCount(0);
});

test("a service that is off offers the copy without a retry; a duplicate and a rate limit are each said plainly", async ({ page }) => {
  let service = await mockService(page, [{ status: 404, body: { error: "unavailable", code: "unavailable" } }]);
  await open(page);
  const form = region(page);
  await form.getByLabel("Your question", { exact: true }).fill("Kept words.");
  await form.getByRole("button", { name: "Send to the editors" }).click();
  await expect(page.locator(".ob-future-suggestion-fallback-message")).toContainText("not taking suggestions through the form");
  await expect(page.getByRole("button", { name: "Try again" })).toBeHidden();
  expect(service.submissions).toHaveLength(1);

  await page.unroute(`${ENDPOINT}/feedback?**`);
  service = await mockService(page, [{ status: 409, body: { error: "again", code: "duplicate" } }]);
  await form.getByRole("button", { name: "Send to the editors" }).click();
  await expect(page.locator(".ob-future-suggestion-status")).toHaveText("This suggestion was already sent and is waiting for review.");

  await page.unroute(`${ENDPOINT}/feedback?**`);
  service = await mockService(page, [{ status: 429, body: { error: "slow down", code: "rateLimited" } }]);
  await form.getByRole("button", { name: "Send to the editors" }).click();
  await expect(page.locator(".ob-future-suggestion-fallback-message")).toContainText("too many have come from here recently");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.unroute(`${ENDPOINT}/feedback?**`);
  service = await mockService(page, [{ status: 422, body: { error: "bad link", code: "invalidUrl" } }]);
  await form.getByRole("button", { name: "Send to the editors" }).click();
  await expect(page.locator(".ob-future-suggestion-fallback-message")).toBeHidden();
});

test("a site with no hosted service shows only its configured contact, loads nothing and makes no request", async ({ page }) => {
  const requested = [];
  page.on("request", (request) => requested.push(new URL(request.url())));
  await page.goto(`${plain}/tides/`);
  const box = region(page);
  await expect(box).toContainText("This site does not take suggestions through a form, but you can write your suggestion to the author");
  await expect(box.getByRole("link", { name: "the contact page" })).toHaveAttribute("href", "https://suggestions-site.example.org/contact/");
  await expect(page.locator("ob-future-suggestion, .ob-future-suggestion-form")).toHaveCount(0);
  expect(requested.some((url) => url.pathname.includes("future-suggestion"))).toBe(false);
  expect(requested.every((url) => url.origin === new URL(plain).origin)).toBe(true);
  await expect(page.locator(".ob-prose")).toContainText("twice a day");
});

for (const [name, viewport, zoom] of [["320px", { width: 320, height: 640 }, 1], ["400% zoom", { width: 1280, height: 800 }, 4]]) {
  test(`at ${name} the form and the static region reflow without scrolling sideways`, async ({ page }) => {
    await page.setViewportSize(zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockService(page);
    await open(page);
    await region(page).getByRole("radio", { name: "Text to read" }).check();
    const box = page.locator("#ob-future-suggestion");
    expect(await box.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    const width = page.viewportSize().width;
    const regionBox = await box.boundingBox();
    expect(regionBox.x + regionBox.width).toBeLessThanOrEqual(width);
    for (const label of ["Why it is worth reading", "Link", "Title", "Creators", "Year", "Publisher or archive", "Identifier", "Identifier value", "Name", "E-mail address"]) {
      const control = await page.getByLabel(label, { exact: true }).boundingBox();
      expect(control.x, label).toBeGreaterThanOrEqual(0);
      expect(control.x + control.width, label).toBeLessThanOrEqual(width);
    }
    for (const label of ["Text to read", "It is about this article", "You may thank me by this name", "You may contact me at this address about this suggestion"]) {
      const control = await page.getByLabel(label, { exact: true }).boundingBox();
      expect(control.x + control.width, label).toBeLessThanOrEqual(width);
    }
    // Hostile text in the copy panel and the receipt panel wraps too.
    await region(page).getByLabel("Why it is worth reading", { exact: true }).fill("x".repeat(400));
    await region(page).getByRole("button", { name: "Send to the editors" }).click();
    await expect(page.locator(".ob-future-suggestion-done")).toBeFocused();
    expect(await box.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`at ${name} a static site's region reflows too`, async ({ page }) => {
    await page.setViewportSize(zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom });
    await page.goto(`${plain}/tides/`);
    const box = page.locator("#ob-future-suggestion");
    expect(await box.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

// The standing a receipt shows (#228, ADR 0163): a stage and one honest sentence, derived by the service.
const NOTICE = "Accepted means the editors are interested in exploring this. It does not mean they agree with it, have checked it, or have permission to use it.";
const LINK_NOTICE = "An editor has recorded a link between it and work they are doing. That is a record, not a promise to publish, and it says nothing about who is right.";
const DECLINE_NOTICE = "Not taking an idea forward is about this site's plans. It is not a judgement of the idea or of you.";
const STANDINGS = {
  received: { label: "Received", note: null },
  interested: { label: "Editors are interested", note: NOTICE },
  converted: { label: "Linked to future work", note: LINK_NOTICE },
  "closed-converted": { label: "Linked to future work, now closed", note: LINK_NOTICE },
  declined: { label: "Not taken forward", note: DECLINE_NOTICE },
};
const suggestionReceipt = (status, standing, extra = {}) => ({
  kind: "future-suggestion", status, version: 4, work: "/tides/", receivedAt: "2026-10-26T10:00:00Z", clarification: null, consent: false, published: false, purged: false,
  body: "Her letters from the 1850 survey would help.", details: { type: "text", url: "https://example.org/letters" },
  standing: { id: standing, ...STANDINGS[standing], acceptance: ["interested", "converted", "closed-converted"].includes(standing) },
  ...extra,
});

async function lookUp(page, item) {
  const sent = [];
  await page.route(/\/receipt(\?.*)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ item }) });
  });
  await open(page);
  const manage = page.locator(".ob-receipt-manage");
  await manage.locator("summary").click();
  await manage.getByLabel("Your receipt", { exact: true }).fill(RECEIPT);
  await manage.getByRole("button", { name: "Look up my suggestion" }).click();
  return { manage, sent };
}

for (const [standing, status, expected, absent] of [
  ["received", "pending", /Waiting for the editors’ review/, [NOTICE, LINK_NOTICE]],
  ["interested", "approved", new RegExp(NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), [LINK_NOTICE, "Linked to future work"]],
  ["converted", "approved", /^Linked to future work\. Accepted means the editors are interested/, []],
  ["closed-converted", "removed", /closed it, after linking it to future work/, []],
  ["declined", "rejected", /decided not to take it forward\. Not taking an idea forward is about this site/, [NOTICE]],
]) {
  test(`a reader's receipt for a suggestion that is "${standing}" says so honestly, with no rank, count or promise`, async ({ page }) => {
    const { manage, sent } = await lookUp(page, suggestionReceipt(status, standing));
    const state = manage.locator(".ob-receipt-state");
    await expect(state).toBeVisible();
    await expect(manage.getByRole("heading", { name: "Your suggestion" })).toBeFocused();
    await expect(state).toHaveText(expected);
    const text = await manage.innerText();
    for (const word of absent) expect(text).not.toContain(word);
    expect(text).not.toMatch(/\b(rank|ranked|score|votes?|popular|most requested|trending)\b/i);
    expect(text).not.toMatch(/will be published|has been published|is published/i);
    // Nothing of what the editors linked it to reaches the reader, and the lookup sends only the receipt.
    expect(text).not.toMatch(/tide-tables|conversions/);
    expect(sent).toEqual([{ receipt: RECEIPT, action: "read" }]);
  });
}

for (const [name, viewport, zoom] of [["320px", { width: 320, height: 640 }, 1], ["400% zoom", { width: 1280, height: 800 }, 4]]) {
  test(`at ${name} a linked suggestion's receipt reflows without scrolling sideways`, async ({ page }) => {
    await page.setViewportSize(zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom });
    const long = "x".repeat(400);
    const { manage } = await lookUp(page, suggestionReceipt("approved", "converted", { body: long }));
    await expect(manage.locator(".ob-receipt-state")).toContainText("Linked to future work.");
    // Measured on the region under test, not on the theme's header.
    const measure = (selector) => page.evaluate((query) => {
      const root = document.querySelector(query);
      const limit = window.innerWidth;
      const elements = [root, ...root.querySelectorAll("*")];
      return {
        overflow: Math.max(Math.max(...elements.map((element) => element.getBoundingClientRect().right)) - limit, root.scrollWidth - root.clientWidth),
        offenders: elements.filter((element) => element.getBoundingClientRect().right > limit + 1).map((element) => `${element.tagName.toLowerCase()}.${element.className}`),
      };
    }, selector);
    const result = await measure("#ob-future-suggestion");
    expect(result.offenders).toEqual([]);
    expect(result.overflow).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("it works under a strict content security policy", async ({ page }) => {
  await page.route(`${hosted}/tides/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const service = await mockService(page);
  await open(page);
  const before = await page.evaluate(() => window.__violations.slice());
  const form = region(page);
  await form.getByLabel("Your question", { exact: true }).fill("Under a strict policy.");
  await form.getByRole("button", { name: "Send to the editors" }).click();
  await expect(page.locator(".ob-future-suggestion-done")).toBeFocused();
  expect(service.submissions[0].type).toBe("question");
  expect(await page.evaluate(() => window.__violations)).toEqual(before);
});

test("without JavaScript the region explains how to write instead, and a locked post has no region", async ({ browser }) => {
  const scriptless = await browser.newContext({ javaScriptEnabled: false });
  const page = await scriptless.newPage();
  await page.goto(`${hosted}/tides/`);
  const fallback = page.locator(".ob-future-suggestion-static");
  await expect(fallback).toContainText("The form needs JavaScript");
  await expect(fallback).toContainText("whether you may be contacted about it");
  await expect(fallback.getByRole("link", { name: "ada@suggestions-site.example.org" })).toHaveAttribute("href", "mailto:ada@suggestions-site.example.org");
  await expect(page.locator(".ob-future-suggestion-form")).toHaveCount(0);
  await expect(page.locator(".ob-prose")).toContainText("twice a day");
  await scriptless.close();

  const context = await browser.newContext();
  const closed = await context.newPage();
  const loaded = [];
  closed.on("request", (request) => loaded.push(new URL(request.url()).pathname));
  await closed.goto(`${hosted}/closed/`);
  await expect(closed.locator("h1")).toHaveText("Closed");
  await expect(closed.locator("#ob-future-suggestion, ob-future-suggestion")).toHaveCount(0);
  expect(loaded.some((path) => path.includes("future-suggestion"))).toBe(false);
  await context.close();
});

// Credit is opt-in and bound to the text it was agreed for (ADR 0167): the reader changes it by their
// receipt, and a change of text or of consent takes it away until they agree again.
test("a reader sees whether the editors may credit them for this text, changes it from the keyboard, and is asked again after a clarification", async ({ page }) => {
  let item = suggestionReceipt("approved", "interested", { credit: { agreed: true } });
  const sent = [];
  await page.route(/\/receipt(\?.*)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = route.request().postDataJSON();
    sent.push(body);
    if (body.action === "credit") item = { ...item, version: item.version + 1, credit: { agreed: body.consent } };
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ item }) });
  });
  await open(page);
  const manage = page.locator(".ob-receipt-manage");
  await manage.locator("summary").click();
  await manage.getByLabel("Your receipt", { exact: true }).fill(RECEIPT);
  await manage.getByRole("button", { name: "Look up my suggestion" }).click();
  const credit = manage.getByLabel("The editors may credit me by the name I gave for this suggestion", { exact: true });
  await expect(credit).toBeChecked();
  await expect(credit).toHaveAccessibleDescription(/If you change its text, tick it again\. Nothing is published or sent/);
  // Withdrawing the agreement from the keyboard saves it for the version the reader loaded.
  await credit.focus();
  await page.keyboard.press("Space");
  await expect(manage.locator(".ob-receipt-status")).toHaveText("Saved: the editors may not credit you by name.");
  expect(sent.at(-1)).toEqual({ receipt: RECEIPT, action: "credit", consent: false, expectedVersion: 4 });
  await expect(credit).not.toBeChecked();
  // Agreeing again is fresh consent for the text as it stands.
  await credit.check();
  await expect(manage.locator(".ob-receipt-status")).toHaveText("Saved: the editors may credit you by your name for this text.");
  expect(sent.at(-1)).toEqual({ receipt: RECEIPT, action: "credit", consent: true, expectedVersion: 5 });
  await expect(credit).toBeChecked();
  // After a clarification changed the text, the service says the agreement no longer stands.
  item = { ...item, version: 7, credit: { agreed: false } };
  await manage.getByLabel("Your receipt", { exact: true }).fill(RECEIPT);
  await manage.getByRole("button", { name: "Look up my suggestion" }).click();
  await expect(credit).not.toBeChecked();
  // A refusal puts the box back and says so.
  await page.unroute(/\/receipt(\?.*)?$/);
  await page.route(/\/receipt(\?.*)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    return route.fulfill({ status: 503, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ error: "down" }) });
  });
  await credit.check();
  await expect(manage.locator(".ob-receipt-status")).toContainText("Something went wrong");
  await expect(credit).not.toBeChecked();
  await expect(credit).toBeFocused();
});

test("a reader who gave no name, or whose suggestion was deleted, is offered no credit to agree to", async ({ page }) => {
  const { manage } = await lookUp(page, suggestionReceipt("approved", "interested", { credit: null }));
  await expect(manage.locator(".ob-receipt-state")).toBeVisible();
  await expect(manage.getByLabel(/may credit me/)).toHaveCount(0);
  const purged = await page.context().newPage();
  const second = await lookUp(purged, suggestionReceipt("withdrawn", "received", { purged: true, body: undefined, details: undefined, credit: undefined }));
  await expect(second.manage.getByLabel(/may credit me/)).toHaveCount(0);
});
