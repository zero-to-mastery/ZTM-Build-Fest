// DOM-contract tests for <ob-passage-feedback> (#82, ADR 0082): labelled,
// keyboard-operable controls; selections mapped onto the build's passage text
// and kept when the selection is lost; selections it cannot quote explained,
// never guessed; announced errors with focus on the field; an explicit
// pending state; success; offline, refused and failing services falling back
// to a copy of the note; the contact link; hostile data; no storage; and an
// article that is never changed.
import test from "node:test";
import assert from "node:assert/strict";

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class Target {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, signal: options.signal });
  }
  live(type) {
    return (this.listeners.get(type) || []).filter((entry) => !entry.signal?.aborted);
  }
  fire(event) {
    for (const { fn } of this.live(event.type)) fn(event);
  }
}

const FOCUSABLE = new Set(["a", "button", "input", "select", "textarea"]);
const reflect = (name) => ({
  get() { return this.getAttribute(name) ?? ""; },
  set(value) { this.setAttribute(name, value); },
});
const flag = (name) => ({
  get() { return this.attributes.has(name); },
  set(value) { if (value) this.setAttribute(name, ""); else this.removeAttribute(name); },
});

/**
 * A small element that mirrors the browser where the component could trip:
 * reflected attributes (`hidden`, `title`, `popover`, `id`, `htmlFor`, ...),
 * radio groups, a select's value, focus refused by disabled controls, and no
 * `innerHTML` at all.
 */
