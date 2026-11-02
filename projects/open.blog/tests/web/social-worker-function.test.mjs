// The hosted delivery worker endpoint (epic #353, story #357, ADR 0317): off unless configured,
// callable only with the worker key, never with a public key or the admin key, bounded, and it
// answers with counts only. Providers are fakes; Supabase is an in-memory fake.
import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../../netlify/functions/social-worker.mjs";
import { createCredentialStore } from "../../netlify/lib/social-credentials.mjs";
import { socialSettings } from "../../netlify/lib/social-scope.mjs";
import { ACCESS, ADMIN_KEY, LINKEDIN, SERVICE_KEY, T0, WORKER_KEY, env, fakeAdapter, queueStorage } from "./social-queue-fakes.mjs";

const ANON_KEY = "sb_anon_".padEnd(60, "e5");

async function setup(options = {}) {
  const now = () => T0;
  const fakes = queueStorage({ now });
  const settings = socialSettings(env());
  await createCredentialStore({ settings, fetchImpl: fakes.fetchImpl, now }).save(LINKEDIN, { accessToken: ACCESS, expiresIn: 86400 });
  const adapter = fakeAdapter("linkedin");
  const handler = createHandler({ env: env(options.env), fetchImpl: fakes.fetchImpl, now, adapters: { linkedin: adapter }, random: () => 0.5 });
  const call = (overrides = {}) => handler({ httpMethod: "POST", path: "/api/social-worker", headers: { authorization: `Bearer ${WORKER_KEY}` }, body: "", ...overrides });
  return { ...fakes, adapter, call, handler };
}

test("off unless social publishing is enabled and every setting is valid", async () => {
  for (const overrides of [{ OPENBLOG_SOCIAL_ENABLED: "" }, { OPENBLOG_SOCIAL_ENABLED: "yes" }, { OPENBLOG_SOCIAL_WORKER_KEY: "short" }]) {
    const s = await setup({ env: overrides });
    s.addPost();
    const reply = await s.call();
    assert.equal(reply.statusCode, 404, JSON.stringify(overrides));
    assert.equal(s.adapter.published.length, 0);
    assert.equal(s.calls.filter((c) => c.name.startsWith("rpc/")).length, 0, "nothing touched the queue");
  }
});

test("only POST with the worker key runs a batch", async () => {
  const s = await setup();
  s.addPost();
  assert.equal((await s.call({ httpMethod: "GET" })).statusCode, 405);
  assert.equal((await s.call({ httpMethod: "GET" })).headers.allow, "POST");
  assert.equal((await s.call({ headers: {} })).statusCode, 401);
  assert.equal((await s.call({ headers: { authorization: "Bearer wrong" } })).statusCode, 401);
  assert.equal((await s.call({ headers: { authorization: `Basic ${WORKER_KEY}` } })).statusCode, 401);
  assert.equal(s.adapter.published.length, 0, "no unauthorized call delivered anything");
  const ok = await s.call();
  assert.equal(ok.statusCode, 200);
  assert.equal(s.adapter.published.length, 1);
});

