// Provider credentials of optional social publishing (epic #353, ADR 0295): envelope encryption,
// single-flight refresh, revocation, and the promise that no token reaches an error, a log line or
// anything Admin can see.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { ProviderTokenError, SocialCredentialError, createCredentialStore } from "../../netlify/lib/social-credentials.mjs";
import { SocialTokenError, openCredential, parseKeyring, redact, rewrapCredential, sealCredential } from "../../netlify/lib/social-tokens.mjs";
import { socialSettings } from "../../netlify/lib/social-scope.mjs";

const b64 = (byte) => Buffer.alloc(32, byte).toString("base64");
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACCESS = "AQX-access-token-value-0001";
const REFRESH = "AQX-refresh-token-value-0002";
const env = (overrides = {}) => ({
  OPENBLOG_SOCIAL_ENABLED: "true",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_".padEnd(48, "c3"),
  OPENBLOG_SITE_ID: "lantern-studios",
  OPENBLOG_SOCIAL_ADMIN_KEY: "adm_".padEnd(48, "a1"),
  OPENBLOG_SOCIAL_WORKER_KEY: "wrk_".padEnd(48, "b2"),
  OPENBLOG_SOCIAL_TOKEN_KEYS: `k1:${b64(1)}`,
  ...overrides,
});

// An in-memory PostgREST for the two tables the store touches: eq./neq./is./lt. filters, the `or`
// filter the refresh lease uses, POST and PATCH with return=representation.
function fakeSupabase() {
  const tables = { openblog_social_credentials: [], openblog_social_accounts: [{ id: ACCOUNT, site_id: "lantern-studios", status: "connected" }] };
  const calls = [];
  const match = (row, name, expr) => {
    const [op, ...rest] = expr.split(".");
    const value = rest.join(".");
    const cell = row[name];
    if (op === "eq") return String(cell) === value;
    if (op === "neq") return String(cell) !== value;
    if (op === "is") return value === "null" ? cell == null : cell != null;
    if (op === "lt") return cell != null && Date.parse(cell) < Date.parse(value);
    throw new Error(`filter ${expr}`);
  };
  const matches = (row, params) => {
    for (const [name, expr] of params) {
      if (name === "select") continue;
      if (name === "or") {
        const parts = expr.slice(1, -1).split(/,(?=\w+\.)/).map((part) => {
          const dot = part.indexOf(".");
          return [part.slice(0, dot), part.slice(dot + 1)];
        });
        if (!parts.some(([field, rest]) => match(row, field, rest))) return false;
      } else if (!match(row, name, expr)) return false;
    }
    return true;
  };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split("/").pop();
    calls.push({ url, init });
    const rows = tables[table];
    const reply = (status, body) => {
      const copy = structuredClone(body);
      return { ok: status < 300, status, json: async () => copy };
    };
    if (init.method === "GET") return reply(200, rows.filter((row) => matches(row, parsed.searchParams)));
    if (init.method === "POST") {
      const row = { version: 1, ...JSON.parse(init.body) };
      rows.push(row);
      return reply(201, [row]);
    }
    const hit = rows.filter((row) => matches(row, parsed.searchParams));
    for (const row of hit) Object.assign(row, JSON.parse(init.body));
    return reply(200, hit);
  };
  return { tables, calls, fetchImpl };
}

const setup = (envOverrides, start = Date.parse("2026-10-29T12:00:00Z")) => {
  const db = fakeSupabase();
  const clock = { t: start };
  const settings = socialSettings(env(envOverrides));
  const store = createCredentialStore({ settings, fetchImpl: db.fetchImpl, now: () => clock.t });
  return { db, clock, settings, store };
};
const saved = (store, extra = {}) => store.save(ACCOUNT, { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600, refreshExpiresIn: 86400 * 60, ...extra }, { scope: "w_member_social" });
const row = (db) => db.tables.openblog_social_credentials[0];
const HOUR = 3600 * 1000;

test("keyring: only well-formed 32-byte keys, ids once, first is active, errors never echo", () => {
  const ring = parseKeyring(`k2:${b64(2)}, k1:${b64(1)}`);
  assert.equal(ring.activeId, "k2");
  assert.ok(ring.has("k1"));
  assert.ok(!JSON.stringify(ring).includes(b64(2)) && !inspect(ring).includes(b64(2)));
  for (const bad of ["", undefined, "k1", "k1:", "k1:c2hvcnQ=", `k1:${b64(1)},k1:${b64(2)}`, `bad id:${b64(1)}`, `k1:${b64(1)}x`]) {
    assert.throws(() => parseKeyring(bad), (error) => error instanceof SocialTokenError && !String(error.message).includes(b64(1)), String(bad));
  }
});

