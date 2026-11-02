// Third Perspective submission through the one hosted engagement function (#221, ADRs 0113 and
// 0111), exercised through HTTP-shaped events with a fake Supabase and site: a submission always
// enters pending as one feedback row with its consent in `details` and a private receipt; consent
// is validated and never assumed; rate limits, duplicates, spam-sized and hostile text, malformed
// JSON, a missing or failing service and the site's participation mode; the reader's receipt
// (reading, agreeing to be asked, clarifying, withdrawing); moderation through the one inbox, whose
// approval binds the text revision and consent record the moderator saw; and the additive SQL.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHandler } from "../../netlify/functions/engagement.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = JSON.parse(read("../fixtures/third-perspective-submissions.json"));
const feedbackSql = read("../../supabase/feedback.sql");
const rollback = read("../../supabase/third-perspective-rollback.sql");

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
};
const NOW = new Date("2026-10-26T10:00:00.000Z");
const ORIGIN = { origin: "https://blog.example" };
const ADMIN = { authorization: "Bearer admin-secret" };
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RECEIPT = "B".repeat(43);
const digest = (receipt) => createHash("sha256").update(receipt).digest("hex");

const event = (path, method, { query = {}, body, headers = {} } = {}) => ({
  path: `/api/${path}`,
  httpMethod: method,
  headers: { "x-nf-client-connection-ip": "203.0.113.9", ...headers },
  queryStringParameters: query,
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

const request = (overrides = {}) => ({ ...fixture.cases[1].request, ...overrides });

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
const site = (mode = "open") => async (url) => {
  if (url.endsWith("openblog-participation.json")) return { ok: true, status: 200, json: async () => ({ "/posts/tides/": { "third-perspective": mode, "abuse-report": "open" } }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const handlerFor = (database, { env = environment, mode = "open", now = () => NOW } = {}) => createHandler({ env, fetchImpl: database.fetchImpl, siteFetchImpl: site(mode), now });
const writes = (database) => database.requests.filter((entry) => entry.method !== "GET" && !entry.path.endsWith("/rpc/openblog_consume_rate_limit"));
const inserted = (database) => writes(database).find((entry) => entry.method === "POST" && entry.path.endsWith("/openblog_feedback"));

// A stored Third Perspective row, as the table holds it.
const stored = (extra = {}) => ({
  id: ID(1), status: "pending", version: 1, moderated_at: null, moderation_reason: null, format_version: 1, kind: "third-perspective",
  work: "/posts/tides/", revision: "p1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", target: { version: 1, kind: "work" }, body: "Another way to read the ending.",
  details: { category: "connection", intake: { receiptDigest: digest(RECEIPT) }, consents: [{ number: 1, givenAt: "2026-10-26T10:00:00Z", publish: true, attribution: { publishName: true }, clarification: true }] },
  seen_at: null, received_at: "2026-10-26T10:00:00+00:00", channel: "hosted", reader_name: "Ada", publish_name: true,
  item_revision: 1, approved_revision: null, clarification_asked: null, clarification_consent: true, purged_at: null, approved_consent: null, ...extra,
});

// ---- Submission

test("a submission always enters pending as one feedback row, with its consent in details and a receipt", async () => {
  const database = fakeDatabase((entry) => (entry.method === "POST" && entry.path.endsWith("/openblog_feedback") ? [{ id: ID(7), status: "pending", received_at: "2026-10-26T10:00:00+00:00" }] : []));
  const response = await handlerFor(database)(event("feedback", "POST", { headers: ORIGIN, body: request({ status: undefined }) }));
  assert.equal(response.statusCode, 202);
  const answer = JSON.parse(response.body);
  assert.equal(answer.status, "pending");
  assert.match(answer.receipt, /^[A-Za-z0-9_-]{43}$/);
  const row = inserted(database).body;
  assert.equal(row.status, "pending", "never anything but pending");
  assert.equal(row.kind, "third-perspective");
  assert.equal(row.receipt_hash, digest(answer.receipt), "only the receipt's digest is kept");
  assert.equal(row.details.intake.receiptDigest, row.receipt_hash);
  assert.deepEqual(row.details.consents, [{ number: 1, givenAt: "2026-10-26T10:00:00Z", publish: true, attribution: { publishName: true }, clarification: true, featureRevision: 1 }]);
  assert.equal(row.details.category, "connection");
  assert.equal(row.reader_name, "Ada");
  assert.equal(row.publish_name, true);
  assert.equal(row.clarification_consent, true);
  assert.equal(row.channel, "hosted");
  assert.equal(row.received_at, "2026-10-26T10:00:00Z", "the receiver's clock, never the reader's");
  for (const field of ["rank", "rating", "score", "vote", "approved_revision", "approved_consent"]) assert.ok(!(field in row), `no ${field} is collected`);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(answer.receipt), "the receipt itself is never stored");
});

test("hostile text is kept as plain text and never answered as markup", async () => {
  const database = fakeDatabase((entry) => (entry.method === "POST" && entry.path.endsWith("/openblog_feedback") ? [{ id: ID(7) }] : []));
  const body = "<script>alert(1)</script> <img src=x onerror=alert(2)> &amp; \"quoted\"";
  const response = await handlerFor(database)(event("feedback", "POST", { headers: ORIGIN, body: request({ body, attribution: { name: "<b>Ada</b>", publishName: false } }) }));
  assert.equal(response.statusCode, 202);
  assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(inserted(database).body.body, body, "stored exactly as written; pages escape it");
  assert.equal(inserted(database).body.reader_name, "<b>Ada</b>");
});

test("consent is checked, never assumed: no publication consent, a shown name without one, unknown fields", async () => {
  const cases = [
    [request({ consent: { publish: false, clarification: true } }), "publicationConsentRequired"],
    [request({ attribution: { publishName: true } }), "consentWithoutName"],
    [request({ consent: { publish: true, rank: 5 } }), "malformed"],
    [request({ rating: 3 }), "malformed"],
    [request({ category: "best" }), "unknownCategory"],
    [request({ target: { version: 1, kind: "quote", section: "methods", exact: "tides", prefix: "", suffix: "", start: 0 } }), "targetNotAllowed"],
    [request({ body: " " }), "invalidBody"],
  ];
  for (const [value, code] of cases) {
    const database = fakeDatabase();
    const response = await handlerFor(database)(event("feedback", "POST", { headers: ORIGIN, body: value }));
    assert.equal(response.statusCode, 422, code);
    const answer = JSON.parse(response.body);
    assert.equal(answer.code, code);
    assert.doesNotMatch(answer.error, /alert|Another way/, "the message never repeats what was written");
    assert.equal(writes(database).length, 0, `${code}: nothing is stored`);
  }
  const database = fakeDatabase();
  const tooLarge = await handlerFor(database)(event("feedback", "POST", { headers: ORIGIN, body: request({ body: "a".repeat(40_000) }) }));
  assert.equal(tooLarge.statusCode, 413, "spam-sized text is refused before it is read");
  const malformed = await handlerFor(database)(event("feedback", "POST", { headers: ORIGIN, body: '{"kind":"third-perspective",' }));
  assert.equal(malformed.statusCode, 422, "text that is not JSON is passage feedback's malformed answer");
  assert.equal(writes(database).length, 0);
});

test("rate limits, duplicates within the hour and a failing store each answer without losing the reader's claim", async () => {
  const limited = fakeDatabase((entry) => (entry.path.endsWith("/rpc/openblog_consume_rate_limit") ? { allowed: false } : []));
  const tooMany = await handlerFor(limited)(event("feedback", "POST", { headers: ORIGIN, body: request() }));
  assert.equal(tooMany.statusCode, 429);
  assert.equal(JSON.parse(tooMany.body).code, "rateLimited");
  assert.equal(inserted(limited), undefined);

  let calls = 0;
  const repeated = fakeDatabase((entry) => {
    if (entry.path.endsWith("/rpc/openblog_consume_rate_limit")) return { allowed: entry.body.p_bucket !== "feedback-repeat" || (calls += 1) === 1 };
    return entry.method === "POST" ? [{ id: ID(7) }] : [];
  });
  const handler = handlerFor(repeated);
  assert.equal((await handler(event("feedback", "POST", { headers: ORIGIN, body: request() }))).statusCode, 202);
  const again = await handler(event("feedback", "POST", { headers: ORIGIN, body: request() }));
  assert.equal(again.statusCode, 409);
  assert.equal(JSON.parse(again.body).code, "duplicate", "a double submit is told it was already sent");

  const failing = fakeDatabase((entry) => (entry.method === "POST" && entry.path.endsWith("/openblog_feedback") ? new Error("down") : []));
  const failed = await handlerFor(failing)(event("feedback", "POST", { headers: ORIGIN, body: request() }));
  assert.equal(failed.statusCode, 502);
  assert.ok(failing.requests.some((entry) => entry.method === "DELETE" && entry.path.endsWith("/openblog_rate_limits")), "the repeat claim is released, so a retry is taken");
});

test("the site's mode, the opt-in and the origin gate every submission", async () => {
  for (const [mode, status, code] of [["locked", 403, "closed"], ["hidden", 403, "unavailable"]]) {
    const database = fakeDatabase();
    const response = await handlerFor(database, { mode })(event("feedback", "POST", { headers: ORIGIN, body: request() }));
    assert.equal(response.statusCode, status, mode);
    assert.equal(JSON.parse(response.body).code, code);
    assert.equal(inserted(database), undefined);
  }
  for (const env of [{ ...environment, OPENBLOG_THIRD_PERSPECTIVES_ENABLED: "" }, { ...environment, OPENBLOG_PROTECTION_ENABLED: "" }]) {
    const database = fakeDatabase();
    const response = await handlerFor(database, { env })(event("feedback", "POST", { headers: ORIGIN, body: request() }));
    assert.equal(response.statusCode, 404, "without receipts or the opt-in the reader gets the copy-and-send path");
    assert.equal(JSON.parse(response.body).code, "unavailable");
    assert.equal(database.requests.length, 0);
  }
  const database = fakeDatabase();
  const foreign = await handlerFor(database)(event("feedback", "POST", { headers: { origin: "https://evil.example" }, body: request() }));
  assert.equal(foreign.statusCode, 403);
  assert.equal(database.requests.length, 0);
});

// ---- The reader's receipt

const receiptCall = (database, body) => handlerFor(database)(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, ...body } }));

test("a receipt shows the reader their reflection and category, never their consent records or digest", async () => {
  const database = fakeDatabase((entry) => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? [stored()] : []));
  const response = await receiptCall(database, { action: "read" });
  assert.equal(response.statusCode, 200);
  const { item } = JSON.parse(response.body);
  assert.equal(item.kind, "third-perspective");
  assert.equal(item.body, "Another way to read the ending.");
  assert.deepEqual(item.details, { category: "connection" });
  assert.equal(item.consent, true);
  assert.doesNotMatch(response.body, new RegExp(digest(RECEIPT)));
  assert.equal(item.published, false, "pending is never published");
});

