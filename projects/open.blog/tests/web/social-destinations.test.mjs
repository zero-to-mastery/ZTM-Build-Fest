// Destinations and connected accounts of optional social publishing (epic #353, story #355, ADR
// 0300): LinkedIn members and organizations, Facebook Pages, eligibility that is verified and never
// guessed, choosing a destination once, reconnecting only the same identity, and disconnecting.
import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../../netlify/functions/social.mjs";
import { openCredential, parseKeyring } from "../../netlify/lib/social-tokens.mjs";
import { accountHealth } from "../../netlify/lib/social-accounts.mjs";
import { ADMIN_KEY, SITE, WORKER_KEY, authorization, b64, env, fakeWorld, request } from "./social-oauth-fakes.mjs";

const ACCESS = "AQX-access-token-value-0001";
const REFRESH = "AQX-refresh-token-value-0002";
const PAGE_ONE = "EAApage-one-token-0006";
const PAGE_TWO = "EAApage-two-token-0007";
const LONG = "EAAlong-user-token-0005";
const NOW = Date.parse("2026-10-29T12:00:00Z");
const KEYS = parseKeyring(`k1:${b64(1)}`);

const ok = (body) => ({ status: 200, body });
const LI = "GET api.linkedin.com";
const linkedinGrant = (scope = "openid,profile,w_member_social,r_organization_admin,w_organization_social") => ({
  "POST www.linkedin.com/oauth/v2/accessToken": ok({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 5184000, refresh_token_expires_in: 31536000, scope }),
  "POST www.linkedin.com/oauth/v2/revoke": ok({}),
  [`${LI}/v2/userinfo`]: ok({ sub: "abc123", name: "Ada Lovelace" }),
  [`${LI}/rest/organizationAcls`]: ok({ elements: [{ organization: "urn:li:organization:777", role: "ADMINISTRATOR" }, { organization: "urn:li:organization:888" }, { organization: "not-a-urn" }] }),
  [`${LI}/rest/organizations/777`]: ok({ localizedName: "Lantern ‮Studios‬ Ltd" }),
  [`${LI}/rest/organizations/888`]: { status: 404, body: {} },
});
const page = (id, name, tasks, token) => ({ id, name, ...(tasks ? { tasks } : {}), ...(token ? { access_token: token } : {}) });
const FB = "graph.facebook.com/v23.0";
const facebookGrant = (pages, granted = ["public_profile", "pages_show_list", "pages_manage_posts", "pages_read_engagement"]) => ({
  [`POST ${FB}/oauth/access_token`]: (call) => ok({ access_token: call.form.grant_type === "fb_exchange_token" ? LONG : "EAAshort", expires_in: 5184000 }),
  [`GET ${FB}/me/permissions`]: ok({ data: granted.map((permission) => ({ permission, status: "granted" })) }),
  [`GET ${FB}/me/accounts`]: ok({ data: pages }),
});

const make = ({ overrides = {}, accounts = [], linkedin, facebook } = {}) => {
  const w = fakeWorld({ accounts, linkedin: linkedin || linkedinGrant(), facebook: facebook || {}, fallback: { status: 404, body: {} } });
  const clock = { t: NOW };
  const handler = createHandler({ env: env({ OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS: "true", ...overrides }), fetchImpl: w.fetchImpl, now: () => clock.t });
  return { w, clock, handler };
};
const call = async (handler, method, path, body, options = {}) => {
  const response = await handler(request(method, `/api/social${path}`, { body, ...options }));
  return { status: response.statusCode, body: JSON.parse(response.body) };
};
const callback = (handler, provider, state) => handler({ httpMethod: "GET", path: `/api/social/callback/${provider}`, rawQuery: `code=the-code&state=${state}`, headers: {} });
const connect = async (handler, provider = "linkedin") => {
  const started = await call(handler, "POST", "/connections", { provider });
  const result = await callback(handler, provider, authorization(started.body.authorizeUrl).state);
  return { id: started.body.connection.id, result, started };
};
const tables = (w) => w.db.tables;
const open = (row) => openCredential(KEYS, { siteId: SITE, accountId: row.account_id || row.id }, row.key_id, row.envelope);
const text = (value) => JSON.stringify(value);

