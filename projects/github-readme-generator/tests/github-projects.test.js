import { describe, it, expect } from "vitest";
import {
  publicRepository,
  applyRepository,
  fetchProjects,
  fetchProject,
  repositoryIdentity,
  filterRepositories,
  suggestedTechnologies,
} from "../src/projects/github-project.js";
const repo = publicRepository({
  name: "tool",
  full_name: "owner/tool",
  description: "Original",
  homepage: "https://example.com",
  language: "JavaScript",
  topics: ["node", "react", "not-a-technology"],
  stargazers_count: 7,
  forks_count: 2,
  archived: true,
});
describe("GitHub project import", () => {
  it("maps selected fields without inferring personal contributions", () => {
    const { project: p } = applyRepository(repo, [
      "name",
      "description",
      "repositoryUrl",
      "liveUrl",
      "technologies",
      "status",
    ]);
    expect(p.role).toBe("");
    expect(p.highlights).toEqual([]);
    expect(p.liveUrl).toBe("https://example.com");
    expect(p.status).toBe("Archived");
    expect(p.metadata.github.snapshot.stargazers_count).toBe(7);
    expect(p.technologies.map((t) => t.name)).toContain("Node.js");
  });
  it("refreshes untouched fields and preserves manual ownership across repeated refreshes", () => {
    const { project: p } = applyRepository(repo, [
      "name",
      "description",
      "repositoryUrl",
      "liveUrl",
    ]);
    p.description = "My own explanation";
    p.role = "Contributor";
    const next = applyRepository(
      {
        ...repo,
        name: "renamed",
        description: "Changed upstream",
        homepage: "https://new.example.com",
      },
      ["name", "description", "liveUrl"],
      JSON.parse(JSON.stringify(p)),
    );
    expect(next.project.name).toBe("renamed");
    expect(next.project.description).toBe("My own explanation");
    expect(next.preserved).toEqual(["description"]);
    expect(next.project.role).toBe("Contributor");
    expect(
      applyRepository(
        { ...repo, description: "Again" },
        ["description"],
        next.project,
      ).project.description,
    ).toBe("My own explanation");
  });
  it("keeps missing statistics unknown and rejects private/incomplete repositories", () => {
    expect(
      publicRepository({ name: "x", full_name: "o/x" }).stargazers_count,
    ).toBe(null);
    expect(() =>
      publicRepository({ name: "x", full_name: "o/x", private: true }),
    ).toThrow();
    expect(() => publicRepository({})).toThrow();
    expect(
      publicRepository({
        name: "x",
        full_name: "o/x",
        homepage: "javascript:alert(1)",
      }).homepage,
    ).toBe("");
  });
  it("canonicalizes duplicate repo URLs", () => {
    expect(repositoryIdentity("https://github.com/Owner/Repo.git/")).toBe(
      "owner/repo",
    );
    expect(repositoryIdentity("https://other.example/o/r")).toBe("");
  });
  it("filters and sorts cached repositories", () => {
    const r = [
      repo,
      {
        ...repo,
        full_name: "o/z",
        archived: false,
        fork: true,
        language: "Rust",
        stargazers_count: 20,
      },
    ];
    expect(
      filterRepositories(r, { language: "Rust", fork: "only" }),
    ).toHaveLength(1);
    expect(filterRepositories(r, { archived: "exclude" })).toHaveLength(1);
    expect(filterRepositories(r, { sort: "stars" })[0].full_name).toBe("o/z");
  });
  it("preserves partial success with bounded concurrency", async () => {
    let active = 0,
      max = 0;
    const results = await fetchProjects(["o/a", "o/b", "o/c", "o/d"], {
      fetcher: async (url) => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return url.endsWith("/b")
          ? { ok: false, status: 404 }
          : {
              ok: true,
              json: async () => ({
                ...repo,
                name: url.split("/").at(-1),
                full_name: url.split("/repos/")[1],
              }),
            };
      },
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.data)).toHaveLength(3);
    expect(results[1].error).toContain("not found");
  });
  it("reports rate limits and offline failures", async () => {
    await expect(
      fetchProject("o/r", {
        fetcher: async () => ({
          ok: false,
          status: 403,
          headers: new Headers({ "x-ratelimit-reset": "2000000000" }),
        }),
      }),
    ).rejects.toThrow(/rate limit/i);
    await expect(
      fetchProject("o/r", {
        fetcher: async () => {
          throw new TypeError("offline");
        },
      }),
    ).rejects.toThrow(/network|offline|connect/i);
  });
  it("uses only exact technology matches and explicit language fallback", () => {
    expect(
      suggestedTechnologies({
        ...repo,
        language: "COBOL",
        topics: ["reactive-system"],
      }),
    ).toEqual([{ name: "COBOL" }]);
  });
});
