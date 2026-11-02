import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_ESSENTIAL_PANES,
  ADMIN_OPTIONAL_MODULES,
  DEFAULT_ADMIN_PREFERENCES,
  Editor,
  ObAdmin,
  adminToolGroups,
  editorPaneLayout,
  legacyAdminPreferences,
  normalizeAdminPreferences,
  visibleAdminModules,
} from "../../web/admin/admin.js";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");
const base = readFileSync(new URL("../../web/base.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/admin/index.html", import.meta.url), "utf8");

const DOCUMENT_PANES = ["write", "preview", "social", "release", "field", "optimize", "settings", "accessibility", "evidence", "assistant"];

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

function snapshotFor(preferences, etag, stored = true) {
  return { preferences: normalizeAdminPreferences(preferences), etag, stored };
}

function fakeApi(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, path, options = {}) {
      calls.push({ method, path, body: options.json });
      const handler = handlers[`${method} ${path}`];
      if (!handler) throw Object.assign(new Error(`unexpected ${method} ${path}`), { status: 500 });
      return handler(options.json, calls);
    },
  };
}

function appWith(api) {
  const app = new ObAdmin();
  app.api = api;
  app.onHash = async () => {
    app.routed = true;
  };
  return app;
}

// ---------------------------------------------------------------- presets and layout

test("the default workspace is calm while every optional module remains known", () => {
  assert.equal(DEFAULT_ADMIN_PREFERENCES.preset, "simple");
  assert.equal(DEFAULT_ADMIN_PREFERENCES.editorMode, "visual");
  assert.deepEqual(visibleAdminModules(DEFAULT_ADMIN_PREFERENCES), []);
  assert.deepEqual(DEFAULT_ADMIN_PREFERENCES.moduleOrder, ADMIN_OPTIONAL_MODULES);
  assert.match(admin, /Everything remains reachable even when your everyday workspace is simple/);
  assert.match(admin, /Write, preview, settings, save, publish status/);
});

test("guided, advanced, and custom presets disclose the intended modules", () => {
  assert.deepEqual(visibleAdminModules({ preset: "guided" }), ["accessibility", "evidence", "research", "assistant"]);
  assert.deepEqual(visibleAdminModules({ preset: "advanced" }), ADMIN_OPTIONAL_MODULES);
  const custom = normalizeAdminPreferences({
    preset: "custom",
    moduleOrder: ["assistant", "social"],
    hiddenModules: ["social"],
  });
  assert.equal(custom.moduleOrder[0], "assistant");
  assert.equal(custom.moduleOrder[1], "social");
  assert.deepEqual(visibleAdminModules(custom).filter((module) => ["assistant", "social"].includes(module)), ["assistant"]);
});

test("untrusted preference values normalize to safe, complete settings", () => {
  const normalized = normalizeAdminPreferences({
    schemaVersion: 99,
    preset: "root",
    density: "invisible",
    editorMode: "html",
    moduleOrder: ["secrets", "assistant", "assistant", "write", "__proto__"],
    hiddenModules: ["publish", "assistant", "assistant", "write"],
    theme: "<script>alert(1)</script>",
  });
  assert.deepEqual(Object.keys(normalized), ["schemaVersion", "preset", "density", "editorMode", "moduleOrder", "hiddenModules"]);
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.preset, "simple");
  assert.equal(normalized.density, "comfortable");
  assert.equal(normalized.editorMode, "visual");
  assert.deepEqual(normalized.moduleOrder, ["assistant", ...ADMIN_OPTIONAL_MODULES.filter((module) => module !== "assistant")]);
  assert.deepEqual(normalized.hiddenModules, ["assistant"]);
});

