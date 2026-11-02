// The OAuth handshake of optional social publishing (epic #353, story #355, ADR 0299): state,
// PKCE, exact callbacks, verified scopes, single use, and the promise that no code, token or
// secret reaches a response, a page or a stored column in the clear.
import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../../netlify/functions/social.mjs";
import { socialProviders, callbackBase, authorizationUrl, pkceChallenge } from "../../netlify/lib/social-providers.mjs";
import { ADMIN_KEY, CALLBACK_BASE, FACEBOOK_SECRET, LINKEDIN_SECRET, SUPABASE_KEY, WORKER_KEY, authorization, env, everything, fakeWorld, request } from "./social-oauth-fakes.mjs";

const ACCESS = "AQX-access-token-value-0001";
const REFRESH = "AQX-refresh-token-value-0002";
const CODE = "authcode-from-linkedin-0003";
const NOW = Date.parse("2026-10-29T12:00:00Z");

const linkedinToken = (over = {}) => ({ status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 5184000, refresh_token_expires_in: 31536000, scope: "openid,profile,w_member_social", ...over } });
const world = (extra = {}) =>
  fakeWorld({
    linkedin: { "POST www.linkedin.com/oauth/v2/accessToken": linkedinToken(), "POST www.linkedin.com/oauth/v2/revoke": { status: 200, body: {} }, "GET api.linkedin.com/v2/userinfo": { status: 200, body: { sub: "abc123", name: "Ada" } } },
    fallback: { status: 404, body: {} },
    ...extra,
  });
const make = (overrides = {}, worldOptions = {}) => {
  const w = world(worldOptions);
  // Discovery (ADR 0300) asks the provider where the grant can post; these tests are about the handshake.
  w.handlers["GET api.linkedin.com/v2/userinfo"] ||= { status: 200, body: { sub: "abc123", name: "Ada" } };
  w.handlers["GET graph.facebook.com/v23.0/me/accounts"] ||= { status: 200, body: { data: [{ id: "111", name: "Page", tasks: ["CREATE_CONTENT"], access_token: "EAApage-token-0006" }] } };
  const clock = { t: NOW };
  const handler = createHandler({ env: env(overrides), fetchImpl: w.fetchImpl, now: () => clock.t });
  return { w, clock, handler };
};
const start = async (handler, provider = "linkedin", options = {}) => {
  const response = await handler(request("POST", "/api/social/connections", { body: { provider }, ...options }));
  return { response, body: JSON.parse(response.body) };
};
const callback = (handler, provider, query) => handler({ httpMethod: "GET", path: `/api/social/callback/${provider}`, rawQuery: query, headers: {} });
const connections = (w) => w.db.tables.openblog_social_connections;
const db = (w) => JSON.stringify(w.db.tables);

test("off unless enabled: every route, including the callback, answers 404 and touches nothing", async () => {
  for (const overrides of [{ OPENBLOG_SOCIAL_ENABLED: "yes" }, { OPENBLOG_SOCIAL_ENABLED: undefined }, { OPENBLOG_SOCIAL_TOKEN_KEYS: "nope" }]) {
    const { w, handler } = make(overrides);
    for (const [method, path] of [["POST", "/api/social/connections"], ["GET", "/api/social/status"], ["GET", "/api/social/callback/linkedin"]]) {
      const response = await handler(request(method, path, { body: method === "POST" ? { provider: "linkedin" } : undefined }));
      assert.equal(response.statusCode, 404, `${method} ${path}`);
    }
    assert.equal(w.db.calls.length + w.provider.length, 0);
  }
});

