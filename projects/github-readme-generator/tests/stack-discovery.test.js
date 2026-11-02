import { describe, it, expect } from "vitest";
import {
  DISCOVERY_LIMITS,
  discoverManifests,
  matchPattern,
  safePath,
  workspacePatterns,
} from "../src/stack-intelligence/discovery.js";
import { StackClient, scanStacks } from "../src/stack-intelligence/client.js";
import { normalizeDependencies } from "../src/stack-intelligence/dependencies.js";
import { readmeSuggestions } from "../src/stack-intelligence/readme-suggestions.js";
import { stackDNA } from "../src/stack-intelligence/dna.js";
import { AuditError } from "../src/repository-audit/github.js";

const HEAD = "c".repeat(40),
  TREE = "d".repeat(40);
const repo = { full_name: "example/mono", default_branch: "main" };
const blob = (path, size = 10, mode = "100644") => ({
  path,
  type: "blob",
  mode,
  size,
  sha: "a".repeat(40),
});
const dir = (path) => ({
  path,
  type: "tree",
  mode: "040000",
  sha: "b".repeat(40),
});
const file = (path, source) => ({
  type: "file",
  path,
  size: Buffer.byteLength(source),
  encoding: "base64",
  content: Buffer.from(source).toString("base64"),
  sha: "e".repeat(40),
});
// Tree entries for every file plus its parent directories.
function treeFor(files) {
  const entries = new Map();
  for (const [path, source] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      entries.set(d, dir(d));
    }
    entries.set(path, blob(path, Buffer.byteLength(source)));
  }
  return [...entries.values()];
}
const contentsPrefix = "/repos/example/mono/contents/";
// A mocked AuditClient: answers the commits, tree and contents calls the
// Nested discovery flow may make and records every request path.
function mockClient(
  files,
  { tree, truncated = false, treeError, headError, contents = {} } = {},
) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path.startsWith("/repos/example/mono/commits?")) {
      if (headError) throw headError;
      return { data: [{ sha: HEAD, commit: { tree: { sha: TREE } } }] };
    }
    if (path === `/repos/example/mono/git/trees/${TREE}?recursive=1`) {
      if (treeError) throw treeError;
      return { data: { tree: tree || treeFor(files), truncated } };
    }
    const ref = path.match(/\?ref=(main|c{40})$/)?.[0];
    if (path === contentsPrefix + ref)
      return {
        data: Object.keys(files)
          .filter((p) => !p.includes("/"))
          .map((p) => ({ type: "file", path: p, size: files[p].length })),
      };
    if (path.startsWith(contentsPrefix) && ref) {
      const decoded = path
        .slice(contentsPrefix.length, -ref.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      if (decoded in contents) return { data: contents[decoded] };
      if (decoded in files) return { data: file(decoded, files[decoded]) };
      throw new AuditError("not-found", "Not found.");
    }
    throw Error("Unexpected request " + path);
  };
  return { client: { request }, calls };
}
// Nested discovery reads at the head commit; root-only analysis at the branch.
const AT_HEAD = "?ref=" + HEAD;
const contentsPaths = (calls) =>
  calls
    .filter(
      (c) =>
        c.startsWith(contentsPrefix) &&
        c !== contentsPrefix + "?ref=main" &&
        c !== contentsPrefix + AT_HEAD,
    )
    .map((c) =>
      c
        .slice(contentsPrefix.length, c.lastIndexOf("?ref="))
        .split("/")
        .map(decodeURIComponent)
        .join("/"),
    );
const pkg = (data) => JSON.stringify(data);

