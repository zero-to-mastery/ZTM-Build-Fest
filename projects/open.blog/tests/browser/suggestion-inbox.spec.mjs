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

// Suggestions for future work in the editors' inbox (#227, ADRs 0152 to 0157). The hosted inbox is
// mocked at the Admin API (the real Admin keeps the hosted token, resolves each item's actor and
// sends only what that actor may see); everything else is the real Admin. Covers a suggestion read as
// the reader's own unchecked statements with hostile text kept as text, its link left for the editor
// to open, accepting and declining from the keyboard with words that never speak of publication, the
// private contact shown only where the server sent it, possible duplicates pointed out without a
// number, the explicit copy into a private research note, conflicts and refusals, and 320px and 400%
// zoom without horizontal scrolling.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const ENDPOINT = "https://inbox.example/api";
const HOSTILE = "<img src=x onerror=alert(1)>";
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-suggestion-inbox-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({
    title: "Inbox",
    url: "https://inbox-site.example.org",
    postPath: "/{slug}/",
    author: { name: "A" },
    engagement: { enabled: true, comments: false, analytics: false, endpoint: ENDPOINT, receipts: true },
    participation: { kinds: { "future-suggestion": "open" } },
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

const DECLINE = [{ id: "off-topic", label: "Off topic" }, { id: "duplicate", label: "Duplicate" }, { id: "other", label: "Other" }];
const CLARIFY = [{ id: "unclear", label: "Unclear" }, { id: "needs-source", label: "Needs a source" }];
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOTICE = "Accepted means the editors are interested in exploring this. It does not mean they agree with it, have checked it, or have permission to use it.";
const approve = { action: "approve", label: "Approve", reasons: [], guidance: "Accepts it into the editors’ private list and publishes nothing. It means only that you are interested in exploring it, not that you agree with it, have checked it or may use it." };
const reject = { action: "reject", label: "Reject", reasons: DECLINE, guidance: "Never shown. Its text is due to be purged 30 days after this decision." };
const clarify = { action: "request-clarification", label: "Ask to clarify", reasons: CLARIFY, guidance: "Asks the reader, through their private receipt, to revise it; nothing is e-mailed." };

/** A suggestion as the Admin server describes it to the signed-in account. */
function suggestion(n, extra = {}, details = {}) {
  return {
    id: ID(n),
    source: "feedback",
    kind: "future-suggestion",
    kindLabel: "Suggestion for future work",
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
    published: false,
    clarification: { askedAboutThisText: false, consent: true },
    body: `Her letters from the 1850 survey would help. ${HOSTILE}`,
    details: {},
    reader: { name: "Private Person", publishName: false },
    suggestion: {
      type: "text",
      typeLabel: "Text to read",
      url: "https://example.org/letters",
      hints: { title: `The survey letters ${HOSTILE}`, creators: [], year: "c. 1850", publisher: null, identifiers: [{ scheme: "doi", value: "10.1234/abc" }] },
      about: { series: "tides" },
      missing: ["a creator"],
      notice: NOTICE,
      standing: { id: "received", label: "Received" },
      received: "2026-10-26",
      contact: "ada@example.org",
      export: null,
      ...details,
    },
    actions: [approve, clarify, reject],
    ...extra,
  };
}

const page_ = (items, extra = {}) => ({ state: "pending", kind: "future-suggestion", protocol: "protected", items, invalid: 0, next: null, ...extra });
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const queueStatus = (page) => page.locator(".oba-feedback-section").first().locator('p[role="status"]').first();

test("an editor reads a suggestion as the reader's own words and accepts it from the keyboard, with nothing published", async ({ page }) => {
  let items = [suggestion(1), suggestion(2, { reader: { publishName: false }, suggestion: undefined, body: "A question." }, {})];
  items[1] = suggestion(2, { reader: { publishName: true, name: "Grace" } }, { type: "audio", typeLabel: "Audio to hear", url: null, hints: { title: null, creators: [], year: null, publisher: null, identifiers: [] }, about: null, missing: ["a link or identifier", "a title", "a creator"], contact: null });
  items[0].similar = [{ id: ID(2), source: "feedback", kindLabel: "Suggestion for future work", receivedAt: "2026-10-26T10:00:00Z", reason: "the same source" }];
  const changes = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await page.route(`${origin}/admin/api/engagement/moderation`, async (route) => {
    expect(route.request().method()).toBe("PATCH");
    const body = route.request().postDataJSON();
    changes.push(body);
    items = items.filter((item) => item.id !== body.id);
    return json(route, 200, { item: { id: body.id, status: "approved" }, published: false, publishError: null });
  });
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation?kind=future-suggestion`);
  await expect(page.getByRole("heading", { name: "Moderation queue", level: 2 })).toBeVisible();
  await expect(queueStatus(page)).toHaveText("2 pending items.");
  await expect(page.getByLabel("Kind", { exact: true })).toHaveValue("future-suggestion");

  const card = page.locator(`[data-moderation-id="${ID(1)}"]`);
  await expect(card.getByRole("heading", { name: "Suggestion for future work on “Tides”", level: 3 })).toBeVisible();
  await expect(card.getByRole("heading", { name: "The reader’s suggestion", level: 4 })).toBeVisible();
  await expect(card.getByText(`Her letters from the 1850 survey would help. ${HOSTILE}`)).toBeVisible();
  await expect(card.locator("img")).toHaveCount(0);
  // Every statement about the source is the reader's, and nothing is called checked.
  await expect(card.getByText("Kind: Text to read.")).toBeVisible();
  await expect(card.getByText(`Title (the reader’s words): The survey letters ${HOSTILE}`)).toBeVisible();
  await expect(card.getByText("DOI (not checked): 10.1234/abc")).toBeVisible();
  await expect(card.getByText("About the series: tides")).toBeVisible();
  await expect(card.getByText("Still to find: a creator.")).toBeVisible();
  const link = card.getByRole("link", { name: "https://example.org/letters" });
  await expect(link).toHaveAttribute("href", "https://example.org/letters");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(card).toContainText("nothing fetched it for you");
  // The contact the server sent, with what happens to it.
  await expect(card.getByText("Contact the reader agreed to: ada@example.org.", { exact: false })).toBeVisible();
  await expect(card).toContainText("this site never e-mails it");
  await expect(card.getByText("The name stays private: the reader has not agreed to be credited by it for this text.", { exact: false })).toBeVisible();
  await expect(card.getByText(NOTICE)).toBeVisible();
  // No count, rank or vote anywhere.
  const text = await card.innerText();
  for (const word of ["votes", "rank", "popular", "most requested"]) expect(text.toLowerCase()).not.toContain(word);
  // A duplicate is pointed out as a cue, with a link that moves focus, and no number.
  await expect(card.getByText("Possibly about the same thing")).toBeVisible();
  await card.getByRole("link", { name: /Suggestion for future work received/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Suggestion for future work on “Tides”", level: 3 }).nth(1)).toBeFocused();
  // The second card shows the name the reader agreed to be credited by for this text, and no contact.
  const second = page.locator(`[data-moderation-id="${ID(2)}"]`);
  await expect(second.getByText("From Grace, who agreed to be credited by this name for this text", { exact: false })).toBeVisible();
  await expect(second.getByText("Contact the reader agreed to")).toHaveCount(0);
  await expect(second.getByText("Still to find: a link or identifier, a title, a creator.")).toBeVisible();

  // Accepting is its own decision, with guidance that says nothing is published.
  const accept = card.getByRole("button", { name: "Approve", exact: true });
  await expect(accept).toHaveAccessibleDescription(/publishes nothing/);
  await accept.focus();
  await page.keyboard.press("Enter");
  await expect(queueStatus(page)).toContainText("Accepted into the editors’ list. Nothing was published or e-mailed.");
  await expect(queueStatus(page)).toContainText("not that you agree with it, have checked it or may use it");
  await expect(queueStatus(page)).toBeFocused();
  expect(changes).toEqual([{ source: "feedback", id: ID(1), action: "approve", from: "pending", version: 3 }]);
  expect(dialogs).toEqual([]);
});

test("declining needs a reason and is worded as not taken forward, never as a verdict", async ({ page }) => {
  let items = [suggestion(3)];
  const changes = [];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await page.route(`${origin}/admin/api/engagement/moderation`, async (route) => {
    changes.push(route.request().postDataJSON());
    items = [];
    return json(route, 200, { item: { id: ID(3), status: "rejected" }, published: false, publishError: null });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation?kind=future-suggestion`);
  const card = page.locator(`[data-moderation-id="${ID(3)}"]`);
  await card.getByRole("button", { name: "Reject", exact: true }).focus();
  await page.keyboard.press("Enter");
  const why = card.getByLabel("Reason to reject");
  await expect(why).toBeFocused();
  await expect(card.locator('p[role="status"]')).toHaveText("Choose a reason first.");
  await why.selectOption("off-topic");
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(queueStatus(page)).toHaveText("Not taken forward. Nothing was published or e-mailed.");
  expect(changes).toEqual([{ source: "feedback", id: ID(3), action: "reject", from: "pending", version: 3, reason: "off-topic" }]);
});

test("a coordinator sees the suggestion but never the contact or the private name, and no export", async ({ page }) => {
  const items = [suggestion(4, { role: "coordinator", reader: { publishName: false, private: true } }, { contact: null, export: null })];
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation?kind=future-suggestion`);
  const card = page.locator(`[data-moderation-id="${ID(4)}"]`);
  await expect(card.getByText("You moderate this as a coordinator", { exact: false })).toBeVisible();
  await expect(card.getByText("The reader gave a name that only the site Admin can see.")).toBeVisible();
  const text = await card.innerText();
  expect(text).not.toContain("ada@example.org");
  expect(text).not.toContain("Private Person");
  await expect(card.getByText("Contact the reader agreed to")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Copy into a private research note" })).toHaveCount(0);
});

test("an accepted suggestion is copied into a private research note only when the author asks, and a conflict says so", async ({ page }) => {
  const accepted = suggestion(5, {
    status: "approved", statusLabel: "Approved", version: 4, moderatedAt: "2026-10-27T10:00:00Z",
    actions: [{ action: "remove", label: "Close it", reasons: DECLINE, guidance: "Closes it with this reason. It was never shown." }],
  }, {
    standing: { id: "interested", label: "Editors are interested" },
    export: { label: "Copy into a private research note", guidance: "Starts a note in your private research notebook from this suggestion, labelled as unverified reader text with where it came from. It copies no name, no contact and no time, fetches nothing, publishes nothing and changes nothing about the suggestion." },
  });
  const exports = [];
  let answer = { status: 201, body: { ok: true, note: { id: "suggestion-00000000" }, revision: "r1", item: null } };
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([accepted], { state: "approved" })));
  await page.route(`${origin}/admin/api/engagement/suggestions/export`, async (route) => {
    exports.push(route.request().postDataJSON());
    return json(route, answer.status, answer.body);
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=future-suggestion`);
  const card = page.locator(`[data-moderation-id="${ID(5)}"]`);
  await expect(card.getByText("Stands as: Editors are interested.")).toBeVisible();
  await expect(card).not.toContainText("Published on the post");
  await expect(card.getByRole("button", { name: /Publish on the post|Take it off/ })).toHaveCount(0);
  const button = card.getByRole("button", { name: "Copy into a private research note" });
  await expect(button).toHaveAccessibleDescription(/copies no name, no contact and no time, fetches nothing, publishes nothing/);
  expect(exports).toEqual([]);
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(card.locator('p[role="status"]:not([data-continuation-form] p)')).toContainText("A private research note was made (suggestion-00000000). Nothing was published, fetched or e-mailed, and the suggestion is unchanged.");
  expect(exports).toEqual([{ id: ID(5), version: 4 }]);
  // A refusal says why and keeps the card.
  answer = { status: 422, body: { error: "The id suggestion-00000000 is already used by a note.", code: "invalid" } };
  await button.click();
  await expect(card.locator('p[role="status"]:not([data-continuation-form] p)')).toContainText("already used");
  await expect(card).toBeVisible();
});

