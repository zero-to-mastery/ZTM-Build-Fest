import { describe, it, expect } from "vitest";
import {
  planRefactors,
  refactorCatalog,
  refactorRegistry,
  applyEdits,
  refactorDiff,
} from "../src/refactors/registry.js";
import { analyzeDocument } from "../src/analysis/analyze.js";
import { Store } from "../src/state/store.js";
import { newDraft } from "../src/state/drafts.js";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
const fix = (source, ids, options) =>
  planRefactors(source, ids, options).newMarkdown;
describe("safe source refactors", () => {
  it("normalizes hierarchy without renaming, preserving Unicode and CRLF", () => {
    const source = "# 🌍\r\n\r\n### Name #\r\n\r\ntext\r\n\r\n##### Deep\r\n";
    const after = fix(source, ["headings"]);
    expect(after).toBe("# 🌍\r\n\r\n## Name #\r\n\r\ntext\r\n\r\n### Deep\r\n");
    expect(fix(after, ["headings"])).toBe(after);
  });
  it("leaves code, comments, escaped HTML and nested headings unchanged", () => {
    const source =
      "# A\n\n```md\n#### Example\n![](x)\n<script>x</script>\n```\n\n<!-- ![](x) <script>x</script> -->\n\n> #### Nested\n\n&lt;script&gt;";
    expect(fix(source, ["headings", "alt", "unsafe"])).toBe(source);
  });
  it("adds explicit TODOs without inventing image descriptions", () => {
    const source =
      '![](a.svg) ![  ](b.svg)\n\n<img src="x.svg"> <img src="y.svg" alt=""> <img alt="Logo" src="z.svg">';
    const after = fix(source, ["alt"]);
    expect(after).toContain("![TODO: describe image](a.svg)");
    expect(after).toContain("![TODO: describe image](b.svg)");
    expect(after).toContain('<img src="x.svg" alt="TODO: describe image">');
    expect(after).toContain('alt="Logo"');
    expect(fix(after, ["alt"])).toBe(after);
  });
  it("does not edit image-looking text inside script content", () => {
    const source = "<script>const example=\"<img src='x'>\";</script>";
    expect(fix(source, ["alt"])).toBe(source);
  });
  it("converts only simple standalone theme pairs and preserves URL queries", () => {
    const source =
      "![Art](light.svg?a=1&b=2#gh-light-mode-only)\r\n![Art](dark.svg?a=2#gh-dark-mode-only)";
    const after = fix(source, ["pictures"]);
    expect(after).toContain("<picture>\r\n");
    expect(after).toContain('src="light.svg?a=1&amp;b=2"');
    expect(after).toContain('srcset="dark.svg?a=2"');
    expect(after).toContain('alt="Art"');
    expect(fix("text " + source, ["pictures"])).toBe("text " + source);
    expect(
      fix(source.replace("![Art](dark", "![Different](dark"), ["pictures"]),
    ).not.toContain("<picture>");
  });
  it("normalizes badge spacing without reordering or changing links", () => {
    const a = "![A](https://img.shields.io/badge/A-blue)",
      b = "[![B](https://img.shields.io/badge/B-red)](https://example.org)";
    expect(fix(a + "   " + b + "\n", ["badges"])).toBe(a + " " + b + "\n");
    const centered = fix(a + " " + b, ["badges"], { badgeMode: "center" });
    expect(centered).toContain('<p align="center">');
    expect(centered.indexOf('alt="A"')).toBeLessThan(
      centered.indexOf('alt="B"'),
    );
    expect(centered).toContain('<a href="https://example.org">');
    expect(
      fix("Some text " + a + " " + b, ["badges"], { badgeMode: "center" }),
    ).toBe("Some text " + a + " " + b);
  });
  it("removes only redundant parsed rules and keeps separators between content", () => {
    const source = "# A\r\n\r\n---\r\n\r\n***\r\n\r\nText\r\n\r\n---\r\n";
    const after = fix(source, ["separators"]);
    expect(after).not.toContain("***");
    expect(after.match(/---/g)).toHaveLength(2);
    expect(after).toContain("Text\r\n");
  });
  it("removes heading-only sections only when selected", () => {
    const source = "# Group\n\n## Body\n\ntext\n\n### Empty\n";
    expect(fix(source, [])).toBe(source);
    expect(fix(source, ["empty"])).toBe("## Body\n\ntext\n\n");
  });
  it("removes complete unsafe blocks but preserves surrounding source and examples", () => {
    const source =
      'Before\r\n\r\n<script>bad()</script>\r\n\r\n<form><input value="x"><button>Go</button></form>\r\n\r\nAfter\r\n\r\n```html\n<script>example</script>\n```';
    const after = fix(source, ["unsafe"]);
    expect(after).toBe(
      "Before\r\n\r\n\r\n\r\n\r\n\r\nAfter\r\n\r\n```html\n<script>example</script>\n```",
    );
    expect(fix("<script>unclosed", ["unsafe"])).toBe("<script>unclosed");
  });
  it("converts simple center wrappers but skips nested block layouts", () => {
    expect(fix('<center><img src="a.svg" alt="A"></center>', ["center"])).toBe(
      '<p align="center"><img src="a.svg" alt="A"></p>',
    );
    const complex = "<center><h2>Title</h2></center>";
    expect(fix(complex, ["center"])).toBe(complex);
  });
  it("normalizes safe URL boundaries without rewriting queries or paths", () => {
    const source =
      '[Repo](HTTPS://WWW.GITHUB.COM/Owner/Repo?b=2&a=%2F#A)\n\n<a href=" https://github.com/A/B?q=a+b&amp;x=2 ">Repo</a>';
    expect(fix(source, ["links"])).toBe(
      '[Repo](https://github.com/Owner/Repo?b=2&a=%2F#A)\n\n<a href="https://github.com/A/B?q=a+b&amp;x=2">Repo</a>',
    );
    expect(fix("[x](javascript:bad)", ["links"])).toBe("[x](javascript:bad)");
  });
  it("combines disjoint edits with an exact mapping and rejects overlaps", () => {
    const source = "# A\n\n### B\n\n![](a.svg)";
    const plan = planRefactors(source, ["headings", "alt"]);
    expect(plan.changes).toHaveLength(2);
    for (const mapping of plan.sourceMapping)
      expect(plan.newMarkdown.slice(mapping.newStart, mapping.newEnd)).toBe(
        plan.changes.find((c) => c.start === mapping.oldStart).after,
      );
    expect(refactorDiff(plan)).toContain("Normalize heading hierarchy");
    expect(() =>
      planRefactors("# A\n\n### Empty\n", ["headings", "empty"]),
    ).toThrow(/overlap/);
    expect(() =>
      applyEdits("abc", [{ start: 0, end: 2, before: "wrong", after: "x" }]),
    ).toThrow(/Source changed/);
  });
  it("exposes a deterministic catalog and transform interface", () => {
    const source = "# A\n\n### B\n\nText";
    expect(refactorCatalog(source)).toEqual(refactorCatalog(source));
    const r = refactorRegistry.find((r) => r.id === "headings");
    expect(r.applicable(source, analyzeDocument(source))).toBe(true);
    expect(r.transform(source).newMarkdown).toContain("## B");
  });
  it("applies as one undo checkpoint and never leaves stale structured blocks", () => {
    const blocks = [
      createBlock("custom", { markdown: "# A\n\n### B\n\n![](a.svg)" }),
    ];
    blocks[0].githubGenerated = { kind: "test" };
    const draft = {
      ...newDraft("Refactor"),
      blocks,
      markdown: serializeBlocks(blocks),
    };
    const before = structuredClone(draft),
      store = new Store(draft);
    store.raw(fix(draft.markdown, ["headings", "alt"]));
    expect(store.past).toHaveLength(1);
    expect(store.draft.blocks[0].type).toBe("custom");
    expect(store.draft.blocks[0].githubGenerated).toBeUndefined();
    store.undo();
    expect(store.draft.markdown).toBe(before.markdown);
    expect(store.draft.blocks).toEqual(before.blocks);
    store.redo();
    expect(store.draft.markdown).toContain("TODO: describe image");
  });
  it("preserves untouched bytes across many independent edits", () => {
    const source = Array.from(
      { length: 100 },
      (_, i) => `## Item ${i}\r\n\r\n![](./${i}.svg)\r\n\r\n`,
    ).join("");
    const plan = planRefactors(source, ["alt"]);
    expect(plan.changes).toHaveLength(100);
    expect(plan.newMarkdown.replaceAll("TODO: describe image", "")).toBe(
      source,
    );
  });
});
it("skips malformed crossing HTML wrappers and ambiguous duplicate alt attributes", () => {
  const source = '<form><div>keep</form></div>\n\n<img src="x" alt="" alt="">';
  expect(fix(source, ["unsafe", "alt"])).toBe(source);
});
it("protects script-like text nested inside an HTML container", () => {
  const source = "<div><script>const x=\"<img src='x'>\";</script></div>";
  expect(fix(source, ["alt"])).toBe(source);
});
it("preserves optional image and link titles when centering badges", () => {
  const source =
    '[![A](https://img.shields.io/badge/A-blue "Image title")](https://example.org "Link title") ![B](https://img.shields.io/badge/B-red)';
  const after = fix(source, ["badges"], { badgeMode: "center" });
  expect(after).toContain('title="Image title"');
  expect(after).toContain('title="Link title"');
});
it("completes a large refactor catalog and patch plan without changing untouched content", () => {
  const source = "# Section\n\n### Heading\n\n![](local.svg)\n\n".repeat(3000);
  const plan = planRefactors(source, ["alt"]);
  expect(plan.changes).toHaveLength(3000);
  expect(plan.newMarkdown.replaceAll("TODO: describe image", "")).toBe(source);
  expect(refactorCatalog(source).find((r) => r.id === "alt").count).toBe(3000);
}, 20000);
it("never removes individual tag-like strings from raw script content", () => {
  const incomplete = '<script>const x="<input>";';
  expect(fix(incomplete, ["unsafe"])).toBe(incomplete);
  const complete =
    'Before\n\n<script>const x="<script><input>";</script>\n\nAfter';
  expect(fix(complete, ["unsafe"])).toBe("Before\n\n\n\nAfter");
});
it("offers centered output even when badge spacing already matches", () => {
  const source =
    "![A](https://img.shields.io/badge/A-blue) ![B](https://img.shields.io/badge/B-red)";
  expect(refactorCatalog(source).find((r) => r.id === "badges").count).toBe(0);
  expect(
    refactorCatalog(source, { badgeMode: "center" }).find(
      (r) => r.id === "badges",
    ).count,
  ).toBe(1);
});
