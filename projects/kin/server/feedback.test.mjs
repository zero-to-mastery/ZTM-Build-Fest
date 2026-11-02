// Problem reports and suggestions on the service (#636, #637, ADR 0021 §3):
// storage, routes, limits, retention and purge, the admin command, and
// forwarding to GitHub against a fake GitHub API (the real one is never
// called).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { FEEDBACK_LIMITS, FEEDBACK_RETENTION_MS, FeedbackService, issueFor, statusFromIssue } from "./feedback-service.mjs";
import { GitHubIssues, parseGitHubConfig } from "./feedback-github.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { newReference } from "../web/feedback/format.js";

const NETWORK_TEST = { timeout: 30_000 };
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff3f0005fe02fea7d6a4560000000049454e44ae426082", "hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1), Buffer.from([0xff, 0xd9])]);

function household(store = null, { now = () => Date.now() } = {}) {
  const pairing = new PairingService({ store, now });
  const sync = new EncryptedSyncService(pairing, { store, now });
  sync.liveService = { eventsAccepted() {}, revalidate() {} };
  const admin = pairing.bootstrap({ credential: credential(`founder-${Math.random()}`) });
  const admit = (options) => {
    const invitation = pairing.createPairing(admin.sessionToken, options);
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`m-${Math.random()}`), deviceLabel: "Phone" });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const adult = admit({ kind: "adult" });
  const child = admit({ kind: "limited" });
  const auth = (who) => pairing.authorize(who.sessionToken);
  return { pairing, sync, admin, adult, child, auth };
}

const problem = (overrides = {}) => ({
  kind: "problem",
  reference: newReference("problem"),
  text: { happened: "The list froze after I added milk.", expected: "It should save." },
  diagnostics: {
    version: "1.5.0", build: "abc123", browser: "Chrome", browserVersion: 131, os: "Android", deviceType: "phone",
    page: "lists", segment: "shopping", online: true, syncState: "ready", lastSyncAt: 1_800_000_000_000,
    recent: [{ t: 1_800_000_000_000, code: "sync_failed", fields: { reason: "connection_unavailable", status: 0 } }],
  },
  ...overrides,
});
const suggestion = (overrides = {}) => ({
  kind: "suggestion", reference: newReference("suggestion"), text: { wish: "A pantry list", why: "We run out of rice." },
  diagnostics: { version: "1.5.0", browser: "Chrome" }, ...overrides,
});
const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(null));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(store); } finally { store.close(); }
  });
}

bothStores("a signed-in report is stored with only the diagnostics the table allows", (store) => {
  const h = household(store);
  const feedback = new FeedbackService({ store, log: () => {} });
  const sent = problem({ diagnostics: { ...problem().diagnostics, householdId: h.admin.householdId, page: "Groceries for Sam",
    recent: [{ t: 1, code: "sync_failed", fields: { reason: "Sam's secret list", status: 503, note: "free text" } }, { t: 2, code: "made_up" }] } });
  const result = feedback.submit({ auth: h.auth(h.adult), body: sent, clientKey: "203.0.113.1" });
  assert.deepEqual(result, { reference: sent.reference, status: "received", duplicate: false });
  const shown = feedback.show(sent.reference);
  assert.equal(shown.memberId, h.adult.memberId);
  assert.equal(shown.householdId, h.admin.householdId);
  assert.equal(shown.report.diagnostics.householdId, undefined, "unknown diagnostics are dropped");
  assert.equal(shown.report.diagnostics.page, undefined, "a page outside the route list is dropped");
  assert.deepEqual(shown.report.diagnostics.recent, [{ t: 1, code: "sync_failed", fields: { reason: "other", status: 503 } }],
    "ring entries keep registry codes and fields only; free text becomes \"other\"");
  assert.ok(!JSON.stringify(shown.report).includes("secret"));
  // The outbox sending the same report again gets the same answer.
  assert.deepEqual(feedback.submit({ auth: h.auth(h.adult), body: sent, clientKey: "203.0.113.1" }),
    { reference: sent.reference, status: "received", duplicate: true });
  // The same reference from someone else, or with other content, is refused.
  assert.throws(() => feedback.submit({ auth: h.auth(h.admin), body: sent }), rejects("feedback_reference_taken", 409));
  assert.throws(() => feedback.submit({ auth: null, body: sent }), rejects("feedback_reference_taken", 409));
  assert.throws(() => feedback.submit({ auth: h.auth(h.adult), body: { ...sent, text: { happened: "other" } } }), rejects("feedback_reference_taken", 409));
  // What I've sent lists a member's own only.
  assert.deepEqual(feedback.mine(h.auth(h.adult)).items.map((item) => [item.reference, item.status, item.title]),
    [[sent.reference, "received", "The list froze after I added milk."]]);
  assert.deepEqual(feedback.mine(h.auth(h.admin)).items, []);
});

