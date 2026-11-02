// The hosted feedback transport (ADRs 0080 and 0081), exercised through
// HTTP-shaped events with fake Supabase and site fetches: off by default,
// shared validation before any request, the site's published policy, the
// existing quota, a receiver-stamped time, a private reader name kept out of
// comments, constant-time moderation authorization, provider failures, and the
// SQL the function relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import { MODERATION_ACTIONS, MODERATION_STATES, auditActor, planModeration } from "../../netlify/lib/feedback-moderation.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/scholarly-feedback.json", import.meta.url), "utf8"));
const moderationFixture = JSON.parse(readFileSync(new URL("../fixtures/feedback-moderation.json", import.meta.url), "utf8"));
const migration = readFileSync(new URL("../../supabase/feedback.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../../supabase/feedback-rollback.sql", import.meta.url), "utf8");
const baseSchema = readFileSync(new URL("../../supabase/openblog.sql", import.meta.url), "utf8");

const environment = {
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: "sb_secret_test_server_only",
  OPENBLOG_SITE_ID: "lantern",
  OPENBLOG_SITE_ORIGIN: "https://blog.example",
  OPENBLOG_ADMIN_API_KEY: "admin-secret",
  OPENBLOG_ANALYTICS_SALT: "daily-hash-secret",
};
const enabled = { ...environment, OPENBLOG_FEEDBACK_ENABLED: "true" };
const NOW = new Date("2026-10-26T10:00:00.750Z");

const textOf = (item) => item.text ?? JSON.stringify(item.submission);
const submission = (index = 0) => textOf(fixture.accepted[index]);

const event = (path, method = "GET", body, extra = {}) => ({
  path: `/api/${path}`,
  httpMethod: method,
  headers: { origin: "https://blog.example", "x-nf-client-connection-ip": "203.0.113.9", ...extra.headers },
  queryStringParameters: extra.query || {},
  body,
});

// The participation manifest (ADR 0101) with `policy` as every passage kind's mode on the post.
const sitePolicy = (policy) => async (url) => {
  assert.equal(url, "https://blog.example/openblog-participation.json");
  const modes = Object.fromEntries(["question", "source-suggestion", "correction-suggestion", "alternative-interpretation"].map((kind) => [kind, policy]));
  return { ok: true, status: 200, json: async () => ({ "/posts/tides/": modes }) };
};

/** A fake Supabase that records requests and answers like PostgREST. */
const fakeDatabase = (answers = {}) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    let value;
    if (url.includes("openblog_consume_rate_limit")) value = answers.quota ?? { allowed: true };
    else if (url.includes("openblog_moderate_feedback")) value = answers.moderated ?? [];
    else if (options.method === "POST") value = [{ id: "00000000-0000-4000-8000-000000000009", status: "pending", received_at: "2026-10-26T10:00:00+00:00" }];
    else if (options.method === "PATCH") value = null;
    else value = answers.rows ?? [];
    return { ok: true, status: 200, json: async () => value };
  };
  return { requests, fetchImpl };
};

const noFetch = async () => assert.fail("must not reach Supabase or the site");

test("a site that has not opted in sees no change and no request is made", async () => {
  const handler = createHandler({ env: environment, fetchImpl: noFetch, siteFetchImpl: noFetch });
  for (const request of [
    event("feedback", "POST", submission()),
    event("admin/feedback", "GET", undefined, { headers: { authorization: "Bearer admin-secret" } }),
  ]) {
    const response = await handler(request);
    assert.equal(response.statusCode, 404);
    const body = JSON.parse(response.body);
    assert.equal(body.code, "unavailable");
    // A useful canonical explanation, never a backend detail.
    assert.match(body.error, /copy your note and send it to the author/);
    assert.doesNotMatch(response.body, /supabase|sb_secret|admin-secret/i);
  }
  for (const value of ["1", "yes", "TRUE ", "on"]) {
    const off = createHandler({ env: { ...environment, OPENBLOG_FEEDBACK_ENABLED: value }, fetchImpl: noFetch, siteFetchImpl: noFetch });
    assert.equal((await off(event("feedback", "POST", submission()))).statusCode, 404, value);
  }
  // Comments are untouched by the feedback switch.
  const comments = fakeDatabase();
  const commentHandler = createHandler({
    env: environment,
    fetchImpl: comments.fetchImpl,
    siteFetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ "/story/": "open" }) }),
  });
  const posted = await commentHandler(event("comments", "POST", JSON.stringify({ path: "/story/", authorName: "Mira", body: "Hi" })));
  assert.equal(posted.statusCode, 202);
  assert.ok(comments.requests.every((request) => !request.url.includes("openblog_feedback")));
});

