// The real provider adapters behind the real delivery worker (epic #353, story #358, ADRs 0316 to
// 0321): createWorker runs with socialAdapters() over a scripted provider fetch, so every provider
// answer is followed from the HTTP reply to the stored row, attempt and summary. Supabase is the
// in-memory fake of social-queue-fakes.mjs. No network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { socialAdapters } from "../../netlify/lib/social-adapters.mjs";
import { ACCESS, FACEBOOK, FUTURE, LINKEDIN, SERVICE_KEY, workerSetup } from "./social-queue-fakes.mjs";
import { networkFailure, providers, scripted } from "./social-publish-fakes.mjs";

const MIN = 60_000;
const URN = "urn:li:share:7123456789012345678";
const FB_PAGE = "1234567890";
const FB_ID = `${FB_PAGE}_555`;
const FB_TOKEN = `fb_${ACCESS}`;
const PROVIDER_TEXT = "PROVIDER-SAID-THIS";

// A worker whose adapters are the real ones, configured from `env` overrides, over a scripted provider.
async function setup(reply, { env, accounts = [LINKEDIN, FACEBOOK] } = {}) {
  const s = await workerSetup({ accounts, policyEnv: { OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  const provider = scripted(reply);
  const adapters = socialAdapters({ providers: providers(env), fetchImpl: provider.fetchImpl, now: s.now });
  return { ...s, provider, adapters, worker: s.build({ adapters }) };
}

const providerCalls = (s, path) => s.provider.calls.filter((c) => c.url.includes(path));

test("a 201 from LinkedIn and a 200 from Facebook publish with the provider's own ids", async () => {
  const s = await setup((n, url) => (url.endsWith("/rest/posts") ? { status: 201, headers: { "x-restli-id": URN } } : { status: 200, body: { id: FB_ID } }));
  const li = s.addPost({ body: "LinkedIn caption" });
  const fb = s.addPost({ account_id: FACEBOOK, body: "Facebook caption" });
  const summary = await s.worker.run();
  assert.equal(summary.published, 2);
  assert.deepEqual([li.status, li.provider_post_id], ["published", URN]);
  assert.deepEqual([fb.status, fb.provider_post_id], ["published", FB_ID]);
  const [liCall] = providerCalls(s, "/rest/posts");
  assert.equal(liCall.headers.authorization, `Bearer ${ACCESS}`);
  assert.equal(JSON.parse(liCall.body).author, "urn:li:person:abc");
  const [fbCall] = providerCalls(s, "/feed");
  assert.equal(fbCall.url, `https://graph.facebook.com/v23.0/${FB_PAGE}/feed`);
  assert.equal(fbCall.headers.authorization, `Bearer ${FB_TOKEN}`);
  assert.ok(liCall.signal instanceof AbortSignal && fbCall.signal instanceof AbortSignal, "the worker's timeout bounds every call");
  await s.worker.run();
  assert.equal(s.provider.calls.length, 2, "a published announcement is never sent again");
});

test("a 401 fails the announcement as a refused credential, without a retry, and the account needs reconnecting", async () => {
  const s = await setup({ status: 401, body: { message: `${PROVIDER_TEXT} ${ACCESS}` } });
  const post = s.addPost();
  await s.worker.run();
  assert.deepEqual([post.status, post.last_error_code, post.next_attempt_at], ["failed", "needs-reauth", null]);
  assert.equal(s.attempts[0].http_status, 401);
  assert.equal(s.accounts.find((a) => a.id === LINKEDIN).status, "needs-reauth");
  assert.equal(s.accounts.find((a) => a.id === FACEBOOK).status, "connected", "only the refused account");
  s.advance(86400_000);
  await s.worker.run();
  assert.equal(s.provider.calls.length, 1);
});

test("a 403 is a final refusal", async () => {
  const s = await setup({ status: 403, body: { error: { code: 200, message: PROVIDER_TEXT } } });
  const post = s.addPost({ account_id: FACEBOOK });
  await s.worker.run();
  assert.deepEqual([post.status, post.last_error_code], ["failed", "provider-rejected"]);
  assert.equal(s.attempts[0].http_status, 403);
});

test("a 429 with Retry-After is retried no sooner than the provider asked, and pauses the account", async () => {
  const s = await setup({ status: 429, headers: { "retry-after": "600" } });
  const post = s.addPost();
  const summary = await s.worker.run();
  assert.equal(summary.retried, 1);
  assert.deepEqual([post.status, post.last_error_code], ["scheduled", "rate-limited"]);
  assert.equal(Date.parse(post.next_attempt_at) - s.now(), 10 * MIN);
  assert.ok(Date.parse(s.accounts.find((a) => a.id === LINKEDIN).paused_until) - s.now() >= 10 * MIN);
});

test("a 5xx may have posted: unknown, and LinkedIn, which cannot be looked up, goes to a person and is never re-sent", async () => {
  const s = await setup({ status: 503 });
  const post = s.addPost();
  const summary = await s.worker.run();
  assert.equal(summary.unknown, 1);
  assert.deepEqual([post.status, post.last_error_code], ["unknown", "timeout"]);
  s.advance(10 * MIN);
  await s.worker.run();
  assert.equal(post.status, "unknown");
  assert.equal(post.last_error_code, "needs-review");
  assert.equal(post.next_attempt_at, null);
  s.advance(86400_000);
  await s.worker.run();
  assert.equal(s.provider.calls.length, 1, "never sent a second time");
});

test("a timeout, an abort and a dropped connection are unknown; a refused connection is retried", async () => {
  for (const kind of ["timeout", "abort", "reset"]) {
    const s = await setup(networkFailure(kind, ACCESS));
    const post = s.addPost();
    await s.worker.run();
    assert.deepEqual([post.status, post.last_error_code], ["unknown", "timeout"], kind);
  }
  const s = await setup(networkFailure("refused", ACCESS));
  const post = s.addPost();
  const summary = await s.worker.run();
  assert.equal(summary.retried, 1);
  assert.deepEqual([post.status, post.last_error_code], ["scheduled", "provider-unavailable"]);
});

test("an ambiguous 2xx without a post id is unknown, never published", async () => {
  for (const [account, reply] of [[LINKEDIN, { status: 201 }], [FACEBOOK, { status: 200, body: { success: true } }], [FACEBOOK, { status: 200, body: { id: "42_1" } }]]) {
    const s = await setup(reply);
    const post = s.addPost({ account_id: account });
    await s.worker.run();
    assert.equal(post.status, "unknown", JSON.stringify(reply));
    assert.equal(post.provider_post_id ?? null, null);
  }
});

test("a Graph code 190 moves the Facebook Page to needs-reauth", async () => {
  const s = await setup({ status: 400, body: { error: { code: 190, message: PROVIDER_TEXT } } });
  const post = s.addPost({ account_id: FACEBOOK });
  await s.worker.run();
  assert.deepEqual([post.status, post.last_error_code], ["failed", "needs-reauth"]);
  assert.equal(s.accounts.find((a) => a.id === FACEBOOK).status, "needs-reauth");
});

const pagePost = (id, message, link) => ({ id, message, created_time: "2026-11-01T12:00:01+0000", attachments: { data: [{ unshimmed_url: link }] } });

test("an unknown Facebook outcome is looked up read-only and settled when the post is found", async () => {
  const s = await setup((n, url) => (url.includes("/published_posts") ? { status: 200, body: { data: [pagePost(FB_ID, "Hello Page", "https://blog.example.org/posts/p1/")] } } : { status: 500, body: { error: { code: 1 } } }));
  const post = s.addPost({ account_id: FACEBOOK, body: "Hello Page" });
  await s.worker.run();
  assert.equal(post.status, "unknown");
  s.advance(6 * MIN);
  const summary = await s.worker.run();
  assert.equal(summary.reconciled.published, 1);
  assert.deepEqual([post.status, post.provider_post_id], ["published", FB_ID]);
  assert.equal(providerCalls(s, "/feed").length, 1, "the post was sent once");
  assert.equal(providerCalls(s, "/published_posts")[0].method, "GET");
  const window = new URL(providerCalls(s, "/published_posts")[0].url).searchParams;
  assert.ok(Number(window.get("until")) > Number(window.get("since")), "the look is bounded to the attempt");
});

test("a sibling announcement's post with the same caption and link is not taken twice: it goes to a person", async () => {
  // The sibling is published first as FB_ID; the second announcement of the same post is unknown.
  const s = await setup((n, url) => {
    if (url.includes("/published_posts")) return { status: 200, body: { data: [pagePost(FB_ID, "Hello Page", "https://blog.example.org/posts/same/")] } };
    return n === 1 ? { status: 200, body: { id: FB_ID } } : { status: 500, body: { error: { code: 1 } } };
  });
  // The later-added post is scheduled earlier, so it is sent first.
  const post = s.addPost({ account_id: FACEBOOK, body: "Hello Page", canonical_url: "https://blog.example.org/posts/same/" });
  const sibling = s.addPost({ account_id: FACEBOOK, body: "Hello Page", canonical_url: "https://blog.example.org/posts/same/" });
  await s.worker.run();
  assert.deepEqual([sibling.status, post.status], ["published", "unknown"]);
  s.advance(6 * MIN);
  await s.worker.run();
  assert.deepEqual([post.status, post.last_error_code, post.next_attempt_at, post.provider_post_id], ["unknown", "needs-review", null, null]);
  s.advance(86400_000);
  await s.worker.run();
  assert.equal(providerCalls(s, "/published_posts").length, 1, "not looked up again every run");
});

test("a link shared by hand on the Page is never taken for the announcement", async () => {
  const s = await setup((n, url) => (url.includes("/published_posts") ? { status: 200, body: { data: [pagePost(`${FB_PAGE}_777`, "Look what I wrote", "https://blog.example.org/posts/p1/")] } } : { status: 500, body: { error: { code: 1 } } }));
  const post = s.addPost({ account_id: FACEBOOK, body: "Hello Page" });
  await s.worker.run();
  s.advance(6 * MIN);
  await s.worker.run();
  assert.equal(post.status, "unknown");
  assert.equal(post.provider_post_id, null);
});

test("a provider this release does not support fails explicitly with no provider call", async () => {
  const s = await setup({ status: 201, headers: { "x-restli-id": URN } }, { accounts: [LINKEDIN, FUTURE] });
  const post = s.addPost({ account_id: FUTURE });
  await s.worker.run();
  assert.deepEqual([post.status, post.last_error_code], ["failed", "unsupported-provider"]);
  assert.equal(s.provider.calls.length, 0);
});

test("a provider named like an Object member is not mistaken for an adapter", async () => {
  const s = await setup({ status: 201, headers: { "x-restli-id": URN } }, { accounts: [LINKEDIN, FUTURE] });
  s.accounts.find((a) => a.id === FUTURE).provider = "constructor";
  const post = s.addPost({ account_id: FUTURE });
  await s.worker.run();
  assert.deepEqual([post.status, post.last_error_code], ["failed", "unsupported-provider"]);
  assert.equal(s.provider.calls.length, 0);
});

test("nothing is registered when no provider is configured, so announcements wait untouched", async () => {
  const none = { OPENBLOG_SOCIAL_LINKEDIN_CLIENT_ID: undefined, OPENBLOG_SOCIAL_LINKEDIN_CLIENT_SECRET: undefined, OPENBLOG_SOCIAL_FACEBOOK_CLIENT_ID: undefined, OPENBLOG_SOCIAL_FACEBOOK_CLIENT_SECRET: undefined };
  const s = await setup({ status: 201, headers: { "x-restli-id": URN } }, { env: none });
  assert.deepEqual(Object.keys(s.adapters), []);
  const li = s.addPost();
  const fb = s.addPost({ account_id: FACEBOOK });
  const summary = await s.worker.run();
  assert.equal(summary.claimed, 0);
  assert.deepEqual([li.status, li.attempt_count, fb.status, fb.attempt_count], ["scheduled", 0, "scheduled", 0]);
  assert.equal(s.provider.calls.length, 0);
});

test("no token, key or provider text reaches a stored error, a summary or a log", async () => {
  const replies = [
    { status: 401, body: { message: `${PROVIDER_TEXT} ${ACCESS}` } },
    { status: 403, body: { error: { code: 200, message: `${PROVIDER_TEXT} ${FB_TOKEN}`, fbtrace_id: "TRACE-1" } } },
    { status: 429, headers: { "retry-after": "60" }, body: PROVIDER_TEXT },
    { status: 500, body: { message: PROVIDER_TEXT } },
    { status: 200, body: `<html>${PROVIDER_TEXT}</html>` },
    networkFailure("reset", `${ACCESS} ${FB_TOKEN}`),
    networkFailure("timeout", ACCESS),
    networkFailure("refused", ACCESS),
  ];
  const seen = [];
  const originals = {};
  for (const name of ["log", "warn", "error", "info", "debug"]) {
    originals[name] = console[name];
    console[name] = (...args) => seen.push(args.map(String).join(" "));
  }
  try {
    for (const reply of replies) {
      const s = await setup(reply);
      s.addPost();
      s.addPost({ account_id: FACEBOOK });
      const summary = await s.worker.run();
      s.advance(10 * MIN);
      const later = await s.worker.run();
      const stored = JSON.stringify({ summary, later, posts: s.posts, attempts: s.attempts, calls: s.calls.map((c) => c.body) });
      for (const secret of [ACCESS, FB_TOKEN, SERVICE_KEY, PROVIDER_TEXT, "TRACE-1"]) assert.equal(stored.includes(secret), false, `${secret.slice(0, 8)} in ${JSON.stringify(reply.status ?? reply.name)}`);
    }
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(seen, []);
});