bothStores("reports are refused when malformed, too large, or with a bad screenshot", (store) => {
  const h = household(store);
  const feedback = new FeedbackService({ store, log: () => {} });
  const auth = h.auth(h.adult);
  for (const body of [null, [], { kind: "problem" }, problem({ reference: "KR-0000" }), problem({ kind: "suggestion" }),
    problem({ text: { happened: 42 } }), suggestion({ text: { why: "no wish" } })])
    assert.throws(() => feedback.submit({ auth, body }), (error) => error instanceof PairingError && error.status === 400, JSON.stringify(body));
  assert.throws(() => feedback.submit({ auth, body: problem({ text: { happened: "x".repeat(4001) } }) }), rejects("feedback_too_large", 413));
  feedback.submit({ auth, body: problem({ text: { happened: "x".repeat(4000), expected: "y".repeat(4000) } }) });
  assert.throws(() => feedback.submit({ auth, body: problem({ text: { happened: "中".repeat(4000), expected: "文".repeat(4000) } }) }),
    rejects("feedback_too_large", 413), "the stored body is at most 16 KiB");
  const screenshot = (type, bytes) => problem({ screenshot: { type, data: bytes.toString("base64") } });
  for (const body of [screenshot("image/png", JPEG), screenshot("image/jpeg", PNG), screenshot("image/gif", PNG),
    screenshot("image/png", Buffer.from("not an image at all")), screenshot("image/png", Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(1024 * 1024)])),
    problem({ screenshot: { type: "image/png", data: "%%%" } })])
    assert.throws(() => feedback.submit({ auth, body }), rejects("feedback_screenshot_invalid", 400));
  assert.throws(() => feedback.submit({ auth: h.auth(h.admin), body: suggestion({ screenshot: { type: "image/png", data: PNG.toString("base64") } }) }),
    rejects("feedback_invalid", 400), "a suggestion has no screenshot");
  // A PNG and a JPEG are accepted, typed by their bytes, and kept apart.
  const png = screenshot("image/png", PNG);
  feedback.submit({ auth, body: png });
  assert.deepEqual(feedback.storage.feedbackScreenshot(png.reference), { type: "image/png", bytes: PNG });
  const jpeg = screenshot("image/jpeg", JPEG);
  feedback.submit({ auth, body: jpeg });
  assert.equal(feedback.storage.feedbackScreenshot(jpeg.reference).type, "image/jpeg");
  assert.equal(feedback.show(png.reference).hasScreenshot, true);
  assert.equal(JSON.stringify(feedback.show(png.reference)).includes(PNG.toString("base64")), false, "show() never carries the image");
});

