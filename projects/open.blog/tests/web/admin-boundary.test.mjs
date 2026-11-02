import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BOUNDARY_REASONS,
  boundaryCountsText,
  boundaryItemHref,
  createBoundaryPreview,
} from "../../web/admin/admin.js";

// What will be public (A8.4, ADR 0125): one section per projection in the server's order, its
// switch, every item it publishes with the fields it copies and the fields it keeps private,
// every item it withholds with the reason in words and a link to where it is changed, what is
// never published, and failures scoped to the projection or file they belong to.

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

const HOSTILE = "<img src=x onerror=alert(1)>";

// A manifest exactly as `GET /admin/api/research/boundary` serializes it (see the Rust tests).
const MANIFEST = () => ({
  version: 1,
  scope: { kind: "site" },
  projections: [
    {
      projection: "citations", switch: "citations", enabled: true,
      published: [{ kind: "source", id: "slings", label: "Slings edition", posts: ["cave"], fields: ["kind", "title"],
        withheldFields: [{ field: "identifiers.url", reason: "unsafe-url", message: "Source `slings`: its web address is withheld because it names a private or local network address readers cannot reach." }] }],
      withheld: [],
    },
    { projection: "claim-evidence", switch: "claimEvidence.publish", enabled: false, published: [],
      withheld: [{ kind: "claim", id: "c2", posts: ["cave"], reason: "projection-off", message: "The site does not publish this; `claimEvidence.publish` is off, so nothing here reaches the public site." }] },
    {
      projection: "atlas", switch: "knowledgeAtlas.publish", enabled: true,
      published: [{ kind: "entry", id: "plato-person", label: HOSTILE, url: "/atlas/plato-person/", fields: ["kind", "label", "summary"] }],
      withheld: [
        { kind: "entry", id: "the-good", label: "The Good", reason: "not-approved", message: "Entry `the-good` is not approved, so it stays private." },
        { kind: "relationship", id: "politeia-discusses-good", reason: "private-dependency", message: "Relationship `politeia-discusses-good` joins entry `the-good`, which is not published, so it stays private until that entry is approved." },
      ],
    },
    { projection: "comparisons", switch: "comparisons.publish", enabled: true, blocked: "passage comparisons cannot be published (broken); run `openblog check`.", published: [], withheld: [] },
  ],
  never: [{ store: "notebook", file: ".openblog/private/research/notebook.json", count: 3, what: "Every note and question." }],
  unavailable: [{ store: "alignments", file: ".openblog/private/research/alignments.json", message: "not valid JSON" }],
  refused: null,
});

const sections = (root) => root.querySelectorAll("section").filter((section) => section.dataset.boundaryProjection);
const item = (root, key) => root.querySelectorAll("li").find((node) => node.dataset.boundaryItem === key);