test("a receipt says a Third Perspective is published only while it is approved at its text under a consent that allows it", async () => {
  const read = async (extra) => {
    const database = fakeDatabase((entry) => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? [stored(extra)] : []));
    const response = await receiptCall(database, { action: "read" });
    assert.equal(database.requests.find((entry) => entry.path.endsWith("/openblog_feedback")).params.select.split(",").includes("approved_consent"), true, "the consent an approval covers is read");
    return JSON.parse(response.body).item;
  };
  const approved = { status: "approved", approved_revision: 1, approved_consent: 1 };
  assert.equal((await read(approved)).published, true);
  // Hiding the name later narrows the consent but keeps publication.
  const narrowed = { ...approved, details: { ...stored().details, consents: [...stored().details.consents, { number: 2, givenAt: "2026-10-27T10:00:00Z", publish: true, attribution: { publishName: false }, clarification: true }] } };
  assert.equal((await read(narrowed)).published, true);
  const revoked = { ...approved, details: { ...stored().details, consents: [...stored().details.consents, { number: 2, givenAt: "2026-10-27T10:00:00Z", publish: false, attribution: { publishName: false }, clarification: false }] } };
  assert.equal((await read(revoked)).published, false, "a revoked consent is never published");
  assert.equal((await read({ ...approved, approved_consent: null })).published, false, "an approval that recorded no consent publishes nothing");
  assert.equal((await read({ ...approved, item_revision: 2 })).published, false, "an approval of an earlier text publishes nothing");
  assert.equal((await read({ ...approved, clarification_asked: 1 })).published, false);
  for (const status of ["clarification", "rejected", "removed", "withdrawn"]) assert.equal((await read({ ...approved, status })).published, false, status);
  // Expired without a decision reads as not published, and never names a reason or a moderator.
  const expired = await read({ status: "rejected", moderation_reason: "expired", moderated_at: "2026-11-30T00:00:00+00:00" });
  assert.equal(expired.status, "rejected");
  assert.equal(expired.published, false);
  assert.ok(!JSON.stringify(expired).includes("expired"), "no moderation reason is shown");
  // A deleted reflection keeps only its facts.
  const deleted = await read({ status: "withdrawn", body: "-", details: {}, reader_name: null, publish_name: false, purged_at: "2026-10-27T10:00:00+00:00" });
  assert.equal(deleted.purged, true);
  assert.equal(deleted.body, undefined);
  assert.equal(deleted.details, undefined);
});

