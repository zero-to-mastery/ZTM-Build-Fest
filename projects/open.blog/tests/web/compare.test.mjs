// Tests for <ob-compare>: the pure model, then the element on a small DOM stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DomNode, installDom } from "./dom-shim.mjs";
import { clampPosition, positionFromPointer, shouldEnhance, valueText } from "../../web/components/ob-compare-model.js";

test("positions are whole numbers kept between 0 and 100", () => {
  assert.equal(clampPosition(42.6), 43);
  assert.equal(clampPosition(-5), 0);
  assert.equal(clampPosition(180), 100);
  assert.equal(clampPosition("abc"), 50);
  assert.equal(clampPosition(undefined, 20), 20);
});

test("a pointer maps onto the stage and an empty stage means the middle", () => {
  const rect = { left: 100, width: 200 };
  assert.equal(positionFromPointer(100, rect), 0);
  assert.equal(positionFromPointer(200, rect), 50);
  assert.equal(positionFromPointer(999, rect), 100);
  assert.equal(positionFromPointer(10, { left: 0, width: 0 }), 50);
});

test("the spoken value names both labels and the ends say only", () => {
  assert.equal(valueText(30, "Before", "After"), "30% Before, 70% After");
  assert.equal(valueText(100, "Before", "Finished"), "Before only");
  assert.equal(valueText(0, "Before", "Finished"), "Finished only");
});

test("the control is offered for two pictures unless motion is reduced", () => {
  assert.equal(shouldEnhance({ pictures: 2 }), true);
  assert.equal(shouldEnhance({ pictures: 2, reducedMotion: true }), false);
  assert.equal(shouldEnhance({ pictures: 1 }), false);
  assert.equal(shouldEnhance(), false);
});

// ---- the element

const dom = installDom();
const { document } = dom;
let reduced = false;
const mediaListeners = [];
globalThis.matchMedia = () => ({
  get matches() {
    return reduced;
  },
  addEventListener: (_name, listener) => mediaListeners.push(listener),
  removeEventListener: (_name, listener) => mediaListeners.splice(mediaListeners.indexOf(listener), 1),
});
let definition;
globalThis.customElements = { get: () => undefined, define: (_name, constructor) => (definition = constructor) };
globalThis.HTMLElement = class extends DomNode {
  constructor() {
    super("ob-compare", document);
    const properties = new Map();
    this.style = {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
      getPropertyValue: (name) => properties.get(name) ?? "",
    };
  }
};
DomNode.prototype.hasAttribute = function hasAttribute(name) {
  return name in this.attributes;
};
DomNode.prototype.prepend = function prepend(node) {
  this.adopt(node);
  this.childNodes.unshift(node);
};
Object.defineProperty(DomNode.prototype, "nextSibling", {
  get() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  },
});
DomNode.prototype.getBoundingClientRect = () => ({ left: 0, width: 200 });
DomNode.prototype.setPointerCapture = function setPointerCapture() {};
DomNode.prototype.releasePointerCapture = function releasePointerCapture() {};
await import("../../web/components/ob-compare.js");

function pane(label, caption) {
  const figure = document.createElement("figure");
  const image = document.createElement("img");
  image.setAttribute("alt", `${label} picture`);
  const text = document.createElement("figcaption");
  const span = document.createElement("span");
  span.className = "ob-compare-label";
  span.textContent = label;
  text.append(span, caption);
  figure.append(image, text);
  return { figure, image };
}

function build() {
  const element = new definition();
  const before = pane("Before", ": Day one");
  const after = pane("After", "");
  element.append(before.figure, after.figure);
  element.connectedCallback();
  return { element, before, after };
}

const stage = (element) => element.children.find((child) => child.className === "ob-compare-stage");
const range = (element) => stage(element).querySelector(".ob-compare-range");

