// Authorized scheduling routes for optional social publishing (epic #353, story #356, ADR 0309):
// list the connected destinations, and create, list, edit, reschedule and cancel announcements.
//
// Server to server only. The Rust Admin has already checked its own session and CSRF token; this
// module checks that the caller holds the admin key (a worker key is refused), takes the site from
// the server's settings (a request naming one is refused), checks the destination belongs to this
// site and is connected, and applies the announcement rules of ADR 0308 again before any row is
// written. Storage is PostgREST over `fetchImpl`, the same fake-fetch seam as the credential store.
//
// Every write names the version it read and the status it expects, so two writers, or an author
// and a worker, can never both win; a lost race is a 409 that says to reload. Nothing here
// returns a token, a key, a lease owner or an idempotency key, and no error carries a provider or
// storage response, a request body or a refused value.

import { ACTOR_HEADER, SocialScopeError, authorizeSocial, ensureOwned, refuseClientScope, scopedQuery } from "./social-scope.mjs";
import { validProviderPostId } from "./social-delivery.mjs";
import {
  ScheduleError,
  checkCanonicalUrl,
  checkCaption,
  checkIdempotencyKey,
  checkTimeZone,
  editable,
  parseSchedule,
  providerOf,
  utcInstant,
  validStatus,
} from "./social-schedule.mjs";

export { ACTOR_HEADER };

export const MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_LIST = 50;
export const MAX_LIST = 100;
const POSTS = "openblog_social_posts";
const ACCOUNTS = "openblog_social_accounts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CREATE_FIELDS = ["accountId", "work", "canonicalUrl", "caption", "scheduledFor", "timeZone", "idempotencyKey"];
const EDIT_FIELDS = ["version", "caption", "scheduledFor", "timeZone"];
const RESCHEDULE_FIELDS = ["version", "scheduledFor", "timeZone"];
const CANCEL_FIELDS = ["version"];
const RETRY_FIELDS = ["version"];
const RESOLVE_FIELDS = ["version", "outcome", "providerPostId"];
const RESOLVE_OUTCOMES = ["published", "not-posted"];

class RouteError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "RouteError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const reply = (status, body) => ({ status, body });
const failure = (status, code, message, extra = {}) => reply(status, { error: message, code, ...extra });

const accountView = (account) => ({
  id: account.id,
  provider: account.provider,
  kind: account.kind,
  displayName: account.display_name,
  status: account.status,
});

const instant = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? utcInstant(new Date(ms)) : null;
};

// The announcement as Admin sees it. The destination's name and provider are included so the list
// is readable; the lease owner, the idempotency key and every credential stay on the server.
const postView = (row, account) => ({
  id: row.id,
  accountId: row.account_id,
  destination: account ? accountView(account) : null,
  work: row.work,
  canonicalUrl: row.canonical_url,
  caption: row.body,
  scheduledFor: instant(row.scheduled_for),
  status: row.status,
  version: row.version,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at ? instant(row.next_attempt_at) : null,
  retryable: row.status === "failed",
  resolvable: row.status === "unknown",
  lastErrorCode: row.last_error_code ?? null,
  providerPostId: row.provider_post_id ?? null,
  publishedAt: row.published_at ? instant(row.published_at) : null,
  canceledAt: row.canceled_at ? instant(row.canceled_at) : null,
  createdBy: row.created_by,
  createdAt: instant(row.created_at),
  updatedAt: instant(row.updated_at),
  editable: editable(row.status),
});

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Only the listed fields, no others, so a request cannot smuggle a status, a site or a lease.
function readBody(body, allowed, required) {
  if (!isPlainObject(body)) throw new RouteError(400, "invalid-request", "Send a JSON object.");
  for (const name of Object.keys(body)) {
    if (!allowed.includes(name)) throw new RouteError(400, "unknown-field", "The request has a field this route does not take.");
  }
  for (const name of required) {
    if (body[name] === undefined || body[name] === null) throw new RouteError(400, "missing-field", "The request is missing a required field.");
  }
  return body;
}

const readVersion = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RouteError(400, "invalid-version", "Send the version you are changing.");
  return value;
};

const readId = (query) => {
  const id = query.get("id") || "";
  if (!UUID.test(id)) throw new RouteError(400, "invalid-id", "That is not an announcement id.");
  return id;
};

const optionalZone = (value) => {
  if (value !== undefined && value !== null) checkTimeZone(value);
};

