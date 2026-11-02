import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../../netlify/functions/engagement.mjs";
import { captchaSettings, checkPass, issuePass, verifyCaptcha } from "../../netlify/lib/comment-captcha.mjs";

const secret = "test-signing-value-".repeat(3);
const time = new Date("2026-10-29T12:00:00Z");
const base = { SUPABASE_URL: "https://db.example", SUPABASE_SECRET_KEY: "private-database-key", OPENBLOG_SITE_ID: "site", OPENBLOG_SITE_ORIGIN: "https://blog.example", OPENBLOG_ADMIN_API_KEY: "admin", OPENBLOG_ANALYTICS_SALT: "salt" };
const env = { ...base, OPENBLOG_CAPTCHA_PROVIDER: "turnstile", OPENBLOG_TURNSTILE_SECRET: "private-provider-key", OPENBLOG_CAPTCHA_SESSION_SECRET: secret };
const event = (extra = {}) => ({ path: "/api/comments", httpMethod: "POST", headers: { origin: base.OPENBLOG_SITE_ORIGIN, "x-nf-client-connection-ip": "203.0.113.9" }, body: JSON.stringify({ path: "/post/", authorName: "Reader", body: "My draft", ...extra }) });
const providerReply = (result, ok = true) => async () => ({ ok, json: async () => result });

function harness(overrides = {}, state = {}) {
  const requests = [];
  const logs = [];
  const handler = createHandler({
    env: { ...env, ...overrides }, now: () => state.time || time,
    siteFetchImpl: async () => ({ ok: true, json: async () => ({ "/post/": "open" }) }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("siteverify")) return (state.provider || providerReply({ success: true }))(url, options);
      if (url.includes("consume_rate_limit")) {
        const bucket = JSON.parse(options.body).p_bucket;
        return { ok: true, json: async () => ({ allowed: !(state.deny || []).includes(bucket) }) };
      }
      return { ok: true, json: async () => [{ id: "id" }] };
    },
  });
  return { handler, requests, logs, buckets: () => requests.filter(({ url }) => url.includes("consume_rate_limit")).map(({ options }) => JSON.parse(options.body).p_bucket), stored: () => requests.some(({ url }) => url.includes("openblog_comments")), provider: () => requests.filter(({ url }) => url.includes("siteverify")) };
}

test("passes reject forgery, tampering, expiry, wrong sites and malformed values", () => {
  const { pass, expiresAt } = issuePass("site", secret, time);
  assert.equal(expiresAt, time.getTime() / 1000 + 1800);
  assert.deepEqual(checkPass(pass, "site", secret, time), { ok: true });
  const [payload, mac] = pass.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ s: "site", e: expiresAt + 5000, n: "x" })).toString("base64url");
  const reasons = (value, site = "site", key = secret, at = time) => checkPass(value, site, key, at).reason;
  assert.equal(reasons(`${forgedPayload}.${mac}`), "forged");
  assert.equal(reasons(`${payload}.${mac.slice(0, -2)}AA`), "forged");
  assert.equal(reasons(pass, "site", "another-secret-".repeat(3)), "forged");
  assert.equal(reasons(pass, "other"), "other_site");
  assert.equal(reasons(pass, "site", secret, new Date((expiresAt - 1) * 1000)), undefined);
  assert.equal(reasons(pass, "site", secret, new Date(expiresAt * 1000)), "expired");
  for (const invalid of [null, {}, "x", `${pass}.extra`, "a".repeat(3000)]) assert.equal(checkPass(invalid, "site", secret, time).ok, false);
  assert.notEqual(issuePass("site", secret, time).pass, pass);
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(Object.keys(decoded).sort(), ["e", "n", "s"]);
});

