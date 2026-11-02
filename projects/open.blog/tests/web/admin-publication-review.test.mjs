import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  Editor,
  PUBLICATION_REVIEW_GROUPS,
  createPublicationReview,
  publicationReviewAcknowledgementText,
  publicationReviewCountsText,
  publicationReviewPlace,
  publicationReviewRelatedTarget,
  publicationReviewTarget,
  researchReviewApplies,
} from "../../web/admin/admin.js";

// The research review before publication (A8.3, ADR 0123 and ADR 0124): grouped by what blocks
// the build and by outcome in the server's order and codes, every finding linked to its place
// and repair, acknowledgement only where the contract allows it and never called resolved,
// failures scoped to the finding that failed, and no score anywhere.

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

DomNode.prototype.click = function click() {
  return this.disabled ? Promise.resolve() : this.dispatch("click");
};

// A review exactly as `POST /admin/api/research/review` serializes it (see the Rust tests).
const REVIEW = () => ({
  version: 1,
  applies: true,
  post: "posts/cave.md",
  firstBodyLine: 8,
  findings: [
    { validator: "atlas", check: "atlas-integrity", code: "file-unreadable", category: "integrity", outcome: "detected", gate: "refuses", scope: { object: "atlas" }, message: "cannot read <img src=x onerror=alert(1)>", repair: "Fix the named record or field; the file is left unchanged until you do.", fingerprint: "77a7d3481ffc4ddc94f4bf1cf3337fe5" },
    { validator: "publication-context", check: "context-link", code: "context-link-unpublished", category: "public-boundary", outcome: "detected", gate: "advisory", scope: { object: "post", path: "posts/cave.md", line: 12 }, related: [{ kind: "entry", id: "the-good" }], message: "The link to /atlas/the-good/ names a page the next build does not publish: the atlas entry `the-good` is not approved.", repair: "Approve the atlas entry if it is ready to be public, or remove the link.", fingerprint: "0123456789abcdef0123456789abcdef" },
    { validator: "citation-review", check: "citation-resolution", code: "citation-unresolved", category: "reference", outcome: "detected", gate: "refuses-when-published", scope: { object: "post", path: "posts/cave.md", line: 14 }, message: "`nobody` is not in the library.", repair: "Fix the citation or add its source to the library.", fingerprint: "8408ef31a285b52fac97121f8fe1d81f" },
    { validator: "claim-review", check: "evidence-relation", code: "claim-evidence-missing", category: "evidence", outcome: "potential", gate: "advisory", scope: { object: "claim", id: "c1", path: "posts/cave.md", field: "claims[c1]" }, message: "The claim has no evidence link.", repair: "Link evidence.", fingerprint: "2644c97cec4452539895e6c76c474a61", acknowledgement: "stale" },
    { validator: "claim-review", check: "evidence-location", code: "claim-locator-missing", category: "locator", outcome: "potential", gate: "advisory", scope: { object: "evidence-link", id: "l1", path: "posts/cave.md" }, related: [{ kind: "claim", id: "c1" }], message: "The link gives no location.", repair: "Add a locator.", fingerprint: "bf8b645d02a756974b6974272f48ef92" },
    { validator: "citation-review", check: "location-review", code: "citation-location-review", category: "locator", outcome: "needs-review", gate: "advisory", scope: { object: "post", path: "posts/cave.md", line: 10 }, message: "1 located citation.", repair: "Compare the location with the source itself and record it.", fingerprint: "0fcdc3e673e71ef97ae4f405edaa8656", acknowledgement: "current" },
  ],
  groups: [
    { name: "blocking", findings: [0, 2] },
    { name: "detected", findings: [1] },
    { name: "potential", findings: [3, 4] },
    { name: "needs-review", findings: [5] },
  ],
  counts: { detected: { found: 3, acknowledged: 0 }, potential: { found: 2, acknowledged: 0 }, needsReview: { found: 1, acknowledged: 1 } },
  unmatchedAcknowledgements: 0,
  notReviewed: [],
  acknowledgements: { file: ".openblog/private/research/acknowledgements.json", revision: "rev-1", error: null },
});

const api = (handler) => {
  const calls = [];
  return {
    calls,
    async call(method, path, options = {}) {
      calls.push({ method, path, body: structuredClone(options.json) });
      return handler(method, path, options.json);
    },
  };
};