class Element extends Target {
  constructor(tag = "span") {
    super();
    this.localName = tag;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.text = "";
    this.rect = { left: 0, top: 0, width: 120, height: 30 };
    this.style = { props: {}, setProperty(name, value) { this.props[name] = value; } };
    this.ownValue = undefined;
    this.ownChecked = false;
    this.selected = false;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  get type() {
    return this.getAttribute("type") ?? (this.localName === "button" ? "submit" : this.localName === "input" ? "text" : "");
  }
  set type(value) { this.setAttribute("type", value); }
  get popover() { return this.getAttribute("popover"); }
  set popover(value) { if (value === null) this.removeAttribute("popover"); else this.setAttribute("popover", value); }
  get tabIndex() {
    const value = this.getAttribute("tabindex");
    return value === null ? (FOCUSABLE.has(this.localName) ? 0 : -1) : Number(value);
  }
  set tabIndex(value) { this.setAttribute("tabindex", value); }
  get rows() { return Number(this.getAttribute("rows") ?? 2); }
  set rows(value) { this.setAttribute("rows", value); }
  get spellcheck() { return this.getAttribute("spellcheck") !== "false"; }
  set spellcheck(value) { this.setAttribute("spellcheck", value ? "true" : "false"); }
  get checked() { return this.ownChecked; }
  set checked(value) {
    this.ownChecked = Boolean(value);
    if (value && this.type === "radio" && document?.body) {
      for (const other of document.body.all()) {
        if (other !== this && other.type === "radio" && other.name === this.name) other.ownChecked = false;
      }
    }
  }
  get options() { return this.children.filter((child) => child.localName === "option"); }
  get value() {
    if (this.localName === "select") {
      const options = this.options;
      return (options.find((option) => option.selected) ?? options[0])?.value ?? "";
    }
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    return this.ownValue ?? this.getAttribute("value") ?? "";
  }
  set value(value) {
    if (this.localName === "select") {
      for (const option of this.options) option.selected = option.value === String(value);
    } else if (this.localName === "option") {
      this.setAttribute("value", value);
    } else {
      this.ownValue = String(value);
    }
  }
  set innerHTML(_value) {
    throw new Error("innerHTML is never used");
  }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.text = String(value);
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? textNode(node) : node;
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) {
    this.textContent = "";
    this.append(...nodes);
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  closest(tag) {
    for (let current = this; current; current = current.parentElement) if (current.localName === tag) return current;
    return null;
  }
  all() {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  matches(selector) {
    return selector.split(",").map((part) => part.trim()).some((part) =>
      part.startsWith(".") ? this.className.split(/\s+/).includes(part.slice(1)) : this.localName === part);
  }
  querySelectorAll(selector) {
    return this.all().slice(1).filter((node) => node.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  compareDocumentPosition(other) {
    const order = document.body.all();
    const here = order.indexOf(this);
    const there = order.indexOf(other);
    if (there > here) return 4 | (this.contains(other) ? 16 : 0);
    return 2;
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  focus() {
    if (this.disabled || (this.tabIndex < 0 && !this.hasAttribute("tabindex") && !FOCUSABLE.has(this.localName))) return;
    document.activeElement = this;
  }
  select() {
    this.selected = true;
  }
  scrollIntoView() {
    this.scrolled = true;
  }
  dispatch(type, init = {}) {
    const event = new FakeEvent(type, { ...init, target: this });
    for (let node = this; node; node = node.parentElement) node.fire(event);
    return event;
  }
  find(className) {
    return this.all().find((node) => node.className.split(/\s+/).includes(className)) || null;
  }
}
for (const name of ["id", "title", "name", "rel", "href", "autocomplete", "lang", "dir", "role"]) {
  Object.defineProperty(Element.prototype, name, reflect(name));
}
Object.defineProperty(Element.prototype, "className", reflect("class"));
Object.defineProperty(Element.prototype, "htmlFor", reflect("for"));
for (const [property, attribute] of [["hidden", "hidden"], ["disabled", "disabled"], ["required", "required"], ["readOnly", "readonly"], ["noValidate", "novalidate"]]) {
  Object.defineProperty(Element.prototype, property, flag(attribute));
}

function textNode(text) {
  const node = new Element("#text");
  node.text = text;
  return node;
}

/** A range over the fake tree: text from a start point to an end point, in document order. */
class FakeRange {
  setStartBefore(node) { this.start = { node, before: true }; }
  setStart(node, offset) { this.start = { node, offset }; }
  setEnd(node, offset) { this.end = { node, offset }; }
  toString() {
    const order = document.body.all();
    const from = order.indexOf(this.start.node);
    const to = order.indexOf(this.end.node);
    let out = "";
    for (let index = from; index <= to; index += 1) {
      const node = order[index];
      if (node.localName !== "#text") continue;
      out += node === this.end.node ? node.text.slice(0, this.end.offset) : node.text;
    }
    return out;
  }
}

class FakeDocument extends Target {
  constructor() {
    super();
    this.body = new Element("body");
    this.activeElement = this.body;
    this.documentElement = { clientWidth: 320, clientHeight: 640 };
    this.selection = { rangeCount: 0, isCollapsed: true, toString: () => "" };
    this.ranges = true;
  }
  createElement(tag) { return new Element(tag); }
  getElementById(id) { return this.body.all().find((node) => node.id === id) || null; }
  getSelection() { return this.selection; }
  get createRange() { return this.ranges ? () => new FakeRange() : undefined; }
}

let Feedback;
globalThis.HTMLElement = Element;
globalThis.customElements = { get: () => undefined, define: (_name, constructor) => (Feedback = constructor) };
globalThis.window = new Target();
for (const name of ["localStorage", "sessionStorage", "indexedDB"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`no ${name}`);
    },
  });
}
const { locateSelection, offeredKinds, quoteFromSelection, readPassages, safeContact } = await import("../../web/components/ob-passage-feedback.js");
const { feedbackCopyText, readEvidenceSubmissionJson, readFeedbackSubmissionJson } = await import("../../web/components/passage-feedback.js");
const { readEvidenceChoices } = await import("../../web/components/ob-passage-feedback.js");

const HOSTILE = "<img src=x onerror=alert(1)> & </script>";
const REVISION = "p1:0123456789abcdef0123456789abcdef";
const digest = (n) => String(n).repeat(32).slice(0, 32);
const DATA = {
  version: 1,
  work: "/tides/",
  revision: REVISION,
  sections: [
    { index: 0, text: "The moon causes the tides. The sun matters too.", digest: digest(1) },
    { index: 1, anchor: "methods", title: "Methods", text: "Methods We measured the tides twice a day. The tides rose.", digest: digest(2) },
    { index: 2, anchor: "methods", title: "Results", text: "Results The tides rose again.", digest: digest(3) },
    { index: 3, anchor: "hostile", title: HOSTILE, text: `${HOSTILE} Plain words.`, digest: digest(4) },
  ],
};

/**
 * A post page: the article's prose (with a heading anchor link and a note
 * marker the build's text leaves out), the feedback region and the data.
 */
function page({ data = JSON.stringify(DATA), endpoint = "https://t.dev/api", contact, kinds, evidence, connect = true } = {}) {
  globalThis.document = new FakeDocument();
  globalThis.window = new Target();
  const script = new Element("script");
  script.id = "ob-passages";
  script.textContent = data;
  const evidenceScript = new Element("script");
  if (evidence !== undefined) {
    evidenceScript.id = "ob-evidence-references";
    evidenceScript.textContent = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  }
  const article = new Element("article");
  const prose = new Element("div");
  prose.className = "ob-prose e-content";
  const node = {};
  const paragraph = (key, ...parts) => {
    const p = new Element("p");
    p.append(...parts);
    node[key] = p;
    return p;
  };
  const heading = (id, title) => {
    const h = new Element("h2");
    h.id = id;
    const link = new Element("a");
    link.className = "ob-heading-anchor";
    link.textContent = "#";
    h.append(link, title);
    return h;
  };
  const marker = new Element("sup");
  marker.append("1");
  prose.append(
    paragraph("lead", "The moon causes the tides. The sun matters too."),
    heading("methods", "Methods"),
    paragraph("methods", "We measured the tides twice a day", marker, ". The tides rose."),
    heading("methods", "Results"),
    paragraph("results", "The tides rose again."),
    heading("hostile", HOSTILE),
    paragraph("hostile", "Plain words."),
  );
  const section = new Element("section");
  section.id = "ob-feedback";
  const host = new Feedback();
  host.localName = "ob-passage-feedback";
  if (endpoint !== null) host.setAttribute("endpoint", endpoint);
  host.setAttribute("page", "https://t.dev/tides/");
  if (contact !== undefined) host.setAttribute("contact", contact);
  if (kinds !== undefined) host.setAttribute("kinds", kinds);
  if (evidence !== undefined) host.setAttribute("evidence", "");
  const intro = new Element("p");
  intro.textContent = "Ask a question about a passage.";
  const fallback = new Element("p");
  fallback.className = "ob-passage-feedback-static";
  fallback.textContent = "The feedback form needs JavaScript.";
  host.append(intro, fallback);
  section.append(host);
  article.append(prose, section);
  document.body.append(script, ...(evidence !== undefined ? [evidenceScript] : []), article);
  if (connect) host.connectedCallback();
  return { host, prose, node, article, intro, fallback, articleText: prose.textContent };
}

/** Select `text` inside one of the page's text nodes (the first one that holds it). */
function select(view, key, text, { endKey, endText, shown = text } = {}) {
  const textNodes = (element) => element.all().filter((child) => child.localName === "#text");
  const startNode = textNodes(view.node[key]).find((child) => child.text.includes(text));
  const endNode = endKey ? textNodes(view.node[endKey]).find((child) => child.text.includes(endText)) : startNode;
  const startOffset = startNode.text.indexOf(text);
  const range = {
    startContainer: startNode,
    startOffset,
    endContainer: endNode,
    endOffset: endKey ? endNode.text.indexOf(endText) + endText.length : startOffset + text.length,
    getBoundingClientRect: () => ({ left: 40, top: 200, width: 80, height: 20, right: 120, bottom: 220 }),
  };
  document.selection = { rangeCount: 1, isCollapsed: false, toString: () => shown, getRangeAt: () => range };
  document.fire(new FakeEvent("selectionchange"));
}

function collapse() {
  document.selection = { rangeCount: 0, isCollapsed: true, toString: () => "" };
  document.fire(new FakeEvent("selectionchange"));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const parts = (host) => ({
  form: host.find("ob-passage-feedback-form"),
  alert: host.find("ob-passage-feedback-alert"),
  status: host.find("ob-passage-feedback-status"),
  done: host.find("ob-passage-feedback-done"),
  fallback: host.find("ob-passage-feedback-fallback"),
  fallbackMessage: host.find("ob-passage-feedback-fallback-message"),
  quoteText: host.find("ob-passage-feedback-quote"),
  selectionButton: host.find("ob-passage-feedback-selection"),
  contact: host.find("ob-passage-feedback-contact"),
  control: (suffix) => host.all().find((node) => node.id.endsWith(`-${suffix}`)),
  error: (name) => host.all().find((node) => node.id.endsWith(`-${name}-error`)),
  submit: host.all().find((node) => node.localName === "button" && node.type === "submit"),
  copy: host.all().find((node) => node.localName === "button" && node.textContent === "Copy note"),
});

/** A fetch that records requests and answers each with the next response. */
function fakeFetch(...answers) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : undefined });
    const answer = answers.shift() ?? { status: 202, body: { status: "pending" } };
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    return { status: answer.status, ok: answer.status < 300, json: async () => answer.body ?? {} };
  };
  return calls;
}

