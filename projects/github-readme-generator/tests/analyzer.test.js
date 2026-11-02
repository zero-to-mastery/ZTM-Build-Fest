import { describe, it, expect } from "vitest";
import { analyzeDocument, documentStats } from "../src/analysis/analyze.js";
import { parseSource } from "../src/analysis/source.js";
describe("source-aware analyzer", () => {
  it("tracks original UTF-16 offsets, Unicode and CRLF", () => {
    const source = "# 🌍\r\n\r\n### Next\r\n\r\n![alt](a.svg)";
    const a = analyzeDocument(source);
    expect(a.headings[1].sourceRange).toMatchObject({
      start: source.indexOf("###"),
      line: 3,
      column: 1,
      approximate: false,
    });
    expect(
      source.slice(a.images[0].sourceRange.start, a.images[0].sourceRange.end),
    ).toBe("![alt](a.svg)");
    expect(a.issues.find((i) => i.ruleId === "heading-skip").reason).toMatch(
      /hierarchy/,
    );
    expect(documentStats(source).bytes).toBe(
      new TextEncoder().encode(source).length,
    );
  });
  it("does not analyze code, escaped tags or comments as markup", () => {
    const a = analyzeDocument(
      '```html\n<script>bad</script>\n# Fake\n```\n\n`<img src="bad">`\n\n&lt;script&gt;\n\n<!-- <img src="bad"> -->',
    );
    expect(a.headings).toHaveLength(0);
    expect(a.images).toHaveLength(0);
    expect(a.htmlBlocks).toHaveLength(0);
    expect(a.codeBlocks).toHaveLength(1);
  });
  it("inventories HTML and distinguishes security from compatibility", () => {
    const a = analyzeDocument(
      '<picture><source srcset="dark.svg"><img src="light.svg" width="1200"></picture>\n\n<script>alert(1)</script>\n\n<iframe src="x"></iframe>',
    );
    expect(a.images[0]).toMatchObject({ missingAlt: true, width: "1200" });
    expect(a.htmlBlocks.some((n) => n.tag === "source")).toBe(true);
    expect(a.issues.find((i) => i.ruleId === "html-script").category).toBe(
      "Security",
    );
    expect(a.issues.find((i) => i.ruleId === "html-iframe").category).toBe(
      "Compatibility",
    );
  });
  it("derives neutral section counts and advisory duplicate titles", () => {
    const a = analyzeDocument(
      "# One\n\n![React](https://img.shields.io/badge/React-blue)\n\n# One\n\n[link](./README.md)",
    );
    expect(a.sections[1]).toMatchObject({ imageCount: 1, badgeCount: 1 });
    expect(a.links[0].kind).toBe("relative");
    expect(a.issues.find((i) => i.ruleId === "multiple-h1").reason).toMatch(
      /not automatically invalid/,
    );
    expect(a.issues.some((i) => i.ruleId === "heading-duplicate")).toBe(true);
  });
  it("distinguishes generic media labels from meaningful and decorative alt", () => {
    const analysis = analyzeDocument(
      "![image](screenshot.png)\n\n![Architecture overview](architecture.svg)\n\n![](divider.svg)",
    );
    expect(
      analysis.issues.filter((issue) => issue.ruleId === "image-alt-quality"),
    ).toHaveLength(1);
    expect(
      analysis.issues.find((issue) => issue.ruleId === "image-alt-quality")
        .message,
    ).toMatch(/generic/i);
    expect(
      analysis.issues.filter((issue) => issue.ruleId === "image-alt"),
    ).toHaveLength(1);
  });
  it("shares immutable tokenization for the same source", () => {
    expect(parseSource("# same")).toBe(parseSource("# same"));
  });
  it.each([100, 250, 500])(
    "completes %i KB with bounded findings",
    (kb) => {
      const source =
        "# Heading\n\nText [link](https://example.com) ![](a.svg)\n\n".repeat(
          Math.ceil((kb * 1024) / 58),
        );
      const a = analyzeDocument(source);
      expect(a.stats.bytes).toBeGreaterThan(900 * kb);
      expect(a.issues.length).toBeLessThanOrEqual(1000);
      expect(a.sections.length).toBeGreaterThan(100);
    },
    20000,
  );
});
it("keeps inline HTML labels and heading bodies out of empty-label diagnostics", () => {
  const a = analyzeDocument(
    'Visit <a href="https://github.com/a/b">Repository</a>.\n\n<h2>About 🌍</h2>\n\nText',
  );
  expect(a.links[0].label).toBe("Repository");
  expect(a.headings[0].title).toBe("About 🌍");
  expect(a.issues.some((i) => i.ruleId === "link-label")).toBe(false);
});
it("keeps malformed and nested source locations bounded and explicitly approximate", () => {
  const source =
    '> ## Nested\r\n> text\r\n\r\n- [link](./a)\r\n  ![alt](./b)\r\n\r\n<picture><img src="x"\r\n';
  const a = analyzeDocument(source);
  for (const item of [
    ...a.headings,
    ...a.links,
    ...a.images,
    ...a.htmlBlocks,
  ]) {
    expect(item.sourceRange.start).toBeGreaterThanOrEqual(0);
    expect(item.sourceRange.end).toBeLessThanOrEqual(source.length);
    expect(typeof item.sourceRange.approximate).toBe("boolean");
  }
});
