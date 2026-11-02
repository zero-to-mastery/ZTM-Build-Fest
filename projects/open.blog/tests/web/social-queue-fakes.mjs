// An in-memory stand-in for Supabase behind the delivery queue, for the node tests of the claim,
// the worker and the retry code. It follows the rules supabase/social-queue.sql enforces (the SQL
// itself is exercised against a real Postgres by social-queue-sql.test.mjs when one is supplied):
// due and paused filters, a per-account cap, leases, attempt rows, version fences and the
// unknown-outcome rules. No network is used.

export const SITE = "lantern-studios";
export const LINKEDIN = "11111111-1111-4111-8111-111111111111";
export const FACEBOOK = "22222222-2222-4222-8222-222222222222";
export const REAUTH = "44444444-4444-4444-8444-444444444444";
export const GONE = "33333333-3333-4333-8333-333333333333";
export const FUTURE = "66666666-6666-4666-8666-666666666666";

export const SERVICE_KEY = "sb_secret_".padEnd(48, "c3");
export const ADMIN_KEY = "adm_".padEnd(48, "a1");
export const WORKER_KEY = "wrk_".padEnd(48, "b2");
// The deployment settings a hosted social function needs, for the tests of the queue and the worker.
export const env = (overrides = {}) => ({
  OPENBLOG_SOCIAL_ENABLED: "true",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: SERVICE_KEY,
  OPENBLOG_SITE_ID: SITE,
  OPENBLOG_SOCIAL_ADMIN_KEY: ADMIN_KEY,
  OPENBLOG_SOCIAL_WORKER_KEY: WORKER_KEY,
  OPENBLOG_SOCIAL_TOKEN_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
  ...overrides,
});

import { createWorker } from "../../netlify/lib/social-worker.mjs";
import { createCredentialStore } from "../../netlify/lib/social-credentials.mjs";
import { deliveryPolicy } from "../../netlify/lib/social-delivery.mjs";
import { socialSettings } from "../../netlify/lib/social-scope.mjs";

const iso = (ms) => new Date(ms).toISOString();

