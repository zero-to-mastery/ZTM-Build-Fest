// The identity boundary of optional scheduled social publishing (epic #353, ADR 0293): the
// hosted half of crates/openblog-core/src/social_publishing.rs. Both read
// tests/fixtures/social-scope.json and must accept and refuse the same values.
//
// Nothing in a browser talks to Supabase. The Rust Admin server checks its own session and calls
// the hosted social function with OPENBLOG_SOCIAL_ADMIN_KEY, naming the signed-in Admin user in
// X-OpenBlog-Actor; the scheduled worker calls with OPENBLOG_SOCIAL_WORKER_KEY and no actor. The
// role comes from which key matched, never from what the request says. The site is always
// OPENBLOG_SITE_ID: a request that names a site is refused, every query is filtered by it, and a
// row from another site is an error.
//
// Only Web Crypto and URL are used, so the module runs unchanged in Node (Netlify, tests) and in
// Deno (a Supabase Edge Function). Errors and settings never carry a key, token or refused value.

import { parseKeyring } from "./social-tokens.mjs";

export const ACTOR_HEADER = "x-openblog-actor";
export const WORKER_ACTOR = "@worker";
export const MAX_SITE_SCOPE_BYTES = 80;
export const MIN_SERVER_KEY_CHARS = 32;

const SITE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ADMIN_USERNAME = /^[a-z0-9_.-]{1,32}$/;
const SITE_KEYS = new Set(["site_id", "siteId", "site", "p_site_id"]);
const MAX_SCOPE_DEPTH = 16;

export class SocialScopeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SocialScopeError";
    this.status = status;
    this.code = code;
  }
}

export const validSiteScope = (value) => typeof value === "string" && SITE_SCOPE.test(value);
export const validActor = (value) => typeof value === "string" && ADMIN_USERNAME.test(value);

const text = (value) => String(value ?? "");

const httpsOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
};

