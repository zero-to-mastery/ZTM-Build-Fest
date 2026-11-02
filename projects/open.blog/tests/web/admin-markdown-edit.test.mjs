import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyMarkdownCommand, insertResearchSection, parseVisualMarkdown, visualBlocksToMarkdown } from "../../web/admin/admin.js";

test("portable publication corpus survives visual-editor round trips byte for byte", () => {
  for (const name of ["research", "recipe", "video-lesson", "hostile-html"]) {
    for (const suffix of [".md", ".portable.md"]) {
      const source = readFileSync(new URL(`../fixtures/portable-html/${name}${suffix}`, import.meta.url), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/^---\n[\s\S]*?\n---\n/, "");
      assert.equal(visualBlocksToMarkdown(parseVisualMarkdown(source)), source, `${name}${suffix}`);
    }
  }
});

test("inline formatting wraps selections and selects placeholders", () => {
  assert.deepEqual(applyMarkdownCommand("make this clear", 5, 9, "bold"), {
    value: "make **this** clear",
    start: 7,
    end: 11,
  });
  assert.deepEqual(applyMarkdownCommand("", 0, 0, "italic"), {
    value: "_italic text_",
    start: 1,
    end: 12,
  });
});

test("link formatting preserves text and selects the URL for replacement", () => {
  assert.deepEqual(applyMarkdownCommand("read docs", 5, 9, "link"), {
    value: "read [docs](https://)",
    start: 12,
    end: 20,
  });
});

test("block formatting expands to complete selected lines", () => {
  assert.deepEqual(applyMarkdownCommand("Intro\nFirst\nSecond\nEnd", 8, 17, "quote"), {
    value: "Intro\n> First\n> Second\nEnd",
    start: 6,
    end: 22,
  });
  assert.equal(applyMarkdownCommand("# Old heading", 3, 3, "heading").value, "## Old heading");
  assert.equal(applyMarkdownCommand("## Old heading", 3, 3, "heading-4").value, "#### Old heading");
  assert.equal(applyMarkdownCommand("#### Old heading", 3, 3, "paragraph").value, "Old heading");
});

test("block formatting respects newline selection boundaries", () => {
  assert.equal(applyMarkdownCommand("one\ntwo\nthree", 0, 4, "quote").value, "> one\ntwo\nthree");
  assert.equal(applyMarkdownCommand("\nnext", 0, 0, "heading").value, "## \nnext");
});

test("code formatting chooses inline or fenced Markdown", () => {
  assert.equal(applyMarkdownCommand("const x = 1", 0, 5, "code").value, "`const` x = 1");
  assert.equal(applyMarkdownCommand("one\ntwo", 0, 7, "code").value, "```\none\ntwo\n```");
  assert.equal(applyMarkdownCommand("a ` b", 0, 5, "code").value, "``a ` b``");
  assert.equal(applyMarkdownCommand("one\n```\ntwo", 0, 11, "code").value, "````\none\n```\ntwo\n````");
  assert.equal(applyMarkdownCommand("`foo", 0, 4, "code").value, "`` `foo ``");
  assert.equal(applyMarkdownCommand("foo`", 0, 4, "code").value, "`` foo` ``");
  assert.equal(applyMarkdownCommand("`foo`", 0, 5, "code").value, "`` `foo` ``");
  assert.equal(applyMarkdownCommand(" foo ", 0, 5, "code").value, "`  foo  `");
  assert.equal(applyMarkdownCommand("   ", 0, 3, "code").value, "`   `");
});

test("multiline code fences stay on their own lines beside prose", () => {
  const edit = applyMarkdownCommand("prefix one\ntwo suffix", 7, 14, "code");
  assert.equal(edit.value, "prefix \n```\none\ntwo\n```\n suffix");
  assert.deepEqual([edit.start, edit.end], [12, 19]);
  assert.equal(applyMarkdownCommand("one\ntwo\n", 0, 8, "code").value, "```\none\ntwo\n```");
});

test("research section helpers preserve source and avoid duplicate headings", () => {
  assert.deepEqual(insertResearchSection("Opening.", "abstract"), {
    value: "Opening.\n\n## Abstract\n\n",
    start: 23,
    end: 23,
    inserted: true,
  });
  assert.equal(insertResearchSection("## **Abstract**\nWritten summary.", "abstract", true).inserted, false);
  assert.equal(insertResearchSection("<!--\n## Abstract\n-->", "abstract", false).inserted, true);
  assert.equal(
    insertResearchSection("## Abstract\nSummary.\n", "references").value,
    "## Abstract\nSummary.\n\n## References\n\n",
  );
});

test("visual editing separates ordinary Markdown from protected advanced blocks without losing source", () => {
  const source = [
    "Opening with **bold text** and a [link](https://example.com).",
    "",
    "### Observations",
    "",
    "- First",
    "- Second",
    "",
    "```quiz",
    "What changed?",
    "- [x] The trail",
    "- [ ] The weather",
    "```",
    "",
    "| Place | Note |",
    "| --- | --- |",
    "| Ridge | Wet |",
    "",
  ].join("\n");
  const blocks = parseVisualMarkdown(source);
  assert.deepEqual(
    blocks.filter((block) => block.type !== "space").map((block) => [block.type, block.label || ""]),
    [
      ["paragraph", ""],
      ["heading", ""],
      ["unordered-list", ""],
      ["protected", "Knowledge check"],
      ["protected", "Table"],
    ],
  );
  assert.equal(visualBlocksToMarkdown(blocks), source);
});

test("visual editing protects source that cannot be edited safely", () => {
  const blocks = parseVisualMarkdown("> [!TIP]\n> Keep this callout.\n\n<custom-card>Keep me</custom-card>\n\nhttps://www.youtube.com/watch?v=abc\n\n- [x] Finished\n- [ ] Next\n\nSee [the guide][docs].\n[docs]: /guide/\n\n```js\nconst open = true;\n");
  assert.deepEqual(
    blocks.filter((block) => block.type !== "space").map((block) => block.label),
    ["Callout", "Raw HTML", "Embedded media", "Task list", "Advanced formatting", "Unclosed code block"],
  );
});

test("visual editing protects unsupported block grammar and ambiguous links", () => {
  const source = [
    "A setext heading",
    "---",
    "",
    "***",
    "",
    "    const indented = true;",
    "",
    "Read [the docs](https://example.test/a_(b)_(c)).",
    "",
  ].join("\n");
  const blocks = parseVisualMarkdown(source);
  assert.deepEqual(
    blocks.filter((block) => block.type !== "space").map((block) => block.label),
    ["Setext heading", "Thematic break", "Indented code block", "Advanced link"],
  );
  assert.equal(visualBlocksToMarkdown(blocks), source);
});

test("visual editing protects nested-parenthesis link destinations", () => {
  const source = "Read [the docs](https://example.test/a_((b))).\n";
  const blocks = parseVisualMarkdown(source);
  assert.equal(blocks[0].type, "protected");
  assert.equal(blocks[0].label, "Advanced link");
  assert.equal(visualBlocksToMarkdown(blocks), source);
});

test("fenced code only closes on a valid closing fence", () => {
  const source = "```js\nfirst\n```not-a-close\nlast\n```\n";
  const blocks = parseVisualMarkdown(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].source, source);
});