bothStores("suggestions come from household admins only, and rates are limited per member and address", (store) => {
  let now = 1_900_000_000_000;
  const h = household(store, { now: () => now });
  // Sessions last hours; these limits are checked over a day and more.
  const auths = new Map([h.admin, h.adult, h.child].map((who) => [who, h.auth(who)]));
  h.auth = (who) => auths.get(who);
  const feedback = new FeedbackService({ store, now: () => now, log: () => {} });
  assert.throws(() => feedback.submit({ auth: h.auth(h.adult), body: suggestion() }), rejects("feedback_admin_only", 403));
  assert.throws(() => feedback.submit({ auth: h.auth(h.child), body: suggestion() }), rejects("feedback_admin_only", 403));
  assert.throws(() => feedback.submit({ auth: null, body: suggestion() }), rejects("authentication_required", 401));
  for (let i = 0; i < FEEDBACK_LIMITS.suggestionsPerMemberHour; i++) feedback.submit({ auth: h.auth(h.admin), body: suggestion(), clientKey: "a" });
  assert.throws(() => feedback.submit({ auth: h.auth(h.admin), body: suggestion(), clientKey: "a" }), rejects("feedback_rate_limited", 429));
  // Reports are counted apart from suggestions.
  for (let i = 0; i < FEEDBACK_LIMITS.problemsPerMemberHour; i++) feedback.submit({ auth: h.auth(h.admin), body: problem(), clientKey: "a" });
  assert.throws(() => feedback.submit({ auth: h.auth(h.admin), body: problem(), clientKey: "a" }), rejects("feedback_rate_limited", 429));
  // Another member on the same address still may, until the address's day is full.
  now += 61 * 60_000;
  let sent = 8;
  const members = [h.admin, h.adult, h.child];
  for (let i = 0; sent < FEEDBACK_LIMITS.perAddressDay; i++) {
    if (i % 5 === 0 && i) now += 61 * 60_000;
    feedback.submit({ auth: h.auth(members[i % 3]), body: problem(), clientKey: "a" });
    sent += 1;
  }
  assert.throws(() => feedback.submit({ auth: h.auth(h.adult), body: problem(), clientKey: "a" }), rejects("feedback_rate_limited", 429));
  feedback.submit({ auth: h.auth(h.adult), body: problem(), clientKey: "b" });
  now += 25 * 60 * 60_000;
  feedback.submit({ auth: h.auth(h.adult), body: problem(), clientKey: "a" });
});

bothStores("reports without signing in have tighter address limits and no member link", (store) => {
  let now = 1_900_000_000_000;
  const feedback = new FeedbackService({ store, now: () => now, log: () => {} });
  const first = problem();
  feedback.submit({ auth: null, body: first, clientKey: "c" });
  assert.equal(feedback.show(first.reference).memberId, null);
  assert.equal(feedback.show(first.reference).householdId, null);
  feedback.submit({ auth: null, body: problem(), clientKey: "c" });
  assert.throws(() => feedback.assertAnonymousAllowed("c"), rejects("feedback_rate_limited", 429), "refused before the body is read");
  assert.throws(() => feedback.submit({ auth: null, body: problem(), clientKey: "c" }), rejects("feedback_rate_limited", 429));
  for (let hour = 0; hour < 2; hour++) {
    now += 61 * 60_000;
    feedback.submit({ auth: null, body: problem(), clientKey: "c" });
  }
  now += 61 * 60_000;
  feedback.submit({ auth: null, body: problem(), clientKey: "c" });
  now += 61 * 60_000;
  assert.throws(() => feedback.submit({ auth: null, body: problem(), clientKey: "c" }), rejects("feedback_rate_limited", 429),
    `at most ${FEEDBACK_LIMITS.anonymousPerAddressDay} a day from one address`);
});

