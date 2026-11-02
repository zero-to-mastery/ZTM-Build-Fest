import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ObAdmin,
  SOURCE_KINDS,
  filterSources,
  normalizeAdminPreferences,
  parseSourceCreators,
  parseSourceIdentifiers,
  sourceDependents,
  sourceDiagnosticControl,
  sourceDraft,
  sourceDraftPayload,
  sourceExportLossNotes,
  sourceFieldsForKind,
  sourceImportRows,
  sourceImportSummary,
  sourceRelationOptions,
  sourceTargetVolumes,
  validateSourceDraft,
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

const LIBRARY = () => [
  { id: "plato-republic", kind: "work", title: "Πολιτεία", language: "grc", creators: [{ name: "Plato", role: "author", dates: "428-348 BC" }], shelf: { room: "B" } },
  { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam", issued: "2003", identifiers: [{ scheme: "isbn", value: "9780198145691" }] },
  { id: "bloom-1968", kind: "translation", of: "plato-republic", title: "The Republic", language: "en", archived: true },
  { id: "cave", kind: "reference", of: "slings-2003", location: { scheme: "page", value: "514a" } },
];

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function sourceApi(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, path, options = {}) {
      const handler = handlers[`${method} ${path}`];
      if (method !== "GET") calls.push({ method, path, body: options.json });
      if (!handler) throw new ApiError(`unexpected ${method} ${path}`, 500, null);
      return handler(options.json);
    },
  };
}

function mountSources(api) {
  const app = new ObAdmin();
  const root = new DomNode("div", globalThis.document);
  app.api = api;
  app.meta = { siteTitle: "Blog" };
  app.preferences = normalizeAdminPreferences({ preset: "advanced" });
  app.replaceChildren = (...nodes) => root.replaceChildren(...nodes);
  return { app, root };
}

const byId = (root, id) => root.querySelector(`#${id}`);
const itemFor = (root, id) => root.querySelectorAll("button").find((button) => button.dataset.sourceId === id);
const visibleIds = (root) => root.querySelectorAll("button").filter((button) => button.dataset.sourceId).map((button) => button.dataset.sourceId);
const type = async (control, value, event = "input") => {
  control.value = value;
  await control.dispatch(event, { target: control });
};
const submit = (root) => root.querySelector("form").dispatch("submit");
const buttonLabelled = (root, text) => root.querySelectorAll("button").find((button) => button.textContent === text);

// ---------------------------------------------------------------- pure helpers

test("search and filters match ids, titles, creators, and identifiers and hide archived by default", () => {
  const sources = LIBRARY();
  assert.deepEqual(filterSources(sources).map((source) => source.id), ["plato-republic", "slings-2003", "cave"]);
  assert.deepEqual(filterSources(sources, { archived: "archived" }).map((source) => source.id), ["bloom-1968"]);
  assert.equal(filterSources(sources, { archived: "all" }).length, 4);
  assert.deepEqual(filterSources(sources, { query: "PLATO" }).map((source) => source.id), ["plato-republic", "slings-2003"], "creator names and titles match ignoring case");
  assert.deepEqual(filterSources(sources, { query: "9780198145691" }).map((source) => source.id), ["slings-2003"]);
  assert.deepEqual(filterSources(sources, { query: "rempublicam 2003" }).map((source) => source.id), ["slings-2003"], "every term must match");
  assert.deepEqual(filterSources(sources, { kind: "reference" }).map((source) => source.id), ["cave"]);
  assert.deepEqual(filterSources(sources, { query: "nothing here" }), []);
  assert.deepEqual(filterSources(null), []);
  assert.deepEqual(sourceDependents(sources, "plato-republic").map((source) => source.id), ["slings-2003", "bloom-1968"]);
  assert.deepEqual(
    sourceDependents([...sources, { id: "slings-2005", kind: "edition", of: "plato-republic", revises: "slings-2003" }], "slings-2003").map((source) => source.id),
    ["cave", "slings-2005"],
    "a revised edition depends on the edition it revises",
  );
});

