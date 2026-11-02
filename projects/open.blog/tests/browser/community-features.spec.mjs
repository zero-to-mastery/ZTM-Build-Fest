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

// Featuring an approved reflection (#229, ADRs 0176 to 0182). The reader's side, in the real site
// with the hosted function mocked at its routes: an unticked feature choice on the form that says
// copies may remain, and a choice on the private receipt for the text the reader sees, saying so
// when an earlier agreement does not cover it. The editor's side, in the real Admin with the
// hosted inbox mocked at the Admin API: a card that offers featuring only on the reader's agreement,
// a preview that is the public form with the fixed notice, a note, taking a feature off, and the
// banner for features that must come off or are hidden. Everything is keyboard operable, and the
// regions are measured at 320px and at 400% zoom.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://features.example/api";
const RECEIPT = "F".repeat(43);
const HOSTILE = "<img src=x onerror=alert(1)>";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POST = "---\ntitle: Tides\ndate: 2026-10-20\n---\nThe moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n";
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-community-features-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Features",
    url: "https://features-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: false, analytics: false, feedback: true, receipts: true, endpoint: ENDPOINT },
    participation: { kinds: { "third-perspective": "open" } },
  }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "tides.md"), POST);
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

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
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

// ---- The reader

async function mockFeedback(page) {
  const sent = [];
  await page.route(`${ENDPOINT}/feedback`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    sent.push(route.request().postDataJSON());
    return json(route, 202, { status: "pending", receipt: RECEIPT });
  });
  return sent;
}

const overflowOf = (page, selector) =>
  page.evaluate((selector) => {
    const region = document.querySelector(selector);
    const limit = document.documentElement.clientWidth;
    const elements = [region, ...region.querySelectorAll("*")];
    const offenders = elements.filter((element) => element.getBoundingClientRect().right > limit + 1).map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return { overflow: Math.max(region.scrollWidth - region.clientWidth, 0), offenders };
  }, selector);

test("the form's feature choice is unticked, separate, says copies may remain, and is sent only when ticked", async ({ page }) => {
  const sent = await mockFeedback(page);
  await page.goto(`${origin}/tides/`);
  await page.waitForFunction(() => customElements.get("ob-third-perspective") !== undefined);
  const form = page.getByRole("region", { name: "Offer a Third Perspective" });
  const feature = form.getByRole("checkbox", { name: "An editor may feature my reflection in a community section" });
  await expect(feature).not.toBeChecked();
  await expect(feature).toHaveAccessibleDescription(/Separate from publishing it\./);
  await expect(feature).toHaveAccessibleDescription(/copies already published may remain/);
  await expect(feature).toHaveAccessibleDescription(/does not mean anyone agrees with it/);
  await form.getByLabel("Your reflection", { exact: true }).fill("A reading of the tides.");
  await form.getByRole("radio", { name: "Yes, publish it on this page if a moderator approves it" }).check();
  // Keyboard: reach the choice by tabbing and tick it with the space bar.
  await feature.focus();
  await page.keyboard.press("Space");
  await expect(feature).toBeChecked();
  await form.getByRole("button", { name: "Send for review" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ob-third-perspective-status")).toHaveText("Sent for review.");
  expect(sent[0].consent).toEqual({ publish: true, clarification: false, feature: true });
  // The receipt shows what was agreed, as its own choice.
  await expect(page.getByRole("checkbox", { name: "An editor may feature this reflection in a community section" })).toBeChecked();

  // Unticked, nothing is sent as agreed.
  await page.reload();
  await page.waitForFunction(() => customElements.get("ob-third-perspective") !== undefined);
  const again = page.getByRole("region", { name: "Offer a Third Perspective" });
  await again.getByLabel("Your reflection", { exact: true }).fill("Another reading.");
  await again.getByRole("radio", { name: "Yes, publish it on this page if a moderator approves it" }).check();
  await again.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".ob-third-perspective-status")).toHaveText("Sent for review.");
  expect(sent[1].consent.feature).toBe(false);
});

