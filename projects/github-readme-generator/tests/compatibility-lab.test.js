import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeDocument } from "../src/analysis/analyze.js";
import { analyzeCompatibility } from "../src/compatibility/analyze.js";
const analyze = (s) => analyzeCompatibility(analyzeDocument(s));
describe("GitHub Compatibility Lab", () => {
  it("inventories fixture support without claiming exact GitHub parity", () => {
    const findings = analyze(
      readFileSync("tests/fixtures/compatibility/github-patterns.md", "utf8"),
    );
    expect(findings.some((f) => f.githubBehavior === "Likely supported")).toBe(
      true,
    );
    expect(findings.some((f) => f.githubBehavior === "Likely stripped")).toBe(
      true,
    );
    expect(findings.some((f) => f.githubBehavior === "Unsafe")).toBe(true);
    for (const f of findings) {
      expect(f.explanation).toBeTruthy();
      expect(f.suggestedAlternative).toBeTruthy();
      expect(f.sourceRange.line).toBeGreaterThan(0);
    }
  });
  it("checks picture fallback and media syntax without flagging valid theme pairs", () => {
    expect(
      analyze(
        '<picture><source media="prefers-color-scheme: dark" srcset="dark.svg"></picture>',
      ).map((f) => f.ruleId),
    ).toEqual(expect.arrayContaining(["picture-fallback", "source-media"]));
    expect(
      analyze(
        '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><img src="light.svg" alt="Art"></picture>',
      ).some(
        (f) => f.ruleId === "picture-fallback" || f.ruleId === "source-media",
      ),
    ).toBe(false);
  });
  it("checks details nesting and summaries", () => {
    const ids = analyze(
      "<summary>Orphan</summary>\n\n<details><details>Body</details>",
    ).map((f) => f.ruleId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "summary-parent",
        "details-summary",
        "nested-details",
        "details-unclosed",
      ]),
    );
  });
  it("separates mobile table risks from security", () => {
    const findings = analyze(
      '<table width="1200"><tr>' +
        Array(7).fill("<td>x</td>").join("") +
        "<td><table></table></td></tr></table>",
    );
    expect(findings.find((f) => f.ruleId === "table-columns").category).toBe(
      "Layout",
    );
    expect(
      findings.find((f) => f.ruleId === "table-nesting").githubBehavior,
    ).toBe("Needs review");
  });
  it("explains CSS, events and encoded unsafe URLs", () => {
    const ids = analyze(
      '<p style="color:red" onclick="x()"><a href="javascript&#58;alert(1)">bad</a><img src="javascript&#58;x" alt="x"></p>',
    ).map((f) => f.ruleId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "inline-style",
        "event-handler",
        "url-executable",
      ]),
    );
  });
  it.each([
    ["data:image/png;base64,x", "url-data"],
    ["blob:https://example.com/id", "url-blob"],
    ["./assets/a.svg", "relative-url"],
    ["https://github.com/a/b/blob/main/a.svg", "github-blob-image"],
    ["https://raw.githubusercontent.com/a/b/main/a.svg", "raw-github"],
  ])("classifies image URL %s", (url, id) =>
    expect(analyze(`![Image](${url})`).some((f) => f.ruleId === id)).toBe(true),
  );
  it("ignores fenced examples, escaped tags and comments", () => {
    expect(
      analyze(
        "```html\n<script>bad</script>\n```\n\n<!-- <iframe> -->\n\n&lt;script&gt;",
      ),
    ).toEqual([]);
  });
  it("preserves quoted angle characters and original source locations", () => {
    const source = '🌍\r\n\r\n<p title="a > b" style="color:red">text</p>';
    const finding = analyze(source).find((f) => f.ruleId === "inline-style");
    expect(finding.sourceRange).toMatchObject({
      start: source.indexOf("<p"),
      line: 3,
      approximate: false,
    });
  });
});
