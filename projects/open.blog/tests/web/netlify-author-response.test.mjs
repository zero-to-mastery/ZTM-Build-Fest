// Author responses to Third Perspectives through the one hosted engagement function (#223, ADRs
// 0131 and 0132), exercised through HTTP-shaped events with a fake Supabase and site: Admin sends
// one request for an answer its signed-in account may write, the function reads it strictly, reads
// the parent from its own store and checks it again, and stores the answer pending as one feedback
// row of the existing table (no schema change); impersonation, a coordinator speaking as the author,
// a stale or hidden parent, another author's section, conflicts, rate limits, duplicates, hostile
// text, a missing opt-in or service; moderation through the one inbox, whose approval needs a shown
// parent and is never the writer's own; and the author's withdrawal. The pure rules are held to
// tests/fixtures/author-responses.json, which the build reads too.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import {
  checkAnswerParent, mayDecideResponse, parentFactsOfRow, readAuthorResponseRequest, receiveAuthorResponse,
} from "../../netlify/lib/author-response.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = JSON.parse(read("../fixtures/author-responses.json"));
const feedbackSql = read("../../supabase/feedback.sql");

const environment = {
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: "sb_secret_test_server_only",
  OPENBLOG_SITE_ID: "lantern",
  OPENBLOG_SITE_ORIGIN: "https://blog.example",
  OPENBLOG_ADMIN_API_KEY: "admin-secret",
  OPENBLOG_ANALYTICS_SALT: "daily-hash-secret",
  OPENBLOG_FEEDBACK_ENABLED: "true",
  OPENBLOG_MODERATION_ENABLED: "true",
  OPENBLOG_PROTECTION_ENABLED: "true",
  OPENBLOG_THIRD_PERSPECTIVES_ENABLED: "true",
  OPENBLOG_AUTHOR_RESPONSES_ENABLED: "true",
};
const NOW = new Date("2026-10-26T10:00:00.000Z");
const ORIGIN = { origin: "https://blog.example" };
const ADMIN = { authorization: "Bearer admin-secret" };
const WORK = "/posts/shared-tides/";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DIGEST = "0123456789abcdef0123456789abcdef";
const REVISION = `p1:${"a".repeat(32)}`;
const MINA_TARGET = { version: 1, kind: "section", section: "ob-by-mina-0", digest: DIGEST };

