// DOM-contract tests for <ob-third-perspective> (#221, ADR 0114): native, labelled controls in
// fieldsets; publication, a shown name and clarification never assumed; no ranking or vote; errors
// announced on their field with focus there; an explicit pending state and a duplicate submit that
// waits; success always pending, with the receipt keeping the reader's consent; offline, network loss
// and failing services keeping the reflection with retry and a copy; a site without receipts, or a
// reader who does not publish, sending nothing; hostile data; no storage; and an article never changed.
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
  after(...nodes) {
    const parent = this.parentElement;
    let index = parent.children.indexOf(this) + 1;
    for (const node of nodes) {
      node.remove();
      node.parentElement = parent;
      parent.children.splice(index, 0, node);
      index += 1;
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

let Perspective;
globalThis.HTMLElement = Element;
globalThis.customElements = { get: () => undefined, define: (_name, constructor) => (Perspective = constructor) };
globalThis.window = new Target();
for (const name of ["localStorage", "sessionStorage", "indexedDB"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`no ${name}`);
    },
  });
}
const { attributedLabel, readAttributedSections, readSections, safeContact } = await import("../../web/components/ob-third-perspective.js");
const { readThirdPerspectiveSubmissionJson } = await import("../../web/components/third-perspective.js");

const HOSTILE = "<img src=x onerror=alert(1)> & </script>";
const REVISION = "p1:0123456789abcdef0123456789abcdef";
const digest = (n) => String(n).repeat(32).slice(0, 32);
const DATA = {
  version: 1,
  work: "/tides/",
  revision: REVISION,
  sections: [
    { index: 0, text: "The moon causes the tides.", digest: digest(1) },
    { index: 1, anchor: "methods", title: "Methods", text: "Methods We measured the tides.", digest: digest(2) },
    { index: 2, anchor: "hostile", title: HOSTILE, text: `${HOSTILE} Plain words.`, digest: digest(4) },
  ],
};

function page({ data = JSON.stringify(DATA), attributed, endpoint = "https://t.dev/api", contact, receipts = true, connect = true } = {}) {
  globalThis.document = new FakeDocument();
  globalThis.window = new Target();
  const script = new Element("script");
  script.id = "ob-passages";
  script.textContent = data;
  const article = new Element("article");
  const prose = new Element("div");
  prose.className = "ob-prose";
  prose.append("The moon causes the tides.");
  const section = new Element("section");
  section.id = "ob-third-perspective";
  const host = new Perspective();
  host.localName = "ob-third-perspective";
  if (endpoint !== null) host.setAttribute("endpoint", endpoint);
  host.setAttribute("page", "https://t.dev/tides/");
  if (contact !== undefined) host.setAttribute("contact", contact);
  if (receipts) host.setAttribute("receipts", "");
  const intro = new Element("p");
  intro.textContent = "Share your own reading of this work.";
  const fallback = new Element("p");
  fallback.className = "ob-third-perspective-static";
  fallback.textContent = "The form needs JavaScript.";
  host.append(intro, fallback);
  section.append(host);
  article.append(prose, section);
  document.body.append(script, article);
  if (attributed !== undefined) {
    const list = new Element("script");
    list.id = "ob-attributed-sections";
    list.textContent = attributed;
    document.body.append(list);
  }
  if (connect) host.connectedCallback();
  return { host, prose, intro, fallback, articleText: prose.textContent };
}

const parts = (host) => ({
  form: host.find("ob-third-perspective-form"),
  alert: host.find("ob-third-perspective-alert"),
  status: host.find("ob-third-perspective-status"),
  done: host.find("ob-third-perspective-done"),
  fallback: host.find("ob-third-perspective-fallback"),
  fallbackMessage: host.find("ob-third-perspective-fallback-message"),
  contact: host.find("ob-third-perspective-contact"),
  control: (suffix) => host.all().find((node) => node.id.endsWith(`-${suffix}`)),
  error: (name) => host.all().find((node) => node.id.endsWith(`-${name}-error`)),
  submit: host.all().find((node) => node.localName === "button" && node.type === "submit"),
  button: (text) => host.all().find((node) => node.localName === "button" && node.textContent === text),
  copyArea: host.all().find((node) => node.localName === "textarea" && node.readOnly),
});

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

