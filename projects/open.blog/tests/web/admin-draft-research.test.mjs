import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  Editor,
  contextLinkMarkdown,
  contextLinkWarning,
  convertedNoteMarkdown,
  createDraftResearchPanel,
  draftResearchItems,
  insertMarkdownBlock,
  literalMarkdownLine,
  parseVisualMarkdown,
  quotationMarkdown,
} from "../../web/admin/admin.js";

// The draft-side research panel (A8.2, ADR 0122): quotations with their citation, citations
// from one source selection, context links only to published pages, explicit conversion of
// private notes, insertion that round-trips in Visual and Markdown modes and never lands in
// code or links, undo, and failures scoped to the item that failed.

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

const type = (node, value) => {
  node.value = value;
  return node.dispatch("input", { target: node });
};
const choose = (node, value) => {
  node.value = value;
  return node.dispatch("change", { target: node });
};

// What the visual editor needs beyond the citation tests' shim.
DomNode.prototype.after = function after(...nodes) {
  const parent = this.parentNode;
  for (const node of nodes) parent.adopt(node);
  parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, ...nodes);
};
DomNode.prototype.insertBefore = function insertBefore(node, reference) {
  this.adopt(node);
  const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
  this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
  return node;
};
DomNode.prototype.click = function click() {
  return this.disabled ? Promise.resolve() : this.dispatch("click");
};
Object.defineProperty(DomNode.prototype, "lastChild", { get() { return this.childNodes[this.childNodes.length - 1] || null; } });

function textarea(value, start = value.length, end = start) {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    events: [],
    setSelectionRange(from, to) {
      this.selectionStart = from;
      this.selectionEnd = to;
    },
    focus() {
      if (globalThis.document) globalThis.document.activeElement = this;
    },
    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    },
  };
}

function markdownEditor(value, start, end) {
  const editor = Object.create(Editor.prototype);
  editor.editorMode = "markdown";
  editor.ui = { body: textarea(value, start, end), citationUndo: { hidden: true, textContent: "" }, citationStatus: { textContent: "" } };
  return editor;
}

function visualEditor(markdown) {
  const editor = Object.create(Editor.prototype);
  editor.ui = { body: textarea(markdown), richBody: document.createElement("div"), citationUndo: { hidden: true, textContent: "" }, citationStatus: { textContent: "" } };
  editor.editorMode = "visual";
  editor.visualDirty = false;
  editor.renderRichEditor();
  return editor;
}

/** A caret in the visual editor, as the browser's saved range would be. */
function caretIn(editor, node, offset) {
  editor.visualSelection = { startContainer: node, endContainer: node, startOffset: offset, endOffset: offset, cloneRange() { return { ...this }; }, toString: () => "" };
}

