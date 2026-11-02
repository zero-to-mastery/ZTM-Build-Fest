// Engagement protection (#226, ADRs 0107 and 0108), exercised through HTTP-shaped events with a
// fake Supabase and site: the shared protection fixture, reader receipts (read, agree to be asked,
// clarify, withdraw and delete), abuse reports that fail closed, upholding a report with the item
// it names, deletion requests by the site Admin, the retention job's dry run and run, hourly quota
// digests that store no address or cross-day identifier, replay bounds, origin and token checks,
// malformed JSON, provider failures and a disabled service, and the additive SQL with its rollback.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import { planErasure, planUphold, retentionStep } from "../../netlify/lib/participation-moderation.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const protection = JSON.parse(read("../fixtures/participation-protection.json"));
const scholarly = JSON.parse(read("../fixtures/scholarly-feedback.json"));
const protectionSql = read("../../supabase/protection.sql");
const protectionRollback = read("../../supabase/protection-rollback.sql");
const feedbackSql = read("../../supabase/feedback.sql");
const baseSchema = read("../../supabase/openblog.sql");

const SECRET = "sb_secret_test_server_only";
const environment = {
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: SECRET,
  OPENBLOG_SITE_ID: "lantern",
  OPENBLOG_SITE_ORIGIN: "https://blog.example",
  OPENBLOG_ADMIN_API_KEY: "admin-secret",
  OPENBLOG_ANALYTICS_SALT: "daily-hash-secret",
  OPENBLOG_FEEDBACK_ENABLED: "true",
  OPENBLOG_MODERATION_ENABLED: "true",
};
const protectedEnv = { ...environment, OPENBLOG_PROTECTION_ENABLED: "true" };
const NOW = new Date("2026-10-27T10:00:00.000Z");
const ADMIN = { authorization: "Bearer admin-secret" };
const ORIGIN = { origin: "https://blog.example" };
const ADDRESS = "203.0.113.9";
const AGENT = "Mozilla/5.0 (Test Browser) Fingerprint/1.0";
const RECEIPT = "A".repeat(43);
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const event = (path, method, { query = {}, body, headers = {} } = {}) => ({
  path: `/api/${path}`,
  httpMethod: method,
  headers: { "x-nf-client-connection-ip": ADDRESS, "user-agent": AGENT, ...headers },
  queryStringParameters: query,
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

const feedbackRow = (extra = {}) => ({
  ...scholarly.storedRow, id: ID(1), version: 1, item_revision: 1, approved_revision: null, clarification_asked: null,
  clarification_consent: false, purged_at: null, ...extra,
});
const commentRow = (extra = {}) => ({
  id: ID(2), path: "/posts/tides/", author_name: "Grace", body: "A comment.", status: "approved", created_at: "2026-10-20T10:00:00+00:00",
  moderated_at: "2026-10-21T10:00:00+00:00", version: 2, moderation_state: "approved", moderation_reason: null, purged_at: null, ...extra,
});
const reportRow = (extra = {}) => ({
  id: ID(3), target_source: "comment", target_id: ID(2), work: "/posts/tides/", ground: "abusive", body: "This is abuse.", status: "pending",
  version: 1, received_at: "2026-10-26T10:00:00+00:00", moderated_at: null, moderation_reason: null, purged_at: null, ...extra,
});

/** A fake Supabase that records every request and answers through `answer`. */
const fakeDatabase = (answer = () => []) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const request = { url, path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
    requests.push(request);
    if (request.path.endsWith("/rpc/openblog_consume_rate_limit")) {
      const value = await answer(request);
      return { ok: true, status: 200, json: async () => (value && typeof value === "object" && !Array.isArray(value) && "allowed" in value ? value : { allowed: true }) };
    }
    const value = await answer(request);
    if (value instanceof Error) return { ok: false, status: 500, json: async () => ({ message: `boom ${SECRET}` }) };
    return { ok: true, status: 200, json: async () => value };
  };
  return { requests, fetchImpl };
};
// The site's participation manifest, with abuse reports open and questions open on the post.
const site = (modes = { "abuse-report": "open", "source-suggestion": "open", question: "open" }, comments = "open") => async (url) => {
  if (url.endsWith("openblog-participation.json")) return { ok: true, status: 200, json: async () => ({ "/posts/tides/": modes }) };
  if (url.endsWith("openblog-comments.json")) return { ok: true, status: 200, json: async () => ({ "/posts/tides/": comments }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const handlerFor = (env, database, { siteFetch = site(), now = () => NOW } = {}) => createHandler({ env, fetchImpl: database.fetchImpl, siteFetchImpl: siteFetch, now });
const writes = (database) => database.requests.filter((request) => request.method !== "GET" && !request.path.endsWith("/rpc/openblog_consume_rate_limit"));

// ---- The shared fixture

test("every retention, deletion and upholding case of the shared fixture agrees with the function", () => {
  assert.ok(protection.retention.length > 200 && protection.erasure.length > 150 && protection.uphold.length > 50);
  for (const expected of protection.retention) {
    const cutoffs = protection.cutoffs[expected.comments ? "withComments" : "withoutComments"];
    const step = retentionStep({ kind: expected.kind, state: expected.state, since: expected.since, retained: expected.retained }, cutoffs);
    assert.equal(step, expected.step, JSON.stringify(expected));
  }
  for (const expected of protection.erasure) {
    const plan = planErasure({ kind: expected.kind, state: expected.state, version: 3, retained: expected.retained }, expected.role, expected.expectedVersion ?? 3);
    if (expected.refused) assert.deepEqual(plan, { ok: false, code: expected.refused }, JSON.stringify(expected));
    else assert.deepEqual(plan, { ok: true, withdraw: expected.withdraw, to: expected.to, version: expected.version }, JSON.stringify(expected));
  }
  for (const expected of protection.uphold) {
    const target = expected.target === "missing" ? null : { id: expected.target === "other" ? ID(1) : ID(2), state: expected.target === "other" ? "approved" : expected.target, version: 5 };
    const plan = planUphold({ kind: "abuse-report", state: expected.state, version: 3, parent: ID(2), retained: true }, target, { role: expected.role, reason: expected.reason, expectedVersion: 3 });
    if (expected.refused) assert.deepEqual(plan, { ok: false, code: expected.refused }, JSON.stringify(expected));
    else {
      assert.ok(plan.ok, JSON.stringify(expected));
      assert.equal(plan.change.to, expected.to);
      assert.equal(plan.removal?.to ?? null, expected.targetTo, JSON.stringify(expected));
    }
  }
});

// ---- Privacy of what is stored

test("no raw address, user agent or identifier that outlives an hour is stored", async () => {
  const hours = ["2026-10-27T10:15:00.000Z", "2026-10-27T11:15:00.000Z", "2026-10-28T10:15:00.000Z"];
  const subjects = [];
  const visitors = [];
  for (const time of hours) {
    const database = fakeDatabase((request) => (request.method === "POST" && request.path.endsWith("/openblog_comments") ? [{ id: ID(9), status: "pending" }] : request.path.includes("rpc/openblog_record_view") ? { views: 1 } : []));
    const handler = handlerFor(protectedEnv, database, { now: () => new Date(time) });
    await handler(event("comments", "POST", { headers: ORIGIN, body: { path: "/posts/tides/", authorName: "Grace", body: "Hello." } }));
    await handler(event("hit", "POST", { headers: ORIGIN, body: { path: "/posts/tides/" } }));
    for (const request of database.requests) {
      const text = JSON.stringify(request.body ?? {}) + request.url;
      assert.doesNotMatch(text, new RegExp(ADDRESS.replaceAll(".", "\\.")), "the address is never sent to the database");
      assert.doesNotMatch(text, /Mozilla|Fingerprint/, "nor the user agent");
    }
    subjects.push(database.requests.filter((request) => request.path.endsWith("/rpc/openblog_consume_rate_limit")).map((request) => request.body.p_subject_hash));
    visitors.push(database.requests.find((request) => request.path.endsWith("/rpc/openblog_record_view")).body.p_visitor_hash);
  }
  // Every quota digest differs from one hour to the next, so none links them; the daily visitor
  // digest counts uniques within a day and changes with the day.
  const flat = subjects.flat();
  assert.equal(new Set(flat).size, flat.length);
  assert.equal(visitors[0], visitors[1]);
  assert.notEqual(visitors[1], visitors[2]);
  assert.ok(visitors.every((visitor) => !flat.includes(visitor)));
  // The quota digest is not the address's plain hash either.
  assert.ok(!flat.includes(createHash("sha256").update(ADDRESS).digest("hex")));
});

test("service credentials never reach a response, whatever fails", async () => {
  const failing = handlerFor(protectedEnv, fakeDatabase(() => new Error("down")));
  const responses = [
    await failing(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT } })),
    await failing(event("reports", "POST", { headers: ORIGIN, body: { source: "comment", id: ID(2), ground: "spam" } })),
    await failing(event("admin/retention", "GET", { headers: ADMIN, query: protection.cutoffs.withoutComments })),
    await failing(event("admin/moderation", "PATCH", { headers: ADMIN, body: { source: "report", id: ID(3), action: "uphold-report", from: "pending", expectedVersion: 1, reason: "abusive" } })),
  ];
  for (const response of responses) {
    assert.equal(response.statusCode, 502);
    assert.doesNotMatch(response.body, /sb_secret|admin-secret|daily-hash-secret|boom|database\.example/);
  }
});

// ---- Disabled service, origin and malformed requests

test("without the protection schema nothing new is reachable, and the rest works as before", async () => {
  const database = fakeDatabase(() => assert.fail("must not reach Supabase"));
  for (const env of [environment, { ...environment, OPENBLOG_MODERATION_ENABLED: "", OPENBLOG_PROTECTION_ENABLED: "true" }]) {
    const handler = handlerFor(env, database);
    for (const path of ["receipt", "reports"]) {
      const response = await handler(event(path, "POST", { headers: ORIGIN, body: { receipt: RECEIPT } }));
      assert.equal(response.statusCode, 404);
      assert.equal(JSON.parse(response.body).code, "unavailable");
    }
    const retention = await handler(event("admin/retention", "GET", { headers: ADMIN, query: protection.cutoffs.withoutComments }));
    assert.equal(retention.statusCode, 404);
  }
  // Not configured at all: the same short answer as before.
  const unconfigured = createHandler({ env: {}, fetchImpl: database.fetchImpl, siteFetchImpl: database.fetchImpl });
  assert.equal((await unconfigured(event("receipt", "POST", { headers: ORIGIN, body: {} }))).statusCode, 503);
  // A feedback submission without protection gets no receipt and stores no digest.
  const plain = fakeDatabase((request) => (request.method === "POST" && request.path.endsWith("/openblog_feedback") ? [{ id: ID(1), status: "pending" }] : []));
  const response = await handlerFor(environment, plain)(event("feedback", "POST", { headers: ORIGIN, body: scholarly.accepted[0].text ?? JSON.stringify(scholarly.accepted[0].submission) }));
  assert.equal(response.statusCode, 202);
  assert.equal(JSON.parse(response.body).receipt, undefined);
  assert.equal(writes(plain).at(-1).body.receipt_hash, undefined);
});

test("reader routes need the site's origin, valid JSON and POST", async () => {
  const database = fakeDatabase(() => assert.fail("must not reach Supabase"));
  const handler = handlerFor(protectedEnv, database);
  for (const path of ["receipt", "reports"]) {
    assert.equal((await handler(event(path, "POST", { body: { receipt: RECEIPT } }))).statusCode, 403);
    assert.equal((await handler(event(path, "POST", { headers: { origin: "https://evil.example" }, body: {} }))).statusCode, 403);
    assert.equal((await handler(event(path, "POST", { headers: ORIGIN, body: "{not json" }))).statusCode, 400);
    assert.equal((await handler(event(path, "GET", { headers: ORIGIN }))).statusCode, 405);
  }
  const preflight = await handler(event("receipt", "OPTIONS", { headers: { origin: "https://evil.example" } }));
  assert.equal(preflight.statusCode, 403);
  // Admin routes need the token, compared in constant time; nothing is asked of Supabase without it.
  for (const authorization of [undefined, "Bearer admin-secreT", "Bearer admin-secret-longer", "admin-secret "]) {
    const headers = authorization ? { authorization } : {};
    assert.equal((await handler(event("admin/retention", "GET", { headers, query: protection.cutoffs.withoutComments }))).statusCode, 401);
    assert.equal((await handler(event("admin/retention", "POST", { headers: { ...headers, ...ORIGIN }, body: {} }))).statusCode, 401);
  }
});

// ---- Receipts

test("a submission returns its receipt once and keeps only the receipt's digest", async () => {
  const database = fakeDatabase((request) => (request.method === "POST" && request.path.endsWith("/openblog_feedback") ? [{ id: ID(1), status: "pending" }] : []));
  const handler = handlerFor(protectedEnv, database);
  const response = await handler(event("feedback", "POST", { headers: ORIGIN, body: JSON.stringify(scholarly.accepted[0].submission) }));
  assert.equal(response.statusCode, 202);
  const { receipt } = JSON.parse(response.body);
  assert.match(receipt, /^[A-Za-z0-9_-]{43}$/);
  const insert = writes(database).at(-1);
  assert.equal(insert.body.receipt_hash, createHash("sha256").update(receipt).digest("hex"));
  assert.doesNotMatch(JSON.stringify(database.requests), new RegExp(receipt));
  // The same note again from the same place within the hour is a replay: refused, nothing stored.
  const replaying = fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_consume_rate_limit") ? { allowed: request.body.p_bucket !== "feedback-repeat" } : []));
  const replay = await handlerFor(protectedEnv, replaying)(event("feedback", "POST", { headers: ORIGIN, body: JSON.stringify(scholarly.accepted[0].submission) }));
  assert.equal(replay.statusCode, 409);
  assert.equal(JSON.parse(replay.body).code, "duplicate");
  assert.equal(writes(replaying).length, 0);
});

test("a receipt reads its own note, and an unknown or malformed one learns nothing", async () => {
  const digest = createHash("sha256").update(RECEIPT).digest("hex");
  const database = fakeDatabase((request) => (request.params.receipt_hash === `eq.${digest}` ? [feedbackRow({ status: "clarification", clarification_asked: 1, moderation_reason: "unclear", clarification_consent: true })] : []));
  const handler = handlerFor(protectedEnv, database);
  const found = await handler(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT } }));
  assert.equal(found.statusCode, 200);
  const { item } = JSON.parse(found.body);
  assert.deepEqual(
    { status: item.status, version: item.version, clarification: item.clarification, consent: item.consent, purged: item.purged, body: item.body },
    { status: "clarification", version: 1, clarification: { reason: "unclear" }, consent: true, purged: false, body: scholarly.storedRow.body },
  );
  assert.equal(item.readerName, undefined);
  assert.doesNotMatch(found.body, /Ada Lovelace/, "the reader's name is not echoed back");
  const unknown = [];
  for (const receipt of ["B".repeat(43), "short", "A".repeat(42) + "=", 42, null]) {
    const response = await handler(event("receipt", "POST", { headers: ORIGIN, body: { receipt } }));
    unknown.push([response.statusCode, response.body]);
  }
  assert.equal(new Set(unknown.map(([status, body]) => `${status}${body}`)).size, 1, "every miss answers the same");
  assert.equal(unknown[0][0], 404);
  // Receipt lookups have their own quota.
  const flooded = handlerFor(protectedEnv, fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_consume_rate_limit") ? { allowed: false } : assert.fail("no lookup"))));
  assert.equal((await flooded(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT } }))).statusCode, 429);
});

