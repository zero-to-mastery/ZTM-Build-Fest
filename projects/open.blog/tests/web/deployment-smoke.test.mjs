import test from "node:test";
import assert from "node:assert/strict";
import { smoke } from "../../scripts/deployment-smoke.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const routes = {
    "https://blog.example/": [200, "text/html", '<link rel="stylesheet" href="/assets/base.css?v=1">'],
    "https://blog.example/assets/base.css?v=1": [200, "text/css", "body {}"],
    "https://blog.example/posts/test/": [200, "text/html", "<article>Post</article>"],
    "https://admin.example/admin/": [200, "text/html", "Admin"],
    "https://admin.example/admin/admin.css": [200, "text/css", ""],
    "https://admin.example/admin/admin.js": [200, "text/javascript", ""],
    "https://blog.example/api/views?path=%2Fposts%2Ftest%2F": [200, "application/json", '{"views":0}'],
    "https://blog.example/api/comments?path=%2Fposts%2Ftest%2F": [200, "application/json", '{"comments":[]}'],
    "https://blog.example/api/admin/analytics?days=7": [401, "application/json", "{}"],
    "https://blog.example/api/admin/comments?status=pending": [401, "application/json", "{}"],
    ...Object.fromEntries(["/admin", "/admin/", "/admin/admin.css"].map(path => [
      `https://blog.example${path}`, [302, "text/plain", "", `https://admin.example${path === "/admin" ? "/admin/" : path}`],
    ])),
    ...overrides,
  };
  return {
    calls,
    options: {
      origin: "https://blog.example",
      adminOrigin: "https://admin.example",
      postPath: "/posts/test/",
      log: () => {},
      fetchImpl: async (url, options) => {
        calls.push([String(url), options]);
        const route = routes[String(url)];
        assert.ok(route, `Unexpected request: ${url}`);
        const [status, contentType, body, location] = route;
        return new Response(body, {
          status, headers: { "content-type": contentType, ...(location && { location }) },
        });
      },
    },
  };
}

test("deployment smoke checks assets, posts, routing and auth without writes or credentials", async () => {
  const { options, calls } = fixture();
  await smoke(options);
  assert.equal(calls.length, 13);
  for (const [, request] of calls) {
    assert.equal(request.redirect, "manual");
    assert.equal(request.method, undefined);
    assert.equal(request.headers.Authorization, undefined);
  }
  assert.ok(!calls.some(([url]) => url.includes("/api/hit")));
});

for (const [name, override] of [
  ["missing stylesheet", { "https://blog.example/assets/base.css?v=1": [404, "text/html", "Not found"] }],
  ["HTML fallback instead of CSS", { "https://blog.example/assets/base.css?v=1": [200, "text/html", "Fallback"] }],
  ["missing post", { "https://blog.example/posts/test/": [404, "text/html", "Not found"] }],
  ["unprotected analytics", { "https://blog.example/api/admin/analytics?days=7": [200, "application/json", "{}"] }],
  ["wrong Admin origin", { "https://blog.example/admin": [302, "text/plain", "", "https://wrong.example/admin/"] }],
  ["invalid view shape", { "https://blog.example/api/views?path=%2Fposts%2Ftest%2F": [200, "application/json", '{"views":"0"}'] }],
]) {
  test(`deployment smoke fails explicitly for ${name}`, async () => {
    await assert.rejects(smoke(fixture(override).options));
  });
}

test("rejects credential-bearing origins before making requests", async () => {
  const { options, calls } = fixture();
  await assert.rejects(smoke({ ...options, origin: "https://user:secret@blog.example" }));
  assert.equal(calls.length, 0);
});

const PROTECTED_POST = '<article><ob-comments path="/posts/test/" endpoint="https://blog.example/api" captcha-provider="turnstile" captcha-site-key="public" captcha-scope="session"></ob-comments></article>';
const refusal = [403, "application/json", '{"code":"captcha_required"}'];

test("optional captcha smoke requires a machine-readable rejection of unverified and forged submissions", async () => {
  const { options, calls } = fixture({ "https://blog.example/posts/test/": [200, "text/html", PROTECTED_POST], "https://blog.example/api/comments": refusal });
  await smoke({ ...options, captcha: true });
  const posts = calls.filter(([, request]) => request.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0][1].body).path, "/posts/test/");
  assert.equal(JSON.parse(posts[1][1].body).captchaPass, "forged.pass");
  assert.ok(posts.every(([, request]) => request.headers.Authorization === undefined && !("captchaToken" in JSON.parse(request.body))));
});

test("captcha smoke detects a site that accepts unverified comments or lacks the public attributes", async () => {
  const accepted = fixture({ "https://blog.example/posts/test/": [200, "text/html", PROTECTED_POST], "https://blog.example/api/comments": [202, "application/json", '{"status":"pending"}'] });
  await assert.rejects(smoke({ ...accepted.options, captcha: true }), /accepted an unverified comment/);
  const unprotectedPage = fixture({ "https://blog.example/api/comments": refusal });
  await assert.rejects(smoke({ ...unprotectedPage.options, captcha: true }), /public captcha attributes/);
  const wrongCode = fixture({ "https://blog.example/posts/test/": [200, "text/html", PROTECTED_POST], "https://blog.example/api/comments": [403, "application/json", '{"error":"Origin is not allowed."}'] });
  await assert.rejects(smoke({ ...wrongCode.options, captcha: true }), /captcha_required/);
});

test("captcha smoke explains a misconfigured function and never sends a secret", async () => {
  const body = '{"code":"captcha_unconfigured","error":"Comment verification is enabled but OPENBLOG_TURNSTILE_SECRET is not set correctly."}';
  const broken = fixture({ "https://blog.example/posts/test/": [200, "text/html", PROTECTED_POST], "https://blog.example/api/comments": [503, "application/json", body] });
  await assert.rejects(smoke({ ...broken.options, captcha: true }), /misconfigured.*captcha_unconfigured.*OPENBLOG_TURNSTILE_SECRET/s);
});

test("without --captcha the smoke never POSTs, even to a protected site", async () => {
  const { options, calls } = fixture({ "https://blog.example/posts/test/": [200, "text/html", PROTECTED_POST] });
  await smoke(options);
  assert.ok(!calls.some(([, request]) => request.method === "POST"));
});