/** What a reader sees: the rendered text of Markdown written by literalMarkdownLine. */
const rendered = (markdown) =>
  markdown
    .replace(/\\([\\*_`[\]])/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const DATA = () => ({
  library: {
    revision: "lib-1",
    sources: [
      { id: "plato", kind: "work", title: "Πολιτεία" },
      { id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam", rightsStatus: { status: "publicDomain", label: "The author states the text is in the public domain" } },
      { id: "bloom", kind: "translation", of: "plato", language: "en", title: "The Republic of Plato", rightsStatus: { status: "unknown", label: "Rights not checked yet" } },
      { id: "gone", kind: "edition", of: "plato", title: "Archived edition", archived: true },
    ],
    interpretations: [{ id: "reading-1", kind: "reading", source: "slings", locators: [{ kind: "page", value: "514" }], language: "en", text: "A reading of the cave" }],
  },
  notebook: {
    revision: "nb-1",
    passages: [
      { id: "cave", source: "slings", locators: [{ kind: "page", value: "514", to: "515" }], excerpt: { text: "ἰδὲ γὰρ *οἷον* [ἐν] <b>x</b>", language: "grc" }, notes: 1 },
      { id: "den", source: "bloom", locators: [], excerpt: { text: "Behold! human beings living in an underground den" }, notes: 0 },
    ],
    notes: [{ id: "why", kind: "question", status: "open", text: "PRIVATE-NOTE why a cave?", passages: ["cave"] }],
  },
  atlas: {
    publish: true,
    url: "/atlas/",
    entries: [
      { id: "plato-person", kind: "person", label: "Plato", aliases: ["Aristocles"], approved: true, url: "/atlas/plato-person/", datings: [{ id: "born", aspect: "birth", text: "c. 428 BCE" }] },
      { id: "the-good", kind: "concept", label: "The Good", aliases: [], approved: false, url: null, datings: [] },
    ],
  },
  comparisons: { publish: false, url: "/comparisons/", items: [{ id: "cave-places", label: "The cave", approved: true, url: null, interpretations: ["reading-1"] }] },
});

function fakeApi(data, check = (body) => ({ markdown: `[@${body.citation.key}${body.citation.locators.map((l, i) => `${i ? "; " : ", "}${l.kind} ${l.value}${l.to ? ` to ${l.to}` : ""}`).join("")}]` })) {
  const calls = [];
  return {
    calls,
    async call(method, path, options = {}) {
      calls.push({ method, path, body: options.json === undefined ? undefined : structuredClone(options.json) });
      if (method === "GET" && path === "research/draft") {
        if (data instanceof Error) throw data;
        return structuredClone(data);
      }
      if (method === "POST" && path === "citations/check") return check(options.json);
      throw new ApiError(`unexpected ${method} ${path}`, 500, null);
    },
  };
}

async function mountPanel(data = DATA(), check, refuse = "") {
  const inserted = [];
  const api = fakeApi(data, check);
  const panel = createDraftResearchPanel({ api, insert: (request) => (inserted.push(request), refuse) });
  document.body.append(panel.element);
  await panel.load();
  return { panel, api, inserted, root: panel.element };
}

const button = (root, text) => root.querySelectorAll("button").find((node) => node.textContent === text) || null;
const item = (root, key) => root.querySelector(`[data-draft-item]`) && root.querySelectorAll("button").find((node) => node.dataset.draftItem === key);
const shown = (root) => root.querySelectorAll("button").filter((node) => node.dataset.draftItem).map((node) => node.dataset.draftItem);
const errorText = (root) => {
  const box = root.querySelectorAll("p").find((node) => node.dataset.draftResearchError === "true");
  return box && !box.hidden ? box.textContent : "";
};

// ---------------------------------------------------------------- Markdown that renders exactly

test("quoted text is written so it renders exactly and nothing in it becomes markup", () => {
  const hostile = [
    "<script>alert(1)</script> & &amp; [x](javascript:alert(1)) ![i](x) *em* _u_ `code` \\ | ~~s~~",
    "# not a heading",
    "> not a quote",
    "- not a list",
    "+ nor this",
    "1. not numbered",
    "2) nor this",
    "=====",
    "    not code, and trailing spaces  ",
    "\tTabbed",
    "[^1]: not a footnote [@not-a-citation]",
    "Ελληνικά and עברית stay as they are",
  ];
  for (const line of hostile) {
    const markdown = literalMarkdownLine(line);
    assert.equal(rendered(markdown), line, `${line} renders as written`);
    assert.doesNotMatch(markdown, /<|^[#>+=-]|^\d+[.)]|^\s|\s$|(?<!\\)\[@|~~|(?<!\\)[*_`[\]]/u, `${line} carries no live markup`);
  }
});

test("a quotation is a block quote of the exact wording ending with its citation", () => {
  assert.equal(quotationMarkdown("One line.", "[@slings, page 514]"), "> One line. [@slings, page 514]");
  assert.equal(quotationMarkdown("\n\nFirst *line*\n\nsecond [line]\n\n", "[@s]"), "> First \\*line\\*\n> \n> second \\[line\\] [@s]", "blank lines at either end go; one inside is a paragraph break");
  assert.equal(quotationMarkdown("Text", "[@x](javascript:alert(1))"), "", "only a citation is accepted");
  assert.equal(quotationMarkdown("Text", ""), "");
  assert.equal(quotationMarkdown("   \n  ", "[@s]"), "", "no wording, no quotation");
  assert.equal(convertedNoteMarkdown("My *own* thought\nwith two lines\n\n# and a second paragraph"), "My \\*own\\* thought\nwith two lines\n\n&#35; and a second paragraph");
});