test("a receipt answers a clarification request as a new revision checked like a submission", async () => {
  const waiting = feedbackRow({ status: "clarification", version: 2, clarification_asked: 1, clarification_consent: true });
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("/rpc/openblog_moderate_feedback_item")) return [{ ...waiting, status: "pending", version: 3, item_revision: 2, body: request.body.p_body }];
    return [waiting];
  });
  const handler = handlerFor(protectedEnv, database);
  const response = await handler(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "clarify", expectedVersion: 2, body: "  A clearer note.  ", details: { sourceUrl: "https://example.org/better" } } }));
  assert.equal(response.statusCode, 200, response.body);
  const call = writes(database).at(-1);
  assert.equal(call.path, "/rest/v1/rpc/openblog_moderate_feedback_item");
  assert.deepEqual(
    { action: call.body.p_action, from: call.body.p_from, to: call.body.p_to, body: call.body.p_body, details: call.body.p_details, actor: call.body.p_actor, role: call.body.p_actor_role },
    { action: "clarify", from: "clarification", to: "pending", body: "A clearer note.", details: { sourceUrl: "https://example.org/better" }, actor: "@reader", role: "submitter" },
  );
  assert.equal(JSON.parse(response.body).item.status, "pending");
  // Text the submission rules refuse is refused here too, before anything is written.
  const before = writes(database).length;
  for (const body of ["", "x".repeat(20_001), "bidi ‮ text"]) {
    const refused = await handler(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "clarify", expectedVersion: 2, body } }));
    assert.equal(refused.statusCode, 422);
  }
  // A stale view, or a note nobody asked about, changes nothing.
  assert.equal((await handler(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "clarify", expectedVersion: 1, body: "Late." } }))).statusCode, 409);
  const pending = handlerFor(protectedEnv, fakeDatabase(() => [feedbackRow()]));
  assert.equal((await pending(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "clarify", expectedVersion: 1, body: "Unasked." } }))).statusCode, 422);
  assert.equal(writes(database).length, before);
});