test("a credential is ciphertext that opens only for its own site, account and key", async () => {
  const ring = parseKeyring(`k1:${b64(1)}`);
  const scope = { siteId: "lantern-studios", accountId: ACCOUNT };
  const { keyId, envelope } = await sealCredential(ring, scope, { accessToken: ACCESS, refreshToken: REFRESH });
  assert.equal(keyId, "k1");
  const stored = JSON.stringify(envelope);
  assert.ok(!stored.includes(ACCESS) && !stored.includes(REFRESH) && !stored.includes(b64(1)));
  assert.deepEqual(await openCredential(ring, scope, keyId, envelope), { accessToken: ACCESS, refreshToken: REFRESH });
  const again = await sealCredential(ring, scope, { accessToken: ACCESS });
  assert.notEqual(JSON.stringify(again.envelope.body), JSON.stringify(envelope.body), "fresh data key and iv every time");
  for (const wrong of [{ ...scope, siteId: "other-site" }, { ...scope, accountId: OTHER }]) {
    await assert.rejects(openCredential(ring, wrong, keyId, envelope), (error) => error.code === "decrypt-failed");
  }
  const flipped = structuredClone(envelope);
  flipped.body.data = (flipped.body.data[0] === "A" ? "B" : "A") + flipped.body.data.slice(1);
  await assert.rejects(openCredential(ring, scope, keyId, flipped), (error) => error instanceof SocialTokenError);
  await assert.rejects(openCredential(parseKeyring(`k1:${b64(9)}`), scope, keyId, envelope), (error) => error.code === "decrypt-failed");
  await assert.rejects(openCredential(parseKeyring(`k9:${b64(1)}`), scope, keyId, envelope), (error) => error.code === "unknown-key");
});

test("rotation re-wraps under the new active key and keeps the tokens unread", async () => {
  const old = parseKeyring(`k1:${b64(1)}`);
  const scope = { siteId: "lantern-studios", accountId: ACCOUNT };
  const sealed = await sealCredential(old, scope, { accessToken: ACCESS });
  const both = parseKeyring(`k2:${b64(2)},k1:${b64(1)}`);
  const moved = await rewrapCredential(both, scope, sealed.keyId, sealed.envelope);
  assert.equal(moved.keyId, "k2");
  assert.deepEqual(await openCredential(parseKeyring(`k2:${b64(2)}`), scope, "k2", moved.envelope), { accessToken: ACCESS });
});

test("saving stores only ciphertext, and Admin sees only status and dates", async () => {
  const { db, store } = setup();
  const view = await saved(store);
  assert.deepEqual(Object.keys(view).sort(), ["accessExpiresAt", "accountId", "lastRefreshedAt", "refreshExpiresAt", "scopes", "status"]);
  assert.equal(view.status, "active");
  const written = db.calls.map((call) => `${call.url} ${call.init.body ?? ""}`).join("\n");
  for (const secret of [ACCESS, REFRESH]) assert.ok(!written.includes(secret), "no plaintext token is sent to storage");
  assert.ok(!JSON.stringify(view).includes(ACCESS));
  assert.deepEqual(await store.describe(ACCOUNT), view);
  const again = await saved(store, { accessToken: "AQX-new-access-0003" });
  assert.equal(again.status, "active");
  assert.equal(row(db).version, 2, "reconnecting raises the version");
  assert.equal(await store.accessToken(ACCOUNT), "AQX-new-access-0003");
});

test("a valid token is returned without a refresh, an expiring one is refreshed and a rotated refresh token kept", async () => {
  const { db, clock, store } = setup();
  await saved(store);
  let calls = 0;
  const refresh = async (token) => {
    calls += 1;
    assert.equal(token, REFRESH);
    return { accessToken: "AQX-fresh-access-0004", refreshToken: "AQX-rotated-refresh-0005", expiresIn: 3600 };
  };
  assert.equal(await store.accessToken(ACCOUNT, { refresh }), ACCESS);
  assert.equal(calls, 0);
  clock.t += HOUR - 60 * 1000;
  assert.equal(await store.accessToken(ACCOUNT, { refresh }), "AQX-fresh-access-0004");
  assert.equal(calls, 1);
  assert.equal(row(db).refresh_lease_until, null);
  assert.equal(row(db).refresh_failures, 0);
  clock.t += HOUR - 60 * 1000;
  const second = async (token) => {
    assert.equal(token, "AQX-rotated-refresh-0005", "the rotated refresh token replaced the old one");
    return { accessToken: "AQX-fresh-access-0006", expiresIn: 3600 };
  };
  assert.equal(await store.accessToken(ACCOUNT, { refresh: second }), "AQX-fresh-access-0006");
  const sent = JSON.stringify(db.calls.map((call) => call.init.body));
  assert.ok(!sent.includes("AQX-fresh") && !sent.includes("AQX-rotated"));
});