test("a valid submission is stored pending with the receiver's time and a private name kept apart", async () => {
  const database = fakeDatabase();
  const handler = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: sitePolicy("open"), now: () => NOW });
  const response = await handler(event("feedback", "POST", submission(3)));
  assert.equal(response.statusCode, 202);
  assert.deepEqual(JSON.parse(response.body), { id: "00000000-0000-4000-8000-000000000009", status: "pending", receivedAt: "2026-10-26T10:00:00Z" });
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://blog.example");

  const [quota, insert] = database.requests;
  assert.match(quota.url, /openblog_consume_rate_limit/);
  const limits = JSON.parse(quota.options.body);
  assert.equal(limits.p_bucket, "feedback");
  assert.equal(limits.p_subject_limit, 5);
  assert.match(limits.p_subject_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(quota.options.body, /203\.0\.113\.9/);

  assert.match(insert.url, /\/rest\/v1\/openblog_feedback\?/);
  const row = JSON.parse(insert.options.body);
  const record = fixture.accepted[3].record;
  assert.deepEqual(row, {
    site_id: "lantern",
    format_version: 1,
    kind: "alternative-interpretation",
    work: "/posts/tides/",
    revision: record.provenance.revision,
    target: record.provenance.target,
    body: "Read it as irony.",
    details: {},
    seen_at: null,
    received_at: "2026-10-26T10:00:00Z",
    channel: "hosted",
    reader_name: "Grace",
    publish_name: false,
    status: "pending",
  });
  // Never through the comments table, whose author_name is published.
  assert.ok(database.requests.every((request) => !request.url.includes("openblog_comments")));
  assert.equal(Object.hasOwn(row, "author_name"), false);
});

test("the reader cannot set the time, status, channel or anything about themselves", async () => {
  const handler = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: noFetch });
  const base = JSON.parse(submission());
  for (const extra of [{ receivedAt: "2020-01-01T00:00:00Z" }, { status: "approved" }, { channel: "manual" }, { email: "ada@example.org" }, { ip: "203.0.113.9" }]) {
    const response = await handler(event("feedback", "POST", JSON.stringify({ ...base, ...extra })));
    assert.equal(response.statusCode, 422);
    assert.equal(JSON.parse(response.body).code, "malformed");
  }
  // A reader clock running ahead is dropped rather than stored.
  const database = fakeDatabase();
  const ahead = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: sitePolicy("open"), now: () => NOW });
  const response = await ahead(event("feedback", "POST", JSON.stringify({ ...base, seenAt: "2026-10-26T10:00:01Z" })));
  assert.equal(response.statusCode, 202);
  assert.equal(JSON.parse(database.requests.at(-1).options.body).seen_at, null);
});

test("every refused fixture is refused before the site or Supabase is asked, with the shared code", async () => {
  const handler = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: noFetch });
  for (const item of fixture.refused) {
    const response = await handler(event("feedback", "POST", textOf(item)));
    assert.equal(response.statusCode, 422, item.name);
    const body = JSON.parse(response.body);
    assert.equal(body.code, item.code, item.name);
    assert.equal(body.target, item.target, item.name);
  }
  const huge = await handler(event("feedback", "POST", `{"pad":"${"a".repeat(40000)}"}`));
  assert.equal(huge.statusCode, 413);
  const encoded = await handler({ ...event("feedback", "POST", Buffer.from(submission().replace('"start":27', '"start":27.0')).toString("base64")), isBase64Encoded: true });
  assert.equal(JSON.parse(encoded.body).target, "malformed");
});

