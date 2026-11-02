import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ObAdmin,
  alignmentDiagnosticControl,
  alignmentDraft,
  alignmentErrorMessage,
  alignmentPayload,
  applyAlignmentState,
  comparisonBuildText,
  comparisonColumns,
  comparisonExportText,
  interpretersText,
  languageTag,
  locatorText,
  normalizeAdminPreferences,
  publicPlaceText,
  rebaseAlignmentDraft,
  rightsText,
  rightsToConfirm,
  textDirection,
  validateAlignmentDraft,
  versionMakerText,
  canonicalAdminHash,
  researchHref,
} from "../../web/admin/admin.js";

// The comparison workspace (A6.3, ADR 0090 and ADR 0091): aligned places across versions side by
// side or in one column, original wording exactly with its direction, labelled normalizations,
// explicit absences, attribution on every place, copying only what is selected after the rights
// statements are read, and alignment editing that keeps the draft through a conflict.

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
  // Reflected like the browser's: `dir` and `lang` read their attributes, so code and tests that use either agree.
  get dir() {
    return this.attributes.dir ?? "";
  }
  get lang() {
    return this.attributes.lang ?? "";
  }
  get readOnly() {
    return "readonly" in this.attributes;
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
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
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
  globalThis.location = { hash: "#/compare" };
  const clipboard = { writes: [], fail: false, async writeText(text) { if (this.fail) throw new Error("denied"); this.writes.push(text); } };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true, writable: true });
  const downloads = { made: [], revoked: [] };
  URL.createObjectURL = (blob) => {
    downloads.made.push(blob);
    return `blob:test/${downloads.made.length}`;
  };
  URL.revokeObjectURL = (url) => downloads.revoked.push(url);
  return {
    document: documentShim,
    clipboard,
    downloads,
    restore() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
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

const HOSTILE = '<img src=x onerror="alert(1)"> 🙂 <script>alert(2)</script>';
// Hebrew with a decomposed vowel point (U+05B0 after its letter) and hostile markup, kept exactly.
const HEBREW = `ירדְתי אתמול ${HOSTILE}`;
const GREEK = "κατέβην χθὲς εἰς Πειραιᾶ\n  μετὰ Γλαύκωνος";
const RIGHTS = {
  publicDomain: { status: "publicDomain", label: "The author states the text is in the public domain", declared: true, note: "Published 2003, edition text ancient" },
  rightsReserved: { status: "rightsReserved", label: "The author states the text is under copyright", declared: true },
  unknown: { status: "unknown", label: "Rights not checked yet", declared: false },
  openLicense: { status: "openLicense", label: "The author states the text is under an open licence", declared: true, license: "CC-BY-4.0" },
};
const SOURCES = () => [
  { id: "plato", kind: "work", title: "Πολιτεία", chain: [] },
  { id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam", creators: [{ name: "S. R. Slings", role: "editor", attribution: "stated" }], chain: [{ id: "plato", kind: "work", title: "Πολιτεία" }], rightsStatus: RIGHTS.publicDomain },
  { id: "bloom", kind: "translation", of: "plato", language: "en", title: "The Republic of Plato", creators: [{ name: "Allan Bloom", role: "translator", attribution: "attributed", note: "second edition" }], chain: [{ id: "plato", kind: "work", title: "Πολιτεία" }], rightsStatus: RIGHTS.rightsReserved },
  { id: "he", kind: "translation", of: "plato", language: "he", title: "פוליטאה", anonymous: true, chain: [{ id: "plato", kind: "work", title: "Πολιτεία" }], rightsStatus: RIGHTS.unknown },
  { id: "ms", kind: "witness", of: "plato", title: "Paris gr. 1807", repository: "BnF", shelfmark: "gr. 1807", volumes: 2, creators: [{ name: "John the Calligrapher", role: "scribe", attribution: "disputed" }], chain: [{ id: "plato", kind: "work", title: "Πολιτεία" }], rightsStatus: RIGHTS.openLicense },
  { id: "slings-2", kind: "edition", of: "plato", title: "Slings revised", revises: "slings", chain: [{ id: "plato", kind: "work", title: "Πολιτεία" }], rightsStatus: RIGHTS.unknown },
  { id: "gone", kind: "edition", of: "plato", title: "Gone", archived: true, chain: [{ id: "plato", kind: "work", title: "Πολιτεία" }], rightsStatus: RIGHTS.unknown },
];
const PASSAGES = () => [
  { id: "p-gr", source: "slings", excerpt: { text: GREEK, language: "grc" }, locators: [{ kind: "canonical", value: "327a" }], visibility: "private" },
  { id: "p-en1", source: "bloom", excerpt: { text: "I went down to the Piraeus yesterday", language: "en" }, locators: [{ kind: "canonical", value: "327a" }], visibility: "private" },
  { id: "p-en2", source: "bloom", excerpt: { text: "with Glaucon", language: "en" }, locators: [{ kind: "canonical", value: "327a", to: "327b" }], visibility: "private" },
  { id: "p-he", source: "he", excerpt: { text: HEBREW, language: "he" }, locators: [{ kind: "page", value: "3" }], visibility: "private" },
];
const INTERPRETATIONS = () => [
  { id: "mine", kind: "rendering", source: "slings", locators: [{ kind: "canonical", value: "327a" }], language: "en", text: "Down I went, yesterday", interpreters: [{ contributor: "ada", display: "Ada <b>Lovelace</b>", attribution: "uncertain" }], rightsStatus: { status: "ownWork", label: "The author states the text is their own work", declared: true } },
  { id: "gloss", kind: "reading", source: "ms", text: "A gloss", anonymous: true, rightsStatus: RIGHTS.unknown },
];
const OPENING = () => ({
  id: "opening",
  label: "Opening: the descent",
  correspondence: "partial",
  members: [
    { source: "slings", passage: "p-gr", locators: [{ kind: "canonical", value: "327a" }] },
    { source: "bloom", passage: "p-en1", locators: [{ kind: "canonical", value: "327a" }], shelf: "kept" },
    { source: "bloom", passage: "p-en2" },
    { source: "he", passage: "p-he", normalized: { text: "ירדתי אתמול", note: "vowel points removed", mark: 1 } },
    { source: "ms", absent: true, note: "the leaf is lost" },
    { interpretation: "mine" },
  ],
  rationale: "The first sentence in every version.",
  confidence: "plausible",
  recordedBy: { kind: "author" },
  evidence: [{ source: "slings", locators: [{ kind: "page", value: "1" }] }],
  visibility: "private",
  shelf: 7,
});
const SECOND = () => ({
  id: "second",
  correspondence: "corresponding",
  members: [
    { source: "slings", locators: [{ kind: "canonical", value: "327b" }] },
    { source: "bloom", locators: [{ kind: "canonical", value: "327b" }] },
  ],
  confidence: "tentative",
  recordedBy: { kind: "named", name: "A concordance" },
  visibility: "private",
});
const NOTICES = () => [{ code: "stale-locator", collection: "alignments", index: 0, id: "opening", field: "members[1].locators", message: "these locators no longer match passage `p-en1`, which may have been re-located since it was aligned; check the place and update one of them" }];
const CORRESPONDENCES = () => [
  { value: "corresponding", label: "The author reads these places as corresponding" },
  { value: "partial", label: "The author reads these places as corresponding in part" },
  { value: "divergent", label: "The author reads these places as corresponding but differing" },
];
const view = (over = {}) => ({
  file: ".openblog/private/research/alignments.json",
  revision: "r1",
  stored: true,
  alignments: [OPENING(), SECOND()],
  sources: SOURCES(),
  passages: PASSAGES(),
  interpretations: INTERPRETATIONS(),
  notices: NOTICES(),
  notice: "An alignment records where its author reads these places as corresponding. It does not say they mean the same thing, and no version is treated as authoritative.",
  correspondences: CORRESPONDENCES(),
  ...over,
});
const context = () => applyAlignmentState({}, view());

function compareApi(handlers = {}) {
  const calls = [];
  const all = { "GET research/alignments": () => view(), ...handlers };
  return {
    calls,
    async call(method, path, options = {}) {
      if (method !== "GET") calls.push({ method, path, body: structuredClone(options.json) });
      const handler = all[`${method} ${path}`];
      if (!handler) throw new ApiError(`unexpected ${method} ${path}`, 500, null);
      return handler(options.json);
    },
  };
}

function mountCompare(api) {
  const app = new ObAdmin();
  const root = new DomNode("div", globalThis.document);
  globalThis.document.body.append(root);
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
const toggle = async (control, checked) => {
  control.checked = checked;
  await control.dispatch("change", { target: control });
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const submit = (root) => root.querySelector("form").dispatch("submit");
const buttonLabelled = (root, text) => root.querySelectorAll("button").find((button) => button.textContent === text);
const all = (root, attribute) => root.querySelectorAll(`[${attribute}]`);
const openAlignment = async (root, id) => {
  await root.querySelectorAll("button").find((button) => button.dataset.compareAlignment === id).click();
  await tick();
};
const versionKeys = (root) => all(root, "data-compare-version").map((section) => section.dataset.compareVersion);
const place = (root, index) => all(root, "data-compare-place").find((item) => item.dataset.comparePlace === String(index));

// ---------------------------------------------------------------- pure helpers

test("text direction comes from the language tag, and unknown text lets the browser decide", () => {
  assert.equal(textDirection("he"), "rtl");
  assert.equal(textDirection("ar-EG"), "rtl");
  assert.equal(textDirection("fa"), "rtl");
  assert.equal(textDirection("az-Arab"), "rtl", "a right-to-left script subtag decides");
  assert.equal(textDirection("he-Latn"), "ltr", "a transliteration is left to right");
  assert.equal(textDirection("grc"), "ltr");
  assert.equal(textDirection("en"), "ltr");
  assert.equal(textDirection(""), "auto");
  for (const language of ["hbo", "arz", "ary", "aeb", "apc", "acm", "ajp", "azb", "ota", "prs", "glk", "lrc", "bal", "jrb", "jpr", "sam", "phn"]) {
    assert.equal(textDirection(language), "rtl", `${language} is written right to left`);
  }
  for (const script of ["Armi", "Avst", "Chrs", "Elym", "Hatr", "Khar", "Mani", "Merc", "Mero", "Narb", "Nbat", "Ougr", "Palm", "Phli", "Phlp", "Phnx", "Prti", "Sarb", "Sogd", "Sogo", "Lydi", "Cprt", "Hung"]) {
    assert.equal(textDirection(`und-${script}`), "rtl", `${script} runs right to left`);
  }
  assert.equal(textDirection("hbo-Hebr"), "rtl");
  assert.equal(textDirection("arc-Latn"), "ltr", "a known left-to-right script decides");
  assert.equal(textDirection("grc-Grek"), "ltr");
  assert.equal(textDirection("xx-Zzzz"), "auto", "an unknown script subtag is left to the browser, never assumed left to right");
  assert.equal(textDirection("he-Qaaa"), "auto");
  assert.equal(textDirection(undefined), "auto");
  assert.equal(textDirection('he" onmouseover="x'), "auto", "a hostile tag is no tag");
  assert.equal(languageTag(" grc "), "grc");
  assert.equal(languageTag("<b>"), "");
  assert.equal(languageTag("x"), "");
});

test("locators read as a person says them", () => {
  assert.equal(locatorText([{ kind: "canonical", value: "327a", to: "327b" }, { kind: "x-csl-volume", value: "2" }]), "canonical 327a to 327b, volume 2");
  assert.equal(locatorText([]), "");
  assert.equal(locatorText(null), "");
});

test("a version names its maker in its own role, and says when nobody is named or recorded", () => {
  const [, slings, bloom, he, ms, revised] = SOURCES();
  assert.equal(versionMakerText(slings), "Editor: S. R. Slings (stated)");
  assert.equal(versionMakerText(bloom), "Translator: Allan Bloom (attributed: second edition)");
  assert.equal(versionMakerText(he), "Translator: anonymous; the source names nobody");
  assert.equal(versionMakerText(ms), "Scribe: John the Calligrapher (disputed)");
  assert.equal(versionMakerText(revised), "Editor: not recorded");
  assert.equal(versionMakerText({ kind: "edition", creators: [{ name: "A", role: "editor" }, { name: "B", role: "editor" }, { name: "C", role: "author" }] }), "Editors: A; B");
  assert.equal(versionMakerText(SOURCES()[0]), "", "a work has no text of its own");
  const [mine, gloss] = INTERPRETATIONS();
  assert.equal(interpretersText(mine), "Interpreted by: Ada <b>Lovelace</b> (uncertain)");
  assert.equal(interpretersText(gloss), "Interpreted by: anonymous; nobody is named");
  assert.equal(interpretersText({ interpreters: [{ name: "Jowett" }] }), "Interpreted by: Jowett");
});

test("rights read as the author's statement and never as permission", () => {
  assert.equal(rightsText(RIGHTS.publicDomain), "The author states the text is in the public domain. Published 2003, edition text ancient");
  assert.equal(rightsText(RIGHTS.openLicense), "The author states the text is under an open licence (CC-BY-4.0)");
  assert.equal(rightsText(undefined), "Rights not checked yet", "undeclared is unknown");
  for (const rights of Object.values(RIGHTS)) assert.doesNotMatch(rightsText(rights), /allowed|permitted|free to/i);
});

test("columns follow the author's member order, keep splits together, and say absence and attribution", () => {
  const columns = comparisonColumns(OPENING(), context());
  assert.deepEqual(columns.map((column) => column.key), ["source:slings", "source:bloom", "source:he", "source:ms", "interpretation:mine"]);
  const [slings, bloom, he, ms, mine] = columns;
  assert.deepEqual(bloom.places.map((item) => item.index), [1, 2], "a split keeps both places in one version");
  assert.equal(slings.places[0].original.text, GREEK, "the wording is exact, whitespace and all");
  assert.equal(slings.places[0].original.language, "grc");
  assert.equal(he.places[0].original.text, HEBREW);
  assert.equal(he.places[0].original.text.normalize("NFC") === HEBREW, true);
  assert.equal(he.places[0].locator, "page 3", "the passage's locators stand in when the member gives none");
  assert.equal(bloom.places[1].locator, "canonical 327a to 327b");
  assert.equal(he.places[0].normalized.text, "ירדתי אתמול");
  assert.equal(he.places[0].normalized.note, "vowel points removed");
  assert.equal(ms.places[0].absent, true);
  assert.equal(ms.places[0].original, null);
  assert.equal(ms.places[0].note, "the leaf is lost");
  assert.equal(ms.maker, "Scribe: John the Calligrapher (disputed)");
  assert.deepEqual(ms.facts.find((fact) => fact.label === "Held at").parts, [{ text: "BnF, gr. 1807" }]);
  assert.deepEqual(ms.facts.find((fact) => fact.label === "Volumes").parts, ["2"]);
  assert.equal(mine.type, "interpretation");
  assert.equal(mine.maker, "Interpreted by: Ada <b>Lovelace</b> (uncertain)");
  assert.equal(mine.places[0].original.text, "Down I went, yesterday");
  assert.equal(mine.places[0].locator, "canonical 327a");
  assert.equal(mine.rights.status, "ownWork");
  assert.match(bloom.places[0].notices[0], /no longer match passage `p-en1`/);
  assert.deepEqual(bloom.places[1].notices, []);
  assert.equal(he.rights.status, "unknown");
  const realizes = slings.facts.find((fact) => fact.label === "Realizes");
  assert.deepEqual(realizes.parts, [{ text: "Πολιτεία" }, " (work)"]);
  const revised = comparisonColumns({ id: "x", members: [{ source: "slings-2", locators: [{ kind: "page", value: "1" }] }, { source: "nowhere", absent: true }] }, context());
  assert.deepEqual(revised[0].facts.find((fact) => fact.label === "Revises").parts, [{ text: "Platonis Rempublicam (edition)" }]);
  assert.equal(revised[1].missing, true, "a member whose version is gone is shown as missing, not dropped");
  assert.equal(revised[1].title, "Missing source nowhere");
});

test("export text carries only selected places, each identified, with rights and exact wording", () => {
  const columns = comparisonColumns(OPENING(), context());
  const none = comparisonExportText(OPENING(), columns, new Set());
  assert.doesNotMatch(none, /Original wording/);
  const text = comparisonExportText(OPENING(), columns, new Set([0, 3, 4]), { correspondence: CORRESPONDENCES()[1].label });
  assert.match(text, /^Alignment: Opening: the descent\nThe author reads these places as corresponding in part\n/);
  assert.ok(text.includes(`Original wording, from notebook passage p-gr:\n${GREEK}\n`));
  assert.ok(text.includes(`Original wording, from notebook passage p-he:\n${HEBREW}\n`));
  assert.ok(text.includes("Platonis Rempublicam (Edition)\nEditor: S. R. Slings (stated)\nLocator: canonical 327a\nRights: The author states the text is in the public domain"));
  assert.ok(text.includes("Paris gr. 1807 (Witness)\nScribe: John the Calligrapher (disputed)\nLocator: none recorded\nRights: The author states the text is under an open licence (CC-BY-4.0)\nAbsent: this version lacks the passage.\n\n"));
  assert.ok(!text.includes("the leaf is lost"), "the author's private notes on places stay out by default");
  const withNotes = comparisonExportText(OPENING(), columns, new Set([4]), { notes: true });
  assert.ok(withNotes.includes("Absent: this version lacks the passage.\nAuthor's note: the leaf is lost\n"), "notes are copied only when asked for");
  assert.ok(!text.includes("I went down"), "unselected places stay out");
  assert.ok(!text.includes("ירדתי אתמול\n"), "a normalization is left out unless asked for");
  const normalized = comparisonExportText(OPENING(), columns, new Set([3]), { normalized: true });
  assert.ok(normalized.includes("The author's normalization, not the source text:\nירדתי אתמול\nNormalized: vowel points removed"));
  assert.match(text, /open\.blog does not decide what is permitted\.\n$/);
});

test("copying asks for confirmation only where rights are unchecked or reserved, and only for quoted text", () => {
  const columns = comparisonColumns(OPENING(), context());
  assert.deepEqual(rightsToConfirm(columns, new Set([0])).map((column) => column.id), [], "a public-domain statement needs no extra confirmation");
  assert.deepEqual(rightsToConfirm(columns, new Set([0, 1, 3])).map((column) => column.id), ["bloom", "he"]);
  assert.deepEqual(rightsToConfirm(columns, new Set([4])).map((column) => column.id), [], "an absent place quotes nothing");
});

test("payloads keep evidence and unknown fields, and drop what an absent place cannot have", () => {
  assert.deepEqual(alignmentPayload(alignmentDraft(OPENING())), OPENING(), "an untouched alignment round-trips exactly");
  const draft = alignmentDraft(OPENING());
  draft.label = "  The descent  ";
  draft.members[1].locators = "canonical: 327a\ncanonical: 327b";
  draft.members[3].normalized = "ירדתי  אתמול ";
  draft.members[0].absent = true;
  draft.correspondence = "divergent";
  const sent = alignmentPayload(draft);
  assert.equal(sent.label, "The descent");
  assert.equal(sent.shelf, 7);
  assert.deepEqual(sent.evidence, OPENING().evidence);
  assert.equal(sent.members[1].shelf, "kept");
  assert.deepEqual(sent.members[1].locators, [{ kind: "canonical", value: "327a" }, { kind: "canonical", value: "327b" }]);
  assert.deepEqual(sent.members[3].normalized, { text: "ירדתי  אתמול ", note: "vowel points removed", mark: 1 }, "a normalization is sent exactly as typed");
  assert.deepEqual(sent.members[0], { source: "slings", absent: true });
  assert.equal(sent.correspondence, "divergent");
  assert.equal(sent.visibility, "private");
  assert.deepEqual(sent.members[5], { interpretation: "mine" });
  const fresh = alignmentPayload(alignmentDraft(null));
  assert.deepEqual(fresh.recordedBy, { kind: "author" });
  assert.equal(fresh.confidence, "tentative");
});

test("a kept draft rests on the newer copy's unknown fields", () => {
  const draft = alignmentDraft(OPENING());
  draft.label = "Mine";
  const newer = { ...OPENING(), shelf: 8, members: OPENING().members.map((member, index) => (index === 1 ? { ...member, shelf: "newer" } : member)) };
  rebaseAlignmentDraft(draft, newer);
  const sent = alignmentPayload(draft);
  assert.equal(sent.label, "Mine");
  assert.equal(sent.shelf, 8);
  assert.equal(sent.members[1].shelf, "newer");
});

test("a rebase never moves one place's unknown fields onto another", () => {
  // A split: a second place added from the same version and passage as the first.
  const split = alignmentDraft(OPENING());
  split.members.splice(1, 0, { ...alignmentDraft(null).members[0], source: "slings", passage: "p-gr", locators: "canonical: 327a" });
  const newer = { ...OPENING(), members: OPENING().members.map((member, index) => (index === 0 ? { ...member, shelf: "first" } : member)) };
  rebaseAlignmentDraft(split, newer);
  let sent = alignmentPayload(split);
  assert.equal(sent.members[0].shelf, "first", "the place read from the stored member rests on its newer copy");
  assert.equal(sent.members[1].shelf, undefined, "the new place takes nobody's fields");
  // An edited version: place 2 now names the version and passage place 3 is in.
  const edited = alignmentDraft(OPENING());
  edited.members[1].source = "bloom";
  edited.members[1].passage = "p-en2";
  edited.members[1].locators = "";
  const marked = { ...OPENING(), members: OPENING().members.map((member, index) => ({ ...member, shelf: `stored-${index}` })) };
  rebaseAlignmentDraft(edited, marked);
  sent = alignmentPayload(edited);
  assert.equal(sent.members[1].shelf, "stored-1", "an edited place keeps the fields of the place it was read as");
  assert.equal(sent.members[2].shelf, "stored-2");
  // Reordered in storage: each place follows its own stored member by identity, each claimed once.
  const moved = alignmentDraft(OPENING());
  rebaseAlignmentDraft(moved, { ...OPENING(), members: [...marked.members].reverse() });
  sent = alignmentPayload(moved);
  assert.deepEqual(sent.members.map((member) => member.shelf), [0, 1, 2, 3, 4, 5].map((index) => `stored-${index}`));
  assert.deepEqual(moved.members.map((member) => member.from), [5, 4, 3, 2, 1, 0]);
  // A place whose stored member is gone keeps its own original.
  const gone = alignmentDraft(OPENING());
  rebaseAlignmentDraft(gone, { ...OPENING(), members: OPENING().members.filter((_, index) => index !== 1) });
  assert.equal(alignmentPayload(gone).members[1].shelf, "kept");
  assert.equal(gone.members[1].from, null);
});

test("notes are sent exactly as typed, so a round trip is lossless", () => {
  const record = { ...OPENING(), members: OPENING().members.map((member, index) => (index === 3 ? { ...member, note: "  spaced  ", normalized: { text: "x", note: " keep " } } : member)) };
  const sent = alignmentPayload(alignmentDraft(record));
  assert.equal(sent.members[3].note, "  spaced  ");
  assert.equal(sent.members[3].normalized.note, " keep ");
  const blank = alignmentDraft(record);
  blank.members[3].note = "   ";
  assert.equal(alignmentPayload(blank).members[3].note, undefined, "a blank note is dropped");
});

test("advisory checks name the first problem and the control for it", () => {
  const ctx = { sources: SOURCES(), passages: PASSAGES(), interpretations: INTERPRETATIONS(), used: ["opening"] };
  const draft = alignmentDraft(null);
  assert.equal(validateAlignmentDraft(draft, { ...ctx, creating: true }).field, "id");
  draft.id = "opening";
  assert.equal(validateAlignmentDraft(draft, { ...ctx, creating: true }).field, "id");
  draft.id = "fresh";
  assert.equal(validateAlignmentDraft(draft, { ...ctx, creating: true }).field, "member-0-source");
  draft.members[0].source = "plato";
  assert.match(validateAlignmentDraft(draft, ctx).message, /a work has no text of its own/);
  draft.members[0].source = "slings";
  assert.equal(validateAlignmentDraft(draft, ctx).field, "member-0-locators");
  draft.members[0].locators = "514";
  assert.match(validateAlignmentDraft(draft, ctx).message, /must look like page: 514/);
  draft.members[0].locators = "canonical: 327a";
  draft.members[1].source = "slings";
  draft.members[1].absent = true;
  assert.equal(validateAlignmentDraft(draft, ctx).field, "members", "one version is not a comparison");
  draft.members[1].source = "he";
  draft.members[1].absent = false;
  draft.members[1].passage = "p-gr";
  assert.equal(validateAlignmentDraft(draft, ctx).field, "member-1-passage");
  draft.members[1].passage = "p-he";
  assert.equal(validateAlignmentDraft(draft, ctx), null);
  draft.members[1].type = "interpretation";
  assert.equal(validateAlignmentDraft(draft, ctx).field, "member-1-interpretation");
  draft.members[1].interpretation = "mine";
  draft.recordedBy.kind = "named";
  assert.equal(validateAlignmentDraft(draft, ctx).field, "recorded-name");
});

test("server diagnostics map to the control that fixes them", () => {
  assert.equal(alignmentDiagnosticControl("members[2].source"), "member-2-source");
  assert.equal(alignmentDiagnosticControl("members[0].locators[1].kind"), "member-0-locators");
  assert.equal(alignmentDiagnosticControl("members[3].normalized"), "member-3-normalized");
  assert.equal(alignmentDiagnosticControl("members[3].normalized.note"), "member-3-normalized-note");
  assert.equal(alignmentDiagnosticControl("members[1]"), "member-1");
  assert.equal(alignmentDiagnosticControl("members"), "members");
  assert.equal(alignmentDiagnosticControl("recordedBy.name"), "recorded-name");
  assert.equal(alignmentDiagnosticControl("correspondence"), "correspondence");
  assert.equal(alignmentDiagnosticControl("evidence[0].source"), "");
  assert.equal(alignmentErrorMessage({ data: { diagnostics: [{ field: "members[0].source", message: "`w` is a work" }] } }), "members[0].source: `w` is a work");
  assert.equal(alignmentErrorMessage(new Error("offline")), "offline");
});

// ---------------------------------------------------------------- the workspace

test("an alignment opens as labelled versions side by side, every place identified and its wording exact", withDom(async () => {
  const { app, root } = mountCompare(compareApi());
  await app.showCompare();
  assert.match(root.querySelector("[data-compare-count]").textContent, /^2 alignments\.$/);
  await openAlignment(root, "opening");
  assert.equal(globalThis.document.activeElement.id, "oba-compare-heading");
  assert.equal(byId(root, "oba-compare-heading").tagName, "H2");
  assert.equal(root.querySelector("[data-compare-correspondence]").textContent, "The author reads these places as corresponding in part.");
  assert.match(root.querySelector("[data-compare-notice]").textContent, /does not say they mean the same thing/);
  assert.doesNotMatch(root.textContent, /equivalent|the same meaning|authoritative version/i);
  assert.equal(root.querySelector("[data-compare-layout]").dataset.compareLayout, "columns");
  assert.deepEqual(versionKeys(root), ["source:slings", "source:bloom", "source:he", "source:ms", "interpretation:mine"]);
  // Headings nest: the alignment, the comparison, then one per version.
  assert.equal(byId(root, "oba-compare-comparison-heading").tagName, "H3");
  for (const section of all(root, "data-compare-version")) {
    const headingId = section.getAttribute("aria-labelledby");
    assert.equal(byId(section, headingId).tagName, "H4");
  }
  // Every place says its version, maker and locator in visible text.
  for (const item of all(root, "data-compare-place")) {
    const ident = item.querySelector("[data-compare-ident]").textContent;
    assert.match(ident, / · Locator: /, ident);
  }
  assert.equal(place(root, 0).querySelector("[data-compare-ident]").textContent, "Platonis Rempublicam · Edition · Editor: S. R. Slings (stated) · Locator: canonical 327a");
  assert.equal(place(root, 2).querySelector("[data-compare-ident]").textContent, "The Republic of Plato · Translation, language en · Translator: Allan Bloom (attributed: second edition) · Locator: canonical 327a to 327b");
  assert.equal(place(root, 5).querySelector("[data-compare-ident]").textContent, "Rendering mine · Interpretation (rendering), language en · Interpreted by: Ada <b>Lovelace</b> (uncertain) · Locator: canonical 327a");
  // Exact wording, with its language and direction.
  const greek = place(root, 0).querySelector("blockquote");
  assert.equal(greek.textContent, GREEK);
  assert.equal(greek.getAttribute("lang"), "grc");
  assert.equal(greek.getAttribute("dir"), "ltr");
  const hebrew = place(root, 3).querySelector("blockquote");
  assert.equal(hebrew.textContent, HEBREW);
  assert.equal(hebrew.getAttribute("lang"), "he");
  assert.equal(hebrew.getAttribute("dir"), "rtl");
  assert.equal(hebrew.dir, "rtl", "the reflected property agrees with the attribute");
  // Titles and names in another direction are isolated, so they cannot reorder the labels around them.
  const heHeading = all(root, "data-compare-version").find((section) => section.dataset.compareVersion === "source:he").querySelector("h4");
  assert.equal(heHeading.children[0].tagName, "BDI");
  assert.equal(heHeading.textContent, "פוליטאה");
  // Absence is said, never left as a gap.
  const absent = place(root, 4);
  assert.equal(absent.dataset.compareAbsent, "true");
  assert.equal(absent.querySelector("[data-compare-absent-text]").textContent, "Absent: this version lacks the passage.");
  assert.match(absent.textContent, /Author's note: the leaf is lost/);
  // Version facts: rights, lineage, witness identity.
  const ms = all(root, "data-compare-version").find((section) => section.dataset.compareVersion === "source:ms");
  assert.match(ms.textContent, /Held atBnF, gr\. 1807/);
  assert.match(ms.textContent, /Volumes2/);
  assert.equal(ms.querySelector("[data-compare-rights]").dataset.compareRights, "openLicense");
  assert.match(place(root, 1).querySelector("[data-compare-place-notice]").textContent, /^Check this place: these locators no longer match passage `p-en1`/);
  assert.equal(root.querySelectorAll("img").length + root.querySelectorAll("script").length + root.querySelectorAll("b").length, 0, "hostile text stays text");
  assert.ok(root.textContent.includes(HOSTILE));
}));

test("the comparison switches to one semantic column in the same order, and back", withDom(async () => {
  const { app, root } = mountCompare(compareApi());
  await app.showCompare("opening");
  assert.equal(globalThis.document.activeElement.id, "oba-compare-heading");
  const before = versionKeys(root);
  const single = byId(root, "oba-compare-layout-sequence");
  assert.equal(root.querySelector("[data-compare-layout-choice]").tagName, "FIELDSET");
  single.focus();
  await toggle(single, true);
  const sequence = root.querySelector("[data-compare-layout]");
  assert.equal(sequence.tagName, "OL");
  assert.equal(sequence.dataset.compareLayout, "sequence");
  assert.deepEqual(sequence.children.map((item) => item.tagName), ["LI", "LI", "LI", "LI", "LI"]);
  assert.deepEqual(versionKeys(root), before, "the reading order does not change");
  assert.equal(globalThis.document.activeElement, single, "focus stays on the control");
  assert.match(root.textContent, /Showing versions in a single column/);
  await toggle(byId(root, "oba-compare-layout-columns"), true);
  assert.equal(root.querySelector("[data-compare-layout]").tagName, "DIV");
  // Another alignment keeps the chosen layout for this visit.
  await toggle(byId(root, "oba-compare-layout-sequence"), true);
  await openAlignment(root, "second");
  assert.equal(root.querySelector("[data-compare-layout]").dataset.compareLayout, "sequence");
}));

test("normalizations are shown only when asked, labelled, and always under the original", withDom(async () => {
  const { app, root } = mountCompare(compareApi());
  await app.showCompare("opening");
  assert.equal(all(root, "data-compare-normalized").length, 0);
  assert.match(place(root, 3).textContent, /A normalization is recorded/);
  await toggle(byId(root, "oba-compare-normalized"), true);
  const he = place(root, 3);
  const quotes = he.querySelectorAll("blockquote");
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].dataset.compareOriginal, "true", "the original comes first");
  assert.equal(quotes[0].textContent, HEBREW);
  assert.equal(quotes[1].dataset.compareNormalized, "true");
  assert.equal(quotes[1].textContent, "ירדתי אתמול");
  assert.equal(quotes[1].getAttribute("dir"), "rtl");
  assert.match(he.textContent, /The author's normalization, not the source text/);
  assert.match(he.textContent, /Normalized: vowel points removed/);
}));

test("copying takes only selected places, after the rights statements are confirmed, and publishes nothing", withDom(async ({ clipboard, downloads }) => {
  const api = compareApi();
  const { app, root } = mountCompare(api);
  await app.showCompare("opening");
  const copy = root.querySelector("[data-compare-copy]");
  await copy.click();
  assert.equal(clipboard.writes.length, 0, "nothing is copied without a selection");
  assert.match(byId(root, "oba-compare-export-error").textContent, /Select at least one place first/);
  assert.equal(globalThis.document.activeElement, root.querySelector("[data-compare-select-all]"));
  assert.equal(root.querySelector("[data-compare-selection]").textContent, "No places selected.");
  // Choose the Greek (public domain) and the Hebrew (rights not checked).
  await toggle(byId(root, "oba-compare-select-0"), true);
  assert.equal(root.querySelector("[data-compare-confirm]"), null, "a public-domain statement needs no extra step");
  await toggle(byId(root, "oba-compare-select-3"), true);
  assert.equal(root.querySelector("[data-compare-selection]").textContent, "2 places selected.");
  const summary = root.querySelector("[data-compare-rights-summary]").textContent;
  assert.match(summary, /Platonis Rempublicam: The author states the text is in the public domain/);
  assert.match(summary, /פוליטאה: Rights not checked yet/);
  assert.match(summary, /not permission/);
  await root.querySelector("[data-compare-copy]").click();
  assert.equal(clipboard.writes.length, 0, "unconfirmed rights stop the copy");
  assert.equal(globalThis.document.activeElement.id, "oba-compare-confirm-rights");
  await toggle(byId(root, "oba-compare-confirm-rights"), true);
  await root.querySelector("[data-compare-copy]").click();
  assert.equal(clipboard.writes.length, 1);
  const text = clipboard.writes[0];
  assert.ok(text.includes(GREEK) && text.includes(HEBREW), "the wording is copied exactly");
  assert.ok(!text.includes("I went down"), "unselected places are not copied");
  assert.match(text, /Rights: Rights not checked yet/);
  assert.match(root.textContent, /Copied 2 places with their version, maker, locator and rights statement/);
  // Download builds the same text locally.
  await root.querySelector("[data-compare-download]").click();
  await tick();
  assert.equal(downloads.made.length, 1);
  assert.equal(await downloads.made[0].text(), text);
  assert.deepEqual(downloads.revoked, ["blob:test/1"]);
  // The author's private notes on places stay out unless explicitly included.
  await toggle(byId(root, "oba-compare-select-4"), true);
  assert.equal(byId(root, "oba-compare-include-notes").checked, false, "notes are left out by default");
  await toggle(byId(root, "oba-compare-confirm-rights"), true);
  await root.querySelector("[data-compare-copy]").click();
  assert.ok(!clipboard.writes.at(-1).includes("the leaf is lost"), "a note is absent unless asked for");
  await toggle(byId(root, "oba-compare-include-notes"), true);
  await root.querySelector("[data-compare-copy]").click();
  assert.ok(clipboard.writes.at(-1).includes("Author's note: the leaf is lost"), "a note is copied once the author includes notes");
  // Changing the selection asks again.
  await toggle(byId(root, "oba-compare-select-1"), true);
  assert.equal(byId(root, "oba-compare-confirm-rights").checked, false);
  assert.deepEqual(api.calls, [], "copying never calls the server");
}));

test("a refused clipboard shows the text to copy by hand", withDom(async ({ clipboard }) => {
  clipboard.fail = true;
  const { app, root } = mountCompare(compareApi());
  await app.showCompare("opening");
  await root.querySelector("[data-compare-select-all]").click();
  await toggle(byId(root, "oba-compare-confirm-rights"), true);
  await root.querySelector("[data-compare-copy]").click();
  const area = byId(root, "oba-compare-export-text");
  assert.ok(area, "the text is offered in a labelled box");
  assert.equal(globalThis.document.activeElement, area);
  assert.ok(area.value.includes(HEBREW));
  assert.equal(root.querySelectorAll("label").some((label) => label.getAttribute("for") === "oba-compare-export-text"), true);
  assert.match(root.textContent, /did not allow copying/);
}));

test("a new alignment is created from the keyboard, with places, an absence and a reordering", withDom(async () => {
  const api = compareApi({
    "POST research/alignments": (body) => ({ ...view({ revision: "r2", alignments: [OPENING(), SECOND(), body.alignment] }), alignment: body.alignment }),
  });
  const { app, root } = mountCompare(api);
  await app.showCompare();
  await root.querySelector("[data-compare-new]").click();
  assert.equal(globalThis.document.activeElement.id, "oba-compare-heading");
  assert.equal(byId(root, "oba-compare-heading").textContent, "New alignment");
  await type(byId(root, "oba-alignment-label"), "The Piraeus");
  assert.equal(byId(root, "oba-alignment-id").value, "the-piraeus");
  const versions = byId(root, "oba-alignment-member-0-source").children.map((option) => option.value).filter(Boolean);
  assert.deepEqual(versions, ["slings", "bloom", "he", "ms", "slings-2"], "only versions, never a work or an archived source");
  await choose(byId(root, "oba-alignment-member-0-source"), "he");
  await choose(byId(root, "oba-alignment-member-0-passage"), "p-he");
  assert.equal(byId(root, "oba-alignment-member-0-locators").value, "page: 3", "a passage fills its locators");
  assert.equal(byId(root, "oba-alignment-member-0-normalized").getAttribute("dir"), "auto");
  await type(byId(root, "oba-alignment-member-0-normalized"), "ירדתי אתמול");
  await choose(byId(root, "oba-alignment-member-1-source"), "ms");
  await toggle(byId(root, "oba-alignment-member-1-absent"), true);
  assert.equal(byId(root, "oba-alignment-member-1-locators"), null, "an absent place has no locators");
  await root.querySelector("[data-alignment-add-member]").click();
  assert.equal(globalThis.document.activeElement.id, "oba-alignment-member-2-source");
  await toggle(byId(root, "oba-alignment-member-2-is-interpretation"), true);
  await choose(byId(root, "oba-alignment-member-2-interpretation"), "mine");
  const up = byId(root, "oba-alignment-member-2-up");
  assert.equal(up.getAttribute("aria-label"), "Move place 3 up");
  await up.click();
  assert.match(root.textContent, /Place 3 moved to position 2/);
  assert.equal(globalThis.document.activeElement.id, "oba-alignment-member-1-up");
  await choose(byId(root, "oba-alignment-correspondence"), "divergent");
  assert.ok(byId(root, "oba-alignment-correspondence").children.every((option) => option.textContent.startsWith("The author reads")));
  await submit(root);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body, {
    revision: "r1",
    alignment: {
      id: "the-piraeus",
      label: "The Piraeus",
      correspondence: "divergent",
      members: [
        { source: "he", passage: "p-he", locators: [{ kind: "page", value: "3" }], normalized: { text: "ירדתי אתמול" } },
        { interpretation: "mine" },
        { source: "ms", absent: true },
      ],
      confidence: "tentative",
      recordedBy: { kind: "author" },
      visibility: "private",
    },
  });
  assert.match(root.textContent, /Alignment saved to the private alignments file/);
  assert.equal(byId(root, "oba-compare-heading").textContent, "The Piraeus");
  assert.equal(globalThis.document.activeElement.id, "oba-compare-heading");
}));

test("a refused save is scoped to its field, keeps the draft, and changes nothing", withDom(async () => {
  const api = compareApi({
    "PUT research/alignments": () => {
      throw new ApiError("invalid", 422, { error: "invalid", file: ".openblog/private/research/alignments.json", diagnostics: [{ code: "ambiguous-locator", field: "members[1].locators[0].kind", message: "a page needs a volume" }] });
    },
  });
  const { app, root } = mountCompare(api);
  await app.showCompare("second");
  await root.querySelector("[data-compare-edit]").click();
  await type(byId(root, "oba-alignment-member-1-locators"), "page: 12");
  await submit(root);
  const locators = byId(root, "oba-alignment-member-1-locators");
  assert.equal(globalThis.document.activeElement, locators);
  assert.equal(locators.getAttribute("aria-invalid"), "true");
  assert.match(locators.getAttribute("aria-describedby"), /oba-alignment-member-1-locators-hint oba-alignment-error/);
  assert.equal(locators.value, "page: 12", "the draft is kept");
  assert.match(byId(root, "oba-alignment-error").textContent, /members\[1\]\.locators\[0\]\.kind: a page needs a volume/);
  assert.match(root.textContent, /The stored alignments are unchanged/);
}));

test("a conflict offers the stored copy or the draft, and keeping the draft rests it on the newer copy", withDom(async () => {
  let attempts = 0;
  const newer = { ...SECOND(), label: "Renamed elsewhere", shelf: "newer" };
  const api = compareApi({
    "PUT research/alignments": (body) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError("conflict", 409, { conflict: true, revision: "r2", current: newer });
      return { ...view({ revision: "r3", alignments: [OPENING(), body.alignment] }), alignment: body.alignment };
    },
  });
  api.call = ((call) => async (method, path, options) => (method === "GET" && attempts ? view({ revision: "r2", alignments: [OPENING(), newer] }) : call(method, path, options)))(api.call);
  const { app, root } = mountCompare(api);
  await app.showCompare("second");
  await root.querySelector("[data-compare-edit]").click();
  await type(byId(root, "oba-alignment-label"), "My label");
  await submit(root);
  const use = all(root, "data-alignment-conflict-use");
  assert.deepEqual(use.map((button) => button.textContent), ["Use the stored copy", "Keep my draft"]);
  assert.equal(globalThis.document.activeElement, use[0]);
  assert.equal(root.querySelector("[data-alignment-save]").disabled, true, "nothing is sent until the author chooses");
  await use[1].click();
  assert.equal(byId(root, "oba-alignment-label").value, "My label");
  await submit(root);
  const sent = api.calls.at(-1).body;
  assert.equal(sent.revision, "r2");
  assert.equal(sent.alignment.label, "My label");
  assert.equal(sent.alignment.shelf, "newer", "the kept draft carries the newer copy's other fields");
}));

test("saving a stale approval keeps it stale, and only Checked - approve again sends reapprove", withDom(async () => {
  const stale = { second: "members: passage `p-long` has moved since the approval." };
  const api = compareApi({
    "GET research/alignments": () => view({ staleApprovals: stale }),
    "PUT research/alignments": (body) => ({ ...view({ revision: "r2", staleApprovals: stale }), alignment: body.alignment }),
  });
  const { app, root } = mountCompare(api);
  await app.showCompare("second");
  await root.querySelector("[data-compare-edit]").click();
  const notice = root.querySelector("[data-alignment-stale]");
  assert.match(notice.textContent, /members: passage `p-long` has moved since the approval\./);
  assert.match(notice.textContent, /stays out of the next build until you have checked the places it names and approve it again/);
  await type(byId(root, "oba-alignment-label"), "An ordinary edit");
  await submit(root);
  assert.equal("reapprove" in api.calls[0].body, false, "an ordinary save never re-approves");
  await root.querySelector("[data-compare-edit]").click();
  assert.equal(root.querySelector("[data-alignment-reapprove]").textContent, "Checked — approve again");
  await root.querySelector("[data-alignment-reapprove]").click();
  await tick();
  assert.equal(api.calls[1].body.reapprove, true);
  // An alignment that is not stale offers no such control.
  const plain = mountCompare(compareApi());
  await plain.app.showCompare("second");
  await plain.root.querySelector("[data-compare-edit]").click();
  assert.equal(plain.root.querySelector("[data-alignment-reapprove]"), null);
}));

test("using the stored copy replaces the draft", withDom(async () => {
  const newer = { ...SECOND(), label: "Renamed elsewhere" };
  const api = compareApi({ "PUT research/alignments": () => { throw new ApiError("conflict", 409, { conflict: true, revision: "r2", current: newer }); } });
  const { app, root } = mountCompare(api);
  await app.showCompare("second");
  await root.querySelector("[data-compare-edit]").click();
  await type(byId(root, "oba-alignment-label"), "Mine");
  await submit(root);
  await all(root, "data-alignment-conflict-use")[0].click();
  assert.equal(byId(root, "oba-alignment-label").value, "Renamed elsewhere");
  assert.match(root.textContent, /Showing the stored copy/);
}));

test("approval and the normalization choice round-trip, and nothing else marks an alignment public", () => {
  const approved = { ...SECOND(), visibility: "approved", publishNormalized: true };
  assert.deepEqual(alignmentPayload(alignmentDraft(approved)), approved, "an approved alignment round-trips exactly");
  const draft = alignmentDraft(approved);
  draft.approved = false;
  draft.publishNormalized = false;
  const sent = alignmentPayload(draft);
  assert.equal(sent.visibility, "private");
  assert.equal("publishNormalized" in sent, false, "the choice is written only when made");
  assert.equal(alignmentDraft(SECOND()).approved, false);
});

test("the public preview reads as what a page would show, never as permission", () => {
  assert.match(publicPlaceText("shown"), /wording is shown/);
  assert.match(publicPlaceText("withheld-rights"), /identified and located only, because the version's rights are unknown or reserved/);
  assert.match(publicPlaceText("withheld-length", 1000), /1000-character excerpt limit/);
  assert.match(publicPlaceText("unquoted"), /located only/);
  assert.match(publicPlaceText("absent"), /absent/);
  assert.equal(publicPlaceText("other"), "");
  assert.equal(comparisonBuildText(undefined), "");
  assert.match(comparisonBuildText({ ok: true }), /rebuilt/);
  assert.match(comparisonBuildText({ ok: false, error: "boom" }), /could not be rebuilt: boom/);
  for (const status of ["shown", "withheld-rights", "withheld-length", "unquoted", "absent"]) {
    assert.doesNotMatch(publicPlaceText(status), /allowed|permitted|legal/i);
  }
});

test("each place previews its public form, and approving publishes through the same save", withDom(async () => {
  const publication = { publish: true, url: "/comparisons/", maxExcerptChars: 1000, places: { opening: ["shown", "withheld-rights", "unquoted", "withheld-rights", "absent", "withheld-length"] } };
  const api = compareApi({
    "GET research/alignments": () => view({ publication }),
    "PUT research/alignments": (body) => ({ ...view({ revision: "r2", alignments: [body.alignment, SECOND()], publication }), alignment: body.alignment, build: { ok: true, files: 9 } }),
  });
  const { app, root } = mountCompare(api);
  await app.showCompare("opening");
  assert.equal(root.querySelector("[data-compare-publication]").dataset.comparePublication, "private");
  const lines = all(root, "data-compare-public").map((line) => line.dataset.comparePublic);
  assert.deepEqual(lines, publication.places.opening);
  await root.querySelector("[data-compare-edit]").click();
  const approve = byId(root, "oba-alignment-approved");
  assert.equal(approve.checked, false);
  assert.match(byId(root, "oba-alignment-approved-hint").textContent, /\/comparisons\/opening\/.*Your notes on places are never published/);
  await toggle(approve, true);
  await toggle(byId(root, "oba-alignment-publish-normalized"), true);
  await submit(root);
  const sent = api.calls.at(-1).body.alignment;
  assert.equal(sent.visibility, "approved");
  assert.equal(sent.publishNormalized, true);
  assert.match(root.textContent, /The published comparisons were rebuilt/);
  const status = root.querySelector("[data-compare-publication]");
  assert.equal(status.dataset.comparePublication, "published");
  assert.equal(status.querySelector("a").getAttribute("href"), "/comparisons/opening/");
}));

test("an approved alignment on a site that does not publish says nothing is public yet", withDom(async () => {
  const api = compareApi({ "GET research/alignments": () => view({ alignments: [{ ...OPENING(), visibility: "approved" }, SECOND()], publication: { publish: false, places: {} } }) });
  const { app, root } = mountCompare(api);
  await app.showCompare("opening");
  const status = root.querySelector("[data-compare-publication]");
  assert.equal(status.dataset.comparePublication, "approved");
  assert.match(status.textContent, /comparisons\.publish/);
  assert.equal(all(root, "data-compare-public").length, 0, "no preview without one from the server");
}));

test("removing an alignment can be undone", withDom(async () => {
  const api = compareApi({
    "DELETE research/alignments": () => ({ ...view({ revision: "r2", alignments: [OPENING()] }), removed: SECOND() }),
    "POST research/alignments": (body) => ({ ...view({ revision: "r3", alignments: [OPENING(), body.alignment] }), alignment: body.alignment }),
  });
  const { app, root } = mountCompare(api);
  await app.showCompare("second");
  globalThis.confirm = () => true;
  try {
    await root.querySelector("[data-compare-remove]").click();
  } finally {
    delete globalThis.confirm;
  }
  assert.deepEqual(api.calls[0], { method: "DELETE", path: "research/alignments", body: { revision: "r1", id: "second" } });
  const undo = root.querySelector("[data-compare-undo-remove]");
  assert.equal(globalThis.document.activeElement, undo);
  assert.equal(undo.textContent, "Undo removing Alignment second");
  await undo.click();
  assert.deepEqual(api.calls[1], { method: "POST", path: "research/alignments", body: { revision: "r2", alignment: SECOND() } });
  assert.equal(byId(root, "oba-compare-heading").textContent, "Alignment second");
}));

test("filtering by version narrows the list and says how many are shown", withDom(async () => {
  const { app, root } = mountCompare(compareApi());
  await app.showCompare();
  const filter = byId(root, "oba-compare-version-filter");
  assert.equal(filter.getAttribute("aria-controls"), "oba-compare-alignments");
  await choose(filter, "source:he");
  assert.deepEqual(root.querySelectorAll("button").filter((button) => button.dataset.compareAlignment).map((button) => button.dataset.compareAlignment), ["opening"]);
  assert.match(root.querySelector("[data-compare-count]").textContent, /^1 of 2 alignments shown\.$/);
}));

test("a damaged file is reported against its file and nothing else is asked for", withDom(async () => {
  const api = compareApi({
    "GET research/alignments": () => {
      throw new ApiError("broken", 500, { error: ".openblog/private/research/alignments.json: invalid JSON", file: ".openblog/private/research/alignments.json" });
    },
  });
  const { app, root } = mountCompare(api);
  await app.showCompare();
  assert.match(root.textContent, /The alignments could not be read/);
  assert.match(root.textContent, /Repair \.openblog\/private\/research\/alignments\.json by hand/);
  assert.deepEqual(api.calls, []);
}));

test("an empty workspace explains what an alignment is", withDom(async () => {
  const { app, root } = mountCompare(compareApi({ "GET research/alignments": () => view({ alignments: [], notices: [], stored: false }) }));
  await app.showCompare();
  assert.match(root.textContent, /No alignments yet/);
  assert.match(root.textContent, /does not say they mean the same thing/);
}));

// ---------------------------------------------------------------- wiring and styles

test("the workspace is reachable from the research workspace, the palette and the router", () => {
  assert.equal(researchHref("compare", "opening"), "#/research/compare/opening");
  assert.equal(canonicalAdminHash("#/compare/opening"), "#/research/compare/opening", "the earlier address redirects");
  assert.match(admin, /panel === "compare"\) await this\.showCompare\(id\)/);
  assert.match(admin, /label: "Compare versions", category: "Research"/);
});

test("the comparison never parses stored text as markup and stores nothing in the browser", () => {
  const start = admin.indexOf("// ---------------------------------------------------------------- comparison workspace");
  const end = admin.indexOf("// ---------------------------------------------------------------- claims and evidence links");
  const viewStart = admin.indexOf("  async showCompare(");
  const viewEnd = admin.indexOf("  // ---- shared reflections");
  const code = admin.slice(start, end) + admin.slice(viewStart, viewEnd);
  assert.ok(start > 0 && viewStart > 0);
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|DOMParser/);
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(code, /\.normalize\(/, "stored wording is never normalized");
});

test("versions sit side by side on wide screens and follow one another on narrow ones", () => {
  assert.match(styles, /\.oba-compare-columns \{\n  display: grid;\n  grid-template-columns: repeat\(auto-fit, minmax\(min\(16rem, 100%\), 1fr\)\);/);
  assert.match(styles, /\.oba-compare-original,\n\.oba-compare-normalized \{[^}]*white-space: pre-wrap;[^}]*unicode-bidi: isolate;/);
  assert.match(styles, /@media \(max-width: 40rem\) \{\n  \.oba-compare-controls,/);
  assert.match(styles, /#oba-compare-heading:focus-visible/);
});