test("settings default to off, bound the lifetime and name only variables that are missing", () => {
  assert.deepEqual(captchaSettings(base).missing, []);
  assert.equal(captchaSettings(base).enabled, false);
  assert.equal(captchaSettings(env).ttl, 1800);
  assert.equal(captchaSettings({ ...env, OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS: "5" }).ttl, 60);
  assert.equal(captchaSettings({ ...env, OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS: "999999" }).ttl, 86400);
  assert.equal(captchaSettings({ ...env, OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS: "junk" }).ttl, 1800);
  assert.deepEqual(captchaSettings({ ...env, OPENBLOG_TURNSTILE_SECRET: "" }).missing, ["OPENBLOG_TURNSTILE_SECRET"]);
  assert.deepEqual(captchaSettings({ ...env, OPENBLOG_CAPTCHA_SESSION_SECRET: "short" }).missing, ["OPENBLOG_CAPTCHA_SESSION_SECRET"]);
  assert.deepEqual(captchaSettings({ ...env, OPENBLOG_CAPTCHA_SESSION_SECRET: "", OPENBLOG_CAPTCHA_SCOPE: "every-comment" }).missing, []);
  assert.deepEqual(captchaSettings({ ...env, OPENBLOG_CAPTCHA_PROVIDER: "hcaptcha" }).missing, ["OPENBLOG_CAPTCHA_PROVIDER"]);
});

test("the verifier reports a distinct reason for each failure and never leaks", async () => {
  const run = (fetchImpl, token = "token") => verifyCaptcha({ provider: "turnstile", token, secret: "private-provider-key", remoteIp: "203.0.113.9", fetchImpl });
  assert.deepEqual(await run(providerReply({ success: true })), { ok: true });
  assert.deepEqual(await run(providerReply({ success: false, "error-codes": ["invalid-input-response"] })), { ok: false, reason: "invalid" });
  assert.deepEqual(await run(providerReply({ success: false, "error-codes": ["timeout-or-duplicate"] })), { ok: false, reason: "reused" });
  assert.deepEqual(await run(providerReply({ success: false, "error-codes": ["token-expired"] })), { ok: false, reason: "expired" });
  assert.deepEqual(await run(providerReply({ success: false, "error-codes": ["invalid-input-secret"] })), { ok: false, reason: "misconfigured" });
  assert.deepEqual(await run(providerReply({ success: false })), { ok: false, reason: "rejected" });
  assert.deepEqual(await run(providerReply({ nope: 1 })), { ok: false, reason: "provider_error" });
  assert.deepEqual(await run(providerReply({}, false)), { ok: false, reason: "provider_error" });
  assert.deepEqual(await run(async () => ({ ok: true, json: async () => { throw new Error("private-provider-key"); } })), { ok: false, reason: "provider_error" });
  assert.deepEqual(await run(async () => { throw new TypeError("private-provider-key"); }), { ok: false, reason: "network" });
  assert.deepEqual(await run(async () => { throw new DOMException("x", "TimeoutError"); }), { ok: false, reason: "timeout" });
  assert.deepEqual(await run(providerReply({ success: true }), ""), { ok: false, reason: "missing_token" });
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const keepAlive = setTimeout(() => {}, 2000);
  assert.deepEqual(await verifyCaptcha({ provider: "turnstile", token: "t", secret: "s", fetchImpl: hang, timeoutMs: 10 }), { ok: false, reason: "timeout" });
  clearTimeout(keepAlive);
  let sent;
  await run(async (url, options) => { sent = options.body; return { ok: true, json: async () => ({ success: true }) }; });
  assert.equal(new URLSearchParams(sent).get("remoteip"), "203.0.113.9");
});

test("provider off never calls the verifier and leaves request and response shapes unchanged", async () => {
  const plain = harness({ OPENBLOG_CAPTCHA_PROVIDER: undefined, OPENBLOG_TURNSTILE_SECRET: undefined, OPENBLOG_CAPTCHA_SESSION_SECRET: undefined });
  const response = await plain.handler(event());
  assert.equal(response.statusCode, 202);
  assert.deepEqual(JSON.parse(response.body), { id: "id", status: "pending" });
  assert.deepEqual(plain.buckets(), ["comments"]);
  assert.equal(plain.provider().length, 0);
  const off = harness({ OPENBLOG_CAPTCHA_PROVIDER: "off" });
  const withIgnoredFields = await off.handler(event({ captchaToken: "ignored", captchaPass: "ignored" }));
  assert.equal(withIgnoredFields.body, response.body);
  assert.equal(off.provider().length, 0);
});