test("status access by receipt cannot enumerate other readers' reflections", async () => {
  const database = fakeDatabase((entry) => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? [] : []));
  // A guessed receipt and a malformed one answer the same, and naming a row's id finds nothing.
  const guessed = await handlerFor(database)(event("receipt", "POST", { headers: ORIGIN, body: { receipt: "A".repeat(43), action: "read", id: ID(1) } }));
  const malformed = await handlerFor(database)(event("receipt", "POST", { headers: ORIGIN, body: { receipt: "not a receipt", action: "read", id: ID(1) } }));
  const missing = await handlerFor(database)(event("receipt", "POST", { headers: ORIGIN, body: { id: ID(1), action: "read" } }));
  for (const response of [guessed, malformed, missing]) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body), JSON.parse(guessed.body));
    assert.equal(JSON.parse(response.body).code, "unknownReceipt");
  }
  const lookups = database.requests.filter((entry) => entry.path.endsWith("/openblog_feedback"));
  assert.equal(lookups.length, 1, "only the well-formed receipt is looked up");
  assert.equal(lookups[0].params.receipt_hash, `eq.${digest("A".repeat(43))}`);
  assert.equal(lookups[0].params.id, undefined, "never by id");
  // A receipt shows its own reflection only: no id, no private name, no consent records, no digest.
  const own = fakeDatabase((entry) => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? [stored({ status: "approved", approved_revision: 1, approved_consent: 1, reader_name: "Private Ada", publish_name: false })] : []));
  const response = await receiptCall(own, { action: "read" });
  const { item } = JSON.parse(response.body);
  assert.deepEqual(Object.keys(item).sort(), ["body", "clarification", "consent", "details", "feature", "kind", "published", "purged", "receivedAt", "status", "version", "work"]);
  for (const secret of ["Private Ada", ID(1), digest(RECEIPT), RECEIPT, "consents", "approvedConsent", "approved_consent"]) assert.ok(!response.body.includes(secret), secret);
});

