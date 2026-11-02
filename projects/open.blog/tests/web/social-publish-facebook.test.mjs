// The Facebook Page feed adapter of optional social publishing (epic #353, story #358, ADR 0320),
// against a scripted provider only. It implements the delivery contract of social-delivery.mjs,
// including the optional read-only `reconcile`.
import test from "node:test";
import assert from "node:assert/strict";
import { facebookAdapter } from "../../netlify/lib/social-publish.mjs";
import { PAGE_TOKEN, call, isDelivery, networkFailure, providers, scripted, settle } from "./social-publish-fakes.mjs";

const PAGE = "10987654321";
const POST_ID = `${PAGE}_55512345678`;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const error = (code, status = 400, extra = {}) => ({ status, body: { error: { message: `Bad token ${PAGE_TOKEN}`, type: "OAuthException", code, ...extra } } });
const adapterFor = (fake, overrides) => facebookAdapter(providers(overrides).facebook, { fetchImpl: fake.fetchImpl, now: () => NOW });
const run = async (reply, input = {}, overrides) => {
  const fake = scripted(reply);
  return { ...(await settle(adapterFor(fake, overrides).publish(call("facebook", input)))), calls: fake.calls };
};

test("a 200 with the Page post id resolves to the id", async () => {
  const { value, calls } = await run({ status: 200, body: { id: POST_ID } });
  assert.deepEqual(value, { providerPostId: POST_ID });
  assert.equal(calls.length, 1);
});

test("the request posts message and link to the Page feed with the token only in the header", async () => {
  const { calls } = await run({ status: 200, body: { id: POST_ID } });
  const [sent] = calls;
  assert.equal(sent.url, `https://graph.facebook.com/v23.0/${PAGE}/feed`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.headers.authorization, `Bearer ${PAGE_TOKEN}`);
  assert.ok(!sent.url.includes(PAGE_TOKEN) && !sent.body.includes(PAGE_TOKEN));
  const form = new URLSearchParams(sent.body);
  assert.deepEqual([...form.keys()].sort(), ["link", "message"]);
  assert.equal(form.get("message"), "A new post is up.");
  assert.equal(form.get("link"), "https://blog.example.com/posts/hello/");
});

test("the configured Graph version is used", async () => {
  const { calls } = await run({ status: 200, body: { id: POST_ID } }, {}, { OPENBLOG_SOCIAL_FACEBOOK_API_VERSION: "v24.0" });
  assert.ok(calls[0].url.startsWith("https://graph.facebook.com/v24.0/"));
});

test("a 2xx without a well-formed id for this Page is uncertain, never a success", async () => {
  for (const reply of [{ status: 200, body: {} }, { status: 200, body: { id: "123" } }, { status: 200, body: { id: "99999_1" } }, { status: 200, body: { id: ["x"] } }, { status: 200, body: "nope" }, { status: 200 }, { status: 201, body: { id: POST_ID } }]) {
    const { value, error: thrown } = await run(reply);
    assert.equal(value, undefined, JSON.stringify(reply));
    assert.ok(isDelivery(thrown, "uncertain"), JSON.stringify(reply));
  }
});

test("an expired or invalid token (code 190, even on a 400) is an auth failure", async () => {
  for (const reply of [error(190), error(102), { status: 401 }]) assert.ok(isDelivery((await run(reply)).error, "auth"), JSON.stringify(reply));
});

test("a permission or role problem is a final refusal", async () => {
  for (const reply of [error(10), error(200), error(299), { status: 403 }]) assert.ok(isDelivery((await run(reply)).error, "rejected"), JSON.stringify(reply));
});

