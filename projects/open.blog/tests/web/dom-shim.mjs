// A small DOM stand-in for the admin's node tests: elements, text, events, focus and the few
// selectors the panels use. Shared by the tests of panels that are built with `h()`.

// ---------------------------------------------------------------- DOM shim

export class DomNode {
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

export function installDom() {
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

export const withDom = (run) => async () => {
  const dom = installDom();
  try {
    await run(dom);
  } finally {
    dom.restore();
  }
};

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const type = (node, value) => {
  node.value = value;
  return node.dispatch("input", { target: node });
};
export const choose = (node, value) => {
  node.value = value;
  return node.dispatch("change", { target: node });
};

// What the visual editor needs beyond the citation tests' shim.
DomNode.prototype.after = function after(...nodes) {
  const parent = this.parentNode;
  for (const node of nodes) parent.adopt(node);
  parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, ...nodes);
};
DomNode.prototype.insertBefore = function insertBefore(node, reference) {
  this.adopt(node);
  const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
  this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
  return node;
};
DomNode.prototype.click = function click() {
  return this.disabled ? Promise.resolve() : this.dispatch("click");
};
Object.defineProperty(DomNode.prototype, "lastChild", { get() { return this.childNodes[this.childNodes.length - 1] || null; } });