test("layouts saved before the research workspace keep it hidden where they hid Evidence Studio", () => {
  // Research showed only with Evidence Studio before the workspace existed (ADR 0120).
  const before = ADMIN_OPTIONAL_MODULES.filter((module) => module !== "research");
  const hidEvidence = normalizeAdminPreferences({ preset: "custom", moduleOrder: before, hiddenModules: ["evidence"] });
  assert.deepEqual(hidEvidence.hiddenModules, ["evidence", "research"]);
  assert.equal(visibleAdminModules(hidEvidence).includes("research"), false);
  const showedEvidence = normalizeAdminPreferences({ preset: "custom", moduleOrder: before, hiddenModules: ["social"] });
  assert.deepEqual(showedEvidence.hiddenModules, ["social"]);
  assert.equal(visibleAdminModules(showedEvidence).includes("research"), true);
  // A layout that already names the workspace keeps it as chosen.
  const chosen = normalizeAdminPreferences({ preset: "custom", moduleOrder: ADMIN_OPTIONAL_MODULES, hiddenModules: ["evidence"] });
  assert.deepEqual(chosen.hiddenModules, ["evidence"]);
});

test("every preset keeps every document view reachable and essentials first", () => {
  const presets = [
    { preset: "simple" },
    { preset: "guided" },
    { preset: "advanced" },
    { preset: "custom", moduleOrder: [...ADMIN_OPTIONAL_MODULES].reverse(), hiddenModules: ADMIN_OPTIONAL_MODULES },
    { preset: "custom", hiddenModules: [] },
  ];
  for (const preferences of presets) {
    const layout = editorPaneLayout(preferences, DOCUMENT_PANES);
    assert.deepEqual(layout.primary.slice(0, 3), ADMIN_ESSENTIAL_PANES, preferences.preset);
    assert.deepEqual([...layout.primary, ...layout.more].sort(), [...DOCUMENT_PANES].sort(), preferences.preset);
    for (const pane of ADMIN_ESSENTIAL_PANES) assert.equal(layout.more.includes(pane), false);
  }
  assert.deepEqual(editorPaneLayout({ preset: "simple" }, DOCUMENT_PANES).primary, ["write", "preview", "settings"]);
  assert.deepEqual(editorPaneLayout({ preset: "simple" }, DOCUMENT_PANES).more, ["social", "release", "field", "optimize", "accessibility", "evidence", "assistant"]);
});

test("custom ordering and hiding change only where optional views appear", () => {
  const preferences = normalizeAdminPreferences({ preset: "custom", moduleOrder: ["assistant", "evidence", "social"], hiddenModules: ["social", "release", "field", "optimize", "accessibility"] });
  const layout = editorPaneLayout(preferences, DOCUMENT_PANES);
  assert.deepEqual(layout.primary, ["write", "preview", "settings", "assistant", "evidence"]);
  assert.deepEqual(layout.more, ["social", "release", "field", "optimize", "accessibility"]);
  const pages = editorPaneLayout(preferences, DOCUMENT_PANES.filter((pane) => pane !== "assistant"));
  assert.deepEqual(pages.primary, ["write", "preview", "settings", "evidence"]);
});

test("advanced tools are grouped by author goal and follow the chosen order", () => {
  const groups = adminToolGroups(normalizeAdminPreferences({ moduleOrder: ["analytics", "assistant", "release", "social"] }), ADMIN_OPTIONAL_MODULES);
  const modules = groups.flatMap((group) => group.modules);
  assert.deepEqual([...modules].sort(), [...ADMIN_OPTIONAL_MODULES].sort());
  for (const group of groups) {
    assert.ok(group.label);
    assert.ok(group.modules.length > 0);
  }
  assert.deepEqual(groups.find((group) => group.modules.includes("social")).modules.slice(0, 2), ["release", "social"]);
  assert.equal(groups.find((group) => group.modules.includes("assistant")).modules.length, 1, "AI help stays its own opt-in goal");
  const outsideEditor = adminToolGroups(DEFAULT_ADMIN_PREFERENCES, ["analytics", "contributors", "public-site"]);
  assert.deepEqual(outsideEditor.flatMap((group) => group.modules).sort(), ["analytics", "contributors", "public-site"]);
});