test("a receipt agrees to be asked only while the note waits, conditionally", async () => {
  const database = fakeDatabase((request) => (request.method === "PATCH" ? [feedbackRow({ clarification_consent: true })] : [feedbackRow()]));
  const handler = handlerFor(protectedEnv, database);
  const response = await handler(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "consent", consent: true, expectedVersion: 1 } }));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).item.consent, true);
  const patch = writes(database).at(-1);
  assert.deepEqual(patch.body, { clarification_consent: true });
  assert.equal(patch.params.status, "eq.pending");
  assert.equal(patch.params.version, "eq.1");
  assert.equal(patch.params.purged_at, "is.null");
  const approved = handlerFor(protectedEnv, fakeDatabase(() => [feedbackRow({ status: "approved", approved_revision: 1 })]));
  assert.equal((await approved(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "consent", consent: true, expectedVersion: 1 } }))).statusCode, 422);
  assert.equal((await handler(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "consent", consent: "yes", expectedVersion: 1 } }))).statusCode, 422);
});

test("withdrawing by receipt deletes the text and name and keeps only the record", async () => {
  for (const [status, withdraw] of [["approved", true], ["pending", true], ["rejected", false]]) {
    const row = feedbackRow({ status, approved_revision: status === "approved" ? 1 : null, version: 4 });
    const database = fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_erase_feedback")
      ? [{ ...row, status: withdraw ? "withdrawn" : status, version: withdraw ? 6 : 5, body: "-", details: {}, reader_name: null, publish_name: false, purged_at: "2026-10-27T10:00:00+00:00" }]
      : [row]));
    const response = await handlerFor(protectedEnv, database)(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "withdraw", expectedVersion: 4 } }));
    assert.equal(response.statusCode, 200, response.body);
    const call = writes(database).at(-1);
    assert.deepEqual(
      { withdraw: call.body.p_withdraw, version: call.body.p_expected_version, actor: call.body.p_actor, role: call.body.p_actor_role },
      { withdraw, version: 4, actor: "@reader", role: "submitter" },
    );
    const { item } = JSON.parse(response.body);
    assert.equal(item.purged, true);
    assert.equal(item.body, undefined);
    assert.doesNotMatch(response.body, /Ada Lovelace|This survey/);
  }
  // Already deleted: nothing more to do.
  const gone = handlerFor(protectedEnv, fakeDatabase(() => [feedbackRow({ status: "withdrawn", purged_at: "2026-10-27T09:00:00+00:00", version: 3 })]));
  const again = await gone(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "withdraw", expectedVersion: 3 } }));
  assert.equal(again.statusCode, 422);
  assert.equal(JSON.parse(again.body).code, "contentPurged");
  // Two tabs racing: the database refuses the second, which is shown the note as it is now.
  let reads = 0;
  const racing = fakeDatabase((request) => {
    if (request.path.endsWith("/rpc/openblog_erase_feedback")) return [];
    reads += 1;
    return [reads === 1 ? feedbackRow({ version: 4 }) : feedbackRow({ status: "withdrawn", version: 6, purged_at: "2026-10-27T10:00:00+00:00" })];
  });
  const raced = await handlerFor(protectedEnv, racing)(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "withdraw", expectedVersion: 4 } }));
  assert.equal(raced.statusCode, 409);
  assert.equal(JSON.parse(raced.body).item.status, "withdrawn");
});

