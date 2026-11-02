import { createGitHubAccess } from "../src/github-access.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createContributedRepositories,
  loadSelectedRepositories,
} from "../src/contributed-repositories.mjs";
import { createPreviewData } from "../src/preview-data.mjs";
import { graphNodes, renderConstellation } from "../src/constellation.mjs";

const repo = (full_name) => ({
  full_name,
  name: full_name.split("/")[1],
  private: false,
  language: "JavaScript",
  stargazers_count: 1,
});
const pr = (name) => ({
  user: { login: "alice" },
  pull_request: {},
  repository_url: `https://api.github.com/repos/${name}`,
});
const commit = (name) => ({
  author: { login: "alice" },
  repository: repo(name),
});

test("discovers team projects from both PRs and commits, deduplicates and validates public metadata", async () => {
  const calls = [];
  const client = createContributedRepositories({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/search/issues"))
        return Response.json({
          total_count: 4,
          items: [
            pr("chingu-voyages/team"),
            pr("chingu-voyages/team"),
            { ...pr("other/wrong-author"), user: { login: "bob" } },
            { ...pr("other/issue"), pull_request: null },
          ],
        });
      if (url.includes("/search/commits"))
        return Response.json({
          total_count: 2,
          items: [
            commit("chingu-voyages/team"),
            commit("code-the-dream/practicum"),
          ],
        });
      return Response.json({
        ...repo(new URL(url).pathname.slice(7)),
        permissions: { admin: true },
        temp_clone_token: "SECRET",
      });
    },
  });
  const found = await client.discover("alice");
  assert.deepEqual(
    found.repositories.map((item) => item.full_name),
    ["chingu-voyages/team", "code-the-dream/practicum"],
  );
  assert.equal(found.partial, false);
  assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify(found), /SECRET|permissions/);
  await client.repository("https://github.com/chingu-voyages/team/");
  assert.equal(calls.length, 4, "metadata reused");
  const scoped = await client.discover("alice", {
    organization: "chingu-voyages",
  });
  assert.deepEqual(
    scoped.repositories.map((item) => item.full_name),
    ["chingu-voyages/team"],
  );
  assert.ok(
    calls
      .slice(4)
      .every((url) =>
        new URL(url).searchParams.get("q").includes(" org:chingu-voyages "),
      ),
  );
});

test("pagination and partial search failures retain discovered projects", async () => {
  const pages = [];
  const client = createContributedRepositories({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/search/issues") {
        pages.push(parsed.searchParams.get("page"));
        return Response.json({
          total_count: 101,
          items:
            parsed.searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, () => pr("team/first"))
              : [pr("team/older")],
        });
      }
      if (parsed.pathname === "/search/commits")
        return Response.json({}, { status: 429 });
      return Response.json(repo(parsed.pathname.slice(7)));
    },
  });
  const result = await client.discover("alice");
  assert.deepEqual(pages, ["1", "2"]);
  assert.deepEqual(
    result.repositories.map((item) => item.full_name),
    ["team/first", "team/older"],
  );
  assert.equal(result.partial, true);
  assert.match(result.diagnostic, /limit reached.*incomplete/);
});

test("manual repository entry rejects invalid URLs and private repositories", async () => {
  let calls = 0;
  const client = createContributedRepositories({
    fetchImpl: async () => {
      calls++;
      return Response.json({ ...repo("team/secret"), private: true });
    },
  });
  for (const name of [
    "https://evil.test/team/repo",
    "team/../secret",
    "team/repo?token=secret",
  ])
    await assert.rejects(client.repository(name), /owner\/repository/);
  assert.equal(calls, 0);
  await assert.rejects(client.repository("team/secret"), /public repository/);
  await assert.rejects(
    client.discover("alice", { organization: "org is:private" }),
    /username/,
  );
});

test("explicit refresh bypasses selected-repository metadata snapshots", async () => {
  let calls = 0;
  const client = createContributedRepositories({
    fetchImpl: async () =>
      Response.json({ ...repo("team/repo"), description: String(++calls) }),
  });
  assert.equal((await client.repository("team/repo")).description, "1");
  assert.equal((await client.repository("team/repo")).description, "1");
  assert.equal(
    (await client.repository("team/repo", { refresh: true })).description,
    "2",
  );
  assert.equal(calls, 2);
});

test("explicit full names load outside owned repositories while pinned selections stay pinned", async () => {
  const client = createContributedRepositories({
    fetchImpl: async (url) =>
      Response.json(repo(new URL(url).pathname.slice(7))),
  });
  const owned = [repo("alice/owned")];
  const selected = {
    includeRepos: ["alice/owned", "team/practicum", "team/practicum"],
  };
  assert.deepEqual(
    (await loadSelectedRepositories(owned, selected, client)).map(
      (item) => item.full_name,
    ),
    ["alice/owned", "team/practicum"],
  );
  assert.deepEqual(
    await loadSelectedRepositories(
      owned,
      { ...selected, repoSource: "pinned" },
      client,
    ),
    owned,
  );
});

test("fresh preview loads and refreshes a saved team selection and retains it across sessions", async () => {
  const calls = [],
    saved = new Map();
  const settings = {
    storage: {
      getItem: (key) => saved.get(key),
      setItem: (key, value) => saved.set(key, value),
    },
    fetchImpl: async (url) => {
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === "/users/alice")
        return Response.json({ login: "alice", type: "User" });
      if (path === "/users/alice/repos")
        return Response.json([repo("alice/owned")]);
      if (path.endsWith("/events/public")) return Response.json([]);
      if (path.endsWith("/languages"))
        return Response.json({ JavaScript: 100 });
      return Response.json(repo(path.slice(7)));
    },
  };
  const options = { includeRepos: ["team/practicum"], maxRepos: 1 };
  let data = authenticatedPreviewData(settings);
  const loaded = await data.load("alice", options);
  assert.deepEqual(
    loaded.find((item) => item.full_name === "team/practicum").languages,
    { JavaScript: 100 },
  );
  const count = calls.length;
  data = authenticatedPreviewData(settings);
  await data.load("alice", options);
  assert.equal(calls.length, count);
  const refreshed = await data.load("alice", options, { refresh: true });
  assert.ok(
    refreshed.some(
      (item) => item.full_name === "team/practicum" && item.languages,
    ),
  );
  assert.equal(
    calls.filter((url) => url.endsWith("/repos/team/practicum")).length,
    2,
  );
});

