import { createGitHubAccess } from "../src/github-access.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createOrganizationData,
  attachFocusEvidence,
} from "../src/organization/data.mjs";
import {
  representativeRepositories,
  groupRepository,
} from "../src/organization/model.mjs";
import { organizationOptions } from "../src/organization/settings.mjs";
import { graphNodes, renderConstellation } from "../src/constellation.mjs";
import { serializeConfig, parseConfig } from "../src/config-schema.mjs";
import { renderWorkflow } from "../src/export.mjs";
import { createPreviewData } from "../src/preview-data.mjs";
import { artifactPositions } from "../src/artifact-layouts.mjs";
import { organizationPositions } from "../src/organization/graph.mjs";
import { mappedColor } from "../src/visual-mapping.mjs";
const repositories = (count) =>
  Array.from({ length: count }, (_, i) => ({
    name: `v${i % 12}-tier${i % 3}-team-${i}`,
    full_name: `community/v${i % 12}-tier${i % 3}-team-${i}`,
    private: false,
    created_at: `${2014 + (i % 12)}-01-01T00:00:00Z`,
    updated_at: "2026-01-01T00:00:00Z",
    pushed_at: "2026-01-01T00:00:00Z",
    language: i % 2 ? "Rust" : "JavaScript",
    languages: { [i % 2 ? "Rust" : "JavaScript"]: 100 },
    topics: [`topic-${i % 8}`],
    dependencies: ["example-package"],
    stargazers_count: count - i,
  }));
const options = {
  accountType: "organization",
  organizationView: "collaboration",
  organizationScope: "featured",
  arrangement: "community-galaxy",
  maxRepos: 100,
  showOther: true,
  animate: false,
  organization: { grouping: { mode: "year" } },
};

