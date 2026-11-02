import test from "node:test";
import assert from "node:assert/strict";
import handler, { config } from "../auth/netlify/functions/github-exchange.mjs";

const env = {
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "server-secret",
  GITHUB_REDIRECT_URI: "https://studio.example/",
  STUDIO_ORIGIN: "https://studio.example",
};
const request = (origin = env.STUDIO_ORIGIN, method = "POST") =>
  new Request("https://auth.example/api/github-exchange", {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify({ code: "code", code_verifier: "a".repeat(43) }) : undefined,
  });

// The function reads Netlify's environment and calls the shared exchange.
async function withEnvironment(values, fetchImpl, run) {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  for (const key of Object.keys(env)) delete process.env[key];
  Object.assign(process.env, values);
  globalThis.fetch = fetchImpl;
  try { return await run(); }
  finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("Netlify function exchanges a code using the site's environment", async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://github.com/login/oauth/access_token");
    sent = options.body;
    return Response.json({ access_token: "token", refresh_token: "refresh-secret" });
  };
  await withEnvironment(env, fetchImpl, async () => {
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { access_token: "token" });
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), env.STUDIO_ORIGIN);
    assert.equal(sent.get("client_secret"), env.GITHUB_CLIENT_SECRET);
    assert.equal(sent.get("redirect_uri"), env.GITHUB_REDIRECT_URI);
    // The browser's CORS preflight is answered for the Studio only.
    assert.equal((await handler(request(env.STUDIO_ORIGIN, "OPTIONS"))).status, 204);
    assert.equal((await handler(request("https://evil.example"))).status, 403);
  });
});

test("Netlify function refuses to run without its configuration", async () => {
  await withEnvironment({ ...env, GITHUB_CLIENT_SECRET: "" }, async () => assert.fail("must not call GitHub"), async () => {
    assert.equal((await handler(request())).status, 503);
  });
});

test("Netlify function has a fixed path and a per-visitor rate limit", () => {
  assert.equal(config.path, "/api/github-exchange");
  assert.deepEqual(config.rateLimit.aggregateBy, ["ip", "domain"]);
  assert.ok(config.rateLimit.windowLimit > 0 && config.rateLimit.windowSize <= 180);
});
