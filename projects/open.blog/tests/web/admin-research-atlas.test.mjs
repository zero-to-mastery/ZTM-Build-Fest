import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ObAdmin,
  atlasBuildText,
  atlasChronologyGroupLabel,
  atlasChronologyModel,
  atlasChronologyStatus,
  atlasChronologyWindow,
  atlasConfidenceText,
  atlasDateText,
  atlasDatesText,
  atlasDatingDraft,
  atlasDatingPayload,
  atlasDatingReading,
  atlasPointText,
  atlasDiagnosticControl,
  atlasDissentDraft,
  atlasEndpointChoices,
  atlasEntryDraft,
  atlasEntryPayload,
  atlasErrorMessage,
  atlasEvidenceDraft,
  atlasEvidenceText,
  atlasFilterEntries,
  atlasRelationshipDraft,
  atlasRelationshipPayload,
  atlasRelationshipSentence,
  atlasStandingText,
  normalizeAdminPreferences,
  rebaseAtlasDatings,
  rebaseAtlasEntryDraft,
  rebaseAtlasRelationshipDraft,
  safeDecodeURIComponent,
  suggestAtlasId,
  validAtlasId,
  validateAtlasDatings,
  validateAtlasEntryDraft,
  validateAtlasRelationshipDraft,
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
    // Like a browser: only controls, links and elements with a tabindex take focus, and never while disabled.
    const focusable = ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(this.tagName) || (this.tagName === "A" && "href" in this.attributes) || "tabindex" in this.attributes;
    if (!focusable || this.disabled) return;
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

// ---------------------------------------------------------------- fixtures

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const HOSTILE = '<img src=x onerror="alert(1)"> Πλάτων 🙂 <script>alert(2)</script>';
const ANY = ["person", "work", "concept", "movement", "event"];
const KINDS = () => ({
  entries: ANY,
  relationships: [
    { kind: "authored", inverse: "authored by", from: ["person"], to: ["work"], symmetric: false, sameKind: false, acyclic: false },
    { kind: "influenced", inverse: "influenced by", from: ANY, to: ANY, symmetric: false, sameKind: false, acyclic: false },
    { kind: "member-of", inverse: "has member", from: ["person"], to: ["movement"], symmetric: false, sameKind: false, acyclic: false },
    { kind: "part-of", inverse: "has part", from: ["work", "concept", "movement", "event"], to: ["work", "concept", "movement", "event"], symmetric: false, sameKind: true, acyclic: true },
    { kind: "specializes", inverse: "generalized by", from: ["concept"], to: ["concept"], symmetric: false, sameKind: false, acyclic: true },
    { kind: "related-to", inverse: "related to", from: ANY, to: ANY, symmetric: true, sameKind: false, acyclic: false },
  ],
  aspects: [
    { aspect: "span", durative: true, entries: ANY, relationship: true },
    { aspect: "birth", durative: false, entries: ["person"], relationship: false },
    { aspect: "death", durative: false, entries: ["person"], relationship: false },
    { aspect: "active", durative: true, entries: ["person", "movement"], relationship: false },
    { aspect: "composition", durative: true, entries: ["work"], relationship: false },
    { aspect: "publication", durative: false, entries: ["work"], relationship: false },
    { aspect: "emergence", durative: false, entries: ["concept", "movement"], relationship: false },
  ],
  orders: ["before", "after", "during"],
  maxDatings: 20,
  maxYear: 100000,
});
const SOURCES = () => [
  { id: "plato-republic", kind: "work", title: "Πολιτεία" },
  { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam" },
  { id: "gone", kind: "work", title: "Gone", archived: true },
];
const PASSAGES = () => [{ id: "passage-1", source: "slings-2003", locators: [{ kind: "page", value: "514" }], preview: "the cave" }];
const ENTRIES = () => [
  { id: "plato", kind: "person", label: HOSTILE, aliases: ["Aristocles"], visibility: "private", shelf: 1 },
  { id: "politeia", kind: "work", label: "Politeia", source: "plato-republic", dates: [{ id: "politeia-composed", aspect: "composition", date: { notBefore: { year: -380, circa: true } }, assertedBy: { kind: "author" }, unsourced: true, confidence: "tentative", visibility: "private", shelf: 2 }], visibility: "approved" },
  { id: "allegory", kind: "concept", label: "Allegory", visibility: "private" },
  { id: "academy", kind: "movement", label: "The Academy", visibility: "private" },
];
const RELATIONSHIP = () => ({
  id: "plato-authored-politeia",
  kind: "authored",
  from: "plato",
  to: "politeia",
  assertedBy: { kind: "author", why: "kept" },
  confidence: "plausible",
  evidence: [{ source: "slings-2003", locators: [{ kind: "page", value: "514", hint: true }], margin: "kept" }],
  uncertainty: "The dating is unsettled.",
  contestedBy: [{ by: { kind: "named", name: "A later editor" }, note: "Doubts the attribution.", tag: "kept" }],
  visibility: "private",
  extra: 7,
});
const atlas = (over = {}) => ({
  file: ".openblog/private/research/atlas.json",
  revision: "r1",
  stored: true,
  entries: ENTRIES(),
  relationships: [RELATIONSHIP()],
  notices: [],
  missingConcepts: [],
  kinds: KINDS(),
  sources: SOURCES(),
  passages: PASSAGES(),
  ...over,
});
const EXPLORE = {
  plato: () => ({ revision: "r1", entry: ENTRIES()[0], outgoing: [{ label: "authored", other: { id: "politeia", kind: "work", label: "Politeia" }, standing: "contested", projected: false, relationship: RELATIONSHIP() }], incoming: [], notes: [] }),
  politeia: () => ({ revision: "r1", entry: ENTRIES()[1], outgoing: [], incoming: [{ label: "authored by", other: { id: "plato", kind: "person", label: HOSTILE }, standing: "contested", projected: false, relationship: RELATIONSHIP() }], notes: [] }),
  allegory: () => ({ revision: "r1", entry: ENTRIES()[2], outgoing: [], incoming: [], notes: [{ id: "note-2", kind: "question", preview: "Why a cave?" }] }),
  academy: () => ({ revision: "r1", entry: ENTRIES()[3], outgoing: [], incoming: [], notes: [] }),
};

function atlasApi(handlers = {}) {
  const calls = [];
  const all = {
    "GET research/atlas": () => atlas(),
    "POST research/atlas/explore": (body) => {
      const found = EXPLORE[body.id];
      if (!found) throw new ApiError("missing", 404, { error: "No atlas entry has this id", missing: true });
      return found();
    },
    ...handlers,
  };
  return {
    calls,
    async call(method, path, options = {}) {
      if (method !== "GET" && path !== "research/atlas/explore") calls.push({ method, path, body: structuredClone(options.json) });
      const handler = all[`${method} ${path}`];
      if (!handler) throw new ApiError(`unexpected ${method} ${path}`, 500, null);
      return handler(options.json);
    },
  };
}

function mountAtlas(api) {
  const app = new ObAdmin();
  const root = new DomNode("div", globalThis.document);
  app.api = api;
  app.meta = { siteTitle: "Blog" };
  app.preferences = normalizeAdminPreferences({ preset: "advanced" });
  app.replaceChildren = (...nodes) => root.replaceChildren(...nodes);
  return { app, root };
}

const byId = (root, id) => root.querySelector(`#${id}`);
const type = async (control, value, event = "input") => {
  control.value = value;
  await control.dispatch(event, { target: control });
};
const choose = (control, value) => type(control, value, "change");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const submit = (root) => root.querySelector("form").dispatch("submit");
const buttonLabelled = (root, text) => root.querySelectorAll("button").find((button) => button.textContent === text);
const entryIds = (root) => root.querySelectorAll("button").filter((button) => button.dataset.atlasEntry).map((button) => button.dataset.atlasEntry);
const options = (select) => select.children.map((option) => option.value).filter(Boolean);
const optionText = (select) => select.children.map((option) => option.textContent);

// ---------------------------------------------------------------- pure helpers

test("entries filter by kind and by any word of the id, label or other names", () => {
  const entries = ENTRIES();
  assert.deepEqual(atlasFilterEntries(entries, { kind: "work" }).map((entry) => entry.id), ["politeia"]);
  assert.deepEqual(atlasFilterEntries(entries, { query: "aristocles" }).map((entry) => entry.id), ["plato"]);
  assert.deepEqual(atlasFilterEntries(entries, { query: "  ΠΛΆΤΩΝ " }).map((entry) => entry.id), ["plato"]);
  assert.deepEqual(atlasFilterEntries(entries, { query: "the academy" }).map((entry) => entry.id), ["academy"]);
  assert.deepEqual(atlasFilterEntries(entries, { query: "academy", kind: "person" }), []);
  assert.equal(atlasFilterEntries(entries, {}).length, 4);
});

test("endpoint pickers offer only the entry kinds a relationship kind may join", () => {
  const entries = ENTRIES();
  const ids = (list) => list.map((entry) => entry.id);
  assert.deepEqual(ids(atlasEndpointChoices(KINDS(), "authored", "from", entries)), ["plato"]);
  assert.deepEqual(ids(atlasEndpointChoices(KINDS(), "authored", "to", entries)), ["politeia"]);
  assert.deepEqual(ids(atlasEndpointChoices(KINDS(), "member-of", "to", entries)), ["academy"]);
  // part-of joins two entries of one kind; the other end narrows the choice and is never offered itself.
  const work = entries[1];
  assert.deepEqual(ids(atlasEndpointChoices(KINDS(), "part-of", "to", [...entries, { id: "book-7", kind: "work", label: "Book 7" }], work)), ["book-7"]);
  assert.ok(!ids(atlasEndpointChoices(KINDS(), "influenced", "to", entries, entries[0])).includes("plato"), "no self-relationship");
  assert.equal(atlasEndpointChoices(KINDS(), "", "from", entries).length, 4, "with no kind, every entry");
});

test("identifiers are readable slugs that nothing uses yet", () => {
  assert.equal(suggestAtlasId("Théodore of Cyrene", []), "theodore-of-cyrene");
  assert.equal(suggestAtlasId("Πολιτεία", [], "work"), "work");
  assert.equal(suggestAtlasId("Plato", ["plato", "plato-2"]), "plato-3");
  assert.ok(suggestAtlasId("x".repeat(200)).length <= 64);
  assert.ok(validAtlasId("the-good") && !validAtlasId("The Good") && !validAtlasId("a--b") && !validAtlasId("x".repeat(65)));
});

test("standing is asserted or contested by named parties, and never consensus", () => {
  const sources = SOURCES();
  assert.equal(atlasStandingText({ contestedBy: [] }), "Asserted; no recorded dissent");
  const contested = atlasStandingText(RELATIONSHIP(), sources);
  assert.match(contested, /^Contested: 1 recorded dissent \(by A later editor\)$/);
  assert.match(atlasStandingText({ contestedBy: [{ by: { kind: "source", source: "plato-republic" } }, { by: { kind: "author" } }] }, sources), /2 recorded dissents \(by the source Πολιτεία; you \(the author\)\)/);
  for (const text of [contested, atlasConfidenceText({ confidence: "strong" }), atlasEvidenceText({ unsourced: true })]) {
    assert.doesNotMatch(text, /consensus|agreed|established|fact/i);
  }
  assert.match(atlasConfidenceText({}), /^Tentative confidence, as held by the asserting party$/);
  assert.equal(atlasEvidenceText({ unsourced: true }), "Unsourced draft: no evidence cited yet");
  assert.equal(atlasRelationshipSentence(RELATIONSHIP(), ENTRIES()), `${HOSTILE} authored Politeia`);
});

test("server diagnostics map to the control that fixes them", () => {
  assert.equal(atlasDiagnosticControl("dates[0].date.at.year", "entry"), "dating-0-at-value");
  assert.equal(atlasDiagnosticControl("dates[2].date.notBefore.month", "entry"), "dating-2-not-before-month");
  assert.equal(atlasDiagnosticControl("dates[1].date.notAfter", "entry"), "dating-1-not-after-precision");
  assert.equal(atlasDiagnosticControl("dates[1].date", "relationship"), "dating-1-form");
  assert.equal(atlasDiagnosticControl("dates[0].date.relative.aspect", "entry"), "dating-0-relative-aspect");
  assert.equal(atlasDiagnosticControl("dates[0].assertedBy.name", "entry"), "dating-0-asserted-name");
  assert.equal(atlasDiagnosticControl("dates[0].evidence[1].passage", "relationship"), "dating-0-evidence-1-passage");
  assert.equal(atlasDiagnosticControl("dates[0].evidence", "entry"), "dating-0-evidence");
  assert.equal(atlasDiagnosticControl("dates[3].visibility", "entry"), "dating-3-approved");
  assert.equal(atlasDiagnosticControl("dates[3].id", "entry"), "dating-3-id");
  assert.equal(atlasDiagnosticControl("dates", "entry"), "dates");
  assert.equal(atlasDiagnosticControl("visibility", "entry"), "approved");
  assert.equal(atlasDiagnosticControl("evidence[1].locators[0].kind", "relationship"), "evidence-1-locators");
  assert.equal(atlasDiagnosticControl("evidence", "relationship"), "evidence");
  assert.equal(atlasDiagnosticControl("assertedBy.name", "relationship"), "asserted-name");
  assert.equal(atlasDiagnosticControl("contestedBy[0].by.source", "relationship"), "dissent-0-source");
  assert.equal(atlasDiagnosticControl("contestedBy[2].evidence[0].passage", "relationship"), "dissent-2-evidence-0-passage");
  assert.equal(atlasDiagnosticControl("contestedBy[1]", "relationship"), "dissent-1");
  assert.equal(atlasDiagnosticControl("to", "relationship"), "to");
  const message = atlasErrorMessage({ data: { diagnostics: [{ code: "cycle", collection: "relationships", id: "a-b", field: "to", message: "part of a cycle" }] } });
  assert.equal(message, "Relationship a-b: to: part of a cycle");
});

test("payloads keep unknown fields at every level the form edits", () => {
  const entry = atlasEntryDraft(ENTRIES()[1]);
  entry.label = "  Republic ";
  const sent = atlasEntryPayload(entry);
  assert.deepEqual(sent.dates, ENTRIES()[1].dates, "datings, precision and unknown fields are carried over unchanged");
  assert.equal(sent.bounds, undefined);
  assert.equal(sent.label, "Republic");
  assert.equal(sent.source, "plato-republic");
  const person = atlasEntryDraft(ENTRIES()[0]);
  person.aliases = "Aristocles\n\n  Platon  ";
  assert.deepEqual(atlasEntryPayload(person).aliases, ["Aristocles", "Platon"]);
  assert.equal(atlasEntryPayload(person).shelf, 1);
  assert.equal(atlasEntryPayload(person).visibility, "private");

  const draft = atlasRelationshipDraft(RELATIONSHIP());
  const same = atlasRelationshipPayload(draft);
  assert.deepEqual(same, RELATIONSHIP(), "an untouched relationship round-trips exactly");
  draft.evidence[0].locators = "page: 515";
  draft.contestedBy[0].note = "Changed.";
  const edited = atlasRelationshipPayload(draft);
  assert.equal(edited.evidence[0].margin, "kept");
  assert.deepEqual(edited.evidence[0].locators, [{ kind: "page", value: "515" }]);
  assert.equal(edited.contestedBy[0].tag, "kept");
  assert.equal(edited.assertedBy.why, "kept");
  assert.equal(edited.extra, 7);
  const unsourced = atlasRelationshipDraft({ id: "r", kind: "influenced", from: "plato", to: "allegory", assertedBy: { kind: "author" }, unsourced: true });
  assert.equal(atlasRelationshipPayload(unsourced).unsourced, true);
  assert.equal(atlasRelationshipPayload(unsourced).evidence, undefined);
});

test("advisory checks name the first problem and the control for it", () => {
  const context = { entries: ENTRIES(), kinds: KINDS(), sources: SOURCES(), passages: PASSAGES() };
  const base = () => atlasRelationshipDraft({ id: "r", kind: "influenced", from: "plato", to: "allegory", assertedBy: { kind: "author" } });
  assert.equal(validateAtlasRelationshipDraft(atlasRelationshipDraft(null), context).field, "kind");
  const wrong = base();
  wrong.kind = "authored";
  wrong.to = "allegory";
  assert.equal(validateAtlasRelationshipDraft(wrong, context).field, "to");
  assert.equal(validateAtlasRelationshipDraft(base(), context).field, "evidence");
  const strong = base();
  strong.unsourced = true;
  strong.confidence = "strong";
  assert.equal(validateAtlasRelationshipDraft(strong, context).field, "confidence");
  const approved = base();
  approved.evidence = [atlasEvidenceDraft({ source: "slings-2003", passage: "passage-1" })];
  approved.approved = true;
  assert.match(validateAtlasRelationshipDraft(approved, context).message, /cannot point into your private notebook/);
  const mismatched = base();
  mismatched.evidence = [atlasEvidenceDraft({ source: "plato-republic", passage: "passage-1" })];
  assert.equal(validateAtlasRelationshipDraft(mismatched, context).field, "evidence-0-passage");
  const dissent = base();
  dissent.unsourced = true;
  dissent.contestedBy = [atlasDissentDraft({ by: { kind: "named", name: "X" } })];
  assert.equal(validateAtlasRelationshipDraft(dissent, context).field, "dissent-0-note");
  const named = base();
  named.unsourced = true;
  named.assertedBy.kind = "named";
  assert.equal(validateAtlasRelationshipDraft(named, context).field, "asserted-name");
  const ok = base();
  ok.unsourced = true;
  assert.equal(validateAtlasRelationshipDraft(ok, context), null);

  const entry = atlasEntryDraft(null, { kind: "person" });
  assert.equal(validateAtlasEntryDraft(entry, { creating: true }).field, "id");
  entry.id = "plato";
  assert.equal(validateAtlasEntryDraft(entry, { creating: true, used: ["plato"] }).field, "id");
  entry.id = "socrates";
  assert.equal(validateAtlasEntryDraft(entry, { creating: true }).field, "label");
  entry.label = "Socrates";
  assert.equal(validateAtlasEntryDraft(entry, { creating: true }), null);
});

test("the entry form names an entry's datings and keeps them, never flattening them to years", () => {
  assert.match(atlasDatesText(0), /^No datings yet\. /);
  assert.match(atlasDatesText(1), /^1 dating\. /);
  assert.match(atlasDatesText(3), /^3 datings\. /);
  assert.match(atlasDatesText(2), /Competing datings stay side by side; nothing picks one/);
  assert.equal(atlasEntryDraft(ENTRIES()[1]).datings.length, 1);
  assert.equal(atlasEntryDraft(ENTRIES()[0]).datings.length, 0);
  assert.equal(atlasEntryPayload(atlasEntryDraft(ENTRIES()[0])).dates, undefined);
});

// ---------------------------------------------------------------- the atlas view

test("the atlas lists entries as text, searches them, and filters by kind", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi());
  await app.showAtlas();
  assert.deepEqual(entryIds(root), ["plato", "politeia", "allegory", "academy"]);
  assert.equal(root.querySelectorAll("img").length + root.querySelectorAll("script").length, 0, "hostile labels render as text");
  assert.ok(root.textContent.includes("<img src=x"));
  assert.match(root.querySelector("[data-atlas-count]").textContent, /^4 entries, 1 relationship, 1 contested\.$/);
  await type(byId(root, "oba-atlas-search"), "aristocles");
  assert.deepEqual(entryIds(root), ["plato"]);
  assert.match(root.querySelector("[data-atlas-count]").textContent, /^1 of 4 entries shown/);
  await type(byId(root, "oba-atlas-search"), "");
  await choose(byId(root, "oba-atlas-kind-filter"), "movement");
  assert.deepEqual(entryIds(root), ["academy"]);
  await type(byId(root, "oba-atlas-search"), "plato");
  assert.match(root.textContent, /No entries match the search and kind/);
  assert.equal(byId(root, "oba-atlas-search").getAttribute("aria-controls"), "oba-atlas-entries");
}));