// The deployment's social settings. Off unless OPENBLOG_SOCIAL_ENABLED is exactly "true"; when it
// is on but incomplete, still off, with the names (never the values) of what is wrong.
export function socialSettings(env = {}) {
  if (text(env.OPENBLOG_SOCIAL_ENABLED).trim() !== "true") return disabled([]);
  const url = text(env.SUPABASE_URL).replace(/\/$/, "");
  const key = text(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
  const siteId = text(env.OPENBLOG_SITE_ID).trim();
  const adminKey = text(env.OPENBLOG_SOCIAL_ADMIN_KEY);
  const workerKey = text(env.OPENBLOG_SOCIAL_WORKER_KEY);
  const problems = [];
  if (!httpsOrigin(`${url}/`)) problems.push("SUPABASE_URL");
  if (!key) problems.push("SUPABASE_SECRET_KEY");
  if (!validSiteScope(siteId)) problems.push("OPENBLOG_SITE_ID");
  // A server key must be long, and must not be any other credential the deployment holds: in
  // particular never the public anon or publishable key, so a public bearer can never act.
  const others = [key, env.OPENBLOG_ADMIN_API_KEY, env.SUPABASE_ANON_KEY, env.SUPABASE_PUBLISHABLE_KEY].map(text).filter(Boolean);
  const serverKey = (name, value, sibling) => {
    if (value.length < MIN_SERVER_KEY_CHARS || /\s/.test(value) || value === sibling || others.includes(value)) problems.push(name);
  };
  let tokenKeys = null;
  try {
    tokenKeys = parseKeyring(env.OPENBLOG_SOCIAL_TOKEN_KEYS);
  } catch {
    problems.push("OPENBLOG_SOCIAL_TOKEN_KEYS");
  }
  serverKey("OPENBLOG_SOCIAL_ADMIN_KEY", adminKey, workerKey);
  serverKey("OPENBLOG_SOCIAL_WORKER_KEY", workerKey, adminKey);
  if (problems.length) return disabled(problems);
  return sealed({ enabled: true, problems: [], url, siteId }, { key, adminKey, workerKey, tokenKeys });
}

const disabled = (problems) => Object.freeze({ enabled: false, problems: Object.freeze(problems), toJSON: () => ({ enabled: false, problems }) });

// Settings whose secrets are readable by the code that needs them and invisible to JSON.stringify,
// console.log and util.inspect, so a logged settings object never shows a key.
function sealed(publicFields, secrets) {
  const settings = { ...publicFields };
  for (const [name, value] of Object.entries(secrets)) {
    Object.defineProperty(settings, name, { value, enumerable: false });
  }
  Object.defineProperty(settings, "toJSON", { value: () => ({ ...publicFields }), enumerable: false });
  Object.defineProperty(settings, Symbol.for("nodejs.util.inspect.custom"), { value: () => `SocialSettings ${JSON.stringify(publicFields)}`, enumerable: false });
  return Object.freeze(settings);
}

const header = (headers, name) => {
  if (!headers) return "";
  if (typeof headers.get === "function") return text(headers.get(name));
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found === undefined ? "" : text(headers[found]);
};

// Compares digests, not the values, so the comparison takes the same time however much of a
// guess is right and works where node:crypto's timingSafeEqual does not exist.
async function sameSecret(left, right) {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([left, right].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= x[index] ^ y[index];
  return difference === 0;
}

// Who is asking. `allow` lists the roles the route accepts. Resolves to { role, actor } or throws a
// SocialScopeError: 404 when the feature is off (it does not exist), 401 for a missing or wrong
// key, 400 for a bad or misplaced actor, 403 for a role the route does not take.
export async function authorizeSocial(headers, settings, { allow = ["admin"] } = {}) {
  if (!settings || settings.enabled !== true) throw new SocialScopeError(404, "not-enabled", "Social publishing is not enabled.");
  const authorization = header(headers, "authorization");
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  const presented = match ? match[1] : "";
  const [admin, worker] = await Promise.all([sameSecret(presented, settings.adminKey), sameSecret(presented, settings.workerKey)]);
  const actorHeader = header(headers, ACTOR_HEADER);
  let identity;
  if (admin) {
    if (!validActor(actorHeader)) throw new SocialScopeError(400, "invalid-actor", "Name the signed-in Admin user.");
    identity = Object.freeze({ role: "admin", actor: actorHeader });
  } else if (worker) {
    if (actorHeader) throw new SocialScopeError(400, "invalid-actor", "The worker acts as itself.");
    identity = Object.freeze({ role: "worker", actor: WORKER_ACTOR });
  } else {
    throw new SocialScopeError(401, "unauthorized", "Not authorized.");
  }
  if (!allow.includes(identity.role)) throw new SocialScopeError(403, "forbidden", "This key cannot do that.");
  return identity;
}

// A request never names a site: not in the query, not anywhere in its JSON body.
export function refuseClientScope({ query, body } = {}) {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query || "");
  for (const name of params.keys()) {
    if (SITE_KEYS.has(name)) throw new SocialScopeError(400, "site-not-accepted", "A request cannot name a site.");
  }
  const visit = (value, depth) => {
    if (depth > MAX_SCOPE_DEPTH) throw new SocialScopeError(400, "invalid-request", "The request is nested too deeply.");
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    if (value && typeof value === "object") {
      for (const [name, inner] of Object.entries(value)) {
        if (SITE_KEYS.has(name)) throw new SocialScopeError(400, "site-not-accepted", "A request cannot name a site.");
        visit(inner, depth + 1);
      }
    }
  };
  visit(body, 0);
}

// PostgREST filters for one table, always led by this site. A filter on site_id from a caller is
// a programming error and is refused rather than silently replaced.
export function scopedQuery(settings, filters = {}) {
  for (const name of Object.keys(filters)) {
    if (SITE_KEYS.has(name)) throw new SocialScopeError(500, "scope-override", "Queries are scoped by the server.");
  }
  return new URLSearchParams({ site_id: `eq.${settings.siteId}`, ...filters });
}

// Every row read back must belong to this site; one that does not is never shown or acted on.
export function ensureOwned(settings, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    if (!row || row.site_id !== settings.siteId) throw new SocialScopeError(500, "other-site", "A record belongs to another site.");
  }
  return rows;
}
