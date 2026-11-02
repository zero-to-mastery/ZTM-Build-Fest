import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { createPreviewServer } from "../scripts/preview-server.mjs";
import { createPreviewFetch, createPreviewData } from "../src/preview-data.mjs";

async function serve(t, options) {
  const server = createPreviewServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("studio serves the Rust binary and its modules with usable MIME types", async (t) => {
  const base = await serve(t);
  const wasm = await fetch(`${base}/src/wasm/constellation_core_bg.wasm`);
  assert.equal(wasm.status, 200);
  assert.match(wasm.headers.get("content-type"), /^application\/wasm/);
  assert.ok(WebAssembly.validate(await wasm.arrayBuffer()));
  for (const path of [
    "engine.mjs",
    "app/boot.mjs",
    "story-clarity.mjs",
    "scene-framing.mjs",
    "wasm/constellation_core.js",
  ]) {
    const response = await fetch(`${base}/src/${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/javascript/);
  }
});

test("local studio authenticates upstream only, retains data, and never serves .env", async (t) => {
  const calls = [];
  const token = "test-local-secret";
  const base = await serve(t, {
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (/\/users\/[^/?]+$/.test(url))
        return Response.json({ login: "octocat", type: "User" });
      return Response.json(
        url.includes("/users/")
          ? [{ name: "demo", full_name: "octocat/demo" }]
          : { JavaScript: 100 },
      );
    },
  });
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('name="constellation-api" content="/api/github"'));
  assert.ok(html.includes('name="constellation-auth" content="authenticated"'));
  assert.ok(!html.includes(token));
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  const data = createPreviewData({
    fetchImpl: createPreviewFetch({ proxyBase: `${base}/api/github`, localAuth: true }),
  });
  await data.load("octocat", { maxRepos: 5 });
  await data.load("octocat", { maxRepos: 5 });
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every(
      ({ url, options }) =>
        url.startsWith("https://api.github.com/") &&
        !url.includes(token) &&
        options.headers.Authorization === `Bearer ${token}`,
    ),
  );
  assert.ok(!JSON.stringify(data.snapshot("octocat")).includes(token));
});

test("missing token uses public requests and static deployments do not use a proxy", async (t) => {
  let headers;
  const base = await serve(t, {
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return Response.json([]);
    },
  });
  assert.ok(
    (await (await fetch(base)).text()).includes(
      'name="constellation-auth" content="public"',
    ),
  );
  await fetch(`${base}/api/github/users/octocat/repos`);
  assert.equal(headers.Authorization, undefined);
  const calls = [];
  const publicFetch = createPreviewFetch({
    fetchImpl: async (url) => calls.push(url),
  });
  await publicFetch("https://api.github.com/users/octocat/repos");
  assert.deepEqual(calls, ["https://api.github.com/users/octocat/repos"]);
});

test("commit history proxy supports branch pagination and forwards pagination links", async (t) => {
  let requested;
  const link =
    '<https://api.github.com/repos/example/repo/commits?page=2>; rel="next"';
  const base = await serve(t, {
    fetchImpl: async (url) => {
      requested = url;
      return Response.json([], { headers: { link } });
    },
  });
  const response = await fetch(
    `${base}/api/github/repos/example/repo/commits?sha=feature%2Fgraph&per_page=100&page=1`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("link"), link);
  assert.equal(new URL(requested).searchParams.get("sha"), "feature/graph");
  assert.equal(
    (
      await fetch(
        `${base}/api/github/repos/example/repo/commits?url=https://example.com`,
      )
    ).status,
    404,
  );
});

test("proxy forwards conditional ETag requests and preserves 304 responses", async (t) => {
  let forwardedHeaders;
  const base = await serve(t, {
    fetchImpl: async (_url, options) => {
      forwardedHeaders = new Headers(options.headers);
      return new Response(null, {
        status: 304,
        headers: { etag: '"snapshot-v1"' },
      });
    },
  });
  const response = await fetch(`${base}/api/github/users/octocat`, {
    headers: { "If-None-Match": '"snapshot-v1"' },
  });
  assert.equal(forwardedHeaders.get("if-none-match"), '"snapshot-v1"');
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"snapshot-v1"');
});