test("a replayed receipt action is refused once the reflection changed", async () => {
  const database = fakeDatabase((entry) => {
    if (entry.method === "GET") return [stored({ status: "withdrawn", version: 3, body: "-", details: {}, reader_name: null, publish_name: false, purged_at: "2026-10-26T10:00:00+00:00" })];
    return [];
  });
  const replay = await receiptCall(database, { action: "withdraw", expectedVersion: 2 });
  assert.equal(replay.statusCode, 409, "the version it names is gone");
  assert.equal(JSON.parse(replay.body).item.purged, true);
  assert.equal(writes(database).length, 0, "nothing is written twice");
});

test("agreeing to be asked through a receipt appends a consent record and raises the version", async () => {
  const database = fakeDatabase((entry) => {
    if (entry.method === "GET") return [stored({ details: { ...stored().details, consents: [{ ...stored().details.consents[0], clarification: false }] }, clarification_consent: false })];
    if (entry.method === "PATCH") return [stored({ version: 2 })];
    return [];
  });
  const response = await receiptCall(database, { action: "consent", consent: true, expectedVersion: 1 });
  assert.equal(response.statusCode, 200);
  const patch = writes(database).find((entry) => entry.method === "PATCH");
  assert.equal(patch.params.version, "eq.1");
  assert.equal(patch.params.receipt_hash, `eq.${digest(RECEIPT)}`);
  assert.equal(patch.body.version, 2);
  assert.equal(patch.body.clarification_consent, true);
  assert.deepEqual(patch.body.details.consents.map((record) => [record.number, record.clarification]), [[1, false], [2, true]]);
  assert.equal(patch.body.details.intake.receiptDigest, digest(RECEIPT), "the intake stays");
});

const featuring = (extra = {}, consents = [{ number: 1, givenAt: "2026-10-26T10:00:00Z", publish: true, attribution: { publishName: false }, clarification: true }]) => stored({ reader_name: null, publish_name: false, details: { category: "connection", intake: { receiptDigest: digest(RECEIPT) }, consents }, ...extra });

