// Optional social publishing, retries, rate limits and uncertain outcomes (epic #353, story #357,
// ADR 0318): a failure that certainly did not post is retried with back-off, a rate limit pauses
// the account, a refusal is final, and anything that may have posted is never sent again, only
// looked up. Providers are fake adapters; no network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { SocialCredentialError } from "../../netlify/lib/social-credentials.mjs";
import { DeliveryError } from "../../netlify/lib/social-delivery.mjs";
import { ACCESS, LINKEDIN, SERVICE_KEY, fakeAdapter, workerSetup as setup } from "./social-queue-fakes.mjs";

const failing = (kind, options) =>
  fakeAdapter("linkedin", {
    publish: () => {
      throw new DeliveryError(kind, options);
    },
  });
const MIN = 60_000;

test("a failure that certainly did not post is retried later with back-off, then delivered", async () => {
  let calls = 0;
  const adapter = fakeAdapter("linkedin", {
    publish: () => {
      calls += 1;
      if (calls === 1) throw new DeliveryError("transient", { status: 503 });
      return { providerPostId: "urn:fake:second" };
    },
  });
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  const first = await s.worker.run();
  assert.equal(first.retried, 1);
  assert.equal(post.status, "scheduled");
  assert.equal(post.last_error_code, "provider-unavailable");
  assert.equal(post.attempt_count, 1);
  assert.equal(Date.parse(post.next_attempt_at) - s.now(), 45_000, "base back-off, three quarters of it with a middle roll");
  assert.equal((await s.worker.run()).claimed, 0, "not before its time");
  assert.equal(adapter.published.length, 1);
  s.advance(46_000);
  const second = await s.worker.run();
  assert.equal(second.published, 1);
  assert.equal(post.status, "published");
  assert.equal(post.attempt_count, 2);
  assert.equal(s.attempts.length, 2);
  assert.deepEqual(s.attempts.map((a) => a.outcome), ["failed", "published"]);
  assert.equal(adapter.published[0].post.idempotencyKey, adapter.published[1].post.idempotencyKey, "one key for every attempt of one announcement");
});

test("back-off grows with each attempt", async () => {
  const adapter = failing("transient");
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  const waits = [];
  for (let i = 0; i < 3; i += 1) {
    await s.worker.run();
    waits.push(Date.parse(post.next_attempt_at) - s.now());
    s.advance(waits[i] + 1000);
  }
  assert.deepEqual(waits, [45_000, 90_000, 180_000]);
});

