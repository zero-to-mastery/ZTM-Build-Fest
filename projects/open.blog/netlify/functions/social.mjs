// The hosted social publishing function (epic #353, story #355; ADRs 0293, 0299). Off unless
// OPENBLOG_SOCIAL_ENABLED=true and every setting is valid: then every route answers 404 and
// nothing touches Supabase or a provider.
//
// Two kinds of caller. The Rust Admin presents OPENBLOG_SOCIAL_ADMIN_KEY and names the signed-in
// Admin user in X-OpenBlog-Actor (ADR 0293); everything under /connections and /accounts needs it.
// The author's browser, coming back from LinkedIn or Facebook, reaches only GET /callback/<provider>,
// which holds no key: the single-use `state` in its query is the proof, and it answers a fixed page.
//
// Scheduled announcements are served by the same function (netlify/lib/social-announcements.mjs).
// The function is bundled by Netlify and reached at /api/social/* (netlify.toml). Provider calls
// and Supabase both go through `fetchImpl`, so tests run against fakes.

import { SocialScopeError, authorizeSocial, refuseClientScope, socialSettings } from "../lib/social-scope.mjs";
import { SocialCredentialError } from "../lib/social-credentials.mjs";
import { SocialOAuthError, createConnector, OUTCOMES } from "../lib/social-oauth.mjs";
import { createAnnouncements } from "../lib/social-announcements.mjs";
import { createAccounts } from "../lib/social-accounts.mjs";
import { ProviderError, describeProvider, socialProviders, validProvider } from "../lib/social-providers.mjs";

const MAX_BODY_CHARS = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SECURITY = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const json = (statusCode, value) => ({ statusCode, headers: { ...SECURITY, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(value) });
const failure = (statusCode, code, message) => json(statusCode, { error: code, message });

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// The only page this function ever renders. Its text comes from OUTCOMES, never from the request.
function resultPage(ok, text) {
  const heading = ok ? "Authorized" : "Not connected";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${heading}</title><style>body{font:1rem/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem;background:#fff;color:#1a1a1a}main{max-width:32rem;margin:0 auto}h1{font-size:1.4rem}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head><body><main><h1>${heading}</h1><p>${escapeHtml(text)}</p><p>You can close this tab and return to Admin.</p></main></body></html>`;
  return {
    statusCode: ok ? 200 : 400,
    headers: { ...SECURITY, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
    body,
  };
}

const queryOf = (event) => {
  if (typeof event.rawQuery === "string") return new URLSearchParams(event.rawQuery);
  const params = new URLSearchParams();
  const multi = event.multiValueQueryStringParameters;
  if (multi && typeof multi === "object") {
    for (const [name, values] of Object.entries(multi)) for (const value of values || []) params.append(name, String(value));
    return params;
  }
  for (const [name, value] of Object.entries(event.queryStringParameters || {})) params.append(name, String(value));
  return params;
};

// The path below the function's own name, whichever of /api/social/... or
// /.netlify/functions/social/... the request used.
const segmentsOf = (event) => {
  const parts = String(event.path || "").split("/").filter(Boolean);
  const at = parts.indexOf("social");
  return at < 0 ? [] : parts.slice(at + 1);
};

function bodyOf(event) {
  const raw = event.isBase64Encoded ? Buffer.from(String(event.body || ""), "base64").toString("utf8") : String(event.body || "");
  if (raw.length > MAX_BODY_CHARS) throw new SocialScopeError(413, "too-large", "The request is too large.");
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SocialScopeError(400, "invalid-request", "The request is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialScopeError(400, "invalid-request", "The request must be a JSON object.");
  return value;
}

const only = (body, names) => {
  for (const key of Object.keys(body)) if (!names.includes(key)) throw new SocialScopeError(400, "invalid-request", "The request has a field this route does not take.");
};

export function createHandler({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), random } = {}) {
  return async (event) => {
    try {
      const settings = socialSettings(env);
      if (!settings.enabled) return failure(404, "not-enabled", "Social publishing is not enabled.");
      const method = String(event.httpMethod || "GET").toUpperCase();
      const segments = segmentsOf(event);
      const query = queryOf(event);
      const providers = socialProviders(env);
      const connector = createConnector({ settings, providers, fetchImpl, now, random });
      const accounts = createAccounts({ connector, settings, providers, fetchImpl, now });

      // The provider's redirect: no key, no JSON, a fixed page. Anything but GET /callback/<provider> is not here.
      if (segments[0] === "callback") {
        if (method !== "GET" || segments.length !== 2 || !validProvider(segments[1])) return failure(404, "not-found", "Not found.");
        const outcome = await connector.callback({ provider: segments[1], params: query });
        return resultPage(outcome.ok, outcome.text);
      }

      // Scheduled announcements (ADR 0309) have their own, larger body and their own storage; the
      // announcements module authorizes the same admin key and bounds its own body.
      if (segments[0] === "announcements" || segments[0] === "destinations") {
        const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
        const scheduled = createAnnouncements({ settings, fetchImpl, now });
        const result = await scheduled({ method, route: segments.join("/"), query, headers: event.headers || {}, body: raw });
        return json(result.status, result.body);
      }

      const identity = await authorizeSocial(event.headers, settings, { allow: ["admin"] });
      const body = method === "GET" ? {} : bodyOf(event);
      refuseClientScope({ query, body });
      const [head, id, action] = segments;

      if (method === "GET" && head === "status" && segments.length === 1) {
        return json(200, { enabled: true, providers: Object.values(providers).map(describeProvider), problems: [...providers.problems] });
      }
      if (head === "connections") {
        if (method === "GET" && segments.length === 1) return json(200, { connections: await connector.list() });
        if (method === "POST" && segments.length === 1) {
          only(body, ["provider"]);
          return json(201, await connector.start({ provider: body.provider, actor: identity.actor }));
        }
        if (method === "POST" && action === "cancel" && segments.length === 3 && UUID.test(id)) {
          only(body, []);
          return json(200, { connection: await connector.cancel(id) });
        }
        if (method === "POST" && action === "select" && segments.length === 3 && UUID.test(id)) {
          only(body, ["destination"]);
          return json(201, await connector.select({ id, destination: body.destination, actor: identity.actor }));
        }
      }
      if (head === "accounts") {
        if (method === "GET" && segments.length === 1) return json(200, { accounts: await accounts.list() });
        if (method === "POST" && action === "reconnect" && segments.length === 3 && UUID.test(id)) {
          only(body, []);
          return json(201, await accounts.reconnect(id, identity.actor));
        }
        if (method === "POST" && action === "disconnect" && segments.length === 3 && UUID.test(id)) {
          only(body, []);
          return json(200, { account: await accounts.disconnect(id) });
        }
      }
      return failure(404, "not-found", "Not found.");
    } catch (error) {
      if (error instanceof SocialScopeError || error instanceof SocialOAuthError || error instanceof SocialCredentialError) {
        return failure(error.status || (error.retryable ? 503 : 500), error.code, error.message);
      }
      if (error instanceof ProviderError) return failure(502, error.code, error.message);
      // Nothing is logged with the error: it could carry a request, and a request carries credentials.
      return failure(500, "internal", "Something went wrong.");
    }
  };
}

export const handler = createHandler();
export { OUTCOMES };