describe("Workspace declarations", () => {
  it("reads package.json workspaces as an array or {packages}", () => {
    expect(
      workspacePatterns({
        "package.json": pkg({ workspaces: ["packages/*", "!packages/skip"] }),
      }).patterns,
    ).toEqual([
      {
        pattern: "packages/*",
        negated: false,
        declaredBy: "package.json workspaces",
      },
      {
        pattern: "packages/skip",
        negated: true,
        declaredBy: "package.json workspaces",
      },
    ]);
    expect(
      workspacePatterns({
        "package.json": pkg({ workspaces: { packages: ["apps/web/"] } }),
      }).patterns.map((p) => p.pattern),
    ).toEqual(["apps/web"]);
    expect(
      workspacePatterns({ "package.json": pkg({ workspaces: "nope" }) })
        .notices[0],
    ).toContain("package.json: workspace declaration could not be read");
    expect(
      workspacePatterns({ "package.json": "{not json" }).notices[0],
    ).toContain("package.json");
  });
  it("reads pnpm-workspace.yaml plain and quoted lists and reports other YAML", () => {
    const read = workspacePatterns({
      "pnpm-workspace.yaml":
        "# comment\npackages:\n  - 'apps/*'\n  - \"libs/**\" # all\n  - tools/cli\n  - '!**/test/**'\ncatalog:\n  react: ^19\n",
    });
    expect(read.patterns.map((p) => [p.pattern, p.negated])).toEqual([
      ["apps/*", false],
      ["libs/**", false],
      ["tools/cli", false],
      ["**/test/**", true],
    ]);
    expect(read.patterns[0].declaredBy).toBe("pnpm-workspace.yaml packages");
    for (const yaml of [
      "packages: [apps/*]\n",
      "packages:\n  - &anchor apps/*\n",
      "packages:\n  - { path: x }\n",
      "packages:\n  key: value\n",
      "packages:\n- &anchor apps/*\n",
    ]) {
      const result = workspacePatterns({ "pnpm-workspace.yaml": yaml });
      expect(result.patterns).toEqual([]);
      expect(result.notices.join(" ")).toContain("not interpreted");
    }
  });
  it("reads a pnpm packages list indented at the key's own column", () => {
    for (const eol of ["\n", "\r\n"]) {
      const yaml = ["packages:", "- 'apps/*'", "- packages/*", "catalog:"];
      const read = workspacePatterns({
        "pnpm-workspace.yaml": [...yaml, "  react: ^19", ""].join(eol),
      });
      expect(read.patterns.map((p) => p.pattern)).toEqual([
        "apps/*",
        "packages/*",
      ]);
      expect(read.notices).toEqual([]);
    }
    // A top-level item under another key is not read as a member.
    expect(
      workspacePatterns({
        "pnpm-workspace.yaml": "other:\n- apps/*\npackages:\n- libs/*\n",
      }).patterns.map((p) => p.pattern),
    ).toEqual(["libs/*"]);
  });
  it("reads Cargo members/exclude, go.work use forms and uv members", () => {
    const read = workspacePatterns({
      "Cargo.toml":
        '[workspace]\nmembers = ["crates/*", "tools/gen"]\nexclude = ["crates/old"]\n[package]\nname = "root"\n',
      "go.work":
        'go 1.22\nuse ./cmd/api\nuse (\n  ./svc/a // comment\n  "./svc/b"\n  .\n)\n',
      "pyproject.toml":
        '[tool.uv.workspace]\nmembers = ["py/*"]\nexclude = ["py/legacy"]\n',
    });
    expect(
      read.patterns.map((p) => [p.pattern, p.negated, p.declaredBy]),
    ).toEqual([
      ["crates/*", false, "Cargo.toml workspace.members"],
      ["tools/gen", false, "Cargo.toml workspace.members"],
      ["crates/old", true, "Cargo.toml workspace.exclude"],
      ["cmd/api", false, "go.work use"],
      ["svc/a", false, "go.work use"],
      ["svc/b", false, "go.work use"],
      ["py/*", false, "pyproject.toml tool.uv.workspace.members"],
      ["py/legacy", true, "pyproject.toml tool.uv.workspace.exclude"],
    ]);
    expect(read.notices).toEqual([]);
    expect(
      workspacePatterns({ "Cargo.toml": "[workspace]\nmembers = 3\n" })
        .notices[0],
    ).toContain("Cargo.toml");
    expect(
      workspacePatterns({ "go.work": "use (\n ./a\n" }).notices[0],
    ).toContain("unterminated");
  });
  it("ignores top-level TOML keys named like Object.prototype members", () => {
    for (const key of ["toString", "constructor", "valueOf", "__proto__"]) {
      expect(
        workspacePatterns({
          "Cargo.toml": `${key} = true\n[workspace]\nmembers = ["crates/*"]\n`,
        }),
      ).toEqual({
        patterns: [
          {
            pattern: "crates/*",
            negated: false,
            declaredBy: "Cargo.toml workspace.members",
          },
        ],
        notices: [],
      });
      expect(
        workspacePatterns({
          "pyproject.toml": `${key} = 1\n[tool.uv.workspace]\nmembers = ["py/*"]\n`,
        }).patterns.map((p) => p.pattern),
      ).toEqual(["py/*"]);
    }
  });
  it("reports an over-long pnpm packages line quickly instead of matching it", () => {
    const started = performance.now();
    const read = workspacePatterns({
      "pnpm-workspace.yaml": "packages:\n  - a" + " ".repeat(200_000) + "# \n",
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(read.patterns).toEqual([]);
    expect(read.notices[0]).toContain("not interpreted");
  });
  it("reports patterns it cannot interpret and maps nothing from them", () => {
    const hostile = [
      "{a,b}/*",
      "[x]",
      "pkg?",
      "../outside",
      "/etc",
      "a\\b",
      "a/../b",
      "a**/b",
    ];
    const read = workspacePatterns({
      "package.json": pkg({ workspaces: hostile }),
    });
    expect(read.patterns).toEqual([]);
    expect(read.notices).toEqual(
      hostile.map((p) => "Workspace pattern not interpreted: " + p),
    );
  });
});

describe("pattern matching", () => {
  it("matches literal, single-segment, any-depth and in-segment patterns", () => {
    expect(matchPattern("packages/web", "packages/web")).toBe(true);
    expect(matchPattern("packages/*", "packages/web")).toBe(true);
    expect(matchPattern("packages/*", "packages/web/sub")).toBe(false);
    expect(matchPattern("packages/*", "packages")).toBe(false);
    expect(matchPattern("packages/**", "packages/a/b/c")).toBe(true);
    expect(matchPattern("packages/**", "packages")).toBe(true);
    expect(matchPattern("**/web", "apps/x/web")).toBe(true);
    expect(matchPattern("apps/**/web", "apps/web")).toBe(true);
    expect(matchPattern("apps/**/web", "apps/a/b/web")).toBe(true);
    expect(matchPattern("apps/app-*", "apps/app-one")).toBe(true);
    expect(matchPattern("apps/app-*", "apps/lib-one")).toBe(false);
    expect(matchPattern("a.b/*", "aXb/c")).toBe(false);
    expect(matchPattern("{a,b}", "a")).toBe(false);
    expect(matchPattern("[x]", "x")).toBe(false);
  });
  it("treats regular-expression characters in a segment as literal text", () => {
    expect(matchPattern("apps/pkg.a*", "apps/pkg.ab")).toBe(true);
    expect(matchPattern("apps/pkg.a*", "apps/pkgXab")).toBe(false);
    expect(matchPattern("apps/a(b)*", "apps/a(b)c")).toBe(true);
    expect(matchPattern("x|*", "packages")).toBe(false);
    expect(matchPattern("x|*", "x|y")).toBe(true);
    expect(matchPattern("libs/c++*", "libs/c++-core")).toBe(true);
    expect(matchPattern("libs/c++*", "libs/ccc")).toBe(false);
    expect(matchPattern("a(*", "a(z")).toBe(true);
    expect(matchPattern("a$^*", "a$^q")).toBe(true);
    for (const pattern of ["c++*", "pkg(*", "x)*", "^*$", "a+*"])
      expect(() => matchPattern(pattern, "anything")).not.toThrow();
  });
  it("matches in-segment wildcards anywhere and collapses repeated **", () => {
    expect(matchPattern("a*b*c", "abc")).toBe(true);
    expect(matchPattern("a*b*c", "aXbYc")).toBe(true);
    expect(matchPattern("a*b*c", "acb")).toBe(false);
    expect(matchPattern("*a", "ba")).toBe(true);
    expect(matchPattern("*a", "ab")).toBe(false);
    expect(matchPattern("a*", "a")).toBe(true);
    expect(matchPattern("*ab*ab", "xabyabab")).toBe(true);
    expect(matchPattern("a/**/**/b", "a/b")).toBe(true);
    expect(matchPattern("a/**/**/b", "a/x/y/b")).toBe(true);
    expect(matchPattern("a/**/**/b", "a/x/c")).toBe(false);
    expect(matchPattern("**/**", "")).toBe(true);
    expect(
      workspacePatterns({
        "package.json": pkg({ workspaces: ["apps/**/**/**/web"] }),
      }).patterns.map((p) => p.pattern),
    ).toEqual(["apps/**/web"]);
  });
  it("stays fast for hostile patterns: repeated ** segments and in-segment wildcards", () => {
    const doubleStars = Array(99).fill("**").join("/") + "/zz";
    const stars = "*a".repeat(140) + "*b";
    const declared = workspacePatterns({
      "package.json": pkg({
        workspaces: [
          ...Array(20).fill(doubleStars),
          ...Array(20).fill(stars + "/x"),
          ...Array(20).fill("**/" + stars),
        ],
      }),
    });
    expect(declared.notices).toEqual([]);
    expect(declared.patterns).toHaveLength(60);
    const tree = [];
    for (let i = 0; i < 20; i++) {
      tree.push(blob(`a/b/c/d${i}/package.json`));
      tree.push(blob(`${"a".repeat(250)}${i}/package.json`));
      tree.push(blob(`l${i}/${"a".repeat(200)}`, 10, "120000"));
    }
    const started = performance.now();
    expect(matchPattern(doubleStars, "a/b/c/zz")).toBe(true);
    expect(matchPattern(doubleStars, "a/b/c/d")).toBe(false);
    expect(matchPattern(stars, "a".repeat(250))).toBe(false);
    const found = discoverManifests(tree, declared.patterns);
    expect(found.toRead).toHaveLength(15);
    expect(found.toRead.every((m) => m.role === "nested")).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("discoverManifests", () => {
  const patterns = workspacePatterns({
    "package.json": pkg({ workspaces: ["packages/*", "!packages/private"] }),
  }).patterns;
  it("separates Workspace members from Nested projects and honours negation", () => {
    const result = discoverManifests(
      treeFor({
        "package.json": "{}",
        "packages/web/package.json": "{}",
        "packages/private/package.json": "{}",
        "docs/site/package.json": "{}",
        "tools/go.mod": "",
      }),
      patterns,
    );
    expect(result.boundaries).toEqual([
      {
        path: "docs/site",
        role: "nested",
        declaredBy: [],
        manifests: ["docs/site/package.json"],
      },
      {
        path: "packages/private",
        role: "nested",
        declaredBy: [],
        manifests: ["packages/private/package.json"],
      },
      {
        path: "packages/web",
        role: "member",
        declaredBy: ["package.json workspaces"],
        manifests: ["packages/web/package.json"],
      },
      {
        path: "tools",
        role: "nested",
        declaredBy: [],
        manifests: ["tools/go.mod"],
      },
    ]);
    expect(result.toRead.map((r) => r.path)).toEqual([
      "packages/web/package.json",
      "tools/go.mod",
      "docs/site/package.json",
      "packages/private/package.json",
    ]);
    expect(result.toRead[0]).toEqual({
      path: "packages/web/package.json",
      file: "package.json",
      project: "packages/web",
      role: "member",
    });
  });
  it("applies the depth and excluded-directory limits and reports them as not read", () => {
    const result = discoverManifests(
      treeFor({
        "a/b/c/d/package.json": "{}",
        "a/b/c/d/e/package.json": "{}",
        "node_modules/x/package.json": "{}",
        "packages/web/node_modules/y/package.json": "{}",
        ".github/actions/x/package.json": "{}",
        "vendor/pkg/go.mod": "",
        "crates/x/target/Cargo.toml": "",
        "examples/__fixtures__/requirements.txt": "",
        "lib/third_party/pyproject.toml": "",
        "dist/package.json": "{}",
        "build/package.json": "{}",
        "out/package.json": "{}",
        "testdata/go.mod": "",
        "fixtures/package.json": "{}",
      }),
      [],
    );
    expect(result.toRead.map((r) => r.path)).toEqual(["a/b/c/d/package.json"]);
    expect(result.found).toBe(14);
    expect(result.notRead).toBe(13);
    expect(result.skipped).toContainEqual({
      path: "a/b/c/d/e/package.json",
      reason: "deeper than 4 directories (limit); not read",
    });
    expect(result.skipped).toContainEqual({
      path: "node_modules/x/package.json",
      reason: "excluded directory (limit); not read",
    });
    expect(result.skipped.every((s) => s.reason.includes("limit"))).toBe(true);
  });
  it("reads at most 15 nested manifests in deterministic order and reports the rest", () => {
    const files = { "package.json": "{}" };
    for (let i = 0; i < 12; i++) files[`packages/p${i}/package.json`] = "{}";
    for (let i = 0; i < 6; i++) files[`examples/e${i}/package.json`] = "{}";
    files["z/package.json"] = "{}";
    const entries = treeFor(files);
    const first = discoverManifests(entries, patterns);
    const shuffled = discoverManifests([...entries].reverse(), patterns);
    expect(first.toRead).toEqual(shuffled.toRead);
    expect(first.toRead).toHaveLength(DISCOVERY_LIMITS.nested);
    // Members first, then Nested projects by depth, then path.
    expect(first.toRead.slice(0, 12).every((r) => r.role === "member")).toBe(
      true,
    );
    expect(first.toRead[12].path).toBe("z/package.json");
    expect(first.toRead.slice(13).map((r) => r.path)).toEqual([
      "examples/e0/package.json",
      "examples/e1/package.json",
    ]);
    expect(first.skipped.map((s) => s.path)).toEqual([
      "examples/e2/package.json",
      "examples/e3/package.json",
      "examples/e4/package.json",
      "examples/e5/package.json",
    ]);
    expect(first.skipped[0].reason).toBe(
      "found, not read (limit of 15 nested manifests)",
    );
    expect(first.found).toBe(19);
    // Over-cap Manifests still belong to boundaries; they are never absent.
    expect(first.boundaries.map((b) => b.path)).toContain("examples/e5");
  });
});

describe("Nested discovery through StackClient", () => {
  const files = {
    "package.json": pkg({
      workspaces: ["packages/*"],
      devDependencies: { vitest: "4" },
    }),
    "go.work": "use ./svc\n",
    "packages/web/package.json": pkg({ dependencies: { react: "19" } }),
    "packages/api/package.json": pkg({ dependencies: { react: "19" } }),
    "svc/go.mod": "module x\nrequire github.com/gin-gonic/gin v1.0.0\n",
    "docs/site/requirements.txt": "mkdocs\n",
  };
  it("reads one tree, root and nested manifests, and records project boundaries (record version 5)", async () => {
    const { client, calls } = mockClient(files);
    const record = await new StackClient({ client, now: () => 5 }).repository(
      repo,
      { nested: true },
    );
    expect(calls.slice(0, 2)).toEqual([
      "/repos/example/mono/commits?sha=main&per_page=1",
      `/repos/example/mono/git/trees/${TREE}?recursive=1`,
    ]);
    expect(calls).not.toContain(contentsPrefix + AT_HEAD);
    expect(calls).not.toContain(contentsPrefix + "?ref=main");
    // Every file is read at the head commit the tree came from.
    for (const call of calls.slice(2))
      expect(call.endsWith(AT_HEAD)).toBe(true);
    expect(contentsPaths(calls)).toEqual([
      "package.json",
      "go.work",
      "svc/go.mod",
      "packages/api/package.json",
      "packages/web/package.json",
      "docs/site/requirements.txt",
    ]);
    expect(record.version).toBe(5);
    expect(record.status).toBe("read");
    expect(record.headSha).toBe(HEAD);
    expect(record.discovery).toEqual({
      nested: true,
      tree: "complete",
      found: 5,
      read: 5,
      skipped: [],
    });
    expect(record.projects).toEqual([
      {
        path: "",
        role: "root",
        declaredBy: [],
        manifests: ["package.json"],
      },
      {
        path: "docs/site",
        role: "nested",
        declaredBy: [],
        manifests: ["docs/site/requirements.txt"],
      },
      {
        path: "packages/api",
        role: "member",
        declaredBy: ["package.json workspaces"],
        manifests: ["packages/api/package.json"],
      },
      {
        path: "packages/web",
        role: "member",
        declaredBy: ["package.json workspaces"],
        manifests: ["packages/web/package.json"],
      },
      {
        path: "svc",
        role: "member",
        declaredBy: ["go.work use"],
        manifests: ["svc/go.mod"],
      },
    ]);
    const web = record.manifests.find((m) => m.project === "packages/web");
    expect(web).toMatchObject({
      path: "packages/web/package.json",
      file: "package.json",
      project: "packages/web",
    });
    // The same dependency in two boundaries stays two records.
    const react = record.dependencies.filter((d) => d.name === "react");
    expect(react.map((d) => [d.project, d.evidence[0].manifest])).toEqual([
      ["packages/api", "packages/api/package.json"],
      ["packages/web", "packages/web/package.json"],
    ]);
    // Root-only notes about unfollowed members no longer apply.
    expect(JSON.stringify(record.manifests)).not.toContain(
      "Workspace members are not followed",
    );
    expect(record.manifests.some((m) => m.path === "go.work")).toBe(false);
    // Stack DNA evidence shows full manifest paths.
    const dna = stackDNA([record]);
    expect(
      dna.technologies
        .find((t) => t.id === "react")
        ?.evidence.map((e) => e.source),
    ).toEqual([
      "packages/api/package.json · dependencies",
      "packages/web/package.json · dependencies",
    ]);
  });
  it("stays within 24 requests per repository at every limit", async () => {
    const big = {
      "package.json": pkg({ workspaces: ["packages/*"] }),
      "Cargo.toml": "[workspace]\nmembers = []\n",
      "pyproject.toml": "[project]\nname = 'x'\n",
      "requirements.txt": "",
      "go.mod": "module x\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "go.work": "use ./packages/p0\n",
    };
    for (let i = 0; i < 40; i++) big[`packages/p${i}/package.json`] = "{}";
    const { client, calls } = mockClient(big);
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    expect(calls).toHaveLength(24);
    expect(record.discovery.read).toBe(5 + 15);
    expect(record.discovery.found).toBe(45);
    expect(record.discovery.skipped).toHaveLength(25);
    expect(record.issues).toEqual([
      "25 nested manifests were found but not read (Discovery limit: 15 per repository).",
    ]);
    expect(record.status).toBe("partial");
  });
  it("keeps root-only analysis on exactly the same requests as before", async () => {
    const { client, calls } = mockClient(files);
    const record = await new StackClient({ client }).repository(repo);
    expect(calls).toEqual([
      contentsPrefix + "?ref=main",
      contentsPrefix + "package.json?ref=main",
    ]);
    expect(record.discovery).toEqual({
      nested: false,
      tree: "not-read",
      found: 1,
      read: 1,
      skipped: [],
    });
    expect(record.headSha).toBeUndefined();
    expect(record.projects).toEqual([
      { path: "", role: "root", declaredBy: [], manifests: ["package.json"] },
    ]);
    expect(record.manifests[0]).toMatchObject({
      path: "package.json",
      file: "package.json",
      project: "",
    });
  });
  it("caches nested and root-only results separately", async () => {
    const { client, calls } = mockClient(files);
    const stack = new StackClient({ client });
    await stack.repository(repo);
    const rootOnly = calls.length;
    const nested = await stack.repository(repo, { nested: true });
    expect(calls.length).toBeGreaterThan(rootOnly);
    const after = calls.length;
    expect((await stack.repository(repo, { nested: true })).projects).toEqual(
      nested.projects,
    );
    expect((await stack.repository(repo)).discovery.nested).toBe(false);
    expect(calls.length).toBe(after);
  });
  it("labels a truncated tree partial and never reports unlisted members absent", async () => {
    const { client } = mockClient(files, { truncated: true });
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    expect(record.status).toBe("partial");
    expect(record.discovery.tree).toBe("truncated");
    expect(record.issues).toContain(
      "GitHub truncated the repository tree; root manifests were found from the root listing, and nested manifests not listed are unknown.",
    );
  });
  it("still reads root manifests and declarations a truncated tree did not list", async () => {
    const files = {
      "go.mod": "module x\nrequire github.com/gin-gonic/gin v1.0.0\n",
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/web/package.json": pkg({ dependencies: { react: "19" } }),
    };
    // The cut falls inside apps/, before the root files that sort after it.
    const { client, calls } = mockClient(files, {
      truncated: true,
      tree: treeFor({
        "apps/web/package.json": files["apps/web/package.json"],
      }),
    });
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    expect(calls).toContain(contentsPrefix + AT_HEAD);
    expect(calls.length).toBeLessThanOrEqual(24);
    expect(contentsPaths(calls)).toEqual([
      "go.mod",
      "pnpm-workspace.yaml",
      "apps/web/package.json",
    ]);
    expect(record.status).toBe("partial");
    expect(record.manifests.map((m) => m.path)).toEqual([
      "go.mod",
      "apps/web/package.json",
    ]);
    expect(record.projects).toEqual([
      { path: "", role: "root", declaredBy: [], manifests: ["go.mod"] },
      {
        path: "apps/web",
        role: "member",
        declaredBy: ["pnpm-workspace.yaml packages"],
        manifests: ["apps/web/package.json"],
      },
    ]);
  });
  it("keeps a truncated tree within 24 requests when the root listing is needed", async () => {
    const big = {
      "package.json": pkg({ workspaces: ["packages/*"] }),
      "Cargo.toml": "[workspace]\nmembers = []\n",
      "pyproject.toml": "[project]\nname = 'x'\n",
      "requirements.txt": "",
      "go.mod": "module x\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "go.work": "use ./packages/p0\n",
    };
    for (let i = 0; i < 40; i++) big[`packages/p${i}/package.json`] = "{}";
    const { client, calls } = mockClient(big, { truncated: true });
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    expect(calls).toHaveLength(24);
    expect(record.discovery.read).toBe(5 + 14);
    expect(record.issues).toContain(
      "At most 14 nested manifests could be read within the budget of 24 requests per repository.",
    );
  });
  it("keeps the scan and root manifests when a workspace pattern holds regular-expression characters", async () => {
    const { client } = mockClient({
      "package.json": pkg({
        workspaces: ["libs/c++*", "apps/a(*", "x|*", "apps/pkg.a*"],
        dependencies: { react: "19" },
      }),
      "libs/c++-core/package.json": "{}",
      "apps/a(b/package.json": "{}",
      "apps/pkgXab/package.json": "{}",
    });
    const records = [];
    await scanStacks([repo], {
      client: new StackClient({ client }),
      nested: true,
      onResult: (r) => records.push(r),
    });
    expect(records[0].status).toBe("read");
    expect(records[0].manifests.map((m) => m.path)).toContain("package.json");
    expect(
      Object.fromEntries(records[0].projects.map((p) => [p.path, p.role])),
    ).toEqual({
      "": "root",
      "apps/a(b": "member",
      "apps/pkgXab": "nested",
      "libs/c++-core": "member",
    });
  });
  it("falls back to root-only reading when the tree fails", async () => {
    const { client, calls } = mockClient(files, {
      treeError: new AuditError("response", "Tree unavailable."),
    });
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    expect(record.status).toBe("partial");
    expect(record.discovery.tree).toBe("failed");
    expect(calls).toContain(contentsPrefix + AT_HEAD);
    expect(contentsPaths(calls)).toEqual(["package.json"]);
    expect(record.projects.map((p) => p.path)).toEqual([""]);
    expect(record.issues.join(" ")).toContain("only root manifests were read");
    // No members were mapped, so the root note still says so.
    expect(record.manifests[0].notes).toContain(
      "Workspace members are not followed; only root declarations were read.",
    );
  });
  it("fails the record when the head commit cannot be read and stops on rate limits", async () => {
    const records = [];
    const { client } = mockClient(files, {
      headError: new AuditError("rate-limit", "Rate limited."),
    });
    const summary = await scanStacks([repo], {
      client: new StackClient({ client }),
      nested: true,
      onResult: (r) => records.push(r),
    });
    expect(records[0].status).toBe("failed");
    expect(summary.stopped).toBe("Rate limited.");
    const broken = mockClient(files, {
      headError: new AuditError("response", "No head."),
    });
    await expect(
      new StackClient({ client: broken.client }).repository(repo, {
        nested: true,
      }),
    ).rejects.toThrow("No head.");
  });
  it("stops reading nested manifests after a forbidden response", async () => {
    let count = 0;
    const { client, calls } = mockClient(files);
    const request = client.request;
    client.request = async (path) => {
      if (path.includes("packages/") && count++ === 0) {
        calls.push(path);
        throw new AuditError("forbidden", "Forbidden.");
      }
      return request(path);
    };
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    expect(record.stopped).toBe("Forbidden.");
    expect(record.status).toBe("partial");
    expect(
      record.discovery.skipped.filter((s) => s.reason.includes("stopped")),
    ).toHaveLength(2);
  });
  it("refuses more than 25 repositories with nested on instead of truncating", async () => {
    const repos = Array.from({ length: 26 }, (_, i) => ({
      full_name: "example/r" + i,
    }));
    let called = 0;
    const client = { repository: async () => called++ };
    await expect(scanStacks(repos, { client, nested: true })).rejects.toThrow(
      "at most 25 repositories",
    );
    expect(called).toBe(0);
    const ok = await scanStacks(repos.slice(0, 25), {
      client: {
        repository: async (r) => ({
          repository: r.full_name,
          status: "none",
          manifests: [],
          issues: [],
        }),
      },
      nested: true,
    });
    expect(ok.completed).toBe(25);
  });
});

describe("malicious paths and responses (#131)", () => {
  const SAFE = new Set(["package.json", "packages/web/package.json", "%2e%2e"]);
  async function scan(tree, extra = {}, rootFiles = {}) {
    const files = {
      "package.json": pkg({ workspaces: ["packages/*", "linked", "missing"] }),
      "packages/web/package.json": pkg({ dependencies: { react: "19" } }),
      ...rootFiles,
    };
    const { client, calls } = mockClient(files, {
      tree: [...treeFor(files), ...tree],
      ...extra,
    });
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    return { record, calls, paths: contentsPaths(calls) };
  }
  it.each([
    ["parent traversal", "../outside/package.json"],
    ["inner traversal", "packages/../../etc/package.json"],
    ["absolute", "/etc/package.json"],
    ["backslash", "packages\\evil/package.json"],
    ["encoded dot-dot", "%2e%2e/package.json"],
    ["encoded dot-dot mixed case", "a/%2E%2e/package.json"],
    ["dot segment", "./package.json"],
    ["empty segment", "packages//package.json"],
    ["control character", "pack\u0000ages/package.json"],
    ["newline", "pack\nages/package.json"],
    ["over-long", "a".repeat(290) + "/package.json"],
  ])("rejects a %s path with a notice and no request", async (_, path) => {
    expect(safePath(path)).toBe(false);
    const { record, paths } = await scan([blob(path)]);
    expect(paths).toEqual(["package.json", "packages/web/package.json"]);
    expect(record.issues.join("\n")).toContain("Unsafe manifest path rejected");
    expect(record.discovery.skipped.map((s) => s.reason)).toContain(
      "unsafe path; not read",
    );
    expect(JSON.stringify(record)).not.toMatch(/[\u0000\n]ages/);
  });
  it("never requests a symlinked member, a symlinked manifest or a submodule", async () => {
    const { record, paths } = await scan([
      blob("linked", 20, "120000"),
      blob("packages/evil/package.json", 20, "120000"),
      {
        path: "packages/sub",
        type: "commit",
        mode: "160000",
        sha: "f".repeat(40),
      },
    ]);
    expect(paths).toEqual(["package.json", "packages/web/package.json"]);
    const issues = record.issues.join("\n");
    expect(issues).toContain(
      "Workspace member linked is a symlink; it was not read.",
    );
    expect(issues).toContain(
      "packages/evil/package.json is a symlink; it was not read.",
    );
    expect(issues).toContain(
      "Workspace member packages/sub is a submodule; it was not read.",
    );
    expect(issues).toContain(
      "Workspace member missing is not in the repository tree; it was not read.",
    );
  });
  it("never reads a symlinked root package.json", async () => {
    const files = { "packages/web/package.json": "{}" };
    const { client, calls } = mockClient(files, {
      tree: [...treeFor(files), blob("package.json", 20, "120000")],
    });
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    expect(contentsPaths(calls)).toEqual(["packages/web/package.json"]);
    expect(record.issues).toContain(
      "package.json: not a regular file within the 256 KB limit.",
    );
  });
  it("reports uninterpreted patterns but still discovers the manifest as a Nested project", async () => {
    const { record } = await scan(
      [],
      {},
      {
        "package.json": pkg({ workspaces: ["{a,b}/*", "[x]"] }),
        "a/one/package.json": "{}",
      },
    );
    expect(record.issues).toContain(
      "Workspace pattern not interpreted: {a,b}/*",
    );
    expect(record.issues).toContain("Workspace pattern not interpreted: [x]");
    expect(record.projects.find((p) => p.path === "a/one").role).toBe("nested");
  });
  it.each([
    ["a different path", (p) => file("packages/other/package.json", "{}")],
    [
      "a symlink target",
      (p) => ({ ...file(p, "{}"), target: "../../etc/passwd" }),
    ],
    ["an oversized file", (p) => ({ ...file(p, "{}"), size: 300_000 })],
    ["bad base64", (p) => ({ ...file(p, "{}"), content: "@@@not-base64@@@" })],
    ["a size mismatch", (p) => ({ ...file(p, "{}"), size: 1 })],
    [
      "non-UTF-8 bytes",
      (p) => ({
        ...file(p, ""),
        size: 2,
        content: Buffer.from([0xff, 0xfe]).toString("base64"),
      }),
    ],
  ])("rejects a nested contents response with %s", async (_, make) => {
    const target = "packages/web/package.json";
    const { record } = await scan([], { contents: { [target]: make(target) } });
    expect(record.status).toBe("partial");
    expect(record.manifests.map((m) => m.path)).toEqual(["package.json"]);
    expect(record.discovery.skipped.map((s) => s.path)).toContain(target);
    expect(record.issues.some((i) => i.startsWith(target + ": "))).toBe(true);
  });
  it.each([
    ["over 256 KB", 300_000],
    ["missing", undefined],
    ["not an integer", 10.5],
  ])(
    "never requests a nested manifest whose tree size is %s",
    async (_, size) => {
      const target = "packages/web/package.json";
      const { record, paths } = await scan([{ ...blob(target), size }]);
      expect(paths).not.toContain(target);
      expect(record.status).toBe("partial");
      expect(record.discovery.skipped).toContainEqual({
        path: target,
        reason: "not a regular file within the 256 KB limit",
      });
      expect(record.issues).toContain(
        target + ": not a regular file within the 256 KB limit.",
      );
    },
  );
  it("bounds CPU and requests for a 100,000-entry tree", async () => {
    const tree = [];
    for (let i = 0; i < 100_000; i++)
      tree.push(
        i % 4 === 0
          ? blob(`node_modules/m${i}/package.json`)
          : i % 4 === 1
            ? blob(`src/f${i}.js`)
            : i % 4 === 2
              ? blob(`deep/a/b/c/d/e${i}/package.json`)
              : blob(`../x${i}/package.json`),
      );
    const started = performance.now();
    const { record, calls } = await scan(tree);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(calls.length).toBeLessThanOrEqual(24);
    expect(record.discovery.skipped.length).toBeLessThanOrEqual(150);
    expect(record.issues.length).toBeLessThanOrEqual(110);
    expect(record.discovery.found).toBe(75_000 + 2);
    expect(record.issues.join(" ")).toContain(
      "more manifests found but not read are not listed",
    );
  });
  it("only ever requests allowlisted, encoded paths", async () => {
    const { calls } = await scan([
      blob("packages/a b#?/package.json"),
      blob("../x/package.json"),
    ]);
    for (const call of calls)
      expect(
        call.startsWith("/repos/example/mono/commits?") ||
          call.startsWith("/repos/example/mono/git/trees/") ||
          call.startsWith(contentsPrefix),
      ).toBe(true);
    expect(calls).toContain(
      contentsPrefix + "packages/a%20b%23%3F/package.json" + AT_HEAD,
    );
    expect(calls.some((c) => c.includes(".."))).toBe(false);
    expect(SAFE.has("package.json")).toBe(true);
  });
});

describe("downstream consumers", () => {
  it("merges dependencies per project boundary", () => {
    const manifest = (path, project) => ({
      path,
      file: "package.json",
      project,
      ecosystem: "Node",
      entries: [
        {
          name: "React",
          role: "runtime",
          evidence: "dependencies",
          line: null,
        },
      ],
    });
    const result = normalizeDependencies("Example/Mono", [
      manifest("package.json", ""),
      manifest("apps/web/package.json", "apps/web"),
    ]);
    expect(
      result.map((d) => [d.project, d.name, d.evidence[0].manifest]),
    ).toEqual([
      ["", "react", "package.json"],
      ["apps/web", "react", "apps/web/package.json"],
    ]);
  });
  it("offers commands only from root manifests, keyed by registry file name", async () => {
    const files = {
      "package.json": pkg({
        workspaces: ["packages/*"],
        scripts: { test: "x" },
      }),
      "packages/web/package.json": pkg({ scripts: { build: "y" } }),
      "packages/py/requirements.txt": "pytest\n",
    };
    const { client } = mockClient(files);
    const record = await new StackClient({ client }).repository(repo, {
      nested: true,
    });
    const ids = readmeSuggestions(record).map((s) => s.id);
    expect(ids).toContain("package.json:test");
    expect(ids).not.toContain("package.json:build");
    expect(ids.some((id) => id.startsWith("packages/"))).toBe(false);
    expect(ids).not.toContain("python:test");
  });
});
