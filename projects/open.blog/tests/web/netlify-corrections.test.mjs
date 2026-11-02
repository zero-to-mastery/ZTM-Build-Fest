// The hosted side of evidence submissions and correction decisions (ADRs 0116 and 0117), through
// HTTP-shaped events with a fake Supabase: off unless the deployer opts in, bounds and the shared
// validator before the quota and the quota before anything is stored, CORS and the token, the
// decision checks agreeing with the Rust policy's shared fixture, stale and refused decisions that
// write nothing, and the additive SQL with its rollback.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import { DECIDER_ROLES, EVIDENCE_KINDS, emptyLog, planDecision } from "../../netlify/lib/correction-decisions.mjs";
import { readFeedbackSubmissionJson } from "../../web/components/passage-feedback.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = JSON.parse(read("../fixtures/evidence-corrections.json"));
const scholarly = JSON.parse(read("../fixtures/scholarly-feedback.json"));
const feedbackSql = read("../../supabase/feedback.sql");
const rollbackSql = read("../../supabase/corrections-rollback.sql");
const moderationRollbackSql = read("../../supabase/moderation-rollback.sql");

const environment = {
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: "sb_secret_test_server_only",
  OPENBLOG_SITE_ID: "lantern",
  OPENBLOG_SITE_ORIGIN: "https://blog.example",
  OPENBLOG_ADMIN_API_KEY: "admin-secret",
  OPENBLOG_ANALYTICS_SALT: "daily-hash-secret",
  OPENBLOG_FEEDBACK_ENABLED: "true",
  OPENBLOG_MODERATION_ENABLED: "true",
};
const corrections = { ...environment, OPENBLOG_CORRECTIONS_ENABLED: "true" };
const NOW = new Date("2026-10-27T10:00:00.000Z");
const ADMIN = { authorization: "Bearer admin-secret" };
const ORIGIN = { origin: "https://blog.example" };
const ID = "a1111111-1111-4111-8111-11111111111a";

const event = (path, method, body, headers = ORIGIN, query = {}) => ({
  path: `/api/${path}`,
  httpMethod: method,
  headers: { "x-nf-client-connection-ip": "203.0.113.9", ...headers },
  queryStringParameters: query,
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

const sitePolicy = async () => {
  const modes = Object.fromEntries(["question", "source-suggestion", "correction-suggestion", "alternative-interpretation"].map((kind) => [kind, "open"]));
  return { ok: true, status: 200, json: async () => ({ "/posts/tides/": modes }) };
};

/** A fake Supabase that records requests and answers by what is asked. */
const fakeDatabase = (answer = () => undefined) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const request = { url, path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    let value = await answer(request);
    if (value === undefined) {
      if (request.path.endsWith("openblog_consume_rate_limit")) value = { allowed: true };
      else if (request.method === "POST" && request.path.endsWith("/openblog_feedback")) value = [{ id: "00000000-0000-4000-8000-000000000009", status: "pending", received_at: "2026-10-27T10:00:00+00:00" }];
      else value = [];
    }
    return { ok: true, status: 200, json: async () => value };
  };
  return { requests, fetchImpl };
};
const handlerFor = (env, database) => createHandler({ env, fetchImpl: database.fetchImpl, siteFetchImpl: sitePolicy, now: () => NOW });
const inserts = (database) => database.requests.filter((request) => request.method === "POST" && request.path.endsWith("/openblog_feedback"));
const evidenceText = (index = 1) => JSON.stringify(fixture.submissions.accepted[index].submission);

test("the function's decision checks agree with every case of the shared decision fixture", () => {
  const ROW_CODES = ["denied", "notDecidable", "itemClosed", "awaitingClarification", "stale"];
  let compared = 0;
  for (const expected of fixture.decisions.cases) {
    // A coordinator's scope is resolved by Admin on the item's work, never by the function.
    if (expected.itemOverrides?.work) continue;
    const item = { ...fixture.decisions.items[expected.item], ...(expected.itemOverrides || {}) };
    const log = expected.log || [];
    const decision = expected.expect.decision ?? {
      version: 1, item: item.id, sequence: log.length + 1, outcome: expected.request.content.outcome, itemRevision: item.revision,
      passageCheck: item.check, decided: expected.request.decided, decidedBy: { role: expected.request.role },
    };
    const plan = planDecision(
      { id: item.id, kind: item.kind, state: item.state, revision: item.revision, clarificationAsked: item.clarificationAsked ?? null, decisions: log.length },
      { role: expected.request.role, expectedDecisions: expected.request.expectedDecisions, decision },
    );
    const code = expected.expect.error;
    if (ROW_CODES.includes(code)) assert.deepEqual(plan, { ok: false, code }, expected.name);
    else assert.deepEqual(plan, { ok: true }, `${expected.name}: Admin decides the rest`);
    compared += 1;
  }
  assert.ok(compared >= 40);
  assert.deepEqual(DECIDER_ROLES, ["site-admin", "coordinator"]);
  assert.deepEqual(EVIDENCE_KINDS, ["source-suggestion", "correction-suggestion"]);
  // What only the function can be asked: a decision that is not the log's next entry, or about
  // another item or text revision, or with a role it does not hold, or with a vote riding along.
  const facts = { id: ID, kind: "correction-suggestion", state: "pending", revision: 2, clarificationAsked: 1, decisions: 1 };
  const decision = { version: 1, item: ID, sequence: 2, outcome: "declined", itemRevision: 2, passageCheck: "current", decided: "2026-10-27", decidedBy: { role: "site-admin" } };
  const plan = (changes, request = {}) => planDecision(facts, { role: "site-admin", expectedDecisions: 1, decision: { ...decision, ...changes }, ...request }).code;
  assert.equal(plan({}), undefined);
  for (const changes of [{ sequence: 1 }, { item: "b1111111-1111-4111-8111-11111111111b" }, { decidedBy: { role: "coordinator" } }, { upvotes: 3 }, { outcome: "verified" }, { decided: "27/10/2026" }, { rationale: "x".repeat(9000) }]) {
    assert.equal(plan(changes), "malformed", JSON.stringify(changes).slice(0, 60));
  }
  // Text that changed since the author looked is stale, not malformed: they review it again.
  assert.equal(plan({ itemRevision: 1 }), "stale");
  assert.equal(plan({}, { role: "contributing-author" }), "denied");
  assert.equal(planDecision({ ...facts, decisions: 100 }, { role: "site-admin", expectedDecisions: 100, decision: { ...decision, sequence: 101 } }).code, "tooManyDecisions");
  assert.deepEqual(emptyLog(ID.toUpperCase()), { version: 1, item: ID, decisions: [] });
});

test("without the opt-in a version 2 submission is refused as B5 refuses it, and nothing is stored", async () => {
  const database = fakeDatabase();
  const response = await handlerFor(environment, database)(event("feedback", "POST", evidenceText()));
  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body).code, "unsupportedVersion");
  assert.equal(database.requests.length, 0, "refused before the quota and before storage");
});