test("the editor bar applies a layout and names a hidden active view on More tools", withDom(async ({ document }) => {
  const editor = {
    paneButtonMap: new Map(DOCUMENT_PANES.map((pane) => [pane, Object.assign(new DomNode("button", document), { textContent: pane })])),
    paneLabels: { social: "Social", assistant: "Assistant" },
    primaryPaneNav: new DomNode("div", document),
    advancedPaneActions: new DomNode("div", document),
    advancedPaneDetails: Object.assign(new DomNode("details", document), { open: true }),
    moreToolsSummary: new DomNode("summary", document),
    root: { dataset: { editorView: "social" } },
    editorMode: "visual",
    syncMoreTools: Editor.prototype.syncMoreTools,
    setEditorMode(mode) {
      this.editorMode = mode;
    },
  };
  Editor.prototype.applyWorkspacePreferences.call(editor, normalizeAdminPreferences({ preset: "simple", editorMode: "markdown" }));
  assert.deepEqual(editor.primaryPaneNav.children.map((button) => button.textContent), ["write", "preview", "settings"]);
  assert.equal(editor.advancedPaneActions.children.length, 7);
  assert.equal(editor.moreToolsSummary.textContent, "More tools: Social");
  assert.equal(editor.advancedPaneDetails.open, false);
  assert.equal(editor.editorMode, "markdown");

  Editor.prototype.applyWorkspacePreferences.call(editor, normalizeAdminPreferences({ preset: "guided" }));
  assert.deepEqual(editor.primaryPaneNav.children.map((button) => button.textContent), ["write", "preview", "settings", "accessibility", "evidence", "assistant"]);
  assert.deepEqual(editor.advancedPaneActions.children.map((button) => button.textContent), ["social", "release", "field", "optimize"]);
  assert.equal(editor.advancedPaneDetails.hidden, false);
  assert.equal(editor.moreToolsSummary.textContent, "More tools: Social");

  Editor.prototype.applyWorkspacePreferences.call(editor, normalizeAdminPreferences({ preset: "custom", moduleOrder: ["assistant", "social"], hiddenModules: ["release", "field", "optimize", "accessibility", "evidence"] }));
  assert.deepEqual(editor.primaryPaneNav.children.map((button) => button.textContent), ["write", "preview", "settings", "assistant", "social"]);
  assert.deepEqual(editor.advancedPaneActions.children.map((button) => button.textContent), ["release", "field", "optimize", "accessibility", "evidence"]);
  assert.equal(editor.moreToolsSummary.textContent, "More tools", "an active view shown in the bar is not named on More tools");

  Editor.prototype.applyWorkspacePreferences.call(editor, normalizeAdminPreferences({ preset: "advanced" }));
  assert.equal(editor.primaryPaneNav.children.length, DOCUMENT_PANES.length);
  assert.equal(editor.advancedPaneDetails.hidden, true);
  assert.equal(editor.moreToolsSummary.textContent, "More tools");
}));

test("choosing a view from More tools keeps keyboard focus on the menu, which names the choice", withDom(async ({ document }) => {
  const summary = new DomNode("summary", document);
  const actions = new DomNode("div", document);
  const choice = Object.assign(new DomNode("button", document), { textContent: "release" });
  actions.append(choice);
  const details = new DomNode("details", document);
  details.append(summary, actions);
  const editor = {
    advancedPaneDetails: Object.assign(details, { open: true }),
    advancedPaneActions: actions,
    moreToolsSummary: summary,
    morePanes: ["release"],
    paneLabels: { release: "Release kit" },
  };
  choice.focus();
  Editor.prototype.syncMoreTools.call(editor, "release");
  assert.equal(details.open, false);
  assert.equal(document.activeElement, summary, "focus does not fall back to the page when the menu collapses");
  assert.equal(summary.textContent, "More tools: Release kit");

  const elsewhere = new DomNode("button", document);
  elsewhere.focus();
  Editor.prototype.syncMoreTools.call(editor, "write");
  assert.equal(document.activeElement, elsewhere, "focus outside the menu is left alone");
}));

function renderShell(app, active) {
  app.meta = { siteTitle: "Blog" };
  const root = app.shell(active);
  app.querySelectorAll = (selector) => root.querySelectorAll(selector);
  app.applyWorkspacePreferences();
  return root;
}

function hiddenWithin(node, root) {
  for (let current = node; current && current !== root; current = current.parent) if (current.hidden) return true;
  return false;
}