test("provider settings: nothing is offered without a client id; wrong values name the setting, not the value", () => {
  assert.deepEqual(Object.keys(socialProviders({})), []);
  const providers = socialProviders(env({ OPENBLOG_SOCIAL_FACEBOOK_CLIENT_ID: undefined, OPENBLOG_SOCIAL_FACEBOOK_CLIENT_SECRET: undefined }));
  assert.deepEqual(Object.keys(providers), ["linkedin"]);
  assert.equal(providers.linkedin.redirectUri, `${CALLBACK_BASE}/callback/linkedin`);
  for (const [override, name] of [
    [{ OPENBLOG_SOCIAL_CALLBACK_BASE: "http://blog.example.com/api/social" }, "OPENBLOG_SOCIAL_CALLBACK_BASE"],
    [{ OPENBLOG_SOCIAL_CALLBACK_BASE: "https://user:pw@blog.example.com/api" }, "OPENBLOG_SOCIAL_CALLBACK_BASE"],
    [{ OPENBLOG_SOCIAL_CALLBACK_BASE: "https://blog.example.com/api?x=1" }, "OPENBLOG_SOCIAL_CALLBACK_BASE"],
    [{ OPENBLOG_SOCIAL_LINKEDIN_API_VERSION: "latest" }, "OPENBLOG_SOCIAL_LINKEDIN_API_VERSION"],
    [{ OPENBLOG_SOCIAL_LINKEDIN_SCOPES: "w_member_social bad scope!" }, "OPENBLOG_SOCIAL_LINKEDIN_SCOPES"],
    [{ OPENBLOG_SOCIAL_LINKEDIN_CLIENT_SECRET: "short" }, "OPENBLOG_SOCIAL_LINKEDIN_CLIENT_SECRET"],
    [{ OPENBLOG_SOCIAL_LINKEDIN_PKCE: "maybe" }, "OPENBLOG_SOCIAL_LINKEDIN_PKCE"],
  ]) {
    const bad = socialProviders(env(override));
    assert.ok(bad.problems.includes(name), name);
    assert.equal(bad.linkedin, undefined);
    assert.ok(!everything(bad.problems).includes("pw@"));
  }
  assert.equal(callbackBase("https://blog.example.com/api/social/"), "https://blog.example.com/api/social");
  const hidden = providers.linkedin;
  assert.ok(!JSON.stringify(hidden).includes(LINKEDIN_SECRET));
});

test("start: only the Admin key may begin, a request cannot name a site or a redirect, and the URL is the exact one registered", async () => {
  const { w, handler } = make();
  for (const [options, status] of [[{ key: null }, 401], [{ key: "wrong".padEnd(40, "x") }, 401], [{ key: WORKER_KEY, actor: null }, 403], [{ actor: null }, 400]]) {
    assert.equal((await start(handler, "linkedin", options)).response.statusCode, status);
  }
  assert.equal(connections(w).length, 0);
  assert.equal((await handler(request("POST", "/api/social/connections", { body: { provider: "linkedin", siteId: "other" } }))).statusCode, 400);
  assert.equal((await handler(request("POST", "/api/social/connections", { body: { provider: "linkedin", redirect_uri: "https://evil.example/cb" } }))).statusCode, 400);
  assert.equal((await handler(request("POST", "/api/social/connections", { body: { provider: "myspace" } }))).statusCode, 409);
  assert.equal((await handler(request("POST", "/api/social/connections", { body: {} }))).statusCode, 409);
  const { response, body } = await start(handler);
  assert.equal(response.statusCode, 201);
  const { url, params, state } = authorization(body.authorizeUrl);
  assert.equal(`${url.origin}${url.pathname}`, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(params.get("redirect_uri"), `${CALLBACK_BASE}/callback/linkedin`);
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("client_id"), "li-client-id");
  assert.equal(params.get("scope"), "openid profile w_member_social");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(params.get("code_challenge"), null, "PKCE is sent only where the deployer turned it on");
  assert.ok(!body.authorizeUrl.includes(LINKEDIN_SECRET));
  // Only a hash of the state is stored, bound to this site and the Admin user.
  const row = connections(w)[0];
  assert.equal(row.created_by, "mikey");
  assert.equal(row.site_id, "lantern-studios");
  assert.match(row.state_hash, /^[0-9a-f]{64}$/);
  assert.ok(!db(w).includes(state));
  assert.deepEqual(Object.keys(body.connection).sort(), ["createdAt", "createdBy", "destinations", "errorCode", "expiresAt", "grantedScopes", "id", "message", "notes", "provider", "reauthAccountId", "requestedScopes", "status"]);
});

test("PKCE: the challenge is S256 of a verifier that is sealed at rest and sent only in the exchange", async () => {
  const { w, handler } = make({ OPENBLOG_SOCIAL_LINKEDIN_PKCE: "true" });
  const { body } = await start(handler);
  const { params, state } = authorization(body.authorizeUrl);
  assert.equal(params.get("code_challenge_method"), "S256");
  const row = connections(w)[0];
  assert.equal(row.pkce, true);
  assert.ok(row.envelope && row.key_id === "k1", "the verifier is sealed like a credential");
  const result = await callback(handler, "linkedin", `code=${CODE}&state=${state}`);
  assert.equal(result.statusCode, 200);
  const exchange = w.provider.find((call) => call.path === "/oauth/v2/accessToken");
  assert.equal(await pkceChallenge(exchange.form.code_verifier), params.get("code_challenge"));
  assert.ok(!db(w).includes(exchange.form.code_verifier), "the verifier is never stored in the clear");
});

