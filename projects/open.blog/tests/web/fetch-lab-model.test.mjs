import test from "node:test";
import assert from "node:assert/strict";
import {
  presets, parseHeaders, handle, trace, snippet,
  createStorage, usage, setItem, getItem, removeItem, clear, QUOTA,
} from "../../web/components/ob-fetch-model.js";

test("every preset produces the outcome its label promises", () => {
  const status = Object.fromEntries(presets.map((p) => {
    const { headers } = parseHeaders(p.headers);
    return [p.label, trace({ method: p.method, path: p.path, headers, body: p.body })];
  }));
  assert.equal(status["List posts"].response.status, 200);
  assert.equal(status["Missing post (404)"].response.status, 404);
  assert.equal(status["Server error (500)"].response.status, 500);
  assert.equal(status["Broken JSON"].ok, true);
  assert.equal(status["Broken JSON"].json.ok, false);
  assert.equal(status["Not JSON at all"].json.ok, false);
  assert.equal(status["Network down"].response, null);
  assert.equal(status["Create post"].response.status, 201);
});

test("404 and 500 resolve but are not ok, and the lesson says so", () => {
  const { ok, lessons } = trace({ path: "/api/posts/99" });
  assert.equal(ok, false);
  assert.match(lessons[0], /response\.ok/);
});

test("POST validation: missing header, bad JSON, missing title", () => {
  const json = { "content-type": "application/json" };
  assert.equal(handle({ method: "POST", path: "/api/posts", body: '{"title":"x"}' }).status, 415);
  assert.equal(handle({ method: "POST", path: "/api/posts", headers: json, body: "{nope" }).status, 400);
  assert.equal(handle({ method: "POST", path: "/api/posts", headers: json, body: "{}" }).status, 422);
});

test("wrong verbs give 405 with an Allow header; unknown paths 404", () => {
  const res = handle({ method: "DELETE", path: "/api/posts" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET, POST");
  assert.equal(handle({ path: "/nope" }).status, 404);
});

test("paths tolerate origins, query strings and trailing slashes", () => {
  assert.equal(handle({ path: "https://example.test/api/posts/?page=2" }).status, 200);
});

test("parseHeaders lowercases names and reports malformed lines", () => {
  const { headers, ignored } = parseHeaders("Content-Type: application/json\nnonsense\nX-A: b: c");
  assert.deepEqual(headers, { "content-type": "application/json", "x-a": "b: c" });
  assert.deepEqual(ignored, ["nonsense"]);
});

test("snippet reflects method, headers and body", () => {
  const code = snippet({ method: "POST", path: "/api/posts", headers: "Content-Type: application/json", body: '{"a":1}' });
  assert.match(code, /method: "POST"/);
  assert.match(code, /"content-type": "application\/json"/);
  assert.match(code, /body: "\{\\"a\\":1\}"/);
  assert.match(snippet({ path: "/x" }), /^const response = await fetch\("\/x"\);/);
});

test("storage coerces to strings, so objects without stringify become [object Object]", () => {
  const empty = createStorage();
  assert.equal(setItem(empty, "a", { id: 1 }).stored, "[object Object]");
  assert.equal(setItem(empty, "a", JSON.stringify({ id: 1 })).stored, '{"id":1}');
});

test("quota is enforced, leaves storage untouched, and replacing a key reclaims space", () => {
  let storage = createStorage(20);
  storage = setItem(storage, "k", "x".repeat(10)).storage;
  const over = setItem(storage, "j", "y".repeat(10));
  assert.match(over.error, /QuotaExceededError/);
  assert.equal(over.storage, storage);
  assert.equal(setItem(storage, "k", "z".repeat(15)).error, undefined);
  assert.equal(usage(storage), 11);
  assert.ok(QUOTA > 100);
});

test("get, remove and clear", () => {
  let storage = setItem(createStorage(), "a", "1").storage;
  assert.equal(getItem(storage, "a"), "1");
  assert.equal(getItem(storage, "b"), null);
  assert.deepEqual(removeItem(storage, "a").items, {});
  assert.deepEqual(clear(storage).items, {});
  assert.equal(setItem(storage, "", "x").error, "Give the item a key.");
});
