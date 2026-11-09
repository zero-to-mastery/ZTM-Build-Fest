import { describe, it, expect } from "vitest";
import {
  buildDynamicBadge,
  providers,
  repositorySuggestions,
} from "../src/badges/providers/index.js";
import { buildLinkedBadge } from "../src/badges/shields.js";
describe("dynamic provider adapters", () => {
  const config = {
    repository: "mnichols08/readme-studio",
    workflow: "ci.yml",
    branch: "feature/badges",
    event: "push",
    package: "@scope/pkg",
    crate: "serde_json",
    siteId: "12345678-1234-1234-1234-123456789abc",
    image: "_/alpine",
    endpoint: "https://example.com/status.json?a=1&b=2",
  };
  it.each(providers.map((p) => [p.id]))("generates safe %s markup", (id) => {
    const c = {
      ...config,
      package: id === "pypi-version" ? "my-package" : config.package,
    };
    const result = buildDynamicBadge(id, c, { cacheSeconds: "3600" });
    expect(result.lightUrl).toMatch(/^https:\/\/img.shields.io\//);
    expect(buildLinkedBadge(result)).toContain("https://");
    expect(new URL(result.lightUrl).searchParams.get("cacheSeconds")).toBe(
      "3600",
    );
  });
  it("encodes scoped npm and workflow query independently", () => {
    expect(buildDynamicBadge("npm-version", config).lightUrl).toContain(
      "/npm/v/%40scope/pkg",
    );
    const url = new URL(buildDynamicBadge("github-workflow", config).lightUrl);
    expect(url.pathname).toBe(
      "/github/actions/workflow/status/mnichols08/readme-studio/ci.yml",
    );
    expect(url.searchParams.get("branch")).toBe("feature/badges");
  });
  it.each([
    ["github-stars", { repository: "owner/../x" }],
    ["github-workflow", { repository: "owner/repo", workflow: "../ci.yml" }],
    ["npm-version", { package: "Bad Package" }],
    ["npm-version", { package: "@scope/" }],
    ["crates-version", { crate: "x/y" }],
    ["netlify", { siteId: "bad" }],
    ["custom-endpoint", { endpoint: "javascript:alert(1)" }],
    ["custom-endpoint", { endpoint: "https://user:secret@example.com" }],
  ])("rejects malformed %s", (id, c) =>
    expect(() => buildDynamicBadge(id, c)).toThrow(),
  );
  it("offers metadata as suggestions without choosing a target", () => {
    expect(
      repositorySuggestions({
        metadata: {
          githubProfile: { login: "octocat" },
          importSource: { owner: "owner", repository: "repo" },
        },
        blocks: [],
      }),
    ).toEqual(["owner/repo", "octocat/octocat"]);
  });
  it("preserves dynamic paths when applying appearance and dark variants", () => {
    const badge = {
      ...buildDynamicBadge("github-stars", config),
      color: "fff",
      darkColor: "000",
      logo: "github",
    };
    const result = buildLinkedBadge(badge);
    expect(result).toContain("github/stars/");
    expect(result).toContain("color=000");
    expect(result).toContain("<picture>");
  });
});
