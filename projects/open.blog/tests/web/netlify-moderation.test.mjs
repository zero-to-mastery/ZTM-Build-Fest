// The hosted side of the one moderation inbox (#225, ADRs 0105 and 0106), exercised through
// HTTP-shaped events with a fake Supabase: the shared transitions fixture, the token as the only
// way in, comments and passage feedback merged in one keyset-paged list, every decision checked
// again from the stored row before one conditional write, what an older schema can store, stale
// and refused decisions that write nothing, provider failures, and the additive SQL with its
// rollback.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import { INBOX_ACTIONS, MODERATION_STATES, commentState, commentStateFilter, legacyCommentStatus, legacySupports, planTransition } from "../../netlify/lib/participation-moderation.mjs";
import { planModeration } from "../../netlify/lib/feedback-moderation.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const transitions = JSON.parse(read("../fixtures/participation-transitions.json"));
const scholarly = JSON.parse(read("../fixtures/scholarly-feedback.json"));
const moderationSql = read("../../supabase/moderation.sql");
const moderationRollback = read("../../supabase/moderation-rollback.sql");
const feedbackSql = read("../../supabase/feedback.sql");
const baseSchema = read("../../supabase/openblog.sql");

const environment = {
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: "sb_secret_test_server_only",
  OPENBLOG_SITE_ID: "lantern",
  OPENBLOG_SITE_ORIGIN: "https://blog.example",
  OPENBLOG_ADMIN_API_KEY: "admin-secret",
  OPENBLOG_ANALYTICS_SALT: "daily-hash-secret",
  OPENBLOG_FEEDBACK_ENABLED: "true",
};
const full = { ...environment, OPENBLOG_MODERATION_ENABLED: "true" };
const NOW = new Date("2026-10-27T10:00:00.000Z");
const ADMIN = { authorization: "Bearer admin-secret" };

const event = (method, { query = {}, body, headers = ADMIN } = {}) => ({
  path: "/api/admin/moderation",
  httpMethod: method,
  headers: { "x-nf-client-connection-ip": "203.0.113.9", ...headers },
  queryStringParameters: query,
  body: body === undefined ? undefined : JSON.stringify(body),
});

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const comment = (n, extra = {}) => ({
  id: ID(n), path: "/posts/tides/", author_name: "Grace", body: "<img src=x onerror=alert(1)>", status: "pending",
  created_at: `2026-10-26T10:00:0${n}.123456+00:00`, moderated_at: null, ...extra,
});
const feedback = (n, extra = {}) => ({ ...scholarly.storedRow, id: ID(n), status: "pending", version: 1, moderated_at: null, moderation_reason: null, received_at: `2026-10-26T10:00:0${n}.5+00:00`, ...extra });

/** A fake Supabase that records requests and answers by table and verb. */
const fakeDatabase = (answer = () => []) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const request = { url, path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const value = await answer(request);
    if (value instanceof Error) return { ok: false, status: 500, json: async () => ({ message: "boom sb_secret" }) };
    return { ok: true, status: 200, json: async () => value };
  };
  return { requests, fetchImpl };
};
const noSite = async () => assert.fail("the inbox never reads the site");
const handlerFor = (env, database) => createHandler({ env, fetchImpl: database.fetchImpl, siteFetchImpl: noSite, now: () => NOW });

