// <ob-annotations> lets a reader keep highlights and private notes on a post, in their own browser
// (ADRs 0237-0241 and 0243, docs/specs/reader-annotations.md). The page is complete without it: the region's
// static text says what it needs. Nothing is sent anywhere, and nothing is stored until the reader
// saves something.
//
// A highlight or note on selected words is a passage target (ADR 0076) found by the same mapping the
// feedback form uses, over the passage text the build published in <script id="ob-passages">. The
// post itself is never changed: saved passages are painted with the CSS Custom Highlight API where the
// browser has it, and every annotation is also a list item with buttons, so a keyboard or screen
// reader never depends on the paint. A saved annotation is looked up again each visit against the
// published text (ADR 0077): it is current, found again in changed text ("moved"), or stale. A stale
// one is kept, shown with its quoted words and the reason, and never silently moved.
//
// Reading never needs storage. If the browser denies it, is full, or holds data this code cannot
// read, the reader is told, what they add stays in memory until they leave, and the saved data is not
// touched. Every reader-facing string is set as text, never as markup.

import { assessAnnotations, workKey, MAX_NOTE_CHARS } from "./reader-annotations.js";
import { DATA_ELEMENT_ID, locateSelection, quoteFromSelection, readPassages, selectionProblem } from "./passage-selection.js";
import { CHANGED_EVENT, DISABLED_KEY, STORAGE_KEY, addAnnotation, annotationsOf, deleteAnnotation, isDisabled, readStore, setNoteText, writeStore } from "./reader-annotations-store.js";

export const HIGHLIGHT_NAME = "ob-annotation";

const HEADINGS = "h1, h2, h3, h4, h5, h6";
const FOLLOWING = 4;
const SKIPPED = "script, style, template, noscript, ob-annotations, ob-passage-feedback";
// Unicode White_Space, the set the build collapses in passage text.
const WHITE_SPACE = /^\p{White_Space}$/u;

const STATE_WORDS = Object.freeze({
  current: "Found where you saved it",
  reanchored: "Moved: the text changed since you saved this, and the same words were found again",
  stale: "Not found: the text has changed since you saved this",
});
const STALE_REASONS = Object.freeze({
  workUnavailable: "This page's text could not be read.",
  targetInvalid: "The saved passage could not be read.",
  sectionRemoved: "The section it was in is gone.",
  ambiguous: "The words now appear in more than one place, so none was chosen.",
  unverified: "The page has changed and the section cannot be matched with certainty.",
  sectionChanged: "The section has been rewritten.",
  contextChanged: "The words are there, but the text around them has changed.",
  quoteNotFound: "The words are no longer on the page.",
});
const STORAGE_NOTES = Object.freeze({
  blocked: "This browser does not allow saving here, so highlights and notes are kept only until you leave this page.",
  full: "This browser has no room to save more, so your latest changes are kept only until you leave this page. Delete something to make room.",
  unreadable: "Highlights and notes saved earlier in this browser could not be read. They have been left untouched, and anything you add now is kept only until you leave this page.",
  off: "Highlights and notes are turned off in this browser. Nothing is marked in the post and nothing new is saved. Anything saved earlier is kept until you erase it; you can turn this back on, export or erase it in the reading trails panel below.",
});
const PROBLEM_WORDS = Object.freeze({
  tooMany: "There is no room for another annotation. Delete one first.",
  tooLarge: "This is too large to keep. Delete something first.",
  emptyText: "Write a note, or delete this annotation.",
  textTooLong: `A note can hold at most ${MAX_NOTE_CHARS.toLocaleString("en-US")} characters.`,
  forbiddenCharacter: "A note cannot hold control or text-direction characters.",
  missing: "That annotation is no longer saved.",
});

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const short = (text, max = 60) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

/** The sections' extent in the page: for each section index, the heading that opens it (or null for the opening). */
function sectionHeadings(prose, passages) {
  const anchors = new Set(passages.sections.map((section) => section.anchor).filter((anchor) => anchor !== undefined));
  const headings = Array.from(prose.querySelectorAll(HEADINGS)).filter((heading) => anchors.has(heading.id));
  const seen = new Map();
  const byIndex = new Map();
  for (const heading of headings) {
    const ordinal = seen.get(heading.id) ?? 0;
    seen.set(heading.id, ordinal + 1);
    const named = passages.sections.filter((section) => section.anchor === heading.id).map((section) => section.index);
    if (named[ordinal] !== undefined) byIndex.set(named[ordinal], heading);
  }
  return { headings, byIndex };
}

