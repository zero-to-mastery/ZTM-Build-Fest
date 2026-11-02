import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.classList = { add() {} };
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
  }
  get firstElementChild() { return this.children[0] ?? null; }
  append(...children) { for (const child of children) if (typeof child === "object") this.children.push(child); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  dispatchEvent(event) { this.events ??= []; this.events.push(event); return true; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  querySelectorAll(selector) {
    const tags = selector.split(",").map((tag) => tag.trim());
    const walk = (node) => node.children.flatMap((child) => [
      ...(tags.includes(child.tagName) ? [child] : []),
      ...walk(child),
    ]);
    return walk(this);
  }
}

// Letter icons draw on an OffscreenCanvas; a stub is enough because these
// tests check the panel's messages, not the pixels.
globalThis.OffscreenCanvas = class {
  getContext() { return { fillRect() {}, fillText() {}, measureText: () => ({}) }; }
  async convertToBlob() { return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }); }
};
globalThis.HTMLElement = class extends ElementStub {};
const components = {};
globalThis.customElements = { define: (name, component) => { components[name] = component; } };
globalThis.document = { createElement: (tagName) => new ElementStub(tagName) };
const { DEFAULT_HOUSEHOLD_BRAND } = await import("../appearance/household.js");
await import("./kin-install-identity.js");
const KinInstallIdentity = components["kin-install-identity"];

const published = { rev: 2, name: "Nichols", shortName: "Nichols", description: "", iconSource: "letter",
  icons: { icon192: "/i/192.png", icon512: "/i/512.png", maskable512: "/i/m512.png", apple180: "/i/180.png" } };
const details = (overrides = {}) => ({ published: structuredClone(published), householdName: "Nichols", seed: "#397052",
  brand: structuredClone(DEFAULT_HOUSEHOLD_BRAND), ...overrides });

// Saves the panel and answers the publish request with `result` or `error`.
async function save(panel, result, error) {
  await panel.regenerate();
  await panel.publish();
  const request = panel.events.at(-1);
  assert.equal(request.type, "kin:publish-install-identity");
  request.detail.complete(result, error);
}

test("a background re-initialize with the same details keeps the Saved status", async () => {
  const panel = new KinInstallIdentity();
  panel.initialize(details());
  await save(panel, { rev: 3 });
  assert.match(panel.status.textContent, /^Saved\./);
  const icons = panel.icons;

  // A sync that lands after the save sends back the copy just published.
  panel.initialize(details({ published: { ...structuredClone(published), rev: 3 } }));
  assert.match(panel.status.textContent, /^Saved\./, "the confirmation stays until something changes");
  assert.equal(panel.icons, icons, "the icons are not redrawn");
  assert.equal(panel.shortName.value, "Nichols");
});

test("a background re-initialize with the same details keeps a save error", async () => {
  const panel = new KinInstallIdentity();
  panel.initialize(details());
  await save(panel, null, { message: "The Kin service is offline." });
  assert.equal(panel.error.textContent, "The Kin service is offline.");

  panel.initialize(details());
  assert.equal(panel.error.textContent, "The Kin service is offline.");
});

test("a real change still redraws the panel", async () => {
  const changes = {
    rev: { published: { ...structuredClone(published), rev: 4 } },
    name: { householdName: "Willow" },
    seed: { seed: "#225588" },
    brand: { brand: { version: 1, iconSource: "upload", icon: { type: "image/png", width: 512, height: 512, bytes: new Uint8Array([9]) } } },
  };
  for (const [what, change] of Object.entries(changes)) {
    const panel = new KinInstallIdentity();
    panel.initialize(details());
    await save(panel, { rev: 3 });
    panel.initialize(details({ published: { ...structuredClone(published), rev: 3 }, ...change }));
    assert.doesNotMatch(panel.status.textContent, /^Saved\./, `a new ${what} redraws the panel`);
    if (what === "name") assert.match(panel.status.textContent, /^Home screens still show “Nichols”/);
  }
});
