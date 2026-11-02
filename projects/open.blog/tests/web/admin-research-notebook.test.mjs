import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  Editor,
  ObAdmin,
  hitContext,
  notebookSearchBody,
  notebookImportRows,
  notebookImportSummary,
  searchIsActive,
  captureSources,
  createCaptureForm,
  entryPreview,
  formatLocatorLines,
  noteDraft,
  noteDraftPayload,
  normalizeAdminPreferences,
  notebookDiagnosticControl,
  notebookErrorMessage,
  parseConceptList,
  parseLocatorLines,
  passageDraft,
  passageDraftPayload,
  suggestEntryId,
  validateNoteDraft,
  validatePassageDraft,
  canonicalAdminHash,
  researchHref,
} from "../../web/admin/admin.js";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");

// ---------------------------------------------------------------- DOM shim

class DomNode {
  constructor(tag = "", owner = null) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.owner = owner;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.open = false;
    this._text = "";
    this._value = undefined;
    this.classList = { contains: (name) => (this.className || "").split(/\s+/).includes(name) };
  }
  get value() {
    if (this.tagName === "SELECT" && this._value === undefined) return this.children.find((child) => child.selected)?.value ?? this.children[0]?.value ?? "";
    return this._value ?? "";
  }
  set value(value) {
    this._value = String(value);
  }
  append(...children) {
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      const node = child instanceof DomNode ? child : Object.assign(new DomNode("#text"), { textContent: String(child) });
      node.parent?.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "hidden") this.hidden = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  get isConnected() {
    for (let node = this; node; node = node.parent) if (node === this.owner?.body) return true;
    return false;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name, listener, options = {}) {
    (this.listeners[name] ||= []).push({ listener, once: Boolean(options.once) });
  }
  dispatch(name, event = {}) {
    const listeners = this.listeners[name] || [];
    this.listeners[name] = listeners.filter((entry) => !entry.once);
    const payload = { type: name, target: this, currentTarget: this, preventDefault() {}, ...event };
    return Promise.all(listeners.map((entry) => entry.listener(payload)));
  }
  click() {
    if (this.disabled) return Promise.resolve();
    return this.dispatch("click");
  }
  focus() {
    this.owner.activeElement = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    // Browsers queue the close event as a task, after the code that closed the dialog.
    setTimeout(() => this.dispatch("close"), 0);
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const attribute = selector.match(/^([a-z]*)\[([a-z-]+)\]$/);
    if (attribute) {
      const [, tag, name] = attribute;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (name === "open") return this.open;
      if (name.startsWith("data-")) return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset;
      return name in this.attributes;
    }
    return this.tagName === selector.toUpperCase();
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
}

function installDom() {
  const previous = { Node: globalThis.Node, document: globalThis.document, location: globalThis.location, open: globalThis.open, localStorage: globalThis.localStorage };
  const documentShim = {
    activeElement: null,
    documentElement: { dataset: {} },
    title: "",
    createElement: (tag) => new DomNode(tag, documentShim),
    createTextNode: (text) => Object.assign(new DomNode("#text", documentShim), { textContent: String(text) }),
    querySelector: (selector) => documentShim.body.querySelector(selector),
  };
  documentShim.body = new DomNode("body", documentShim);
  globalThis.Node = DomNode;
  globalThis.document = documentShim;
  globalThis.location = { hash: "#/overview" };
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

const settledSearch = () => new Promise((resolve) => setTimeout(resolve, 250));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const memoryStorage = (values = {}) => ({
  values,
  getItem: (key) => values[key] ?? null,
  setItem: (key, value) => {
    values[key] = String(value);
  },
  removeItem: (key) => {
    delete values[key];
  },
});
const findByText = (root, tag, text) => root.querySelectorAll(tag).find((node) => node.textContent.includes(text));

// ---------------------------------------------------------------- fixtures

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const HOSTILE = '<img src=x onerror="alert(1)"> ὁ δὲ Σωκράτης 🙂 <script>alert(2)</script>';
const SOURCES = () => [
  { id: "plato-republic", kind: "work", title: "Πολιτεία" },
  { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam" },
  { id: "old", kind: "edition", of: "plato-republic", title: "Old", archived: true },
];
const PASSAGE = () => ({
  id: "passage-1",
  source: "slings-2003",
  excerpt: { text: HOSTILE, language: "grc", scan: "p1.png" },
  locators: [{ kind: "page", value: "514", hint: true }, { kind: "canonical", value: "514a", to: "520a" }],
  visibility: "private",
  extra: 1,
});
const NOTE = () => ({ id: "note-2", kind: "question", text: "Why a cave?", passages: ["passage-1"], sources: ["plato-republic"], concepts: ["allegory"], visibility: "private" });
const notebook = (over = {}) => ({ file: ".openblog/private/research/notebook.json", revision: "r1", stored: true, sources: SOURCES(), passages: [PASSAGE()], notes: [NOTE()], ...over });

function notebookApi(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, path, options = {}) {
      const handler = handlers[`${method} ${path}`] || handlers[`${method} ${path} ${JSON.stringify(options.json)}`];
      if (method !== "GET" && !/^research\/(search|backlinks)$/.test(path)) calls.push({ method, path, body: options.json });
      if (!handler) throw new ApiError(`unexpected ${method} ${path}`, 500, null);
      return handler(options.json);
    },
  };
}

const byId = (root, id) => root.querySelector(`#${id}`);
const type = async (control, value, event = "input") => {
  control.value = value;
  await control.dispatch(event, { target: control });
};
const submit = (node) => (node.tagName === "FORM" ? node : node.querySelector("form")).dispatch("submit");
const buttonLabelled = (root, text) => root.querySelectorAll("button").find((button) => button.textContent === text);
const entryButtons = (root) => root.querySelectorAll("button").filter((button) => button.dataset.entryId);
const entryButton = (root, id) => entryButtons(root).find((button) => button.dataset.entryId === id);
const removeButton = (root) => root.querySelectorAll("button").find((button) => button.dataset.entryRemove);

function formState(over = {}) {
  return { revision: "r1", sources: SOURCES(), passages: [], notes: [], ...over };
}

// ---------------------------------------------------------------- pure helpers

test("locators parse one per line, keep ranges, and format back losslessly", () => {
  const lines = "page: 514\nfolio: 12r\ncanonical: 514a to 520a\nx-stephanus: 514a\n\nloose";
  assert.deepEqual(parseLocatorLines(lines), [
    { kind: "page", value: "514" },
    { kind: "folio", value: "12r" },
    { kind: "canonical", value: "514a", to: "520a" },
    { kind: "x-stephanus", value: "514a" },
    { kind: "", value: "loose" },
  ]);
  const stored = PASSAGE().locators;
  assert.deepEqual(parseLocatorLines(formatLocatorLines(stored)), [{ kind: "page", value: "514" }, stored[1]]);
  assert.deepEqual(parseConceptList("Allegory, the-good  allegory\n"), ["allegory", "the-good"]);
});

