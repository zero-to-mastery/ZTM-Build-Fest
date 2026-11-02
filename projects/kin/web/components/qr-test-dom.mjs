// A small DOM stand-in for the QR component tests: enough element, event and
// canvas behaviour to render <kin-qr> and <kin-qr-scanner> without a browser.

export class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.className = "";
    this._text = "";
    this.isConnected = false;
  }
  append(...nodes) {
    for (const node of nodes) if (node && typeof node === "object") node.parentNode = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
    if (this.isConnected) {
      this.isConnected = false;
      this.disconnectedCallback?.();
    }
  }
  focus() { globalThis.document.activeElement = this; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener); }
  dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener(event); return true; }
  click() { this.dispatchEvent({ type: "click" }); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent ?? "").join(""); }
  /** Every descendant, depth first. */
  *all() {
    for (const child of this.children) {
      yield child;
      if (child instanceof FakeElement) yield* child.all();
    }
  }
  find(predicate) {
    for (const node of this.all()) if (predicate(node)) return node;
    return null;
  }
  byClass(name) { return this.find((node) => node.className?.split(" ").includes(name)); }
  byText(text) { return this.find((node) => node.tagName === "BUTTON" && node._text === text); }
}

/** A canvas whose 2D context records every fillRect. */
export class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.width = 300;
    this.height = 150;
    this.context = { fills: [], fillStyle: "", fillRect(x, y, w, h) { this.fills.push([this.fillStyle, x, y, w, h]); } };
  }
  getContext() { return this.context; }
}

/** Installs the stand-in globals. The element classes register through
 * customElements.define; their constructors are returned by name. */
export function installDom() {
  const defined = {};
  const documentListeners = {};
  globalThis.HTMLElement = class extends FakeElement {};
  globalThis.customElements = { define: (name, component) => { defined[name] = component; } };
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.bubbles = init.bubbles; } };
  globalThis.document = {
    visibilityState: "visible",
    createElement: (tag) => (tag === "canvas" ? new FakeCanvas() : defined[tag] ? new defined[tag]() : new FakeElement(tag)),
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener: (type, listener) => (documentListeners[type] ??= []).push(listener),
    removeEventListener: (type, listener) => { documentListeners[type] = (documentListeners[type] ?? []).filter((l) => l !== listener); },
    fire: (type) => { for (const listener of documentListeners[type] ?? []) listener({ type }); },
    listenerCount: (type) => (documentListeners[type] ?? []).length,
  };
  return defined;
}

/** Collects events an element dispatches, by type. */
export function recordEvents(element) {
  const seen = [];
  const original = element.dispatchEvent.bind(element);
  element.dispatchEvent = (event) => { seen.push(event); return original(event); };
  return seen;
}

/** Connects an element as the browser would. */
export function connect(element) {
  element.isConnected = true;
  element.connectedCallback?.();
  return element;
}

export function disconnect(element) {
  element.isConnected = false;
  element.disconnectedCallback?.();
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
