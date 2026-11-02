// The LinkedIn Posts adapter of optional social publishing (epic #353, story #358, ADR 0319),
// against a scripted provider only. It implements the delivery contract of social-delivery.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { escapeLinkedInCommentary, linkedInTitle, linkedinAdapter } from "../../netlify/lib/social-publish.mjs";
import { LI_TOKEN, call, isDelivery, networkFailure, providers, scripted, settle } from "./social-publish-fakes.mjs";

const URN = "urn:li:share:7123456789012345678";
const CREATED = { status: 201, headers: { "x-restli-id": URN } };
const NOW = Date.parse("2026-11-01T12:00:00Z");
const run = async (reply, input = {}, overrides) => {
  const fake = scripted(reply);
  const adapter = linkedinAdapter(providers(overrides).linkedin, { fetchImpl: fake.fetchImpl, now: () => NOW });
  return { ...(await settle(adapter.publish(call("linkedin", input)))), calls: fake.calls };
};

test("a 201 with the post URN resolves to the URN and nothing else", async () => {
  const { value, calls } = await run(CREATED);
  assert.deepEqual(value, { providerPostId: URN });
  assert.equal(calls.length, 1);
});

test("the request is the versioned REST Posts call with an article, a bearer token and no obsolete headers", async () => {
  const { calls } = await run(CREATED);
  const [sent] = calls;
  assert.equal(sent.url, "https://api.linkedin.com/rest/posts");
  assert.equal(sent.method, "POST");
  assert.equal(sent.redirect, "manual");
  assert.ok(sent.hasSignal);
  assert.equal(sent.headers.authorization, `Bearer ${LI_TOKEN}`);
  assert.equal(sent.headers["linkedin-version"], "202510");
  assert.equal(sent.headers["x-restli-protocol-version"], "2.0.0");
  assert.equal(JSON.stringify(sent.headers).includes("x-li-format"), false);
  assert.ok(!sent.url.includes(LI_TOKEN) && !sent.body.includes(LI_TOKEN));
  const body = JSON.parse(sent.body);
  assert.equal(body.author, "urn:li:person:abc123");
  assert.equal(body.commentary, "A new post is up.");
  assert.equal(body.visibility, "PUBLIC");
  assert.equal(body.lifecycleState, "PUBLISHED");
  assert.deepEqual(body.content, { article: { source: "https://blog.example.com/posts/hello/", title: "A new post is up." } });
  assert.equal(body.distribution.feedDistribution, "MAIN_FEED");
});

test("the configured API version is sent, and an organization posts as itself", async () => {
  const { calls } = await run(CREATED, { account: { externalId: "urn:li:organization:777", kind: "organization" } }, { OPENBLOG_SOCIAL_LINKEDIN_API_VERSION: "202601" });
  assert.equal(calls[0].headers["linkedin-version"], "202601");
  assert.equal(JSON.parse(calls[0].body).author, "urn:li:organization:777");
});

test("caption characters LinkedIn reads as markup are escaped", () => {
  assert.equal(escapeLinkedInCommentary("(beta) | v2 *new* #tag @someone _x_ ~y~ [a] {b} <c> \\"), "\\(beta\\) \\| v2 \\*new\\* \\#tag \\@someone \\_x\\_ \\~y\\~ \\[a\\] \\{b\\} \\<c\\> \\\\");
});

test("the article title is the caption's first line, bounded, with a fixed fallback", () => {
  assert.equal(linkedInTitle("Hello there\nmore text"), "Hello there");
  assert.equal(linkedInTitle("x".repeat(500)).length, 200);
  assert.equal(linkedInTitle("   "), "Read the full post");
});

test("a 2xx without a usable post id is uncertain, never a success", async () => {
  for (const reply of [{ status: 201 }, { status: 201, headers: { "x-restli-id": "garbage" } }, { status: 202, headers: { "x-restli-id": URN } }, { status: 200, body: "not json" }]) {
    const { value, error } = await run(reply);
    assert.equal(value, undefined, JSON.stringify(reply));
    assert.ok(isDelivery(error, "uncertain"), JSON.stringify(reply));
  }
});

test("a 401 is an auth failure and a 403 a refusal; neither is retried", async () => {
  const unauthorized = (await run({ status: 401, body: { message: `token ${LI_TOKEN} expired` } })).error;
  assert.deepEqual([unauthorized.kind, unauthorized.status], ["auth", 401]);
  const forbidden = (await run({ status: 403, body: { message: "ACCESS_DENIED" } })).error;
  assert.deepEqual([forbidden.kind, forbidden.status], ["rejected", 403]);
});

