// DOM-contract tests for <ob-citation-previews> (ADR 0061): keyboard, pointer
// and touch use, Escape and focus return, outside interaction, viewport
// edges, several markers, hostile data, unsafe links, disconnection, and the
// page's styles for reduced motion and print.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
  /** The listeners still attached: an aborted signal removes its own. */
  live(type) {
    return (this.listeners.get(type) || []).filter((entry) => !entry.signal?.aborted);
  }
  fire(event) {
    for (const { fn } of this.live(event.type)) fn(event);
  }
  count(type) {
    return this.live(type).length;
  }
}

class Element extends Target {
  constructor(tag = "span") {
    super();
    this.localName = tag;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.text = "";
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
    this.style = { props: {}, setProperty(name, value) { this.props[name] = value; } };
  }
  get id() { return this.getAttribute("id") ?? ""; }
  set id(value) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(value) { this.setAttribute("class", value); }
  get href() { return this.getAttribute("href") ?? ""; }
  set href(value) { this.setAttribute("href", value); }
  get rel() { return this.getAttribute("rel") ?? ""; }
  set rel(value) { this.setAttribute("rel", value); }
  // HTMLElement's own `popover` reflects its attribute as a string, as in a
  // browser, so a component that keeps an element there breaks here too.
  get popover() { return this.getAttribute("popover"); }
  set popover(value) { if (value === null) this.removeAttribute("popover"); else this.setAttribute("popover", value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.text = String(value);
  }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.textContent = "";
    this.append(...nodes);
  }
  after(node) {
    node.remove();
    const parent = this.parentElement;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
    node.parentElement = parent;
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
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  focus() {
    document.focus(this);
  }
  /** Dispatch an event at this element, bubbling to the document. */
  dispatch(type, init = {}) {
    const event = new FakeEvent(type, { ...init, target: this });
    for (let node = this; node; node = node.parentElement) node.fire(event);
    if (init.bubbles !== false) document.fire(event);
    return event;
  }
  all() {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  find(className) {
    return this.all().find((node) => node.className.split(/\s+/).includes(className)) || null;
  }
}

class FakeDocument extends Target {
  constructor() {
    super();
    this.body = new Element("body");
    this.activeElement = this.body;
    this.documentElement = { clientWidth: 1000, clientHeight: 800 };
  }
  createElement(tag) {
    return new Element(tag);
  }
  getElementById(id) {
    return this.body.all().find((node) => node.id === id) || null;
  }
  focus(element) {
    this.activeElement = element;
    element.fire(new FakeEvent("focus", { target: element }));
    element.dispatch("focusin");
  }
}

let Previews;
globalThis.HTMLElement = Element;
globalThis.customElements = { get: () => undefined, define: (_name, constructor) => (Previews = constructor) };
globalThis.window = new Target();
// The component never fetches and never stores anything.
globalThis.fetch = () => {
  throw new Error("no requests");
};
for (const name of ["localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`no ${name}`);
    },
  });
}
const { readReferences, safeLink } = await import("../../web/components/ob-citation-previews.js");

const HOSTILE = "</script><img src=x onerror=alert(1)> & <b>bold</b>";
const DATA = {
  version: 1,
  style: "notes",
  locale: "en",
  references: [
    { id: "slings", number: 1, formatted: "Platonis Rempublicam. 2003. doi:10.1000/xyz", link: "https://doi.org/10.1000/xyz" },
    { id: "plato", number: 2, formatted: "Plato. Πολιτεία" },
    { id: "hostile", number: 3, formatted: HOSTILE, link: "javascript:alert(1)" },
  ],
  citations: [
    { marker: "cite-1-ref-1", note: "cite-1", reference: "slings", formatted: "p. 514" },
    { marker: "cite-1-ref-2", note: "cite-1", reference: "slings", formatted: "p. 514" },
    { marker: "cite-2-ref-1", note: "cite-2", reference: "plato" },
    { marker: "cite-3-ref-1", note: "cite-3", reference: "hostile" },
  ],
};

/** A post page: a paragraph of markers, the notes, the data and the host element. */
function page({ data = JSON.stringify(DATA), noteLabel = "Go to note", connect = true } = {}) {
  globalThis.document = new FakeDocument();
  globalThis.window = new Target();
  const script = new Element("script");
  script.id = "ob-references";
  script.textContent = data;
  const paragraph = new Element("p");
  const markers = {};
  for (const [index, citation] of DATA.citations.entries()) {
    const sup = new Element("sup");
    sup.className = "footnote-reference ob-citation";
    const marker = new Element("a");
    marker.id = citation.marker;
    marker.href = `#${citation.note}`;
    marker.setAttribute("role", "doc-noteref");
    marker.textContent = `Citation ${citation.note.slice(5)}`;
    marker.rect = { left: 100 + index * 50, top: 100, width: 10, height: 16 };
    sup.append(marker);
    paragraph.append(sup);
    markers[citation.marker] = marker;
  }
  const after = new Element("a");
  after.href = "/elsewhere/";
  paragraph.append(after);
  document.body.append(script, paragraph);
  for (const note of ["cite-1", "cite-2", "cite-3"]) {
    const div = new Element("div");
    div.id = note;
    document.body.append(div);
  }
  const host = new Previews();
  if (noteLabel !== null) host.setAttribute("note-label", noteLabel);
  document.body.append(host);
  if (connect) host.connectedCallback();
  return { host, markers, after, paragraph };
}

const popoverOf = (host) => host.panel;
const isOpen = (host) => Boolean(host.panel && !host.panel.hidden);

test("reads the data and drops what it cannot trust, entry by entry", () => {
  const previews = readReferences(JSON.stringify(DATA));
  assert.equal(previews.size, 4);
  assert.deepEqual(previews.get("cite-1-ref-1"), {
    note: "cite-1",
    text: "Platonis Rempublicam. 2003. doi:10.1000/xyz",
    locators: "p. 514",
    link: "https://doi.org/10.1000/xyz",
  });
  assert.equal(previews.get("cite-3-ref-1").link, null, "an unsafe link is dropped, the text kept");
  // A newer version, broken JSON, oversized or missing data: no previews at all.
  for (const text of [JSON.stringify({ ...DATA, version: 2 }), "{", "x".repeat(1_000_001), undefined, "null", "[]"]) {
    assert.equal(readReferences(text), null);
  }
  // A malformed entry loses only its own preview.
  const mixed = {
    ...DATA,
    references: [...DATA.references, { id: 7, formatted: "bad id" }, { id: "no-text" }],
    citations: [
      ...DATA.citations,
      { marker: "cite-9-ref-1", note: "cite-9", reference: "missing" },
      { marker: "cite-8-ref-1", note: "cite-8", reference: "no-text" },
      { marker: 5, note: "cite-1", reference: "slings" },
      null,
    ],
  };
  assert.deepEqual([...readReferences(JSON.stringify(mixed)).keys()], DATA.citations.map((c) => c.marker));
});

test("only plain http(s) addresses without credentials are links", () => {
  assert.equal(safeLink("https://doi.org/10.1000/xyz"), "https://doi.org/10.1000/xyz");
  assert.equal(safeLink("http://example.org/a_(b)?q=1"), "http://example.org/a_(b)?q=1");
  for (const unsafe of [
    "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd",
    "https://user:secret@example.org/", "//example.org/", "/relative", "#cite-1", "", 42, null,
  ]) {
    assert.equal(safeLink(unsafe), null, String(unsafe));
  }
});

test("focusing a marker opens its preview, as text, right after the marker", () => {
  const { host, markers } = page();
  const marker = markers["cite-1-ref-1"];
  marker.focus();
  const popover = popoverOf(host);
  assert.ok(isOpen(host));
  // Placed straight after the marker's <sup>, so Tab reaches its links next.
  assert.equal(marker.parentElement.parentElement.children.indexOf(popover), 1);
  assert.equal(popover.getAttribute("role"), "group");
  assert.equal(popover.getAttribute("aria-labelledby"), "cite-1-ref-1");
  const details = popover.find("ob-citation-preview-details");
  assert.equal(marker.getAttribute("aria-describedby"), details.id);
  assert.equal(details.textContent, "Platonis Rempublicam. 2003. doi:10.1000/xyz" + "p. 514");
  const source = popover.find("ob-citation-preview-source");
  assert.equal(source.href, "https://doi.org/10.1000/xyz");
  assert.equal(source.textContent, "https://doi.org/10.1000/xyz");
  assert.equal(source.rel, "noreferrer");
  const note = popover.find("ob-citation-preview-note");
  assert.equal(note.href, "#cite-1");
  assert.equal(note.textContent, "Go to note");
  // The marker is untouched: still a link to its note.
  assert.equal(marker.href, "#cite-1");
  assert.equal(marker.getAttribute("role"), "doc-noteref");
});