test("rate limits are rate-limited, with the provider's Retry-After when it gave one", async () => {
  for (const reply of [error(4), error(17), error(32), error(613), error(80001), error(80000), error(80014), { status: 429, headers: { "retry-after": "30" } }]) assert.ok(isDelivery((await run(reply)).error, "rate-limited"), JSON.stringify(reply));
  assert.equal((await run({ status: 429, headers: { "retry-after": "30" } })).error.retryAfterMs, 30_000);
  assert.equal((await run({ ...error(4), headers: { "retry-after": "90" } })).error.retryAfterMs, 90_000);
  assert.equal((await run(error(4))).error.retryAfterMs, null);
  // Only Meta's business-use-case range is a throttle; a neighbouring code still falls back to the status rules.
  for (const code of [79999, 80015]) assert.ok(isDelivery((await run(error(code))).error, "rejected"), String(code));
});

test("an unknown Graph error, a server error or a lost answer may have posted, so it is uncertain", async () => {
  for (const reply of [error(1, 500), error(2, 500), { status: 500 }, { status: 503 }, networkFailure("reset", PAGE_TOKEN), networkFailure("timeout")]) {
    const { error: thrown } = await run(reply);
    assert.ok(isDelivery(thrown, "uncertain"));
    assert.ok(!JSON.stringify({ m: thrown.message, s: thrown.stack }).includes(PAGE_TOKEN));
  }
  assert.ok(isDelivery((await run(networkFailure("refused"))).error, "transient"));
});

test("any other refusal is final", async () => {
  const { error: thrown } = await run(error(100, 400, { error_subcode: 2061006 }));
  assert.deepEqual([thrown.kind, thrown.status], ["rejected", 400]);
});

test("a post this adapter cannot send is refused before any request", async () => {
  const bad = [
    { account: { externalId: "../me" } },
    { account: { externalId: PAGE, kind: "member" } },
    { account: { externalId: "urn:li:person:abc123" } },
    { post: { caption: "" } },
    { post: { caption: "nul\u0000" } },
    { post: { canonicalUrl: "javascript:alert(1)" } },
    { post: { canonicalUrl: "http://blog.example.com/p/" } },
  ];
  for (const input of bad) {
    const { error: thrown, calls } = await run({ status: 200, body: { id: POST_ID } }, input);
    assert.ok(isDelivery(thrown, "rejected"), JSON.stringify(input));
    assert.equal(calls.length, 0);
  }
});

test("no Facebook text or token reaches an error", async () => {
  const { error: thrown } = await run(error(190, 400, { fbtrace_id: "TRACE123" }));
  const text = JSON.stringify({ ...thrown, message: thrown.message, stack: thrown.stack });
  assert.ok(!text.includes(PAGE_TOKEN) && !text.includes("OAuthException") && !text.includes("TRACE123"));
});

// Reconcile: a read-only look at the Page's own published posts.
const ATTEMPTED = "2026-11-01T11:50:00.000Z";
const FINISHED = "2026-11-01T11:50:20.000Z";
const LINK = "https://blog.example.com/posts/hello/";
const CAPTION = "A new post is up.";
const look = async (reply, input = {}) => {
  const fake = scripted(reply);
  const args = { ...call("facebook", input), attemptedAt: input.attemptedAt === undefined ? ATTEMPTED : input.attemptedAt, finishedAt: input.finishedAt === undefined ? FINISHED : input.finishedAt };
  return { value: await adapterFor(fake).reconcile(args), calls: fake.calls };
};
const listed = (data, paging) => ({ status: 200, body: { data, ...(paging ? { paging } : {}) } });

test("reconcile reads the Page's published posts since just before the attempt, with the token in the header", async () => {
  const { calls } = await look(listed([]));
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `https://graph.facebook.com/v23.0/${PAGE}/published_posts`);
  assert.equal(calls[0].method, "GET");
  assert.equal(url.searchParams.get("since"), String(Date.parse(ATTEMPTED) / 1000 - 120));
  assert.equal(url.searchParams.get("until"), String(Date.parse(FINISHED) / 1000 + 120), "the window ends just after the attempt");
  const open = new URL((await look(listed([]), { finishedAt: null })).calls[0].url);
  assert.equal(open.searchParams.get("until"), String(Date.parse(ATTEMPTED) / 1000 + 900 + 120), "no recorded end: the longest lease");
  assert.equal(calls[0].headers.authorization, `Bearer ${PAGE_TOKEN}`);
  assert.ok(!calls[0].url.includes(PAGE_TOKEN));
  assert.equal(calls[0].body, undefined, "a lookup never posts");
});

