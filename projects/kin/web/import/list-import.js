// Bringing lists into Kin (#452, #453, #457). Pure: no DOM, no storage.
// Text pasted from a notes app, and CSV or text files exported from other
// list apps or a spreadsheet, become rows to preview; nothing here saves.
// Every parser is hand-written (zero dependencies) and bounded.

/** Most rows one import takes. */
export const MAX_IMPORT_ROWS = 200;
/** Longest import file read, in characters (about 1 MB). */
export const MAX_IMPORT_CHARS = 1_000_000;
/** Longest item text kept; Kin's own limit is in bytes, the dialog checks. */
const MAX_TEXT = 1_000;

// Bullets, checkboxes and numbering at the start of a line. A checked box
// marks the row done.
const CHECKED = /^\s*(?:[-*+]\s*)?(?:\[[xX✓✔]\]|☑|✅|✓|✔)\s*/u;
const UNCHECKED = /^\s*(?:[-*+]\s*)?(?:\[\s?\]|☐|⬜|○)\s*/u;
const BULLET = /^\s*(?:[-*+•·▪◦‣⁃]|\d{1,3}[.)]|[a-zA-Z][.)](?=\s))(?:\s+|$)/u;

/** One pasted or plain-text line, tidied: `{ text, done }`, or null for a
 * line with nothing left. */
export function parseListLine(line) {
  let rest = String(line ?? "");
  let done = false;
  if (CHECKED.test(rest)) {
    done = true;
    rest = rest.replace(CHECKED, "");
  } else if (UNCHECKED.test(rest)) {
    rest = rest.replace(UNCHECKED, "");
  } else {
    rest = rest.replace(BULLET, "");
  }
  const text = rest.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text ? { text, done } : null;
}

/**
 * Pasted text or a .txt file as rows: one per non-empty line, bullets and
 * checkboxes removed. Returns `{ rows, skipped, truncated }`, where a row is
 * `{ text, done, duplicate }` and `duplicate` marks a repeat within this
 * import (case-insensitive), so the preview can leave it unticked.
 */
export function parseListText(input) {
  const lines = String(input ?? "").slice(0, MAX_IMPORT_CHARS).replace(/^﻿/, "").split(/\r\n|\r|\n/);
  const rows = [];
  const seen = new Set();
  let skipped = 0;
  let truncated = false;
  for (const line of lines) {
    const row = parseListLine(line);
    if (!row) { if (line.trim()) skipped += 1; continue; }
    if (rows.length >= MAX_IMPORT_ROWS) { truncated = true; break; }
    const key = row.text.toLocaleLowerCase();
    rows.push({ ...row, duplicate: seen.has(key) });
    seen.add(key);
  }
  return { rows, skipped, truncated };
}

/** Whether pasted text looks like a list (two or more non-empty lines). */
export function looksLikeList(text) {
  return String(text ?? "").split(/\r\n|\r|\n/).filter((line) => line.trim()).length >= 2;
}

/**
 * RFC 4180 CSV: fields separated by commas (or semicolons or tabs, when the
 * first line has more of those), quoted fields may hold separators, newlines
 * and doubled quotes. A UTF-8 byte-order mark is dropped. Returns an array of
 * rows (arrays of strings), bounded by MAX_IMPORT_ROWS + 1 (a header).
 */
export function parseCsv(input) {
  const text = String(input ?? "").slice(0, MAX_IMPORT_CHARS).replace(/^﻿/, "");
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const count = (character) => firstLine.split(character).length - 1;
  const separator = [",", ";", "\t"].reduce((best, candidate) => (count(candidate) > count(best) ? candidate : best), ",");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => {
    endField();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };
  while (index < text.length && rows.length <= MAX_IMPORT_ROWS) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false;
      } else {
        field += character;
      }
      index += 1;
      continue;
    }
    if (character === '"' && field === "") quoted = true;
    else if (character === separator) endField();
    else if (character === "\r") { endRow(); if (text[index + 1] === "\n") index += 1; }
    else if (character === "\n") endRow();
    else field += character;
    index += 1;
  }
  if (field !== "" || row.length) endRow();
  return rows.slice(0, MAX_IMPORT_ROWS + 1);
}