const noFetch = () => {
  globalThis.fetch = () => assert.fail("nothing may be sent");
};

function fill(view, { kind = "question", body = "Which sources say so?", source, suggested, name, consent, passage } = {}) {
  const ui = parts(view.host);
  const kindSelect = ui.control("kind");
  kindSelect.value = kind;
  kindSelect.dispatch("change");
  ui.control("body").value = body;
  if (source !== undefined) ui.control("source").value = source;
  if (suggested !== undefined) ui.control("suggested").value = suggested;
  if (name !== undefined) ui.control("name").value = name;
  if (consent !== undefined) ui.control("consent").checked = consent;
  if (passage === "section") ui.control("section").checked = true;
  if (passage === "quote") ui.control("quote").checked = true;
  if (passage === "work") ui.control("work").checked = true;
  return ui;
}

const submit = (view) => parts(view.host).form.dispatch("submit");

test("without its data or a safe endpoint the static text stays, as without JavaScript", () => {
  for (const options of [
    { data: null },
    { data: "{not json" },
    { data: JSON.stringify({ ...DATA, version: 2 }) },
    { data: JSON.stringify({ ...DATA, revision: "p1:short" }) },
    { data: JSON.stringify({ ...DATA, work: "https://evil.example/" }) },
    { data: JSON.stringify({ ...DATA, sections: [{ ...DATA.sections[0], index: 1 }] }) },
    { data: JSON.stringify({ ...DATA, sections: [{ ...DATA.sections[0], digest: "x" }] }) },
    { endpoint: null },
    { endpoint: "http://t.dev/api" },
    { endpoint: "https://user:secret@t.dev/api" },
    { endpoint: "javascript:alert(1)" },
  ]) {
    const view = page({ ...options, data: options.data === null ? "" : options.data });
    assert.deepEqual(view.host.children, [view.intro, view.fallback], JSON.stringify(options));
  }
  assert.equal(readPassages("x".repeat(8_000_001)), null);
});

test("the form is labelled, keyboard-operable and replaces only the no-JavaScript text", () => {
  const view = page();
  const ui = parts(view.host);
  assert.equal(view.host.children[0], view.intro);
  assert.ok(!view.host.contains(view.fallback));
  assert.ok(ui.form.noValidate);
  // Every control is a native, focusable form control with its own label.
  const controls = view.host.all().filter((node) => ["input", "select", "textarea"].includes(node.localName));
  assert.ok(controls.length >= 10);
  for (const control of controls) {
    const labels = view.host.all().filter((node) => node.localName === "label" && node.htmlFor === control.id);
    assert.equal(labels.length, 1, `label for ${control.id}`);
    assert.ok(labels[0].textContent.trim().length > 0);
  }
  // The passage choice is one native radio group in a fieldset with a legend.
  const radios = controls.filter((control) => control.type === "radio");
  assert.equal(radios.length, 3);
  assert.equal(new Set(radios.map((radio) => radio.name)).size, 1);
  assert.ok(ui.control("work").checked);
  assert.ok(ui.control("quote").disabled, "no words selected yet");
  assert.equal(ui.control("quote").getAttribute("aria-describedby"), ui.quoteText.id);
  for (const fieldset of view.host.querySelectorAll("fieldset")) {
    assert.equal(fieldset.children[0].localName, "legend");
  }
  // Sections are offered by their heading titles, hostile ones as text.
  const options = ui.control("section-select").options;
  assert.deepEqual(options.map((option) => option.textContent), ["The opening, before the first heading", "Methods", "Results", HOSTILE]);
  assert.deepEqual(options.map((option) => option.value), ["0", "1", "2", "3"]);
  // Announcements: an alert for errors in the form, a status line outside it.
  assert.equal(ui.alert.getAttribute("role"), "alert");
  assert.equal(ui.status.getAttribute("role"), "status");
  assert.ok(!ui.form.contains(ui.status));
  assert.equal(ui.submit.textContent, "Send for review");
  assert.ok(ui.selectionButton.hidden);
  assert.ok(ui.fallback.hidden && ui.done.hidden);
  // Nothing on the page is styled inline or reached through innerHTML.
  for (const node of view.host.all()) assert.ok(!node.hasAttribute("style"));
  assert.equal(view.prose.textContent, view.articleText);
  // Connecting twice builds one form.
  view.host.connectedCallback();
  assert.equal(view.host.querySelectorAll(".ob-passage-feedback-form").length, 1);
});

