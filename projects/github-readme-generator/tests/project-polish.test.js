import { describe, it, expect } from "vitest";
import { normalizeProject } from "../src/projects/project-model.js";
import {
  projectHealth,
  projectMatches,
} from "../src/projects/project-health.js";
import {
  readProjectPack,
  exportProjectPack,
  mergeProjectPack,
} from "../src/projects/project-pack.js";
import { checkProjectLinks } from "../src/projects/project-links.js";
import { serializeShowcase } from "../src/projects/serialize-project.js";
import { analyzeDraft } from "../src/markdown/health-analysis.js";
import {
  applyRepository,
  publicRepository,
} from "../src/projects/github-project.js";
const project = (value = {}) =>
  normalizeProject({
    schemaVersion: 1,
    name: "Tool",
    description: "Useful CLI",
    role: "Testing Lead",
    repositoryUrl: "https://github.com/a/tool",
    ...value,
  });
describe("Project intelligence", () => {
  it("advises without changing content or claiming abandonment", () => {
    const projects = [
      project({
        description: "",
        role: "",
        imageUrl: "https://example.com/image",
        status: "Active",
        highlights: [{ title: "", description: "" }],
        technologies: ["Node", "Node.js"],
        metadata: {
          github: { snapshot: { archived: true, pushed_at: "2020-01-01" } },
        },
      }),
      project(),
    ];
    const before = structuredClone(projects),
      messages = projectHealth(projects)
        .map((i) => i.message)
        .join(" ");
    for (const term of [
      "description",
      "alt text",
      "personally",
      "empty highlight",
      "aliases",
      "Duplicate project",
      "already included",
      "archived",
      "not been updated recently",
    ])
      expect(messages).toContain(term);
    expect(projects).toEqual(before);
  });
  it("does not flag complete entries and searches status, source and technology", () => {
    const p = project({ status: "Maintained", technologies: ["Node.js"] });
    expect(projectHealth([p])).toEqual([]);
    for (const q of ["tool", "node", "maintained", "a/tool"])
      expect(projectMatches(p, q)).toBe(true);
    expect(projectMatches(p, "python")).toBe(false);
  });
  it("integrates project advice with worker Health analysis", () => {
    const p = project({ description: "" }),
      settings = { version: 1, layout: "detailed", items: [p] };
    expect(
      analyzeDraft({
        markdown: serializeShowcase(settings),
        blocks: [{ type: "projects", settings }],
      }).analysis.issues.some(
        (i) => i.category === "Projects" && i.message.includes("description"),
      ),
    ).toBe(true);
  });
  it.each([10, 25, 50])(
    "completes serialization and analysis for %s rich projects",
    (count) => {
      const projects = Array.from({ length: count }, (_, i) =>
        project({
          name: `Project ${i}`,
          highlights: Array.from({ length: 4 }, () => ({
            title: "Testing",
            description: "Coverage of failure boundaries",
          })),
          technologies: ["Rust", "Node.js"],
          imageUrl: `https://example.com/${i}.png`,
        }),
      );
      const md = serializeShowcase({ items: projects, layout: "two-column" });
      expect(md.match(/<h3>/g)).toHaveLength(count);
      expect(projectHealth(projects).length).toBeLessThan(count * 4);
    },
  );
});
describe("Portable project packs", () => {
  it("round trips only project data and resolves name/id collisions", () => {
    const p = project({ metadata: { unrelated: "secret" } }),
      pack = exportProjectPack([p]);
    expect(JSON.stringify(pack)).not.toContain("secret");
    const added = mergeProjectPack(
      [p],
      readProjectPack(JSON.stringify({ ...pack, projects: [p, p] })),
    );
    expect(added.map((v) => v.name)).toEqual(["Tool (2)", "Tool (3)"]);
    expect(new Set([p.id, ...added.map((v) => v.id)]).size).toBe(3);
  });
  it.each([
    "{",
    { version: 2, type: "project-showcase", projects: [] },
    { version: 1, type: "draft", projects: [] },
    { version: 1, type: "project-showcase", projects: [{ name: "oops" }] },
    {
      version: 1,
      type: "project-showcase",
      projects: [{ schemaVersion: 1, name: "oops", technologies: {} }],
    },
  ])("rejects malformed/future packs %j", (data) =>
    expect(() => readProjectPack(data)).toThrow(),
  );
  it("preserves GitHub refresh ownership after export and reload", () => {
    const repo = publicRepository({
      name: "tool",
      full_name: "a/tool",
      language: "UnknownLanguage",
    });
    const original = applyRepository(repo, ["name", "technologies"]).project;
    const saved = readProjectPack(JSON.stringify(exportProjectPack([original])))
      .projects[0];
    const changed = applyRepository(
      { ...repo, name: "new", language: "Rust" },
      ["name", "technologies"],
      saved,
    );
    expect(changed.preserved).toEqual([]);
    expect(changed.project.technologies[0].name).toBe("Rust");
  });
});
describe("Explicit link checks", () => {
  it("bounds concurrency and distinguishes CORS from missing content", async () => {
    let active = 0,
      max = 0;
    const fetcher = async (url, options) => {
      expect(options.method).toBe("HEAD");
      expect(options.credentials).toBe("omit");
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
      if (url.endsWith("cors")) throw TypeError("CORS");
      return {
        ok: !url.endsWith("missing"),
        status: url.endsWith("missing") ? 404 : 200,
      };
    };
    const result = await checkProjectLinks(
      [
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
        "https://example.com/missing",
        "https://example.com/cors",
        "javascript:alert(1)",
      ],
      { fetcher },
    );
    expect(max).toBeLessThanOrEqual(3);
    expect(result.map((r) => r.state)).toEqual([
      "reachable",
      "reachable",
      "reachable",
      "unavailable",
      "unverified",
      "unverified",
    ]);
  });
  it("times out without blocking other results", async () => {
    const results = await checkProjectLinks(["https://example.com/slow"], {
      timeout: 5,
      fetcher: (_, o) =>
        new Promise((_, reject) =>
          o.signal.addEventListener("abort", () => reject(Error("timeout"))),
        ),
    });
    expect(results[0].state).toBe("unverified");
    expect(results[0].message).toContain("timed out");
  });
});
