import { it, expect } from "vitest";
import {
  repositoryContext,
  repositoryAPI,
  filterContexts,
  authorRepositories,
  technologySuggestions,
  repoBadges,
} from "../src/github/repository-context.js";
import { serializeBlock } from "../src/markdown/serialize.js";
const raw = {
  name: "demo",
  full_name: "ada/demo",
  description: "Useful | <script>alert(1)</script>",
  language: "JavaScript",
  topics: ["react", "pwa", "accessibility"],
  homepage: "https://example.com/demo",
  stargazers_count: 12,
  default_branch: "main",
  archived: true,
};
it("normalizes only public metadata and preserves branch/homepage", () => {
  const r = repositoryContext(raw);
  expect(r.fullName).toBe("ada/demo");
  expect(r.defaultBranch).toBe("main");
  expect(repositoryContext(repositoryAPI(r)).homepage).toBe(r.homepage);
  expect(() => repositoryContext({ ...raw, private: true })).toThrow();
  expect(() => repositoryContext({ ...raw, visibility: "internal" })).toThrow();
  expect(
    repositoryContext({ ...raw, homepage: "javascript:alert(1)" }).homepage,
  ).toBe("");
});
it("filters and sorts without changing input", () => {
  const a = repositoryContext(raw),
    b = repositoryContext({
      ...raw,
      name: "b",
      full_name: "ada/b",
      archived: false,
      stargazers_count: 20,
      created_at: "2025-01-01",
    });
  const repos = [a, b];
  expect(filterContexts(repos, { archived: "exclude" })).toEqual([b]);
  expect(filterContexts(repos, { sort: "stars" })[0]).toBe(b);
  expect(
    filterContexts(repos, { search: "demo", language: "JavaScript" }),
  ).toEqual([a]);
  expect(filterContexts(repos, { sort: "created" })[0]).toBe(b);
  expect(repos[0]).toBe(a);
});
it("suggests known technologies and curated topics without skill claims", () => {
  expect(
    technologySuggestions([repositoryContext(raw)]).map((t) => t.name),
  ).toEqual(
    expect.arrayContaining(["JavaScript", "React", "PWA", "Accessibility"]),
  );
});
it("repository layouts escape untrusted content and retain source ownership outside Markdown", () => {
  for (const layout of ["compact", "detailed", "table", "badges"]) {
    const b = authorRepositories([repositoryContext(raw)], { layout });
    expect(b.githubGenerated.repositories).toEqual(["ada/demo"]);
    expect(serializeBlock(b)).not.toContain("<script>");
    expect(serializeBlock(b)).not.toContain("githubGenerated");
  }
  expect(
    serializeBlock(
      authorRepositories([repositoryContext(raw)], { layout: "table" }),
    ),
  ).toContain("&#124;");
});
it("projects reuse field ownership and live URLs; user confirms technologies", () => {
  const r = repositoryContext(raw),
    b = authorRepositories([r], { action: "projects" });
  expect(b.settings.items[0].metadata.github.generatedFields.liveUrl).toBe(
    raw.homepage,
  );
  expect(b.settings.items[0].status).toBe("Archived");
  expect(
    authorRepositories([r], {
      action: "tech",
      technologies: ["React"],
    }).settings.items.map((t) => t.name),
  ).toEqual(["React"]);
});
it("badges use existing GitHub providers including configured workflows", () => {
  expect(repoBadges(repositoryContext(raw), ["workflow"], "ci.yml")).toContain(
    "github/actions/workflow/status/ada/demo/ci.yml",
  );
  expect(() => repoBadges(repositoryContext(raw), ["workflow"])).toThrow();
  expect(() => authorRepositories([])).toThrow();
});