test("contribution search proxy permits public authors across organizations and rejects arbitrary queries", async (t) => {
  const base = await serve(t, {
    fetchImpl: async () => Response.json({ items: [] }),
  });
  for (const [endpoint, query] of [
    ["issues", "author:alice is:pr is:public"],
    ["issues", "author:alice org:chingu-voyages is:pr is:public"],
    ["commits", "author:alice is:public"],
    ["commits", "author:alice org:code-the-dream is:public"],
  ]) {
    assert.equal(
      (
        await fetch(
          `${base}/api/github/search/${endpoint}?q=${encodeURIComponent(query)}&page=1&per_page=100&sort=created&order=desc`,
        )
      ).status,
      200,
    );
  }
  for (const query of [
    "author:alice is:private",
    "author:alice is:public OR is:private",
    "org:team is:public",
  ]) {
    assert.equal(
      (
        await fetch(
          `${base}/api/github/search/commits?q=${encodeURIComponent(query)}`,
        )
      ).status,
      404,
    );
  }
  assert.equal(
    (await fetch(`${base}/src/contributed-repositories.mjs`)).status,
    200,
  );
});

test("proxy rejects foreign origins, unexpected hosts, writes, and non-allowlisted endpoints", async (t) => {
  let calls = 0;
  const base = await serve(t, {
    token: "test-token",
    fetchImpl: async () => {
      calls++;
      return Response.json([]);
    },
  });
  const path = `${base}/api/github/users/octocat/repos`;
  assert.equal(
    (await fetch(path, { headers: { Origin: "https://example.com" } })).status,
    403,
  );
  assert.equal(
    (await fetch(path, { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) => {
    get(path, { headers: { Host: "example.com" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(path, { method: "POST" })).status, 405);
  for (const route of [
    "/api/github/users/octocat/events",
    "/api/github/users/octocat/events/public?private=true",
    "/api/github/user",
    "/api/github/repos/owner/project/contents",
    "/api/github/users/octocat/repos?url=https://example.com",
  ]) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  assert.equal(calls, 0);
});

test("upstream failures preserve status and rate limits without leaking server errors", async (t) => {
  const token = "private-test-token";
  const base = await serve(t, {
    token,
    fetchImpl: async () =>
      new Response(token, {
        status: 429,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  });
  const result = await fetch(`${base}/api/github/repos/octocat/demo/languages`);
  assert.equal(result.status, 429);
  assert.equal(result.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(!(await result.text()).includes(token));
  const failed = await serve(t, {
    token,
    fetchImpl: async () => {
      throw Error(token);
    },
  });
  const error = await fetch(`${failed}/api/github/users/octocat/repos`);
  assert.equal(error.status, 502);
  assert.ok(!(await error.text()).includes(token));
});

test("pinned endpoint runs a fixed server-side query without exposing the token or private pins", async (t) => {
  const token = "private-test-token";
  let request;
  const base = await serve(t, {
    token,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        data: {
          repositoryOwner: {
            pinnedItems: {
              nodes: [
                {
                  name: "public",
                  nameWithOwner: "other/public",
                  isPrivate: false,
                  isFork: false,
                  stargazerCount: 1,
                  primaryLanguage: { name: "Rust" },
                  repositoryTopics: { nodes: [] },
                },
                {
                  name: "secret",
                  nameWithOwner: "other/secret",
                  isPrivate: true,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    },
  });
  const response = await fetch(`${base}/api/github/users/octocat/pinned`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes(token) && !body.includes("other/secret"));
  assert.equal(JSON.parse(body)[0].full_name, "other/public");
  assert.equal(request.url, "https://api.github.com/graphql");
  assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
  assert.equal(JSON.parse(request.options.body).variables.login, "octocat");
  assert.equal(
    (await fetch(`${base}/api/github/users/octocat/pinned?query=anything`))
      .status,
    404,
  );
  assert.equal(
    (await fetch(`${base}/api/github/graphql`, { method: "POST" })).status,
    405,
  );
  const unauthenticated = await serve(t);
  const missing = await fetch(
    `${unauthenticated}/api/github/users/octocat/pinned`,
  );
  assert.equal(missing.status, 401);
  assert.match(await missing.text(), /GH_TOKEN/);
});