test("context links are made only for published atlas and comparison pages", () => {
  assert.equal(contextLinkMarkdown("Plato [the] *philosopher*", "/atlas/plato/"), "[Plato \\[the\\] \\*philosopher\\*](/atlas/plato/)");
  assert.equal(contextLinkMarkdown("The cave", "/comparisons/cave-places/"), "[The cave](/comparisons/cave-places/)");
  for (const url of ["javascript:alert(1)", "/atlas/../private/", "https://example.com/atlas/x/", "/atlas/x", "/notes/x/", "", null]) {
    assert.equal(contextLinkMarkdown("Label", url), "", `${url} is never linked`);
  }
  assert.equal(contextLinkMarkdown("   ", "/atlas/x/"), "");
  assert.match(contextLinkWarning({ approved: false, url: null }, { area: "atlas", publish: true }), /^Not published: this entry is private research/);
  assert.match(contextLinkWarning({ approved: true, url: null }, { area: "atlas", publish: false }), /knowledgeAtlas\.publish/);
  assert.match(contextLinkWarning({ approved: true, url: null }, { area: "comparisons", publish: false }), /comparisons\.publish/);
  assert.match(contextLinkWarning({ approved: true, url: null }, { area: "comparisons", publish: true }), /cannot publish this comparison/);
  assert.equal(contextLinkWarning({ approved: true, url: "/atlas/x/" }, { area: "atlas", publish: true }), "");
});

test("a block goes after the paragraph the caret is in, never inside code or HTML", () => {
  const draft = "First line\nsecond line.\n\nNext paragraph.\n";
  const block = "> Q [@s]";
  const middle = insertMarkdownBlock(draft, 3, 8, block);
  assert.equal(middle.value, "First line\nsecond line.\n\n> Q [@s]\n\nNext paragraph.\n", "the paragraph is not split and the selection stays");
  assert.equal(middle.start, "First line\nsecond line.\n\n> Q [@s]".length);
  assert.equal(insertMarkdownBlock(draft, draft.length, draft.length, block).value, `${draft}\n${block}\n`);
  assert.equal(insertMarkdownBlock("", 0, 0, block).value, `${block}\n`);
  assert.equal(insertMarkdownBlock("A\n\n\n\nB", 3, 3, block).value, "A\n\n> Q [@s]\n\nB", "on a blank line it goes there, between blank lines");
  assert.equal(insertMarkdownBlock("- one\n- two\n\nAfter", 2, 2, block).value, "- one\n- two\n\n> Q [@s]\n\nAfter", "after a whole list");
  assert.deepEqual(insertMarkdownBlock("```\ncode\n```\n", 6, 6, block), { problem: "code" });
  assert.deepEqual(insertMarkdownBlock("<div>\nhtml\n</div>\n", 8, 8, block), { problem: "html" });
});

// ---------------------------------------------------------------- the editor

test("a quotation inserted in Markdown mode is undoable to the exact draft and caret", withDom(() => {
  const draft = "Intro paragraph.\n\nClosing.\n";
  const editor = markdownEditor(draft, 5, 5);
  const markdown = quotationMarkdown("Behold!", "[@bloom]");
  assert.equal(editor.insertFromResearch({ kind: "block", markdown, label: "quotation" }), "");
  assert.equal(editor.ui.body.value, "Intro paragraph.\n\n> Behold! [@bloom]\n\nClosing.\n");
  assert.equal(editor.ui.citationUndo.hidden, false);
  assert.equal(editor.ui.citationUndo.textContent, "Undo quotation");
  assert.match(editor.ui.citationStatus.textContent, /^Quotation inserted into your unsaved draft\. Press Ctrl\+Z/);
  assert.equal(editor.citationUndoAvailable(), true);
  assert.equal(editor.undoCitation(), true);
  assert.equal(editor.ui.body.value, draft);
  assert.deepEqual([editor.ui.body.selectionStart, editor.ui.body.selectionEnd], [5, 5]);
  assert.equal(editor.ui.citationStatus.textContent, "Quotation undone. The draft is as it was before.");
}));