export function createAnnouncements({ settings, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (!settings || settings.enabled !== true) throw new SocialScopeError(404, "not-enabled", "Social publishing is not enabled.");
  const iso = (ms) => new Date(ms).toISOString();

  // PostgREST. A unique-violation comes back as `conflict`, anything else unexpected is a fixed error.
  const rest = async (method, table, query, body) => {
    let response;
    try {
      response = await fetchImpl(`${settings.url}/rest/v1/${table}?${query}`, {
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
      throw new RouteError(502, "storage-unavailable", "The schedule could not be reached. Try again.");
    }
    if (response.status === 409) return { conflict: true, rows: [] };
    if (!response.ok) throw new RouteError(502, "storage-failed", "The schedule refused the request.");
    const rows = await response.json().catch(() => []);
    return { conflict: false, rows: Array.isArray(rows) ? rows : [] };
  };

  const accountById = async (id) => {
    const { rows } = await rest("GET", ACCOUNTS, scopedQuery(settings, { id: `eq.${id}`, select: "id,site_id,provider,kind,display_name,status" }).toString());
    if (!rows.length) return null;
    ensureOwned(settings, rows);
    return rows[0];
  };

  const postById = async (id) => {
    const { rows } = await rest("GET", POSTS, scopedQuery(settings, { id: `eq.${id}`, select: "*" }).toString());
    if (!rows.length) return null;
    ensureOwned(settings, rows);
    return rows[0];
  };

  const usable = async (accountId) => {
    const account = await accountById(accountId);
    if (!account) throw new RouteError(404, "destination-not-found", "That destination is not connected to this site.");
    if (account.status !== "connected") {
      throw new RouteError(409, "destination-not-connected", account.status === "needs-reauth" ? "Connect this destination again before scheduling." : "That destination was disconnected.");
    }
    providerOf(account.provider);
    return account;
  };

  const destinations = async () => {
    const { rows } = await rest("GET", ACCOUNTS, scopedQuery(settings, { select: "id,site_id,provider,kind,display_name,status", status: "eq.connected", order: "display_name.asc", limit: "100" }).toString());
    ensureOwned(settings, rows);
    const supported = [];
    for (const row of rows) {
      try {
        providerOf(row.provider);
        supported.push(accountView(row));
      } catch {
        // A provider this release cannot announce to is not offered.
      }
    }
    return reply(200, { destinations: supported });
  };

  const list = async (query) => {
    const filters = { select: "*", order: "scheduled_for.desc", limit: String(DEFAULT_LIST) };
    const status = query.get("status");
    if (status) {
      if (!validStatus(status)) throw new RouteError(400, "invalid-status", "That is not a status.");
      filters.status = `eq.${status}`;
    }
    const work = query.get("work");
    if (work) {
      if (!/^\/[^?#\\\u0000-\u001F]{1,499}$/.test(work) || work.startsWith("//")) throw new RouteError(400, "invalid-work", "That is not a post path.");
      filters.work = `eq.${work}`;
    }
    if (query.has("limit")) {
      const limit = Number(query.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw new RouteError(400, "invalid-limit", "That is not a valid page size.");
      filters.limit = String(limit);
    }
    const { rows } = await rest("GET", POSTS, scopedQuery(settings, filters).toString());
    ensureOwned(settings, rows);
    const ids = [...new Set(rows.map((row) => row.account_id))].filter((id) => UUID.test(id));
    const accounts = new Map();
    if (ids.length) {
      const found = await rest("GET", ACCOUNTS, scopedQuery(settings, { id: `in.(${ids.join(",")})`, select: "id,site_id,provider,kind,display_name,status" }).toString());
      ensureOwned(settings, found.rows);
      for (const account of found.rows) accounts.set(account.id, account);
    }
    return reply(200, { announcements: rows.map((row) => postView(row, accounts.get(row.account_id))) });
  };

  const sameRequest = (row, wanted) =>
    row.work === wanted.work && row.canonical_url === wanted.canonicalUrl && row.body === wanted.caption && instant(row.scheduled_for) === wanted.scheduledFor;

  const create = async (identity, rawBody) => {
    const body = readBody(rawBody, CREATE_FIELDS, ["accountId", "work", "canonicalUrl", "caption", "scheduledFor", "idempotencyKey"]);
    if (typeof body.accountId !== "string" || !UUID.test(body.accountId)) throw new RouteError(400, "invalid-account", "That is not a destination id.");
    for (const name of ["work", "canonicalUrl", "caption", "scheduledFor", "idempotencyKey"]) {
      if (typeof body[name] !== "string") throw new RouteError(400, "invalid-request", "The request has a field of the wrong type.");
    }
    optionalZone(body.timeZone);
    checkIdempotencyKey(body.idempotencyKey);
    // Look the destination up without judging its state yet: a request this key already made is
    // answered as it was, even if the destination needs to be connected again since.
    const account = await accountById(body.accountId);
    if (!account) throw new RouteError(404, "destination-not-found", "That destination is not connected to this site.");
    providerOf(account.provider);
    const caption = checkCaption(account.provider, body.caption);
    checkCanonicalUrl(body.canonicalUrl, body.work);

    // The same key means the same request: a retry of a timed-out submit gets the original row
    // back, even if time has since passed, and never a second post.
    const existing = await rest("GET", POSTS, scopedQuery(settings, { account_id: `eq.${account.id}`, idempotency_key: `eq.${body.idempotencyKey}`, select: "*" }).toString());
    const replay = (rows) => {
      ensureOwned(settings, rows);
      const wanted = { work: body.work, canonicalUrl: body.canonicalUrl, caption, scheduledFor: utcInstant(parseSchedule(body.scheduledFor, 0, { bounds: false })) };
      if (!sameRequest(rows[0], wanted)) throw new RouteError(409, "idempotency-conflict", "That request key was already used for a different announcement.");
      return reply(200, { announcement: postView(rows[0], account), replayed: true });
    };
    if (existing.rows.length) return replay(existing.rows);

    await usable(account.id);
    const at = parseSchedule(body.scheduledFor, now());
    const stamp = iso(now());
    const inserted = await rest("POST", POSTS, "select=*", {
      site_id: settings.siteId,
      account_id: account.id,
      work: body.work,
      canonical_url: body.canonicalUrl,
      body: caption,
      scheduled_for: utcInstant(at),
      status: "scheduled",
      idempotency_key: body.idempotencyKey,
      created_by: identity.actor,
      created_at: stamp,
      updated_at: stamp,
    });
    if (inserted.conflict) {
      // Two submits with one key raced: the one that lost reads the winner.
      const winner = await rest("GET", POSTS, scopedQuery(settings, { account_id: `eq.${account.id}`, idempotency_key: `eq.${body.idempotencyKey}`, select: "*" }).toString());
      if (winner.rows.length) return replay(winner.rows);
      throw new RouteError(409, "conflict", "The schedule changed; try again.");
    }
    ensureOwned(settings, inserted.rows);
    return reply(201, { announcement: postView(inserted.rows[0], account), replayed: false });
  };

  // The change an author may make to a scheduled announcement: caption, time, or both.
  const change = async (id, version, { caption, scheduledFor }) => {
    const row = await postById(id);
    if (!row) throw new RouteError(404, "not-found", "That announcement does not exist.");
    if (!editable(row.status)) throw new RouteError(409, "not-editable", new ScheduleError("not-editable").message, { status: row.status, version: row.version });
    if (row.version !== version) throw new RouteError(409, "stale", "This announcement changed since you opened it. Reload and try again.", { version: row.version });
    const account = await usable(row.account_id);
    const patch = { version: version + 1, updated_at: iso(now()) };
    if (caption !== undefined) patch.body = checkCaption(account.provider, caption);
    if (scheduledFor !== undefined) patch.scheduled_for = utcInstant(parseSchedule(scheduledFor, now()));
    const query = scopedQuery(settings, { id: `eq.${id}`, version: `eq.${version}`, status: "eq.scheduled", select: "*" }).toString();
    const { rows } = await rest("PATCH", POSTS, query, patch);
    // Zero rows: a worker claimed it, or another edit landed, between the read and the write.
    if (!rows.length) throw new RouteError(409, "conflict", "This announcement changed or was claimed just now. Reload and check its status.");
    ensureOwned(settings, rows);
    return reply(200, { announcement: postView(rows[0], account) });
  };

  const edit = async (query, rawBody) => {
    const id = readId(query);
    const body = readBody(rawBody, EDIT_FIELDS, ["version"]);
    const version = readVersion(body.version);
    if (body.caption === undefined && body.scheduledFor === undefined) throw new RouteError(400, "nothing-to-change", "Send a new caption or time.");
    if (body.caption !== undefined && typeof body.caption !== "string") throw new RouteError(400, "invalid-request", "The request has a field of the wrong type.");
    if (body.scheduledFor !== undefined && typeof body.scheduledFor !== "string") throw new RouteError(400, "invalid-request", "The request has a field of the wrong type.");
    optionalZone(body.timeZone);
    return change(id, version, body);
  };

  const reschedule = async (query, rawBody) => {
    const id = readId(query);
    const body = readBody(rawBody, RESCHEDULE_FIELDS, ["version", "scheduledFor"]);
    const version = readVersion(body.version);
    if (typeof body.scheduledFor !== "string") throw new RouteError(400, "invalid-request", "The request has a field of the wrong type.");
    optionalZone(body.timeZone);
    return change(id, version, { scheduledFor: body.scheduledFor });
  };

  const cancel = async (query, rawBody) => {
    const id = readId(query);
    const version = readVersion(readBody(rawBody, CANCEL_FIELDS, ["version"]).version);
    const row = await postById(id);
    if (!row) throw new RouteError(404, "not-found", "That announcement does not exist.");
    const account = await accountById(row.account_id);
    // Cancelling twice is the same as cancelling once, so a retried click is safe.
    if (row.status === "canceled") return reply(200, { announcement: postView(row, account) });
    if (!editable(row.status)) throw new RouteError(409, "not-editable", new ScheduleError("not-editable").message, { status: row.status, version: row.version });
    if (row.version !== version) throw new RouteError(409, "stale", "This announcement changed since you opened it. Reload and try again.", { version: row.version });
    const stamp = iso(now());
    const query2 = scopedQuery(settings, { id: `eq.${id}`, version: `eq.${version}`, status: "eq.scheduled", select: "*" }).toString();
    const { rows } = await rest("PATCH", POSTS, query2, { status: "canceled", canceled_at: stamp, version: version + 1, updated_at: stamp });
    if (!rows.length) throw new RouteError(409, "conflict", "This announcement was claimed just now, so it can no longer be canceled. Reload and check its status.");
    ensureOwned(settings, rows);
    return reply(200, { announcement: postView(rows[0], account) });
  };

  // Manual recovery (ADR 0318). Only a failed announcement can be retried: it goes back to the queue
  // with a fresh allowance of attempts. An unknown outcome may already be on the provider, so it
  // cannot be retried; a person looks at the account and resolves it as posted (with the provider's
  // post id) or not posted, and only then can it be retried. Both name the version they read.
  const retry = async (query, rawBody) => {
    const id = readId(query);
    const version = readVersion(readBody(rawBody, RETRY_FIELDS, ["version"]).version);
    const row = await postById(id);
    if (!row) throw new RouteError(404, "not-found", "That announcement does not exist.");
    if (row.status === "unknown") throw new RouteError(409, "needs-resolution", "This may already be posted. Check the account, then say whether it was posted.", { status: row.status, version: row.version });
    if (row.status !== "failed") throw new RouteError(409, "not-retryable", "Only an announcement that failed can be retried.", { status: row.status, version: row.version });
    if (row.version !== version) throw new RouteError(409, "stale", "This announcement changed since you opened it. Reload and try again.", { version: row.version });
    const account = await usable(row.account_id);
    const patch = { status: "scheduled", next_attempt_at: null, attempt_floor: row.attempt_count, reconcile_count: 0, last_error_code: null, version: version + 1, updated_at: iso(now()) };
    const { rows } = await rest("PATCH", POSTS, scopedQuery(settings, { id: `eq.${id}`, version: `eq.${version}`, status: "eq.failed", select: "*" }).toString(), patch);
    if (!rows.length) throw new RouteError(409, "conflict", "This announcement changed just now. Reload and check its status.");
    ensureOwned(settings, rows);
    return reply(200, { announcement: postView(rows[0], account) });
  };

  const resolve = async (identity, query, rawBody) => {
    const id = readId(query);
    const body = readBody(rawBody, RESOLVE_FIELDS, ["version", "outcome"]);
    const version = readVersion(body.version);
    if (!RESOLVE_OUTCOMES.includes(body.outcome)) throw new RouteError(400, "invalid-outcome", "Say whether it was posted or not posted.");
    if (body.outcome === "published" && !validProviderPostId(body.providerPostId)) throw new RouteError(400, "invalid-provider-post-id", "Enter the post id the provider shows for it.");
    if (body.outcome === "not-posted" && body.providerPostId !== undefined) throw new RouteError(400, "unknown-field", "A post that was not posted has no post id.");
    const row = await postById(id);
    if (!row) throw new RouteError(404, "not-found", "That announcement does not exist.");
    if (row.status !== "unknown") throw new RouteError(409, "not-resolvable", "Only an announcement with an unknown outcome can be resolved.", { status: row.status, version: row.version });
    if (row.version !== version) throw new RouteError(409, "stale", "This announcement changed since you opened it. Reload and try again.", { version: row.version });
    const account = await accountById(row.account_id);
    const published = body.outcome === "published";
    const { rows } = await rest("POST", "rpc/openblog_social_settle", "", {
      p_site_id: settings.siteId,
      p_post_id: id,
      p_version: version,
      p_result: published ? "published" : "failed",
      p_provider_post_id: published ? body.providerPostId : null,
      p_error_code: published ? null : "reviewed-not-posted",
      p_error_detail: published ? null : `Checked by ${identity.actor}: it was not posted.`,
    });
    if (!rows.length) throw new RouteError(409, "conflict", "This announcement changed just now. Reload and check its status.");
    ensureOwned(settings, rows);
    return reply(200, { announcement: postView(rows[0], account) });
  };

  // What was tried: every attempt, newest last, with its short code and fixed sentence.
  const attempts = async (query) => {
    const id = readId(query);
    if (!(await postById(id))) throw new RouteError(404, "not-found", "That announcement does not exist.");
    const { rows } = await rest("GET", "openblog_social_attempts", scopedQuery(settings, { post_id: `eq.${id}`, select: "*", order: "attempt_no.asc", limit: "50" }).toString());
    ensureOwned(settings, rows);
    return reply(200, {
      attempts: rows.map((row) => ({
        attemptNo: row.attempt_no,
        startedAt: instant(row.started_at),
        finishedAt: row.finished_at ? instant(row.finished_at) : null,
        outcome: row.outcome ?? null,
        httpStatus: row.http_status ?? null,
        errorCode: row.error_code ?? null,
        errorDetail: row.error_detail ?? null,
        providerPostId: row.provider_post_id ?? null,
      })),
    });
  };

  // { method, route, query, headers, body } -> { status, body }. `body` is parsed JSON or text.
  return async function handle({ method = "GET", route = "", query = "", headers = {}, body } = {}) {
    try {
      const identity = await authorizeSocial(headers, settings, { allow: ["admin"] });
      const params = query instanceof URLSearchParams ? query : new URLSearchParams(query || "");
      const path = String(route).replace(/^\/+|\/+$/g, "");
      const table = {
        "GET destinations": () => destinations(),
        "GET announcements": () => list(params),
        "POST announcements": (parsed) => create(identity, parsed),
        "PATCH announcements": (parsed) => edit(params, parsed),
        "POST announcements/reschedule": (parsed) => reschedule(params, parsed),
        "POST announcements/cancel": (parsed) => cancel(params, parsed),
        "POST announcements/retry": (parsed) => retry(params, parsed),
        "POST announcements/resolve": (parsed) => resolve(identity, params, parsed),
        "GET announcements/attempts": () => attempts(params),
      };
      const run = table[`${method} ${path}`];
      if (!run) {
        const known = Object.keys(table).some((key) => key.endsWith(` ${path}`));
        return failure(known ? 405 : 404, known ? "method-not-allowed" : "not-found", known ? "That method is not allowed." : "Not found.");
      }
      const parsed = await parseBody(method, body);
      refuseClientScope({ query: params, body: parsed });
      return await run(parsed);
    } catch (error) {
      if (error instanceof RouteError) return failure(error.status, error.code, error.message, error.extra);
      if (error instanceof ScheduleError) return failure(422, error.code, error.message);
      if (error instanceof SocialScopeError) return failure(error.status, error.code, error.message);
      // Anything else is a bug; say nothing about it, in the response or here.
      return failure(500, "internal", "Something went wrong.");
    }
  };
}

async function parseBody(method, body) {
  if (method === "GET" || method === "HEAD") return undefined;
  if (body === undefined || body === null || body === "") throw new RouteError(400, "invalid-request", "Send a JSON object.");
  if (typeof body !== "string") return body;
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new RouteError(413, "too-large", "The request is too large.");
  try {
    return JSON.parse(body);
  } catch {
    throw new RouteError(400, "invalid-json", "The request is not valid JSON.");
  }
}