// ---- Abuse reports

test("an abuse report is taken only for an item that is public now, and names nobody", async () => {
  const database = fakeDatabase((request) => (request.path.endsWith("/openblog_comments") ? [commentRow()] : []));
  const handler = handlerFor(protectedEnv, database);
  const response = await handler(event("reports", "POST", { headers: ORIGIN, body: { source: "comment", id: ID(2).toUpperCase(), ground: "abusive", body: "  Insults.  " } }));
  assert.equal(response.statusCode, 202);
  assert.deepEqual(JSON.parse(response.body), { status: "pending" });
  const insert = writes(database).find((request) => request.path.endsWith("/openblog_abuse_reports"));
  assert.deepEqual(insert.body, { site_id: "lantern", target_source: "comment", target_id: ID(2), work: "/posts/tides/", ground: "abusive", body: "Insults.", status: "pending", received_at: "2026-10-27T10:00:00Z" });

  // Missing, not public, hidden, purged or with reports off: one answer, nothing stored.
  const answers = new Set();
  for (const [rows, siteFetch] of [
    [[], site()],
    [[commentRow({ status: "pending", moderation_state: "pending" })], site()],
    [[commentRow({ status: "rejected", moderation_state: "removed" })], site()],
    [[commentRow()], site(undefined, "hidden")],
    [[commentRow({ status: "rejected", moderation_state: "rejected", purged_at: "2026-10-27T00:00:00+00:00" })], site()],
    [[commentRow()], site({ question: "open" })],
  ]) {
    const quiet = fakeDatabase((request) => (request.path.endsWith("/openblog_comments") ? rows : []));
    const refused = await handlerFor(protectedEnv, quiet, { siteFetch })(event("reports", "POST", { headers: ORIGIN, body: { source: "comment", id: ID(2), ground: "spam" } }));
    answers.add(`${refused.statusCode} ${refused.body}`);
    assert.equal(writes(quiet).length, 0);
  }
  assert.deepEqual([...answers], ['404 {"error":"This item cannot be reported.","code":"unavailable"}']);

  // Feedback is public only approved at its current revision, never the text a clarification asked about.
  for (const [row, ok] of [
    [feedbackRow({ status: "approved", approved_revision: 1 }), true],
    [feedbackRow({ status: "approved", approved_revision: 1, item_revision: 2 }), false],
    [feedbackRow({ status: "approved", approved_revision: 1, clarification_asked: 1 }), false],
  ]) {
    const store = fakeDatabase((request) => (request.path.endsWith("/openblog_feedback") ? [row] : []));
    const result = await handlerFor(protectedEnv, store)(event("reports", "POST", { headers: ORIGIN, body: { source: "feedback", id: ID(1), ground: "personal-data" } }));
    assert.equal(result.statusCode, ok ? 202 : 404, JSON.stringify(row));
  }
  // A ground outside the list, text that is too long or hides direction controls, or extra identity: refused.
  for (const body of [
    { source: "comment", id: ID(2), ground: "incorrect" },
    { source: "comment", id: ID(2), ground: "no-action" },
    { source: "comment", id: ID(2), ground: "spam", body: "x".repeat(1001) },
    { source: "comment", id: ID(2), ground: "spam", body: "bidi ‮" },
    { source: "report", id: ID(3), ground: "spam" },
    { source: "comment", id: "../x", ground: "spam" },
  ]) {
    assert.equal((await handler(event("reports", "POST", { headers: ORIGIN, body }))).statusCode, 422, JSON.stringify(body));
  }
});