function fill(view, { body = "Another way to read the ending.", publish = "yes", category, section, name, showName, clarification, feature } = {}) {
  const ui = parts(view.host);
  ui.control("body").value = body;
  if (publish) ui.control(`publish-${publish}`).checked = true;
  if (category) ui.control(`category-${category}`).checked = true;
  if (section !== undefined) {
    ui.control("section-select").value = String(section);
    ui.control("section-select").dispatch("change");
  }
  if (name !== undefined) ui.control("name").value = name;
  if (showName !== undefined) ui.control("show-name").checked = showName;
  if (clarification !== undefined) ui.control("clarification").checked = clarification;
  if (feature !== undefined) ui.control("feature").checked = feature;
  return ui;
}

const submitted = async (view) => {
  parts(view.host).form.dispatch("submit");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const RECEIPT = "R".repeat(43);

test("the static text stays without data, an endpoint, or JavaScript's custom element", () => {
  for (const options of [{ data: "not json" }, { endpoint: null }, { endpoint: "http://insecure.example" }, { data: JSON.stringify({ ...DATA, version: 2 }) }]) {
    const view = page(options);
    assert.ok(view.host.find("ob-third-perspective-static"), JSON.stringify(options));
    assert.equal(parts(view.host).form, null);
  }
  assert.equal(readSections(JSON.stringify({ ...DATA, sections: [{ index: 1, digest: digest(1) }] })), null, "a shifted index is never trusted");
  assert.equal(safeContact("javascript:alert(1)"), null);
  assert.equal(safeContact("mailto:ada@example.org?subject=x"), null);
});

test("every control is native and labelled, the choices are fieldsets with legends, and nothing ranks or votes", () => {
  const view = page();
  const ui = parts(view.host);
  assert.equal(view.host.find("ob-third-perspective-static"), null, "the static paragraph is replaced");
  assert.equal(view.intro.parentElement, view.host, "the introduction stays");
  const labels = view.host.all().filter((node) => node.localName === "label");
  for (const control of view.host.all().filter((node) => ["input", "select", "textarea"].includes(node.localName))) {
    assert.ok(labels.some((label) => label.htmlFor === control.id), `${control.localName}#${control.id} has a label`);
  }
  const legends = view.host.all().filter((node) => node.localName === "legend").map((node) => node.textContent);
  assert.deepEqual(legends, ["What is it about?", "A prompt (optional)", "May it be published?", "Your name (optional)"]);
  const text = view.host.textContent;
  // The only words about ratings or votes say there are none.
  assert.doesNotMatch(text.replace(/there are no ratings, votes or sides/gi, ""), /\b(score|rating|rank|vote|upvote|star)s?\b/i);
  for (const node of view.host.all()) assert.doesNotMatch(`${node.className} ${node.getAttribute("name") ?? ""}`, /rank|vote|score|rating/);
  // Publication is never assumed, a name is never shown by default, and nobody is asked to clarify without saying so.
  assert.equal(ui.control("publish-yes").checked, false);
  assert.equal(ui.control("publish-no").checked, false);
  assert.equal(ui.control("show-name").checked, false);
  // Choosing to show a name says it becomes part of the site's public record.
  assert.match(document.getElementById(ui.control("show-name").getAttribute("aria-describedby")).textContent, /becomes part of the site’s public record.*copies already published may remain/);
  assert.equal(ui.control("clarification").checked, false);
  assert.equal(ui.control("category-none").checked, true, "no prompt is a complete choice");
  // A hostile section title is text.
  assert.ok(ui.control("section-select").options.some((option) => option.textContent === HOSTILE));
  // Each prompt's question describes its choice.
  const prompt = ui.control("category-connection");
  assert.equal(document.getElementById(prompt.getAttribute("aria-describedby")).textContent, "What does this bring to mind: another work, idea or source?");
});

test("choosing nothing about publication is announced on that choice, with focus there, and nothing is sent", async () => {
  noFetch();
  const view = page();
  const ui = fill(view, { publish: null });
  await submitted(view);
  assert.equal(ui.alert.textContent, "Choose whether your reflection may be published.");
  const yes = ui.control("publish-yes");
  assert.equal(yes.getAttribute("aria-invalid"), "true");
  assert.equal(document.activeElement, yes);
  assert.match(yes.getAttribute("aria-describedby"), /-publication-error$/);
});

test("an empty or overlong reflection, and a shown name without a name, are each marked on their field", async () => {
  noFetch();
  for (const [options, field, message] of [
    [{ body: "   " }, "body", /Write your reflection/],
    [{ body: "a".repeat(4001) }, "body", /Write your reflection/],
    [{ showName: true }, "show-name", /Enter your name/],
    [{ name: "Ada‮" }, "name", /plain text of up to 80/],
  ]) {
    const view = page();
    const ui = fill(view, options);
    await submitted(view);
    const control = ui.control(field);
    assert.equal(control.getAttribute("aria-invalid"), "true", field);
    assert.equal(document.activeElement, control);
    assert.match(ui.alert.textContent, message);
    assert.notEqual(ui.control("body").value, "", "nothing is cleared");
  }
});

test("a reflection is sent with exactly the reader's choices and enters pending; the receipt keeps their consent", async () => {
  const calls = fakeFetch({ status: 202, body: { status: "pending", receipt: RECEIPT } });
  const view = page();
  const ui = fill(view, { category: "question", section: 1, name: "  Ada  ", showName: true, clarification: true, body: `  ${HOSTILE}  ` });
  await submitted(view);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://t.dev/api/feedback");
  assert.equal(calls[0].options.credentials, "omit");
  const sent = calls[0].body;
  assert.deepEqual({ ...sent, seenAt: undefined }, {
    version: 1, kind: "third-perspective", work: "/tides/", revision: REVISION,
    target: { version: 1, kind: "section", section: "methods", digest: digest(2) }, category: "question", body: HOSTILE,
    seenAt: undefined, attribution: { name: "Ada", publishName: true }, consent: { publish: true, clarification: true, feature: false },
  });
  assert.ok(readThirdPerspectiveSubmissionJson(JSON.stringify(sent)).ok, "the shared validator accepts what is sent");
  for (const field of ["rank", "rating", "score", "vote"]) assert.ok(!(field in sent));
  assert.equal(ui.done.hidden, false);
  assert.equal(document.activeElement, ui.done);
  assert.match(ui.done.textContent, /published only if a moderator approves it/);
  assert.equal(ui.control("body").value, "", "the reflection was sent");
  assert.equal(ui.control("name").value, "  Ada  ", "the name stays for another");
  const receipt = view.host.all().find((node) => node.localName === "input" && node.value === RECEIPT);
  assert.ok(receipt, "the receipt is shown once");
  const consent = view.host.all().find((node) => node.localName === "input" && node.type === "checkbox" && node.id.endsWith("-consent") && node.id.startsWith("ob-receipt"));
  assert.equal(consent.checked, true, "the receipt shows the consent already given");
  assert.ok(view.host.all().some((node) => node.textContent === "Check, clarify or withdraw a reflection you sent"), "readers can use a receipt here");
});

test("feature consent is its own unticked choice, says copies may remain, and is sent only when ticked", async () => {
  const unticked = fakeFetch({ status: 202, body: { status: "pending", receipt: RECEIPT } });
  const view = page();
  const ui = fill(view);
  const box = ui.control("feature");
  assert.equal(box.checked, false, "never ticked for the reader");
  assert.equal(box.type, "checkbox");
  const label = view.host.all().find((node) => node.localName === "label" && node.htmlFor === box.id);
  assert.match(label.textContent, /feature my reflection/);
  const hint = view.host.all().find((node) => node.id === box.getAttribute("aria-describedby"));
  assert.match(hint.textContent, /Separate from publishing/);
  assert.match(hint.textContent, /copies already published may remain/);
  await submitted(view);
  assert.equal(unticked[0].body.consent.feature, false);
  const ticked = fakeFetch({ status: 202, body: { status: "pending", receipt: RECEIPT } });
  const again = page();
  fill(again, { feature: true });
  await submitted(again);
  assert.equal(ticked[0].body.consent.feature, true);
  assert.ok(readThirdPerspectiveSubmissionJson(JSON.stringify(ticked[0].body)).ok);
  const agreed = again.host.all().find((node) => node.localName === "input" && node.type === "checkbox" && node.id.endsWith("-feature") && node.id.startsWith("ob-receipt"));
  assert.equal(agreed.checked, true, "the receipt shows what was agreed");
});

test("a pending state is explicit and a second submit waits", async () => {
  let release;
  const calls = fakeFetch(() => new Promise((resolve) => { release = () => resolve({ status: 202, ok: true, json: async () => ({ status: "pending" }) }); }));
  const view = page();
  const ui = fill(view);
  ui.form.dispatch("submit");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.form.getAttribute("aria-busy"), "true");
  assert.equal(ui.submit.getAttribute("aria-disabled"), "true");
  assert.equal(ui.submit.textContent, "Sending…");
  assert.equal(ui.status.textContent, "Sending your reflection…");
  ui.form.dispatch("submit");
  assert.equal(calls.length, 1, "a duplicate submit is not sent");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.form.getAttribute("aria-busy"), null);
  assert.equal(ui.status.textContent, "Sent for review.");
});