const KINDS = [
  { id: "draft", label: "A draft (its slug)" },
  { id: "series", label: "A series (its slug)" },
  { id: "library-source", label: "A Source Library record (its id)" },
];
const LINK_OFFER = {
  kinds: KINDS,
  full: false,
  guidance: "Records that you made, or are making, something from this suggestion: the slug of a draft or series, or the id of a source you added to your library. It creates, fetches and publishes nothing, and tells the reader only that it is linked to future work. The reader’s contact and unpublished name are cleared the next time you run retention.",
};
const CANDIDATE = {
  label: "Show hints for a Source Library record",
  guidance: "Shows the link and details the reader gave, marked unverified, to copy into a source record you make yourself. Nothing is written to your library, fetched or published, and rights stay your own declaration.",
  type: "text", url: "https://example.org/letters", title: "The survey letters", creators: ["A. Surveyor"], year: "c. 1850", publisher: null,
  identifiers: [{ scheme: "doi", value: "10.1234/abc" }], unverified: true,
};
const acceptedCard = (n, details = {}, extra = {}) => suggestion(n, {
  status: "approved", statusLabel: "Approved", version: 4, moderatedAt: "2026-10-27T10:00:00Z",
  actions: [{ action: "remove", label: "Close it", reasons: DECLINE, guidance: "Closes it with this reason. It was never shown." }],
  ...extra,
}, {
  standing: { id: "interested", label: "Editors are interested" },
  outcome: { id: "held", label: "Held" },
  conversions: [],
  link: LINK_OFFER,
  libraryCandidate: CANDIDATE,
  ...details,
});