test("a site that publishes only B5's feedback manifest never takes abuse reports", async () => {
  // Built before the participation manifest existed: openblog-feedback.json opens the post.
  const b5Site = async (url) => {
    if (url.endsWith("openblog-feedback.json")) return { ok: true, status: 200, json: async () => ({ "/posts/tides/": "open" }) };
    if (url.endsWith("openblog-comments.json")) return { ok: true, status: 200, json: async () => ({ "/posts/tides/": "open" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  for (const [source, row] of [["comment", commentRow()], ["feedback", feedbackRow({ status: "approved", approved_revision: 1 })]]) {
    const database = fakeDatabase((request) => (request.path.endsWith(source === "comment" ? "/openblog_comments" : "/openblog_feedback") ? [row] : []));
    const response = await handlerFor(protectedEnv, database, { siteFetch: b5Site })(event("reports", "POST", { headers: ORIGIN, body: { source, id: row.id, ground: "spam" } }));
    assert.equal(response.statusCode, 404, source);
    assert.equal(JSON.parse(response.body).code, "unavailable");
    assert.equal(writes(database).length, 0);
  }
  // B5's four kinds still follow that manifest.
  const notes = fakeDatabase((request) => (request.method === "POST" && request.path.endsWith("/openblog_feedback") ? [{ id: ID(1), status: "pending" }] : []));
  const taken = await handlerFor(protectedEnv, notes, { siteFetch: b5Site })(event("feedback", "POST", { headers: ORIGIN, body: JSON.stringify(scholarly.accepted[0].submission) }));
  assert.equal(taken.statusCode, 202, taken.body);
});

test("report floods and repeats are bounded without telling the reporter", async () => {
  // Over the client's quota: told to wait.
  const limited = fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_consume_rate_limit") ? { allowed: request.body.p_bucket !== "reports" } : request.path.endsWith("/openblog_comments") ? [commentRow()] : []));
  assert.equal((await handlerFor(protectedEnv, limited)(event("reports", "POST", { headers: ORIGIN, body: { source: "comment", id: ID(2), ground: "spam" } }))).statusCode, 429);
  // Too many reports of one item this hour, or the same report again: accepted and not stored.
  for (const bucket of ["reports-item", "reports-repeat"]) {
    const capped = fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_consume_rate_limit") ? { allowed: request.body.p_bucket !== bucket } : request.path.endsWith("/openblog_comments") ? [commentRow()] : []));
    const response = await handlerFor(protectedEnv, capped)(event("reports", "POST", { headers: ORIGIN, body: { source: "comment", id: ID(2), ground: "spam" } }));
    assert.equal(response.statusCode, 202);
    assert.equal(writes(capped).some((request) => request.path.endsWith("/openblog_abuse_reports")), false);
  }
});

test("a submission whose storing fails can be sent again, and only a stored one is a replay", async () => {
  // A rate-limit table that counts as the database does, and forgets a row the function deletes.
  const limiter = () => {
    const counts = new Map();
    const key = (bucket, hour, digest) => `${bucket}|${hour}|${digest}`;
    return (request) => {
      if (request.path.endsWith("/rpc/openblog_consume_rate_limit")) {
        const { p_bucket, p_window_start, p_subject_hash, p_subject_limit } = request.body;
        const id = key(p_bucket, p_window_start, p_subject_hash);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        return { allowed: counts.get(id) <= p_subject_limit };
      }
      if (request.path.endsWith("/openblog_rate_limits") && request.method === "DELETE") {
        assert.equal(request.params.site_id, "eq.lantern");
        counts.delete(key(...["bucket", "window_start", "subject_hash"].map((name) => request.params[name].slice(3))));
        return null;
      }
      return undefined;
    };
  };
  const cases = [
    ["comments", { headers: ORIGIN, body: { path: "/posts/tides/", authorName: "Grace", body: "Hello." } }, "/openblog_comments", 202],
    ["feedback", { headers: ORIGIN, body: JSON.stringify(scholarly.accepted[0].submission) }, "/openblog_feedback", 202],
    ["reports", { headers: ORIGIN, body: { source: "comment", id: ID(2), ground: "spam" } }, "/openblog_abuse_reports", 202],
  ];
  for (const [operation, request, table, accepted] of cases) {
    const quota = limiter();
    let failing = true;
    let stored = 0;
    const database = fakeDatabase((call) => {
      const limited = quota(call);
      if (limited !== undefined) return limited;
      if (call.method === "POST" && call.path.endsWith(table)) {
        if (failing) return new Error("down");
        stored += 1;
        return [{ id: ID(9), status: "pending" }];
      }
      return call.path.endsWith("/openblog_comments") ? [commentRow()] : [];
    });
    const handler = handlerFor(protectedEnv, database);
    const first = await handler(event(operation, "POST", request));
    assert.equal(first.statusCode, 502, operation);
    assert.ok(database.requests.some((call) => call.method === "DELETE" && call.path.endsWith("/openblog_rate_limits") && call.params.bucket === `eq.${operation}-repeat`), operation);
    failing = false;
    const retry = await handler(event(operation, "POST", request));
    assert.equal(retry.statusCode, accepted, `${operation}: ${retry.body}`);
    assert.equal(stored, 1, operation);
    // Once stored, the same submission again is the replay it always was.
    const replay = await handler(event(operation, "POST", request));
    assert.equal(stored, 1, operation);
    if (operation === "reports") assert.equal(replay.statusCode, 202);
    else assert.equal(JSON.parse(replay.body).code, "duplicate", operation);
  }
});

// ---- The inbox: reports, upholding and deletion

test("reports join the inbox with the item they name, never a reader's private name", async () => {
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("/openblog_abuse_reports")) return [reportRow(), reportRow({ id: ID(4), target_source: "feedback", target_id: ID(1) })];
    if (request.path.endsWith("/openblog_comments")) return request.params.id ? [commentRow()] : [];
    if (request.path.endsWith("/openblog_feedback")) return request.params.id ? [feedbackRow({ status: "approved", approved_revision: 1 })] : [];
    return [];
  });
  const page = JSON.parse((await handlerFor(protectedEnv, database)(event("admin/moderation", "GET", { headers: ADMIN, query: { state: "pending" } }))).body);
  assert.equal(page.protocol, "protected");
  const [first, second] = page.items.filter((item) => item.source === "report");
  assert.deepEqual(first.report, { ground: "abusive", body: "This is abuse." });
  assert.deepEqual(first.target, { source: "comment", id: ID(2), kind: "comment", status: "approved", version: 2, revision: 1, authorName: "Grace", body: "A comment." });
  assert.equal(second.target.kind, "source-suggestion");
  assert.doesNotMatch(JSON.stringify(second), /Ada Lovelace/);
  const targets = database.requests.filter((request) => request.params.id?.startsWith("in.("));
  assert.deepEqual(targets.map((request) => request.params.id), [`in.(${ID(2)})`, `in.(${ID(1)})`]);
  // The abuse-report filter asks only the report store.
  database.requests.length = 0;
  await handlerFor(protectedEnv, database)(event("admin/moderation", "GET", { headers: ADMIN, query: { state: "pending", kind: "abuse-report" } }));
  assert.deepEqual([...new Set(database.requests.map((request) => request.path))], ["/rest/v1/openblog_abuse_reports", "/rest/v1/openblog_comments", "/rest/v1/openblog_feedback"]);
});

const decision = (extra = {}) => ({ source: "report", id: ID(3), action: "uphold-report", from: "pending", expectedVersion: 1, reason: "abusive", actor: "ada", actorRole: "site-admin", targetVersion: 2, ...extra });

test("upholding a report removes the item it names in one transaction, exactly as Admin saw it", async () => {
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("/rpc/openblog_uphold_report")) {
      return { report: reportRow({ status: "approved", version: 2, moderation_reason: "abusive" }), target: commentRow({ status: "rejected", moderation_state: "removed", moderation_reason: "upheld-report", version: 3 }) };
    }
    if (request.path.endsWith("/openblog_abuse_reports")) return [reportRow()];
    if (request.path.endsWith("/openblog_comments")) return [commentRow()];
    return [];
  });
  const handler = handlerFor(protectedEnv, database);
  const response = await handler(event("admin/moderation", "PATCH", { headers: ADMIN, body: decision() }));
  assert.equal(response.statusCode, 200, response.body);
  const call = writes(database).at(-1);
  assert.deepEqual(call.body, {
    p_site_id: "lantern", p_id: ID(3), p_expected_version: 1, p_target_version: 2, p_reason: "abusive",
    p_actor: "ada", p_actor_role: "site-admin", p_at: "2026-10-27T10:00:00Z",
  });
  const result = JSON.parse(response.body);
  assert.equal(result.item.status, "approved");
  assert.equal(result.removed.status, "removed");
  assert.equal(result.removed.reason, "upheld-report");

  // The item moved since Admin looked, or the database finds it moved: nothing changes.
  const moved = await handler(event("admin/moderation", "PATCH", { headers: ADMIN, body: decision({ targetVersion: 1 }) }));
  assert.equal(moved.statusCode, 409);
  const conflicted = fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_uphold_report") ? { conflict: "target" } : request.path.endsWith("/openblog_abuse_reports") ? [reportRow()] : [commentRow()]));
  assert.equal((await handlerFor(protectedEnv, conflicted)(event("admin/moderation", "PATCH", { headers: ADMIN, body: decision() }))).statusCode, 409);
  // Already out of view: only the report changes.
  const outOfView = fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_uphold_report") ? { report: reportRow({ status: "approved", version: 2 }), target: null } : request.path.endsWith("/openblog_abuse_reports") ? [reportRow()] : [commentRow({ status: "rejected", moderation_state: "removed", version: 3 })]));
  const only = await handlerFor(protectedEnv, outOfView)(event("admin/moderation", "PATCH", { headers: ADMIN, body: decision({ targetVersion: 3 }) }));
  assert.equal(only.statusCode, 200);
  assert.equal(writes(outOfView).at(-1).body.p_target_version, null);
  // No reason, a dismissal reason, a contributing author, or no protection: refused before any write.
  for (const [body, status] of [[decision({ reason: null }), 422], [decision({ reason: "no-action" }), 422], [decision({ actorRole: "contributing-author" }), 422]]) {
    const before = writes(database).length;
    assert.equal((await handler(event("admin/moderation", "PATCH", { headers: ADMIN, body }))).statusCode, status, JSON.stringify(body));
    assert.equal(writes(database).length, before);
  }
  assert.equal((await handlerFor(environment, database)(event("admin/moderation", "PATCH", { headers: ADMIN, body: decision() }))).statusCode, 422);
});