const toolbeltLinks = (root) =>
  root.querySelector("nav").querySelectorAll("a").filter((link) => link.attributes.href?.startsWith("#/") && !hiddenWithin(link, root)).map((link) => link.textContent);

test("every preset applies its toolbelt modules and the open route always stays marked current", withDom(async () => {
  const content = ["Overview", "Posts", "Pages", "Series", "Services", "Shared reflections", "Capture", "Landing page", "Reading paths", "Comparisons", "Appearance", "Customize look", "Business facts"];
  const research = "Research workspace";
  const voice = "Voice";
  const cases = [
    [{ preset: "simple" }, "overview", content],
    [{ preset: "simple" }, "sources", [...content, research]],
    [{ preset: "guided" }, "posts", [...content, voice, research]],
    [{ preset: "simple" }, "appearance", content],
    [{ preset: "advanced" }, "overview", [...content, voice, "Analytics", "Moderation inbox", research, "Contributors"]],
    [{ preset: "custom", hiddenModules: ["contributors"] }, "overview", [...content, voice, "Analytics", "Moderation inbox", research]],
    [{ preset: "custom", hiddenModules: ["research"] }, "overview", [...content, voice, "Analytics", "Moderation inbox", "Contributors"]],
    [{ preset: "custom", hiddenModules: ["research"] }, "atlas", [...content, voice, "Analytics", "Moderation inbox", research, "Contributors"]],
    [{ preset: "custom", hiddenModules: ["assistant"] }, "overview", [...content, "Analytics", "Moderation inbox", research, "Contributors"]],
    [{ preset: "simple" }, "voice", [...content, voice]],
    [{ preset: "simple" }, "analytics", [...content, "Analytics", "Moderation inbox"]],
    [{ preset: "simple" }, "moderation", [...content, "Analytics", "Moderation inbox"]],
    [{ preset: "guided" }, "moderation", [...content, voice, "Analytics", "Moderation inbox", research]],
    [{ preset: "guided" }, "contributors", [...content, voice, research, "Contributors"]],
    [{ preset: "custom", hiddenModules: ["analytics"] }, "analytics", [...content, voice, "Analytics", "Moderation inbox", research, "Contributors"]],
  ];
  for (const [preferences, active, expected] of cases) {
    const app = appWith(fakeApi({}));
    app.preferences = normalizeAdminPreferences(preferences);
    const root = renderShell(app, active);
    const label = `${preferences.preset} on ${active}`;
    assert.deepEqual(toolbeltLinks(root), expected, label);
    // One page is current; on a research panel the toolbelt marks the workspace it belongs to.
    const current = root.querySelectorAll("a").filter((link) => link.attributes["aria-current"] === "page");
    assert.equal(current.length, 1, `${label} marks one current item`);
    assert.equal(hiddenWithin(current[0], root), false, `${label} shows the current item`);
    const section = root.querySelector("nav").querySelectorAll("a").filter((link) => link.attributes["aria-current"] === "true");
    assert.deepEqual(section.map((link) => link.textContent), ["sources", "atlas"].includes(active) ? [research] : [], `${label} marks the research workspace only inside it`);
  }
}));

// ---------------------------------------------------------------- migration

test("first-time admins start Simple while earlier admins keep the full workspace", () => {
  const storage = (values) => ({ getItem: (key) => values[key] ?? null });
  const unstored = snapshotFor({}, "a", false);
  assert.equal(legacyAdminPreferences(unstored, storage({})), null);
  assert.equal(legacyAdminPreferences(snapshotFor({}, "a", true), storage({ "ob-admin-editor-mode": "markdown" })), null);
  assert.deepEqual(legacyAdminPreferences(unstored, storage({ "ob-admin-editor-mode": "markdown" })), normalizeAdminPreferences({ preset: "advanced", editorMode: "markdown" }));
  assert.equal(legacyAdminPreferences(unstored, storage({ "ob-admin-preview-width": "tablet" })), null, "this release still writes the preview width, so it proves nothing");
  assert.equal(legacyAdminPreferences(unstored, { getItem: () => { throw new Error("blocked"); } }), null);
  assert.equal(legacyAdminPreferences(unstored, undefined), null);
});