test("an author records a link to future work from the keyboard, and the outcome and link are shown as theirs", async ({ page }) => {
  let card = acceptedCard(7);
  const sent = [];
  let answer = { status: 200, body: { ok: true, item: null, published: false } };
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([card], { state: "approved" })));
  await page.route(`${origin}/admin/api/engagement/suggestions/link`, async (route) => {
    sent.push(route.request().postDataJSON());
    if (answer.status === 200) {
      card = acceptedCard(7, {
        standing: { id: "converted", label: "Linked to future work" },
        outcome: { id: "converted", label: "Converted" },
        conversions: [{ kind: "draft", kindLabel: "A draft (its slug)", id: "tide-tables", at: "2026-10-28T10:00:00Z", by: "writer" }],
      }, { version: 5 });
    }
    return json(route, answer.status, answer.body);
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=future-suggestion`);
  const item = page.locator(`[data-moderation-id="${ID(7)}"]`);
  await expect(item.getByText("Outcome: Held.")).toBeVisible();
  await expect(item.getByText("Stands as: Editors are interested.")).toBeVisible();
  const form = item.locator("[data-link-form]");
  await expect(form.getByRole("heading", { name: "Link to future work" })).toBeVisible();
  const kind = form.getByLabel("What you made", { exact: true });
  const target = form.getByLabel("Its slug or id", { exact: true });
  await expect(kind).toHaveAccessibleDescription(/creates, fetches and publishes nothing/);
  await expect(target).toHaveAccessibleDescription(/reader’s contact and unpublished name are cleared the next time you run retention/);
  // Nothing is sent until the author says so, and an incomplete form says what is missing and where.
  expect(sent).toEqual([]);
  await form.getByRole("button", { name: "Record this link" }).click();
  await expect(item.locator('p[role="status"]:not([data-continuation-form] p)')).toContainText("Choose what you made from this suggestion.");
  await expect(kind).toBeFocused();
  await kind.selectOption({ label: "A draft (its slug)" });
  await form.getByRole("button", { name: "Record this link" }).click();
  await expect(item.locator('p[role="status"]:not([data-continuation-form] p)')).toContainText("Name it:");
  await expect(target).toBeFocused();
  expect(sent).toEqual([]);
  // From the keyboard.
  await target.fill("tide-tables");
  await target.press("Enter");
  await expect(queueStatus(page)).toContainText("The link was recorded. Nothing was created, published or sent");
  expect(sent).toEqual([{ id: ID(7), version: 4, conversion: { kind: "draft", id: "tide-tables" } }]);
  // The reloaded card shows the outcome and the link as the author's own record, never opened.
  await expect(item.getByText("Outcome: Converted.")).toBeVisible();
  await expect(item.getByText("Linked to the draft tide-tables, recorded 2026-10-28 by writer. Nothing opened or checked it.")).toBeVisible();
  await expect(item.getByText("Stands as: Linked to future work.")).toBeVisible();
  await expect(item).not.toContainText("Published on the post");
  expect(await item.innerText()).not.toMatch(/\b(rank|score|votes?|popular|most requested|trending)\b/i);
  // A duplicate and a conflict each say what happened.
  answer = { status: 422, body: { error: "The suggestion is already linked to that.", code: "alreadyLinked" } };
  await item.locator("[data-link-form]").getByLabel("What you made", { exact: true }).selectOption({ label: "A draft (its slug)" });
  await item.locator("[data-link-form]").getByLabel("Its slug or id", { exact: true }).fill("tide-tables");
  await item.locator("[data-link-form]").getByRole("button", { name: "Record this link" }).click();
  await expect(item.locator('p[role="status"]:not([data-continuation-form] p)').first()).toContainText("It is already linked to that.");
  answer = { status: 409, body: { error: "This item changed since you loaded it. Review it again before acting.", code: "conflict", item: null } };
  await item.locator("[data-link-form]").getByRole("button", { name: "Record this link" }).click();
  await expect(queueStatus(page)).toContainText("This item changed since you loaded it");
});

test("the library hints are offered only to copy by hand, marked unverified, and a full list or an unaccepted suggestion offers no link", async ({ page }) => {
  const full = acceptedCard(8, { link: { ...LINK_OFFER, full: true } });
  const pending = suggestion(9);
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([full, pending], { state: "approved" })));
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=future-suggestion`);
  const item = page.locator(`[data-moderation-id="${ID(8)}"]`);
  const details = item.locator("[data-library-candidate]");
  await expect(details.locator("summary")).toHaveText("Show hints for a Source Library record");
  await expect(details.locator("summary")).toHaveAccessibleDescription(/Nothing is written to your library, fetched or published/);
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(details.getByText("Unverified: these are the reader’s own words about a source", { exact: false })).toBeVisible();
  await expect(details.getByText("Title: The survey letters")).toBeVisible();
  await expect(details.getByText("DOI: 10.1234/abc")).toBeVisible();
  await expect(details.getByText("Private Person")).toHaveCount(0);
  await expect(details.getByText("ada@example.org")).toHaveCount(0);
  // The list is full: the control stays, disabled, and says why.
  await expect(item.getByRole("button", { name: "Record this link" })).toBeDisabled();
  await expect(item.getByText("It is linked as many times as it can be.")).toBeVisible();
  // Nothing was fetched on the author's behalf: no request left the admin origin or reached the link.
  expect(requests.filter((url) => url.includes("example.org"))).toEqual([]);
  // An unaccepted suggestion offers neither (the server sends neither).
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([pending], { state: "pending" })));
  await page.goto(`${origin}/admin/#/moderation?kind=future-suggestion`);
  const waiting = page.locator(`[data-moderation-id="${ID(9)}"]`);
  await expect(waiting.getByText("Kind: Text to read.")).toBeVisible();
  await expect(waiting.locator("[data-link-form], [data-library-candidate]")).toHaveCount(0);
});