test("personal and organization galaxies share project and technology anchors", () => {
  const repos = repositories(30);
  const common = {
    maxRepos: 100,
    showOther: true,
    seedMode: "custom",
    seed: "shared-map",
    nodeColorMode: "language",
    nodeSize: "stars",
  };
  const personal = graphNodes(repos, { ...common, nodeMode: "combined" });
  const orgOptions = {
    ...common,
    accountType: "organization",
    organizationScope: "featured",
    organizationView: "collaboration",
    organization: { grouping: { mode: "language" } },
    organizationData: {
      records: Object.fromEntries(
        repos
          .slice(0, 5)
          .map((repo) => [
            repo.full_name,
            [{ login: "alice", contributions: 2 }],
          ]),
      ),
    },
  };
  const org = graphNodes(repos, orgOptions);
  assert.equal(
    org.repositoryCount,
    30,
    "incomplete contributor scans do not remove unscanned projects",
  );
  for (const compact of [false, true]) {
    const projects = artifactPositions(repos, "galaxy", "shared-map", compact);
    const combined = artifactPositions(
      personal.nodes,
      "galaxy",
      "shared-map",
      compact,
    );
    const community = organizationPositions(
      org,
      "community-galaxy",
      compact,
      "shared-map",
    );
    assert.deepEqual(
      community,
      organizationPositions(
        { ...org, nodes: [...org.nodes].reverse() },
        "community-galaxy",
        compact,
        "shared-map",
      ),
    );
    for (const repo of repos) {
      assert.deepEqual(combined[repo.full_name], projects[repo.full_name]);
      assert.deepEqual(community[repo.full_name], projects[repo.full_name]);
    }
    for (const node of personal.nodes) {
      const counterpart = org.nodes.find(
        (value) => value.full_name === node.full_name,
      );
      assert.ok(counterpart);
      assert.deepEqual(
        community[node.full_name],
        combined[node.full_name],
        "shared categories keep their location",
      );
      assert.equal(
        mappedColor(node, "language"),
        mappedColor(counterpart, "language"),
        "node colors have the same meaning",
      );
    }
    for (const point of Object.values(community)) {
      assert.ok(point.x >= 32 && point.x <= 868);
      assert.ok(point.y >= 28 && point.y <= (compact ? 220 : 500));
    }
    const contributor = community["contributor:alice"];
    assert.ok(
      Object.entries(community)
        .filter(([id]) => id !== "contributor:alice")
        .every(
          ([, point]) =>
            Math.hypot(point.x - contributor.x, point.y - contributor.y) >=
            (compact ? 16 : 23),
        ),
    );
  }
  const svg = renderConstellation("community", repos, {
    ...orgOptions,
    arrangement: "community-galaxy",
    nodeSize: "uniform",
    starPositions: { [repos[0].full_name]: { x: 100, y: 100 } },
  });
  assert.match(svg, /class="star" cx="100.0" cy="100.0" r="4.0"/);
  assert.match(
    svg,
    /r="4.0" data-repo="contributor:alice"/,
    "uniform sizing applies to people too",
  );
  assert.doesNotMatch(
    svg,
    /stroke-width:1.00;opacity:0.27/,
    "organization links use the shared visual styling",
  );
  const projectSVG = renderConstellation("community", repos, {
    ...common,
    arrangement: "galaxy",
    accountType: "user",
  });
  const orgSVG = renderConstellation("community", repos, {
    ...orgOptions,
    organizationView: "projects",
    arrangement: "community-galaxy",
  });
  const connections = (source) =>
    [...source.matchAll(/data-from="([^"]+)" data-to="([^"]+)"/g)]
      .map((match) => `${match[1]}:${match[2]}`)
      .sort();
  assert.deepEqual(
    connections(orgSVG),
    connections(projectSVG),
    "project maps share the same relationship selection",
  );
});
test("organization resolution, public pagination, scope bounds and reusable metadata", async () => {
  const repos = repositories(405),
    calls = [],
    memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key),
    setItem: (key, value) => memory.set(key, value),
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (!u.pathname.endsWith("/repos"))
      return Response.json({
        login: "community",
        type: "Organization",
        public_repos: 405,
        billing_email: "PRIVATE",
      });
    const start = (Number(u.searchParams.get("page")) - 1) * 100;
    return Response.json(repos.slice(start, start + 100));
  };
  let api = createOrganizationData({ storage, fetchImpl });
  const metadata = await api.resolve("community");
  assert.equal(metadata.type, "Organization");
  assert.ok(!JSON.stringify(metadata).includes("PRIVATE"));
  const initial = await api.discover("community", {
    organizationScope: "sample",
  });
  assert.equal(initial.discovered, 300);
  assert.equal(initial.complete, false);
  api = createOrganizationData({ storage, fetchImpl });
  const total = await api.discover("community", {
    organizationScope: "all-metadata",
  });
  assert.equal(total.discovered, 405);
  assert.equal(total.complete, true);
  assert.equal(
    calls.filter((url) => new URL(url).searchParams.get("page") === "1").length,
    1,
  );
  const before = calls.length;
  await api.resolve("community");
  await api.discover("community", { organizationScope: "all-metadata" });
  assert.equal(calls.length, before);
});
test("a delayed organization profile cannot overwrite explicit refresh metadata", async () => {
  let calls = 0,
    startOld,
    finishOld;
  const oldStarted = new Promise((resolve) => {
    startOld = resolve;
  });
  const delayedProfile = new Promise((resolve) => {
    finishOld = resolve;
  });
  const api = createOrganizationData({
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        startOld();
        return delayedProfile;
      }
      return Response.json({
        login: "community",
        name: "Fresh profile",
        type: "User",
      });
    },
  });
  const earlier = api.resolve("community");
  await oldStarted;
  const fresh = await api.resolve("community", {}, true);
  finishOld(
    Response.json({ login: "community", name: "Old profile", type: "User" }),
  );
  assert.equal((await earlier).name, "Fresh profile");
  assert.equal(fresh.name, "Fresh profile");
  assert.equal(calls, 2);
});
test("contributor scan bounds, rate limits, resume, deduplication and honest dates", async () => {
  const repos = repositories(12),
    cache = new Map();
  let active = 0,
    peak = 0,
    limited = true,
    calls = 0;
  const storage = {
    getItem: (key) => cache.get(key),
    setItem: (key, value) => cache.set(key, value),
  };
  const fetchImpl = async (url) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (limited && url.includes(repos[1].name))
      return new Response("", { status: 429 });
    return Response.json([
      { login: "alice", contributions: 4 },
      { login: "ALICE", contributions: 99 },
      { name: "Anonymous", email: "PRIVATE" },
    ]);
  };
  let api = createOrganizationData({ storage, fetchImpl });
  const config = {
    organization: {
      contributors: {
        maxRepositories: 12,
        maxContributorsPerRepo: 25,
        strategy: "deep",
      },
    },
  };
  const first = await api.contributors(repos, config);
  assert.ok(peak <= 3);
  assert.ok(first.scanned < 12);
  assert.match(first.diagnostic, /limit/);
  const scanned = first.scanned;
  limited = false;
  calls = 0;
  api = createOrganizationData({ storage, fetchImpl });
  const completed = await api.contributors(repos, config);
  assert.equal(calls, 12 - scanned);
  assert.equal(completed.scanned, 12);
  assert.equal(completed.contributors.length, 1);
  assert.equal(completed.contributors[0].repositoryCount, 12);
  assert.equal(completed.contributors[0].contributionCount, 48);
  assert.equal(completed.contributors[0].firstSeen, null);
  assert.equal(completed.complete, false);
  assert.ok(!JSON.stringify(completed).includes("PRIVATE"));
});
test("representative selection and named grouping are deterministic and validated", () => {
  const repos = repositories(1504);
  assert.deepEqual(
    representativeRepositories(repos, 100),
    representativeRepositories([...repos].reverse(), 100),
  );
  const grouping = {
    mode: "regex",
    pattern: "^v(?<voyage>\\d+)-(?<tier>tier\\d+)-",
  };
  assert.deepEqual(groupRepository(repos[5], grouping).metadata, {
    voyage: "5",
    tier: "tier2",
  });
  assert.throws(() =>
    organizationOptions({
      organization: { grouping: { mode: "regex", pattern: "^(a+)+$" } },
    }),
  );
  assert.throws(() =>
    organizationOptions({
      organization: { contributors: { maxRepositories: 2001 } },
    }),
  );
});
test("1504-project ecosystems obey node and edge limits, preserve contributors, and export native geometry", () => {
  const repos = repositories(1504),
    records = Object.fromEntries(
      repos
        .slice(0, 100)
        .map((repo, i) => [
          repo.full_name,
          Array.from({ length: 25 }, (_, j) => ({
            login: `person-${(i + j) % 140}`,
            contributions: j + 1,
          })),
        ]),
    );
  const config = {
    ...options,
    organizationData: {
      records,
      scanned: 100,
      selected: 100,
      perRepositoryLimit: 25,
      metadataComplete: true,
    },
  };
  for (const arrangement of [
    "community-galaxy",
    "collaboration-gravity",
    "era-rings",
  ]) {
    const graph = graphNodes(repos, config);
    assert.ok(graph.nodes.length <= 256);
    assert.ok(graph.edges.length <= 2048);
    assert.equal(
      graph.nodes.filter((node) => node.nodeKind === "repository").length,
      100,
    );
    assert.equal(
      graph.nodes.filter((node) => node.nodeKind === "contributor").length,
      120,
    );
    assert.match(graph.note, /1504 repositories discovered/);
    assert.match(graph.note, /1404 through era systems/);
    const svg = renderConstellation("community", repos, {
      ...config,
      arrangement,
    });
    assert.equal(
      svg,
      renderConstellation("community", [...repos].reverse(), {
        ...config,
        arrangement,
      }),
    );
    assert.match(svg, /data-kind="contributor"/);
    assert.match(svg, /shape-diamond/);
    assert.doesNotMatch(svg, /<image|<script|NaN|Infinity/);
    assert.ok(Buffer.byteLength(svg) < 1500000);
  }
});
test("user plus organization highlights shared work and keeps missing-user coverage honest", () => {
  const repos = repositories(6),
    records = {
      [repos[5].full_name]: [
        { login: "alice", contributions: 8 },
        { login: "bob", contributions: 3 },
      ],
      [repos[0].full_name]: [{ login: "carol", contributions: 3 }],
    };
  const config = {
    ...options,
    maxRepos: 2,
    organizationUser: "alice",
    organizationData: { records },
  };
  const graph = graphNodes(repos, config);
  assert.ok(
    graph.nodes.find((node) => node.full_name === repos[5].full_name)
      ?.organizationFocus,
  );
  assert.ok(graph.nodes.find((node) => node.name === "bob")?.organizationFocus);
  assert.equal(
    graph.nodes.find((node) => node.name === "carol")?.organizationFocus,
    false,
  );
  const svg = renderConstellation("community", repos, config);
  assert.match(svg, /data-organization-focus="true"/);
  assert.match(
    graphNodes(repos, { ...config, organizationUser: "missing" }).note,
    /does not establish absence/,
  );
  const clean = parseConfig(serializeConfig("community", config));
  assert.equal(clean.options.organizationUser, "alice");
  assert.equal(clean.options.organizationData, undefined);
  const workflow = renderWorkflow("community", config);
  assert.match(workflow, /username: 'community'/);
  assert.doesNotMatch(workflow, /"records"/);
});
test("organization preview retains a usable graph when language details are rate limited", async () => {
  const repos = repositories(3).map(({ languages, ...repo }) => repo);
  const data = authenticatedPreviewData({
    fetchImpl: async (url) =>
      url.includes("/contributors")
        ? Response.json([{ login: "alice", contributions: 1 }])
        : url.includes("/languages")
          ? new Response("", { status: 429 })
          : url.includes("/events")
            ? Response.json([])
            : url.includes("/repos?")
              ? Response.json(repos)
              : Response.json({ login: "community", type: "Organization" }),
  });
  const loaded = await data.load("community", options);
  assert.equal(loaded.length, 3);
  assert.equal(data.profile("community").type, "Organization");
  assert.equal(data.organization("community").scanned, 3);
  assert.match(data.organization("community").diagnostic, /primary languages/);
});

