import { describe, it, expect } from "vitest";
import {
  badgeUrl,
  badge,
  picture,
  social,
  project,
  stack,
  createBlock,
  serializeBlocks,
} from "../src/markdown/serialize.js";
import { render } from "../src/markdown/render.js";
import { analyze } from "../src/markdown/compatibility.js";
import { parseSections } from "../src/markdown/sections.js";
import { template, templateNames } from "../src/data/templates.js";
import {
  newDraft,
  saveDrafts,
  readDrafts,
  validateDraft,
} from "../src/state/drafts.js";
import { Store } from "../src/state/store.js";
import { importGithub } from "../src/state/import.js";
describe("portable generators", () => {
  it("uses the message-only Shields form for technology badges", () => {
    expect(
      new URL(badgeUrl({ name: "React", brandColor: "149ECA" })).pathname,
    ).toBe("/badge/React-149ECA");
  });
  it("escapes Shields path segments and query parameters", () => {
    const url = badgeUrl({
      label: "CI-CD_test /",
      message: "all good",
      logo: "react",
      color: "abc123",
    });
    expect(url).toContain("CI--CD__test_%2F-all_good-abc123");
    expect(new URL(url).searchParams.get("logo")).toBe("react");
  });
  it("creates linked theme badges and picture dimensions safely", () => {
    expect(
      badge({ label: "Rust", darkColor: "fff", link: "https://example.com" }),
    ).toContain("<picture>");
    const p = picture({
      light: "https://a.test/light.svg",
      dark: "https://a.test/dark.svg",
      alt: '" <x>',
      width: "400",
      height: '9" onload="bad',
      link: "javascript:bad",
      align: "center",
    });
    expect(p).toContain("prefers-color-scheme: dark");
    expect(p).toContain('width="400"');
    expect(p).not.toContain("onload");
    expect(p).not.toContain("<a");
    expect(p).toContain("&lt;x&gt;");
  });
  it("serializes optional social links and footer safely", () => {
    expect(
      social({
        style: "links",
        items: [
          { name: "Mail", url: "mailto:hello@example.com" },
          { name: "Bad", url: "javascript:alert(1)" },
        ],
      }),
    ).toBe("[Mail](mailto:hello@example.com)");
    expect(
      social({
        style: "footer",
        items: [{ name: "<me>", url: "https://example.com" }],
      }),
    ).toContain("&lt;me&gt;");
  });
  it("renders all project layouts including custom links", () => {
    const p = {
      name: "Project",
      subtitle: "Useful",
      description: "A good thing",
      highlights: "Fast\nAccessible",
      stack: "Rust",
      links: [{ name: "Docs", url: "https://example.com" }],
    };
    expect(project(p)).toContain("- Accessible");
    expect(project(p)).toContain("[Docs]");
    expect(project({ ...p, layout: "compact" })).not.toContain("A good thing");
    expect(project({ ...p, layout: "card" })).toContain("<table>");
  });
  it("supports stack headings and all output styles", () => {
    const s = {
      items: [{ name: "Rust", category: "Languages" }],
      headings: true,
    };
    expect(stack(s)).toContain("### Languages");
    expect(stack({ ...s, style: "chips" })).toContain("<code>Rust</code>");
    expect(stack({ ...s, style: "text" })).toContain("Rust");
  });
  it.each(templateNames)("creates editable %s template", (name) => {
    const blocks = template(name);
    expect(blocks.length).toBeGreaterThan(4);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    expect(serializeBlocks(blocks)).toContain("Your Name");
  });
});
describe("preview trust boundary", () => {
  it("removes script, events, CSS, unsafe URLs and interactive HTML", () => {
    const out = render(
      '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a><iframe src="https://evil.test"></iframe><style>p{color:red}</style><form><button>Submit</button></form>',
    );
    const node = document.createElement("div");
    node.innerHTML = out;
    expect(
      node.querySelector(
        'script,iframe,style,form,button,[onerror],[href^="javascript"]',
      ),
    ).toBeNull();
  });
  it("preserves GFM, details, pictures, code and safe link targets", () => {
    const out = render(
      '# Hi\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Task\n\n```js\nconst x = 1;\n```\n\n<details><summary>More</summary><picture><source media="(prefers-color-scheme: dark)" srcset="https://a.test/dark.svg"><img src="https://a.test/light.svg" alt="Chart"></picture></details>\n\n[Link](https://example.com)',
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<summary>More</summary>");
    expect(out).toContain("<source");
    expect(out).toContain("hljs-keyword");
    expect(out).toContain("noopener noreferrer");
    expect(out).toContain("disabled");
  });
  it.each([
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
    "<img src=x onerror=alert(1)>",
    '<a href="java&#x73;cript:alert(1)">x</a>',
    "<math><mtext><img src=x onerror=alert(1)></mtext></math>",
  ])("sanitizes hostile markup %s", (input) => {
    const node = document.createElement("div");
    node.innerHTML = render(input);
    expect(
      node.querySelector('svg,math,[onerror],[href^="javascript"]'),
    ).toBeNull();
  });
});
describe("analysis and non-destructive state", () => {
  it("reports categorized issues without a numeric score", () => {
    const a = analyze(
      "# A\n### Skip\n# B\n\n![](https://a.test/x)\n\n<script>bad()</script>",
    );
    expect(new Set(a.issues.map((i) => i.category))).toEqual(
      new Set(["Accessibility", "Compatibility", "Structure"]),
    );
    expect(a).not.toHaveProperty("score");
    expect(a.images).toHaveLength(1);
  });
  it("ignores script examples and heading examples in code fences", () => {
    const a = analyze("# Intro\n\n```html\n<script>test</script>\n# Fake\n```");
    expect(a.codeBlocks).toBe(1);
    expect(a.headings).toHaveLength(1);
    expect(a.issues).toHaveLength(0);
  });
  it("preserves Unicode and fence contents when explicitly splitting sections", () => {
    const md =
      "# Héllo 🌍\r\n\r\nText  \n\n## Skills\n```md\n# Not a section\n```\n\n## End\n";
    const pieces = parseSections(md);
    expect(pieces).toHaveLength(3);
    expect(
      serializeBlocks(
        pieces.map((markdown) => ({
          ...createBlock("custom", { markdown }),
          separator: "",
        })),
      ),
    ).toBe(md);
  });
  it("never overwrites raw edits when appending a block and supports undo", () => {
    const store = new Store(newDraft("Test", template("Minimal")));
    const raw = "# Hi\n\n  unusual spacing\n";
    store.raw(raw);
    store.blocks([...store.draft.blocks, createBlock("divider")]);
    expect(store.draft.markdown).toBe(raw + "\n\n---");
    store.undo();
    expect(store.draft.markdown).toBe(raw);
    store.redo();
    expect(store.draft.markdown).toContain("---");
  });
  it("keeps raw section identity stable across consecutive keystrokes", () => {
    const store = new Store(newDraft("Typing", template()));
    store.raw("# First");
    const id = store.draft.blocks[0].id;
    store.raw("# First edit");
    expect(store.draft.blocks[0].id).toBe(id);
    expect(serializeBlocks(store.draft.blocks)).toBe("# First edit");
  });
  it("round-trips drafts and preserves markdown when block metadata is stale", () => {
    const d = newDraft("Draft", template());
    const data = { drafts: [d], active: d.id, settings: { theme: "dark" } };
    saveDrafts(data);
    const restored = readDrafts();
    expect(restored.drafts[0].markdown).toBe(d.markdown);
    expect(restored.settings.theme).toBe("dark");
    const changed = validateDraft({ ...d, markdown: "raw  \n" });
    expect(changed.blocks[0].type).toBe("custom");
    expect(changed.markdown).toBe("raw  \n");
  });
  it("handles 100 KB documents", () => {
    const md =
      "# Intro\n\n" + "A useful line with Unicode 🌍.\n\n".repeat(4000);
    const a = analyze(md);
    expect(a.bytes).toBeGreaterThan(100_000);
    expect(render(md)).toContain("🌍");
  });
});
describe("public import", () => {
  it("uses profile repository and preserves raw text", async () => {
    let url;
    const r = await importGithub("octocat", async (u) => {
      url = u;
      return {
        ok: true,
        text: async () =>
          JSON.stringify(
            u.includes("/readme")
              ? {
                  path: "README.md",
                  sha: "abc",
                  size: 8,
                  encoding: "base64",
                  content: btoa("# Raw\n  "),
                }
              : { default_branch: "main" },
          ),
      };
    });
    expect(url).toContain("/octocat/octocat/readme");
    expect(r.markdown).toBe("# Raw\n  ");
  });
  it("reports missing repositories and invalid input", async () => {
    await expect(
      importGithub("owner/repo", async () => ({ ok: false, status: 404 })),
    ).rejects.toThrow("Repository not found");
    await expect(importGithub("../repo")).rejects.toThrow("Enter a username");
  });
});
