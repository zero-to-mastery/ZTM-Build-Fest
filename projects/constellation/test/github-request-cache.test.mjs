import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubRequestCache } from "../src/github-request-cache.mjs";
import { createContributedRepositories } from "../src/contributed-repositories.mjs";
import { createRepositoryCommits } from "../src/repository-commits.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRequestCache } from "../src/cli-request-cache.mjs";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("coalesces identical concurrent GETs and returns independently readable responses", async () => {
  let calls = 0;
  const cache = createGitHubRequestCache({
    fetchImpl: async () => {
      calls++;
      await Promise.resolve();
      return Response.json({ calls });
    },
  });
  const [first, second] = await Promise.all([
    cache.fetch("https://api.github.com/users/a/repos"),
    cache.fetch("https://api.github.com/users/a/repos"),
  ]);
  assert.deepEqual(await first.json(), { calls: 1 });
  assert.deepEqual(await second.json(), { calls: 1 });
  assert.equal(calls, 1);
  assert.equal(cache.statistics().sharedRequest, 1);
});

test("persists public bodies and revalidates expired entries with ETags", async () => {
  let time = 1000,
    calls = 0,
    conditional = false;
  const storage = memoryStorage();
  const fetchImpl = async (_url, options) => {
    calls++;
    if (new Headers(options.headers).has("if-none-match")) conditional = true;
    return conditional
      ? new Response(null, {
          status: 304,
          headers: { etag: "v1", "cache-control": "max-age=30" },
        })
      : Response.json({ public: true }, { headers: { etag: "v1" } });
  };
  let cache = createGitHubRequestCache({
    fetchImpl,
    storage,
    now: () => time,
    ttlMs: 50,
  });
  assert.deepEqual(
    await (await cache.fetch("https://api.github.com/repos/a/b")).json(),
    { public: true },
  );
  cache = createGitHubRequestCache({
    fetchImpl,
    storage,
    now: () => time,
    ttlMs: 50,
  });
  time += 51;
  const refreshed = await cache.fetch("https://api.github.com/repos/a/b");
  assert.equal(refreshed.status, 200);
  assert.deepEqual(await refreshed.json(), { public: true });
  assert.equal(conditional, true);
  assert.equal(calls, 2);
  assert.equal(cache.statistics().revalidation, 1);
});

test("CLI public response data survives separate cache instances and refresh bypasses disk", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "constellation-request-cache-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "requests.json");
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({ public: true });
  };
  const url = "https://api.github.com/users/octocat";
  await createCliRequestCache({ path, fetchImpl }).fetch(url);
  await createCliRequestCache({ path, fetchImpl }).fetch(url);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
  await createCliRequestCache({ path, fetchImpl, refresh: true }).fetch(url);
  assert.equal(calls, 2);
});

test("isolates authorization contexts, refresh bypasses cache, and abort is consumer-local", async () => {
  let calls = 0;
  const storage = memoryStorage();
  const cache = createGitHubRequestCache({
    fetchImpl: async (_url, options) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({
        authorization: new Headers(options.headers).get("authorization"),
      });
    },
    storage,
  });
  const controller = new AbortController();
  const canceled = cache.fetch("https://api.github.com/user", {
    headers: { Authorization: "token-a" },
    signal: controller.signal,
  });
  const survivor = cache.fetch("https://api.github.com/user", {
    headers: { Authorization: "token-a" },
  });
  controller.abort();
  await assert.rejects(canceled, { name: "AbortError" });
  assert.equal((await survivor).status, 200);
  await cache.fetch("https://api.github.com/user", {
    headers: { Authorization: "token-b" },
  });
  await cache.fetch("https://api.github.com/user", {
    headers: { Authorization: "token-a" },
    refresh: true,
  });
  assert.equal(calls, 3);
  const persisted = [...storage.values.values()].join("");
  assert.doesNotMatch(persisted, /token-a|token-b/);
  assert.equal(JSON.parse(persisted).entries.length, 0);
});

test("independent repository and commit loaders share metadata requests", async () => {
  const loadWith = async (fetchImpl) => {
    const contributions = createContributedRepositories({ fetchImpl });
    const commits = createRepositoryCommits({ fetchImpl });
    await Promise.all([
      contributions.repository("owner/repo"),
      commits.load("owner/repo", { limit: 1 }),
    ]);
  };
  let before = 0;
  const respond = async (url) => {
    return url.endsWith("/commits?per_page=1&page=1&sha=main")
      ? Response.json([])
      : Response.json({
          name: "repo",
          full_name: "owner/repo",
          private: false,
          default_branch: "main",
        });
  };
  const directFetch = async (url) => {
    before++;
    return respond(url);
  };
  await loadWith(directFetch);
  let after = 0;
  const cache = createGitHubRequestCache({
    fetchImpl: async (url, options) => {
      after++;
      return respond(url, options);
    },
  });
  await loadWith(cache.fetch);
  assert.deepEqual({ before, after }, { before: 3, after: 2 });
  assert.equal(cache.statistics().sharedRequest, 1);
});