bothStores("retention purges after 180 days; removal and household deletion purge at once", (store) => {
  let now = 1_900_000_000_000;
  const h = household(store, { now: () => now });
  const feedback = new FeedbackService({ store, now: () => now, log: () => {} });
  h.sync.feedbackService = feedback;
  h.pairing.onMemberRemoved = (_householdId, memberId) => feedback.forgetMember(memberId);
  // A member's removal purges theirs at once.
  const adults = problem();
  feedback.submit({ auth: h.auth(h.adult), body: adults, clientKey: "a" });
  h.pairing.removeOtherAdult(h.admin.sessionToken, h.adult.memberId, h.admin.memberId);
  assert.equal(feedback.show(adults.reference), null);
  const admin = h.auth(h.admin);
  const old = problem({ screenshot: { type: "image/png", data: PNG.toString("base64") } });
  feedback.submit({ auth: admin, body: old, clientKey: "a" });
  now += FEEDBACK_RETENTION_MS - 1000;
  const recent = problem();
  feedback.submit({ auth: admin, body: recent, clientKey: "a" });
  now += 2000;
  assert.equal(feedback.purgeExpired(), 1);
  assert.equal(feedback.show(old.reference), null);
  assert.equal(feedback.storage.feedbackScreenshot(old.reference), null, "its screenshot goes with it");
  assert.ok(feedback.show(recent.reference));
  // The household's deletion purges the rest.
  if (store) {
    assert.equal(store.householdPurgeStatus(h.admin.householdId).counts.feedback, 1);
    store.forcePurgeHousehold(h.admin.householdId, now);
    assert.equal(store.householdPurgeStatus(h.admin.householdId).purged, true);
    assert.equal(store.validate(), true);
  } else feedback.forgetHousehold(h.admin.householdId);
  assert.equal(feedback.show(recent.reference), null);
});

test("statuses follow GitHub: completed is done, not planned is won't do, the planned label is planned", () => {
  assert.equal(statusFromIssue({ state: "closed", stateReason: "completed", labels: [] }), "done");
  assert.equal(statusFromIssue({ state: "closed", stateReason: "not_planned", labels: [] }), "wont_do");
  assert.equal(statusFromIssue({ state: "closed", stateReason: null, labels: [] }), "done");
  assert.equal(statusFromIssue({ state: "open", stateReason: null, labels: ["from-app", "planned"] }), "planned");
  assert.equal(statusFromIssue({ state: "open", stateReason: "reopened", labels: ["from-app"] }), "received");
});

