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

// Continuation links (#231, ADRs 0218 to 0223). The reader's side, in the real site with JavaScript
// switched off: the earlier page lists where a question went, the later page lists what it
// continues, each as ordinary links reached from the keyboard, with a link to an unpublished page
// absent, no reader text and no overflow at 320px. The editor's side, in the real Admin with the
// hosted inbox mocked at the Admin API: a card that offers linking only to the site Admin for an
// approved item, a preview with the fixed notice, a link that is refused with a code, the list of
// links with their standing, removal, and the sweep of withdrawn submissions.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOSTILE = "<img src=x onerror=alert(1)>";
const NOTE = "The next episode returns to the neap tides.";
const post = (title, extra = "") => `---\ntitle: ${title}\ndate: 2026-10-20\n${extra}---\nThe body of ${title}.\n`;
const edge = (id, to, extra = {}) => ({ id, kind: "question", origin: ID(1), from: "/tides/", to, relation: "takes-up", linked: "2026-10-27", ...extra });
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-continuations-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Continuations",
    url: "https://continuations.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: false, analytics: false, feedback: true, receipts: true, endpoint: "https://continuations.example/api" },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), post("Tides"));
  writeFileSync(join(root, "content", "posts", "neaps.md"), post("Neap tides", "series: ocean\n"));
  writeFileSync(join(root, "content", "posts", "springs.md"), post(`Spring ${HOSTILE}`));
  writeFileSync(join(root, "content", "posts", "later.md"), post("Not yet", "draft: true\n"));
  writeFileSync(join(root, "content", "continuations.json"), `${JSON.stringify({
    version: 1,
    items: [
      edge("a", "/neaps/", { series: "ocean", note: NOTE }),
      edge("b", "/springs/"),
      edge("c", "/later/"),
    ],
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

const CORS = { "access-control-allow-origin": "*" };
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });

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

const overflowOf = (page, selector) =>
  page.evaluate((selector) => {
    const region = document.querySelector(selector);
    const limit = document.documentElement.clientWidth;
    const elements = [region, ...region.querySelectorAll("*")];
    const offenders = elements.filter((element) => element.getBoundingClientRect().right > limit + 1).map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return { overflow: Math.max(region.scrollWidth - region.clientWidth, 0), offenders };
  }, selector);

// ---- The reader

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the earlier page lists where the question went and the later page lists what it continues", async ({ page }) => {
    await page.goto(`${origin}/tides/`);
    const earlier = page.getByRole("region", { name: "Where this question went" });
    await expect(earlier).toBeVisible();
    await expect(earlier).toContainText("These links connect later work to earlier questions and reflections.");
    await expect(earlier).toContainText("does not mean the earlier submission caused it");
    // Two published targets; the draft is absent, and so is anything of its title.
    await expect(earlier.getByRole("listitem")).toHaveCount(2);
    await expect(earlier.getByRole("link", { name: "Neap tides" })).toHaveAttribute("href", "/neaps/");
    await expect(earlier).toContainText(NOTE);
    await expect(earlier).toContainText("in the series ocean");
    await expect(earlier).not.toContainText("Not yet");
    // The hostile title is text, never markup.
    await expect(earlier.getByRole("link", { name: `Spring ${HOSTILE}` })).toBeVisible();
    await expect(earlier.locator("img")).toHaveCount(0);
    // No form, count or subscription belongs to it.
    await expect(earlier.locator("form, input, button, script")).toHaveCount(0);
    await expect(earlier).not.toContainText(/subscribe|popular|\d+ readers/i);
  });

  test("the link is followed from the keyboard, and the way back is a link too", async ({ page }) => {
    await page.goto(`${origin}/tides/`);
    const link = page.getByRole("region", { name: "Where this question went" }).getByRole("link", { name: "Neap tides" });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/neaps/`);
    const later = page.getByRole("region", { name: "Earlier questions this continues" });
    await expect(later).toContainText("a reader's question");
    await expect(later).not.toContainText("The moon");
    const back = later.getByRole("link", { name: "Tides" });
    await back.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/tides/`);
  });

  test("an item has a stable anchor that scrolls to it", async ({ page }) => {
    await page.goto(`${origin}/tides/#ob-continuation-a`);
    await expect(page.locator("#ob-continuation-a")).toBeInViewport();
    await expect(page.locator("#ob-continuation-a")).toContainText("Neap tides");
  });

  test("the region fits at 320px and at 400% zoom, with reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [320, 1280 / 4]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/tides/`);
      const result = await overflowOf(page, "#ob-continuations");
      expect(result.offenders, `at ${width}px`).toEqual([]);
      expect(result.overflow, `at ${width}px`).toBe(0);
    }
  });
});

// ---- The editor