test("research is never inserted inside code, HTML or a link, and a citation never edits one the caret is in", withDom(() => {
  const inCode = markdownEditor("Use `code here` now.", 8);
  assert.match(inCode.insertFromResearch({ kind: "inline", markdown: "[Plato](/atlas/plato/)", label: "link" }), /cannot go inside code/);
  assert.equal(inCode.ui.body.value, "Use `code here` now.");
  const inLink = markdownEditor("See [the page](/x/) here.", 7);
  assert.match(inLink.insertFromResearch({ kind: "inline", markdown: "[Plato](/atlas/plato/)", label: "link" }), /^Link cannot go inside a link/);
  const fence = markdownEditor("```\nx\n```\n", 5);
  assert.match(fence.insertFromResearch({ kind: "block", markdown: "> Q [@s]", label: "quotation" }), /^Quotation cannot go inside code/);
  assert.equal(fence.ui.body.value, "```\nx\n```\n");

  const cited = markdownEditor("Claim [@plato, page 2] here.", 10);
  assert.equal(cited.insertFromResearch({ kind: "citation", markdown: "[@slings]" }), "");
  assert.equal(cited.ui.body.value, "Claim [@plato, page 2] [@slings] here.", "the citation the caret was in is kept");
  assert.equal(cited.ui.citationUndo.textContent, "Undo citation");

  const link = markdownEditor("Plato wrote.", 5);
  assert.equal(link.insertFromResearch({ kind: "inline", markdown: "[Plato](/atlas/plato/)", label: "link" }), "");
  assert.equal(link.ui.body.value, "Plato [Plato](/atlas/plato/) wrote.");
  assert.match(markdownEditor("x").insertFromResearch({ kind: "citation", markdown: "[@x](javascript:alert(1))" }), /no citation/);
}));

test("in Visual mode a quotation lands after the caret's paragraph and writes the same Markdown back", withDom(() => {
  const draft = "First paragraph.\n\nSecond paragraph.\n";
  const editor = visualEditor(draft);
  const first = editor.ui.richBody.children[0];
  caretIn(editor, first.childNodes[0], 5);
  const excerpt = "ἰδὲ *οἷον* [ἐν] <b>x</b> & 1. done";
  const markdown = quotationMarkdown(excerpt, "[@slings, page 514]");
  assert.equal(editor.insertFromResearch({ kind: "block", markdown, label: "quotation" }), "");
  const [, quote, second] = editor.ui.richBody.children;
  assert.equal(quote.tagName, "BLOCKQUOTE");
  assert.equal(quote.querySelector(".oba-citation").dataset.citation, "[@slings, page 514]");
  assert.equal(quote.querySelectorAll("em").length, 0, "no emphasis appears from the wording");
  assert.equal(second.textContent, "Second paragraph.");
  assert.equal(editor.ui.body.value, `First paragraph.\n\n${markdown}\n\nSecond paragraph.\n`);
  // Switching modes, both ways, keeps every byte.
  const reread = visualEditor(editor.ui.body.value);
  assert.equal(reread.richEditorMarkdown(), editor.ui.body.value);
  assert.deepEqual(parseVisualMarkdown(`${markdown}\n`).map((block) => block.type), ["quote"]);

  assert.equal(editor.undoCitation(), true);
  assert.equal(editor.ui.body.value, draft);
  assert.equal(editor.ui.richBody.children.length, 2);
}));

test("in Visual mode a block replaces the empty paragraph and a link goes at the caret", withDom(() => {
  const empty = visualEditor("");
  caretIn(empty, empty.ui.richBody.children[0], 0);
  assert.equal(empty.insertFromResearch({ kind: "block", markdown: convertedNoteMarkdown("My own words"), label: "note text" }), "");
  assert.equal(empty.ui.body.value, "My own words\n");
  assert.equal(empty.ui.richBody.children.length, 1);

  const editor = visualEditor("Plato wrote.\n");
  const paragraph = editor.ui.richBody.children[0];
  caretIn(editor, paragraph.childNodes[0], 5);
  assert.equal(editor.insertFromResearch({ kind: "inline", markdown: contextLinkMarkdown("Plato", "/atlas/plato/"), label: "link" }), "");
  assert.equal(editor.ui.body.value, "Plato [Plato](/atlas/plato/) wrote.\n");
  assert.equal(paragraph.querySelector("a").getAttribute("href"), "/atlas/plato/");

  const linked = visualEditor("See [the page](/x/).\n");
  const anchor = linked.ui.richBody.children[0].querySelector("a");
  caretIn(linked, anchor.childNodes[0], 2);
  assert.match(linked.insertFromResearch({ kind: "inline", markdown: "[P](/atlas/p/)", label: "link" }), /cannot go inside a link/);
  assert.equal(linked.ui.body.value, "See [the page](/x/).\n");
  const noCaret = visualEditor("Text.\n");
  assert.match(noCaret.insertFromResearch({ kind: "inline", markdown: "[P](/atlas/p/)", label: "link" }), /Place the caret/);
}));