test("a reader agrees to feature the text they see through their receipt, and it is a new consent record", async () => {
  const database = fakeDatabase((entry) => {
    if (entry.method === "GET") return [featuring()];
    if (entry.method === "PATCH") return [featuring({ version: 2 })];
    return [];
  });
  const view = JSON.parse((await receiptCall(database, { action: "read" })).body).item;
  assert.deepEqual(view.feature, { revision: 1, agreed: false, earlier: false });
  const response = await receiptCall(database, { action: "feature", consent: true, revisionSeen: 1, expectedVersion: 1 });
  assert.equal(response.statusCode, 200);
  const patch = writes(database).find((entry) => entry.method === "PATCH");
  assert.equal(patch.params.version, "eq.1");
  assert.equal(patch.params.status, "in.(pending,clarification,approved)");
  assert.equal(patch.body.version, 2);
  assert.deepEqual(patch.body.details.consents.map((record) => [record.number, record.clarification, record.featureRevision]), [[1, true, undefined], [2, true, 1]]);
  assert.ok(!("clarification_consent" in patch.body), "being asked to clarify is untouched");
});

test("featuring consent is bound to the revision the reader saw and never renewed by another change", async () => {
  // Approved at revision 2; the reader agreed to feature revision 1 before a clarification.
  const earlier = [{ number: 1, givenAt: "2026-10-26T10:00:00Z", publish: true, attribution: { publishName: false }, clarification: false, featureRevision: 1 }];
  const row = featuring({ status: "approved", item_revision: 2, approved_revision: 2, approved_consent: 1, version: 3, details: { intake: { receiptDigest: digest(RECEIPT) }, consents: earlier, revisedAt: "2026-10-26T10:00:00Z" } });
  const database = fakeDatabase((entry) => (entry.method === "GET" ? [row] : entry.method === "PATCH" ? [{ ...row, version: 4 }] : []));
  const view = JSON.parse((await receiptCall(database, { action: "read" })).body).item;
  assert.deepEqual(view.feature, { revision: 2, agreed: false, earlier: true }, "the old agreement covers the old text only");
  // Agreeing for a revision the reader did not see is refused as a stale view, and writes nothing.
  const stale = await receiptCall(database, { action: "feature", consent: true, revisionSeen: 1, expectedVersion: 3 });
  assert.equal(stale.statusCode, 409);
  assert.equal(writes(database).length, 0);
  // Toggling whether they may be asked to clarify keeps the old revision.
  const toggled = await receiptCall(database, { action: "consent", consent: true, expectedVersion: 3 });
  assert.equal(toggled.statusCode, 422, "that change is for a waiting reflection only");
  // Agreeing for the revision they see binds it; declining takes it back.
  const agreed = await receiptCall(database, { action: "feature", consent: true, revisionSeen: 2, expectedVersion: 3 });
  assert.equal(agreed.statusCode, 200);
  assert.equal(writes(database).at(-1).body.details.consents.at(-1).featureRevision, 2);
  const declined = await receiptCall(database, { action: "feature", consent: false, expectedVersion: 3 });
  assert.equal(declined.statusCode, 200);
  assert.equal("featureRevision" in writes(database).at(-1).body.details.consents.at(-1), false);
});

test("featuring is refused where there is nothing to agree to: rejected, withdrawn, purged, a bad body or the feature off", async () => {
  for (const [name, row] of [["rejected", featuring({ status: "rejected" })], ["withdrawn", featuring({ status: "withdrawn" })], ["purged", featuring({ status: "approved", purged_at: "2026-10-26T10:00:00+00:00", approved_revision: 1 })]]) {
    const database = fakeDatabase((entry) => (entry.method === "GET" ? [row] : []));
    const response = await receiptCall(database, { action: "feature", consent: true, revisionSeen: 1, expectedVersion: 1 });
    assert.ok([409, 422].includes(response.statusCode), name);
    assert.equal(writes(database).length, 0, name);
  }
  const database = fakeDatabase((entry) => (entry.method === "GET" ? [featuring()] : []));
  assert.equal((await receiptCall(database, { action: "feature", consent: "yes", expectedVersion: 1 })).statusCode, 422);
  assert.equal((await receiptCall(database, { action: "feature", consent: true, expectedVersion: 1 })).statusCode, 422, "agreeing names the revision seen");
  assert.equal(writes(database).length, 0);
  const off = fakeDatabase((entry) => (entry.method === "GET" ? [featuring()] : []));
  const without = createHandler({ env: { ...environment, OPENBLOG_THIRD_PERSPECTIVES_ENABLED: "false" }, fetchImpl: off.fetchImpl, siteFetchImpl: site(), now: () => NOW });
  const refused = await without(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "feature", consent: true, revisionSeen: 1, expectedVersion: 1 } }));
  assert.equal(refused.statusCode, 404);
  assert.equal(writes(off).length, 0);
});