test("a rate limit honours Retry-After and pauses the whole account", async () => {
  const adapter = failing("rate-limited", { status: 429, retryAfterMs: 10 * MIN });
  const s = await setup({ adapters: { linkedin: adapter }, policyEnv: { OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  const limited = s.addPost();
  const other = s.addPost();
  const summary = await s.worker.run({});
  assert.equal(summary.claimed, 2);
  assert.equal(adapter.published.length, 2, "both were in the batch before the limit was seen");
  assert.equal(limited.last_error_code, "rate-limited");
  assert.equal(Date.parse(limited.next_attempt_at) - s.now(), 10 * MIN);
  assert.ok(Date.parse(s.accounts[0].paused_until) - s.now() >= 10 * MIN);
  const later = s.addPost();
  s.advance(5 * MIN);
  assert.equal((await s.worker.run()).claimed, 0, "the account is paused for everything");
  assert.equal(later.status, "scheduled");
  assert.equal(other.status, "scheduled");
  s.advance(6 * MIN);
  assert.ok((await s.worker.run()).claimed >= 1, "and resumes afterwards");
});

test("a hostile Retry-After cannot park an announcement for more than a day", async () => {
  const adapter = failing("rate-limited", { status: 429, retryAfterMs: 400 * 86400_000 });
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  await s.worker.run();
  assert.equal(Date.parse(post.next_attempt_at) - s.now(), 86400_000);
});

test("attempts run out: a dead letter that says why and is not retried", async () => {
  const adapter = failing("transient", { status: 503 });
  const s = await setup({ adapters: { linkedin: adapter }, policyEnv: { OPENBLOG_SOCIAL_MAX_ATTEMPTS: "3" } });
  const post = s.addPost();
  for (let i = 0; i < 6; i += 1) {
    await s.worker.run();
    s.advance(2 * 3600_000);
  }
  assert.equal(adapter.published.length, 3, "exactly the allowed attempts, no more");
  assert.equal(post.status, "failed");
  assert.equal(post.last_error_code, "attempts-exhausted");
  assert.equal(post.attempt_count, 3);
  assert.equal(s.attempts.at(-1).error_code, "attempts-exhausted");
});

test("a refusal or a refused credential is final, with no retry", async () => {
  for (const [kind, code] of [["rejected", "provider-rejected"], ["auth", "needs-reauth"]]) {
    const adapter = failing(kind, { status: kind === "auth" ? 401 : 422 });
    const s = await setup({ adapters: { linkedin: adapter } });
    const post = s.addPost();
    const summary = await s.worker.run();
    assert.equal(summary.failed, 1);
    assert.equal(post.status, "failed");
    assert.equal(post.last_error_code, code);
    assert.equal(post.next_attempt_at, null);
    s.advance(86400_000);
    await s.worker.run();
    assert.equal(adapter.published.length, 1, kind);
  }
});

test("anything that may have posted is unknown and never sent again", async () => {
  const cases = [
    new DeliveryError("uncertain", { status: 504 }),
    new Error(`socket hang up ${SERVICE_KEY} ${ACCESS}`),
    new DOMException("The operation timed out.", "TimeoutError"),
    "a string thrown",
    null,
  ];
  for (const thrown of cases) {
    const adapter = fakeAdapter("linkedin", {
      publish: () => {
        throw thrown;
      },
    });
    const s = await setup({ adapters: { linkedin: adapter } });
    const post = s.addPost();
    const summary = await s.worker.run();
    assert.equal(summary.unknown, 1);
    assert.equal(post.status, "unknown");
    assert.equal(post.last_error_code, "timeout");
    assert.equal(s.attempts[0].outcome, "unknown");
    assert.ok(post.next_attempt_at, "a look is scheduled");
    for (let i = 0; i < 4; i += 1) {
      s.advance(30 * MIN);
      await s.worker.run();
    }
    assert.equal(adapter.published.length, 1, "never sent a second time");
    const seen = JSON.stringify({ posts: s.posts, attempts: s.attempts });
    assert.equal(seen.includes(SERVICE_KEY) || seen.includes(ACCESS), false);
  }
});

test("a look-up that finds the post records its id and does not post again", async () => {
  const adapter = fakeAdapter("linkedin", {
    publish: () => {
      throw new DeliveryError("uncertain");
    },
    reconcile: () => ({ state: "published", providerPostId: "urn:fake:found" }),
  });
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  await s.worker.run();
  assert.equal(adapter.looked.length, 0, "not looked at the moment it became unknown");
  s.advance(6 * MIN);
  const summary = await s.worker.run();
  assert.equal(summary.reconciled.published, 1);
  assert.equal(post.status, "published");
  assert.equal(post.provider_post_id, "urn:fake:found");
  assert.equal(s.attempts[0].outcome, "published");
  assert.equal(s.attempts[0].provider_post_id, "urn:fake:found");
  assert.equal(adapter.published.length, 1);
  const [look] = adapter.looked;
  assert.deepEqual(Object.keys(look).sort(), ["accessToken", "account", "attemptedAt", "finishedAt", "post", "signal"]);
  assert.ok(look.attemptedAt);
  assert.ok(Date.parse(look.finishedAt) >= Date.parse(look.attemptedAt), "the window the attempt ran in is given");
});

test("a provider that refuses the token moves the account to needs-reauth, and its other posts are not sent", async () => {
  const adapter = failing("auth", { status: 401 });
  const s = await setup({ adapters: { linkedin: adapter }, policyEnv: { OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  const first = s.addPost();
  const second = s.addPost();
  const summary = await s.worker.run();
  assert.equal(summary.failed, 2);
  assert.equal(adapter.published.length, 1, "the second post fails before any send");
  assert.equal(s.accounts.find((a) => a.id === LINKEDIN).status, "needs-reauth");
  assert.deepEqual([first.status, first.last_error_code], ["failed", "needs-reauth"]);
  assert.deepEqual([second.status, second.last_error_code], ["failed", "needs-reauth"]);
  const third = s.addPost();
  s.advance(MIN);
  await s.worker.run();
  assert.deepEqual([third.status, third.last_error_code, adapter.published.length], ["failed", "needs-reauth", 1]);
});

test("a token refusal never overrides a reconnect or a disconnect that landed first", async () => {
  const adapter = failing("auth", { status: 401 });
  const s = await setup({ adapters: { linkedin: adapter } });
  s.addPost();
  const original = adapter.publish;
  adapter.publish = async (args) => {
    s.accounts.find((a) => a.id === LINKEDIN).status = "disconnected";
    return original(args);
  };
  await s.worker.run();
  assert.equal(s.accounts.find((a) => a.id === LINKEDIN).status, "disconnected");
});

test("a look-up whose post id another announcement already holds goes to a person, not round again", async () => {
  const adapter = fakeAdapter("linkedin", {
    publish: (n) => {
      if (n === 1) return { providerPostId: "urn:fake:sibling" };
      throw new DeliveryError("uncertain");
    },
    reconcile: () => ({ state: "published", providerPostId: "urn:fake:sibling" }),
  });
  const s = await setup({ adapters: { linkedin: adapter }, policyEnv: { OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS: "50" } });
  // The later-added post is scheduled earlier, so it is sent first.
  const post = s.addPost();
  const sibling = s.addPost();
  await s.worker.run();
  assert.deepEqual([sibling.status, post.status], ["published", "unknown"]);
  s.advance(6 * MIN);
  const summary = await s.worker.run();
  assert.equal(summary.reconciled.published, 0);
  assert.equal(summary.unrecorded, 0);
  assert.deepEqual([post.status, post.last_error_code, post.next_attempt_at, post.provider_post_id], ["unknown", "needs-review", null, null]);
  assert.equal(sibling.provider_post_id, "urn:fake:sibling");
  s.advance(86400_000);
  await s.worker.run();
  assert.equal(adapter.looked.length, 1, "never looked up again");
});

test("a look-up that cannot be recorded because storage is down is tried again later", async () => {
  let down = false;
  const adapter = fakeAdapter("linkedin", {
    publish: () => {
      throw new DeliveryError("uncertain");
    },
    reconcile: () => ({ state: "published", providerPostId: "urn:fake:found" }),
  });
  const s = await setup({ adapters: { linkedin: adapter }, storage: { failRpc: (name, body) => down && name === "openblog_social_settle" && body.p_result === "published" } });
  const post = s.addPost();
  await s.worker.run();
  down = true;
  s.advance(6 * MIN);
  const summary = await s.worker.run();
  assert.equal(summary.unrecorded, 1);
  assert.equal(post.status, "unknown");
  assert.notEqual(post.last_error_code, "needs-review");
  down = false;
  await s.worker.run();
  assert.deepEqual([post.status, post.provider_post_id], ["published", "urn:fake:found"]);
});

test("only a conclusive absence, long enough after the attempt, marks it not delivered", async () => {
  const absent = (conclusive) => () => ({ state: "absent", conclusive });
  const publishFails = () => {
    throw new DeliveryError("uncertain");
  };
  // Conclusive but too soon: the provider may not list a new post yet.
  const soon = fakeAdapter("linkedin", { publish: publishFails, reconcile: absent(true) });
  const a = await setup({ adapters: { linkedin: soon } });
  const early = a.addPost();
  await a.worker.run();
  a.advance(6 * MIN);
  await a.worker.run();
  assert.equal(early.status, "unknown");
  assert.equal(soon.looked.length, 1);
  // Conclusive and settled: failed, with a code that says it is safe to retry by hand.
  a.advance(2 * 3600_000);
  const summary = await a.worker.run();
  assert.equal(summary.reconciled.failed, 1);
  assert.equal(early.status, "failed");
  assert.equal(early.last_error_code, "not-delivered");
  assert.equal(soon.published.length, 1, "even now it is not sent automatically");
  // Not conclusive: stays unknown however long.
  const vague = fakeAdapter("linkedin", { publish: publishFails, reconcile: absent(false) });
  const b = await setup({ adapters: { linkedin: vague } });
  const stays = b.addPost();
  await b.worker.run();
  b.advance(6 * MIN);
  await b.worker.run();
  b.advance(2 * 3600_000);
  await b.worker.run();
  assert.equal(stays.status, "unknown");
});

test("a look-up that fails or cannot tell leaves it unknown and looks again later, then asks a person", async () => {
  const adapter = fakeAdapter("linkedin", {
    publish: () => {
      throw new DeliveryError("uncertain");
    },
    reconcile: (n) => {
      if (n % 2) throw new Error(`lookup failed ${ACCESS}`);
      return { state: "unknown" };
    },
  });
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  await s.worker.run();
  let looks = 0;
  for (let i = 0; i < 12 && post.next_attempt_at; i += 1) {
    s.advance(2 * 86400_000);
    await s.worker.run();
    looks = adapter.looked.length;
  }
  assert.equal(post.status, "unknown");
  assert.equal(post.next_attempt_at, null, "no more automatic looks");
  assert.equal(post.last_error_code, "needs-review");
  assert.equal(looks, 6, "a bounded number of looks");
  assert.equal(post.reconcile_count, 6);
  assert.equal(adapter.published.length, 1);
  assert.equal(JSON.stringify([s.posts, s.attempts]).includes(ACCESS), false);
});

test("a destination that cannot be looked up goes straight to a person", async () => {
  const adapter = failing("uncertain");
  const s = await setup({ adapters: { linkedin: adapter } });
  const post = s.addPost();
  await s.worker.run();
  s.advance(6 * MIN);
  const summary = await s.worker.run();
  assert.equal(summary.reconciled.stillUnknown, 1);
  assert.equal(post.status, "unknown");
  assert.equal(post.last_error_code, "needs-review");
  assert.equal(post.next_attempt_at, null);
  s.advance(86400_000);
  assert.equal((await s.worker.run()).reconciled.checked, 0);
});

test("a retry waiting for its time is not looked at as an unknown outcome", async () => {
  const adapter = fakeAdapter("linkedin", {
    publish: () => {
      throw new DeliveryError("transient");
    },
    reconcile: () => ({ state: "published", providerPostId: "urn:fake:no" }),
  });
  const s = await setup({ adapters: { linkedin: adapter } });
  s.addPost();
  await s.worker.run();
  s.advance(30_000);
  await s.worker.run();
  assert.equal(adapter.looked.length, 0);
});

test("a credential that cannot be used yet is a retry; one the provider dropped is final; the provider is not called", async () => {
  const cases = [
    [new SocialCredentialError("storage-unavailable", "x", { retryable: true }), "scheduled", "credential-error"],
    [new SocialCredentialError("refresh-failed", "x", { retryable: true }), "scheduled", "credential-error"],
    [new SocialCredentialError("needs-reauth", "x"), "failed", "needs-reauth"],
    [new SocialCredentialError("no-credential", "x"), "failed", "needs-reauth"],
    [new SocialCredentialError("invalid-tokens", "x"), "failed", "credential-error"],
  ];
  for (const [error, status, code] of cases) {
    const adapter = fakeAdapter("linkedin");
    const s = await setup({ adapters: { linkedin: adapter } });
    const post = s.addPost();
    const worker = s.build({
      credentials: {
        accessToken: async () => {
          throw error;
        },
      },
    });
    await worker.run();
    assert.equal(post.status, status, error.code);
    assert.equal(post.last_error_code, code, error.code);
    assert.equal(adapter.published.length, 0);
  }
});