test("each kind asks for its own details", () => {
  const view = page();
  const ui = parts(view.host);
  const kind = ui.control("kind");
  assert.deepEqual(kind.options.map((option) => option.value), ["question", "source-suggestion", "correction-suggestion", "alternative-interpretation"]);
  const suggestedField = ui.control("suggested").parentElement;
  const sourceLabel = view.host.all().find((node) => node.localName === "label" && node.htmlFor === ui.control("source").id);
  assert.ok(suggestedField.hidden);
  assert.equal(sourceLabel.textContent, "Link to a source (optional)");
  kind.value = "source-suggestion";
  kind.dispatch("change");
  assert.equal(sourceLabel.textContent, "Link to the source");
  assert.ok(ui.control("source").required);
  kind.value = "correction-suggestion";
  kind.dispatch("change");
  assert.ok(!suggestedField.hidden);
  assert.ok(!ui.control("source").required);
  assert.match(ui.control("kind-hint").textContent, /suggestion until the author decides/);
});

test("the form offers only the kinds the post has open, and none leaves the static text (ADR 0101)", () => {
  const view = page({ kinds: "correction-suggestion question" });
  // The registry's order, whatever order the attribute names them in.
  assert.deepEqual(parts(view.host).control("kind").options.map((option) => option.value), ["question", "correction-suggestion"]);
  assert.deepEqual(offeredKinds(null), ["question", "source-suggestion", "correction-suggestion", "alternative-interpretation"]);
  assert.deepEqual(offeredKinds(" third-perspective  abuse-report "), []);
  for (const kinds of ["", "third-perspective", "constructor __proto__"]) {
    const closed = page({ kinds });
    assert.deepEqual(closed.host.children, [closed.intro, closed.fallback], kinds);
  }
});

test("a selection maps onto the build's passage text and is kept when the selection is lost", async () => {
  const view = page();
  const ui = parts(view.host);
  select(view, "methods", "twice a day");
  await tick();
  assert.ok(!ui.control("quote").disabled);
  assert.equal(ui.quoteText.textContent, "“twice a day”");
  // The button appears next to the selection, inside the viewport.
  assert.ok(!ui.selectionButton.hidden);
  assert.equal(ui.selectionButton.style.props["--ob-passage-feedback-x"], "40px");
  assert.equal(ui.selectionButton.style.props["--ob-passage-feedback-y"], "228px");
  // A press on it keeps the selection; activating it chooses the words and focuses that choice.
  assert.ok(ui.selectionButton.dispatch("mousedown").defaultPrevented);
  ui.selectionButton.dispatch("click");
  assert.ok(ui.control("quote").checked && !ui.control("work").checked);
  assert.equal(document.activeElement, ui.control("quote"));
  assert.ok(ui.selectionButton.hidden);
  // The selection goes away; the quotation stays.
  collapse();
  await tick();
  assert.equal(ui.quoteText.textContent, "“twice a day”");
  const calls = fakeFetch({ status: 202, body: { status: "pending" } });
  fill(view, {});
  submit(view);
  await tick();
  const sentence = DATA.sections[1].text;
  const start = Array.from(sentence).indexOf("t", sentence.indexOf("twice"));
  assert.deepEqual(calls[0].body.target, {
    version: 1,
    kind: "quote",
    section: "methods",
    exact: "twice a day",
    prefix: "Methods We measured the tides ",
    suffix: ". The tides rose.",
    start,
  });
  assert.equal(view.prose.textContent, view.articleText, "the article is never changed");
});

test("a repeated anchor is told apart by heading order, and repeated words by where they were selected", async () => {
  const view = page();
  const ui = parts(view.host);
  select(view, "results", "The tides rose");
  await tick();
  const calls = fakeFetch();
  fill(view, { passage: "quote" });
  submit(view);
  await tick();
  // Section 2 (the second #methods): its own context, from its own start.
  assert.equal(calls[0].body.target.prefix, "Results ");
  assert.equal(calls[0].body.target.suffix, " again.");
  assert.equal(calls[0].body.target.start, 8);

  // "tides" occurs twice in section 1: the page's position picks the one selected.
  select(view, "methods", "tides rose");
  await tick();
  assert.ok(ui.quoteText.textContent.includes("tides rose"));
  const located = locateSelection(view.prose, document.getSelection(), readPassages(JSON.stringify(DATA)));
  assert.equal(located.index, 1);
  assert.ok(Number.isFinite(located.hint));
  // Without a way to measure, repeated words are refused, not guessed.
  const passages = readPassages(JSON.stringify(DATA));
  assert.equal(quoteFromSelection(passages, 1, "tides", undefined).code, "ambiguous");
  assert.equal(quoteFromSelection(passages, 1, "tides", 70).target.start, DATA.sections[1].text.lastIndexOf("tides"));
  assert.equal(quoteFromSelection(passages, 1, "tides", 20).target.start, DATA.sections[1].text.indexOf("tides"));
  assert.equal(quoteFromSelection(passages, 1, "twice", undefined).ok, true);
});