test("a public key, the service key and the admin key can never run the worker", async () => {
  const s = await setup();
  s.addPost();
  assert.equal((await s.call({ headers: { authorization: `Bearer ${ANON_KEY}` } })).statusCode, 401);
  assert.equal((await s.call({ headers: { authorization: `Bearer ${SERVICE_KEY}` } })).statusCode, 401);
  assert.equal((await s.call({ headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-openblog-actor": "mikey" } })).statusCode, 403);
  assert.equal(s.adapter.published.length, 0);
  // A worker key equal to a public key is refused when the settings are read: the endpoint is off.
  const anonAsWorker = await setup({ env: { SUPABASE_ANON_KEY: WORKER_KEY } });
  assert.equal((await anonAsWorker.call()).statusCode, 404);
});

test("the worker acts as itself: an actor header is refused", async () => {
  const s = await setup();
  assert.equal((await s.call({ headers: { authorization: `Bearer ${WORKER_KEY}`, "x-openblog-actor": "mikey" } })).statusCode, 400);
});

test("a request cannot name a site, carry fields or be large", async () => {
  const s = await setup();
  s.addPost();
  assert.equal((await s.call({ rawQuery: "site_id=other" })).statusCode, 400);
  assert.equal((await s.call({ body: JSON.stringify({ site_id: "other" }) })).statusCode, 400);
  assert.equal((await s.call({ body: JSON.stringify({ limit: 99 }) })).statusCode, 400);
  assert.equal((await s.call({ body: "{nope" })).statusCode, 400);
  assert.equal((await s.call({ body: "[]" })).statusCode, 400);
  assert.equal((await s.call({ body: JSON.stringify({ pad: "x".repeat(2000) }) })).statusCode, 413);
  assert.equal(s.adapter.published.length, 0);
  assert.equal((await s.call({ body: "{}" })).statusCode, 200);
});

test("an empty or object body runs one bounded batch and answers with counts only", async () => {
  const s = await setup({ env: { OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  for (let i = 0; i < 4; i += 1) s.addPost();
  const reply = await s.call({ body: "{}" });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.equal(reply.headers["content-type"], "application/json; charset=utf-8");
  const body = JSON.parse(reply.body);
  assert.equal(body.ok, true);
  assert.equal(body.summary.claimed, 3);
  assert.equal(body.summary.published, 3);
  assert.deepEqual(Object.keys(body.summary).sort(), ["claimed", "deferred", "failed", "lost", "published", "reconciled", "retried", "unknown", "unrecorded"]);
  for (const secret of [ACCESS, SERVICE_KEY, ADMIN_KEY, WORKER_KEY]) assert.equal(reply.body.includes(secret), false);
});

test("the batch size is a setting, bounded", async () => {
  const s = await setup({ env: { OPENBLOG_SOCIAL_BATCH_SIZE: "1" } });
  s.addPost();
  s.addPost();
  assert.equal(JSON.parse((await s.call()).body).summary.claimed, 1);
  const bad = await setup({ env: { OPENBLOG_SOCIAL_BATCH_SIZE: "500" } });
  bad.addPost();
  assert.equal(JSON.parse((await bad.call()).body).summary.claimed, 1, "an out-of-range value falls back to the default");
});

test("an unreachable queue is a fixed 503 that shows no key and no reply", async () => {
  const now = () => T0;
  const fakes = queueStorage({ now, failRpc: () => true });
  const handler = createHandler({ env: env(), fetchImpl: fakes.fetchImpl, now, adapters: {} });
  const reply = await handler({ httpMethod: "POST", headers: { authorization: `Bearer ${WORKER_KEY}` }, body: "" });
  assert.equal(reply.statusCode, 503);
  assert.deepEqual(JSON.parse(reply.body), { error: "storage-unavailable", message: "The queue could not be reached." });
  const down = createHandler({
    env: env(),
    fetchImpl: async () => {
      throw new Error(`boom ${SERVICE_KEY}`);
    },
    adapters: {},
  });
  const second = await down({ httpMethod: "POST", headers: { authorization: `Bearer ${WORKER_KEY}` } });
  assert.equal(second.statusCode, 503);
  assert.equal(second.body.includes(SERVICE_KEY), false);
});

test("with no adapter registered nothing is delivered and announcements keep waiting", async () => {
  const now = () => T0;
  const fakes = queueStorage({ now });
  const post = fakes.addPost();
  const handler = createHandler({ env: env(), fetchImpl: fakes.fetchImpl, now });
  const reply = await handler({ httpMethod: "POST", headers: { authorization: `Bearer ${WORKER_KEY}` }, body: "" });
  assert.equal(reply.statusCode, 200);
  assert.equal(JSON.parse(reply.body).summary.claimed, 0);
  assert.equal(post.status, "scheduled");
});
