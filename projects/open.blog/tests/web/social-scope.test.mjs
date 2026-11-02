// Optional social publishing, identity boundary (epic #353, ADR 0293): the feature is off unless
// configured, the role comes from which server key matched, the Admin user is an attribution
// only, the site always comes from the server, and nothing here repeats a key.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import {
  ACTOR_HEADER,
  SocialScopeError,
  WORKER_ACTOR,
  authorizeSocial,
  ensureOwned,
  refuseClientScope,
  scopedQuery,
  socialSettings,
  validActor,
  validSiteScope,
} from "../../netlify/lib/social-scope.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/social-scope.json", import.meta.url), "utf8"));

const ADMIN_KEY = "adm_".padEnd(48, "a1");
const WORKER_KEY = "wrk_".padEnd(48, "b2");
const SERVICE_KEY = "sb_secret_".padEnd(48, "c3");
const env = (overrides = {}) => ({
  OPENBLOG_SOCIAL_ENABLED: "true",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: SERVICE_KEY,
  OPENBLOG_SITE_ID: "lantern-studios",
  OPENBLOG_SOCIAL_ADMIN_KEY: ADMIN_KEY,
  OPENBLOG_SOCIAL_WORKER_KEY: WORKER_KEY,
  OPENBLOG_SOCIAL_TOKEN_KEYS: "k1:" + Buffer.alloc(32, 7).toString("base64"),
  ...overrides,
});

const rejects = async (promise, status, code) => {
  await assert.rejects(promise, (error) => error instanceof SocialScopeError && error.status === status && error.code === code);
};

test("site scopes and actors match the shared fixture the Rust core reads", () => {
  for (const site of fixture.sites.accepted) assert.equal(validSiteScope(site), true, site);
  for (const site of fixture.sites.refused) assert.equal(validSiteScope(site), false, JSON.stringify(site));
  for (const actor of fixture.actors.accepted) assert.equal(validActor(actor), true, actor);
  for (const actor of fixture.actors.refused) assert.equal(validActor(actor), false, JSON.stringify(actor));
});