test("every case of the shared transitions fixture agrees with the function's state machine", () => {
  const facts = { plain: [1, null, false], consented: [1, null, true], asked: [1, 1, true], answered: [2, 1, true] };
  assert.ok(transitions.cases.length > 600);
  for (const expected of transitions.cases) {
    const [revision, clarificationAsked, clarificationConsent] = facts[expected.facts];
    const plan = planTransition(
      { kind: expected.kind, state: expected.state, version: 3, revision, clarificationAsked, clarificationConsent },
      { action: expected.action, expectedVersion: expected.expectedVersion ?? 3, reason: expected.reason, role: expected.role },
    );
    if (expected.refused) {
      assert.deepEqual(plan, { ok: false, code: expected.refused }, JSON.stringify(expected));
    } else {
      assert.ok(plan.ok, JSON.stringify(expected));
      const { to, version, approvedRevision } = plan.change;
      assert.deepEqual(
        { to, version, revision: plan.change.revision, approvedRevision, clarificationAsked: plan.change.clarificationAsked },
        { to: expected.to, version: expected.version, revision: expected.revision, approvedRevision: expected.approvedRevision, clarificationAsked: expected.clarificationAsked },
        JSON.stringify(expected),
      );
    }
  }
  // Requests no case can make: an action or kind this version does not know, the reader's own
  // actions from a moderator, and text retention already purged.
  const item = { kind: "question", state: "pending", version: 1, revision: 1, clarificationAsked: null, clarificationConsent: true };
  assert.equal(planTransition(item, { action: "delete", expectedVersion: 1, role: "site-admin" }).code, "notAllowed");
  assert.equal(planTransition({ ...item, kind: "vote" }, { action: "approve", expectedVersion: 1, role: "site-admin" }).code, "notAllowed");
  assert.equal(planTransition(item, { action: "withdraw", expectedVersion: 1, role: "site-admin" }).code, "denied");
  assert.equal(planTransition(item, { action: "approve", expectedVersion: 1, role: "public" }).code, "denied");
  assert.equal(planTransition({ ...item, contentRetained: false }, { action: "approve", expectedVersion: 1, role: "site-admin" }).code, "contentPurged");
  // The submitter's answer replaces the text as the next revision.
  const answered = planTransition({ ...item, state: "clarification", clarificationAsked: 1 }, { action: "clarify", expectedVersion: 1, role: "submitter" });
  assert.deepEqual(answered.change, { action: "clarify", from: "clarification", to: "pending", reason: null, version: 2, revision: 2, approvedRevision: null, clarificationAsked: 1 });
  // B5's route is the same machine, cut to its three actions.
  assert.equal(planModeration("pending", "request-clarification").code, "notAllowed");
  assert.deepEqual(planModeration("approved", "remove", "spam").change, { action: "remove", from: "approved", to: "removed", reason: "spam" });
  assert.deepEqual(INBOX_ACTIONS, ["approve", "request-clarification", "reject", "remove", "reopen"]);
  assert.ok(legacySupports("comment", "reopen") && !legacySupports("question", "reopen") && !legacySupports("comment", "request-clarification"));
});

test("only the moderation token reaches the inbox, and nothing is asked of Supabase without it", async () => {
  const database = fakeDatabase(() => assert.fail("must not reach Supabase"));
  const handler = handlerFor(full, database);
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "admin-secret " }, { origin: "https://blog.example" }]) {
    assert.equal((await handler(event("GET", { headers }))).statusCode, 401);
    assert.equal((await handler(event("PATCH", { headers, body: {} }))).statusCode, headers.origin ? 401 : 403);
  }
});