test("each supported source type shows only its own fields and valid relations", () => {
  assert.deepEqual(SOURCE_KINDS.map((item) => item.kind), ["work", "edition", "translation", "witness", "reference"]);
  assert.deepEqual(sourceFieldsForKind("work"), { of: false, basedOn: false, location: false, titleRequired: true, languageRequired: false });
  assert.equal(sourceFieldsForKind("translation").basedOn, true);
  assert.equal(sourceFieldsForKind("translation").languageRequired, true);
  assert.equal(sourceFieldsForKind("reference").location, true);
  assert.equal(sourceFieldsForKind("reference").titleRequired, false);
  const sources = LIBRARY();
  assert.deepEqual(sourceRelationOptions(sources, "translation", "of").map((source) => source.id), ["plato-republic"]);
  assert.deepEqual(sourceRelationOptions(sources, "reference", "of").map((source) => source.id), ["plato-republic", "slings-2003", "bloom-1968"]);
  assert.deepEqual(sourceRelationOptions(sources, "translation", "basedOn", "bloom-1968").map((source) => source.id), ["slings-2003"], "never itself");
  assert.deepEqual(sourceRelationOptions(sources, "work", "of"), []);
});

test("a draft round-trips losslessly and keeps fields the form does not edit", () => {
  const work = LIBRARY()[0];
  assert.deepEqual(sourceDraftPayload(sourceDraft(work)), work, "unknown fields inside creators and beside the form fields survive");

  const edited = sourceDraft(work);
  edited.title = "Republic";
  edited.creators = "Plato | author\nGlaucon";
  const payload = sourceDraftPayload(edited);
  assert.equal(payload.title, "Republic");
  assert.deepEqual(payload.creators, [work.creators[0], { name: "Glaucon" }]);
  assert.deepEqual(payload.shelf, { room: "B" });

  assert.equal(sourceDraftPayload(sourceDraft(LIBRARY()[2])).archived, true, "editing never restores an archived source");

  const reference = Object.assign(sourceDraft(null, "reference"), { id: "r", of: "slings-2003", title: "  ", locationScheme: "page", locationValue: " 12 ", basedOn: "x", language: "" });
  assert.deepEqual(sourceDraftPayload(reference), { id: "r", kind: "reference", of: "slings-2003", location: { scheme: "page", value: "12" } });
  const work2 = Object.assign(sourceDraft(null, "work"), { id: "w", title: "W", of: "stale", locationValue: "x", locationScheme: "page" });
  assert.deepEqual(sourceDraftPayload(work2), { id: "w", kind: "work", title: "W" }, "fields of another type are dropped");
});

test("version provenance the form does not edit yet survives an Admin round trip", () => {
  const edition = {
    id: "burnet-1902",
    kind: "edition",
    of: "plato-republic",
    title: "Platonis Opera IV",
    revises: "burnet-1900",
    volumes: 5,
    rights: { status: "publicDomain", note: "Published 1902" },
    creators: [{ name: "John Burnet", role: "editor", attribution: "stated", note: "Title page" }],
  };
  assert.deepEqual(sourceDraftPayload(sourceDraft(edition)), edition);
  const edited = Object.assign(sourceDraft(edition), { title: "Platonis Opera" });
  const payload = sourceDraftPayload(edited);
  assert.equal(payload.title, "Platonis Opera");
  assert.deepEqual(payload.rights, edition.rights, "the author's rights declaration is never dropped by an edit");
  assert.equal(payload.revises, "burnet-1900");
  assert.deepEqual(payload.creators, edition.creators, "attribution certainty stays on an unchanged creator");
  const reference = { id: "r", kind: "reference", of: "burnet-1902", location: { scheme: "page", value: "327", volume: "4" } };
  assert.deepEqual(sourceDraftPayload(sourceDraft(reference)).location, reference.location, "the volume stays with an unchanged location");
});

test("an edited creator or location keeps the provenance the form does not edit", () => {
  const work = {
    id: "magna-moralia",
    kind: "work",
    title: "Magna Moralia",
    anonymous: true,
    creators: [
      { name: "Aristotle", role: "author", attribution: "disputed", note: "Most scholars doubt it", family: "Aristotle", x: 1 },
      { name: "Theophrastus", role: "other", attribution: "uncertain" },
    ],
  };
  const renamed = sourceDraftPayload(Object.assign(sourceDraft(work), { creators: "Pseudo-Aristotle | author\nTheophrastus | other" }));
  assert.deepEqual(
    renamed.creators,
    [{ name: "Pseudo-Aristotle", role: "author", attribution: "disputed", note: "Most scholars doubt it", x: 1 }, work.creators[1]],
    "a renamed creator keeps its attribution, note, and unknown fields, but not name parts of the old name",
  );
  const roleChanged = sourceDraftPayload(Object.assign(sourceDraft(work), { creators: "Aristotle | editor\nTheophrastus" }));
  assert.deepEqual(roleChanged.creators, [
    { ...work.creators[0], role: "editor" },
    { name: "Theophrastus", attribution: "uncertain" },
  ], "a changed or removed role keeps everything else, so an anonymous record stays saveable");
  const reordered = sourceDraftPayload(Object.assign(sourceDraft(work), { creators: "Theophrastus | other\nAristotle | author" }));
  assert.deepEqual(reordered.creators, [work.creators[1], work.creators[0]], "creators follow their names when lines move");
  const removed = sourceDraftPayload(Object.assign(sourceDraft(work), { creators: "Theophrastus | other" }));
  assert.deepEqual(removed.creators, [work.creators[1]], "a removed line removes only that creator");

  const sources = [{ id: "burnet-1902", kind: "edition", of: "plato-republic", title: "Opera", volumes: 5 }];
  const reference = { id: "r", kind: "reference", of: "burnet-1902", location: { scheme: "page", value: "327", volume: "4", note: "x" } };
  const moved = sourceDraftPayload(Object.assign(sourceDraft(reference), { locationValue: "328" }));
  assert.deepEqual(moved.location, { scheme: "page", value: "328", volume: "4", note: "x" }, "an edited location keeps its volume and unknown fields");
  const otherVolume = sourceDraftPayload(Object.assign(sourceDraft(reference), { locationVolume: " 5 " }));
  assert.deepEqual(otherVolume.location, { scheme: "page", value: "327", volume: "5", note: "x" }, "the volume can be changed");
  const cleared = sourceDraftPayload(Object.assign(sourceDraft(reference), { locationScheme: "canonical", locationValue: "327a", locationVolume: "" }));
  assert.deepEqual(cleared.location, { scheme: "canonical", value: "327a", note: "x" }, "a volume the author cleared is removed");
  const fresh = sourceDraftPayload(Object.assign(sourceDraft(null, "reference"), { id: "n", of: "burnet-1902", locationScheme: "page", locationValue: "2", locationVolume: "3" }));
  assert.deepEqual(fresh.location, { scheme: "page", value: "2", volume: "3" });
  assert.equal(sourceTargetVolumes(sources, "burnet-1902"), 5);
  assert.equal(sourceTargetVolumes(sources, "missing"), 0);
  assert.equal(validateSourceDraft(Object.assign(sourceDraft(null, "reference"), { id: "n", of: "burnet-1902", locationVolume: "3" }), sources).field, "locationVolume");
  assert.equal(sourceDiagnosticControl("location.volume"), "locationVolume");
});

test("creator and identifier lines parse without trusting their content", () => {
  assert.deepEqual(parseSourceCreators("Ada | author\n\n  Bob  \nCarl | wizard"), [{ name: "Ada", role: "author" }, { name: "Bob" }, { name: "Carl | wizard" }]);
  assert.deepEqual(parseSourceIdentifiers("DOI: 10.1000/182\nurl: https://example.org/a:b\nloose"), [
    { scheme: "doi", value: "10.1000/182" },
    { scheme: "url", value: "https://example.org/a:b" },
    { scheme: "", value: "loose" },
  ]);
  const hostile = Object.assign(sourceDraft(null, "work"), { id: "w", title: "<img src=x onerror=alert(1)>", identifiers: "url: javascript:alert(1)" });
  const payload = sourceDraftPayload(hostile);
  assert.equal(payload.title, "<img src=x onerror=alert(1)>", "text stays data; the server decides what is unsafe");
  assert.deepEqual(payload.identifiers, [{ scheme: "url", value: "javascript:alert(1)" }]);
});