test("with the opt-in an evidence submission is checked, rate limited, then stored pending with its block", async () => {
  const database = fakeDatabase();
  const response = await handlerFor(corrections, database)(event("feedback", "POST", evidenceText()));
  assert.equal(response.statusCode, 202);
  assert.equal(JSON.parse(response.body).status, "pending");
  const [stored] = inserts(database);
  assert.equal(stored.body.format_version, 2);
  assert.equal(stored.body.status, "pending");
  assert.deepEqual(stored.body.evidence, fixture.submissions.accepted[1].record.evidence);
  // The quota was taken before the row was written.
  const quota = database.requests.findIndex((request) => request.path.endsWith("openblog_consume_rate_limit"));
  assert.ok(quota >= 0 && quota < database.requests.indexOf(stored));
  // A version 1 submission stays byte for byte B5's, with no evidence column written.
  const plain = fakeDatabase();
  assert.equal((await handlerFor(corrections, plain)(event("feedback", "POST", evidenceText(0)))).statusCode, 202);
  assert.equal(inserts(plain)[0].body.format_version, 1);
  assert.equal(Object.hasOwn(inserts(plain)[0].body, "evidence"), false);
});

test("bad, hostile or oversized evidence is refused before the quota, and spam is refused before storage", async () => {
  for (const refused of fixture.submissions.refused) {
    // A version 1 question is B5's own submission, which the hosted path still takes.
    if (readFeedbackSubmissionJson(JSON.stringify(refused.submission)).ok) continue;
    const database = fakeDatabase();
    const response = await handlerFor(corrections, database)(event("feedback", "POST", JSON.stringify(refused.submission)));
    assert.ok([413, 422].includes(response.statusCode), refused.name);
    assert.equal(database.requests.length, 0, `${refused.name}: nothing is asked of Supabase`);
    assert.doesNotMatch(response.body, /sb_secret|admin-secret/);
  }
  const huge = JSON.stringify({ ...fixture.submissions.accepted[1].submission, body: "a".repeat(40_000) });
  assert.equal((await handlerFor(corrections, fakeDatabase())(event("feedback", "POST", huge))).statusCode, 413);
  const limited = fakeDatabase((request) => (request.path.endsWith("openblog_consume_rate_limit") ? { allowed: false } : undefined));
  const response = await handlerFor(corrections, limited)(event("feedback", "POST", evidenceText()));
  assert.equal(response.statusCode, 429);
  assert.equal(inserts(limited).length, 0);
  // With engagement protection the same evidence submission again within the hour is a replay,
  // refused before storage; the same note with other evidence is a different submission.
  const protectedEnv = { ...corrections, OPENBLOG_PROTECTION_ENABLED: "true" };
  const repeats = new Set();
  const replaying = fakeDatabase((request) => {
    if (!request.path.endsWith("openblog_consume_rate_limit")) return undefined;
    if (request.body.p_bucket !== "feedback-repeat") return { allowed: true };
    const seen = repeats.has(request.body.p_subject_hash);
    repeats.add(request.body.p_subject_hash);
    return { allowed: !seen };
  });
  const replayHandler = handlerFor(protectedEnv, replaying);
  assert.equal((await replayHandler(event("feedback", "POST", evidenceText()))).statusCode, 202);
  const replay = await replayHandler(event("feedback", "POST", evidenceText()));
  assert.equal(replay.statusCode, 409);
  assert.equal(JSON.parse(replay.body).code, "duplicate");
  const other = { ...fixture.submissions.accepted[1].submission, evidence: { claim: "tide-height" } };
  assert.equal((await replayHandler(event("feedback", "POST", JSON.stringify(other)))).statusCode, 202);
  assert.equal(inserts(replaying).length, 2);
  // Another origin cannot submit.
  const elsewhere = fakeDatabase();
  assert.equal((await handlerFor(corrections, elsewhere)(event("feedback", "POST", evidenceText(), { origin: "https://evil.example" }))).statusCode, 403);
  assert.equal(elsewhere.requests.length, 0);
});

const stored = (extra = {}) => ({
  ...scholarly.storedRow, id: ID, kind: "correction-suggestion", target: { version: 1, kind: "section", section: "tides" }, details: {},
  format_version: 2, evidence: { claim: "tide-height", source: "admiralty-1990", stance: "contradicts" }, status: "pending", version: 3,
  item_revision: 1, approved_revision: null, clarification_asked: null, clarification_consent: false, decisions: null, ...extra,
});
const decision = (extra = {}) => ({
  version: 1, item: ID, sequence: 1, outcome: "declined", declineReason: "maintains-reading", rationale: "The survey measured the neap tide.",
  itemRevision: 1, passageRevision: "p1:4a264dbcfbe9d0a56591ff04cbf12ca4", passageCheck: "current", decided: "2026-10-27", decidedBy: { role: "site-admin", account: "mikey" }, ...extra,
});
const decide = (body) => event("admin/decisions", "POST", { id: ID, expectedDecisions: 0, actor: "mikey", actorRole: "site-admin", decision: decision(), ...body }, ADMIN);

test("the inbox carries the evidence block and the decision log only with the opt-in", async () => {
  const row = stored();
  const on = fakeDatabase((request) => (request.path.endsWith("/openblog_feedback") && request.method === "GET" ? [{ ...row, received_at: "2026-10-26T10:00:00.5+00:00" }] : undefined));
  const listed = JSON.parse((await handlerFor(corrections, on)(event("admin/moderation", "GET", undefined, ADMIN, { state: "pending", kind: "correction-suggestion" }))).body);
  const [item] = listed.items;
  assert.deepEqual(item.feedback.evidence, row.evidence);
  assert.equal(item.feedback.version, 2);
  assert.deepEqual(item.decisions, emptyLog(ID));
  assert.match(on.requests.find((request) => request.path.endsWith("/openblog_feedback")).params.select, /,evidence,decisions$/);
  // Without it the columns are not asked for, so a site that never ran the schema keeps working.
  const off = fakeDatabase((request) => (request.path.endsWith("/openblog_feedback") && request.method === "GET" ? [] : undefined));
  await handlerFor(environment, off)(event("admin/moderation", "GET", undefined, ADMIN, { state: "pending" }));
  assert.doesNotMatch(off.requests.find((request) => request.path.endsWith("/openblog_feedback")).params.select, /evidence|decisions/);
});

test("only an evidence submission carries a decision log, so Admin still reads every other kind", async () => {
  const rows = ["third-perspective", "question", "alternative-interpretation", "source-suggestion", "correction-suggestion"].map((kind, index) => ({
    ...stored(), id: `a1111111-1111-4111-8111-11111111111${index}`, kind, evidence: null, decisions: null, details: {}, received_at: "2026-10-26T10:00:00+00:00",
  }));
  const database = fakeDatabase((request) => (request.path.endsWith("/openblog_feedback") && request.method === "GET" ? rows : undefined));
  const listed = JSON.parse((await handlerFor(corrections, database)(event("admin/moderation", "GET", undefined, ADMIN, { state: "pending" }))).body);
  assert.equal(listed.items.length, rows.length);
  for (const item of listed.items) {
    const decidable = EVIDENCE_KINDS.includes(item.feedback.kind);
    assert.equal("decisions" in item, decidable, item.feedback.kind);
    if (decidable) assert.deepEqual(item.decisions, emptyLog(item.id));
  }
});

test("a block too large for the store is refused before the quota or the replay claim is spent", async () => {
  const large = fixture.submissions.refused.find((item) => item.code === "evidenceTooLarge");
  assert.ok(large);
  const database = fakeDatabase();
  const response = await handlerFor(corrections, database)(event("feedback", "POST", JSON.stringify(large.submission)));
  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body).code, "evidenceTooLarge");
  assert.equal(database.requests.length, 0);
});

test("with the opt-in off, a stored version 2 row reads as its version 1 record so it can still be moderated", async () => {
  const row = stored();
  assert.equal(row.format_version, 2);
  // Like the database: a column that was not selected is not returned.
  const database = fakeDatabase((request) => {
    if (!(request.path.endsWith("/openblog_feedback") && request.method === "GET")) return undefined;
    const { evidence, decisions, ...plain } = row;
    return [{ ...(request.params.select.includes("evidence") ? row : plain), received_at: "2026-10-26T10:00:00.5+00:00" }];
  });
  const listed = JSON.parse((await handlerFor(environment, database)(event("admin/moderation", "GET", undefined, ADMIN, { state: "pending" }))).body);
  const [item] = listed.items;
  assert.equal(item.feedback.version, 1);
  assert.equal("evidence" in item.feedback, false, "the block was not read, so none is claimed");
  assert.equal(item.decisions, undefined);
  // The same row with the opt-in on keeps version 2 and its block.
  const on = JSON.parse((await handlerFor(corrections, database)(event("admin/moderation", "GET", undefined, ADMIN, { state: "pending" }))).body);
  assert.equal(on.items[0].feedback.version, 2);
});

test("a decision needs the token and the opt-in, and is checked from the stored row before one conditional write", async () => {
  const noDatabase = fakeDatabase(() => assert.fail("must not reach Supabase"));
  for (const headers of [{}, ORIGIN, { authorization: "Bearer wrong" }]) {
    assert.equal((await handlerFor(corrections, noDatabase)(event("admin/decisions", "POST", {}, headers))).statusCode, headers.origin ? 401 : 403);
  }
  assert.equal((await handlerFor(environment, noDatabase)(decide({}))).statusCode, 404);

  const row = stored();
  const decided = { ...row, decisions: { version: 1, item: ID, decisions: [decision()] } };
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("openblog_record_feedback_decision")) return [decided];
    if (request.path.endsWith("/openblog_feedback")) return [row];
    return undefined;
  });
  const response = await handlerFor(corrections, database)(decide({}));
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.item.decisions.decisions.length, 1);
  assert.equal(result.item.status, "pending", "a decision never moderates");
  const rpc = database.requests.find((request) => request.path.endsWith("openblog_record_feedback_decision"));
  assert.deepEqual(
    { ...rpc.body, p_decision: undefined },
    { p_site_id: "lantern", p_id: ID, p_expected_decisions: 0, p_item_revision: 1, p_decision: undefined, p_actor: "mikey", p_actor_role: "site-admin", p_at: "2026-10-27T10:00:00Z" },
  );
  assert.deepEqual(rpc.body.p_decision, decision());
});