/**
 * The page's text of section `index` as a list of characters, each with where it is: [{ character, node, from, to }],
 * with each run of white space collapsed to one space, as the build writes passage text. Text the reader
 * cannot see as prose (scripts, the annotation panel itself) is left out.
 */
export function sectionStream(prose, passages, index) {
  const { headings, byIndex } = sectionHeadings(prose, passages);
  const opening = passages.sections[index]?.anchor === undefined;
  const start = opening ? null : byIndex.get(index);
  if (!opening && !start) return null;
  const startPosition = headings.indexOf(start);
  const next = opening ? headings[0] : headings[startPosition + 1];
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  const stream = [];
  let pendingSpace = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (start && start !== node && !(start.compareDocumentPosition(node) & FOLLOWING)) continue;
    if (next && (next === node || (next.compareDocumentPosition(node) & FOLLOWING) || next.contains(node))) break;
    if (node.parentElement?.closest(SKIPPED)) continue;
    const value = node.nodeValue;
    let at = 0;
    for (const character of value) {
      const length = character.length;
      if (WHITE_SPACE.test(character)) {
        if (!pendingSpace) pendingSpace = { character: " ", node, from: at, to: at + length };
      } else {
        if (pendingSpace) {
          if (stream.length > 0) stream.push(pendingSpace);
          pendingSpace = null;
        }
        stream.push({ character, node, from: at, to: at + length });
      }
      at += length;
    }
  }
  return stream;
}

const commonSuffix = (wanted, have) => {
  let count = 0;
  while (count < wanted.length && count < have.length && wanted[wanted.length - 1 - count] === have[have.length - 1 - count]) count += 1;
  return count;
};
const commonPrefix = (wanted, have) => {
  let count = 0;
  while (count < wanted.length && count < have.length && wanted[count] === have[count]) count += 1;
  return count;
};

/**
 * A DOM Range over the words of a target in section `index` of the page, or null when the page's text does not
 * hold them as one run (a note marker, code or embedded content in between). The best match by surrounding
 * words, then by nearness to where the build's text put them, is chosen; a tie is no match.
 */