export function queueStorage({ now, failRpc, failGet } = {}) {
  const accounts = [
    { id: LINKEDIN, site_id: SITE, provider: "linkedin", kind: "member", external_id: "urn:li:person:abc", display_name: "Mikey Nichols", status: "connected", paused_until: null },
    { id: FACEBOOK, site_id: SITE, provider: "facebook", kind: "page", external_id: "1234567890", display_name: "Lantern Page", status: "connected", paused_until: null },
    { id: REAUTH, site_id: SITE, provider: "linkedin", kind: "member", external_id: "urn:li:person:old", display_name: "Stale", status: "needs-reauth", paused_until: null },
    { id: GONE, site_id: SITE, provider: "linkedin", kind: "member", external_id: "urn:li:person:gone", display_name: "Old", status: "disconnected", paused_until: null },
    { id: FUTURE, site_id: SITE, provider: "threads", kind: "member", external_id: "t1", display_name: "Future", status: "connected", paused_until: null },
  ];
  const posts = [];
  const attempts = [];
  const credentials = [];
  const calls = [];
  let sequence = 0;

  const addPost = (fields = {}) => {
    sequence += 1;
    const row = {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, "0")}`,
      site_id: SITE,
      account_id: LINKEDIN,
      work: `/posts/p${sequence}/`,
      canonical_url: `https://blog.example.org/posts/p${sequence}/`,
      body: "A new post is live.",
      scheduled_for: iso(now() - 3600_000 - sequence * 1000),
      status: "scheduled",
      version: 1,
      idempotency_key: `idem-key-${String(sequence).padStart(12, "0")}`,
      claimed_by: null,
      claimed_at: null,
      lease_expires_at: null,
      attempt_count: 0,
      attempt_floor: 0,
      reconcile_count: 0,
      next_attempt_at: null,
      provider_post_id: null,
      published_at: null,
      last_error_code: null,
      created_by: "mikey",
      created_at: iso(now()),
      updated_at: iso(now()),
      canceled_at: null,
      ...fields,
    };
    posts.push(row);
    return row;
  };

  const accountOf = (post) => accounts.find((account) => account.id === post.account_id && account.site_id === post.site_id);
  const ms = (value) => (value ? Date.parse(value) : null);
  const bump = (row, patch) => {
    Object.assign(row, patch, { version: row.version + 1, updated_at: iso(now()) });
    return row;
  };

  const reap = (siteId, maxAttempts) => {
    let count = 0;
    for (const row of posts) {
      if (row.site_id !== siteId || row.status !== "claimed" || ms(row.lease_expires_at) > now()) continue;
      const attempt = attempts.find((a) => a.post_id === row.id && a.attempt_no === row.attempt_count && !a.finished_at);
      const sent = Boolean(attempt?.sending_at);
      if (attempt) Object.assign(attempt, { finished_at: iso(now()), outcome: sent ? "unknown" : "failed", error_code: "lease-expired" });
      const spent = row.attempt_count - row.attempt_floor >= maxAttempts;
      bump(row, {
        status: sent ? "unknown" : spent ? "failed" : "scheduled",
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        next_attempt_at: sent ? iso(now() + 5 * 60_000) : spent ? null : iso(now()),
        last_error_code: sent ? "lease-expired" : spent ? "attempts-exhausted" : "lease-expired",
      });
      count += 1;
    }
    return count;
  };

  const claim = (args) => {
    const limit = Math.min(Math.max(args.p_limit ?? 5, 1), 25);
    const lease = Math.min(Math.max(args.p_lease_seconds ?? 300, 30), 900);
    const max = Math.min(Math.max(args.p_max_attempts ?? 5, 1), 10);
    const per = Math.min(Math.max(args.p_per_account ?? 3, 1), 25);
    reap(args.p_site_id, max);
    const skip = args.p_skip_providers || [];
    const due = posts
      .filter((row) => {
        const account = accountOf(row);
        return (
          row.site_id === args.p_site_id &&
          row.status === "scheduled" &&
          ms(row.scheduled_for) <= now() &&
          (ms(row.next_attempt_at) ?? ms(row.scheduled_for)) <= now() &&
          row.attempt_count - row.attempt_floor < max &&
          account &&
          !(account.paused_until && ms(account.paused_until) > now()) &&
          !skip.includes(account.provider)
        );
      })
      .sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : a.scheduled_for > b.scheduled_for ? 1 : a.id < b.id ? -1 : 1));
    const perAccount = new Map();
    const picked = [];
    for (const row of due) {
      const taken = perAccount.get(row.account_id) || 0;
      if (taken >= per || picked.length >= limit) continue;
      perAccount.set(row.account_id, taken + 1);
      picked.push(row);
    }
    for (const row of picked) {
      bump(row, { status: "claimed", claimed_by: args.p_worker, claimed_at: iso(now()), lease_expires_at: iso(now() + lease * 1000), attempt_count: row.attempt_count + 1, next_attempt_at: null });
      attempts.push({ id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(attempts.length + 1).padStart(12, "0")}`, site_id: row.site_id, post_id: row.id, attempt_no: row.attempt_count, worker: args.p_worker, started_at: iso(now()), finished_at: null, outcome: null, sending_at: null, error_code: null });
    }
    return picked.map((row) => ({ ...row }));
  };

  const markSending = (args) => {
    const attempt = attempts.find((a) => a.site_id === args.p_site_id && a.post_id === args.p_post_id && a.attempt_no === args.p_attempt_no && !a.finished_at && !a.sending_at);
    const row = posts.find((p) => p.id === args.p_post_id && p.site_id === args.p_site_id);
    if (!attempt || !row || row.status !== "claimed" || row.attempt_count !== args.p_attempt_no || ms(row.lease_expires_at) <= now()) return false;
    attempt.sending_at = iso(now());
    return true;
  };

  const settle = (args) => {
    if (!["published", "retry", "failed", "unknown"].includes(args.p_result)) throw new Error("invalid result");
    if (args.p_result === "published" && !args.p_provider_post_id) throw new Error("published needs the provider post id");
    const row = posts.find((p) => p.id === args.p_post_id && p.site_id === args.p_site_id && p.version === args.p_version && ["claimed", "unknown"].includes(p.status));
    if (!row) return [];
    if (row.status === "unknown" && args.p_result === "retry") throw new Error("an unknown outcome resolves only to published or failed");
    // The unique index openblog_social_posts_provider_post (site_id, account_id, provider_post_id).
    if (args.p_result === "published" && posts.some((p) => p !== row && p.site_id === row.site_id && p.account_id === row.account_id && p.provider_post_id === args.p_provider_post_id)) {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { status: 409 });
    }
    if (row.status === "claimed" || args.p_result !== "unknown") {
      const attempt = attempts.find((a) => a.post_id === row.id && a.attempt_no === row.attempt_count && (!a.finished_at || a.outcome === "unknown"));
      if (attempt) {
        Object.assign(attempt, {
          finished_at: attempt.finished_at || iso(now()),
          outcome: args.p_result === "published" ? "published" : args.p_result === "unknown" ? "unknown" : "failed",
          http_status: args.p_http_status ?? attempt.http_status ?? null,
          provider_request_id: args.p_request_id ?? attempt.provider_request_id ?? null,
          provider_post_id: args.p_result === "published" ? args.p_provider_post_id : attempt.provider_post_id ?? null,
          error_code: args.p_result === "published" ? null : args.p_error_code ?? attempt.error_code ?? null,
          error_detail: args.p_result === "published" ? null : (args.p_error_detail ?? attempt.error_detail ?? null),
        });
      }
    }
    const release = { claimed_by: null, claimed_at: null, lease_expires_at: null };
    const previous = row.status;
    if (args.p_result === "published") bump(row, { ...release, status: "published", published_at: iso(now()), provider_post_id: args.p_provider_post_id, next_attempt_at: null, last_error_code: null });
    else if (args.p_result === "retry") bump(row, { ...release, status: "scheduled", next_attempt_at: args.p_next_at ?? iso(now()), last_error_code: args.p_error_code, attempt_floor: row.attempt_floor + (args.p_error_code === "deferred" ? 1 : 0) });
    else if (args.p_result === "failed") bump(row, { ...release, status: "failed", next_attempt_at: null, last_error_code: args.p_error_code });
    else bump(row, { ...release, status: "unknown", next_attempt_at: args.p_next_at, reconcile_count: row.reconcile_count + (previous === "unknown" ? 1 : 0), last_error_code: args.p_error_code ?? row.last_error_code });
    if (args.p_error_code === "rate-limited" && args.p_next_at) {
      const account = accountOf(row);
      const until = Math.max(ms(account.paused_until) ?? 0, ms(args.p_next_at));
      account.paused_until = iso(until);
    }
    return [{ ...row }];
  };

  const matches = (row, params) => {
    for (const [name, filter] of params) {
      if (["select", "order", "limit"].includes(name)) continue;
      const [operator, ...rest] = filter.split(".");
      const value = rest.join(".");
      const actual = row[name];
      if (operator === "eq" && String(actual) !== value) return false;
      if (operator === "in" && !value.slice(1, -1).split(",").includes(String(actual))) return false;
      if (operator === "lte" && !(actual !== null && actual !== undefined && Date.parse(actual) <= Date.parse(value))) return false;
    }
    return true;
  };

  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    const name = target.pathname.replace(/^\/rest\/v1\//, "");
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, name, query: target.search, body, headers: options.headers });
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (name.startsWith("rpc/")) {
      if (failRpc?.(name.slice(4), body)) return json(500, { message: "boom with secret sb_secret_value" });
      const rpc = name.slice(4);
      try {
        if (rpc === "openblog_social_claim_due") return json(200, claim(body));
        if (rpc === "openblog_social_mark_sending") return json(200, markSending(body));
        if (rpc === "openblog_social_settle") return json(200, settle(body));
      } catch (error) {
        return json(error.status || 400, { message: error.message });
      }
      return json(404, {});
    }
    if (failGet?.(name)) return json(500, {});
    const table = { openblog_social_posts: posts, openblog_social_accounts: accounts, openblog_social_attempts: attempts, openblog_social_credentials: credentials }[name];
    if (!table) return json(404, {});
    if (method === "GET") {
      let found = table.filter((row) => matches(row, target.searchParams));
      const order = target.searchParams.get("order");
      if (order) {
        const [column, direction] = order.split(".");
        found.sort((a, b) => (a[column] < b[column] ? -1 : 1) * (direction === "desc" ? -1 : 1));
      }
      const limit = Number(target.searchParams.get("limit"));
      if (limit) found = found.slice(0, limit);
      return json(200, found.map((row) => ({ ...row })));
    }
    if (method === "POST" && table === credentials) {
      credentials.push({ ...body });
      return json(201, [{ ...body }]);
    }
    if (method === "PATCH") {
      const changed = [];
      for (const row of table) {
        if (matches(row, target.searchParams)) {
          Object.assign(row, body);
          changed.push({ ...row });
        }
      }
      return json(200, changed);
    }
    return json(405, {});
  };

  return { fetchImpl, accounts, posts, attempts, credentials, calls, addPost, reap };
}

// A provider adapter that records what it is given and answers from a script. `script` is called
// with (call number, arguments) and returns { providerPostId } or throws; the default publishes.
export function fakeAdapter(provider, { publish, reconcile } = {}) {
  const published = [];
  const looked = [];
  const adapter = {
    provider,
    published,
    looked,
    async publish(args) {
      published.push(args);
      if (publish) return publish(published.length, args);
      return { providerPostId: `urn:fake:${provider}:${published.length}`, requestId: `req-${published.length}` };
    },
  };
  if (reconcile) {
    adapter.reconcile = async (args) => {
      looked.push(args);
      return reconcile(looked.length, args);
    };
  }
  return adapter;
}

export const T0 = Date.parse("2026-11-01T12:00:00Z");
export const ACCESS = "li_access_token_".padEnd(40, "z9");

// A worker over fresh fakes, with real encrypted credentials for the accounts that have one.
export async function workerSetup({ adapters, policyEnv = {}, storage = {}, accounts = [LINKEDIN, FACEBOOK] } = {}) {
  let clock = T0;
  const now = () => clock;
  const fakes = queueStorage({ now, ...storage });
  const settings = socialSettings(env());
  const credentials = createCredentialStore({ settings, fetchImpl: fakes.fetchImpl, now });
  for (const id of accounts) await credentials.save(id, { accessToken: id === LINKEDIN ? ACCESS : `fb_${ACCESS}`, expiresIn: 30 * 86400 });
  const policy = deliveryPolicy(policyEnv);
  const build = (extra = {}) => createWorker({ settings, adapters, fetchImpl: fakes.fetchImpl, now, random: () => 0.5, policy, credentials, ...extra });
  return { ...fakes, now, advance: (ms) => (clock += ms), worker: build(), build, settings, policy, credentials };
}

