import test from "node:test";
import assert from "node:assert/strict";
import {
  scenarios, createWorld, advance, changeReport, clearCache, clearCookies, exchange, cacheEntries,
  corsVerdict, runUnderTest, testSnippet, snippet, trace, presets, APP_ORIGIN, API_ORIGIN,
} from "../../web/components/ob-fetch-model.js";

const login = { method: "POST", path: `${API_ORIGIN}/login`, body: '{"user":"mika"}', credentials: "include" };
const me = (credentials, server) => ({ method: "GET", path: `${API_ORIGIN}/me`, credentials, server });

test("scenario ids and the original presets are unchanged", () => {
  assert.deepEqual(Object.keys(scenarios), ["login", "caching", "testing"]);
  assert.equal(presets.length, 8);
  assert.equal(trace({ path: "/api/posts/99" }).response.status, 404);
  assert.doesNotMatch(snippet({ path: "/x" }), /credentials/);
});

test("every scenario preset has a label and an explanation", () => {
  for (const scenario of Object.values(scenarios)) {
    for (const preset of scenario.presets) assert.ok(preset.label && preset.explain.length > 20, preset.label);
  }
});

test("login: Set-Cookie is kept only with credentials include", () => {
  const omitted = exchange(createWorld(), { ...login, credentials: "same-origin" });
  assert.equal(omitted.response.status, 200);
  assert.equal(omitted.world.cookie, null);
  const kept = exchange(createWorld(), login);
  assert.ok(kept.world.cookie);
  assert.match(kept.lessons[0], /HttpOnly/);
});

test("login: /me needs the cookie to be sent, which cross-origin means include", () => {
  const { world } = exchange(createWorld(), login);
  assert.equal(exchange(world, me("include")).response.status, 200);
  for (const mode of ["omit", "same-origin"]) {
    const result = exchange(world, me(mode));
    assert.equal(result.response.status, 401, mode);
    assert.equal(result.cookieSent, false);
    assert.match(result.lessons[0], /include/);
  }
  assert.equal(exchange(createWorld(), me("include")).response.status, 401);
  assert.match(exchange(createWorld(), me("include")).lessons[0], /Log in first/);
});

test("login: a path with no host is same-origin, so cookies go by default but not with omit", () => {
  const { world } = exchange(createWorld(), { ...login, path: "/login", credentials: "same-origin" });
  assert.ok(world.cookie);
  assert.equal(exchange(world, { path: "/me" }).response.status, 200);
  assert.equal(exchange(world, { path: "/me", credentials: "omit" }).response.status, 401);
});

test("login: a credentialed cross-origin response needs a specific origin and Allow-Credentials", () => {
  const { world } = exchange(createWorld(), login);
  const wildcard = exchange(world, me("include", { allowOrigin: "*", allowCredentials: true }));
  assert.equal(wildcard.response, null);
  assert.match(wildcard.blocked, /\*/);
  assert.equal(wildcard.wire.status, 200);
  const noFlag = exchange(world, me("include", { allowOrigin: APP_ORIGIN, allowCredentials: false }));
  assert.match(noFlag.blocked, /Allow-Credentials/);
  const none = exchange(world, me("include", { allowOrigin: "none", allowCredentials: true }));
  assert.match(none.blocked, /no Access-Control-Allow-Origin/);
  assert.equal(exchange(world, me("include", { allowOrigin: APP_ORIGIN, allowCredentials: true })).blocked, null);
});

test("login: a blocked login does not store the cookie", () => {
  const result = exchange(createWorld(), { ...login, server: { allowOrigin: "*", allowCredentials: true } });
  assert.ok(result.blocked);
  assert.equal(result.world.cookie, null);
});

test("cors: a wildcard is fine without credentials", () => {
  assert.equal(corsVerdict({ "access-control-allow-origin": "*" }, "omit"), null);
  assert.match(corsVerdict({ "access-control-allow-origin": "https://other.test" }, "omit"), /other\.test/);
});

test("login: bad requests and unknown hosts", () => {
  assert.equal(exchange(createWorld(), { ...login, body: "nope" }).response.status, 400);
  assert.equal(exchange(createWorld(), { ...login, method: "GET" }).response.status, 405);
  assert.equal(exchange(createWorld(), { path: "https://elsewhere.test/me" }).response, null);
  assert.equal(clearCookies(exchange(createWorld(), login).world).cookie, null);
});

const report = { method: "GET", path: "/report" };