test("targeted lookup finds older user projects outside the organization sample without inventing commit totals", async () => {
  const old = {
      ...repositories(1)[0],
      name: "old-voyage",
      full_name: "community/old-voyage",
    },
    calls = [],
    stored = new Map();
  const api = createOrganizationData({
    storage: {
      getItem: (key) => stored.get(key),
      setItem: (key, value) => stored.set(key, value),
    },
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/search/issues"))
        return Response.json({
          total_count: 1,
          items: [
            {
              number: 42,
              user: { login: "alice" },
              repository_url:
                "https://api.github.com/repos/community/old-voyage",
              pull_request: {},
              body: "DO_NOT_CACHE",
            },
          ],
        });
      if (url.endsWith("/repos/community/old-voyage"))
        return Response.json(old);
      return Response.json([{ login: "bob", contributions: 10 }]);
    },
  });
  const focus = await api.focusRepositories("community", "alice");
  assert.equal(focus.repositories[0].full_name, old.full_name);
  assert.equal(
    new URL(calls[0]).searchParams.get("q"),
    "author:alice org:community is:pr is:public",
  );
  const scan = attachFocusEvidence(
    await api.contributors(focus.repositories, { organizationUser: "alice" }),
    focus,
    "alice",
    focus.repositories,
  );
  const alice = scan.contributors.find((person) => person.login === "alice");
  assert.equal(alice.pullRequestCount, 1);
  assert.equal(alice.contributionCount, 0);
  const config = {
    ...options,
    organizationUser: "alice",
    organizationData: scan,
  };
  const graph = graphNodes(focus.repositories, config);
  assert.equal(graph.focusProjects[0], old.full_name);
  const svg = renderConstellation("community", focus.repositories, config);
  assert.match(svg, /data-organization-user="true"/);
  assert.match(svg, /bright lines show direct participation/);
  assert.match(svg, /stroke-width:2.50;opacity:0.95/);
  assert.ok(!JSON.stringify([...stored.values()]).includes("DO_NOT_CACHE"));
  const before = calls.length;
  await api.focusRepositories("community", "alice");
  assert.equal(calls.length, before);
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }
