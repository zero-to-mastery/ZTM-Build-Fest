import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio page and sign-in, with the collaboration API replaced by a small in-memory
// stand-in that checks the expected revision and the time format the way the server does. This
// exercises the media moments panel in a browser: keyboard use at phone width, malformed times,
// several media, a source with no link, a save that lost a race, and the quotation attribution,
// rights guidance and warnings (ADR 0065).

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const PUBLICATION = "shared-0a1b2c3d4e5f";
const SOURCES = [
  { id: "source-1", kind: "video", kindLabel: "Video", title: "A talk on video", url: "https://www.youtube.com/watch?v=abcdefghijk" },
  { id: "source-2", kind: "book", kindLabel: "Book", title: "A book without a link", url: null },
  { id: "source-3", kind: "podcast", kindLabel: "Podcast", title: "A podcast", url: "https://podcasts.example/12" },
];
const TIME = /^(\d+(?::[0-5]\d){0,2})(?:\.\d+)?$/;
// The server's quotation guide, shaped as `quotation_guide` sends it.
const GUIDE = {
  briefQuotationChars: 300,
  maxQuotationChars: 1000,
  maxRightsNoteBytes: 500,
  statement: "The rights status is the participant's own statement about these words. open.blog records it and shows it to co-authors; it does not check rights or decide how the words may be used.",
  rights: [
    { value: "unknown", label: "Not checked yet", guidance: "Nobody has considered yet how these words may be reused." },
    { value: "briefQuotation", label: "A brief quotation for commentary or review", guidance: "This states that the words are quoted briefly to comment on, criticise or review the source." },
    { value: "permission", label: "The rights holder gave permission", guidance: "This states that the rights holder agreed to this use. Say in the rights note who agreed and when." },
    { value: "openLicense", label: "The source is under an open licence", guidance: "This states that the source carries an open licence covering this use." },
    { value: "publicDomain", label: "The source is in the public domain", guidance: "This states that the source is in the public domain." },
    { value: "ownWords", label: "The participant's own words", guidance: "This states that the words are the participant's own." },
  ],
  notices: {
    noSpeaker: "No speaker is named, so the words are credited to the source alone. Name who said or wrote them if you know.",
    long: "This quotation is longer than 300 characters. Consider quoting only the words the point needs.",
    longForBriefQuotation: "This quotation is longer than 300 characters, which is long for a brief quotation. Consider quoting fewer words. This is a guide, not a legal limit.",
  },
};
let root;
let server;
let origin;
let moments;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-moments-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
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

const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function seconds(value) {
  return value.split(".")[0].split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function stored(id, moment) {
  const first = moment.locators[0];
  const location = first.kind === "timestamp" ? (first.to ? `from ${first.value} to ${first.to}` : `at ${first.value}`) : `${first.kind} ${first.value}`;
  const source = SOURCES.find((entry) => entry.id === moment.source);
  const time = moment.locators.find((locator) => locator.kind === "timestamp");
  const link = !source?.url ? null : source.id === "source-1" && time ? { href: `${source.url}&t=${seconds(time.value)}s`, atTime: true } : { href: source.url, atTime: false };
  const quotation = moment.quotation;
  const where = source ? `${source.title} (${source.kindLabel})` : "a source that is no longer listed";
  const attribution = quotation?.speaker ? `${quotation.speaker}, in ${where}, ${location}` : `${where}, ${location}`;
  const notices = [];
  if (quotation && !quotation.speaker) notices.push({ code: "noSpeaker", message: GUIDE.notices.noSpeaker });
  if (quotation && [...quotation.text].length > GUIDE.briefQuotationChars) {
    const code = quotation.rights === "briefQuotation" ? "longForBriefQuotation" : "long";
    notices.push({ code, message: GUIDE.notices[code] });
  }
  return { id, quotation: null, observation: null, ...moment, location, attribution, notices, link };
}

async function install(context) {
  moments = { revision: 0, next: 0, moments: [], shared: [], sources: SOURCES, you: "p-me", quotationGuide: GUIDE };
  await context.route("**/admin/api/collaboration/**", async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname.replace("/admin/api/collaboration/", "");
    if (path === "publications") {
      return json(route, 200, { publications: [{ publicationId: PUBLICATION, roles: ["contributor"], title: "A shared reflection", guidingQuestion: "What stayed with you?", sources: [] }] });
    }
    if (path === "draft" && method === "GET") return json(route, 200, { draft: null });
    if (path === "reveal") return json(route, 200, { policy: "voluntary", ready: false, canSetPolicy: false, slots: [] });
    if (path === "moments" && method === "GET") return json(route, 200, moments);
    if (path === "moments" && method === "POST") {
      const body = route.request().postDataJSON();
      if (body.expectedRevision !== moments.revision) return json(route, 409, { error: "The moments changed since you read them. Reload to see the current moments; what you typed is still here and nothing was changed." });
      const change = body.change;
      if (change.moment && change.moment.locators.some((locator) => locator.kind === "timestamp" && !TIME.test(locator.value))) {
        return json(route, 422, { error: "Give a location: a timestamp as seconds or h:mm:ss.", field: "locators" });
      }
      let list = moments.moments.slice();
      let next = moments.next;
      if (change.action === "add") list.push(stored(`moment-${(next += 1)}`, change.moment));
      if (change.action === "edit") list = list.map((moment) => (moment.id === change.id ? stored(change.id, change.moment) : moment));
      if (change.action === "remove") list = list.filter((moment) => moment.id !== change.id);
      moments = { ...moments, revision: moments.revision + 1, next, moments: list };
      return json(route, 200, moments);
    }
    return json(route, 404, { error: "not found" });
  });
}

