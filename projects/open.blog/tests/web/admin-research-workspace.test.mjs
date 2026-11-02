import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_MODULE_DETAILS,
  ADMIN_MODULE_LABELS,
  ADMIN_OPTIONAL_MODULES,
  ObAdmin,
  RESEARCH_PANELS,
  WORKSPACE_VISIBILITY,
  adminToolGroups,
  canonicalAdminHash,
  draftRoute,
  normalizeAdminPreferences,
  planWorkspaceNavigation,
  researchHref,
  researchPanelForRoute,
  unsavedWorkQuestion,
  visibleAdminModules,
  workspacePanelKey,
} from "../../web/admin/admin.js";

// The research workspace in Admin navigation (A8.1, ADR 0120 and ADR 0121): one route namespace
// with the earlier routes redirected, private research and the publishable draft told apart in
// words and data, landmarks with a skip link and focus on route change, presets that place the
// workspace in the main navigation, and panels with unsaved changes kept while another opens.

const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");

// ---------------------------------------------------------------- DOM shim

// Mirrors the browser properties the workspace relies on: `childNodes` includes text nodes,
// `isConnected` is true only under the document, `focus()` moves focus only to a focusable
// element (a control, a link with href, or anything with tabindex), and `preventDefault()`
// sets `defaultPrevented`.
const FOCUSABLE = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

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
    this.classList = { contains: (name) => (this.className || "").split(/\s+/).includes(name), add() {}, remove() {} };
  }
  get childNodes() {
    return [...this.children];
  }
  get parentNode() {
    return this.parent;
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
      const node = child instanceof DomNode ? child : Object.assign(new DomNode("#text", this.owner), { textContent: String(child) });
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
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
  get isConnected() {
    for (let node = this; node; node = node.parent) if (node === this.owner?.body) return true;
    return false;
  }
  addEventListener(name, listener, options = {}) {
    (this.listeners[name] ||= []).push({ listener, once: Boolean(options.once) });
  }
  dispatch(name, event = {}) {
    const listeners = this.listeners[name] || [];
    this.listeners[name] = listeners.filter((entry) => !entry.once);
    const payload = { type: name, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    return Promise.all(listeners.map((entry) => entry.listener(payload))).then(() => payload);
  }
  click() {
    if (this.disabled) return Promise.resolve({ defaultPrevented: false });
    return this.dispatch("click");
  }
  focus() {
    const focusable = FOCUSABLE.has(this.tagName) || (this.tagName === "A" && "href" in this.attributes) || "tabindex" in this.attributes;
    if (focusable && !this.disabled) this.owner.activeElement = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
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
    const attribute = selector.match(/^([a-z]*)\[([a-z-]+)(?:="([^"]*)")?\]$/);
    if (attribute) {
      const [, tag, name, value] = attribute;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (name === "open") return this.open;
      if (!(name in this.attributes)) return false;
      return value === undefined || this.attributes[name] === value;
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

function installDom(hash = "#/overview") {
  const previous = { Node: globalThis.Node, document: globalThis.document, location: globalThis.location, history: globalThis.history, confirm: globalThis.confirm };
  const documentShim = {
    activeElement: null,
    documentElement: { dataset: {} },
    title: "",
    createElement: (tag) => new DomNode(tag, documentShim),
    createTextNode: (text) => Object.assign(new DomNode("#text", documentShim), { textContent: String(text) }),
    querySelector: (selector) => documentShim.body.querySelector(selector),
  };
  documentShim.body = new DomNode("body", documentShim);
  documentShim.activeElement = documentShim.body;
  const location = { hash };
  const replaced = [];
  const questions = [];
  const answers = [];
  globalThis.Node = DomNode;
  globalThis.document = documentShim;
  globalThis.location = location;
  // Like the browser's: the address changes and no hashchange event fires.
  globalThis.history = { replaceState: (_state, _title, url) => { replaced.push(url); location.hash = url; } };
  globalThis.confirm = (question) => {
    questions.push(question);
    return answers.length ? answers.shift() : true;
  };
  return {
    document: documentShim,
    location,
    replaced,
    questions,
    answers,
    restore() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    },
  };
}

const withDom = (run, hash) => async () => {
  const dom = installDom(hash);
  try {
    await run(dom);
  } finally {
    dom.restore();
  }
};

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function fakeApi(handlers = {}) {
  const calls = [];
  // The session the server confirms before a kept panel returns: the writer's, unless a test says otherwise.
  const routes = { "GET session": () => ({ csrf: "same", user: "writer" }), ...handlers };
  return {
    calls,
    async call(method, path, options = {}) {
      if (method !== "GET") calls.push({ method, path, body: structuredClone(options.json) });
      const handler = routes[`${method} ${path}`];
      if (!handler) throw new ApiError(`unexpected ${method} ${path}`, 500, null);
      return handler(options.json);
    },
  };
}

function mountApp(api, preset = "advanced") {
  const app = new ObAdmin();
  const root = new DomNode("ob-admin", globalThis.document);
  globalThis.document.body.append(root);
  app.api = api;
  app.user = "writer";
  app.meta = { siteTitle: "Blog" };
  app.preferences = normalizeAdminPreferences({ preset });
  app.replaceChildren = (...nodes) => root.replaceChildren(...nodes);
  app.querySelector = (selector) => root.querySelector(selector);
  app.querySelectorAll = (selector) => root.querySelectorAll(selector);
  app.contains = (node) => root.contains(node);
  return { app, root };
}

const node = (tag, text = "", attributes = {}) => {
  const element = new DomNode(tag, globalThis.document);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text) element.textContent = text;
  return element;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const go = async (app, hash) => {
  globalThis.location.hash = hash;
  await app.onHash();
};
const type = async (control, value) => {
  control.value = value;
  await control.dispatch("input", { target: control });
};
const buttonLabelled = (root, text) => root.querySelectorAll("button").find((button) => button.textContent === text);
const researchNav = (root) => root.querySelectorAll("nav").find((nav) => nav.attributes["aria-label"] === "Research workspace") || null;
const navItem = (root, key) => researchNav(root)?.querySelectorAll("li").find((item) => item.dataset.researchPanel === key) || null;
const byId = (root, id) => root.querySelector(`#${id}`);

const LIBRARY = () => ({ file: ".openblog/private/research/sources.json", revision: "r1", stored: true, sources: [{ id: "plato", kind: "work", title: "Πολιτεία" }] });
const NOTEBOOK = () => ({ file: ".openblog/private/research/notebook.json", revision: "n1", stored: true, sources: LIBRARY().sources, passages: [], notes: [] });

/** A stand-in for a mounted editor: what the workspace asks of one, and a record of what it did. */
function fakeEditor(title = "A <b>draft</b>") {
  const surface = node("textarea", "", { "aria-label": "Markdown" });
  const panes = { evidence: node("section", "", { "data-pane": "evidence" }) };
  const content = node("div", "", { class: "oba-editor" });
  content.append(surface, panes.evidence);
  const log = [];
  return {
    log,
    content,
    surface,
    saving: false,
    root: Object.assign(content, { dataset: { editorView: "write" } }),
    currentTitle: () => title,
    suspend: () => log.push("suspend"),
    resume: () => log.push("resume"),
    dispose: () => log.push("dispose"),
    writingSurface: () => surface,
    activatePane: (pane) => log.push(`pane:${pane}`),
  };
}

/** Open a fake editor the way showEditor does: workspace draft, shell, then the editor. */
function openFakeEditor(app, hash, editor) {
  globalThis.location.hash = hash;
  app.workspaceDraft = { hash, kind: "posts", title: editor.currentTitle() };
  app.mount(app.shell("posts", editor.content));
  app.editor = editor;
  app.currentHash = hash;
}

// ---------------------------------------------------------------- routes

test("research panels share one route namespace and the earlier routes redirect into it", () => {
  assert.deepEqual(RESEARCH_PANELS.map((panel) => panel.id), ["overview", "sources", "notebook", "atlas", "compare", "public"]);
  assert.equal(researchHref("public", "x"), "#/research/public", "What will be public opens no item by id");
  assert.equal(researchHref("overview"), "#/research/overview");
  assert.equal(researchHref("atlas", "the good/2"), "#/research/atlas/the%20good%2F2", "an item id is one encoded segment");
  assert.equal(researchHref("notebook", "cave"), "#/research/notebook", "panels that do not open items by id ignore one");
  assert.equal(researchHref("sources", "plato"), "#/research/sources/plato", "Sources opens a source by id");
  assert.equal(researchHref("missing"), "#/research/overview");

  assert.equal(canonicalAdminHash("#/sources"), "#/research/sources");
  assert.equal(canonicalAdminHash("#/research"), "#/research/notebook", "the bare route was the notebook's and still opens it");
  assert.equal(canonicalAdminHash("#/atlas"), "#/research/atlas");
  assert.equal(canonicalAdminHash("#/atlas/the%20good"), "#/research/atlas/the%20good", "the item stays encoded as it was");
  assert.equal(canonicalAdminHash("#/compare/opening?layout=x"), "#/research/compare/opening?layout=x", "a query is kept");
  assert.equal(canonicalAdminHash("#/research/atlas/plato"), "#/research/atlas/plato", "canonical routes are unchanged");
  assert.equal(canonicalAdminHash("#/research/notebook/stray"), "#/research/notebook", "a panel without items drops a stray segment");
  assert.equal(canonicalAdminHash("#/research/<img src=x>"), "#/research/overview", "an unknown panel opens the workflow");
  for (const hash of ["#/overview", "#/posts?status=draft", "#/edit/posts%2Fa.md", "#/new/posts", "#/shared/accept/abc", "", "#/analytics/30"]) {
    assert.equal(canonicalAdminHash(hash), hash, `${hash || "no hash"} is not a research route`);
  }
});

test("every address names its workspace panel, and a draft's views are one draft", () => {
  assert.equal(workspacePanelKey("#/research/overview"), "overview");
  assert.equal(workspacePanelKey("#/sources"), "sources");
  assert.equal(workspacePanelKey("#/research"), "notebook");
  assert.equal(workspacePanelKey("#/atlas/plato"), "atlas");
  assert.equal(workspacePanelKey("#/edit/posts%2Fa.md?pane=evidence"), "draft");
  assert.equal(workspacePanelKey("#/new/pages"), "draft");
  assert.equal(workspacePanelKey("#/new/nonsense"), null);
  assert.equal(workspacePanelKey("#/posts"), null);
  assert.equal(workspacePanelKey("#/overview"), null);
  assert.equal(workspacePanelKey(""), null);
  assert.equal(draftRoute("#/edit/posts%2Fa.md?pane=evidence"), "#/edit/posts%2Fa.md");
  assert.equal(researchPanelForRoute("research"), "notebook", "the notebook view's shell route");
  assert.equal(researchPanelForRoute("research-overview"), "overview");
  assert.equal(researchPanelForRoute("posts"), null);
});

test("switching panels keeps unsaved work, and only discarding it asks first", () => {
  const plan = (options) => planWorkspaceNavigation(options);
  const none = { keep: null, restore: null, discard: [], confirm: [] };
  assert.deepEqual(plan({ fromHash: "#/edit/posts%2Fa.md", toHash: "#/research/sources", currentDirty: true }), { ...none, keep: "draft" });
  assert.deepEqual(plan({ fromHash: "#/research/notebook", toHash: "#/research/atlas", currentDirty: true }), { ...none, keep: "notebook" });
  assert.deepEqual(plan({ fromHash: "#/research/notebook", toHash: "#/research/atlas", currentDirty: false }), none, "a clean panel reloads fresh");
  assert.deepEqual(plan({ fromHash: "#/edit/posts%2Fa.md", toHash: "#/research/sources", currentDirty: true, saving: true }), { ...none, confirm: ["draft"] }, "a draft is never kept mid-save");
  assert.deepEqual(plan({ fromHash: "#/research/sources", toHash: "#/research/notebook", currentDirty: true, saving: true }), { ...none, confirm: ["sources"] }, "nor is a research panel");
  assert.deepEqual(plan({ fromHash: "#/research/atlas/plato", toHash: "#/research/atlas/socrates", currentDirty: true }), { ...none, confirm: ["atlas"] }, "reloading the same panel asks");
  assert.deepEqual(plan({ fromHash: "#/research/notebook", toHash: "#/posts", currentDirty: true }), { ...none, confirm: ["notebook"] }, "leaving the workspace asks");
  assert.deepEqual(plan({ fromHash: "#/contributors", toHash: "#/research/sources", currentDirty: true }), { ...none, confirm: ["current"] }, "a view outside the workspace is never kept");

  const keptDraft = { key: "draft", hash: "#/edit/posts%2Fa.md", dirty: true };
  assert.deepEqual(plan({ fromHash: "#/research/sources", toHash: "#/edit/posts%2Fa.md?pane=evidence", kept: [keptDraft] }), { ...none, restore: "draft" }, "the kept draft opens on another of its views");
  assert.deepEqual(plan({ fromHash: "#/research/sources", toHash: "#/edit/posts%2Fb.md", kept: [keptDraft] }), { ...none, discard: ["draft"], confirm: ["draft"] }, "another document replaces the kept draft only after asking");
  assert.deepEqual(plan({ fromHash: "#/research/sources", toHash: "#/analytics", currentDirty: true, kept: [keptDraft, { key: "atlas", hash: "#/research/atlas", dirty: true }] }), { ...none, discard: ["draft", "atlas"], confirm: ["sources", "draft", "atlas"] });
  assert.deepEqual(plan({ fromHash: "#/research/sources", toHash: "#/research/compare", currentDirty: true, kept: [keptDraft] }), { ...none, keep: "sources" }, "other kept panels stay kept");
  assert.deepEqual(plan({ fromHash: "", toHash: "#/research/sources" }), none, "the first route has nothing to keep");
});

test("the unsaved-work question names every place the work is in", () => {
  assert.equal(unsavedWorkQuestion([]), "You have unsaved changes. Leave without saving?");
  assert.equal(unsavedWorkQuestion([""]), "You have unsaved changes. Leave without saving?");
  assert.equal(unsavedWorkQuestion(["Notebook"]), "You have unsaved changes in Notebook. Leave without saving?");
  assert.equal(unsavedWorkQuestion(["", "Notebook", "the draft “A”"]), "You have unsaved changes in this view, Notebook and the draft “A”. Leave without saving?");
});

// ---------------------------------------------------------------- presets

test("the research workspace is an optional module every preset keeps reachable", () => {
  assert.ok(ADMIN_OPTIONAL_MODULES.includes("research"));
  assert.equal(ADMIN_MODULE_LABELS.research, "Research workspace");
  assert.ok(ADMIN_MODULE_DETAILS.research);
  assert.deepEqual(visibleAdminModules({ preset: "simple" }), [], "Simple keeps the main navigation to content");
  assert.ok(visibleAdminModules({ preset: "guided" }).includes("research"));
  assert.ok(visibleAdminModules({ preset: "advanced" }).includes("research"));
  assert.ok(!visibleAdminModules({ preset: "custom", hiddenModules: ["research"] }).includes("research"));
  const review = adminToolGroups({ preset: "simple" }, ["research", "analytics"]).find((group) => group.goal === "review");
  assert.deepEqual(review.modules, ["research"], "Advanced tools offers it even in Simple");
  // Preferences saved before the workspace existed gain it, shown or hidden as Evidence Studio
  // was, since research used to show only with it.
  const before = ["social", "release", "field", "optimize", "accessibility", "evidence", "assistant", "analytics", "contributors", "public-site"];
  const earlier = normalizeAdminPreferences({ preset: "custom", moduleOrder: before, hiddenModules: ["social"] });
  assert.equal(earlier.moduleOrder.at(-1), "research");
  assert.ok(visibleAdminModules(earlier).includes("research"));
  const hidEvidence = normalizeAdminPreferences({ preset: "custom", moduleOrder: before, hiddenModules: ["evidence"] });
  assert.ok(!visibleAdminModules(hidEvidence).includes("research"));
});

// ---------------------------------------------------------------- shell, landmarks and labels

test("the shell has a skip link to the main landmark and a focusable page heading", withDom(async (dom) => {
  const { app, root } = mountApp(fakeApi());
  app.mount(app.shell("overview", node("p", "content")));
  const shell = root.children[0];
  const skip = shell.children[0];
  assert.equal(skip.tagName, "A", "the skip link is the first thing in the shell");
  assert.equal(skip.textContent, "Skip to main content");
  const main = root.querySelector("main");
  assert.equal(main.id, "oba-main");
  assert.equal(skip.attributes.href, "#oba-main");
  const event = await skip.click();
  assert.equal(event.defaultPrevented, true, "the router's hash is left alone");
  assert.equal(dom.location.hash, "#/overview");
  assert.equal(dom.document.activeElement, main, "focus moves into the main landmark");
  const heading = byId(root, "oba-page-heading");
  assert.equal(heading.tagName, "H1");
  assert.equal(heading.attributes.tabindex, "-1");
  assert.equal(researchNav(root), null, "outside the workspace there is no research navigation");
}));

test("research panels are listed as private and the draft as publishable, in words and data", withDom(async () => {
  const { app, root } = mountApp(fakeApi(), "simple");
  app.workspaceDraft = { hash: "#/edit/posts%2Fa.md", kind: "posts", title: "A <b>draft</b>" };
  app.mount(app.shell("atlas", node("p", "atlas")));
  const nav = researchNav(root);
  assert.ok(nav, "a research panel always shows the workspace navigation, whatever the preset");
  assert.equal(nav.attributes["data-admin-module"], undefined, "no preset hides it on its own panels");
  const groups = nav.querySelectorAll("div").filter((group) => group.classList.contains("oba-research-group"));
  assert.deepEqual(groups.map((group) => group.dataset.visibility), ["private", "publishable"]);
  assert.deepEqual(groups.map((group) => group.querySelector(".oba-visibility").textContent), [WORKSPACE_VISIBILITY.private.label, WORKSPACE_VISIBILITY.publishable.label]);
  for (const group of groups) {
    const label = group.querySelector(".oba-visibility");
    assert.equal(group.querySelector("ul").attributes["aria-labelledby"], label.id, "each list is named by its visibility");
    for (const link of group.querySelectorAll("a")) {
      assert.ok(link.attributes["aria-describedby"].split(" ").includes(label.id), `${link.textContent} is described as ${label.textContent}`);
      assert.equal(link.parent.dataset.visibility, group.dataset.visibility);
    }
  }
  const links = nav.querySelectorAll("a");
  assert.deepEqual(links.map((link) => link.textContent), ["Workflow", "Sources", "Notebook", "Atlas", "Compare", "What will be public", "Claims", "Draft"]);
  assert.deepEqual(links.map((link) => link.attributes.href), ["#/research/overview", "#/research/sources", "#/research/notebook", "#/research/atlas", "#/research/compare", "#/research/public", "#/edit/posts%2Fa.md?pane=evidence", "#/edit/posts%2Fa.md"]);
  assert.deepEqual(links.filter((link) => link.attributes["aria-current"] === "page").map((link) => link.textContent), ["Atlas"]);
  assert.equal(navItem(root, "draft").querySelector("bdi").textContent, "A <b>draft</b>", "the draft's title is text");
  assert.equal(root.querySelector("[data-workspace-visibility]").dataset.visibility, "private");
  assert.equal(root.querySelector("[data-workspace-visibility]").textContent, WORKSPACE_VISIBILITY.private.detail);
  assert.equal(byId(root, "oba-page-heading").textContent, "Knowledge Atlas");
  // The toolbelt marks the workspace the page belongs to, without a second current page.
  const toolbelt = root.querySelector("nav");
  assert.deepEqual(toolbelt.querySelectorAll("a").filter((link) => link.attributes["aria-current"]).map((link) => [link.textContent, link.attributes["aria-current"]]), [["Research workspace", "true"]]);
}));

test("without an open draft the workspace offers to start one and has no claims link", withDom(async () => {
  const { app, root } = mountApp(fakeApi());
  app.mount(app.shell("research-overview", node("p", "x")));
  assert.equal(navItem(root, "claims"), null);
  assert.equal(navItem(root, "draft").querySelector("a").attributes.href, "#/new/posts");
  assert.match(navItem(root, "draft").textContent, /No draft open: start a post/);
}));

test("beside a draft the workspace navigation follows the preset and labels the draft publishable", withDom(async () => {
  for (const [preset, shown] of [["simple", false], ["guided", true], ["advanced", true], ["custom", true]]) {
    const { app, root } = mountApp(fakeApi(), preset);
    openFakeEditor(app, "#/edit/posts%2Fa.md", fakeEditor());
    const nav = researchNav(root);
    assert.equal(Boolean(nav) && !nav.hidden, shown, `${preset} ${shown ? "shows" : "hides"} it beside a draft`);
    if (!shown) continue;
    assert.equal(nav.attributes["data-admin-module"], "research", "it follows later preference changes");
    assert.equal(nav.querySelector('a[aria-current="page"]').textContent, "Draft");
    assert.equal(root.querySelector("[data-workspace-visibility]").dataset.visibility, "publishable");
    assert.equal(root.querySelector("[data-workspace-visibility]").textContent, WORKSPACE_VISIBILITY.publishable.detail);
  }
}));

// ---------------------------------------------------------------- routing

test("an earlier research route redirects in place and opens its item", withDom(async (dom) => {
  const { app } = mountApp(fakeApi());
  const opened = [];
  app.showAtlas = async (id) => opened.push(["atlas", id]);
  app.showCompare = async (id) => opened.push(["compare", id]);
  app.showResearch = async () => opened.push(["notebook"]);
  app.showSources = async () => opened.push(["sources"]);
  app.showResearchOverview = async () => opened.push(["overview"]);
  for (const [hash, canonical] of [["#/atlas/the%20good", "#/research/atlas/the%20good"], ["#/compare/opening", "#/research/compare/opening"], ["#/research", "#/research/notebook"], ["#/sources", "#/research/sources"], ["#/research/nope", "#/research/overview"]]) {
    await go(app, hash);
    assert.equal(dom.location.hash, canonical);
    assert.equal(dom.replaced.at(-1), canonical, "no extra history entry");
    assert.equal(app.currentHash, canonical);
  }
  assert.deepEqual(opened, [["atlas", "the good"], ["compare", "opening"], ["notebook"], ["sources"], ["overview"]]);
}));

test("a source draft is kept while another panel opens, and returns exactly as left", withDom(async (dom) => {
  const api = fakeApi({
    "GET sources": () => LIBRARY(),
    "POST sources": (body) => ({ revision: "r2", stored: true, source: body.source }),
  });
  const { app, root } = mountApp(api);
  app.showResearch = async function () {
    this.mount(this.shell("research", node("p", "the notebook")));
  };
  await go(app, "#/research/sources");
  await buttonLabelled(root, "New source").click();
  await type(byId(root, "oba-source-id"), "republic");
  await type(byId(root, "oba-source-title"), "The Republic");
  const title = byId(root, "oba-source-title");
  const version = app.viewVersion;
  assert.equal(app.hasUnsavedView(), true);

  await go(app, "#/research/notebook");
  assert.deepEqual(dom.questions, [], "switching panels asks nothing");
  assert.match(root.textContent, /the notebook/);
  assert.equal(byId(root, "oba-source-title"), null);
  assert.deepEqual([...app.kept.keys()], ["sources"]);
  assert.equal(navItem(root, "sources").querySelector(".oba-research-kept").textContent, "Unsaved changes kept");
  assert.ok(navItem(root, "sources").querySelector("a").attributes["aria-describedby"].includes("oba-research-sources-kept"), "the kept state is part of the link's description");
  assert.equal(app.hasUnsavedWork(), true, "leaving the page still warns");

  await go(app, "#/research/sources");
  assert.deepEqual(dom.questions, []);
  assert.equal(byId(root, "oba-source-title"), title, "the same form, not a reload");
  assert.equal(title.value, "The Republic");
  assert.equal(app.kept.size, 0);
  assert.equal(app.viewVersion, version, "the panel's pending work applies to it again");
  assert.equal(dom.document.activeElement, byId(root, "oba-page-heading"), "focus starts at the page heading");
  await tick();
  assert.match(root.querySelector("[data-workspace-status]").textContent, /Sources is as you left it, with your unsaved changes\./);

  await root.querySelector("form").dispatch("submit");
  assert.equal(api.calls[0].body.source.title, "The Republic");
  assert.match(root.textContent, /The Republic saved\./, "the restored panel takes its save result");
  assert.equal(app.hasUnsavedView(), false);
}));

test("a source save in flight is never kept, so its result lands and the next save sends its revision", withDom(async (dom) => {
  let finish;
  const api = fakeApi({
    "GET sources": () => LIBRARY(),
    "POST sources": (body) => new Promise((resolve) => {
      finish = () => resolve({ revision: "r2", stored: true, source: body.source });
    }),
    "PUT sources": (body) => ({ revision: "r3", stored: true, source: body.source }),
  });
  const { app, root } = mountApp(api);
  app.showResearch = async function () {
    this.mount(this.shell("research", node("p", "the notebook")));
  };
  await go(app, "#/research/sources");
  await buttonLabelled(root, "New source").click();
  await type(byId(root, "oba-source-id"), "republic");
  await type(byId(root, "oba-source-title"), "The Republic");
  const saving = root.querySelector("form").dispatch("submit");
  assert.equal(app.isSavingView(), true);

  dom.answers.push(false);
  await go(app, "#/research/notebook");
  assert.deepEqual(dom.questions, ["You have unsaved changes in Sources. Leave without saving?"], "a panel mid-save is asked about, not kept");
  assert.equal(app.kept.size, 0);
  assert.equal(dom.location.hash, "#/research/sources");

  finish();
  await saving;
  assert.match(root.textContent, /The Republic saved\./, "the save's result reaches the open panel");
  await type(byId(root, "oba-source-title"), "The Republic, revised");
  await root.querySelector("form").dispatch("submit");
  assert.equal(api.calls.at(-1).method, "PUT");
  assert.equal(api.calls.at(-1).body.revision, "r2", "the next save names the revision the first one produced");
}));

test("an earlier address of the open panel corrects the address without reloading it", withDom(async (dom) => {
  const { app, root } = mountApp(fakeApi({ "GET sources": () => LIBRARY() }));
  let notebookMounts = 0;
  app.showResearch = async function () {
    notebookMounts += 1;
    this.mount(this.shell("research", node("p", "the notebook")));
  };
  await go(app, "#/research/sources");
  await buttonLabelled(root, "New source").click();
  const title = byId(root, "oba-source-title");
  await type(title, "Unsaved");
  await go(app, "#/sources");
  assert.deepEqual(dom.questions, [], "nothing is asked");
  assert.equal(dom.location.hash, "#/research/sources");
  assert.equal(dom.replaced.at(-1), "#/research/sources");
  assert.equal(byId(root, "oba-source-title"), title, "the same form, edits and all");
  assert.equal(title.value, "Unsaved");
  assert.equal(app.kept.size, 0);

  await go(app, "#/research/notebook");
  await go(app, "#/research");
  assert.equal(notebookMounts, 1, "the bare notebook route does not reload the open notebook");
  assert.equal(dom.location.hash, "#/research/notebook");
}));

test("leaving the workspace asks before unsaved research is lost, and declining keeps it", withDom(async (dom) => {
  const { app, root } = mountApp(fakeApi({ "GET sources": () => LIBRARY() }));
  app.showList = async function () {
    this.mount(this.shell("posts", node("p", "posts")));
  };
  await go(app, "#/research/sources");
  await buttonLabelled(root, "New source").click();
  await type(byId(root, "oba-source-title"), "Unsaved");
  dom.answers.push(false);
  await go(app, "#/posts");
  assert.deepEqual(dom.questions, ["You have unsaved changes in Sources. Leave without saving?"]);
  assert.equal(dom.location.hash, "#/research/sources", "the address returns to the panel");
  assert.equal(byId(root, "oba-source-title").value, "Unsaved");
  await go(app, "#/posts");
  assert.equal(dom.questions.length, 2);
  assert.match(root.textContent, /posts/);
}));

test("the draft is kept, suspended, while research panels open, and comes back where it was", withDom(async (dom) => {
  const { app, root } = mountApp(fakeApi(), "guided");
  app.showSources = async function () {
    this.mount(this.shell("sources", node("p", "sources")));
  };
  const editor = fakeEditor();
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  await go(app, "#/research/sources");
  assert.deepEqual(dom.questions, []);
  assert.deepEqual(editor.log, ["suspend"], "background work pauses and the editor is not disposed");
  assert.equal(app.editor, null, "shortcuts never reach a draft out of view");
  assert.equal(app.dirty, false);
  assert.equal(navItem(root, "draft").querySelector(".oba-research-kept").textContent, "Unsaved changes kept");

  await go(app, "#/edit/posts%2Fa.md?pane=evidence");
  assert.equal(app.editor, editor);
  assert.equal(app.dirty, true, "the draft is still unsaved");
  assert.deepEqual(editor.log, ["suspend", "resume", "pane:evidence"], "the claims link opens Evidence Studio");
  assert.ok(root.contains(editor.surface), "the same writing surface is back");
  assert.equal(dom.location.hash, "#/edit/posts%2Fa.md?pane=evidence");

  // Another view of the open draft switches views without reloading or asking.
  await go(app, "#/edit/posts%2Fa.md");
  assert.equal(app.editor, editor);
  assert.deepEqual(dom.questions, []);
}));

test("opening another document or leaving the workspace asks before a kept draft is discarded", withDom(async (dom) => {
  const { app, root } = mountApp(fakeApi(), "guided");
  app.showSources = async function () {
    this.mount(this.shell("sources", node("p", "sources")));
  };
  app.showEditor = async function () {
    this.mount(this.shell("posts", node("p", "another draft")));
  };
  app.showAnalytics = async function () {
    this.mount(this.shell("analytics", node("p", "analytics")));
  };
  const editor = fakeEditor("First");
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  await go(app, "#/research/sources");

  dom.answers.push(false);
  await go(app, "#/edit/posts%2Fb.md");
  assert.deepEqual(dom.questions, ["You have unsaved changes in the draft “First”. Leave without saving?"]);
  assert.equal(dom.location.hash, "#/research/sources");
  assert.ok(app.kept.has("draft"), "declining keeps the draft");

  dom.answers.push(false);
  await go(app, "#/analytics");
  assert.equal(dom.questions.length, 2);
  assert.ok(app.kept.has("draft"));

  await go(app, "#/analytics");
  assert.equal(app.kept.size, 0);
  assert.ok(editor.log.includes("dispose"), "a discarded draft is disposed");
  assert.match(root.textContent, /analytics/);
}));

test("a draft that is saving is not kept, so the save keeps its editor and address", withDom(async (dom) => {
  const { app } = mountApp(fakeApi(), "guided");
  app.showSources = async function () {
    this.mount(this.shell("sources", node("p", "sources")));
  };
  const editor = fakeEditor();
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  editor.saving = true;
  dom.answers.push(false);
  await go(app, "#/research/sources");
  assert.equal(dom.questions.length, 1);
  assert.equal(app.editor, editor);
  assert.equal(app.kept.size, 0);
}));

test("signing out asks about kept work and a new sign-in starts with nothing kept", withDom(async (dom) => {
  const { app } = mountApp(fakeApi(), "guided");
  app.showSources = async function () {
    this.mount(this.shell("sources", node("p", "sources")));
  };
  const editor = fakeEditor("Private title");
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  await go(app, "#/research/sources");
  dom.answers.push(false);
  assert.equal(await app.confirmLeave(), false);
  assert.deepEqual(dom.questions, ["You have unsaved changes in the draft “Private title”. Leave without saving?"]);
  app.showLogin();
  assert.equal(app.kept.size, 0);
  assert.equal(app.workspaceDraft, null, "another sign-in never sees this draft's title");
  assert.ok(editor.log.includes("dispose"));
}));

/** Sign in through the form the way an author would, without the rest of the Admin's start-up. */
async function signIn(app, root, username) {
  app.enter = async function () {
    await this.onHash();
  };
  byId(root, "oba-user").value = username;
  byId(root, "oba-pass").value = "secret";
  await root.querySelector("form").dispatch("submit");
}

test("an ended session keeps unsaved panels for the same user's next sign-in", withDom(async (dom) => {
  const api = fakeApi({
    "GET sources": () => LIBRARY(),
    "POST login": (body) => ({ csrf: "fresh", user: body.username }),
  });
  const { app, root } = mountApp(api, "guided");
  app.user = "writer";
  const editor = fakeEditor("Private title");
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  await go(app, "#/research/sources");
  await buttonLabelled(root, "New source").click();
  const title = byId(root, "oba-source-title");
  await type(title, "Unsaved source");

  app.showSessionEnded();
  assert.deepEqual([...app.kept.keys()].sort(), ["draft", "sources"], "the open panel is kept with the draft");
  assert.ok(!editor.log.includes("dispose"));
  assert.equal(app.hasUnsavedWork(), true, "closing the page still warns");
  assert.match(root.querySelector("[data-login-kept]").textContent, /kept on this page/);
  assert.doesNotMatch(root.textContent, /Private title|Unsaved source/, "the sign-in form names no kept work");

  await signIn(app, root, "writer");
  assert.deepEqual(dom.questions, []);
  assert.equal(byId(root, "oba-source-title"), title, "the same form returns");
  assert.equal(title.value, "Unsaved source");
  assert.equal(api.csrf, "fresh", "later saves carry the new session token");
  assert.deepEqual([...app.kept.keys()], ["draft"]);

  await go(app, "#/edit/posts%2Fa.md");
  assert.equal(app.editor, editor, "the kept draft comes back too");
  assert.deepEqual(editor.log, ["suspend", "resume"]);
}));

test("another user signing in after an ended session never sees the kept panels", withDom(async (dom) => {
  const api = fakeApi({
    "GET sources": () => LIBRARY(),
    "POST login": (body) => ({ csrf: "fresh", user: body.username }),
  });
  const { app, root } = mountApp(api, "guided");
  app.user = "writer";
  const editor = fakeEditor("Private title");
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  app.showSessionEnded();
  assert.deepEqual([...app.kept.keys()], ["draft"]);

  app.showEditor = async function () {
    this.mount(this.shell("posts", node("p", "a fresh load")));
  };
  await signIn(app, root, "someone-else");
  assert.equal(app.kept.size, 0);
  assert.equal(app.workspaceDraft, null);
  assert.ok(editor.log.includes("dispose"), "the other user's draft is disposed");
  assert.match(root.textContent, /a fresh load/);
  assert.deepEqual(dom.questions, []);

  // Signing out on purpose forgets kept work even for the same user.
  const again = fakeEditor();
  openFakeEditor(app, "#/edit/posts%2Fb.md", again);
  app.dirty = true;
  app.user = "writer";
  app.showSessionEnded();
  assert.equal(app.kept.size, 1);
  app.showLogin();
  assert.equal(app.kept.size, 0);
  assert.equal(root.querySelector("[data-login-kept]"), null);
}));

test("while signed out a hash change routes nothing and restores no kept panel", withDom(async (dom) => {
  const api = fakeApi({ "GET sources": () => LIBRARY() });
  const { app, root } = mountApp(api, "guided");
  const editor = fakeEditor("Private title");
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  await go(app, "#/research/sources");
  app.showSessionEnded();
  assert.equal(app.signedOut, true);
  let routed = 0;
  app.showResearchPanel = async () => { routed += 1; };
  await go(app, "#/edit/posts%2Fa.md");
  await go(app, "#/research/notebook");
  assert.equal(routed, 0, "no view opens");
  assert.equal(app.editor, null, "the kept draft stays kept");
  assert.equal(globalThis.location.hash, "#/research/sources", "the address returns to where the panels were left");
  assert.doesNotMatch(root.textContent, /Private title/);
  assert.ok(root.querySelector("#oba-user"), "the sign-in form stays");
  assert.deepEqual(dom.questions, []);
}));

test("a kept panel is refused when the server's session belongs to someone else", withDom(async () => {
  let sessionUser = "writer";
  const api = fakeApi({ "GET sources": () => LIBRARY(), "GET session": () => ({ csrf: "other", user: sessionUser }) });
  const { app, root } = mountApp(api, "guided");
  const editor = fakeEditor("Private title");
  openFakeEditor(app, "#/edit/posts%2Fa.md", editor);
  app.dirty = true;
  await go(app, "#/research/sources");
  assert.deepEqual([...app.kept.keys()], ["draft"]);
  assert.equal(app.keptOwner, "writer");
  // Another tab signed out and signed in as someone else on the same cookie.
  sessionUser = "editor";
  await go(app, "#/edit/posts%2Fa.md");
  assert.equal(app.kept.size, 0, "the kept panels are discarded, never handed on");
  assert.ok(editor.log.includes("dispose"));
  assert.ok(!editor.log.includes("resume"));
  assert.doesNotMatch(root.textContent, /Private title/);
  assert.match(root.textContent, /Another account signed in on this browser/);
  assert.equal(app.signedOut, true);
}));

test("a route change moves focus to the new page's heading unless the view placed it", withDom(async (dom) => {
  const { app, root } = mountApp(fakeApi());
  app.showResearch = async function () {
    this.mount(this.shell("research", node("p", "notebook")));
  };
  app.showAtlas = async function () {
    const heading = node("h2", "Plato", { tabindex: "-1", id: "oba-atlas-heading" });
    this.mount(this.shell("atlas", heading));
    heading.focus();
  };
  await go(app, "#/research/notebook");
  const link = navItem(root, "atlas").querySelector("a");
  link.focus();
  assert.equal(dom.document.activeElement, link);
  await go(app, "#/research/atlas/plato");
  assert.equal(dom.document.activeElement, byId(root, "oba-atlas-heading"), "the atlas focused its entry itself");
  navItem(root, "notebook").querySelector("a").focus();
  await go(app, "#/research/notebook");
  assert.equal(dom.document.activeElement, byId(root, "oba-page-heading"));
}));

// ---------------------------------------------------------------- the workflow panel

test("an empty workspace leads from a first source to a cited draft", withDom(async () => {
  const { app, root } = mountApp(fakeApi({ "GET sources": () => ({ ...LIBRARY(), sources: [] }), "GET research/notebook": () => ({ ...NOTEBOOK(), sources: [] }) }));
  await go(app, "#/research/overview");
  assert.equal(root.querySelector("h2").textContent, "Start your research");
  const steps = root.querySelectorAll("li").filter((item) => item.dataset.researchStep);
  assert.deepEqual(steps.map((item) => [item.dataset.researchStep, item.dataset.done, item.dataset.visibility]), [
    ["source", "false", "private"],
    ["passage", "false", "private"],
    ["relate", "optional", "private"],
    ["draft", "false", "publishable"],
  ]);
  const actions = (key) => steps.find((item) => item.dataset.researchStep === key).querySelectorAll("a").map((link) => [link.textContent, link.attributes.href, link.classList.contains("oba-btn-primary")]);
  assert.deepEqual(actions("source"), [["Add your first source", "#/research/sources", true]], "the first step is the one to take");
  assert.deepEqual(actions("passage"), [["Capture a passage", "#/research/notebook", false]]);
  assert.deepEqual(actions("relate"), [["Open the Atlas", "#/research/atlas", false], ["Compare versions", "#/research/compare", false]]);
  assert.deepEqual(actions("draft"), [["Start a post", "#/new/posts", false]]);
  assert.equal(navItem(root, "overview").querySelector("a").attributes["aria-current"], "page");
}));

test("the workflow says how far research has come and returns to the open draft", withDom(async () => {
  const { app, root } = mountApp(fakeApi({
    "GET sources": () => ({ ...LIBRARY(), sources: [...LIBRARY().sources, { id: "old", kind: "work", title: "Old", archived: true }] }),
    "GET research/notebook": () => ({ ...NOTEBOOK(), passages: [{ id: "p1", source: "plato" }, { id: "p2", source: "plato" }], notes: [{ id: "n1", kind: "observation", text: "x" }] }),
  }));
  app.workspaceDraft = { hash: "#/edit/posts%2Fa.md", kind: "posts", title: "<script>x</script>" };
  await go(app, "#/research/overview");
  assert.equal(root.querySelector("h2").textContent, "From source to draft");
  const state = (key) => root.querySelectorAll("li").find((item) => item.dataset.researchStep === key).querySelector("[data-research-step-state]").textContent;
  assert.equal(state("source"), "Done: 1 source in the library.", "archived sources are not counted");
  assert.equal(state("passage"), "Done: 2 passages and 1 note.");
  assert.equal(state("draft"), "Your draft: <script>x</script>");
  const back = root.querySelectorAll("a").find((link) => link.textContent === "Back to the draft");
  assert.equal(back.attributes.href, "#/edit/posts%2Fa.md");
}));

test("a store that cannot be read is reported in its own step and nothing else fails", withDom(async () => {
  const { app, root } = mountApp(fakeApi({
    "GET sources": () => {
      throw new ApiError("broken", 422, { error: "the library is not valid JSON", file: ".openblog/private/research/sources.json" });
    },
    "GET research/notebook": () => ({ ...NOTEBOOK(), passages: [{ id: "p1", source: "plato" }] }),
  }));
  await go(app, "#/research/overview");
  const step = (key) => root.querySelectorAll("li").find((item) => item.dataset.researchStep === key);
  assert.equal(step("source").dataset.done, "unreadable");
  const message = step("source").querySelector("[data-research-step-state]");
  assert.equal(message.className, "oba-error");
  assert.equal(message.textContent, "The source library could not be read. the library is not valid JSON Repair .openblog/private/research/sources.json by hand, then reload this view. Nothing was changed.");
  assert.equal(step("passage").dataset.done, "true", "the notebook still reports its own state");
  assert.equal(app.api.calls.length, 0, "the workflow never writes");
}));

test("an ended session on the workflow asks for sign-in again", withDom(async () => {
  const { app } = mountApp(fakeApi({
    "GET sources": () => LIBRARY(),
    "GET research/notebook": () => {
      throw new ApiError("signed out", 401, null);
    },
  }));
  await assert.rejects(app.showResearchOverview(), (error) => error.status === 401);
}));

test("the palette and Advanced tools reach the workspace and the draft it returns to", withDom(async (dom) => {
  const { app } = mountApp(fakeApi(), "simple");
  const dialogs = [];
  dom.document.body.append = ((append) => (...nodes) => {
    dialogs.push(...nodes);
    append(...nodes);
  })(dom.document.body.append.bind(dom.document.body));
  app.workspaceDraft = { hash: "#/edit/posts%2Fa.md", kind: "posts", title: "A" };
  app.openCommandPalette();
  const palette = dialogs.at(-1);
  const labels = palette.querySelectorAll("button").map((button) => button.children[0]?.textContent);
  for (const label of ["Research workspace", "Sources", "Research notebook", "Knowledge Atlas", "Compare versions", "Back to draft"]) assert.ok(labels.includes(label), `${label} is in the palette`);
  await palette.querySelectorAll("button").find((button) => button.children[0]?.textContent === "Back to draft").click();
  assert.equal(dom.location.hash, "#/edit/posts%2Fa.md");

  app.openAdvancedTools();
  const advanced = dialogs.at(-1);
  const tool = advanced.querySelectorAll("button").find((button) => button.children[0]?.textContent === "Research workspace");
  assert.ok(tool, "Simple still offers the workspace in Advanced tools");
}));

// ---------------------------------------------------------------- styles

test("the workspace reflows at 320 pixels and tells visibility apart without colour alone", () => {
  assert.match(styles, /\.oba-skip-link \{[^}]*transform: translateY\(-200%\);/);
  assert.match(styles, /\.oba-skip-link:focus \{[^}]*transform: none;/);
  assert.match(styles, /\.oba-research-nav \{[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.oba-research-group ul \{[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.oba-research-item \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.oba-visibility\[data-visibility="publishable"\],[^{]*\{[^}]*border-style: double;/, "a border style repeats what the words say");
  assert.match(styles, /@media \(max-width: 44rem\) \{\s*\.oba-shell \{[^}]*\}\s*\.oba-app-header \{\s*flex-wrap: wrap;/, "the header wraps instead of overflowing on a phone");
  assert.doesNotMatch(styles.slice(styles.indexOf("/* Research workspace (ADR 0120)")), /animation|transition/, "the workspace adds no motion");
});

/** A Map-backed stand-in for localStorage, installed for one test. */
function installStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return {
    keys: () => [...map.keys()].sort(),
    restore: () => (previous ? Object.defineProperty(globalThis, "localStorage", previous) : delete globalThis.localStorage),
  };
}

/** The real Admin API client over a fake `fetch`: a 401 is the client's own ApiError, as in the page. */
function fetchApi(respond) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const [status, body] = respond(init.method, String(url).replace("/admin/api/", ""), init.body ? JSON.parse(init.body) : undefined);
    return { ok: status < 400, status, statusText: "", json: async () => body };
  };
  return () => {
    globalThis.fetch = previous;
  };
}

test("a 401 while writing keeps the author's voice copies through navigation and sign-in, and nobody else's", withDom(async () => {
  const COPIES = {
    "ob-voice-draft:writer": "rough words",
    "ob-voice-polished:writer:2026-10-28-a-rough.md": "polished words",
    "ob-voice-draft:writer2": "someone else's rough words",
    "ob-voice-polished:other:2026-10-28-b-rough.md": "someone else's polished words",
    "unrelated": "kept",
  };
  const storage = installStorage(COPIES);
  const { app, root } = mountApp(fakeApi(), "guided");
  let signedIn = false;
  app.api = new (new ObAdmin().api.constructor)();
  const restoreFetch = fetchApi((method, path, body) => {
    if (method === "POST" && path === "login") {
      signedIn = true;
      return [200, { csrf: "fresh", user: body.username }];
    }
    if (!signedIn) return [401, { error: "signed out" }];
    if (path === "sources") return [200, LIBRARY()];
    return [200, {}];
  });
  try {
    app.user = "writer";
    // The session ends behind the Voice view; the author goes to another view, which gets the 401.
    await go(app, "#/research/sources");
    assert.equal(app.signedOut, true, "the 401 on navigation asks for sign-in");
    assert.deepEqual(storage.keys(), Object.keys(COPIES).sort(), "an ended session erases no voice copy");

    await signIn(app, root, "writer");
    assert.equal(app.signedOut, false);
    assert.deepEqual(
      storage.keys(),
      ["ob-voice-draft:writer", "ob-voice-polished:writer:2026-10-28-a-rough.md", "unrelated"],
      "signing in again as the same author keeps that author's copies and only theirs",
    );

    // An ended session followed by someone else signing in removes the first author's copies.
    signedIn = false;
    await go(app, "#/research/sources");
    assert.equal(app.signedOut, true);
    await signIn(app, root, "someone-else");
    assert.deepEqual(storage.keys(), ["unrelated"]);
  } finally {
    restoreFetch();
    storage.restore();
  }
}));
