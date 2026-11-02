// <kin-fridge size="display"> (#700): the kitchen display's fridge. The same
// room and access rules as everywhere; a wall-tablet layout, the notes again
// in large type, no full screen or hover titles, and a magnet's menu of nine
// big place buttons instead of a drop-down. The layout itself (64px tools,
// the door at 1280×800 and 800×1280) is checked in a real browser by
// scripts/kitchen-display-regression.mjs.
import assert from "node:assert/strict";
import test from "node:test";

// Minimal DOM stand-ins: only what the fridge uses outside drawing.
class Node {
  constructor(localName = "div") {
    this.localName = localName;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {}, left: "", top: "" };
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.isConnected = true;
  }
  get firstElementChild() { return this.children[0] ?? null; }
  append(...children) { for (const child of children) if (typeof child === "object") { child.remove(); child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  after(node) { const parent = this.parentElement; node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) ?? []) listener(event); return true; }
  setAttribute(name, value) {
    const before = this.getAttribute(name);
    this.attributes.set(name, String(value));
    if (name === "title") this.titleValue = String(value);
    this.attributeChangedCallback?.(name, before, String(value));
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) {
    const before = this.getAttribute(name);
    this.attributes.delete(name);
    if (name === "title") this.titleValue = undefined;
    this.attributeChangedCallback?.(name, before, null);
  }
  hasAttribute(name) { return this.attributes.has(name); }
  // `title` reflects its attribute, as on a real element.
  set title(value) { this.attributes.set("title", String(value)); this.titleValue = String(value); }
  get title() { return this.titleValue ?? ""; }
  contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  matches(selector) {
    const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) {
      const key = attr[1].startsWith("data-") ? attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null;
      const value = key ? this.dataset[key] : this.getAttribute(attr[1]);
      return value !== undefined && value !== null && (attr[2] === undefined || value === attr[2]);
    }
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
    return this.localName === selector;
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    let found = [this];
    for (const part of parts) found = found.flatMap((node) => [...node.walk()].filter((child) => child.matches(part)));
    return [...new Set(found)];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  click() { this.dispatchEvent({ type: "click", detail: 1 }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

let Fridge = null;
globalThis.HTMLElement = Node;
globalThis.customElements = { get: () => undefined, define: (name, component) => { if (name === "kin-fridge") Fridge = component; } };
globalThis.document = {
  createElement: (name) => new Node(name),
  createElementNS: (_ns, name) => new Node(name),
  activeElement: null,
  fullscreenEnabled: true,
  fullscreenElement: null,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
await import("./kin-fridge.js");

const ME = "a".repeat(32);
const OTHER = "b".repeat(32);
const board = {
  strokes: [],
  magnets: [
    { id: "m1", kind: "note", text: "Milk please", author: ME, x: 2048, y: 2730 },
    { id: "m2", kind: "emoji", emoji: "🍕", author: OTHER, x: 600, y: 600 },
    { id: "m3", kind: "note", text: "Dentist Thursday", author: OTHER, x: 3400, y: 4800 },
  ],
  openClear: null,
};
function room(access = "write") {
  const changes = [];
  return {
    access, changes, waiting: false, syncError: null,
    board: () => board,
    subscribe: () => () => {},
    change: async (command) => { changes.push(command); },
  };
}
function fridge({ access = "write", display = true } = {}) {
  const element = new Fridge();
  element.requestFullscreen = () => Promise.resolve();
  element.connectedCallback();
  element.memberId = ME;
  element.labelOf = (id) => (id === ME ? "you" : "Sam");
  element.room = room(access);
  if (display) element.setAttribute("size", "display");
  return element;
}

test("on the display the notes are repeated in large type, with who put them up", () => {
  const element = fridge();
  assert.equal(element.dataset.layout, "display");
  const notes = element.querySelector(".fridge-notes");
  assert.equal(notes.hidden, false);
  assert.deepEqual(element.querySelectorAll(".fridge-note").map((note) => note.children.map((part) => part.textContent)),
    [["Milk please", "from you"], ["Dentist Thursday", "from Sam"]], "only notes, in board order");
  // Off the display, the door alone shows them.
  element.removeAttribute("size");
  assert.equal(element.dataset.layout, undefined);
  assert.equal(element.querySelector(".fridge-notes").hidden, true);
});

test("on the display nothing needs a hover or full screen", () => {
  const element = fridge({ display: false });
  assert.equal(element.querySelector(".fridge-fullscreen").hidden, false, "the phone's fridge offers full screen");
  assert.ok(element.querySelectorAll(".fridge-colour").every((button) => button.title), "and tooltips on its swatches");
  element.setAttribute("size", "display");
  assert.equal(element.querySelector(".fridge-fullscreen").hidden, true, "the display is full screen already");
  assert.equal(element.querySelector(".fridge-kitchen-note").hidden, true);
  for (const selector of [".fridge-colour", ".fridge-width", ".fridge-magnet"])
    for (const button of element.querySelectorAll(selector)) {
      assert.equal(button.hasAttribute("title"), false, `${selector} has no hover title`);
      assert.ok(button.getAttribute("aria-label"), `${selector} keeps its name`);
    }
});

test("a magnet's menu on the display moves it with one big button per place", async () => {
  const element = fridge();
  const magnet = element.querySelector('[data-magnet-id="m1"]');
  magnet.dispatchEvent({ type: "click", detail: 0 });
  const menu = element.querySelector(".fridge-magnet-menu");
  assert.ok(menu, "the menu opens");
  assert.equal(menu.querySelector("select"), null, "no drop-down");
  const places = menu.querySelectorAll(".fridge-magnet-place");
  assert.deepEqual(places.map((button) => button.dataset.region),
    ["top-left", "top", "top-right", "left", "middle", "right", "bottom-left", "bottom", "bottom-right"]);
  assert.equal(document.activeElement, places[4], "the middle has the focus");
  places[0].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(element.querySelector(".fridge-magnet-menu"), null, "it closes");
  assert.equal(element.room.changes.at(-1)?.type, "move-magnet");
  assert.equal(element.room.changes.at(-1)?.magnetId, "m1");
  // The phone keeps its drop-down and Move.
  element.removeAttribute("size");
  element.querySelector('[data-magnet-id="m1"]').dispatchEvent({ type: "click", detail: 0 });
  assert.ok(element.querySelector(".fridge-magnet-menu select"));
});

test("the fridge's own access rules hold on the display", () => {
  const looking = fridge({ access: "read" });
  assert.equal(looking.querySelector(".fridge-tools").hidden, true, "look only: no tools");
  assert.equal(looking.querySelector(".fridge-notes").hidden, false, "but the notes still read");
  const none = fridge({ access: "none" });
  assert.equal(none.querySelector(".fridge-door").hidden, true);
  assert.equal(none.querySelector(".fridge-notes").hidden, true, "no access, no notes");
  const locked = fridge();
  locked.room = null;
  assert.equal(locked.querySelector(".fridge-notes").hidden, true, "locked, nothing shows");
});