const mount = (review, mode = "publish", handler = () => ({ revision: "rev-2" })) => {
  const done = [];
  const client = api(handler);
  const view = createPublicationReview({ review, mode, api: client, onDone: (result) => done.push(result) });
  globalThis.document.body.append(view.element);
  return { view, root: view.element, done, client };
};

const groupsOf = (root) => root.querySelectorAll("[data-review-group]").map((section) => section.dataset.reviewGroup);
const codesIn = (section) => section.querySelectorAll("[data-review-finding]").map((article) => article.dataset.reviewFinding);
const article = (root, code) => root.querySelectorAll("[data-review-finding]").find((node) => node.dataset.reviewFinding === code);
const toggleOf = (node) => node.querySelectorAll("button").find((button) => button.dataset.reviewAcknowledge);

test("the review applies to research and cited posts only, as Evidence Studio does", () => {
  assert.equal(researchReviewApplies({ title: "A" }, "research"), true);
  assert.equal(researchReviewApplies({ citations: "notes" }, "article"), true);
  assert.equal(researchReviewApplies({ profile: "Research" }), true);
  assert.equal(researchReviewApplies({ title: "Plain" }, "article"), false);
  assert.equal(researchReviewApplies({ citations: "  " }, ""), false);

  const editor = (status, initial, profile = "research") => ({ kind: "posts", currentStatus: () => status, initialStatus: () => initial, ui: { profile: { value: profile } } });
  const needs = (...args) => Editor.prototype.needsPublicationReview.call(editor(...args), {});
  assert.equal(needs("published", "draft"), true, "publishing a draft is reviewed");
  assert.equal(needs("scheduled", "draft"), true, "scheduling is reviewed");
  assert.equal(needs("published", "scheduled"), true, "publishing a scheduled post now is reviewed");
  assert.equal(needs("published", "published"), false, "saving a published post again is not");
  assert.equal(needs("draft", "draft"), false, "saving a draft is not");
  assert.equal(needs("published", "draft", "article"), false, "other posts publish as before");
  assert.equal(Editor.prototype.needsPublicationReview.call({ kind: "pages" }, {}), false);
});

test("groups and findings appear in the server's order and codes, each with its place and repair", withDom(async () => {
  const review = REVIEW();
  const { root } = mount(review);
  assert.deepEqual(groupsOf(root), review.groups.map((group) => group.name), "the server's grouping, unchanged");
  for (const section of root.querySelectorAll("[data-review-group]")) {
    const group = review.groups.find((item) => item.name === section.dataset.reviewGroup);
    assert.deepEqual(codesIn(section), group.findings.map((index) => review.findings[index].code));
    assert.match(section.querySelector("h3").textContent, new RegExp(`^${PUBLICATION_REVIEW_GROUPS[group.name].label} \\(${group.findings.length}\\)$`));
  }
  const context = article(root, "context-link-unpublished");
  assert.match(context.textContent, /line 5 of the draft/, "a source line is shown as the editor's line");
  assert.match(context.textContent, /Next: Approve the atlas entry/);
  const targets = context.querySelectorAll("[data-review-target]");
  assert.equal(targets[0].textContent, "Go to line 5 of the draft");
  assert.equal(targets[1].getAttribute("href"), "#/research/atlas/the-good", "the linked page's object opens in its panel");
  // Untrusted text is text.
  assert.match(article(root, "file-unreadable").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(root.querySelectorAll("img").length, 0);
  // No score: each outcome counted apart.
  const status = root.querySelector("[data-review-status]");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.textContent, "2 must be fixed before publishing. Detected: 3. Potential: 2. Needs review: 1 (1 acknowledged).");
  assert.doesNotMatch(root.textContent, /score|\d+%|\bpassed\b|\bverified\b|ready to publish/i);
}));

