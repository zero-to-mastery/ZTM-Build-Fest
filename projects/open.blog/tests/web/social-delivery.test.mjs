// The delivery contract of optional social publishing (epic #353, ADR 0318): how a provider's answer
// is classified, the Retry-After and back-off arithmetic, and the optional delivery settings. Pure.
import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryError, KINDS, backoffDelay, codeOfKind, deliveryPolicy, detailOf, kindOfStatus, parseRetryAfter, retryDelay, validProviderPostId } from "../../netlify/lib/social-delivery.mjs";

const NOW = Date.parse("2026-11-01T12:00:00Z");

test("a status the provider answered maps to one kind; everything else is uncertain", () => {
  assert.equal(kindOfStatus(429), "rate-limited");
  assert.equal(kindOfStatus(401), "auth");
  for (const status of [400, 403, 404, 409, 410, 422]) assert.equal(kindOfStatus(status), "rejected", String(status));
  for (const status of [0, 200, 408, 500, 502, 503, 504, 599]) assert.equal(kindOfStatus(status), "uncertain", String(status));
});

test("a delivery error has a fixed message and never repeats what a provider said", () => {
  for (const kind of KINDS) {
    const error = new DeliveryError(kind, { status: 429, retryAfterMs: 5000, requestId: "req-1" });
    assert.equal(error.kind, kind);
    assert.ok(error.message.length > 10);
    assert.doesNotMatch(error.message, /\d{3}/);
  }
  assert.equal(new DeliveryError("something-else").kind, "uncertain", "an unknown kind is the safe one");
  const odd = new DeliveryError("rejected", { status: 99999, retryAfterMs: -5, requestId: "x".repeat(400) });
  assert.equal(odd.status, 0);
  assert.equal(odd.retryAfterMs, null);
  assert.equal(odd.requestId, null);
});

test("each kind keeps a short code and a fixed sentence", () => {
  assert.deepEqual(KINDS.map(codeOfKind), ["provider-unavailable", "rate-limited", "provider-rejected", "provider-auth", "timeout"]);
  for (const kind of KINDS) assert.match(codeOfKind(kind), /^[a-z][a-z0-9-]{0,39}$/);
  assert.ok(detailOf("rejected", 422).includes("HTTP 422"));
  assert.ok(detailOf("uncertain", 0).length <= 500);
});

test("Retry-After is whole seconds or an HTTP date, and anything else is no hint", () => {
  assert.equal(parseRetryAfter("120", NOW), 120_000);
  assert.equal(parseRetryAfter(" 0 ", NOW), 0);
  assert.equal(parseRetryAfter("Sun, 01 Nov 2026 12:05:00 GMT", NOW), 300_000);
  assert.equal(parseRetryAfter("Sun, 01 Nov 2026 11:00:00 GMT", NOW), 0, "a date in the past means now");
  for (const bad of ["", null, undefined, "-5", "1.5", "soon", "12345678901", "2026-11-01T12:05:00Z", "Sun, 32 Nov 2026 12:05:00 GMT x"]) assert.equal(parseRetryAfter(bad, NOW), null, String(bad));
});

test("back-off doubles per attempt, is capped, and never drops below half the nominal wait", () => {
  const policy = deliveryPolicy({});
  const at = (attempt, roll) => backoffDelay(attempt, policy, () => roll);
  assert.equal(at(1, 1), 60_000);
  assert.equal(at(1, 0), 30_000);
  assert.equal(at(2, 1), 120_000);
  assert.equal(at(3, 1), 240_000);
  assert.equal(at(30, 1), 3_600_000, "capped");
  assert.equal(at(30, 0), 1_800_000);
  assert.equal(at(0, 1), 60_000, "attempts start at one");
  assert.equal(at(2, 5), 120_000, "a bad random is clamped");
  assert.equal(at(2, Number.NaN), 60_000);
  for (let attempt = 1; attempt < 12; attempt += 1) assert.ok(at(attempt, 0.5) <= at(attempt + 1, 0.5) || at(attempt, 0.5) === 2_700_000);
});

test("a provider's Retry-After is a floor, capped at a day; back-off still applies", () => {
  const policy = deliveryPolicy({});
  const wait = (error, attempt = 1) => retryDelay(error, attempt, policy, () => 1);
  assert.equal(wait(new DeliveryError("rate-limited", { retryAfterMs: 600_000 })), 600_000);
  assert.equal(wait(new DeliveryError("rate-limited", { retryAfterMs: 1000 })), 60_000, "a short hint does not shorten the back-off");
  assert.equal(wait(new DeliveryError("rate-limited", { retryAfterMs: 90 * 86400_000 })), 86_400_000, "a hostile hint is capped");
  assert.equal(wait(new DeliveryError("rate-limited")), 60_000);
  assert.equal(wait(new DeliveryError("transient", { retryAfterMs: 600_000 })), 60_000, "only a rate limit carries a hint");
});

test("delivery settings have defaults, ranges, and name a bad setting without its value", () => {
  const policy = deliveryPolicy({});
  assert.deepEqual([policy.maxAttempts, policy.batch, policy.perAccount, policy.leaseSeconds, policy.providerTimeoutMs, policy.budgetMs], [5, 5, 3, 300, 4000, 8000]);
  assert.deepEqual(policy.problems, []);
  assert.equal(deliveryPolicy({ OPENBLOG_SOCIAL_MAX_ATTEMPTS: "8" }).maxAttempts, 8);
  const bad = deliveryPolicy({ OPENBLOG_SOCIAL_MAX_ATTEMPTS: "99", OPENBLOG_SOCIAL_BATCH_SIZE: "0", OPENBLOG_SOCIAL_LEASE_SECONDS: "abc", OPENBLOG_SOCIAL_BACKOFF_SECONDS: "1.5", OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "-3" });
  assert.deepEqual([bad.maxAttempts, bad.batch, bad.leaseSeconds, bad.backoffBaseSeconds, bad.budgetSeconds], [5, 5, 300, 60, 8]);
  assert.deepEqual([...bad.problems].sort(), ["OPENBLOG_SOCIAL_BACKOFF_SECONDS", "OPENBLOG_SOCIAL_BATCH_SIZE", "OPENBLOG_SOCIAL_LEASE_SECONDS", "OPENBLOG_SOCIAL_MAX_ATTEMPTS", "OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS"]);
  assert.doesNotMatch(JSON.stringify(bad.problems), /99|abc|1\.5/);
  assert.ok(Object.isFrozen(policy));
});

test("a provider post id is printable, bounded and has no whitespace", () => {
  for (const ok of ["urn:li:share:7000000000000000000", "123456789_987654321", "a"]) assert.equal(validProviderPostId(ok), true, ok);
  for (const bad of ["", " ", "a b", "line\nbreak", "x".repeat(301), null, undefined, 12, "tab\t", "é"]) assert.equal(validProviderPostId(bad), false, String(bad));
});

test("the default policy fits a 10 second platform limit and can start a delivery", () => {
  const policy = deliveryPolicy({});
  assert.ok(policy.providerTimeoutMs + 2000 <= policy.budgetMs, "one provider call plus the margin fits the budget");
  assert.ok(policy.budgetMs < 10_000, "the budget is under Netlify's default function timeout");
});

test("a budget too small for one provider call is refused and flagged", () => {
  const policy = deliveryPolicy({ OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "6", OPENBLOG_SOCIAL_PROVIDER_TIMEOUT_SECONDS: "8" });
  assert.deepEqual([policy.budgetMs, policy.providerTimeoutMs], [8000, 4000]);
  assert.deepEqual([...policy.problems], ["OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS"]);
});