test("LinkedIn: the member and the organizations they administer, with eligibility from the grant and cleaned names", async () => {
  const { w, handler } = make();
  const { id, result } = await connect(handler);
  assert.equal(result.statusCode, 200);
  const orgCall = w.provider.find((entry) => entry.path === "/rest/organizationAcls");
  assert.equal(orgCall.headers["linkedin-version"], "202510");
  assert.equal(orgCall.headers["x-restli-protocol-version"], "2.0.0");
  assert.equal(orgCall.headers.authorization, `Bearer ${ACCESS}`);
  const { connections } = (await call(handler, "GET", "/connections")).body;
  const connection = connections.find((entry) => entry.id === id);
  assert.equal(connection.status, "authorized");
  assert.deepEqual(connection.destinations, [
    { id: "urn:li:person:abc123", kind: "member", name: "Ada Lovelace", eligible: true, reason: null },
    { id: "urn:li:organization:777", kind: "organization", name: "Lantern Studios Ltd", eligible: true, reason: null },
    { id: "urn:li:organization:888", kind: "organization", name: "Organization 888", eligible: true, reason: null },
  ]);
  assert.ok(!text(connection).includes(ACCESS) && !text(connection).includes(REFRESH));
});

test("LinkedIn: a refused or missing organization lookup is its own state, never 'no organizations'", async () => {
  const cases = [
    [{ [`${LI}/rest/organizationAcls`]: { status: 403, body: {} } }, {}, "organizations-not-approved"],
    [{ [`${LI}/rest/organizationAcls`]: { status: 500, body: {} } }, {}, "organizations-unavailable"],
    [{ [`${LI}/rest/organizationAcls`]: ok({ elements: [] }) }, {}, "no-organizations"],
    [{ "POST www.linkedin.com/oauth/v2/accessToken": ok({ access_token: ACCESS, scope: "openid,profile,w_member_social" }) }, {}, "organizations-not-granted"],
    [{}, { OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS: "false" }, "organizations-not-requested"],
  ];
  for (const [patch, overrides, note] of cases) {
    const { handler } = make({ overrides, linkedin: { ...linkedinGrant(), ...patch } });
    const { id } = await connect(handler);
    const connection = (await call(handler, "GET", "/connections")).body.connections.find((entry) => entry.id === id);
    assert.equal(connection.status, "authorized", note);
    assert.deepEqual(connection.destinations.map((d) => d.kind), ["member"], note);
    assert.deepEqual(connection.notes.map((n) => n.code), [note]);
    assert.ok(connection.notes[0].text.length > 20);
  }
});

