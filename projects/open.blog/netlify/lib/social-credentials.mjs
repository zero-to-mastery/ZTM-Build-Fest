// The lifecycle of a connected account's provider credentials (epic #353, ADR 0295): store them
// encrypted, hand an access token to server code that needs one, refresh it once and only once at a
// time, and revoke it for good. Server-only, behind the site scope of ADR 0293.
//
// Tokens never leave this module except as the return value of `accessToken`, which only the
// hosted function's delivery code calls. `describe` is what Admin may ever see: a status and
// dates. Every failure is a SocialCredentialError with a fixed message; nothing from a provider
// response, a request or a stored value is put in an error, so nothing here can reach a log.
//
// Storage is PostgREST over `fetchImpl` (the fake-fetch seam hosted engagement uses). Every write
// names the row's `version`, so two refreshes, or a refresh and a revoke, cannot both win.

import { SocialScopeError, scopedQuery } from "./social-scope.mjs";
import { SocialTokenError, openCredential, rewrapCredential, sealCredential } from "./social-tokens.mjs";

export const REFRESH_SKEW_MS = 5 * 60 * 1000;
export const REFRESH_LEASE_MS = 60 * 1000;
const TABLE = "openblog_social_credentials";
const ACCOUNTS = "openblog_social_accounts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SocialCredentialError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "SocialCredentialError";
    this.code = code;
    this.retryable = retryable;
  }
}

// A provider adapter's refresh/revoke throws this. `permanent` means the grant is gone (revoked,
// expired refresh token, invalid_grant), so the account needs the author to connect it again.
export class ProviderTokenError extends Error {
  constructor(permanent) {
    super(permanent ? "The provider rejected the credential." : "The provider could not be reached.");
    this.name = "ProviderTokenError";
    this.permanent = Boolean(permanent);
  }
}

const iso = (ms) => new Date(ms).toISOString();

export function createCredentialStore({ settings, keyring = settings?.tokenKeys, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (!settings || settings.enabled !== true || !keyring) throw new SocialScopeError(404, "not-enabled", "Social publishing is not enabled.");

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
      throw new SocialCredentialError("storage-unavailable", "The credential store could not be reached.", { retryable: true });
    }
    if (!response.ok) throw new SocialCredentialError("storage-failed", `The credential store refused the request (${Number(response.status) || 0}).`, { retryable: response.status >= 500 });
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  };

  const keyOf = (accountId) => {
    if (!UUID.test(String(accountId))) throw new SocialCredentialError("invalid-account", "That is not an account id.");
    return { siteId: settings.siteId, accountId };
  };

  const read = async (accountId) => {
    keyOf(accountId);
    const rows = await rest("GET", TABLE, scopedQuery(settings, { account_id: `eq.${accountId}`, select: "*" }).toString());
    if (!rows.length) return null;
    if (rows[0].site_id !== settings.siteId) throw new SocialScopeError(500, "other-site", "A record belongs to another site.");
    return rows[0];
  };

  // A conditional update: it applies only to the version the caller read, and says whether it did.
  const write = async (accountId, version, patch, extra = {}) => {
    const query = scopedQuery(settings, { account_id: `eq.${accountId}`, version: `eq.${version}`, ...extra }).toString();
    const rows = await rest("PATCH", TABLE, query, { ...patch, version: version + 1, updated_at: iso(now()) });
    return rows[0] || null;
  };

  const sealed = async (accountId, secrets) => {
    const { keyId, envelope } = await sealCredential(keyring, keyOf(accountId), secrets);
    return { key_id: keyId, envelope };
  };

  const expiries = (tokens) => ({
    access_expires_at: Number.isFinite(tokens.expiresIn) ? iso(now() + tokens.expiresIn * 1000) : null,
    refresh_expires_at: Number.isFinite(tokens.refreshExpiresIn) ? iso(now() + tokens.refreshExpiresIn * 1000) : null,
  });

  const bundle = (tokens) => {
    if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken) throw new SocialCredentialError("invalid-tokens", "The provider returned no access token.");
    const secrets = { accessToken: tokens.accessToken };
    if (typeof tokens.refreshToken === "string" && tokens.refreshToken) secrets.refreshToken = tokens.refreshToken;
    return secrets;
  };

  const markReauth = async (accountId, version) => {
    // Tokens that the provider no longer honours are erased, not kept: the author connects again.
    const erased = await write(accountId, version, { status: "revoked", key_id: null, envelope: null, refresh_lease_until: null, revoked_at: iso(now()) });
    // The write is conditional on the version read. If it lost (a reconnect landed), the new tokens
    // stand and the account must not be flagged.
    if (!erased) return false;
    await rest("PATCH", ACCOUNTS, scopedQuery(settings, { id: `eq.${accountId}`, status: "eq.connected" }).toString(), { status: "needs-reauth", updated_at: iso(now()) });
    return true;
  };

  const reauth = async (accountId, version) => {
    if (!(await markReauth(accountId, version))) throw new SocialCredentialError("conflict", "The credential changed; try again.", { retryable: true });
    throw new SocialCredentialError("needs-reauth", "This account must be connected again.");
  };

  return {
    // Stores (or replaces) an account's tokens, encrypted. The account row must already exist.
    async save(accountId, tokens, { scope } = {}) {
      const secrets = bundle(tokens);
      const fields = { ...(await sealed(accountId, secrets)), ...expiries(tokens), scopes: typeof scope === "string" ? scope.slice(0, 1000) : null, status: "active", refresh_lease_until: null, refresh_failures: 0, revoked_at: null, last_refreshed_at: iso(now()) };
      const existing = await read(accountId);
      if (!existing) {
        const rows = await rest("POST", TABLE, "", { account_id: accountId, site_id: settings.siteId, ...fields });
        return describe(rows[0]);
      }
      const row = await write(accountId, existing.version, fields);
      if (!row) throw new SocialCredentialError("conflict", "The credential changed; try again.", { retryable: true });
      return describe(row);
    },

    // What Admin may see. No token, no ciphertext.
    async describe(accountId) {
      const row = await read(accountId);
      return row ? describe(row) : null;
    },

    // An access token that is valid for at least the skew, refreshing first if it is not. Callers
    // pass `refresh(refreshToken)`, the provider adapter's call, so tests need no network.
    async accessToken(accountId, { refresh } = {}) {
      const scope = keyOf(accountId);
      for (let round = 0; round < 2; round += 1) {
        const row = await read(accountId);
        if (!row) throw new SocialCredentialError("no-credential", "This account has no credential.");
        if (row.status !== "active" || !row.envelope) throw new SocialCredentialError("needs-reauth", "This account must be connected again.");
        const secrets = await openCredential(keyring, scope, row.key_id, row.envelope);
        const expires = row.access_expires_at ? Date.parse(row.access_expires_at) : Infinity;
        if (expires - now() > REFRESH_SKEW_MS) return secrets.accessToken;
        const refreshable = Boolean(secrets.refreshToken) && !(row.refresh_expires_at && Date.parse(row.refresh_expires_at) <= now());
        if (!refreshable) {
          if (expires > now()) return secrets.accessToken;
          await reauth(accountId, row.version);
        }
        if (typeof refresh !== "function") {
          // A caller that cannot refresh must not destroy a grant that still can be.
          if (expires > now()) return secrets.accessToken;
          throw new SocialCredentialError("refresh-unavailable", "This access token needs a refresh and no refresh was supplied.", { retryable: true });
        }
        // Take the refresh lease. Only one caller gets it; the rest wait for the result.
        const leased = await write(accountId, row.version, { refresh_lease_until: iso(now() + REFRESH_LEASE_MS) }, { or: `(refresh_lease_until.is.null,refresh_lease_until.lt.${iso(now())})` });
        if (!leased) continue;
        let fresh;
        try {
          fresh = await refresh(secrets.refreshToken);
        } catch (error) {
          if (error instanceof ProviderTokenError && error.permanent) {
            await reauth(accountId, leased.version);
          }
          await write(accountId, leased.version, { refresh_lease_until: null, refresh_failures: (row.refresh_failures || 0) + 1 });
          throw new SocialCredentialError("refresh-failed", "The access token could not be refreshed; it will be tried again.", { retryable: true });
        }
        const next = bundle({ ...fresh, refreshToken: fresh.refreshToken || secrets.refreshToken });
        const stored = await write(accountId, leased.version, { ...(await sealed(accountId, next)), ...expiries(fresh), refresh_lease_until: null, refresh_failures: 0, last_refreshed_at: iso(now()) });
        // Revoked or reconnected while the provider call ran: the new tokens are dropped.
        if (!stored) throw new SocialCredentialError("conflict", "The credential changed during a refresh.", { retryable: true });
        return next.accessToken;
      }
      throw new SocialCredentialError("refresh-in-progress", "Another refresh is running; try again shortly.", { retryable: true });
    },

    // Revokes at the provider (best effort, so an unreachable provider never keeps a token here),
    // then erases the stored tokens and disconnects the account. Idempotent.
    async revoke(accountId, { revokeAtProvider } = {}) {
      const scope = keyOf(accountId);
      const row = await read(accountId);
      if (row && row.status === "active" && row.envelope) {
        if (typeof revokeAtProvider === "function") {
          try {
            const secrets = await openCredential(keyring, scope, row.key_id, row.envelope);
            await revokeAtProvider(secrets);
          } catch {
            // Erasing here is what the author asked for; the provider-side failure is not reported
            // with detail because it could echo a token.
          }
        }
        const done = await write(accountId, row.version, { status: "revoked", key_id: null, envelope: null, refresh_lease_until: null, revoked_at: iso(now()) });
        if (!done) throw new SocialCredentialError("conflict", "The credential changed; try again.", { retryable: true });
      }
      await rest("PATCH", ACCOUNTS, scopedQuery(settings, { id: `eq.${accountId}`, status: "neq.disconnected" }).toString(), { status: "disconnected", disconnected_at: iso(now()), updated_at: iso(now()) });
      return { status: "revoked" };
    },

    // Key rotation: re-wrap one account's data key under the active key. Tokens stay unread.
    async rotate(accountId) {
      const scope = keyOf(accountId);
      const row = await read(accountId);
      if (!row || row.status !== "active" || !row.envelope || row.key_id === keyring.activeId) return false;
      const { keyId, envelope } = await rewrapCredential(keyring, scope, row.key_id, row.envelope);
      const done = await write(accountId, row.version, { key_id: keyId, envelope });
      return Boolean(done);
    },
  };
}

// The only shape of a credential that ever leaves the server.
function describe(row) {
  return Object.freeze({
    accountId: row.account_id,
    status: row.status,
    accessExpiresAt: row.access_expires_at || null,
    refreshExpiresAt: row.refresh_expires_at || null,
    scopes: row.scopes || null,
    lastRefreshedAt: row.last_refreshed_at || null,
  });
}

export { SocialTokenError };