test("existing admins migrate once into a stored Advanced workspace", withDom(async () => {
  const storage = memoryStorage({ "ob-admin-editor-mode": "markdown" });
  globalThis.localStorage = storage;
  const api = fakeApi({
    "GET meta": () => ({ siteTitle: "Blog" }),
    "GET preferences": () => snapshotFor({}, "initial", false),
    "PUT preferences": (body) => snapshotFor(body.preferences, "migrated"),
  });
  const app = appWith(api);
  await app.enter();
  const put = api.calls.find((call) => call.method === "PUT");
  assert.equal(put.body.etag, "initial");
  assert.equal(put.body.preferences.preset, "advanced");
  assert.equal(app.preferences.editorMode, "markdown");
  assert.equal(app.preferencesEtag, "migrated");
  assert.equal(app.routed, true);
  assert.equal(storage.getItem("ob-admin-editor-mode"), null, "the legacy trace is dropped after migrating");

  // Another login signing in for the first time in the same browser starts Simple.
  const other = fakeApi({
    "GET meta": () => ({ siteTitle: "Blog" }),
    "GET preferences": () => snapshotFor({}, "ada", false),
  });
  const ada = appWith(other);
  await ada.enter();
  assert.equal(ada.preferences.preset, "simple");
  assert.equal(other.calls.some((call) => call.method === "PUT"), false);
}));

test("a first-time admin who changes preview width stays Simple after a reload", withDom(async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const api = fakeApi({
    "GET meta": () => ({ siteTitle: "Blog" }),
    "GET preferences": () => snapshotFor({}, "initial", false),
  });
  const first = appWith(api);
  await first.enter();
  assert.equal(first.preferences.preset, "simple");
  // The editor remembers the chosen preview width in this browser.
  storage.setItem("ob-admin-preview-width", "mobile");
  const reloaded = appWith(api);
  await reloaded.enter();
  assert.equal(reloaded.preferences.preset, "simple");
  assert.equal(api.calls.some((call) => call.method === "PUT"), false, "nothing is migrated or stored");
}));

// ---------------------------------------------------------------- storage failure and conflicts

test("unavailable preference storage falls back to a usable Simple workspace", withDom(async ({ document }) => {
  const api = fakeApi({
    "GET meta": () => ({ siteTitle: "Blog" }),
    "GET preferences": () => {
      throw Object.assign(new Error("disk unavailable"), { status: 500 });
    },
  });
  const app = appWith(api);
  await app.enter();
  assert.deepEqual(app.preferences, normalizeAdminPreferences());
  assert.equal(app.preferencesEtag, "");
  assert.match(app.preferencesError, /personalization is unavailable: disk unavailable/);
  assert.equal(document.documentElement.dataset.adminPreset, "simple");
  assert.equal(document.title, "Admin · Blog");
  assert.equal(app.routed, true);
}));

test("preference saves are serialized so each one sends the latest revision", withDom(async () => {
  let revision = 0;
  const api = fakeApi({
    "PUT preferences": async (body) => {
      await tick();
      revision += 1;
      return snapshotFor(body.preferences, `r${revision}`);
    },
  });
  const app = appWith(api);
  app.preferencesEtag = "r0";
  await Promise.all([
    app.saveWorkspacePreferences({ ...app.preferences, density: "compact" }),
    app.saveWorkspacePreferences({ ...app.preferences, editorMode: "markdown" }),
  ]);
  assert.deepEqual(api.calls.map((call) => call.body.etag), ["r0", "r1"]);
  assert.equal(app.preferencesEtag, "r2");
}));

test("a stale preference write reloads the latest revision instead of overwriting it", withDom(async () => {
  const api = fakeApi({
    "PUT preferences": () => {
      throw Object.assign(new Error("changed elsewhere"), { status: 409 });
    },
    "GET preferences": () => snapshotFor({ preset: "advanced" }, "theirs"),
  });
  const app = appWith(api);
  app.preferencesEtag = "mine";
  await assert.rejects(app.saveWorkspacePreferences({ ...app.preferences, preset: "guided" }), (error) => error.status === 409);
  assert.equal(app.preferences.preset, "advanced");
  assert.equal(app.preferencesEtag, "theirs");
}));

