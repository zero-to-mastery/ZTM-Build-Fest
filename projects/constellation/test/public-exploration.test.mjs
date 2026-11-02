import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubAccess } from "../src/github-access.mjs";
import {
  createPreviewData,
  createPreviewFetch,
  canRenderPreview,
  createPinnedFetch,
} from "../src/preview-data.mjs";
import { createGitHubRequestCache } from "../src/github-request-cache.mjs";
import { createRepositoryCommits } from "../src/repository-commits.mjs";
import { createCommitFieldData } from "../src/commit-field.mjs";
import {
  graphNodes,
  selectRepositories,
  renderConstellation,
} from "../src/constellation.mjs";
import {
  choicesFor,
  defaultIntent,
  recommendProjects,
} from "../src/onboarding-model.mjs";
import { generateGuidedDesign } from "../src/onboarding-generator.mjs";
import { analyzeDeveloperProfile } from "../src/engine.mjs";

const repo = (full_name = "alice/project") => ({
  name: full_name.split("/")[1],
  full_name,
  private: false,
  language: "JavaScript",
  topics: ["tools"],
  description: "Public project",
  stargazers_count: 3,
  created_at: "2020-01-01",
  updated_at: "2026-01-01",
  default_branch: "main",
});
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
};

test('anonymous project structure access is limited to explicit scan endpoints', async () => {
  const calls = [];
  const fetchImpl = createPreviewFetch({ fetchImpl: async url => { calls.push(url); return Response.json({}); } });
  await fetchImpl('https://api.github.com/repos/alice/project/commits/main');
  await fetchImpl('https://api.github.com/repos/alice/project/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1');
  await fetchImpl('https://api.github.com/repos/alice/project/contents/package.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(calls.length, 3);
  await assert.rejects(fetchImpl('https://api.github.com/repos/alice/project/issues'), /Sign in/);
  await assert.rejects(fetchImpl('https://api.github.com/repos/alice/project/git/trees/not-a-sha'), /Sign in/);
  await assert.rejects(fetchImpl('https://api.github.com/repos/alice/project/commits/main', { method: 'POST' }), /Sign in/);
  assert.equal(calls.length, 3);
});

for (const type of ["User", "Organization"])
  test(`anonymous ${type} load is bounded to two requests despite enrichment options`, async () => {
    const calls = [];
    const fetchImpl = createPreviewFetch({
      proxyBase: "https://shared.example/api/github",
      fetchImpl: async (url) => {
        calls.push(url);
        assert.equal(new URL(url).origin, "https://api.github.com");
        return Response.json(
          url.includes("/repos?")
            ? Array.from({ length: 100 }, (_, i) => repo(`alice/project${i}`))
            : { login: "alice", type, public_repos: 1200 },
        );
      },
    });
    const data = createPreviewData({ fetchImpl });
    const options = {
      maxRepos: 100,
      organizationScope: "all-metadata",
      organizationUser: "bob",
      includeRepos: ["team/missing"],
    };
    const loaded = await data.load("alice", options, {
      languages: true,
      activity: true,
    });
    assert.equal(loaded.length, 100);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /sort=updated&per_page=100&page=1/);
    assert.equal(
      new URL(calls[1]).pathname,
      `/${type === "User" ? "users" : "orgs"}/alice/repos`,
    );
    assert.ok(loaded.every((value) => value.languages === undefined));
    await data.load("alice", { maxRepos: 10, colors: {}, layout: "orbital" });
    assert.equal(calls.length, 2);
    await data.load("alice", options, { refresh: true });
    assert.equal(calls.length, 4);
  });

test("primary-language metadata supports filters, recommendations, graph and guided generation", () => {
  const repositories = [repo()];
  const options = { languages: ["JavaScript"], maxRepos: 10 };
  assert.equal(selectRepositories(repositories, options).length, 1);
  assert.equal(
    selectRepositories(repositories, { languages: ["CSS"] }).length,
    0,
  );
  assert.ok(graphNodes(repositories, options).nodes.length);
  assert.equal(
    canRenderPreview(repositories, options, createGitHubAccess()),
    true,
  );
  assert.deepEqual(recommendProjects(repositories), ["alice/project"]);
  assert.ok(
    choicesFor(repositories, ["alice/project"], 2026).languages.includes(
      "JavaScript",
    ),
  );
  const generated = generateGuidedDesign(
    "alice",
    repositories,
    defaultIntent(repositories),
    { seed: "public", year: 2026, activityAvailable: false },
  );
  assert.match(
    renderConstellation("alice", repositories, generated.config.options),
    /<svg/,
  );
  assert.equal(repositories[0].languages, undefined);
  const evidence = analyzeDeveloperProfile({
    repositories: [
      {
        name: "alice/systems",
        languages: {},
        language_names: ["Rust"],
        topics: [],
      },
    ],
  });
  assert.ok(
    evidence.dimensions.find((dimension) => dimension.id === "systems").score >
      0,
  );
  assert.match(
    renderConstellation("alice", repositories, {
      ...options,
      arrangement: "temporal-stack",
      temporalStack: { enabled: true, axis: "language" },
    }),
    /JavaScript/,
  );
});