test("LinkedIn: a granted-but-unwritable organization scope leaves the organization visible and ineligible, with the reason", async () => {
  const { w, handler } = make({ linkedin: linkedinGrant("openid,profile,w_member_social,r_organization_admin") });
  const { id } = await connect(handler);
  const connection = (await call(handler, "GET", "/connections")).body.connections.find((entry) => entry.id === id);
  const org = connection.destinations.find((d) => d.id === "urn:li:organization:777");
  assert.equal(org.eligible, false);
  assert.equal(org.reason, "missing-scope");
  const refused = await call(handler, "POST", `/connections/${id}/select`, { destination: org.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "destination-not-eligible");
  assert.equal(tables(w).openblog_social_accounts.length, 0);
});

test("choosing a destination creates the account and its sealed credential once; organizations share the member's grant", async () => {
  const { w, handler } = make();
  const { id } = await connect(handler);
  const chosen = await call(handler, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" }, { actor: "ada" });
  assert.equal(chosen.status, 201);
  assert.equal(chosen.body.account.externalId, "urn:li:person:abc123");
  assert.equal(chosen.body.account.connectedBy, "ada");
  assert.equal(chosen.body.account.kind, "member");
  assert.equal(chosen.body.account.status, "connected");
  assert.equal(chosen.body.credential.scopes, "openid profile w_member_social r_organization_admin w_organization_social");
  assert.ok(!text(chosen.body).includes(ACCESS) && !text(chosen.body).includes("envelope"));
  const [credential] = tables(w).openblog_social_credentials;
  assert.deepEqual(await open(credential), { accessToken: ACCESS, refreshToken: REFRESH });
  assert.ok(!text(tables(w)).includes(ACCESS) && !text(tables(w)).includes(REFRESH), "tokens are only ever sealed");
  const connection = tables(w).openblog_social_connections.find((row) => row.id === id);
  assert.equal(connection.status, "completed");
  assert.equal(connection.envelope, null, "the handshake's tokens are erased once chosen");
  // The same connection cannot be used again, for the same or another destination.
  for (const destination of ["urn:li:person:abc123", "urn:li:organization:777"]) {
    assert.equal((await call(handler, "POST", `/connections/${id}/select`, { destination })).body.error, "not-authorized");
  }
  assert.equal(tables(w).openblog_social_accounts.length, 1);
});

test("selecting is bounded by what was discovered: unknown, malformed and expired choices change nothing", async () => {
  const { w, clock, handler } = make();
  const { id } = await connect(handler);
  for (const [body, status, code] of [
    [{ destination: "urn:li:person:someone-else" }, 400, "unknown-destination"],
    [{ destination: "" }, 400, "invalid-destination"],
    [{ destination: 7 }, 400, "invalid-destination"],
    [{}, 400, "invalid-destination"],
    [{ destination: "urn:li:person:abc123", accountId: "x" }, 400, "invalid-request"],
    [{ destination: "urn:li:person:abc123", siteId: "other" }, 400, "site-not-accepted"],
  ]) {
    const result = await call(handler, "POST", `/connections/${id}/select`, body);
    assert.equal(result.status, status);
    assert.equal(result.body.error, code);
  }
  assert.equal((await call(handler, "POST", "/connections/not-a-uuid/select", { destination: "x" })).status, 404);
  assert.equal((await call(handler, "POST", "/connections/11111111-1111-4111-8111-111111111111/select", { destination: "x" })).status, 404);
  assert.equal(tables(w).openblog_social_accounts.length, 0);
  clock.t += 31 * 60 * 1000;
  const late = await call(handler, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" });
  assert.equal(late.body.error, "expired");
  assert.equal(tables(w).openblog_social_accounts.length, 0);
  assert.equal(tables(w).openblog_social_connections[0].envelope, null);
});

test("only the Admin key reaches accounts and choices; the worker key and a stranger cannot", async () => {
  const { handler } = make();
  const { id } = await connect(handler);
  for (const [method, path, body] of [["GET", "/accounts"], ["POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" }], ["POST", `/accounts/${id}/disconnect`, {}], ["POST", `/accounts/${id}/reconnect`, {}]]) {
    assert.equal((await call(handler, method, path, body, { key: WORKER_KEY, actor: null })).status, 403, path);
    assert.equal((await call(handler, method, path, body, { key: null })).status, 401, path);
    assert.equal((await call(handler, method, path, body, { key: "not-the-key".padEnd(40, "x") })).status, 401, path);
  }
  assert.equal(ADMIN_KEY.length > 32, true);
});

test("Facebook: a Page is offered only when the grant and the person's role on it say so", async () => {
  const pages = [
    page("111", "Lantern Page", ["CREATE_CONTENT", "MODERATE"], PAGE_ONE),
    page("222", "Read Only Page", ["ANALYZE"], "EAAnever-shown-0008"),
    page("333", "Mystery Page", null, "EAAnever-shown-0009"),
    page("444", "No Token Page", ["CREATE_CONTENT"], null),
    page("not-a-number", "Skipped", ["CREATE_CONTENT"], "EAAnever-shown-0010"),
  ];
  const { w, handler } = make({ facebook: facebookGrant(pages) });
  const { id } = await connect(handler, "facebook");
  const connection = (await call(handler, "GET", "/connections")).body.connections.find((entry) => entry.id === id);
  assert.deepEqual(connection.destinations.map((d) => [d.id, d.eligible, d.reason]), [
    ["111", true, null],
    ["222", false, "no-posting-role"],
    ["333", false, "role-unverified"],
    ["444", false, "no-page-token"],
  ]);
  assert.deepEqual(connection.notes.map((n) => n.code), ["app-review-unverified"]);
  assert.match(connection.notes[0].text, /cannot be read from the API/);
  const accounts = w.provider.find((entry) => entry.path.endsWith("/me/accounts"));
  assert.equal(accounts.headers.authorization, `Bearer ${LONG}`);
  assert.ok(!accounts.url.includes(LONG), "the token is in a header, not the URL");
  for (const token of [PAGE_ONE, LONG, "EAAnever-shown-0008"]) assert.ok(!text(tables(w)).includes(token) && !text(connection).includes(token));
  // Choosing the eligible Page stores that Page's own token, and nothing else.
  const chosen = await call(handler, "POST", `/connections/${id}/select`, { destination: "111" });
  assert.equal(chosen.status, 201);
  assert.equal(chosen.body.account.kind, "page");
  assert.deepEqual(await open(tables(w).openblog_social_credentials[0]), { accessToken: PAGE_ONE });
  assert.equal(tables(w).openblog_social_credentials[0].access_expires_at, null, "a Page token does not expire");
});

test("Facebook: nothing eligible fails the attempt with the reasons kept and no token stored; a missing permission marks every Page", async () => {
  const none = make({ facebook: facebookGrant([page("222", "Read Only Page", ["ANALYZE"], "EAAnever-shown-0008")]) });
  const first = await connect(none.handler, "facebook");
  assert.equal(first.result.statusCode, 400);
  const row = tables(none.w).openblog_social_connections[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "no-destination");
  assert.equal(row.envelope, null);
  assert.equal(row.destinations[0].reason, "no-posting-role");
  assert.equal(tables(none.w).openblog_social_accounts.length, 0);

  const empty = make({ facebook: facebookGrant([]) });
  await connect(empty.handler, "facebook");
  assert.match(tables(empty.w).openblog_social_connections[0].notes, /no-pages/);
});

test("a Page already connected cannot be connected twice, and the author may then pick again", async () => {
  const pages = [page("111", "One", ["CREATE_CONTENT"], PAGE_ONE), page("555", "Two", ["CREATE_CONTENT"], PAGE_TWO)];
  const { w, handler } = make({ facebook: facebookGrant(pages) });
  const first = await connect(handler, "facebook");
  assert.equal((await call(handler, "POST", `/connections/${first.id}/select`, { destination: "111" })).status, 201);
  const second = await connect(handler, "facebook");
  const duplicate = await call(handler, "POST", `/connections/${second.id}/select`, { destination: "111" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "already-connected");
  const row = tables(w).openblog_social_connections.find((entry) => entry.id === second.id);
  assert.equal(row.status, "authorized", "the choice is open again");
  assert.ok(row.envelope);
  assert.equal(tables(w).openblog_social_accounts.length, 1, "no half-made account was left behind");
  assert.equal((await call(handler, "POST", `/connections/${second.id}/select`, { destination: "555" })).status, 201);
  assert.deepEqual(await open(tables(w).openblog_social_credentials[1]), { accessToken: PAGE_TWO });
});

test("a failing credential store leaves no connected account and lets the author retry", async () => {
  const { w, handler } = make();
  const { id } = await connect(handler);
  const real = w.fetchImpl;
  const broken = createHandler({
    env: env({ OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS: "true" }),
    now: () => NOW,
    fetchImpl: async (url, init) => (String(url).includes("openblog_social_credentials") && init.method === "POST" ? { ok: false, status: 500, json: async () => ({}), text: async () => "" } : real(url, init)),
  });
  const failed = await call(broken, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" });
  assert.ok(failed.status >= 500);
  assert.equal(tables(w).openblog_social_accounts[0].status, "disconnected");
  assert.ok(tables(w).openblog_social_accounts[0].disconnected_at);
  assert.equal(tables(w).openblog_social_connections.find((row) => row.id === id).status, "authorized");
});

test("accounts: listing shows status, dates and scopes, computes health, and hides other sites and every secret", async () => {
  const other = { id: "99999999-9999-4999-8999-999999999999", site_id: "another-site", provider: "linkedin", kind: "member", external_id: "urn:li:person:zzz", display_name: "Elsewhere", status: "connected", connected_by: "x", created_at: "2026-01-01T00:00:00Z" };
  const { w, clock, handler } = make({ accounts: [other] });
  const { id } = await connect(handler);
  await call(handler, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" });
  let { accounts } = (await call(handler, "GET", "/accounts")).body;
  assert.deepEqual(accounts.map((a) => a.displayName), ["Ada Lovelace"]);
  assert.equal(accounts[0].health, "ok");
  assert.equal(accounts[0].credential.status, "active");
  assert.deepEqual(accounts[0].credential.scopes.slice(0, 3), ["openid", "profile", "w_member_social"]);
  assert.ok(!text(accounts).includes(ACCESS) && !text(accounts).includes("envelope") && !text(accounts).includes("ciphertext"));
  assert.equal((await call(handler, "POST", `/accounts/${other.id}/disconnect`, {})).status, 404, "another site's account does not exist here");
  clock.t += 359 * 24 * 3600 * 1000;
  accounts = (await call(handler, "GET", "/accounts")).body.accounts;
  assert.equal(accounts[0].health, "expiring");
  clock.t += 10 * 24 * 3600 * 1000;
  accounts = (await call(handler, "GET", "/accounts")).body.accounts;
  assert.equal(accounts[0].health, "needs-reauth");
  assert.equal(tables(w).openblog_social_accounts.length, 2);
  const at = NOW;
  assert.equal(accountHealth({ status: "needs-reauth" }, { status: "active" }, at), "needs-reauth");
  assert.equal(accountHealth({ status: "connected" }, null, at), "needs-reauth");
  assert.equal(accountHealth({ status: "connected" }, { status: "revoked" }, at), "needs-reauth");
  assert.equal(accountHealth({ status: "connected" }, { status: "active", access_expires_at: new Date(at - 1000).toISOString(), refresh_expires_at: new Date(at + 30 * 86400000).toISOString() }, at), "ok", "an expired access token with a live refresh token refreshes itself");
  assert.equal(accountHealth({ status: "connected" }, { status: "active", access_expires_at: null }, at), "ok");
  assert.equal(accountHealth({ status: "disconnected" }, null, at), "disconnected");
});

test("reconnect: the same identity replaces the credential and clears the flag; a different identity changes nothing", async () => {
  const { w, handler } = make();
  const { id } = await connect(handler);
  const account = (await call(handler, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" })).body.account;
  const before = structuredClone(tables(w).openblog_social_credentials[0]);
  tables(w).openblog_social_accounts[0].status = "needs-reauth";

  // A different LinkedIn identity signs in: refused, the grant withdrawn, nothing swapped.
  w.handlers[`${LI}/v2/userinfo`] = ok({ sub: "someone-else", name: "Mallory" });
  const started = await call(handler, "POST", `/accounts/${account.id}/reconnect`, {});
  assert.equal(started.status, 201);
  assert.equal(started.body.connection.reauthAccountId, account.id);
  const wrong = await callback(handler, "linkedin", authorization(started.body.authorizeUrl).state);
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.body, /different account/);
  assert.deepEqual(tables(w).openblog_social_credentials[0].envelope, before.envelope, "the stored credential is untouched");
  assert.equal(tables(w).openblog_social_accounts[0].status, "needs-reauth");
  assert.ok(!w.provider.some((entry) => entry.path === "/oauth/v2/revoke"), "the account is still live, so a failed attempt never withdraws a grant it may share");

  // The right identity signs in again.
  w.handlers[`${LI}/v2/userinfo`] = ok({ sub: "abc123", name: "Ada L." });
  w.handlers["POST www.linkedin.com/oauth/v2/accessToken"] = ok({ access_token: "AQX-new-access-0011", refresh_token: "AQX-new-refresh-0012", expires_in: 5184000, scope: "openid,profile,w_member_social" });
  const again = await call(handler, "POST", `/accounts/${account.id}/reconnect`, {});
  const done = await callback(handler, "linkedin", authorization(again.body.authorizeUrl).state);
  assert.equal(done.statusCode, 200);
  assert.equal(tables(w).openblog_social_accounts.length, 1, "no second account");
  assert.equal(tables(w).openblog_social_accounts[0].status, "connected");
  assert.equal(tables(w).openblog_social_accounts[0].display_name, "Ada L.");
  assert.deepEqual(await open(tables(w).openblog_social_credentials[0]), { accessToken: "AQX-new-access-0011", refreshToken: "AQX-new-refresh-0012" });
  const finished = tables(w).openblog_social_connections.find((row) => row.id === again.body.connection.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.envelope, null);
  assert.ok(!text(tables(w)).includes("AQX-new-access-0011"));
  assert.equal((await call(handler, "GET", "/accounts")).body.accounts[0].health, "ok");
});

test("reconnecting Facebook re-asks for declined permissions, and a disconnected or unknown account cannot be reconnected", async () => {
  const { w, handler } = make({ facebook: facebookGrant([page("111", "One", ["CREATE_CONTENT"], PAGE_ONE)]) });
  const { id } = await connect(handler, "facebook");
  const account = (await call(handler, "POST", `/connections/${id}/select`, { destination: "111" })).body.account;
  const started = await call(handler, "POST", `/accounts/${account.id}/reconnect`, {});
  assert.equal(new URL(started.body.authorizeUrl).searchParams.get("auth_type"), "rerequest");
  assert.equal((await callback(handler, "facebook", authorization(started.body.authorizeUrl).state)).statusCode, 200);
  assert.equal(tables(w).openblog_social_credentials.length, 1);
  await call(handler, "POST", `/accounts/${account.id}/disconnect`, {});
  assert.equal((await call(handler, "POST", `/accounts/${account.id}/reconnect`, {})).body.error, "disconnected");
  assert.equal((await call(handler, "POST", "/accounts/11111111-1111-4111-8111-111111111111/reconnect", {})).status, 404);
});

test("disconnect: tokens are erased and the row kept; LinkedIn is told only when no other account shares the grant; Facebook is never revoked per Page", async () => {
  const { w, handler } = make();
  const { id } = await connect(handler);
  const member = (await call(handler, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" })).body.account;
  const second = await connect(handler);
  const org = (await call(handler, "POST", `/connections/${second.id}/select`, { destination: "urn:li:organization:777" })).body.account;
  const revokes = () => w.provider.filter((entry) => entry.path === "/oauth/v2/revoke");

  const first = await call(handler, "POST", `/accounts/${member.id}/disconnect`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.account.status, "disconnected");
  assert.equal(first.body.account.health, "disconnected");
  assert.equal(revokes().length, 0, "another LinkedIn account is still connected, so the grant is left alone");
  const credential = tables(w).openblog_social_credentials.find((row) => row.account_id === member.id);
  assert.equal(credential.status, "revoked");
  assert.equal(credential.envelope, null);
  assert.ok(tables(w).openblog_social_accounts.some((row) => row.id === member.id), "the account row stays for history");

  const last = await call(handler, "POST", `/accounts/${org.id}/disconnect`, {});
  assert.equal(last.body.account.status, "disconnected");
  assert.equal(revokes().length, 1);
  assert.equal(revokes()[0].form.token, REFRESH);
  assert.equal(revokes()[0].form.client_secret, "li-client-secret-0001");
  assert.equal((await call(handler, "POST", `/accounts/${org.id}/disconnect`, {})).status, 200, "disconnecting twice is harmless");
  assert.equal(revokes().length, 1);
  assert.ok(!text(tables(w)).includes(ACCESS));
});

test("disconnecting a Facebook Page never calls Facebook, and survives a failing provider", async () => {
  const { w, handler } = make({ facebook: facebookGrant([page("111", "One", ["CREATE_CONTENT"], PAGE_ONE)]) });
  const { id } = await connect(handler, "facebook");
  const account = (await call(handler, "POST", `/connections/${id}/select`, { destination: "111" })).body.account;
  const calls = w.provider.length;
  assert.equal((await call(handler, "POST", `/accounts/${account.id}/disconnect`, {})).body.account.status, "disconnected");
  assert.equal(w.provider.length, calls);

  const failing = make();
  const linked = await connect(failing.handler);
  const only = (await call(failing.handler, "POST", `/connections/${linked.id}/select`, { destination: "urn:li:person:abc123" })).body.account;
  failing.w.handlers["POST www.linkedin.com/oauth/v2/revoke"] = new Error(`socket hang up ${ACCESS}`);
  const result = await call(failing.handler, "POST", `/accounts/${only.id}/disconnect`, {});
  assert.equal(result.status, 200);
  assert.equal(result.body.account.status, "disconnected");
  assert.ok(!text(result.body).includes(ACCESS));
  assert.equal(tables(failing.w).openblog_social_credentials[0].envelope, null);
});

test("hostile provider data: names are cleaned and bounded, ids are validated, and nothing is trusted as markup", async () => {
  const long = "x".repeat(900);
  const pages = [page("111", `<img src=x onerror=alert(1)>\u0000‮${long}`, ["CREATE_CONTENT"], PAGE_ONE)];
  const { handler } = make({ facebook: facebookGrant(pages) });
  const { id } = await connect(handler, "facebook");
  const destination = (await call(handler, "GET", "/connections")).body.connections.find((entry) => entry.id === id).destinations[0];
  assert.ok(destination.name.length <= 200);
  assert.ok(!/[\u0000-\u001f‮]/.test(destination.name));
  const chosen = await call(handler, "POST", `/connections/${id}/select`, { destination: "111" });
  assert.equal(chosen.body.account.displayName, destination.name);
});

// A fetch that fails the PATCHes whose JSON body matches, to model a storage blip at one step.
const failing = (w, table, matches) => async (url, init = {}) => {
  if (String(url).includes(table) && init.method === "PATCH" && matches(JSON.parse(init.body))) return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
  return w.fetchImpl(url, init);
};
const flaky = (w, clock, table, matches) => createHandler({ env: env({ OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS: "true" }), fetchImpl: failing(w, table, matches), now: () => clock.t });

test("a claim that dies before it finishes keeps its sealed tokens only for the short lease; list erases them", async () => {
  const { w, clock, handler } = make();
  const { id } = await connect(handler);
  const broken = flaky(w, clock, "openblog_social_connections", (patch) => patch.status === "completed");
  const chosen = await call(broken, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" });
  assert.equal(chosen.status, 201, "the account and credential were saved, so the choice stands");
  const row = () => tables(w).openblog_social_connections.find((entry) => entry.id === id);
  assert.equal(row().status, "exchanging");
  assert.ok(row().envelope, "still sealed inside the lease");
  clock.t += 3 * 60 * 1000;
  await call(handler, "GET", "/connections");
  assert.equal(row().status, "expired");
  assert.equal(row().envelope, null);
  assert.equal(row().key_id, null);
});

test("a failed restore after a failed choice erases the sealed tokens at once instead of leaving them", async () => {
  const { w, clock, handler } = make();
  const { id } = await connect(handler);
  const real = w.fetchImpl;
  const broken = createHandler({
    env: env({ OPENBLOG_SOCIAL_LINKEDIN_ORGANIZATIONS: "true" }),
    now: () => clock.t,
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("openblog_social_credentials") && init.method === "POST") return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
      if (String(url).includes("openblog_social_connections") && init.method === "PATCH" && JSON.parse(init.body).status === "authorized") return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
      return real(url, init);
    },
  });
  assert.ok((await call(broken, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" })).status >= 500);
  const row = tables(w).openblog_social_connections.find((entry) => entry.id === id);
  assert.equal(row.envelope, null);
  assert.equal(row.status, "failed");
});

test("disconnect also erases a handshake of that provider that is stuck holding sealed tokens", async () => {
  const { w, clock, handler } = make();
  const first = await connect(handler);
  const account = (await call(handler, "POST", `/connections/${first.id}/select`, { destination: "urn:li:person:abc123" })).body.account;
  const second = await connect(handler);
  const stuck = flaky(w, clock, "openblog_social_connections", (patch) => patch.status === "completed");
  await call(stuck, "POST", `/connections/${second.id}/select`, { destination: "urn:li:organization:777" });
  const row = tables(w).openblog_social_connections.find((entry) => entry.id === second.id);
  assert.ok(row.envelope);
  await call(handler, "POST", `/accounts/${account.id}/disconnect`, {});
  assert.equal(row.envelope, null);
});

test("a failed handshake never revokes a grant while another LinkedIn account of the site is live", async () => {
  const { w, handler } = make();
  const { id } = await connect(handler);
  await call(handler, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" });
  const revokes = () => w.provider.filter((entry) => entry.path === "/oauth/v2/revoke");
  // Connecting another account that ends with nothing usable.
  w.handlers[`${LI}/rest/organizationAcls`] = ok({ elements: [] });
  w.handlers[`${LI}/v2/userinfo`] = { status: 404, body: {} };
  const attempt = await connect(handler);
  assert.equal(attempt.result.statusCode, 400);
  assert.equal(revokes().length, 0);
  // A missing required scope is the same.
  w.handlers["POST www.linkedin.com/oauth/v2/accessToken"] = ok({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 100, scope: "openid,profile" });
  assert.equal((await connect(handler)).result.statusCode, 400);
  assert.equal(revokes().length, 0);
});

test("a failed handshake still withdraws the grant when no account is live", async () => {
  const { w, handler } = make();
  w.handlers["POST www.linkedin.com/oauth/v2/accessToken"] = ok({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 100, scope: "openid,profile" });
  assert.equal((await connect(handler)).result.statusCode, 400);
  assert.equal(w.provider.filter((entry) => entry.path === "/oauth/v2/revoke").length, 1);
});

test("reconnect: when the account row cannot be updated after the credential was saved, the new token is not revoked", async () => {
  const { w, clock, handler } = make();
  const { id } = await connect(handler);
  const account = (await call(handler, "POST", `/connections/${id}/select`, { destination: "urn:li:person:abc123" })).body.account;
  w.handlers["POST www.linkedin.com/oauth/v2/accessToken"] = ok({ access_token: "AQX-new-access-0011", refresh_token: "AQX-new-refresh-0012", expires_in: 5184000, scope: "openid,profile,w_member_social" });
  const started = await call(handler, "POST", `/accounts/${account.id}/reconnect`, {});
  const broken = flaky(w, clock, "openblog_social_accounts", () => true);
  const done = await callback(broken, "linkedin", authorization(started.body.authorizeUrl).state);
  assert.equal(done.statusCode, 400);
  assert.equal(w.provider.filter((entry) => entry.path === "/oauth/v2/revoke").length, 0);
  assert.deepEqual(await open(tables(w).openblog_social_credentials[0]), { accessToken: "AQX-new-access-0011", refreshToken: "AQX-new-refresh-0012" });
});