test("a receipt asks again for a changed text, and agreeing or declining is saved by version", async ({ page }) => {
  const reads = [];
  let item = { kind: "third-perspective", status: "approved", version: 4, work: "/tides/", receivedAt: "2026-10-26T10:00:00Z", clarification: null, consent: true, published: true, purged: false, body: "My own reading.", details: {}, feature: { revision: 2, agreed: false, earlier: true } };
  await page.route(`${ENDPOINT}/receipt`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = route.request().postDataJSON();
    reads.push(body);
    if (body.action === "feature") {
      if (body.expectedVersion !== item.version) return json(route, 409, { error: "changed", code: "conflict", item });
      item = { ...item, version: item.version + 1, feature: { revision: 2, agreed: body.consent === true, earlier: false } };
    }
    return json(route, 200, { item });
  });
  await page.goto(`${origin}/tides/`);
  const manager = page.locator("#ob-third-perspective .ob-receipt-manage");
  await manager.locator("summary").click();
  await manager.getByLabel("Your receipt").fill(RECEIPT);
  await manager.getByLabel("Your receipt").press("Enter");
  const box = manager.getByRole("checkbox", { name: "An editor may feature this reflection in a community section" });
  await expect(box).not.toBeChecked();
  await expect(box).toHaveAccessibleDescription(/You agreed to feature an earlier text\. That does not cover this one\./);
  await expect(box).toHaveAccessibleDescription(/Copies already published may remain/);
  await box.focus();
  await page.keyboard.press("Space");
  await expect(manager.getByRole("status")).toHaveText("Saved: an editor may feature this text.");
  expect(reads.at(-1)).toEqual({ receipt: RECEIPT, action: "feature", consent: true, revisionSeen: 2, expectedVersion: 4 });
  await expect(manager.getByRole("checkbox", { name: "An editor may feature this reflection in a community section" })).toBeChecked();
  // Declining is immediate and names no revision.
  await manager.getByRole("checkbox", { name: "An editor may feature this reflection in a community section" }).uncheck();
  await expect(manager.getByRole("status")).toHaveText("Saved: it will not be featured.");
  expect(reads.at(-1)).toEqual({ receipt: RECEIPT, action: "feature", consent: false, expectedVersion: 5 });
  // Withdrawing says a feature and a name stay in the site's history.
  await expect(manager.getByLabel(/may remain, and that a feature or a name that was published stays in them/)).toBeVisible();
});

// ---- The editor

const approve = { action: "approve", label: "Approve", reasons: [], guidance: "" };
function reflection(n, extra = {}) {
  return {
    id: ID(n), source: "feedback", kind: "third-perspective", kindLabel: "Third Perspective", status: "approved", statusLabel: "Approved",
    version: 5, revision: 1, reason: null, reasonLabel: null, receivedAt: "2026-10-26T10:00:00Z", moderatedAt: "2026-10-27T09:00:00Z",
    work: "/tides/", post: { title: "Tides", url: "/tides/", source: "posts/tides.md" }, role: "site-admin", mode: "open", public: true,
    clarification: { askedAboutThisText: false, consent: false }, body: `A reading of the tides. ${HOSTILE}`, details: {},
    reader: { publishName: false }, published: true, mayBeShown: true, nameNarrowed: false, featureConsent: "agreed", actions: [], ...extra,
  };
}
const page_ = (items, extra = {}) => ({ state: "approved", kind: "third-perspective", protocol: "full", items, invalid: 0, next: null, ...extra });
const queueStatus = (page) => page.locator(".oba-feedback-section").first().locator('p[role="status"]').first();
const PREVIEW = {
  preview: {
    id: ID(1), response: { kind: "third-perspective", role: "reader", work: "/tides/", about: "work", stale: false, earlierRevision: false, body: `A reading of the tides. ${HOSTILE}`, name: null, received: "2026-10-26" },
    context: "Connects the tides to a rhythm.", featured: "2026-10-28",
    provenance: "A Third Perspective from a reader, received 2026-10-26 and approved by the editors. It is featured here from 2026-10-28, with the reader's separate permission.",
  },
  notice: "The editors chose these reflections to feature. Each is one reader's view: featuring a reflection is an editorial choice, not a vote, and it does not mean the authors, the editors or the community agree with it.",
  willPublish: false,
};