test("hostile reference text stays text and an unsafe link is never shown", () => {
  const { host, markers } = page();
  markers["cite-3-ref-1"].focus();
  const popover = popoverOf(host);
  assert.equal(popover.find("ob-citation-preview-reference").textContent, HOSTILE);
  const tags = popover.all().map((node) => node.localName);
  assert.ok(!tags.includes("img") && !tags.includes("b") && !tags.includes("script"), tags.join());
  assert.equal(popover.find("ob-citation-preview-source"), null);
  assert.ok(popover.find("ob-citation-preview-locators").hidden, "no locators, nothing shown");
  const hrefs = popover.all().map((node) => node.getAttribute("href")).filter(Boolean);
  assert.deepEqual(hrefs, ["#cite-3"]);
});

test("Escape closes the preview and returns focus to its marker without reopening it", () => {
  const { host, markers } = page();
  const marker = markers["cite-1-ref-1"];
  marker.focus();
  const link = popoverOf(host).find("ob-citation-preview-source");
  link.focus();
  assert.ok(isOpen(host), "focus inside the preview keeps it open");
  document.body.dispatch("keydown", { key: "Escape" });
  assert.ok(!isOpen(host));
  assert.equal(document.activeElement, marker);
  assert.equal(marker.getAttribute("aria-describedby"), null);
  // Escape on the marker itself closes it and leaves focus there.
  markers["cite-2-ref-1"].focus();
  assert.ok(isOpen(host));
  document.body.dispatch("keydown", { key: "Escape" });
  assert.ok(!isOpen(host));
  assert.equal(document.activeElement, markers["cite-2-ref-1"]);
  // Other keys do nothing.
  markers["cite-2-ref-1"].focus();
  markers["cite-1-ref-1"].focus();
  document.body.dispatch("keydown", { key: "Enter" });
  assert.ok(isOpen(host));
});

test("focus or a press anywhere else closes it; inside the preview it stays", () => {
  const { host, markers, after } = page();
  markers["cite-1-ref-1"].focus();
  popoverOf(host).find("ob-citation-preview-note").dispatch("pointerdown", { pointerType: "mouse" });
  assert.ok(isOpen(host));
  document.body.dispatch("pointerdown", { pointerType: "mouse" });
  assert.ok(!isOpen(host));
  markers["cite-1-ref-1"].focus();
  after.focus();
  assert.ok(!isOpen(host), "Tab past the preview closes it");
  assert.equal(markers["cite-1-ref-1"].getAttribute("aria-describedby"), null);
});

test("one preview at a time across several markers", () => {
  const { host, markers } = page();
  markers["cite-1-ref-1"].focus();
  markers["cite-2-ref-1"].focus();
  const popovers = document.body.all().filter((node) => node.className === "ob-citation-preview");
  assert.equal(popovers.length, 1);
  assert.equal(markers["cite-1-ref-1"].getAttribute("aria-describedby"), null);
  assert.equal(markers["cite-2-ref-1"].getAttribute("aria-describedby"), popoverOf(host).find("ob-citation-preview-details").id);
  assert.equal(popoverOf(host).find("ob-citation-preview-reference").textContent, "Plato. Πολιτεία");
  assert.equal(markers["cite-2-ref-1"].parentElement.parentElement.children.indexOf(popoverOf(host)), 3);
});