test("a reader time in year 0000 is refused before the quota or Postgres, which cannot store it", async () => {
  const handler = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: noFetch, now: () => NOW });
  const value = JSON.parse(submission());
  value.seenAt = "0000-01-01T00:00:00Z";
  const response = await handler(event("feedback", "POST", JSON.stringify(value)));
  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body).code, "invalidTime");
  // The first year storage holds is still accepted.
  const database = fakeDatabase();
  const accepting = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: sitePolicy("open"), now: () => NOW });
  value.seenAt = "0001-01-01T00:00:00Z";
  assert.equal((await accepting(event("feedback", "POST", JSON.stringify(value)))).statusCode, 202);
});

test("hostile text is stored as data and never echoed", async () => {
  const database = fakeDatabase();
  const handler = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: sitePolicy("open"), now: () => NOW });
  const hostile = { ...JSON.parse(submission()), body: "<script>alert(1)</script> ' OR 1=1 --", attribution: { name: "<img src=x onerror=alert(1)>", publishName: false } };
  const response = await handler(event("feedback", "POST", JSON.stringify(hostile)));
  assert.equal(response.statusCode, 202);
  assert.doesNotMatch(response.body, /script|onerror/);
  const row = JSON.parse(database.requests.at(-1).options.body);
  assert.equal(row.body, hostile.body);
  assert.equal(row.reader_name, hostile.attribution.name);
  const refused = await handler(event("feedback", "POST", JSON.stringify({ ...hostile, body: "evil ‮ txt" })));
  assert.doesNotMatch(refused.body, /evil/);
});

test("the published feedback policy is enforced on the server", async () => {
  for (const [policy, status, code] of [["locked", 403, "closed"], ["hidden", 403, "unavailable"], ["nonsense", 403, "unavailable"]]) {
    const handler = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: sitePolicy(policy) });
    const response = await handler(event("feedback", "POST", submission()));
    assert.equal(response.statusCode, status, policy);
    assert.equal(JSON.parse(response.body).code, code, policy);
  }
  // A site that publishes neither manifest (feedback off in openblog.json) accepts nothing.
  const missing = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal((await missing(event("feedback", "POST", submission()))).statusCode, 403);
  // Each kind has its own mode: a post open for questions only refuses a suggested source.
  const kind = JSON.parse(submission()).kind;
  const perKind = createHandler({
    env: enabled,
    fetchImpl: noFetch,
    siteFetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ "/posts/tides/": { [kind === "question" ? "source-suggestion" : "question"]: "open", [kind]: "locked" } }) }),
  });
  assert.equal(JSON.parse((await perKind(event("feedback", "POST", submission()))).body).code, "closed");
  // A site built before the participation manifest still has B5's file, read only then.
  const older = [];
  const legacy = createHandler({
    env: enabled,
    fetchImpl: noFetch,
    siteFetchImpl: async (url) => {
      older.push(url);
      if (url.endsWith("openblog-participation.json")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ "/posts/tides/": "locked" }) };
    },
  });
  assert.equal(JSON.parse((await legacy(event("feedback", "POST", submission()))).body).code, "closed");
  assert.deepEqual(older, ["https://blog.example/openblog-participation.json", "https://blog.example/openblog-feedback.json"]);
  // A participation manifest that cannot be read is not a reason to read the older file.
  const failing = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: async (url) => {
    assert.ok(url.endsWith("openblog-participation.json"));
    return { ok: false, status: 500, json: async () => ({}) };
  } });
  assert.equal(JSON.parse((await failing(event("feedback", "POST", submission()))).body).code, "unavailable");
  // Another post is not open just because one is.
  const other = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: sitePolicy("open") });
  const elsewhere = JSON.stringify({ ...JSON.parse(submission()), work: "/posts/other/" });
  assert.equal((await other(event("feedback", "POST", elsewhere))).statusCode, 403);
  // The manifest is read below the site's base path.
  let requested = "";
  const based = createHandler({
    env: { ...enabled, OPENBLOG_SITE_BASE_PATH: "/journal/" },
    fetchImpl: noFetch,
    siteFetchImpl: async (url) => {
      requested = url;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await based(event("feedback", "POST", submission()));
  assert.equal(requested, "https://blog.example/journal/openblog-participation.json");
});

test("the existing quota stops a submission before it is stored, and a replay counts again", async () => {
  const limited = fakeDatabase({ quota: { allowed: false } });
  const handler = createHandler({ env: enabled, fetchImpl: limited.fetchImpl, siteFetchImpl: sitePolicy("open") });
  const response = await handler(event("feedback", "POST", submission()));
  assert.equal(response.statusCode, 429);
  assert.equal(JSON.parse(response.body).code, "rateLimited");
  assert.equal(limited.requests.length, 1);

  const database = fakeDatabase();
  const replaying = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: sitePolicy("open") });
  await replaying(event("feedback", "POST", submission()));
  await replaying(event("feedback", "POST", submission()));
  assert.equal(database.requests.filter((request) => request.url.includes("openblog_consume_rate_limit")).length, 2);
  assert.ok(database.requests.filter((request) => request.url.includes("openblog_feedback")).every((request) => JSON.parse(request.options.body).status === "pending"));
});