test("a clarification replaces the text and keeps the category, receipt and consent records", async () => {
  const asked = stored({ status: "clarification", clarification_asked: 1, moderation_reason: "unclear", version: 2 });
  const database = fakeDatabase((entry) => {
    if (entry.method === "GET") return [asked];
    if (entry.path.endsWith("/rpc/openblog_moderate_feedback_item")) return [{ ...asked, status: "pending", item_revision: 2, version: 3 }];
    return [];
  });
  const response = await receiptCall(database, { action: "clarify", expectedVersion: 2, body: "  A clearer reading.  ", details: { category: "question", intake: { receiptDigest: "0".repeat(64) } } });
  assert.equal(response.statusCode, 200);
  const call = writes(database).find((entry) => entry.path.endsWith("/rpc/openblog_moderate_feedback_item"));
  assert.equal(call.body.p_body, "A clearer reading.");
  assert.equal(call.body.p_actor_role, "submitter");
  assert.deepEqual(call.body.p_details, { ...asked.details, revisedAt: "2026-10-26T10:00:00Z" }, "what the reader sends never replaces the stored details");
  const empty = fakeDatabase((entry) => (entry.method === "GET" ? [asked] : []));
  assert.equal(JSON.parse((await receiptCall(empty, { action: "clarify", expectedVersion: 2, body: "   " })).body).code, "invalidBody");
});

test("withdrawing through a receipt purges the reflection and its name, as for every reader kind", async () => {
  const database = fakeDatabase((entry) => {
    if (entry.method === "GET") return [stored({ status: "approved", approved_revision: 1, approved_consent: 1, version: 2 })];
    if (entry.path.endsWith("/rpc/openblog_erase_feedback")) return [stored({ status: "withdrawn", version: 4, body: "-", details: {}, reader_name: null, publish_name: false, purged_at: "2026-10-26T10:00:00+00:00" })];
    return [];
  });
  const response = await receiptCall(database, { action: "withdraw", expectedVersion: 2 });
  assert.equal(response.statusCode, 200);
  const call = writes(database).find((entry) => entry.path.endsWith("/rpc/openblog_erase_feedback"));
  assert.equal(call.body.p_withdraw, true);
  const { item } = JSON.parse(response.body);
  assert.equal(item.purged, true);
  assert.equal(item.body, undefined);
});

// ---- Moderation through the one inbox

test("the inbox lists Third Perspectives with the consent record an approval covers", async () => {
  const database = fakeDatabase((entry) => (entry.path.endsWith("/openblog_feedback") ? [stored({ status: "approved", approved_revision: 1, approved_consent: 1 })] : []));
  const response = await handlerFor(database)(event("admin/moderation", "GET", { headers: ADMIN, query: { state: "approved", kind: "third-perspective" } }));
  assert.equal(response.statusCode, 200);
  const page = JSON.parse(response.body);
  assert.equal(page.thirdPerspectives, true);
  assert.equal(page.items[0].approvedConsent, 1);
  assert.equal(page.items[0].feedback.kind, "third-perspective");
  const select = database.requests.find((entry) => entry.path.endsWith("/openblog_feedback")).params.select;
  assert.match(select, /approved_consent/);
});

test("an approval binds the text revision and consent record the moderator saw, or is refused", async () => {
  const decide = async (row, body, env) => {
    const database = fakeDatabase((entry) => {
      if (entry.method === "GET") return [row];
      if (entry.path.endsWith("/rpc/openblog_moderate_third_perspective")) return [{ ...row, status: "approved", version: row.version + 1, approved_revision: 1, approved_consent: entry.body.p_consent }];
      return [];
    });
    const response = await handlerFor(database, { env })(event("admin/moderation", "PATCH", { headers: ADMIN, body: { source: "feedback", id: ID(1), action: "approve", from: row.status, expectedVersion: row.version, actor: "mikey", ...body } }));
    return { response, database };
  };
  const { response, database } = await decide(stored(), { seenRevision: 1, seenConsent: 1 });
  assert.equal(response.statusCode, 200);
  const call = writes(database).find((entry) => entry.path.endsWith("/rpc/openblog_moderate_third_perspective"));
  assert.equal(call.body.p_consent, 1);
  assert.equal(call.body.p_to, "approved");
  assert.equal(call.body.p_actor, "mikey");
  assert.equal(JSON.parse(response.body).item.approvedConsent, 1);

  const changed = stored({ details: { ...stored().details, consents: [...stored().details.consents, { number: 2, givenAt: "2026-10-26T11:00:00Z", publish: true, attribution: { publishName: true }, clarification: false }] } });
  assert.equal((await decide(changed, { seenRevision: 1, seenConsent: 1 })).response.statusCode, 409, "the reader changed their consent since");
  assert.equal((await decide(stored({ item_revision: 2 }), { seenRevision: 1, seenConsent: 1 })).response.statusCode, 409, "the text changed since");
  const unconfigured = await decide(stored(), { seenRevision: 1, seenConsent: 1 }, { ...environment, OPENBLOG_THIRD_PERSPECTIVES_ENABLED: "" });
  assert.equal(unconfigured.response.statusCode, 422, "without the column an approval could not record its consent");
  assert.equal(writes(unconfigured.database).length, 0);
});

test("other decisions on a Third Perspective go through its own function and record no consent", async () => {
  const database = fakeDatabase((entry) => {
    if (entry.method === "GET") return [stored()];
    if (entry.path.endsWith("/rpc/openblog_moderate_third_perspective")) return [stored({ status: "rejected", version: 2, moderation_reason: "spam" })];
    return [];
  });
  const response = await handlerFor(database)(event("admin/moderation", "PATCH", { headers: ADMIN, body: { source: "feedback", id: ID(1), action: "reject", reason: "spam", from: "pending", expectedVersion: 1, actor: "mikey" } }));
  assert.equal(response.statusCode, 200);
  assert.equal(writes(database).find((entry) => entry.path.endsWith("/rpc/openblog_moderate_third_perspective")).body.p_consent, null);
});

test("B5's own feedback view lists only its kinds and never decides a Third Perspective", async () => {
  const database = fakeDatabase((entry) => (entry.method === "GET" ? [stored()] : []));
  await handlerFor(database)(event("admin/feedback", "GET", { headers: ADMIN }));
  assert.equal(database.requests[0].params.kind, "in.(question,source-suggestion,correction-suggestion,alternative-interpretation)");
  const refused = await handlerFor(database)(event("admin/feedback", "PATCH", { headers: ADMIN, body: { id: ID(1), from: "pending", action: "approve", expectedVersion: 1 } }));
  assert.equal(refused.statusCode, 409);
  assert.equal(JSON.parse(refused.body).code, "useModerationInbox");
  assert.ok(!writes(database).some((entry) => entry.path.includes("/rpc/")));

  // With Third Perspectives switched off, the generic route still never approves one without its consent.
  const off = fakeDatabase((entry) => (entry.method === "GET" ? [stored()] : []));
  const offEnv = { ...environment, OPENBLOG_THIRD_PERSPECTIVES_ENABLED: "" };
  const refusedOff = await handlerFor(off, { env: offEnv })(event("admin/feedback", "PATCH", { headers: ADMIN, body: { id: ID(1), from: "pending", action: "approve", expectedVersion: 1 } }));
  assert.equal(refusedOff.statusCode, 409);
  assert.equal(JSON.parse(refusedOff.body).code, "useModerationInbox");
  assert.equal(writes(off).length, 0);
});

// ---- The SQL

test("Third Perspectives add one nullable column and one function, and their rollback drops exactly those", () => {
  const section = feedbackSql.slice(feedbackSql.indexOf("-- Third Perspectives (ADR 0113)"), feedbackSql.indexOf("-- Evidence submissions and correction decisions")).replace(/--[^\n]*/g, "").toLowerCase();
  assert.deepEqual(section.match(/alter table[^;]*;/g).map((statement) => statement.replace(/\s+/g, " ")), [
    "alter table public.openblog_feedback add column if not exists approved_consent integer check (approved_consent >= 1);",
  ]);
  assert.doesNotMatch(section, /\bdrop\b|\brename\b|\bdelete\s+from\b|security\s+definer|grant[^;]*\b(anon|authenticated)\b/);
  assert.match(section, /and kind = 'third-perspective'/);
  assert.match(section, /details->'consents'->-1->'number' = to_jsonb\(p_consent\)/);
  assert.match(section, /details->'consents'->-1->'publish' = 'true'::jsonb/);
  assert.match(section, /and purged_at is null/);
  assert.match(section, /grant execute on function public\.openblog_moderate_third_perspective\([^)]*\) to service_role;/);
  const undo = rollback.replace(/--[^\n]*/g, "").toLowerCase();
  assert.deepEqual(undo.match(/\b(drop|alter)\b[^;]*;/g), [
    "drop function if exists public.openblog_moderate_third_perspective(text, uuid, integer, text, text, text, text, text, text, timestamptz, integer);",
    "alter table if exists public.openblog_feedback drop column if exists approved_consent;",
  ]);
});