const approve = { action: "approve", label: "Approve", reasons: [], guidance: "" };
function item(n, extra = {}) {
  return {
    id: ID(n), source: "feedback", kind: "third-perspective", kindLabel: "Third Perspective", status: "approved", statusLabel: "Approved",
    version: 5, revision: 1, reason: null, reasonLabel: null, receivedAt: "2026-10-26T10:00:00Z", moderatedAt: "2026-10-27T09:00:00Z",
    work: "/tides/", post: { title: "Tides", url: "/tides/", source: "posts/tides.md" }, role: "site-admin", mode: "open", public: true,
    clarification: { askedAboutThisText: false, consent: false }, body: `A reading of the tides. ${HOSTILE}`, details: {},
    reader: { publishName: false }, published: true, mayBeShown: true, nameNarrowed: false, featureConsent: "not-agreed", actions: [approve].slice(1), ...extra,
  };
}
const page_ = (items, extra = {}) => ({ state: "approved", kind: "third-perspective", protocol: "full", items, invalid: 0, next: null, ...extra });
const WORKS = [{ path: "/neaps/", title: "Neap tides", series: "ocean" }, { path: "/springs/", title: "Spring tides", series: null }];
const NOTICE = "These links connect later work to earlier questions and reflections.";

test("an editor previews, links, removes and sweeps continuation links from the keyboard", async ({ page }) => {
  const calls = [];
  let links = [{ id: "link-1", origin: ID(9), kind: "question", relation: "takes-up", from: "/tides/", to: "/neaps/", series: "ocean", note: null, linked: "2026-10-20", standing: "notApproved", shown: false, hidden: null }];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([item(1), item(2, { role: "moderator" }), item(3, { status: "pending", statusLabel: "Pending" })])));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features: [] }));
  await page.route(`${origin}/admin/api/engagement/continuations`, (route) => json(route, 200, { truncated: false, links, works: WORKS, notice: NOTICE }));
  await page.route(`${origin}/admin/api/engagement/continuations/preview`, async (route) => {
    calls.push(["preview", route.request().postDataJSON()]);
    return json(route, 200, { preview: { kind: "reflection", relation: "takes-up", from: "/tides/", to: "/neaps/", series: "ocean", note: NOTE }, notice: NOTICE });
  });
  await page.route(`${origin}/admin/api/engagement/continuations/link`, async (route) => {
    const body = route.request().postDataJSON();
    calls.push(["link", body]);
    if (body.note?.includes("caused")) return json(route, 422, { error: "`note` must not say the submission caused or is endorsed by the work", code: "invalid" });
    links = [...links, { id: "link-2", origin: ID(1), kind: "reflection", relation: "takes-up", from: "/tides/", to: "/neaps/", series: "ocean", note: NOTE, linked: "2026-10-28", standing: "approved", shown: true, hidden: null }];
    return json(route, 200, { linked: true, id: "link-2", build: { ok: true } });
  });
  await page.route(`${origin}/admin/api/engagement/continuations/unlink`, async (route) => {
    calls.push(["unlink", route.request().postDataJSON()]);
    links = links.filter((entry) => entry.id !== route.request().postDataJSON().id);
    return json(route, 200, { unlinked: true, build: { ok: true } });
  });
  await page.route(`${origin}/admin/api/engagement/continuations/sweep`, async (route) => {
    calls.push(["sweep", route.request().postDataJSON()]);
    links = links.filter((entry) => entry.standing !== "notApproved");
    return json(route, 200, { dropped: 1, build: { ok: true } });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);

  // Only the site Admin, only an approved item.
  const form = page.locator(`[data-moderation-id="${ID(1)}"] [data-continuation-form]`);
  await expect(form.getByRole("heading", { name: "Link to a later work", level: 4 })).toBeVisible();
  await expect(page.locator(`[data-moderation-id="${ID(2)}"] [data-continuation-form]`)).toHaveCount(0);
  await expect(page.locator(`[data-moderation-id="${ID(3)}"] [data-continuation-form]`)).toHaveCount(0);

  // The list shows the stale link with its standing, in words.
  const section = page.locator("[data-continuations]");
  await expect(section.getByRole("heading", { name: "Continuation links", level: 2 })).toBeVisible();
  await expect(section).toContainText("Its submission is no longer approved here, so it is not shown.");

  // A choice needs a work.
  await form.getByRole("button", { name: "Preview" }).click();
  await expect(form.getByRole("status")).toContainText("Choose the later work first.");
  expect(calls).toEqual([]);

  const note = form.getByLabel("Your note");
  await expect(note).toHaveAccessibleDescription(/refused if it says the submission caused the work/);
  await expect(note).toHaveAttribute("maxlength", "280");
  await form.getByLabel("Later work").selectOption("/neaps/");
  await note.fill(`  ${NOTE}  `);
  await form.getByRole("button", { name: "Preview" }).focus();
  await page.keyboard.press("Enter");
  const preview = form.locator("[data-continuation-preview]");
  await expect(preview).toContainText(NOTICE);
  await expect(preview).toContainText("From /tides/ to /neaps/ (takes-up, series ocean).");
  await expect(preview).toContainText(`Your note: ${NOTE}`);
  expect(calls).toEqual([["preview", { id: ID(1), to: "/neaps/", relation: "takes-up", note: NOTE, expectedVersion: 5 }]]);

  // A refused note says why and keeps the form.
  await note.fill("Our post caused this one.");
  await form.getByRole("button", { name: "Link to the later work" }).click();
  await expect(form.getByRole("status")).toContainText("must not say the submission caused");
  await expect(form.getByRole("button", { name: "Link to the later work" })).toBeEnabled();

  await note.fill(NOTE);
  await form.getByRole("button", { name: "Link to the later work" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".oba-feedback-section").first().locator('p[role="status"]').first()).toContainText("Linked.");
  expect(calls.at(-1)).toEqual(["link", { id: ID(1), to: "/neaps/", relation: "takes-up", note: NOTE, expectedVersion: 5 }]);
  await expect(section).toContainText("It is shown on both pages.");

  // The sweep drops what the hosted service says is gone; removal takes a shown link off.
  await section.getByRole("button", { name: "Check for withdrawn submissions" }).click();
  await expect(page.locator(".oba-feedback-section").first().locator('p[role="status"]').first()).toContainText("1 link of withdrawn or removed submissions dropped.");
  await expect(section).not.toContainText("no longer approved");
  await section.getByRole("button", { name: "Remove the link" }).click();
  await expect(page.locator(".oba-feedback-section").first().locator('p[role="status"]').first()).toContainText("The link was removed from both pages.");
  expect(calls.at(-1)).toEqual(["unlink", { id: "link-2" }]);
  await expect(section).toContainText("No links yet.");
});

