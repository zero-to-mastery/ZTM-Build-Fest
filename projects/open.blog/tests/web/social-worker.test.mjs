// Optional social publishing, the delivery worker (epic #353, story #357, ADR 0317): a due
// announcement is delivered once through its provider's adapter, never twice, and nothing secret is
// shown to an adapter, a summary or an error. The provider is a fake adapter; Supabase is the
// in-memory fake of social-queue-fakes.mjs. No network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../../netlify/lib/social-worker.mjs";
import { socialSettings } from "../../netlify/lib/social-scope.mjs";
import { ACCESS, ADMIN_KEY, FACEBOOK, FUTURE, GONE, LINKEDIN, REAUTH, SERVICE_KEY, SITE, WORKER_KEY, fakeAdapter, workerSetup as setup } from "./social-queue-fakes.mjs";

const LINKED = () => fakeAdapter("linkedin");

test("a due announcement is delivered once and recorded with the provider's id", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost({ body: "Read the new post." });
  const summary = await s.worker.run();
  assert.equal(summary.claimed, 1);
  assert.equal(summary.published, 1);
  assert.equal(adapter.published.length, 1);
  assert.equal(post.status, "published");
  assert.equal(post.provider_post_id, "urn:fake:linkedin:1");
  assert.ok(post.published_at);
  assert.equal(post.claimed_by, null);
  assert.equal(s.attempts[0].outcome, "published");
  assert.equal(s.attempts[0].provider_post_id, "urn:fake:linkedin:1");
  assert.equal(s.attempts[0].provider_request_id, "req-1");
  assert.ok(s.attempts[0].sending_at, "the sending mark came before the call");
  const second = await s.worker.run();
  assert.equal(second.claimed, 0);
  assert.equal(adapter.published.length, 1, "a published announcement is never sent again");
});

test("an adapter is given the announcement and a token, and nothing else of ours", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter } });
  s.addPost({ body: "Caption", canonical_url: "https://blog.example.org/posts/x/", work: "/posts/x/" });
  await s.worker.run();
  const [call] = adapter.published;
  assert.deepEqual(Object.keys(call).sort(), ["accessToken", "account", "post", "signal"]);
  assert.equal(call.accessToken, ACCESS);
  assert.deepEqual(call.post, { id: call.post.id, idempotencyKey: call.post.idempotencyKey, caption: "Caption", canonicalUrl: "https://blog.example.org/posts/x/", work: "/posts/x/" });
  assert.deepEqual(call.account, { provider: "linkedin", kind: "member", externalId: "urn:li:person:abc", displayName: "Mikey Nichols" });
  assert.match(call.post.idempotencyKey, /^idem-key-/);
  assert.ok(call.signal instanceof AbortSignal);
  const everything = JSON.stringify({ ...call, signal: null });
  for (const secret of [SERVICE_KEY, ADMIN_KEY, WORKER_KEY]) assert.equal(everything.includes(secret), false);
});

test("a summary, a row and an attempt never hold a token or a key", async () => {
  const adapter = fakeAdapter("linkedin", {
    publish: () => {
      throw new Error(`failed with ${ACCESS} and ${SERVICE_KEY}`);
    },
  });
  const s = await setup({ adapters: { linkedin: adapter } });
  s.addPost();
  const summary = await s.worker.run();
  const seen = JSON.stringify({ summary, posts: s.posts, attempts: s.attempts, calls: s.calls.map((c) => c.body) });
  for (const secret of [ACCESS, SERVICE_KEY, ADMIN_KEY, WORKER_KEY]) assert.equal(seen.includes(secret), false, secret.slice(0, 6));
});

test("two workers at once deliver each announcement exactly once", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, policyEnv: { OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  for (let i = 0; i < 5; i += 1) s.addPost();
  const other = s.build();
  const [a, b] = await Promise.all([s.worker.run(), other.run()]);
  assert.equal(a.claimed + b.claimed, 5, "each claimed a different share");
  const ids = adapter.published.map((call) => call.post.id);
  assert.equal(new Set(ids).size, ids.length, "no announcement was sent twice");
  const all = adapter.published.map((call) => call.post.id);
  assert.equal(new Set(all).size, 5);
  assert.equal(all.length, 5);
});

test("a provider with no adapter yet waits; a provider this release does not know fails explicitly", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, accounts: [LINKEDIN, FACEBOOK, FUTURE] });
  const waiting = s.addPost({ account_id: FACEBOOK });
  const unknown = s.addPost({ account_id: FUTURE });
  const summary = await s.worker.run();
  assert.equal(waiting.status, "scheduled", "facebook has no adapter in this deployment: it waits, untouched");
  assert.equal(waiting.attempt_count, 0);
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.last_error_code, "unsupported-provider");
  assert.equal(summary.failed, 1);
  assert.equal(adapter.published.length, 0);
});

