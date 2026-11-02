// A small DOM stand-in for the control panel's component tests: elements,
// text, attributes, events, simple selectors and custom elements, enough to
// render and drive the panel without a browser. Selectors: tag, #id,
// .class, [attr], [attr="value"], and a tag followed by any of those,
// combined with a descendant space.

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export class FakeNode {
  constructor() { this.parentNode = null; }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === globalThis.document?.body;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}

export class FakeText extends FakeNode {
  constructor(text) { super(); this.data = String(text); }
  get textContent() { return this.data; }
}

export class FakeElement extends FakeNode {
  constructor(tagName = "div") {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    const element = this;
    this.dataset = new Proxy({}, {
      set(target, key, value) { target[key] = String(value); element.attributes[`data-${kebab(String(key))}`] = String(value); return true; },
      deleteProperty(target, key) { delete target[key]; delete element.attributes[`data-${kebab(String(key))}`]; return true; },
    });
  }
  get id() { return this.attributes.id ?? ""; }
  set id(value) { this.attributes.id = String(value); }
  get className() { return this.attributes.class ?? ""; }
  set className(value) { this.attributes.class = String(value); }
  get htmlFor() { return this.attributes.for ?? ""; }
  set htmlFor(value) { this.attributes.for = String(value); }
  get classList() { return { contains: (name) => this.className.split(/\s+/).includes(name) }; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) Reflect.set(this.dataset, camel(name.slice(5)), String(value));
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.remove?.();
      child.parentNode = this;
      this.children.push(child);
      if (child.isConnected) child.connectedCallback?.();
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  after(node) {
    const parent = this.parentNode;
    node.remove?.();
    const index = parent.children.indexOf(this);
    node.parentNode = parent;
    parent.children.splice(index + 1, 0, node);
  }
  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(...(value === "" ? [] : [new FakeText(value)])); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners[event.type] ?? []) listener.call(this, event);
    if (event.bubbles && this.parentNode?.dispatchEvent) this.parentNode.dispatchEvent(event);
    return true;
  }
  click() { this.dispatchEvent({ type: "click", bubbles: true, preventDefault() {} }); }
  submit() { this.dispatchEvent({ type: "submit", preventDefault() {} }); }
  focus() { globalThis.document.activeElement = this; }
  get elements() { return this.querySelectorAll("input, select"); }
  matches(selector) { return selector.split(",").some((part) => matchCompound(this, part.trim())); }
  *#descendants() {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      yield child;
      yield* child.#descendants();
    }
  }
  querySelectorAll(selector) {
    const parts = selector.split(",").map((part) => part.trim().split(/\s+/));
    const found = [];
    for (const node of this.#descendants()) {
      if (parts.some((chain) => matchChain(node, chain, this))) found.push(node);
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

// Properties a browser reflects into attributes, so selectors see them.
for (const name of ["scope", "name", "type", "href", "rel", "target", "role"]) {
  Object.defineProperty(FakeElement.prototype, name, {
    get() { return this.attributes[name] ?? ""; },
    set(value) { this.attributes[name] = String(value); },
    configurable: true,
  });
}

function matchCompound(node, selector) {
  const match = /^([a-z][a-z0-9-]*)?(.*)$/i.exec(selector);
  if (match[1] && node.tagName !== match[1].toUpperCase()) return false;
  const rest = match[2];
  for (const [, kind, name, value] of rest.matchAll(/([#.]|\[)([^\]#.=]+)(?:="?([^"\]]*)"?)?\]?/g)) {
    if (kind === "#" && node.id !== name) return false;
    if (kind === "." && !node.className.split(/\s+/).includes(name)) return false;
    if (kind === "[" && (value === undefined ? !node.hasAttribute(name) : node.getAttribute(name) !== value)) return false;
  }
  return true;
}

function matchChain(node, chain, root) {
  if (!matchCompound(node, chain.at(-1))) return false;
  let ancestor = node.parentNode;
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    while (ancestor && ancestor !== root && !(ancestor instanceof FakeElement && matchCompound(ancestor, chain[index]))) ancestor = ancestor.parentNode;
    if (!ancestor || ancestor === root) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

/** Installs the stand-in as the global document, HTMLElement and
 * customElements. Returns the document. */
export function installDom() {
  const registry = new Map();
  globalThis.HTMLElement = FakeElement;
  globalThis.customElements = {
    get: (name) => registry.get(name),
    define: (name, constructor) => { registry.set(name, constructor); },
  };
  // Node's own CustomEvent belongs to EventTarget; these elements need a
  // plain one whose target they can set.
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, { detail, bubbles } = {}) { this.type = type; this.detail = detail; this.bubbles = Boolean(bubbles); this.target = null; }
  };
  const document = {
    body: new FakeElement("body"),
    activeElement: null,
    createElement(tag) {
      const constructor = registry.get(tag.toLowerCase());
      const element = constructor ? new constructor() : new FakeElement(tag);
      element.tagName = tag.toUpperCase();
      return element;
    },
    createTextNode: (text) => new FakeText(text),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  };
  globalThis.document = document;
  return document;
}

/** Lets pending promise callbacks and zero-delay timers run. */
export const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