for (const [name, viewport, zoom] of [["320px", { width: 320, height: 900 }, 1], ["400% zoom", { width: 1280, height: 800 }, 4]]) {
  test(`at ${name} the link form, the links and the library hints reflow without scrolling sideways`, async ({ browser }) => {
    const size = zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom };
    const context = await browser.newContext({ viewport: size, reducedMotion: "reduce" });
    const page = await context.newPage();
    const long = "x".repeat(400);
    const card = acceptedCard(10, {
      standing: { id: "converted", label: "Linked to future work" },
      outcome: { id: "converted", label: "Converted" },
      conversions: [
        { kind: "draft", kindLabel: "A draft (its slug)", id: "d".repeat(64), at: "2026-10-28T10:00:00Z", by: "w".repeat(64) },
        { kind: "library-source", kindLabel: "A Source Library record (its id)", id: "s".repeat(64), at: "2026-10-29T10:00:00Z", by: "w".repeat(64) },
      ],
      libraryCandidate: { ...CANDIDATE, url: `https://example.org/${"a".repeat(300)}`, title: long, creators: [long], publisher: long, identifiers: [{ scheme: "doi", value: `10.1234/${long}` }] },
    });
    await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([card], { state: "approved" })));
    await signIn(page);
    await page.goto(`${origin}/admin/#/moderation/approved?kind=future-suggestion`);
    const item = page.locator(`[data-moderation-id="${ID(10)}"]`);
    await expect(item.getByText("Outcome: Converted.")).toBeVisible();
    await item.locator("[data-library-candidate] summary").click();
    await expect(item.getByText("Title: ", { exact: false })).toBeVisible();
    const wide = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      return [...document.querySelectorAll(".oba-moderation-item, .oba-moderation-item *")]
        .filter((element) => element.getBoundingClientRect().right > limit + 1)
        .map((element) => element.className || element.tagName);
    });
    expect(wide).toEqual([]);
    expect(await item.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    for (const control of await item.locator("[data-link-form] select, [data-link-form] input, [data-link-form] button, [data-library-candidate] summary").all()) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
    }
    await context.close();
  });
}