const pagePost = (id, message, link, created_time = "2026-11-01T11:50:05+0000") => ({ id, message, created_time, ...(link ? { attachments: { data: [{ url: "https://l.facebook.com/x", unshimmed_url: link }] } } : {}) });

test("reconcile finds the post only by its caption and its link together", async () => {
  const both = await look(listed([pagePost(`${PAGE}_1`, "Something else"), pagePost(POST_ID, CAPTION, LINK)]));
  assert.deepEqual(both.value, { state: "published", providerPostId: POST_ID });
  const otherPage = await look(listed([pagePost("42_1", CAPTION, LINK)]));
  assert.equal(otherPage.value.state, "absent", "a post id of another Page is never taken");
});

test("reconcile never takes a post that matches by the link or the caption alone", async () => {
  // A hand-made share of the same link, and a caption edited on Facebook: either may be someone else's post.
  for (const item of [pagePost(POST_ID, "Look what I wrote", LINK), pagePost(POST_ID, CAPTION), pagePost(POST_ID, CAPTION, "https://blog.example.com/posts/other/")]) {
    assert.deepEqual((await look(listed([item]))).value, { state: "unknown" }, JSON.stringify(item));
  }
  const nearAndExact = await look(listed([pagePost(`${PAGE}_9`, "Shared by hand", LINK), pagePost(POST_ID, CAPTION, LINK)]));
  assert.deepEqual(nearAndExact.value, { state: "unknown" }, "a hand-made share beside a match makes the match ambiguous");
});

test("reconcile answers unknown when two posts match: a sibling announcement of the same post", async () => {
  const twins = await look(listed([pagePost(`${PAGE}_1`, CAPTION, LINK), pagePost(POST_ID, CAPTION, LINK)]));
  assert.deepEqual(twins.value, { state: "unknown" });
});

test("reconcile ignores a post made outside the attempt window", async () => {
  const later = await look(listed([pagePost(POST_ID, CAPTION, LINK, "2026-11-02T09:00:00+0000")]));
  assert.deepEqual(later.value, { state: "absent", conclusive: true });
  const earlier = await look(listed([pagePost(POST_ID, CAPTION, LINK, "2026-11-01T11:40:00+0000")]));
  assert.deepEqual(earlier.value, { state: "absent", conclusive: true });
});

test("reconcile says absent conclusively only when the whole window came back empty of this Page's posts", async () => {
  assert.deepEqual((await look(listed([]))).value, { state: "absent", conclusive: true });
  // An edited caption on a rewritten link matches neither way, yet could still be the announcement.
  assert.deepEqual((await look(listed([{ id: `${PAGE}_1`, message: "other" }]))).value, { state: "unknown" });
  assert.deepEqual((await look(listed([pagePost(POST_ID, "Edited on Facebook", "https://blog.example.com/posts/hello/?fbclid=x")]))).value, { state: "unknown" });
  assert.deepEqual((await look(listed([], { next: "https://graph.facebook.com/next" }))).value, { state: "absent", conclusive: false });
});

test("reconcile answers unknown when it cannot tell, and never throws", async () => {
  for (const reply of [error(10, 403), error(190), { status: 500 }, { status: 200, body: "nope" }, { status: 200, body: { data: "x" } }, networkFailure("timeout", PAGE_TOKEN)]) {
    assert.deepEqual((await look(reply)).value, { state: "unknown" }, JSON.stringify(reply));
  }
  const noTime = await look(listed([]), { attemptedAt: null });
  assert.deepEqual(noTime.value, { state: "unknown" });
  assert.equal(noTime.calls.length, 0, "without a start time there is no window to look in");
});