test("an editor previews, chooses, annotates and takes off a feature from the keyboard, only on the reader's agreement", async ({ page }) => {
  let features = [];
  const calls = [];
  const items = () => [reflection(1), reflection(2, { featureConsent: "not-agreed" }), reflection(3, { featureConsent: "earlier-text" })];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items())));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features }));
  await page.route(`${origin}/admin/api/engagement/community/preview`, async (route) => { calls.push(["preview", route.request().postDataJSON()]); return json(route, 200, PREVIEW); });
  await page.route(`${origin}/admin/api/engagement/community/feature`, async (route) => {
    calls.push(["feature", route.request().postDataJSON()]);
    features = [{ id: ID(1), post: "posts/tides.md", featured: "2026-10-28", context: "Connects the tides to a rhythm.", standing: "covered" }];
    return json(route, 200, { featured: true, build: { ok: true, posts: 1 } });
  });
  await page.route(`${origin}/admin/api/engagement/community/note`, async (route) => { calls.push(["note", route.request().postDataJSON()]); return json(route, 200, { updated: true, build: { ok: true } }); });
  await page.route(`${origin}/admin/api/engagement/community/unfeature`, async (route) => {
    calls.push(["unfeature", route.request().postDataJSON()]);
    features = [];
    return json(route, 200, { featured: false, build: { ok: true } });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
  const agreed = page.locator(`[data-moderation-id="${ID(1)}"] [data-feature-section]`);
  await expect(agreed.getByRole("heading", { name: "Feature on the post", level: 4 })).toBeVisible();
  await expect(agreed.getByText("The reader agreed to have this text featured.")).toBeVisible();
  // Without the reader's agreement, or with one for earlier text, there is nothing to choose.
  const none = page.locator(`[data-moderation-id="${ID(2)}"] [data-feature-section]`);
  await expect(none.getByText("The reader has not agreed to have this reflection featured.", { exact: false })).toBeVisible();
  await expect(none.getByRole("button")).toHaveCount(0);
  const earlier = page.locator(`[data-moderation-id="${ID(3)}"] [data-feature-section]`);
  await expect(earlier.getByText("does not cover this one", { exact: false })).toBeVisible();
  await expect(earlier.getByRole("button")).toHaveCount(0);

  // Preview: the public form with the fixed notice, as text, changing nothing.
  const note = agreed.getByLabel("The editors’ note");
  await expect(note).toHaveAccessibleDescription(/refused if it claims popularity, agreement or a count of readers/);
  await expect(note).toHaveAttribute("maxlength", "280");
  await note.fill("  Connects the tides to a rhythm.  ");
  await agreed.getByRole("button", { name: "Preview" }).focus();
  await page.keyboard.press("Enter");
  const preview = agreed.locator("[data-feature-preview]");
  await expect(preview.getByRole("heading", { name: "Preview: how the post’s Community perspectives section will show it", level: 5 })).toBeVisible();
  await expect(preview).toContainText("featuring a reflection is an editorial choice, not a vote");
  await expect(preview).toContainText("approved by the editors");
  await expect(preview.locator("blockquote")).toHaveText(`A reading of the tides. ${HOSTILE}`);
  await expect(preview.locator("img")).toHaveCount(0);
  await expect(preview).toContainText("The editors’ note: Connects the tides to a rhythm.");
  expect(calls).toEqual([["preview", { id: ID(1), context: "Connects the tides to a rhythm." }]]);

  // Choose: with the version the editor saw.
  await agreed.getByRole("button", { name: "Feature on the post" }).focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toContainText("Featured in the post’s Community perspectives section.");
  expect(calls.at(-1)).toEqual(["feature", { id: ID(1), context: "Connects the tides to a rhythm.", expectedVersion: 5 }]);
  const featured = page.locator(`[data-moderation-id="${ID(1)}"] [data-feature-section]`);
  await expect(featured.getByText("Featured on 2026-10-28 in the post’s Community perspectives section.", { exact: false })).toBeVisible();
  await expect(featured.getByRole("button", { name: "Feature on the post" })).toHaveCount(0);
  // The note changes without the reader; the feature can be taken off by choice.
  await featured.getByLabel("The editors’ note").fill("A closer look at the tides.");
  await featured.getByRole("button", { name: "Save the note" }).click();
  await expect(queueStatus(page)).toContainText("The editors’ note was saved.");
  expect(calls.at(-1)).toEqual(["note", { id: ID(1), context: "A closer look at the tides." }]);
  await page.locator(`[data-moderation-id="${ID(1)}"] [data-feature-section]`).getByRole("button", { name: "Take the feature off" }).click();
  await expect(queueStatus(page)).toContainText("The feature was taken off its post. The reflection stays published.");
  expect(calls.at(-1)).toEqual(["unfeature", { id: ID(1) }]);
});