test("a destination that is not connected fails explicitly and the provider is not called", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, accounts: [LINKEDIN, REAUTH, GONE], policyEnv: { OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  const reauth = s.addPost({ account_id: REAUTH });
  const gone = s.addPost({ account_id: GONE });
  await s.worker.run();
  assert.equal(reauth.status, "failed");
  assert.equal(reauth.last_error_code, "needs-reauth");
  assert.equal(gone.status, "failed");
  assert.equal(gone.last_error_code, "account-not-connected");
  assert.equal(adapter.published.length, 0);
});

test("an account whose credential is gone fails with needs-reauth and is not retried", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, accounts: [] });
  const post = s.addPost();
  await s.worker.run();
  assert.equal(post.status, "failed");
  assert.equal(post.last_error_code, "needs-reauth");
  assert.equal(adapter.published.length, 0);
});

test("a result without the provider's own post id is not a success", async () => {
  for (const result of [undefined, {}, { providerPostId: "" }, { providerPostId: "has space" }, { providerPostId: "x".repeat(301) }]) {
    const adapter = fakeAdapter("linkedin", { publish: () => result });
    const s = await setup({ adapters: { linkedin: adapter } });
    const post = s.addPost();
    await s.worker.run();
    assert.equal(post.status, "unknown", JSON.stringify(result));
    assert.equal(post.provider_post_id, null);
    assert.equal(adapter.published.length, 1);
  }
});

test("a worker that lost its lease before sending does not call the provider", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  const stale = s.build({
    credentials: {
      accessToken: async () => {
        s.advance(301_000);
        return ACCESS;
      },
    },
  });
  const summary = await stale.run();
  assert.equal(summary.lost, 1);
  assert.equal(adapter.published.length, 0);
  assert.equal(post.status, "claimed", "the reaper, not this worker, decides what happens to it");
});

test("success that cannot be recorded is never sent again: it becomes unknown", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, storage: { failRpc: (name) => name === "openblog_social_settle" } });
  const post = s.addPost();
  const summary = await s.worker.run();
  assert.equal(summary.published, 1);
  assert.equal(summary.unrecorded, 1);
  assert.equal(post.status, "claimed");
  s.advance(301_000);
  const next = await s.worker.run();
  assert.equal(adapter.published.length, 1, "the lease ran out after sending: unknown, not retried");
  assert.equal(next.claimed, 0);
  assert.equal(post.status, "unknown");
});

test("a confirmed success that arrives after the lease ran out is still recorded", async () => {
  const adapter = fakeAdapter("linkedin", {
    publish: () => {
      s.advance(301_000);
      s.reap(SITE, 5);
      return { providerPostId: "urn:fake:late" };
    },
  });
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  const summary = await s.worker.run();
  assert.equal(summary.lost, 0);
  assert.equal(post.status, "published");
  assert.equal(post.provider_post_id, "urn:fake:late");
  assert.equal(s.attempts[0].outcome, "published");
});

test("work that does not fit the time budget is deferred without using an attempt", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, policyEnv: { OPENBLOG_SOCIAL_PROVIDER_TIMEOUT_SECONDS: "8" } });
  const post = s.addPost();
  const summary = await s.worker.run({ budgetMs: 5000 });
  assert.equal(summary.deferred, 1);
  assert.equal(adapter.published.length, 0);
  assert.equal(post.status, "scheduled");
  assert.equal(post.attempt_floor, 1, "the attempt is given back");
  assert.equal((await s.worker.run()).published, 1, "the next run delivers it");
});

test("a batch is bounded by the policy", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, policyEnv: { OPENBLOG_SOCIAL_BATCH_SIZE: "2", OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  for (let i = 0; i < 5; i += 1) s.addPost();
  assert.equal((await s.worker.run()).claimed, 2);
  assert.equal(adapter.published.length, 2);
});

test("the queue being down is an error for the caller, with nothing delivered", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter }, storage: { failRpc: () => true } });
  s.addPost();
  await assert.rejects(s.worker.run(), (error) => error.code === "storage-failed" && !String(error.message).includes(SERVICE_KEY));
  assert.equal(adapter.published.length, 0);
});

test("the worker does not exist unless social publishing is enabled", () => {
  assert.throws(() => createWorker({ settings: socialSettings({}) }), (e) => e.status === 404);
  assert.equal(SITE, "lantern-studios");
});

test("a run claims only as many announcements as its budget can finish", async () => {
  const adapter = LINKED();
  const s = await setup({ adapters: { linkedin: adapter } });
  for (let i = 0; i < 5; i += 1) s.addPost();
  const summary = await s.worker.run();
  assert.equal(summary.claimed, 1, "the 8 second default budget fits one 4 second call and its margin");
  assert.equal(summary.published, 1);
  assert.equal(summary.deferred, 0);
});