test("the advisory check names the first problem and the control that fixes it", () => {
  const sources = LIBRARY();
  const check = (changes, kind = "work") => validateSourceDraft(Object.assign(sourceDraft(null, kind), changes), sources);
  assert.equal(check({ id: "../x", title: "t" }).field, "id");
  assert.equal(check({ id: "Upper", title: "t" }).field, "id");
  assert.match(check({ id: "cave", title: "t" }).message, /already used/);
  assert.equal(check({ id: "w" }).field, "title");
  assert.equal(check({ id: "e", title: "t" }, "edition").field, "of");
  assert.equal(check({ id: "t", title: "t", of: "plato-republic" }, "translation").field, "language");
  assert.equal(check({ id: "r", of: "cave", locationScheme: "page" }, "reference").field, "locationValue");
  assert.equal(check({ id: "ok", title: "t" }), null);
  assert.equal(validateSourceDraft(sourceDraft(sources[0]), sources), null, "an existing id is not a duplicate of itself");
  assert.equal(sourceDiagnosticControl("identifiers[0]"), "identifiers");
  assert.equal(sourceDiagnosticControl("location.scheme"), "locationValue");
  assert.equal(sourceDiagnosticControl("kind"), "kind-field");
  assert.equal(sourceDiagnosticControl("unheard"), "");
});

// ---------------------------------------------------------------- the view

const listing = (sources = LIBRARY(), revision = "r1") => ({ file: ".openblog/private/research/sources.json", revision, stored: true, sources });

test("the library lists, searches, filters, and reopens each source with useful empty states", withDom(async () => {
  const { app, root } = mountSources(sourceApi({ "GET sources": () => listing() }));
  await app.showSources();
  assert.deepEqual(visibleIds(root), ["plato-republic", "slings-2003", "cave"]);
  assert.match(byId(root, "oba-source-count").textContent, /3 of 4 sources shown/);

  await type(byId(root, "oba-source-search"), "slings");
  assert.deepEqual(visibleIds(root), ["slings-2003"]);
  await type(byId(root, "oba-source-search"), "zzz");
  assert.match(root.querySelector("[data-source-empty]").textContent, /No sources match/);
  await type(byId(root, "oba-source-search"), "");
  await type(byId(root, "oba-source-archived"), "archived", "change");
  assert.deepEqual(visibleIds(root), ["bloom-1968"]);
  assert.match(itemFor(root, "bloom-1968").attributes["aria-label"], /archived/);
  await type(byId(root, "oba-source-archived"), "active", "change");
  await type(byId(root, "oba-source-kind"), "reference", "change");
  assert.deepEqual(visibleIds(root), ["cave"]);

  await itemFor(root, "cave").click();
  assert.equal(itemFor(root, "cave").attributes["aria-current"], "true");
  assert.equal(byId(root, "oba-source-id").attributes.readonly, "");
  assert.equal(byId(root, "oba-source-locationValue").value, "514a");
  assert.equal(document.activeElement, byId(root, "oba-source-heading"), "focus moves to the opened source");
  assert.ok(byId(root, "oba-source-of"), "a reference names what it points at");
  assert.equal(byId(root, "oba-source-basedOn"), null, "fields of other types stay hidden");
  const controls = [...root.querySelectorAll("input"), ...root.querySelectorAll("select"), ...root.querySelectorAll("textarea")];
  assert.ok(controls.length > 6);
  for (const control of controls) {
    assert.ok(root.querySelectorAll("label").some((label) => label.attributes.for === control.id), `${control.id} has a label`);
  }
}));

