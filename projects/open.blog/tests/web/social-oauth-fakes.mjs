// Fakes for the social OAuth tests: an in-memory PostgREST and a scripted provider. No test that
// uses them can reach a real network.
import { socialSettings } from "../../netlify/lib/social-scope.mjs";

export const b64 = (byte) => Buffer.alloc(32, byte).toString("base64");
export const SITE = "lantern-studios";
export const ADMIN_KEY = "adm_".padEnd(48, "a1");
export const WORKER_KEY = "wrk_".padEnd(48, "b2");
export const SUPABASE_KEY = "sb_secret_".padEnd(48, "c3");
export const LINKEDIN_SECRET = "li-client-secret-0001";
export const FACEBOOK_SECRET = "fb-client-secret-0002";
export const CALLBACK_BASE = "https://blog.example.com/api/social";

export const env = (overrides = {}) => ({
  OPENBLOG_SOCIAL_ENABLED: "true",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: SUPABASE_KEY,
  OPENBLOG_SITE_ID: SITE,
  OPENBLOG_SOCIAL_ADMIN_KEY: ADMIN_KEY,
  OPENBLOG_SOCIAL_WORKER_KEY: WORKER_KEY,
  OPENBLOG_SOCIAL_TOKEN_KEYS: `k1:${b64(1)}`,
  OPENBLOG_SOCIAL_CALLBACK_BASE: CALLBACK_BASE,
  OPENBLOG_SOCIAL_LINKEDIN_CLIENT_ID: "li-client-id",
  OPENBLOG_SOCIAL_LINKEDIN_CLIENT_SECRET: LINKEDIN_SECRET,
  OPENBLOG_SOCIAL_FACEBOOK_CLIENT_ID: "fb-client-id",
  OPENBLOG_SOCIAL_FACEBOOK_CLIENT_SECRET: FACEBOOK_SECRET,
  ...overrides,
});

export const settingsFor = (overrides) => socialSettings(env(overrides));

const TABLES = ["openblog_social_accounts", "openblog_social_connections", "openblog_social_credentials"];

function cellMatches(row, name, expression) {
  const dot = expression.indexOf(".");
  const op = expression.slice(0, dot);
  const value = expression.slice(dot + 1);
  const cell = row[name];
  switch (op) {
    case "eq": return String(cell) === value;
    case "neq": return String(cell) !== value;
    case "is": return value === "null" ? cell == null : cell != null;
    case "lt": return cell != null && Date.parse(cell) < Date.parse(value);
    case "gt": return cell != null && Date.parse(cell) > Date.parse(value);
    case "in": return value.slice(1, -1).split(",").includes(String(cell));
    default: throw new Error(`unsupported filter ${expression}`);
  }
}

// In-memory PostgREST for the tables the social code touches. Every call is recorded.
export function fakeSupabase({ accounts = [] } = {}) {
  const tables = Object.fromEntries(TABLES.map((name) => [name, []]));
  tables.openblog_social_accounts.push(...accounts);
  const calls = [];
  const matches = (row, params) => {
    for (const [name, expression] of params) {
      if (["select", "order", "limit"].includes(name)) continue;
      if (name === "or") {
        const parts = expression.slice(1, -1).split(/,(?=\w+\.)/).map((part) => [part.slice(0, part.indexOf(".")), part.slice(part.indexOf(".") + 1)]);
        if (!parts.some(([field, rest]) => cellMatches(row, field, rest))) return false;
      } else if (!cellMatches(row, name, expression)) return false;
    }
    return true;
  };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split("/").pop();
    calls.push({ url: String(url), init });
    const rows = tables[table];
    const reply = (status, body) => {
      const copy = structuredClone(body);
      return { ok: status < 300, status, json: async () => copy, text: async () => JSON.stringify(copy) };
    };
    if (!rows) return reply(404, []);
    if (init.method === "GET") {
      let hit = rows.filter((row) => matches(row, parsed.searchParams));
      if (parsed.searchParams.get("order") === "created_at.desc") hit = [...hit].reverse();
      const limit = Number(parsed.searchParams.get("limit"));
      return reply(200, limit ? hit.slice(0, limit) : hit);
    }
    const payload = JSON.parse(init.body);
    if (init.method === "POST") {
      const row = { version: 1, id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
      if (table === "openblog_social_connections" && rows.some((other) => other.state_hash === row.state_hash)) return reply(409, []);
      if (table === "openblog_social_accounts" && payload.status !== "disconnected" && rows.some((other) => other.provider === row.provider && other.external_id === row.external_id && other.status !== "disconnected")) return reply(409, []);
      rows.push(row);
      return reply(201, [row]);
    }
    const hit = rows.filter((row) => matches(row, parsed.searchParams));
    for (const row of hit) Object.assign(row, payload);
    return reply(200, hit);
  };
  return { tables, calls, fetchImpl };
}

// A scripted provider plus the database behind one `fetch`. Provider handlers receive the parsed
// request and return { status, body }. Every provider request is recorded.
export function fakeWorld({ accounts = [], linkedin = {}, facebook = {}, fallback } = {}) {
  const db = fakeSupabase({ accounts });
  const provider = [];
  const handlers = { ...linkedin, ...facebook };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("https://project.supabase.co/")) return db.fetchImpl(url, init);
    const parsed = new URL(href);
    const record = {
      method: init.method || "GET",
      url: href,
      path: parsed.pathname,
      host: parsed.host,
      headers: Object.fromEntries(Object.entries(init.headers || {}).map(([name, value]) => [name.toLowerCase(), value])),
      form: typeof init.body === "string" && init.body && !init.body.startsWith("{") ? Object.fromEntries(new URLSearchParams(init.body)) : null,
      query: Object.fromEntries(parsed.searchParams),
    };
    provider.push(record);
    const key = `${record.method} ${parsed.host}${parsed.pathname}`;
    const handler = handlers[key] || fallback;
    if (!handler) return { ok: false, status: 599, text: async () => "unscripted", json: async () => ({}) };
    const result = typeof handler === "function" ? await handler(record) : handler;
    if (result instanceof Error) throw result;
    const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? {});
    return { ok: result.status < 300, status: result.status, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { db, provider, fetchImpl, handlers };
}

export const request = (method, path, { key = ADMIN_KEY, actor = "mikey", body, query = "", headers = {} } = {}) => ({
  httpMethod: method,
  path,
  rawQuery: query,
  headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(actor ? { "x-openblog-actor": actor } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Reads the state out of an authorization URL the way a provider would receive it.
export const authorization = (authorizeUrl) => {
  const url = new URL(authorizeUrl);
  return { url, params: url.searchParams, state: url.searchParams.get("state") };
};

export const everything = (value) => JSON.stringify(value);
