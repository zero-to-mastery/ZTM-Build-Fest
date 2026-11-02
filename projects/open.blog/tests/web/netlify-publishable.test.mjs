// A kind that is never public is never called published, shown or reportable (ADR 0161): the hosted
// function asks the policy's `publishable` rule before a receipt says an item is published or a report
// treats it as shown. Exercised with an approved suggestion for future work, whose approval admits it
// to the editors' private queue and publishes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import { isPublishable } from "../../netlify/lib/participation-moderation.mjs";

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
};
const NOW = new Date("2026-10-26T10:00:00.000Z");
const ORIGIN = { origin: "https://blog.example" };
const ID = "00000000-0000-4000-8000-000000000001";
const RECEIPT = "P".repeat(43);
const WORK = "/posts/tides/";

const event = (path, body) => ({
  path: `/api/${path}`,
  httpMethod: "POST",
  headers: { ...ORIGIN, "x-nf-client-connection-ip": "203.0.113.9" },
  queryStringParameters: {},
  body: JSON.stringify(body),
});
const fakeDatabase = (rows) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const entry = { path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(entry);
    if (entry.path.endsWith("/rpc/openblog_consume_rate_limit")) return { ok: true, status: 200, json: async () => ({ allowed: true }) };
    return { ok: true, status: 200, json: async () => (entry.method === "GET" && entry.path.endsWith("/openblog_feedback") ? rows : []) };
  };
  return { requests, fetchImpl };
};
const siteFetch = async (url) => (url.endsWith("openblog-participation.json")
  ? { ok: true, status: 200, json: async () => ({ [WORK]: { "future-suggestion": "open", question: "open", "abuse-report": "open" } }) }
  : { ok: false, status: 404, json: async () => ({}) });
const handlerFor = (database) => createHandler({ env: environment, fetchImpl: database.fetchImpl, siteFetchImpl: siteFetch, now: () => NOW });
const writes = (database) => database.requests.filter((entry) => entry.method !== "GET" && !entry.path.endsWith("/rpc/openblog_consume_rate_limit"));

const row = (kind, extra = {}) => ({
  id: ID, status: "approved", version: 3, moderated_at: "2026-10-26T09:00:00+00:00", moderation_reason: null, format_version: 1, kind,
  work: WORK, revision: kind === "future-suggestion" ? null : "p1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", target: kind === "future-suggestion" ? null : { version: 1, kind: "work" },
  body: "Her letters would help.", details: kind === "future-suggestion" ? { type: "text" } : {}, seen_at: null, received_at: "2026-10-26T08:00:00+00:00", channel: "hosted",
  reader_name: null, publish_name: false, item_revision: 1, approved_revision: 1, clarification_asked: null, clarification_consent: false, purged_at: null, ...extra,
});

test("the rule: only a kind whose rules say publishable is ever published", () => {
  assert.equal(isPublishable("future-suggestion"), false);
  assert.equal(isPublishable("abuse-report"), false);
  assert.equal(isPublishable("nonsense"), false);
  assert.equal(isPublishable(undefined), false);
  for (const kind of ["comment", "question", "source-suggestion", "correction-suggestion", "alternative-interpretation", "third-perspective", "author-response"]) {
    assert.equal(isPublishable(kind), true, kind);
  }
});

test("an accepted suggestion's receipt says it is not published", async () => {
  const read = async (kind) => {
    const database = fakeDatabase([row(kind)]);
    const response = await handlerFor(database)(event("receipt", { receipt: RECEIPT, action: "read" }));
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body).item;
  };
  const suggestion = await read("future-suggestion");
  assert.equal(suggestion.status, "approved");
  assert.equal(suggestion.published, false, "approved into the editors' queue is not published");
  assert.equal((await read("question")).published, true, "a public kind in the same state is unchanged");
  assert.equal(createHash("sha256").update(RECEIPT).digest("hex").length, 64);
});

test("a report against an accepted suggestion gets the answer of an id that does not exist, and stores nothing", async () => {
  const report = (rows) => {
    const database = fakeDatabase(rows);
    return handlerFor(database)(event("reports", { source: "feedback", id: ID, ground: "abusive" })).then((response) => ({ response, database }));
  };
  const accepted = await report([row("future-suggestion")]);
  const missing = await report([]);
  assert.equal(accepted.response.statusCode, 404);
  assert.deepEqual(JSON.parse(accepted.response.body), JSON.parse(missing.response.body));
  assert.equal(JSON.parse(accepted.response.body).code, "unavailable");
  assert.equal(writes(accepted.database).length, 0);
  assert.equal(writes(missing.database).length, 0);
  // A public kind in the same state is still reportable.
  assert.equal((await report([row("question")])).response.statusCode, 202);
});