test("two callers cannot refresh at once: the second sees the lease and then the fresh token", async () => {
  const { clock, store } = setup();
  await saved(store);
  clock.t += HOUR;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    await gate;
    return { accessToken: "AQX-fresh-access-0007", refreshToken: REFRESH, expiresIn: 3600 };
  };
  const first = store.accessToken(ACCOUNT, { refresh });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(store.accessToken(ACCOUNT, { refresh }), (error) => error instanceof SocialCredentialError && error.code === "refresh-in-progress" && error.retryable);
  release();
  assert.equal(await first, "AQX-fresh-access-0007");
  assert.equal(calls, 1);
  assert.equal(await store.accessToken(ACCOUNT, { refresh }), "AQX-fresh-access-0007");
});

test("a crashed refresh does not lock the account: the lease expires", async () => {
  const { clock, store } = setup();
  await saved(store);
  clock.t += HOUR;
  void store.accessToken(ACCOUNT, { refresh: () => new Promise(() => {}) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  clock.t += 61 * 1000;
  assert.equal(await store.accessToken(ACCOUNT, { refresh: async () => ({ accessToken: "AQX-fresh-access-0008", expiresIn: 3600 }) }), "AQX-fresh-access-0008");
});

test("a transient refresh failure is retryable and counted; a permanent one erases the tokens and asks to reconnect", async () => {
  const { db, clock, store } = setup();
  await saved(store);
  clock.t += HOUR;
  await assert.rejects(store.accessToken(ACCOUNT, { refresh: async () => { throw new ProviderTokenError(false); } }), (error) => error.code === "refresh-failed" && error.retryable);
  assert.equal(row(db).refresh_failures, 1);
  assert.equal(row(db).refresh_lease_until, null);
  assert.equal(row(db).status, "active");
  await assert.rejects(store.accessToken(ACCOUNT, { refresh: async () => { throw new ProviderTokenError(true); } }), (error) => error.code === "needs-reauth" && !error.retryable);
  assert.equal(row(db).status, "revoked");
  assert.equal(row(db).envelope, null);
  assert.equal(row(db).key_id, null);
  assert.equal(db.tables.openblog_social_accounts[0].status, "needs-reauth");
  await assert.rejects(store.accessToken(ACCOUNT), (error) => error.code === "needs-reauth");
});

test("accessToken without a refresh callback keeps a refreshable credential", async () => {
  const { db, clock, store } = setup();
  await saved(store);
  clock.t += HOUR;
  await assert.rejects(store.accessToken(ACCOUNT), (error) => error.code === "refresh-unavailable" && error.retryable);
  await assert.rejects(store.accessToken(ACCOUNT, { refresh: undefined }), (error) => error.code === "refresh-unavailable");
  assert.equal(row(db).status, "active");
  assert.ok(row(db).envelope);
  assert.equal(db.tables.openblog_social_accounts[0].status, "connected");
});

test("a reconnect that lands during a permanent refresh failure keeps the account connected", async () => {
  const { db, clock, store } = setup();
  await saved(store);
  clock.t += HOUR;
  const refresh = async () => {
    await store.save(ACCOUNT, { accessToken: "AQX-new-access-0010", refreshToken: "AQX-new-refresh-0011", expiresIn: 3600 });
    throw new ProviderTokenError(true);
  };
  await assert.rejects(store.accessToken(ACCOUNT, { refresh }), (error) => error.code === "conflict" && error.retryable);
  assert.equal(row(db).status, "active");
  assert.ok(row(db).envelope);
  assert.equal(db.tables.openblog_social_accounts[0].status, "connected");
});

test("a provider error that echoes a token never reaches the error", async () => {
  const { clock, store } = setup();
  await saved(store);
  clock.t += HOUR;
  const leaky = async () => {
    throw new Error(`failed with refresh_token=${REFRESH} Bearer ${ACCESS}`);
  };
  await assert.rejects(store.accessToken(ACCOUNT, { refresh: leaky }), (error) => {
    const shown = [error.message, error.stack, inspect(error)].join("\n");
    return error.code === "refresh-failed" && !shown.includes(REFRESH) && !shown.includes(ACCESS);
  });
});

test("a refresh that loses to a revoke drops the new tokens", async () => {
  const { db, clock, store } = setup();
  await saved(store);
  clock.t += HOUR;
  const refresh = async () => {
    await store.revoke(ACCOUNT);
    return { accessToken: "AQX-fresh-access-0009", expiresIn: 3600 };
  };
  await assert.rejects(store.accessToken(ACCOUNT, { refresh }), (error) => error.code === "conflict");
  assert.equal(row(db).envelope, null);
  assert.ok(!JSON.stringify(db.tables).includes("AQX-fresh"));
});

test("revoke tries the provider, then erases the tokens and disconnects, whatever the provider says", async () => {
  const { db, store } = setup();
  await saved(store);
  let seen;
  await store.revoke(ACCOUNT, {
    revokeAtProvider: async (secrets) => {
      seen = secrets;
      throw new Error(`down ${secrets.refreshToken}`);
    },
  });
  assert.deepEqual(seen, { accessToken: ACCESS, refreshToken: REFRESH });
  assert.equal(row(db).status, "revoked");
  assert.equal(row(db).envelope, null);
  assert.ok(row(db).revoked_at);
  assert.equal(db.tables.openblog_social_accounts[0].status, "disconnected");
  assert.ok(db.tables.openblog_social_accounts[0].disconnected_at);
  assert.deepEqual(await store.revoke(ACCOUNT), { status: "revoked" }, "idempotent");
  assert.equal((await store.describe(ACCOUNT)).status, "revoked");
});

test("the store is scoped to the site, takes only an account id and needs the feature on", async () => {
  const { db, store } = setup();
  await saved(store);
  assert.ok(db.calls.every((call) => call.init.method === "POST" || new URL(call.url).searchParams.get("site_id") === "eq.lantern-studios"));
  await assert.rejects(store.describe("not-a-uuid"), (error) => error.code === "invalid-account");
  assert.equal(await store.describe(OTHER), null);
  const stray = createCredentialStore({ settings: socialSettings(env()), fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ ...row(db), site_id: "other-site" }] }) });
  await assert.rejects(stray.describe(ACCOUNT), (error) => error.code === "other-site");
  assert.throws(() => createCredentialStore({ settings: socialSettings({}), fetchImpl: db.fetchImpl }), (error) => error.status === 404);
  assert.throws(() => createCredentialStore({ settings: socialSettings(env({ OPENBLOG_SOCIAL_TOKEN_KEYS: "" })), fetchImpl: db.fetchImpl }), (error) => error.status === 404);
});