async function openPanel(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.goto(`${origin}/admin/#/shared`);
  await page.locator("summary", { hasText: "Your draft" }).click();
  await expect(page.getByRole("heading", { name: "Moments in the sources" })).toBeVisible();
}

const panel = (page) => page.locator(".oba-moments");

test("a moment is captured with the keyboard alone at phone width, and a malformed time is caught first", async ({ page, context }) => {
  await install(context);
  await page.setViewportSize({ width: 320, height: 700 });
  await openPanel(page);
  await panel(page).getByLabel("Source", { exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(panel(page).getByLabel("Source", { exact: true })).toHaveValue("source-1");
  await panel(page).getByLabel("Location", { exact: true }).focus();
  await page.keyboard.type("1:60");
  await panel(page).getByLabel("Your observation (Markdown, optional)").focus();
  await page.keyboard.type("The pause before the answer.");
  await panel(page).getByRole("button", { name: "Add moment" }).focus();
  await page.keyboard.press("Enter");
  const alert = panel(page).getByRole("alert");
  await expect(alert).toContainText("seconds or h:mm:ss");
  await expect(alert).toBeFocused();
  await expect(panel(page).getByLabel("Location", { exact: true })).toHaveAttribute("aria-invalid", "true");
  expect(moments.moments).toEqual([]);
  await panel(page).getByLabel("Location", { exact: true }).fill("1:02");
  await panel(page).getByRole("button", { name: "Add moment" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByText(/Moment 1 of 1\./)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Edit moment 1 of 1" })).toBeFocused();
  await expect(panel(page).getByLabel("Your observation (Markdown, optional)")).toHaveValue("");
  expect(moments.moments[0].observation).toBe("The pause before the answer.");
  await expect(panel(page).getByRole("link", { name: /Open the source at 1:02/ })).toHaveAttribute("href", "https://www.youtube.com/watch?v=abcdefghijk&t=62s");
  const wide = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".oba-moments, .oba-moments *")].filter((node) => node.getBoundingClientRect().right > limit + 1).map((node) => node.className || node.tagName);
  });
  expect(wide).toEqual([]);
});

test("several media list in source order, and a source with no link keeps the location as text", async ({ page, context }) => {
  await install(context);
  await openPanel(page);
  const items = panel(page).locator(".oba-moments-list > li");
  // Every add says the same "Moment added", so wait for this save's own moment to be listed
  // before typing the next: typing during a save is reset when the save finishes.
  const add = async (source, kind, value, words) => {
    const before = await items.count();
    await panel(page).getByLabel("Source", { exact: true }).selectOption(source);
    await panel(page).getByLabel("Kind of location").selectOption(kind);
    await panel(page).getByLabel("Location", { exact: true }).fill(value);
    await panel(page).getByLabel("Your observation (Markdown, optional)").fill(words);
    await panel(page).getByRole("button", { name: "Add moment" }).click();
    await expect(items).toHaveCount(before + 1);
    await expect(panel(page).getByRole("status")).toContainText("Moment added");
  };
  await add("source-3", "timestamp", "5:00", "On the podcast.");
  await add("source-2", "page", "12", "In the book.");
  await add("source-1", "timestamp", "0:30", "On the video.");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("A talk on video");
  await expect(items.nth(1)).toContainText("This source has no link. The location is kept with the moment.");
  await expect(items.nth(2).getByRole("link", { name: /find the location yourself/ })).toHaveAttribute("href", "https://podcasts.example/12");
});