test("a writing-mode toggle never replaces stored settings that could not be loaded", withDom(async ({ document }) => {
  const api = fakeApi({
    "GET meta": () => ({ siteTitle: "Blog" }),
    "GET preferences": () => {
      throw Object.assign(new Error("permission denied"), { status: 500 });
    },
    "PUT preferences": (body) => snapshotFor(body.preferences, "overwritten"),
  });
  const app = appWith(api);
  await app.enter();
  const status = Object.assign(new DomNode("span", document), { textContent: "Markdown" });
  app.editor = { ui: { editorModeStatus: status }, applyWorkspacePreferences() {} };
  await app.persistEditorMode("markdown");
  assert.equal(app.preferences.editorMode, "markdown", "the mode still changes for this session");
  assert.equal(api.calls.some((call) => call.method === "PUT"), false);
  assert.match(status.textContent, /preference not saved/);
  assert.match(app.preferencesError, /personalization is unavailable/);
}));

test("a writing-mode save queued behind a Personalize save keeps that save's choices", withDom(async () => {
  let revision = 0;
  const api = fakeApi({
    "PUT preferences": async (body) => {
      await tick();
      revision += 1;
      return snapshotFor(body.preferences, `r${revision}`);
    },
  });
  const app = appWith(api);
  app.preferencesEtag = "r0";
  const personalize = app.saveWorkspacePreferences({ ...app.preferences, density: "compact", preset: "guided" });
  const mode = app.persistEditorMode("markdown");
  await Promise.all([personalize, mode]);
  const last = api.calls.at(-1).body;
  assert.equal(last.etag, "r1");
  assert.equal(last.preferences.density, "compact");
  assert.equal(last.preferences.preset, "guided");
  assert.equal(last.preferences.editorMode, "markdown");
  assert.equal(app.preferences.density, "compact");
  assert.equal(app.preferences.editorMode, "markdown");
}));

test("a writing-mode conflict merges with the other session without flipping the editor", withDom(async () => {
  let attempts = 0;
  const api = fakeApi({
    "PUT preferences": (body) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("changed elsewhere"), { status: 409 });
      return snapshotFor(body.preferences, "merged");
    },
    "GET preferences": () => snapshotFor({ preset: "advanced", editorMode: "visual" }, "theirs"),
  });
  const app = appWith(api);
  app.preferencesEtag = "mine";
  const modes = [];
  app.editor = { applyWorkspacePreferences: (preferences) => modes.push(preferences.editorMode) };
  await app.persistEditorMode("markdown");
  assert.deepEqual(modes.filter((mode) => mode !== "markdown"), [], "the editor never shows the other session's writing mode");
  assert.equal(api.calls.at(-1).body.etag, "theirs");
  assert.equal(api.calls.at(-1).body.preferences.preset, "advanced");
  assert.equal(api.calls.at(-1).body.preferences.editorMode, "markdown");
  assert.equal(app.preferences.preset, "advanced");
  assert.equal(app.preferencesError, "");
}));

test("a failed writing-mode save keeps the mode for this session and says so", withDom(async () => {
  const api = fakeApi({
    "PUT preferences": () => {
      throw Object.assign(new Error("disk full"), { status: 500 });
    },
  });
  const app = appWith(api);
  app.preferencesEtag = "r0";
  await app.persistEditorMode("markdown");
  assert.equal(app.preferences.editorMode, "markdown");
  assert.match(app.preferencesError, /could not be saved: disk full/);
}));

// ---------------------------------------------------------------- dialogs, keyboard, and focus