test("with motion allowed the pair becomes a labelled range over two pictures", () => {
  reduced = false;
  const { element, before, after } = build();
  assert.ok("data-enhanced" in element.attributes);
  const control = range(element);
  assert.equal(control.type, "range");
  assert.match(control.getAttribute("aria-label"), /Before and After|between Before and After/);
  assert.equal(control.getAttribute("aria-valuetext"), "50% Before, 50% After");
  assert.equal(element.style.getPropertyValue("--ob-compare-pos"), "50%");
  assert.equal(stage(element).getAttribute("role"), "group");
  assert.equal(stage(element).children[0], before.image);
  assert.equal(stage(element).querySelector(".ob-compare-over").children[0], after.image);
  // Each caption is still there for a screen reader, and the decorative tags are hidden from it.
  assert.equal(before.figure.querySelector("figcaption").textContent, "Before: Day one");
  assert.deepEqual(
    stage(element).querySelectorAll(".ob-compare-tag").map((tag) => tag.getAttribute("aria-hidden")),
    ["true", "true"],
  );
});

test("the keyboard and a drag both move the reveal and update what is spoken", () => {
  reduced = false;
  const { element } = build();
  const control = range(element);
  control.value = "30";
  control.dispatch("input");
  assert.equal(element.style.getPropertyValue("--ob-compare-pos"), "30%");
  assert.equal(control.getAttribute("aria-valuetext"), "30% Before, 70% After");
  stage(element).dispatch("pointerdown", { clientX: 150, button: 0, pointerId: 1 });
  assert.equal(element.style.getPropertyValue("--ob-compare-pos"), "75%");
  assert.equal(document.activeElement, control);
  stage(element).dispatch("pointermove", { clientX: 20, pointerId: 1 });
  assert.equal(element.style.getPropertyValue("--ob-compare-pos"), "10%");
  stage(element).dispatch("pointerup", { pointerId: 1 });
  stage(element).dispatch("pointermove", { clientX: 190, pointerId: 1 });
  assert.equal(element.style.getPropertyValue("--ob-compare-pos"), "10%", "a move after release does nothing");
});

test("reduced motion leaves the two figures untouched and changing it switches live", () => {
  reduced = true;
  const { element, before } = build();
  assert.ok(!("data-enhanced" in element.attributes));
  assert.equal(stage(element), undefined);
  assert.deepEqual(before.figure.children.map((child) => child.tagName), ["IMG", "FIGCAPTION"]);

  reduced = false;
  mediaListeners.at(-1)();
  assert.ok(stage(element));
  reduced = true;
  mediaListeners.at(-1)();
  assert.equal(stage(element), undefined);
  assert.deepEqual(before.figure.children.map((child) => child.tagName), ["IMG", "FIGCAPTION"], "the picture goes back above its caption");
});

test("anything that is not two pictures is left as it was", () => {
  reduced = false;
  const element = new definition();
  const only = pane("Before", "");
  element.append(only.figure);
  element.connectedCallback();
  assert.equal(stage(element), undefined);
});

test("the element never assigns a built-in HTMLElement property on this", () => {
  const source = fs.readFileSync(new URL("../../web/components/ob-compare.js", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/\bthis\.(popover|title|hidden|lang|dir|inert|slot|part|id)\s*=(?!=)/g)], []);
});

test("every bundled theme inherits the styles, which use only tokens the base theme defines", () => {
  const css = fs.readFileSync(new URL("../../web/base.css", import.meta.url), "utf8");
  const start = css.indexOf("/* ---------- Before and after");
  const block = css.slice(start, css.indexOf("/* ---------- Recipes", start));
  assert.ok(start > 0 && block.includes("ob-compare[data-enhanced]"));
  const base = JSON.parse(fs.readFileSync(new URL("../../themes/base/theme.json", import.meta.url), "utf8"));
  const defined = new Set(Object.keys(base.colors.light).map((key) => `--ob-color-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`));
  const used = new Set(block.match(/var\((--ob-[a-z-]+)/g)?.map((match) => match.slice(4)));
  const ownTokens = new Set(block.match(/--ob-compare-[a-z-]+(?=\s*:)/g));
  for (const token of used) {
    if (token.startsWith("--ob-compare-")) assert.ok(ownTokens.has(token) || token === "--ob-compare-pos" || token === "--ob-compare-ratio", `${token} has no default`);
    else if (token.startsWith("--ob-color-")) assert.ok(defined.has(token), `${token} is not a base theme colour`);
  }
  for (const name of fs.readdirSync(new URL("../../themes/", import.meta.url))) {
    const theme = JSON.parse(fs.readFileSync(new URL(`../../themes/${name}/theme.json`, import.meta.url), "utf8"));
    assert.ok(name === "base" || theme.extends, `${name} extends a theme that carries the compare styles`);
  }
});
