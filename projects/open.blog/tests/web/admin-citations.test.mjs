import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  Editor,
  citationAt,
  citationChip,
  citationDraftPayload,
  citationEvidenceRows,
  citationExportStatus,
  citationFailure,
  citationLocatorsFromPassage,
  citationSourceChoices,
  citationInsertionProblem,
  citationSpans,
  createCitationForm,
  evidenceStudioState,
  formatCitationText,
  insertCitationText,
  parseCitationText,
  validateCitationDraft,
  visualCitationProblem,
} from "../../web/admin/admin.js";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");

// ---------------------------------------------------------------- DOM shim

class DomNode {
  static ELEMENT_NODE = 1;
  static TEXT_NODE = 3;

  constructor(tag, owner) {
    this.text = tag === "#text";
    this.nodeType = this.text ? 3 : 1;
    this.tagName = this.text ? "#text" : tag.toUpperCase();
    this.owner = owner;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.selected = false;
    this.checked = false;
    this.open = false;
    this.nodeValue = "";
    this._value = undefined;
    this.classList = { contains: (name) => this.className.split(/\s+/).includes(name) };
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }
  get parentElement() {
    return this.parentNode;
  }
  get value() {
    if (this.tagName === "SELECT" && this._value === undefined) return this.children.find((child) => child.selected)?.value ?? "";
    if (this.tagName === "OPTION" && this._value === undefined) return this.attributes.value ?? "";
    return this._value ?? "";
  }
  set value(value) {
    this._value = String(value);
    if (this.tagName === "SELECT") for (const option of this.children) option.selected = option.value === this._value;
  }
  get textContent() {
    return this.text ? this.nodeValue : this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value) {
    if (this.text) this.nodeValue = String(value);
    else this.replaceChildren(this.owner.createTextNode(String(value)));
  }
  get isConnected() {
    for (let node = this; node; node = node.parentNode) if (node === this.owner.body) return true;
    return false;
  }
  adopt(node) {
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    return node;
  }
  append(...nodes) {
    for (const node of nodes.flat()) {
      if (node === null || node === undefined || node === false) continue;
      this.childNodes.push(this.adopt(node instanceof DomNode ? node : this.owner.createTextNode(String(node))));
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    const index = parent.childNodes.indexOf(this);
    for (const node of nodes) parent.adopt(node);
    parent.childNodes.splice(index, 1, ...nodes);
    this.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  cloneNode(deep) {
    const copy = new DomNode(this.text ? "#text" : this.tagName.toLowerCase(), this.owner);
    Object.assign(copy, { nodeValue: this.nodeValue, className: this.className, attributes: { ...this.attributes }, dataset: { ...this.dataset }, id: this.id });
    if (deep) for (const child of this.childNodes) copy.append(child.cloneNode(true));
    return copy;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "hidden") this.hidden = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  matches(selector) {
    if (this.text) return false;
    return selector.split(",").map((part) => part.trim()).some((part) => {
      if (part.startsWith("#")) return this.id === part.slice(1);
      if (part.startsWith(".")) return this.classList.contains(part.slice(1));
      const attribute = /^([a-z]*)\[([a-z-]+)\]$/.exec(part);
      if (attribute) {
        if (attribute[1] && this.tagName !== attribute[1].toUpperCase()) return false;
        return attribute[2] in this.attributes;
      }
      return this.tagName === part.toUpperCase();
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  addEventListener(name, listener) {
    (this.listeners[name] ||= []).push(listener);
  }
  dispatch(name, event = {}) {
    const payload = { type: name, target: this, currentTarget: this, preventDefault() {}, ...event };
    return Promise.all((this.listeners[name] || []).map((listener) => listener(payload)));
  }
  dispatchEvent(event) {
    this.dispatch(event.type, { target: this });
    return true;
  }
  focus() {
    this.owner.activeElement = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}

function installDom() {
  const previous = { Node: globalThis.Node, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  const documentShim = {
    activeElement: null,
    createElement: (tag) => new DomNode(tag, documentShim),
    createTextNode: (text) => Object.assign(new DomNode("#text", documentShim), { nodeValue: String(text) }),
  };
  documentShim.body = new DomNode("body", documentShim);
  globalThis.Node = DomNode;
  globalThis.HTMLElement = DomNode;
  globalThis.document = documentShim;
  return {
    document: documentShim,
    restore() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    },
  };
}

const withDom = (run) => async () => {
  const dom = installDom();
  try {
    await run(dom);
  } finally {
    dom.restore();
  }
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function fakeApi(handler) {
  const calls = [];
  return {
    calls,
    async call(method, path, options = {}) {
      calls.push({ method, path, body: options.json });
      return handler(method, path, options.json);
    },
  };
}

function textarea(value, start = value.length, end = start) {
  const events = [];
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    events,
    focused: false,
    setSelectionRange(from, to) {
      this.selectionStart = from;
      this.selectionEnd = to;
    },
    focus() {
      this.focused = true;
      if (globalThis.document) globalThis.document.activeElement = this;
    },
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
  };
}

const SOURCES = () => [
  { id: "plato-republic", kind: "work", title: "Πολιτεία", creators: [{ name: "Plato" }] },
  { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam", creators: [{ name: "S. R. Slings" }] },
  { id: "old-edition", kind: "edition", title: "Old", archived: true },
];
const PASSAGES = () => [
  { id: "passage-1", source: "slings-2003", preview: "ὁ δὲ Σωκράτης <b>", locators: [{ kind: "page", value: "514", to: "520" }, { kind: "canonical", value: "514a" }] },
];
const STATE = (over = {}) => ({ revision: "rev-1", sources: SOURCES(), passages: PASSAGES(), notebookAvailable: true, ...over });
const byId = (root, id) => root.querySelectorAll("*").find((node) => node.id === id) || root.querySelector(`#${id}`);
const control = (form, name) => form.element.querySelector(`#oba-citation-${name}`);
const type = (node, value) => {
  node.value = value;
  return node.dispatch("input", { target: node });
};
const choose = (node, value) => {
  node.value = value;
  return node.dispatch("change", { target: node });
};

// ---------------------------------------------------------------- Markdown helpers

test("citation spans skip code, escapes, links and definitions, and keep Unicode offsets", () => {
  const markdown = [
    "Intro [@slings-2003, page 5] and `[@code]` and \\[@escaped] and [@link](https://example.com) and [@ref][r].",
    "```",
    "[@fenced]",
    "```",
    "[@def]: https://example.com",
    "Πολιτεία [@plato-republic, section Βιβλίον ζ] 🙂 [@Bad Key]",
  ].join("\n");
  const spans = citationSpans(markdown);
  assert.deepEqual(spans.map((span) => span.text), ["[@slings-2003, page 5]", "[@plato-republic, section Βιβλίον ζ]", "[@Bad Key]"]);
  for (const span of spans) assert.equal(markdown.slice(span.start, span.end), span.text);
  const inside = markdown.indexOf("page 5");
  assert.equal(citationAt(markdown, inside)?.text, "[@slings-2003, page 5]");
  const after = markdown.indexOf("] and `") + 1;
  assert.equal(citationAt(markdown, after), null, "a caret just after a citation inserts a new one");
  assert.equal(citationAt(markdown, spans[0].start, spans[0].end)?.text, spans[0].text);
  assert.equal(citationAt(markdown, markdown.indexOf("[@code]") + 3), null);
});

test("citation text parses to parts and formats back, with ranges and Unicode", () => {
  for (const text of ["[@plato-republic]", "[@slings-2003, page 514 to 520; canonical 514a; section Βιβλίον ζ]", "[@x, x-stephanus 514a]"]) {
    assert.equal(formatCitationText(parseCitationText(text)), text);
  }
  assert.deepEqual(parseCitationText("[@slings-2003, page 514 to 520]"), { key: "slings-2003", locators: [{ kind: "page", value: "514", to: "520" }] });
  assert.equal(parseCitationText("[see](x)"), null);
  assert.equal(parseCitationText("[@a] tail"), null);
});

test("a passage's locators are copied as kind, value and end only", () => {
  const passage = { ...PASSAGES()[0], locators: [{ kind: "page", value: "514", hint: true, privateNote: "no" }, { kind: "canonical", value: "514a", to: "520a", scan: "p1.png" }, { kind: 5 }] };
  assert.deepEqual(citationLocatorsFromPassage(passage), [{ kind: "page", value: "514" }, { kind: "canonical", value: "514a", to: "520a" }]);
  assert.deepEqual(citationDraftPayload({ source: "slings-2003", locators: "page: 514 to 520\ncanonical: 514a" }), {
    key: "slings-2003",
    locators: [{ kind: "page", value: "514", to: "520" }, { kind: "canonical", value: "514a" }],
  });
});

test("inserting changes only the insertion point, and replacing changes only the edited citation", () => {
  const draft = "Claim one[^1] and a claim.\n\n[^1]: A hand-written footnote [@not-touched].\n";
  const at = draft.indexOf(" and");
  const inserted = insertCitationText(draft, at, at, "[@slings-2003, page 5]");
  assert.equal(inserted.value, "Claim one[^1] [@slings-2003, page 5] and a claim.\n\n[^1]: A hand-written footnote [@not-touched].\n");
  assert.equal(inserted.start, at + " [@slings-2003, page 5]".length);
  assert.equal(inserted.start, inserted.end);
  const afterSpace = insertCitationText("A claim ", 8, 8, "[@x]");
  assert.equal(afterSpace.value, "A claim [@x]");
  const selected = insertCitationText("Keep this selected.", 5, 18, "[@x]");
  assert.equal(selected.value, "Keep this selected [@x].", "the selected text stays and the citation follows it");
  const span = citationSpans(draft).find((item) => item.text === "[@not-touched]");
  const replaced = insertCitationText(draft, span.start + 3, span.start + 3, "[@slings-2003]", span);
  assert.equal(replaced.value, draft.replace("[@not-touched]", "[@slings-2003]"));
});

test("advisory validation and failure messages point at the right field", () => {
  assert.equal(validateCitationDraft({ source: "", locators: "" }, SOURCES()).field, "source");
  assert.equal(validateCitationDraft({ source: "gone", locators: "" }, SOURCES()).field, "source");
  assert.equal(validateCitationDraft({ source: "slings-2003", locators: "page 5" }, SOURCES()).field, "locators");
  assert.equal(validateCitationDraft({ source: "slings-2003", locators: Array(9).fill("line: 1").join("\n") }, SOURCES()).field, "locators");
  assert.equal(validateCitationDraft({ source: "slings-2003", locators: "page: 5" }, SOURCES()), null);
  assert.equal(citationFailure(new ApiError("x", 422, { diagnostics: [{ code: "unknown-key", message: "no source" }] })).field, "source");
  assert.equal(citationFailure(new ApiError("x", 422, { diagnostics: [{ code: "ambiguous-locator", message: "page on a work" }] })).field, "locators");
  assert.equal(citationFailure(new ApiError("x", 409, { error: "changed" })).field, "source");
  assert.match(citationFailure(new Error("offline")).message, /draft is unchanged/);
  const choices = citationSourceChoices(SOURCES(), "", "").map((source) => source.id);
  assert.deepEqual(choices, ["slings-2003", "plato-republic"], "archived sources are not offered");
  assert.deepEqual(citationSourceChoices(SOURCES(), "", "old-edition").map((source) => source.id).sort(), ["old-edition", "plato-republic", "slings-2003"]);
  assert.deepEqual(citationSourceChoices(SOURCES(), "πολι").map((source) => source.id), ["plato-republic"]);
});

// ---------------------------------------------------------------- visual round trips

function visualEditor(markdown) {
  const editor = Object.create(Editor.prototype);
  editor.ui = { body: textarea(markdown), richBody: document.createElement("div") };
  editor.editorMode = "visual";
  editor.visualDirty = false;
  editor.renderRichEditor();
  return editor;
}

test("visual mode keeps generated and hand-written citations byte for byte", withDom(() => {
  const markdown = [
    "# Title [@plato-republic]",
    "",
    "Claim [@slings-2003, page 514 to 520; canonical 514a] and _quiet [@x-1, section Βιβλίον ζ]_ text.",
    "",
    "- item [@Bad Key]",
    "- two",
    "",
    "> quote [@q]",
    "",
    "Escaped \\[@not-a-citation\\] stays text.",
    "",
    "A footnote[^1].",
    "",
    "[^1]: Manual [@inside-footnote].",
    "",
  ].join("\n");
  const editor = visualEditor(markdown);
  const chips = editor.ui.richBody.querySelectorAll(".oba-citation");
  assert.deepEqual(chips.map((chip) => chip.dataset.citation), ["[@plato-republic]", "[@slings-2003, page 514 to 520; canonical 514a]", "[@x-1, section Βιβλίον ζ]", "[@Bad Key]", "[@q]"]);
  for (const chip of chips) {
    assert.equal(chip.getAttribute("contenteditable"), "false");
    assert.equal(chip.getAttribute("role"), "button");
    assert.equal(chip.getAttribute("tabindex"), "0");
    assert.match(chip.getAttribute("aria-label"), /^Citation .+Press Enter to edit\.$/);
  }
  assert.equal(editor.richEditorMarkdown(), markdown.replace(/\n\n$/, "\n"));
}));

test("visual mode reads backslash-escaped characters as text and writes them back unchanged", withDom(() => {
  const markdown = [
    String.raw`> a \[sic\] \*not emphasis\* and \_not\_ either, \`no code\`, a \\ backslash [@q]`,
    "",
    String.raw`Not a link: \[x\](y), but **bold \* star** and [a link](/atlas/plato/) stay formatting.`,
    "",
    String.raw`Code keeps its backslash: ` + "`a\\*b`" + ".",
    "",
  ].join("\n");
  const editor = visualEditor(markdown);
  const [quote, paragraph, code] = editor.ui.richBody.children;
  assert.equal(quote.textContent, "a [sic] *not emphasis* and _not_ either, `no code`, a \\ backslash [@q]");
  assert.equal(quote.querySelectorAll("em").length, 0);
  assert.deepEqual(paragraph.children.map((child) => child.tagName), ["STRONG", "A"]);
  assert.equal(paragraph.querySelector("strong").textContent, "bold * star");
  assert.equal(code.querySelector("code").textContent, "a\\*b");
  assert.equal(editor.richEditorMarkdown(), markdown.replace(/\n\n$/, "\n"));
}));

test("a pasted look-alike chip cannot smuggle Markdown into the draft", withDom(() => {
  const editor = visualEditor("Text.\n");
  const paragraph = editor.ui.richBody.children[0];
  const fake = citationChip("[@ok]");
  fake.setAttribute("data-citation", "[@x](javascript:alert(1))");
  fake.textContent = "[@x](javascript:alert(1))";
  paragraph.append(" ", fake);
  assert.equal(editor.richEditorMarkdown(), "Text. \\[@x\\](javascript:alert(1))\n");
}));

// ------------------------------------------- claim anchors from the visual editor (A4, ADR 0073)

function savableVisualEditor(markdown, saved) {
  const editor = visualEditor(markdown);
  Object.assign(editor, {
    kind: "pages",
    doc: { path: "content/pages/p.md", etag: "e1" },
    f: {},
    collect: () => ({}),
    validateClient: () => "",
    creditRequestFields: () => ({}),
    reportSaved() {},
    flash() {},
  });
  editor.app = { editVersion: 1, dirty: true, api: fakeApi((method, path, json) => (saved.push(json.body), { path: "content/pages/p.md", etag: "e2" })) };
  Object.assign(editor.ui, { saveBtn: document.createElement("button"), saveState: Object.assign(document.createElement("span"), { classList: { add() {}, remove() {} } }) });
  return editor;
}

function selectWords(editor, block, words) {
  const node = block.childNodes.find((child) => child.nodeType === 3 && child.nodeValue.includes(words));
  editor.visualSelection = { startContainer: node, endContainer: node, toString: () => words };
}

test("a claim selected after saving with an empty paragraph anchors in its own block", withDom(async (dom) => {
  const previousLocation = globalThis.location;
  globalThis.location = { hash: "#/edit/content%2Fpages%2Fp.md" };
  try {
    const markdown = "Intro.\n\nThe cave educates.\n\nThe cave educates again.\n";
    const saved = [];
    const editor = savableVisualEditor(markdown, saved);
    const empty = document.createElement("p");
    empty.setAttribute("data-visual-block", "paragraph");
    empty.append(document.createElement("br"));
    editor.ui.richBody.childNodes.splice(1, 0, editor.ui.richBody.adopt(empty));
    editor.visualChanged();
    // The caret stays in the editor, so the save leaves the editor as it is, empty paragraph included.
    dom.document.activeElement = empty;
    await editor.save();
    assert.deepEqual(saved, [markdown]);
    assert.equal(editor.ui.richBody.children.length, 4);
    const second = editor.ui.richBody.children[2];
    selectWords(editor, second, "cave educates");
    const at = markdown.indexOf("cave educates.");
    assert.deepEqual(editor.claimSelection(), { anchor: { start: at, end: at + 13, text: "cave educates" } });

    // Saved from the button instead, the editor is drawn again from the saved draft, block for block.
    editor.ui.richBody.childNodes.splice(1, 0, editor.ui.richBody.adopt(empty));
    editor.visualChanged();
    dom.document.activeElement = editor.ui.saveBtn;
    await editor.save();
    assert.equal(editor.ui.richBody.children.length, 3);
    assert.equal(editor.visualDirty, false);
    assert.equal(editor.visualSelection, null);
    selectWords(editor, editor.ui.richBody.children[1], "cave educates");
    assert.deepEqual(editor.claimSelection(), { anchor: { start: at, end: at + 13, text: "cave educates" } });
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
}));

test("a formatted selection is refused when the block shows the same words twice", withDom(() => {
  const editor = visualEditor("The *big* cave and the big cave.\n");
  const paragraph = editor.ui.richBody.children[0];
  const emphasis = paragraph.children.find((child) => child.tagName === "EM");
  const node = emphasis.childNodes[0];
  editor.visualSelection = { startContainer: node, endContainer: paragraph.childNodes.at(-1), toString: () => "big cave" };
  assert.match(editor.claimSelection().error, /more than once in that block/);
}));

// ---------------------------------------------------------------- applying and undoing

test("inserting in Markdown mode and undoing restores the exact draft and caret", withDom(() => {
  const draft = "First claim.\n\nSecond[^n] claim.\n\n[^n]: Manual note.\n";
  const editor = Object.create(Editor.prototype);
  editor.editorMode = "markdown";
  editor.ui = { body: textarea(draft, 5, 11), citationUndo: { hidden: true }, citationStatus: { textContent: "" } };
  const target = editor.citationTarget();
  assert.deepEqual([target.start, target.end, target.span], [5, 11, null]);
  assert.equal(editor.applyCitation(target, "[@slings-2003, page 5]"), true);
  assert.equal(editor.ui.body.value, "First claim [@slings-2003, page 5].\n\nSecond[^n] claim.\n\n[^n]: Manual note.\n");
  assert.equal(editor.ui.body.selectionStart, "First claim [@slings-2003, page 5]".length);
  assert.equal(editor.ui.citationUndo.hidden, false);
  assert.equal(editor.citationUndoAvailable(), true);
  assert.equal(editor.undoCitation(), true);
  assert.equal(editor.ui.body.value, draft);
  assert.deepEqual([editor.ui.body.selectionStart, editor.ui.body.selectionEnd], [5, 11]);
  assert.equal(editor.ui.citationUndo.hidden, true);
  assert.deepEqual(editor.ui.body.events, ["input", "input"]);
}));

test("undo refuses once the draft changed after the citation", withDom(() => {
  const editor = Object.create(Editor.prototype);
  editor.editorMode = "markdown";
  editor.ui = { body: textarea("Claim.", 5), citationStatus: { textContent: "" } };
  editor.applyCitation(editor.citationTarget(), "[@x]");
  editor.ui.body.value += " more";
  assert.equal(editor.citationUndoAvailable(), false);
  assert.equal(editor.undoCitation(), false);
  assert.equal(editor.ui.body.value, "Claim [@x]. more");
  assert.match(editor.ui.citationStatus.textContent, /draft changed/);
}));

test("editing a citation chip in Visual mode replaces only it, and undo restores the editor", withDom((dom) => {
  const markdown = "Claim [@plato-republic] here and [@manual, page 2].\n";
  const editor = visualEditor(markdown);
  editor.ui.citationStatus = { textContent: "" };
  editor.ui.body.value = markdown;
  const chip = editor.ui.richBody.querySelectorAll(".oba-citation")[0];
  chip.focus();
  const target = editor.citationTarget(chip);
  assert.equal(target.chip, chip);
  assert.equal(editor.applyCitation(target, "[@slings-2003, page 514]"), true);
  assert.equal(editor.ui.body.value, "Claim [@slings-2003, page 514] here and [@manual, page 2].\n");
  assert.equal(editor.undoCitation(), true);
  assert.equal(editor.ui.body.value, markdown);
  assert.equal(editor.richEditorMarkdown(), markdown);
  assert.equal(dom.document.activeElement?.dataset?.citation, "[@plato-republic]", "focus returns to the restored chip");
}));

test("a malformed server reply never changes the draft", withDom(() => {
  const editor = Object.create(Editor.prototype);
  editor.editorMode = "markdown";
  editor.ui = { body: textarea("Claim."), citationStatus: { textContent: "" } };
  assert.equal(editor.applyCitation(editor.citationTarget(), "[@x](javascript:alert(1))"), false);
  assert.equal(editor.ui.body.value, "Claim.");
}));

// ---------------------------------------------------------------- the picker

test("the picker searches by keyboard, copies passage locators, and checks with the server", withDom(async () => {
  const api = fakeApi(() => ({ revision: "rev-1", markdown: "[@slings-2003, page 514 to 520; canonical 514a]" }));
  const inserted = [];
  const form = createCitationForm({ api, state: STATE(), onInsert: (result) => inserted.push(result) });
  document.body.append(form.element);
  form.focus();
  const search = control(form, "search");
  assert.equal(document.activeElement, search);
  for (const name of ["search", "source", "passage", "locators"]) {
    const input = control(form, name);
    assert.ok(form.element.querySelectorAll("label").some((label) => label.getAttribute("for") === input.id), `${name} is labelled`);
  }
  const sources = control(form, "source");
  assert.deepEqual(sources.children.map((option) => option.value), ["slings-2003", "plato-republic"]);
  await type(search, "Πολι");
  assert.deepEqual(sources.children.map((option) => option.value), ["plato-republic"]);
  await type(search, "");
  await choose(control(form, "passage"), "passage-1");
  assert.equal(sources.value, "slings-2003");
  assert.equal(control(form, "locators").value, "page: 514 to 520\ncanonical: 514a");
  assert.equal(byId(form.element, "oba-citation-preview").textContent, "[@slings-2003, page 514 to 520; canonical 514a]");
  assert.ok(!form.element.textContent.includes("<b>") || form.element.querySelectorAll("b").length === 0, "passage previews are text");
  await form.element.dispatch("submit");
  assert.deepEqual(api.calls, [{ method: "POST", path: "citations/check", body: { revision: "rev-1", citation: { key: "slings-2003", locators: [{ kind: "page", value: "514", to: "520" }, { kind: "canonical", value: "514a" }] } } }]);
  assert.equal(inserted[0].markdown, "[@slings-2003, page 514 to 520; canonical 514a]");
}));

test("a stale library keeps the author's choices and shows the refreshed sources", withDom(async () => {
  let attempt = 0;
  const api = fakeApi(() => {
    attempt += 1;
    if (attempt === 1) throw new ApiError("conflict", 409, { error: "The source library changed after the citation picker opened.", revision: "rev-2", sources: [...SOURCES(), { id: "new-source", kind: "work", title: "Newer" }] });
    return { revision: "rev-2", markdown: "[@slings-2003, page 5]" };
  });
  const state = STATE();
  const inserted = [];
  const form = createCitationForm({ api, state, initial: { key: "slings-2003", locators: [{ kind: "page", value: "5" }] }, onInsert: (result) => inserted.push(result) });
  document.body.append(form.element);
  assert.equal(form.element.querySelector("[data-citation-insert]").textContent, "Update citation");
  await form.element.dispatch("submit");
  assert.equal(inserted.length, 0);
  assert.equal(state.revision, "rev-2");
  const error = byId(form.element, "oba-citation-error");
  assert.equal(error.hidden, false);
  assert.equal(error.getAttribute("role"), "alert");
  assert.match(error.textContent, /changed/);
  const sources = control(form, "source");
  assert.equal(document.activeElement, sources);
  assert.equal(sources.getAttribute("aria-invalid"), "true");
  assert.ok(sources.children.some((option) => option.value === "new-source"));
  assert.equal(sources.value, "slings-2003");
  assert.equal(control(form, "locators").value, "page: 5");
  await form.element.dispatch("submit");
  assert.equal(api.calls[1].body.revision, "rev-2");
  assert.equal(inserted.length, 1);
}));

test("server diagnostics are scoped to a field and nothing is inserted", withDom(async () => {
  const api = fakeApi(() => {
    throw new ApiError("invalid", 422, { diagnostics: [{ code: "ambiguous-locator", message: "a page needs an edition", key: "plato-republic" }] });
  });
  const inserted = [];
  const form = createCitationForm({ api, state: STATE(), onInsert: (result) => inserted.push(result) });
  document.body.append(form.element);
  await choose(control(form, "source"), "plato-republic");
  await type(control(form, "locators"), "page: 5");
  await form.element.dispatch("submit");
  assert.equal(inserted.length, 0);
  assert.equal(control(form, "locators").getAttribute("aria-invalid"), "true");
  assert.equal(document.activeElement, control(form, "locators"));
  assert.match(byId(form.element, "oba-citation-error").textContent, /page needs an edition/);
}));

test("advisory checks run before any request, and Cancel leaves everything alone", withDom(async () => {
  const api = fakeApi(() => assert.fail("no request expected"));
  let cancelled = 0;
  const form = createCitationForm({ api, state: STATE({ notebookAvailable: false, passages: [] }), onCancel: () => { cancelled += 1; } });
  document.body.append(form.element);
  assert.ok(form.element.querySelector("[data-citation-notebook]"), "an unreadable notebook is explained");
  await form.element.dispatch("submit");
  assert.equal(api.calls.length, 0);
  assert.equal(document.activeElement, control(form, "source"));
  await form.element.querySelector("[data-citation-cancel]").dispatch("click");
  assert.equal(cancelled, 1);
}));

test("the editor dialog reopens a citation under the caret, replaces only it, and returns focus", withDom(async (dom) => {
  const draft = "See [@plato-republic, canonical 514a] and more.";
  const caret = draft.indexOf("canonical");
  const editor = Object.create(Editor.prototype);
  editor.editorMode = "markdown";
  editor.ui = { body: textarea(draft, caret), citationStatus: { textContent: "" } };
  editor.captureVisualSelection = () => {};
  editor.app = {
    api: fakeApi((method, path) => {
      if (path === "citations/library") return { revision: "rev-1", sources: SOURCES(), passages: [], notebookAvailable: true };
      return { revision: "rev-1", markdown: "[@plato-republic, canonical 514b]" };
    }),
  };
  await editor.openCitationDialog();
  const dialog = dom.document.body.querySelector(".oba-citation-dialog");
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector("h2").textContent, "Edit citation");
  const locators = dialog.querySelector("#oba-citation-locators");
  assert.equal(locators.value, "canonical: 514a");
  locators.value = "canonical: 514b";
  await locators.dispatch("input", { target: locators });
  await dialog.querySelector("form").dispatch("submit");
  assert.equal(dialog.isConnected, false);
  assert.equal(editor.ui.body.value, "See [@plato-republic, canonical 514b] and more.");
  assert.equal(editor.ui.body.focused, true);

  // Escape cancels without touching the draft and restores the selection.
  editor.ui.body.setSelectionRange(2, 3);
  await editor.openCitationDialog();
  const again = dom.document.body.querySelector(".oba-citation-dialog");
  assert.equal(again.querySelector("h2").textContent, "Insert citation");
  await again.dispatch("cancel");
  assert.equal(again.isConnected, false);
  assert.equal(editor.ui.body.value, "See [@plato-republic, canonical 514b] and more.");
  assert.deepEqual([editor.ui.body.selectionStart, editor.ui.body.selectionEnd], [2, 3]);
  await tick();
}));

test("citation code builds DOM safely and its styles keep focus visible without motion", () => {
  const start = admin.indexOf("// ---------------------------------------------------------------- citations");
  const end = admin.indexOf(" * The capture form shared by");
  const dialog = admin.slice(admin.indexOf("  citationTarget(chip = null) {"), admin.indexOf("  sayCitation(message) {"));
  for (const code of [admin.slice(start, end), dialog]) assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|createContextualFragment/);
  assert.match(dialog, /showModal\(\)/);
  assert.match(dialog, /addEventListener\("cancel"[\s\S]*returnToDraft\(\)/);
  const css = styles.slice(styles.indexOf("/* Citations in the visual editor"));
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /transition|animation/);
});

// ---------------------------------------------------------------- review fixes

test("lines the visual editor cannot chip the way the core scanner reads them are preserved verbatim", withDom(() => {
  const risky = [
    "A \\\\[@a] b.",
    "A [@a](see also) b.",
    "foo_bar [@a, section 1_2] baz_",
    "Malformed [@a, page 5",
    "A [link with [@a] inside](https://example.com) here.",
    "[[@a]](https://example.com)",
  ];
  for (const line of risky) assert.equal(visualCitationProblem(line), true, line);
  for (const line of ["Claim [@a] and _quiet [@b, section 1_2]_ text.", "Escaped \\[@a] stays text.", "**see [@a]**", "Code `[@a](x)` only.", "No citation_here_ at all."]) {
    assert.equal(visualCitationProblem(line), false, line);
  }
  const markdown = [
    "Intro paragraph [@kept].",
    "",
    ...risky.flatMap((line) => [line, ""]),
    "Two lines, the second",
    "holds [@a](see also) text.",
    "",
    "- item one",
    "- item [@a](see also)",
    "",
    "> quote",
    "> foo_bar [@a] baz_",
    "",
  ].join("\n");
  const editor = visualEditor(markdown);
  const protectedBlocks = editor.ui.richBody.querySelectorAll(".oba-protected-block");
  assert.equal(protectedBlocks.length, risky.length + 3);
  for (const block of protectedBlocks) assert.equal(block.getAttribute("aria-label"), "Citation text block");
  assert.deepEqual(editor.ui.richBody.querySelectorAll(".oba-citation").map((chip) => chip.dataset.citation), ["[@kept]"]);
  // A visual edit rewrites the draft from the DOM: every risky line comes back byte for byte.
  assert.equal(editor.richEditorMarkdown(), markdown.replace(/\n\n$/, "\n"));
}));

test("a chip never reads as a link: a following ( is escaped and read back", withDom(() => {
  const editor = visualEditor("Claim.\n");
  const paragraph = editor.ui.richBody.children[0];
  paragraph.append(" ", citationChip("[@a]"), "(see page 2)");
  const written = editor.richEditorMarkdown();
  assert.equal(written, "Claim. [@a]\\(see page 2)\n");
  const again = visualEditor(written);
  assert.equal(again.ui.richBody.querySelectorAll(".oba-citation").length, 1);
  assert.equal(again.ui.richBody.children[0].textContent, "Claim. [@a](see page 2)");
  assert.equal(again.richEditorMarkdown(), written);
  const inserted = insertCitationText("See [link](x).", 4, 4, "[@a]");
  assert.equal(inserted.value, "See [@a] [link](x).", "a space keeps a following link from joining the citation");
  assert.equal(inserted.start, "See [@a]".length);
}));

test("Markdown insertion is refused inside code and link text", () => {
  const markdown = "See [the [@kept] link](https://example.com) and `code` here.\n\n```\nfenced\n```\n";
  assert.equal(citationInsertionProblem(markdown, markdown.indexOf("the")), "link");
  assert.equal(citationInsertionProblem(markdown, markdown.indexOf("example")), "link");
  assert.equal(citationInsertionProblem(markdown, markdown.indexOf("ode")), "code");
  assert.equal(citationInsertionProblem(markdown, markdown.indexOf("fenced")), "code");
  assert.equal(citationInsertionProblem(markdown, markdown.indexOf(" and")), "");
  assert.equal(citationInsertionProblem(markdown, 0), "");
  assert.equal(citationInsertionProblem(markdown, markdown.indexOf(" here")), "");
});

test("Markdown insertion is refused in autolinks, indented code, multi-line spans and links, and HTML", () => {
  const at = (markdown, needle, shift = 1) => citationInsertionProblem(markdown, markdown.indexOf(needle) + shift);
  // Autolinks, web and email.
  assert.equal(at("See <https://example.com/a> now.", "example"), "link");
  assert.equal(at("Write <someone@example.com> now.", "example"), "link");
  assert.equal(at("See <https://example.com/a> now.", " now"), "");
  // Indented code after a blank line, but not a lazy continuation line.
  assert.equal(at("Text.\n\n    indented code\n", "code"), "code");
  assert.equal(at("Text.\n\n\tindented code\n", "code"), "code");
  assert.equal(at("Text\n    continued here.\n", "continued"), "");
  // Code spans and links over several lines of one paragraph.
  assert.equal(at("A `code\nspan` here.", "span", 0), "code");
  assert.equal(at("A `code\nspan` here.", " here"), "");
  assert.equal(at("A [link\ntext](https://example.com) end.", "text"), "link");
  assert.equal(at("A [link](https://\nexample.com) end.", "example"), "link");
  assert.equal(at("A [link\ntext](https://example.com) end.", " end"), "");
  // HTML comments, inline and as blocks, and HTML blocks.
  assert.equal(at("Text <!-- a\nnote --> after.", "note"), "html");
  assert.equal(at("Text <!-- a\nnote --> after.", " after"), "");
  assert.equal(at("<!--\nhidden\n-->\n\nVisible.", "hidden"), "html");
  assert.equal(at("<!--\nhidden\n-->\n\nVisible.", "Visible"), "");
  assert.equal(at("<div>\ninside block\n</div>\n\nOutside.", "inside"), "html");
  assert.equal(at("<div>\ninside block\n</div>\n\nOutside.", "Outside"), "");
  assert.equal(at("<span class=\"x\">\n\nAfter.", "class"), "html");
  assert.equal(at("Text <span title=\"a b\">kept</span>.", "a b"), "html");
  assert.equal(at("Text <span title=\"a b\">kept</span>.", "kept"), "");
  assert.equal(at("<pre>\nraw\n\nstill raw\n</pre>\nAfter.", "still"), "html");
  // A link reference definition, and containers that hold ordinary text.
  assert.equal(at("[label]: https://example.com\n", "example"), "link");
  assert.equal(at("> Quoted text.\n", "Quoted"), "");
  assert.equal(at("- Listed text.\n", "Listed"), "");
  assert.equal(at("> ```\n> fenced\n> ```\n", "fenced"), "code");
  assert.equal(at("- ```\n  fenced\n  ```\n", "fenced"), "code");
});

function dialogEditor(dom, draft, caret) {
  const editor = Object.create(Editor.prototype);
  editor.editorMode = "markdown";
  editor.ui = { body: textarea(draft, caret), citationStatus: { textContent: "" } };
  editor.captureVisualSelection = () => {};
  editor.app = {
    api: fakeApi((method, path) => {
      if (path === "citations/library") return { revision: "rev-1", sources: SOURCES(), passages: [], notebookAvailable: true };
      return { revision: "rev-1", markdown: "[@plato-republic]" };
    }),
  };
  return editor;
}

test("a refused target keeps the dialog open with the author's choices and fails inside it", withDom(async (dom) => {
  const draft = "See [link text](https://example.com) here.";
  const editor = dialogEditor(dom, draft, draft.indexOf("text"));
  await editor.openCitationDialog();
  const dialog = dom.document.body.querySelector(".oba-citation-dialog");
  assert.match(dialog.querySelector("[data-citation-target]").textContent, /inside a link/);
  const sources = dialog.querySelector("#oba-citation-source");
  await choose(sources, "plato-republic");
  await dialog.querySelector("form").dispatch("submit");
  assert.equal(dialog.isConnected, true, "the dialog stays open");
  assert.equal(dialog.open, true);
  const error = byId(dialog, "oba-citation-error");
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /inside a link/);
  assert.equal(dom.document.activeElement, error, "focus stays in the dialog, on the explanation");
  assert.equal(sources.value, "plato-republic", "the choice is kept");
  assert.deepEqual(editor.app.api.calls.map((call) => call.path), ["citations/library"], "nothing is sent to check");
  assert.equal(editor.ui.body.value, draft);
  await dialog.querySelector("[data-citation-cancel]").dispatch("click");
  assert.equal(dialog.isConnected, false);
  assert.equal(editor.ui.body.focused, true, "Cancel returns focus to the writing surface");
}));

test("a server reply that is not a citation fails inside the open dialog", withDom(async (dom) => {
  const editor = dialogEditor(dom, "Claim.", 5);
  editor.app.api = fakeApi((method, path) => (path === "citations/library" ? { revision: "rev-1", sources: SOURCES(), passages: [] } : { markdown: "[@x](javascript:alert(1))" }));
  await editor.openCitationDialog();
  const dialog = dom.document.body.querySelector(".oba-citation-dialog");
  assert.equal(dialog.querySelector("[data-citation-target]"), null);
  await choose(dialog.querySelector("#oba-citation-source"), "plato-republic");
  await dialog.querySelector("form").dispatch("submit");
  assert.equal(dialog.isConnected, true);
  assert.match(byId(dialog, "oba-citation-error").textContent, /no citation/);
  assert.equal(editor.ui.body.value, "Claim.");
}));

test("Visual insertion inside a link or code is refused before anything changes", withDom(() => {
  const editor = visualEditor("See [link](https://example.com) and `code`.\n");
  const paragraph = editor.ui.richBody.children[0];
  const link = paragraph.querySelector("a");
  const code = paragraph.querySelector("code");
  const rangeIn = (node) => ({ endContainer: node.childNodes[0], startContainer: node.childNodes[0], cloneRange() { return this; } });
  assert.match(editor.citationTargetProblem({ mode: "visual", range: rangeIn(link) }), /inside a link/);
  assert.match(editor.citationTargetProblem({ mode: "visual", range: rangeIn(code) }), /inside code/);
  assert.match(editor.citationTargetProblem({ mode: "visual", range: null }), /Place the caret/);
  assert.equal(editor.citationTargetProblem({ mode: "visual", range: rangeIn(paragraph) }), "");
  editor.ui.citationStatus = { textContent: "" };
  const before = editor.richEditorMarkdown();
  assert.equal(editor.applyCitation({ mode: "visual", range: rangeIn(link), chip: null }, "[@a]"), false);
  assert.equal(editor.richEditorMarkdown(), before);
}));

function installSelection(dom, node, offset) {
  const selection = {
    rangeCount: 1,
    isCollapsed: true,
    anchorNode: node,
    anchorOffset: offset,
    getRangeAt() {
      return { endContainer: this.anchorNode };
    },
    removeAllRanges() {},
    addRange(range) {
      this.anchorNode = range.after.parentNode;
      this.anchorOffset = range.after.parentNode.childNodes.indexOf(range.after) + 1;
    },
  };
  dom.document.createRange = () => ({
    setStartAfter(after) { this.after = after; },
    collapse() {},
    cloneRange() { return this; },
  });
  globalThis.getSelection = () => selection;
  return selection;
}

test("a citation typed in Visual mode becomes a chip, but older escaped text stays text", withDom((dom) => {
  const editor = visualEditor("Email \\[@handle] here.\n");
  const paragraph = editor.ui.richBody.children[0];
  const text = paragraph.childNodes[0];
  assert.equal(text.nodeValue, "Email [@handle] here.");
  // The author types at the end of the paragraph: `. See [@plato-republic]`.
  text.nodeValue += " See [@plato-republic]";
  const selection = installSelection(dom, text, text.nodeValue.length);
  try {
    const chip = editor.chipCitationBeforeCaret();
    assert.equal(chip?.dataset.citation, "[@plato-republic]");
    assert.equal(selection.anchorNode, paragraph, "the caret lands after the chip");
    assert.equal(editor.richEditorMarkdown(), "Email \\[@handle\\] here. See [@plato-republic]\n");
    // A caret not straight after `]` changes nothing.
    const plain = paragraph.childNodes[0];
    installSelection(dom, plain, 3);
    assert.equal(editor.chipCitationBeforeCaret(), null);
    // Inside a link it stays text.
    const linked = visualEditor("[go [@x]](https://example.com) now\n");
    assert.equal(linked.ui.richBody.querySelector(".oba-protected-block") !== null, true);
    const inLink = visualEditor("[go here](https://example.com) now\n");
    const anchorText = inLink.ui.richBody.querySelector("a").childNodes[0];
    anchorText.nodeValue = "go [@x]";
    installSelection(dom, anchorText, anchorText.nodeValue.length);
    assert.equal(inLink.chipCitationBeforeCaret(), null);
  } finally {
    delete globalThis.getSelection;
  }
}));

test("pasted text makes chips of its well-formed citations only", withDom((dom) => {
  const editor = visualEditor("Start\n");
  const paragraph = editor.ui.richBody.children[0];
  const text = paragraph.childNodes[0];
  const selection = installSelection(dom, text, text.nodeValue.length);
  const inserted = [];
  dom.document.execCommand = (command, _ui, value) => {
    inserted.push(value);
    const node = selection.anchorNode.nodeType === 3 ? selection.anchorNode : null;
    if (node) {
      node.nodeValue = node.nodeValue.slice(0, selection.anchorOffset) + value + node.nodeValue.slice(selection.anchorOffset);
      selection.anchorOffset += value.length;
    } else {
      const fresh = dom.document.createTextNode(value);
      selection.anchorNode.childNodes.splice(selection.anchorOffset, 0, fresh);
      fresh.parentNode = selection.anchorNode;
      selection.anchorNode = fresh;
      selection.anchorOffset = value.length;
    }
    return true;
  };
  editor.ui.body.dispatchEvent = () => true;
  try {
    editor.pasteVisualText(" one [@a, page 2] two \\[@b] three [@c](x) four [@d]");
    assert.deepEqual(editor.ui.richBody.querySelectorAll(".oba-citation").map((chip) => chip.dataset.citation), ["[@a, page 2]", "[@d]"]);
    assert.equal(inserted.join(""), " one [@a, page 2] two \\[@b] three [@c](x) four [@d]");
    assert.equal(editor.richEditorMarkdown(), "Start one [@a, page 2] two \\\\\\[@b\\] three \\[@c\\](x) four [@d]\n");
  } finally {
    delete globalThis.getSelection;
  }
}));

test("the citation status stays rendered so screen readers announce it", () => {
  const css = styles.slice(styles.indexOf("/* Citations in the visual editor"));
  const rule = css.slice(css.indexOf(".oba-citation-bar"), css.indexOf("}", css.indexOf(".oba-citation-bar")));
  assert.doesNotMatch(rule, /display:\s*none/);
  assert.match(rule, /clip: rect\(0 0 0 0\)/);
  assert.match(admin, /ui\.citationStatus = h\("span", \{ class: "oba-small", role: "status", "aria-live": "polite" \}\)/);
});

test("Evidence Studio is active for posts that publish citations and offers their portable bibliography", () => {
  const citations = { style: "notes", citations: 3, references: 1, offline: true };
  assert.equal(evidenceStudioState([], null, null).active, false);
  const state = evidenceStudioState([{ code: "citation-location-review", outcome: "needs-review", source: { path: "posts/a.md", line: 6 }, message: "m", repair: "r" }], null, citations);
  assert.equal(state.active, true);
  assert.equal(state.status, "1 evidence finding");
  assert.deepEqual(citationEvidenceRows(citations), [
    ["Citations", "3 citations of 1 reference, published as notes"],
    ["Citation checks", "Offline, from your source library; nothing is looked up online"],
  ]);
  assert.deepEqual(citationEvidenceRows(null), []);
  // A draft whose citations could not be published keeps its findings.
  const unresolved = [{ code: "citation-unresolved", outcome: "detected", source: { path: "posts/a.md", line: 6 }, message: "m", repair: "r" }];
  const broken = evidenceStudioState(unresolved, null, null);
  assert.equal(broken.active, true);
  assert.equal(broken.review.total, 1);
  const optedIn = evidenceStudioState([], null, null, true);
  assert.equal(optedIn.active, true);
  assert.equal(optedIn.status, "0 evidence findings");
  assert.equal(evidenceStudioState([], null, null, false).active, false);
  assert.equal(
    citationExportStatus({ filename: "a-references.bib", count: 2, content: "@misc{a,}", losses: [{ sourceId: "e", field: "kind", reason: "x" }, { sourceId: "e", field: "creators[1]", reason: "y" }] }),
    "Exported 2 cited references as a-references.bib; nothing was looked up online. This format cannot carry: e: kind, creators[1].",
  );
  assert.equal(citationExportStatus({ filename: "a.json", count: 1, content: "[]", losses: [] }), "Exported 1 cited reference as a.json; nothing was looked up online.");
  assert.equal(citationExportStatus(null), "Preview the post again before exporting its references.");
  // The download controls are real, labelled buttons in a named section.
  assert.match(admin, /"Download cited references \(CSL JSON\)"/);
  assert.match(admin, /"Download cited references \(BibTeX\)"/);
  assert.match(admin, /"aria-label": "Portable bibliography"/);
});