test("offline, network loss and a failing service keep the reflection, and offer retry and a copy", async () => {
  for (const [answer, reason, retry] of [
    [new Error("network"), /did not answer/, true],
    [{ status: 502, body: { code: "x" } }, /had a problem/, true],
    [{ status: 429, body: { code: "rateLimited" } }, /too many/, true],
    [{ status: 404, body: { code: "unavailable" } }, /not taking reflections/, false],
  ]) {
    const calls = fakeFetch(answer, { status: 202, body: { status: "pending", receipt: RECEIPT } });
    const view = page({ contact: "mailto:author@example.org" });
    const ui = fill(view, { body: "Kept words." });
    await submitted(view);
    assert.equal(ui.fallback.hidden, false);
    assert.match(ui.fallbackMessage.textContent, reason);
    assert.equal(document.activeElement, ui.fallbackMessage);
    assert.equal(ui.control("body").value, "Kept words.", "nothing is lost");
    assert.match(ui.copyArea.value, /Kept words\./);
    assert.match(ui.contact.href, /^mailto:author@example\.org\?subject=/);
    const again = ui.button("Try again");
    assert.equal(again.hidden, !retry);
    if (retry) {
      again.dispatch("click");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls.length, 2, "trying again sends the same reflection");
      assert.deepEqual(calls[1].body, calls[0].body);
      assert.equal(ui.done.hidden, false);
    }
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  noFetch();
  const view = page();
  const ui = fill(view);
  await submitted(view);
  assert.match(ui.fallbackMessage.textContent, /offline/);
  assert.equal(ui.button("Try again").hidden, false);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
});

