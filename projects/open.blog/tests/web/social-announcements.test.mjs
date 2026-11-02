// Optional social publishing, authorized scheduling routes (epic #353, ADR 0309): who may call,
// what a destination must be, idempotent creation, versioned edits, cancel, and that nothing secret
// or foreign comes back. Storage is an in-memory PostgREST fake; no real network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createAnnouncements, MAX_BODY_BYTES } from "../../netlify/lib/social-announcements.mjs";
import { socialSettings } from "../../netlify/lib/social-scope.mjs";
import { createHandler } from "../../netlify/functions/social.mjs";
import { FACEBOOK, FUTURE, GONE, LINKEDIN, OTHER_SITE, REAUTH, SITE, fakeStorage } from "./social-fake-storage.mjs";

const ADMIN_KEY = "adm_".padEnd(48, "a1");
const WORKER_KEY = "wrk_".padEnd(48, "b2");
const SERVICE_KEY = "sb_secret_".padEnd(48, "c3");
const env = (overrides = {}) => ({
  OPENBLOG_SOCIAL_ENABLED: "true",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: SERVICE_KEY,
  OPENBLOG_SITE_ID: SITE,
  OPENBLOG_SOCIAL_ADMIN_KEY: ADMIN_KEY,
  OPENBLOG_SOCIAL_WORKER_KEY: WORKER_KEY,
  OPENBLOG_SOCIAL_TOKEN_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
  ...overrides,
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
const KEY = "request-key-0000001";
const WORK = "/posts/hello/";
const URL_OK = "https://blog.example.org/posts/hello/";

function setup(options = {}) {
  const storage = fakeStorage(options);
  const settings = socialSettings(env());
  const handle = createAnnouncements({ settings, fetchImpl: storage.fetchImpl, now: () => options.now ?? NOW });
  const call = (request) =>
    handle({ headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-openblog-actor": "mikey" }, ...request });
  return { ...storage, handle, call };
}

const draft = (overrides = {}) => ({
  accountId: LINKEDIN,
  work: WORK,
  canonicalUrl: URL_OK,
  caption: "A new post is live.",
  scheduledFor: "2026-11-02T09:30:00+02:00",
  timeZone: "Europe/Athens",
  idempotencyKey: KEY,
  ...overrides,
});
const post = (body, route = "announcements", query = "") => ({ method: "POST", route, query, body: JSON.stringify(body) });
const created = async (t, overrides) => {
  const r = await t.call(post(draft(overrides)));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.announcement;
};

test("the feature is absent unless configured", async () => {
  assert.throws(() => createAnnouncements({ settings: socialSettings({}) }), /not enabled/);
  const handler = createHandler({ env: { OPENBLOG_SOCIAL_ENABLED: "true" }, fetchImpl: async () => assert.fail("no network") });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await handler({ httpMethod: "GET", path: "/.netlify/functions/social/announcements", headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    assert.equal(r.statusCode, 404);
    assert.ok(!r.body.includes("SUPABASE"), "the response does not name settings");
  } finally {
    console.warn = warn;
  }
});

test("only the admin key may call, with a named actor, and a worker key is refused", async () => {
  const t = setup();
  const get = { method: "GET", route: "announcements" };
  assert.equal((await t.handle({ ...get, headers: {} })).status, 401);
  assert.equal((await t.handle({ ...get, headers: { authorization: `Bearer ${SERVICE_KEY}`, "x-openblog-actor": "mikey" } })).status, 401, "the service key is not an admin key");
  assert.equal((await t.handle({ ...get, headers: { authorization: `Bearer ${WORKER_KEY}` } })).status, 403);
  assert.equal((await t.handle({ ...get, headers: { authorization: `Bearer ${ADMIN_KEY}` } })).status, 400, "an admin call names its actor");
  assert.equal((await t.handle({ ...get, headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-openblog-actor": "Mikey N" } })).status, 400);
  assert.equal((await t.call(get)).status, 200);
  assert.equal(t.calls.filter((c) => c.method !== "GET").length, 0);
  // Nothing reached storage for a refused caller.
  const refused = setup();
  await refused.handle({ ...get, headers: { authorization: "Bearer nope" } });
  assert.equal(refused.calls.length, 0);
});

test("a request can never name a site, and every query is led by this site", async () => {
  const t = setup();
  assert.equal((await t.call({ method: "GET", route: "announcements", query: "site_id=other" })).status, 400);
  assert.equal((await t.call(post(draft({ site_id: "other" }))) ).status, 400);
  assert.equal((await t.call(post({ ...draft(), nested: { siteId: "x" } }))).status, 400);
  await created(t);
  await t.call({ method: "GET", route: "announcements" });
  for (const call of t.calls.filter((c) => c.method !== "POST")) assert.ok(call.query.includes(`site_id=eq.${SITE}`), call.query);
  const insert = t.calls.find((c) => c.method === "POST");
  assert.equal(insert.body.site_id, SITE);
  // The service key goes only to storage, as the credential, never into a body.
  for (const call of t.calls) assert.ok(!JSON.stringify(call.body ?? {}).includes(SERVICE_KEY));
});

test("destinations are the connected, supported accounts of this site", async () => {
  const t = setup();
  const r = await t.call({ method: "GET", route: "destinations" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.destinations.map((d) => d.id).sort(), [FACEBOOK, LINKEDIN].sort());
  assert.deepEqual(Object.keys(r.body.destinations[0]).sort(), ["displayName", "id", "kind", "provider", "status"]);
});

test("a valid announcement is stored for this site, in UTC, as the named actor", async () => {
  const t = setup();
  const announcement = await created(t);
  assert.equal(announcement.scheduledFor, "2026-11-02T07:30:00Z");
  assert.equal(announcement.status, "scheduled");
  assert.equal(announcement.version, 1);
  assert.equal(announcement.createdBy, "mikey");
  assert.equal(announcement.editable, true);
  assert.equal(announcement.destination.displayName, "Mikey Nichols");
  const row = t.posts[0];
  assert.equal(row.site_id, SITE);
  assert.equal(row.scheduled_for, "2026-11-02T07:30:00Z");
  assert.equal(row.created_by, "mikey");
  assert.equal(row.status, "scheduled");
  // What comes back has no lease owner, no idempotency key and no credential.
  const text = JSON.stringify(announcement);
  for (const secret of [KEY, SERVICE_KEY, ADMIN_KEY, WORKER_KEY, "claimed_by", "idempotency"]) assert.ok(!text.includes(secret), secret);
});

test("destination ownership: another site's, unknown, disconnected, stale and unsupported accounts are refused", async () => {
  const t = setup();
  const code = async (overrides) => {
    const r = await t.call(post(draft(overrides)));
    return [r.status, r.body.code];
  };
  assert.deepEqual(await code({ accountId: OTHER_SITE }), [404, "destination-not-found"]);
  assert.deepEqual(await code({ accountId: "77777777-7777-4777-8777-777777777777" }), [404, "destination-not-found"]);
  assert.deepEqual(await code({ accountId: GONE }), [409, "destination-not-connected"]);
  assert.deepEqual(await code({ accountId: REAUTH }), [409, "destination-not-connected"]);
  assert.deepEqual(await code({ accountId: FUTURE }), [422, "unsupported-provider"]);
  assert.deepEqual(await code({ accountId: "not-a-uuid" }), [400, "invalid-account"]);
  assert.equal(t.posts.length, 0);
});

test("invalid input is refused with a fixed code and stores nothing", async () => {
  const t = setup();
  const code = async (overrides) => {
    const r = await t.call(post(draft(overrides)));
    return [r.status, r.body.code];
  };
  assert.deepEqual(await code({ caption: "   " }), [422, "caption-empty"]);
  assert.deepEqual(await code({ caption: "x".repeat(3001) }), [422, "caption-too-long"]);
  assert.deepEqual(await code({ caption: "bell\u0007" }), [422, "caption-characters"]);
  assert.deepEqual(await code({ scheduledFor: "2026-11-02T09:30:00" }), [422, "time-needs-zone"]);
  assert.deepEqual(await code({ scheduledFor: "2026-11-01T12:00:30Z" }), [422, "time-too-soon"]);
  assert.deepEqual(await code({ scheduledFor: "2030-11-01T12:00:30Z" }), [422, "time-too-far"]);
  assert.deepEqual(await code({ timeZone: "../etc" }), [422, "time-zone-invalid"]);
  assert.deepEqual(await code({ idempotencyKey: "short" }), [422, "key-invalid"]);
  assert.deepEqual(await code({ canonicalUrl: "http://blog.example.org/posts/hello/" }), [422, "url-invalid"]);
  assert.deepEqual(await code({ canonicalUrl: "https://blog.example.org/posts/other/" }), [422, "url-invalid"]);
  assert.deepEqual(await code({ status: "published" }), [400, "unknown-field"]);
  assert.deepEqual(await code({ caption: 5 }), [400, "invalid-request"]);
  assert.deepEqual(await code({ caption: undefined }), [400, "missing-field"]);
  assert.equal((await t.call({ method: "POST", route: "announcements", body: "{nope" })).status, 400);
  assert.equal((await t.call({ method: "POST", route: "announcements", body: "[]" })).status, 400);
  assert.equal((await t.call({ method: "POST", route: "announcements", body: "x".repeat(MAX_BODY_BYTES + 1) })).status, 413);
  assert.equal(t.posts.length, 0);
  // A facebook destination accepts the same bounded caption under its own provider.
  assert.equal((await t.call(post(draft({ accountId: FACEBOOK, idempotencyKey: "another-key-000001" })))).status, 201);
});

test("the same key is the same announcement: a retry returns it and never posts twice", async () => {
  const t = setup();
  const first = await created(t);
  const retry = await t.call(post(draft()));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.announcement.id, first.id);
  assert.equal(t.posts.length, 1);
  // Even after the chosen time has passed, a retry of the same request is recognized.
  const late = setup({ now: Date.parse("2026-11-03T00:00:00Z") });
  late.posts.push(...t.posts);
  assert.equal((await late.call(post(draft()))).status, 200);
  // The key is reused for something else.
  const clash = await t.call(post(draft({ caption: "A different caption." })));
  assert.deepEqual([clash.status, clash.body.code], [409, "idempotency-conflict"]);
  // Another destination may use the same key (the index is per account).
  assert.equal((await t.call(post(draft({ accountId: FACEBOOK })))).status, 201);
  assert.equal(t.posts.length, 2);
});

test("a retry of a key already used is answered even when the destination now needs reconnecting", async () => {
  const t = setup();
  const first = await created(t);
  t.accounts.find((account) => account.id === LINKEDIN).status = "needs-reauth";
  const retry = await t.call(post(draft()));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.announcement.id, first.id);
  // A new request for that destination is still refused.
  const fresh = await t.call(post(draft({ idempotencyKey: "another-key-000002" })));
  assert.deepEqual([fresh.status, fresh.body.code], [409, "destination-not-connected"]);
});

test("two submits that race on one key resolve to one row", async () => {
  const t = setup();
  const original = t.fetchImpl;
  let raced = false;
  const racing = createAnnouncements({
    settings: socialSettings(env()),
    now: () => NOW,
    fetchImpl: async (url, options) => {
      // The winner lands between this caller's lookup and its insert.
      if (!raced && (options?.method || "GET") === "POST") {
        raced = true;
        await original(url, options);
      }
      return original(url, options);
    },
  });
  const r = await racing({ method: "POST", route: "announcements", headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-openblog-actor": "mikey" }, body: JSON.stringify(draft()) });
  assert.equal(r.status, 200);
  assert.equal(r.body.replayed, true);
  assert.equal(t.posts.length, 1);
  assert.equal(raced, true);
});

test("the list shows this site's announcements with their destinations, and filters are bounded", async () => {
  const t = setup();
  const a = await created(t);
  await created(t, { accountId: FACEBOOK, idempotencyKey: "another-key-000002", scheduledFor: "2026-11-05T10:00:00Z", work: "/posts/two/", canonicalUrl: "https://blog.example.org/posts/two/" });
  const list = await t.call({ method: "GET", route: "announcements" });
  assert.equal(list.body.announcements.length, 2);
  assert.equal(list.body.announcements[0].destination.provider, "facebook", "latest first");
  const byWork = await t.call({ method: "GET", route: "announcements", query: `work=${encodeURIComponent(WORK)}` });
  assert.deepEqual(byWork.body.announcements.map((x) => x.id), [a.id]);
  assert.equal((await t.call({ method: "GET", route: "announcements", query: "status=canceled" })).body.announcements.length, 0);
  for (const query of ["status=bogus", "limit=0", "limit=101", "limit=x", "work=//evil", "work=nope"]) assert.equal((await t.call({ method: "GET", route: "announcements", query })).status, 400, query);
});

test("a row from another site is never shown", async () => {
  const t = setup({ ignoreFilters: true });
  t.posts.push({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", site_id: "other-site", account_id: OTHER_SITE, work: WORK, canonical_url: URL_OK, body: "Secret plan", scheduled_for: "2026-11-02T07:30:00Z", status: "scheduled", version: 1 });
  const r = await t.call({ method: "GET", route: "announcements" });
  assert.equal(r.status, 500);
  assert.ok(!JSON.stringify(r.body).includes("Secret plan"));
});

test("an edit names the version, raises it, and keeps the same row", async () => {
  const t = setup();
  const a = await created(t);
  const edited = await t.call({ method: "PATCH", route: "announcements", query: `id=${a.id}`, body: JSON.stringify({ version: 1, caption: "Better words.", scheduledFor: "2026-11-04T08:00:00Z" }) });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.announcement.version, 2);
  assert.equal(edited.body.announcement.caption, "Better words.");
  assert.equal(edited.body.announcement.scheduledFor, "2026-11-04T08:00:00Z");
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].idempotency_key, KEY, "the key never changes");
  const patch = t.calls.find((c) => c.method === "PATCH");
  assert.ok(patch.query.includes("status=eq.scheduled") && patch.query.includes("version=eq.1"));
  // A stale version, an empty change and a bad id are refused.
  const stale = await t.call({ method: "PATCH", route: "announcements", query: `id=${a.id}`, body: JSON.stringify({ version: 1, caption: "Again." }) });
  assert.deepEqual([stale.status, stale.body.code, stale.body.version], [409, "stale", 2]);
  assert.equal((await t.call({ method: "PATCH", route: "announcements", query: `id=${a.id}`, body: JSON.stringify({ version: 2 }) })).body.code, "nothing-to-change");
  assert.equal((await t.call({ method: "PATCH", route: "announcements", query: "id=x", body: JSON.stringify({ version: 2, caption: "x" }) })).body.code, "invalid-id");
  assert.equal((await t.call({ method: "PATCH", route: "announcements", query: `id=${a.id}`, body: JSON.stringify({ version: 2, caption: "x".repeat(3001) }) })).body.code, "caption-too-long");
  assert.equal((await t.call({ method: "PATCH", route: "announcements", query: `id=${a.id}`, body: JSON.stringify({ version: 2, status: "published", caption: "x" }) })).body.code, "unknown-field");
  assert.equal(t.posts[0].body, "Better words.");
});

test("reschedule changes only the time, and the time must still be valid", async () => {
  const t = setup();
  const a = await created(t);
  const moved = await t.call(post({ version: 1, scheduledFor: "2026-11-09T18:00:00Z" }, "announcements/reschedule", `id=${a.id}`));
  assert.equal(moved.status, 200);
  assert.equal(moved.body.announcement.scheduledFor, "2026-11-09T18:00:00Z");
  assert.equal(moved.body.announcement.caption, "A new post is live.");
  const past = await t.call(post({ version: 2, scheduledFor: "2026-10-01T18:00:00Z" }, "announcements/reschedule", `id=${a.id}`));
  assert.deepEqual([past.status, past.body.code], [422, "time-too-soon"]);
  const caption = await t.call(post({ version: 2, scheduledFor: "2026-11-10T18:00:00Z", caption: "x" }, "announcements/reschedule", `id=${a.id}`));
  assert.equal(caption.body.code, "unknown-field");
});

test("cancel is versioned and idempotent, and only a scheduled announcement can be canceled or changed", async () => {
  const t = setup();
  const a = await created(t);
  const canceled = await t.call(post({ version: 1 }, "announcements/cancel", `id=${a.id}`));
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.announcement.status, "canceled");
  assert.equal(canceled.body.announcement.editable, false);
  assert.ok(canceled.body.announcement.canceledAt);
  assert.equal(t.posts[0].status, "canceled");
  // Cancelling again, even with an old version, is the same as once.
  const again = await t.call(post({ version: 1 }, "announcements/cancel", `id=${a.id}`));
  assert.equal(again.status, 200);
  assert.equal(again.body.announcement.status, "canceled");
  // A canceled announcement cannot be edited or rescheduled.
  const edit = await t.call({ method: "PATCH", route: "announcements", query: `id=${a.id}`, body: JSON.stringify({ version: 2, caption: "x" }) });
  assert.deepEqual([edit.status, edit.body.code], [409, "not-editable"]);

  for (const status of ["claimed", "published", "failed", "unknown"]) {
    const b = await created(t, { idempotencyKey: `status-key-${status}-000`, scheduledFor: "2026-11-06T10:00:00Z" });
    Object.assign(t.posts.find((row) => row.id === b.id), { status });
    const refused = await t.call(post({ version: 1 }, "announcements/cancel", `id=${b.id}`));
    assert.deepEqual([refused.status, refused.body.code, refused.body.status], [409, "not-editable", status]);
    const edited = await t.call({ method: "PATCH", route: "announcements", query: `id=${b.id}`, body: JSON.stringify({ version: 1, caption: "x" }) });
    assert.deepEqual([edited.status, edited.body.code], [409, "not-editable"]);
    assert.equal(t.posts.find((row) => row.id === b.id).status, status, "nothing changed");
  }
  const missing = await t.call(post({ version: 1 }, "announcements/cancel", "id=99999999-9999-4999-8999-999999999999"));
  assert.equal(missing.status, 404);
});

test("a worker that claims between the read and the write wins, and the author is told", async () => {
  let claim = false;
  const t = setup({
    onPatch: (posts) => {
      if (claim) for (const row of posts) Object.assign(row, { status: "claimed", version: row.version + 1 });
    },
  });
  const a = await created(t);
  claim = true;
  const canceled = await t.call(post({ version: 1 }, "announcements/cancel", `id=${a.id}`));
  assert.deepEqual([canceled.status, canceled.body.code], [409, "conflict"]);
  assert.equal(t.posts[0].status, "claimed", "a claimed announcement is not canceled underneath the worker");
  const edited = await t.call({ method: "PATCH", route: "announcements", query: `id=${a.id}`, body: JSON.stringify({ version: 1, caption: "x" }) });
  assert.equal(edited.status, 409);
});

test("storage failures are fixed errors that leak nothing", async () => {
  const leak = `${SERVICE_KEY} Bearer secret-token detail`;
  const down = createAnnouncements({ settings: socialSettings(env()), fetchImpl: async () => { throw new Error(leak); }, now: () => NOW });
  const refused = createAnnouncements({ settings: socialSettings(env()), fetchImpl: async () => new Response(leak, { status: 500 }), now: () => NOW });
  for (const handle of [down, refused]) {
    const r = await handle({ method: "GET", route: "announcements", headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-openblog-actor": "mikey" } });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r).includes("secret-token") && !JSON.stringify(r).includes(SERVICE_KEY));
  }
  const broken = createAnnouncements({ settings: socialSettings(env()), fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error(leak); } }), now: () => NOW });
  const r = await broken({ method: "GET", route: "destinations", headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-openblog-actor": "mikey" } });
  assert.ok(!JSON.stringify(r).includes("secret-token"));
});

test("unknown routes and wrong methods are denied", async () => {
  const t = setup();
  assert.equal((await t.call({ method: "GET", route: "nope" })).status, 404);
  assert.equal((await t.call({ method: "DELETE", route: "announcements" })).status, 405);
  assert.equal((await t.call({ method: "GET", route: "announcements/cancel" })).status, 405);
  assert.equal((await t.call({ method: "POST", route: "announcements/../destinations" })).status, 404);
});

test("the Netlify function routes by path, decodes a base64 body, and answers JSON with no-store", async () => {
  const storage = fakeStorage();
  const handler = createHandler({ env: env(), fetchImpl: storage.fetchImpl, now: () => NOW });
  const headers = { Authorization: `Bearer ${ADMIN_KEY}`, "X-OpenBlog-Actor": "mikey" };
  const r = await handler({ httpMethod: "POST", path: "/.netlify/functions/social/announcements", headers, queryStringParameters: null, body: Buffer.from(JSON.stringify(draft())).toString("base64"), isBase64Encoded: true });
  assert.equal(r.statusCode, 201);
  assert.match(r.headers["cache-control"], /no-store/);
  assert.equal(JSON.parse(r.body).announcement.status, "scheduled");
  const list = await handler({ httpMethod: "GET", path: "/.netlify/functions/social/announcements", headers, queryStringParameters: { status: "scheduled" } });
  assert.equal(JSON.parse(list.body).announcements.length, 1);
  const none = await handler({ httpMethod: "GET", path: "/.netlify/functions/social/announcements", headers: {} });
  assert.equal(none.statusCode, 401);
});