export function rangeFor(prose, passages, index, target, resolved) {
  const stream = sectionStream(prose, passages, index);
  if (!stream) return null;
  const exact = Array.from(target.exact);
  const prefix = Array.from(target.prefix);
  const suffix = Array.from(target.suffix);
  const characters = stream.map((each) => each.character);
  let best = null;
  let tied = false;
  for (let start = 0; start + exact.length <= characters.length; start += 1) {
    if (!exact.every((character, offset) => characters[start + offset] === character)) continue;
    const end = start + exact.length;
    const score = commonSuffix(prefix, characters.slice(Math.max(0, start - prefix.length), start)) + commonPrefix(suffix, characters.slice(end, end + suffix.length));
    const distance = Math.abs(start - resolved.start);
    const better = !best || score > best.score || (score === best.score && distance < best.distance);
    if (better) {
      best = { start, end, score, distance };
      tied = false;
    } else if (best && score === best.score && distance === best.distance) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  const first = stream[best.start];
  const last = stream[best.end - 1];
  try {
    const range = document.createRange();
    range.setStart(first.node, first.from);
    range.setEnd(last.node, last.to);
    return range;
  } catch {
    return null;
  }
}

const storage = () => window.localStorage;
let instances = 0;

export class ObAnnotations extends HTMLElement {
  #passages = null;
  #prose = null;
  #work = null;
  #document = null;
  #persistence = "saved";
  #selected = null;
  #listeners = null;
  #ui = null;
  #editing = null;
  #deleting = null;
  #focusAfter = null;
  #ranges = new Map();

  connectedCallback() {
    if (this.#listeners) return;
    const passages = readPassages(document.getElementById(DATA_ELEMENT_ID)?.textContent);
    const prose = this.closest("article")?.querySelector(".ob-prose") ?? null;
    // Without the page's passage text or its prose the static text stays, as without JavaScript.
    if (!passages || !prose) return;
    this.#passages = passages;
    this.#prose = prose;
    // The path the build published for this post, so /tides/ and /tides/index.html are one work.
    this.#work = { site: location.origin, path: passages.work };
    if (!this.#ui) {
      instances += 1;
      this.#ui = this.#build(`ob-annotations-${instances}`);
      this.querySelector(".ob-annotations-static")?.remove();
      this.append(this.#ui.status, this.#ui.notice, this.#ui.make, this.#ui.list);
    }
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    document.addEventListener("selectionchange", () => this.#selectionChanged(), { signal });
    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === STORAGE_KEY || event.key === DISABLED_KEY) this.#reload();
    }, { signal });
    // The reading-trail panel on the same page changed the saved document.
    window.addEventListener(CHANGED_EVENT, (event) => {
      if (event.detail?.from !== this) this.#reload();
    }, { signal });
    this.#reload();
  }

  disconnectedCallback() {
    this.#listeners?.abort();
    this.#listeners = null;
    this.#paint([]);
  }

  /** What is saved here, read again; used on load and when another tab changes it. */
  #reload() {
    const read = readStore(storage);
    // After a failed write the document in memory holds changes that are saved nowhere else: keep it.
    if (this.#persistence === "full" && (read.status === "ok" || read.status === "empty")) {
      this.#render();
      return;
    }
    if (read.status === "unreadable") this.#persistence = "unreadable";
    else if (read.status === "blocked") this.#persistence = "blocked";
    else this.#persistence = "saved";
    // An unreadable or blocked store keeps what the reader added this visit.
    if (!this.#document || read.status === "ok" || read.status === "empty") this.#document = read.document;
    this.#render();
  }

  #build(id) {
    const status = el("p", "ob-annotations-status");
    status.setAttribute("role", "status");
    const notice = el("p", "ob-annotations-notice");
    notice.hidden = true;

    const make = el("form", "ob-annotations-make");
    make.noValidate = true;
    const heading = el("p", "ob-annotations-lead", "Select words in the post, then use the buttons here. Your highlights and notes stay in this browser and are never sent anywhere.");
    heading.id = `${id}-lead`;
    const selection = el("p", "ob-annotations-selection", "No words selected yet.");
    selection.id = `${id}-selection`;
    const selectionNote = el("p", "ob-annotations-hint");
    selectionNote.id = `${id}-selection-note`;
    selectionNote.hidden = true;

    const highlight = el("button", undefined, "Highlight the selected words");
    highlight.type = "button";
    highlight.setAttribute("aria-describedby", selection.id);

    const where = el("fieldset", "ob-annotations-where");
    where.append(el("legend", undefined, "Add a note to"));
    const radio = (value, label, checked) => {
      const input = el("input");
      input.type = "radio";
      input.name = `${id}-where`;
      input.value = value;
      input.id = `${id}-where-${value}`;
      input.checked = Boolean(checked);
      const wrapper = el("div", "ob-annotations-choice");
      const text = el("label", undefined, label);
      text.htmlFor = input.id;
      wrapper.append(input, text);
      return { input, wrapper };
    };
    const quote = radio("quote", "The words I selected", true);
    const section = radio("section", "A section");
    const work = radio("work", "The whole post");
    const sectionSelect = el("select");
    sectionSelect.id = `${id}-section-select`;
    sectionSelect.setAttribute("aria-label", "Section for the note");
    for (const item of this.#passages.sections) {
      const option = el("option", undefined, item.title || (item.anchor === undefined ? "The opening, before the first heading" : `#${item.anchor}`));
      option.value = String(item.index);
      sectionSelect.append(option);
    }
    if (this.#passages.sections.length === 0) {
      section.input.disabled = true;
      sectionSelect.disabled = true;
    }
    where.append(quote.wrapper, section.wrapper, sectionSelect, work.wrapper);

    const noteField = el("div", "ob-annotations-field");
    const noteText = el("textarea");
    noteText.id = `${id}-note`;
    noteText.rows = 4;
    noteText.maxLength = MAX_NOTE_CHARS;
    const noteLabel = el("label", undefined, "Your note (private)");
    noteLabel.htmlFor = noteText.id;
    const noteError = el("p", "ob-annotations-error");
    noteError.id = `${id}-note-error`;
    noteError.hidden = true;
    noteField.append(noteLabel, noteText, noteError);

    const save = el("button", undefined, "Save note");
    save.type = "submit";
    const actions = el("div", "ob-annotations-actions");
    actions.append(highlight, save);
    make.append(heading, selection, selectionNote, where, noteField, actions);

    const list = el("ol", "ob-annotations-list");
    list.setAttribute("aria-label", "Your highlights and notes on this post");

    highlight.addEventListener("click", () => this.#addHighlight());
    make.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#addNote();
    });
    sectionSelect.addEventListener("focus", () => (section.input.checked = true));
    sectionSelect.addEventListener("change", () => (section.input.checked = true));
    return { id, status, notice, make, list, selection, selectionNote, highlight, quote, section, work, sectionSelect, noteText, noteError, save };
  }

  /** Say something to every reader of the page, once the live region has been quiet. */
  #say(message) {
    const { status } = this.#ui;
    status.textContent = "";
    // A changed text is what a screen reader announces.
    setTimeout(() => {
      status.textContent = message;
    }, 30);
  }

  #selectionChanged() {
    const selection = document.getSelection();
    if (!selection) return;
    const { selectionNote, selection: shown } = this.#ui;
    const located = locateSelection(this.#prose, selection, this.#passages);
    if (located === null) {
      // A collapsed caret in the post clears the choice; focus moving into the panel does not.
      if (selection.rangeCount > 0 && selection.isCollapsed && this.#prose.contains(selection.anchorNode)) {
        this.#selected = null;
        shown.textContent = "No words selected yet.";
        selectionNote.hidden = true;
      }
      return;
    }
    const made = located.problem ? selectionProblem(located.problem) : quoteFromSelection(this.#passages, located.index, located.text, located.hint);
    if (!made.ok) {
      this.#selected = null;
      shown.textContent = "No words selected yet.";
      selectionNote.textContent = made.message;
      selectionNote.hidden = false;
      return;
    }
    this.#selected = made.target;
    shown.textContent = `Selected: “${short(made.target.exact, 120)}”`;
    selectionNote.hidden = true;
  }

  #fail(message) {
    this.#say(message);
  }

  /** Apply a change to the freshest saved document, keep it, and report where it went. */
  #commit(change) {
    let base = this.#document;
    // When storage is full, the document in memory is the freshest: it holds the changes that could not be saved.
    if (this.#persistence === "saved") {
      const read = readStore(storage);
      if (read.status === "ok" || read.status === "empty") base = read.document;
      else if (read.status === "unreadable") this.#persistence = "unreadable";
      else if (read.status === "blocked") this.#persistence = "blocked";
    }
    const result = change(base);
    if (!result.ok) return result;
    this.#document = result.document;
    if (this.#persistence === "saved" || this.#persistence === "full") {
      const written = writeStore(storage, result.document);
      this.#persistence = written.ok ? "saved" : written.reason;
      if (written.ok) window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { from: this } }));
    }
    return result;
  }

  #addHighlight() {
    if (!this.#selected) {
      this.#fail("Select some words in the post first.");
      return;
    }
    const result = this.#commit((document) => addAnnotation(document, { work: this.#work, revision: this.#passages.revision, target: this.#selected }));
    if (!result.ok) {
      this.#fail(PROBLEM_WORDS[result.problem.code] ?? "That could not be saved.");
      return;
    }
    this.#render();
    this.#say(`Highlighted: ${short(this.#selected.exact)}. ${this.#savedWords()}`);
  }

  #savedWords() {
    return this.#persistence === "saved" ? "Saved in this browser." : "Kept until you leave this page.";
  }

  #addNote() {
    const ui = this.#ui;
    ui.noteError.hidden = true;
    ui.noteText.removeAttribute("aria-invalid");
    ui.noteText.removeAttribute("aria-describedby");
    const text = ui.noteText.value;
    const refuse = (message) => {
      ui.noteError.textContent = message;
      ui.noteError.hidden = false;
      ui.noteText.setAttribute("aria-invalid", "true");
      ui.noteText.setAttribute("aria-describedby", ui.noteError.id);
      ui.noteText.focus();
    };
    if (text.trim() === "") return refuse("Write your note first.");
    let target;
    if (ui.quote.input.checked) {
      if (!this.#selected) return refuse("Select words in the post first, or choose a section or the whole post.");
      target = this.#selected;
    } else if (ui.section.input.checked) {
      const section = this.#passages.sections[Number(ui.sectionSelect.value)];
      if (!section) return refuse("Choose a section.");
      target = { version: 1, kind: "section", digest: section.digest };
      if (section.anchor !== undefined) target = { version: 1, kind: "section", section: section.anchor, digest: section.digest };
    } else {
      target = { version: 1, kind: "work" };
    }
    const result = this.#commit((document) => addAnnotation(document, { work: this.#work, revision: this.#passages.revision, target, text }));
    if (!result.ok) return refuse(PROBLEM_WORDS[result.problem.code] ?? "That note could not be saved.");
    ui.noteText.value = "";
    this.#render();
    this.#say(`Note added. ${this.#savedWords()}`);
  }

  #startEdit(id) {
    this.#editing = id;
    this.#deleting = null;
    this.#focusAfter = { id, control: "text" };
    this.#render();
  }

  #saveEdit(id, text, field, error) {
    error.hidden = true;
    field.removeAttribute("aria-invalid");
    const refuse = (message) => {
      error.textContent = message;
      error.hidden = false;
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", error.id);
      field.focus();
    };
    if (text.trim() === "") return refuse("Write a note, or cancel and delete this annotation.");
    const result = this.#commit((document) => setNoteText(document, id, text));
    if (!result.ok) return refuse(PROBLEM_WORDS[result.problem.code] ?? "That note could not be saved.");
    this.#editing = null;
    this.#focusAfter = { id, control: "edit" };
    this.#render();
    this.#say(`Note saved. ${this.#savedWords()}`);
  }

  #cancelEdit(id) {
    this.#editing = null;
    this.#focusAfter = { id, control: "edit" };
    this.#render();
    this.#say("Editing cancelled. Nothing changed.");
  }

  #remove(id, siblings) {
    const result = this.#commit((document) => deleteAnnotation(document, id));
    this.#deleting = null;
    if (!result.ok) {
      this.#render();
      this.#fail(PROBLEM_WORDS[result.problem.code] ?? "That could not be deleted.");
      return;
    }
    const at = siblings.indexOf(id);
    const neighbour = siblings[at + 1] ?? siblings[at - 1];
    this.#focusAfter = neighbour ? { id: neighbour, control: "edit" } : { id: null, control: "lead" };
    this.#render();
    this.#say(`Deleted. ${this.#savedWords()}`);
  }

  #show(entry, range) {
    const selection = document.getSelection();
    if (range) {
      const target = range.startContainer.parentElement;
      target?.scrollIntoView({ block: "center", behavior: "auto" });
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      this.#say("The passage is selected in the post. Press Escape or move on to continue reading.");
      return;
    }
    const anchor = entry.target.section;
    const heading = anchor ? this.#prose.querySelector(`[id="${CSS.escape(anchor)}"]`) : null;
    (heading ?? this.#prose).scrollIntoView({ block: "start", behavior: "auto" });
    this.#say(heading ? "Scrolled to the section." : "Scrolled to the start of the post.");
  }

  #paint(ranges) {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
    CSS.highlights.delete(HIGHLIGHT_NAME);
    if (ranges.length > 0) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  }

  /** Draw the notice, the list and the painted passages from the document and the page's published text. */
  #render() {
    const ui = this.#ui;
    if (isDisabled(storage)) {
      // Turned off by the reader: nothing is read, painted or offered, and what is saved is left alone.
      ui.notice.textContent = STORAGE_NOTES.off;
      ui.notice.hidden = false;
      ui.make.hidden = true;
      ui.list.hidden = true;
      ui.list.replaceChildren();
      this.#paint([]);
      return;
    }
    ui.make.hidden = false;
    const mine = annotationsOf(this.#document, this.#work);
    const note = STORAGE_NOTES[this.#persistence];
    ui.notice.textContent = note ?? "";
    ui.notice.hidden = !note;
    const works = { [workKey(this.#work)]: { revision: this.#passages.revision, sections: this.#passages.sections } };
    const assessed = new Map(assessAnnotations({ annotations: mine }, works).map((each) => [each.id, each]));
    const ids = mine.map((record) => record.id);
    const ranges = [];
    ui.list.replaceChildren();
    for (const record of mine) {
      const entry = assessed.get(record.id);
      const range =
        record.target.kind === "quote" && entry.state !== "stale" ? rangeFor(this.#prose, this.#passages, entry.index, record.target, entry) : null;
      if (range) ranges.push(range);
      ui.list.append(this.#item(record, entry, range, ids));
    }
    this.#paint(ranges);
    const empty = mine.length === 0;
    ui.list.hidden = empty;
    this.#restoreFocus();
  }

  #item(record, entry, range, ids) {
    const ui = this.#ui;
    const item = el("li", "ob-annotations-item");
    item.dataset.annotation = record.id;
    const quoted = record.target.kind === "quote";
    const title =
      quoted ? short(record.target.exact, 80) : record.target.kind === "section" ? this.#sectionName(record.target) : "the whole post";
    const kind = el("p", "ob-annotations-kind", record.kind === "note" ? "Note" : "Highlight");
    const where = quoted ? el("blockquote", "ob-annotations-quote") : el("p", "ob-annotations-quote");
    where.textContent = quoted ? record.target.exact : title;
    const state = el("p", "ob-annotations-state", STATE_WORDS[entry.state]);
    if (entry.state === "stale") state.append(el("span", "ob-annotations-reason", ` ${STALE_REASONS[entry.reason] ?? ""}`));
    else if (quoted && !range) state.append(el("span", "ob-annotations-reason", " It cannot be marked in the text, but it is listed here."));
    item.append(kind, where, state);
    if (this.#editing === record.id) {
      const field = el("textarea");
      field.id = `${ui.id}-edit-${record.id}`;
      field.rows = 4;
      field.maxLength = MAX_NOTE_CHARS;
      field.value = record.text ?? "";
      field.dataset.control = "text";
      const label = el("label", undefined, `Note on ${title}`);
      label.htmlFor = field.id;
      const error = el("p", "ob-annotations-error");
      error.id = `${field.id}-error`;
      error.hidden = true;
      const save = el("button", undefined, "Save");
      save.type = "button";
      const cancel = el("button", undefined, "Cancel");
      cancel.type = "button";
      save.addEventListener("click", () => this.#saveEdit(record.id, field.value, field, error));
      cancel.addEventListener("click", () => this.#cancelEdit(record.id));
      field.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.#cancelEdit(record.id);
      });
      const actions = el("div", "ob-annotations-actions");
      actions.append(save, cancel);
      item.append(label, field, error, actions);
      return item;
    }
    if (record.text !== undefined) item.append(el("p", "ob-annotations-text", record.text));
    const actions = el("div", "ob-annotations-actions");
    if (entry.state !== "stale") {
      const show = el("button", undefined, "Show in the post");
      show.type = "button";
      show.setAttribute("aria-label", `Show in the post: ${title}`);
      show.addEventListener("click", () => this.#show(record, range));
      actions.append(show);
    }
    const edit = el("button", undefined, record.text === undefined ? "Add a note" : "Edit note");
    edit.type = "button";
    edit.dataset.control = "edit";
    edit.setAttribute("aria-label", `${record.text === undefined ? "Add a note to" : "Edit the note on"}: ${title}`);
    edit.addEventListener("click", () => this.#startEdit(record.id));
    actions.append(edit);
    if (this.#deleting === record.id) {
      const confirm = el("button", undefined, "Confirm delete");
      confirm.type = "button";
      confirm.dataset.control = "confirm";
      confirm.setAttribute("aria-label", `Confirm delete: ${title}`);
      const keep = el("button", undefined, "Keep it");
      keep.type = "button";
      confirm.addEventListener("click", () => this.#remove(record.id, ids));
      keep.addEventListener("click", () => {
        this.#deleting = null;
        this.#focusAfter = { id: record.id, control: "delete" };
        this.#render();
      });
      actions.append(confirm, keep);
    } else {
      const del = el("button", undefined, "Delete");
      del.type = "button";
      del.dataset.control = "delete";
      del.setAttribute("aria-label", `Delete: ${title}`);
      del.addEventListener("click", () => {
        this.#deleting = record.id;
        this.#editing = null;
        this.#focusAfter = { id: record.id, control: "confirm" };
        this.#render();
      });
      actions.append(del);
    }
    item.append(actions);
    return item;
  }

  #sectionName(target) {
    const section = this.#passages.sections.find((each) => each.anchor === target.section && (target.digest === undefined || each.digest === target.digest))
      ?? this.#passages.sections.find((each) => each.anchor === target.section);
    if (section?.title) return `the section ${section.title}`;
    return target.section ? `the section #${target.section}` : "the opening of the post";
  }

  #restoreFocus() {
    const want = this.#focusAfter;
    this.#focusAfter = null;
    if (!want) return;
    if (want.control === "lead") {
      const lead = this.#ui.make.querySelector(".ob-annotations-lead");
      lead.tabIndex = -1;
      lead.focus();
      return;
    }
    const item = Array.from(this.#ui.list.children).find((each) => each.dataset.annotation === want.id);
    const control = item?.querySelector(`[data-control="${want.control}"]`) ?? item?.querySelector("button");
    control?.focus();
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ob-annotations")) {
  customElements.define("ob-annotations", ObAnnotations);
}