test("comments and feedback are merged oldest first and paged by a keyset cursor", async () => {
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("/openblog_comments")) return [comment(1), comment(3), comment(5)];
    return [feedback(2), feedback(4)];
  });
  const handler = handlerFor(full, database);
  const first = await handler(event("GET", { query: { state: "pending", limit: "3" } }));
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["Cache-Control"], "no-store");
  const page = JSON.parse(first.body);
  assert.equal(page.protocol, "full");
  assert.deepEqual(page.items.map((item) => [item.source, item.id]), [["comment", ID(1)], ["feedback", ID(2)], ["comment", ID(3)]]);
  assert.equal(page.next, `2026-10-26T10:00:03.123456Z~${ID(3)}`);
  // Hostile text stays data; the comment carries its version and full state.
  assert.equal(page.items[0].comment.body, "<img src=x onerror=alert(1)>");
  assert.equal(page.items[0].comment.createdAt, "2026-10-26T10:00:01Z");
  assert.equal(page.items[0].version, 1);
  const [comments, rows] = database.requests;
  assert.equal(comments.params.site_id, "eq.lantern");
  assert.equal(comments.params.and, "(and(status.eq.pending,or(moderation_state.is.null,moderation_state.not.in.(clarification))))");
  assert.match(comments.params.select, /version,moderation_state,moderation_reason$/);
  assert.equal(comments.params.order, "created_at.asc,id.asc");
  assert.equal(comments.params.limit, "4");
  assert.match(rows.params.select, /item_revision,approved_revision,clarification_asked,clarification_consent$/);
  assert.equal(rows.params.and, "(status.eq.pending)");

  database.requests.length = 0;
  await handler(event("GET", { query: { state: "removed", kind: "comment", after: page.next } }));
  assert.equal(database.requests.length, 1, "a comment filter asks only the comment store");
  assert.equal(
    database.requests[0].params.and,
    `(and(status.eq.rejected,moderation_state.eq.removed),or(created_at.gt."2026-10-26T10:00:03.123456Z",and(created_at.eq."2026-10-26T10:00:03.123456Z",id.gt.${ID(3)})))`,
  );
  // Comments never wait for clarification: only the feedback store is asked.
  database.requests.length = 0;
  await handler(event("GET", { query: { state: "clarification", kind: "question" } }));
  assert.deepEqual(database.requests.map((request) => request.path), ["/rest/v1/openblog_feedback"]);
  assert.equal(database.requests[0].params.and, "(status.eq.clarification,kind.eq.question)");

  for (const query of [{ after: "yesterday" }, { after: `2026-10-26T10:00:03Z~${ID(3)}` }, { kind: "vote" }, { id: "../x", source: "comment" }, { id: ID(1), source: "abuse" }]) {
    assert.equal((await handler(event("GET", { query }))).statusCode, 422, JSON.stringify(query));
  }
  database.requests.length = 0;
  const one = JSON.parse((await handler(event("GET", { query: { id: ID(2).toUpperCase(), source: "feedback" } }))).body);
  assert.equal(database.requests[0].params.id, `eq.${ID(2)}`);
  assert.equal(one.next, null);
});

test("an older schema is read and paged as it is, and feedback stays out until it is switched on", async () => {
  const database = fakeDatabase((request) => (request.path.endsWith("/openblog_comments") ? [comment(1, { status: "rejected" })] : [feedback(2)]));
  const legacy = handlerFor(environment, database);
  const page = JSON.parse((await legacy(event("GET", { query: { state: "rejected" } }))).body);
  assert.equal(page.protocol, "legacy");
  assert.equal(page.next, null);
  assert.equal(database.requests[0].params.and, "(status.eq.rejected)");
  assert.equal(database.requests[0].params.select, "id,path,author_name,body,status,created_at,moderated_at");
  assert.equal(database.requests[1].params.select.includes("item_revision"), false);
  assert.equal(page.items[0].version, 1);
  // Removed comments exist only with the inbox's schema.
  database.requests.length = 0;
  await legacy(event("GET", { query: { state: "removed", kind: "comment" } }));
  assert.equal(database.requests.length, 0);
  // Without OPENBLOG_FEEDBACK_ENABLED the feedback table is never asked.
  database.requests.length = 0;
  const commentsOnly = handlerFor({ ...full, OPENBLOG_FEEDBACK_ENABLED: "" }, database);
  await commentsOnly(event("GET", { query: { state: "pending" } }));
  assert.deepEqual(database.requests.map((request) => request.path), ["/rest/v1/openblog_comments"]);
  assert.equal((await commentsOnly(event("GET", { query: { id: ID(2), source: "feedback" } }))).statusCode, 422);
});

