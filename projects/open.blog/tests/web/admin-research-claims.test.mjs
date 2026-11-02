import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  claimAnchorStatusText,
  claimCountsText,
  claimDiagnosticControl,
  claimDraft,
  claimFindings,
  claimFindingsSummary,
  claimLinkColumns,
  claimPayload,
  claimSelectionAnchor,
  claimsErrorMessage,
  createClaimsStudio,
  evidenceLinkDraft,
  evidenceLinkPayload,
  utf8Length,
  validateEvidenceLinkDraft,
  visualBlockSpans,
  visualSelectionAnchor,
} from "../../web/admin/admin.js";

// Claims and evidence links in Evidence Studio (A4.2, ADR 0073): selection anchors in UTF-8
// bytes, opposing links side by side and never netted, stale and ambiguous ranges refused,
// conflicts that keep the draft, undo, keyboard labels, and hostile text kept as text.

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

// ---------------------------------------------------------------- fixtures

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const HOSTILE = '<img src=x onerror="alert(1)"> Πλάτων 🙂 <script>alert(2)</script>';
const SOURCES = () => [
  { id: "plato-republic", kind: "work", title: "Πολιτεία" },
  { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam" },
  { id: "scholar", kind: "work", title: "A study" },
];
const PASSAGES = () => [{ id: "passage-1", source: "slings-2003", locators: [{ kind: "page", value: "514" }], preview: "the cave" }];
const CLAIM = () => ({ id: "c1", post: "on-caves", statement: HOSTILE, anchor: { start: 4, end: 8, text: "cave" }, recordedBy: { kind: "author" }, origin: "authored", visibility: "private", shelf: 1 });
const LINKS = () => [
  { id: "l1", claim: "c1", relation: "supports", evidence: { source: "slings-2003", locators: [{ kind: "page", value: "514" }], margin: "kept" }, rationale: "Socrates says so.", confidence: "plausible", reviewState: "unreviewed", recordedBy: { kind: "author" }, origin: "authored", visibility: "private" },
  { id: "l2", claim: "c1", relation: "contradicts", evidence: { source: "scholar" }, confidence: "tentative", uncertainty: "Disputed.", reviewState: "reviewed", recordedBy: { kind: "author" }, origin: "authored", visibility: "private" },
  { id: "l3", claim: "c1", relation: "contradicts", evidence: { source: "plato-republic" }, confidence: "strong", reviewState: "unreviewed", recordedBy: { kind: "author" }, origin: "authored", visibility: "private" },
];
const view = (over = {}) => ({
  file: ".openblog/private/research/claims.json",
  revision: "r1",
  stored: true,
  post: "on-caves",
  claims: [CLAIM(), { id: "c9", post: "elsewhere", statement: "Another post's claim", visibility: "private" }],
  links: LINKS(),
  notices: [],
  anchors: { c1: { status: "verified" } },
  counts: { c1: { supports: 1, contradicts: 2, contextualizes: 0 }, c9: { supports: 0, contradicts: 0, contextualizes: 0 } },
  projected: [],
  sources: SOURCES(),
  passages: PASSAGES(),
  ...over,
});

function claimsApi(handlers = {}) {
  const calls = [];
  const all = { "GET research/claims?path=posts%2F2026-01-07-on-caves.md": () => view(), ...handlers };
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

const POST = { path: "posts/2026-01-07-on-caves.md", etag: "e1", dirty: false, slug: "on-caves" };

async function mountStudio(api, { post = POST, selection = () => ({ anchor: { start: 4, end: 8, text: "cave" } }) } = {}) {
  const studio = createClaimsStudio({ api, post: () => post, selection });
  globalThis.document.body.append(studio.element);
  await studio.load();
  return studio;
}

const byId = (root, id) => root.querySelector(`#${id}`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const buttonLabelled = (root, text) => root.querySelectorAll("button").find((button) => button.textContent === text || button.getAttribute("aria-label") === text);
const allNodes = (root) => root.children.flatMap((child) => [child, ...allNodes(child)]);
const withData = (root, key, value) => allNodes(root).filter((node) => node.dataset?.[key] === value);
const type = async (control, value, event = "input") => {
  control.value = value;
  await control.dispatch(event, { target: control });
};
const choose = (control, value) => type(control, value, "change");
const submit = (root) => root.querySelector("form").dispatch("submit");

// ---------------------------------------------------------------- pure helpers

test("selections become UTF-8 byte anchors in the saved draft's terms", () => {
  assert.equal(utf8Length("Πλάτων 🙂"), 17);
  const body = "The cave. Πλάτων 🙂 says so.";
  const start = body.indexOf("Πλάτων");
  assert.deepEqual(claimSelectionAnchor(body, start, start + "Πλάτων 🙂".length), { anchor: { start: 10, end: 27, text: "Πλάτων 🙂" } });
  // Surrounding spaces are trimmed, CRLF folds to LF, and leading line breaks do not count: the
  // server's anchor text drops them too, as an Admin save trims them after the front matter.
  assert.deepEqual(claimSelectionAnchor("\n\nab  cd\r\nef ", 6, 13), { anchor: { start: 4, end: 9, text: "cd\nef" } });
  assert.match(claimSelectionAnchor(body, 3, 3).error, /Select the words/);
  assert.match(claimSelectionAnchor("a \u202e b", 0, 5).error, /control or direction-override/);
  assert.match(claimSelectionAnchor("x".repeat(2100), 0, 2100).error, /at most 2000/);
});

test("visual selections anchor only to words that occur once in their own block, counted overlapping", () => {
  const first = { index: 0, type: "paragraph" };
  assert.deepEqual(visualSelectionAnchor("Oh, ha ha!", "ha ha", first), { anchor: { start: 4, end: 9, text: "ha ha" } });
  assert.match(visualSelectionAnchor("ha ha ha", "ha ha", first).error, /more than once in that block/);
  assert.match(visualSelectionAnchor("**bold** words", "bold words", first).error, /formatted differently/);
  assert.match(visualSelectionAnchor("text", "  ", first).error, /Select the words/);
  // A selection that is not inside one known block is refused rather than searched for.
  assert.match(visualSelectionAnchor("Oh, ha ha!", "ha ha", { index: -1 }).error, /Switch to Markdown/);
  assert.match(visualSelectionAnchor("Oh, ha ha!", "ha ha", { index: 3, type: "paragraph" }).error, /inside one paragraph/);
  assert.match(visualSelectionAnchor("Oh, ha ha!", "ha ha", { index: 0, type: "heading" }).error, /inside one paragraph/);
});

test("visual selections never anchor to the same words formatted differently elsewhere", () => {
  // The rendered "The big cave" reads as "big cave", which the Markdown writes only later as plain text.
  const body = "The *big* cave is dark.\n\nA big cave again.\n";
  assert.deepEqual(visualBlockSpans(body), [
    { type: "paragraph", start: 0, end: 24 },
    { type: "paragraph", start: 25, end: body.length },
  ]);
  assert.match(visualSelectionAnchor(body, "big cave", { index: 0, type: "paragraph" }).error, /formatted differently/);
  // The same words selected in the second block anchor there, in byte terms.
  const later = body.indexOf("big cave again");
  assert.deepEqual(visualSelectionAnchor(body, "big cave", { index: 1, type: "paragraph" }), { anchor: { start: later, end: later + 8, text: "big cave" } });
  // A soft line break inside a paragraph matches a space in the selection.
  const wrapped = "# Caves\n\nThe cave\neducates.\n";
  const at = wrapped.indexOf("cave\neducates");
  assert.deepEqual(visualSelectionAnchor(wrapped, "cave educates", { index: 1, type: "paragraph" }), { anchor: { start: at, end: at + 13, text: "cave\neducates" } });
  assert.deepEqual(visualSelectionAnchor(wrapped, "Caves", { index: 0, type: "heading" }), { anchor: { start: 2, end: 7, text: "Caves" } });
});

test("visual selections are refused when the editor and the draft do not line up, or the words show twice", () => {
  const body = "Intro.\n\nThe cave educates.\n\nThe cave educates again.\n";
  const at = body.indexOf("cave educates.");
  const ok = { index: 1, type: "paragraph", markdown: "The cave educates.", text: "The cave educates." };
  assert.deepEqual(visualSelectionAnchor(body, "cave educates", ok), { anchor: { start: at, end: at + 13, text: "cave educates" } });
  // The block's own Markdown must be that span exactly; the editor's block count must match the draft's.
  assert.match(visualSelectionAnchor(body, "cave educates", { ...ok, markdown: "The cave educates again." }).error, /line up block for block/);
  assert.match(visualSelectionAnchor(body, "cave educates", { index: 1, type: "paragraph", count: 4 }).error, /line up block for block/);
  assert.equal(visualSelectionAnchor(body, "cave educates", { index: 1, type: "paragraph", count: 3 }).anchor.start, at);
  // "*big* cave" selected: the Markdown has the words once, plainly, but the block shows them twice.
  const formatted = "The *big* cave and the big cave.\n";
  assert.match(visualSelectionAnchor(formatted, "big cave", { index: 0, type: "paragraph", text: "The big cave and the big  cave." }).error, /more than once in that block/);
});

test("links are grouped by relation in file order and counted apart, never netted", () => {
  const columns = claimLinkColumns(LINKS(), "c1");
  assert.deepEqual(columns.supports.map((link) => link.id), ["l1"]);
  assert.deepEqual(columns.contradicts.map((link) => link.id), ["l2", "l3"]);
  assert.deepEqual(columns.contextualizes, []);
  const text = claimCountsText({ supports: 1, contradicts: 2, contextualizes: 0 });
  assert.equal(text, "1 supporting link, 2 contradicting links, 0 contextualizing links");
  assert.doesNotMatch(text, /net|score|verdict|-1|total/i);
  for (const status of ["moved", "stale", "ambiguous"]) assert.match(claimAnchorStatusText({ status }), new RegExp(status, "i"));
  assert.match(claimAnchorStatusText({ status: "verified" }), /^In place/);
  assert.match(claimAnchorStatusText(null), /No anchor/);
});

test("payloads keep unknown fields, and a relation is never defaulted", () => {
  const claim = claimDraft(CLAIM());
  claim.statement = " Reworded. ";
  claim.approved = true;
  assert.deepEqual(claimPayload(claim), { ...CLAIM(), statement: "Reworded.", visibility: "approved" });
  const fresh = evidenceLinkDraft(null, { claim: "c1" });
  assert.equal(fresh.relation, "");
  assert.equal(validateEvidenceLinkDraft(fresh, { sources: SOURCES(), passages: PASSAGES() }).field, "relation");
  const link = evidenceLinkDraft(LINKS()[0]);
  link.rationale = "Plainly.";
  assert.deepEqual(evidenceLinkPayload(link), { ...LINKS()[0], rationale: "Plainly." });
  link.evidence.passage = "passage-1";
  link.evidence.source = "scholar";
  assert.equal(validateEvidenceLinkDraft(link, { sources: SOURCES(), passages: PASSAGES() }).field, "passage");
  link.evidence.source = "slings-2003";
  link.approved = true;
  assert.match(validateEvidenceLinkDraft(link, { sources: SOURCES(), passages: PASSAGES() }).message, /never a private notebook passage/);
  link.approved = false;
  link.evidence.locators = "514";
  assert.equal(validateEvidenceLinkDraft(link, { sources: SOURCES(), passages: PASSAGES() }).field, "locators");
  assert.equal(claimDiagnosticControl("evidence.passage", "link"), "passage");
  assert.equal(claimDiagnosticControl("anchor", "claim"), "statement");
  assert.match(claimsErrorMessage({ data: { diagnostics: [{ field: "claim", message: "stale words", code: "stale-anchor" }] } }), /claim: stale words/);
});

// ---------------------------------------------------------------- the studio

test("a post's claims list their supporting and contradicting evidence side by side, as text", withDom(async () => {
  const studio = await mountStudio(claimsApi());
  const root = studio.element;
  const claims = withData(root, "claimsClaim", "c1");
  assert.equal(claims.length, 1);
  assert.equal(withData(root, "claimsClaim", "c9").length, 0, "another post's claims stay out of this post");
  assert.equal(root.querySelectorAll("img").length + root.querySelectorAll("script").length, 0);
  assert.ok(root.textContent.includes(HOSTILE));
  const columns = root.querySelector(".oba-claim-columns");
  assert.deepEqual(columns.children.map((column) => column.dataset.claimsColumn), ["supports", "contradicts"]);
  assert.match(columns.children[0].textContent, /Supporting \(1\)/);
  assert.match(columns.children[1].textContent, /Contradicting \(2\)/);
  assert.match(root.textContent, /1 supporting link, 2 contradicting links, 0 contextualizing links/);
  assert.match(withData(root, "claimsAnchor", "verified")[0].textContent, /In place/);
  assert.match(root.textContent, /Disputed\./);
  assert.match(root.textContent, /Stored privately in \.openblog\/private\/research\/claims\.json/);
  assert.doesNotMatch(root.querySelector("[data-claims-list]").textContent, /score|verdict|true claim|proven|net /i);
}));

test("making a claim checks the selection against the saved draft, then saves it with the revision", withDom(async () => {
  const api = claimsApi({
    "POST research/claims/anchor": (body) => ({ post: "on-caves", status: "verified", anchor: { start: body.start, end: body.end, text: body.text } }),
    "POST research/claims/claims": (body) => ({ ...view({ revision: "r2", claims: [CLAIM(), body.claim], anchors: { c1: { status: "verified" }, [body.claim.id]: { status: "verified" } } }), claim: body.claim }),
  });
  const studio = await mountStudio(api, { selection: () => ({ anchor: { start: 4, end: 14, text: "Πλάτων" } }) });
  const root = studio.element;
  await buttonLabelled(root, "Make a claim from the selected words").click();
  assert.deepEqual(api.calls[0], { method: "POST", path: "research/claims/anchor", body: { path: POST.path, etag: "e1", start: 4, end: 14, text: "Πλάτων" } });
  assert.equal(globalThis.document.activeElement.id, "oba-claims-statement");
  assert.equal(byId(root, "oba-claims-statement").value, "Πλάτων");
  await type(byId(root, "oba-claims-statement"), "Plato is named here.");
  await type(byId(root, "oba-claims-uncertainty"), "Which Plato?");
  await submit(root);
  const saved = api.calls[1];
  assert.equal(saved.path, "research/claims/claims");
  assert.equal(saved.body.revision, "r1");
  assert.deepEqual(saved.body.claim, { id: "plato-is-named-here", post: "on-caves", statement: "Plato is named here.", anchor: { start: 4, end: 14, text: "Πλάτων" }, uncertainty: "Which Plato?", visibility: "private" });
  assert.equal(globalThis.document.activeElement.id, "oba-claims-claim-plato-is-named-here");
  assert.match(root.textContent, /Claim saved privately/);
}));

test("unsaved, stale or ambiguous selections fail without writing anything", withDom(async () => {
  const api = claimsApi({ "POST research/claims/anchor": () => ({ post: "on-caves", status: "ambiguous", anchor: {} }) });
  const dirty = await mountStudio(api, { post: { ...POST, dirty: true } });
  await buttonLabelled(dirty.element, "Make a claim from the selected words").click();
  assert.equal(api.calls.length, 0, "unsaved text is never sent as the draft");
  assert.match(dirty.element.textContent, /Save the post first/);
  dirty.element.remove();

  const studio = await mountStudio(api);
  await buttonLabelled(studio.element, "Make a claim from the selected words").click();
  assert.deepEqual(api.calls.map((call) => call.path), ["research/claims/anchor"]);
  assert.match(studio.element.textContent, /Not anchored\. Ambiguous/);
  assert.equal(studio.element.querySelector("form"), null);
  studio.element.remove();

  const changed = claimsApi({ "POST research/claims/anchor": () => { throw new ApiError("conflict", 409, { error: "The post was saved elsewhere after you opened it.", draftChanged: true }); } });
  const other = await mountStudio(changed);
  await buttonLabelled(other.element, "Make a claim from the selected words").click();
  assert.match(other.element.textContent, /saved elsewhere/);
  assert.equal(changed.calls.length, 1);
}));

test("evidence is linked with a named relation, a notebook passage, rationale, confidence and uncertainty", withDom(async () => {
  const api = claimsApi({
    "POST research/claims/links": (body) => ({ ...view({ revision: "r2", links: [...LINKS(), body.link], counts: { c1: { supports: 1, contradicts: 3, contextualizes: 0 } } }), link: body.link }),
  });
  const studio = await mountStudio(api);
  const root = studio.element;
  await root.querySelector("[data-claims-add-link]").click();
  assert.equal(globalThis.document.activeElement.id, "oba-claims-relation-supports");
  // No relation chosen: refused at the relation, nothing sent.
  await submit(root);
  assert.equal(api.calls.length, 0);
  assert.match(byId(root, "oba-claims-error").textContent, /citation alone asserts none/);
  assert.equal(globalThis.document.activeElement.id, "oba-claims-relation-supports");
  const contradicts = byId(root, "oba-claims-relation-contradicts");
  contradicts.checked = true;
  await contradicts.dispatch("change", { target: contradicts });
  await choose(byId(root, "oba-claims-passage"), "passage-1");
  assert.equal(byId(root, "oba-claims-source").value, "slings-2003", "a passage names its source");
  assert.equal(byId(root, "oba-claims-locators").value, "page: 514");
  await type(byId(root, "oba-claims-rationale"), "The cave reads otherwise here.");
  await choose(byId(root, "oba-claims-confidence"), "plausible");
  await type(byId(root, "oba-claims-uncertainty"), "Translation disputed.");
  await choose(byId(root, "oba-claims-review"), "location-checked");
  await submit(root);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body, {
    revision: "r1",
    link: {
      id: "c1-contradicts",
      claim: "c1",
      relation: "contradicts",
      evidence: { source: "slings-2003", locators: [{ kind: "page", value: "514" }], passage: "passage-1" },
      rationale: "The cave reads otherwise here.",
      confidence: "plausible",
      uncertainty: "Translation disputed.",
      reviewState: "location-checked",
      visibility: "private",
    },
  });
  assert.match(root.querySelector(".oba-claim-columns").children[1].textContent, /Contradicting \(3\)/);
  assert.equal(globalThis.document.activeElement.id, "oba-claims-claim-c1");
}));

test("a refused link keeps the draft and says nothing was stored", withDom(async () => {
  const api = claimsApi({
    "POST research/claims/links": () => { throw new ApiError("invalid", 422, { error: "stale", diagnostics: [{ code: "stale-anchor", collection: "links", field: "claim", message: "the claim's words are no longer in the saved draft" }] }); },
  });
  const studio = await mountStudio(api);
  const root = studio.element;
  await root.querySelector("[data-claims-add-link]").click();
  const supports = byId(root, "oba-claims-relation-supports");
  supports.checked = true;
  await supports.dispatch("change", { target: supports });
  await choose(byId(root, "oba-claims-source"), "scholar");
  await type(byId(root, "oba-claims-rationale"), "Kept after a refusal.");
  await submit(root);
  assert.match(root.textContent, /Not saved\. The stored claims and the draft are unchanged\./);
  assert.match(byId(root, "oba-claims-error").textContent, /no longer in the saved draft/);
  assert.equal(byId(root, "oba-claims-rationale").value, "Kept after a refusal.");
  assert.equal(byId(root, "oba-claims-source").value, "scholar");
}));

test("stale and ambiguous claims block new evidence and offer a re-anchor; a moved one re-anchors in place", withDom(async () => {
  const api = claimsApi({
    "GET research/claims?path=posts%2F2026-01-07-on-caves.md": () => view({ anchors: { c1: { status: "moved", start: 10 } } }),
    "PUT research/claims/claims": (body) => ({ ...view({ revision: "r2", claims: [body.claim], anchors: { c1: { status: "verified" } } }), claim: body.claim }),
  });
  const studio = await mountStudio(api);
  const root = studio.element;
  assert.equal(root.querySelector("[data-claims-add-link]").disabled, false, "a moved claim still takes evidence");
  await root.querySelector("[data-claims-reanchor]").click();
  assert.deepEqual(api.calls[0].body.claim.anchor, { start: 10, end: 14, text: "cave" });
  assert.equal(api.calls[0].body.claim.shelf, 1, "unknown fields survive a re-anchor");
  assert.match(root.textContent, /re-anchored/);

  const stale = claimsApi({
    "GET research/claims?path=posts%2F2026-01-07-on-caves.md": () => view({ anchors: { c1: { status: "stale" } } }),
    "POST research/claims/anchor": () => ({ post: "on-caves", status: "verified", anchor: { start: 20, end: 24, text: "cave" } }),
    "PUT research/claims/claims": (body) => ({ ...view({ revision: "r2", claims: [body.claim], anchors: { c1: { status: "verified" } } }), claim: body.claim }),
  });
  const blocked = await mountStudio(stale);
  assert.equal(blocked.element.querySelector("[data-claims-add-link]").disabled, true);
  assert.match(blocked.element.textContent, /Stale: the words are no longer in the saved draft/);
  const button = blocked.element.querySelector("[data-claims-reanchor]");
  assert.equal(button.textContent, "Re-anchor to the selected words");
  await button.click();
  assert.deepEqual(stale.calls.map((call) => call.path), ["research/claims/anchor", "research/claims/claims"]);
  assert.deepEqual(stale.calls[1].body.claim.anchor, { start: 20, end: 24, text: "cave" });
}));

test("a conflict blocks saving until the author uses the stored copy or keeps the draft", withDom(async () => {
  let stored = { ...CLAIM(), statement: "Changed elsewhere", extra: "theirs" };
  let attempt = 0;
  const api = claimsApi({
    "PUT research/claims/claims": (body) => {
      attempt += 1;
      if (attempt === 1) throw new ApiError("conflict", 409, { conflict: true, revision: "r2", current: stored });
      return { ...view({ revision: "r3", claims: [body.claim] }), claim: body.claim };
    },
  });
  const studio = await mountStudio(api);
  const root = studio.element;
  await buttonLabelled(root, `Edit claim: ${HOSTILE}`).click();
  await type(byId(root, "oba-claims-statement"), "My wording");
  await submit(root);
  assert.ok(root.querySelector("[data-claims-conflict]"));
  assert.equal(root.querySelector("[data-claims-save]").disabled, true);
  assert.equal(globalThis.document.activeElement.dataset.claimsConflictUse, "stored");
  await submit(root);
  assert.equal(attempt, 1, "nothing is sent until the author chooses");
  await buttonLabelled(root, "Keep my draft").click();
  assert.equal(byId(root, "oba-claims-statement").value, "My wording");
  await submit(root);
  assert.equal(attempt, 2);
  assert.equal(api.calls.at(-1).body.claim.statement, "My wording");
  assert.equal(api.calls.at(-1).body.claim.extra, "theirs", "fields added elsewhere carry over");
  stored = null;
}));

test("using the stored copy after a conflict replaces the draft", withDom(async () => {
  const api = claimsApi({
    "PUT research/claims/claims": () => { throw new ApiError("conflict", 409, { conflict: true, revision: "r2", current: { ...CLAIM(), statement: "Stored wording" } }); },
  });
  const studio = await mountStudio(api);
  const root = studio.element;
  await buttonLabelled(root, `Edit claim: ${HOSTILE}`).click();
  await type(byId(root, "oba-claims-statement"), "Mine");
  await submit(root);
  await buttonLabelled(root, "Use the stored copy").click();
  assert.equal(byId(root, "oba-claims-statement").value, "Stored wording");
  assert.equal(root.querySelector("[data-claims-conflict]"), null);
}));

test("removing a link can be undone from the keyboard", withDom(async () => {
  const api = claimsApi({
    "DELETE research/claims/links": () => view({ revision: "r2", links: LINKS().filter((link) => link.id !== "l2"), counts: { c1: { supports: 1, contradicts: 1, contextualizes: 0 } } }),
    "POST research/claims/links": (body) => ({ ...view({ revision: "r3" }), link: body.link }),
  });
  const studio = await mountStudio(api);
  const root = studio.element;
  await root.querySelectorAll("button").find((button) => button.dataset.claimsRemoveLink === "l2").click();
  assert.deepEqual(api.calls[0].body, { revision: "r1", id: "l2" });
  const undo = root.querySelector("[data-claims-undo-button]");
  assert.equal(globalThis.document.activeElement, undo);
  assert.equal(undo.textContent, "Undo removing the link");
  await undo.click();
  assert.deepEqual(api.calls[1], { method: "POST", path: "research/claims/links", body: { revision: "r2", link: LINKS()[1] } });
  assert.equal(root.querySelector("[data-claims-undo-button]"), null);
  assert.match(root.textContent, /Evidence link restored/);
}));

test("approved support held back by a private contradiction says so, and notices name ids only", withDom(async () => {
  const links = LINKS();
  links[0].visibility = "approved";
  const api = claimsApi({
    "GET research/claims?path=posts%2F2026-01-07-on-caves.md": () => view({ links, notices: [{ code: "private-endpoint", collection: "links", id: "l1", field: "claim", message: "the claim `c1` is private, so this approved link stays out of public output until the claim is approved" }] }),
  });
  const studio = await mountStudio(api);
  assert.match(studio.element.textContent, /Approved, but held back until its claim and every contradicting link on it are approved/);
  assert.match(withData(studio.element, "claimsNotice", "private-endpoint")[0].textContent, /^Link l1: the claim `c1` is private/);
}));

const FINDINGS = () => [
  { code: "claim-contradiction-undiscussed", outcome: "needs-review", source: { path: "posts/2026-01-07-on-caves.md", field: "claims[c1].uncertainty" }, message: "Claim `c1` has 2 contradicting evidence links and no uncertainty note saying how the post addresses them.", repair: "Discuss the contradicting evidence in the post, then record how in the claim's uncertainty note in Evidence Studio.", object: { claim: "c1" } },
  { code: "claim-location-unreviewed", outcome: "needs-review", source: { path: "posts/2026-01-07-on-caves.md", field: "links[l1].reviewState" }, message: `Evidence link \`l1\` gives a location. ${HOSTILE}`, repair: "Compare the location with the source.", object: { claim: "c1", link: "l1" } },
  { code: "claim-locator-missing", outcome: "potential", source: { path: "posts/2026-01-07-on-caves.md", field: "links[l2].evidence.locators" }, message: "Evidence link `l2` names source `scholar` but no page or other location in it.", repair: "Add where it is.", object: { claim: "c1", link: "l2" } },
  { code: "claim-evidence-missing", outcome: "potential", source: { path: ".openblog/private/research/claims.json", field: "claims[c9]" }, message: "Claim `c9` has no evidence links.", repair: "Link the sources you relied on.", object: { claim: "c9" } },
];

test("evidence gaps are kept per claim in review order and summarised as gaps, never verdicts", () => {
  assert.deepEqual(claimFindings(FINDINGS(), "c1").map((finding) => finding.code), ["claim-contradiction-undiscussed", "claim-location-unreviewed", "claim-locator-missing"]);
  assert.deepEqual(claimFindings([null, { object: { claim: "c1" } }, ...FINDINGS()], "c9").map((finding) => finding.code), ["claim-evidence-missing"]);
  const summary = claimFindingsSummary(claimFindings(FINDINGS(), "c1"));
  assert.equal(summary, "3 evidence gaps and review prompts for this post's claims: 0 detected, 1 potential, 2 needing review. They show what the record lacks or what only you can check, never whether a claim is true.");
  assert.match(claimFindingsSummary([]), /^No evidence gaps or review prompts/);
  assert.doesNotMatch(`${summary} ${claimFindingsSummary([])}`, /verified|score|proven|correct/i);
  // A position check is never labelled as verifying the claim.
  assert.doesNotMatch(claimAnchorStatusText({ status: "verified" }), /^Verified/);
  assert.match(claimAnchorStatusText({ status: "verified" }), /text positions only, not whether the claim is true/);
});

test("Evidence Studio lists each claim's gaps and prompts with the action to take, as text", withDom(async () => {
  const api = claimsApi({ "GET research/claims?path=posts%2F2026-01-07-on-caves.md": () => view({ findings: FINDINGS() }) });
  const studio = await mountStudio(api);
  const root = studio.element;
  const section = withData(root, "claimsFindings", "c1")[0];
  assert.ok(section, "the claim has a findings section");
  assert.match(section.getAttribute("aria-label"), /^Evidence gaps and prompts for the claim: /);
  assert.equal(section.querySelector("h5").textContent, "Gaps and prompts (3)");
  const items = section.querySelectorAll("li");
  assert.deepEqual(items.map((item) => item.dataset.claimsFinding), ["claim-contradiction-undiscussed", "claim-location-unreviewed", "claim-locator-missing"]);
  assert.match(items[0].textContent, /claim-contradiction-undiscussed \(needing review\): Claim `c1` has 2 contradicting/);
  assert.match(items[0].textContent, /Next: Discuss the contradicting evidence/);
  // Hostile text in a message stays text.
  assert.ok(items[1].textContent.includes(HOSTILE));
  assert.equal(root.querySelectorAll("img").length, 0);
  // Another post's claim and its finding are not shown here.
  assert.equal(withData(root, "claimsFindings", "c9").length, 0);
  const summary = root.querySelector("[data-claims-findings-summary]");
  assert.equal(summary.hidden, false);
  assert.match(summary.textContent, /^3 evidence gaps and review prompts for this post's claims: 0 detected, 1 potential, 2 needing review\./);
}));

test("every claims control is labelled and the relation is a fieldset with a legend", withDom(async () => {
  const studio = await mountStudio(claimsApi());
  const root = studio.element;
  await root.querySelector("[data-claims-add-link]").click();
  const form = root.querySelector("form");
  const labels = new Set(form.querySelectorAll("label").map((label) => label.getAttribute("for")));
  for (const control of [...form.querySelectorAll("input"), ...form.querySelectorAll("select"), ...form.querySelectorAll("textarea")]) {
    assert.ok(labels.has(control.id), `control ${control.id} has a label`);
  }
  assert.equal(form.querySelectorAll("legend")[0].textContent, "How does this source bear on the claim?");
  assert.equal(form.querySelectorAll("input").filter((input) => input.getAttribute("type") === "radio").every((radio) => !radio.checked), true, "no relation is preselected");
  const actions = root.querySelectorAll("button").filter((button) => button.getAttribute("aria-label")?.startsWith("Edit link:"));
  assert.equal(actions.length, 3, "each link's actions name the link");
}));

test("a damaged claims file is reported as text with no way to overwrite it", withDom(async () => {
  const api = claimsApi({
    "GET research/claims?path=posts%2F2026-01-07-on-caves.md": () => { throw new ApiError("bad", 422, { error: "claims file: invalid JSON", file: ".openblog/private/research/claims.json", diagnostics: [{ code: "invalid-json", message: "invalid JSON" }] }); },
  });
  const studio = await mountStudio(api);
  assert.match(studio.element.textContent, /The claims could not be read\. invalid JSON/);
  assert.match(studio.element.textContent, /Repair \.openblog\/private\/research\/claims\.json by hand/);
}));

// ---------------------------------------------------------------- wiring

test("the writing toolbar and Evidence Studio reach the claims, and claims code builds no markup from text", () => {
  assert.match(admin, /"data-claim-from-selection": "true"/);
  assert.match(admin, /if \(pane === "evidence"\) void this\.loadClaims\(\);/);
  assert.match(admin, /ui\.claimsRegion,/);
  const code = admin.slice(admin.indexOf("// ---------------------------------------------------------------- claims and evidence links"), admin.indexOf("export const SHARED_SOURCE_KINDS"));
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|createContextualFragment/);
  assert.match(code, /role: "alert"/);
  assert.match(code, /"aria-live": "polite"/);
  assert.match(code, /aria-invalid/);
  assert.match(code, /h\("legend"/);
  assert.doesNotMatch(code, /[\u202a-\u202e\u2066-\u2069]/u, "no literal direction-override characters in the source");
});

test("claims styles put supporting and contradicting side by side, keep focus visible and add no motion", () => {
  const css = styles.slice(styles.indexOf("/* Claims and evidence"), styles.indexOf("/* Anchors styled as buttons"));
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 40rem\)/);
  assert.doesNotMatch(css, /transition|animation/);
  // The region is inset from the pane border so focus rings are never clipped.
  assert.match(css, /\.oba-claims-region \{\s*padding-inline: [^;]+;/);
});
