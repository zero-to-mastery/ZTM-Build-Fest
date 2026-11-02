// Bringing lists into Kin (#452): the pasted-list and CSV parsers, column
// guesses, dates and the resumable import plan.
import assert from "node:assert/strict";
import test from "node:test";
import {
  csvRows, guessColumns, hasHeader, looksLikeList, MAX_IMPORT_ROWS, parseCsv, parseImportDate,
  parseListLine, parseListText, remainingImportSteps,
} from "./list-import.js";

test("a pasted line loses bullets, numbering and checkboxes; a ticked box is done", () => {
  assert.deepEqual(parseListLine("- Milk"), { text: "Milk", done: false });
  assert.deepEqual(parseListLine("• Eggs"), { text: "Eggs", done: false });
  assert.deepEqual(parseListLine("12. Bread"), { text: "Bread", done: false });
  assert.deepEqual(parseListLine("3) Butter"), { text: "Butter", done: false });
  assert.deepEqual(parseListLine("- [ ] Call the plumber"), { text: "Call the plumber", done: false });
  assert.deepEqual(parseListLine("- [x] Pay rent"), { text: "Pay rent", done: true });
  assert.deepEqual(parseListLine("☑ Book dentist"), { text: "Book dentist", done: true });
  assert.deepEqual(parseListLine("☐ Book vet"), { text: "Book vet", done: false });
  assert.deepEqual(parseListLine("  Tea   bags  "), { text: "Tea bags", done: false });
  assert.deepEqual(parseListLine("2026 taxes"), { text: "2026 taxes", done: false }, "a number that isn't a list marker stays");
  assert.deepEqual(parseListLine("🍎 Apples"), { text: "🍎 Apples", done: false });
  assert.equal(parseListLine("   "), null);
  assert.equal(parseListLine("- "), null);
});

test("pasted text: one row per line, blanks ignored, repeats marked, bounded", () => {
  const { rows, skipped, truncated } = parseListText("﻿Milk\r\n\r\n- eggs\n• Milk\n-\n");
  assert.deepEqual(rows.map((row) => [row.text, row.duplicate]), [["Milk", false], ["eggs", false], ["Milk", true]]);
  assert.equal(skipped, 1, "a lone bullet counts as skipped");
  assert.equal(truncated, false);
  const many = parseListText(Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, n) => `Item ${n}`).join("\n"));
  assert.equal(many.rows.length, MAX_IMPORT_ROWS);
  assert.equal(many.truncated, true);
  assert.equal(looksLikeList("one line"), false);
  assert.equal(looksLikeList("one\n\ntwo"), true);
});

test("CSV: quotes, separators and newlines in fields, doubled quotes, CRLF, BOM, other separators", () => {
  assert.deepEqual(parseCsv('﻿Title,Notes\r\n"Milk, oat","2 litres"\r\n"Say ""hi""",x\n"Two\nlines",\n'),
    [["Title", "Notes"], ["Milk, oat", "2 litres"], ['Say "hi"', "x"], ["Two\nlines", ""]]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]], "semicolons when the first line uses them");
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]], "tabs too");
  assert.deepEqual(parseCsv("\n\nx\n\n"), [["x"]], "blank lines are ignored");
  assert.deepEqual(parseCsv('"unterminated'), [["unterminated"]], "an unterminated quote ends with the file");
});

test("columns are guessed from common headers", () => {
  assert.deepEqual(guessColumns(["Title", "List", "Due Date", "Completed"]), { text: 0, list: 1, date: 2, done: 3 });
  assert.deepEqual(guessColumns(["Something", "Other"]), { text: 0, list: -1, date: -1, done: -1 });
  assert.equal(hasHeader(["Task", "Due"]), true);
  assert.equal(hasHeader(["Milk", "2"]), false);
});

test("dates: only unambiguous ISO-like forms are read", () => {
  assert.equal(parseImportDate("2026-10-21"), 20261021);
  assert.equal(parseImportDate("2026/1/5"), 20260105);
  assert.equal(parseImportDate("2026-10-21T09:00:00Z"), 20261021);
  assert.equal(parseImportDate("03/04/2026"), null, "day/month order isn't guessed");
  assert.equal(parseImportDate("2026-02-30"), null, "no such day");
  assert.equal(parseImportDate(""), null);
});

test("CSV rows become import rows: shopping lists to Shopping, dates and done read", () => {
  const rows = parseCsv("Title,List,Due,Done\nMilk,Groceries,,no\nFix tap,Home,2026-10-22,yes\n,Home,,\nmilk,Groceries,,\n");
  const { rows: out, skipped } = csvRows(rows, guessColumns(rows[0]));
  assert.deepEqual(out.map(({ text, classification, planningDate, done, duplicate }) => [text, classification, planningDate, done, duplicate]), [
    ["Milk", "shopping", null, false, false],
    ["Fix tap", "need", 20261022, true, false],
    ["milk", "shopping", null, false, true],
  ]);
  assert.equal(skipped, 1);
  const plain = csvRows([["Bread"], ["Jam"]], { text: 0, list: -1, date: -1, done: -1 }, { header: false, fallback: "shopping" });
  assert.deepEqual(plain.rows.map((row) => row.classification), ["shopping", "shopping"]);
});

test("the import plan adds, plans and completes, and resumes without duplicates", () => {
  const rows = [
    { id: "a".repeat(32), text: "Milk", classification: "shopping", planningDate: null, done: false },
    { id: "b".repeat(32), text: "Fix tap", classification: "need", planningDate: 20261022, done: true },
  ];
  assert.deepEqual(remainingImportSteps({ items: [] }, rows).map((step) => step.type), ["add", "add", "set-item-planning-date", "complete"]);
  // The first row and the second's add were saved before a failure.
  const partial = { items: [
    { itemId: "a".repeat(32), status: "active", planningDate: null },
    { itemId: "b".repeat(32), status: "active", planningDate: null },
  ] };
  assert.deepEqual(remainingImportSteps(partial, rows).map((step) => step.type), ["set-item-planning-date", "complete"]);
  const finished = { items: [
    { itemId: "a".repeat(32), status: "active", planningDate: null },
    { itemId: "b".repeat(32), status: "completed", planningDate: 20261022 },
  ] };
  assert.deepEqual(remainingImportSteps(finished, rows), []);
});