test("public manual additions cost one call, survive refresh/reload, and stop at ten lookups", async () => {
  const calls = [],
    disk = storage();
  const fetchImpl = createPreviewFetch({
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(
        url.includes("/repos?")
          ? [repo()]
          : url.includes("/repos/")
            ? repo(new URL(url).pathname.slice(7))
            : { login: "alice", type: "User" },
      );
    },
  });
  const data = createPreviewData({ fetchImpl, storage: disk });
  await data.load("alice", {});
  const external = await data.contributed.repository(
    "https://github.com/team/other",
  );
  assert.equal(calls.length, 3);
  data.remember("alice", [external]);
  await data.load("alice", { includeRepos: ["team/other"] });
  assert.equal(calls.length, 3);
  assert.equal(
    canRenderPreview(
      data.snapshot("alice"),
      { includeRepos: ["team/other"] },
      data.access,
    ),
    true,
  );
  await data.load("alice", {}, { refresh: true });
  assert.ok(
    data.snapshot("alice").some((value) => value.full_name === "team/other"),
  );
  assert.ok(
    createPreviewData({ storage: disk })
      .snapshot("alice")
      .some((value) => value.full_name === "team/other"),
  );
  for (let i = 0; i < 9; i++)
    await data.contributed.repository(`team/extra${i}`);
  const before = calls.length;
  await assert.rejects(
    data.contributed.repository("team/eleventh"),
    /10 manual.*sign in/i,
  );
  assert.equal(calls.length, before);
  assert.equal(
    (await data.contributed.repository("team/other")).full_name,
    "team/other",
  );
});

test("public acquisition gates stop every expensive entry point before the first request", async () => {
  let calls = 0;
  const fetchImpl = createPreviewFetch({
    fetchImpl: async () => {
      calls++;
      throw Error("unexpected request");
    },
  });
  const data = createPreviewData({ fetchImpl });
  await assert.rejects(data.load("alice", { repoSource: "pinned" }), /sign-in/);
  await assert.rejects(data.load("alice", { nodeMode: "commits" }), /Sign in/);
  await assert.rejects(data.loadActivity("alice"), /Sign in/);
  await assert.rejects(data.contributed.discover("alice"), /manually/);
  await assert.rejects(
    createRepositoryCommits({ fetchImpl }).load("alice/project"),
    /Sign in/,
  );
  const field = await createCommitFieldData({ fetchImpl }).load([repo()]);
  assert.match(field.diagnostics.join(" "), /Sign in/);
  for (const path of [
    "repos/alice/project/languages",
    "search/issues?q=author:alice",
    "users/alice/events/public",
    "repos/alice/project/contributors",
    "repos/alice/project/commits",
    "users/alice/repos?page=2",
    "graphql",
  ])
    await assert.rejects(
      fetchImpl(`https://api.github.com/${path}`),
      /Sign in/,
    );
  await assert.rejects(
    createPinnedFetch({ proxyBase: "/api/github", fetchImpl })("alice"),
    /Continue with GitHub/,
  );
  assert.equal(calls, 0);
});

test("public rate-limit response stops retries and preserves the previous repository snapshot", async () => {
  let limited = false,
    calls = 0;
  const fetchImpl = createPreviewFetch({
    fetchImpl: async (url) => {
      calls++;
      if (limited)
        return Response.json(
          {},
          {
            status: 403,
            headers: {
              "x-ratelimit-limit": "60",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 3600),
              "x-ratelimit-resource": "core",
            },
          },
        );
      return Response.json(
        url.includes("/repos?") ? [repo()] : { login: "alice", type: "User" },
      );
    },
  });
  const data = createPreviewData({ fetchImpl });
  const previous = await data.load("alice", {});
  limited = true;
  await assert.rejects(
    data.load("alice", {}, { refresh: true }),
    /public request allowance.*Sign in/,
  );
  await assert.rejects(
    data.contributed.repository("team/new"),
    /public request allowance/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(data.snapshot("alice"), previous);
  assert.equal(
    (await (await fetchImpl("https://api.github.com/users/alice")).json())
      .login,
    "alice",
  );
  assert.equal(
    calls,
    3,
    "failed refresh retains the prior public HTTP response too",
  );
  assert.equal(fetchImpl.requestCache.publicRateLimit().remaining, 0);
  assert.equal(fetchImpl.requestCache.publicRateLimit().resource, "core");
  assert.equal(canRenderPreview(previous, {}, data.access), true);
});