test("callback happy path: exact redirect, secret in the body only, scopes read from the grant, tokens sealed, a fixed page", async () => {
  const { w, handler } = make();
  const { body } = await start(handler);
  const { state } = authorization(body.authorizeUrl);
  // Extra and hostile parameters change nothing: redirect_uri and scope come from settings.
  const result = await callback(handler, "linkedin", `code=${CODE}&state=${state}&redirect_uri=https%3A%2F%2Fevil.example&scope=anything`);
  assert.equal(result.statusCode, 200);
  assert.match(result.headers["content-type"], /^text\/html/);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["referrer-policy"], "no-referrer");
  assert.match(result.headers["content-security-policy"], /default-src 'none'/);
  for (const secret of [CODE, state, ACCESS, REFRESH, LINKEDIN_SECRET]) assert.ok(!result.body.includes(secret), "the page repeats nothing");
  const exchange = w.provider.find((call) => call.path === "/oauth/v2/accessToken");
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.form.redirect_uri, `${CALLBACK_BASE}/callback/linkedin`);
  assert.equal(exchange.form.code, CODE);
  assert.equal(exchange.form.client_secret, LINKEDIN_SECRET);
  assert.ok(!exchange.url.includes(LINKEDIN_SECRET) && !exchange.url.includes(CODE), "credentials are never in a URL");
  const row = connections(w)[0];
  assert.equal(row.status, "authorized");
  assert.equal(row.granted_scopes, "openid profile w_member_social");
  assert.equal(row.access_expires_at, new Date(NOW + 5184000 * 1000).toISOString());
  assert.ok(row.envelope && row.key_id === "k1");
  for (const secret of [ACCESS, REFRESH, CODE, state, LINKEDIN_SECRET]) assert.ok(!db(w).includes(secret), "nothing secret is stored in the clear");
});

test("callback is single use: a replay, a second tab and a concurrent pair exchange the code once", async () => {
  const { w, handler } = make();
  const { body } = await start(handler);
  const { state } = authorization(body.authorizeUrl);
  const both = await Promise.all([callback(handler, "linkedin", `code=${CODE}&state=${state}`), callback(handler, "linkedin", `code=${CODE}&state=${state}`)]);
  assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 400]);
  const replay = await callback(handler, "linkedin", `code=${CODE}&state=${state}`);
  assert.equal(replay.statusCode, 400);
  assert.match(replay.body, /not valid or was already used/);
  assert.equal(w.provider.filter((call) => call.path === "/oauth/v2/accessToken").length, 1);
});

test("callback refuses what a stranger can send, with the same page and no exchange", async () => {
  const { w, handler } = make();
  const { body } = await start(handler);
  const { state } = authorization(body.authorizeUrl);
  const forged = "A".repeat(43);
  for (const query of [
    "", `code=${CODE}`, `state=${state}`.replace(state, "short"), `code=${CODE}&state=${forged}`, `code=${CODE}&state=${state}&state=${state}`,
    `code=${CODE}&code=${CODE}&state=${state}`, `code=${CODE}&state=${state}%0A`, `code=${CODE}&state=${state.toLowerCase()}`,
  ]) {
    const result = await callback(handler, "linkedin", query);
    assert.equal(result.statusCode, 400, query);
    assert.ok(!result.body.includes(CODE));
  }
  // A real state replayed against the other provider, or a provider that does not exist, is refused too.
  assert.equal((await callback(handler, "facebook", `code=${CODE}&state=${state}`)).statusCode, 400);
  assert.equal((await callback(handler, "myspace", `code=${CODE}&state=${state}`)).statusCode, 404);
  assert.equal((await handler({ httpMethod: "POST", path: "/api/social/callback/linkedin", rawQuery: `code=${CODE}&state=${state}`, headers: {} })).statusCode, 404);
  assert.equal(w.provider.length, 0, "no provider call was made for any of them");
  assert.equal(connections(w)[0].status, "pending", "and the real connection is still usable");
  assert.equal((await callback(handler, "linkedin", `code=${CODE}&state=${state}`)).statusCode, 200);
});

