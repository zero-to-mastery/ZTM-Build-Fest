// Optional social publishing, the delivery queue (epic #353, story #357, ADR 0316): claiming due
// announcements under a lease, the attempt counter, the unknown-outcome rules and what a failure
// may reveal. Storage is an in-memory fake that follows supabase/social-queue.sql; the SQL itself
// is run against a real Postgres by social-queue-sql.test.mjs when one is supplied.
import test from "node:test";
import assert from "node:assert/strict";
import { createQueue, QueueError } from "../../netlify/lib/social-queue.mjs";
import { socialSettings } from "../../netlify/lib/social-scope.mjs";
import { FACEBOOK, LINKEDIN, REAUTH, SERVICE_KEY, SITE, env, queueStorage } from "./social-queue-fakes.mjs";

const T0 = Date.parse("2026-11-01T12:00:00Z");
const claimArgs = { limit: 5, leaseSeconds: 300, maxAttempts: 5, perAccount: 3 };

function setup(options = {}) {
  let clock = T0;
  const now = () => clock;
  const storage = queueStorage({ now, ...options });
  const queue = createQueue({ settings: socialSettings(env()), fetchImpl: storage.fetchImpl, now });
  return { ...storage, queue, now, advance: (ms) => (clock += ms) };
}

test("a claim takes due, scheduled work, leases it and opens an attempt", async () => {
  const s = setup();
  const due = s.addPost();
  s.addPost({ scheduled_for: new Date(T0 + 3600_000).toISOString() });
  s.addPost({ status: "canceled", canceled_at: new Date(T0).toISOString() });
  const claimed = await s.queue.claim(claimArgs);
  assert.deepEqual(claimed.map((row) => row.id), [due.id]);
  const [row] = claimed;
  assert.equal(row.status, "claimed");
  assert.equal(row.attempt_count, 1);
  assert.equal(row.version, 2);
  assert.equal(row.claimed_by, "@worker");
  assert.equal(Date.parse(row.lease_expires_at), T0 + 300_000);
  assert.equal(s.attempts.length, 1);
  assert.equal(s.attempts[0].attempt_no, 1);
  assert.equal(s.attempts[0].finished_at, null);
});

test("a second claim cannot take what is already leased", async () => {
  const s = setup();
  s.addPost();
  assert.equal((await s.queue.claim(claimArgs)).length, 1);
  assert.equal((await s.queue.claim(claimArgs)).length, 0);
  assert.equal(s.attempts.length, 1, "no second attempt row");
});

test("a batch is bounded, ordered by time, and capped per account", async () => {
  const s = setup();
  for (let i = 0; i < 8; i += 1) s.addPost();
  s.addPost({ account_id: FACEBOOK });
  const first = await s.queue.claim({ ...claimArgs, limit: 25, perAccount: 3 });
  assert.equal(first.filter((row) => row.account_id === LINKEDIN).length, 3);
  assert.equal(first.filter((row) => row.account_id === FACEBOOK).length, 1);
  const times = first.filter((row) => row.account_id === LINKEDIN).map((row) => row.scheduled_for);
  assert.deepEqual(times, [...times].sort());

  const t = setup();
  for (let i = 0; i < 6; i += 1) t.addPost({ account_id: i % 2 ? FACEBOOK : LINKEDIN });
  assert.equal((await t.queue.claim({ ...claimArgs, limit: 2 })).length, 2);
});

test("a paused account, a provider without an adapter and an exhausted post wait", async () => {
  const s = setup();
  const linked = s.addPost();
  const facebook = s.addPost({ account_id: FACEBOOK });
  s.accounts.find((a) => a.id === LINKEDIN).paused_until = new Date(T0 + 60_000).toISOString();
  assert.deepEqual((await s.queue.claim({ ...claimArgs, skipProviders: ["facebook"] })).map((r) => r.id), []);
  s.advance(61_000);
  assert.deepEqual((await s.queue.claim({ ...claimArgs, skipProviders: ["facebook"] })).map((r) => r.id), [linked.id]);
  assert.equal(facebook.status, "scheduled");
  const spent = s.addPost({ attempt_count: 5 });
  assert.equal((await s.queue.claim(claimArgs)).some((row) => row.id === spent.id), false);
});

test("a retry is not claimed before its time", async () => {
  const s = setup();
  const post = s.addPost({ next_attempt_at: new Date(T0 + 120_000).toISOString() });
  assert.equal((await s.queue.claim(claimArgs)).length, 0);
  s.advance(120_000);
  assert.equal((await s.queue.claim(claimArgs))[0].id, post.id);
});

test("an expired lease before sending goes back to the queue", async () => {
  const s = setup();
  const post = s.addPost();
  await s.queue.claim(claimArgs);
  s.advance(301_000);
  const again = await s.queue.claim(claimArgs);
  assert.equal(again.length, 1);
  assert.equal(again[0].id, post.id);
  assert.equal(again[0].attempt_count, 2);
  assert.equal(s.attempts[0].outcome, "failed");
  assert.equal(s.attempts[0].error_code, "lease-expired");
  assert.equal(s.attempts.length, 2);
});

test("an expired lease after sending is unknown and is never claimed again", async () => {
  const s = setup();
  const post = s.addPost();
  const [claimed] = await s.queue.claim(claimArgs);
  assert.equal(await s.queue.markSending(claimed), true);
  s.advance(301_000);
  assert.equal((await s.queue.claim(claimArgs)).length, 0);
  assert.equal(post.status, "unknown");
  assert.equal(post.last_error_code, "lease-expired");
  assert.equal(s.attempts[0].outcome, "unknown");
  assert.ok(post.next_attempt_at, "a look is scheduled");
});