// ---- Switched off or rolled back: the consent column is not read

const { OPENBLOG_THIRD_PERSPECTIVES_ENABLED: _flag, ...flagOff } = environment;
// What the table answers when the consent column was not selected.
const withoutConsent = (row) => { const { approved_consent: _consent, ...rest } = row; return rest; };
const report = (database, env = environment) => handlerFor(database, { env })(event("reports", "POST", { headers: ORIGIN, body: { source: "feedback", id: ID(1), ground: "abusive" } }));
const reportable = (extra, flagOn) => fakeDatabase((entry) => {
  if (entry.method === "GET" && entry.path.endsWith("/openblog_feedback")) return [flagOn ? stored(extra) : withoutConsent(stored(extra))];
  return [];
});
const approvedRow = { status: "approved", approved_revision: 1, approved_consent: 1 };

test("reports on a Third Perspective are gated by its consent with the flag on, and by plain approval with it off", async () => {
  // On: only an approval under a consent that allows publication can be reported.
  assert.equal((await report(reportable(approvedRow, true))).statusCode, 202);
  const revoked = { ...approvedRow, details: { ...stored().details, consents: [...stored().details.consents, { number: 2, givenAt: "2026-10-27T10:00:00Z", publish: false, attribution: { publishName: false }, clarification: false }] } };
  assert.equal((await report(reportable(revoked, true))).statusCode, 404, "a revoked consent is not public, so not reportable");
  assert.equal((await report(reportable({ ...approvedRow, approved_consent: null }, true))).statusCode, 404);
  for (const status of ["pending", "removed", "withdrawn"]) assert.equal((await report(reportable({ ...approvedRow, status }, true))).statusCode, 404, status);
  // Off (or rolled back): reflections that are still published stay reportable, on plain approval at the current text.
  const off = reportable(approvedRow, false);
  assert.equal((await report(off, flagOff)).statusCode, 202, "approved at its current text is reportable");
  assert.equal(off.requests.find((entry) => entry.path.endsWith("/openblog_feedback")).params.select.split(",").includes("approved_consent"), false);
  assert.equal((await report(reportable({ ...approvedRow, item_revision: 2 }, false), flagOff)).statusCode, 404);
  assert.equal((await report(reportable({ ...approvedRow, clarification_asked: 1 }, false), flagOff)).statusCode, 404);
  for (const status of ["pending", "removed", "withdrawn", "rejected"]) assert.equal((await report(reportable({ ...approvedRow, status }, false), flagOff)).statusCode, 404, status);
  // A hidden kind is never reportable, flag or not.
  const hidden = fakeDatabase((entry) => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? [withoutConsent(stored(approvedRow))] : []));
  assert.equal((await handlerFor(hidden, { env: flagOff, mode: "hidden" })(event("reports", "POST", { headers: ORIGIN, body: { source: "feedback", id: ID(1), ground: "abusive" } }))).statusCode, 404);
});

test("a receipt cannot tell whether an approved reflection is shown when the consent column is not read, and never says it is hidden", async () => {
  const read = async (extra, { flagOn = false, mode = "open" } = {}) => {
    const database = fakeDatabase((entry) => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? [flagOn ? stored(extra) : withoutConsent(stored(extra))] : []));
    const response = await handlerFor(database, { env: flagOn ? environment : flagOff, mode })(event("receipt", "POST", { headers: ORIGIN, body: { receipt: RECEIPT, action: "read" } }));
    return JSON.parse(response.body).item;
  };
  assert.equal((await read(approvedRow)).published, null, "unknown, not false");
  assert.equal((await read({ ...approvedRow, status: "withdrawn" })).published, false, "a state that is not approved is known not to be shown");
  assert.equal((await read({ ...approvedRow, item_revision: 2 })).published, false);
  // A kind the site has hidden is not shown whatever the consent says.
  assert.equal((await read(approvedRow, { flagOn: true, mode: "hidden" })).published, false);
  assert.equal((await read(approvedRow, { flagOn: false, mode: "hidden" })).published, false);
  assert.equal((await read(approvedRow, { flagOn: true })).published, true);
});
