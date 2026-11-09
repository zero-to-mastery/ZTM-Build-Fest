import { describe, it, expect } from "vitest";
import { heading, divider } from "../src/styling/presentation.js";
import {
  callout,
  details,
  codeSample,
  columns,
} from "../src/styling/blocks.js";
import { stylingHealth } from "../src/styling/health.js";
import { serializeBlock } from "../src/markdown/serialize.js";
import { render } from "../src/markdown/render.js";
import { themeBlocks } from "../src/themes/theme-resolver.js";
import { baseTheme } from "../src/themes/theme-model.js";
describe("Section styling", () => {
  it.each([
    "plain",
    "emoji-accent",
    "minimal-prefix",
    "terminal-prompt",
    "centered",
    "divider-heading",
  ])("escapes %s headings", (style) => {
    const html = render(
      heading("<script>x</script>", { heading: style, decoration: "◆" }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it.each(["rule", "glyph", "ascii", "dots", "none"])(
    "serializes simple %s dividers",
    (style) => {
      const result = divider(style, "<");
      expect(result).not.toContain("style=");
      expect(result).not.toContain("<script");
      if (style === "none") expect(result).toBe("");
    },
  );
  it("produces readable alerts with escaped prose", () => {
    expect(callout({ style: "warning", body: "Be careful" })).toBe(
      "> [!WARNING]\n> Be careful",
    );
    expect(
      callout({ style: "quote", body: "<script>x</script>" }),
    ).not.toContain("> <script>");
  });
  it("protects code fences from embedded delimiters", () => {
    const s = codeSample({
      language: "js",
      code: "```\n<script>alert(1)</script>",
      collapsed: true,
      title: "<img onerror=x>",
    });
    expect(s).toContain("````js");
    expect(s).toContain("&lt;img onerror=x&gt;");
    expect(render(s)).not.toContain("<script>");
    expect(() => codeSample({ language: "js\nonclick=x" })).toThrow();
  });
  it("creates details with open state and safe summaries", () => {
    expect(
      details({ summary: "A & B", body: "**Useful**", open: true }),
    ).toContain("<details open>\n<summary>A &amp; B</summary>");
  });
  it("escapes table content without relying on Markdown inside HTML", () => {
    expect(
      columns({
        leftTitle: "Left",
        leftBody: "<img onerror=x>",
        rightBody: "two\nlines",
      }),
    ).toContain("&lt;img onerror=x&gt;");
    expect(columns({ rightBody: "two\nlines" })).toContain("two<br>lines");
  });
  it("centers badges using HTML while leaving custom source unchanged", () => {
    expect(
      serializeBlock({
        type: "badge",
        settings: { label: "Test", presentation: { center: true } },
      }),
    ).toContain('<p align="center"><img');
    const b = { type: "custom", settings: { markdown: "## exact\r\ntext" } };
    expect(themeBlocks([b], baseTheme)[0]).toEqual(b);
  });
  it("flags clutter and nested details without flagging code examples", () => {
    const b = {
      type: "about",
      settings: {
        presentation: {
          heading: "terminal-prompt",
          center: true,
          divider: "rule",
        },
      },
    };
    expect(stylingHealth(Array(6).fill(b))).toHaveLength(3);
    expect(
      stylingHealth([
        { type: "details", settings: { body: "```html\n<details>\n```" } },
      ]),
    ).toEqual([]);
    expect(
      stylingHealth([
        { type: "details", settings: { body: "<details>more</details>" } },
      ]),
    ).toHaveLength(1);
  });
});