test("a passage payload sends the quoted text exactly and carries every unknown field", () => {
  const stored = PASSAGE();
  assert.deepEqual(passageDraftPayload(passageDraft(stored)), stored, "an untouched draft is the stored passage");
  const draft = passageDraft(stored);
  draft.excerpt = `  ${HOSTILE}\n\n  second paragraph  `;
  draft.language = "";
  draft.locators = "page: 515";
  const payload = passageDraftPayload(draft);
  assert.equal(payload.excerpt.text, `  ${HOSTILE}\n\n  second paragraph  `, "quoted text is neither trimmed nor interpreted");
  assert.equal(payload.excerpt.scan, "p1.png");
  assert.equal("language" in payload.excerpt, false);
  assert.deepEqual(payload.locators, [{ kind: "page", value: "515" }]);
  assert.equal(payload.extra, 1);
  const fresh = Object.assign(passageDraft(null, "slings-2003"), { id: "passage-9", excerpt: "x" });
  assert.deepEqual(passageDraftPayload(fresh), { id: "passage-9", source: "slings-2003", excerpt: { text: "x" } });
});

test("a note payload keeps unknown fields and drops emptied links", () => {
  const stored = NOTE();
  assert.deepEqual(noteDraftPayload(noteDraft(stored)), stored);
  const draft = noteDraft({ ...stored, mood: "curious" });
  draft.passages = [];
  draft.concepts = "";
  const payload = noteDraftPayload(draft);
  assert.equal(payload.mood, "curious");
  assert.equal("passages" in payload, false);
  assert.equal("concepts" in payload, false);
});

test("the advisory checks name the first problem and the control that fixes it", () => {
  const sources = SOURCES();
  const check = (changes) => validatePassageDraft(Object.assign(passageDraft(null), changes), sources);
  assert.equal(check({ excerpt: "x" }).field, "source");
  assert.equal(check({ source: "absent", excerpt: "x" }).field, "source");
  assert.equal(check({ source: "slings-2003", excerpt: "  \n " }).field, "excerpt");
  assert.equal(check({ source: "slings-2003", excerpt: "ὁ".repeat(20001) }).field, "excerpt");
  assert.equal(check({ source: "slings-2003", excerpt: "ὁ".repeat(20000) }), null, "long Unicode is counted by character");
  assert.equal(check({ source: "slings-2003", excerpt: "x", locators: "page" }).field, "locators");
  assert.equal(check({ source: "slings-2003", excerpt: "x", locators: Array(9).fill("page: 1").join("\n") }).field, "locators");
  assert.equal(validateNoteDraft(noteDraft()).field, "text");
  assert.equal(validateNoteDraft({ ...noteDraft(), text: "ok", concepts: "Bad Concept!" }).field, "concepts");
  assert.equal(validateNoteDraft({ ...noteDraft(), text: "ok", concepts: "fine, ok-too" }), null);
  assert.equal(notebookDiagnosticControl("excerpt.text"), "excerpt");
  assert.equal(notebookDiagnosticControl("excerpt.language"), "language");
  assert.equal(notebookDiagnosticControl("locators[1].value"), "locators");
  assert.equal(notebookDiagnosticControl("source"), "source");
  assert.equal(notebookDiagnosticControl("unheard"), "");
  assert.equal(notebookErrorMessage({ data: { diagnostics: [{ field: "source", message: "unknown" }] } }), "source: unknown");
});

test("identifiers are fresh, archived sources are not offered, and previews never split a character", () => {
  assert.equal(suggestEntryId("passage", []), "passage-1");
  assert.equal(suggestEntryId("note", ["passage-1", "note-2"]), "note-3");
  assert.equal(suggestEntryId("note", ["note-3", "a", "b"]), "note-4");
  const offered = captureSources(SOURCES()).map((source) => source.id);
  assert.equal(offered.length, 2);
  assert.ok(!offered.includes("old"));
  assert.equal(entryPreview({ excerpt: { text: "🙂".repeat(200) } }, 10), `${"🙂".repeat(9)}…`);
  assert.equal(entryPreview({ text: "a\n\n  b" }), "a b");
});

// ---------------------------------------------------------------- the capture form

test("saving requires a valid source and never calls the API otherwise", withDom(async () => {
  const api = notebookApi({});
  const state = formState();
  const form = createCaptureForm({ api, state });
  await type(byId(form.element, "oba-capture-excerpt"), "Some quote");
  await submit(form.element);
  assert.equal(api.calls.length, 0);
  const error = byId(form.element, "oba-capture-error");
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /Choose the source/);
  assert.equal(globalThis.document.activeElement, byId(form.element, "oba-capture-source"), "focus moves to the control that needs attention");
  assert.equal(byId(form.element, "oba-capture-source").getAttribute("aria-invalid"), "true");

  const noSources = createCaptureForm({ api, state: formState({ sources: [{ id: "old", kind: "work", title: "Old", archived: true }] }) });
  assert.ok(buttonLabelled(noSources.element, "Save to notebook").disabled, "nothing to quote without a source");
  assert.match(noSources.element.textContent, /Add a source to the library first/);
}));

test("capturing a passage with a note names the revision, sends the text verbatim, and links the note", withDom(async () => {
  const state = formState();
  const api = notebookApi({
    "POST research/passages": (body) => ({ revision: "r2", sources: SOURCES(), passages: [body.passage], notes: [], passage: body.passage }),
    "POST research/notes": (body) => ({ revision: "r3", sources: SOURCES(), passages: state.passages, notes: [body.note], note: body.note }),
  });
  let saved = null;
  const form = createCaptureForm({ api, state, prefill: { excerpt: HOSTILE }, onSaved: (result) => { saved = result; } });
  assert.equal(byId(form.element, "oba-capture-excerpt").value, HOSTILE, "the draft selection is prefilled");
  await type(byId(form.element, "oba-capture-source"), "slings-2003", "change");
  await type(byId(form.element, "oba-capture-locators"), "page: 514\ncanonical: 514a to 520a");
  await type(byId(form.element, "oba-capture-follow-text"), "Why does he go back down?");
  await type(byId(form.element, "oba-capture-follow-kind"), "question", "change");
  await submit(form.element);
  assert.deepEqual(api.calls.map((call) => [call.method, call.path, call.body.revision]), [["POST", "research/passages", "r1"], ["POST", "research/notes", "r2"]]);
  assert.equal(api.calls[0].body.passage.excerpt.text, HOSTILE);
  assert.equal(api.calls[0].body.passage.id, "passage-1");
  assert.deepEqual(api.calls[0].body.passage.locators, [{ kind: "page", value: "514" }, { kind: "canonical", value: "514a", to: "520a" }]);
  assert.deepEqual(api.calls[1].body.note, { id: "note-2", kind: "question", text: "Why does he go back down?", passages: ["passage-1"] });
  assert.equal(state.revision, "r3");
  assert.equal(saved.type, "passage");
  assert.equal(saved.note.id, "note-2");
}));