test("the banner on every tab lists features that must come off or are hidden, and takes them off", async ({ page }) => {
  let features = [
    { id: ID(1), post: "posts/tides.md", featured: "2026-10-28", context: null, standing: "mustComeOff", reason: "consent-declined", explanation: "the reader no longer agrees to have it featured" },
    { id: ID(2), post: "posts/tides.md", featured: "2026-10-28", context: null, standing: "hidden", reason: "source-gone", explanation: "the article it is about is no longer published" },
    { id: ID(3), post: "posts/tides.md", featured: "2026-10-28", context: null, standing: "covered" },
  ];
  const off = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([], { state: new URL(route.request().url()).searchParams.get("state") })));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { checked: features.length, truncated: false, features }));
  await page.route(`${origin}/admin/api/engagement/community/unfeature`, async (route) => {
    const body = route.request().postDataJSON();
    off.push(body.id);
    features = features.filter((entry) => entry.id !== body.id);
    return json(route, 200, { featured: false, build: { ok: true } });
  });
  await signIn(page);
  for (const hash of ["pending", "approved", "withdrawn?kind=third-perspective"]) {
    await page.goto(`${origin}/admin/#/moderation/${hash}`);
    await expect(page.locator('[data-feature-notice="mustComeOff"]')).toContainText("1 featured reflection must come off its post");
    await expect(page.locator('[data-feature-notice="hidden"]')).toContainText("hidden because the article it is about is not published now");
  }
  await expect(page.locator('[data-feature-notice="mustComeOff"]')).toContainText("the reader no longer agrees to have it featured");
  // No notice counts or ranks anything beyond what must be done.
  await expect(page.locator("[data-feature-banner]")).not.toContainText(/popular|rank|vote|score/i);
  const button = page.locator('[data-feature-notice="mustComeOff"]').getByRole("button", { name: "Take the feature off" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toContainText("The feature was taken off its post.");
  expect(off).toEqual([ID(1)]);
  await expect(page.locator('[data-feature-notice="mustComeOff"]')).toHaveCount(0);
  await expect(page.locator('[data-feature-notice="hidden"]')).toBeVisible();
});

// ---- Rollback and a hosted service that cannot be asked

test("when Third Perspectives are rolled back the banner says it could not check, the feature can still come off, and choosing is refused", async ({ page }) => {
  let features = [{ id: ID(1), post: "posts/tides.md", featured: "2026-10-28", context: null, standing: "unknown" }];
  const off = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([reflection(2)])));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features }));
  await page.route(`${origin}/admin/api/engagement/community/feature`, (route) => json(route, 409, { error: "Third Perspectives are switched off or rolled back on the hosted service, so the reader's consent cannot be checked", code: "rolledBack" }));
  await page.route(`${origin}/admin/api/engagement/community/unfeature`, async (route) => {
    off.push(route.request().postDataJSON().id);
    features = [];
    return json(route, 200, { featured: false, build: { ok: true } });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
  const notice = page.locator('[data-feature-notice="unknown"]');
  await expect(notice).toContainText("cannot be checked against the hosted copy");
  const section = page.locator(`[data-moderation-id="${ID(2)}"] [data-feature-section]`);
  await section.getByRole("button", { name: "Feature on the post" }).click();
  await expect(section.getByRole("status")).toContainText("rolled back on the hosted service");
  await expect(section.getByRole("button", { name: "Feature on the post" })).toBeEnabled();
  // Removing is always safe, without the hosted service.
  await notice.getByRole("button", { name: "Take the feature off" }).click();
  await expect(queueStatus(page)).toContainText("The feature was taken off its post.");
  expect(off).toEqual([ID(1)]);
});

