import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Approved Third Perspectives and a reader's status (#222, ADR 0115), in the real site with the
// hosted function mocked at its routes: approved reflections listed on the canonical page as
// readers' and never as the authors', with hostile text kept as text and a look-alike of the
// author's name withheld; the page without JavaScript; keyboard use; 320px and 400% zoom measured
// on the post's main content; the reader's receipt naming pending, approved, not published and
// withdrawn without saying anything about anyone else; an offline lookup; and a post that hides
// the kind showing nothing.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const ENDPOINT = "https://status.example/api";
const RECEIPT = "S".repeat(43);
const HOSTILE = "<img src=x onerror=alert(1)>";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REVISION = "p1:00000000000000000000000000000000";
const POST = "---\ntitle: Tides\ndate: 2026-10-20\n---\nThe moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n";
let root;
let server;
let origin;

const record = (n, post, work, extra) => ({
  id: ID(n), post, work, revision: REVISION, target: { version: 1, kind: "work" },
  body: "A reading of the tides.", received: "2026-10-26", approved: "2026-10-27", ...extra,
});

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-third-perspective-status-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Status",
    url: "https://status-site.example.org",
    postPath: "/{slug}/",
    author: { name: "Ada Lovelace" },
    engagement: { enabled: true, comments: false, analytics: false, receipts: true, endpoint: ENDPOINT },
    participation: { kinds: { "third-perspective": "open", "abuse-report": "open" } },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
  writeFileSync(join(root, "content", "posts", "quiet.md"), "---\ntitle: Quiet\ndate: 2026-10-19\nparticipation:\n  - third-perspective: hidden\n---\nQuiet text.\n");
  writeFileSync(join(root, "content", "third-perspectives.json"), `${JSON.stringify({
    version: 1,
    items: [
      record(1, "posts/tides.md", "/tides/", { name: "Mina", category: "connection", body: `Tides as a conversation ${HOSTILE}.\n\nA second ${"very-long-unbroken-word".repeat(6)} paragraph.` }),
      record(2, "posts/tides.md", "/tides/", { name: "Ada Love​lace", target: { version: 1, kind: "section", section: "methods" } }),
      record(3, "posts/quiet.md", "/quiet/", { body: "Never shown on a hidden post." }),
    ],
  }, null, 2)}\n`);
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

const json = (route, status, body) => route.fulfill({
  status,
  contentType: "application/json",
  headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" },
  body: JSON.stringify(body),
});
const preflight = (route) => route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST" }, body: "" });

/** The hosted receipt route answering `answer` (or dropping the connection), recording requests. */
async function mockReceipt(page, answer) {
  const sent = [];
  await page.route(`${ENDPOINT}/receipt`, async (route) => {
    if (route.request().method() === "OPTIONS") return preflight(route);
    sent.push(JSON.parse(route.request().postData() || "{}"));
    const current = typeof answer === "function" ? answer() : answer;
    if (current?.abort) return route.abort("internetdisconnected");
    return json(route, current.status ?? 200, current.body);
  });
  return sent;
}

const reflection = (extra = {}) => ({ kind: "third-perspective", status: "pending", version: 1, work: "/tides/", receivedAt: "2026-10-26T10:00:00Z", clarification: null, consent: true, published: false, purged: false, body: "My own reading.", details: { category: "connection" }, ...extra });

// How far the post's main content pokes past the viewport or scrolls sideways, naming what
// overflows. The theme's header depends on the platform's fonts, not on this section.
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

test("approved reflections are listed on the canonical page as readers', never as the authors'", async ({ page }) => {
  await page.route(`${ENDPOINT}/**`, (route) => route.abort());
  const alerts = [];
  page.on("dialog", (dialog) => { alerts.push(dialog.message()); dialog.dismiss(); });
  await page.goto(`${origin}/tides/`);
  const section = page.getByRole("region", { name: "Third Perspectives" });
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { level: 2, name: "Third Perspectives" })).toBeVisible();
  await expect(section.getByText("never as one of the authors’", { exact: false })).toBeVisible();
  const items = section.getByRole("listitem");
  await expect(items).toHaveCount(2);
  const named = section.getByRole("article", { name: "Third Perspective from Mina, a reader" });
  await expect(named).toBeVisible();
  await expect(named.getByText(`Tides as a conversation ${HOSTILE}.`)).toBeVisible();
  await expect(named.getByText("Prompt: A connection", { exact: false })).toBeVisible();
  await expect(named.getByText("Written about an earlier version of this work.")).toBeVisible();
  // A name that looks like the author's is never shown with a reflection.
  const anonymous = section.getByRole("article", { name: "Third Perspective from a reader" });
  await expect(anonymous).toBeVisible();
  await expect(section.getByText("Ada Love", { exact: false })).toHaveCount(0);
  expect(alerts).toEqual([]);
  expect(await page.locator("img[src=x]").count()).toBe(0);
  // Keyboard: the section link reaches the Methods heading.
  const link = anonymous.getByRole("link", { name: "Methods" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#methods$/);
  // The list follows the authors' text and comes before the form asking for more.
  const order = await page.evaluate(() => {
    const at = (selector) => [...document.querySelectorAll("*")].indexOf(document.querySelector(selector));
    return [at(".ob-prose"), at("#ob-third-perspectives"), at("#ob-third-perspective")];
  });
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  // Each can be reported, without a script needed to read it.
  await expect(named.locator("ob-abuse-report")).toHaveCount(1);
  // A post that hides the kind shows none.
  await page.goto(`${origin}/quiet/`);
  await expect(page.getByText("Never shown on a hidden post.")).toHaveCount(0);
  await expect(page.locator("#ob-third-perspectives")).toHaveCount(0);
});