test("Advanced tools is a labelled dialog that restores focus to its opener", withDom(async ({ document }) => {
  const app = appWith(fakeApi({}));
  const opener = new DomNode("button", document);
  opener.focus();
  const panes = DOCUMENT_PANES.filter((pane) => !ADMIN_ESSENTIAL_PANES.includes(pane));
  app.editor = { optionalPanes: panes, paneLabels: Object.fromEntries(panes.map((pane) => [pane, pane])), activatePane() {} };
  app.openAdvancedTools();
  const dialog = document.querySelector("dialog[open]");
  assert.ok(dialog);
  assert.equal(dialog.attributes["aria-labelledby"], "oba-advanced-title");
  assert.ok(dialog.querySelector("#oba-advanced-title"));
  const headings = dialog.querySelectorAll("h3").map((heading) => heading.textContent);
  assert.deepEqual(headings, ["Get writing help", "Check quality and research", "Share and distribute", "Collaborate and understand readers"]);
  assert.equal(dialog.querySelectorAll("button").filter((button) => button.classList.contains("oba-advanced-tool")).length, ADMIN_OPTIONAL_MODULES.length);
  await findByText(dialog, "button", "Close").click();
  await tick();
  assert.equal(dialog.parent, null);
  assert.equal(document.activeElement, opener);
}));

test("choosing an advanced tool moves focus to the tool instead of back to the opener", withDom(async ({ document }) => {
  const app = appWith(fakeApi({}));
  const opener = new DomNode("button", document);
  const pane = new DomNode("section", document);
  opener.focus();
  app.editor = { optionalPanes: ["social", "assistant"], paneLabels: { social: "Social", assistant: "Assistant" }, activatePane: (name) => { app.activated = name; pane.focus(); } };
  app.openAdvancedTools();
  const dialog = document.querySelector("dialog[open]");
  await findByText(dialog, "button", "Assistant").click();
  await tick();
  assert.equal(app.activated, "assistant");
  assert.equal(document.activeElement, pane);
}));

test("the personalization form reorders by keyboard, keeps focus, and restores defaults", withDom(async ({ document }) => {
  const api = fakeApi({ "PUT preferences": (body) => snapshotFor(body.preferences, "saved") });
  const app = appWith(api);
  app.preferences = normalizeAdminPreferences({ preset: "custom", density: "compact", editorMode: "markdown", hiddenModules: ["assistant"] });
  app.preferencesEtag = "r0";
  const opener = new DomNode("button", document);
  opener.focus();
  app.openWorkspacePreferences();
  const dialog = document.querySelector("dialog[open]");
  assert.equal(dialog.attributes["aria-labelledby"], "oba-preferences-title");
  assert.equal(document.activeElement.id, "oba-workspace-preset");

  const down = dialog.querySelectorAll("button").find((button) => button.attributes["aria-label"] === "Move Social preview down");
  await down.click();
  const rows = dialog.querySelectorAll(".oba-module-row").map((row) => row.textContent);
  assert.match(rows[0], /Release kit/);
  assert.match(rows[1], /Social preview/);
  assert.equal(document.activeElement.attributes["aria-label"], "Move Social preview down", "focus follows the moved tool");

  await findByText(dialog, "button", "Save workspace").click();
  assert.equal(api.calls.at(-1).body.preferences.moduleOrder[1], "social");
  assert.equal(api.calls.at(-1).body.etag, "r0");
  assert.ok(findByText(dialog, "p", "Workspace saved."));

  await findByText(dialog, "button", "Restore defaults").click();
  await findByText(dialog, "button", "Save workspace").click();
  assert.deepEqual(api.calls.at(-1).body.preferences, normalizeAdminPreferences());
  assert.equal(api.calls.at(-1).body.etag, "saved");

  await findByText(dialog, "button", "Close").click();
  await tick();
  assert.equal(document.activeElement, opener);
}));

test("individual tool toggles are only editable in Custom", withDom(async ({ document }) => {
  const app = appWith(fakeApi({}));
  app.openWorkspacePreferences();
  const dialog = document.querySelector("dialog[open]");
  const toggles = dialog.querySelectorAll("input");
  assert.equal(toggles.length, ADMIN_OPTIONAL_MODULES.length);
  assert.ok(toggles.every((toggle) => toggle.disabled));
  const preset = dialog.querySelector("#oba-workspace-preset");
  preset.value = "custom";
  await preset.dispatch("change");
  assert.ok(dialog.querySelectorAll("input").every((toggle) => !toggle.disabled));
}));