test("personal-account contributor views load all seven selected team repositories and reuse cached scans", async () => {
  const names = [
    "Code-the-Dream-School/summer-26-js-practicum-team2",
    "chingu-voyages/v43-tier1-team-09",
    "chingu-voyages/v47-tier1-team-04",
    "chingu-voyages/v48-tier1-team-04",
    "chingu-voyages/v49-tier1-team-05",
    "chingu-voyages/v49-tier2-team-16",
    "chingu-voyages/v50-tier3-team-24",
  ];
  const calls = [],
    saved = new Map();
  const settings = {
    storage: {
      getItem: (key) => saved.get(key),
      setItem: (key, value) => saved.set(key, value),
    },
    fetchImpl: async (url) => {
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === "/users/mnichols08")
        return Response.json({ login: "mnichols08", type: "User" });
      if (path === "/users/mnichols08/repos")
        return Response.json([
          { ...repo("mnichols08/owned"), languages: { JavaScript: 100 } },
        ]);
      if (path.endsWith("/events/public")) return Response.json([]);
      if (path.endsWith("/languages"))
        return Response.json({ JavaScript: 100 });
      if (path.endsWith("/contributors"))
        return Response.json([
          { login: "mnichols08", contributions: 5 },
          { login: "teammate", contributions: 8 },
        ]);
      const canonical = names.find(
        (name) => name.toLowerCase() === path.slice(7).toLowerCase(),
      );
      assert.ok(canonical);
      return Response.json(repo(canonical));
    },
  };
  const data = authenticatedPreviewData(settings);
  await data.load("mnichols08", { maxRepos: 7 });
  assert.equal(
    calls.filter((url) => url.includes("/contributors")).length,
    0,
    "ordinary personal views do not scan contributors",
  );
  const options = {
    accountType: "auto",
    nodeMode: "contributors",
    maxRepos: 7,
    includeRepos: names,
    showOther: true,
    includeArchived: true,
    includeForks: true,
    organizationScope: "active",
    organization: {
      contributors: {
        enabled: true,
        strategy: "representative",
        maxRepositories: 100,
        maxContributorsPerRepo: 25,
      },
    },
  };
  for (const nodeMode of [
    "contributors",
    "ecosystem",
    "organization-community",
  ]) {
    const loaded = await data.load("mnichols08", { ...options, nodeMode });
    const snapshot = data.organization("mnichols08");
    assert.equal(snapshot.scanned, 7);
    assert.deepEqual(Object.keys(snapshot.records).sort(), [...names].sort());
    const graph = graphNodes(loaded, {
      ...options,
      nodeMode,
      accountData: data.profile("mnichols08"),
      organizationData: snapshot,
    });
    assert.deepEqual(
      graph.nodes
        .filter((node) => node.nodeKind === "contributor")
        .map((node) => node.name)
        .sort(),
      ["mnichols08", "teammate"],
    );
  }
  assert.equal(calls.filter((url) => url.includes("/contributors")).length, 7);
  const reloaded = authenticatedPreviewData(settings);
  const loaded = await reloaded.load("mnichols08", options);
  assert.equal(calls.filter((url) => url.includes("/contributors")).length, 7);
  assert.match(
    renderConstellation("mnichols08", loaded, {
      ...options,
      organizationData: reloaded.organization("mnichols08"),
    }),
    /data-kind="contributor"/,
  );
});

test("contributor empty states distinguish unrequested, disabled, failed and empty scans", async () => {
  const repos = [repo("team/practicum")];
  const options = { nodeMode: "contributors", showOther: true };
  const states = [
    [{}, /has not been loaded/],
    [
      { organization: { contributors: { enabled: false } } },
      /discovery is off/,
    ],
    [
      {
        organizationData: {
          records: {},
          diagnostic: "GitHub request limit reached.",
        },
      },
      /unavailable or incomplete/,
    ],
    [{ organizationData: { records: {} } }, /not been loaded for all selected/],
    [
      { organizationData: { records: { "team/practicum": [] }, scanned: 1 } },
      /No attributed contributors were found in the loaded results/,
    ],
  ];
  for (const [extra, message] of states) {
    const svg = renderConstellation("alice", repos, { ...options, ...extra });
    assert.match(svg, message);
    assert.doesNotMatch(svg, /No contributors in the matching repositories/);
  }
  const data = authenticatedPreviewData({
    fetchImpl: async (url) =>
      url.includes("/contributors")
        ? Response.json({}, { status: 429 })
        : url.includes("/events/")
          ? Response.json([])
          : url.includes("/repos?")
            ? Response.json(
                repos.map((repo) => ({
                  ...repo,
                  languages: { JavaScript: 100 },
                })),
              )
            : Response.json({ login: "alice", type: "User" }),
  });
  const loaded = await data.load("alice", options);
  assert.match(data.organization("alice").diagnostic, /limit reached/);
  assert.match(
    renderConstellation("alice", loaded, {
      ...options,
      organizationData: data.organization("alice"),
    }),
    /unavailable or incomplete/,
  );
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }
