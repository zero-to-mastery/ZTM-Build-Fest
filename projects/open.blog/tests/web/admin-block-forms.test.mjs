import assert from "node:assert/strict";
import test from "node:test";

import { parseVisualMarkdown, visualBlocksToMarkdown } from "../../web/admin/admin.js";
import {
  calloutMarkdown,
  editableBlockKind,
  embedProblem,
  parseCallout,
  parseEmbed,
  parsePieceFence,
  parseTable,
  parseTaskList,
  tableMarkdown,
  taskListMarkdown,
} from "../../web/admin/block-forms.js";

const label = (source) => parseVisualMarkdown(source).find((block) => block.type === "protected")?.label;

test("a callout opens a form and writes the same Markdown back", () => {
  const source = "> [!WARNING]\n> Hot pan.\n>\n> Really hot.\n";
  assert.equal(label(source), "Callout");
  assert.equal(editableBlockKind("Callout", source), "callout");
  const parsed = parseCallout(source);
  assert.deepEqual(parsed, { kind: "WARNING", text: "Hot pan.\n\nReally hot." });
  assert.equal(`${calloutMarkdown(parsed)}\n`, source);
  assert.equal(calloutMarkdown({ ...parsed, kind: "TIP" }), "> [!TIP]\n> Hot pan.\n>\n> Really hot.");
});

test("a callout the form would rewrite stays protected", () => {
  for (const source of ["> [!NOTE]\n>   indented\n", "> [!NOTE]\n> a\n> > nested\n", "> [!NOTE]\n"]) {
    // Nested quotes round-trip as text, so only a form that would change bytes is refused.
    const kind = editableBlockKind("Callout", source);
    if (kind) assert.equal(`${calloutMarkdown(parseCallout(source))}\n`, source, source);
  }
  assert.equal(parseCallout("> [!NOTE]\n>text\n"), null, "a missing space would be rewritten");
});

test("task lists keep their checked state and refuse nesting", () => {
  const source = "- [ ] Buy flour\n- [x] Preheat\n";
  assert.equal(label(source), "Task list");
  assert.deepEqual(parseTaskList(source), [
    { checked: false, text: "Buy flour" },
    { checked: true, text: "Preheat" },
  ]);
  assert.equal(`${taskListMarkdown(parseTaskList(source))}\n`, source);
  assert.equal(parseTaskList("- [ ] a\n  - [ ] nested\n"), null);
  assert.equal(parseTaskList("- [ ] a\n- plain\n"), null);
});

test("tables add and remove rows and columns and escape bars", () => {
  const source = "| Name | Qty |\n| :--- | ---: |\n| Flour | 2 |\n| Salt | 1 |\n";
  assert.equal(label(source), "Table");
  const table = parseTable(source);
  assert.deepEqual(table.header, ["Name", "Qty"]);
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(`${tableMarkdown(table)}\n`, source);
  table.rows.push(["Yeast", "a|b"]);
  table.header.push("Note");
  table.align.push("");
  table.rows.forEach((row) => row.push(""));
  assert.equal(tableMarkdown(table).split("\n").at(-1), "| Yeast | a\\|b |  |");
  assert.equal(parseTable("| a | b |\n| --- | --- |\n| only one |\n"), null, "a ragged row stays protected");
  assert.equal(parseTable("| a | b |\n| --- | --- |\n| `x|y` | z |\n"), null, "a bar in code stays protected");
});

test("an embed is a provider and an address", () => {
  const source = "https://www.youtube.com/watch?v=dQw4w9WgXcQ\n";
  assert.equal(label(source), "Embedded media");
  assert.deepEqual(parseEmbed(source), { provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(parseEmbed("https://codepen.io/a/pen/b\n").provider, "codepen");
  assert.equal(embedProblem("codepen", "https://www.youtube.com/watch?v=dQw4w9WgXcQ").includes("not a CodePen address"), true);
  assert.equal(embedProblem("youtube", ""), "Enter the YouTube address.");
  assert.equal(embedProblem("youtube", "https://youtu.be/dQw4w9WgXcQ"), "");
});

test("a piece fence is read for its form, exactly as the engine writes it", () => {
  const source = "```piece hours\nnote: Closed on holidays.\ndays: Mon\nhours: 9 to 5\ndays: Tue\nhours: Closed\n```\n";
  assert.equal(label(source), "Piece");
  assert.equal(visualBlocksToMarkdown(parseVisualMarkdown(source)), source, "byte stable");
  assert.deepEqual(parsePieceFence(source), {
    kind: "hours",
    values: [
      ["note", "Closed on holidays."],
      ["days", "Mon"],
      ["hours", "9 to 5"],
      ["days", "Tue"],
      ["hours", "Closed"],
    ],
  });
  const faq = "````piece faq\nquestion: Why?\nanswer: Because.\n  \n  Really.\n````\n";
  assert.deepEqual(parsePieceFence(faq).values[1], ["answer", "Because.\n\nReally."]);
  assert.equal(editableBlockKind("Piece", source), "piece");
  assert.equal(parsePieceFence("```piece hours\nnot a field line\n```\n"), null);
});

test("other protected blocks stay protected and unchanged", () => {
  for (const [name, source] of [
    ["Knowledge check", "```quiz\nQ?\n- [x] a\n- [ ] b\n```\n"],
    ["Footnote", "Text[^1]\n\n[^1]: Note.\n"],
    ["Raw HTML", "<div class=\"x\">raw</div>\n"],
  ]) {
    const blocks = parseVisualMarkdown(source);
    assert.equal(visualBlocksToMarkdown(blocks), source, name);
    for (const block of blocks.filter((b) => b.type === "protected")) assert.equal(editableBlockKind(block.label, block.source), "", block.label);
  }
});

test("existing content round-trips unchanged with the new labels", () => {
  const source = "# Title\n\nIntro with a [link](/x/).\n\n> [!TIP]\n> Toast.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] one\n- [x] two\n\n```piece button\nlabel: Go\nhref: /go/\n```\n\nEnd.\n";
  assert.equal(visualBlocksToMarkdown(parseVisualMarkdown(source)), source);
});

test("tables and task lists the form would rewrite stay protected", () => {
  for (const source of [
    "|a|b|\n|---|---|\n|1|2|\n",
    "| a | b |\n|:-:|--:|\n| 1 | 2 |\n",
    "| a | b |\n| --- | --- |\n| 1 | 2 |  \n",
    "| a | b |\n| ----- | --- |\n| 1 | 2 |\n",
  ]) {
    assert.equal(parseTable(source), null, source);
    assert.equal(editableBlockKind("Table", source), "", source);
  }
  for (const source of ["* [ ] a\n* [x] b\n", "- [X] a\n", "- [ ] a  \n", "- [ ]  two spaces\n"]) {
    assert.equal(parseTaskList(source), null, source);
    assert.equal(editableBlockKind("Task list", source), "", source);
  }
  assert.notEqual(parseTable("| a | b |\n| --- | --- |\n| 1 | 2 |\n"), null);
});

test("a piece fence with unknown or repeated fields stays protected", () => {
  const hours = {
    kind: "hours",
    fields: [{ name: "note" }],
    list: { fields: [{ name: "days" }, { name: "hours" }] },
  };
  const ok = "```piece hours\nnote: x\ndays: Mon\nhours: 9\ndays: Tue\nhours: 5\n```\n";
  assert.notEqual(parsePieceFence(ok, hours), null);
  assert.equal(editableBlockKind("Piece", ok, [hours]), "piece");
  assert.equal(parsePieceFence("```piece hours\nnote: x\nbogus: y\n```\n", hours), null);
  assert.equal(parsePieceFence("```piece hours\nnote: x\nnote: y\n```\n", hours), null);
  assert.equal(editableBlockKind("Piece", "```piece hours\nbogus: y\n```\n", [hours]), "");
  assert.equal(editableBlockKind("Piece", "```piece nothing\nnote: y\n```\n", [hours]), "");
});
