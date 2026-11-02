// The delivery contract of optional scheduled social publishing (epic #353, ADRs 0316 to 0318):
// the one narrow interface the worker calls a provider through, how a provider's answer is told
// apart (not sent, refused, rate limited, unknown), and the retry and back-off arithmetic.
//
// Pure: no network, no storage, no clock of its own. A provider adapter (LinkedIn Posts API,
// Facebook Pages feed; story SP5) implements `publish` and, where the provider allows, `reconcile`;
// the worker (social-worker.mjs) knows nothing else about a provider and is tested with a fake one.
//
// ADAPTER INTERFACE
//
//   adapter = {
//     provider: "linkedin",
//     // Posts the announcement. Resolves to { providerPostId, requestId? } only when the provider
//     // CONFIRMED success and named the post. Anything else must throw a DeliveryError:
//     //   "transient"    definitely not accepted, safe to try again (connection refused, 503 before queuing)
//     //   "rate-limited" the provider said slow down (429); pass `retryAfterMs` when it said how long
//     //   "rejected"     the provider refused this post and will again (400, 403, 404, 422)
//     //   "auth"         the credential was refused (401)
//     //   "uncertain"    the request may have reached the provider (timeout, dropped connection, 5xx,
//     //                  an unreadable answer). It is NEVER retried blindly.
//     // A plain Error is treated as "uncertain". `idempotencyKey` is stable across attempts of one
//     // announcement; send it to a provider that honours one.
//     publish({ post, account, accessToken, signal }),
//     // Optional. Looks the announcement up at the provider without posting. Resolves to
//     //   { state: "published", providerPostId }        it is there
//     //   { state: "absent", conclusive: true }          the provider can say it is not there
//     //   { state: "unknown" }                           it could not tell (or a lookup is not possible)
//     // `conclusive` is true only when the lookup covers everything a post of that time could be.
//     // `attemptedAt` and `finishedAt` (null if the attempt never recorded an end) bound the window
//     // to look in. "published" must name a post that can only be this announcement's: a match that
//     // could be another announcement's or a hand-made post is "unknown".
//     reconcile({ post, account, accessToken, attemptedAt, finishedAt, signal }),
//   }
//
// `post` is { id, idempotencyKey, caption, canonicalUrl, work }; `account` is { provider, kind,
// externalId, displayName }. The worker never gives an adapter a service key, an admin key, a lease
// or another account's data. No message here repeats anything a provider said.

export const KINDS = Object.freeze(["transient", "rate-limited", "rejected", "auth", "uncertain"]);

const MESSAGES = {
  transient: "The provider did not accept the request.",
  "rate-limited": "The provider asked us to slow down.",
  rejected: "The provider refused the post.",
  auth: "The provider refused the credential.",
  uncertain: "The provider's answer was not seen, so the post may or may not have been published.",
};

export class DeliveryError extends Error {
  // `retryAfterMs` is only read for "rate-limited"; `status` is the provider's HTTP status when there was one.
  constructor(kind, { status = 0, retryAfterMs = null, requestId = null } = {}) {
    super(MESSAGES[kind] || MESSAGES.uncertain);
    this.name = "DeliveryError";
    this.kind = KINDS.includes(kind) ? kind : "uncertain";
    this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
    this.requestId = typeof requestId === "string" && requestId.length <= 300 ? requestId : null;
  }
}

// The kind an HTTP status means when an adapter has nothing more specific: only a status the
// provider answered while it was reading the request. 5xx and the rest are "uncertain".
export function kindOfStatus(status) {
  if (status === 429) return "rate-limited";
  if (status === 401) return "auth";
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 410 || status === 422) return "rejected";
  return "uncertain";
}

// Retry-After is either whole seconds or an HTTP date. Anything else is no hint at all.
export function parseRetryAfter(value, nowMs) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

const code = (kind) =>
  ({ transient: "provider-unavailable", "rate-limited": "rate-limited", rejected: "provider-rejected", auth: "provider-auth", uncertain: "timeout" })[kind];

// The short code kept on the row for each kind, and the fixed sentence kept on the attempt.
export const codeOfKind = code;
export const detailOf = (kind, status) => `${MESSAGES[kind] || MESSAGES.uncertain}${status ? ` (HTTP ${status}.)` : ""}`.slice(0, 500);