test("a refused field from the service is marked on that field; a closed work and a duplicate say so", async () => {
  fakeFetch({ status: 422, body: { code: "invalidBody" } });
  let view = page();
  let ui = fill(view);
  await submitted(view);
  assert.equal(ui.control("body").getAttribute("aria-invalid"), "true");
  fakeFetch({ status: 403, body: { code: "closed" } });
  view = page();
  ui = fill(view);
  await submitted(view);
  assert.match(ui.fallbackMessage.textContent, /not taking Third Perspectives now/);
  fakeFetch({ status: 409, body: { code: "duplicate" } });
  view = page();
  ui = fill(view);
  await submitted(view);
  assert.equal(ui.status.textContent, "This reflection was already sent and is waiting for review.");
  assert.equal(ui.fallback.hidden, true);
});

test("choosing not to publish, or a site without receipts, never sends anything and offers the copy", async () => {
  noFetch();
  let view = page();
  let ui = fill(view, { publish: "no", name: "Ada" });
  await submitted(view);
  assert.match(ui.fallbackMessage.textContent, /chose not to publish it, so it was not sent/);
  assert.match(ui.copyArea.value, /Not for publication: for the author only\./);
  assert.doesNotMatch(ui.copyArea.value, /open\.blog Third Perspective record/);
  assert.equal(ui.button("Try again").hidden, true);
  view = page({ receipts: false, contact: "https://t.dev/contact/" });
  ui = parts(view.host);
  assert.equal(ui.submit.textContent, "Prepare to send to the author");
  ui = fill(view);
  await submitted(view);
  assert.match(ui.fallbackMessage.textContent, /ready/);
  assert.match(ui.copyArea.value, /open\.blog Third Perspective record/);
  assert.equal(ui.contact.href, "https://t.dev/contact/");
  assert.equal(view.host.all().some((node) => node.textContent === "Check, clarify or withdraw a note you sent"), false);
});