test("the forwarded issue carries the title, typed text, diagnostics and reference, never IDs, usernames or the screenshot", () => {
  const sent = problem({ text: { happened: "It broke ```js\nalert(1)\n``` @mnichols08 | pipe", expected: "" } });
  const issue = issueFor({ ...sent, text: { happened: sent.text.happened }, diagnostics: { ...sent.diagnostics } });
  assert.ok(issue.title.startsWith(`[${sent.reference}] It broke`));
  assert.deepEqual(issue.labels, ["from-app", "bug"]);
  assert.match(issue.body, /\*\*Reference:\*\* KR-/);
  assert.match(issue.body, /````text\nIt broke ```js/, "typed text sits in a fence longer than any it contains");
  assert.match(issue.body, /\| Browser \| Chrome \|/);
  assert.match(issue.body, /sync_failed reason=connection_unavailable status=0/);
  assert.deepEqual(issueFor(suggestion()).labels, ["from-app", "enhancement"]);
});

test("the GitHub configuration is both settings or neither, and https", () => {
  assert.equal(parseGitHubConfig({}), null);
  assert.throws(() => parseGitHubConfig({ repo: "owner/name" }), /both/);
  assert.throws(() => parseGitHubConfig({ token: "t" }), /both/);
  assert.throws(() => parseGitHubConfig({ repo: "not a repo", token: "t" }), /owner\/name/);
  assert.throws(() => parseGitHubConfig({ repo: "o/n", token: "t", api: "http://example.com" }), /https/);
  assert.equal(parseGitHubConfig({ repo: "o/n", token: "t" }).api, "https://api.github.com");
  assert.equal(parseGitHubConfig({ repo: "o/n", token: "t", api: "http://127.0.0.1:9/" }).api, "http://127.0.0.1:9");
});

/** A fake GitHub API: issues in memory, and switches for failures. */
async function fakeGitHub(t) {
  const state = { issues: [], requests: [], failNext: [], private: true, loseCreateResponse: false };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const url = new URL(request.url, "http://localhost");
    state.requests.push({ method: request.method, path: url.pathname, search: url.search, authorization: request.headers.authorization, body });
    const send = (status, value, headers = {}) => { response.writeHead(status, { "Content-Type": "application/json", ...headers }); response.end(JSON.stringify(value)); };
    const failure = state.failNext.shift();
    if (failure) return send(failure.status, { message: "fail" }, failure.headers ?? {});
    if (request.method === "GET" && url.pathname === "/repos/kin/reports") return send(200, { private: state.private });
    if (request.method === "POST" && url.pathname === "/repos/kin/reports/issues") {
      const issue = { number: state.issues.length + 1, title: body.title, body: body.body, labels: body.labels.map((name) => ({ name })), state: "open", state_reason: null };
      state.issues.push(issue);
      if (state.loseCreateResponse) { state.loseCreateResponse = false; request.socket.destroy(); return; }
      return send(201, { number: issue.number });
    }
    if (request.method === "GET" && url.pathname === "/repos/kin/reports/issues") {
      const label = url.searchParams.get("labels");
      return send(200, state.issues.filter((issue) => issue.labels.some((entry) => entry.name === label)));
    }
    const match = /^\/repos\/kin\/reports\/issues\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && match) {
      const issue = state.issues[Number(match[1]) - 1];
      return issue ? send(200, issue) : send(404, { message: "Not Found" });
    }
    send(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, api: `http://127.0.0.1:${server.address().port}` };
}

const noSleep = () => Promise.resolve();

test("forwarding opens one labelled issue per report, retries with backoff, and stays idempotent by reference", NETWORK_TEST, async (t) => {
  const github = await fakeGitHub(t);
  let now = 1_900_000_000_000;
  const store = new DurableStore(":memory:");
  t.after(() => store.close());
  const h = household(store, { now: () => now });
  const config = parseGitHubConfig({ repo: "kin/reports", token: "secret-token", api: github.api });
  const feedback = new FeedbackService({ store, github: new GitHubIssues(config, { sleep: noSleep, now: () => now }), now: () => now, log: () => {} });
  assert.deepEqual(await feedback.channel(), { forwarding: true, trackerPublic: false });
  // A rate limit is waited out within the call.
  github.state.failNext.push({ status: 429, headers: { "retry-after": "1" } });
  const sent = problem({ screenshot: { type: "image/png", data: PNG.toString("base64") } });
  feedback.submit({ auth: h.auth(h.adult), body: sent, clientKey: "a" });
  await feedback.forwardDue();
  assert.equal(github.state.issues.length, 1);
  // A server error is retried later, with backoff, looking the reference up first.
  github.state.failNext.push({ status: 502 });
  const early = problem();
  feedback.submit({ auth: h.auth(h.adult), body: early, clientKey: "a" });
  await feedback.forwardDue();
  assert.equal(feedback.show(early.reference).forwardState, "pending");
  now = feedback.show(early.reference).forwardNextAt;
  await feedback.forwardDue();
  assert.equal(feedback.show(early.reference).githubIssue, 2);
  github.state.issues.pop();
  store.updateFeedback(early.reference, { githubIssue: null, forwardState: "off" });
  const issue = github.state.issues[0];
  assert.deepEqual(issue.labels.map((label) => label.name), ["from-app", "bug"]);
  assert.ok(issue.title.includes(sent.reference));
  for (const secret of [h.admin.householdId, h.adult.memberId, h.adult.deviceId, PNG.toString("base64"), "screenshot\":"])
    assert.ok(!issue.body.includes(secret) && !issue.title.includes(secret), `never forwarded: ${secret}`);
  assert.ok(github.state.requests.every((request) => request.authorization === "Bearer secret-token"));
  assert.equal(feedback.show(sent.reference).forwardState, "forwarded");
  assert.equal(feedback.show(sent.reference).githubIssue, 1);
  // Forwarding again does nothing.
  await feedback.forwardDue();
  assert.equal(github.state.issues.length, 1);

  // The issue is opened but the answer is lost: the next attempt finds it.
  github.state.loseCreateResponse = true;
  const second = suggestion();
  feedback.submit({ auth: h.auth(h.admin), body: second, clientKey: "a" });
  await feedback.forwardDue();
  assert.equal(github.state.issues.length, 2);
  const pending = feedback.show(second.reference);
  assert.equal(pending.forwardState, "pending");
  assert.ok(pending.forwardNextAt > now, "retried later, with backoff");
  now = pending.forwardNextAt;
  await feedback.forwardDue();
  assert.equal(github.state.issues.length, 2, "no second issue for the same reference");
  assert.equal(feedback.show(second.reference).githubIssue, 2);
  assert.deepEqual(github.state.issues[1].labels.map((label) => label.name), ["from-app", "enhancement"]);

  // A refusal (bad token, say) gives up and leaves it for the admin command.
  const third = problem();
  github.state.failNext.push({ status: 401 });
  feedback.submit({ auth: h.auth(h.admin), body: third, clientKey: "a" });
  await feedback.forwardDue();
  assert.equal(feedback.show(third.reference).forwardState, "failed");

  // Status follows the issue; one set by the operator holds until it changes.
  now += 60 * 60_000;
  github.state.issues[0].labels.push({ name: "planned" });
  assert.equal(await feedback.pollStatuses(), 1);
  assert.equal(feedback.show(sent.reference).status, "planned");
  assert.equal(feedback.mine(h.auth(h.adult)).items.find((item) => item.reference === sent.reference).status, "planned",
    "the sender's What I've sent shows it");
  feedback.setStatus(second.reference, "done");
  now += 60 * 60_000;
  assert.equal(await feedback.pollStatuses(), 0);
  assert.equal(feedback.show(second.reference).status, "done", "the operator's status holds while the issue is unchanged");
  Object.assign(github.state.issues[1], { state: "closed", state_reason: "not_planned" });
  Object.assign(github.state.issues[0], { state: "closed", state_reason: "completed" });
  now += 60 * 60_000;
  assert.equal(await feedback.pollStatuses(), 2);
  assert.equal(feedback.show(second.reference).status, "wont_do");
  assert.equal(feedback.show(sent.reference).status, "done");
});

test("the feedback routes: sign-in, limits before the body, the anonymous route and What I've sent", NETWORK_TEST, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1", feedbackGithub: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const admin = app.service.bootstrap({ credential: credential("admin") });
  const post = (path, body, cookie = null) => fetch(url + path, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) } });
  const session = `kin_session=${admin.sessionToken}; kin_device=${admin.deviceToken}`;
  assert.deepEqual(await (await fetch(`${url}/api/feedback/channel`)).json(), { forwarding: false, trackerPublic: null });
  assert.equal((await post("/api/feedback", problem())).status, 401);
  assert.equal((await fetch(`${url}/api/feedback/mine`)).status, 401);
  const report = problem();
  const accepted = await post("/api/feedback", report, session);
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), { reference: report.reference, status: "received" });
  assert.equal((await post("/api/feedback", report, session)).status, 200, "the outbox's repeat is answered, not stored twice");
  const idea = suggestion();
  assert.equal((await post("/api/feedback", idea, session)).status, 201);
  const mine = await (await fetch(`${url}/api/feedback/mine`, { headers: { cookie: session } })).json();
  assert.deepEqual(mine.items.map((item) => item.reference).sort(), [idea.reference, report.reference].sort());
  app.feedbackService.setStatus(idea.reference, "planned");
  const after = await (await fetch(`${url}/api/feedback/mine`, { headers: { cookie: session } })).json();
  assert.equal(after.items.find((item) => item.reference === idea.reference).status, "planned");
  // Without signing in: a report, never a suggestion, and tighter limits.
  assert.equal((await post("/api/feedback/anonymous", problem())).status, 201);
  assert.equal((await post("/api/feedback/anonymous", suggestion())).status, 401);
  assert.equal((await post("/api/feedback/anonymous", problem())).status, 201);
  const limited = await post("/api/feedback/anonymous", problem());
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "feedback_rate_limited");
  // A body past the bound is refused as it arrives.
  const huge = await fetch(`${url}/api/feedback`, { method: "POST", headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ ...problem(), padding: "x".repeat(2 * 1024 * 1024) }) });
  assert.equal(huge.status, 413);
});

