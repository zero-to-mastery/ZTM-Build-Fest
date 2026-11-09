import { it, expect } from "vitest";
import {
  embedMarkdown,
  normalizeEmbed,
  typingURL,
} from "../src/widgets/embed.js";
import { widgetRegistry } from "../src/widgets/registry.js";
import { widgetHealth } from "../src/widgets/health.js";
import { analyzeDraft } from "../src/markdown/health-analysis.js";
it("registry attributes all seven projects and describes hosting/actions", () => {
  expect(widgetRegistry).toHaveLength(7);
  for (const w of widgetRegistry) {
    expect(w.projectUrl).toMatch(/^https:\/\/github.com\//);
    expect(w.actions).toBeTruthy();
    expect(w.notes).toBeTruthy();
  }
});
it("generates Markdown, linked Markdown, centered HTML and light/dark pictures", () => {
  const s = { image: "https://example.com/light.svg", alt: "Useful graph" };
  expect(embedMarkdown(s)).toBe(
    "![Useful graph](https://example.com/light.svg)",
  );
  expect(embedMarkdown({ ...s, link: "https://example.com" })).toContain(
    "](https://example.com)",
  );
  const pair = embedMarkdown({
    ...s,
    dark: "assets/dark.svg",
    align: "center",
    width: "600",
  });
  expect(pair).toContain('<p align="center">');
  expect(pair).toContain('<source media="(prefers-color-scheme: dark)"');
  expect(pair).toContain('width="600"');
});
it.each([
  { image: "javascript:alert(1)" },
  { image: "data:text/html,evil" },
  { image: "https://example.com/x", link: "javascript:evil" },
  { image: "https://example.com/x", width: '2" onload=evil' },
  { image: "https://example.com/x", height: 5000 },
])("rejects unsafe embed URLs/dimensions", (v) =>
  expect(() => normalizeEmbed(v)).toThrow(),
);
it("escapes image alt markup and never exposes executable SVG", () =>
  expect(
    embedMarkdown({
      image: "https://example.com/a.svg",
      alt: '"><script>x</script>',
      align: "center",
    }),
  ).not.toContain("<script>"));
it("typing URL safely encodes pluses, hashes and Unicode with documented parameters", () => {
  const u = new URL(
    typingURL({
      lines: "C++ & C#\n雪 + Rust",
      font: "Fira Code",
      size: 24,
      duration: 3000,
      color: "123abc",
      center: true,
    }),
  );
  expect(u.searchParams.get("lines")).toBe("C++ & C#;雪 + Rust");
  expect(u.searchParams.get("font")).toBe("Fira Code");
  expect(u.searchParams.get("center")).toBe("true");
  expect(() => typingURL({ lines: "x;y" })).toThrow();
});
it("widget Health detects duplicates, clutter, missing alt and mixed widths", () => {
  const images = Array.from({ length: 4 }, (_, i) => ({
    url: "https://example.com/metrics.svg",
    alt: "",
    section: "Stats",
    width: i ? 200 : 900,
  }));
  const messages = widgetHealth(images)
    .map((v) => v.message)
    .join(" ");
  expect(messages).toMatch(/Repeated widget/);
  expect(messages).toMatch(/descriptive alt/);
  expect(messages).toMatch(/4 widgets/);
  expect(messages).toMatch(/Mixed widget widths/);
});
it("widget examples inside code are not analyzed as rendered widgets", () => {
  const result = analyzeDraft({
    markdown:
      '```html\n<img src="https://example.com/metrics.svg" alt="">\n```',
    blocks: [],
  });
  expect(
    result.analysis.issues.filter((i) => i.category.startsWith("Widget")),
  ).toHaveLength(0);
});