// ---------------------------------------------------------------- the panel

test("the panel lists research by kind with its visibility, keeps notes out unless asked, and searches", withDom(async () => {
  const { root, panel } = await mountPanel();
  assert.equal(root.tagName, "ASIDE");
  assert.equal(root.getAttribute("aria-labelledby"), "oba-draft-research-title");
  assert.ok(root.querySelector("#oba-draft-research-title"));
  assert.equal(root.querySelectorAll("label").map((label) => label.textContent).slice(0, 2).join(" | "), "Search research | Show");
  assert.match(root.querySelector("[data-draft-research-boundary]").textContent, /Only what you insert goes into this draft/);
  assert.deepEqual(shown(root), ["passage:cave", "passage:den", "source:plato", "source:slings", "source:bloom", "atlas:plato-person", "atlas:the-good", "comparison:cave-places", "interpretation:reading-1"]);
  assert.doesNotMatch(root.textContent, /PRIVATE-NOTE/, "private notes are not listed by default");
  assert.equal(item(root, "atlas:plato-person").querySelector(".oba-visibility").textContent, "Published");
  assert.equal(item(root, "atlas:the-good").querySelector(".oba-visibility").textContent, "Not published");
  assert.equal(item(root, "passage:cave").querySelector(".oba-visibility").textContent, "Private research");

  const filter = root.querySelector("#oba-draft-research-filter");
  await choose(filter, "notes");
  assert.deepEqual(shown(root), ["note:why"]);
  assert.equal(item(root, "note:why").querySelector(".oba-visibility").textContent, "Private note");
  await choose(filter, "all");
  await type(root.querySelector("#oba-draft-research-search"), "aristocles");
  assert.deepEqual(shown(root), ["atlas:plato-person"], "aliases are searched");
  await type(root.querySelector("#oba-draft-research-search"), "οιον");
  assert.deepEqual(shown(root), ["passage:cave"], "accents are folded");
  assert.match(root.querySelector("[data-draft-research-status]").textContent, /^1 result\.$/);
  assert.equal(typeof panel.focus, "function");
}));

test("a passage inserts its exact wording with a server-checked citation and never its notes", withDom(async (dom) => {
  const { root, api, inserted } = await mountPanel();
  await item(root, "passage:cave").click();
  assert.equal(dom.document.activeElement?.id, "oba-draft-research-detail-title", "focus moves to the item");
  assert.match(root.textContent, /1 private note is linked to this passage\. It is never inserted with it\./);
  assert.match(root.textContent, /Rights: The author states the text is in the public domain/);
  assert.equal(root.querySelector("[data-draft-research-confirm]"), null, "a declared public-domain text asks no confirmation");
  await button(root, "Insert quotation with citation").click();
  const check = api.calls.find((call) => call.path === "citations/check");
  assert.deepEqual(check.body, { revision: "lib-1", citation: { key: "slings", locators: [{ kind: "page", value: "514", to: "515" }] } });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].kind, "block");
  assert.equal(inserted[0].label, "quotation");
  assert.equal(inserted[0].markdown, quotationMarkdown("ἰδὲ γὰρ *οἷον* [ἐν] <b>x</b>", "[@slings, page 514 to 515]"));
  assert.doesNotMatch(JSON.stringify(inserted), /PRIVATE-NOTE/);

  await button(root, "Insert citation only").click();
  assert.deepEqual(inserted[1], { kind: "citation", markdown: "[@slings, page 514 to 515]" });
}));