test("a finding that withholds says it stays out until the place is checked and approved again, not that the build refuses it", withDom(async () => {
  const review = REVIEW();
  review.findings.push({ validator: "comparison-approval", check: "stale-approval", code: "stale-approval", category: "public-boundary", outcome: "detected", gate: "withholds", scope: { object: "alignment", id: "cave-places" }, message: "The approval of `cave-places` is out of date.", repair: "Check the place, then approve it again in Compare.", fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  review.groups.find((group) => group.name === "detected").findings.push(review.findings.length - 1);
  const { root } = mount(review);
  const finding = article(root, "stale-approval");
  assert.equal(toggleOf(finding), undefined, "it has no acknowledge control");
  assert.match(finding.textContent, /acknowledging would not publish it/);
  assert.match(finding.textContent, /stays out of the next build until you check the place and approve it again/);
  assert.doesNotMatch(finding.textContent, /the build refuses/);
}));

test("only findings the build refuses block, and they cannot be acknowledged", withDom(async () => {
  const { root, view, done } = mount(REVIEW());
  assert.equal(view.confirm.disabled, true);
  assert.equal(view.confirm.getAttribute("aria-describedby"), "oba-review-blocked");
  assert.equal(root.querySelector("[data-review-blocked]").hidden, false);
  for (const code of ["file-unreadable", "citation-unresolved"]) {
    assert.equal(toggleOf(article(root, code)), undefined, `${code} has no acknowledge control`);
    assert.match(article(root, code).textContent, /cannot be acknowledged/);
  }
  for (const code of ["context-link-unpublished", "claim-evidence-missing", "claim-locator-missing", "citation-location-review"]) {
    assert.ok(toggleOf(article(root, code)), `${code} can be acknowledged`);
  }
  await view.cancel.click();
  assert.deepEqual(done, ["cancel"]);

  const advisoryOnly = REVIEW();
  advisoryOnly.groups = advisoryOnly.groups.filter((group) => group.name !== "blocking");
  const open = mount(advisoryOnly, "schedule");
  assert.equal(open.view.confirm.disabled, false, "advisory findings never stop publishing");
  assert.equal(open.view.confirm.textContent, "Schedule");
  assert.equal(open.root.querySelector("[data-review-blocked]").hidden, true);
  await open.view.confirm.click();
  assert.deepEqual(open.done, ["confirm"]);

  const check = mount(REVIEW(), "check");
  assert.equal(check.view.confirm, null, "a review on request publishes nothing");
  assert.equal(check.view.cancel.textContent, "Close");
}));

test("acknowledging keeps a finding listed and counted, and withdrawing restores it", withDom(async () => {
  const review = REVIEW();
  const { root, client } = mount(review);
  const context = article(root, "context-link-unpublished");
  const toggle = toggleOf(context);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(toggle.textContent, "Acknowledge", "the name stays the same; the pressed state changes");
  assert.match(toggle.getAttribute("aria-label"), /^Acknowledge context-link-unpublished, line 5 of the draft$/);
  await toggle.click();
  assert.deepEqual(client.calls[0], {
    method: "PUT",
    path: "research/review/acknowledgements",
    body: { revision: "rev-1", acknowledgement: { validator: "publication-context", code: "context-link-unpublished", object: "post", path: "posts/cave.md", fingerprint: "0123456789abcdef0123456789abcdef" } },
  });
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.ok(article(root, "context-link-unpublished"), "still listed");
  assert.match(context.querySelector("[data-review-acknowledgement]").textContent, /stays listed and counted/);
  assert.match(root.querySelector("[data-review-status]").textContent, /not resolved\. .*Detected: 3 \(1 acknowledged\)/);
  assert.deepEqual(root.textContent.match(/\w+ resolved/gi), ["not resolved"], "the word appears only to say it is not");

  await toggle.click();
  assert.equal(client.calls[1].method, "DELETE");
  assert.equal(client.calls[1].body.revision, "rev-2", "the next change names the revision the last one produced");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(context.querySelector("[data-review-acknowledgement]").hidden, true);
  assert.match(root.querySelector("[data-review-status]").textContent, /^Acknowledgement withdrawn\. .*Detected: 3\./);

  // A stale acknowledgement says the finding changed, and is not pressed.
  const stale = article(root, "claim-evidence-missing");
  assert.equal(toggleOf(stale).getAttribute("aria-pressed"), "false");
  assert.equal(stale.querySelector("[data-review-acknowledgement]").textContent, publicationReviewAcknowledgementText("stale"));
  assert.equal(toggleOf(article(root, "citation-location-review")).getAttribute("aria-pressed"), "true");
}));

test("a refused acknowledgement is reported on its finding alone and changes nothing", withDom(async () => {
  const { root, client } = mount(REVIEW(), "publish", (method) => {
    if (method === "PUT") throw new ApiError("conflict", 409, { error: "The acknowledgements changed since this review was read.", revision: "rev-9" });
    return { revision: "rev-10" };
  });
  const context = article(root, "context-link-unpublished");
  await toggleOf(context).click();
  const error = context.querySelector("[data-review-error]");
  assert.equal(error.hidden, false);
  assert.equal(error.getAttribute("role"), "alert");
  assert.match(error.textContent, /^Not saved: The acknowledgements changed since this review was read\. Nothing was changed\.$/);
  assert.equal(toggleOf(context).getAttribute("aria-pressed"), "false");
  assert.equal(article(root, "claim-locator-missing").querySelector("[data-review-error]").hidden, true, "other findings are untouched");
  await toggleOf(article(root, "claim-locator-missing")).click();
  assert.equal(client.calls.at(-1).body.revision, "rev-9", "the conflict's revision is used next");
}));

test("every finding links to its exact object and repair", () => {
  const context = { post: "posts/cave.md", firstBodyLine: 8 };
  const target = (scope, related = []) => publicationReviewTarget({ scope, related }, context);
  assert.deepEqual(target({ object: "post", path: "posts/cave.md", line: 9 }), { kind: "line", line: 2, label: "Go to line 2 of the draft" });
  assert.deepEqual(target({ object: "post", path: "posts/cave.md", field: "doi" }), { kind: "field", field: "doi", label: "Go to the doi field" });
  assert.equal(target({ object: "post", path: "posts/other.md", line: 3 }), null, "another post is not this draft");
  assert.deepEqual(target({ object: "claim", id: "c1" }), { kind: "claim", claim: "c1", link: "", label: "Open the claim c1 in Evidence Studio" });
  assert.deepEqual(target({ object: "evidence-link", id: "l1" }, [{ kind: "claim", id: "c1" }]), { kind: "claim", claim: "c1", link: "l1", label: "Open the evidence link l1 in Evidence Studio" });
  assert.equal(target({ object: "source", id: "slings" }).href, "#/research/sources/slings");
  assert.equal(target({ object: "entry", id: "plato" }).href, "#/research/atlas/plato");
  assert.equal(target({ object: "alignment", id: "cave-places", field: "members[1]" }).href, "#/research/compare/cave-places");
  assert.equal(target({ object: "relationship", id: "plato-taught-aristotle" }).href, "#/research/atlas/relationships/plato-taught-aristotle", "a relationship opens focused, not the generic atlas");
  assert.equal(target({ object: "relationship", id: "plato-taught-aristotle" }).label, "Open the atlas relationship plato-taught-aristotle in the Knowledge Atlas");
  assert.equal(target({ object: "relationship", id: "a b/c" }).href, "#/research/atlas/relationships/a%20b%2Fc");
  assert.equal(target({ object: "passage", id: "p1" }).href, "#/research/notebook");
  assert.equal(target({ object: "source-library" }).href, "#/research/sources");
  assert.equal(target({ object: "alignments-file" }).href, "#/research/compare");
  assert.equal(target({ object: "entry", id: "a b/../x" }).href, "#/research/atlas/a%20b%2F..%2Fx", "an id is one encoded segment");
  assert.equal(publicationReviewPlace({ scope: { object: "alignment", id: "cave", field: "members[1]" } }), "comparison cave, members[1]");
  assert.equal(publicationReviewPlace({ scope: { object: "selections-file" } }), "the curated selections file");
  assert.equal(target({ object: "selections-file" }), null, "the curated selections are repaired by hand, so there is nowhere to go");
  assert.equal(publicationReviewRelatedTarget({ check: "context-link", related: [{ kind: "alignment", id: "cave" }] }).href, "#/research/compare/cave");
  assert.equal(publicationReviewRelatedTarget({ check: "claim-anchoring", related: [{ kind: "claim", id: "c" }] }), null);
  assert.equal(publicationReviewCountsText({ counts: {}, groups: [] }), "Detected: 0. Potential: 0. Needs review: 0.");
});

test("parts that were not reviewed, unreadable acknowledgements and posts outside the review say so", withDom(async () => {
  const review = REVIEW();
  review.notReviewed = [{ part: "claims", message: "This post's claims were not reviewed because the claims file cannot be read." }];
  review.acknowledgements = { file: ".openblog/private/research/acknowledgements.json", revision: null, error: "the file is not valid UTF-8" };
  const { root } = mount(review);
  assert.match(root.querySelector("[data-review-not-reviewed]").textContent, /^Not reviewed: This post's claims/);
  assert.match(root.querySelector("[data-review-acknowledgements-error]").textContent, /Repair \.openblog\/private\/research\/acknowledgements\.json by hand\./);
  assert.ok(root.querySelectorAll("button").filter((button) => button.dataset.reviewAcknowledge).every((button) => button.disabled), "nothing is saved while the file is unreadable");

  const outside = mount({ version: 1, applies: false, findings: [], groups: [], counts: {}, notReviewed: [], acknowledgements: {} }, "check");
  assert.ok(outside.root.querySelector("[data-review-not-applicable]"));
  const empty = mount({ ...REVIEW(), findings: [], groups: [], counts: {} }, "publish");
  assert.match(empty.root.querySelector("[data-review-empty]").textContent, /not a judgement of the post/);
  assert.equal(empty.view.confirm.disabled, false);
}));

test("the review is labelled, keyboard operable, builds DOM safely and adds no motion", () => {
  const start = admin.indexOf("// ---------------------------------------------------------------- research review before publication");
  const end = admin.indexOf("export function evidenceStudioState(");
  const source = admin.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|localStorage|sessionStorage|indexedDB/);
  assert.match(admin, /"oba-dialog oba-review-dialog", "aria-labelledby": "oba-review-title", "aria-describedby": "oba-review-intro"/);
  assert.match(admin, /dialog\.addEventListener\("cancel"/, "Escape keeps editing");
  assert.match(admin, /view\.heading\.focus\(\)/, "focus starts on the review's heading");
  const css = styles.slice(styles.indexOf("/* Research review before publication"));
  assert.doesNotMatch(css, /transition|animation/);
  assert.match(css, /overflow-wrap: anywhere/);
});

// ---------------------------------------------------------------- the readiness report (#194, ADR 0150)

const READINESS = () => ({
  ...structuredClone(JSON.parse(readFileSync(new URL("../fixtures/research-readiness/report.json", import.meta.url), "utf8"))),
  applies: true,
  notReviewed: [],
  acknowledgements: { file: ".openblog/private/research/acknowledgements.json", revision: "rev-1", error: null },
});

const mountSite = (review, handler = () => ({ revision: "rev-2" })) => {
  const done = [];
  const client = api(handler);
  const view = createPublicationReview({ review, mode: "check", api: client, onDone: (result) => done.push(result), embedded: true, site: true, headingLevel: 3, idPrefix: "oba-readiness-site" });
  globalThis.document.body.append(view.element);
  return { view, root: view.element, done, client };
};

test("the site report inside What will be public lists the shared groups and codes, with no dialog actions", withDom(async () => {
  const review = READINESS();
  const { root, view } = mountSite(review);
  assert.equal(root.dataset.publicationReview, "site");
  assert.equal(view.heading.tagName, "H3", "it sits under the panel's heading");
  assert.equal(view.heading.textContent, "Research checks");
  assert.deepEqual(groupsOf(root), review.groups.map((group) => group.name));
  for (const section of root.querySelectorAll("[data-review-group]")) {
    const group = review.groups.find((item) => item.name === section.dataset.reviewGroup);
    assert.deepEqual(codesIn(section), group.findings.map((index) => review.findings[index].code));
    assert.equal(section.children[0].tagName, "H4", "groups sit one level under it");
  }
  assert.equal(root.querySelector("[data-review-confirm]"), null);
  assert.equal(root.querySelector("[data-review-cancel]"), null);
  assert.match(root.querySelector("[data-review-group]").textContent, /The next build would refuse these/);
  assert.equal(root.querySelector("[data-review-status]").textContent, publicationReviewCountsText(review));
  // Places and repairs are the site's: the post and its line, opened in the editor.
  const unresolved = article(root, "citation-unresolved");
  assert.match(unresolved.textContent, /posts\/cave\.md:12:1/);
  assert.equal(unresolved.querySelector("[data-review-target]").getAttribute("href"), "#/edit/posts%2Fcave.md");
  assert.match(unresolved.textContent, /once its post is published/, "a draft only warns, and the finding says so");
  assert.equal(toggleOf(unresolved), undefined, "a refusal is fixed, not acknowledged");
  assert.doesNotMatch(root.textContent, /score|\d+%|\bpassed\b|\bverified\b|ready to publish/i);
}));

test("acknowledging in the site report keeps the finding listed and counted, never resolved", withDom(async () => {
  const review = READINESS();
  const { root, client } = mountSite(review);
  const finding = article(root, "abstract-missing");
  const toggle = toggleOf(finding);
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "a stale acknowledgement is not a current one");
  await toggle.click();
  await tick();
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, "research/review/acknowledgements");
  assert.equal(client.calls[0].body.revision, "rev-1");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.ok(article(root, "abstract-missing"), "it is still listed");
  assert.match(root.querySelector("[data-review-status]").textContent, /it is not resolved/);
  assert.match(root.querySelector("[data-review-status]").textContent, /Detected: 4 \(1 acknowledged\)/);
  assert.doesNotMatch(finding.textContent, /Resolved/);
}));

test("the site panel and the draft panel reuse the one review renderer and add no parallel one", () => {
  const panel = admin.slice(admin.indexOf("async showPublicPreview()"), admin.indexOf("needsPublicationReview(fields)"));
  assert.match(panel, /"research\/readiness"/);
  assert.match(panel, /createPublicationReview\(\{[\s\S]*embedded: true,[\s\S]*site: true/);
  const post = admin.slice(admin.indexOf("async previewBoundary()"), admin.indexOf("async reviewResearch("));
  assert.match(post, /"research\/review"[\s\S]*createPublicationReview\(\{[\s\S]*embedded: true/);
  assert.match(admin, /onChecks: this\.kind === "posts" \? \(\) => this\.readResearchChecks\(\) : null,\s+onReview: \(\) => void this\.reviewResearch\("check"\)/);
  assert.equal((admin.match(/export function createPublicationReview/g) || []).length, 1);
  const css = styles.slice(styles.indexOf("/* Research review before publication"));
  assert.match(css, /\.oba-review\.is-embedded/);
  assert.doesNotMatch(css.slice(css.indexOf(".oba-review.is-embedded")), /transition|animation/);
});

test("the site report's empty state speaks of the site, never calls the research ready and shows no dialog actions", withDom(async () => {
  const { root } = mountSite({ ...READINESS(), findings: [], groups: [], counts: {}, notReviewed: [] });
  const empty = root.querySelector("[data-review-empty]");
  assert.match(empty.textContent, /raised nothing for the site/);
  assert.match(empty.textContent, /not a judgement of your research/);
  assert.doesNotMatch(empty.textContent, /\b(ready|passed|resolved|score)\b/i);
  assert.equal(root.querySelector("[data-review-confirm]"), null);
  assert.equal(root.querySelector("[data-review-status]").textContent, "Detected: 0. Potential: 0. Needs review: 0.");
  assert.equal(root.querySelector("[data-review-blocked]"), null, "an embedded report has no dialog actions");
}));

test("an embedded report adds no second live region and hands what it says to its panel's status line", withDom(async () => {
  const spoken = [];
  const client = api(() => ({ revision: "rev-2" }));
  const view = createPublicationReview({ review: READINESS(), mode: "check", api: client, embedded: true, site: true, headingLevel: 3, idPrefix: "oba-readiness-site", announce: (text) => spoken.push(text) });
  globalThis.document.body.append(view.element);
  const live = view.element.querySelectorAll("*").filter((node) => node.getAttribute("aria-live") || node.getAttribute("role") === "status");
  assert.equal(live.length, 0, "the panel's own status line is the one polite region");
  assert.equal(view.status.textContent, publicationReviewCountsText(READINESS()));
  assert.deepEqual(spoken, [], "nothing is announced on load");
  const toggle = toggleOf(article(view.element, "abstract-missing"));
  await toggle.click();
  await tick();
  assert.match(spoken.at(-1), /it is not resolved/);
}));
