// The delivery worker of optional scheduled social publishing (epic #353, story #357, ADRs
// 0314 to 0316). One `run` claims a bounded batch of due announcements, delivers each through its
// provider's adapter, records the outcome, and then looks again at outcomes it could not confirm.
//
// What it guarantees, in order of importance:
//   * No duplicate. A row is posted only by the worker that holds its lease, and only after the
//     database confirmed "sending" while that lease was valid. Anything that may have reached the
//     provider and was not confirmed (timeout, dropped connection, 5xx, unreadable answer, a crash,
//     a failure to record success) becomes `unknown` and is never sent again by this code; it is
//     looked up (`reconcile`) or left for a person.
//   * `published` only with the provider's own post id from an adapter that confirmed success.
//   * A destination with no adapter is not guessed at: a provider this release knows but has no
//     adapter for yet waits in the queue; one it does not know fails explicitly.
//   * Bounded. A batch size, a per-account cap, a time budget with a margin per post, and a
//     provider timeout. Work that does not fit the budget is deferred without using an attempt.
//   * Nothing a provider said, no token and no key reaches an error, a summary or a log.
//
// The provider adapter is the interface of social-delivery.mjs; tests use a fake. The worker holds
// no state between runs: every run starts from the database.

import { createQueue, QueueError } from "./social-queue.mjs";
import { SocialCredentialError, createCredentialStore } from "./social-credentials.mjs";
import { SocialScopeError } from "./social-scope.mjs";
import { SocialTokenError } from "./social-tokens.mjs";
import { PROVIDERS, refreshWith } from "./social-providers.mjs";
import { DeliveryError, codeOfKind, deliveryPolicy, detailOf, retryDelay, validProviderPostId } from "./social-delivery.mjs";

const SPARE_MS = 2000;

const emptySummary = () => ({
  claimed: 0,
  published: 0,
  retried: 0,
  failed: 0,
  unknown: 0,
  deferred: 0,
  lost: 0,
  unrecorded: 0,
  reconciled: { checked: 0, published: 0, failed: 0, stillUnknown: 0 },
});