test("an audit that fails says features could not be checked, except for a 403", async ({ page }) => {
  let status = 502;
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([])));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, status, { error: "The hosted service could not be asked" }));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
  await expect(page.locator("[data-feature-banner]")).toContainText("Featured reflections could not be checked against the hosted copy.");
  status = 403;
  await page.reload();
  await expect(page.locator("[data-feature-banner]")).toHaveText("");
});

// ---- Mixed prompts

test("reflections of different prompts are each featured on their own, from their own card", async ({ page }) => {
  const kinds = [[1, "connection"], [2, "question"], [3, null]];
  let features = [];
  const chosen = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(kinds.map(([n, category]) => reflection(n, { details: category ? { category } : {} })))));
  await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features }));
  await page.route(`${origin}/admin/api/engagement/community/feature`, async (route) => {
    const body = route.request().postDataJSON();
    chosen.push(body.id);
    features = [...features, { id: body.id, post: "posts/tides.md", featured: "2026-10-28", context: null, standing: "covered" }];
    return json(route, 200, { featured: true, build: { ok: true } });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
  for (const [n] of kinds) await expect(page.locator(`[data-moderation-id="${ID(n)}"] [data-feature-section]`).getByRole("button", { name: "Feature on the post" })).toBeVisible();
  await page.locator(`[data-moderation-id="${ID(2)}"] [data-feature-section]`).getByRole("button", { name: "Feature on the post" }).click();
  await expect(queueStatus(page)).toContainText("Featured in the post’s Community perspectives section.");
  expect(chosen).toEqual([ID(2)]);
  for (const n of [1, 3]) await expect(page.locator(`[data-moderation-id="${ID(n)}"] [data-feature-section]`).getByRole("button", { name: "Feature on the post" })).toBeVisible();
  await expect(page.locator(`[data-moderation-id="${ID(2)}"] [data-feature-section]`).getByRole("button", { name: "Feature on the post" })).toHaveCount(0);
});

// ---- Reflow

test("the reader's choice and the editor's section reflow at 320px and 400% zoom", async ({ browser }) => {
  for (const viewport of [{ width: 320, height: 800 }, { width: 1280 / 4, height: 800 / 4 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.route(`${ENDPOINT}/**`, (route) => route.abort());
    await page.goto(`${origin}/tides/`);
    await page.waitForFunction(() => customElements.get("ob-third-perspective") !== undefined);
    const form = await overflowOf(page, "#ob-third-perspective");
    expect(form.overflow, `${viewport.width}px form: ${form.offenders.join(", ")}`).toBeLessThanOrEqual(1);
    expect(form.offenders, `${viewport.width}px form`).toEqual([]);
    await signIn(page);
    await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([reflection(1, { body: "x".repeat(300) })])));
    await page.route(`${origin}/admin/api/engagement/community/features`, (route) => json(route, 200, { truncated: false, features: [{ id: ID(4), post: "posts/a-very-long-post-name-that-goes-on-and-on.md", featured: "2026-10-28", context: null, standing: "mustComeOff", explanation: "the reader no longer agrees to have it featured" }] }));
    await page.route(`${origin}/admin/api/engagement/community/preview`, (route) => json(route, 200, { ...PREVIEW, preview: { ...PREVIEW.preview, response: { ...PREVIEW.preview.response, body: "unbroken".repeat(40) } } }));
    await page.goto(`${origin}/admin/#/moderation/approved?kind=third-perspective`);
    const section = page.locator(`[data-moderation-id="${ID(1)}"] [data-feature-section]`);
    await section.getByRole("button", { name: "Preview" }).click();
    await expect(section.locator("[data-feature-preview] blockquote")).toBeVisible();
    const wide = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll("[data-feature-section], [data-feature-section] *, [data-feature-banner], [data-feature-banner] *")]
        .filter((element) => element.getBoundingClientRect().right > width + 1)
        .map((element) => element.className || element.tagName);
    });
    expect(wide, `${viewport.width}px editor`).toEqual([]);
    for (const control of await page.locator("[data-feature-section] button, [data-feature-section] textarea, [data-feature-banner] button").all()) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    await context.close();
  }
});