test("the site Admin deletes a closed item's text on request; nothing open, and nobody else", async () => {
  const removed = commentRow({ status: "rejected", moderation_state: "removed", version: 3 });
  const database = fakeDatabase((request) => (request.path.endsWith("/rpc/openblog_purge_comment") ? [{ ...removed, author_name: "-", body: "-", version: 4, purged_at: "2026-10-27T10:00:00+00:00" }] : [removed]));
  const handler = handlerFor(protectedEnv, database);
  const erase = { source: "comment", id: ID(2), action: "erase", from: "removed", expectedVersion: 3, actor: "ada", actorRole: "site-admin" };
  const response = await handler(event("admin/moderation", "PATCH", { headers: ADMIN, body: erase }));
  assert.equal(response.statusCode, 200, response.body);
  const { item } = JSON.parse(response.body);
  assert.equal(item.purgedAt, "2026-10-27T10:00:00Z");
  assert.equal(item.body, undefined);
  assert.doesNotMatch(response.body, /Grace|A comment/);
  assert.deepEqual(writes(database).at(-1).body, { p_site_id: "lantern", p_id: ID(2), p_expected_version: 3, p_actor: "ada", p_actor_role: "site-admin", p_at: "2026-10-27T10:00:00Z" });
  const before = writes(database).length;
  assert.equal((await handler(event("admin/moderation", "PATCH", { headers: ADMIN, body: { ...erase, actorRole: "coordinator" } }))).statusCode, 403);
  const approved = handlerFor(protectedEnv, fakeDatabase(() => [commentRow()]));
  assert.equal((await approved(event("admin/moderation", "PATCH", { headers: ADMIN, body: { ...erase, from: "approved", expectedVersion: 2 } }))).statusCode, 422);
  assert.equal(writes(database).length, before);
  // A purged item takes no decision at all.
  const purged = handlerFor(protectedEnv, fakeDatabase(() => [{ ...removed, purged_at: "2026-10-27T09:00:00+00:00", version: 4 }]));
  const reopen = await purged(event("admin/moderation", "PATCH", { headers: ADMIN, body: { ...erase, action: "reopen", expectedVersion: 4 } }));
  assert.equal(JSON.parse(reopen.body).code, "contentPurged");
});

// ---- Retention

const cutoffs = protection.cutoffs.withoutComments;