test("the article is never changed and nothing is stored in the browser", async () => {
  fakeFetch();
  const view = page();
  fill(view);
  await submitted(view);
  assert.equal(view.prose.textContent, view.articleText);
});

// ---- One author's section of a shared reflection (#223, ADR 0131)

const ATTRIBUTED = {
  version: 1,
  work: "/tides/",
  sections: [
    { anchor: "ob-by-mina-0", contributor: "mina", nth: 0, author: "MINA", excerpt: "The moon pulls the water.", digest: digest(5) },
    { anchor: "ob-by-joe-0", contributor: "joe", nth: 0, author: "JOE", excerpt: "It is also the sun.", digest: digest(6) },
    { anchor: "ob-by-mina-1", contributor: "mina", nth: 1, author: HOSTILE, excerpt: `${HOSTILE} Neither explains the harbour…`, digest: digest(7) },
  ],
};

test("author sections are read only when every one is exactly what the build writes", () => {
  const read = readAttributedSections(JSON.stringify(ATTRIBUTED), "/tides/");
  assert.equal(read.sections.length, 3);
  assert.equal(attributedLabel(read.sections[0]), "MINA, section 1: “The moon pulls the water.”");
  assert.equal(attributedLabel(read.sections[2]).startsWith(`${HOSTILE}, section 2`), true, "hostile text stays text");
  const bad = (change) => {
    const data = structuredClone(ATTRIBUTED);
    change(data);
    return readAttributedSections(JSON.stringify(data), "/tides/");
  };
  assert.equal(readAttributedSections(JSON.stringify(ATTRIBUTED), "/other/"), null, "another work's list is not this page's");
  assert.equal(readAttributedSections("not json", "/tides/"), null);
  assert.equal(readAttributedSections(undefined, "/tides/"), null);
  assert.equal(bad((data) => { data.version = 2; }), null);
  assert.equal(bad((data) => { data.sections = []; }), null);
  assert.equal(bad((data) => { data.sections[0].anchor = "ob-by-Mina-0"; data.sections[0].contributor = "Mina"; }), null, "not a registry key");
  assert.equal(bad((data) => { data.sections[0].nth = 1; }), null, "anchor and place disagree");
  assert.equal(bad((data) => { data.sections[0].contributor = "joe"; }), null, "anchor and contributor disagree");
  assert.equal(bad((data) => { data.sections[0].anchor = "ob-by-mina-00"; }), null);
  assert.equal(bad((data) => { data.sections[1].digest = "xyz"; }), null);
  assert.equal(bad((data) => { data.sections[1].author = ""; }), null);
});