test("sending is refused to a worker whose lease ran out", async () => {
  const s = setup();
  s.addPost();
  const [claimed] = await s.queue.claim(claimArgs);
  s.advance(301_000);
  assert.equal(await s.queue.markSending(claimed), false);
  const [again] = await s.queue.claim(claimArgs);
  assert.equal(await s.queue.markSending(claimed), false, "the old holder stays out");
  assert.equal(await s.queue.markSending(again), true);
  assert.equal(await s.queue.markSending(again), false, "only once per attempt");
});

test("a stale holder cannot overwrite the new one", async () => {
  const s = setup();
  s.addPost();
  const [first] = await s.queue.claim(claimArgs);
  s.advance(301_000);
  const [second] = await s.queue.claim(claimArgs);
  assert.equal(await s.queue.settle(first, { result: "published", providerPostId: "urn:li:share:1" }), null);
  const done = await s.queue.settle(second, { result: "published", providerPostId: "urn:li:share:2", httpStatus: 201 });
  assert.equal(done.status, "published");
  assert.equal(done.provider_post_id, "urn:li:share:2");
  assert.equal(done.lease_expires_at, null);
});

test("settle checks its input and published needs the provider's id", async () => {
  const s = setup();
  s.addPost();
  const [claimed] = await s.queue.claim(claimArgs);
  await assert.rejects(s.queue.settle(claimed, { result: "done" }), (e) => e instanceof QueueError && e.code === "invalid-result");
  await assert.rejects(s.queue.settle({ ...claimed, id: "nope" }, { result: "failed" }), (e) => e instanceof QueueError);
  await assert.rejects(s.queue.settle(claimed, { result: "failed", errorCode: "Bad Code!" }), (e) => e instanceof QueueError);
  await assert.rejects(s.queue.settle(claimed, { result: "published" }), (e) => e instanceof QueueError && e.code === "storage-failed");
  assert.equal(s.posts[0].status, "claimed", "nothing changed");
});

test("an unknown outcome resolves only to published or failed", async () => {
  const s = setup();
  s.addPost();
  const [claimed] = await s.queue.claim(claimArgs);
  const unknown = await s.queue.settle(claimed, { result: "unknown", errorCode: "timeout", nextAtMs: T0 + 300_000 });
  assert.equal(unknown.status, "unknown");
  await assert.rejects(s.queue.settle(unknown, { result: "retry" }), QueueError);
  const again = await s.queue.settle(unknown, { result: "unknown", nextAtMs: T0 + 900_000 });
  assert.equal(again.reconcile_count, 1);
  const done = await s.queue.settle(again, { result: "published", providerPostId: "urn:li:share:9" });
  assert.equal(done.status, "published");
  assert.equal(s.attempts[0].outcome, "published", "the attempt is corrected by what was found");
});

test("a rate limit pauses the account, not just the post", async () => {
  const s = setup();
  s.addPost();
  s.addPost();
  const [one] = await s.queue.claim({ ...claimArgs, limit: 1 });
  await s.queue.settle(one, { result: "retry", errorCode: "rate-limited", httpStatus: 429, nextAtMs: T0 + 600_000 });
  assert.equal((await s.queue.claim(claimArgs)).length, 0, "the other post waits too");
  s.advance(600_000);
  assert.equal((await s.queue.claim(claimArgs)).length, 2);
});

test("only this site's rows are ever returned", async () => {
  const s = setup();
  s.addPost({ site_id: "other-site" });
  const mine = s.addPost();
  assert.deepEqual((await s.queue.claim(claimArgs)).map((r) => r.id), [mine.id]);
  const wrong = createQueue({ settings: socialSettings(env()), fetchImpl: async () => new Response(JSON.stringify([{ id: LINKEDIN, site_id: "other-site" }]), { status: 200 }) });
  await assert.rejects(wrong.claim(claimArgs), (e) => e.code === "other-site");
  await assert.rejects(wrong.accounts([LINKEDIN]), (e) => e.code === "other-site");
});

test("accounts are looked up by this site's ids only", async () => {
  const s = setup();
  const map = await s.queue.accounts([LINKEDIN, REAUTH, "not-an-id"]);
  assert.deepEqual([...map.keys()].sort(), [LINKEDIN, REAUTH].sort());
  assert.equal((await s.queue.accounts([])).size, 0);
  assert.ok(s.calls.every((call) => !call.query.includes("not-an-id")));
});

test("a storage failure is a fixed error that carries no reply and no key", async () => {
  const s = setup({ failRpc: () => true });
  try {
    await s.queue.claim(claimArgs);
    assert.fail("should throw");
  } catch (error) {
    assert.ok(error instanceof QueueError);
    assert.equal(error.code, "storage-failed");
    assert.equal(error.retryable, true);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /sb_secret|boom|secret/);
  }
  const down = createQueue({
    settings: socialSettings(env()),
    fetchImpl: async () => {
      throw new Error(`connect failed ${SERVICE_KEY}`);
    },
  });
  await assert.rejects(down.claim(claimArgs), (error) => error.code === "storage-unavailable" && !error.message.includes(SERVICE_KEY));
});

test("the service key is sent only to the project's REST address, with the site in every call", async () => {
  const s = setup();
  s.addPost();
  await s.queue.claim(claimArgs);
  const [call] = s.calls;
  assert.equal(call.name, "rpc/openblog_social_claim_due");
  assert.equal(call.body.p_site_id, SITE);
  assert.equal(call.body.p_worker, "@worker");
  assert.ok(call.headers.authorization.endsWith(SERVICE_KEY));
});

test("the queue does not exist unless social publishing is enabled", () => {
  assert.throws(() => createQueue({ settings: socialSettings({}) }), (e) => e.status === 404);
});