test("callback: an expired attempt, a declined grant and a missing code end the attempt without tokens", async () => {
  const expired = make();
  let { body } = await start(expired.handler);
  expired.clock.t += 11 * 60 * 1000;
  assert.match((await callback(expired.handler, "linkedin", `code=${CODE}&state=${authorization(body.authorizeUrl).state}`)).body, /expired/);
  assert.equal(connections(expired.w)[0].status, "expired");
  assert.equal(expired.w.provider.length, 0);

  const denied = make();
  ({ body } = await start(denied.handler));
  const refused = await callback(denied.handler, "linkedin", `error=access_denied&error_description=${ACCESS}&state=${authorization(body.authorizeUrl).state}`);
  assert.equal(refused.statusCode, 400);
  assert.ok(!refused.body.includes(ACCESS), "the provider's description is never shown");
  assert.equal(connections(denied.w)[0].status, "failed");
  assert.equal(connections(denied.w)[0].error_code, "denied");

  const empty = make();
  ({ body } = await start(empty.handler));
  assert.equal((await callback(empty.handler, "linkedin", `state=${authorization(body.authorizeUrl).state}`)).statusCode, 400);
  assert.equal(connections(empty.w)[0].error_code, "invalid-request");
  for (const run of [denied, empty]) {
    assert.equal(run.w.provider.length, 0);
    assert.equal(connections(run.w)[0].envelope, null);
  }
});

test("scopes are verified from the grant: a missing required scope fails the attempt, revokes the token and stores nothing", async () => {
  const { w, handler } = make({}, { linkedin: { "POST www.linkedin.com/oauth/v2/accessToken": linkedinToken({ scope: "openid,profile" }), "POST www.linkedin.com/oauth/v2/revoke": { status: 200, body: {} } } });
  const { body } = await start(handler);
  const result = await callback(handler, "linkedin", `code=${CODE}&state=${authorization(body.authorizeUrl).state}`);
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /permission this feature needs/);
  const row = connections(w)[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "scopes-missing");
  assert.equal(row.envelope, null);
  assert.ok(!db(w).includes(ACCESS));
  assert.ok(w.provider.some((call) => call.path === "/oauth/v2/revoke"), "the unusable grant is withdrawn");
});

test("Facebook: a declined permission is caught by reading the real grant, and the long-lived exchange is used", async () => {
  const short = "EAAshort-token-0004";
  const long = "EAAlong-token-0005";
  const facebook = (granted) => ({
    "POST graph.facebook.com/v23.0/oauth/access_token": (call) =>
      call.form.grant_type === "fb_exchange_token" ? { status: 200, body: { access_token: long, expires_in: 5184000 } } : { status: 200, body: { access_token: short, expires_in: 3600 } },
    "GET graph.facebook.com/v23.0/me/permissions": { status: 200, body: { data: granted.map((permission) => ({ permission, status: "granted" })).concat([{ permission: "pages_manage_posts", status: "declined" }].filter(() => !granted.includes("pages_manage_posts"))) } },
  });
  const good = make({}, { facebook: facebook(["public_profile", "pages_show_list", "pages_manage_posts", "pages_read_engagement"]) });
  let { body } = await start(good.handler, "facebook");
  const { params, state } = authorization(body.authorizeUrl);
  assert.equal(new URL(body.authorizeUrl).host, "www.facebook.com");
  assert.equal(params.get("scope"), "pages_show_list,pages_manage_posts,pages_read_engagement");
  assert.equal((await callback(good.handler, "facebook", `code=${CODE}&state=${state}`)).statusCode, 200);
  const exchange = good.w.provider.find((call) => call.form?.fb_exchange_token);
  assert.equal(exchange.form.fb_exchange_token, short);
  assert.equal(exchange.form.client_secret, FACEBOOK_SECRET);
  assert.equal(good.w.provider.find((call) => call.path.endsWith("/me/permissions")).headers.authorization, `Bearer ${long}`);
  assert.ok(!db(good.w).includes(long) && !db(good.w).includes(short));
  assert.equal(connections(good.w)[0].granted_scopes, "public_profile pages_show_list pages_manage_posts pages_read_engagement");

  const bad = make({}, { facebook: facebook(["public_profile", "pages_show_list"]) });
  ({ body } = await start(bad.handler, "facebook"));
  const refused = await callback(bad.handler, "facebook", `code=${CODE}&state=${authorization(body.authorizeUrl).state}`);
  assert.equal(refused.statusCode, 400);
  assert.equal(connections(bad.w)[0].error_code, "scopes-missing");
  assert.equal(connections(bad.w)[0].envelope, null);
});