test("a moderator who is not the site Admin is not offered the section", async ({ page }) => {
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([item(1, { role: "moderator" })])));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 403, { error: "denied" }));
  await page.route(`${origin}/admin/api/engagement/continuations`, (route) => json(route, 403, { error: "Only the site Admin can change the continuation links.", code: "denied" }));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
  await expect(page.locator(`[data-moderation-id="${ID(1)}"]`)).toBeVisible();
  await expect(page.locator("[data-continuations]")).toBeHidden();
  await expect(page.locator("[data-continuation-form]")).toHaveCount(0);
});

test("a slow continuations list still ends with the section, the cards and their forms, and no failure", async ({ page }) => {
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([item(1)])));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features: [] }));
  await page.route(`${origin}/admin/api/engagement/continuations`, async (route) => {
    await new Promise((done) => setTimeout(done, 2500));
    return json(route, 200, { truncated: false, links: [], works: WORKS, notice: NOTICE });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
  // The list is slow, not broken: once it arrives the section, the card and its form all show,
  // and nothing said the load failed.
  await expect(page.locator("[data-continuations]")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("[data-continuations]")).toContainText("No links yet.");
  await expect(page.locator("[data-continuations]")).not.toContainText("could not be loaded");
  const form = page.locator(`[data-moderation-id="${ID(1)}"] [data-continuation-form]`);
  await expect(form.getByLabel("Later work")).toBeVisible();
  await expect(form.getByLabel("Later work").locator("option")).toHaveCount(WORKS.length + 1);
});

test("a continuations list that cannot be loaded says so instead of vanishing", async ({ page }) => {
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([item(1)])));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features: [] }));
  await page.route(`${origin}/admin/api/engagement/continuations`, (route) => json(route, 500, { error: "The service is down." }));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
  const section = page.locator("[data-continuations]");
  await expect(section).toBeVisible();
  await expect(section.getByRole("status")).toContainText("The continuation links could not be loaded");
  await expect(section.getByRole("status")).toContainText("nothing was changed");
  // A refused load stays quiet for someone who is not offered the section, and a dropped
  // connection is a failure like a server fault.
  await page.unroute(`${origin}/admin/api/engagement/continuations`);
  await page.route(`${origin}/admin/api/engagement/continuations`, (route) => route.abort("connectionreset"));
  await page.reload();
  await expect(page.locator("[data-continuations]").getByRole("status")).toContainText("could not be loaded");
});

test("a decision whose continuation links could not be dropped tells the moderator", async ({ page }) => {
  const reject = { action: "reject", label: "Reject", reasons: [], guidance: "" };
  const MESSAGE = "The submission's continuation links could not be removed, so a link may still show on the pages. Run \"Check for withdrawn submissions\" or remove the link by hand.";
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([item(3, { status: "pending", statusLabel: "Pending", actions: [reject] })], { state: "pending" })));
  await page.route(`${origin}/admin/api/engagement/moderation`, (route) => json(route, 200, { item: item(3), published: false, publishError: null, build: { ok: true }, removedTarget: false, continuationsDropped: 0, continuationsError: MESSAGE }));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features: [] }));
  await page.route(`${origin}/admin/api/engagement/continuations`, (route) => json(route, 200, { truncated: false, links: [], works: WORKS, notice: NOTICE }));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/pending?kind=third-perspective`);
  await page.locator(`[data-moderation-id="${ID(3)}"]`).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Rejected. Nothing was published.").first()).toContainText("Check for withdrawn submissions");
});