test("the retention dry run lists exactly what is due and how many audit events are old enough", async () => {
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("_events")) return [{ id: 1 }, { id: 2 }];
    if (request.path.endsWith("/openblog_feedback")) return [
      feedbackRow({ id: ID(11), status: "rejected", moderated_at: "2026-09-01T00:00:00+00:00" }),
      feedbackRow({ id: ID(12), status: "rejected", moderated_at: "2026-10-20T00:00:00+00:00" }),
      feedbackRow({ id: ID(13), status: "pending", received_at: "2026-07-01T00:00:00+00:00" }),
      feedbackRow({ id: ID(14), status: "withdrawn", moderated_at: "2026-10-26T00:00:00+00:00" }),
    ];
    if (request.path.endsWith("/openblog_abuse_reports")) return [reportRow({ status: "approved", moderated_at: "2026-09-01T00:00:00+00:00" })];
    return assert.fail(`comments are not touched without comment retention: ${request.path}`);
  });
  const response = await handlerFor(protectedEnv, database)(event("admin/retention", "GET", { headers: ADMIN, query: cutoffs }));
  assert.equal(response.statusCode, 200, response.body);
  const dry = JSON.parse(response.body);
  assert.deepEqual(dry.items.map((item) => [item.source, item.id, item.step]), [
    ["feedback", ID(11), "purge-content"], ["feedback", ID(13), "expire"], ["feedback", ID(14), "purge-content"], ["report", ID(3), "purge-content"],
  ]);
  assert.deepEqual(dry.audit, { comment: 2, feedback: 2, report: 2 });
  assert.equal(writes(database).length, 0, "a dry run writes nothing");
  const feedbackQuery = database.requests.find((request) => request.path.endsWith("/openblog_feedback"));
  assert.match(feedbackQuery.params.or, /and\(status\.eq\.withdrawn,purged_at\.is\.null\)/);
  // Cutoffs newer than a day, malformed or missing are refused, whatever Admin sends.
  // So is an audit cutoff later than the closed-item cutoff: audit events outlive closed items (ADR 0104).
  for (const bad of [{ ...cutoffs, closedUntil: "2026-10-27T00:00:00Z" }, { ...cutoffs, pendingUntil: "2026-07-29" }, { auditUntil: cutoffs.auditUntil }, { ...cutoffs, auditUntil: "2026-09-27T10:00:01Z" }]) {
    assert.equal((await handlerFor(protectedEnv, database)(event("admin/retention", "GET", { headers: ADMIN, query: bad }))).statusCode, 422);
  }
});

test("a retention run applies only what is still due as it was, and deletes old audit events when asked", async () => {
  const rows = {
    [ID(11)]: feedbackRow({ id: ID(11), status: "rejected", version: 3, moderated_at: "2026-09-01T00:00:00+00:00" }),
    [ID(13)]: feedbackRow({ id: ID(13), status: "pending", version: 1, received_at: "2026-07-01T00:00:00+00:00" }),
    [ID(15)]: feedbackRow({ id: ID(15), status: "approved", approved_revision: 1, version: 2, moderated_at: "2026-01-01T00:00:00+00:00" }),
  };
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("/rpc/openblog_erase_feedback")) return [{ ...rows[request.body.p_id], purged_at: "2026-10-27T10:00:00+00:00" }];
    if (request.path.endsWith("/rpc/openblog_moderate_feedback_item")) return [{ ...rows[request.body.p_id], status: "rejected" }];
    if (request.path.endsWith("_events")) return request.method === "DELETE" ? [{ id: 1 }] : [];
    if (request.path.endsWith("/openblog_feedback")) return [rows[request.params.id.slice(3)]].filter(Boolean);
    return [];
  });
  const handler = handlerFor(protectedEnv, database);
  const response = await handler(event("admin/retention", "POST", { headers: { ...ADMIN, ...ORIGIN }, body: {
    ...cutoffs,
    audit: true,
    items: [
      { source: "feedback", id: ID(11), version: 3, step: "purge-content" },
      { source: "feedback", id: ID(13), version: 1, step: "expire" },
      // Seen at another version, an approved note, or a comment without comment retention: skipped or refused.
      { source: "feedback", id: ID(11), version: 2, step: "purge-content" },
      { source: "feedback", id: ID(15), version: 2, step: "purge-content" },
    ],
  } }));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(JSON.parse(response.body), { ok: true, expired: 1, purged: 1, scrubbed: 0, skipped: 2, auditDeleted: { comment: 1, feedback: 1, report: 1 } });
  const calls = writes(database);
  const expire = calls.find((request) => request.path.endsWith("/rpc/openblog_moderate_feedback_item")).body;
  assert.deepEqual({ action: expire.p_action, to: expire.p_to, reason: expire.p_reason, actor: expire.p_actor, role: expire.p_actor_role }, { action: "expire", to: "rejected", reason: "expired", actor: "@retention", role: "system" });
  const purge = calls.find((request) => request.path.endsWith("/rpc/openblog_erase_feedback")).body;
  assert.deepEqual({ withdraw: purge.p_withdraw, actor: purge.p_actor, role: purge.p_actor_role }, { withdraw: false, actor: "@retention", role: "system" });
  const deletes = calls.filter((request) => request.method === "DELETE");
  assert.deepEqual(deletes.map((request) => [request.path, request.params.at]), [
    ["/rest/v1/openblog_comment_events", `lte.${cutoffs.auditUntil}`],
    ["/rest/v1/openblog_feedback_events", `lte.${cutoffs.auditUntil}`],
    ["/rest/v1/openblog_abuse_report_events", `lte.${cutoffs.auditUntil}`],
  ]);
  // Comments are never part of a run unless Admin says the site opted them in.
  const refused = await handler(event("admin/retention", "POST", { headers: { ...ADMIN, ...ORIGIN }, body: { ...cutoffs, items: [{ source: "comment", id: ID(2), version: 1, step: "purge-content" }] } }));
  assert.equal(refused.statusCode, 422);
});

// ---- The SQL

const statementsOf = (sql) => sql.replace(/--[^\n]*/g, "").toLowerCase();