test("unchecked or reserved rights wait for confirmation, and a refusal is reported inside the item", withDom(async () => {
  const { root, inserted, api } = await mountPanel(DATA(), undefined, "Quotation cannot go inside code or a protected block. Move the caret into ordinary text and insert again; your draft is unchanged.");
  await item(root, "passage:den").click();
  assert.match(root.querySelector("[data-draft-research-confirm]").textContent, /nobody has checked the rights to this text, and quoting it is my decision/);
  await button(root, "Insert quotation with citation").click();
  assert.equal(inserted.length, 0);
  assert.equal(api.calls.filter((call) => call.path === "citations/check").length, 0, "nothing is asked before the confirmation");
  assert.match(errorText(root), /Confirm that you have read the rights statement first/);
  root.querySelector("#oba-draft-research-confirm-rights").checked = true;
  await button(root, "Insert quotation with citation").click();
  assert.equal(inserted.length, 1);
  assert.match(errorText(root), /^Quotation cannot go inside code/, "the editor's refusal stays with the item");
}));

test("a stale library or a citation problem fails inside the item and changes nothing", withDom(async () => {
  let attempt = 0;
  const check = () => {
    attempt += 1;
    if (attempt === 1) throw new ApiError("changed", 409, { error: "The source library changed after the citation picker opened. Nothing was inserted; review the refreshed sources and insert again.", conflict: true, revision: "lib-2", sources: DATA().library.sources });
    if (attempt === 2) throw new ApiError("bad", 422, { error: "bad locator", diagnostics: [{ code: "ambiguous-locator", message: "A page needs an edition." }] });
    return { markdown: "[@slings, page 9]" };
  };
  const { root, api, inserted } = await mountPanel(DATA(), check);
  await item(root, "source:slings").click();
  await type(root.querySelector("#oba-draft-research-locators"), "page: 9");
  assert.equal(root.querySelector("[data-draft-research-citation]").textContent, "[@slings, page 9]");
  await button(root, "Insert citation").click();
  assert.match(errorText(root), /source library changed/);
  assert.equal(inserted.length, 0);
  await button(root, "Insert citation").click();
  assert.match(errorText(root), /A page needs an edition\. Your draft is unchanged\./);
  await button(root, "Insert citation").click();
  assert.deepEqual(inserted, [{ kind: "citation", markdown: "[@slings, page 9]" }]);
  const revisions = api.calls.filter((call) => call.path === "citations/check").map((call) => call.body.revision);
  assert.deepEqual(revisions, ["lib-1", "lib-2", "lib-2"], "the refreshed revision is used next");
  assert.deepEqual(api.calls.filter((call) => call.method !== "GET" && call.path !== "citations/check"), [], "nothing is written");
  await type(root.querySelector("#oba-draft-research-locators"), "nonsense");
  await button(root, "Insert citation").click();
  assert.match(errorText(root), /Locator 1 must look like/);
  assert.equal(inserted.length, 1);
}));

test("context is linked only once published, with a clear warning otherwise", withDom(async () => {
  const { root, inserted } = await mountPanel();
  await item(root, "atlas:the-good").click();
  assert.match(root.querySelector("[data-draft-research-warning]").textContent, /^Not published: this entry is private research/);
  assert.equal(root.querySelectorAll("button").filter((node) => node.dataset.draftInsert === "link").length, 0, "no way to link a private entry");
  await item(root, "comparison:cave-places").click();
  assert.match(root.querySelector("[data-draft-research-warning]").textContent, /does not publish its comparisons yet/);
  assert.equal(root.querySelectorAll("button").filter((node) => node.dataset.draftInsert === "link").length, 0);

  await item(root, "atlas:plato-person").click();
  assert.match(root.textContent, /Published at \/atlas\/plato-person\/\./);
  await button(root, "Insert link to this entry").click();
  await button(root, "Insert “c. 428 BCE” linked to the entry").click();
  assert.deepEqual(inserted, [
    { kind: "inline", markdown: "[Plato](/atlas/plato-person/)", label: "link" },
    { kind: "inline", markdown: "[c. 428 BCE](/atlas/plato-person/)", label: "dating" },
  ]);
  const open = root.querySelectorAll("a").find((node) => node.dataset.draftResearchOpen === "true");
  assert.equal(open.getAttribute("href"), "#/research/atlas/plato-person", "the full panel opens in the workspace, keeping the draft");
}));