const event = (path, method, { query = {}, body, headers = {} } = {}) => ({
  path: `/api/${path}`,
  httpMethod: method,
  headers: { "x-nf-client-connection-ip": "203.0.113.9", ...headers },
  queryStringParameters: query,
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

const fakeDatabase = (answer = () => []) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const entry = { path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(entry);
    const value = await answer(entry);
    if (entry.path.endsWith("/rpc/openblog_consume_rate_limit")) return { ok: true, status: 200, json: async () => (value && typeof value === "object" && "allowed" in value ? value : { allowed: true }) };
    if (value instanceof Error) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value };
  };
  return { requests, fetchImpl };
};
const site = (modes = {}) => async (url) => {
  if (url.endsWith("openblog-participation.json")) {
    return { ok: true, status: 200, json: async () => ({ [WORK]: { "third-perspective": "open", "author-response": "open", ...modes }, "/posts/other/": { "third-perspective": "open" } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const handlerFor = (database, { env = environment, modes = {} } = {}) => createHandler({ env, fetchImpl: database.fetchImpl, siteFetchImpl: site(modes), now: () => NOW });
const writes = (database) => database.requests.filter((entry) => entry.method !== "GET" && !entry.path.endsWith("/rpc/openblog_consume_rate_limit"));
const inserted = (database) => writes(database).find((entry) => entry.method === "POST" && entry.path.endsWith("/openblog_feedback"));

// A stored Third Perspective, approved, about MINA's first section.
const perspective = (extra = {}) => ({
  id: ID(1), status: "approved", version: 3, moderated_at: "2026-10-26T09:00:00+00:00", moderation_reason: null, format_version: 1, kind: "third-perspective",
  work: WORK, revision: REVISION, target: MINA_TARGET, body: "I read the harbour differently.",
  details: { intake: { receiptDigest: "5e".repeat(32) }, consents: [{ number: 1, givenAt: "2026-10-26T08:00:00Z", publish: true, attribution: { publishName: false }, clarification: false }] },
  seen_at: null, received_at: "2026-10-26T08:00:00+00:00", channel: "hosted", reader_name: null, publish_name: false,
  item_revision: 1, approved_revision: 1, clarification_asked: null, clarification_consent: false, purged_at: null, approved_consent: 1, ...extra,
});
const request = (overrides = {}) => ({
  version: 1, kind: "author-response", work: WORK, parent: { id: ID(1), version: 3 }, body: "I meant the harbour, not the open sea.",
  responder: { contributor: "mina", author: "MINA", standing: { state: "current", moved: false } }, binding: { participant: "p-mina" }, actor: "mina-admin", ...overrides,
});
// A stored answer, as the table holds it.
const answerRow = (extra = {}) => ({
  id: ID(2), status: "pending", version: 1, moderated_at: null, moderation_reason: null, format_version: 1, kind: "author-response",
  work: WORK, revision: REVISION, target: MINA_TARGET, body: "I meant the harbour, not the open sea.",
  details: { parent: ID(1), responder: { contributor: "mina", author: "MINA", standing: { state: "current", moved: false } }, binding: { participant: "p-mina", account: "mina-admin" } },
  seen_at: null, received_at: "2026-10-26T09:30:00+00:00", channel: "hosted", reader_name: null, publish_name: false,
  item_revision: 1, approved_revision: null, clarification_asked: null, clarification_consent: false, purged_at: null, ...extra,
});

// The database as it holds the parent (and, optionally, an answer already there).
const store = ({ parent = perspective(), answers = [], answer = answerRow() } = {}) => (entry) => {
  if (entry.method === "POST" && entry.path.endsWith("/openblog_feedback")) return [{ id: ID(7), status: "pending", received_at: "2026-10-26T10:00:00+00:00" }];
  if (entry.method === "GET" && entry.path.endsWith("/openblog_feedback")) {
    if (entry.params["details->>parent"]) return answers;
    if (entry.params.id === `eq.${ID(1)}`) return parent ? [parent] : [];
    if (entry.params.id === `eq.${ID(2)}`) return answer ? [answer] : [];
    return [];
  }
  return [];
};
const answerCall = (database, body, options = {}) => handlerFor(database, options)(event("admin/author-response", "POST", { headers: ADMIN, body }));

// ---- The shared fixture

test("the function's request reader, row builder, parent check and decision rule agree with the build's fixture", () => {
  assert.ok(fixture.requests.length >= 35);
  for (const entry of fixture.requests) {
    const text = entry.text ?? JSON.stringify(entry.request);
    const outcome = readAuthorResponseRequest(text);
    if (entry.expect.row) {
      assert.ok(outcome.ok, `${entry.name}: ${outcome.error?.message}`);
      const row = receiveAuthorResponse(outcome.request, entry.parent, fixture.receivedAt);
      assert.deepEqual(JSON.parse(JSON.stringify(row)), entry.expect.row, entry.name);
    } else {
      assert.equal(outcome.ok, false, entry.name);
      assert.equal(outcome.error.code, entry.expect.code, `${entry.name}: ${outcome.error.message}`);
    }
  }
  for (const entry of fixture.parents) {
    const code = checkAnswerParent(entry.facts, entry.work, entry.contributor);
    assert.equal(code ?? "ok", entry.expect, entry.name);
  }
  for (const entry of fixture.decisions) {
    assert.equal(mayDecideResponse(entry.account, entry.decider, entry.action) ? "allowed" : "denied", entry.expect, entry.name);
  }
});

test("a stored row's facts are read the way the build reads a parent", () => {
  assert.deepEqual(parentFactsOfRow(perspective()), {
    kind: "third-perspective", work: WORK, state: "approved", revision: 1, approvedRevision: 1, clarificationAsked: null,
    approvedConsentPublishes: true, currentConsentPublishes: true, retained: true, target: MINA_TARGET,
  });
  assert.equal(checkAnswerParent(parentFactsOfRow(perspective()), WORK, "mina"), null);
  // The reader revoked consent after the approval; the text was purged; the approval covers no consent.
  const revoked = perspective({ details: { consents: [...perspective().details.consents, { number: 2, givenAt: "2026-10-27T00:00:00Z", publish: false, attribution: { publishName: false }, clarification: false }] } });
  assert.equal(checkAnswerParent(parentFactsOfRow(revoked), WORK, "mina"), "parentUnavailable");
  assert.equal(checkAnswerParent(parentFactsOfRow(perspective({ purged_at: "2026-10-27T00:00:00+00:00" })), WORK, "mina"), "parentUnavailable");
  assert.equal(checkAnswerParent(parentFactsOfRow(perspective({ approved_consent: null })), WORK, "mina"), "parentUnavailable");
});

// ---- Storing an answer

test("an answer is stored pending as one feedback row of the existing table, with its parent's revision and target", async () => {
  const database = fakeDatabase(store());
  const response = await answerCall(database, request());
  assert.equal(response.statusCode, 202);
  const answer = JSON.parse(response.body);
  assert.deepEqual(Object.keys(answer).sort(), ["id", "receivedAt", "status"]);
  assert.equal(answer.status, "pending");
  const row = inserted(database).body;
  assert.equal(row.status, "pending", "never anything but pending");
  assert.equal(row.kind, "author-response");
  assert.equal(row.work, WORK);
  assert.equal(row.revision, REVISION, "the parent row's revision, never the request's");
  assert.deepEqual(row.target, MINA_TARGET);
  assert.equal(row.body, "I meant the harbour, not the open sea.");
  assert.deepEqual(row.details, {
    parent: ID(1),
    responder: { contributor: "mina", author: "MINA", standing: { state: "current", moved: false } },
    binding: { participant: "p-mina", account: "mina-admin" },
  });
  assert.equal(row.received_at, "2026-10-26T10:00:00Z", "the receiver's clock");
  assert.equal(row.reader_name, null);
  assert.equal(row.publish_name, false);
  assert.equal(row.clarification_consent, false);
  assert.ok(!("receipt_hash" in row), "an answer has no receipt: nobody can take it back but its author, through Admin");
  for (const field of ["rank", "rating", "score", "vote", "approved_revision", "approved_consent"]) assert.ok(!(field in row), field);
  assert.doesNotMatch(response.body, /p-mina|mina-admin/, "the binding is never answered back");
  // It is an ordinary feedback insert: the function adds nothing to the schema or its columns.
  assert.equal(inserted(database).path, "/rest/v1/openblog_feedback");
});

test("the quota is per answering account and the same answer is taken once an hour", async () => {
  const database = fakeDatabase(store());
  await answerCall(database, request());
  const quota = database.requests.find((entry) => entry.path.endsWith("/rpc/openblog_consume_rate_limit") && entry.body.p_bucket === "author-response");
  const hour = "2026-10-26T10:00:00Z";
  assert.equal(quota.body.p_subject_hash, createHash("sha256").update(`daily-hash-secret\0author-response\0${hour}\0mina-admin`).digest("hex"), "per account, never per address");
  assert.equal(quota.body.p_subject_limit, 20);
  const limited = fakeDatabase((entry) => (entry.path.endsWith("/rpc/openblog_consume_rate_limit") ? { allowed: false } : store()(entry)));
  const tooMany = await answerCall(limited, request());
  assert.equal(tooMany.statusCode, 429);
  assert.equal(JSON.parse(tooMany.body).code, "rateLimited");
  assert.equal(inserted(limited), undefined);

  let repeats = 0;
  const repeated = fakeDatabase((entry) => {
    if (entry.path.endsWith("/rpc/openblog_consume_rate_limit")) return { allowed: entry.body.p_bucket !== "author-response-repeat" || (repeats += 1) === 1 };
    return store()(entry);
  });
  assert.equal((await answerCall(repeated, request())).statusCode, 202);
  const again = await answerCall(repeated, request());
  assert.equal(again.statusCode, 409);
  assert.equal(JSON.parse(again.body).code, "duplicate");

  const failing = fakeDatabase((entry) => (entry.method === "POST" && entry.path.endsWith("/openblog_feedback") ? new Error("down") : store()(entry)));
  const failed = await answerCall(failing, request());
  assert.equal(failed.statusCode, 502);
  assert.ok(failing.requests.some((entry) => entry.method === "DELETE" && entry.path.endsWith("/openblog_rate_limits")), "the repeat claim is released, so a retry is taken");
});

test("only Admin's token reaches the route, and a reader's origin is nobody", async () => {
  for (const headers of [ORIGIN, { ...ORIGIN, authorization: "Bearer wrong" }, {}]) {
    const database = fakeDatabase(store());
    const response = await handlerFor(database)(event("admin/author-response", "POST", { headers, body: request() }));
    assert.ok([401, 403].includes(response.statusCode), `${JSON.stringify(headers)}: ${response.statusCode}`);
    assert.equal(database.requests.length, 0, "no store is touched");
  }
  const withdraw = fakeDatabase(store());
  const refused = await handlerFor(withdraw)(event("admin/author-response", "PATCH", { headers: ORIGIN, body: { id: ID(2), expectedVersion: 1, actor: "mina-admin" } }));
  assert.ok([401, 403].includes(refused.statusCode));
  assert.equal(withdraw.requests.length, 0);
});

test("the opt-in, the site's mode and an absent service each answer without storing anything", async () => {
  for (const env of [{ ...environment, OPENBLOG_AUTHOR_RESPONSES_ENABLED: "" }, { ...environment, OPENBLOG_THIRD_PERSPECTIVES_ENABLED: "" }, { ...environment, OPENBLOG_PROTECTION_ENABLED: "" }]) {
    const database = fakeDatabase(store());
    const response = await answerCall(database, request(), { env });
    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).code, "unavailable");
    assert.equal(database.requests.length, 0);
  }
  for (const [mode, status, code] of [["locked", 403, "closed"], ["hidden", 403, "unavailable"]]) {
    const database = fakeDatabase(store());
    const response = await answerCall(database, request(), { modes: { "author-response": mode } });
    assert.equal(response.statusCode, status, mode);
    assert.equal(JSON.parse(response.body).code, code);
    assert.equal(inserted(database), undefined);
  }
  // The service itself is not configured.
  const unconfigured = await createHandler({ env: {}, fetchImpl: fakeDatabase().fetchImpl })(event("admin/author-response", "POST", { headers: ADMIN, body: request() }));
  assert.equal(unconfigured.statusCode, 503);
  // The database is down: a plain, honest failure, nothing claimed stored.
  const down = fakeDatabase(() => new Error("down"));
  const failed = await answerCall(down, request());
  assert.equal(failed.statusCode, 502);
  assert.doesNotMatch(failed.body, /down|database\.example/);
});

test("the function reads the parent itself: pending, hidden, changed, another work's or another author's parents refuse", async () => {
  const cases = [
    ["a pending parent", { parent: perspective({ status: "pending", approved_revision: null, approved_consent: null }) }, request(), {}, 409, "parentUnavailable"],
    ["a removed parent", { parent: perspective({ status: "removed" }) }, request(), {}, 409, "parentUnavailable"],
    ["a missing parent", { parent: null }, request(), {}, 409, "parentUnavailable"],
    ["a parent whose text was purged", { parent: perspective({ purged_at: "2026-10-27T00:00:00+00:00" }) }, request(), {}, 409, "parentUnavailable"],
    ["a parent whose kind the post hides", {}, request(), { "third-perspective": "hidden" }, 409, "parentUnavailable"],
    ["a parent that changed since Admin loaded it", { parent: perspective({ version: 4 }) }, request(), {}, 409, "conflict"],
    ["a parent about another author's section", { parent: perspective({ target: { ...MINA_TARGET, section: "ob-by-joe-0" } }) }, request(), {}, 422, "responderMismatch"],
    ["a parent about the whole work", { parent: perspective({ target: { version: 1, kind: "work" } }) }, request(), {}, 422, "notAttributed"],
    ["a parent about an ordinary heading", { parent: perspective({ target: { version: 1, kind: "section", section: "methods", digest: DIGEST } }) }, request(), {}, 422, "notAttributed"],
    ["a parent of another work", { parent: perspective({ work: "/posts/other/" }) }, request(), {}, 422, "wrongWork"],
    ["a parent that is not a Third Perspective", { parent: perspective({ kind: "question" }) }, request(), {}, 409, "parentUnavailable"],
    ["a coordinator answering as another contributor", {}, request({ responder: { contributor: "coord", author: "COORD", standing: { state: "current", moved: false } }, binding: { participant: "p-coord" }, actor: "coord-admin" }), {}, 422, "responderMismatch"],
  ];
  for (const [name, options, body, modes, status, code] of cases) {
    const database = fakeDatabase(store(options));
    const response = await answerCall(database, body, { modes });
    assert.equal(response.statusCode, status, name);
    assert.equal(JSON.parse(response.body).code, code, name);
    assert.equal(inserted(database), undefined, `${name}: nothing is stored`);
  }
});

test("a reflection that already has an answer waiting or shown is not answered twice", async () => {
  const database = fakeDatabase(store({ answers: [{ id: ID(2) }] }));
  const response = await answerCall(database, request());
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, "alreadyAnswered");
  const lookup = database.requests.find((entry) => entry.params["details->>parent"]);
  assert.equal(lookup.params["details->>parent"], `eq.${ID(1)}`);
  assert.equal(lookup.params.status, "in.(pending,approved)", "a withdrawn or rejected answer can be replaced");
  assert.equal(lookup.params.kind, "eq.author-response");
  assert.equal(inserted(database), undefined);
});

test("hostile or malformed requests are refused without echoing what was written", async () => {
  const markup = "<script>alert(1)</script> <img src=x onerror=alert(2)> &amp; [x](javascript:alert(3))";
  const database = fakeDatabase(store());
  const stored = await answerCall(database, request({ body: markup }));
  assert.equal(stored.statusCode, 202);
  assert.equal(inserted(database).body.body, markup, "stored exactly as written; pages escape it");
  for (const [body, code] of [
    [request({ body: "   " }), "invalidBody"],
    [request({ body: "a\u0000b" }), "invalidBody"],
    [request({ body: "x‮y" }), "invalidBody"],
    [request({ kind: "third-perspective" }), "wrongKind"],
    [request({ actor: "@moderation-token" }), "invalidActor"],
    [request({ responder: { contributor: "Mina", author: "MINA", standing: { state: "current", moved: false } } }), "invalidResponder"],
    [{ ...request(), rank: 1 }, "malformed"],
  ]) {
    const refused = fakeDatabase(store());
    const response = await answerCall(refused, body);
    assert.equal(response.statusCode, 422, code);
    const answer = JSON.parse(response.body);
    assert.equal(answer.code, code);
    assert.doesNotMatch(answer.error, /alert|harbour|mina-admin/, "the message never repeats what was written");
    assert.equal(inserted(refused), undefined);
  }
  const huge = await answerCall(fakeDatabase(store()), request({ body: "a".repeat(40_000) }));
  assert.equal(huge.statusCode, 413);
  const notJson = await handlerFor(fakeDatabase())(event("admin/author-response", "POST", { headers: ADMIN, body: "{" }));
  assert.equal(notJson.statusCode, 400);
});

// ---- Moderation through the one inbox

const decide = async (row, body, { env = environment, parent = perspective(), modes = {}, shown = [] } = {}) => {
  const database = fakeDatabase((entry) => {
    if (entry.path.endsWith("/rpc/openblog_moderate_feedback_item")) return [{ ...row, status: entry.body.p_to, version: row.version + 1, approved_revision: entry.body.p_to === "approved" ? 1 : null }];
    if (entry.method === "GET" && entry.path.endsWith("/openblog_feedback")) {
      if (entry.params.id === `eq.${row.id}`) return [row];
      if (entry.params.id === `eq.${ID(1)}`) return parent ? [parent] : [];
      if (entry.params["details->>parent"]) return shown;
    }
    return [];
  });
  const response = await handlerFor(database, { env, modes })(event("admin/moderation", "PATCH", {
    headers: ADMIN, body: { source: "feedback", id: row.id, action: "approve", from: row.status, expectedVersion: row.version, actor: "coord-admin", actorRole: "coordinator", ...body },
  }));
  return { response, database, answer: JSON.parse(response.body) };
};

test("the inbox lists author responses beside the other kinds, with their responder", async () => {
  const database = fakeDatabase((entry) => (entry.path.endsWith("/openblog_feedback") ? [answerRow()] : []));
  const response = await handlerFor(database)(event("admin/moderation", "GET", { headers: ADMIN, query: { state: "pending", kind: "author-response" } }));
  assert.equal(response.statusCode, 200);
  const page = JSON.parse(response.body);
  assert.equal(page.items.length, 1);
  const item = page.items[0];
  assert.equal(item.feedback.kind, "author-response");
  assert.equal(item.feedback.details.responder.contributor, "mina");
  assert.equal(item.clarificationConsent, false);
  assert.equal(item.approvedConsent, undefined, "only a Third Perspective's approval binds a consent record");
  assert.equal(database.requests.find((entry) => entry.path.endsWith("/openblog_feedback")).params.and.includes("kind.eq.author-response"), true);
  assert.equal(item.feedback.provenance.attribution.publishName, false);
});

test("an answer is approved by a coordinator under a shown parent, and the database applies it", async () => {
  const { response, database, answer } = await decide(answerRow(), {});
  assert.equal(response.statusCode, 200);
  assert.equal(answer.ok, true);
  const call = writes(database).find((entry) => entry.path.endsWith("/rpc/openblog_moderate_feedback_item"));
  assert.equal(call.body.p_to, "approved");
  assert.equal(call.body.p_expected_version, 1);
  assert.equal(call.body.p_actor, "coord-admin");
  assert.equal(call.body.p_actor_role, "coordinator");
  // The parent was read from the store, not taken from the request.
  assert.ok(database.requests.some((entry) => entry.method === "GET" && entry.params.id === `eq.${ID(1)}`));
});

test("nobody approves their own answer, and an answer never outlives or contradicts its parent", async () => {
  const own = await decide(answerRow(), { actor: "mina-admin" });
  assert.equal(own.response.statusCode, 403);
  assert.equal(own.answer.code, "denied");
  assert.equal(writes(own.database).length, 0);
  for (const [name, parent, status, code] of [
    ["a parent taken down", perspective({ status: "removed" }), 409, "parentUnavailable"],
    ["a parent whose reader revoked consent", perspective({ details: { consents: [...perspective().details.consents, { number: 2, givenAt: "2026-10-27T00:00:00Z", publish: false, attribution: { publishName: false }, clarification: false }] } }), 409, "parentUnavailable"],
    ["a parent about another author's section", perspective({ target: { ...MINA_TARGET, section: "ob-by-joe-0" } }), 422, "responderMismatch"],
    ["no parent at all", null, 409, "parentUnavailable"],
  ]) {
    const refused = await decide(answerRow(), {}, { parent });
    assert.equal(refused.response.statusCode, status, name);
    assert.equal(refused.answer.code, code, name);
    assert.equal(writes(refused.database).length, 0, name);
  }
  // Without the author-response opt-in no answer is approved.
  const off = await decide(answerRow(), {}, { env: { ...environment, OPENBLOG_AUTHOR_RESPONSES_ENABLED: "" } });
  assert.equal(off.response.statusCode, 422);
  assert.equal(off.answer.code, "notAllowed");
  // Declining, and taking down, need no parent: a moderator can always close an answer.
  const rejected = await decide(answerRow(), { action: "reject", reason: "off-topic" }, { parent: null });
  assert.equal(rejected.response.statusCode, 200);
  assert.equal(writes(rejected.database)[0].body.p_to, "rejected");
  const removed = await decide(answerRow({ status: "approved", approved_revision: 1, version: 2 }), { action: "remove", reason: "other", from: "approved", expectedVersion: 2, actor: "mina-admin" }, { parent: null });
  assert.equal(removed.response.statusCode, 200, "the author may take their own words down");
});

test("a report about an answer whose parent is hidden answers as an answer that does not exist", async () => {
  const shown = answerRow({ status: "approved", approved_revision: 1, version: 2 });
  const report = async (parent, { database = fakeDatabase(store({ parent, answer: shown })) } = {}) => ({
    database,
    response: await handlerFor(database, { modes: { "abuse-report": "open" } })(event("reports", "POST", { headers: ORIGIN, body: { source: "feedback", id: ID(2), ground: "spam" } })),
  });
  const accepted = await report(perspective());
  assert.equal(accepted.response.statusCode, 202);
  for (const [name, parent] of [
    ["a parent taken down", perspective({ status: "removed" })],
    ["a parent whose reader revoked consent", perspective({ details: { consents: [...perspective().details.consents, { number: 2, givenAt: "2026-10-27T00:00:00Z", publish: false, attribution: { publishName: false }, clarification: false }] } })],
    ["a parent about another author's section", perspective({ target: { ...MINA_TARGET, section: "ob-by-joe-0" } })],
    ["no parent at all", null],
  ]) {
    const refused = await report(parent);
    assert.equal(refused.response.statusCode, 404, name);
    assert.equal(JSON.parse(refused.response.body).code, "unavailable", name);
    assert.equal(writes(refused.database).filter((entry) => entry.path.endsWith("/openblog_abuse_reports")).length, 0, name);
  }
});

test("two answers stored in the same instant are never both shown", async () => {
  const racing = await decide(answerRow(), {}, { shown: [{ id: ID(9) }] });
  assert.equal(racing.response.statusCode, 409);
  assert.equal(racing.answer.code, "alreadyAnswered");
  assert.equal(writes(racing.database).length, 0);
  const query = racing.database.requests.find((entry) => entry.params["details->>parent"] && entry.params.status === "eq.approved");
  assert.equal(query.params.id, `neq.${ID(2)}`);
});

test("an author is never asked to clarify, and a stale decision is a conflict", async () => {
  const clarify = await decide(answerRow(), { action: "request-clarification", reason: "unclear" });
  assert.equal(clarify.response.statusCode, 422, "the kind has no clarification");
  assert.equal(clarify.answer.code, "notAllowed");
  const stale = await decide(answerRow({ version: 2 }), { expectedVersion: 1 });
  assert.equal(stale.response.statusCode, 409);
  assert.equal(stale.answer.code, "conflict");
  assert.equal(writes(stale.database).length, 0);
});

test("B5's route never decides an author response", async () => {
  const database = fakeDatabase((entry) => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? [answerRow()] : []));
  const response = await handlerFor(database)(event("admin/feedback", "PATCH", { headers: ADMIN, body: { id: ID(2), expectedVersion: 1, from: "pending", action: "approve", actor: "coord-admin" } }));
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, "useModerationInbox");
  assert.equal(writes(database).length, 0);
});

