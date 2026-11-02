import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.textContent = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
  }
  focus() { globalThis.document.activeElement = this; }
  get firstElementChild() { return this.children.find((child) => child.tagName !== "#text") ?? null; }
  append(...children) {
    for (const value of children) {
      const child = typeof value === "string" ? Object.assign(new ElementStub("#text"), { textContent: value }) : value;
      child.parent = this; this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  dispatchEvent(event) { this.dispatched ??= []; this.dispatched.push(event); return true; }
  querySelectorAll(selector) {
    const tags = selector.split(",");
    const walk = (node) => node.children.flatMap((child) => [
      ...(tags.includes(child.tagName) ? [child] : []),
      ...walk(child),
    ]);
    return walk(this);
  }
}

globalThis.HTMLElement = class extends ElementStub {};
globalThis.CustomEvent ??= class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
const components = {};
globalThis.customElements = { define: (name, component) => { components[name] = component; } };
globalThis.document = { activeElement: null, createElement: (tagName) => new ElementStub(tagName) };
await import("./kin-appearance.js");
const KinAppearance = components["kin-appearance"];

const initial = Object.freeze({
  version: 1, owner: null, mode: "system", colorSource: "default", seed: "#984D38", manual: null,
  image: { seed: "#684033", type: "image/webp", width: 10, height: 10, bytes: new Uint8Array([1, 2]) },
});

test("theme presets use one native radio group and preview the checked choice", () => {
  const appearance = new KinAppearance();
  appearance.connectedCallback();
  appearance.initialize(initial);
  assert.equal(appearance.dirty, false);

  const controls = [...appearance.presetControls.values()];
  assert.equal(controls.length, 8);
  assert.ok(controls.every((input) => input.type === "radio"));
  assert.equal(new Set(controls.map((input) => input.name)).size, 1, "all presets share one native radio group");
  assert.equal(appearance.swatches.getAttribute("role"), null, "the group needs no emulated radio role");
  assert.ok(appearance.swatches.children.every((label) => label.tagName === "label" && label.children[0].type === "radio"));
  assert.deepEqual(controls.filter((input) => input.checked).map((input) => input.value), ["default"]);

  const forest = appearance.presetControls.get("forest");
  forest.checked = true;
  forest.listeners.change();
  assert.deepEqual(controls.filter((input) => input.checked).map((input) => input.value), ["forest"]);
  assert.equal(appearance.draft.colorSource, "preset");
  assert.equal(appearance.draft.seed, "#397052");
  assert.deepEqual(appearance.draft.image, initial.image);
  assert.equal(appearance.feedback.textContent, "Unsaved changes.");
  assert.equal(appearance.dirty, true);

  void appearance.requestSave();
  const save = appearance.dispatched.at(-1);
  assert.deepEqual(save.detail.baseline.image, initial.image);
  assert.deepEqual(save.detail.value.image, initial.image);

  appearance.restoreSaved("Changes canceled.");
  assert.equal(appearance.dirty, false);
  assert.equal(appearance.draft.seed, initial.seed);
});

test("an incomplete hex edit remains dirty and cannot be saved", async () => {
  const appearance = new KinAppearance();
  appearance.connectedCallback();
  appearance.initialize(initial);

  appearance.hex.value = "#3A7";
  appearance.hex.listeners.input();
  assert.equal(appearance.dirty, true);
  assert.equal(appearance.hex.value, "#3A7");
  assert.equal(appearance.hex.getAttribute("aria-invalid"), "true");
  assert.equal(appearance.feedback.textContent, "");

  await appearance.requestSave();
  assert.equal(document.activeElement, appearance.hex);
  assert.equal(appearance.feedback.textContent, "Finish the hex color before saving.");
  assert.equal(appearance.dispatched?.some((event) => event.type === "kin:save-appearance") ?? false, false);

  appearance.restoreSaved("Changes canceled.");
  assert.equal(appearance.dirty, false);
  assert.equal(appearance.hex.value, initial.seed);
  assert.equal(appearance.hex.getAttribute("aria-invalid"), "false");
});

test("cancel clears an invalid edit when the saved color is custom", async () => {
  const appearance = new KinAppearance();
  appearance.connectedCallback();
  appearance.initialize({
    ...initial,
    colorSource: "custom",
    seed: "#256A91",
    manual: { source: "custom", name: "Custom color", seed: "#256A91" },
  });

  appearance.hex.focus();
  appearance.hex.value = "#3A";
  appearance.hex.listeners.input();
  appearance.cancel.focus();
  appearance.cancel.listeners.click();
  assert.equal(appearance.hex.value, "#256A91");
  assert.equal(appearance.hex.getAttribute("aria-invalid"), "false");
  assert.equal(appearance.hexError.hidden, true);

  const dark = appearance.modeControls.get("dark");
  dark.focus();
  dark.checked = true;
  dark.listeners.change();
  await appearance.requestSave();
  assert.equal(appearance.dispatched.filter((event) => event.type === "kin:save-appearance").length, 1);
});

test("reset requests explicit Kin defaults and cancel clears that intent", async () => {
  const appearance = new KinAppearance();
  appearance.connectedCallback();
  appearance.initialize(initial);

  appearance.reset.listeners.click();
  await appearance.requestSave();
  assert.equal(appearance.dispatched.at(-1).detail.forceExplicit, true);

  appearance.restoreSaved("Changes canceled.");
  appearance.modeControls.get("dark").checked = true;
  appearance.modeControls.get("dark").listeners.change();
  await appearance.requestSave();
  assert.equal(appearance.dispatched.at(-1).detail.forceExplicit, false);
});