const HEADERS = {
  text: ["text", "title", "name", "item", "task", "todo", "to do", "description", "note", "notes", "reminder", "content", "summary"],
  list: ["list", "category", "type", "group", "folder", "project"],
  date: ["date", "due", "due date", "duedate", "planned", "when", "start", "start date", "deadline"],
  done: ["done", "completed", "complete", "status", "checked", "is completed", "finished"],
};

/** Guesses which columns hold the text, list, date and done state from a
 * header row. Unknown columns map to nothing; text falls back to the first
 * column. Returns `{ text, list, date, done }` as column indexes or -1. */
export function guessColumns(header) {
  const names = (header ?? []).map((value) => String(value).trim().toLowerCase());
  const find = (choices) => names.findIndex((name) => choices.includes(name));
  const mapping = { text: find(HEADERS.text), list: find(HEADERS.list), date: find(HEADERS.date), done: find(HEADERS.done) };
  if (mapping.text < 0 && names.length) mapping.text = 0;
  return mapping;
}

/** Whether a header row looks like a header (a known column name). */
export function hasHeader(firstRow) {
  const names = (firstRow ?? []).map((value) => String(value).trim().toLowerCase());
  return names.some((name) => Object.values(HEADERS).some((choices) => choices.includes(name)));
}

/** A civil date (YYYYMMDD number) from an ISO-like date, or null. Ambiguous
 * forms such as 03/04/2026 are not guessed. */
export function parseImportDate(value) {
  const match = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(String(value ?? ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return year * 10_000 + month * 100 + day;
}

const TRUE = new Set(["1", "true", "yes", "y", "x", "done", "completed", "complete", "checked", "finished", "✓", "✔"]);
const SHOPPING = /shop|grocer|buy|market|supermarket/i;

/** Rows of a CSV as import rows, with the chosen columns. A list column
 * whose value mentions shopping or groceries goes to Shopping; anything else
 * to `fallback` ("need" or "shopping"). */
export function csvRows(rows, mapping, { header = true, fallback = "need" } = {}) {
  const body = header ? rows.slice(1) : rows;
  const out = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of body) {
    const cell = (index) => (index >= 0 ? String(row[index] ?? "").trim() : "");
    const text = cell(mapping.text).replace(/\s+/g, " ").slice(0, MAX_TEXT);
    if (!text) { skipped += 1; continue; }
    if (out.length >= MAX_IMPORT_ROWS) break;
    const list = cell(mapping.list);
    const key = text.toLocaleLowerCase();
    out.push({
      text,
      classification: list ? (SHOPPING.test(list) ? "shopping" : "need") : fallback,
      planningDate: parseImportDate(cell(mapping.date)),
      done: TRUE.has(cell(mapping.done).toLowerCase()),
      duplicate: seen.has(key),
    });
    seen.add(key);
  }
  return { rows: out, skipped, truncated: body.length - skipped > MAX_IMPORT_ROWS };
}

/**
 * The commands still needed to import `rows` (each with a client `id`)
 * against the current projection, in order: add, then a planned date, then
 * complete. Rows already saved are skipped, so a retry after a partial
 * import resumes without duplicates.
 */
export function remainingImportSteps(state, rows) {
  const steps = [];
  const items = new Map((state?.items ?? []).map((item) => [item.itemId, item]));
  for (const row of rows) {
    const item = items.get(row.id);
    if (!item) steps.push({ type: "add", id: row.id, text: row.text, classification: row.classification });
    if (row.planningDate != null && (item?.planningDate ?? null) !== row.planningDate)
      steps.push({ type: "set-item-planning-date", itemId: row.id, planningDate: row.planningDate });
    if (row.done && item?.status !== "completed") steps.push({ type: "complete", itemId: row.id });
  }
  return steps;
}