// ---- Withdrawal

test("an author withdraws their own answer: the row, responder and audit stay, and it is never public again", async () => {
  const database = fakeDatabase((entry) => {
    if (entry.path.endsWith("/rpc/openblog_moderate_feedback_item")) return [answerRow({ status: "withdrawn", version: 2 })];
    return store({ answer: answerRow({ status: "approved", approved_revision: 1, version: 1 }) })(entry);
  });
  const response = await handlerFor(database)(event("admin/author-response", "PATCH", { headers: ADMIN, body: { id: ID(2), expectedVersion: 1, actor: "mina-admin" } }));
  assert.equal(response.statusCode, 200);
  const call = writes(database).find((entry) => entry.path.endsWith("/rpc/openblog_moderate_feedback_item"));
  assert.equal(call.body.p_to, "withdrawn");
  assert.equal(call.body.p_action, "withdraw");
  assert.equal(call.body.p_actor, "mina-admin");
  assert.equal(call.body.p_actor_role, "contributing-author");
  assert.ok(!writes(database).some((entry) => entry.path.endsWith("/rpc/openblog_erase_feedback")), "the text is not purged at once: retention does that, as for any closed item");
  assert.equal(JSON.parse(response.body).item.feedback.details.responder.contributor, "mina", "provenance stays");
});

