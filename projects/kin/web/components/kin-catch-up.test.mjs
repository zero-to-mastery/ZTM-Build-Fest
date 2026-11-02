import assert from "node:assert/strict";
import test from "node:test";

// Minimal DOM stubs so the component renders under node:test without a browser.
class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.textContent = "";
    this.hidden = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

globalThis.HTMLElement = class extends ElementStub {};
globalThis.customElements = {
  define: (name, component) => {
    if (name === "kin-catch-up") globalThis.KinCatchUpUnderTest = component;
  },
};
globalThis.document = {
  createElement: (tagName) => new ElementStub(tagName),
  activeElement: null,
};
await import("./kin-catch-up.js");
const KinCatchUp = globalThis.KinCatchUpUnderTest;

function renderedLines(entries) {
  const element = new KinCatchUp();
  element.connectedCallback();
  element.summary = { entries, totalCount: entries.length };
  return element.list.children.map((item) => item.textContent);
}

test("catch up names the list each item was actually added to", () => {
  const lines = renderedLines([
    { kind: "item-added", text: "today", classification: "today" },
    { kind: "item-added", text: "needs", classification: "need" },
    { kind: "item-added", text: "shopping", classification: "shopping" },
    { kind: "item-added", text: "staples", classification: "staple" },
  ]);
  assert.deepEqual(lines, [
    "today added to Today",
    "needs added to To do",
    "shopping added to Shopping",
    "staples added to Staples",
  ]);
});

test("catch up never reports a Shopping or Staples item as added to To do", () => {
  const lines = renderedLines([
    { kind: "item-added", text: "milk", classification: "shopping" },
    { kind: "item-added", text: "rice", classification: "staple" },
  ]);
  for (const line of lines) assert.doesNotMatch(line, /added to To do/);
});

test("catch up falls back to a neutral destination for an unknown classification", () => {
  const lines = renderedLines([
    { kind: "item-added", text: "mystery", classification: "later" },
  ]);
  assert.deepEqual(lines, ["mystery added to your lists"]);
});

test("catch up keeps lifecycle changes anchored to their existing destination", () => {
  const lines = renderedLines([
    { kind: "item-completed", text: "Milk", classification: "shopping" },
    { kind: "item-reopened", text: "Call plumber", classification: "need" },
    { kind: "item-archived", text: "Old task", classification: "today" },
    { kind: "handoff-acknowledged", text: "School pickup" },
    { kind: "talk-resolved", text: "Weekend plans" },
  ]);
  assert.deepEqual(lines, [
    "Milk handled in Shopping",
    "Call plumber reopened in To do",
    "Old task archived from Today",
    "School pickup acknowledged in Handoff",
    "Weekend plans resolved in Talk",
  ]);
});
