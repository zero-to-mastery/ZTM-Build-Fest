import test from "node:test";
import assert from "node:assert/strict";
import {
  repositoryName,
  normalizeCommits,
  createRepositoryCommits,
} from "../src/repository-commits.mjs";
import { commitGraph, renderCommitGraph } from "../src/commit-graph.mjs";
const sha = (n) => n.toString(16).padStart(40, "0");
const raw = (n, parents = [], login = "alice") => ({
  sha: sha(n),
  parents: parents.map((n) => ({ sha: sha(n) })),
  author: login ? { login } : null,
  commit: {
    message: `Commit ${n}`,
    author: { name: "Unlinked Dev", email: "omit@example.com" },
    committer: { date: "2026-09-27T12:00:00Z" },
  },
});
const metadata = {
  private: false,
  full_name: "example/repo",
  default_branch: "main",
};
const snapshot = {
  repository: "example/repo",
  branch: "main",
  commits: normalizeCommits([
    raw(4, [3, 2]),
    raw(3, [1]),
    raw(2, [1], "bob"),
    raw(1, [], null),
  ]),
  partial: false,
};

test("commit graph preserves merge ancestry, contributor attribution and topological order", () => {
  const graph = commitGraph({
    ...snapshot,
    commits: [...snapshot.commits].reverse(),
  });
  assert.equal(graph.nodes[0].sha, sha(4));
  assert.equal(graph.edges.length, 4);
  assert.ok(graph.edges.every((edge) => edge.from.row < edge.to.row));
  assert.ok(graph.nodes.some((node) => node.lane > 0));
  assert.equal(graph.contributors.length, 3);
  assert.equal(
    graph.contributors.find((person) => person.name === "alice").count,
    2,
  );
  assert.equal(graph.boundary, 0);
});

test("normalization omits emails, deduplicates commits and handles unlinked authors", () => {
  const data = normalizeCommits([
    raw(1, [], null),
    raw(1),
    { sha: "<script>" },
  ]);
  assert.equal(data.length, 1);
  assert.equal(data[0].login, null);
  assert.equal(data[0].author, "Unlinked Dev");
  assert.doesNotMatch(JSON.stringify(data), /omit@example/);
  assert.equal(
    repositoryName("https://github.com/example/repo/"),
    "example/repo",
  );
  for (const value of [
    "../repo",
    "example/..",
    "example/repo?token=x",
    "https://evil.com/example/repo",
  ])
    assert.throws(() => repositoryName(value));
});

test("SVG escapes titles and messages, links actual commits and marks history boundaries", () => {
  const commits = normalizeCommits([
    {
      ...raw(1, [99]),
      commit: {
        message: '<script>alert("x")</script>',
        author: { name: "Dev" },
      },
    },
  ]);
  const svg = renderCommitGraph({ ...snapshot, commits });
  assert.doesNotMatch(svg, /<script|NaN|Infinity/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /earlier history outside view/);
  assert.match(svg, new RegExp(`/commit/${sha(1)}`));
  assert.match(renderCommitGraph(snapshot, "github:bob"), /highlighting bob/);
  assert.match(
    renderCommitGraph({ ...snapshot, commits: [] }),
    /no commits yet/,
  );
});

test("history paginates at a pinned head, is capped, cached and explicitly refreshable", async () => {
  const urls = [];
  const data = createRepositoryCommits({
    fetchImpl: async (url) => {
      urls.push(url);
      if (!url.includes("/commits?")) return Response.json(metadata);
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(
        Array.from({ length: 100 }, (_, i) => raw(400 - (page - 1) * 100 - i)),
        { headers: { link: '<https://api.github.com/next>; rel="next"' } },
      );
    },
  });
  const result = await data.load("example/repo");
  assert.equal(result.commits.length, 300);
  assert.equal(result.partial, true);
  assert.equal(urls.length, 4);
  assert.equal(new URL(urls[2]).searchParams.get("sha"), sha(400));
  assert.equal(await data.load("example/repo"), result);
  assert.equal(urls.length, 4);
  await data.load("example/repo", { refresh: true });
  assert.equal(urls.length, 8);
});

test("a delayed earlier history cannot replace an explicit refresh", async () => {
  let metadataCalls = 0,
    startOld,
    finishOld;
  const oldMetadataStarted = new Promise((resolve) => {
    startOld = resolve;
  });
  const delayedMetadata = new Promise((resolve) => {
    finishOld = resolve;
  });
  const data = createRepositoryCommits({
    fetchImpl: async (url) => {
      if (url.includes("/commits?"))
        return Response.json([raw(url.includes("sha=fresh") ? 2 : 1)]);
      metadataCalls++;
      if (metadataCalls === 1) {
        startOld();
        return delayedMetadata;
      }
      return Response.json({ ...metadata, default_branch: "fresh" });
    },
  });
  const earlier = data.load("example/repo");
  await oldMetadataStarted;
  const fresh = await data.load("example/repo", { refresh: true });
  finishOld(Response.json(metadata));
  const oldResult = await earlier;
  assert.equal(fresh.branch, "fresh");
  assert.equal(oldResult.branch, "fresh");
  assert.equal((await data.load("example/repo")).branch, "fresh");
});

test("empty repositories, private metadata, missing branches and partial rate limits are explicit", async () => {
  for (const status of [409, 404, 429]) {
    const data = createRepositoryCommits({
      fetchImpl: async (url) =>
        url.includes("/commits?")
          ? new Response(null, { status })
          : Response.json(metadata),
    });
    if (status === 409)
      assert.deepEqual((await data.load("example/repo")).commits, []);
    else
      await assert.rejects(
        data.load("example/repo"),
        status === 404 ? /not found/ : /limit reached/,
      );
  }
  const privateData = createRepositoryCommits({
    fetchImpl: async () => Response.json({ ...metadata, private: true }),
  });
  await assert.rejects(privateData.load("example/repo"), /public repository/);
  const partial = createRepositoryCommits({
    fetchImpl: async (url) =>
      !url.includes("/commits?")
        ? Response.json(metadata)
        : new URL(url).searchParams.get("page") === "1"
          ? Response.json([raw(2, [1])], {
              headers: { link: '<https://api.github.com/next>; rel="next"' },
            })
          : new Response(null, { status: 429 }),
  });
  const result = await partial.load("example/repo");
  assert.equal(result.commits.length, 1);
  assert.equal(result.partial, true);
  assert.match(result.diagnostic, /already loaded/);
});