/** Evaluate the PostgREST conditions the inbox writes (and, or, eq, is.null, not.in) on a row. */
const matches = (condition, row) => {
  const group = /^(and|or)\((.*)\)$/.exec(condition);
  if (group) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < group[2].length; index += 1) {
      const char = group[2][index];
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        parts.push(group[2].slice(start, index));
        start = index + 1;
      }
    }
    parts.push(group[2].slice(start));
    return group[1] === "and" ? parts.every((part) => matches(part, row)) : parts.some((part) => matches(part, row));
  }
  const [column, ...rest] = condition.split(".");
  const operator = rest.join(".");
  const value = row[column] ?? null;
  if (operator === "is.null") return value === null;
  if (operator.startsWith("eq.")) return value === operator.slice(3);
  const notIn = /^not\.in\.\((.*)\)$/.exec(operator);
  if (notIn) return value !== null && !notIn[1].split(",").includes(value);
  throw new Error(`unknown condition ${condition}`);
};

test("a comment's state filter matches exactly the rows its two columns read as that state", () => {
  for (const status of ["pending", "approved", "rejected"]) {
    for (const moderationState of [null, ...MODERATION_STATES]) {
      const row = { status, moderation_state: moderationState };
      const state = commentState(moderationState, status);
      assert.equal(legacyCommentStatus(state), status, "a state never contradicts what public reads see");
      for (const asked of MODERATION_STATES) {
        const filter = commentStateFilter(asked);
        assert.equal(filter !== null && matches(filter, row), asked === state && filter !== null, `${asked} ${JSON.stringify(row)}`);
      }
    }
  }
});

test("decisions taken while the full schema was switched off read back as their status once it is on again", async () => {
  // One stored comment, written as the database would: the full function only while its state and
  // version match, the older route by its status alone.
  const row = comment(1, { version: 1, moderation_state: null, moderation_reason: null });
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("/rpc/openblog_moderate_comment")) {
      const { p_from, p_to, p_expected_version, p_reason } = request.body;
      if (commentState(row.moderation_state, row.status) !== p_from || row.version !== p_expected_version) return [];
      Object.assign(row, { moderation_state: p_to, status: legacyCommentStatus(p_to), moderation_reason: p_reason, version: row.version + 1 });
      return [{ ...row }];
    }
    if (request.method === "PATCH") {
      if (request.params.status !== `eq.${row.status}`) return [];
      Object.assign(row, request.body);
      return [{ ...row }];
    }
    // Only the columns asked for, as PostgREST answers.
    const selected = Object.fromEntries(request.params.select.split(",").map((column) => [column, row[column]]));
    if (request.params.id) return [selected];
    return matches(request.params.and.slice(1, -1), row) ? [selected] : [];
  });
  const on = handlerFor(full, database);
  const off = handlerFor(environment, database);
  const listed = async (handler, state) => JSON.parse((await handler(event("GET", { query: { state, kind: "comment" } }))).body).items.map((item) => item.status);
  const send = async (handler, body) => {
    const response = await handler(event("PATCH", { body: decision(body) }));
    assert.equal(response.statusCode, 200, response.body);
    return JSON.parse(response.body).item;
  };
  // With the schema: approved, then removed.
  await send(on, { action: "approve", from: "pending", expectedVersion: 1 });
  assert.equal((await send(on, { action: "remove", from: "approved", reason: "spam", expectedVersion: 2 })).status, "removed");
  assert.deepEqual(await listed(on, "removed"), ["removed"]);
  // Without it: reopened and approved again, which writes `status` alone.
  assert.equal((await send(off, { action: "reopen", from: "rejected", expectedVersion: 1 })).status, "pending");
  assert.equal((await send(off, { action: "approve", from: "pending", expectedVersion: 1 })).status, "approved");
  assert.deepEqual({ status: row.status, moderation_state: row.moderation_state }, { status: "approved", moderation_state: "removed" });
  // With it again: the live comment is approved, never shown as removed, and can be removed afresh.
  assert.deepEqual(await listed(on, "approved"), ["approved"]);
  assert.deepEqual(await listed(on, "removed"), []);
  const one = JSON.parse((await on(event("GET", { query: { id: ID(1), source: "comment" } }))).body);
  assert.equal(one.items[0].status, "approved");
  assert.equal((await send(on, { action: "remove", from: "approved", reason: "abusive", expectedVersion: 3 })).status, "removed");
  assert.deepEqual({ status: row.status, moderation_state: row.moderation_state, version: row.version }, { status: "rejected", moderation_state: "removed", version: 4 });
});