test("a selection the form cannot quote is explained and never replaces the last good one", async () => {
  const view = page();
  const ui = parts(view.host);
  const note = ui.control("selection-note");
  select(view, "methods", "twice a day");
  await tick();
  // Across the note marker the build leaves out: not in the passage text.
  select(view, "methods", "a day", { endKey: "methods", endText: ". The", shown: "a day1. The" });
  await tick();
  assert.ok(!note.hidden);
  assert.match(note.textContent, /cannot quote/);
  assert.ok(ui.selectionButton.hidden);
  assert.equal(ui.quoteText.textContent, "“twice a day”");
  // Across two sections.
  select(view, "lead", "too.", { endKey: "methods", endText: "We", shown: "too. # Methods We" });
  await tick();
  assert.match(note.textContent, /cannot quote/);
  // Words outside the post (text in the form itself) are ignored.
  const body = ui.control("body");
  const outside = textNode("my own note");
  body.append(outside);
  document.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "my own note",
    getRangeAt: () => ({ startContainer: outside, startOffset: 0, endContainer: outside, endOffset: 4 }),
  };
  document.fire(new FakeEvent("selectionchange"));
  await tick();
  assert.equal(ui.quoteText.textContent, "“twice a day”");
  // Starting in the post and ending outside it.
  document.selection = {
    rangeCount: 1, isCollapsed: false, toString: () => "x",
    getRangeAt: () => ({ startContainer: view.node.lead.children[0], startOffset: 0, endContainer: outside, endOffset: 1 }),
  };
  assert.deepEqual(locateSelection(view.prose, document.selection, readPassages(JSON.stringify(DATA))), { problem: "outside" });
  const passages = readPassages(JSON.stringify(DATA));
  assert.equal(quoteFromSelection(passages, 0, "x".repeat(501), 0).code, "tooLong");
  assert.equal(quoteFromSelection(passages, 9, "moon", 0).code, "notFound");
  assert.equal(quoteFromSelection(passages, 0, "  \n ", 0).code, "notFound");
  assert.equal(view.prose.textContent, view.articleText);
});

test("errors are announced, marked on the field and take focus, and nothing is sent", () => {
  const view = page();
  noFetch();
  const cases = [
    [{ body: "   " }, "body", /Write your note/],
    [{ kind: "source-suggestion" }, "source", /needs a link/],
    [{ source: "javascript:alert(1)" }, "source", /full web address/],
    [{ source: "https://user:pw@example.org/" }, "source", /without a user name/],
    [{ kind: "correction-suggestion", passage: "work" }, "work", /not the whole post/],
    [{ consent: true, name: "  " }, "consent", /Enter your name/],
    [{ name: "a".repeat(81) }, "name", /up to 80 characters/],
    [{ kind: "correction-suggestion", passage: "section", suggested: "‮evil" }, "suggested", /suggested wording/],
  ];
  for (const [values, field, message] of cases) {
    const ui = fill(view, { source: "", suggested: "", name: "", consent: false, passage: "work", ...values });
    submit(view);
    assert.match(ui.alert.textContent, message, field);
    const control = ui.control(field);
    assert.equal(document.activeElement, control, field);
    assert.equal(control.getAttribute("aria-invalid"), "true", field);
    const errorName = field === "work" ? "passage" : field;
    const error = ui.error(errorName);
    assert.ok(!error.hidden, field);
    assert.match(error.textContent, message);
    if (field === "work") assert.deepEqual(ui.control("work").closest("fieldset").getAttribute("aria-describedby").split(" "), [ui.control("passage-hint").id, error.id]);
    else assert.ok(control.getAttribute("aria-describedby").split(" ").includes(error.id), field);
  }
  // Fixing the problem clears every mark.
  const ui = fill(view, { kind: "question", body: "Fine now", source: "", name: "", consent: false, passage: "work" });
  const calls = fakeFetch();
  submit(view);
  assert.equal(ui.alert.textContent, "");
  assert.ok(view.host.all().every((node) => node.getAttribute("aria-invalid") === null));
  assert.equal(ui.control("source").getAttribute("aria-describedby"), ui.control("source-hint").id);
  assert.equal(calls.length, 1);
});

test("the request is exactly the validated submission, with consent only when given", async () => {
  const view = page();
  const calls = fakeFetch(...Array(3).fill({ status: 202 }));
  fill(view, { kind: "correction-suggestion", passage: "section", body: "  The rise was measured once.\n", source: "https://EXAMPLE.org/a b".replace(" ", "%20"), suggested: "once a day", name: "  Ada   Lovelace ", consent: true });
  parts(view.host).control("section-select").value = "2";
  parts(view.host).control("section-select").dispatch("change");
  submit(view);
  await tick();
  const [call] = calls;
  assert.equal(call.url, "https://t.dev/api/feedback");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.credentials, "omit");
  assert.equal(call.options.headers["Content-Type"], "application/json");
  const read = readFeedbackSubmissionJson(call.options.body);
  assert.ok(read.ok);
  assert.equal(call.body.work, "/tides/");
  assert.equal(call.body.revision, REVISION);
  assert.deepEqual(call.body.target, { version: 1, kind: "section", section: "methods", digest: digest(3) });
  assert.equal(call.body.body, "The rise was measured once.");
  assert.deepEqual(call.body.details, { sourceUrl: "https://example.org/a%20b", suggestedText: "once a day" });
  assert.deepEqual(call.body.attribution, { name: "Ada Lovelace", publishName: true });
  assert.match(call.body.seenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // No name: no attribution at all. The opening section has no anchor.
  fill(view, { kind: "question", passage: "section", body: "Why?", source: "", name: "", consent: false });
  parts(view.host).control("section-select").value = "0";
  parts(view.host).control("section-select").dispatch("change");
  submit(view);
  await tick();
  assert.equal(calls[1].body.attribution, undefined);
  assert.deepEqual(calls[1].body.target, { version: 1, kind: "section", digest: digest(1) });
  // A name without consent stays private.
  fill(view, { passage: "work", name: "Ada", consent: false });
  submit(view);
  await tick();
  assert.deepEqual(calls[2].body.attribution, { name: "Ada", publishName: false });
  assert.deepEqual(calls[2].body.target, { version: 1, kind: "work" });
});