for (const [name, viewport, zoom] of [["320px", { width: 320, height: 900 }, 1], ["400% zoom", { width: 1280, height: 800 }, 4]]) {
  test(`at ${name} a suggestion's card reflows without scrolling sideways`, async ({ browser }) => {
    const size = zoom === 1 ? viewport : { width: viewport.width / zoom, height: viewport.height / zoom };
    const context = await browser.newContext({ viewport: size, reducedMotion: "reduce" });
    const page = await context.newPage();
    const long = "x".repeat(400);
    const items = [suggestion(6, { body: long }, {
      url: `https://example.org/${"a".repeat(300)}`,
      hints: { title: long, creators: [long], year: null, publisher: long, identifiers: [{ scheme: "doi", value: `10.1234/${long}` }] },
      export: { label: "Copy into a private research note", guidance: "Starts a note." },
      contact: `${"a".repeat(60)}@${"b".repeat(60)}.example.org`,
    })];
    await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_(items)));
    await signIn(page);
    await page.goto(`${origin}/admin/#/moderation?kind=future-suggestion`);
    await expect(queueStatus(page)).toHaveText("1 pending item.");
    const card = page.locator(`[data-moderation-id="${ID(6)}"]`);
    await expect(card.getByText("Kind: Text to read.")).toBeVisible();
    const width = size.width;
    const wide = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      return [...document.querySelectorAll(".oba-moderation-item, .oba-moderation-item *")]
        .filter((element) => element.getBoundingClientRect().right > limit + 1)
        .map((element) => element.className || element.tagName);
    });
    expect(wide).toEqual([]);
    expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    for (const control of await card.locator("button, select, input, a").all()) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    await context.close();
  });
}

