// The hosted delivery queue (epic #353, story #357, ADR 0316): claim due announcements, mark the
// moment before a provider call, and settle the outcome, through the functions of
// supabase/social-queue.sql. Server-only, behind the site scope of ADR 0293.
//
// Every state change is one database function call, so a claim is atomic (`for update skip
// locked`), a lease can be lost but never shared, and a settle names the version it read. This
// module adds only the shape: validated arguments in, rows of this site out, fixed errors. A
// storage reply is never put in an error, so nothing a database or proxy says can reach a log.
//
// Storage is PostgREST over `fetchImpl`, the same fake-fetch seam as the rest of the social code.

import { SocialScopeError, ensureOwned, scopedQuery } from "./social-scope.mjs";

const POSTS = "openblog_social_posts";
const ACCOUNTS = "openblog_social_accounts";
const ATTEMPTS = "openblog_social_attempts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULTS = ["published", "retry", "failed", "unknown"];
const CODE = /^[a-z][a-z0-9-]{0,39}$/;

export class QueueError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "QueueError";
    this.code = code;
    this.retryable = retryable;
  }
}

const iso = (ms) => new Date(ms).toISOString();

export function createQueue({ settings, fetchImpl = globalThis.fetch, now = () => Date.now(), worker = "@worker" } = {}) {
  if (!settings || settings.enabled !== true) throw new SocialScopeError(404, "not-enabled", "Social publishing is not enabled.");

  const call = async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${settings.url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: settings.key,
          authorization: `Bearer ${settings.key}`,
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new QueueError("storage-unavailable", "The queue could not be reached.", { retryable: true });
    }
    if (!response.ok) throw new QueueError("storage-failed", `The queue refused the request (${Number(response.status) || 0}).`, { retryable: response.status >= 500 });
    try {
      return await response.json();
    } catch {
      throw new QueueError("storage-invalid", "The queue sent an answer that could not be read.");
    }
  };
  const rows = (value) => (Array.isArray(value) ? value : []);

  return {
    // Reaps expired leases, then claims up to `limit` due announcements. Each returned row has a
    // lease, a raised version and an open attempt row; `attempt_count` is this attempt's number.
    async claim({ limit, leaseSeconds, maxAttempts, perAccount, skipProviders = [] }) {
      const found = rows(
        await call("POST", "rpc/openblog_social_claim_due", {
          p_site_id: settings.siteId,
          p_worker: worker,
          p_limit: limit,
          p_lease_seconds: leaseSeconds,
          p_max_attempts: maxAttempts,
          p_per_account: perAccount,
          p_skip_providers: skipProviders,
        }),
      );
      ensureOwned(settings, found);
      return found;
    },

    // True while this attempt still holds a valid lease; false means do not call the provider.
    async markSending(post) {
      if (!UUID.test(String(post?.id))) throw new QueueError("invalid-post", "That is not an announcement id.");
      const answer = await call("POST", "rpc/openblog_social_mark_sending", { p_site_id: settings.siteId, p_post_id: post.id, p_attempt_no: post.attempt_count });
      return answer === true;
    },

    // Records an outcome for the version the caller read. Resolves to the updated row, or null when
    // the row is no longer that version (the lease was lost, or another writer got there first).
    async settle(post, { result, providerPostId, httpStatus, requestId, errorCode, errorDetail, nextAtMs }) {
      if (!UUID.test(String(post?.id)) || !Number.isSafeInteger(post.version)) throw new QueueError("invalid-post", "That is not an announcement.");
      if (!RESULTS.includes(result)) throw new QueueError("invalid-result", "That is not an outcome.");
      if (errorCode !== undefined && errorCode !== null && !CODE.test(errorCode)) throw new QueueError("invalid-result", "That is not an error code.");
      const found = rows(
        await call("POST", "rpc/openblog_social_settle", {
          p_site_id: settings.siteId,
          p_post_id: post.id,
          p_version: post.version,
          p_result: result,
          p_provider_post_id: providerPostId ?? null,
          p_http_status: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
          p_request_id: typeof requestId === "string" && requestId ? requestId.slice(0, 300) : null,
          p_error_code: errorCode ?? null,
          p_error_detail: typeof errorDetail === "string" ? errorDetail.slice(0, 500) : null,
          p_next_at: Number.isFinite(nextAtMs) ? iso(nextAtMs) : null,
        }),
      );
      if (!found.length) return null;
      ensureOwned(settings, found);
      return found[0];
    },

    async post(id) {
      if (!UUID.test(String(id))) throw new QueueError("invalid-post", "That is not an announcement id.");
      const found = rows(await call("GET", `${POSTS}?${scopedQuery(settings, { id: `eq.${id}`, select: "*" })}`));
      if (!found.length) return null;
      ensureOwned(settings, found);
      return found[0];
    },

    // Unknown outcomes whose next look is due. Rows with no next look are for a person.
    async unknownDue({ limit }) {
      const query = scopedQuery(settings, { status: "eq.unknown", next_attempt_at: `lte.${iso(now())}`, select: "*", order: "next_attempt_at.asc", limit: String(limit) });
      const found = rows(await call("GET", `${POSTS}?${query}`));
      ensureOwned(settings, found);
      return found;
    },

    async accounts(ids) {
      const wanted = [...new Set(ids)].filter((id) => UUID.test(String(id)));
      const map = new Map();
      if (!wanted.length) return map;
      const found = rows(await call("GET", `${ACCOUNTS}?${scopedQuery(settings, { id: `in.(${wanted.join(",")})`, select: "id,site_id,provider,kind,external_id,display_name,status" })}`));
      ensureOwned(settings, found);
      for (const account of found) map.set(account.id, account);
      return map;
    },

    // A provider refused the account's token (401, an expired Graph token): the account must be
    // connected again. Guarded on `connected`, so a reconnect or a disconnect that landed first
    // stands. Resolves to true when this call moved the account.
    async markNeedsReauth(accountId) {
      if (!UUID.test(String(accountId))) throw new QueueError("invalid-account", "That is not an account id.");
      const changed = rows(await call("PATCH", `${ACCOUNTS}?${scopedQuery(settings, { id: `eq.${accountId}`, status: "eq.connected" })}`, { status: "needs-reauth", updated_at: iso(now()) }));
      ensureOwned(settings, changed);
      return changed.length > 0;
    },

    // The most recent attempt of one announcement, for reconciliation.
    async latestAttempt(postId) {
      if (!UUID.test(String(postId))) throw new QueueError("invalid-post", "That is not an announcement id.");
      const found = rows(await call("GET", `${ATTEMPTS}?${scopedQuery(settings, { post_id: `eq.${postId}`, select: "*", order: "attempt_no.desc", limit: "1" })}`));
      ensureOwned(settings, found);
      return found[0] || null;
    },
  };
}