test("with captcha on, an unverified comment is refused before anything is stored", async () => {
  const run = harness();
  for (const extra of [{}, { captchaToken: "" }, { captchaPass: "" }]) {
    const absent = await run.handler(event(extra));
    assert.equal(absent.statusCode, 403);
    assert.equal(JSON.parse(absent.body).code, "captcha_required");
  }
  assert.equal(run.stored(), false);
  assert.equal(run.provider().length, 0);
  assert.deepEqual(run.buckets(), [], "missing proof is not a verification attempt");
});

test("a verified token is exchanged for a pass that authorizes later comments for the same site only", async () => {
  const run = harness();
  const verified = await run.handler(event({ captchaToken: "valid-token" }));
  assert.equal(verified.statusCode, 202);
  const result = JSON.parse(verified.body);
  assert.equal(result.captchaPassExpiresAt, time.getTime() / 1000 + 1800);
  assert.doesNotMatch(verified.body, /private-provider-key|private-database-key|test-signing-value/);
  assert.equal(run.provider().length, 1);
  assert.match(run.provider()[0].options.body, /remoteip=203.0.113.9/);
  run.requests.length = 0;
  const reused = await run.handler(event({ captchaPass: result.captchaPass }));
  assert.equal(reused.statusCode, 202);
  assert.equal(run.provider().length, 0);
  assert.equal("captchaPass" in JSON.parse(reused.body), false);
  assert.deepEqual(run.buckets(), ["comments"], "every comment still spends the comments quota");
  const other = harness({ OPENBLOG_SITE_ID: "other" });
  const refused = await other.handler(event({ captchaPass: result.captchaPass }));
  assert.equal(JSON.parse(refused.body).code, "captcha_required");
  assert.equal(other.stored(), false);
});

test("expired, forged and tampered passes are refused; expiry has its own code", async () => {
  const { pass } = issuePass("site", secret, time);
  const late = harness({}, { time: new Date(time.getTime() + 1800 * 1000) });
  const expired = await late.handler(event({ captchaPass: pass }));
  assert.equal(expired.statusCode, 403);
  assert.equal(JSON.parse(expired.body).code, "captcha_expired");
  assert.equal(late.stored(), false);
  const early = harness({}, { time: new Date(time.getTime() + 1799 * 1000) });
  assert.equal((await early.handler(event({ captchaPass: pass }))).statusCode, 202);
  const tampered = harness();
  const bad = await tampered.handler(event({ captchaPass: `${pass.slice(0, -3)}abc` }));
  assert.equal(JSON.parse(bad.body).code, "captcha_required");
  assert.equal(tampered.stored(), false);
  assert.deepEqual(tampered.buckets(), ["captcha"], "a rejected pass counts as an abuse attempt");
});

test("the configured lifetime is honored", async () => {
  const run = harness({ OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS: "600" });
  const result = JSON.parse((await run.handler(event({ captchaToken: "valid-token" }))).body);
  assert.equal(result.captchaPassExpiresAt, time.getTime() / 1000 + 600);
});

test("every-comment scope never issues or accepts a pass", async () => {
  const run = harness({ OPENBLOG_CAPTCHA_SCOPE: "every-comment", OPENBLOG_CAPTCHA_SESSION_SECRET: "" });
  const verified = await run.handler(event({ captchaToken: "valid-token" }));
  assert.equal(verified.statusCode, 202);
  assert.equal("captchaPass" in JSON.parse(verified.body), false);
  const { pass } = issuePass("site", secret, time);
  const withPass = harness({ OPENBLOG_CAPTCHA_SCOPE: "every-comment" });
  const refused = await withPass.handler(event({ captchaPass: pass }));
  assert.equal(JSON.parse(refused.body).code, "captcha_required");
  assert.equal(withPass.stored(), false);
});