test("a save that lost a race keeps everything typed and stores it on retry", async ({ page, context }) => {
  await install(context);
  await openPanel(page);
  moments = { ...moments, revision: 3, next: 1, moments: [stored("moment-1", { source: "source-3", locators: [{ kind: "timestamp", value: "9" }], observation: "Made in another tab.", intent: "private" })] };
  await panel(page).getByLabel("Source", { exact: true }).selectOption("source-1");
  await panel(page).getByLabel("Location", { exact: true }).fill("2:00");
  await panel(page).getByLabel("Quoted words").fill("Words I typed carefully.");
  await panel(page).getByLabel("Rights (your statement)").selectOption("briefQuotation");
  await panel(page).getByLabel("Where the words came from").selectOption("transcribed");
  await panel(page).getByRole("button", { name: "Add moment" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("changed since you read them");
  await expect(panel(page).getByText("Made in another tab.")).toBeVisible();
  await expect(panel(page).getByLabel("Quoted words")).toHaveValue("Words I typed carefully.");
  await expect(panel(page).getByLabel("Location", { exact: true })).toHaveValue("2:00");
  await panel(page).getByRole("button", { name: "Add moment" }).click();
  await expect(panel(page).locator(".oba-moments-list > li")).toHaveCount(2);
  expect(moments.moments[1].quotation).toEqual({ text: "Words I typed carefully.", rights: "briefQuotation", provenance: "transcribed" });
});

test("a quotation shows neutral rights guidance and live warnings, saves anyway, and is credited precisely", async ({ page, context }) => {
  await install(context);
  await page.setViewportSize({ width: 320, height: 700 });
  await openPanel(page);
  const rights = panel(page).getByLabel("Rights (your statement)");
  const guidance = panel(page).locator("#oba-moments-0-rights-guidance");
  const warnings = panel(page).locator("#oba-moments-0-quote-notices");
  await expect(guidance).toHaveAttribute("aria-live", "polite");
  await expect(rights).toHaveAttribute("aria-describedby", "oba-moments-0-rights-guidance");
  await expect(guidance).toContainText("does not check rights");
  await panel(page).getByLabel("Source", { exact: true }).selectOption("source-1");
  await panel(page).getByLabel("Location", { exact: true }).fill("1:02");
  await panel(page).getByLabel("Quoted words").fill(`${"Line of a long answer.\n".repeat(14)}`);
  await rights.focus();
  await rights.selectOption("briefQuotation");
  await expect(guidance).toContainText("quoted briefly to comment on");
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("No speaker is named");
  await expect(warnings).toContainText("long for a brief quotation");
  await panel(page).getByLabel("Speaker (optional)").fill("The host");
  await expect(warnings).not.toContainText("No speaker is named");
  await panel(page).getByLabel("Rights note (optional)").fill("Quoted for review only");
  await panel(page).getByLabel("Where the words came from").selectOption("transcribed");
  // The warnings are advice: the moment saves with them.
  await panel(page).getByRole("button", { name: "Add moment" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toContainText("Moment added");
  expect(moments.moments[0].quotation).toMatchObject({ speaker: "The host", rights: "briefQuotation", rightsNote: "Quoted for review only" });
  const item = panel(page).locator(".oba-moments-list > li").first();
  await expect(item.locator("figcaption")).toHaveText("— The host, in A talk on video (Video), at 1:02");
  await expect(item).toContainText("Rights, as you state them: A brief quotation for commentary or review.");
  await expect(item).toContainText("Rights note: Quoted for review only");
  await expect(item).toContainText("long for a brief quotation");
  await expect(page.getByText(/fair use/i)).toHaveCount(0);
  const wide = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".oba-moments, .oba-moments *")].filter((node) => node.getBoundingClientRect().right > limit + 1).map((node) => node.className || node.tagName);
  });
  expect(wide).toEqual([]);
});
