import { generateWorkflow } from "../src/workflows/model.js";
// @vitest-environment node
import { it, expect, vi } from "vitest";
import { createPublishingService } from "../server/publishing.js";
import { buildChangeSet, gitBlobSha } from "../src/publishing/change-set.js";
const origin = "https://studio.example",
  sha = "a".repeat(40),
  newSha = "b".repeat(40),
  changeSetId = "c".repeat(64);
// A write as the reviewed Change set executor sends it.
const reviewed = async (input) => ({
  ...input,
  resultSha: await gitBlobSha(input.content),
  changeSetId,
});
function harness({
  permission = true,
  exists = true,
  commitStatus = 200,
  workflows = false,
  allowWorkflows = workflows,
  installed = true,
  push = true,
  archived = false,
  branchStatus = 200,
  protectedBranch = false,
  rules = [],
  rulesStatus = 200,
  remoteContent = "# Old",
  remoteSha = sha,
  commitThrows = false,
  commitBody = null,
  pullRequestsPermission = true,
  pulls = [],
  pullRequest = null,
  pullRequestThrows = false,
  pullRequestCreateBody = null,
  branchShas = {},
  branchShaSequences = {},
} = {}) {
  let clock = 1000,
    cookie,
    csrf;
  const upstream = vi.fn(async (url, options) => {
    if (url.endsWith("/device/code"))
      return Response.json({
        device_code: "PRIVATE_DEVICE",
        user_code: "ABCD-EFGH",
        expires_in: 900,
        interval: 5,
      });
    if (url.endsWith("/oauth/access_token"))
      return Response.json({
        access_token: "PRIVATE_ACCESS",
        refresh_token: "PRIVATE_REFRESH",
        expires_in: 28800,
      });
    if (url.endsWith("/user"))
      return Response.json({ login: "octocat", name: "Octo", id: 1 });
    if (url.includes("/user/installations?"))
      return Response.json({
        installations: [
          {
            id: 1,
            permissions: {
              contents: permission ? "write" : "read",
              workflows: workflows ? "write" : "read",
              pull_requests: pullRequestsPermission ? "write" : "read",
            },
          },
        ],
      });
    if (url.includes("/user/installations/1/repositories?"))
      return Response.json({
        repositories: installed
          ? [
              {
                full_name: "octocat/octocat",
                default_branch: "main",
                archived,
                permissions: { push },
              },
            ]
          : [],
      });
    if (url.includes("/rules/branches/"))
      return Response.json(rulesStatus === 200 ? rules : { message: "no" }, {
        status: rulesStatus,
      });
    if (url.includes("/branches/")) {
      const branch = decodeURIComponent(url.split("/branches/")[1]),
        sequence = branchShaSequences[branch],
        branchSha = sequence?.length
          ? sequence.shift()
          : branchShas[branch] || sha;
      return Response.json(
        branchStatus === 200
          ? {
              commit: { sha: branchSha },
              protected: protectedBranch,
            }
          : { message: "Branch not found" },
        { status: branchStatus },
      );
    }
    if (url.includes("/pulls?")) return Response.json(pulls);
    if (/\/pulls\/\d+$/.test(url))
      return Response.json(pullRequest || { message: "Not found" }, {
        status: pullRequest ? 200 : 404,
      });
    if (url.endsWith("/pulls") && options.method === "POST") {
      if (pullRequestThrows) throw new Error("response lost after POST");
      const value = JSON.parse(options.body);
      return Response.json(
        pullRequestCreateBody || {
          number: 42,
          html_url: "https://github.com/octocat/octocat/pull/42",
          state: "open",
          draft: value.draft,
          title: value.title,
          head: {
            ref: value.head,
            sha: branchShas[value.head] || sha,
            repo: { full_name: "octocat/octocat" },
          },
          base: {
            ref: value.base,
            sha: branchShas[value.base] || sha,
            repo: { full_name: "octocat/octocat" },
          },
        },
      );
    }
    if (url.endsWith("/git/refs"))
      return Response.json({ ref: "refs/heads/readme-studio/update" });
    if (options.method === "PUT") {
      if (commitThrows) throw new Error("response lost after PUT");
      const putInput = JSON.parse(options.body);
      return Response.json(
        commitStatus === 200
          ? (commitBody ?? {
              commit: { sha: newSha },
              content: {
                sha: await gitBlobSha(
                  Buffer.from(putInput.content, "base64").toString("utf8"),
                ),
              },
            })
          : { message: "PRIVATE_ACCESS" },
        { status: commitStatus },
      );
    }
    if (url.includes("/contents/"))
      return Response.json(
        exists
          ? {
              type: "file",
              encoding: "base64",
              size: 6,
              sha: remoteSha,
              content: Buffer.from(remoteContent).toString("base64"),
            }
          : {},
        { status: exists ? 200 : 404 },
      );
    throw new Error("Unexpected mock route");
  });
  const service = createPublishingService({
    origin,
    clientId: "APP_ID",
    allowWorkflows,
    fetchImpl: upstream,
    now: () => clock,
  });
  async function request(op, body, headers = {}) {
    const response = await service(
      new Request(`${origin}/api/publishing/${op}`, {
        method: body ? "POST" : "GET",
        headers: {
          cookie: cookie || "",
          origin,
          "content-type": "application/json",
          "x-studio-csrf": csrf || "",
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    const value = await response.json();
    if (value.csrf) csrf = value.csrf;
    return { response, value };
  }
  async function connect() {
    await request("session");
    await request("connect", {});
    clock += 6000;
    return request("poll", {});
  }
  return { request, connect, upstream };
}
it("isolates tokens in server memory and disconnects the session", async () => {
  const h = harness();
  const session = await h.request("session");
  expect(session.response.headers.get("set-cookie")).toMatch(
    /HttpOnly; Secure; SameSite=Lax/,
  );
  const connected = await h.connect();
  expect(connected.value.identity.login).toBe("octocat");
  expect(JSON.stringify(connected.value)).not.toMatch(/PRIVATE_/);
  expect(
    (await h.request("repositories", {})).value.repositories[0].writable,
  ).toBe(true);
  await h.request("disconnect", {});
  expect((await h.request("repositories", {})).response.status).toBe(403);
});
it("rejects cross-origin, CSRF, arbitrary proxy and unconfirmed writes", async () => {
  const h = harness();
  await h.connect();
  expect(
    (await h.request("commit", {}, { origin: "https://evil.example" })).response
      .status,
  ).toBe(403);
  expect(
    (await h.request("commit", {}, { "x-studio-csrf": "wrong" })).response
      .status,
  ).toBe(403);
  expect((await h.request("delete", {})).response.status).toBe(404);
  expect(
    (
      await h.request("commit", {
        repository: "octocat/octocat",
        branch: "main",
        path: "README.md",
        sha: null,
        content: "# New",
        message: "update",
      })
    ).response.status,
  ).toBe(400);
  expect(h.upstream.mock.calls.some(([, o]) => o.method === "PUT")).toBe(false);
});

it("refuses a selected PR commit when its exact branch head moved", async () => {
  const h = harness({ branchShas: { main: newSha } });
  await h.connect();
  const result = await h.request(
    "commit",
    await reviewed({
      repository: "octocat/octocat",
      branch: "main",
      path: "README.md",
      sha,
      content: "# New",
      message: "Update README",
      confirmed: true,
      expectedBranchSha: sha,
    }),
  );
  expect(result.response.status).toBe(409);
  expect(result.value.error).toContain("head changed before this write");
  expect(
    h.upstream.mock.calls.some(([, options]) => options.method === "PUT"),
  ).toBe(false);
});

const pr = ({
  number = 7,
  head = "docs/readme",
  base = "main",
  headSha = sha,
  baseSha = newSha,
  mergeable = true,
  title = "Improve docs",
  createdAt = "1970-01-01T00:00:02.000Z",
} = {}) => ({
  number,
  title,
  html_url: `https://github.com/octocat/octocat/pull/${number}`,
  state: "open",
  draft: true,
  mergeable,
  created_at: createdAt,
  head: {
    ref: head,
    sha: headSha,
    repo: { full_name: "octocat/octocat" },
  },
  base: {
    ref: base,
    sha: baseSha,
    repo: { full_name: "octocat/octocat" },
  },
});

it("lists only compatible same-repository pull requests", async () => {
  const compatible = pr(),
    fork = pr({ number: 8 }),
    malformed = pr({ number: 9 });
  fork.head.repo.full_name = "someone/fork";
  malformed.html_url = 'https://github.com/octocat/octocat/pull/9\"><img>';
  const h = harness({ pulls: [compatible, fork, malformed] });
  await h.connect();
  const result = await h.request("pull-requests", {
    repository: "octocat/octocat",
    branch: "main",
  });
  expect(result.value.pullRequests).toEqual([
    expect.objectContaining({ number: 7, head: "docs/readme", base: "main" }),
  ]);
  expect(
    h.upstream.mock.calls.some(([url]) => url.includes("state=open")),
  ).toBe(true);
});

it("checks an existing PR head and rejects stale or conflicting selection", async () => {
  const value = pr(),
    h = harness({ pullRequest: value });
  await h.connect();
  const input = {
    repository: "octocat/octocat",
    number: 7,
    head: "docs/readme",
    base: "main",
    headSha: sha,
  };
  expect((await h.request("pull-request-check", input)).response.status).toBe(
    200,
  );
  value.head.sha = newSha;
  expect((await h.request("pull-request-check", input)).value.error).toContain(
    "head changed",
  );
  value.head.sha = sha;
  value.mergeable = false;
  expect((await h.request("pull-request-check", input)).value.error).toContain(
    "conflicts",
  );
});

it("creates a draft PR only with permission, exact branch heads, and no duplicate", async () => {
  const input = {
      repository: "octocat/octocat",
      head: "docs/readme",
      base: "main",
      headSha: sha,
      baseSha: newSha,
      title: "Improve README",
      body: "Reviewed locally.",
      confirmed: true,
    },
    branchShas = { "docs/readme": sha, main: newSha },
    denied = harness({ pullRequestsPermission: false, branchShas });
  await denied.connect();
  expect((await denied.request("pull-request", input)).response.status).toBe(
    403,
  );
  expect(
    denied.upstream.mock.calls.some(
      ([url, options]) => url.endsWith("/pulls") && options.method === "POST",
    ),
  ).toBe(false);

  const duplicate = harness({ pulls: [pr()], branchShas });
  await duplicate.connect();
  const duplicateResult = await duplicate.request("pull-request", input);
  expect(duplicateResult.response.status).toBe(409);
  expect(duplicateResult.value.pullRequest.number).toBe(7);

  const allowed = harness({ branchShas });
  await allowed.connect();
  const created = await allowed.request("pull-request", input);
  expect(created.value).toMatchObject({ number: 42, draft: true });
  const post = allowed.upstream.mock.calls.find(
    ([url, options]) => url.endsWith("/pulls") && options.method === "POST",
  );
  expect(JSON.parse(post[1].body)).toEqual({
    title: "Improve README",
    body: "Reviewed locally.",
    head: "docs/readme",
    base: "main",
    draft: true,
  });
});

it.each([
  ["non-draft", { draft: false }],
  [
    "changed head",
    {
      head: {
        ref: "docs/readme",
        sha: newSha,
        repo: { full_name: "octocat/octocat" },
      },
    },
  ],
])(
  "keeps recovery ambiguous for an unreadable %s create response",
  async (_, change) => {
    const branchShas = { "docs/readme": sha, main: newSha },
      valid = {
        number: 42,
        html_url: "https://github.com/octocat/octocat/pull/42",
        state: "open",
        draft: true,
        title: "Improve README",
        head: {
          ref: "docs/readme",
          sha,
          repo: { full_name: "octocat/octocat" },
        },
        base: {
          ref: "main",
          sha: newSha,
          repo: { full_name: "octocat/octocat" },
        },
      },
      h = harness({
        branchShas,
        pullRequestCreateBody: { ...valid, ...change },
      });
    await h.connect();
    const result = await h.request("pull-request", {
      repository: "octocat/octocat",
      head: "docs/readme",
      base: "main",
      headSha: sha,
      baseSha: newSha,
      title: "Improve README",
      body: "",
      confirmed: true,
    });
    expect(result.response.status).toBe(502);
    expect(result.value.ambiguous).toBe(true);
  },
);

it("rechecks exact branch heads after duplicate discovery and before PR creation", async () => {
  const h = harness({
    branchShaSequences: {
      "docs/readme": [sha, newSha],
      main: [newSha, newSha],
    },
  });
  await h.connect();
  const result = await h.request("pull-request", {
    repository: "octocat/octocat",
    head: "docs/readme",
    base: "main",
    headSha: sha,
    baseSha: newSha,
    title: "Improve README",
    body: "",
    confirmed: true,
  });
  expect(result.response.status).toBe(409);
  expect(result.value.error).toContain("changed during review");
  expect(
    h.upstream.mock.calls.some(
      ([url, options]) => url.endsWith("/pulls") && options.method === "POST",
    ),
  ).toBe(false);
});

it("marks a lost draft-PR response ambiguous and supports exact reconciliation", async () => {
  const input = {
      repository: "octocat/octocat",
      head: "docs/readme",
      base: "main",
      headSha: sha,
      baseSha: newSha,
      title: "Improve README",
      body: "",
      confirmed: true,
    },
    branchShas = { "docs/readme": sha, main: newSha },
    h = harness({ pullRequestThrows: true, branchShas });
  await h.connect();
  const lost = await h.request("pull-request", input);
  expect(lost.response.status).toBe(502);
  expect(lost.value.ambiguous).toBe(true);

  const found = pr({
    headSha: sha,
    baseSha: newSha,
    title: input.title,
    createdAt: "1970-01-01T00:00:01.000Z",
  });
  const reconciliation = harness({ pulls: [found] });
  await reconciliation.connect();
  expect(
    (
      await reconciliation.request("pull-request-status", {
        repository: input.repository,
        head: input.head,
        base: input.base,
        headSha: input.headSha,
        baseSha: input.baseSha,
        title: input.title,
        createdAt: 1999,
      })
    ).value.found.number,
  ).toBe(7);
});

it("does not reconcile an older PR that lacks the exact reviewed evidence", async () => {
  const h = harness({
    pulls: [
      pr({
        title: "Older title",
        createdAt: "1970-01-01T00:00:00.500Z",
      }),
    ],
  });
  await h.connect();
  const result = await h.request("pull-request-status", {
    repository: "octocat/octocat",
    head: "docs/readme",
    base: "main",
    headSha: sha,
    baseSha: newSha,
    title: "Improve README",
    createdAt: 1000,
  });
  expect(result.value.found).toBeNull();
});

it("does not attribute an otherwise matching PR outside the recovery window", async () => {
  const h = harness({
    pulls: [
      pr({
        title: "Improve README",
        createdAt: "1970-01-01T00:20:00.000Z",
      }),
    ],
  });
  await h.connect();
  const result = await h.request("pull-request-status", {
    repository: "octocat/octocat",
    head: "docs/readme",
    base: "main",
    headSha: sha,
    baseSha: newSha,
    title: "Improve README",
    createdAt: 1000,
  });
  expect(result.value.found).toBeNull();
});
it("reads a BOM-prefixed README as the exact bytes its Base SHA names", async () => {
  const raw = "\uFEFF# Hi\n",
    h = harness({ remoteContent: raw });
  await h.connect();
  const t = {
      repository: "octocat/octocat",
      branch: "main",
      path: "README.md",
    },
    baseline = (await h.request("read", t)).value,
    baseSha = await gitBlobSha(raw);
  // A dropped BOM would make an identical draft look like an update.
  expect(baseline.content).toBe(raw);
  const build = (content) =>
    buildChangeSet({
      target: t,
      message: "Update",
      files: [
        {
          path: "README.md",
          kind: "readme",
          baseSha,
          baseContent: baseline.content,
          content,
        },
      ],
    });
  expect((await build(baseline.content)).entries[0].action).toBe("unchanged");
  expect((await build("# Hi\n")).entries[0]).toMatchObject({
    action: "update",
    bom: "removed",
  });
});
it.each([true, false])(
  "loads and commits an existing=%s README without changing UTF-8 source",
  async (exists) => {
    const h = harness({ exists });
    await h.connect();
    const t = {
      repository: "octocat/octocat",
      branch: "main",
      path: "README.md",
    };
    const baseline = (await h.request("read", t)).value;
    expect(baseline.sha).toBe(exists ? sha : null);
    const result = await h.request(
      "commit",
      await reviewed({
        ...t,
        sha: baseline.sha,
        content: "# 🦀\r\n",
        message: "My commit",
        confirmed: true,
      }),
    );
    expect(result.value.commitSha).toBe(newSha);
    const body = JSON.parse(
      h.upstream.mock.calls.find(([, o]) => o.method === "PUT")[1].body,
    );
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe(
      "# 🦀\r\n",
    );
    expect(body.sha).toBe(exists ? sha : undefined);
  },
);
it("rejects read-only repositories and redacts GitHub error bodies", async () => {
  const t = await reviewed({
    repository: "octocat/octocat",
    branch: "main",
    path: "README.md",
    sha,
    content: "New",
    message: "update",
    confirmed: true,
  });
  const h = harness({ permission: false });
  await h.connect();
  expect((await h.request("commit", t)).response.status).toBe(403);
  expect(h.upstream.mock.calls.some(([, o]) => o.method === "PUT")).toBe(false);
  const denied = harness({ commitStatus: 403 });
  await denied.connect();
  const result = await denied.request("commit", t);
  expect(result.value.error).toContain("branch protection");
  expect(JSON.stringify(result.value)).not.toContain("PRIVATE");
});
it("leaves static deployments unconfigured and uses HTTPS only", async () => {
  expect(() =>
    createPublishingService({ origin: "http://example.com" }),
  ).toThrow("HTTPS");
  const service = createPublishingService({ origin });
  expect(
    await (
      await service(new Request(origin + "/api/publishing/session"))
    ).json(),
  ).toEqual({ configured: false, connected: false });
});
it("does not accept arbitrary SVG content or hidden asset paths", async () => {
  const h = harness();
  await h.connect();
  const input = {
    repository: "octocat/octocat",
    branch: "main",
    path: "assets/readme/banner.svg",
    kind: "asset",
    sha: null,
    content: '<svg onload="alert(1)"/>',
    message: "update",
    confirmed: true,
  };
  expect((await h.request("commit", input)).response.status).toBe(400);
  expect(
    (await h.request("commit", { ...input, path: ".github/workflows/a.svg" }))
      .response.status,
  ).toBe(400);
  expect(h.upstream.mock.calls.some(([, o]) => o.method === "PUT")).toBe(false);
});
it("stops stale writes on the server before PUT and returns a reviewable remote baseline", async () => {
  const h = harness();
  await h.connect();
  const result = await h.request(
    "commit",
    await reviewed({
      repository: "octocat/octocat",
      branch: "main",
      path: "README.md",
      sha: newSha,
      content: "New",
      message: "update",
      confirmed: true,
    }),
  );
  expect(result.response.status).toBe(409);
  expect(result.value.remote.content).toBe("# Old");
  expect(h.upstream.mock.calls.some(([, o]) => o.method === "PUT")).toBe(false);
});
it("refuses an already-applied Result SHA without issuing a duplicate PUT", async () => {
  const input = await reviewed({
    repository: "octocat/octocat",
    branch: "main",
    path: "README.md",
    sha,
    content: "New",
    message: "update",
    confirmed: true,
  });
  const h = harness({ remoteSha: input.resultSha, remoteContent: "New" });
  await h.connect();
  const result = await h.request("commit", input);
  expect(result.response.status).toBe(409);
  expect(result.value.alreadyApplied).toBe(true);
  expect(result.value.remote.sha).toBe(input.resultSha);
  expect(
    h.upstream.mock.calls.some(([, options]) => options.method === "PUT"),
  ).toBe(false);
});
it("marks a lost GitHub write response as ambiguous and never retries it", async () => {
  const h = harness({ commitThrows: true });
  await h.connect();
  const result = await h.request(
    "commit",
    await reviewed({
      repository: "octocat/octocat",
      branch: "main",
      path: "README.md",
      sha,
      content: "New",
      message: "update",
      confirmed: true,
    }),
  );
  expect(result.response.status).toBe(502);
  expect(result.value.ambiguous).toBe(true);
  expect(
    h.upstream.mock.calls.filter(([, options]) => options.method === "PUT"),
  ).toHaveLength(1);
});
it.each([
  ["missing fields", {}],
  ["invalid SHAs", { commit: { sha: "no" }, content: { sha: "wrong" } }],
])(
  "marks a 2xx GitHub write response with %s ambiguous",
  async (_, commitBody) => {
    const h = harness({ commitBody });
    await h.connect();
    const result = await h.request(
      "commit",
      await reviewed({
        repository: "octocat/octocat",
        branch: "main",
        path: "README.md",
        sha,
        content: "New",
        message: "update",
        confirmed: true,
      }),
    );
    expect(result.response.status).toBe(502);
    expect(result.value.ambiguous).toBe(true);
    expect(
      h.upstream.mock.calls.filter(([, options]) => options.method === "PUT"),
    ).toHaveLength(1);
  },
);
it("creates only explicitly confirmed branches at an unchanged source commit", async () => {
  const h = harness();
  await h.connect();
  const input = {
    repository: "octocat/octocat",
    branch: "main",
    path: "README.md",
    commitSha: sha,
    newBranch: "readme-studio/update",
  };
  expect((await h.request("branch", input)).response.status).toBe(400);
  expect(
    (
      await h.request("branch", {
        ...input,
        confirmed: true,
        commitSha: newSha,
      })
    ).response.status,
  ).toBe(409);
  expect(
    (await h.request("branch", { ...input, confirmed: true })).value.branch,
  ).toBe("readme-studio/update");
  const write = h.upstream.mock.calls.filter(([url]) =>
    url.endsWith("/git/refs"),
  );
  expect(write).toHaveLength(1);
  expect(JSON.parse(write[0][1].body)).toEqual({
    ref: "refs/heads/readme-studio/update",
    sha,
  });
});
it("redacts network failures and does not retry a write", async () => {
  const h = harness();
  await h.connect();
  h.upstream.mockRejectedValueOnce(new Error("PRIVATE_ACCESS network error"));
  const result = await h.request("repositories", {});
  expect(result.response.status).toBe(502);
  expect(result.value.error).toContain("local draft is safe");
  expect(JSON.stringify(result.value)).not.toContain("PRIVATE_ACCESS");
  expect(h.upstream.mock.calls.some(([, o]) => o.method === "PUT")).toBe(false);
});

it("workflow write requires opt-in, app permission and exact generated YAML", async () => {
  const config = {
      provider: "snake",
      publish: true,
      repository: "octocat/octocat",
    },
    r = generateWorkflow(config);
  const input = await reviewed({
    repository: "octocat/octocat",
    branch: "main",
    path: r.path,
    kind: "workflow",
    sha,
    content: r.yaml,
    workflow: config,
    message: "Add workflow",
    confirmed: true,
  });
  const denied = harness();
  await denied.connect();
  expect((await denied.request("commit", input)).response.status).toBe(403);
  const allowed = harness({ workflows: true });
  await allowed.connect();
  expect(
    (
      await allowed.request(
        "commit",
        await reviewed({ ...input, content: r.yaml + "injected: true" }),
      )
    ).response.status,
  ).toBe(400);
  expect((await allowed.request("commit", input)).value.commitSha).toBe(newSha);
});

const readmeTarget = {
  repository: "octocat/octocat",
  branch: "main",
  path: "README.md",
};
const puts = (h) =>
  h.upstream.mock.calls.filter(([, o]) => o?.method === "PUT").length;
const checkOf = (report, id) => report.checks.find((c) => c.id === id);
async function preflightThenCommit(options, value = readmeTarget) {
  const h = harness(options);
  await h.connect();
  const report = (await h.request("preflight", value)).value;
  const commit = await h.request(
    "commit",
    await reviewed({
      ...value,
      sha,
      content: "# New",
      message: "update",
      confirmed: true,
    }),
  );
  return { h, report, commit };
}
it("preflight is read-only and reports a writable target with advisory warnings", async () => {
  const { h, report, commit } = await preflightThenCommit({
    protectedBranch: true,
  });
  expect(report.verdict).toBe("writable");
  expect(report.branchCommitSha).toBe(sha);
  expect(report.defaultBranch).toBe("main");
  expect(checkOf(report, "branch-rules").status).toBe("warn");
  expect(checkOf(report, "default-branch").status).toBe("warn");
  expect(commit.value.commitSha).toBe(newSha);
  // The preflight itself only issued GET requests.
  const preflightCalls = h.upstream.mock.calls.filter(([url]) =>
    url.includes("/rules/branches/"),
  );
  expect(preflightCalls).toHaveLength(1);
  expect(preflightCalls[0][1].method).toBe("GET");
  expect(puts(h)).toBe(1);
});
it.each([
  [
    "installation contents: read",
    { permission: false },
    "contents-permission",
    "App grants Contents: read only",
  ],
  ["push: false", { push: false }, "user-push", "cannot push"],
  ["archived repository", { archived: true }, "not-archived", "archived"],
  [
    "missing installation",
    { installed: false },
    "installation",
    "not installed",
  ],
  ["branch 404", { branchStatus: 404 }, "branch-exists", "was not found"],
])(
  "%s: preflight fails and commit is refused with the same message and no PUT",
  async (_, options, id, message) => {
    const { h, report, commit } = await preflightThenCommit(options);
    expect(report.verdict).toBe("read-only");
    const failed = checkOf(report, id);
    expect(failed.status).toBe("fail");
    expect(failed.message).toContain(message);
    expect(commit.response.status).toBe(403);
    expect(commit.value.error).toBe(failed.message);
    expect(commit.value.preflight).toBe(id);
    expect(puts(h)).toBe(0);
  },
);
it("unreadable branch rules stay an unknown advisory and do not block", async () => {
  for (const rulesStatus of [403, 404]) {
    const { report, commit } = await preflightThenCommit({ rulesStatus });
    expect(checkOf(report, "branch-rules")).toMatchObject({
      status: "unknown",
      blocking: false,
    });
    expect(report.verdict).toBe("writable");
    expect(commit.value.commitSha).toBe(newSha);
  }
  const { report } = await preflightThenCommit({
    rules: [{ type: "pull_request" }],
  });
  expect(checkOf(report, "branch-rules").status).toBe("warn");
  expect(report.verdict).toBe("writable");
});
it.each([
  [
    "without server opt-in",
    { workflows: true, allowWorkflows: false },
    "ALLOW_WORKFLOW_WRITES",
  ],
  [
    "with opt-in but no Workflows: write",
    { workflows: false, allowWorkflows: true },
    "Workflows: write",
  ],
])(
  "workflow preflight %s fails workflow-permission and refuses the commit",
  async (_, options, message) => {
    const config = {
        provider: "snake",
        publish: true,
        repository: "octocat/octocat",
      },
      r = generateWorkflow(config);
    const h = harness(options);
    await h.connect();
    const value = { ...readmeTarget, path: r.path, kind: "workflow" };
    const report = (await h.request("preflight", value)).value;
    expect(report.target.kind).toBe("workflow");
    const failed = checkOf(report, "workflow-permission");
    expect(failed.status).toBe("fail");
    expect(failed.message).toContain(message);
    expect(report.verdict).toBe("read-only");
    const repos = (await h.request("repositories", {})).value.repositories;
    expect(repos[0]).toMatchObject({
      writable: true,
      workflowsWritable: false,
    });
    const commit = await h.request(
      "commit",
      await reviewed({
        ...value,
        sha,
        content: r.yaml,
        workflow: config,
        message: "Add workflow",
        confirmed: true,
      }),
    );
    expect(commit.response.status).toBe(403);
    expect(commit.value.error).toBe(failed.message);
    expect(commit.value.preflight).toBe("workflow-permission");
    expect(puts(h)).toBe(0);
  },
);
it("preflight needs a session, verifies CSRF and reports offline GitHub as unknown", async () => {
  const h = harness();
  await h.request("session");
  const disconnected = (await h.request("preflight", readmeTarget)).value;
  expect(checkOf(disconnected, "session").status).toBe("fail");
  expect(h.upstream).not.toHaveBeenCalled();
  expect(
    (await h.request("preflight", readmeTarget, { "x-studio-csrf": "bad" }))
      .response.status,
  ).toBe(403);
  await h.connect();
  expect(
    (await h.request("preflight", { ...readmeTarget, repository: "../x" }))
      .response.status,
  ).toBe(400);
  h.upstream.mockRejectedValueOnce(new Error("PRIVATE_ACCESS offline"));
  const offline = await h.request("preflight", readmeTarget);
  expect(offline.response.status).toBe(200);
  expect(checkOf(offline.value, "installation").status).toBe("unknown");
  expect(offline.value.verdict).toBe("read-only");
  expect(JSON.stringify(offline.value)).not.toContain("PRIVATE");
});
it("unconfigured deployments return a read-only preflight without contacting GitHub", async () => {
  const upstream = vi.fn();
  const service = createPublishingService({ origin, fetchImpl: upstream });
  const report = await (
    await service(
      new Request(`${origin}/api/publishing/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
  ).json();
  expect(report.verdict).toBe("read-only");
  expect(checkOf(report, "service").status).toBe("fail");
  expect(upstream).not.toHaveBeenCalled();
});
it("branch creation is refused on a read-only installation before any ref write", async () => {
  const h = harness({ permission: false });
  await h.connect();
  const result = await h.request("branch", {
    ...readmeTarget,
    commitSha: sha,
    newBranch: "readme-studio/update",
    confirmed: true,
  });
  expect(result.response.status).toBe(403);
  expect(result.value.error).toContain("App grants Contents: read only");
  expect(h.upstream.mock.calls.some(([url]) => url.endsWith("/git/refs"))).toBe(
    false,
  );
});
const refWrites = (h) =>
  h.upstream.mock.calls.filter(([url]) => url.endsWith("/git/refs")).length;
it("branch creation is refused in an archived repository", async () => {
  const h = harness({ archived: true });
  await h.connect();
  const result = await h.request("branch", {
    ...readmeTarget,
    commitSha: sha,
    newBranch: "readme-studio/update",
    confirmed: true,
  });
  expect(result.response.status).toBe(403);
  expect(result.value.error).toContain("archived");
  expect(result.value.preflight).toBe("not-archived");
  expect(refWrites(h)).toBe(0);
});
it("workflow branch creation keeps the opt-in and Workflows: write boundary", async () => {
  const input = {
    repository: "octocat/octocat",
    branch: "main",
    path: ".github/workflows/readme-studio.yml",
    kind: "workflow",
    commitSha: sha,
    newBranch: "readme-studio/wf",
    confirmed: true,
  };
  for (const options of [
    { allowWorkflows: false, workflows: false },
    { allowWorkflows: true, workflows: false },
  ]) {
    const h = harness(options);
    await h.connect();
    const result = await h.request("branch", input);
    expect(result.response.status).toBe(403);
    expect(result.value.preflight).toBe("workflow-permission");
    expect(refWrites(h)).toBe(0);
  }
  const allowed = harness({ workflows: true });
  await allowed.connect();
  expect((await allowed.request("branch", input)).value.branch).toBe(
    "readme-studio/wf",
  );
  expect(refWrites(allowed)).toBe(1);
});
it("refuses a write whose content does not match its reviewed Result SHA", async () => {
  const h = harness();
  await h.connect();
  const input = await reviewed({
    ...readmeTarget,
    sha,
    content: "# Reviewed",
    message: "update",
    confirmed: true,
  });
  const forged = await h.request("commit", {
    ...input,
    content: "# Swapped after review",
  });
  expect(forged.response.status).toBe(400);
  expect(forged.value.error).toContain("Result SHA");
  expect(puts(h)).toBe(0);
  // The reviewed content itself is accepted.
  expect((await h.request("commit", input)).value.commitSha).toBe(newSha);
  expect(puts(h)).toBe(1);
});
it("refuses a create when the file now exists, with the remote for review", async () => {
  const h = harness({ exists: true });
  await h.connect();
  const result = await h.request(
    "commit",
    await reviewed({
      ...readmeTarget,
      sha: null,
      content: "# New",
      message: "create",
      confirmed: true,
    }),
  );
  expect(result.response.status).toBe(409);
  expect(result.value.error).toContain("README.md now exists");
  expect(result.value.remote.sha).toBe(sha);
  expect(puts(h)).toBe(0);
});
it.each([
  ["no Base SHA", { sha: undefined }, "remote SHA"],
  ["no Result SHA", { resultSha: undefined }, "Result SHA"],
  ["a malformed Result SHA", { resultSha: "abc" }, "Result SHA"],
  ["no change set id", { changeSetId: undefined }, "id"],
])(
  "rejects an update with %s before any GitHub request",
  async (_, change, message) => {
    const h = harness();
    await h.connect();
    const calls = h.upstream.mock.calls.length;
    const input = await reviewed({
      ...readmeTarget,
      sha,
      content: "# New",
      message: "update",
      confirmed: true,
    });
    const result = await h.request("commit", { ...input, ...change });
    expect(result.response.status).toBe(400);
    expect(result.value.error).toContain(message);
    expect(h.upstream.mock.calls.length).toBe(calls);
    expect(puts(h)).toBe(0);
  },
);