test("submissions need the site's origin; preflight allows only it", async () => {
  const handler = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: noFetch });
  const foreign = await handler(event("feedback", "POST", submission(), { headers: { origin: "https://evil.example" } }));
  assert.equal(foreign.statusCode, 403);
  const missing = await handler({ ...event("feedback", "POST", submission()), headers: {} });
  assert.equal(missing.statusCode, 403);
  const preflight = await handler(event("feedback", "OPTIONS"));
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], "https://blog.example");
  assert.equal((await handler(event("feedback", "OPTIONS", undefined, { headers: { origin: "https://evil.example" } }))).statusCode, 403);
});

test("moderation needs the server-held token and returns the record the build reads", async () => {
  const database = fakeDatabase({ rows: [fixture.storedRow] });
  const handler = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: noFetch, now: () => NOW });
  for (const authorization of [undefined, "Bearer admin-secreT", "Bearer admin-secret-longer", "admin-secret ", "Bearer "]) {
    const denied = await handler(event("admin/feedback", "GET", undefined, { headers: authorization ? { authorization } : {} }));
    assert.equal(denied.statusCode, 401, String(authorization));
    const change = await handler(event("admin/feedback", "PATCH", JSON.stringify({ id: fixture.storedRow.id, status: "approved" }), { headers: authorization ? { authorization } : {} }));
    assert.equal(change.statusCode, 401, String(authorization));
  }
  assert.equal(database.requests.length, 0);

  const admin = { authorization: "Bearer admin-secret" };
  const listed = await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { status: "pending", kind: "source-suggestion" } }));
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(JSON.parse(listed.body), { feedback: [fixture.hostedItem] });
  const url = new URL(database.requests.at(-1).url);
  assert.equal(url.searchParams.get("site_id"), "eq.lantern");
  assert.equal(url.searchParams.get("status"), "eq.pending");
  assert.equal(url.searchParams.get("kind"), "eq.source-suggestion");
  for (const status of ["approved", "rejected", "bogus"]) {
    await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { status } }));
    assert.equal(new URL(database.requests.at(-1).url).searchParams.get("status"), `eq.${status === "bogus" ? "pending" : status}`);
  }
  assert.equal((await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { kind: "constructor" } }))).statusCode, 422);

  for (const status of ["clarification", "removed", "withdrawn"]) {
    await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { status } }));
    assert.equal(new URL(database.requests.at(-1).url).searchParams.get("status"), `eq.${status}`);
  }
  // One item by id, whatever its state.
  const one = await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { id: fixture.storedRow.id.toUpperCase(), status: "approved" } }));
  assert.equal(one.statusCode, 200);
  const byId = new URL(database.requests.at(-1).url);
  assert.equal(byId.searchParams.get("id"), `eq.${fixture.storedRow.id}`);
  assert.equal(byId.searchParams.get("status"), null);
  assert.equal((await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { id: "1 or 1=1" } }))).statusCode, 422);
});

test("a moderation change names the state and version seen and is applied with its audit event in one statement", async () => {
  const approvedRow = { ...fixture.storedRow, status: "approved", version: 2, moderated_at: "2026-10-26T10:00:00+00:00" };
  const database = fakeDatabase({ moderated: [approvedRow] });
  const handler = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: noFetch, now: () => NOW });
  const admin = { authorization: "Bearer admin-secret" };
  const change = { id: fixture.storedRow.id, action: "approve", from: "pending", expectedVersion: 1, actor: "writer" };
  const changed = await handler(event("admin/feedback", "PATCH", JSON.stringify(change), { headers: admin }));
  assert.equal(changed.statusCode, 200);
  const result = JSON.parse(changed.body);
  assert.equal(result.ok, true);
  assert.equal(result.item.status, "approved");
  assert.equal(result.item.version, 2);
  assert.equal(result.item.moderatedAt, "2026-10-26T10:00:00Z");
  const request = database.requests.at(-1);
  assert.match(request.url, /\/rest\/v1\/rpc\/openblog_moderate_feedback$/);
  assert.deepEqual(JSON.parse(request.options.body), {
    p_site_id: "lantern",
    p_id: fixture.storedRow.id,
    p_expected_version: 1,
    p_from: "pending",
    p_to: "approved",
    p_action: "approve",
    p_reason: null,
    p_actor: "writer",
    p_at: "2026-10-26T10:00:00Z",
  });
  // A rejection carries its reason code; an unknown actor is recorded as the token.
  await handler(event("admin/feedback", "PATCH", JSON.stringify({ ...change, action: "reject", reason: "off-topic", actor: "<b>x</b>" }), { headers: admin }));
  const rejection = JSON.parse(database.requests.at(-1).options.body);
  assert.equal(rejection.p_to, "rejected");
  assert.equal(rejection.p_reason, "off-topic");
  assert.equal(rejection.p_actor, "@moderation-token");

  // Refused before the database: a bad id or version, an unknown state, a
  // transition the rules do not list, or a missing or unknown reason.
  const before = database.requests.length;
  for (const bad of [
    { ...change, id: "1; drop table" },
    { ...change, expectedVersion: 0 },
    { ...change, expectedVersion: "1" },
    { ...change, expectedVersion: 1.5 },
    { ...change, from: "bogus" },
    { ...change, from: "approved" },
    { ...change, action: "delete" },
    { ...change, action: "reject" },
    { ...change, action: "reject", reason: "incorrect" },
    { ...change, reason: "spam" },
    { id: fixture.storedRow.id, status: "approved" },
  ]) {
    const refused = await handler(event("admin/feedback", "PATCH", JSON.stringify(bad), { headers: admin }));
    assert.equal(refused.statusCode, 422, JSON.stringify(bad));
  }
  assert.equal(database.requests.length, before);
});

test("with the inbox's schema switched on, B5's /admin/feedback answers exactly as v0.33.0 did", async () => {
  // A v0.33.0 Admin refuses any field it does not know, so the inbox's facts never reach this route.
  const facts = { item_revision: 2, approved_revision: 2, clarification_asked: 1, clarification_consent: true };
  const stored = { ...fixture.storedRow, ...facts };
  const database = fakeDatabase({ rows: [stored], moderated: [{ ...stored, status: "approved", version: 2, moderated_at: "2026-10-26T10:00:00+00:00" }] });
  const handler = createHandler({ env: { ...enabled, OPENBLOG_MODERATION_ENABLED: "true" }, fetchImpl: database.fetchImpl, siteFetchImpl: noFetch, now: () => NOW });
  const admin = { authorization: "Bearer admin-secret" };
  const keys = Object.keys(fixture.hostedItem).sort();
  const listed = await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { status: "pending" } }));
  assert.deepEqual(JSON.parse(listed.body), { feedback: [fixture.hostedItem] });
  assert.equal(new URL(database.requests.at(-1).url).searchParams.get("select").includes("item_revision"), false);
  const one = JSON.parse((await handler(event("admin/feedback", "GET", undefined, { headers: admin, query: { id: fixture.storedRow.id } }))).body);
  assert.deepEqual(Object.keys(one.feedback[0]).sort(), keys);
  const changed = await handler(event("admin/feedback", "PATCH", JSON.stringify({ id: fixture.storedRow.id, action: "approve", from: "pending", expectedVersion: 1 }), { headers: admin }));
  assert.equal(changed.statusCode, 200, changed.body);
  assert.match(database.requests.at(-1).url, /openblog_moderate_feedback_item$/);
  const { item } = JSON.parse(changed.body);
  assert.deepEqual(Object.keys(item).sort(), keys);
  assert.deepEqual(Object.keys(item.feedback).sort(), Object.keys(fixture.hostedItem.feedback).sort());
  // A conflict carries the item in the same shape.
  const moved = createHandler({ env: { ...enabled, OPENBLOG_MODERATION_ENABLED: "true" }, fetchImpl: fakeDatabase({ rows: [stored], moderated: [] }).fetchImpl, siteFetchImpl: noFetch, now: () => NOW });
  const conflict = JSON.parse((await moved(event("admin/feedback", "PATCH", JSON.stringify({ id: fixture.storedRow.id, action: "approve", from: "pending", expectedVersion: 1 }), { headers: admin }))).body);
  assert.equal(conflict.code, "conflict");
  assert.deepEqual(Object.keys(conflict.item).sort(), keys);
  // The inbox reads the same row with its facts.
  const inbox = JSON.parse((await handler({ ...event("admin/moderation", "GET", undefined, { headers: admin, query: { id: fixture.storedRow.id, source: "feedback" } }) })).body);
  assert.deepEqual(
    [inbox.items[0].itemRevision, inbox.items[0].approvedRevision, inbox.items[0].clarificationAsked, inbox.items[0].clarificationConsent],
    [2, 2, 1, true],
  );
});

test("a change to an item that moved meanwhile is a conflict carrying the item as it is now", async () => {
  const current = { ...fixture.storedRow, status: "rejected", version: 2, moderation_reason: "spam", moderated_at: "2026-10-26T09:59:00+00:00" };
  const database = fakeDatabase({ moderated: [], rows: [current] });
  const handler = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: noFetch, now: () => NOW });
  const admin = { authorization: "Bearer admin-secret" };
  const response = await handler(event("admin/feedback", "PATCH", JSON.stringify({ id: fixture.storedRow.id, action: "approve", from: "pending", expectedVersion: 1 }), { headers: admin }));
  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body);
  assert.equal(body.code, "conflict");
  assert.equal(body.item.status, "rejected");
  assert.equal(body.item.reason, "spam");
  assert.equal(body.item.version, 2);
  const missing = createHandler({ env: enabled, fetchImpl: fakeDatabase({ moderated: [], rows: [] }).fetchImpl, siteFetchImpl: noFetch, now: () => NOW });
  const gone = await missing(event("admin/feedback", "PATCH", JSON.stringify({ id: fixture.storedRow.id, action: "approve", from: "pending", expectedVersion: 1 }), { headers: admin }));
  assert.equal(gone.statusCode, 404);
  assert.equal(JSON.parse(gone.body).code, "notFound");
});

test("the function's moderation rules are the shared fixture's", () => {
  assert.deepEqual([...MODERATION_STATES], moderationFixture.rules.states);
  assert.deepEqual(JSON.parse(JSON.stringify(MODERATION_ACTIONS)), moderationFixture.rules.actions);
  for (const item of moderationFixture.cases) {
    const outcome = planModeration(item.from, item.action, item.reason);
    if (item.refused) {
      assert.equal(outcome.ok, false, JSON.stringify(item));
      assert.equal(outcome.code, item.refused, JSON.stringify(item));
    } else {
      assert.equal(outcome.ok, true, JSON.stringify(item));
      assert.equal(outcome.change.to, item.to);
      assert.equal(outcome.change.reason, item.reason ?? null);
    }
  }
  // Any Admin account name is recorded as it is (valid_admin_username), and nothing else.
  for (const good of ["writer.one", "_ops", ".x", "-", "a".repeat(32)]) assert.equal(auditActor(good), good);
  for (const bad of ["", " writer", "a".repeat(33), "x y", "Writer", "@moderation-token", null, 7]) assert.equal(auditActor(bad), "@moderation-token");
});

test("provider failures are reported without detail and change nothing else", async () => {
  const failing = createHandler({
    env: enabled,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ message: "relation openblog_feedback does not exist", hint: "sb_secret_test_server_only" }) }),
    siteFetchImpl: sitePolicy("open"),
  });
  const response = await failing(event("feedback", "POST", submission()));
  assert.equal(response.statusCode, 502);
  assert.doesNotMatch(response.body, /relation|sb_secret|openblog_feedback/);
  const unreachable = createHandler({ env: enabled, fetchImpl: noFetch, siteFetchImpl: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1"); } });
  const down = await unreachable(event("feedback", "POST", submission()));
  assert.equal(down.statusCode, 502);
  assert.doesNotMatch(down.body, /ECONNREFUSED|10\.0\.0\.1/);
});

// The SQL the function relies on: an additive, private table whose columns
// match what the function writes and reads, and a rollback that touches
// nothing else.
const columns = (() => {
  const body = migration.slice(migration.indexOf("create table if not exists public.openblog_feedback ("), migration.indexOf("\n);"));
  return new Set(body.split("\n").slice(1).map((line) => line.trim().match(/^([a-z_]+) (?:uuid|text|integer|jsonb|timestamptz|boolean)\b/)?.[1]).filter(Boolean));
})();