test("an interpretation is never inserted, and a private note only through explicit conversion", withDom(async () => {
  const { root, inserted } = await mountPanel();
  await item(root, "interpretation:reading-1").click();
  assert.match(root.querySelector("[data-draft-research-warning]").textContent, /never cited and never inserted/);
  assert.equal(root.querySelectorAll("button").filter((node) => node.dataset.draftInsert === "link").length, 0, "its comparison is not published");
  await button(root, "Cite the interpreted source").click();
  assert.deepEqual(inserted, [{ kind: "citation", markdown: "[@slings, page 514]" }]);

  await choose(root.querySelector("#oba-draft-research-filter"), "notes");
  await item(root, "note:why").click();
  const convert = root.querySelector("[data-draft-research-convert]");
  assert.equal(convert.hidden, true, "conversion starts hidden");
  await button(root, "Convert to draft text…").click();
  assert.equal(convert.hidden, false);
  await button(root, "Insert as my own words").click();
  assert.equal(inserted.length, 1, "nothing goes in without the confirmation");
  assert.match(errorText(root), /Confirm the conversion first/);
  root.querySelector("#oba-draft-research-confirm-note").checked = true;
  await button(root, "Insert as my own words").click();
  assert.deepEqual(inserted[1], { kind: "block", markdown: "PRIVATE-NOTE why a cave?", label: "note text" });
}));

test("a store that cannot be read is reported in its own part and the rest still works", withDom(async () => {
  const data = DATA();
  data.notebook = { error: "The research notebook could not be read, so it is not offered here. Nothing was changed.", file: ".openblog/private/research/notebook.json" };
  const { root } = await mountPanel(data);
  assert.match(root.querySelector("[data-draft-research-problem]").textContent, /^Passages and notes: The research notebook could not be read/);
  assert.ok(shown(root).includes("source:slings"));
  assert.ok(!shown(root).some((key) => key.startsWith("passage:")));

  const failed = await mountPanel(new ApiError("Server error", 500, null));
  assert.match(failed.root.querySelector("[data-draft-research-status]").textContent, /^Your research could not be read\. Your draft is unchanged\./);
  assert.deepEqual(shown(failed.root), []);
}));

test("comparisons blocked by an unreadable library or notebook never blame the alignments file", withDom(async () => {
  for (const [part, said] of [["library", "your sources"], ["notebook", "your passages and notes"]]) {
    const data = DATA();
    data[part] = { error: "It could not be read, so it is not offered here. Nothing was changed.", file: `.openblog/private/research/${part}.json` };
    // Even a server that still blamed the alignments file is not repeated.
    data.comparisons = { error: "The comparisons could not be read. alignments.json: broken", file: ".openblog/private/research/alignments.json" };
    const { root } = await mountPanel(data);
    const problem = (key) => root.querySelectorAll("[data-draft-research-problem]").find((node) => node.dataset.draftResearchProblem === key).textContent;
    const notice = problem("comparisons");
    assert.equal(notice, `Comparisons: Not offered while ${said} cannot be read. Nothing was changed.`);
    assert.doesNotMatch(notice, /alignments|Repair/);
    assert.ok(problem(part).endsWith(`Repair .openblog/private/research/${part}.json by hand.`), problem(part));
  }
  const data = DATA();
  data.comparisons = { error: "The comparisons could not be read, so it is not offered here. Nothing was changed.", file: ".openblog/private/research/alignments.json" };
  const { root } = await mountPanel(data);
  assert.match(root.querySelectorAll("[data-draft-research-problem]").find((node) => node.dataset.draftResearchProblem === "comparisons").textContent, /Repair \.openblog\/private\/research\/alignments\.json by hand\./);
}));