const decision = (extra = {}) => ({ source: "comment", id: ID(1), action: "approve", from: "pending", expectedVersion: 4, actor: "ada", actorRole: "site-admin", ...extra });

test("a decision is checked again from the stored row and written once, conditionally, with its audit role", async () => {
  const stored = comment(1, { version: 4, moderation_state: "pending", moderation_reason: null });
  const database = fakeDatabase((request) => {
    if (request.path.endsWith("/rpc/openblog_moderate_comment")) return [{ ...stored, status: "approved", moderation_state: "approved", version: 5 }];
    return [stored];
  });
  const handler = handlerFor(full, database);
  const response = await handler(event("PATCH", { body: decision() }));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(JSON.parse(response.body).item.status, "approved");
  const write = database.requests.at(-1);
  assert.equal(write.path, "/rest/v1/rpc/openblog_moderate_comment");
  assert.deepEqual(write.body, {
    p_site_id: "lantern", p_id: ID(1), p_expected_version: 4, p_from: "pending", p_to: "approved", p_action: "approve",
    p_reason: null, p_actor: "ada", p_actor_role: "site-admin", p_at: "2026-10-27T10:00:00Z",
  });
  // An account name the audit trail cannot hold is the token's.
  await handler(event("PATCH", { body: decision({ actor: "Robert'); drop table" }) }));
  assert.equal(database.requests.at(-1).body.p_actor, "@moderation-token");

  // Feedback goes through its own function; a clarification needs the reader's consent.
  const asking = fakeDatabase((request) => (request.path.includes("/rpc/") ? [feedback(2, { status: "clarification", version: 2, item_revision: 1, clarification_asked: 1, clarification_consent: true })] : [feedback(2, { item_revision: 1, clarification_consent: true })]));
  const ask = await handlerFor(full, asking)(event("PATCH", { body: decision({ source: "feedback", id: ID(2), action: "request-clarification", reason: "unclear", expectedVersion: 1, actorRole: "coordinator" }) }));
  assert.equal(ask.statusCode, 200, ask.body);
  assert.equal(asking.requests.at(-1).path, "/rest/v1/rpc/openblog_moderate_feedback_item");
  assert.equal(asking.requests.at(-1).body.p_actor_role, "coordinator");
  assert.equal(JSON.parse(ask.body).item.clarificationAsked, 1);
});

test("stale, refused and conflicting decisions write nothing and say why without repeating the item", async () => {
  const stored = comment(1, { version: 4, moderation_state: "removed", status: "rejected" });
  const database = fakeDatabase((request) => (request.path.includes("/rpc/") ? assert.fail("nothing may be written") : [stored]));
  const handler = handlerFor(full, database);
  // A view from before someone else's decision.
  const stale = await handler(event("PATCH", { body: decision({ from: "pending" }) }));
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).item.status, "removed");
  assert.equal((await handler(event("PATCH", { body: decision({ from: "removed", action: "reopen", expectedVersion: 3 }) }))).statusCode, 409);
  // Only the site Admin reopens; a reason is required to reject; roles are closed.
  const denied = await handler(event("PATCH", { body: decision({ from: "removed", action: "reopen", actorRole: "coordinator" }) }));
  assert.equal(denied.statusCode, 403);
  assert.equal(JSON.parse(denied.body).code, "denied");
  for (const body of [
    decision({ from: "removed", action: "approve" }),
    decision({ from: "removed", action: "remove", reason: "spam" }),
    decision({ actorRole: "contributing-author" }),
    decision({ actorRole: "public" }),
    decision({ action: "withdraw" }),
    decision({ action: "uphold-report" }),
    decision({ source: "abuse" }),
    decision({ expectedVersion: 0 }),
    decision({ expectedVersion: "4" }),
    decision({ from: "published" }),
  ]) {
    const refused = await handler(event("PATCH", { body }));
    assert.ok([403, 422].includes(refused.statusCode), `${JSON.stringify(body)} ${refused.statusCode}`);
    assert.doesNotMatch(refused.body, /onerror|Grace/);
  }
  // The row moved between the read and the write: the database refuses, and the item is shown as it is now.
  let reads = 0;
  const racing = fakeDatabase((request) => {
    if (request.path.includes("/rpc/")) return [];
    reads += 1;
    return [reads === 1 ? comment(1, { version: 4, moderation_state: "pending" }) : comment(1, { version: 5, moderation_state: "rejected", status: "rejected" })];
  });
  const raced = await handlerFor(full, racing)(event("PATCH", { body: decision() }));
  assert.equal(raced.statusCode, 409);
  assert.equal(JSON.parse(raced.body).item.status, "rejected");
  // A missing item is not found, before and after.
  const missing = await handlerFor(full, fakeDatabase(() => []))(event("PATCH", { body: decision() }));
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).code, "notFound");
});

