import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { keepStoredSeries, NEW_SERIES, NO_SERIES, ObAdmin, seriesFailure, seriesPartText, seriesPlacementRequest, seriesPlacementText } from "../../web/admin/admin.js";

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
    const valued = selector.match(/^([a-z]*)\[([a-z-]+)="([^"]*)"\]$/);
    if (valued) return (!valued[1] || this.tagName === valued[1].toUpperCase()) && this.attributes[valued[2]] === valued[3];
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
  globalThis.location = { hash: "#/shared", origin: "https://blog.example" };
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
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

class FakeApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const PUBLICATION = "shared-0a1b2c3d4e5f";
const CHOICES = () => [
  { slug: "letters-across-time", name: "Letters across time", parts: 2, defined: true },
  { slug: "guides", name: "Guides", parts: 1, defined: false },
];
const PARTS = [
  { title: "First letter", url: "/first-letter/", order: 1, thisPublication: false },
  { title: "Second letter", url: "/second-letter/", order: 2, thisPublication: false },
];

/** A stand-in for the series API that behaves like the server: it checks the revision. */
function fakeApi({ canPlace = true, canCreate = false, placement = null, failures = {} } = {}) {
  const state = { revision: 0, placement, series: CHOICES(), calls: [], gets: [] };
  const preview = (series, order) => {
    if (!series) return null;
    const slug = series.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const known = state.series.find((item) => item.slug === slug);
    const parts = known?.slug === "letters-across-time" ? PARTS.map((part) => ({ ...part })) : [];
    const at = order === null || order === undefined ? parts.length : parts.filter((part) => part.order <= order).length;
    parts.splice(at, 0, { order: order ?? null, thisPublication: true });
    return { slug, name: known?.name || series, defined: Boolean(known?.defined), description: known?.defined ? "Two writers answer one letter." : "", parts };
  };
  const view = (candidate) => ({
    revision: state.revision,
    placement: state.placement,
    canPlace,
    canCreate,
    published: false,
    series: state.series,
    preview: candidate ? preview(candidate.series, candidate.order) : state.placement ? preview(state.placement.series, state.placement.order) : null,
  });
  return {
    state,
    async call(method, path, options = {}) {
      const [route, query = ""] = path.split("?");
      const key = `${method} ${route}`;
      if (method === "GET") state.gets.push(query);
      else state.calls.push({ key, body: options.json });
      if (failures[key]) {
        const failure = failures[key];
        delete failures[key];
        if (typeof failure === "function") failure(state);
        else throw failure;
      }
      switch (key) {
        case "GET collaboration/series": {
          const params = new URLSearchParams(query);
          if (!params.has("series")) return view(null);
          return view({ series: params.get("series"), order: params.get("order") === "" ? null : Number(params.get("order")) });
        }
        case "PUT collaboration/series": {
          if (options.json.expectedRevision !== state.revision) throw new FakeApiError("The series placement changed while you were working. Reload to see the current choice; nothing was changed.", 409, null);
          if (JSON.stringify(options.json.placement) !== JSON.stringify(state.placement)) {
            state.placement = options.json.placement;
            state.revision += 1;
          }
          return view(null);
        }
        case "POST collaboration/series/create": {
          const slug = options.json.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          state.series = [...state.series, { slug, name: options.json.title, parts: 0, defined: true }];
          return { slug, name: options.json.title, path: `series/${slug}.md` };
        }
        default:
          throw new FakeApiError(`unexpected ${key}`, 500, null);
      }
    },
  };
}

async function openPanel(api, roles = ["coordinator"]) {
  const app = new ObAdmin();
  app.api = api;
  const panel = app.seriesPanel({ publicationId: PUBLICATION, roles }, 0);
  document.body.append(panel);
  panel.open = true;
  await panel.dispatch("toggle");
  await settle();
  return panel;
}

const byId = (root, id) => root.querySelector(`#oba-series-0-${id}`);
const button = (root, label) => root.querySelectorAll("button").find((node) => node.textContent === label);
const textOf = (root) => root.textContent.replace(/\s+/g, " ");
const alertOf = (root) => root.querySelectorAll("p").find((node) => node.attributes.role === "alert");
const statusOf = (root) => root.querySelectorAll("p").find((node) => node.attributes.role === "status");
const formOf = (root) => byId(root, "form-heading").parent;
const createFormOf = (root) => byId(root, "create-heading").parent;
const choose = async (root, value) => {
  const select = byId(root, "choice");
  select.value = value;
  await select.dispatch("change");
};

// ---------------------------------------------------------------- pure helpers