test("the migration is additive, private, and matches what the function writes and reads", async () => {
  const database = fakeDatabase();
  const handler = createHandler({ env: enabled, fetchImpl: database.fetchImpl, siteFetchImpl: sitePolicy("open"), now: () => NOW });
  await handler(event("feedback", "POST", submission(1)));
  const written = Object.keys(JSON.parse(database.requests.at(-1).options.body));
  for (const column of written) assert.ok(columns.has(column), `missing column ${column}`);
  for (const column of Object.keys(fixture.storedRow)) assert.ok(columns.has(column), `missing column ${column}`);

  const statements = migration.replace(/--[^\n]*/g, "").toLowerCase();
  // The one change to something that exists is a check it loosens, for suggestions (ADR 0154).
  const loosening = "alter table public.openblog_feedback drop constraint if exists openblog_feedback_passage_complete;";
  assert.equal(statements.split(loosening).length, 2);
  assert.doesNotMatch(statements.replace(loosening, ""), /\bdrop\b/);
  for (const forbidden of [/\balter\s+table\s+(?!public\.openblog_feedback(?:_events)?\b)/, /\brename\b/, /\bdelete\s+from\b/, /\btruncate\b/, /openblog_comments/, /create\s+or\s+replace\s+function\s+(?!public\.openblog_(?:moderate_feedback(?:_item)?|erase_feedback|record_feedback_decision|feedback_purge_evidence|moderate_third_perspective)\()/]) {
    assert.doesNotMatch(statements, forbidden);
  }
  // The only updates are the moderation functions', of the feedback table
  // (ADR 0083, and the inbox's, ADR 0106), the deletion function's (ADR 0108)
  // the correction decision function's (ADR 0117) and
  // Third Perspectives' (ADR 0113).
  assert.deepEqual(statements.match(/\bupdate\s+public\.[a-z_]+/g), Array(5).fill("update public.openblog_feedback"));
  assert.match(statements, /create table if not exists public\.openblog_feedback/);
  assert.match(statements, /alter table public\.openblog_feedback enable row level security/);
  // service_role is revoked too, so Supabase's default DELETE and TRUNCATE
  // grants go and only the three operations the function needs remain.
  assert.match(statements, /revoke all on public\.openblog_feedback from public, anon, authenticated, service_role;\s*grant select, insert, update on public\.openblog_feedback to service_role;/);
  assert.doesNotMatch(statements, /grant[^;]*\b(anon|authenticated)\b/);
  assert.doesNotMatch(statements, /create policy/);
  // Pending by default; the reader's name is a separate, optional column.
  assert.match(statements, /status text not null default 'pending'/);
  assert.match(statements, /reader_name text check/);
  assert.match(statements, /publish_name boolean not null default false/);
  // Moderation (ADR 0083): a version for every change, a reason code, an
  // insert-only audit table and one function the public roles cannot run.
  assert.match(statements, /version integer not null default 1 check \(version >= 1\)/);
  assert.match(statements, /moderation_reason text check/);
  assert.match(statements, /create table if not exists public\.openblog_feedback_events/);
  assert.match(statements, /alter table public\.openblog_feedback_events enable row level security/);
  assert.match(statements, /revoke all on public\.openblog_feedback_events from public, anon, authenticated, service_role;\s*grant select, insert on public\.openblog_feedback_events to service_role;/);
  assert.match(statements, /and status = p_from\s+and version = p_expected_version/);
  assert.match(statements, /insert into public\.openblog_feedback_events/);
  assert.match(statements, /revoke all on function public\.openblog_moderate_feedback\([^)]*\) from public, anon, authenticated;\s*grant execute on function public\.openblog_moderate_feedback\([^)]*\) to service_role;/);
  assert.doesNotMatch(statements, /security definer/);
  // Fresh installs without the feature are unchanged.
  assert.doesNotMatch(baseSchema, /openblog_feedback/);

  const undo = rollback.replace(/--[^\n]*/g, "").toLowerCase();
  assert.deepEqual(undo.match(/\bdrop\b[^;]*;/g), [
    "drop function if exists public.openblog_record_feedback_decision(text, uuid, integer, integer, jsonb, text, text, timestamptz);",
    "drop trigger if exists openblog_feedback_purge_evidence on public.openblog_feedback;",
    "drop function if exists public.openblog_feedback_purge_evidence();",
    "drop function if exists public.openblog_moderate_third_perspective(text, uuid, integer, text, text, text, text, text, text, timestamptz, integer);",
    "drop function if exists public.openblog_erase_feedback(text, uuid, integer, boolean, text, text, timestamptz);",
    "drop function if exists public.openblog_moderate_feedback_item(text, uuid, integer, text, text, text, text, text, text, timestamptz, text, jsonb);",
    "drop function if exists public.openblog_moderate_feedback(text, uuid, integer, text, text, text, text, text, timestamptz);",
    "drop table if exists public.openblog_feedback_events;",
    "drop table if exists public.openblog_feedback;",
  ]);
  assert.doesNotMatch(undo, /openblog_comments|openblog_rate_limits|openblog_daily/);
});