test("hovering opens after a moment, and leaving both closes it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, markers } = page();
  const marker = markers["cite-1-ref-1"];
  marker.dispatch("pointerenter", { pointerType: "mouse", bubbles: false });
  assert.ok(!isOpen(host));
  t.mock.timers.tick(250);
  assert.ok(isOpen(host));
  marker.dispatch("pointerleave", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(100);
  popoverOf(host).dispatch("pointerenter", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(1000);
  assert.ok(isOpen(host), "moving onto the preview keeps it open");
  popoverOf(host).dispatch("pointerleave", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(300);
  assert.ok(!isOpen(host));
  // A pass over a marker that is shorter than the delay opens nothing.
  marker.dispatch("pointerenter", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(100);
  marker.dispatch("pointerleave", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(1000);
  assert.ok(!isOpen(host));
  // Leaving does not close a preview the keyboard is using.
  marker.focus();
  marker.dispatch("pointerleave", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(1000);
  assert.ok(isOpen(host));
});

test("a click or Enter still follows the link; a first tap opens the preview instead", () => {
  const { host, markers, after } = page();
  const marker = markers["cite-1-ref-1"];
  // Mouse: press, focus, click. The link is followed and the preview closes.
  marker.dispatch("pointerdown", { pointerType: "mouse", isPrimary: true });
  marker.focus();
  let click = marker.dispatch("click", { detail: 1 });
  assert.equal(click.defaultPrevented, false);
  assert.ok(!isOpen(host));
  // Keyboard Enter is a click without a pointer.
  marker.focus();
  click = marker.dispatch("click", { detail: 0 });
  assert.equal(click.defaultPrevented, false);
  // Touch: the first tap opens the preview and stays on the page...
  after.focus();
  document.body.dispatch("pointerdown", { pointerType: "touch", isPrimary: true });
  marker.dispatch("pointerenter", { pointerType: "touch", bubbles: false });
  marker.dispatch("pointerdown", { pointerType: "touch", isPrimary: true });
  marker.focus();
  click = marker.dispatch("click", { detail: 1 });
  assert.equal(click.defaultPrevented, true);
  assert.ok(isOpen(host));
  // ...and a second tap on the same marker follows the link.
  marker.dispatch("pointerdown", { pointerType: "touch", isPrimary: true });
  click = marker.dispatch("click", { detail: 1 });
  assert.equal(click.defaultPrevented, false);
  assert.ok(!isOpen(host));
});

/** A touch press on a marker whose preview is closed, focus elsewhere first. */
function touchPress(marker, away) {
  away.focus();
  marker.dispatch("pointerdown", { pointerType: "touch", isPrimary: true });
}

test("a touch press that never becomes a tap leaves Enter following the link", () => {
  const { host, markers, after } = page();
  const marker = markers["cite-1-ref-1"];
  // The browser takes the press back (a scroll, say): a later Enter follows the link.
  touchPress(marker, after);
  marker.dispatch("pointercancel", { pointerType: "touch", bubbles: false });
  marker.focus();
  let click = marker.dispatch("click", { detail: 0 });
  assert.equal(click.defaultPrevented, false);
  // Focus leaves the marker after the press: the press is forgotten.
  touchPress(marker, after);
  marker.focus();
  marker.dispatch("blur", { bubbles: false });
  after.focus();
  marker.focus();
  click = marker.dispatch("click", { detail: 1 });
  assert.equal(click.defaultPrevented, false);
  // A press anywhere else forgets it too.
  touchPress(marker, after);
  after.dispatch("pointerdown", { pointerType: "mouse", isPrimary: true });
  after.focus();
  marker.focus();
  click = marker.dispatch("click", { detail: 1 });
  assert.equal(click.defaultPrevented, false);
  assert.ok(!isOpen(host), "following the link closes the preview");
});

test("keyboard, scripted and assistive-technology activation always follow the link", () => {
  const { markers, after } = page();
  const marker = markers["cite-1-ref-1"];
  // `detail` 0 is never a tap, even straight after a touch press.
  touchPress(marker, after);
  let click = marker.dispatch("click", { detail: 0 });
  assert.equal(click.defaultPrevented, false);
  // A screen reader's double-tap on a touch screen: a click with no press before it.
  after.focus();
  click = marker.dispatch("click", { detail: 1 });
  assert.equal(click.defaultPrevented, false);
  // A press on one marker never makes a click on another a first tap.
  touchPress(markers["cite-2-ref-1"], after);
  click = marker.dispatch("click", { detail: 1 });
  assert.equal(click.defaultPrevented, false);
  // A second finger is not a tap either; a mouse or pen press is not a touch.
  for (const press of [
    { pointerType: "touch", isPrimary: false },
    { pointerType: "pen", isPrimary: true },
    { pointerType: "mouse", isPrimary: true },
  ]) {
    after.focus();
    marker.dispatch("pointerdown", press);
    click = marker.dispatch("click", { detail: 1 });
    assert.equal(click.defaultPrevented, false, JSON.stringify(press));
  }
});

test("the preview stays inside the viewport, below the marker or above it", () => {
  const { host, markers } = page();
  const marker = markers["cite-1-ref-1"];
  const popover = () => popoverOf(host);
  // Room below: aligned with the marker, just under it.
  marker.rect = { left: 100, top: 100, width: 10, height: 16 };
  marker.focus();
  popover().rect = { left: 110, top: 100, width: 300, height: 120 };
  host.place();
  assert.deepEqual(popover().style.props, {
    "--ob-citation-preview-max-inline-size": "984px",
    "--ob-citation-preview-x": "-10px",
    "--ob-citation-preview-y": "20px",
  });
  assert.equal(popover().dataset.side, "below");
  // At the right edge it moves left to keep an 8px gutter.
  marker.rect = { left: 900, top: 100, width: 10, height: 16 };
  popover().rect = { left: 910, top: 100, width: 300, height: 120 };
  host.place();
  assert.equal(popover().style.props["--ob-citation-preview-x"], `${1000 - 8 - 300 - 910}px`);
  // Near the bottom it opens above the marker.
  marker.rect = { left: 100, top: 740, width: 10, height: 16 };
  popover().rect = { left: 110, top: 740, width: 300, height: 120 };
  host.place();
  assert.equal(popover().dataset.side, "above");
  assert.equal(popover().style.props["--ob-citation-preview-y"], `${740 - 4 - 120 - 740}px`);
  // Narrower than the preview: pinned to the left gutter.
  document.documentElement.clientWidth = 280;
  marker.rect = { left: 100, top: 100, width: 10, height: 16 };
  popover().rect = { left: 110, top: 100, width: 264, height: 120 };
  host.place();
  assert.equal(popover().style.props["--ob-citation-preview-x"], `${8 - 110}px`);
  // Its width is the viewport's without a classic scrollbar (clientWidth),
  // less both gutters, never `100vw`.
  assert.equal(popover().style.props["--ob-citation-preview-max-inline-size"], `${280 - 16}px`);
  document.documentElement.clientWidth = 10;
  host.place();
  assert.equal(popover().style.props["--ob-citation-preview-max-inline-size"], "0px");
  // Resizing places it again.
  assert.equal(window.count("resize"), 1);
});

test("disconnecting removes the preview, its descriptions, timers and listeners", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, markers } = page();
  const marker = markers["cite-1-ref-1"];
  marker.focus();
  markers["cite-2-ref-1"].dispatch("pointerenter", { pointerType: "mouse", bubbles: false });
  host.remove();
  host.disconnectedCallback();
  t.mock.timers.tick(1000);
  assert.equal(document.body.find("ob-citation-preview"), null);
  assert.equal(marker.getAttribute("aria-describedby"), null);
  for (const type of ["keydown", "pointerdown", "focusin"]) assert.equal(document.count(type), 0, type);
  assert.equal(window.count("resize"), 0);
  assert.equal(marker.count("focus"), 0);
  marker.focus();
  assert.equal(document.body.find("ob-citation-preview"), null);
  // Connected again, it enhances the page again, once.
  document.body.append(host);
  host.connectedCallback();
  host.connectedCallback();
  assert.equal(marker.count("focus"), 1);
  marker.focus();
  assert.ok(isOpen(host));
});

test("without usable data, or for markers that no longer link to their note, nothing changes", () => {
  for (const data of ["{", JSON.stringify({ ...DATA, version: 2 })]) {
    const { host, markers } = page({ data });
    markers["cite-1-ref-1"].focus();
    assert.equal(host.panel ?? null, null);
    assert.equal(document.count("keydown"), 0);
  }
  // A marker whose link was changed keeps its own behaviour; the others are enhanced.
  const { host, markers } = page({ connect: false });
  markers["cite-2-ref-1"].href = "#somewhere-else";
  host.connectedCallback();
  markers["cite-2-ref-1"].focus();
  assert.ok(!isOpen(host));
  assert.equal(markers["cite-2-ref-1"].getAttribute("aria-describedby"), null);
  markers["cite-1-ref-1"].focus();
  assert.ok(isOpen(host));
  // Without its localized words there is no note link; the marker still is one.
  const plain = page({ noteLabel: null });
  plain.markers["cite-2-ref-1"].focus();
  assert.equal(plain.host.panel.find("ob-citation-preview-note"), null);
  assert.ok(plain.host.panel.find("ob-citation-preview-links").hidden);
});

test("the page's styles animate only without a reduced-motion preference and never print it", () => {
  const css = fs.readFileSync(new URL("../../web/base.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const motion = css.indexOf("@media (prefers-reduced-motion: no-preference) {\n  .ob-citation-preview:not([hidden])");
  assert.ok(motion > 0);
  const animated = [...css.matchAll(/ob-citation-preview-in/g)].map((match) => match.index);
  assert.ok(animated.every((at) => at > motion), "the preview's animation is declared only in the no-preference block");
  const preview = css.slice(css.indexOf(".ob-citation-preview {"), css.indexOf("}", css.indexOf(".ob-citation-preview {")));
  assert.ok(!/transition|animation/.test(preview), preview);
  const print = css.slice(css.indexOf("@media print {"));
  assert.match(print, /\.ob-citation-back,\n {2}\.ob-citation-preview \{\n {4}display: none !important;/);
  assert.match(css, /ob-citation-previews \{\n {2}display: none;/);
  // The width the component measures bounds the preview, not `100vw`.
  assert.match(preview, /\n {2}inline-size: 28rem;\n {2}max-inline-size: var\(--ob-citation-preview-max-inline-size, /);
});

// ---------- #67: hostile data, browser data and reading position ----------

test("hostile data shapes never pollute objects, throw, or reach another entry", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).join();
  const hostile = JSON.stringify({
    version: 1,
    constructor: { prototype: { polluted: true } },
    references: [
      { id: "__proto__", formatted: "proto", link: "https://example.org/" },
      { id: "constructor", formatted: "ctor" },
      { id: "toString", formatted: 42 },
      { id: "array", formatted: ["not", "text"] },
      { id: "object", formatted: { toString: "x" } },
      { id: "ok", formatted: "Fine", link: { href: "https://example.org/" } },
      { id: "ok", formatted: "A second entry for the same id is ignored", link: "https://evil.example/" },
    ],
    citations: [
      { marker: "__proto__", note: "cite-1", reference: "__proto__" },
      { marker: "constructor", note: "cite-2", reference: "constructor", formatted: { evil: 1 } },
      { marker: "m-to-string", note: "cite-3", reference: "toString" },
      { marker: "m-array", note: "cite-3", reference: "array" },
      { marker: "m-ok", note: "cite-4", reference: "ok", formatted: 7 },
      { marker: "m-ok", note: "cite-5", reference: "ok", formatted: "a later duplicate marker is ignored" },
      { marker: "", note: "cite-6", reference: "ok" },
      { marker: "m-no-note", note: "", reference: "ok" },
    ],
  }).replace('{"version":1,', '{"version":1,"__proto__":{"polluted":true},');
  assert.ok(hostile.includes('"__proto__":{"polluted":true}'));
  const previews = readReferences(hostile);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).join(), before);
  assert.deepEqual([...previews.keys()], ["__proto__", "constructor", "m-ok"]);
  assert.deepEqual(previews.get("__proto__"), { note: "cite-1", text: "proto", locators: "", link: "https://example.org/" });
  assert.equal(previews.get("constructor").locators, "", "a locator that is not text is dropped");
  assert.deepEqual(previews.get("m-ok"), { note: "cite-4", text: "Fine", locators: "", link: null });
  // Deep nesting, huge numbers and a document exactly at the budget never throw.
  assert.equal(readReferences(`${"[".repeat(100_000)}${"]".repeat(100_000)}`), null);
  assert.equal(readReferences('{"version":1e999,"references":[],"citations":[]}'), null);
  const padded = JSON.stringify({ version: 1, references: [], citations: [], pad: "" });
  const exact = padded.replace('"pad":""', `"pad":"${"x".repeat(1_000_000 - padded.length)}"`);
  assert.equal(exact.length, 1_000_000);
  assert.equal(readReferences(exact).size, 0, "at the budget it is read");
  assert.equal(readReferences(`${exact} `), null, "one character over it is not");
});

test("only absolute http(s) addresses with a host and no credentials survive, normalized", () => {
  for (const unsafe of [
    " javascript:alert(1)", "\u0000javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)",
    "javascript&colon;alert(1)", "jav&#x61;script:alert(1)", "data:,x", "blob:https://example.org/x",
    "about:blank", "ftp://example.org/", "ws://example.org/", "mailto:a@example.org", "tel:1",
    "https://user@example.org/", "https://:pw@example.org/", "http://", "https://",
    String.raw`\\example.org\x`, "[object Object]", undefined, {}, [], true,
  ]) {
    assert.equal(safeLink(unsafe), null, JSON.stringify(String(unsafe)));
  }
  // What remains is the browser's own serialization: no raw quote, bracket,
  // space or control character can come through into an attribute or text.
  for (const [value, expected] of [
    ["HTTPS://EXAMPLE.ORG/a b?q=<1>\"'", "https://example.org/a%20b?q=%3C1%3E%22%27"],
    ["https://example.org/\u202ex", "https://example.org/%E2%80%AEx"],
    [String.raw`https:\\example.org\x`, "https://example.org/x"],
    ["https://例え.jp/", "https://xn--r8jz45g.jp/"],
    ["  https://example.org/padded  ", "https://example.org/padded"],
    ["http:example.org", "http://example.org/"],
  ]) {
    assert.equal(safeLink(value), expected, value);
    assert.doesNotMatch(safeLink(value), /[\s"<>\u0000-\u001f\u202e]/);
  }
});

test("using previews changes no browser data, history, scroll position or the marker", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, markers, after } = page();
  const touched = [];
  const trap = (name) => () => {
    touched.push(name);
    throw new Error(`${name} was used`);
  };
  Object.defineProperty(document, "cookie", { configurable: true, get: trap("cookie read"), set: trap("cookie write") });
  globalThis.history = { pushState: trap("history.pushState"), replaceState: trap("history.replaceState"), back: trap("history.back") };
  window.scrollTo = trap("scrollTo");
  window.scrollBy = trap("scrollBy");
  const marker = markers["cite-1-ref-1"];
  const snapshot = () => Object.values(markers).map((m) => [m.id, m.href, m.getAttribute("role"), m.textContent, m.parentElement.localName]);
  const original = snapshot();
  // Every way of opening, using and closing a preview.
  marker.focus();
  host.panel.find("ob-citation-preview-source").focus();
  document.body.dispatch("keydown", { key: "Escape" });
  markers["cite-2-ref-1"].dispatch("pointerenter", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(250);
  markers["cite-2-ref-1"].dispatch("pointerleave", { pointerType: "mouse", bubbles: false });
  t.mock.timers.tick(300);
  after.focus();
  markers["cite-3-ref-1"].dispatch("pointerdown", { pointerType: "touch", isPrimary: true });
  markers["cite-3-ref-1"].focus();
  markers["cite-3-ref-1"].dispatch("click", { detail: 1 });
  window.fire(new FakeEvent("resize"));
  document.body.dispatch("pointerdown", { pointerType: "mouse", isPrimary: true });
  marker.dispatch("click", { detail: 0 });
  host.remove();
  host.disconnectedCallback();
  assert.deepEqual(touched, []);
  // The markers are exactly as they were: links to their notes, unchanged.
  assert.deepEqual(snapshot(), original);
  assert.equal(document.body.all().filter((node) => node.getAttribute("aria-describedby")).length, 0);
  delete globalThis.history;
});