test("an older schema stores only what it can, with a status-conditional write for comments", async () => {
  const database = fakeDatabase((request) => {
    if (request.method === "PATCH") return [comment(1, { status: "rejected" })];
    if (request.path.endsWith("/openblog_comments")) return [comment(1, { status: "approved" })];
    return [feedback(2, { status: "removed", version: 3 })];
  });
  const handler = handlerFor(environment, database);
  const removed = await handler(event("PATCH", { body: decision({ action: "remove", from: "approved", reason: "spam", expectedVersion: 1 }) }));
  assert.equal(removed.statusCode, 200, removed.body);
  const write = database.requests.at(-1);
  assert.equal(write.method, "PATCH");
  assert.equal(write.params.status, "eq.approved");
  assert.deepEqual(write.body, { status: "rejected", moderated_at: "2026-10-27T10:00:00Z" });
  // Reopening feedback needs the inbox's schema; nothing is written.
  database.requests.length = 0;
  const reopen = await handler(event("PATCH", { body: decision({ source: "feedback", id: ID(2), action: "reopen", from: "removed", expectedVersion: 3 }) }));
  assert.equal(reopen.statusCode, 422);
  assert.match(JSON.parse(reopen.body).error, /moderation\.sql/);
  assert.equal(database.requests.some((request) => request.method !== "GET"), false);
});

test("with the inbox's schema the older comment route refuses to skip versions and audit", async () => {
  const database = fakeDatabase(() => assert.fail("nothing may be written"));
  const response = await handlerFor(full, database)({
    path: "/api/admin/comments", httpMethod: "PATCH", headers: ADMIN, queryStringParameters: {}, body: JSON.stringify({ id: ID(1), status: "approved" }),
  });
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, "useModerationInbox");
});

test("a failing provider is a short 502 that names no secret", async () => {
  const handler = handlerFor(full, fakeDatabase(() => new Error("down")));
  for (const request of [event("GET"), event("PATCH", { body: decision() })]) {
    const response = await handler(request);
    assert.equal(response.statusCode, 502);
    assert.doesNotMatch(response.body, /sb_secret|admin-secret|boom/);
  }
});

const statementsOf = (sql) => sql.replace(/--[^\n]*/g, "").toLowerCase();