const CREDIT = { name: "Ada", line: "The reader agreed to be credited as Ada for this text. Nothing credits them unless you do." };

test("the reader's credit shows only in the link view, for the text they agreed it for, and goes when their consent or text changes", async ({ page }) => {
  // The reader agreed to be credited for this text; the author sees it beside the link form and nowhere else.
  let card = acceptedCard(9, { link: { ...LINK_OFFER, credit: CREDIT } }, { reader: { name: "Ada", publishName: true } });
  await page.route(`${origin}/admin/api/engagement/moderation?**`, (route) => json(route, 200, page_([card], { state: "approved" })));
  await page.route(`${origin}/admin/api/engagement/suggestions/link`, async (route) => {
    // Meanwhile the reader withdrew (or changed the text of) what they agreed to: the next list has no credit.
    card = acceptedCard(9, { link: { ...LINK_OFFER, credit: null }, conversions: [{ kind: "draft", kindLabel: "A draft (its slug)", id: "tide-tables", at: "2026-10-28T10:00:00Z", by: "writer" }] }, { version: 5, reader: { name: "Ada", publishName: false } });
    return json(route, 200, { ok: true, item: null, published: false });
  });
  await signIn(page);
  await page.goto(`${origin}/admin/#/moderation/approved?kind=future-suggestion`);
  const item = page.locator(`[data-moderation-id="${ID(9)}"]`);
  const form = item.locator("[data-link-form]");
  await expect(form.locator("[data-suggestion-credit]")).toHaveText(CREDIT.line);
  await expect(item.locator("[data-suggestion-credit]")).toHaveCount(1);
  // The reader line says only that it is shown with the link form, and offers nothing to publish it.
  await expect(item.getByText("who agreed to be credited by this name for this text. That is shown with the link form.")).toBeVisible();
  await expect(item.getByRole("button", { name: /credit|thank|publish/i })).toHaveCount(0);
  // Nothing was sent by looking at it.
  await form.getByLabel("What you made", { exact: true }).selectOption({ label: "A draft (its slug)" });
  await form.getByLabel("Its slug or id", { exact: true }).fill("tide-tables");
  await form.getByRole("button", { name: "Record this link" }).click();
  await expect(queueStatus(page)).toContainText("The link was recorded.");
  // With the agreement gone, the line is gone and the name stays private.
  await expect(item.locator("[data-suggestion-credit]")).toHaveCount(0);
  await expect(item.getByText("The name stays private: the reader has not agreed to be credited by it for this text.")).toBeVisible();
});