test("pending is explicit, a second submission waits, and success is announced with focus", async () => {
  const view = page();
  const ui = parts(view.host);
  let answer;
  const calls = fakeFetch(() => new Promise((resolve) => (answer = resolve)));
  fill(view, { source: "https://example.org/", name: "Ada" });
  submit(view);
  assert.equal(ui.form.getAttribute("aria-busy"), "true");
  assert.equal(ui.submit.getAttribute("aria-disabled"), "true");
  assert.equal(ui.submit.textContent, "Sending…");
  assert.equal(ui.status.textContent, "Sending your note…");
  submit(view);
  assert.equal(calls.length, 1);
  answer({ status: 202, json: async () => ({ id: "x", status: "pending" }) });
  await tick();
  assert.equal(ui.form.getAttribute("aria-busy"), null);
  assert.equal(ui.submit.getAttribute("aria-disabled"), null);
  assert.equal(ui.submit.textContent, "Send for review");
  assert.equal(ui.status.textContent, "Sent for review.");
  assert.ok(!ui.done.hidden);
  assert.match(ui.done.textContent, /sent to the author for review/);
  assert.equal(document.activeElement, ui.done);
  assert.equal(ui.control("body").value, "");
  assert.equal(ui.control("source").value, "");
  assert.equal(ui.control("name").value, "Ada", "the name is kept for another note");
  assert.equal(view.prose.textContent, view.articleText);
});

test("offline, refused and failing services fall back to a copy of the note, losing nothing", async () => {
  for (const [answer, reason] of [
    [new TypeError("Failed to fetch"), /did not answer/],
    [{ status: 404, body: { code: "unavailable" } }, /not taking feedback/],
    [{ status: 403, body: { code: "unavailable" } }, /not taking feedback/],
    [{ status: 429, body: { code: "rateLimited" } }, /too many notes/],
    [{ status: 502, body: { error: "The hosted data service is unavailable." } }, /had a problem/],
    [{ status: 200, body: {} }, /had a problem/],
    ["offline", /offline/],
  ]) {
    const view = page();
    const ui = parts(view.host);
    let calls;
    if (answer === "offline") {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
      noFetch();
    } else {
      calls = fakeFetch(answer);
    }
    fill(view, { kind: "source-suggestion", source: "https://example.org/x", body: HOSTILE, name: "Ada", consent: true, passage: "section" });
    submit(view);
    await tick();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    assert.ok(!ui.fallback.hidden, String(reason));
    assert.match(ui.fallbackMessage.textContent, reason);
    assert.match(ui.fallbackMessage.textContent, /Nothing you wrote was lost/);
    assert.equal(document.activeElement, ui.fallbackMessage);
    const copyArea = ui.control("copy");
    assert.ok(copyArea.readOnly);
    const sent = calls?.[0]?.options.body;
    const submission = readFeedbackSubmissionJson(sent ?? JSON.stringify({
      version: 1, kind: "source-suggestion", work: "/tides/", revision: REVISION,
      target: { version: 1, kind: "section", digest: digest(1) }, body: HOSTILE,
      details: { sourceUrl: "https://example.org/x" }, attribution: { name: "Ada", publishName: true },
    })).submission;
    if (sent) assert.equal(copyArea.value, feedbackCopyText(submission, "https://t.dev/tides/"));
    assert.ok(copyArea.value.includes(HOSTILE), "the note is plain text in a text box");
    assert.ok(copyArea.value.startsWith("Suggested source about https://t.dev/tides/"));
    // Nothing the reader wrote was cleared.
    assert.equal(ui.control("body").value, HOSTILE);
    assert.equal(ui.control("source").value, "https://example.org/x");
    assert.ok(ui.contact.hidden, "no contact was configured");
    assert.equal(view.prose.textContent, view.articleText);
  }
});

test("a closed post says so and offers no copy", async () => {
  const view = page();
  const ui = parts(view.host);
  fakeFetch({ status: 403, body: { code: "closed" } });
  fill(view, {});
  submit(view);
  await tick();
  assert.match(ui.status.textContent, /closed/);
  assert.ok(ui.fallback.hidden);
});

test("a note already sent this hour says it is waiting for review and offers no copy", async () => {
  const view = page();
  const ui = parts(view.host);
  fakeFetch({ status: 409, body: { error: "This note was already sent and is waiting for review.", code: "duplicate" } });
  fill(view, {});
  submit(view);
  await tick();
  assert.equal(ui.status.textContent, "This note was already sent and is waiting for review.");
  assert.ok(ui.fallback.hidden);
});

test("a refusal the service reports for one field is shown on that field", async () => {
  const view = page();
  const ui = parts(view.host);
  fakeFetch({ status: 422, body: { code: "invalidSourceUrl" } });
  fill(view, { source: "https://example.org/" });
  submit(view);
  await tick();
  assert.equal(document.activeElement, ui.control("source"));
  assert.ok(ui.fallback.hidden);
});