test("caching: miss, then a hit from the cache within max-age without bothering the server", () => {
  const first = exchange(createWorld(), report);
  assert.equal(first.source, "network");
  assert.equal(first.wire.headers["cache-control"], "max-age=60");
  assert.equal(first.wire.headers.etag, '"v1"');
  const second = exchange(advance(first.world, 30), report);
  assert.equal(second.source, "cache");
  assert.equal(second.wire, null);
  assert.equal(second.response.headers.age, "30");
  assert.equal(second.world.serverHits, 1);
  assert.match(second.lessons[0], /cache/);
});

test("caching: after expiry the lab sends If-None-Match and gets a body-less 304", () => {
  const first = exchange(createWorld(), report);
  const stale = exchange(advance(first.world, 60), report);
  assert.equal(stale.source, "revalidated");
  assert.equal(stale.sent["if-none-match"], '"v1"');
  assert.equal(stale.wire.status, 304);
  assert.equal(stale.wire.body, "");
  assert.equal(stale.response.status, 200);
  assert.equal(stale.json.ok, true);
  assert.equal(stale.world.serverHits, 2);
  // The 304 refreshed the copy, so the next request is a hit again.
  assert.equal(exchange(advance(stale.world, 30), report).source, "cache");
});

test("caching: a changed report returns 200 and a new ETag after expiry", () => {
  const first = exchange(createWorld(), report);
  const world = changeReport(advance(first.world, 60));
  const result = exchange(world, report);
  assert.equal(result.source, "network");
  assert.equal(result.wire.status, 200);
  assert.equal(result.wire.headers.etag, '"v2"');
  assert.equal(result.sent["if-none-match"], '"v1"');
  assert.deepEqual(cacheEntries(result.world).map((e) => e.etag), ['"v2"']);
});

test("caching: changing the report does not matter while the copy is fresh", () => {
  const first = exchange(createWorld(), report);
  const fresh = exchange(changeReport(advance(first.world, 30)), report);
  assert.equal(fresh.source, "cache");
  assert.equal(fresh.json.value.version, 1);
});

test("caching: no-store is never saved and always reaches the server", () => {
  let world = createWorld();
  for (let i = 1; i <= 3; i++) {
    const result = exchange(world, { method: "GET", path: "/report-no-store" });
    assert.equal(result.source, "network");
    assert.equal(result.wire.headers["cache-control"], "no-store");
    world = result.world;
    assert.equal(world.serverHits, i);
  }
  assert.deepEqual(cacheEntries(world), []);
});

test("caching: clearing the cache forces a new miss; the clock is pretend", () => {
  const first = exchange(createWorld(), report);
  assert.equal(exchange(clearCache(first.world), report).source, "network");
  assert.equal(advance(createWorld()).now, 30);
  assert.equal(cacheEntries(advance(first.world, 61))[0].fresh, false);
});

test("testing: each stub produces the outcome its label promises", () => {
  const byLabel = Object.fromEntries(scenarios.testing.presets.map((p) => [p.label, runUnderTest(p)]));
  assert.deepEqual([byLabel.Success.outcome, byLabel.Success.value], ["returns", "Hello, fetch"]);
  assert.equal(byLabel["Not found (404)"].error.message, "HTTP 404");
  assert.equal(byLabel["Network error"].error.name, "TypeError");
  assert.equal(byLabel["Slow (timeout)"].error.name, "TimeoutError");
  assert.equal(byLabel["Broken JSON"].error.name, "SyntaxError");
});

test("testing: a slow stub inside the limit succeeds, and a body without a title returns undefined", () => {
  const body = '{"title": "ok"}';
  assert.equal(runUnderTest({ kind: "slow", status: 200, body, delay: 2000 }).value, "ok");
  const missing = runUnderTest({ kind: "response", status: 200, body: "{}" });
  assert.equal(missing.outcome, "returns");
  assert.equal(missing.value, undefined);
  assert.match(missing.lessons[0], /undefined/);
});

test("testing: the generated test code matches the outcome", () => {
  const [success, notFound, network, slow] = scenarios.testing.presets.map(testSnippet);
  assert.match(success, /assert\.equal\(await getPostTitle\(stub, 1\), "Hello, fetch"\)/);
  assert.match(notFound, /status: 404/);
  assert.match(notFound, /assert\.rejects/);
  assert.match(network, /throw new TypeError/);
  assert.match(slow, /TimeoutError/);
  assert.match(slow, /signal\.addEventListener/);
});

test("snippet includes the credentials option only when one is given", () => {
  assert.match(snippet({ path: "/me", credentials: "include" }), /credentials: "include",/);
});