test("opening an entry moves focus to it and lists its relationships from its side, with labels", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi());
  await app.showAtlas();
  await root.querySelectorAll("button").find((button) => button.dataset.atlasEntry === "politeia").click();
  await tick();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  const explorer = root.querySelector("[data-atlas-explorer]");
  const incoming = explorer.querySelectorAll("section").find((section) => section.dataset.atlasDirection === "incoming");
  assert.match(incoming.textContent, /Incoming \(1\)/);
  assert.ok(incoming.textContent.includes(`Politeia authored by ${HOSTILE}`));
  assert.match(incoming.textContent, /Contested: 1 recorded dissent \(by A later editor\)/);
  assert.match(incoming.textContent, /Plausible confidence, as held by the asserting party/);
  assert.match(incoming.textContent, /Uncertain: The dating is unsettled\./);
  assert.match(incoming.textContent, /Rests on 1 piece of evidence/);
  assert.match(explorer.textContent, /Outgoing \(0\)/);
  assert.doesNotMatch(explorer.textContent, /consensus|agreed|established/i);
  assert.equal(explorer.querySelectorAll("img").length, 0);
  // Navigate along the relationship as text, from the keyboard.
  await buttonLabelled(explorer, `Explore ${HOSTILE}`).click();
  await tick();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  assert.ok(root.querySelector("[data-atlas-explorer]").textContent.includes(`${HOSTILE} authored Politeia`));
  const edit = root.querySelector("[data-atlas-open-relationship]");
  assert.equal(edit.getAttribute("aria-label"), `Edit relationship: ${HOSTILE} authored Politeia`);
  await edit.click();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  assert.equal(root.querySelector("[data-atlas-sentence]").textContent, `${HOSTILE} authored Politeia`);
  assert.equal(root.querySelector("p[data-atlas-standing]").dataset.atlasStanding, "contested");
}));