test("copying uses the clipboard, or selects the note for the reader to copy", async () => {
  const view = page();
  const ui = parts(view.host);
  fakeFetch(new TypeError("offline"));
  fill(view, {});
  submit(view);
  await tick();
  let copied;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => (copied = text) } } });
  ui.copy.dispatch("click");
  await tick();
  assert.equal(copied, ui.control("copy").value);
  assert.equal(ui.status.textContent, "Your note was copied.");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("denied"); } } } });
  ui.copy.dispatch("click");
  await tick();
  assert.ok(ui.control("copy").selected);
  assert.equal(document.activeElement, ui.control("copy"));
  assert.match(ui.status.textContent, /selected/);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
});

test("the author's contact link carries the note when it fits, and an unsafe one is never shown", async () => {
  const mail = page({ contact: "mailto:ada@t.dev" });
  fakeFetch({ status: 404, body: { code: "unavailable" } });
  fill(mail, { body: "Short note." });
  submit(mail);
  await tick();
  const link = parts(mail.host).contact;
  assert.ok(!link.hidden);
  assert.equal(link.textContent, "Write to the author");
  const url = new URL(link.href);
  assert.equal(url.protocol, "mailto:");
  assert.equal(url.pathname, "ada@t.dev");
  assert.equal(url.searchParams.get("subject"), "Question about https://t.dev/tides/");
  assert.equal(url.searchParams.get("body"), parts(mail.host).control("copy").value);

  const long = page({ contact: "mailto:ada@t.dev" });
  fakeFetch({ status: 404, body: { code: "unavailable" } });
  fill(long, { body: "word ".repeat(600) });
  submit(long);
  await tick();
  assert.ok(!parts(long.host).contact.href.includes("body="));

  const web = page({ contact: "https://t.dev/contact/" });
  fakeFetch(new TypeError("offline"));
  fill(web, {});
  submit(web);
  await tick();
  assert.equal(parts(web.host).contact.href, "https://t.dev/contact/");
  assert.equal(parts(web.host).contact.textContent, "Open the author’s contact page");

  for (const unsafe of ["javascript:alert(1)", "mailto:a@b?bcc=c@d", "http://t.dev/contact", "data:text/html,x"]) {
    assert.equal(safeContact(unsafe), null, unsafe);
    const view = page({ contact: unsafe });
    assert.ok(parts(view.host).contact.hidden, unsafe);
  }
});

test("disconnecting removes its listeners and stops a pending request", async () => {
  const view = page();
  let signal;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  fill(view, {});
  submit(view);
  assert.equal(document.live("selectionchange").length, 1);
  view.host.disconnectedCallback();
  assert.equal(document.live("selectionchange").length, 0);
  assert.equal(window.live("scroll").length, 0);
  assert.ok(signal.aborted);
  // Moved back into the page, it keeps its one form and listens again.
  view.host.connectedCallback();
  assert.equal(view.host.querySelectorAll(".ob-passage-feedback-form").length, 1);
  assert.equal(document.live("selectionchange").length, 1);
  const calls = fakeFetch();
  fill(view, { body: "Again" });
  submit(view);
  await tick();
  assert.equal(calls.length, 1);
});

test("the element shim mirrors the browser's own reflected properties", () => {
  const element = new Element("div");
  element.hidden = true;
  assert.equal(element.getAttribute("hidden"), "");
  element.title = "t";
  assert.equal(element.getAttribute("title"), "t");
  element.popover = "auto";
  assert.equal(typeof element.popover, "string");
  assert.throws(() => { element.innerHTML = "<b>x</b>"; });
  // The component keeps its state in private fields, so none of these can be shadowed.
  const view = page();
  for (const property of ["title", "hidden", "popover", "lang", "dir", "role", "id"]) {
    assert.ok(!Object.hasOwn(view.host, property), property);
  }
});

// ---- The evidence offer (ADR 0116)

const CHOICES = {
  version: 1,
  claims: [
    { id: "tide-height", label: "Claim 1: The tide rises 3 m", links: [{ id: "tide-height-noaa", label: "Supported by NOAA 2020" }] },
    { id: "moon", label: `Claim 2: ${HOSTILE}`, links: [] },
  ],
  citations: [{ id: "noaa-2020", label: "NOAA tide tables (2020)" }],
  sources: [{ id: "admiralty-1990", label: "Admiralty tide tables (1990)" }, { id: "noaa-2020", label: "NOAA tide tables (2020)" }],
};

