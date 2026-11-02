import { describe, it, expect, vi } from "vitest";
import { analyzeManifest } from "../src/stack-intelligence/manifests.js";
import {
  normalizeDependencies,
  normalizeDependencyName,
} from "../src/stack-intelligence/dependencies.js";
import { StackClient } from "../src/stack-intelligence/client.js";
const detect = (path, source, repository = "Example/App") =>
  normalizeDependencies(repository, [analyzeManifest(path, source)]);
describe("direct dependency normalization", () => {
  it.each([
    [
      "package.json",
      '{"dependencies":{"React":"1"},"devDependencies":{"vitest":"1"},"peerDependencies":{"react":"1"}}',
      "node",
      [
        ["react", "peer"],
        ["react", "runtime"],
        ["vitest", "development"],
      ],
    ],
    [
      "Cargo.toml",
      '[dependencies]\nserde="1"\n[build-dependencies]\ncc="1"\n[dev-dependencies]\ninsta="1"',
      "rust",
      [
        ["cc", "build"],
        ["insta", "development"],
        ["serde", "runtime"],
      ],
    ],
    [
      "pyproject.toml",
      '[project]\ndependencies=["Some_Pkg>=1"]\n[build-system]\nrequires=["setuptools"]',
      "python",
      [
        ["setuptools", "build"],
        ["some-pkg", "runtime"],
      ],
    ],
    [
      "requirements.txt",
      "Requests==2\nrequests>=1",
      "python",
      [["requests", "runtime"]],
    ],
    [
      "go.mod",
      "require example.org/Direct v1.0.0\nrequire example.org/indirect v1.0.0 // indirect",
      "go",
      [["example.org/Direct", "runtime"]],
    ],
  ])(
    "normalizes %s with repository association and kinds",
    (path, source, ecosystem, expected) => {
      const result = detect(path, source);
      expect(result.map((item) => [item.name, item.kind])).toEqual(expected);
      for (const item of result) {
        expect(item).toMatchObject({
          ecosystem,
          repository: "example/app",
          direct: true,
        });
        expect(item.evidence[0].manifest).toBe(path);
      }
    },
  );
  it("resolves only referenced Cargo workspace dependencies from the same manifest", () => {
    const result = detect(
      "Cargo.toml",
      `
[workspace.dependencies]
alias = {package="real-crate",version="1"}
unused = "1"
[dependencies]
alias = {workspace=true,optional=true}
missing = {workspace=true}
[target.'cfg(unix)'.build-dependencies]
alias = {workspace=true}
`,
    );
    expect(result.map((d) => [d.name, d.kind])).toEqual([
      ["real-crate", "build"],
      ["real-crate", "optional"],
    ]);
    expect(
      result.every((d) => d.evidence[0].section.includes("inherited")),
    ).toBe(true);
  });
  it("merges Python spelling variants across files, retaining evidence and distinct kinds", () => {
    const manifests = [
      analyzeManifest(
        "pyproject.toml",
        '[project]\ndependencies=["Some_Pkg>=1"]\n[dependency-groups]\ntest=["some.pkg"]',
      ),
      analyzeManifest("requirements.txt", "some-pkg==1"),
    ];
    const result = normalizeDependencies("Example/App", manifests);
    expect(result).toHaveLength(2);
    expect(result.find((d) => d.kind === "runtime").evidence).toHaveLength(2);
    expect(result.find((d) => d.kind === "development").evidence).toHaveLength(
      1,
    );
    expect(
      normalizeDependencies("other/repo", manifests).every(
        (d) => d.repository === "other/repo",
      ),
    ).toBe(true);
  });
  it("keeps Go and Rust spelling while normalizing npm aliases and Python names", () => {
    expect(normalizeDependencyName("Some_Crate", "rust")).toBe("Some_Crate");
    expect(normalizeDependencyName("Example.org/Module", "go")).toBe(
      "Example.org/Module",
    );
    expect(normalizeDependencyName("Some__Pkg.name", "python")).toBe(
      "some-pkg-name",
    );
    const result = detect(
      "package.json",
      '{"dependencies":{"alias":"npm:@Scope/Real@1"}}',
    );
    expect(result[0].name).toBe("@scope/real");
    expect(result[0].evidence[0].section).toContain("alias");
    expect(() => normalizeDependencyName("<script>", "node")).toThrow();
  });
  it("filters legacy indirect and workspace records defensively", () => {
    const result = normalizeDependencies("example/app", [
      {
        ecosystem: "Go",
        path: "go.mod",
        entries: [{ name: "x", role: "indirect" }],
      },
    ]);
    expect(result).toEqual([]);
    expect(() => normalizeDependencies("../app", [])).toThrow();
  });
  it("caches normalized results across repository casing without mixing branches or repositories", async () => {
    const source = '{"dependencies":{"react":"1"}}';
    const request = vi.fn(async (path) => ({
      data: path.includes("package.json")
        ? {
            type: "file",
            path: "package.json",
            size: source.length,
            encoding: "base64",
            content: btoa(source),
          }
        : [{ type: "file", path: "package.json" }],
    }));
    const client = new StackClient({ client: { request } });
    const first = await client.repository({
      full_name: "Example/App",
      default_branch: "main",
    });
    const second = await client.repository({
      full_name: "example/app",
      default_branch: "main",
    });
    expect(second.dependencies).toEqual(first.dependencies);
    expect(second.repository).toBe("example/app");
    expect(request).toHaveBeenCalledTimes(2);
    const other = await client.repository({
      full_name: "Example/Other",
      default_branch: "main",
    });
    expect(other.dependencies[0].repository).toBe("example/other");
    await client.repository({
      full_name: "example/app",
      default_branch: "dev",
    });
    expect(request).toHaveBeenCalledTimes(6);
    expect(first.version).toBe(5);
  });
});