test("provider failures end the attempt with a fixed code and never repeat the provider's reply", async () => {
  for (const [reply, code] of [
    [{ status: 400, body: { error: "invalid_grant", error_description: `code ${CODE} expired for ${ACCESS}` } }, "code-rejected"],
    [{ status: 503, body: "Service down " + ACCESS }, "provider-unavailable"],
    [{ status: 200, body: "not json " + ACCESS }, "provider-error"],
    [{ status: 200, body: { nothing: true } }, "provider-error"],
    [new Error(`socket hang up ${ACCESS}`), "provider-unavailable"],
  ]) {
    const { w, handler } = make({}, { linkedin: { "POST www.linkedin.com/oauth/v2/accessToken": reply } });
    const { body } = await start(handler);
    const result = await callback(handler, "linkedin", `code=${CODE}&state=${authorization(body.authorizeUrl).state}`);
    assert.equal(result.statusCode, 400);
    assert.equal(connections(w)[0].error_code, code);
    assert.equal(connections(w)[0].status, "failed");
    for (const secret of [ACCESS, CODE]) assert.ok(!result.body.includes(secret) && !db(w).includes(secret));
  }
});

test("a storage outage during the callback never leaks and cannot be replayed", async () => {
  const { w, handler } = make();
  const { body } = await start(handler);
  const real = w.fetchImpl;
  let writes = 0;
  const flaky = createHandler({
    env: env(),
    now: () => NOW,
    fetchImpl: async (url, init) => {
      if (String(url).includes("/rest/v1/") && init.method === "PATCH" && (writes += 1) >= 2) return { ok: false, status: 500, json: async () => ({ message: ACCESS }), text: async () => ACCESS };
      return real(url, init);
    },
  });
  const result = await callback(flaky, "linkedin", `code=${CODE}&state=${authorization(body.authorizeUrl).state}`);
  assert.equal(result.statusCode, 400);
  assert.ok(!result.body.includes(ACCESS));
  assert.equal(connections(w)[0].status, "exchanging");
  assert.equal((await callback(handler, "linkedin", `code=${CODE}&state=${authorization(body.authorizeUrl).state}`)).statusCode, 400, "a spent state stays spent");
});

test("open attempts are bounded, cancel erases the sealed verifier, and only the Admin key lists", async () => {
  const { w, handler } = make({ OPENBLOG_SOCIAL_LINKEDIN_PKCE: "true" });
  const ids = [];
  for (let i = 0; i < 10; i += 1) ids.push((await start(handler)).body.connection.id);
  const over = await start(handler);
  assert.equal(over.response.statusCode, 429);
  const cancelled = await handler(request("POST", `/api/social/connections/${ids[0]}/cancel`, { body: {} }));
  assert.equal(cancelled.statusCode, 200);
  assert.equal(JSON.parse(cancelled.body).connection.status, "canceled");
  const row = connections(w).find((r) => r.id === ids[0]);
  assert.equal(row.envelope, null);
  assert.equal((await start(handler)).response.statusCode, 201, "a freed slot can be used again");
  assert.equal((await handler(request("POST", "/api/social/connections/not-an-id/cancel", { body: {} }))).statusCode, 404);
  assert.equal((await handler(request("GET", "/api/social/connections", { key: null }))).statusCode, 401);
  const listed = JSON.parse((await handler(request("GET", "/api/social/connections"))).body);
  assert.ok(listed.connections.length >= 10);
  for (const connection of listed.connections) assert.ok(!("envelope" in connection) && !("state_hash" in connection) && !("stateHash" in connection));
});

test("status shows the exact redirect to register and nothing secret", async () => {
  const { handler } = make({ OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS: "true", OPENBLOG_SOCIAL_FACEBOOK_API_VERSION: "v24.0" });
  const response = await handler(request("GET", "/.netlify/functions/social/status"));
  assert.equal(response.statusCode, 200);
  const status = JSON.parse(response.body);
  assert.deepEqual(status.providers.map((p) => p.provider), ["linkedin", "facebook"]);
  assert.equal(status.providers[0].redirectUri, `${CALLBACK_BASE}/callback/linkedin`);
  assert.deepEqual(status.providers[0].scopes, ["openid", "profile", "w_member_social", "r_organization_admin", "w_organization_social"]);
  assert.equal(status.providers[1].version, "v24.0");
  for (const secret of [LINKEDIN_SECRET, FACEBOOK_SECRET, ADMIN_KEY, WORKER_KEY, SUPABASE_KEY]) assert.ok(!response.body.includes(secret));
  assert.ok(authorizationUrl);
});