test("a passage saved without its follow-up note carries on as a note about that passage", withDom(async () => {
  const state = formState();
  const api = notebookApi({
    "POST research/passages": (body) => ({ revision: "r2", sources: SOURCES(), passages: [body.passage], notes: [], passage: body.passage }),
    "POST research/notes": () => {
      throw new ApiError("bad", 422, { diagnostics: [{ field: "text", message: "is not allowed" }] });
    },
  });
  const events = [];
  const form = createCaptureForm({ api, state, onSaved: (result) => events.push(result) });
  await type(byId(form.element, "oba-capture-source"), "slings-2003", "change");
  await type(byId(form.element, "oba-capture-excerpt"), "quoted");
  await type(byId(form.element, "oba-capture-follow-text"), "my words");
  await submit(form.element);
  assert.equal(events.length, 1);
  assert.equal(events[0].partial, true);
  assert.match(byId(form.element, "oba-capture-error").textContent, /The passage was saved, but the note was not/);
  assert.equal(byId(form.element, "oba-capture-text").value, "my words", "the note draft is kept");
  assert.equal(globalThis.document.activeElement, byId(form.element, "oba-capture-text"));
  assert.equal(state.passages.length, 1);
  assert.equal(api.calls.filter((call) => call.path === "research/passages").length, 1, "retrying the note never quotes the passage twice");
}));

test("a server rejection is scoped to its field, keeps the draft, and says nothing was stored", withDom(async () => {
  const api = notebookApi({
    "POST research/passages": () => {
      throw new ApiError("bad", 422, { diagnostics: [{ field: "locators[0].kind", message: "pages differ between editions" }] });
    },
  });
  const form = createCaptureForm({ api, state: formState() });
  await type(byId(form.element, "oba-capture-source"), "plato-republic", "change");
  await type(byId(form.element, "oba-capture-excerpt"), "keep me");
  await type(byId(form.element, "oba-capture-locators"), "page: 1");
  await submit(form.element);
  assert.match(byId(form.element, "oba-capture-error").textContent, /locators\[0\]\.kind: pages differ/);
  assert.equal(globalThis.document.activeElement, byId(form.element, "oba-capture-locators"));
  assert.equal(byId(form.element, "oba-capture-excerpt").value, "keep me");
  assert.match(form.element.textContent, /The stored notebook is unchanged/);
  assert.ok(!buttonLabelled(form.element, "Save to notebook").disabled, "the author can fix it and save again");
}));

test("a stale revision keeps the draft, reloads the notebook, and saves again only on request", withDom(async () => {
  const state = formState();
  let attempts = 0;
  const api = notebookApi({
    "POST research/notes": (body) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError("changed", 409, { conflict: true, revision: "r9" });
      return { revision: "r10", sources: SOURCES(), passages: [], notes: [body.note], note: body.note };
    },
    "GET research/notebook": () => notebook({ revision: "r9", passages: [], notes: [{ id: "note-1", kind: "observation", text: "elsewhere" }] }),
  });
  let saved = null;
  const form = createCaptureForm({ api, state, prefill: { type: "note" }, onSaved: (result) => { saved = result; } });
  await type(byId(form.element, "oba-capture-text"), "my note");
  await submit(form.element);
  assert.equal(saved, null);
  assert.ok(form.element.querySelector("[data-capture-conflict]"));
  assert.equal(state.revision, "r9");
  assert.equal(byId(form.element, "oba-capture-text").value, "my note");
  assert.equal(globalThis.document.activeElement.dataset.captureSave, "true");
  assert.equal(api.calls.length, 1, "nothing is resubmitted automatically");
  await submit(form.element);
  assert.equal(api.calls[1].body.revision, "r9");
  assert.equal(api.calls[1].body.note.id, "note-2", "ids are chosen against the latest notebook");
  assert.equal(saved.note.id, "note-2");
}));

test("cancelling is a plain button that changes nothing", withDom(async () => {
  const api = notebookApi({});
  let cancelled = 0;
  const form = createCaptureForm({ api, state: formState(), onCancel: () => { cancelled += 1; } });
  const cancel = buttonLabelled(form.element, "Cancel");
  assert.equal(cancel.getAttribute("type"), "button");
  await type(byId(form.element, "oba-capture-excerpt"), "draft");
  await form.element.dispatch("input"); // the browser bubbles the control's event to the form
  assert.equal(form.isDirty(), true);
  await cancel.click();
  assert.equal(cancelled, 1);
  assert.equal(api.calls.length, 0);
}));

test("every control is labelled, grouped, and quoted text only ever reaches the page as text", withDom(async () => {
  const form = createCaptureForm({ api: notebookApi({}), state: formState({ passages: [PASSAGE()], notes: [NOTE()] }), prefill: { type: "note" } });
  for (const control of form.element.querySelectorAll("textarea").concat(form.element.querySelectorAll("select"))) {
    assert.ok(form.element.querySelectorAll("label").some((label) => label.getAttribute("for") === control.id), `${control.id} has a label`);
  }
  assert.ok(form.element.querySelectorAll("legend").length >= 3, "radios and checkbox lists are grouped under legends");
  assert.ok(form.element.textContent.includes("Passages this note is about"));
  assert.equal(form.element.querySelectorAll("img").length + form.element.querySelectorAll("script").length, 0);
}));

// ---------------------------------------------------------------- the view

function mountResearch(api) {
  const app = new ObAdmin();
  const root = new DomNode("div", globalThis.document);
  app.api = api;
  app.meta = { siteTitle: "Blog" };
  app.preferences = normalizeAdminPreferences({ preset: "advanced" });
  app.replaceChildren = (...nodes) => root.replaceChildren(...nodes);
  return { app, root };
}

test("the notebook lists passages and notes as text, searches them, and opens an entry for editing", withDom(async () => {
  const { app, root } = mountResearch(notebookApi({
    "GET research/notebook": () => notebook(),
    "POST research/search {\"q\":\"cave\"}": () => ({ total: 1, truncated: false, broken: [], hits: [{ id: "note-2", entry: "note", kind: "question", state: "open", snippet: "Why a cave?", matched: ["text"], sources: [], passages: [], notes: [] }] }),
  }));
  await app.showResearch();
  assert.deepEqual(entryButtons(root).map((item) => item.dataset.entryId), ["passage-1", "note-2"]);
  assert.equal(root.querySelectorAll("img").length + root.querySelectorAll("script").length, 0, "hostile excerpts render as text");
  assert.ok(root.textContent.includes("<img src=x"), "the characters are shown, not interpreted");
  await type(byId(root, "oba-research-search"), "cave");
  await settledSearch();
  assert.deepEqual(entryButtons(root).map((item) => item.dataset.entryId), ["note-2"]);
  await type(byId(root, "oba-research-search"), "");
  await settledSearch();
  assert.deepEqual(entryButtons(root).map((item) => item.dataset.entryId), ["passage-1", "note-2"]);
  await entryButton(root, "passage-1").click();
  assert.equal(globalThis.document.activeElement.id, "oba-research-heading");
  assert.equal(byId(root, "oba-research-excerpt").value, HOSTILE);
  assert.equal(byId(root, "oba-research-source").value, "slings-2003");
  assert.match(root.textContent, /1 note links to this passage, so it cannot be removed/);
}));

