// <kin-chore-chart> reward editing (#676, #699): on the kitchen display
// (size="display") an Adult sets or changes a child's reward with big
// buttons, never a typed number; what is chosen survives a redraw; the
// phone keeps its number box. Both send the same kin:chore-reward the chores
// controller turns into kind 78.
import assert from "node:assert/strict";
import test from "node:test";

// Minimal DOM stand-ins: only what the chart uses.
class Node {
  constructor(localName = "div") {
    this.localName = localName;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); } };
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.type = "";
    this.isConnected = true;
  }
  append(...children) { for (const child of children) if (typeof child === "object") { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatchEvent(event) {
    for (let node = this; node; node = event.bubbles ? node.parentElement : null)
      for (const listener of node.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  matches(selector) {
    return selector.split(",").map((part) => part.trim()).some((part) => {
      const focus = /^\[data-focus-key(?:="([^"]*)")?\]$/.exec(part);
      if (focus) return this.dataset.focusKey !== undefined && (focus[1] === undefined || this.dataset.focusKey === focus[1]);
      if (part.startsWith(".")) return this.className.split(" ").includes(part.slice(1));
      return this.localName === part;
    });
  }
  querySelectorAll(selector) { return [...this.walk()].filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { globalThis.document.activeElement = this; }
  click() { this.dispatchEvent({ type: "click", bubbles: true }); }
  reportValidity() { return [...this.walk()].every((node) => !(node.required && !String(node.value).trim())); }
  requestSubmit() { this.dispatchEvent({ type: "submit", bubbles: false, preventDefault() {} }); }
}

let Chart = null;
globalThis.HTMLElement = Node;
globalThis.CustomEvent = class { constructor(type, { bubbles = false, detail } = {}) { Object.assign(this, { type, bubbles, detail }); } };
globalThis.customElements = { get: () => undefined, define: (_name, component) => { Chart = component; } };
globalThis.document = { createElement: (name) => new Node(name), activeElement: null };
await import("./kin-chore-chart.js");

const CHILD = "c".repeat(32);
const card = (reward = null) => ({
  memberId: CHILD, name: "Sam", colour: "#1f5fae", adult: false, self: false, points: 4, reward,
  line: reward ? `4 of ${reward.goal} for ${reward.text}` : "4 points this week", progress: null, today: [], week: [],
});

function chart({ display, reward = null } = {}) {
  const element = new Chart();
  if (display) element.setAttribute("size", "display");
  element.connectedCallback();
  element.editable = true;
  element.cards = [card(reward)];
  const sent = [];
  element.addEventListener("kin:chore-reward", (event) => sent.push(event.detail));
  return { element, sent };
}
const one = (element, selector) => element.querySelector(selector);

test("on the display the goal is chosen with big buttons, never typed", () => {
  const { element, sent } = chart({ display: true });
  const toggle = one(element, ".chore-reward-toggle");
  assert.equal(toggle.textContent, "Set a reward");
  toggle.click();
  const form = one(element, ".chore-reward-form");
  assert.ok(form, "the editor opens");
  assert.equal(element.querySelectorAll("input").filter((node) => node.type === "number").length, 0, "no number box to type into");
  assert.equal(document.activeElement?.dataset.focusKey, `${CHILD}:goal-more`, "a button has the focus, so no keyboard covers the chart yet");
  assert.equal(one(element, ".chore-goal-value").textContent, "20 points", "20 to start with");
  // A one-tap goal, then one more.
  element.querySelectorAll(".chore-goal-preset").find((node) => node.dataset.goal === "30").click();
  assert.equal(one(element, ".chore-goal-value").textContent, "30 points");
  assert.equal(element.querySelectorAll(".chore-goal-preset").find((node) => node.dataset.goal === "30").getAttribute("aria-pressed"), "true");
  element.querySelectorAll(".chore-goal-step").find((node) => node.dataset.step === "1").click();
  assert.equal(one(element, ".chore-goal-value").textContent, "31 points");
  // Typed text survives a redraw (a sync, a tick on another card).
  const text = one(element, `[data-focus-key="${CHILD}:reward-text"]`);
  text.value = "Park trip";
  text.dispatchEvent({ type: "input" });
  element.cards = [card()];
  assert.equal(one(element, `[data-focus-key="${CHILD}:reward-text"]`).value, "Park trip", "the draft is kept");
  assert.equal(one(element, ".chore-goal-value").textContent, "31 points");
  one(element, ".chore-reward-form").requestSubmit();
  assert.deepEqual(sent, [{ memberId: CHILD, goal: 31, text: "Park trip" }]);
  assert.equal(one(element, ".chore-reward-form"), null, "and it closes");
});

test("on the display the goal stays within 1 to 1000, and Cancel changes nothing", () => {
  const { element, sent } = chart({ display: true, reward: { goal: 2, text: "Ice cream" } });
  one(element, ".chore-reward-toggle").click();
  assert.equal(one(element, ".chore-reward-toggle").textContent, "Change reward");
  assert.equal(one(element, `[data-focus-key="${CHILD}:reward-text"]`).value, "Ice cream", "starts from the current reward");
  const fewer = () => element.querySelectorAll(".chore-goal-step").find((node) => node.dataset.step === "-1");
  fewer().click();
  assert.equal(one(element, ".chore-goal-value").textContent, "1 point");
  assert.equal(fewer().disabled, true, "not below 1");
  one(element, ".chore-reward-cancel").click();
  assert.equal(one(element, ".chore-reward-form"), null);
  assert.deepEqual(sent, []);
  // Opening again starts from the reward, not the cancelled draft.
  one(element, ".chore-reward-toggle").click();
  assert.equal(one(element, ".chore-goal-value").textContent, "2 points");
  one(element, ".chore-reward-remove").click();
  assert.deepEqual(sent, [{ memberId: CHILD, goal: 0, text: "" }], "Remove reward clears it");
});

test("a reward needs a name before it saves", () => {
  const { element, sent } = chart({ display: true });
  one(element, ".chore-reward-toggle").click();
  one(element, ".chore-reward-form").requestSubmit();
  assert.deepEqual(sent, []);
  assert.ok(one(element, ".chore-reward-form"), "still open");
});

test("the phone keeps its number box, and only children's cards are editable", () => {
  const { element, sent } = chart({ display: false });
  one(element, ".chore-reward-toggle").click();
  const goal = element.querySelectorAll("input").find((node) => node.type === "number");
  assert.ok(goal, "a number box on the phone");
  assert.equal(one(element, ".chore-goal-stepper"), null);
  assert.equal(one(element, ".chore-reward-cancel"), null);
  goal.value = "12";
  goal.dispatchEvent({ type: "input" });
  const text = one(element, `[data-focus-key="${CHILD}:reward-text"]`);
  text.value = "Movie night";
  one(element, ".chore-reward-form").requestSubmit();
  assert.deepEqual(sent, [{ memberId: CHILD, goal: 12, text: "Movie night" }]);
  element.cards = [{ ...card(), adult: true }];
  assert.equal(one(element, ".chore-reward-toggle"), null, "an adult on the chart has no reward");
  element.cards = [card()];
  element.editable = false;
  assert.equal(one(element, ".chore-reward-toggle"), null, "not editable, no editor");
});