test("only the account that wrote an answer withdraws it, and only while the version is the one it saw", async () => {
  const other = fakeDatabase(store());
  const refused = await handlerFor(other)(event("admin/author-response", "PATCH", { headers: ADMIN, body: { id: ID(2), expectedVersion: 1, actor: "joe-admin" } }));
  assert.equal(refused.statusCode, 404, "the same answer as for an answer that is not there");
  assert.equal(writes(other).length, 0);
  const missing = fakeDatabase(store({ answer: null }));
  assert.equal((await handlerFor(missing)(event("admin/author-response", "PATCH", { headers: ADMIN, body: { id: ID(2), expectedVersion: 1, actor: "mina-admin" } }))).statusCode, 404);
  const stale = fakeDatabase(store({ answer: answerRow({ version: 3 }) }));
  const conflict = await handlerFor(stale)(event("admin/author-response", "PATCH", { headers: ADMIN, body: { id: ID(2), expectedVersion: 1, actor: "mina-admin" } }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(writes(stale).length, 0);
  const closed = fakeDatabase(store({ answer: answerRow({ status: "rejected", version: 2 }) }));
  const notAllowed = await handlerFor(closed)(event("admin/author-response", "PATCH", { headers: ADMIN, body: { id: ID(2), expectedVersion: 2, actor: "mina-admin" } }));
  assert.equal(notAllowed.statusCode, 422);
  const invalid = await handlerFor(fakeDatabase(store()))(event("admin/author-response", "PATCH", { headers: ADMIN, body: { id: "x", expectedVersion: 1, actor: "mina-admin" } }));
  assert.equal(invalid.statusCode, 422);
});

// ---- No schema change

test("author responses add nothing to the hosted schema", () => {
  assert.doesNotMatch(feedbackSql, /author[-_]response/i, "an answer is a row of the existing table; supabase/feedback.sql is unchanged for it");
});