test("failed verifications are rate limited in their own bucket, without touching comments", async () => {
  const failing = { provider: providerReply({ success: false, "error-codes": ["invalid-input-response"] }) };
  const run = harness({}, failing);
  const refused = await run.handler(event({ captchaToken: "bad" }));
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).code, "captcha_required");
  assert.deepEqual(run.buckets(), ["captcha"]);
  assert.equal(run.stored(), false);
  const limited = harness({}, { ...failing, deny: ["captcha"] });
  const tooMany = await limited.handler(event({ captchaToken: "bad" }));
  assert.equal(tooMany.statusCode, 429);
  assert.equal(JSON.parse(tooMany.body).code, "captcha_rate_limited");
  assert.equal(limited.stored(), false);
  let providerCalls = 0;
  const counted = harness({}, { deny: ["captcha"], provider: async () => { providerCalls += 1; return { ok: true, json: async () => ({ success: true }) }; } });
  assert.equal((await counted.handler(event({ captchaToken: "good" }))).statusCode, 429, "a full bucket refuses even a valid token");
  assert.equal(providerCalls, 0, "a full bucket never reaches the provider");
  assert.equal(counted.stored(), false);
  const commentsFull = harness({}, { deny: ["comments"] });
  assert.equal((await commentsFull.handler(event({ captchaToken: "good" }))).statusCode, 429);
});

test("provider outages and timeouts fail closed", async () => {
  for (const provider of [async () => { throw new TypeError("offline"); }, async () => { throw new DOMException("t", "TimeoutError"); }, providerReply("not json")]) {
    const run = harness({}, { provider });
    const refused = await run.handler(event({ captchaToken: "token" }));
    assert.equal(refused.statusCode, 403);
    assert.equal(run.stored(), false);
  }
});

test("enabled captcha with a missing or invalid variable answers 503 naming it, never a value", async () => {
  const cases = [["OPENBLOG_TURNSTILE_SECRET", ""], ["OPENBLOG_CAPTCHA_SESSION_SECRET", "short"], ["OPENBLOG_CAPTCHA_SCOPE", "sometimes"], ["OPENBLOG_CAPTCHA_PROVIDER", "mystery"]];
  for (const [name, value] of cases) {
    const run = harness({ [name]: value });
    const response = await run.handler(event({ captchaToken: "token" }));
    assert.equal(response.statusCode, 503);
    const body = JSON.parse(response.body);
    assert.equal(body.code, "captcha_unconfigured");
    assert.ok(body.error.includes(name), name);
    for (const secretValue of [secret, "private-provider-key", "private-database-key", value].filter((text) => text.length > 5)) assert.ok(!response.body.includes(secretValue), name);
    assert.equal(run.stored(), false);
    assert.equal(run.provider().length, 0);
  }
});

test("captcha runs after policy and field validation and before the rate limit", async () => {
  const invalid = harness();
  assert.equal((await invalid.handler({ ...event(), body: JSON.stringify({ path: "/post/", authorName: "", body: "x" }) })).statusCode, 422);
  assert.equal(invalid.provider().length, 0);
  const locked = createHandler({ env, now: () => time, siteFetchImpl: async () => ({ ok: true, json: async () => ({ "/post/": "locked" }) }), fetchImpl: async () => assert.fail("no provider or database call") });
  assert.equal((await locked(event())).statusCode, 403);
  const run = harness();
  await run.handler(event());
  assert.deepEqual(run.buckets(), []);
});

test("secrets are never written to the console", async () => {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args) => lines.push(args.join(" "));
  try {
    for (const state of [{}, { provider: async () => { throw new TypeError(secret); } }]) {
      const run = harness({}, state);
      await run.handler(event({ captchaToken: "the-token" }));
      await run.handler(event());
    }
  } finally { Object.assign(console, original); }
  assert.doesNotMatch(lines.join("\n"), /private-provider-key|the-token|test-signing-value/);
});