test("the feature is off unless explicitly enabled, and off when incomplete", () => {
  assert.equal(socialSettings({}).enabled, false);
  assert.equal(socialSettings(env({ OPENBLOG_SOCIAL_ENABLED: "" })).enabled, false);
  assert.equal(socialSettings(env({ OPENBLOG_SOCIAL_ENABLED: "TRUE" })).enabled, false);
  assert.equal(socialSettings(env({ OPENBLOG_SOCIAL_ENABLED: "1" })).enabled, false);
  assert.deepEqual(socialSettings({}).problems, [], "not enabled is not a misconfiguration");
  const ok = socialSettings(env());
  assert.equal(ok.enabled, true);
  assert.equal(ok.siteId, "lantern-studios");
  for (const [name, value] of [
    ["SUPABASE_URL", "http://project.supabase.co"],
    ["SUPABASE_URL", "https://user:pass@project.supabase.co"],
    ["SUPABASE_URL", "https://project.supabase.co/rest/v1"],
    ["OPENBLOG_SITE_ID", "lantern studios"],
    ["OPENBLOG_SITE_ID", ""],
    ["OPENBLOG_SOCIAL_ADMIN_KEY", "short"],
    ["OPENBLOG_SOCIAL_WORKER_KEY", ""],
    ["OPENBLOG_SOCIAL_TOKEN_KEYS", ""],
    ["OPENBLOG_SOCIAL_TOKEN_KEYS", "k1:c2hvcnQ="],
    ["OPENBLOG_SOCIAL_TOKEN_KEYS", "bad id:" + Buffer.alloc(32, 7).toString("base64")],
  ]) {
    const settings = socialSettings(env({ [name]: value }));
    assert.equal(settings.enabled, false, `${name}=${value}`);
    assert.ok(settings.problems.includes(name), `${name} named`);
  }
  assert.equal(socialSettings(env({ SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" })).enabled, false);
});

test("no server key may be shared with another credential, above all a public one", () => {
  const anon = "anon_".padEnd(48, "d4");
  for (const overrides of [
    { OPENBLOG_SOCIAL_WORKER_KEY: ADMIN_KEY },
    { OPENBLOG_SOCIAL_ADMIN_KEY: SERVICE_KEY },
    { OPENBLOG_SOCIAL_WORKER_KEY: SERVICE_KEY },
    { SUPABASE_ANON_KEY: anon, OPENBLOG_SOCIAL_WORKER_KEY: anon },
    { SUPABASE_PUBLISHABLE_KEY: anon, OPENBLOG_SOCIAL_ADMIN_KEY: anon },
    { OPENBLOG_ADMIN_API_KEY: ADMIN_KEY },
  ]) {
    assert.equal(socialSettings(env(overrides)).enabled, false, JSON.stringify(Object.keys(overrides)));
  }
});

test("settings never show a key when logged or serialized", () => {
  const settings = socialSettings(env());
  const shown = [JSON.stringify(settings), inspect(settings), String(Object.keys(settings)), JSON.stringify(socialSettings(env({ OPENBLOG_SOCIAL_ADMIN_KEY: "short-secret" })))].join("\n");
  for (const secret of [ADMIN_KEY, WORKER_KEY, SERVICE_KEY, "short-secret"]) assert.ok(!shown.includes(secret));
  assert.equal(settings.adminKey, ADMIN_KEY, "the code that needs the key can still read it");
});

test("the admin key with a valid Admin user is the admin role; the actor is attribution only", async () => {
  const settings = socialSettings(env());
  const identity = await authorizeSocial({ Authorization: `Bearer ${ADMIN_KEY}`, [ACTOR_HEADER]: "mikey" }, settings);
  assert.deepEqual({ ...identity }, { role: "admin", actor: "mikey" });
  const fromHeaders = await authorizeSocial(new Headers({ authorization: `Bearer ${ADMIN_KEY}`, "X-OpenBlog-Actor": "editor.two" }), settings);
  assert.equal(fromHeaders.actor, "editor.two");
  await rejects(authorizeSocial({ Authorization: `Bearer ${ADMIN_KEY}` }, settings), 400, "invalid-actor");
  await rejects(authorizeSocial({ Authorization: `Bearer ${ADMIN_KEY}`, [ACTOR_HEADER]: WORKER_ACTOR }, settings), 400, "invalid-actor");
  await rejects(authorizeSocial({ Authorization: `Bearer ${ADMIN_KEY}`, [ACTOR_HEADER]: "Mikey" }, settings), 400, "invalid-actor");
});

test("an actor without a key, a wrong key or a public key is refused", async () => {
  const settings = socialSettings(env({ SUPABASE_ANON_KEY: "anon_".padEnd(48, "d4") }));
  for (const headers of [
    { [ACTOR_HEADER]: "mikey" },
    { Authorization: `Bearer ${ADMIN_KEY}x`, [ACTOR_HEADER]: "mikey" },
    { Authorization: `Bearer ${ADMIN_KEY.slice(0, -1)}`, [ACTOR_HEADER]: "mikey" },
    { Authorization: `Basic ${ADMIN_KEY}`, [ACTOR_HEADER]: "mikey" },
    { Authorization: `Bearer  ${ADMIN_KEY}`, [ACTOR_HEADER]: "mikey" },
    { Authorization: `Bearer ${SERVICE_KEY}`, [ACTOR_HEADER]: "mikey" },
    { Authorization: `Bearer ${"anon_".padEnd(48, "d4")}` },
    { Authorization: "Bearer " },
    {},
  ]) {
    await rejects(authorizeSocial(headers, settings, { allow: ["admin", "worker"] }), 401, "unauthorized");
  }
});

test("the worker key is only the worker, and the admin key is never the worker", async () => {
  const settings = socialSettings(env());
  const worker = await authorizeSocial({ Authorization: `Bearer ${WORKER_KEY}` }, settings, { allow: ["worker"] });
  assert.deepEqual({ ...worker }, { role: "worker", actor: WORKER_ACTOR });
  await rejects(authorizeSocial({ Authorization: `Bearer ${WORKER_KEY}`, [ACTOR_HEADER]: "mikey" }, settings, { allow: ["worker", "admin"] }), 400, "invalid-actor");
  await rejects(authorizeSocial({ Authorization: `Bearer ${WORKER_KEY}` }, settings), 403, "forbidden");
  await rejects(authorizeSocial({ Authorization: `Bearer ${ADMIN_KEY}`, [ACTOR_HEADER]: "mikey" }, settings, { allow: ["worker"] }), 403, "forbidden");
});

test("with the feature off every request is a 404, even with a key", async () => {
  await rejects(authorizeSocial({ Authorization: `Bearer ${ADMIN_KEY}`, [ACTOR_HEADER]: "mikey" }, socialSettings({})), 404, "not-enabled");
  await rejects(authorizeSocial({ Authorization: `Bearer ${ADMIN_KEY}`, [ACTOR_HEADER]: "mikey" }, socialSettings(env({ OPENBLOG_SITE_ID: "" }))), 404, "not-enabled");
});

test("a request cannot name a site anywhere, not even its own", () => {
  for (const request of [
    { query: "site_id=other-site" },
    { query: new URLSearchParams({ siteId: "lantern-studios" }) },
    { body: { site_id: "other-site" } },
    { body: { destination: { siteId: "other-site" } } },
    { body: { items: [{ ok: true }, { p_site_id: "other-site" }] } },
    { body: { site: "other-site" } },
  ]) {
    assert.throws(() => refuseClientScope(request), (error) => error.status === 400 && error.code === "site-not-accepted", JSON.stringify(request));
  }
  refuseClientScope({ query: "status=scheduled", body: { text: "site_id in prose is fine", nested: { a: [1, 2] } } });
  let deep = {};
  for (let index = 0; index < 40; index += 1) deep = { inner: deep };
  assert.throws(() => refuseClientScope({ body: deep }), (error) => error.code === "invalid-request");
});

test("every query is led by the server's site and cannot be re-scoped", () => {
  const settings = socialSettings(env());
  const query = scopedQuery(settings, { status: "eq.scheduled", select: "id" });
  assert.equal(query.toString(), "site_id=eq.lantern-studios&status=eq.scheduled&select=id");
  assert.throws(() => scopedQuery(settings, { site_id: "eq.other-site" }), (error) => error.code === "scope-override");
});

test("a row from another site is never returned", () => {
  const settings = socialSettings(env());
  const mine = [{ site_id: "lantern-studios", id: 1 }];
  assert.equal(ensureOwned(settings, mine), mine);
  assert.throws(() => ensureOwned(settings, [...mine, { site_id: "other-site", id: 2 }]), (error) => error.code === "other-site");
  assert.throws(() => ensureOwned(settings, { id: 3 }), (error) => error.code === "other-site");
  assert.throws(() => ensureOwned(settings, [null]), (error) => error.code === "other-site");
});

test("refusals never repeat what was presented", async () => {
  const settings = socialSettings(env());
  const presented = "Bearer guess-".padEnd(60, "z");
  try {
    await authorizeSocial({ Authorization: presented, [ACTOR_HEADER]: "mikey" }, settings);
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(!`${error.message} ${error.code}`.includes("guess-"));
  }
});