test("storage failures are fixed messages that carry no response body or key", async () => {
  const settings = socialSettings(env());
  const failing = createCredentialStore({ settings, fetchImpl: async () => ({ ok: false, status: 500, json: async () => [{ detail: ACCESS }] }) });
  await assert.rejects(failing.describe(ACCOUNT), (error) => error.code === "storage-failed" && error.retryable && !error.message.includes(ACCESS) && !error.message.includes(settings.key));
  const down = createCredentialStore({
    settings,
    fetchImpl: async () => {
      throw new Error(`connect ${settings.key}`);
    },
  });
  await assert.rejects(down.describe(ACCOUNT), (error) => error.code === "storage-unavailable" && !inspect(error).includes(settings.key));
});

test("redact removes known secrets, bearer values and token fields", () => {
  const out = redact(`Bearer abc123def456 {"access_token":"zzzzzzzz","x":1} client_secret=hunter22 mine:${ACCESS}`, [ACCESS]);
  for (const secret of ["abc123def456", "zzzzzzzz", "hunter22", ACCESS]) assert.ok(!out.includes(secret), secret);
  assert.match(out, /\[redacted\]/);
});

test("the schema keeps tokens only as erasable ciphertext in a private table", () => {
  const sql = readFileSync(new URL("../../supabase/social.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
  assert.match(sql, /create table if not exists public\.openblog_social_credentials/);
  assert.match(sql, /alter table public\.openblog_social_credentials enable row level security/);
  assert.match(sql, /revoke all on public\.openblog_social_credentials from public, anon, authenticated/);
  assert.doesNotMatch(sql, /(access|refresh)_token/, "no plaintext token column");
  assert.match(sql, /\(status = 'revoked'\) = \(envelope is null and key_id is null and revoked_at is not null\)/);
  assert.match(sql, /foreign key \(account_id, site_id\) references public\.openblog_social_accounts \(id, site_id\)/);
});