test("each projection is listed in the server's order with its switch, published and withheld items", withDom(async () => {
  const root = createBoundaryPreview({ manifest: MANIFEST() });
  assert.deepEqual(sections(root).map((section) => section.dataset.boundaryProjection), ["citations", "claim-evidence", "atlas", "comparisons"]);
  const headings = sections(root).map((section) => section.querySelector("h2").textContent);
  assert.deepEqual(headings, ["Citations", "Claims and evidence", "Knowledge Atlas", "Comparisons"]);
  for (const section of sections(root)) {
    assert.equal(section.attributes["aria-labelledby"], section.querySelector("h2").id, "each section is named by its heading");
    assert.equal(section.querySelectorAll("h3").length, 2, "published and withheld each have a heading");
  }
  const switches = root.querySelectorAll("p").filter((node) => node.dataset.boundarySwitch).map((node) => node.dataset.boundarySwitch);
  assert.deepEqual(switches, ["on", "off", "on", "on"]);
  assert.match(sections(root)[1].textContent, /Off: claimEvidence\.publish is off in openblog\.json, so nothing from here is published\./);

  const slings = item(root, "source:slings");
  assert.equal(slings.dataset.boundaryState, "published");
  assert.equal(slings.querySelector(".oba-visibility").dataset.visibility, "publishable");
  assert.equal(slings.querySelector(".oba-visibility").textContent, "Published");
  assert.match(slings.textContent, /Publishes: kind, title\./);
  assert.match(slings.textContent, /With the post cave/);
  const field = slings.querySelectorAll("li").find((node) => node.dataset.boundaryField === "identifiers.url");
  assert.equal(field.dataset.boundaryReason, "unsafe-url");
  assert.match(field.textContent, /^Withheld identifiers\.url: A web address readers should not be given\. Source `slings`/);

  const plato = item(root, "entry:plato-person");
  assert.equal(plato.querySelector("bdi").textContent, HOSTILE, "a label is text");
  assert.equal(root.querySelectorAll("img").length + root.querySelectorAll("script").length, 0);
  assert.match(plato.textContent, /Public address: \/atlas\/plato-person\//);

  const good = item(root, "entry:the-good");
  assert.equal(good.dataset.boundaryState, "withheld");
  assert.equal(good.querySelector(".oba-visibility").dataset.visibility, "private");
  assert.match(good.textContent, /Not approved: private research\. Entry `the-good` is not approved, so it stays private\./);
  assert.equal(good.querySelector("a").attributes.href, "#/research/atlas/the-good");
  assert.equal(item(root, "relationship:politeia-discusses-good").querySelector("a").attributes.href, "#/research/atlas/relationships/politeia-discusses-good");
  assert.equal(item(root, "claim:c2").querySelector("a"), null, "a claim is changed in its post's Evidence Studio");

  assert.match(root.querySelector("[data-boundary-blocked]").textContent, /^Not previewed: passage comparisons cannot be published/);
  assert.match(root.querySelectorAll("p").find((node) => node.dataset.boundaryUnavailable === "alignments").textContent, /Alignments could not be read: not valid JSON Repair \.openblog\/private\/research\/alignments\.json by hand\. Nothing was changed\./);
  const never = root.querySelector("[data-boundary-never]");
  assert.match(never.textContent, /Research notebook \(3\): Every note and question\./);
  assert.equal(root.querySelector("[data-boundary-refused]"), null);
  assert.equal(boundaryCountsText(MANIFEST()), "2 published, 3 withheld.");
}));

test("a refused build and one post's preview say so, at the heading level they are placed at", withDom(async () => {
  const refused = createBoundaryPreview({ manifest: { ...MANIFEST(), refused: "refusing to build: `static/notes.json` looks like private research" } });
  assert.match(refused.querySelector("[data-boundary-refused]").textContent, /^The next build is refused: refusing to build/);
  const post = createBoundaryPreview({ manifest: { ...MANIFEST(), scope: { kind: "post", path: "posts/cave.md", slug: "cave" } }, level: 4, scope: "post", idPrefix: "p" });
  assert.equal(post.dataset.boundaryPreview, "post");
  assert.equal(post.querySelectorAll("h4").length, 5, "projections and never published at level 4");
  assert.equal(post.querySelectorAll("h5").length, 8);
  assert.match(post.querySelector("[data-boundary-intro]").textContent, /^What this post publishes of your research when it is published/);
  const empty = createBoundaryPreview({ manifest: { version: 1, scope: { kind: "site" }, projections: [], never: [] } });
  assert.equal(sections(empty).length, 0);
  assert.equal(boundaryCountsText({}), "0 published, 0 withheld.");
  // The atlas query file repeats what the atlas lists, so its items are not a second count of
  // published research (the server's `summary()` skips it the same way); its withheld file counts.
  assert.equal(
    boundaryCountsText({
      projections: [
        { projection: "atlas", published: [{ id: "a" }, { id: "b" }], withheld: [] },
        { projection: "atlas-query", published: [{ id: "a" }, { id: "b" }, { id: "src" }], withheld: [] },
      ],
    }),
    "2 published, 0 withheld.",
  );
  assert.equal(
    boundaryCountsText({
      projections: [
        { projection: "atlas", published: [{ id: "a" }], withheld: [] },
        { projection: "atlas-query", published: [], withheld: [{ kind: "atlas-query", id: "atlas-query" }] },
      ],
    }),
    "1 published, 1 withheld.",
  );
}));

test("a text match is a notice naming the output, the file, the record and the field, not a refusal", withDom(async () => {
  const warning = "boundary: `static/notes.txt` carries text from the research notebook (`.openblog/private/research/notebook.json`, `n1`, field `text`). Remove it there, or keep it.";
  const root = createBoundaryPreview({ manifest: { ...MANIFEST(), textMatches: [warning] } });
  const notice = root.querySelector("[data-boundary-text-match]");
  assert.equal(notice.textContent, warning);
  assert.equal(notice.className, "oba-notice");
  assert.equal(root.querySelector("[data-boundary-refused]"), null);
  assert.equal(createBoundaryPreview({ manifest: MANIFEST() }).querySelector("[data-boundary-text-match]"), null);
}));

test("every withheld item links to where it is changed, by its own address", () => {
  assert.equal(boundaryItemHref({ kind: "source", id: "a b" }), "#/research/sources/a%20b");
  assert.equal(boundaryItemHref({ kind: "entry", id: "plato" }), "#/research/atlas/plato");
  assert.equal(boundaryItemHref({ kind: "atlas-page", id: "plato" }), "#/research/atlas/plato");
  assert.equal(boundaryItemHref({ kind: "relationship", id: "r/1" }), "#/research/atlas/relationships/r%2F1");
  assert.equal(boundaryItemHref({ kind: "dating", id: "born" }), "#/research/atlas");
  assert.equal(boundaryItemHref({ kind: "dating", id: "born", owner: { kind: "entry", id: "plato person" } }), "#/research/atlas/plato%20person");
  assert.equal(boundaryItemHref({ kind: "dating", id: "born", owner: { kind: "relationship", id: "r/1" } }), "#/research/atlas/relationships/r%2F1");
  assert.equal(boundaryItemHref({ kind: "comparison", id: "cave" }), "#/research/compare/cave");
  assert.equal(boundaryItemHref({ kind: "comparison-page", id: "cave" }), "#/research/compare/cave");
  // A claim and an evidence link are changed in their post's Evidence Studio, once the post is located.
  const postPaths = new Map([["cave", "posts/2026-01-07-the cave.md"]]);
  assert.equal(boundaryItemHref({ kind: "claim", id: "c1", posts: ["cave"] }, { postPaths }), "#/edit/posts%2F2026-01-07-the%20cave.md?pane=evidence");
  assert.equal(boundaryItemHref({ kind: "evidence-link", id: "l1", posts: ["cave"] }, { postPaths }), "#/edit/posts%2F2026-01-07-the%20cave.md?pane=evidence");
  assert.equal(boundaryItemHref({ kind: "claim", id: "c1", posts: ["elsewhere"] }, { postPaths }), null, "an unknown post has no link");
  assert.equal(boundaryItemHref({ kind: "claim", id: "c1" }), null);
  assert.equal(boundaryItemHref({ kind: "evidence-link", id: "l1", posts: ["cave"] }), null);
  for (const reason of ["projection-off", "not-approved", "unsourced", "notebook-passage", "private-dependency", "contradiction-withheld", "post-not-published", "stale-approval", "unsafe-url", "private-identifier", "rights", "length", "stale-anchor", "page-not-published", "withdrawn", "stale-selection", "missing-target", "selection-cycle", "over-limit", "inconsistent"]) {
    assert.ok(BOUNDARY_REASONS[reason], `${reason} has words`);
    assert.doesNotMatch(BOUNDARY_REASONS[reason], /score|verdict|false|true|wrong/i, "no reason judges the research");
  }
});

test("the preview builds DOM safely, adds no motion, reflows, and is reachable from the workspace and Evidence Studio", () => {
  const start = admin.indexOf("// ---------------------------------------------------------------- what will be public");
  const end = admin.indexOf("export function evidenceStudioState(");
  const source = admin.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|localStorage|sessionStorage|indexedDB/);
  assert.match(admin, /Object\.freeze\(\{ id: "public", label: "What will be public"/);
  assert.match(admin, /else if \(panel === "public"\) await this\.showPublicPreview\(\);/);
  assert.match(admin, /this\.api\.call\("GET", "research\/boundary"\)/);
  assert.match(admin, /this\.app\.api\.call\("POST", "research\/boundary"/);
  assert.match(admin, /"data-boundary-post-open": "true"/);
  assert.match(admin, /\{ label: "What will be public", category: "Research"/);
  const css = styles.slice(styles.indexOf("/* What will be public (ADR 0125)"));
  assert.doesNotMatch(css, /transition|animation/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /min-width: 0/);
});

test("a withheld claim links to its post's Evidence Studio and a withheld dating to the item it dates", withDom(async () => {
  const manifest = {
    version: 1,
    scope: { kind: "site" },
    projections: [
      { projection: "claim-evidence", switch: "claimEvidence.publish", enabled: true, published: [], withheld: [{ kind: "claim", id: "c2", posts: ["cave"], reason: "not-approved", message: "Claim `c2` is not approved." }, { kind: "evidence-link", id: "l2", posts: ["cave"], reason: "not-approved", message: "Link `l2` is not approved." }] },
      { projection: "datings", switch: "knowledgeAtlas.publish", enabled: true, published: [], withheld: [{ kind: "dating", id: "died", owner: { kind: "entry", id: "plato-person" }, reason: "not-approved", message: "Dating `died` of `plato-person` is not approved." }] },
    ],
    never: [],
  };
  const root = createBoundaryPreview({ manifest, postPaths: new Map([["cave", "posts/cave.md"]]) });
  const open = (key) => item(root, key).querySelectorAll("a").find((link) => link.dataset.boundaryOpen === key);
  assert.equal(open("claim:c2").attributes.href, "#/edit/posts%2Fcave.md?pane=evidence");
  assert.equal(open("evidence-link:l2").attributes.href, "#/edit/posts%2Fcave.md?pane=evidence");
  assert.equal(open("dating:died").attributes.href, "#/research/atlas/plato-person");
  const unlocated = createBoundaryPreview({ manifest });
  assert.equal(item(unlocated, "claim:c2").querySelectorAll("a").length, 0, "no link where the post is not known");
}));

test("the site preview sits under the panel's h2 and the post preview's button controls and reports its region", () => {
  const panel = admin.slice(admin.indexOf("async showPublicPreview()"), admin.indexOf("// ---- what will be public (#63, ADR 0125)") + 4000);
  assert.match(admin, /level: 3, scope: "site", postPaths/, "projections are h3 under the panel's h2");
  assert.match(panel, /h\("h2", \{ id: "oba-boundary-heading" \}/);
  assert.match(admin, /"data-boundary-post-open": "true", "aria-controls": "oba-boundary-post", "aria-expanded": "false"/);
  assert.match(admin, /\{ id: "oba-boundary-post", class: "oba-boundary-post"/, "the button controls the region, not its heading");
  assert.match(admin, /setAttribute\("aria-expanded", "true"\)/);
  // A read of the post goes stale as soon as the draft is edited again.
  assert.match(admin, /markBoundaryStale\(\) \{\s+if \(!this\.boundaryRead \|\| this\.boundaryStale/);
  assert.match(admin, /markDirty\(\) \{\s+if \(!this\.ui\?\.saveState\) return;\s+this\.markBoundaryStale\(\);/);
  assert.match(admin, /data-boundary-post-stale/);
});
