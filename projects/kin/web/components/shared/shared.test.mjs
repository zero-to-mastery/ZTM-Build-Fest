import assert from "node:assert/strict";
import test from "node:test";

import { button, field, message, section, text } from "./dom.js";
import { OperationGuard } from "./operation.js";
import { asArray, defineProps } from "./props.js";
import { captureFocus, restoreFocus } from "./focus.js";
import { assertCurrentSession, captureSession, isCurrentSession, reconnectLostAuthorization } from "./session-guard.js";

// Minimal DOM stand-ins; only what the shared helpers use.
class Node {
  constructor(localName) {
    this.localName = localName;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.open = false;
    this.isConnected = true;
    this.disabled = false;
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
  querySelector(selector) {
    const className = selector.slice(1);
    for (const child of this.children) {
      if (child.className === className) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  closest(selector) {
    for (let current = this; current; current = current.parentElement)
      if (selector === "[hidden]" && current.hidden) return current;
    return null;
  }
  focus() { globalThis.document.activeElement = this; }
}
globalThis.document = { createElement: (name) => new Node(name), activeElement: null };

test("a persisted sync binding locks on reconnect even without cached household settings", () => {
  assert.equal(reconnectLostAuthorization({ loaded: true, identity: null }, true), true);
  assert.equal(reconnectLostAuthorization({ loaded: true, identity: null }, false), false);
  assert.equal(reconnectLostAuthorization({ loaded: false, identity: null }, true), false);
  assert.equal(reconnectLostAuthorization({ loaded: true, identity: { householdId: "current" } }, true), false);
});

test("dom builders create native elements with text content only", () => {
  const host = new Node("div");
  let clicked = 0;
  const control = button("Save <b>", () => { clicked += 1; }, { className: "primary", disabled: true, parent: host });
  assert.equal(control.localName, "button");
  assert.equal(control.type, "button");
  assert.equal(control.textContent, "Save <b>");
  assert.equal(control.className, "primary");
  assert.equal(control.disabled, true);
  control.listeners.click();
  assert.equal(clicked, 1);
  assert.equal(host.children[0], control);
  const paragraph = text("<script>", { parent: host });
  assert.equal(paragraph.localName, "p");
  assert.equal(paragraph.textContent, "<script>");
  const block = section("Recovery", { className: "security-section", parent: host });
  assert.equal(block.children[0].localName, "h3");
  assert.equal(block.children[0].textContent, "Recovery");
  const input = new Node("input");
  const label = field("Name", input, { hint: "Shown to members" });
  assert.deepEqual(label.children.map((child) => child.localName), ["span", "input", "small"]);
});

test("message reuses one live region and switches politeness", () => {
  const host = new Node("div");
  const first = message(host, "Saved.", { className: "household-message" });
  const second = message(host, "Failed.", { alert: true, className: "household-message" });
  assert.equal(first, second);
  assert.equal(second.attributes.role, "alert");
  assert.equal(second.textContent, "Failed.");
  assert.equal(host.children.length, 1);
});

test("operation guard runs one action at a time and drops stale failures", async () => {
  const host = new Node("div");
  const errors = [];
  const busy = [];
  const guard = new OperationGuard(host, { onError: (error) => errors.push(error.message), onBusy: (value) => busy.push(value) });
  let release;
  const first = guard.run(() => new Promise((resolve) => { release = resolve; }));
  assert.equal(guard.busy, true);
  assert.equal(host.attributes["aria-busy"], "true");
  await guard.run(() => { throw new Error("ignored while busy"); });
  release();
  await first;
  assert.equal(guard.busy, false);
  await guard.run(() => { throw new Error("reported"); });
  assert.deepEqual(errors, ["reported"]);
  const stale = guard.run(async () => { await null; throw new Error("stale"); });
  guard.cancel();
  await stale;
  assert.deepEqual(errors, ["reported"]);
  assert.throws(() => guard.assertCurrent(1, "cancelled"), /cancelled/);
  assert.deepEqual(busy, [true, false, true, false, true, false]);
  const blocked = new OperationGuard(host, { canStart: () => false });
  let ran = false;
  await blocked.run(() => { ran = true; });
  assert.equal(ran, false);
});

test("defineProps coalesces assignments into one microtask render", async () => {
  class List { constructor() { this.renders = 0; } render() { this.renders += 1; } }
  defineProps(List, { items: { field: "records", coerce: asArray }, mode: {} });
  const list = new List();
  list.items = "not an array";
  list.items = [1, 2];
  list.mode = "today";
  assert.equal(list.renders, 0);
  assert.deepEqual(list.records, [1, 2]);
  assert.equal(list.mode, "today");
  await null;
  assert.equal(list.renders, 1);
  list.items = [3];
  assert.equal(list.flushRender(), true);
  assert.equal(list.renders, 2);
  await null;
  assert.equal(list.renders, 2, "a flushed batch does not render again");
});

test("defineProps ignores a value identical to the current one", async () => {
  class List { constructor() { this.renders = 0; } render() { this.renders += 1; } }
  defineProps(List, { items: { field: "records", coerce: asArray } });
  const list = new List();
  const records = [1];
  list.items = records;
  assert.equal(list.flushRender(), true);
  list.items = records;
  list.items = undefined;
  list.items = null; // both coerce to the same shared empty array
  assert.equal(list.flushRender(), true, "the change to an empty list renders once");
  list.items = undefined;
  assert.equal(list.flushRender(), false, "an identical value schedules nothing");
  await null;
  assert.equal(list.renders, 2);
});

test("focus snapshots restore the same control or a found replacement", () => {
  const root = new Node("section");
  const details = new Node("details");
  const control = new Node("button");
  details.append(control);
  root.append(details);
  control.focus();
  const snapshot = captureFocus(root, { describe: () => ({ id: "a" }) });
  assert.equal(snapshot.id, "a");
  globalThis.document.activeElement = null;
  assert.equal(restoreFocus(snapshot, { reveal: true }), control);
  assert.equal(details.open, true);
  control.isConnected = false;
  const replacement = new Node("button");
  root.append(replacement);
  assert.equal(restoreFocus(snapshot, { find: ({ id }) => (id === "a" ? replacement : null) }), replacement);
  assert.equal(globalThis.document.activeElement, replacement);
  assert.equal(captureFocus(new Node("div")), null);
});

test("session guard detects any lock, reopen or engine change", () => {
  const vault = { locked: false };
  const host = { securityGeneration: 2, vault, store: {}, engine: {} };
  const session = captureSession(host);
  assert.equal(isCurrentSession(host, session), true);
  for (const change of [
    () => { host.securityGeneration = 3; },
    () => { vault.locked = true; },
    () => { host.store = {}; },
    () => { host.engine = {}; },
    () => { host.vault = null; },
  ]) {
    const before = { ...host };
    vault.locked = false;
    change();
    assert.equal(isCurrentSession(host, session), false);
    assert.throws(() => assertCurrentSession(host, session), (error) => error.code === "locked");
    Object.assign(host, before);
  }
});