test("editing a passage sends the full record on the notebook revision and updates the list", withDom(async () => {
  const api = notebookApi({
    "GET research/notebook": () => notebook(),
    "PUT research/passages": (body) => ({ revision: "r2", sources: SOURCES(), passages: [body.passage], notes: [NOTE()], passage: body.passage }),
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  await entryButton(root, "passage-1").click();
  await type(byId(root, "oba-research-excerpt"), "Edited quote");
  await submit(root);
  assert.deepEqual(api.calls.map((call) => [call.method, call.path, call.body.revision]), [["PUT", "research/passages", "r1"]]);
  assert.equal(api.calls[0].body.passage.extra, 1, "unknown fields survive the edit");
  assert.equal(api.calls[0].body.passage.excerpt.scan, "p1.png");
  assert.match(root.textContent, /Saved to the private notebook/);
  assert.ok(root.textContent.includes("Edited quote"));
}));

test("removing asks first, names the revision, and a refused removal says why", withDom(async () => {
  let refuse = true;
  const api = notebookApi({
    "GET research/notebook": () => notebook(),
    "DELETE research/passages": () => {
      if (refuse) throw new ApiError("linked", 422, { diagnostics: [{ field: "passages", message: "this note still links to the passage" }] });
      return { revision: "r2", sources: SOURCES(), passages: [], notes: [NOTE()] };
    },
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  await entryButton(root, "passage-1").click();
  globalThis.confirm = () => false;
  await removeButton(root).click();
  assert.equal(api.calls.length, 0, "declining the confirmation changes nothing");
  globalThis.confirm = () => true;
  await removeButton(root).click();
  assert.deepEqual(api.calls[0], { method: "DELETE", path: "research/passages", body: { revision: "r1", id: "passage-1" } });
  assert.match(root.textContent, /still links to the passage/);
  assert.match(root.textContent, /The stored notebook is unchanged/);
  refuse = false;
  await removeButton(root).click();
  assert.equal(entryButton(root, "passage-1"), undefined);
  delete globalThis.confirm;
}));

test("a damaged notebook is reported with its path and offers no way to overwrite it", withDom(async () => {
  const api = notebookApi({
    "GET research/notebook": () => {
      throw new ApiError("bad", 422, { error: "invalid JSON", file: ".openblog/private/research/notebook.json", diagnostics: [{ message: "invalid JSON: eof" }] });
    },
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  assert.match(root.textContent, /The research notebook could not be read/);
  assert.match(root.textContent, /Repair \.openblog\/private\/research\/notebook\.json by hand/);
  assert.equal(root.querySelectorAll("form").length, 0);
}));

// ---------------------------------------------------------------- wiring and accessibility

test("the notebook is reachable from the research tools, the palette, the router, and the editor", () => {
  assert.equal(researchHref("notebook"), "#/research/notebook");
  assert.equal(canonicalAdminHash("#/research"), "#/research/notebook", "the notebook's earlier address still opens it");
  assert.match(admin, /panel === "notebook"\) await this\.showResearch\(\)/);
  assert.match(admin, /label: "Research notebook", category: "Research"/);
  assert.match(admin, /"data-research-capture": "true", onClick: \(\) => this\.openResearchCapture\(\)/);
});

test("capture code never parses text as markup and the dialog hands focus back to the draft", () => {
  const start = admin.indexOf("// ---------------------------------------------------------------- research notebook capture");
  const end = admin.indexOf("export const SHARED_SOURCE_KINDS");
  const capture = admin.slice(start, end);
  const view = admin.slice(admin.indexOf("// ---- research notebook"), admin.indexOf("// ---- shared reflections"));
  const dialog = admin.slice(admin.indexOf("async openResearchCapture()"), admin.indexOf("  openKnowledgeCheck() {"));
  for (const code of [capture, view, dialog]) assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|createContextualFragment/);
  assert.match(dialog, /showModal\(\)/);
  assert.match(dialog, /addEventListener\("cancel"[\s\S]*returnToDraft\(\)/, "Escape cancels and returns to the draft");
  assert.match(dialog, /const returnToDraft = \(\) => \{[\s\S]*surface\.focus\(\)[\s\S]*setSelectionRange[\s\S]*restoreVisualSelection/);
  assert.match(dialog, /onCancel: returnToDraft/);
  assert.match(dialog, /if \(!result\.partial\) returnToDraft\(\)/);
  assert.doesNotMatch(dialog, /this\.markDirty|this\.ui\.body\.value =/, "capturing never edits the draft");
  assert.match(capture, /role: "alert"/);
  assert.match(capture, /"aria-live": "polite"/);
  assert.match(capture, /aria-invalid/);
  assert.match(capture, /h\("legend"/);
});

test("capture styles keep focus visible, targets large, and add no motion", () => {
  const css = styles.slice(styles.indexOf("/* Research notebook capture */"), styles.indexOf("/* Anchors styled as buttons"));
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.doesNotMatch(css, /transition|animation/);
  assert.match(css, /max-width: 100%/);
});

// ---------------------------------------------------------------- review follow-ups

const conflictApi = (current, over = {}) =>
  notebookApi({
    "GET research/notebook": () => notebook({ revision: "r9" }),
    "PUT research/passages": (body) => {
      if (body.revision !== "r9") throw new ApiError("changed", 409, { conflict: true, revision: "r9", current });
      return { revision: "r10", sources: SOURCES(), passages: [body.passage], notes: [], passage: body.passage };
    },
    ...over,
  });

test("an edit conflict blocks saving until the author picks a copy, then rests the draft on the stored one", withDom(async () => {
  const newer = { ...PASSAGE(), excerpt: { text: "newer words", scan: "p2.png" }, extra: 2, fresh: "from elsewhere" };
  const api = conflictApi(newer);
  const form = createCaptureForm({ api, state: formState({ passages: [PASSAGE()] }), entry: PASSAGE(), entryType: "passage" });
  await type(byId(form.element, "oba-capture-excerpt"), "my words");
  await submit(form.element);
  assert.equal(api.calls.length, 1);
  assert.ok(buttonLabelled(form.element, "Use the stored copy") && buttonLabelled(form.element, "Keep my draft"));
  assert.equal(buttonLabelled(form.element, "Save changes").disabled, true);
  await submit(form.element);
  assert.equal(api.calls.length, 1, "nothing is resubmitted before a choice");
  assert.match(byId(form.element, "oba-capture-error").textContent, /Choose the stored copy or keep your draft/);
  await buttonLabelled(form.element, "Keep my draft").click();
  assert.equal(byId(form.element, "oba-capture-excerpt").value, "my words");
  await submit(form.element);
  assert.equal(api.calls[1].body.revision, "r9");
  assert.equal(api.calls[1].body.passage.fresh, "from elsewhere", "fields added elsewhere are not dropped");
  assert.equal(api.calls[1].body.passage.extra, 2);
  assert.equal(api.calls[1].body.passage.excerpt.scan, "p2.png");
  assert.equal(api.calls[1].body.passage.excerpt.text, "my words");
}));

test("choosing the stored copy replaces the draft with it; a removed entry can only be discarded", withDom(async () => {
  const newer = { ...PASSAGE(), excerpt: { text: "newer words" } };
  const form = createCaptureForm({ api: conflictApi(newer), state: formState({ passages: [PASSAGE()] }), entry: PASSAGE(), entryType: "passage" });
  await type(byId(form.element, "oba-capture-excerpt"), "my words");
  await submit(form.element);
  await buttonLabelled(form.element, "Use the stored copy").click();
  assert.equal(byId(form.element, "oba-capture-excerpt").value, "newer words");
  assert.ok(!buttonLabelled(form.element, "Save changes").disabled);

  let cancelled = 0;
  const gone = createCaptureForm({ api: conflictApi(null), state: formState({ passages: [PASSAGE()] }), entry: PASSAGE(), entryType: "passage", onCancel: () => { cancelled += 1; } });
  await type(byId(gone.element, "oba-capture-excerpt"), "my words");
  await submit(gone.element);
  assert.match(gone.element.textContent, /was removed from the notebook/);
  assert.equal(buttonLabelled(gone.element, "Keep my draft"), undefined);
  assert.equal(buttonLabelled(gone.element, "Save changes").disabled, true);
  await buttonLabelled(gone.element, "Discard my draft").click();
  assert.equal(cancelled, 1);
}));

test("a conflict in the notebook view refreshes the lists and a kept draft saves on the new copy", withDom(async () => {
  const latest = notebook({ revision: "r9", passages: [PASSAGE()], notes: [NOTE(), { id: "note-3", kind: "observation", text: "added elsewhere" }] });
  let reads = 0;
  const api = conflictApi({ ...PASSAGE(), extra: 5 });
  const inner = api.call.bind(api);
  api.call = async (method, path, options) => {
    if (path === "research/backlinks") return { entries: [] };
    return method === "GET" ? (reads++ ? latest : notebook()) : inner(method, path, options);
  };
  const { app, root } = mountResearch(api);
  await app.showResearch();
  await entryButton(root, "passage-1").click();
  await submit(root);
  assert.ok(entryButton(root, "note-3"), "the list shows the notebook as it is now");
  await buttonLabelled(root, "Keep my draft").click();
  await submit(root);
  assert.equal(api.calls.at(-1).body.passage.extra, 5);
  assert.match(root.textContent, /Saved to the private notebook/);
}));

test("archived sources are offered only for new choices; an edited entry keeps its own, labelled", withDom(async () => {
  const archivedPassage = { ...PASSAGE(), source: "old" };
  const editing = createCaptureForm({ api: notebookApi({}), state: formState({ passages: [archivedPassage] }), entry: archivedPassage, entryType: "passage" });
  const select = byId(editing.element, "oba-capture-source");
  assert.equal(select.children.find((option) => option.selected)?.value, "old");
  assert.ok(select.children.some((option) => option.textContent.includes("(archived)")));
  const fresh = createCaptureForm({ api: notebookApi({}), state: formState(), prefill: { type: "passage" } });
  assert.ok(!byId(fresh.element, "oba-capture-source").children.some((option) => option.value === "old"));
  const note = { ...NOTE(), sources: ["old"] };
  const noteForm = createCaptureForm({ api: notebookApi({}), state: formState({ notes: [note] }), entry: note, entryType: "note" });
  assert.ok(byId(noteForm.element, "oba-capture-sources-old"), "the archived source is still checkable");
  assert.ok(noteForm.element.textContent.includes("(archived)"));
  const freshNote = createCaptureForm({ api: notebookApi({}), state: formState(), prefill: { type: "note" } });
  assert.equal(byId(freshNote.element, "oba-capture-sources-old"), null);
}));

test("a client-side error is not left behind on the next submit and never replaces a hint", withDom(async () => {
  const form = createCaptureForm({ api: notebookApi({ "POST research/passages": (b) => ({ revision: "r2", sources: SOURCES(), passages: [b.passage], notes: [], passage: b.passage }) }), state: formState() });
  await submit(form.element);
  const source = byId(form.element, "oba-capture-source");
  assert.equal(source.getAttribute("aria-invalid"), "true");
  assert.equal(source.getAttribute("aria-describedby"), "oba-capture-source-hint oba-capture-error");
  await type(source, "plato-republic", "change");
  await submit(form.element);
  assert.equal(source.getAttribute("aria-invalid"), null, "the stale mark is cleared");
  assert.equal(source.getAttribute("aria-describedby"), "oba-capture-source-hint");
  const excerpt = byId(form.element, "oba-capture-excerpt");
  assert.equal(excerpt.getAttribute("aria-invalid"), "true");
  assert.equal(form.element.querySelectorAll("[aria-invalid]").length, 1);
}));

// The editor's capture dialog hands focus and selection back however it closes.
async function withEditor(run) {
  const dom = installDom();
  const previousElement = globalThis.HTMLElement;
  globalThis.HTMLElement = DomNode;
  try {
    const body = Object.assign(new DomNode("textarea", dom.document), { value: "Before quote after", selectionStart: 7, selectionEnd: 12 });
    const ranges = [];
    body.setSelectionRange = (start, end) => {
      ranges.push([start, end]);
      body.selectionStart = start;
      body.selectionEnd = end;
    };
    const trigger = new DomNode("button", dom.document);
    const api = notebookApi({
      "GET research/notebook": () => notebook({ passages: [], notes: [] }),
      "POST research/passages": (b) => ({ revision: "r2", sources: SOURCES(), passages: [b.passage], notes: [], passage: b.passage }),
      "POST research/notes": () => {
        throw new ApiError("bad", 422, { diagnostics: [{ field: "text", message: "rejected" }] });
      },
    });
    const editor = new Editor({ meta: {}, api }, { kind: "posts", fields: {}, body: body.value });
    editor.ui = { body };
    editor.editorMode = "markdown";
    const open = async () => {
      trigger.focus();
      await editor.openResearchCapture();
      return dom.document.body.querySelectorAll("dialog")[0];
    };
    await run({ dom, editor, body, open, ranges, api });
  } finally {
    if (previousElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousElement;
    dom.restore();
  }
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the capture dialog quotes the selection and Escape returns to the draft with the selection restored", () => withEditor(async ({ dom, editor, body, open, ranges }) => {
  const dialog = await open();
  assert.equal(dialog.open, true);
  assert.equal(byId(dialog, "oba-capture-excerpt").value, "quote");
  await dialog.dispatch("cancel");
  assert.equal(dialog.open, false);
  assert.equal(dom.document.body.querySelectorAll("dialog").length, 0, "the dialog is removed");
  assert.equal(dom.document.activeElement, body);
  assert.deepEqual(ranges.at(-1), [7, 12]);
  assert.equal(body.value, "Before quote after", "the draft is unchanged");
  assert.equal(editor.writingSurface(), body);
}));

test("the Cancel button returns to the draft and saves nothing", () => withEditor(async ({ dom, body, open, ranges, api }) => {
  const dialog = await open();
  await buttonLabelled(dialog, "Cancel").click();
  assert.equal(dialog.open, false);
  assert.equal(dom.document.activeElement, body);
  assert.deepEqual(ranges.at(-1), [7, 12]);
  assert.equal(api.calls.length, 0);
}));

test("a successful save closes the dialog, returns focus, and leaves the draft alone", () => withEditor(async ({ dom, body, open, ranges, api }) => {
  const dialog = await open();
  await type(byId(dialog, "oba-capture-source"), "plato-republic", "change");
  await submit(dialog);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].body.passage.excerpt.text, "quote");
  assert.equal(dialog.open, false);
  assert.equal(dom.document.body.querySelectorAll("dialog").length, 0);
  assert.equal(dom.document.activeElement, body);
  assert.deepEqual(ranges.at(-1), [7, 12]);
  assert.equal(body.value, "Before quote after");
}));

test("a partial save keeps the dialog open, with focus inside it and the selection untouched", () => withEditor(async ({ dom, body, open, ranges, api }) => {
  const dialog = await open();
  await type(byId(dialog, "oba-capture-source"), "plato-republic", "change");
  await type(byId(dialog, "oba-capture-follow-text"), "my note");
  await submit(dialog);
  await settled();
  assert.deepEqual(api.calls.map((call) => call.path), ["research/passages", "research/notes"]);
  assert.equal(dialog.open, true, "the dialog stays open so the note can be retried");
  assert.ok(dialog.isConnected);
  assert.match(dialog.textContent, /The passage was saved, but the note was not/);
  assert.notEqual(dom.document.activeElement, body);
  assert.ok(dialog.contains(dom.document.activeElement), "focus stays inside the dialog");
  assert.equal(ranges.length, 0, "the selection is only restored when the dialog closes");
}));

// ---------------------------------------------------------------- search, backlinks and question state

const HIT = (over = {}) => ({
  id: "passage-1",
  entry: "passage",
  score: 3,
  snippet: HOSTILE,
  matched: ["excerpt"],
  sources: [{ id: "old", label: "Old", archived: true, missing: false }],
  locators: ["page: 514"],
  concepts: [],
  passages: [],
  notes: [{ id: "note-2", entry: "note", kind: "question", state: "open", preview: "Why a cave?" }],
  ...over,
});
const searchResult = (hits, over = {}) => ({ revision: "r1", total: hits.length, truncated: false, counts: {}, broken: [], hits, ...over });
const filterControl = (root, name) => root.querySelectorAll("select").find((node) => node.dataset.researchFilter === name);
const change = async (control, value) => {
  control.value = value;
  await control.dispatch("change", { target: control });
  await tick();
};

test("search bodies carry only the filters that are set, and never go in a URL", () => {
  assert.deepEqual(notebookSearchBody({}), {});
  assert.deepEqual(notebookSearchBody({ query: " the cave ", source: "slings-2003", locator: "page", concept: "allegory", state: "open" }), { q: "the cave", source: "slings-2003", locator: "page", concept: "allegory", state: "open" });
  assert.deepEqual(notebookSearchBody({ query: "a&b=c#" }), { q: "a&b=c#" });
  assert.equal(searchIsActive({ query: "  " }), false);
  assert.equal(searchIsActive({ state: "resolved" }), true);
  assert.equal(hitContext(HIT()), "Old (archived) · page: 514");
  assert.equal(hitContext({ entry: "note", kind: "question", state: "resolved", sources: [] }), "resolved question");
});

test("filters call the server search, show context as text, and clearing them restores the lists", withDom(async () => {
  const api = notebookApi({
    "GET research/notebook": () => notebook(),
    "POST research/search {\"source\":\"old\",\"locator\":\"page\",\"state\":\"open\"}": () => searchResult([HIT()]),
    "POST research/search {\"source\":\"old\",\"locator\":\"page\",\"state\":\"resolved\"}": () => searchResult([]),
    "POST research/search {\"source\":\"old\",\"locator\":\"page\"}": () => searchResult([HIT()]),
    "POST research/search {\"source\":\"old\"}": () => searchResult([HIT()], { broken: [{ from: "note-9", entry: "note", field: "passages[0]", target: "gone" }] }),
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  for (const name of ["source", "locator", "state"]) assert.ok(filterControl(root, name), `${name} filter exists`);
  assert.ok(root.querySelectorAll("label").some((label) => label.getAttribute("for") === "oba-research-concept-filter"), "the concept filter is labelled");
  const archivedOption = filterControl(root, "source").children.find((option) => option.value === "old");
  assert.ok(archivedOption.textContent.includes("(archived)"));
  await change(filterControl(root, "source"), "old");
  assert.match(root.textContent, /1 match\./);
  assert.match(root.textContent, /link in the notebook point to missing entries|links? in the notebook point to missing/);
  assert.equal(root.querySelectorAll("img").length + root.querySelectorAll("script").length, 0, "hostile snippets render as text");
  assert.ok(root.textContent.includes("<img src=x"));
  assert.ok(root.textContent.includes("Old (archived) · page: 514"));
  assert.ok(root.textContent.includes("1 linked note"));
  await change(filterControl(root, "locator"), "page");
  await change(filterControl(root, "state"), "open");
  assert.equal(entryButtons(root).length, 1);
  await change(filterControl(root, "state"), "resolved");
  assert.match(root.textContent, /No entries match these filters/);
  assert.match(root.textContent, /0 matches\./);
  assert.equal(api.calls.length, 0, "searching never writes");
  await change(filterControl(root, "source"), "");
  await change(filterControl(root, "locator"), "");
  await change(filterControl(root, "state"), "");
  assert.deepEqual(entryButtons(root).map((item) => item.dataset.entryId), ["passage-1", "note-2"]);
}));

test("a refused search says why in the page and changes nothing", withDom(async () => {
  const api = notebookApi({
    "GET research/notebook": () => notebook(),
    "POST research/search {\"concept\":\"bad word\"}": () => {
      throw new ApiError("bad", 422, { diagnostics: [{ field: "concept", message: "a concept is lowercase words" }] });
    },
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  const concept = byId(root, "oba-research-concept-filter");
  concept.value = "Bad Word";
  await concept.dispatch("input", { target: concept });
  await settledSearch();
  assert.match(root.textContent, /concept: a concept is lowercase words/);
  assert.match(root.textContent, /The notebook is unchanged/);
  assert.equal(api.calls.length, 0);
}));

test("the panel lists backlinks for a passage, its source and a note's concepts, and opens them", withDom(async () => {
  const api = notebookApi({
    "GET research/notebook": () => notebook(),
    "POST research/backlinks {\"type\":\"passage\",\"id\":\"passage-1\"}": () => ({ entries: [{ id: "note-2", entry: "note", kind: "question", state: "open", preview: "Why a cave?", relation: "notes" }] }),
    "POST research/backlinks {\"type\":\"source\",\"id\":\"slings-2003\"}": () => ({ entries: [{ id: "passage-1", entry: "passage", preview: "self", relation: "quotes" }, { id: "other", entry: "passage", preview: "another quote", relation: "quotes", through: "slings-2003" }] }),
    "POST research/backlinks {\"type\":\"concept\",\"id\":\"allegory\"}": () => ({ entries: [{ id: "note-2", entry: "note", kind: "question", state: "resolved", preview: "me", relation: "notes" }, { id: "note-7", entry: "note", kind: "observation", preview: "Also allegory", relation: "notes" }] }),
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  await entryButton(root, "passage-1").click();
  await tick();
  await tick();
  const listed = root.querySelectorAll("button").filter((button) => button.dataset.backlinkId).map((button) => button.dataset.backlinkId);
  assert.deepEqual(listed, ["note-2", "other"], "the entry itself is not listed as its own backlink");
  assert.match(root.textContent, /Notes about this passage/);
  assert.match(root.textContent, /Other research on/);
  await entryButton(root, "note-2").click();
  await tick();
  await tick();
  assert.deepEqual(root.querySelectorAll("button").filter((button) => button.dataset.backlinkId).map((button) => button.dataset.backlinkId), ["note-7"]);
  assert.match(root.textContent, /Notes tagged allegory/);
}));

test("a question can be marked resolved, an unset state stays unwritten, and an observation never carries one", () => {
  const question = { id: "q", kind: "question", text: "Why?" };
  assert.equal(noteDraft(question).status, "open");
  assert.ok(!("status" in noteDraftPayload(noteDraft(question))), "an untouched question stays as stored");
  const resolved = noteDraft(question);
  resolved.status = "resolved";
  assert.equal(noteDraftPayload(resolved).status, "resolved");
  const reopened = noteDraft({ ...question, status: "resolved" });
  reopened.status = "open";
  assert.equal(noteDraftPayload(reopened).status, "open", "a state the author wrote is kept when reopened");
  const observation = noteDraft({ ...question, status: "resolved" });
  observation.kind = "observation";
  assert.ok(!("status" in noteDraftPayload(observation)));
});

test("the capture form offers the question state only for questions and sends it", withDom(async () => {
  const api = notebookApi({
    "POST research/notes": (body) => ({ revision: "r2", sources: SOURCES(), passages: [], notes: [body.note], note: body.note }),
  });
  const form = createCaptureForm({ api, state: formState(), prefill: { type: "note" } });
  assert.equal(byId(form.element, "oba-capture-status"), null, "an observation has no state");
  await type(byId(form.element, "oba-capture-kind"), "question", "change");
  const status = byId(form.element, "oba-capture-status");
  assert.ok(status && form.element.querySelectorAll("label").some((label) => label.getAttribute("for") === status.id));
  await type(byId(form.element, "oba-capture-text"), "Is it settled?");
  await type(status, "resolved", "change");
  await submit(form.element);
  assert.equal(api.calls[0].body.note.status, "resolved");
  assert.equal(api.calls[0].body.note.kind, "question");
}));

test("opening a hit the view has not seen refreshes the notebook and retries; if it is still missing the author is told and the list stays", withDom(async () => {
  let reads = 0;
  const newer = { id: "note-9", kind: "observation", text: "added elsewhere", visibility: "private" };
  const api = notebookApi({
    "GET research/notebook": () => (reads++ ? notebook({ revision: "r2", notes: [NOTE(), newer] }) : notebook()),
    "POST research/search": () => searchResult([HIT({ id: "note-9", entry: "note", kind: "observation", snippet: "added elsewhere", sources: [] }), HIT({ id: "ghost-1", entry: "note", kind: "observation", snippet: "nowhere", sources: [] })]),
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  await type(byId(root, "oba-research-search"), "else");
  await settledSearch();
  await entryButton(root, "note-9").click();
  await tick();
  assert.ok(byId(root, "oba-capture-text") || root.textContent.includes("Observation"), "the refreshed entry opened for editing");
  await entryButton(root, "ghost-1").click();
  await tick();
  assert.match(root.textContent, /no longer in the notebook/);
  assert.ok(entryButton(root, "ghost-1"), "the list is left as it was");
  assert.equal(api.calls.length, 0);
}));

test("a refresh for a missing hit does not hand the open form a newer revision, so its save still conflicts", withDom(async () => {
  let reads = 0;
  const elsewhere = { ...PASSAGE(), excerpt: { text: "edited elsewhere" } };
  const api = notebookApi({
    "GET research/notebook": () => (reads++ ? notebook({ revision: "r2", passages: [elsewhere] }) : notebook()),
    "POST research/search": () => searchResult([HIT({ id: "ghost-1", entry: "note", kind: "observation", snippet: "nowhere", sources: [] })]),
    "PUT research/passages": (body) => {
      if (body.revision !== "r2") throw new ApiError("changed", 409, { conflict: true, revision: "r2", current: elsewhere });
      return { revision: "r3", sources: SOURCES(), passages: [body.passage], notes: [], passage: body.passage };
    },
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  await entryButton(root, "passage-1").click();
  assert.ok(byId(root, "oba-research-excerpt"), "the stale copy is open");
  await type(byId(root, "oba-research-search"), "nowhere");
  await settledSearch();
  await entryButton(root, "ghost-1").click();
  await tick();
  assert.match(root.textContent, /no longer in the notebook/);
  assert.equal(reads, 2, "the notebook was refreshed");
  await type(byId(root, "oba-research-excerpt"), "my edit");
  await submit(root);
  await tick();
  assert.deepEqual(api.calls.map((call) => [call.method, call.body.revision]), [["PUT", "r1"]], "the save used the revision the form was built from");
  assert.ok(buttonLabelled(root, "Use the stored copy"), "the conflict flow is offered");
}));

test("the capture form can still save a passage when every source is archived", withDom(async () => {
  const archived = SOURCES().map((source) => ({ ...source, archived: true }));
  const passage = { ...PASSAGE(), source: archived[0].id };
  const form = createCaptureForm({ api: notebookApi({}), state: formState({ sources: archived, passages: [passage] }), entry: passage, entryType: "passage" });
  assert.ok(!form.element.textContent.includes("Add a source to the library first"));
  assert.ok(!buttonLabelled(form.element, "Save changes").disabled);
}));

test("the notebook archives and restores an entry and hides archived entries until asked", withDom(async () => {
  let current = notebook({ passages: [PASSAGE()], notes: [NOTE()] });
  const api = notebookApi({
    "GET research/notebook": () => current,
    "POST research/archive": (body) => {
      assert.deepEqual(Object.keys(body).sort(), ["archived", "id", "revision", "type"]);
      current = notebook({ revision: body.archived ? "r2" : "r3", passages: [PASSAGE()], notes: [{ ...NOTE(), archived: body.archived || undefined }] });
      return current;
    },
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  await entryButton(root, "note-2").click();
  const archive = root.querySelectorAll("button").find((button) => button.dataset.entryArchive);
  assert.equal(archive.textContent, "Archive");
  await archive.click();
  await tick();
  assert.deepEqual(entryButtons(root).map((item) => item.dataset.entryId), ["passage-1"], "an archived entry leaves the default lists");
  assert.match(root.textContent, /Archived\. It stays in the notebook and in exports/);
  assert.match(root.textContent, /1 archived/);
  assert.match(root.textContent, /Restore from archive/);
  assert.equal(api.calls.at(-1).body.revision, "r1");

  const toggle = byId(root, "oba-research-archived");
  toggle.checked = true;
  await toggle.dispatch("change", { target: toggle });
  assert.deepEqual(entryButtons(root).map((item) => item.dataset.entryId), ["passage-1", "note-2"]);
  assert.ok(entryButton(root, "note-2").textContent.includes("archived"), entryButton(root, "note-2").textContent);

  const restore = root.querySelectorAll("button").find((button) => button.dataset.entryArchive);
  await restore.click();
  await tick();
  assert.equal(api.calls.at(-1).body.archived, false);
  assert.match(root.textContent, /Restored from the archive/);
  assert.equal(api.calls.at(-1).body.revision, "r2");
}));

test("the search body asks for archived entries only when shown, and import previews are text-free summaries", () => {
  assert.deepEqual(notebookSearchBody({ query: "x", archived: true }), { q: "x", includeArchived: true });
  assert.deepEqual(notebookSearchBody({ query: "x", archived: false }), { q: "x" });
  const plan = { counts: { create: 1, unchanged: 2, conflict: 1 }, entries: [
    { id: "a", collection: "notes", action: "create" },
    { id: "b", collection: "passages", action: "unchanged" },
    { id: "c", collection: "passages", action: "conflict", message: "a different passage in this notebook already uses this id" },
  ] };
  assert.equal(notebookImportSummary(plan), "1 to add, 2 already here, 1 in conflict");
  assert.deepEqual(notebookImportRows(plan).map((row) => [row.label, row.name]), [["Add", "note a"], ["Conflict", "passage c"]]);
});

test("export needs a confirmation and asks the server for the private bundle explicitly", withDom(async () => {
  const downloads = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, confirm: globalThis.confirm };
  URL.createObjectURL = (blob) => (downloads.push(blob), "blob:test");
  URL.revokeObjectURL = () => {};
  try {
    const api = notebookApi({
      "GET research/notebook": () => notebook(),
      "POST research/export": (body) => {
        assert.deepEqual(body, { includePrivate: true });
        return { filename: "open-blog-research-notebook.json", mediaType: "application/json", passages: 1, notes: 1, archived: 0, content: "{}\n" };
      },
    });
    const { app, root } = mountResearch(api);
    await app.showResearch();
    const button = root.querySelectorAll("button").find((item) => item.dataset.researchExport);
    globalThis.confirm = () => false;
    await button.click();
    await tick();
    assert.equal(downloads.length, 0, "declining the confirmation exports nothing");
    globalThis.confirm = (message) => (assert.match(message, /private passages and notes/), true);
    await button.click();
    await tick();
    assert.equal(downloads.length, 1);
    assert.match(root.textContent, /Exported 1 passage and 1 note as open-blog-research-notebook\.json/);
    assert.match(root.textContent, /keep it out of your public folders/);
  } finally {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
    if (original.confirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = original.confirm;
  }
}));

test("import reads a file, previews first, applies only what was previewed", withDom(async () => {
  const file = { format: "open.blog/research-notebook", version: 1, private: true, notebook: { version: 1, notes: [] } };
  // 2^53 + 1 would be rounded by JSON.parse, so the file text must reach the server untouched.
  const fileText = JSON.stringify(file).replace('"notes":[]', '"notes":[],"counter":9007199254740993');
  let applied = 0;
  const create = { counts: { create: 1, unchanged: 0, conflict: 0 }, entries: [{ id: "note-9", collection: "notes", action: "create" }] };
  const api = notebookApi({
    "GET research/notebook": () => notebook(),
    "POST research/import": (body) => {
      assert.equal(body.content, fileText, "the file text is sent exactly as read");
      if (!body.apply) return { revision: "r1", applied: false, applicable: true, plan: create };
      applied += 1;
      return { revision: "r5", applied: true, applicable: true, sources: SOURCES(), passages: [PASSAGE()], notes: [NOTE(), { id: "note-9", kind: "observation", text: "imported", visibility: "private" }], plan: create };
    },
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  const input = byId(root, "oba-research-import-file");
  const previewButton = root.querySelectorAll("button").find((item) => item.dataset.researchImportPreview);
  const applyButton = root.querySelectorAll("button").find((item) => item.dataset.researchImportApply);
  assert.equal(previewButton.disabled, true);
  assert.equal(applyButton.hidden, true);
  input.files = [{ name: "notes.json", text: async () => "not json" }];
  await input.dispatch("change", { target: input });
  assert.match(root.textContent, /not a research bundle/);
  assert.equal(previewButton.disabled, true);
  input.files = [{ name: "notes.json", text: async () => fileText }];
  await input.dispatch("change", { target: input });
  assert.match(root.textContent, /Loaded notes\.json\. Preview it before importing/);
  await applyButton.click();
  assert.equal(applied, 0, "nothing applies before a preview");
  await previewButton.click();
  await tick();
  assert.match(root.textContent, /Preview: 1 to add, 0 already here, 0 in conflict\. Nothing has been saved\./);
  assert.match(root.textContent, /Add: note note-9/);
  assert.equal(applyButton.hidden, false);
  await applyButton.click();
  await tick();
  assert.equal(applied, 1);
  assert.ok(entryButton(root, "note-9"), "the list shows the imported entry");
  assert.match(root.textContent, /Import saved/);
  assert.equal(applyButton.hidden, true);
}));

test("an import that conflicts is reported without applying and keeps the notebook as it was", withDom(async () => {
  const api = notebookApi({
    "GET research/notebook": () => notebook(),
    "POST research/import": () => {
      throw new ApiError("x", 422, { error: "conflict", plan: { counts: { create: 0, unchanged: 0, conflict: 1 }, entries: [{ id: "note-2", collection: "notes", action: "conflict", message: "a different note in this notebook already uses this id; nothing is overwritten" }] } });
    },
  });
  const { app, root } = mountResearch(api);
  await app.showResearch();
  const input = byId(root, "oba-research-import-file");
  input.files = [{ name: "n.json", text: async () => JSON.stringify({ format: "x" }) }];
  await input.dispatch("change", { target: input });
  await root.querySelectorAll("button").find((item) => item.dataset.researchImportPreview).click();
  await tick();
  assert.match(root.textContent, /Conflict: note note-2/);
  assert.match(root.textContent, /The import was not applied\. Nothing was saved\./);
  assert.equal(root.querySelectorAll("button").find((item) => item.dataset.researchImportApply).hidden, true);
  assert.deepEqual(entryButtons(root).map((item) => item.dataset.entryId), ["passage-1", "note-2"]);
}));