test("an older in-flight response cannot overwrite a forced refresh", async () => {
  let calls = 0,
    finishOld;
  const oldStarted = new Promise((resolve) => {
    finishOld = resolve;
  });
  const cache = createGitHubRequestCache({
    fetchImpl: async () => {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          finishOld(() => resolve(Response.json({ version: "old" })));
        });
      return Response.json({ version: "fresh" });
    },
  });
  const url = "https://api.github.com/repos/owner/repo";
  const older = cache.fetch(url).then((response) => response.json());
  const releaseOld = await oldStarted;
  assert.deepEqual(await (await cache.fetch(url, { refresh: true })).json(), {
    version: "fresh",
  });
  releaseOld();
  await older;
  assert.deepEqual(await (await cache.fetch(url)).json(), { version: "fresh" });
  assert.equal(calls, 2);
});

test("rate-limit cooldown prevents retries, and failed responses remain retryable", async () => {
  let time = 100000,
    calls = 0;
  const cache = createGitHubRequestCache({
    now: () => time,
    fetchImpl: async (url) => {
      calls++;
      if (url.includes("/rate"))
        return calls === 1
          ? Response.json(
              { message: "limited" },
              { status: 429, headers: { "retry-after": "30" } },
            )
          : Response.json({ ok: true });
      return calls % 2
        ? Response.json({ message: "unavailable" }, { status: 503 })
        : Response.json({ ok: true });
    },
  });
  assert.equal((await cache.fetch("https://api.github.com/rate")).status, 429);
  await assert.rejects(
    cache.fetch("https://api.github.com/rate", { refresh: true }),
    /rate limit is active/,
  );
  assert.equal(calls, 1);
  time += 30001;
  assert.equal((await cache.fetch("https://api.github.com/rate")).status, 200);
  assert.equal(
    (await cache.fetch("https://api.github.com/temporary")).status,
    503,
  );
  assert.equal(
    (await cache.fetch("https://api.github.com/temporary")).status,
    200,
  );
  assert.equal(calls, 4);
});

test("rate-limit cooldown survives cache reconstruction without storing credentials", async () => {
  let time = 100000,
    calls = 0;
  const storage = memoryStorage();
  const fetchImpl = async () => {
    calls++;
    return Response.json(
      {},
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" },
      },
    );
  };
  await createGitHubRequestCache({ fetchImpl, storage, now: () => time }).fetch(
    "https://api.github.com/users/octocat",
  );
  const saved = [...storage.values.values()].join("");
  assert.doesNotMatch(saved, /Authorization|token/);
  const reloaded = createGitHubRequestCache({
    fetchImpl,
    storage,
    now: () => time + 1000,
  });
  await assert.rejects(
    reloaded.fetch("https://api.github.com/users/octocat"),
    /rate limit is active/,
  );
  assert.equal(calls, 1);
});

test("does not cache POST requests, including GraphQL bodies", async () => {
  let calls = 0;
  const cache = createGitHubRequestCache({
    fetchImpl: async () => {
      calls++;
      return Response.json({ data: { viewer: {} } });
    },
  });
  const request = () =>
    cache.fetch("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "query { viewer { login } }" }),
    });
  await request();
  await request();
  assert.equal(calls, 2);
  assert.equal(cache.statistics().entries, 0);
});

test("bounds cache entries and tolerates corrupt or unavailable persistence", async () => {
  const corrupt = memoryStorage({ "constellation-github-requests-v1": "{" });
  const cache = createGitHubRequestCache({
    fetchImpl: async (url) => Response.json({ url }),
    storage: corrupt,
    maxEntries: 1,
    maxBytes: 256,
  });
  await cache.fetch("https://api.github.com/repos/a/one");
  await cache.fetch("https://api.github.com/repos/a/two");
  assert.equal(cache.statistics().entries, 1);
  const unavailable = createGitHubRequestCache({
    fetchImpl: async () => Response.json({ ok: true }),
    storage: {
      getItem() {
        throw Error();
      },
      setItem() {
        throw Error();
      },
    },
  });
  assert.deepEqual(
    await (await unavailable.fetch("https://api.github.com/user")).json(),
    { ok: true },
  );
});
