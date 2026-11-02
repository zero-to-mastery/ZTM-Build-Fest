// Provider adapters for optional social publishing (epic #353, story #355, ADR 0299): the
// LinkedIn and Facebook settings, the authorization URL, the code exchange and the scope check.
// Server-only. Every provider call goes through an injected `fetchImpl`, so tests run against fakes
// and no real network call is ever made by this repository's tests.
//
// Nothing here is guessed from memory at run time. The API versions and scopes are settings, with
// defaults that docs/social-publishing.md tells the deployer to verify at setup. A provider reply
// is read for the few fields named below; its text is never put in an error, so a token, a code or
// a client secret cannot reach a log, and nothing a provider says can inject text into a page.

import { ProviderTokenError } from "./social-credentials.mjs";

export class ProviderError extends Error {
  // `code` is a fixed slug; `status` is the provider's HTTP status when there was one.
  constructor(code, { status = 0, retryable = false } = {}) {
    super(MESSAGES[code] || MESSAGES["provider-failed"]);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const MESSAGES = {
  "provider-unreachable": "The provider could not be reached.",
  "provider-rejected": "The provider refused the request.",
  "provider-invalid": "The provider sent a reply that could not be read.",
  "code-rejected": "The provider did not accept the authorization code.",
  "provider-failed": "The provider request failed.",
};

export const PROVIDERS = Object.freeze(["linkedin", "facebook"]);
export const validProvider = (value) => typeof value === "string" && PROVIDERS.includes(value);

// The provider endpoints and defaults. Versions and scopes are overridable; hosts are not, so a
// misconfigured environment cannot send a client secret anywhere but the provider.
const DEFINITIONS = Object.freeze({
  linkedin: Object.freeze({
    label: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    revokeUrl: "https://www.linkedin.com/oauth/v2/revoke",
    apiBase: "https://api.linkedin.com",
    versionPattern: /^\d{6}$/,
    defaultVersion: "202510",
    // The member scopes every connection needs. `openid profile` name the member; `w_member_social` posts as them.
    baseScopes: Object.freeze(["openid", "profile", "w_member_social"]),
    // Only requested when OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS=true: they need the Community
    // Management API, which LinkedIn approves per app.
    organizationScopes: Object.freeze(["r_organization_admin", "w_organization_social"]),
    optionalScopes: Object.freeze(["r_organization_admin", "w_organization_social"]),
    scopeSeparator: " ",
  }),
  facebook: Object.freeze({
    label: "Facebook",
    authorizeUrl: "https://www.facebook.com/{version}/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/{version}/oauth/access_token",
    apiBase: "https://graph.facebook.com/{version}",
    versionPattern: /^v\d{2}\.\d$/,
    defaultVersion: "v23.0",
    baseScopes: Object.freeze(["pages_show_list", "pages_manage_posts"]),
    organizationScopes: Object.freeze([]),
    // Reading engagement is nice to have; posting is not possible without the first two.
    optionalScopes: Object.freeze(["pages_read_engagement"]),
    extraScopes: Object.freeze(["pages_read_engagement"]),
    scopeSeparator: ",",
  }),
});

export const providerLabel = (provider) => DEFINITIONS[provider]?.label || "Provider";
export const providerDefinition = (provider) => DEFINITIONS[provider];

const text = (value) => String(value ?? "").trim();
const SCOPE = /^[A-Za-z0-9_.:-]{1,80}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,200}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{8,300}$/;

export function parseScopes(value) {
  const list = text(value).split(/[\s,]+/).filter(Boolean);
  if (!list.length || list.length > 20 || list.some((scope) => !SCOPE.test(scope))) return null;
  return [...new Set(list)];
}

// A callback base is the https URL the hosted function is reachable at, such as
// https://blog.example.com/api/social. No credentials, query or fragment; the exact callback for a
// provider is `${base}/callback/${provider}` and is the only redirect URI this code ever sends.
export function callbackBase(value) {
  try {
    const url = new URL(text(value));
    const clean = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.hostname.endsWith(".") && url.href.length <= 400;
    if (!clean) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

// The configured providers. A provider with no client id is simply not offered. One with a client
// id but something wrong is also not offered, and `problems` names the settings (never values).
export function socialProviders(env = {}) {
  const base = callbackBase(env.OPENBLOG_SOCIAL_CALLBACK_BASE);
  const problems = [];
  const providers = {};
  for (const provider of PROVIDERS) {
    const upper = provider.toUpperCase();
    const definition = DEFINITIONS[provider];
    const name = (suffix) => `OPENBLOG_SOCIAL_${upper}_${suffix}`;
    const clientId = text(env[name("CLIENT_ID")]);
    const clientSecret = text(env[name("CLIENT_SECRET")]);
    if (!clientId && !clientSecret) continue;
    const bad = [];
    if (!CLIENT_ID.test(clientId)) bad.push(name("CLIENT_ID"));
    if (!CLIENT_SECRET.test(clientSecret)) bad.push(name("CLIENT_SECRET"));
    if (!base) bad.push("OPENBLOG_SOCIAL_CALLBACK_BASE");
    const version = text(env[name("API_VERSION")]) || definition.defaultVersion;
    if (!definition.versionPattern.test(version)) bad.push(name("API_VERSION"));
    const organizations = provider === "linkedin" && text(env[name("ORGANIZATIONS")]) === "true";
    let scopes = [...definition.baseScopes, ...(organizations ? definition.organizationScopes : []), ...(definition.extraScopes || [])];
    if (text(env[name("SCOPES")])) {
      scopes = parseScopes(env[name("SCOPES")]);
      if (!scopes) bad.push(name("SCOPES"));
    }
    const pkceSetting = text(env[name("PKCE")]);
    if (pkceSetting && !["true", "false"].includes(pkceSetting)) bad.push(name("PKCE"));
    if (bad.length) {
      problems.push(...bad);
      continue;
    }
    const resolve = (template) => template.replace("{version}", version);
    const secretFields = { clientSecret };
    const publicFields = {
      provider,
      label: definition.label,
      clientId,
      redirectUri: `${base}/callback/${provider}`,
      version,
      scopes: Object.freeze(scopes),
      requiredScopes: Object.freeze(scopes.filter((scope) => !definition.optionalScopes.includes(scope))),
      organizations,
      // PKCE is sent only where the deployer has confirmed the provider app supports it.
      pkce: pkceSetting === "true",
      authorizeUrl: resolve(definition.authorizeUrl),
      tokenUrl: resolve(definition.tokenUrl),
      revokeUrl: definition.revokeUrl || null,
      apiBase: resolve(definition.apiBase),
    };
    providers[provider] = hideSecrets(publicFields, secretFields);
  }
  Object.defineProperty(providers, "problems", { value: Object.freeze([...new Set(problems)]), enumerable: false });
  return Object.freeze(providers);
}

function hideSecrets(publicFields, secrets) {
  const settings = { ...publicFields };
  for (const [name, value] of Object.entries(secrets)) Object.defineProperty(settings, name, { value, enumerable: false });
  Object.defineProperty(settings, "toJSON", { value: () => ({ ...publicFields }), enumerable: false });
  Object.defineProperty(settings, Symbol.for("nodejs.util.inspect.custom"), { value: () => `SocialProvider ${JSON.stringify(publicFields)}`, enumerable: false });
  return Object.freeze(settings);
}

// What Admin may be told about a provider's setup: nothing secret, the exact redirect to register.
export function describeProvider(settings) {
  return Object.freeze({
    provider: settings.provider,
    label: settings.label,
    redirectUri: settings.redirectUri,
    version: settings.version,
    scopes: [...settings.scopes],
    requiredScopes: [...settings.requiredScopes],
    organizations: settings.organizations,
    pkce: settings.pkce,
  });
}

const encoder = new TextEncoder();
export const base64url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const randomToken = (random = (n) => crypto.getRandomValues(new Uint8Array(n))) => base64url(random(32));
export const sha256Hex = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const pkceChallenge = async (verifier) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));

// The URL the author's browser is sent to. Built only from settings and fixed fields; `state` and
// the PKCE challenge are the only per-attempt values, and both are server-made.
export function authorizationUrl(settings, { state, challenge, reauthorize = false }) {
  const url = new URL(settings.authorizeUrl);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", settings.clientId);
  params.set("redirect_uri", settings.redirectUri);
  params.set("state", state);
  params.set("scope", settings.scopes.join(DEFINITIONS[settings.provider].scopeSeparator));
  if (challenge) {
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
  }
  // Facebook remembers a declined permission and does not ask again unless told to.
  if (settings.provider === "facebook" && reauthorize) params.set("auth_type", "rerequest");
  return url.toString();
}

const MAX_REPLY_CHARS = 512 * 1024;
const TIMEOUT_MS = 10_000;

// One provider call. Network failure, a non-2xx status and an unreadable body are three fixed
// errors; the reply is parsed but never quoted.
export async function providerJson(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("provider-unreachable", { retryable: true });
  }
  const status = Number(response.status) || 0;
  let body = null;
  try {
    const raw = await response.text();
    if (raw.length > MAX_REPLY_CHARS) throw new Error("large");
    body = raw ? JSON.parse(raw) : null;
  } catch {
    if (response.ok) throw new ProviderError("provider-invalid", { status });
  }
  if (!response.ok) throw new ProviderError(status === 400 || status === 401 ? "provider-rejected" : "provider-failed", { status, retryable: status >= 500 || status === 429 });
  if (!body || typeof body !== "object") throw new ProviderError("provider-invalid", { status });
  return body;
}

const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields).toString() });

const seconds = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : undefined);

export const splitScopes = (value) => [...new Set(text(value).split(/[\s,]+/).filter(Boolean))];

// Exchanges the one-time code for tokens and returns the scopes the author actually granted.
// Client credentials travel in the POST body, never in a URL, so a proxy or access log cannot keep them.
export async function exchangeCode(settings, { code, verifier }, fetchImpl) {
  const fields = { grant_type: "authorization_code", code, redirect_uri: settings.redirectUri, client_id: settings.clientId, client_secret: settings.clientSecret };
  if (verifier) fields.code_verifier = verifier;
  if (settings.provider === "linkedin") {
    let reply;
    try {
      reply = await providerJson(fetchImpl, settings.tokenUrl, form(fields));
    } catch (error) {
      throw error instanceof ProviderError && error.code === "provider-rejected" ? new ProviderError("code-rejected", { status: error.status }) : error;
    }
    if (typeof reply.access_token !== "string" || !reply.access_token) throw new ProviderError("provider-invalid");
    return {
      accessToken: reply.access_token,
      refreshToken: typeof reply.refresh_token === "string" && reply.refresh_token ? reply.refresh_token : undefined,
      expiresIn: seconds(reply.expires_in),
      refreshExpiresIn: seconds(reply.refresh_token_expires_in),
      granted: splitScopes(reply.scope),
    };
  }
  // Facebook: a short-lived user token, exchanged for a long-lived one, whose Page tokens do not expire.
  let short;
  try {
    short = await providerJson(fetchImpl, settings.tokenUrl, form(fields));
  } catch (error) {
    throw error instanceof ProviderError && error.code === "provider-rejected" ? new ProviderError("code-rejected", { status: error.status }) : error;
  }
  if (typeof short.access_token !== "string" || !short.access_token) throw new ProviderError("provider-invalid");
  const long = await providerJson(fetchImpl, settings.tokenUrl, form({ grant_type: "fb_exchange_token", client_id: settings.clientId, client_secret: settings.clientSecret, fb_exchange_token: short.access_token }));
  if (typeof long.access_token !== "string" || !long.access_token) throw new ProviderError("provider-invalid");
  const permissions = await providerJson(fetchImpl, `${settings.apiBase}/me/permissions`, { headers: { authorization: `Bearer ${long.access_token}`, accept: "application/json" } });
  const granted = (Array.isArray(permissions.data) ? permissions.data : []).filter((entry) => entry && entry.status === "granted" && typeof entry.permission === "string").map((entry) => entry.permission);
  return { accessToken: long.access_token, expiresIn: seconds(long.expires_in), granted: [...new Set(granted)] };
}

// Requested scopes the provider did not grant, split into those a connection cannot work without
// and those that only narrow what it can reach.
export function checkScopes(settings, granted) {
  const have = new Set(granted);
  return {
    missingRequired: settings.requiredScopes.filter((scope) => !have.has(scope)),
    missingOptional: settings.scopes.filter((scope) => !settings.requiredScopes.includes(scope) && !have.has(scope)),
  };
}

// Best-effort revocation of a LinkedIn grant at LinkedIn. Facebook has none to offer a single Page:
// a Page token cannot withdraw the user's grant, and withdrawing it would cut off every other Page
// that shares it, so the author removes the app in Facebook's settings (docs/social-publishing.md).
// Failure is a boolean, never detail.
export async function revokeAtProvider(settings, secrets, fetchImpl) {
  if (settings.provider !== "linkedin" || !settings.revokeUrl) return false;
  try {
    const response = await fetchImpl(settings.revokeUrl, { ...form({ client_id: settings.clientId, client_secret: settings.clientSecret, token: secrets.refreshToken || secrets.accessToken }), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return Boolean(response.ok);
  } catch {
    return false;
  }
}

// The LinkedIn refresh grant, in the shape createCredentialStore's `refresh` expects.
export function refreshWith(settings, fetchImpl) {
  return async (refreshToken) => {
    let reply;
    try {
      reply = await providerJson(fetchImpl, settings.tokenUrl, form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: settings.clientId, client_secret: settings.clientSecret }));
    } catch (error) {
      throw new ProviderTokenError(error instanceof ProviderError && error.code === "provider-rejected");
    }
    if (typeof reply.access_token !== "string" || !reply.access_token) throw new ProviderTokenError(false);
    return {
      accessToken: reply.access_token,
      refreshToken: typeof reply.refresh_token === "string" && reply.refresh_token ? reply.refresh_token : undefined,
      expiresIn: seconds(reply.expires_in),
      refreshExpiresIn: seconds(reply.refresh_token_expires_in),
    };
  };
}