test("without JavaScript the reflections are complete, and they reflow at 320px and 400% zoom", async ({ browser }) => {
  const still = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 800 } });
  const page = await still.newPage();
  await page.goto(`${origin}/tides/`);
  await expect(page.getByRole("article", { name: "Third Perspective from Mina, a reader" })).toBeVisible();
  await expect(page.getByText("To report this reflection as abusive, write to the author.").first()).toBeVisible();
  const still320 = await mainOverflow(page);
  expect(still320.overflow, still320.offenders.join(", ")).toBeLessThanOrEqual(1);
  await still.close();
  for (const viewport of [{ width: 320, height: 640 }, { width: 1280 / 4, height: 800 / 4 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const live = await context.newPage();
    await live.route(`${ENDPOINT}/**`, (route) => route.abort());
    await live.goto(`${origin}/tides/`);
    const section = live.locator("#ob-third-perspectives");
    await expect(section).toBeVisible();
    const sectionOverflow = await section.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(sectionOverflow).toBeLessThanOrEqual(0);
    const measured = await mainOverflow(live);
    expect(measured.overflow, `${viewport.width}px: ${measured.offenders.join(", ")}`).toBeLessThanOrEqual(1);
    await context.close();
  }
});

test("a reader's receipt names their reflection's state, and pending never reads as published", async ({ page }) => {
  let answer = { body: { item: reflection() } };
  const sent = await mockReceipt(page, () => answer);
  await page.goto(`${origin}/tides/`);
  const region = page.locator("#ob-third-perspective");
  const manager = region.locator(".ob-receipt-manage");
  await manager.locator("summary").click();
  await expect(manager.locator("summary")).toHaveText("Check, clarify or withdraw a reflection you sent");
  const field = manager.getByLabel("Your receipt");
  await field.fill(RECEIPT);
  await field.press("Enter");
  await expect(manager.getByRole("heading", { name: "Your reflection" })).toBeFocused();
  const state = manager.locator(".ob-receipt-state");
  await expect(state).toHaveText(/^Waiting for a moderator’s review\. It is not published/);
  await expect(state).not.toHaveText(/is shown on/);
  expect(sent.at(-1)).toEqual({ receipt: RECEIPT, action: "read" });

  const look = manager.getByRole("button", { name: "Look up my reflection" });
  for (const [item, words] of [
    [reflection({ status: "approved", published: true }), /^Approved; it appears on the work’s page as a reader’s reflection/],
    [reflection({ status: "rejected" }), /^Not published:/],
    [reflection({ status: "withdrawn", purged: true, body: undefined, details: undefined }), /^You withdrew it, so it is not published\./],
  ]) {
    answer = { body: { item } };
    await look.click();
    await expect(state).toHaveText(words);
  }
  // Withdrawn and deleted: nothing of the text, and nothing left to withdraw.
  await expect(manager.getByText("What you wrote:")).toHaveCount(0);
  await expect(manager.getByRole("button", { name: "Withdraw and delete my reflection" })).toHaveCount(0);

  // An approved reflection can still be withdrawn, said in the reflection's words.
  answer = { body: { item: reflection({ status: "approved", published: true }) } };
  await look.click();
  await expect(manager.getByLabel("I want this reflection taken off the work’s page and out of any community section it is featured in and the hosted copy of its text and my name deleted. I understand that copies already published (the site’s history, feeds and the repository’s history) may remain, and that a feature or a name that was published stays in them. This cannot be undone.")).toBeVisible();

  // A guessed receipt finds nothing and names nobody.
  answer = { status: 404, body: { error: "No note matches this receipt.", code: "unknownReceipt" } };
  await look.click();
  await expect(manager.getByRole("status")).toHaveText("No note matches this receipt. Check that you copied all of it.");
  await expect(manager.locator(".ob-receipt-result")).toBeEmpty();
  // Offline: the page says so and keeps the receipt typed in.
  answer = { abort: true };
  await look.click();
  await expect(manager.getByRole("status")).toHaveText("The service did not answer. Check your connection and try again.");
  await expect(field).toHaveValue(RECEIPT);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
});
