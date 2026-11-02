import { describe, it, expect } from "vitest";
import {
  normalizeProject,
  normalizeShowcase,
} from "../src/projects/project-model.js";
import {
  serializeProject,
  serializeShowcase,
} from "../src/projects/serialize-project.js";
import { serializeBlock, createBlock } from "../src/markdown/serialize.js";
import { validateDraft } from "../src/state/drafts.js";
describe("Project Showcase 2.0", () => {
  it("normalizes legacy fields without losing text", () => {
    const p = normalizeProject({
      name: "CLI",
      icon: "🔧",
      github: "https://github.com/a/b",
      demo: "https://example.com",
      url: "https://docs.example.com",
      highlights: "Architecture\nTests",
      stack: "Node.js, Rust",
      status: "![CI](https://example.com/status.svg)",
      image: "https://example.com/image.png",
    });
    expect(p.emoji).toBe("🔧");
    expect(p.repositoryUrl).toContain("github.com");
    expect(p.highlights.map((h) => h.description)).toEqual([
      "Architecture",
      "Tests",
    ]);
    expect(p.technologies.map((t) => t.name)).toEqual(["Node.js", "Rust"]);
    expect(p.legacyStatusMarkdown).toContain("![CI]");
    expect(p.role).toBe("");
    expect(serializeProject(p)).toContain("https://docs.example.com");
  });
  it("leaves saved legacy source exact until explicit migration", () => {
    const b = createBlock("projects", {
      items: [
        {
          name: "Old",
          description: "<b>original</b>",
          highlights: "A\nB",
          stack: "React",
        },
      ],
    });
    const markdown = serializeBlock(b),
      draft = validateDraft({ name: "Old", markdown, blocks: [b] });
    expect(draft.markdown).toBe(markdown);
    expect(draft.blocks[0].type).toBe("projects");
    expect(draft.blocks[0].settings.version).toBeUndefined();
  });
  it("escapes untrusted prose and renders only safe populated links", () => {
    const p = normalizeProject({
      schemaVersion: 1,
      name: "<script>bad</script>",
      description: "[bad](javascript:alert(1))",
      role: "Contributor",
      links: [{ name: "Docs", url: "javascript:bad" }],
      repositoryUrl: "https://example.com/a(b)",
      imageUrl: "javascript:bad",
    });
    const output = serializeProject(p);
    expect(output).not.toContain("<script>");
    expect(output).not.toContain('src="javascript');
    expect(output).toContain("a%28b%29");
    expect(output).not.toContain("[Docs]");
  });
  it.each(["chips", "badges", "text"])(
    "supports %s technologies",
    (technologyStyle) => {
      const p = normalizeProject({
        schemaVersion: 1,
        name: "App",
        technologyStyle,
        technologies: ["React"],
      });
      const md = serializeProject(p);
      expect(md).toContain("React");
      if (technologyStyle === "chips") expect(md).toContain("<code>");
      if (technologyStyle === "badges") expect(md).toContain("img.shields.io");
    },
  );
  it("round trips new blocks and regenerates duplicate project IDs", () => {
    const p = normalizeProject({ name: "App" }),
      s = normalizeShowcase({ items: [p, p] });
    expect(new Set(s.items.map((i) => i.id)).size).toBe(2);
    const b = createBlock("projects", s),
      markdown = serializeShowcase(s);
    expect(
      validateDraft({ name: "X", blocks: [b], markdown }).blocks[0].type,
    ).toBe("projects");
  });
});

describe("Project layouts", () => {
  const p = () =>
    normalizeProject({
      schemaVersion: 1,
      name: "Tool",
      description: "Safe <script>alert(1)</script>",
      role: "Testing Lead",
      highlights: [{ title: "Architecture", description: "Separate concerns" }],
      technologies: ["Rust"],
      repositoryUrl: "https://github.com/a/b",
      imageUrl: "https://example.com/light.png",
      darkImageUrl: "https://example.com/dark.png",
      imageAlt: 'Tool "screen"',
      problem: "Repeated work",
      testing: "Integration coverage",
    });
  it.each([
    "compact",
    "detailed",
    "featured",
    "card",
    "two-column",
    "case-study",
    "featured-first",
  ])("serializes %s without mutating source", (layout) => {
    const s = { title: "Projects", layout, items: [p()] },
      before = structuredClone(s),
      md = serializeShowcase(s);
    expect(md).toContain("Tool");
    expect(md).toContain("https://github.com/a/b");
    expect(md).not.toContain("<script>");
    expect(s).toEqual(before);
  });
  it("creates balanced odd tables and real HTML rather than Markdown in cells", () => {
    const md = serializeShowcase({
      layout: "two-column",
      items: [p(), p(), p()],
    });
    expect(md.match(/<tr>/g)).toHaveLength(2);
    expect(md.match(/<\/tr>/g)).toHaveLength(2);
    expect(md).toContain('colspan="2"');
    expect(md).toContain('<a href="https://github.com/a/b">Repository</a>');
    expect(md).not.toContain("[Repository]");
  });
  it("omits empty case sections and preserves optional populated sections", () => {
    const md = serializeProject(p(), "case-study");
    expect(md).toContain("#### Problem");
    expect(md).toContain("#### Testing");
    expect(md).not.toContain("#### Outcome");
  });
  it("places themed images without source rewrites", () => {
    const x = p();
    x.imagePlacement = "top";
    expect(serializeProject(x).indexOf("<picture>")).toBeLessThan(
      serializeProject(x).indexOf("### Tool"),
    );
    x.imagePlacement = "hidden";
    expect(serializeProject(x)).not.toContain("<picture>");
    x.imagePlacement = "side-by-side";
    expect(serializeProject(x)).toContain('<td valign="top">');
    expect(serializeProject(x)).toContain("prefers-color-scheme: dark");
  });
  it("compact presentation retains all stored highlights when switching back", () => {
    const x = p();
    expect(serializeProject(x, "compact")).not.toContain("Separate concerns");
    expect(serializeProject(x, "detailed")).toContain("Separate concerns");
  });
});