test("personalization can replace unreadable stored preferences", withDom(async ({ document }) => {
  const api = fakeApi({ "PUT preferences": (body) => snapshotFor(body.preferences, "fresh") });
  const app = appWith(api);
  app.preferencesError = "Workspace personalization is unavailable: admin preferences are not valid";
  app.openWorkspacePreferences();
  const dialog = document.querySelector("dialog[open]");
  await findByText(dialog, "button", "Save workspace").click();
  assert.equal(api.calls.at(-1).body.etag, "");
  assert.equal(app.preferencesEtag, "fresh");
  assert.equal(app.preferencesError, "");
}));

test("the workspace storage warning disappears once a save recovers", withDom(async () => {
  const api = fakeApi({ "PUT preferences": (body) => snapshotFor(body.preferences, "fresh") });
  const app = appWith(api);
  app.preferencesError = "Workspace personalization is unavailable: admin preferences are not valid";
  app.preferencesUnreadable = true;
  const root = renderShell(app, "overview");
  const warning = root.querySelector(".oba-preferences-warning");
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /personalization is unavailable/);
  await app.saveWorkspacePreferences(normalizeAdminPreferences({ preset: "guided" }));
  assert.equal(warning.hidden, true);
  assert.equal(warning.textContent, "");
}));

test("keyboard shortcuts and search reach every view regardless of preferences", () => {
  assert.match(admin, /\["write", "preview", "social", "release", "field", "optimize", "settings", "accessibility", "evidence"\]\[Number\(e\.key\) - 1\]/);
  assert.match(admin, /label: "Advanced tools"/);
  assert.match(admin, /label: "Personalize workspace"/);
  assert.match(admin, /label: `Show \$\{pane\}`/);
});

// ---------------------------------------------------------------- responsive, zoom, and motion

test("personalization uses the private authenticated API and accessible responsive controls", () => {
  assert.match(admin, /api\.call\("GET", "preferences"\)/);
  assert.match(admin, /api\.call\("PUT", "preferences"/);
  assert.match(admin, /Your private view/);
  assert.match(admin, /Restore defaults/);
  assert.match(admin, /role: "status", "aria-live": "polite"/);
  assert.match(styles, /\.oba-progressive-tools\[hidden\]/);
  assert.doesNotMatch(styles, /data-admin-preset="simple"\] \.oba-progressive-tools/, "hiding follows the hidden attribute, so the open route can stay visible");
  assert.match(styles, /@media \(max-width: 44rem\)/);
  assert.match(styles, /min-height: 44px/);
});

test("workspace dialogs and menus reflow at narrow widths and 400% zoom", () => {
  assert.match(styles, /\.oba-dialog \{[^}]*width: min\(42rem, calc\(100vw - 2rem\)\);[^}]*max-height: calc\(100vh - 2rem\);[^}]*overflow: auto;/s);
  assert.match(styles, /\.oba-editor-advanced-actions \{[^}]*max-width: min\(32rem, calc\(100vw - 2rem\)\);/s);
  const narrow = styles.slice(styles.indexOf("@media (max-width: 44rem)"));
  assert.match(narrow, /\.oba-preferences-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(narrow, /\.oba-module-row \{\s*flex-wrap: wrap;/);
  assert.match(narrow, /\.oba-dialog-actions \{\s*flex-wrap: wrap;/);
  assert.doesNotMatch(styles, /\.oba-advanced-trigger[^{]*\{[^}]*display: none/, "the path to advanced tools stays visible on small screens");
  assert.match(admin, /oba-advanced-trigger".*\}, "Advanced tools"\);/);
});

test("workspace personalization adds no motion that ignores reduced-motion preferences", () => {
  assert.match(page, /href="\/assets\/base\.css"/);
  assert.match(base, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important;/);
  const workspaceRules = styles.slice(styles.indexOf(".oba-dialog-actions"), styles.indexOf(".oba-command-dialog"));
  assert.doesNotMatch(workspaceRules, /animation|@keyframes/);
});