test("a relationship's address opens it focused, and an unknown one says so", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi());
  await app.showAtlas("relationships/plato-authored-politeia");
  await tick();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  assert.equal(root.querySelector("[data-atlas-sentence]").textContent, `${HOSTILE} authored Politeia`);
  const other = mountAtlas(atlasApi());
  await other.app.showAtlas("relationships/gone");
  assert.match(other.root.textContent, /No relationship has the identifier gone/);
  assert.equal(other.root.querySelector("[data-atlas-sentence]"), null);
}));

test("a concept lists the notebook notes that link it", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi());
  await app.showAtlas("allegory");
  await tick();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  const notes = root.querySelector("[data-atlas-notes]");
  assert.match(notes.textContent, /Notebook notes linking this concept \(1\)/);
  assert.match(notes.textContent, /Why a cave\? \(question, note-2\)/);
}));

test("creating an entry suggests an id, sends the revision, and focuses the saved entry", withDom(async () => {
  const api = atlasApi({
    "POST research/atlas/entries": (body) => ({ ...atlas({ revision: "r2", entries: [...ENTRIES(), body.entry] }), entry: body.entry }),
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas();
  await buttonLabelled(root, "New entry").click();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  await choose(byId(root, "oba-atlas-entry-kind"), "person");
  await type(byId(root, "oba-atlas-entry-label"), "Socrates of Athens");
  assert.equal(byId(root, "oba-atlas-entry-id").value, "socrates-of-athens");
  assert.equal(byId(root, "oba-atlas-entry-from-year"), null, "years are no longer edited as bounds");
  assert.match(root.querySelector("[data-atlas-dates-summary]").textContent, /^No datings yet\./);
  await submit(root);
  assert.deepEqual(api.calls.map((call) => [call.method, call.path, call.body.revision]), [["POST", "research/atlas/entries", "r1"]]);
  assert.deepEqual(api.calls[0].body.entry, { id: "socrates-of-athens", kind: "person", label: "Socrates of Athens", visibility: "private" });
  await tick();
  assert.ok(entryIds(root).includes("socrates-of-athens"));
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  assert.equal(byId(root, "oba-atlas-heading").textContent, "Socrates of Athens");
  assert.match(root.textContent, /Entry saved to the private atlas/);
}));

test("a relationship is built with typed pickers, notebook evidence, and an explicit draft state", withDom(async () => {
  const api = atlasApi({
    "POST research/atlas/relationships": (body) => ({ ...atlas({ revision: "r2", relationships: [RELATIONSHIP(), body.relationship] }), relationship: body.relationship }),
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas();
  await buttonLabelled(root, "New relationship").click();
  const kind = byId(root, "oba-atlas-relationship-kind");
  await choose(kind, "member-of");
  assert.equal(globalThis.document.activeElement, byId(root, "oba-atlas-relationship-kind"), "focus stays on the kind after it changes");
  assert.deepEqual(options(byId(root, "oba-atlas-relationship-from")), ["plato"]);
  assert.deepEqual(options(byId(root, "oba-atlas-relationship-to")), ["academy"]);
  await choose(byId(root, "oba-atlas-relationship-from"), "plato");
  await choose(byId(root, "oba-atlas-relationship-to"), "academy");
  // A kind the chosen target cannot take clears it, and says so.
  await choose(byId(root, "oba-atlas-relationship-kind"), "authored");
  assert.equal(byId(root, "oba-atlas-relationship-to").value, "");
  assert.equal(byId(root, "oba-atlas-relationship-from").value, "plato");
  assert.match(root.querySelector("form").textContent, /The target entry does not fit a authored relationship, so it was cleared/);
  await choose(byId(root, "oba-atlas-relationship-kind"), "influenced");
  await choose(byId(root, "oba-atlas-relationship-to"), "allegory");
  assert.ok(!options(byId(root, "oba-atlas-relationship-to")).includes("plato"), "the starting entry is not offered as a target");

  // Without evidence or the draft state nothing is sent.
  await submit(root);
  assert.equal(api.calls.length, 0);
  assert.equal(byId(root, "oba-atlas-relationship-evidence").getAttribute("aria-invalid"), "true");
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-relationship-evidence");
  assert.match(byId(root, "oba-atlas-relationship-error").textContent, /Add evidence, or mark this relationship as an unsourced draft/);

  await buttonLabelled(root, "Add evidence").click();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-relationship-evidence-0-source");
  assert.equal(byId(root, "oba-atlas-relationship-unsourced").disabled, true, "evidence and the draft state exclude each other");
  assert.ok(!options(byId(root, "oba-atlas-relationship-evidence-0-source")).includes("gone"), "archived sources are not offered");
  await choose(byId(root, "oba-atlas-relationship-evidence-0-passage"), "passage-1");
  assert.equal(byId(root, "oba-atlas-relationship-evidence-0-source").value, "slings-2003");
  assert.equal(byId(root, "oba-atlas-relationship-evidence-0-locators").value, "page: 514");
  assert.ok(optionText(byId(root, "oba-atlas-relationship-evidence-0-passage")).includes("the cave (passage-1)"));
  await choose(byId(root, "oba-atlas-relationship-confidence"), "plausible");
  byId(root, "oba-atlas-relationship-asserted-is-named").checked = true;
  await byId(root, "oba-atlas-relationship-asserted-is-named").dispatch("change");
  await type(byId(root, "oba-atlas-relationship-asserted-name"), "  Diogenes Laertius ");
  await type(byId(root, "oba-atlas-relationship-uncertainty"), "Only one late source says so.");
  await submit(root);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body, {
    revision: "r1",
    relationship: {
      id: "plato-influenced-allegory",
      kind: "influenced",
      from: "plato",
      to: "allegory",
      assertedBy: { kind: "named", name: "Diogenes Laertius" },
      confidence: "plausible",
      evidence: [{ source: "slings-2003", locators: [{ kind: "page", value: "514" }], passage: "passage-1" }],
      uncertainty: "Only one late source says so.",
      visibility: "private",
    },
  });
  assert.match(root.textContent, /Relationship saved to the private atlas/);
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
}));

test("an unsourced draft and a dissent are recorded from the keyboard", withDom(async () => {
  const api = atlasApi({
    "POST research/atlas/relationships": (body) => ({ ...atlas({ revision: "r2", relationships: [RELATIONSHIP(), body.relationship] }), relationship: body.relationship }),
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("allegory");
  await tick();
  await buttonLabelled(root, "Add a relationship to this entry").click();
  assert.equal(byId(root, "oba-atlas-relationship-to").value, "allegory");
  await choose(byId(root, "oba-atlas-relationship-kind"), "related-to");
  await choose(byId(root, "oba-atlas-relationship-from"), "academy");
  const unsourced = byId(root, "oba-atlas-relationship-unsourced");
  unsourced.checked = true;
  await unsourced.dispatch("change", { target: unsourced });
  await buttonLabelled(root, "Add a dissent").click();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-relationship-dissent-0-name");
  await type(byId(root, "oba-atlas-relationship-dissent-0-name"), "A historian");
  await submit(root);
  assert.equal(api.calls.length, 0, "a dissent needs evidence or a note");
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-relationship-dissent-0-note");
  await type(byId(root, "oba-atlas-relationship-dissent-0-note"), "Sees no link.");
  await submit(root);
  const sent = api.calls[0].body.relationship;
  assert.equal(sent.unsourced, true);
  assert.equal(sent.evidence, undefined);
  assert.deepEqual(sent.contestedBy, [{ by: { kind: "named", name: "A historian" }, note: "Sees no link." }]);
}));

test("a refused save is scoped to its field, keeps the draft, and says nothing was stored", withDom(async () => {
  const api = atlasApi({
    "PUT research/atlas/relationships": () => {
      throw new ApiError("cycle", 422, { error: "cycle", diagnostics: [{ code: "cycle", collection: "relationships", id: "plato-authored-politeia", field: "to", message: "part of a cycle of part-of relationships" }] });
    },
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas();
  await root.querySelectorAll("button").find((button) => button.dataset.atlasEntry === "plato").click();
  await tick();
  await root.querySelector("[data-atlas-open-relationship]").click();
  await type(byId(root, "oba-atlas-relationship-uncertainty"), "Edited doubt");
  await submit(root);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].body.relationship.extra, 7, "unknown fields survive the edit");
  assert.equal(byId(root, "oba-atlas-relationship-to").getAttribute("aria-invalid"), "true");
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-relationship-to");
  assert.match(byId(root, "oba-atlas-relationship-error").textContent, /Relationship plato-authored-politeia: to: part of a cycle/);
  assert.match(root.textContent, /Not saved\. The stored atlas is unchanged\./);
  assert.equal(byId(root, "oba-atlas-relationship-uncertainty").value, "Edited doubt");
}));

test("a conflict blocks saving until the author uses the stored copy or keeps the draft", withDom(async () => {
  const newer = { ...ENTRIES()[0], label: "Plato (stored)", added: "elsewhere" };
  let reads = 0;
  const api = atlasApi({
    "GET research/atlas": () => (reads++ ? atlas({ revision: "r9", entries: [newer, ...ENTRIES().slice(1)] }) : atlas()),
    "PUT research/atlas/entries": (body) => {
      if (body.revision !== "r9") throw new ApiError("changed", 409, { conflict: true, revision: "r9", current: newer });
      return { ...atlas({ revision: "r10", entries: [body.entry, ...ENTRIES().slice(1)] }), entry: body.entry };
    },
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("plato");
  await tick();
  await type(byId(root, "oba-atlas-entry-label"), "My Plato");
  await submit(root);
  assert.ok(buttonLabelled(root, "Use the stored copy") && buttonLabelled(root, "Keep my draft"));
  assert.equal(buttonLabelled(root, "Save changes").disabled, true);
  assert.equal(globalThis.document.activeElement.dataset.atlasConflictUse, "stored");
  await submit(root);
  assert.equal(api.calls.length, 1, "nothing is resent before a choice");
  await buttonLabelled(root, "Keep my draft").click();
  assert.equal(byId(root, "oba-atlas-entry-label").value, "My Plato");
  await submit(root);
  assert.equal(api.calls[1].body.revision, "r9");
  assert.equal(api.calls[1].body.entry.added, "elsewhere", "fields added elsewhere are kept");
  assert.equal(api.calls[1].body.entry.label, "My Plato");

  const second = mountAtlas(atlasApi({
    "GET research/atlas": () => atlas({ revision: "r9" }),
    "PUT research/atlas/entries": () => {
      throw new ApiError("changed", 409, { conflict: true, revision: "r9", current: newer });
    },
  }));
  await second.app.showAtlas("plato");
  await tick();
  await type(byId(second.root, "oba-atlas-entry-label"), "Mine");
  await submit(second.root);
  await buttonLabelled(second.root, "Use the stored copy").click();
  assert.equal(byId(second.root, "oba-atlas-entry-label").value, "Plato (stored)");
  assert.ok(!buttonLabelled(second.root, "Save changes").disabled);
}));

test("keeping a relationship draft after a conflict keeps fields added elsewhere to its evidence, dissents and parties", withDom(async () => {
  const base = () => {
    const relationship = RELATIONSHIP();
    relationship.contestedBy[0].evidence = [{ source: "plato-republic", locators: [{ kind: "page", value: "1" }] }];
    return relationship;
  };
  const newer = base();
  newer.uncertainty = "Stored doubt.";
  newer.evidence[0].added = "elsewhere";
  newer.evidence[0].locators[0].added = "elsewhere";
  newer.contestedBy[0].added = "elsewhere";
  newer.contestedBy[0].by.added = "elsewhere";
  newer.contestedBy[0].evidence[0].added = "elsewhere";
  let reads = 0;
  const api = atlasApi({
    "GET research/atlas": () => (reads++ ? atlas({ revision: "r9", relationships: [newer] }) : atlas({ relationships: [base()] })),
    "POST research/atlas/explore": (body) => ({ ...EXPLORE[body.id](), outgoing: [{ label: "authored", other: { id: "politeia", kind: "work", label: "Politeia" }, standing: "contested", projected: false, relationship: base() }] }),
    "PUT research/atlas/relationships": (body) => {
      if (body.revision !== "r9") throw new ApiError("changed", 409, { conflict: true, revision: "r9", current: newer });
      return { ...atlas({ revision: "r10", relationships: [body.relationship] }), relationship: body.relationship };
    },
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("plato");
  await tick();
  await root.querySelector("[data-atlas-open-relationship]").click();
  await type(byId(root, "oba-atlas-relationship-uncertainty"), "My doubt.");
  await submit(root);
  await buttonLabelled(root, "Keep my draft").click();
  await submit(root);
  assert.equal(api.calls.length, 2);
  const sent = api.calls[1].body.relationship;
  assert.equal(api.calls[1].body.revision, "r9");
  assert.equal(sent.uncertainty, "My doubt.", "the draft's own edit wins");
  assert.equal(sent.evidence[0].added, "elsewhere", "an evidence item keeps a field added elsewhere");
  assert.equal(sent.evidence[0].margin, "kept");
  assert.deepEqual(sent.evidence[0].locators, [{ kind: "page", value: "514", hint: true, added: "elsewhere" }], "an unchanged locator is compared with the newer copy");
  assert.equal(sent.contestedBy[0].added, "elsewhere", "a dissent keeps a field added elsewhere");
  assert.equal(sent.contestedBy[0].tag, "kept");
  assert.deepEqual(sent.contestedBy[0].by, { kind: "named", name: "A later editor", added: "elsewhere" }, "a dissenting party keeps a field added elsewhere");
  assert.equal(sent.contestedBy[0].evidence[0].added, "elsewhere", "a dissent's evidence keeps a field added elsewhere");
  assert.equal(sent.assertedBy.why, "kept");
}));

test("a rebased draft takes each nested item from the stored index it was read from, and leaves new items alone", () => {
  const draft = atlasRelationshipDraft(RELATIONSHIP());
  draft.evidence.unshift(atlasEvidenceDraft({ source: "plato-republic" }));
  draft.contestedBy.push(atlasDissentDraft({ by: { kind: "named", name: "New" }, note: "Mine." }));
  const newer = RELATIONSHIP();
  newer.evidence[0].added = "elsewhere";
  newer.contestedBy[0].by.added = "elsewhere";
  rebaseAtlasRelationshipDraft(draft, newer);
  const sent = atlasRelationshipPayload(draft);
  assert.deepEqual(sent.evidence[0], { source: "plato-republic" }, "a new item has nothing to rebase onto");
  assert.equal(sent.evidence[1].added, "elsewhere", "a moved item still rests on the item it came from");
  assert.equal(sent.contestedBy[0].by.added, "elsewhere");
  assert.deepEqual(sent.contestedBy[1], { by: { kind: "named", name: "New" }, note: "Mine." });
  const gone = atlasRelationshipDraft(RELATIONSHIP());
  rebaseAtlasRelationshipDraft(gone, { ...RELATIONSHIP(), evidence: [], contestedBy: [] });
  assert.equal(atlasRelationshipPayload(gone).evidence[0].margin, "kept", "an item removed elsewhere keeps the copy the draft holds");
});

test("a rebased draft keeps its own copy of an item whose stored index now holds another item", () => {
  const record = RELATIONSHIP();
  record.evidence = [
    { source: "removed-elsewhere", passage: "p-0", own: "first" },
    { source: "slings-2003", passage: "p-1", own: "second" },
  ];
  record.contestedBy = [
    { by: { kind: "named", name: "Removed elsewhere" }, note: "Gone.", own: "first" },
    { by: { kind: "named", name: "A later editor" }, note: "Doubts the attribution.", own: "second" },
  ];
  const draft = atlasRelationshipDraft(record);
  draft.evidence.shift();
  draft.contestedBy.shift();
  const newer = RELATIONSHIP();
  newer.evidence = [{ source: "slings-2003", passage: "p-1", own: "second", added: "elsewhere" }];
  newer.contestedBy = [{ by: { kind: "named", name: "A later editor" }, note: "Doubts the attribution.", own: "second", added: "elsewhere" }];
  rebaseAtlasRelationshipDraft(draft, newer);
  const sent = atlasRelationshipPayload(draft);
  assert.deepEqual(sent.evidence, [{ source: "slings-2003", passage: "p-1", own: "second", added: "elsewhere" }], "the evidence item rests on its own stored copy, now at index 0, and never on another item at index 1");
  assert.equal(sent.contestedBy.length, 1);
  assert.equal(sent.contestedBy[0].own, "second", "the dissent keeps its own fields");
  assert.equal(sent.contestedBy[0].added, "elsewhere", "the dissent's party is unique in both lists, so it rests on its own stored copy, now at index 0");

  const shifted = atlasRelationshipDraft(record);
  const elsewhere = RELATIONSHIP();
  elsewhere.evidence = [{ source: "slings-2003", passage: "p-1", own: "second" }];
  elsewhere.contestedBy = [{ by: { kind: "named", name: "A later editor" }, note: "Doubts the attribution.", own: "second" }];
  rebaseAtlasRelationshipDraft(shifted, elsewhere);
  const kept = atlasRelationshipPayload(shifted);
  assert.deepEqual(kept.evidence.map((item) => item.own), ["first", "second"], "an item removed elsewhere ahead of the draft's items neither loses nor borrows fields");
  assert.deepEqual(kept.contestedBy.map((item) => item.own), ["first", "second"]);
  assert.equal(kept.contestedBy[1].by.name, "A later editor");
});

// Two evidence items citing the same source and passage, told apart only by their locators.
const TWINS = () => [
  { source: "slings-2003", passage: "p-1", locators: [{ kind: "page", value: "1" }], own: "A" },
  { source: "slings-2003", passage: "p-1", locators: [{ kind: "page", value: "2" }], own: "B" },
];
const removedA = () => [{ ...TWINS()[1], added: "b" }];
const swapped = () => [
  { ...TWINS()[1], added: "b" },
  { ...TWINS()[0], added: "a" },
];
const checkTwins = (sent, expected, message) => {
  assert.deepEqual(sent.map((item) => [item.own, item.added, item.locators[0].value]), expected, message);
};

test("evidence citing the same source and passage twice never rests on the other item after a removal or a swap elsewhere", () => {
  const record = RELATIONSHIP();
  record.evidence = TWINS();
  record.contestedBy[0].evidence = TWINS();
  for (const [change, expected] of [
    [removedA, [["A", undefined, "1"], ["B", "b", "2"]]],
    [swapped, [["A", "a", "1"], ["B", "b", "2"]]],
  ]) {
    const draft = atlasRelationshipDraft(record);
    const newer = RELATIONSHIP();
    newer.evidence = change();
    newer.contestedBy[0].evidence = change();
    rebaseAtlasRelationshipDraft(draft, newer);
    const sent = atlasRelationshipPayload(draft);
    checkTwins(sent.evidence, expected, `relationship evidence after ${change.name}: A keeps its own fields and B takes only its own`);
    checkTwins(sent.contestedBy[0].evidence, expected, `dissent evidence after ${change.name}`);
  }
});

test("dissents by the same party rest on their own newer copy, never the other party member's", () => {
  const dissent = (note, own, extra = {}) => ({ by: { kind: "named", name: "Editor" }, note, own, evidence: [{ source: "x", passage: "p", tag: `${own}-ev` }], ...extra });
  const opened = () => ({ ...RELATIONSHIP(), contestedBy: [dissent("First doubt.", "first"), dissent("Second doubt.", "second")] });
  const rebase = (contestedBy) => {
    const draft = atlasRelationshipDraft(opened());
    rebaseAtlasRelationshipDraft(draft, { ...opened(), contestedBy });
    return atlasRelationshipPayload(draft).contestedBy.map((item) => [item.own, item.added, item.evidence[0].tag]);
  };
  // The first is removed elsewhere and the second gains a field: the first keeps its own copy.
  assert.deepEqual(rebase([dissent("Second doubt.", "second", { added: "x" })]), [["first", undefined, "first-ev"], ["second", "x", "second-ev"]]);
  // A swap elsewhere is followed by note.
  assert.deepEqual(rebase([dissent("Second doubt.", "second", { added: "b" }), dissent("First doubt.", "first", { added: "a" })]), [["first", "a", "first-ev"], ["second", "b", "second-ev"]]);
  // Identical dissents are told apart only by their index while the group keeps its size.
  const twins = () => [dissent("Same.", "one"), dissent("Same.", "two")];
  const draft = atlasRelationshipDraft({ ...RELATIONSHIP(), contestedBy: twins() });
  rebaseAtlasRelationshipDraft(draft, { ...RELATIONSHIP(), contestedBy: [{ ...twins()[1], added: "b" }] });
  assert.deepEqual(atlasRelationshipPayload(draft).contestedBy.map((item) => [item.own, item.added]), [["one", undefined], ["two", undefined]]);
});

test("identical evidence items keep their own copy when the identical group changed size elsewhere", () => {
  const same = () => [{ source: "s", passage: "p", own: "A" }, { source: "s", passage: "p", own: "B" }];
  const record = { ...RELATIONSHIP(), evidence: same(), contestedBy: [] };
  const draft = atlasRelationshipDraft(record);
  rebaseAtlasRelationshipDraft(draft, { ...record, evidence: [{ ...same()[1], added: "b" }] });
  assert.deepEqual(atlasRelationshipPayload(draft).evidence.map((item) => [item.own, item.added]), [["A", undefined], ["B", undefined]]);
  // When the group is the same size the item at its own index is followed.
  const again = atlasRelationshipDraft(record);
  rebaseAtlasRelationshipDraft(again, { ...record, evidence: [{ ...same()[0], added: "a" }, same()[1]] });
  assert.deepEqual(atlasRelationshipPayload(again).evidence.map((item) => [item.own, item.added]), [["A", "a"], ["B", undefined]]);
});

test("a dating's evidence citing the same source and passage twice never rests on the other item after a removal or a swap elsewhere", () => {
  const stored = (evidence) => ({ id: "birth", aspect: "birth", date: { at: { year: -428 } }, assertedBy: { kind: "author" }, confidence: "tentative", evidence, visibility: "private" });
  for (const [change, expected] of [
    [removedA, [["A", undefined, "1"], ["B", "b", "2"]]],
    [swapped, [["A", "a", "1"], ["B", "b", "2"]]],
  ]) {
    const opened = [stored(TWINS())];
    const datings = opened.map((item) => atlasDatingDraft(item));
    rebaseAtlasDatings(datings, [stored(change())], opened);
    checkTwins(atlasDatingPayload(datings[0]).evidence, expected, `dating evidence after ${change.name}`);
  }
  // A pair only one item holds is still followed wherever it moves.
  const opened = [stored([{ source: "other", locators: [{ kind: "page", value: "9" }] }, TWINS()[0]])];
  const datings = opened.map((item) => atlasDatingDraft(item));
  rebaseAtlasDatings(datings, [stored([{ ...TWINS()[0], added: "a" }])], opened);
  const sent = atlasDatingPayload(datings[0]).evidence;
  assert.equal(sent[0].added, undefined, "an item removed elsewhere borrows nothing");
  assert.equal(sent[1].added, "a", "a moved item rests on its own newer copy");
});

test("removing asks first, a linked entry is refused with the reason, and unresolved notes are reported", withDom(async () => {
  let refuse = true;
  const api = atlasApi({
    "DELETE research/atlas/entries": () => {
      if (refuse) throw new ApiError("linked", 422, { diagnostics: [{ code: "still-linked", collection: "relationships", id: "plato-authored-politeia", field: "from", message: "this relationship still joins the entry `plato`" }] });
      return { ...atlas({ revision: "r2", entries: ENTRIES().filter((entry) => entry.id !== "allegory") }), unresolvedNotes: ["note-2", "note-5"] };
    },
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("plato");
  await tick();
  assert.match(root.textContent, /1 relationship joins this entry, so it cannot be removed until it is removed/);
  globalThis.confirm = () => false;
  await root.querySelector("[data-atlas-remove]").click();
  assert.equal(api.calls.length, 0);
  globalThis.confirm = () => true;
  await root.querySelector("[data-atlas-remove]").click();
  assert.deepEqual(api.calls[0], { method: "DELETE", path: "research/atlas/entries", body: { revision: "r1", id: "plato" } });
  assert.match(root.textContent, /Relationship plato-authored-politeia: from: this relationship still joins/);
  assert.match(root.textContent, /The stored atlas is unchanged/);
  refuse = false;
  await root.querySelectorAll("button").find((button) => button.dataset.atlasEntry === "allegory").click();
  await tick();
  await root.querySelector("[data-atlas-remove]").click();
  assert.match(root.textContent, /2 notebook notes now link to a concept with no entry \(note-2, note-5\)/);
  assert.equal(entryIds(root).includes("allegory"), false);
  delete globalThis.confirm;
}));

test("a concept a note links to without an entry opens as a new concept with that identifier", withDom(async () => {
  const api = atlasApi({ "GET research/atlas": () => atlas({ missingConcepts: ["the-good"] }) });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("the-good");
  assert.equal(byId(root, "oba-atlas-heading").textContent, "New concept the-good");
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  assert.equal(byId(root, "oba-atlas-entry-id").value, "the-good");
  assert.equal(byId(root, "oba-atlas-entry-kind").value, "concept");
  assert.match(root.textContent, /No entry has the identifier the-good yet/);
  assert.ok(buttonLabelled(root, "Add concept the-good"), "missing concepts are offered from the list too");
  await type(byId(root, "oba-atlas-entry-label"), "The Good");
  assert.equal(byId(root, "oba-atlas-entry-id").value, "the-good", "the linked identifier is kept");
  const hostile = mountAtlas(atlasApi());
  await hostile.app.showAtlas("<script>");
  assert.equal(byId(hostile.root, "oba-atlas-heading").textContent, "Knowledge Atlas", "an invalid id opens nothing");
}));

test("notices and a damaged atlas are reported as text, never with a way to overwrite", withDom(async () => {
  const noticed = mountAtlas(atlasApi({
    "GET research/atlas": () =>
      atlas({
        notices: [
          { code: "private-endpoint", collection: "relationships", id: "plato-authored-politeia", field: "from", message: "the entry `plato` is private, so this approved relationship stays out of public output until the entry is approved" },
          { code: "unpublished-datings", collection: "entries", id: "plato", field: "dates", message: "`plato` is published, but none of its 1 dating can be, so public pages show no years for it" },
        ],
      }),
  }));
  await noticed.app.showAtlas();
  assert.match(noticed.root.textContent, /Relationship plato-authored-politeia, from: the entry `plato` is private/);
  const undated = noticed.root.querySelectorAll("li").find((item) => item.dataset.atlasNotice === "unpublished-datings");
  assert.match(undated.textContent, /^Entry plato, dates: `plato` is published, but none of its 1 dating can be/, "an entry's notice names the entry, not a relationship");
  const damaged = mountAtlas(atlasApi({
    "GET research/atlas": () => {
      throw new ApiError("bad", 422, { error: "invalid JSON", file: ".openblog/private/research/atlas.json", diagnostics: [{ message: "invalid JSON: eof" }] });
    },
  }));
  await damaged.app.showAtlas();
  assert.match(damaged.root.textContent, /The Knowledge Atlas could not be read/);
  assert.match(damaged.root.textContent, /Repair \.openblog\/private\/research\/atlas\.json by hand/);
  assert.equal(damaged.root.querySelectorAll("form").length, 0);
}));

test("every atlas control is labelled and grouped", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi());
  await app.showAtlas();
  await root.querySelectorAll("button").find((button) => button.dataset.atlasEntry === "plato").click();
  await tick();
  await root.querySelector("[data-atlas-open-relationship]").click();
  const form = root.querySelector("form");
  const labels = new Set(form.querySelectorAll("label").map((label) => label.getAttribute("for")));
  for (const control of [...form.querySelectorAll("input"), ...form.querySelectorAll("select"), ...form.querySelectorAll("textarea")]) {
    assert.ok(labels.has(control.id), `control ${control.id} has a label`);
  }
  assert.ok(form.querySelectorAll("legend").length >= 4, "parties, evidence and dissent are fieldsets with legends");
  assert.ok(buttonLabelled(form, "Remove evidence 1") && buttonLabelled(form, "Remove dissent 1") && buttonLabelled(form, "Add evidence to dissent 1"));
}));

// ---------------------------------------------------------------- chronology (ADR 0098)

const CHRONO_ENTRIES = () => {
  const entries = ENTRIES();
  entries[0].dates = [
    { id: "plato-born-a", aspect: "birth", date: { at: { year: -428, circa: true } }, assertedBy: { kind: "named", name: "Diogenes" }, confidence: "plausible", evidence: [{ source: "plato-republic" }], note: HOSTILE, visibility: "private" },
    { id: "plato-born-b", aspect: "birth", date: { at: { year: -427 } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" },
    { id: "plato-died", aspect: "death", date: { notAfter: { century: -6 } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" },
  ];
  entries[1].dates.push({ id: "politeia-after", aspect: "composition", date: { relative: { order: "after", entry: "plato", aspect: "birth" } }, assertedBy: { kind: "source", source: "plato-republic" }, confidence: "tentative", evidence: [{ source: "plato-republic" }], visibility: "approved" });
  entries[2].dates = [{ id: "allegory-unknown", aspect: "emergence", date: { unknown: true }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" }];
  return entries;
};
const placed = (id, owner, index, field, aspect, text, placement, startYear = null, endYear = null) => ({ id, owner, collection: "entries", index, field, aspect, text, placement, startYear, endYear, projected: false });
const CHRONOLOGY = () => ({
  timeline: [
    placed("plato-died", "plato", 0, "dates[2]", "death", "not after 6th century BCE", "dated", null, -501),
    placed("plato-born-a", "plato", 0, "dates[0]", "birth", "c. 428 BCE", "dated", -428, -428),
    placed("plato-born-b", "plato", 0, "dates[1]", "birth", "427 BCE", "dated", -427, -427),
    placed("politeia-composed", "politeia", 1, "dates[0]", "composition", "not before c. 380 BCE", "dated", -380, null),
    placed("politeia-after", "politeia", 1, "dates[1]", "composition", "after `plato` birth", "relative"),
    placed("allegory-unknown", "allegory", 2, "dates[0]", "emergence", "unknown", "unknown"),
  ],
  prompts: [
    { code: "death-before-birth", collection: "entries", index: 0, id: "plato", field: "dates[2]", datings: ["plato-died", "plato-born-a"], message: "death dating `plato-died` (not after 6th century BCE) ends before birth dating `plato-born-a` (c. 428 BCE) can begin, so as recorded they cannot both hold. They come from different parties: check the values against the cited evidence; a recorded disagreement can stay side by side as it is." },
    { code: "death-before-birth", collection: "entries", index: 0, id: "plato", field: "dates[2]", datings: ["plato-died", "plato-born-b"], message: "death dating `plato-died` (not after 6th century BCE) ends before birth dating `plato-born-b` (427 BCE) can begin, so as recorded they cannot both hold. They come from the same party: check the values against the cited evidence." },
  ],
  unlisted: 0,
});
const chronoAtlas = (over = {}) => atlas({ entries: CHRONO_ENTRIES(), chronology: CHRONOLOGY(), ...over });
const VERDICTS = /consensus|agreed|established|most likely|accepted date|correct date|true date/i;

test("points and dates read back at their stated precision, BCE written out, exactly as the core writes them", () => {
  assert.equal(atlasPointText({ decade: -380 }), "the 380s BCE");
  assert.equal(atlasPointText({ decade: 1380, circa: true }), "c. 1380s CE");
  assert.equal(atlasPointText({ century: -4 }), "4th century BCE");
  assert.equal(atlasPointText({ century: 21 }), "21st century CE");
  assert.equal(atlasPointText({ century: 12 }), "12th century CE");
  assert.equal(atlasPointText({ year: -428, circa: true }), "c. 428 BCE");
  assert.equal(atlasPointText({ year: 1380 }), "1380 CE");
  assert.equal(atlasPointText({ year: -44, month: 3, day: 15, calendar: "julian" }), "15 Mar 44 BCE (julian)");
  assert.equal(atlasPointText({ year: 0 }), "", "there is no year 0");
  assert.equal(atlasDateText({ notBefore: { year: -387, circa: true }, notAfter: { year: -367 } }), "between c. 387 BCE and 367 BCE");
  assert.equal(atlasDateText({ notAfter: { century: -6 } }), "not after 6th century BCE");
  assert.equal(atlasDateText({ from: { decade: -390 } }), "from the 390s BCE");
  assert.equal(atlasDateText({ to: { year: 5 } }), "until 5 CE");
  assert.equal(atlasDateText({ unknown: true }), "unknown");
  assert.equal(atlasDateText({ relative: { order: "after", entry: "plato", aspect: "active" } }), "after `plato` active");
  assert.equal(atlasDateText({ relative: { order: "after", entry: "plato", aspect: "active" } }, [{ id: "plato", label: "Plato" }]), "after the activity of Plato");
});

test("a dating round-trips exactly, keeps unknown fields at every level, and states BCE without a minus sign", () => {
  const stored = {
    id: "d1", aspect: "composition", shelf: { kept: true },
    date: { notBefore: { year: -387, circa: true, hint: 1 }, notAfter: { decade: -360 }, margin: 2 },
    assertedBy: { kind: "named", name: "Nails", why: "kept" }, confidence: "plausible",
    evidence: [{ source: "plato-republic", locators: [{ kind: "page", value: "9" }], tag: "kept" }],
    note: "Reckoned by archon years.", visibility: "approved",
  };
  const draft = atlasDatingDraft(stored);
  assert.deepEqual(atlasDatingPayload(draft), stored, "an untouched dating round-trips exactly");
  assert.equal(draft.form, "window");
  assert.deepEqual([draft.points.notBefore.magnitude, draft.points.notBefore.era, draft.points.notBefore.precision], ["387", "bce", "year"]);
  assert.deepEqual([draft.points.notAfter.magnitude, draft.points.notAfter.precision], ["360", "decade"]);
  draft.points.notBefore.magnitude = "390";
  draft.points.notBefore.circa = false;
  draft.note = "Edited.";
  const edited = atlasDatingPayload(draft);
  assert.deepEqual(edited.date, { notBefore: { year: -390, hint: 1 }, notAfter: { decade: -360 }, margin: 2 });
  assert.equal(edited.shelf.kept, true);
  assert.equal(edited.assertedBy.why, "kept");
  assert.equal(edited.evidence[0].tag, "kept");
  // Switching form keeps the date's own unknown fields and only the slots of the new form.
  draft.form = "at";
  draft.points.at = { ...draft.points.at, precision: "day", magnitude: "44", era: "bce", month: "3", day: "15", calendar: "julian" };
  assert.deepEqual(atlasDatingPayload(draft).date, { at: { year: -44, month: 3, day: 15, calendar: "julian" }, margin: 2 });
  assert.equal(atlasDatingReading(draft), "15 Mar 44 BCE (julian)");
  draft.points.at.precision = "century";
  draft.points.at.magnitude = "4";
  assert.deepEqual(atlasDatingPayload(draft).date.at, { century: -4 }, "a calendar only goes with a month");
  // An open end stays open, and a stored open start is not filled in.
  const open = atlasDatingDraft({ id: "d2", aspect: "active", date: { to: { year: -347 } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" });
  assert.equal(open.points.from.precision, "open");
  assert.deepEqual(atlasDatingPayload(open).date, { to: { year: -347 } });
  const relative = atlasDatingDraft({ id: "d3", aspect: "composition", date: { relative: { order: "after", entry: "phaedo", aspect: "composition", why: "kept" } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" });
  assert.deepEqual(atlasDatingPayload(relative).date, { relative: { order: "after", entry: "phaedo", aspect: "composition", why: "kept" } });
  const unknown = atlasDatingDraft({ id: "d4", aspect: "birth", date: { unknown: true }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" });
  assert.deepEqual(atlasDatingPayload(unknown).date, { unknown: true });
  assert.equal(atlasDatingReading(atlasDatingDraft(null, { aspect: "birth" })), "not complete yet");
});

test("advisory dating checks constrain the aspect by kind and name the control to fix", () => {
  const context = (over = {}) => ({ owner: "person", ownerId: "plato", kinds: KINDS(), entries: ENTRIES(), sources: SOURCES(), passages: PASSAGES(), used: ["plato", "politeia"], ...over });
  const dating = (over = {}) => Object.assign(atlasDatingDraft({ id: "plato-born", aspect: "birth", date: { at: { year: -428 } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" }), over);
  const field = (list, over) => validateAtlasDatings(list, context(over))?.field ?? null;
  assert.equal(field([dating()]), null);
  assert.equal(field([dating({ id: "Plato Born" })]), "dating-0-id");
  assert.equal(field([dating({ id: "politeia" })]), "dating-0-id", "one identifier space");
  assert.equal(field([dating(), dating()]), "dating-1-id");
  assert.equal(field([dating({ aspect: "composition" })]), "dating-0-aspect", "a person has no composition");
  assert.equal(field([dating({ aspect: "span" })], { owner: "relationship", ownerId: "" }), null);
  assert.equal(field([dating()], { owner: "relationship", ownerId: "" }), "dating-0-aspect", "a relationship is dated only by its span");
  assert.equal(field([dating({ form: "range" })]), "dating-0-form", "a birth is a window, not a duration");
  const year = (magnitude, precision = "year", extra = {}) => dating({ points: { ...dating().points, at: { ...dating().points.at, magnitude, precision, ...extra } } });
  assert.equal(field([year("0")]), "dating-0-at-value", "there is no year 0");
  assert.equal(field([year("-428")]), "dating-0-at-value", "BCE is chosen, never typed as a minus sign");
  assert.equal(field([year("385", "decade")]), "dating-0-at-value");
  assert.equal(field([year("380", "decade")]), null);
  assert.equal(field([year("428", "month")]), "dating-0-at-month");
  assert.equal(field([year("428", "day", { month: "2", day: "30" })]), "dating-0-at-day");
  assert.equal(field([year("428", "day", { month: "2", day: "29" })]), null, "February may have 29 days");
  const window = (start, end) => {
    const value = dating({ form: "window" });
    value.points.notBefore = { ...value.points.notBefore, ...start };
    value.points.notAfter = { ...value.points.notAfter, ...end };
    return value;
  };
  assert.equal(field([window({ precision: "open" }, { precision: "open" })]), "dating-0-not-before-precision");
  assert.equal(field([window({ precision: "year", magnitude: "300", era: "bce" }, { precision: "year", magnitude: "400", era: "bce" })]), "dating-0-not-after-value", "a window that starts after it ends");
  assert.equal(field([window({ precision: "year", magnitude: "400", era: "bce" }, { precision: "century", magnitude: "4", era: "bce" })]), null);
  const relative = (rel) => dating({ aspect: "death", form: "relative", relative: { extras: {}, order: "after", entry: "", aspect: "", ...rel } });
  assert.equal(field([relative({})]), "dating-0-relative-entry");
  assert.equal(field([relative({ entry: "politeia", aspect: "birth" })]), "dating-0-relative-aspect", "a work has no birth");
  assert.equal(field([relative({ entry: "politeia", aspect: "publication", order: "during" })]), "dating-0-relative-aspect", "during needs an aspect that lasts");
  assert.equal(field([relative({ entry: "plato", aspect: "death" })]), "dating-0-relative-aspect", "not against the aspect it dates");
  assert.equal(field([relative({ entry: "politeia", aspect: "composition", order: "during" })]), null);
  assert.equal(field([dating({ unsourced: false })]), "dating-0-evidence");
  assert.equal(field([dating({ confidence: "strong" })]), "dating-0-confidence");
  assert.equal(field([dating({ approved: true })]), "dating-0-approved");
  assert.equal(field([dating({ unsourced: false, approved: true, evidence: [atlasEvidenceDraft({ source: "slings-2003", passage: "passage-1" })] })]), "dating-0-approved");
  const named = dating();
  named.assertedBy.kind = "named";
  assert.equal(field([named]), "dating-0-asserted-name");
});

test("a dating draft rests on the newer stored datings by identity, never by position", () => {
  const stored = (id, over = {}) => ({ id, aspect: "birth", date: { at: { year: -428 } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private", ...over });
  const opened = [stored("a"), stored("b", { date: { at: { year: -427 } } }), stored("gone-here"), stored("gone-there")];
  const datings = opened.map((item) => atlasDatingDraft(item));
  datings.splice(2, 1); // the author removes `gone-here`
  datings[1].note = "Mine.";
  datings.push(atlasDatingDraft(null, { id: "new", aspect: "death" }));
  // Elsewhere: the list is reordered, `gone-there` removed, `c` added, and fields added to `a` and `b`.
  const newer = [
    stored("c", { aspect: "death" }),
    stored("b", { date: { at: { year: -427, hint: "elsewhere" }, margin: 1 }, shelf: "elsewhere" }),
    stored("gone-here"),
    stored("a", { assertedBy: { kind: "author", why: "elsewhere" } }),
  ];
  const added = rebaseAtlasDatings(datings, newer, opened);
  assert.equal(added, 1);
  const sent = datings.map(atlasDatingPayload);
  assert.deepEqual(sent.map((item) => item.id), ["a", "b", "gone-there", "new", "c"]);
  assert.equal(sent[0].assertedBy.why, "elsewhere", "a moved dating rests on its own newer copy");
  assert.deepEqual(sent[1].date, { at: { year: -427, hint: "elsewhere" }, margin: 1 });
  assert.equal(sent[1].shelf, "elsewhere");
  assert.equal(sent[1].note, "Mine.", "the draft's own edit wins");
  assert.equal(sent[2].shelf, undefined, "a dating removed elsewhere keeps the draft's copy and borrows nothing");
  assert.ok(!sent.some((item) => item.id === "gone-here"), "a dating the author removed is not brought back");

  const entry = atlasEntryDraft({ ...ENTRIES()[1] });
  entry.label = "Republic";
  const current = { ...ENTRIES()[1], added: "elsewhere" };
  current.dates = [{ ...current.dates[0], shelf: "elsewhere" }];
  rebaseAtlasEntryDraft(entry, current);
  const payload = atlasEntryPayload(entry);
  assert.equal(payload.added, "elsewhere");
  assert.equal(payload.dates[0].shelf, "elsewhere");
  assert.equal(payload.label, "Republic");
});

test("the chronology model keeps competing datings together and never flattens them under a filter", () => {
  const state = { entries: CHRONO_ENTRIES(), relationships: [], chronology: CHRONOLOGY(), kinds: KINDS(), sources: SOURCES() };
  const all = atlasChronologyModel(state, {});
  assert.deepEqual(all.rows.map((row) => row.key), ["entries:plato:death", "entries:plato:birth", "entries:politeia:composition", "entries:allegory:emergence"]);
  assert.deepEqual(all.rows[1].datings.map((dating) => dating.id), ["plato-born-a", "plato-born-b"], "competing datings side by side, in the index's order");
  assert.deepEqual(all.groups.map((group) => group.label), ["No earliest point stated (open start)", "5th century BCE", "4th century BCE"]);
  assert.deepEqual(all.unplaced.map((row) => row.key), ["entries:allegory:emergence"], "an unknown date is never placed in time");
  assert.deepEqual(all.relative.map(({ dating }) => dating.id), ["politeia-after"]);
  assert.equal(all.rows[0].datings[0].prompts, 2);
  assert.equal(atlasChronologyStatus(all, {}), "Showing 4 of 4 dated aspects (6 of 6 datings); grouped by the century each begins in.");

  const narrow = { fromYear: "430", fromEra: "bce", toYear: "428", toEra: "bce", zoom: "decade" };
  const windowed = atlasChronologyModel(state, narrow);
  assert.deepEqual(windowed.groups.map((group) => group.rows.map((row) => row.key)), [["entries:plato:birth"]]);
  assert.equal(windowed.groups[0].label, "the 420s BCE");
  const [inside, outside] = windowed.groups[0].rows[0].datings;
  assert.deepEqual([inside.inWindow, outside.inWindow], [true, false], "the competitor outside the window stays, marked");
  assert.deepEqual(windowed.unplaced.map((row) => row.key), ["entries:allegory:emergence"]);
  assert.equal(atlasChronologyStatus(windowed, narrow), "Showing 2 of 4 dated aspects (3 of 6 datings); from 430 BCE; to 428 BCE; grouped by the decade each begins in.");

  assert.deepEqual(atlasChronologyModel(state, { aspect: "birth" }).groups.flatMap((group) => group.rows.map((row) => row.key)), ["entries:plato:birth"]);
  assert.deepEqual(atlasChronologyModel(state, { competing: true }).groups.flatMap((group) => group.rows.map((row) => row.key)), ["entries:plato:birth", "entries:politeia:composition"]);
  assert.deepEqual(atlasChronologyModel(state, { prompted: true }).groups.flatMap((group) => group.rows.map((row) => row.key)), ["entries:plato:death", "entries:plato:birth"]);
  assert.deepEqual(atlasChronologyModel(state, { query: "politeia" }).groups.flatMap((group) => group.rows.map((row) => row.key)), ["entries:politeia:composition"]);
  assert.equal(atlasChronologyModel(state, { zoom: "none" }).groups.length, 1);
  assert.match(atlasChronologyWindow({ fromYear: "300", fromEra: "bce", toYear: "400", toEra: "bce" }).problem, /starts after it ends/);
  assert.match(atlasChronologyWindow({ fromYear: "0" }).problem, /no year 0/);
  assert.equal(atlasChronologyGroupLabel(-428, "century"), "5th century BCE");
  assert.equal(atlasChronologyGroupLabel(-400, "century"), "4th century BCE");
  assert.equal(atlasChronologyGroupLabel(-1, "decade"), "1 to 9 BCE");
  assert.equal(atlasChronologyGroupLabel(1, "century"), "1st century CE");
  assert.equal(atlasChronologyGroupLabel(1999, "decade"), "the 1990s CE");
  assert.equal(atlasChronologyGroupLabel(-44, "year"), "44 BCE");
  const empty = atlasChronologyModel({ entries: [], relationships: [], chronology: { timeline: [], prompts: [], unlisted: 0 } }, {});
  assert.equal(atlasChronologyStatus(empty, {}), "Showing 0 of 0 dated aspects (0 of 0 datings); grouped by the century each begins in.");
});

test("a dating is authored in the entry editor from the keyboard, with only the aspects its kind has", withDom(async () => {
  const api = atlasApi({
    "PUT research/atlas/entries": (body) => ({ ...atlas({ revision: "r2", entries: [body.entry, ...ENTRIES().slice(1)] }), entry: body.entry }),
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("plato");
  await tick();
  await buttonLabelled(root, "Add a dating").click();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-entry-dating-0-aspect");
  assert.deepEqual(options(byId(root, "oba-atlas-entry-dating-0-aspect")), ["span", "birth", "death", "active"]);
  assert.equal(byId(root, "oba-atlas-entry-dating-0-id").value, "plato-span");
  await choose(byId(root, "oba-atlas-entry-dating-0-aspect"), "birth");
  assert.equal(byId(root, "oba-atlas-entry-dating-0-id").value, "plato-birth", "the suggested id follows the aspect");
  assert.equal(byId(root, "oba-atlas-entry-dating-0-form-range").disabled, true, "a birth cannot be a duration");
  const windowForm = byId(root, "oba-atlas-entry-dating-0-form-window");
  windowForm.checked = true;
  await windowForm.dispatch("change");
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-entry-dating-0-form-window");
  await choose(byId(root, "oba-atlas-entry-dating-0-not-before-precision"), "decade");
  await type(byId(root, "oba-atlas-entry-dating-0-not-before-value"), "420");
  await choose(byId(root, "oba-atlas-entry-dating-0-not-before-era"), "bce");
  assert.equal(byId(root, "oba-atlas-entry-dating-0-not-after-precision").value, "open");
  assert.equal(byId(root, "oba-atlas-entry-dating-0-reads").textContent, "Reads: not before the 420s BCE");
  const named = byId(root, "oba-atlas-entry-dating-0-asserted-is-named");
  named.checked = true;
  await named.dispatch("change");
  await type(byId(root, "oba-atlas-entry-dating-0-asserted-name"), "Diogenes Laertius");
  await submit(root);
  assert.equal(api.calls.length, 0, "a dating needs evidence or the draft state");
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-entry-dating-0-evidence");
  assert.match(byId(root, "oba-atlas-entry-error").textContent, /Add evidence to dating 1, or mark it as an unsourced draft/);
  const unsourced = byId(root, "oba-atlas-entry-dating-0-unsourced");
  unsourced.checked = true;
  await unsourced.dispatch("change", { target: unsourced });
  await submit(root);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body.entry.dates, [
    { id: "plato-birth", aspect: "birth", date: { notBefore: { decade: -420 } }, assertedBy: { kind: "named", name: "Diogenes Laertius" }, confidence: "tentative", unsourced: true, visibility: "private" },
  ]);
  assert.equal(api.calls[0].body.entry.shelf, 1, "the entry's unknown fields survive");
}));

test("a refused dating is scoped to its control, keeps the draft and says nothing was stored", withDom(async () => {
  const api = atlasApi({
    "GET research/atlas": () => chronoAtlas(),
    "PUT research/atlas/entries": () => {
      throw new ApiError("invalid", 422, { error: "invalid", diagnostics: [{ code: "invalid-date", collection: "entries", id: "plato", field: "dates[1].date.at.year", message: "must be a whole year between -100000 and 100000; negative is BCE and there is no year 0" }] });
    },
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("plato");
  await tick();
  await type(byId(root, "oba-atlas-entry-dating-1-note"), "Edited note");
  await submit(root);
  assert.equal(api.calls.length, 1);
  const sent = api.calls[0].body.entry.dates;
  assert.deepEqual(sent.map((dating) => dating.id), ["plato-born-a", "plato-born-b", "plato-died"]);
  assert.equal(sent[0].note, HOSTILE, "untouched datings are sent as stored");
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-entry-dating-1-at-value");
  assert.equal(byId(root, "oba-atlas-entry-dating-1-at-value").getAttribute("aria-invalid"), "true");
  assert.match(root.textContent, /Not saved\. The stored atlas is unchanged\./);
  assert.equal(byId(root, "oba-atlas-entry-dating-1-note").value, "Edited note");
}));

test("a relationship is dated only by its span, and a relative dating offers only aspects the other entry has", withDom(async () => {
  const api = atlasApi({
    "PUT research/atlas/relationships": (body) => ({ ...atlas({ revision: "r2", relationships: [body.relationship] }), relationship: body.relationship }),
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("plato");
  await tick();
  await root.querySelector("[data-atlas-open-relationship]").click();
  await buttonLabelled(root, "Add a dating").click();
  assert.deepEqual(options(byId(root, "oba-atlas-relationship-dating-0-aspect")), ["span"]);
  assert.equal(byId(root, "oba-atlas-relationship-dating-0-id").value, "plato-authored-politeia-span");
  const relative = byId(root, "oba-atlas-relationship-dating-0-form-relative");
  relative.checked = true;
  await relative.dispatch("change");
  assert.deepEqual(options(byId(root, "oba-atlas-relationship-dating-0-relative-aspect")), [], "no aspect before an entry is chosen");
  await choose(byId(root, "oba-atlas-relationship-dating-0-relative-entry"), "politeia");
  assert.deepEqual(options(byId(root, "oba-atlas-relationship-dating-0-relative-aspect")), ["span", "composition", "publication"]);
  await choose(byId(root, "oba-atlas-relationship-dating-0-relative-order"), "during");
  assert.deepEqual(options(byId(root, "oba-atlas-relationship-dating-0-relative-aspect")), ["span", "composition"], "during offers only aspects that last");
  await choose(byId(root, "oba-atlas-relationship-dating-0-relative-aspect"), "composition");
  assert.equal(byId(root, "oba-atlas-relationship-dating-0-reads").textContent, "Reads: during the composition of Politeia");
  const unsourced = byId(root, "oba-atlas-relationship-dating-0-unsourced");
  unsourced.checked = true;
  await unsourced.dispatch("change", { target: unsourced });
  await submit(root);
  assert.equal(api.calls.length, 1, byId(root, "oba-atlas-relationship-error").textContent);
  const sent = api.calls[0].body.relationship;
  assert.deepEqual(sent.dates[0].date, { relative: { order: "during", entry: "politeia", aspect: "composition" } });
  assert.equal(sent.extra, 7);
  assert.equal(sent.contestedBy[0].tag, "kept");
}));

test("keeping an entry draft after a conflict rests its datings on the stored ones by identity and keeps datings added elsewhere", withDom(async () => {
  const opened = CHRONO_ENTRIES()[0];
  const newer = structuredClone(opened);
  newer.dates = [
    { ...opened.dates[2], shelf: "elsewhere" },
    { id: "plato-born-c", aspect: "birth", date: { at: { year: -429 } }, assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" },
    opened.dates[1],
    { ...opened.dates[0], date: { at: { year: -428, circa: true, hint: "elsewhere" } } },
  ];
  let reads = 0;
  const api = atlasApi({
    "GET research/atlas": () => (reads++ ? chronoAtlas({ revision: "r9", entries: [newer, ...CHRONO_ENTRIES().slice(1)] }) : chronoAtlas()),
    "PUT research/atlas/entries": (body) => {
      if (body.revision !== "r9") throw new ApiError("changed", 409, { conflict: true, revision: "r9", current: newer });
      return { ...chronoAtlas({ revision: "r10", entries: [body.entry, ...CHRONO_ENTRIES().slice(1)] }), entry: body.entry };
    },
  });
  const { app, root } = mountAtlas(api);
  await app.showAtlas("plato");
  await tick();
  await type(byId(root, "oba-atlas-entry-dating-1-note"), "My doubt.");
  await submit(root);
  await buttonLabelled(root, "Keep my draft").click();
  assert.match(root.querySelector("form").textContent, /1 dating added elsewhere was added to your draft/);
  assert.equal(byId(root, "oba-atlas-entry-dating-1-note").value, "My doubt.");
  await submit(root);
  assert.equal(api.calls.length, 2);
  const sent = api.calls[1].body.entry.dates;
  assert.deepEqual(sent.map((dating) => dating.id), ["plato-born-a", "plato-born-b", "plato-died", "plato-born-c"]);
  assert.equal(sent[0].date.at.hint, "elsewhere", "a point keeps a field added elsewhere though the dating moved");
  assert.equal(sent[1].note, "My doubt.");
  assert.equal(sent[2].shelf, "elsewhere");
}));

test("the chronology explorer lists every dating as text, side by side, with keyboard filters and visible state", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi({ "GET research/atlas": () => chronoAtlas() }));
  await app.showAtlas();
  await buttonLabelled(root, "Chronology").click();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-heading");
  assert.equal(byId(root, "oba-atlas-heading").textContent, "Chronology");
  const status = root.querySelector("[data-chronology-status]");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.textContent, "Showing 4 of 4 dated aspects (6 of 6 datings); grouped by the century each begins in.");
  const timeline = root.querySelector("[data-chronology-timeline]");
  assert.equal(timeline.querySelectorAll("ol")[0].tagName, "OL", "the timeline is an ordered list, never a drawing");
  assert.deepEqual(timeline.querySelectorAll("h4").map((heading) => heading.textContent), ["No earliest point stated (open start) (1 dated aspect)", "5th century BCE (1 dated aspect)", "4th century BCE (1 dated aspect)"]);
  const births = root.querySelectorAll("li").find((item) => item.dataset.chronologyRow === "entries:plato:birth");
  assert.equal(births.querySelector("p[data-chronology-competing]").dataset.chronologyCompeting, "2");
  assert.match(births.textContent, /2 competing datings, side by side\. None is preferred/);
  assert.match(births.textContent, /c\. 428 BCE \(dating plato-born-a\)/);
  assert.match(births.textContent, /427 BCE \(dating plato-born-b\)/);
  assert.match(births.textContent, /Dated by Diogenes/);
  assert.match(births.textContent, /Dated by you \(the author\)/);
  assert.match(births.textContent, /Plausible confidence, as held by that party/);
  assert.ok(births.textContent.includes(`Note: ${HOSTILE}`));
  assert.equal(root.querySelectorAll("img").length + root.querySelectorAll("script").length, 0, "hostile text stays text");
  assert.doesNotMatch(root.querySelector("[data-chronology-timeline]").textContent, VERDICTS);
  const unplaced = root.querySelector("[data-chronology-unplaced]");
  assert.match(unplaced.textContent, /Not placed in time \(1\)/);
  assert.match(unplaced.textContent, /Unknown, as the party states/);
  const relative = root.querySelector("[data-chronology-relative]");
  assert.match(relative.textContent, /Composition of Politeia: after the birth of /);
  const prompts = root.querySelector("[data-chronology-prompts]");
  assert.match(prompts.textContent, /Datings to check \(2\)/);
  assert.match(prompts.textContent, /Prompts, never verdicts/);
  assert.equal(prompts.querySelectorAll("li").filter((item) => item.dataset.chronologyPrompt).length, 2);
  assert.match(prompts.textContent, /Check: death dating `plato-died`/);

  // Zoom and filter from the keyboard: every control is a labelled form control, and the state is said in words.
  await type(byId(root, "oba-chronology-from"), "430");
  await type(byId(root, "oba-chronology-to"), "428");
  await choose(byId(root, "oba-chronology-to-era"), "bce");
  await choose(byId(root, "oba-chronology-zoom"), "decade");
  assert.equal(root.querySelector("[data-chronology-status]").textContent, "Showing 2 of 4 dated aspects (3 of 6 datings); from 430 BCE; to 428 BCE; grouped by the decade each begins in.");
  assert.equal(byId(root, "oba-chronology-zoom").value, "decade", "the zoom level stays visible in its control");
  const outside = root.querySelectorAll("li").find((item) => item.dataset.chronologyDating === "plato-born-b");
  assert.equal(outside.dataset.inWindow, "false");
  assert.match(outside.textContent, /Outside the time window; listed because a competing dating falls inside it/);
  assert.deepEqual(root.querySelector("[data-chronology-timeline]").querySelectorAll("h4").map((heading) => heading.textContent), ["the 420s BCE (1 dated aspect)"]);
  await choose(byId(root, "oba-chronology-from-era"), "ce");
  assert.match(root.querySelector("[data-chronology-status]").textContent, /starts after it ends, so it is not applied/);
  await buttonLabelled(root, "Clear filters").click();
  assert.equal(globalThis.document.activeElement.id, "oba-chronology-query");
  assert.match(root.querySelector("[data-chronology-status]").textContent, /^Showing 4 of 4 dated aspects/);
  const competing = byId(root, "oba-chronology-competing");
  competing.checked = true;
  await competing.dispatch("change", { target: competing });
  assert.match(root.querySelector("[data-chronology-status]").textContent, /only aspects with competing datings/);

  // A check prompt links to the item and lands on the dating it starts from.
  await root.querySelectorAll("button").find((button) => button.dataset.atlasCheck === "plato-died").click();
  assert.equal(globalThis.document.activeElement.id, "oba-atlas-entry-dating-2");
  assert.equal(byId(root, "oba-atlas-heading").textContent, HOSTILE);
}));

test("an entry shows its own chronology, the relative datings that point at it, and its check prompts", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi({ "GET research/atlas": () => chronoAtlas() }));
  await app.showAtlas("plato");
  await tick();
  const own = root.querySelector("[data-atlas-chronology-of]");
  assert.ok(own.textContent.startsWith(`Chronology of ${HOSTILE}`));
  assert.deepEqual(own.querySelectorAll("li").filter((item) => item.dataset.chronologyRow).map((item) => item.dataset.chronologyRow), ["entries:plato:death", "entries:plato:birth"]);
  assert.match(own.textContent, /Composition of Politeia: after the birth of /);
  assert.match(own.textContent, /Datings to check \(2\)/);
  assert.doesNotMatch(own.textContent, VERDICTS);
  const empty = mountAtlas(atlasApi());
  await empty.app.showAtlas();
  await buttonLabelled(empty.root, "Chronology").click();
  assert.match(empty.root.querySelector("[data-chronology-empty]").textContent, /^No datings yet\./);
  assert.match(empty.root.querySelector("[data-chronology-prompts]").textContent, /Nothing to check/);
}));

test("every dating control and chronology filter is labelled, and the datings are grouped in fieldsets", withDom(async () => {
  const { app, root } = mountAtlas(atlasApi({ "GET research/atlas": () => chronoAtlas() }));
  await app.showAtlas("politeia");
  await tick();
  const form = root.querySelector("form");
  const labels = new Set(form.querySelectorAll("label").map((label) => label.getAttribute("for")));
  const controls = [...form.querySelectorAll("input"), ...form.querySelectorAll("select"), ...form.querySelectorAll("textarea")];
  assert.ok(controls.some((control) => control.id === "oba-atlas-entry-dating-1-relative-entry"));
  for (const control of controls) assert.ok(labels.has(control.id), `control ${control.id} has a label`);
  assert.ok(form.querySelectorAll("fieldset").filter((set) => set.dataset.atlasDating !== undefined).length === 2);
  assert.ok(buttonLabelled(form, "Remove dating 2") && buttonLabelled(form, "Add evidence to dating 2"));
  await buttonLabelled(root, "Chronology").click();
  const panel = byId(root, "oba-chronology-results").parent;
  const filterLabels = new Set(panel.querySelectorAll("label").map((label) => label.getAttribute("for")));
  for (const control of [...panel.querySelectorAll("input"), ...panel.querySelectorAll("select")]) assert.ok(filterLabels.has(control.id), `filter ${control.id} has a label`);
}));

// ---------------------------------------------------------------- wiring

test("a note's concepts link to their atlas entries from the notebook", withDom(async () => {
  const api = {
    async call(method, path) {
      if (path === "research/backlinks") return { entries: [] };
      if (method === "GET" && path === "research/notebook") {
        return { file: ".openblog/private/research/notebook.json", revision: "r1", stored: true, sources: SOURCES(), passages: [], notes: [{ id: "note-2", kind: "question", text: "Why a cave?", concepts: ["allegory", "the-good"], visibility: "private" }] };
      }
      throw new ApiError(`unexpected ${method} ${path}`, 500, null);
    },
  };
  const { app, root } = mountAtlas(api);
  await app.showResearch();
  await root.querySelectorAll("button").find((button) => button.dataset.entryId === "note-2").click();
  const links = root.querySelector("[data-atlas-concepts]").querySelectorAll("a");
  assert.deepEqual(links.map((link) => link.getAttribute("href")), ["#/research/atlas/allegory", "#/research/atlas/the-good"]);
}));

test("the atlas is reachable from the research workspace, the palette and the router", () => {
  assert.equal(researchHref("atlas", "the good"), "#/research/atlas/the%20good");
  assert.equal(canonicalAdminHash("#/atlas/plato"), "#/research/atlas/plato", "the earlier address redirects");
  assert.match(admin, /panel === "atlas"\) await this\.showAtlas\(id\)/);
  assert.match(admin, /label: "Knowledge Atlas", category: "Research"/);
  assert.equal(safeDecodeURIComponent("the%20good"), "the good");
  assert.equal(safeDecodeURIComponent("%E0%A4%A"), "");
});

test("a save says whether the published atlas was rebuilt, only when the site publishes it", () => {
  assert.equal(atlasBuildText(undefined), "");
  assert.equal(atlasBuildText({ ok: true, files: 9 }), " The published Knowledge Atlas was rebuilt.");
  assert.equal(atlasBuildText({ ok: false, error: "the Knowledge Atlas cannot be published" }), " The change is saved, but the site could not be rebuilt: the Knowledge Atlas cannot be published");
});

test("atlas code never parses text as markup and announces changes", () => {
  const helpers = admin.slice(admin.indexOf("// ---------------------------------------------------------------- knowledge atlas"), admin.indexOf("export const SHARED_SOURCE_KINDS"));
  const view = admin.slice(admin.indexOf("  // ---- knowledge atlas"), admin.indexOf("  // ---- shared reflections"));
  for (const code of [helpers, view]) assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|createContextualFragment|<canvas|<svg/);
  assert.match(helpers, /role: "alert"/);
  assert.match(helpers, /"aria-live": "polite"/);
  assert.match(view, /"aria-live": "polite"/);
  assert.match(helpers, /aria-invalid/);
  assert.match(helpers, /h\("legend"/);
});

test("atlas styles keep focus visible, targets large, text wrapping, and add no motion", () => {
  const css = styles.slice(styles.indexOf("/* Knowledge Atlas"), styles.indexOf("/* Anchors styled as buttons"));
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 40rem\)/);
  assert.doesNotMatch(css, /transition|animation/);
});