test("placements and parts are described in words, with or without a position", () => {
  assert.equal(seriesPlacementText("Letters", 2), "Letters, part 2");
  assert.equal(seriesPlacementText("Letters", 0), "Letters, part 0");
  assert.match(seriesPlacementText("Letters", null), /^Letters \(no position/);
  assert.equal(seriesPlacementText(""), "Not part of a series.");
  assert.equal(seriesPartText({ title: "First", order: 1 }, 0), "1. First (position 1)");
  assert.equal(seriesPartText({ title: "Loose", order: null }, 2), "3. Loose (no position)");
  assert.match(seriesPartText({ thisPublication: true, order: 2 }, 1), /^2\. This shared reflection \(not published yet, position 2\)$/);
});

test("the request names an existing series by its address and checks the position", () => {
  assert.deepEqual(seriesPlacementRequest("guides", "", "3"), { placement: { series: "guides", order: 3 } });
  assert.deepEqual(seriesPlacementRequest("guides", "ignored", " "), { placement: { series: "guides", order: null } });
  assert.deepEqual(seriesPlacementRequest(NEW_SERIES, "  Letters  ", ""), { placement: { series: "Letters", order: null } });
  assert.deepEqual(seriesPlacementRequest(NO_SERIES, "", ""), { placement: null });
  for (const bad of ["-1", "1.5", "two", "4294967296"]) {
    assert.equal(seriesPlacementRequest("guides", "", bad).field, "order", bad);
  }
  assert.equal(seriesPlacementRequest(NEW_SERIES, "   ", "").field, "title");
  assert.notEqual(NEW_SERIES, NO_SERIES);
  assert.doesNotMatch(NEW_SERIES, /^[\p{L}\p{N}-]+$/u, "the new-title value can never be a series address");
});

test("an unchanged choice keeps the stored reference, so saving it changes nothing", () => {
  const stored = { series: "Letters Across Time", order: 2 };
  // The select shows the typed title as the series it resolves to; sending that back keeps the title.
  assert.deepEqual(keepStoredSeries({ series: "letters-across-time", order: 2 }, stored, "letters-across-time"), stored);
  assert.deepEqual(keepStoredSeries({ series: "letters-across-time", order: 2 }, stored, undefined), stored, "falls back to slugifying the stored title");
  assert.deepEqual(keepStoredSeries({ series: "letters-across-time", order: null }, { series: "Letters Across Time" }, "letters-across-time"), { series: "Letters Across Time", order: null });
  // A real change is sent as chosen.
  assert.deepEqual(keepStoredSeries({ series: "letters-across-time", order: 3 }, stored, "letters-across-time"), { series: "letters-across-time", order: 3 });
  assert.deepEqual(keepStoredSeries({ series: "guides", order: 2 }, stored, "letters-across-time"), { series: "guides", order: 2 });
  assert.equal(keepStoredSeries(null, stored, "letters-across-time"), null);
  assert.deepEqual(keepStoredSeries({ series: "guides", order: null }, null, undefined), { series: "guides", order: null });
});

test("failures keep what was typed and say what happened", () => {
  assert.equal(seriesFailure(undefined).kind, "offline");
  assert.equal(seriesFailure(new FakeApiError("changed", 409, null)).message, "changed");
  assert.equal(seriesFailure(new FakeApiError("nope", 404, { error: "x" })).kind, "denied");
  assert.equal(seriesFailure(new FakeApiError("bad", 422, { error: "Use a title.", field: "series" })).field, "series");
  for (const status of [undefined, 404, 409, 422, 500]) {
    assert.match(seriesFailure(status ? new FakeApiError("", status, null) : undefined).message, /\w{4,}/);
  }
});

// ---------------------------------------------------------------- the panel

test("every participant sees the placement and its reading order, but only arrangers get controls", withDom(async () => {
  const api = fakeApi({ canPlace: false, placement: { series: "letters-across-time", order: 2 } });
  const app = new ObAdmin();
  app.api = api;
  const panel = app.seriesPanel({ publicationId: PUBLICATION, roles: ["reader"] }, 0);
  assert.equal(api.state.gets.length, 0, "nothing loads until the panel is opened");
  document.body.append(panel);
  panel.open = true;
  await panel.dispatch("toggle");
  await settle();
  const text = textOf(panel);
  assert.match(text, /Series: Letters across time, part 2/);
  assert.match(text, /1\. First letter \(position 1\)/);
  assert.match(text, /3\. This shared reflection \(not published yet, position 2\)/);
  assert.match(text, /Two writers answer one letter\./);
  assert.equal(formOf(panel).hidden, true);
  assert.equal(createFormOf(panel).parent.hidden, true);
  // Words, not color, mark this reflection; links name their target.
  const links = panel.querySelectorAll("a");
  assert.equal(links.length, 2);
  for (const link of links) assert.match(link.attributes["aria-label"], /^Open (First|Second) letter$/);
  assert.doesNotMatch(text, /\b(couple|partner|husband|wife|boyfriend|girlfriend|his|hers?)\b/i);
}));

test("a coordinator previews and saves an existing series and position with the keyboard", withDom(async () => {
  const api = fakeApi();
  const panel = await openPanel(api);
  assert.match(textOf(panel), /Not part of a series\./);
  const form = formOf(panel);
  assert.equal(form.hidden, false);
  // Every control has a label.
  for (const control of [byId(panel, "choice"), byId(panel, "title"), byId(panel, "order")]) {
    assert.ok(panel.querySelectorAll("label").some((label) => label.attributes.for === control.id), control.id);
  }
  const options = byId(panel, "choice").querySelectorAll("option").map((option) => option.textContent);
  assert.deepEqual(options, ["Not in a series", "Letters across time (2 published parts)", "Guides (1 published part)", "A new series title..."]);

  await choose(panel, "letters-across-time");
  byId(panel, "order").value = "1";
  await button(panel, "Preview order").click();
  await settle();
  assert.equal(api.state.calls.length, 0, "previewing stores nothing");
  assert.match(api.state.gets.at(-1), /series=letters-across-time&order=1$/);
  assert.match(textOf(panel), /1\. First letter \(position 1\) Open\s*2\. This shared reflection \(not published yet, position 1\)/);
  assert.match(statusOf(panel).textContent, /Nothing has been saved/);

  await form.dispatch("submit");
  await settle();
  assert.deepEqual(api.state.calls.at(-1), { key: "PUT collaboration/series", body: { publicationId: PUBLICATION, expectedRevision: 0, placement: { series: "letters-across-time", order: 1 } } });
  assert.match(statusOf(panel).textContent, /approves the piece again/);
  assert.match(textOf(panel), /Series: Letters across time, part 1/);
  assert.equal(document.activeElement, button(panel, "Save placement"), "focus stays on the control that was used");
  // Reordering uses the new revision; removing sends no placement.
  byId(panel, "order").value = "3";
  await form.dispatch("submit");
  await settle();
  assert.equal(api.state.calls.at(-1).body.expectedRevision, 1);
  await choose(panel, NO_SERIES);
  await form.dispatch("submit");
  await settle();
  assert.deepEqual(api.state.calls.at(-1).body, { publicationId: PUBLICATION, expectedRevision: 2, placement: null });
  assert.match(textOf(panel), /Not part of a series\./);
}));

test("saving a typed title that names an existing series, unchanged, keeps every approval", withDom(async () => {
  const api = fakeApi({ placement: { series: "Letters Across Time", order: 2 } });
  const panel = await openPanel(api);
  assert.equal(byId(panel, "choice").value, "letters-across-time", "the stored title is shown as the series it joins");
  await formOf(panel).dispatch("submit");
  await settle();
  assert.deepEqual(api.state.calls.at(-1).body.placement, { series: "Letters Across Time", order: 2 });
  assert.equal(api.state.revision, 0, "nothing changed, so the revision and approvals stand");
  assert.equal(statusOf(panel).textContent, "Nothing changed.");
  // Changing the position is a real change and is sent as chosen.
  byId(panel, "order").value = "3";
  await formOf(panel).dispatch("submit");
  await settle();
  assert.deepEqual(api.state.calls.at(-1).body.placement, { series: "letters-across-time", order: 3 });
  assert.equal(api.state.revision, 1);
}));

test("a new title is typed in a labelled field that appears only when chosen", withDom(async () => {
  const api = fakeApi();
  const panel = await openPanel(api);
  const titleField = byId(panel, "title").parent;
  assert.equal(titleField.hidden, true);
  await choose(panel, NEW_SERIES);
  assert.equal(titleField.hidden, false);
  byId(panel, "title").value = "Seasons <of> change";
  await formOf(panel).dispatch("submit");
  await settle();
  assert.deepEqual(api.state.calls.at(-1).body.placement, { series: "Seasons <of> change", order: null });
  // The stored new title comes back into the field, and text stays text.
  assert.equal(byId(panel, "choice").value, NEW_SERIES);
  assert.equal(byId(panel, "title").value, "Seasons <of> change");
  assert.match(textOf(panel), /Series: Seasons <of> change \(no position/);
  assert.equal(panel.querySelectorAll("of").length, 0);
}));

test("a stale save keeps the person's choice, explains, and reloads the current placement", withDom(async () => {
  const api = fakeApi({
    failures: {
      "PUT collaboration/series": (state) => {
        // Someone else saved first.
        state.placement = { series: "guides", order: 4 };
        state.revision = 1;
        throw new FakeApiError("The series placement changed while you were working. Reload to see the current choice; nothing was changed.", 409, null);
      },
    },
  });
  const panel = await openPanel(api);
  await choose(panel, NEW_SERIES);
  byId(panel, "title").value = "My typed title";
  byId(panel, "order").value = "7";
  await formOf(panel).dispatch("submit");
  await settle();
  const alert = alertOf(panel);
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /changed while you were working/);
  assert.equal(document.activeElement, alert);
  assert.equal(byId(panel, "choice").value, NEW_SERIES);
  assert.equal(byId(panel, "title").value, "My typed title");
  assert.equal(byId(panel, "order").value, "7");
  assert.match(textOf(panel), /Series: Guides, part 4/, "the current placement is shown beside the typed choice");
  // Saving again goes against the revision just read.
  await formOf(panel).dispatch("submit");
  await settle();
  assert.deepEqual(api.state.calls.at(-1).body, { publicationId: PUBLICATION, expectedRevision: 1, placement: { series: "My typed title", order: 7 } });
}));

test("a denied or offline save keeps the choice and does not pretend it was saved", withDom(async () => {
  const api = fakeApi({ failures: { "PUT collaboration/series": new FakeApiError("That shared reflection was not found, or you cannot see or arrange its series.", 404, null) } });
  const panel = await openPanel(api);
  await choose(panel, "guides");
  byId(panel, "order").value = "2";
  const reads = api.state.gets.length;
  await formOf(panel).dispatch("submit");
  await settle();
  assert.match(alertOf(panel).textContent, /cannot arrange/);
  assert.equal(byId(panel, "choice").value, "guides");
  assert.equal(byId(panel, "order").value, "2");
  assert.equal(api.state.gets.length, reads);
  assert.match(textOf(panel), /Not part of a series\./);
  api.state.calls.length = 0;
  api.call = async () => {
    throw new TypeError("Failed to fetch");
  };
  await formOf(panel).dispatch("submit");
  await settle();
  assert.match(alertOf(panel).textContent, /offline/);
  assert.equal(byId(panel, "order").value, "2");
}));

test("a bad position is caught before sending, and focus goes to the field", withDom(async () => {
  const api = fakeApi();
  const panel = await openPanel(api);
  await choose(panel, "guides");
  byId(panel, "order").value = "-2";
  await formOf(panel).dispatch("submit");
  await settle();
  assert.equal(api.state.calls.length, 0);
  assert.match(alertOf(panel).textContent, /whole number/);
  assert.equal(document.activeElement, byId(panel, "order"));
  await choose(panel, NEW_SERIES);
  byId(panel, "order").value = "";
  await formOf(panel).dispatch("submit");
  await settle();
  assert.equal(api.state.calls.length, 0);
  assert.equal(document.activeElement, byId(panel, "title"));
}));

test("only a site owner can add a new series, which is then ready to choose", withDom(async () => {
  const coordinator = await openPanel(fakeApi({ canCreate: false }));
  assert.equal(createFormOf(coordinator).parent.hidden, true);
  coordinator.remove();

  const api = fakeApi({ canCreate: true });
  const panel = await openPanel(api, ["siteOwner", "contributor"]);
  const createForm = createFormOf(panel);
  assert.equal(createForm.parent.hidden, false);
  await createForm.dispatch("submit");
  await settle();
  assert.equal(api.state.calls.length, 0, "a name is required before sending");
  assert.equal(document.activeElement, byId(panel, "new-title"));
  byId(panel, "new-title").value = "Seasons";
  byId(panel, "premise").value = "Each part answers one question.";
  await createForm.dispatch("submit");
  await settle();
  assert.deepEqual(api.state.calls.at(-1), { key: "POST collaboration/series/create", body: { publicationId: PUBLICATION, title: "Seasons", premise: "Each part answers one question." } });
  assert.equal(byId(panel, "choice").value, "seasons");
  assert.equal(document.activeElement, byId(panel, "choice"));
  assert.match(statusOf(panel).textContent, /Choose Save placement/);
  assert.equal(api.state.placement, null, "creating a series places nothing");
  assert.equal(byId(panel, "new-title").value, "");
}));

test("the series panel is in every shared reflection card and styled for small screens", () => {
  assert.match(admin, /this\.seriesPanel\(publication, index\)/);
  assert.match(styles, /\.oba-series \.oba-btn \{\s*min-height: 2\.75rem;/);
  assert.match(styles, /@media \(max-width: 44rem\) \{\s*\.oba-series \.oba-toolbar \.oba-btn/);
});
