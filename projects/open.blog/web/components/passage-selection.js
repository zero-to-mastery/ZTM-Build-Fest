// The page's passage text and the mapping of a reader's selection onto it (ADRs 0076, 0082).
// Shared by the feedback form and the reader's own highlights: both read the build's published
// passage data and turn selected words into a quotation target, and neither changes the page.
//
// Dependency-free; the functions that take a selection read the DOM only to name the section.

import { MAX_QUOTE_CHARS, createQuoteTarget, normalizePassageText } from "./passage-target.js";
import { isPassageRevision, isWorkPath } from "./passage-feedback.js";

export const DATA_ELEMENT_ID = "ob-passages";
export const SUPPORTED_VERSION = 1;
// Far beyond any post's passage text; anything larger is not read at all.
const MAX_DATA_LENGTH = 8_000_000;

export const isText = (value) => typeof value === "string";
const isDigest = (value) => isText(value) && /^[0-9a-f]{32}$/.test(value);

/**
 * The page's passage data as { work, revision, sections: [{ index, anchor?,
 * title?, text, digest }] }, or null when there is none, it cannot be read,
 * or its version is newer than this component knows. Sections are named by
 * their index, so one malformed section makes the whole document unusable
 * rather than shifting the others.
 */
export function readPassages(text) {
  if (!isText(text) || text.length > MAX_DATA_LENGTH) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.version !== SUPPORTED_VERSION) return null;
  if (!isWorkPath(data.work) || !isPassageRevision(data.revision) || !Array.isArray(data.sections)) return null;
  const sections = [];
  for (const [position, section] of data.sections.entries()) {
    if (!section || typeof section !== "object" || section.index !== position) return null;
    if (!isText(section.text) || !isDigest(section.digest)) return null;
    const anchor = section.anchor ?? undefined;
    const title = section.title ?? undefined;
    if ((anchor !== undefined && (!isText(anchor) || anchor === "")) || (title !== undefined && !isText(title))) return null;
    sections.push(Object.freeze({ index: position, anchor, title, text: normalizePassageText(section.text), digest: section.digest }));
  }
  return Object.freeze({ work: data.work, revision: data.revision, sections: Object.freeze(sections) });
}

const SELECTION_PROBLEMS = Object.freeze({
  outside: "Select words inside the post’s text.",
  tooLong: `Select at most ${MAX_QUOTE_CHARS} characters, or choose the whole section instead.`,
  notFound:
    "That selection holds text the form cannot quote, such as a note marker, code, embedded content or more than one section. Select words from one paragraph, or choose the section instead.",
  ambiguous: "Those words appear more than once in this section. Select a few more words around them.",
  splitCharacter: "The selection starts or ends inside a character. Select whole words.",
});

export const selectionProblem = (code) => ({ ok: false, code, message: SELECTION_PROBLEMS[code] });

/**
 * A quotation target for `selected` (the selection's text) in section
 * `index` of the build's passage text. `hint` is roughly where the selection
 * starts in that section, in characters, and only decides between equal
 * quotations; without it, a quotation found more than once is refused rather
 * than guessed. Returns { ok: true, target } or { ok: false, code, message }.
 */
export function quoteFromSelection(passages, index, selected, hint) {
  const section = passages.sections[index];
  if (!section) return selectionProblem("notFound");
  const wanted = Array.from(normalizePassageText(selected));
  if (wanted.length === 0) return selectionProblem("notFound");
  if (wanted.length > MAX_QUOTE_CHARS) return selectionProblem("tooLong");
  const chars = Array.from(section.text);
  const starts = [];
  for (let start = 0; start + wanted.length <= chars.length; start += 1) {
    if (wanted.every((character, offset) => chars[start + offset] === character)) starts.push(start);
  }
  if (starts.length === 0) return selectionProblem("notFound");
  let start = starts[0];
  if (starts.length > 1) {
    if (!Number.isFinite(hint)) return selectionProblem("ambiguous");
    const distance = (candidate) => Math.abs(candidate - hint);
    const [nearest, next] = [...starts].sort((a, b) => distance(a) - distance(b));
    if (distance(nearest) === distance(next)) return selectionProblem("ambiguous");
    start = nearest;
  }
  const made = createQuoteTarget(passages, index, start, start + wanted.length);
  if (!made.ok) return selectionProblem(made.error.code === "splitCharacter" ? "splitCharacter" : "notFound");
  return { ok: true, target: made.target };
}

const HEADINGS = "h1, h2, h3, h4, h5, h6";
// Node.DOCUMENT_POSITION_FOLLOWING; a descendant also follows its ancestor.
const FOLLOWING = 4;

const inside = (container, node) => Boolean(node && container.contains(node));

/**
 * Where a selection is in the post, read from the page only to name the
 * section (by the heading before it) and roughly where in it: { index, text,
 * hint }, or { problem } for a selection the form cannot use, or null when
 * the selection is not in the post at all (text in the form, for instance).
 */
export function locateSelection(prose, selection, passages, doc = document) {
  if (!prose || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startInside = inside(prose, range.startContainer);
  const endInside = inside(prose, range.endContainer);
  if (!startInside && !endInside) return null;
  if (!startInside || !endInside) return { problem: "outside" };
  const anchors = new Set(passages.sections.map((section) => section.anchor).filter((anchor) => anchor !== undefined));
  const headings = Array.from(prose.querySelectorAll(HEADINGS)).filter((heading) => anchors.has(heading.id));
  let heading = null;
  for (const candidate of headings) {
    if (candidate === range.startContainer || candidate.compareDocumentPosition(range.startContainer) & FOLLOWING) heading = candidate;
    else break;
  }
  let index;
  if (heading) {
    const named = passages.sections.filter((section) => section.anchor === heading.id).map((section) => section.index);
    const ordinal = headings.slice(0, headings.indexOf(heading) + 1).filter((candidate) => candidate.id === heading.id).length - 1;
    index = named[ordinal];
  } else {
    index = passages.sections.find((section) => section.anchor === undefined)?.index;
  }
  if (index === undefined) return { problem: "notFound" };
  let hint;
  if (typeof doc.createRange === "function") {
    try {
      const before = doc.createRange();
      if (heading) before.setStartBefore(heading);
      else before.setStart(prose, 0);
      before.setEnd(range.startContainer, range.startOffset);
      hint = Array.from(normalizePassageText(before.toString())).length;
    } catch {
      hint = undefined;
    }
  }
  return { index, text: selection.toString(), hint };
}