test("an empty library invites the first work and a damaged one is reported without a way to overwrite", withDom(async () => {
  const empty = mountSources(sourceApi({ "GET sources": () => listing([], "e") }));
  await empty.app.showSources();
  assert.match(empty.root.querySelector("[data-source-empty]").textContent, /library is empty/);

  const damaged = mountSources(sourceApi({
    "GET sources": () => {
      throw new ApiError("bad", 422, { file: ".openblog/private/research/sources.json", diagnostics: [{ sourceId: "w", field: "title", message: "is required" }] });
    },
  }));
  await damaged.app.showSources();
  assert.match(damaged.root.textContent, /title: is required/);
  assert.match(damaged.root.textContent, /Repair \.openblog\/private\/research\/sources\.json by hand/);
  assert.equal(damaged.root.querySelector("form"), null);
  assert.ok(damaged.root.querySelectorAll("p").some((p) => p.attributes.role === "alert"));
}));

test("creating, editing, and archiving name the library revision and update the list", withDom(async () => {
  let n = 1;
  const api = sourceApi({
    "GET sources": () => listing(),
    "POST sources": (body) => ({ revision: `r${++n}`, stored: true, source: body.source }),
    "PUT sources": (body) => ({ revision: `r${++n}`, stored: true, source: body.source }),
    "POST sources/archive": (body) => ({ revision: `r${++n}`, stored: true, source: { ...LIBRARY()[1], archived: body.archived } }),
  });
  const { app, root } = mountSources(api);
  await app.showSources();

  await buttonLabelled(root, "New source").click();
  await submit(root);
  assert.match(byId(root, "oba-source-error").textContent, /lowercase ASCII slug/);
  assert.equal(document.activeElement, byId(root, "oba-source-id"), "focus returns to the control that needs fixing");
  assert.equal(api.calls.length, 0, "an advisory failure sends nothing");
  await type(byId(root, "oba-source-id"), "new-work");
  await type(byId(root, "oba-source-title"), "A <b>New</b> Work");
  await submit(root);
  assert.deepEqual(api.calls[0], { method: "POST", path: "sources", body: { revision: "r1", source: { id: "new-work", kind: "work", title: "A <b>New</b> Work" } } });
  assert.ok(itemFor(root, "new-work"));
  assert.equal(itemFor(root, "new-work").children[0].textContent, "A <b>New</b> Work", "titles are text, never markup");
  assert.equal(byId(root, "oba-source-id").attributes.readonly, "", "a saved source reopens with a fixed id");
  assert.match(root.textContent, /saved\./);
  assert.equal(app.dirty, false);

  await type(byId(root, "oba-source-title"), "Renamed");
  assert.equal(app.dirty, true, "unsaved edits guard navigation");
  await submit(root);
  assert.deepEqual([api.calls[1].method, api.calls[1].body.revision, api.calls[1].body.source.title], ["PUT", "r2", "Renamed"]);

  await itemFor(root, "slings-2003").click();
  await root.querySelectorAll("button").find((button) => button.dataset.sourceArchive).click();
  assert.deepEqual(api.calls[2], { method: "POST", path: "sources/archive", body: { revision: "r3", id: "slings-2003", archived: true } });
  assert.equal(itemFor(root, "slings-2003"), undefined, "an archived source leaves the active list");
  assert.match(root.textContent, /archived\./);
  assert.ok(buttonLabelled(root, "Restore source"), "an archived source can be reopened and restored");
}));