export function createWorker({ settings, providers = {}, adapters = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), random = Math.random, policy = deliveryPolicy({}), queue, credentials } = {}) {
  if (!settings || settings.enabled !== true) throw new SocialScopeError(404, "not-enabled", "Social publishing is not enabled.");
  const store = queue || createQueue({ settings, fetchImpl, now });
  const tokens = credentials || createCredentialStore({ settings, fetchImpl, now });
  // Providers this release knows but has no adapter for are left alone, not failed.
  // Own properties only, so a provider named like an Object member is never mistaken for an adapter.
  const adapterFor = (provider) => (typeof provider === "string" && Object.hasOwn(adapters, provider) ? adapters[provider] : null);
  const waiting = PROVIDERS.filter((provider) => !adapterFor(provider));

  const accessTokenFor = (account) => {
    const configured = providers[account.provider];
    const refresh = configured && account.provider === "linkedin" ? refreshWith(configured, fetchImpl) : undefined;
    return tokens.accessToken(account.id, { refresh });
  };

  const view = (post, account) => ({
    post: { id: post.id, idempotencyKey: post.idempotency_key, caption: post.body, canonicalUrl: post.canonical_url, work: post.work },
    account: { provider: account.provider, kind: account.kind, externalId: account.external_id, displayName: account.display_name },
  });

  // Records an outcome. If the row moved on (the lease ran out while the provider call ran), a
  // confirmed success is still recorded against the unknown outcome it became; nothing else is
  // forced. If recording itself fails, the lease expires and the row becomes unknown: never lost.
  const settle = async (summary, post, args) => {
    let row;
    try {
      row = await store.settle(post, args);
      if (!row && args.result === "published") {
        const current = await store.post(post.id);
        if (current && current.status === "unknown" && current.attempt_count === post.attempt_count) row = await store.settle(current, args);
      }
    } catch {
      summary.unrecorded += 1;
      return null;
    }
    if (!row) summary.lost += 1;
    return row;
  };

  const failed = (summary, post, errorCode, errorDetail, extra = {}) => {
    summary.failed += 1;
    return settle(summary, post, { result: "failed", errorCode, errorDetail, ...extra });
  };

  // What a delivery error means for the row: retry, fail, or unknown.
  const outcomeOf = (error, post) => {
    const attempts = post.attempt_count - (post.attempt_floor || 0);
    if (error.kind === "transient" || error.kind === "rate-limited") {
      if (attempts >= policy.maxAttempts) return { result: "failed", errorCode: "attempts-exhausted", errorDetail: detailOf(error.kind, error.status) };
      return { result: "retry", errorCode: codeOfKind(error.kind), errorDetail: detailOf(error.kind, error.status), nextAtMs: now() + retryDelay(error, attempts, policy, random) };
    }
    if (error.kind === "rejected" || error.kind === "auth") return { result: "failed", errorCode: codeOfKind(error.kind), errorDetail: detailOf(error.kind, error.status) };
    return { result: "unknown", errorCode: codeOfKind("uncertain"), errorDetail: detailOf("uncertain", error.status), nextAtMs: now() + policy.reconcileDelaysMs[0] };
  };

  const credentialOutcome = (error, post) => {
    const attempts = post.attempt_count - (post.attempt_floor || 0);
    if (error instanceof SocialCredentialError && (error.code === "needs-reauth" || error.code === "no-credential")) {
      return { result: "failed", errorCode: "needs-reauth", errorDetail: "This account must be connected again before it can post." };
    }
    if (error instanceof SocialScopeError) return { result: "failed", errorCode: "credential-error", errorDetail: "The account's credential could not be used." };
    // Storage or a provider token endpoint was unreachable, or a key could not open the envelope:
    // nothing was sent, so trying again later is safe.
    if (attempts >= policy.maxAttempts) return { result: "failed", errorCode: "attempts-exhausted", errorDetail: "The account's credential could not be used." };
    const retryable = error instanceof SocialCredentialError ? error.retryable : error instanceof SocialTokenError || error instanceof QueueError;
    if (!retryable) return { result: "failed", errorCode: "credential-error", errorDetail: "The account's credential could not be used." };
    return { result: "retry", errorCode: "credential-error", errorDetail: "The account's credential could not be used yet.", nextAtMs: now() + retryDelay(new DeliveryError("transient"), attempts, policy, random) };
  };

  // The provider refused the token itself: no later post on this account can succeed, so the
  // account is flagged for a reconnect (Admin's "connect again") and the rest of this batch fails
  // fast before any send. A flag that could not be written is tried again by the next refusal.
  const reauthNeeded = async (account) => {
    try {
      if (typeof store.markNeedsReauth === "function" && (await store.markNeedsReauth(account.id))) account.status = "needs-reauth";
    } catch {
      // Storage could not be reached; the post is still recorded as failed below.
    }
  };

  const record = (summary, post, outcome) => {
    if (outcome.result === "retry") summary.retried += 1;
    else if (outcome.result === "failed") summary.failed += 1;
    else if (outcome.result === "unknown") summary.unknown += 1;
    return settle(summary, post, outcome);
  };

  async function deliver(summary, post, account, deadline) {
    if (!account) return failed(summary, post, "account-not-connected", "The destination no longer exists.");
    if (account.status !== "connected") {
      return failed(summary, post, account.status === "needs-reauth" ? "needs-reauth" : "account-not-connected", account.status === "needs-reauth" ? "This account must be connected again before it can post." : "The destination was disconnected.");
    }
    const adapter = adapterFor(account.provider);
    if (!adapter) return failed(summary, post, "unsupported-provider", "This destination is not supported by this deployment.");
    // Not enough time left to finish safely: give the attempt back instead of starting a send that
    // the platform may cut off.
    if (deadline - now() < policy.providerTimeoutMs + SPARE_MS) {
      summary.deferred += 1;
      return settle(summary, post, { result: "retry", errorCode: "deferred", errorDetail: "Not enough time left in this run; it will be picked up next.", nextAtMs: now() });
    }
    let accessToken;
    try {
      accessToken = await accessTokenFor(account);
    } catch (error) {
      return record(summary, post, credentialOutcome(error, post));
    }
    // From here the request may reach the provider. The database must agree the lease is still ours.
    let allowed;
    try {
      allowed = await store.markSending(post);
    } catch {
      summary.unrecorded += 1;
      return null;
    }
    if (!allowed) {
      summary.lost += 1;
      return null;
    }
    let result;
    try {
      result = await adapter.publish({ ...view(post, account), accessToken, signal: AbortSignal.timeout(policy.providerTimeoutMs) });
      if (!result || !validProviderPostId(result.providerPostId)) throw new DeliveryError("uncertain");
    } catch (error) {
      const known = error instanceof DeliveryError ? error : new DeliveryError("uncertain");
      let outcome = outcomeOf(known, post);
      if (known.kind === "auth") {
        await reauthNeeded(account);
        outcome = { ...outcome, errorCode: "needs-reauth", errorDetail: "The provider refused this account's sign-in. Connect it again, then use Try again." };
      }
      return record(summary, post, { ...outcome, httpStatus: known.status || undefined, requestId: known.requestId || undefined });
    }
    summary.published += 1;
    return settle(summary, post, { result: "published", providerPostId: result.providerPostId, requestId: typeof result.requestId === "string" ? result.requestId : undefined, httpStatus: Number.isInteger(result.status) ? result.status : undefined });
  }

  // One look at an outcome that could not be confirmed.
  async function reconcile(summary, post, account) {
    summary.reconciled.checked += 1;
    const exhausted = post.reconcile_count + 1 >= policy.maxReconciles;
    const nextAtMs = exhausted ? null : now() + policy.reconcileDelaysMs[Math.min(post.reconcile_count + 1, policy.reconcileDelaysMs.length - 1)];
    const stillUnknown = (code) => {
      summary.reconciled.stillUnknown += 1;
      return settle(summary, post, { result: "unknown", errorCode: exhausted ? "needs-review" : code, errorDetail: exhausted ? "The provider could not confirm whether this was posted. Check the account and resolve it by hand." : undefined, nextAtMs });
    };
    const adapter = account && account.status === "connected" ? adapterFor(account.provider) : null;
    // No way to look it up: nothing will change by waiting, so it goes to a person now.
    if (!adapter || typeof adapter.reconcile !== "function") {
      summary.reconciled.stillUnknown += 1;
      return settle(summary, post, { result: "unknown", errorCode: "needs-review", errorDetail: "This destination cannot check whether the post was published. Check the account and resolve it by hand.", nextAtMs: null });
    }
    let found;
    try {
      const accessToken = await accessTokenFor(account);
      const attempt = await store.latestAttempt(post.id);
      found = await adapter.reconcile({ ...view(post, account), accessToken, attemptedAt: attempt?.started_at ?? null, finishedAt: attempt?.finished_at ?? null, signal: AbortSignal.timeout(policy.providerTimeoutMs) });
      if (found?.state === "absent") {
        const settled = attempt?.finished_at ? now() - Date.parse(attempt.finished_at) >= policy.absenceSettleMs : false;
        if (found.conclusive === true && settled) {
          summary.reconciled.failed += 1;
          return settle(summary, post, { result: "failed", errorCode: "not-delivered", errorDetail: "The provider confirmed this post is not there. It can be retried." });
        }
        return stillUnknown("timeout");
      }
    } catch {
      return stillUnknown("timeout");
    }
    if (found?.state === "published" && validProviderPostId(found.providerPostId)) {
      try {
        const row = await store.settle(post, { result: "published", providerPostId: found.providerPostId });
        if (row) summary.reconciled.published += 1;
        else summary.lost += 1;
        return row;
      } catch (error) {
        // Storage refused the id outright (it is already recorded on another announcement of this
        // account): the lookup found someone else's post. Looking again would find it again, so a
        // person decides. A storage outage is left for the next run, as any unrecorded outcome.
        if (!(error instanceof QueueError) || error.retryable) {
          summary.unrecorded += 1;
          return null;
        }
        summary.reconciled.stillUnknown += 1;
        return settle(summary, post, { result: "unknown", errorCode: "needs-review", errorDetail: "The post found on the provider belongs to another announcement. Check the account and resolve it by hand.", nextAtMs: null });
      }
    }
    return stillUnknown("timeout");
  }

  return {
    // { budgetMs } bounds the run. Resolves to counts only.
    async run({ budgetMs = policy.budgetMs } = {}) {
      const summary = emptySummary();
      const deadline = now() + Math.min(Math.max(budgetMs, 1000), 55_000);
      // Claim only what the budget can finish, so claimed work is not left to expire on its lease.
      const fits = Math.max(1, Math.floor((deadline - now() - SPARE_MS) / (policy.providerTimeoutMs + SPARE_MS)));
      const claimed = await store.claim({ limit: Math.min(policy.batch, fits), leaseSeconds: policy.leaseSeconds, maxAttempts: policy.maxAttempts, perAccount: policy.perAccount, skipProviders: waiting });
      summary.claimed = claimed.length;
      const accounts = await store.accounts(claimed.map((post) => post.account_id));
      for (const post of claimed) await deliver(summary, post, accounts.get(post.account_id), deadline);
      if (deadline - now() > SPARE_MS) {
        const unknown = await store.unknownDue({ limit: policy.reconcileBatch });
        const known = await store.accounts(unknown.map((post) => post.account_id));
        for (const post of unknown) {
          if (deadline - now() < policy.providerTimeoutMs + SPARE_MS) break;
          await reconcile(summary, post, known.get(post.account_id));
        }
      }
      return summary;
    },
  };
}