function adminCli(databasePath, args, env = {}) {
  return spawnSync(process.execPath, [join(import.meta.dirname, "admin.mjs"), ...args], {
    env: { ...process.env, KIN_DATABASE_PATH: databasePath, NODE_NO_WARNINGS: "1", ...env }, encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
}

test("the admin command lists, shows, sets status, forwards and purges", NETWORK_TEST, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kin-feedback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath, { acquireProcessLock: false });
  const h = household(store);
  const feedback = new FeedbackService({ store, log: () => {} });
  const report = problem({ screenshot: { type: "image/png", data: PNG.toString("base64") } });
  const idea = suggestion();
  feedback.submit({ auth: h.auth(h.adult), body: report, clientKey: "a" });
  feedback.submit({ auth: h.auth(h.admin), body: idea, clientKey: "a" });
  store.close();

  const list = adminCli(databasePath, ["feedback-list", "--kind", "problem"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${report.reference}\\t.*\\tproblem\\treceived\\tmember\\tforward: off\\tscreenshot\\tThe list froze`));
  assert.doesNotMatch(list.stdout, new RegExp(idea.reference));
  const screenshotPath = join(directory, "shot.png");
  const show = adminCli(databasePath, ["feedback-show", report.reference, "--screenshot", screenshotPath]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /"happened": "The list froze after I added milk\."/);
  assert.deepEqual(readFileSync(screenshotPath), PNG);
  assert.equal(adminCli(databasePath, ["feedback-show", report.reference, "--screenshot", screenshotPath]).status, 1, "never overwrites a file");
  const set = adminCli(databasePath, ["feedback-set-status", idea.reference, "wont-do"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /is now Won't do/);
  assert.equal(adminCli(databasePath, ["feedback-set-status", idea.reference, "maybe"]).status, 1);
  assert.equal(adminCli(databasePath, ["feedback-forward", idea.reference]).status, 1, "forwarding needs the configuration");

  // Forwarding from the command, to the fake GitHub (spawned without
  // blocking, so this process can answer it).
  const github = await fakeGitHub(t);
  const forwarded = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "admin.mjs"), "feedback-forward", idea.reference], {
      env: { ...process.env, KIN_DATABASE_PATH: databasePath, NODE_NO_WARNINGS: "1", KIN_FEEDBACK_GITHUB_REPO: "kin/reports",
        KIN_FEEDBACK_GITHUB_TOKEN: "cli-token", KIN_FEEDBACK_GITHUB_API: github.api }, windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(forwarded.status, 0, forwarded.stderr);
  assert.match(forwarded.stdout, /is GitHub issue #1/);
  assert.deepEqual(github.state.issues[0].labels.map((label) => label.name), ["from-app", "enhancement"]);

  const purgeOne = adminCli(databasePath, ["feedback-purge", report.reference, "--confirm-reference", report.reference]);
  assert.equal(purgeOne.status, 0, purgeOne.stderr);
  assert.equal(adminCli(databasePath, ["feedback-purge", report.reference]).status, 1, "a single purge needs the confirmation");
  const purgeExpired = adminCli(databasePath, ["feedback-purge"]);
  assert.equal(purgeExpired.status, 0, purgeExpired.stderr);
  assert.match(purgeExpired.stdout, /Purged 0 report/);
  const reopened = new DurableStore(databasePath, { readonly: true });
  try {
    assert.equal(reopened.feedback(report.reference), null);
    assert.equal(reopened.feedbackScreenshot(report.reference), null);
    assert.equal(reopened.feedback(idea.reference).status, "wont_do");
  } finally { reopened.close(); }
});
