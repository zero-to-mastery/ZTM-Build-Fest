// #267: a capture says "saved here" until the relay accepts it, then "sent";
// it never claims more than the app knows.
import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.isConnected = true;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelectorAll() { return []; }
  focus() {}
}

globalThis.HTMLElement = class extends ElementStub {};
globalThis.customElements = { define: (_name, component) => { globalThis.KinComposeUnderTest = component; } };
globalThis.document = {
  createElement: (tagName) => new ElementStub(tagName),
  createTextNode: (text) => ({ textContent: text }),
};
await import("./kin-compose.js");
const KinCompose = globalThis.KinComposeUnderTest;

function composer() {
  const element = new KinCompose();
  element.attributeChangedCallback("mode", null, "today");
  element.connectedCallback();
  return element;
}
const text = (element) => element.result.children.map((part) => part.textContent).join("");

test("waiting to sync stays visible and only markShared turns it into sent", () => {
  const element = composer();
  element.showResult("Saved here. Waiting to sync.", { kind: "pending-sync" });
  assert.equal(element.result.hidden, false);
  assert.equal(element.result.dataset.kind, "pending-sync");
  assert.equal(element.markShared(), true);
  assert.equal(text(element), "Saved and sent to your household.");
  assert.equal(element.result.dataset.kind, "saved");
  clearTimeout(element.resultTimer);
  // Already settled: a second confirmation changes nothing.
  assert.equal(element.markShared(), false);
});

test("an error or a local-only save is never upgraded to sent", () => {
  const element = composer();
  element.showResult("Kin couldn't save that.", { kind: "error" });
  assert.equal(element.markShared(), false);
  assert.equal(text(element), "Kin couldn't save that.");
  element.showResult("Saved on this device.");
  assert.equal(element.markShared(), false, "a device without sync never claims to have sent anything");
  clearTimeout(element.resultTimer);
});

test("a new capture clears a waiting line, so a later confirmation can't relabel it", () => {
  const element = composer();
  element.showResult("Saved here. Waiting to sync.", { kind: "pending-sync" });
  element.clearResult();
  assert.equal(element.markShared(), false);
  assert.equal(element.result.hidden, true);
});

test("the Today capture says where an item will go before Add (#265)", () => {
  const element = composer();
  assert.equal(element.input.attributes["aria-describedby"], element.destination.id);
  assert.equal(element.destination.textContent, "Adds to To do, planned for today.");
  element.classification.value = "shopping";
  element.plan.value = "none";
  element.renderDestination();
  assert.equal(element.destination.textContent, "Adds to Shopping, with no date.");
  element.plan.value = "date";
  element.renderDestination();
  assert.equal(element.destination.textContent, "Adds to Shopping, on the date you pick.");
  element.planDate.value = "2026-10-24";
  element.renderDestination();
  assert.equal(element.destination.textContent, "Adds to Shopping, planned for 2026-10-24.");
  element.restoreDraft();
  assert.equal(element.destination.textContent, "Adds to To do, planned for today.", "a reset draft resets the line");
});

test("a list capture keeps its fixed destination and has no destination line", () => {
  const element = new KinCompose();
  element.attributeChangedCallback("fixed-classification", null, "shopping");
  element.connectedCallback();
  assert.equal(element.destination, undefined);
  assert.equal(element.input.placeholder, "Add to Shopping");
});