test("without the build's list the form is exactly as before; with it, an author's section is a third, labelled choice", () => {
  const before = parts(page().host);
  const without = page({ attributed: "not json" });
  assert.equal(parts(without.host).control("author-section"), undefined, "an unreadable list adds nothing");
  const view = page({ attributed: JSON.stringify(ATTRIBUTED) });
  const ui = parts(view.host);
  assert.equal(before.control("author-section"), undefined);
  const radio = ui.control("author-section");
  const select = ui.control("author-select");
  assert.equal(radio.type, "radio");
  assert.equal(radio.checked, false, "the whole work stays the default");
  assert.deepEqual(select.options.map((option) => option.textContent).slice(0, 2), ["MINA, section 1: “The moon pulls the water.”", "JOE, section 1: “It is also the sun.”"]);
  const labels = view.host.all().filter((node) => node.localName === "label");
  for (const control of [radio, select]) assert.ok(labels.some((label) => label.htmlFor === control.id), `${control.localName} has a label`);
  const legends = view.host.all().filter((node) => node.localName === "legend").map((node) => node.textContent);
  assert.deepEqual(legends, ["What is it about?", "A prompt (optional)", "May it be published?", "Your name (optional)"], "no new group, no ranking");
  // Choosing from the list selects the choice.
  select.value = "1";
  select.dispatch("change");
  assert.equal(radio.checked, true);
  assert.doesNotMatch(view.host.textContent, /\b(left|right|column|side)\b/i, "an author's section is never named by a side");
});

test("a reflection about an author's section is sent as the ordinary section target of that author and text", async () => {
  const calls = fakeFetch({ status: 202, body: { status: "pending", receipt: RECEIPT } });
  const view = page({ attributed: JSON.stringify(ATTRIBUTED) });
  const ui = fill(view);
  ui.control("author-select").value = "1";
  ui.control("author-select").dispatch("change");
  await submitted(view);
  assert.equal(calls.length, 1);
  const sent = calls[0].body;
  assert.deepEqual(sent.target, { version: 1, kind: "section", section: "ob-by-joe-0", digest: digest(6) });
  // The shared validator reads it as the build does.
  assert.equal(readThirdPerspectiveSubmissionJson(JSON.stringify(sent)).ok, true);
  assert.equal(sent.consent.publish, true);
  assert.equal(JSON.stringify(sent).includes("excerpt"), false, "the excerpt is for the reader's list only");
  // A section by the same contributor later in the work is its own choice.
  const second = fakeFetch({ status: 202, body: { status: "pending", receipt: RECEIPT } });
  const again = page({ attributed: JSON.stringify(ATTRIBUTED) });
  const filled = fill(again);
  filled.control("author-select").value = "2";
  filled.control("author-select").dispatch("change");
  await submitted(again);
  assert.equal(second[0].body.target.section, "ob-by-mina-1");
});

test("a site without receipts prepares a copy that names the author, never a side, and sends nothing", async () => {
  noFetch();
  const view = page({ attributed: JSON.stringify(ATTRIBUTED), receipts: false });
  const ui = fill(view);
  ui.control("author-select").value = "0";
  ui.control("author-select").dispatch("change");
  await submitted(view);
  const copy = parts(view.host).copyArea.value;
  assert.match(copy, /About: One author’s section: by mina, section 1/);
  assert.doesNotMatch(copy.split("open.blog Third Perspective record")[0], /ob-by-/, "the copy says it in words");
  assert.match(copy, /"section":"ob-by-mina-0"/, "the record line the author can enter keeps the exact target");
});
