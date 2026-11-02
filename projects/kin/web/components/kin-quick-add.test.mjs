// Quick add puts focus back where the dialog was opened from (#469). The
// browser queues a dialog's close event, so these stubs hold close events
// until the test runs them, the way a slow task queue would.
import assert from "node:assert/strict";
import test from "node:test";

const queuedCloses = [];
const runQueuedCloses = () => { while (queuedCloses.length) queuedCloses.shift()(); };

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
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener(event); return true; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelectorAll() { return []; }
  focus() { globalThis.document.activeElement = this; }
  remove() { this.isConnected = false; }
}

class DialogStub extends ElementStub {
  constructor() { super("dialog"); this.open = false; }
  showModal() { this.open = true; this.previouslyFocused = globalThis.document.activeElement; }
  // Like the browser: close() puts focus back on whatever had it before
  // showModal(), then queues the close event.
  close(returnValue = "") {
    if (!this.open) return;
    this.open = false;
    this.returnValue = returnValue;
    if (this.previouslyFocused?.isConnected) this.previouslyFocused.focus();
    queuedCloses.push(() => this.dispatchEvent({ type: "close" }));
  }
}

globalThis.HTMLElement = class extends ElementStub {};
globalThis.Option = class extends ElementStub { constructor(label, value) { super("option"); this.textContent = label; this.value = value; } };
globalThis.location = { hash: "#today" };
globalThis.customElements = { define: (_name, component) => { globalThis.KinQuickAddUnderTest = component; } };
globalThis.document = {
  activeElement: null,
  createElement: (tagName) => (tagName === "dialog" ? new DialogStub() : new ElementStub(tagName)),
  createTextNode: (text) => ({ textContent: text }),
};
await import("./kin-quick-add.js");
const KinQuickAdd = globalThis.KinQuickAddUnderTest;

function quickAdd() {
  const element = new KinQuickAdd();
  element.connectedCallback();
  element.disabled = false;
  return element;
}

test("a late close event from a saved session can't take a newer session's fallback", () => {
  const quick = quickAdd();
  const heading = new ElementStub("h2");
  const fallback = () => heading;

  // Session 1: opened from the empty-state action and saved.
  const action = new ElementStub("button");
  action.focus();
  quick.open({ opener: action, fallback });
  quick.input.value = "Water the plants";
  quick.clearIfMatches({ text: "Water the plants", revision: quick.draftRevision });
  assert.equal(document.activeElement, action, "a save puts focus back on its opener");

  // Session 2 opens before session 1's close event has run. Its opener goes
  // away (the refresh removed the action), then it is cancelled.
  const nextAction = new ElementStub("button");
  nextAction.focus();
  quick.open({ opener: nextAction, fallback });
  nextAction.remove();
  quick.cancelButton.dispatchEvent({ type: "click" });
  runQueuedCloses();

  assert.equal(quick.dialog.open, false);
  assert.equal(document.activeElement, heading, "focus lands on the fallback heading, not the Quick add trigger");
});

test("Escape and other native closes still put focus back from the close event", () => {
  const quick = quickAdd();
  const action = new ElementStub("button");
  quick.open({ opener: action });
  quick.dialog.close();
  document.activeElement = null;
  runQueuedCloses();
  assert.equal(document.activeElement, action);
});