test("passages, notes and atlas entries blocked by an earlier part never blame their own files", withDom(async () => {
  for (const [part, said, later] of [["library", "your sources", ["notebook", "atlas"]], ["notebook", "your passages and notes", ["atlas"]]]) {
    const data = DATA();
    data[part] = { error: "It could not be read, so it is not offered here. Nothing was changed.", file: `.openblog/private/research/${part}.json` };
    // A server that still blamed the later files is not repeated: the earlier part is the cause.
    data.atlas = { error: "The Knowledge Atlas could not be read. atlas.json: broken", file: ".openblog/private/research/atlas.json" };
    if (part === "library") data.notebook = { error: "The passages and notes are not offered while the source library cannot be read. Nothing was changed.", unavailableBecause: "library" };
    const { root } = await mountPanel(data);
    const problem = (key) => root.querySelectorAll("[data-draft-research-problem]").find((node) => node.dataset.draftResearchProblem === key).textContent;
    const labels = { notebook: "Passages and notes", atlas: "Atlas entries" };
    for (const key of later) {
      const notice = problem(key);
      assert.equal(notice, `${labels[key]}: Not offered while ${said} cannot be read. Nothing was changed.`);
      assert.doesNotMatch(notice, /\.json|Repair/);
    }
    assert.ok(problem(part).endsWith(`Repair .openblog/private/research/${part}.json by hand.`), problem(part));
  }
}));

test("the panel builds DOM safely, has no motion, and reflows on narrow screens", () => {
  const start = admin.indexOf("export function createDraftResearchPanel");
  const end = admin.indexOf("/** Child indexes from `root` down to `node`", start);
  const source = admin.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|localStorage|sessionStorage|indexedDB/);
  assert.match(styles, /\.oba-write-layout\[data-research="open"\] \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /@media \(min-width: 64rem\) \{\s*\.oba-write-layout\[data-research="open"\] \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(16rem, 22rem\);/);
  assert.match(styles, /\.oba-draft-research-item:focus-visible \{[^}]*outline: 3px solid/);
  const panelStyles = styles.slice(styles.indexOf("/* The draft-side research panel"));
  assert.doesNotMatch(panelStyles, /transition|animation/);
});

// ---------------------------------------------------------------- research checks beside the draft (#194)

test("the draft-side panel counts the draft's research checks apart and opens the one review, never scoring", withDom(async () => {
  const review = {
    applies: true,
    findings: [{}, {}, {}],
    counts: { detected: { found: 2, acknowledged: 1 }, potential: { found: 1, acknowledged: 0 }, needsReview: { found: 0, acknowledged: 0 } },
    groups: [{ name: "blocking", findings: [0] }],
  };
  const opened = [];
  const api = fakeApi(DATA());
  const panel = createDraftResearchPanel({ api, insert: () => "", onChecks: async () => review, onReview: () => opened.push("review") });
  document.body.append(panel.element);
  await panel.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const line = panel.element.querySelector("[data-draft-research-checks-line]");
  assert.equal(line.textContent, "1 must be fixed before publishing. Detected: 2 (1 acknowledged). Potential: 1. Needs review: 0.");
  assert.equal(line.getAttribute("role"), "status");
  assert.doesNotMatch(line.textContent, /score|ready|passed|resolved/i);
  const open = panel.element.querySelector("[data-draft-research-checks-open]");
  assert.equal(open.getAttribute("aria-describedby"), line.id);
  await open.click();
  assert.deepEqual(opened, ["review"], "it opens the same review the publication dialog shows");

  // A draft outside the review, an empty review and a failed read each say so, in words.
  for (const [result, pattern] of [
    [{ applies: false, findings: [] }, /neither/],
    [{ applies: true, findings: [] }, /not a judgement of the draft/],
  ]) {
    const other = createDraftResearchPanel({ api: fakeApi(DATA()), insert: () => "", onChecks: async () => result, onReview: () => {} });
    document.body.append(other.element);
    await other.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(other.element.querySelector("[data-draft-research-checks-line]").textContent, pattern);
  }
  const failing = createDraftResearchPanel({ api: fakeApi(DATA()), insert: () => "", onChecks: async () => { throw new Error("offline"); }, onReview: () => {} });
  document.body.append(failing.element);
  await failing.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(failing.element.querySelector("[data-draft-research-checks-line]").textContent, /could not be read\. Your draft is unchanged/);
  // Without the hook (pages) the panel has no checks section at all.
  const plain = createDraftResearchPanel({ api: fakeApi(DATA()), insert: () => "" });
  assert.equal(plain.element.querySelector("[data-draft-research-checks]"), null);
}));