test("the inbox's schema is additive, private and opt-in, and its rollback drops exactly what it added", () => {
  const added = statementsOf(moderationSql);
  for (const forbidden of [/\bdrop\b/, /\brename\b/, /\bdelete\s+from\b/, /\btruncate\b/, /\balter\s+column\b/, /security\s+definer/, /create policy/, /grant[^;]*\b(anon|authenticated)\b/, /openblog_feedback/]) {
    assert.doesNotMatch(added, forbidden);
  }
  // Only new columns on comments, each with a default or nullable.
  assert.deepEqual(added.match(/alter table public\.[a-z_]+\s+add column if not exists [a-z_]+ [a-z]+[^;]*;/g).map((statement) => statement.replace(/\s+/g, " ")), [
    "alter table public.openblog_comments add column if not exists version integer not null default 1 check (version >= 1);",
    "alter table public.openblog_comments add column if not exists moderation_state text check (moderation_state ~ '^[a-z][a-z-]{0,31}$');",
    "alter table public.openblog_comments add column if not exists moderation_reason text check (moderation_reason ~ '^[a-z][a-z-]{0,31}$');",
  ]);
  assert.equal(added.match(/\balter table\b/g).length, 4, "three columns and the events table's row level security");
  assert.match(added, /alter table public\.openblog_comment_events enable row level security/);
  assert.match(added, /revoke all on public\.openblog_comment_events from public, anon, authenticated, service_role;\s*grant select, insert on public\.openblog_comment_events to service_role;/);
  // Public reads keep `status`, and nothing not public is ever stored there as approved.
  assert.match(added, /status = case p_to when 'pending' then 'pending' when 'approved' then 'approved' else 'rejected' end/);
  // The full state counts only while `status` still holds its legacy value (ADR 0106).
  assert.match(added, /when moderation_state is not null\s+and status = case moderation_state\s+when 'pending' then 'pending'\s+when 'clarification' then 'pending'\s+when 'approved' then 'approved'\s+else 'rejected'\s+end\s+then moderation_state\s+else status\s+end\) = p_from\s+and version = p_expected_version/);
  assert.doesNotMatch(baseSchema, /moderation_state|openblog_comment_events/);

  // The feedback side adds columns to its own tables and guards the clarification rule in SQL.
  const feedbackStatements = statementsOf(feedbackSql);
  for (const column of ["item_revision integer not null default 1", "approved_revision integer check", "clarification_asked integer check", "clarification_consent boolean not null default false"]) {
    assert.match(feedbackStatements, new RegExp(`alter table public\\.openblog_feedback\\s+add column if not exists ${column}`));
  }
  for (const column of ["kind", "item_revision", "actor_role"]) {
    assert.match(feedbackStatements, new RegExp(`alter table public\\.openblog_feedback_events\\s+add column if not exists ${column} `));
  }
  assert.match(feedbackStatements, /and not \(p_to = 'approved' and clarification_asked is not distinct from item_revision\)/);
  assert.match(feedbackStatements, /and not \(p_action = 'request-clarification' and not clarification_consent\)/);

  const undo = statementsOf(moderationRollback);
  assert.deepEqual(undo.match(/\b(drop|alter)\b[^;]*;/g), [
    "drop function if exists public.openblog_moderate_comment(text, uuid, integer, text, text, text, text, text, text, timestamptz);",
    "drop table if exists public.openblog_comment_events;",
    "alter table public.openblog_comments drop column if exists moderation_reason;",
    "alter table public.openblog_comments drop column if exists moderation_state;",
    "alter table public.openblog_comments drop column if exists version;",
    "drop function if exists public.openblog_record_feedback_decision(text, uuid, integer, integer, jsonb, text, text, timestamptz);",
    "drop function if exists public.openblog_moderate_feedback_item(text, uuid, integer, text, text, text, text, text, text, timestamptz, text, jsonb);",
    "alter table if exists public.openblog_feedback_events drop column if exists actor_role;",
    "alter table if exists public.openblog_feedback_events drop column if exists item_revision;",
    "alter table if exists public.openblog_feedback_events drop column if exists kind;",
    "alter table if exists public.openblog_feedback drop column if exists clarification_consent;",
    "alter table if exists public.openblog_feedback drop column if exists clarification_asked;",
    "alter table if exists public.openblog_feedback drop column if exists approved_revision;",
    "alter table if exists public.openblog_feedback drop column if exists item_revision;",
  ]);
});