test("evidence is offered only for a suggested source or correction, labelled, from published choices only", () => {
  const view = page({ evidence: CHOICES });
  const ui = parts(view.host);
  const fieldset = view.host.find("ob-passage-feedback-evidence");
  assert.ok(fieldset, "the evidence fieldset is built");
  assert.equal(fieldset.children[0].localName, "legend");
  assert.ok(fieldset.hidden, "a question offers no evidence");
  for (const kind of ["source-suggestion", "correction-suggestion"]) {
    fill(view, { kind });
    assert.ok(!fieldset.hidden, kind);
  }
  fill(view, { kind: "alternative-interpretation" });
  assert.ok(fieldset.hidden);
  fill(view, { kind: "correction-suggestion" });
  // Every control has one label; hostile labels stay text.
  for (const control of fieldset.all().filter((node) => ["input", "select"].includes(node.localName))) {
    assert.equal(view.host.all().filter((node) => node.localName === "label" && node.htmlFor === control.id).length, 1, control.id);
  }
  const claim = ui.control("claim");
  assert.deepEqual(claim.options.map((option) => option.value), ["", "tide-height", "moon"]);
  assert.equal(claim.options[2].textContent, `Claim 2: ${HOSTILE}`);
  // The evidence links follow the claim chosen; none until then.
  const link = ui.control("evidence-link");
  assert.ok(link.disabled);
  claim.value = "tide-height";
  claim.dispatch("change");
  assert.ok(!link.disabled);
  assert.deepEqual(link.options.map((option) => option.value), ["", "tide-height-noaa"]);
  claim.value = "moon";
  claim.dispatch("change");
  assert.ok(link.disabled, "a claim without published links offers none");
  // Where in the source waits for a source.
  assert.ok(ui.control("locator").disabled);
  ui.control("offered").value = "admiralty-1990";
  ui.control("offered").dispatch("change");
  assert.ok(!ui.control("locator").disabled);
  // The stance is one radio group, "not saying" first and chosen.
  const stances = fieldset.all().filter((node) => node.type === "radio");
  assert.deepEqual(stances.map((radio) => radio.value), ["", "supports", "contradicts", "contextualizes"]);
  assert.equal(new Set(stances.map((radio) => radio.name)).size, 1);
  assert.ok(stances[0].checked);
});

test("the chosen evidence is sent as a validated version 2 submission, and nothing chosen stays version 1", async () => {
  const view = page({ evidence: CHOICES });
  const calls = fakeFetch(...Array(2).fill({ status: 202 }));
  const ui = fill(view, { kind: "correction-suggestion", passage: "section", body: "The height is wrong." });
  ui.control("claim").value = "tide-height";
  ui.control("claim").dispatch("change");
  ui.control("evidence-link").value = "tide-height-noaa";
  ui.control("offered").value = "admiralty-1990";
  ui.control("offered").dispatch("change");
  ui.control("locator").value = " 40 ";
  ui.control("locator-to").value = "41";
  view.host.all().find((node) => node.type === "radio" && node.value === "contradicts").checked = true;
  submit(view);
  await tick();
  const [call] = calls;
  assert.equal(call.body.version, 2);
  assert.deepEqual(call.body.evidence, {
    claim: "tide-height", evidenceLink: "tide-height-noaa", source: "admiralty-1990",
    locators: [{ kind: "page", value: "40", to: "41" }], stance: "contradicts",
  });
  assert.ok(readEvidenceSubmissionJson(call.options.body).ok);
  // After success the offer is cleared, so the next note starts with nothing named.
  assert.equal(ui.control("claim").value, "");
  assert.ok(view.host.all().find((node) => node.type === "radio" && node.value === "").checked);
  fill(view, { kind: "correction-suggestion", passage: "section", body: "Another." });
  submit(view);
  await tick();
  assert.equal(calls[1].body.version, 1);
  assert.equal(calls[1].body.evidence, undefined);
});

test("evidence problems are announced on their own field, and nothing is sent", () => {
  const view = page({ evidence: CHOICES });
  noFetch();
  let ui = fill(view, { kind: "correction-suggestion", passage: "section", source: "" });
  const contradicts = view.host.all().find((node) => node.type === "radio" && node.value === "contradicts");
  contradicts.checked = true;
  submit(view);
  assert.match(ui.alert.textContent, /only when you offer one/);
  assert.equal(document.activeElement, contradicts);
  assert.equal(contradicts.getAttribute("aria-invalid"), "true");
  assert.ok(contradicts.closest("fieldset").getAttribute("aria-describedby").includes(ui.error("stance").id));
  ui = fill(view, { kind: "correction-suggestion", passage: "section", source: "" });
  view.host.all().find((node) => node.type === "radio" && node.value === "").checked = true;
  ui.control("offered").value = "admiralty-1990";
  ui.control("offered").dispatch("change");
  ui.control("locator").value = "4\n5";
  submit(view);
  assert.match(ui.alert.textContent, /Say where in the source/);
  assert.equal(document.activeElement, ui.control("locator"));
  assert.equal(ui.control("locator").getAttribute("aria-invalid"), "true");
});

test("a site whose service does not store evidence yet falls back to a copy that keeps the evidence", async () => {
  const view = page({ evidence: CHOICES });
  fakeFetch({ status: 422, body: { code: "unsupportedVersion", error: "newer" } });
  const ui = fill(view, { kind: "correction-suggestion", passage: "section", body: "The height is wrong." });
  ui.control("claim").value = "tide-height";
  ui.control("claim").dispatch("change");
  submit(view);
  await tick();
  assert.ok(!ui.fallback.hidden);
  assert.match(ui.fallbackMessage.textContent, /does not take evidence through the form/);
  assert.equal(document.activeElement, ui.fallbackMessage);
  const copy = view.host.all().find((node) => node.localName === "textarea" && node.readOnly);
  assert.match(copy.value, /Claim: tide-height/);
  assert.ok(readEvidenceSubmissionJson(copy.value.split("\n").at(-1)).ok);
});

test("without the site's evidence switch or readable choices, the form is what it was", () => {
  for (const options of [{}, { evidence: "{not json" }, { evidence: { ...CHOICES, version: 2 } }, { evidence: { ...CHOICES, sources: [{ id: "Bad Id", label: "x" }] } }, { evidence: CHOICES, kinds: "question" }]) {
    const view = page(options);
    assert.equal(view.host.find("ob-passage-feedback-evidence"), null, JSON.stringify(options).slice(0, 60));
  }
  assert.equal(readEvidenceChoices("x".repeat(2_000_001)), null);
  assert.deepEqual(readEvidenceChoices(JSON.stringify(CHOICES)).claims[0].links[0], { id: "tide-height-noaa", label: "Supported by NOAA 2020" });
});