test("a server rejection is scoped to the field, keeps the draft, and says nothing was stored", withDom(async () => {
  const api = sourceApi({
    "GET sources": () => listing(),
    "PUT sources": () => {
      throw new ApiError("invalid", 422, { diagnostics: [{ code: "invalid-identifier", sourceId: "slings-2003", field: "identifiers[0]", message: "unsafe scheme" }] });
    },
  });
  const { app, root } = mountSources(api);
  await app.showSources();
  await itemFor(root, "slings-2003").click();
  await type(byId(root, "oba-source-identifiers"), "url: javascript:alert(1)");
  await submit(root);
  assert.match(byId(root, "oba-source-error").textContent, /identifiers\[0\]: unsafe scheme/);
  assert.equal(document.activeElement, byId(root, "oba-source-identifiers"));
  assert.equal(byId(root, "oba-source-identifiers").attributes["aria-invalid"], "true");
  assert.equal(byId(root, "oba-source-identifiers").value, "url: javascript:alert(1)", "the draft is kept");
  assert.match(root.textContent, /stored library is unchanged/);
  assert.equal(root.querySelector("[data-source-conflict]"), null);
}));

test("a stale edit shows a conflict, keeps the draft, and only an explicit choice moves to the latest revision", withDom(async () => {
  const newer = { ...LIBRARY()[1], title: "Edited elsewhere" };
  let stored = "r1";
  const api = sourceApi({
    "GET sources": () => listing(stored === "r1" ? LIBRARY() : [LIBRARY()[0], newer, LIBRARY()[2], LIBRARY()[3]], stored),
    "PUT sources": (body) => {
      if (body.revision !== stored) throw new ApiError("conflict", 409, { conflict: true, revision: stored, current: newer });
      return { revision: "r9", stored: true, source: body.source };
    },
  });
  const { app, root } = mountSources(api);
  await app.showSources();
  await itemFor(root, "slings-2003").click();
  stored = "r2";
  await type(byId(root, "oba-source-title"), "My title");
  await submit(root);
  assert.ok(root.querySelector("[data-source-conflict]"));
  assert.match(root.textContent, /nothing was saved/);
  assert.equal(byId(root, "oba-source-title").value, "My title", "the draft survives the conflict");
  assert.equal(api.calls.length, 1);
  await submit(root);
  assert.equal(api.calls.length, 1, "a conflicted draft cannot be resubmitted blindly");

  const buttons = root.querySelectorAll("button").filter((button) => button.dataset.sourceConflictUse);
  assert.deepEqual(buttons.map((button) => button.dataset.sourceConflictUse), ["stored", "draft"]);
  await buttons[1].click();
  assert.equal(root.querySelector("[data-source-conflict]"), null);
  assert.equal(byId(root, "oba-source-title").value, "My title");
  await submit(root);
  assert.deepEqual([api.calls.at(-1).method, api.calls.at(-1).body.revision, api.calls.at(-1).body.source.title], ["PUT", "r2", "My title"]);

  // Choosing the stored copy discards the draft instead.
  stored = "r3";
  await type(byId(root, "oba-source-title"), "Again");
  await submit(root);
  await root.querySelectorAll("button").find((button) => button.dataset.sourceConflictUse === "stored").click();
  assert.equal(byId(root, "oba-source-title").value, "Edited elsewhere");
  assert.equal(app.dirty, false);
}));

// ---------------------------------------------------------------- shell, accessibility, and escaping

const sourceView = () => admin.slice(admin.indexOf("async showSources("), admin.indexOf("// ---- analytics"));

test("the sources route is reachable from the research tools, the palette, and the router", () => {
  assert.equal(researchHref("sources"), "#/research/sources");
  assert.equal(canonicalAdminHash("#/sources"), "#/research/sources", "the earlier address redirects");
  assert.match(admin, /panel === "sources"\) await this\.showSources\(id\)/, "an address can name the source to open");
  assert.equal(researchHref("sources", "plato"), "#/research/sources/plato");
  assert.match(admin, /label: "Sources", category: "Research"/);
  assert.match(sourceView(), /"sources\/archive"/);
  assert.doesNotMatch(sourceView(), /innerHTML|insertAdjacentHTML|outerHTML/, "source text is never parsed as markup");
});