test("a stale, refused or malformed decision writes nothing", async () => {
  const cases = [
    [{ expectedDecisions: 1 }, stored(), 409, "conflict"],
    [{ actorRole: "contributing-author", decision: decision({ decidedBy: { role: "contributing-author" } }) }, stored(), 403, "denied"],
    [{}, stored({ kind: "question", format_version: 1, evidence: null, target: { version: 1, kind: "work" } }), 422, "notDecidable"],
    [{}, stored({ status: "rejected" }), 422, "itemClosed"],
    [{}, stored({ status: "clarification", clarification_asked: 1 }), 422, "awaitingClarification"],
    [{}, stored({ purged_at: "2026-10-27T09:00:00+00:00", status: "withdrawn" }), 422, "itemClosed"],
    [{ decision: decision({ sequence: 2 }) }, stored(), 422, "malformed"],
    [{ decision: decision({ itemRevision: 2 }) }, stored(), 409, "conflict"],
    [{ id: "not-a-uuid" }, stored(), 422, "invalid"],
  ];
  for (const [body, row, status, code] of cases) {
    const database = fakeDatabase((request) => {
      if (request.path.endsWith("openblog_record_feedback_decision")) return assert.fail("must not write");
      if (request.path.endsWith("/openblog_feedback")) return [row];
      return undefined;
    });
    const response = await handlerFor(corrections, database)(decide(body));
    assert.equal(response.statusCode, status, code);
    assert.equal(JSON.parse(response.body).code, code);
  }
  // A decision the database refuses (someone decided in between) answers a conflict with the item now.
  const raced = fakeDatabase((request) => {
    if (request.path.endsWith("openblog_record_feedback_decision")) return [];
    if (request.path.endsWith("/openblog_feedback")) return [stored()];
    return undefined;
  });
  const response = await handlerFor(corrections, raced)(decide({}));
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).item.id, ID);
  // A provider failure says nothing about the backend.
  const failing = createHandler({ env: corrections, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ message: "sb_secret boom" }) }), siteFetchImpl: sitePolicy, now: () => NOW });
  const failed = await failing(decide({}));
  assert.equal(failed.statusCode, 502);
  assert.doesNotMatch(failed.body, /sb_secret|boom/);
});

test("the schema is additive and opt in, refuses in SQL what must never happen, and its rollback drops exactly what it added", () => {
  const sql = feedbackSql.replace(/--[^\n]*/g, "").toLowerCase();
  assert.match(sql, /add column if not exists evidence jsonb\s+check \(evidence is null or/);
  assert.match(sql, /add column if not exists decisions jsonb\s+check \(decisions is null or/);
  assert.match(sql, /check \(evidence is null or format_version >= 2\)/);
  // A purge deletes the reader's evidence block with their text.
  assert.match(sql, /if \(to_jsonb\(new\) ->> 'purged_at'\) is not null then\s+new\.evidence := null;/);
  assert.match(sql, /create or replace trigger openblog_feedback_purge_evidence\s+before update on public\.openblog_feedback/);
  const fn = sql.slice(sql.indexOf("create or replace function public.openblog_record_feedback_decision"));
  for (const condition of [
    "kind in ('source-suggestion', 'correction-suggestion')",
    "status in ('pending', 'approved')",
    "clarification_asked is distinct from item_revision",
    "item_revision = p_item_revision",
    "coalesce(jsonb_array_length(decisions -> 'decisions'), 0) = p_expected_decisions",
    "p_actor_role in ('site-admin', 'coordinator')",
    "p_decision -> 'sequence' = to_jsonb(p_expected_decisions + 1)",
  ]) assert.ok(fn.includes(condition), condition);
  // It changes only the log, and records the event without any text.
  const update = fn.slice(fn.indexOf("update public.openblog_feedback"), fn.indexOf("where id = p_id"));
  assert.doesNotMatch(update, /status =|version =|body =|details =|evidence =|approved_revision/);
  assert.match(fn, /select site_id, id, 'decide', status, status, null, p_actor, p_at, version, kind, item_revision, p_actor_role from changed/);
  assert.match(fn, /revoke all on function public\.openblog_record_feedback_decision\([^)]*\) from public, anon, authenticated;\s*grant execute on function public\.openblog_record_feedback_decision\([^)]*\) to service_role;/);
  assert.doesNotMatch(sql, /security definer/);

  const undo = rollbackSql.replace(/--[^\n]*/g, "").toLowerCase();
  assert.deepEqual(undo.match(/\bdrop\b[^;]*;/g), [
    "drop function if exists public.openblog_record_feedback_decision(text, uuid, integer, integer, jsonb, text, text, timestamptz);",
    "drop trigger if exists openblog_feedback_purge_evidence on public.openblog_feedback;",
    "drop function if exists public.openblog_feedback_purge_evidence();",
    "drop constraint if exists openblog_feedback_evidence_needs_version_2;",
    "drop column if exists evidence;",
    "drop column if exists decisions;",
  ]);
  // Undoing the inbox alone must not leave the decision function behind, reading a column it drops.
  assert.match(moderationRollbackSql.replace(/--[^\n]*/g, ""), /drop function if exists public\.openblog_record_feedback_decision\(text, uuid, integer, integer, jsonb, text, text, timestamptz\);/);
  assert.match(undo, /update public\.openblog_feedback set format_version = 1 where format_version = 2;/);
  assert.doesNotMatch(undo, /drop table|openblog_feedback_events|openblog_comments|delete from/);
});