test("public quota reserve serves cached data, suppresses network and isolates authenticated capacity", async () => {
  let calls = 0,
    time = 100000;
  const cache = createGitHubRequestCache({
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return Response.json([repo()], {
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "5",
          "x-ratelimit-reset": "200",
        },
      });
    },
  });
  const publicOptions = { publicBudget: true },
    url = "https://api.github.com/users/alice/repos";
  await cache.fetch(url, {}, publicOptions);
  assert.ok(cache.publicRateLimit().stopped);
  await cache.fetch(url, {}, publicOptions);
  await assert.rejects(
    cache.fetch(url + "?page=1", {}, publicOptions),
    /Sign in/,
  );
  assert.equal(calls, 1);
  await cache.fetch(url, {}, { authContext: "token" });
  assert.equal(calls, 2);
  time = 200001;
  await cache.fetch(url + "?page=1", {}, publicOptions);
  assert.equal(calls, 3);
});

test("sign-in upgrades a public snapshot to full pagination, languages and activity", async () => {
  const calls = [];
  const respond = async (url) => {
    calls.push(url);
    if (url.includes("/languages"))
      return Response.json({ JavaScript: 100, CSS: 40 });
    if (url.includes("/events/public")) return Response.json([]);
    if (url.includes("/repos?"))
      return Response.json(
        url.includes("page=2")
          ? [repo("alice/older")]
          : Array.from({ length: 100 }, (_, i) => repo(`alice/project${i}`)),
      );
    return Response.json({ login: "alice", type: "User" });
  };
  const session = { token: "", fetch: respond };
  const fetchImpl = createPreviewFetch({ session, fetchImpl: respond });
  const data = createPreviewData({ fetchImpl });
  await data.load("alice", { maxRepos: 1 });
  assert.equal(calls.length, 2);
  assert.equal(data.access.mode, "public");
  session.token = "test-token";
  const loaded = await data.load("alice", { maxRepos: 1 });
  assert.equal(data.access.mode, "authenticated");
  assert.equal(loaded.length, 101);
  assert.ok(calls.some((url) => url.includes("page=2")));
  assert.ok(calls.some((url) => url.includes("/languages")));
  assert.ok(calls.some((url) => url.includes("/events/public")));
  assert.ok(loaded.some((value) => value.languages?.CSS === 40));
  session.token = "";
  const before = calls.length;
  await assert.rejects(data.loadActivity("alice", true), /Sign in/);
  assert.equal(calls.length, before);
});

test("manual lookup budget survives session reload and retains cached older owned projects", async () => {
  const disk = storage();
  let calls = 0;
  const fetchImpl = createPreviewFetch({
    fetchImpl: async (url) => {
      calls++;
      return Response.json(
        url.includes("/repos?")
          ? [repo()]
          : url.includes("/repos/")
            ? repo(new URL(url).pathname.slice(7))
            : { login: "alice", type: "User" },
      );
    },
  });
  const data = createPreviewData({ fetchImpl, storage: disk });
  await data.load("alice", {});
  for (let index = 0; index < 10; index++)
    data.remember("alice", [
      await data.contributed.repository(`alice/old${index}`),
    ]);
  await data.load("alice", {}, { refresh: true });
  assert.equal(data.snapshot("alice").length, 11);
  const restored = createPreviewData({ fetchImpl, storage: disk });
  const before = calls;
  assert.equal(
    (await restored.contributed.repository("alice/old0")).full_name,
    "alice/old0",
  );
  await assert.rejects(
    restored.contributed.repository("team/new"),
    /10 manual/,
  );
  assert.equal(calls, before);
});

test("concurrent public calls reserve capacity already used by an in-flight request", async () => {
  let calls = 0,
    complete;
  const cache = createGitHubRequestCache({
    fetchImpl: async () => {
      calls++;
      if (calls === 2)
        await new Promise((resolve) => {
          complete = resolve;
        });
      return Response.json(
        {},
        { headers: { "x-ratelimit-remaining": calls === 1 ? "6" : "5" } },
      );
    },
  });
  const options = { publicBudget: true };
  await cache.fetch("https://api.github.com/users/alice", {}, options);
  const pending = cache.fetch(
    "https://api.github.com/repos/alice/one",
    {},
    options,
  );
  await assert.rejects(
    cache.fetch("https://api.github.com/repos/alice/two", {}, options),
    /Sign in/,
  );
  assert.equal(calls, 2);
  complete();
  await pending;
});

test("rate limiting without reset headers does not promise a reset time or retry", async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const cache = createGitHubRequestCache({
      fetchImpl: async () => {
        calls++;
        return Response.json({}, { status });
      },
    });
    const read = () =>
      cache.fetch(
        "https://api.github.com/users/alice",
        {},
        { publicBudget: true },
      );
    await assert.rejects(
      read(),
      (error) => /Sign in/.test(error.message) && !/Reset:/.test(error.message),
    );
    await assert.rejects(read(), /Sign in/);
    assert.equal(calls, 1);
  }
});