test("the protection schema is additive, private and opt-in, and its rollback drops exactly what it added", () => {
  const added = statementsOf(protectionSql);
  for (const forbidden of [/\bdrop\b/, /\brename\b/, /\bdelete\s+from\b/, /\btruncate\b/, /\balter\s+column\b/, /security\s+definer/, /create policy/, /grant[^;]*\b(anon|authenticated)\b/, /\bip\b|address|user_agent|email/]) {
    assert.doesNotMatch(added, forbidden);
  }
  // On existing tables, only one new nullable column and one check that a purged comment is never approved.
  assert.deepEqual(added.match(/alter table public\.openblog_comments\s+add (?:column|constraint)[^;]*;/g).map((statement) => statement.replace(/\s+/g, " ")), [
    "alter table public.openblog_comments add column if not exists purged_at timestamptz;",
    "alter table public.openblog_comments add constraint openblog_comments_purged_never_public check (purged_at is null or status <> 'approved');",
  ]);
  for (const table of ["openblog_abuse_reports", "openblog_abuse_report_events"]) {
    assert.match(added, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(added, new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role;`));
  }
  assert.match(added, /grant select, insert, update on public\.openblog_abuse_reports to service_role/);
  // A report names only the item and the ground; the uphold function enforces the fail-closed rule.
  assert.doesNotMatch(added.match(/create table if not exists public\.openblog_abuse_reports \([^;]*\);/)[0], /name|contact|hash/);
  assert.match(added, /if coalesce\(target_status, ''\) = 'approved' then\s+if p_target_version is distinct from target_version then\s+return jsonb_build_object\('conflict', 'target'\);/);
  assert.match(added, /elsif p_target_version is not null then\s+return jsonb_build_object\('conflict', 'target'\);/);
  // Purging touches only closed items.
  assert.match(added, /set author_name = '-', body = '-', purged_at = p_at, version = version \+ 1\s+where id = p_id\s+and site_id = p_site_id\s+and status = 'rejected'\s+and purged_at is null/);
  // The feedback side: a receipt digest, never the receipt, and purging only what is closed or withdrawn first.
  const feedback = statementsOf(feedbackSql);
  assert.match(feedback, /add column if not exists receipt_hash text check \(receipt_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(feedback, /add constraint openblog_feedback_purged_never_public check \(purged_at is null or status <> 'approved'\)/);
  assert.match(feedback, /\(p_withdraw and status in \('pending', 'clarification', 'approved'\)\)\s+or \(not p_withdraw and status in \('rejected', 'removed', 'withdrawn'\)\)/);
  assert.doesNotMatch(baseSchema, /purged_at|receipt|abuse/);
  // An upheld report's removal names the report in the item's audit event, through one new nullable column each.
  assert.match(added, /alter table public\.openblog_comment_events\s+add column if not exists related uuid;/);
  assert.match(feedback, /alter table public\.openblog_feedback_events\s+add column if not exists related uuid;/);
  const uphold = added.match(/create or replace function public\.openblog_uphold_report\([\s\S]*?\$\$;/)[0];
  assert.match(uphold, /insert into public\.openblog_comment_events\s+\([^)]*, related\)\s+values \([^;]*, p_id\);/);
  assert.match(uphold, /insert into public\.openblog_feedback_events\s+\([^)]*, related\)\s+values \([^;]*, p_id\);/);

  const undo = statementsOf(protectionRollback);
  assert.deepEqual(undo.match(/\b(drop|alter|revoke)\b[^;]*;/g).map((statement) => statement.replace(/\s+/g, " ").trim()), [
    "drop function if exists public.openblog_purge_report(text, uuid, integer, text, text, timestamptz);",
    "drop function if exists public.openblog_purge_comment(text, uuid, integer, text, text, timestamptz);",
    "drop function if exists public.openblog_uphold_report(text, uuid, integer, integer, text, text, text, timestamptz);",
    "drop function if exists public.openblog_moderate_report(text, uuid, integer, text, text, text, text, text, text, timestamptz);",
    "drop function if exists public.openblog_erase_feedback(text, uuid, integer, boolean, text, text, timestamptz);",
    "drop table if exists public.openblog_abuse_report_events;",
    "drop table if exists public.openblog_abuse_reports;",
    "revoke delete on public.openblog_comment_events from service_role;",
    "drop trigger if exists openblog_comment_events_keep_recent on public.openblog_comment_events;",
    "alter table public.openblog_comment_events drop column if exists related;",
    "revoke delete on public.openblog_feedback_events from service_role;",
    "drop trigger if exists openblog_feedback_events_keep_recent on public.openblog_feedback_events;",
    "alter table public.openblog_feedback_events drop column if exists related;",
    "drop function if exists public.openblog_keep_recent_audit_events();",
    "alter table public.openblog_comments drop constraint if exists openblog_comments_purged_never_public;",
    "alter table public.openblog_comments drop column if exists purged_at;",
    "alter table if exists public.openblog_feedback drop constraint if exists openblog_feedback_purged_never_public;",
    "alter table if exists public.openblog_feedback drop column if exists purged_at;",
    "drop index if exists public.openblog_feedback_receipt;",
    "alter table if exists public.openblog_feedback drop column if exists receipt_hash;",
  ]);
});

test("the service role may delete audit events, but never one recorded in the last day", () => {
  const added = statementsOf(protectionSql);
  const tables = ["openblog_comment_events", "openblog_feedback_events", "openblog_abuse_report_events"];
  // Every table the service role may delete from has the guard, and no other delete is granted.
  const granted = [...added.matchAll(/grant ([a-z, ]+) on public\.(\w+) to service_role/g)].filter(([, rights]) => /\bdelete\b/.test(rights)).map(([, , table]) => table);
  assert.deepEqual([...new Set(granted)].sort(), [...tables].sort());
  for (const table of tables) {
    const trigger = new RegExp(`create or replace trigger ${table}_keep_recent\\s+before delete on public\\.${table}\\s+for each row execute function public\\.openblog_keep_recent_audit_events\\(\\);`);
    assert.match(added, trigger, table);
  }
  // The guard raises for anything newer than a day, and runs with its caller's rights.
  const guard = added.match(/create or replace function public\.openblog_keep_recent_audit_events\(\)[\s\S]*?\$\$;/)[0];
  assert.match(guard, /returns trigger\s+language plpgsql/);
  assert.match(guard, /if old\.at > now\(\) - interval '1 day' then\s+raise exception/);
  assert.match(guard, /return old;/);
  assert.doesNotMatch(guard, /security\s+definer/);
  // The feedback table's guard is added with its grant, only where that table exists.
  assert.match(added, /if to_regclass\('public\.openblog_feedback_events'\) is not null then\s+grant delete on public\.openblog_feedback_events to service_role;\s+create or replace trigger openblog_feedback_events_keep_recent/);
});