test("a 429 is rate limited with the provider's Retry-After, in seconds or as a date", async () => {
  const slow = (await run({ status: 429, headers: { "retry-after": "120" } })).error;
  assert.deepEqual([slow.kind, slow.status, slow.retryAfterMs], ["rate-limited", 429, 120_000]);
  const dated = (await run({ status: 429, headers: { "retry-after": new Date(NOW + 30_000).toUTCString() } })).error;
  assert.equal(dated.retryAfterMs, 30_000);
  assert.equal((await run({ status: 429 })).error.retryAfterMs, null);
  assert.equal((await run({ status: 429, headers: { "retry-after": "soon" } })).error.retryAfterMs, null);
});

test("a 5xx, a timeout or a dropped connection may have posted, so it is uncertain", async () => {
  for (const reply of [{ status: 500 }, { status: 502 }, { status: 503 }, { status: 504 }, networkFailure("reset", LI_TOKEN), networkFailure("timeout"), networkFailure("abort"), new Error(`socket hang up ${LI_TOKEN}`)]) {
    const { error } = await run(reply);
    assert.ok(isDelivery(error, "uncertain"), String(reply.status ?? reply.name));
    assert.ok(!JSON.stringify({ m: error.message, s: error.stack }).includes(LI_TOKEN));
  }
});

test("a connection that was refused or never resolved certainly did not post, so it is transient", async () => {
  const notFound = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
  for (const reply of [networkFailure("refused"), notFound]) assert.ok(isDelivery((await run(reply)).error, "transient"));
});

test("an already aborted signal sends nothing and is transient", async () => {
  const controller = new AbortController();
  controller.abort();
  const { error, calls } = await run(CREATED, { signal: controller.signal });
  assert.ok(isDelivery(error, "transient"));
  assert.equal(calls.length, 0);
});

test("the worker's signal is what aborts the call", async () => {
  const controller = new AbortController();
  const fake = scripted((n, url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  const adapter = linkedinAdapter(providers().linkedin, { fetchImpl: fake.fetchImpl });
  const pending = settle(adapter.publish(call("linkedin", { signal: controller.signal })));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const { error } = await pending;
  assert.ok(isDelivery(error, "uncertain"), "an abort after the request left may have posted");
});

test("a validation refusal is final and a redirect is never followed", async () => {
  for (const status of [400, 422, 426]) {
    const { error } = await run({ status, body: { message: "Content is duplicate" } });
    assert.deepEqual([error.kind, error.status], ["rejected", status]);
  }
  const moved = await run({ status: 302, headers: { location: "https://evil.example/" } });
  assert.ok(isDelivery(moved.error, "uncertain"));
  assert.equal(moved.calls.length, 1);
});

test("a post this adapter cannot send is refused before any request", async () => {
  const bad = [
    { account: { externalId: "urn:li:person:../x" } },
    { account: { externalId: "urn:li:person:abc123", kind: "page" } },
    { account: { externalId: "1234567890" } },
    { post: { caption: "   " } },
    { post: { caption: "bad‮text" } },
    { post: { caption: "x".repeat(3001) } },
    { post: { canonicalUrl: "http://blog.example.com/p/" } },
    { post: { canonicalUrl: "https://user:pw@blog.example.com/p/" } },
    { post: { canonicalUrl: "not a url" } },
  ];
  for (const input of bad) {
    const { error, calls } = await run(CREATED, input);
    assert.ok(isDelivery(error, "rejected"), JSON.stringify(input));
    assert.equal(calls.length, 0);
  }
});

test("a missing or odd token is an auth failure before any request", async () => {
  for (const accessToken of [null, "", "has space token", "line\nbreak-token"]) {
    const { error, calls } = await run(CREATED, { accessToken });
    assert.ok(isDelivery(error, "auth"));
    assert.equal(calls.length, 0);
  }
});

test("no provider text or token reaches an error", async () => {
  const { error } = await run({ status: 403, body: { message: `secret ${LI_TOKEN} <script>alert(1)</script>`, serviceErrorCode: 100 } });
  const text = JSON.stringify({ ...error, message: error.message, stack: error.stack });
  assert.ok(!text.includes(LI_TOKEN) && !text.includes("script") && !text.includes("secret"));
});
