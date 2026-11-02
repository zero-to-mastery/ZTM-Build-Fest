// Optional social publishing, manual recovery (epic #353, story #357, ADR 0318): retrying a failed
// announcement, resolving an unknown outcome by hand, and reading the attempt history. Routes of the
// hosted function, called by the Rust Admin with the admin key; storage is an in-memory fake.
import test from "node:test";
import assert from "node:assert/strict";
import { createAnnouncements } from "../../netlify/lib/social-announcements.mjs";
import { socialSettings } from "../../netlify/lib/social-scope.mjs";
import { ADMIN_KEY, GONE, LINKEDIN, SERVICE_KEY, T0, WORKER_KEY, env, queueStorage } from "./social-queue-fakes.mjs";

function setup() {
  let clock = T0;
  const now = () => clock;
  const storage = queueStorage({ now });
  const handle = createAnnouncements({ settings: socialSettings(env()), fetchImpl: storage.fetchImpl, now });
  const call = (method, route, id, body, headers = { authorization: `Bearer ${ADMIN_KEY}`, "x-openblog-actor": "mikey" }) =>
    handle({ method, route, query: id ? `id=${id}` : "", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...storage, call, advance: (ms) => (clock += ms) };
}

const failed = (s, fields = {}) => s.addPost({ status: "failed", attempt_count: 3, version: 4, last_error_code: "attempts-exhausted", ...fields });
const unknown = (s, fields = {}) => s.addPost({ status: "unknown", attempt_count: 1, version: 3, last_error_code: "timeout", next_attempt_at: null, ...fields });

test("a failed announcement can be retried: back in the queue with a fresh allowance", async () => {
  const s = setup();
  const post = failed(s);
  const reply = await s.call("POST", "announcements/retry", post.id, { version: 4 });
  assert.equal(reply.status, 200);
  assert.equal(post.status, "scheduled");
  assert.equal(post.attempt_floor, 3, "the three used attempts do not count against the new allowance");
  assert.equal(post.attempt_count, 3, "the history is kept");
  assert.equal(post.last_error_code, null);
  assert.equal(post.version, 5);
  assert.equal(reply.body.announcement.status, "scheduled");
  assert.equal(reply.body.announcement.editable, true);
});

test("only a failed announcement is retried; an unknown outcome must be resolved first", async () => {
  const s = setup();
  const maybe = unknown(s);
  const refused = await s.call("POST", "announcements/retry", maybe.id, { version: 3 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "needs-resolution");
  assert.equal(maybe.status, "unknown");
  for (const status of ["scheduled", "claimed", "published", "canceled"]) {
    const post = s.addPost({ status, version: 2 });
    const reply = await s.call("POST", "announcements/retry", post.id, { version: 2 });
    assert.equal(reply.status, 409, status);
    assert.equal(reply.body.code, "not-retryable", status);
    assert.equal(post.status, status, "nothing changed");
  }
});

test("a retry names the version, and a destination that is not connected is refused", async () => {
  const s = setup();
  const post = failed(s);
  const stale = await s.call("POST", "announcements/retry", post.id, { version: 2 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale");
  assert.equal(stale.body.version, 4);
  assert.equal(post.status, "failed");
  const detached = failed(s, { account_id: GONE });
  const reply = await s.call("POST", "announcements/retry", detached.id, { version: 4 });
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, "destination-not-connected");
  assert.equal(detached.status, "failed");
  assert.equal((await s.call("POST", "announcements/retry", post.id, {})).status, 400);
  assert.equal((await s.call("POST", "announcements/retry", post.id, { version: 4, status: "published" })).status, 400);
  assert.equal((await s.call("POST", "announcements/retry", "not-an-id", { version: 4 })).status, 400);
  assert.equal((await s.call("POST", "announcements/retry", "99999999-9999-4999-8999-999999999999", { version: 1 })).status, 404);
});

test("an unknown outcome the author found on the provider is recorded as published, with its id", async () => {
  const s = setup();
  const post = unknown(s);
  s.attempts.push({ post_id: post.id, site_id: post.site_id, attempt_no: 1, started_at: new Date(T0).toISOString(), finished_at: new Date(T0).toISOString(), outcome: "unknown" });
  const reply = await s.call("POST", "announcements/resolve", post.id, { version: 3, outcome: "published", providerPostId: "urn:li:share:7000" });
  assert.equal(reply.status, 200);
  assert.equal(post.status, "published");
  assert.equal(post.provider_post_id, "urn:li:share:7000");
  assert.equal(reply.body.announcement.providerPostId, "urn:li:share:7000");
  assert.equal(s.attempts[0].outcome, "published");
});

test("an unknown outcome the author found missing becomes failed and can then be retried", async () => {
  const s = setup();
  const post = unknown(s);
  const reply = await s.call("POST", "announcements/resolve", post.id, { version: 3, outcome: "not-posted" });
  assert.equal(reply.status, 200);
  assert.equal(post.status, "failed");
  assert.equal(post.last_error_code, "reviewed-not-posted");
  const retried = await s.call("POST", "announcements/retry", post.id, { version: post.version });
  assert.equal(retried.status, 200);
  assert.equal(post.status, "scheduled");
});

test("resolving checks the outcome, the id, the status and the version", async () => {
  const s = setup();
  const post = unknown(s);
  const send = (body) => s.call("POST", "announcements/resolve", post.id, body);
  for (const body of [
    { version: 3 },
    { version: 3, outcome: "done" },
    { version: 3, outcome: "published" },
    { version: 3, outcome: "published", providerPostId: "has a space" },
    { version: 3, outcome: "published", providerPostId: "x".repeat(301) },
    { version: 3, outcome: "not-posted", providerPostId: "urn:li:share:1" },
    { version: 3, outcome: "published", providerPostId: "urn:li:share:1", status: "published" },
    { outcome: "published", providerPostId: "urn:li:share:1" },
  ]) {
    const reply = await send(body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.equal(post.status, "unknown");
  }
  assert.equal((await send({ version: 1, outcome: "not-posted" })).body.code, "stale");
  const scheduled = s.addPost();
  assert.equal((await s.call("POST", "announcements/resolve", scheduled.id, { version: 1, outcome: "not-posted" })).body.code, "not-resolvable");
  assert.equal(scheduled.status, "scheduled");
});

test("only the admin key may recover an announcement; the worker key and no key may not", async () => {
  const s = setup();
  const post = failed(s);
  for (const route of ["announcements/retry", "announcements/resolve"]) {
    assert.equal((await s.call("POST", route, post.id, { version: 4, outcome: "not-posted" }, { authorization: `Bearer ${WORKER_KEY}` })).status, 403, route);
    assert.equal((await s.call("POST", route, post.id, { version: 4, outcome: "not-posted" }, {})).status, 401, route);
    assert.equal((await s.call("POST", route, post.id, { version: 4, outcome: "not-posted", site_id: "other" })).status, 400, route);
  }
  assert.equal((await s.call("GET", "announcements/attempts", post.id, undefined, { authorization: `Bearer ${WORKER_KEY}` })).status, 403);
  assert.equal(post.status, "failed");
});

test("the attempt history shows what was tried and nothing secret", async () => {
  const s = setup();
  const post = failed(s);
  s.attempts.push(
    { id: "b1", site_id: post.site_id, post_id: post.id, attempt_no: 1, worker: "@worker", started_at: new Date(T0).toISOString(), finished_at: new Date(T0 + 2000).toISOString(), outcome: "failed", http_status: 503, error_code: "provider-unavailable", error_detail: "The provider did not accept the request. (HTTP 503.)", provider_request_id: "req-secret-ish", sending_at: new Date(T0).toISOString() },
    { id: "b2", site_id: post.site_id, post_id: post.id, attempt_no: 2, worker: "@worker", started_at: new Date(T0 + 60_000).toISOString(), finished_at: null, outcome: null },
    { id: "b3", site_id: "other-site", post_id: post.id, attempt_no: 3, worker: "@worker", started_at: new Date(T0).toISOString(), outcome: "failed" },
  );
  const reply = await s.call("GET", "announcements/attempts", post.id);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.attempts.map((a) => [a.attemptNo, a.outcome, a.errorCode, a.httpStatus]), [[1, "failed", "provider-unavailable", 503], [2, null, null, null]]);
  assert.deepEqual(Object.keys(reply.body.attempts[0]).sort(), ["attemptNo", "errorCode", "errorDetail", "finishedAt", "httpStatus", "outcome", "providerPostId", "startedAt"]);
  const text = JSON.stringify(reply.body);
  for (const hidden of ["@worker", "req-secret-ish", "sending_at", SERVICE_KEY, ADMIN_KEY, WORKER_KEY]) assert.equal(text.includes(hidden), false, hidden);
  assert.equal((await s.call("GET", "announcements/attempts", "99999999-9999-4999-8999-999999999999")).status, 404);
  assert.equal((await s.call("GET", "announcements/attempts")).status, 400);
});

test("the announcement view tells Admin what can be done and when the next try is", async () => {
  const s = setup();
  const post = failed(s);
  const waiting = s.addPost({ next_attempt_at: new Date(T0 + 90_000).toISOString(), attempt_count: 1, last_error_code: "provider-unavailable" });
  const list = (await s.call("GET", "announcements", undefined)).body.announcements;
  const byId = (id) => list.find((item) => item.id === id);
  assert.equal(byId(post.id).retryable, true);
  assert.equal(byId(post.id).resolvable, false);
  assert.equal(byId(post.id).nextAttemptAt, null);
  assert.equal(byId(waiting.id).nextAttemptAt, "2026-11-01T12:01:30Z");
  assert.equal(byId(waiting.id).retryable, false);
  assert.equal(JSON.stringify(list).includes("idempotency"), false);
  assert.equal(LINKEDIN.length, 36);
});