const DEFAULTS = Object.freeze({
  maxAttempts: 5,
  batch: 5,
  perAccount: 3,
  leaseSeconds: 300,
  backoffBaseSeconds: 60,
  backoffMaxSeconds: 3600,
  maxRetryAfterSeconds: 86400,
  providerTimeoutSeconds: 4,
  budgetSeconds: 8,
  reconcileBatch: 5,
  maxReconciles: 6,
  absenceSettleSeconds: 900,
});

// Keep in step with SPARE_MS in social-worker.mjs.
export const MARGIN_SECONDS = 2;

const RANGES = {
  maxAttempts: ["OPENBLOG_SOCIAL_MAX_ATTEMPTS", 1, 10],
  batch: ["OPENBLOG_SOCIAL_BATCH_SIZE", 1, 25],
  leaseSeconds: ["OPENBLOG_SOCIAL_LEASE_SECONDS", 30, 900],
  backoffBaseSeconds: ["OPENBLOG_SOCIAL_BACKOFF_SECONDS", 5, 3600],
  providerTimeoutSeconds: ["OPENBLOG_SOCIAL_PROVIDER_TIMEOUT_SECONDS", 2, 30],
  budgetSeconds: ["OPENBLOG_SOCIAL_WORKER_BUDGET_SECONDS", 5, 50],
};

// Delivery settings, all optional. A value that is not a whole number in its range is ignored,
// the default is used and `problems` names the setting (never the value).
export function deliveryPolicy(env = {}) {
  const values = { ...DEFAULTS };
  const problems = [];
  for (const [field, [name, low, high]] of Object.entries(RANGES)) {
    const raw = String(env[name] ?? "").trim();
    if (!raw) continue;
    const number = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(number) && number >= low && number <= high) values[field] = number;
    else problems.push(name);
  }
  // A run must have room for at least one provider call plus the margin, or nothing would ever be
  // delivered. Refuse the pair, flag both settings and go back to the defaults.
  if (values.budgetSeconds < values.providerTimeoutSeconds + MARGIN_SECONDS) {
    problems.push(RANGES.budgetSeconds[0]);
    values.budgetSeconds = DEFAULTS.budgetSeconds;
    values.providerTimeoutSeconds = DEFAULTS.providerTimeoutSeconds;
  }
  return Object.freeze({
    ...values,
    problems: Object.freeze(problems),
    backoffBaseMs: values.backoffBaseSeconds * 1000,
    backoffMaxMs: Math.max(values.backoffMaxSeconds, values.backoffBaseSeconds) * 1000,
    maxRetryAfterMs: values.maxRetryAfterSeconds * 1000,
    providerTimeoutMs: values.providerTimeoutSeconds * 1000,
    budgetMs: values.budgetSeconds * 1000,
    absenceSettleMs: values.absenceSettleSeconds * 1000,
    // The first look at an unknown outcome is five minutes after, then it backs off.
    reconcileDelaysMs: Object.freeze([5, 15, 60, 360, 1440, 1440].map((minutes) => minutes * 60000)),
  });
}

// Exponential back-off with full jitter in its upper half: attempt 1 waits about the base, each
// further attempt doubles, never more than the cap, and never less than half the nominal wait so
// a run of bad luck cannot hammer a struggling provider.
export function backoffDelay(attemptNo, policy, random = Math.random) {
  const exponent = Math.min(Math.max(Number(attemptNo) || 1, 1) - 1, 20);
  const nominal = Math.min(policy.backoffBaseMs * 2 ** exponent, policy.backoffMaxMs);
  const roll = Math.min(Math.max(Number(random()) || 0, 0), 1);
  return Math.round(nominal / 2 + (nominal / 2) * roll);
}

// How long to wait before trying again. A provider's Retry-After is honoured as a floor but is
// capped (a hostile or broken header cannot park a post for a year), and the back-off still applies.
export function retryDelay(error, attemptNo, policy, random = Math.random) {
  const hinted = error.kind === "rate-limited" && error.retryAfterMs !== null ? Math.min(error.retryAfterMs, policy.maxRetryAfterMs) : 0;
  return Math.max(hinted, backoffDelay(attemptNo, policy, random));
}

// A provider post id as it is stored: printable, bounded, no whitespace.
export const validProviderPostId = (value) => typeof value === "string" && /^[\x21-\x7E]{1,300}$/.test(value);