test("source controls are labelled, reflow on small screens, and add no motion", () => {
  const view = sourceView();
  assert.match(view, /"aria-live": "polite"/);
  assert.match(view, /role: "alert"/);
  assert.match(view, /"aria-current": selected === source\.id/);
  assert.match(view, /aria-invalid/);
  assert.match(styles, /\.oba-source-item:focus-visible/);
  const css = styles.slice(styles.indexOf("/* Research source library */"), styles.indexOf("/* Anchors styled as buttons"));
  assert.match(css, /@media \(max-width: 52rem\)[\s\S]*\.oba-source-layout[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /transition|animation/);
  assert.match(css, /min-height: 44px/);
});

// ---------------------------------------------------------------- import and export

const PLAN = (counts, entries) => ({ counts: { create: 0, update: 0, unchanged: 0, conflict: 0, ...counts }, entries, diagnostics: [] });
const CREATE_ENTRY = { index: 0, cslId: "Plato-Republic", sourceId: "plato-republic", action: "create", changes: [], kept: [], unsupported: [{ field: "note", reason: "private notes and abstracts are never imported" }], diagnostics: [] };

test("import previews are summarised with kept and unsupported fields and every conflict", () => {
  assert.equal(sourceImportSummary(PLAN({ create: 2, update: 1, conflict: 1 })), "2 new, 1 updated, 1 in conflict");
  assert.equal(sourceImportSummary(PLAN({})), "Nothing to import");
  const rows = sourceImportRows(PLAN({ create: 1, update: 1, conflict: 2 }, [
    CREATE_ENTRY,
    { index: 1, cslId: "x", sourceId: "x", action: "update", changes: [{ field: "title" }], kept: ["of", "creators"], unsupported: [], diagnostics: [] },
    { index: 2, cslId: null, sourceId: null, action: "conflict", changes: [], kept: [], unsupported: [], diagnostics: [{ field: "id", message: "every item needs a non-empty `id`" }] },
    { index: 3, cslId: "Π", sourceId: "csl-0123", action: "conflict", changes: [], kept: [], unsupported: [], diagnostics: [{ message: "shares an identifier" }] },
  ]));
  assert.deepEqual(rows[0], { action: "create", label: "New", name: "plato-republic (from Plato-Republic)", details: ["Not imported: note (private notes and abstracts are never imported)"] });
  assert.deepEqual(rows[1].details, ["Changes title", "Keeps of, creators as they are"]);
  assert.deepEqual([rows[2].name, rows[2].details], ["Item 3", ["id: every item needs a non-empty `id`"]]);
  assert.equal(rows[3].name, "csl-0123 (from Π)");
  assert.deepEqual(sourceExportLossNotes([{ sourceId: "a", field: "kind" }, { sourceId: "a", field: "of" }, { sourceId: "b", field: "location" }, { sourceId: "a", field: "kind" }]), ["a: kind, of", "b: location"]);
  assert.deepEqual(sourceExportLossNotes(undefined), []);
});

test("an import is previewed first, applies only the previewed text, and reports conflicts without saving", withDom(async () => {
  const csl = '[{"id":"Plato-Republic","title":"<b>Πολιτεία</b>"}]';
  const plan = PLAN({ create: 1 }, [CREATE_ENTRY]);
  const api = sourceApi({
    "GET sources": () => listing(),
    "POST sources/import": (body) => {
      if (body.content.includes("bad")) throw new ApiError("conflict", 422, { diagnostics: [{ sourceId: "bad", field: "identifiers[0]", message: "must be an absolute HTTP(S) URL" }], plan: PLAN({ conflict: 1 }, [{ ...CREATE_ENTRY, action: "conflict", sourceId: "bad", cslId: "bad", unsupported: [], diagnostics: [{ field: "identifiers[0]", message: "must be an absolute HTTP(S) URL" }] }]) });
      if (body.revision === "stale") throw new ApiError("changed", 409, { conflict: true });
      return body.apply
        ? { revision: "r2", applied: true, applicable: true, plan, sources: [...LIBRARY(), { id: "plato-republic-2", kind: "work", title: "Imported" }] }
        : { revision: body.revision, applied: false, applicable: true, plan };
    },
  });
  const { app, root } = mountSources(api);
  await app.showSources();
  const text = byId(root, "oba-source-import-text");
  const applyButton = buttonLabelled(root, "Apply import");
  assert.equal(applyButton.hidden, true, "nothing can be applied before a preview");
  assert.ok(root.querySelectorAll("label").some((label) => label.attributes.for === "oba-source-import-text"));
  assert.ok(root.querySelectorAll("label").some((label) => label.attributes.for === "oba-source-import-file"));

  await buttonLabelled(root, "Preview import").click();
  assert.match(root.textContent, /Paste CSL JSON or choose a file first/);
  assert.equal(document.activeElement, text);

  text.value = csl;
  await buttonLabelled(root, "Preview import").click();
  assert.deepEqual(api.calls[0], { method: "POST", path: "sources/import", body: { revision: "r1", content: csl, apply: false } });
  assert.match(byId(root, "oba-source-import-result").textContent, /Preview: 1 new\. Nothing has been saved\./);
  assert.match(byId(root, "oba-source-import-result").textContent, /Not imported: note/);
  assert.equal(applyButton.hidden, false);
  assert.equal(document.activeElement, byId(root, "oba-source-import-result"), "focus moves to the preview");

  // Editing the text invalidates the preview.
  await type(text, csl.replace("Πολιτεία", "Other"));
  assert.equal(applyButton.hidden, true);
  await buttonLabelled(root, "Preview import").click();
  await applyButton.click();
  assert.equal(api.calls.at(-1).body.apply, true);
  assert.equal(api.calls.at(-1).body.revision, "r1");
  assert.match(byId(root, "oba-source-import-result").textContent, /Imported: 1 new\./);
  assert.ok(itemFor(root, "plato-republic-2"), "the list shows the imported source");
  assert.equal(applyButton.hidden, true);

  // A conflict is shown per item and offers no way to apply.
  await type(text, '[{"id":"bad"}]');
  await buttonLabelled(root, "Preview import").click();
  assert.match(byId(root, "oba-source-import-result").textContent, /Conflict: bad/);
  assert.match(byId(root, "oba-source-import-result").textContent, /identifiers\[0\]: must be an absolute HTTP\(S\) URL/);
  assert.equal(applyButton.hidden, true);
  assert.match(root.textContent, /Nothing was saved/);
}));

test("exports download the file and name what the format could not carry", withDom(async () => {
  const downloads = [];
  const previous = { URL: globalThis.URL, Blob: globalThis.Blob };
  globalThis.URL = Object.assign(function URLShim() {}, { createObjectURL: (blob) => (downloads.push(blob), "blob:test"), revokeObjectURL() {} });
  globalThis.Blob = class { constructor(parts, options) { this.text = parts.join(""); this.type = options.type; } };
  try {
    const api = sourceApi({
      "GET sources": () => listing(),
      "GET sources/export?format=bibtex": () => ({ filename: "open-blog-sources.bib", mediaType: "application/x-bibtex", count: 4, content: "@misc{a,\n}\n", losses: [{ sourceId: "slings-2003", field: "kind" }, { sourceId: "slings-2003", field: "of" }] }),
      "GET sources/export?format=csl-json": () => { throw new ApiError("damaged", 422, { diagnostics: [{ sourceId: "w", field: "title", message: "is required" }] }); },
    });
    const { app, root } = mountSources(api);
    await app.showSources();
    await buttonLabelled(root, "Export BibTeX").click();
    assert.equal(downloads[0].text, "@misc{a,\n}\n");
    assert.match(downloads[0].type, /^application\/x-bibtex;charset=utf-8$/);
    assert.match(root.textContent, /Exported 4 sources as open-blog-sources\.bib\. This format cannot carry: slings-2003: kind, of\./);
    await buttonLabelled(root, "Export CSL JSON").click();
    assert.equal(downloads.length, 1, "a failed export downloads nothing");
    assert.match(root.textContent, /title: is required/);
  } finally {
    Object.assign(globalThis, previous);
  }
}));
