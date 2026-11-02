import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
  }
  get firstElementChild() { return this.children[0] ?? null; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  insertBefore(child) { this.append(child); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  dispatchEvent(event) { this.events ??= []; this.events.push(event); return true; }
  setAttribute(name, value) { this.attributes[name] = value; }
  contains() { return true; }
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
const components = {};
globalThis.customElements = { define: (name, component) => { components[name] = component; } };
globalThis.document = {
  createElement: (tagName) => {
    const element = new ElementStub(tagName);
    if (tagName === "kin-appearance") element.initialize = () => {};
    if (tagName === "kin-install-identity") element.initialize = (state) => { element.state = state; };
    return element;
  },
};
await import("./kin-household-defaults.js");
const KinHouseholdDefaults = components["kin-household-defaults"];

test("admin authority that arrives after a busy pass enables the household name", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  // The app applies busy state before the settings response establishes authority.
  panel.disabled = true;
  panel.disabled = false;
  assert.equal(panel.nameInput.disabled, true, "controls stay locked without admin authority");

  panel.initialize({ admin: true, adminRecorded: true, value: null });
  assert.equal(panel.hidden, false);
  assert.equal(panel.nameInput.disabled, false, "the household name is editable for an admin");
  assert.ok(panel.querySelectorAll("button").every((control) => !control.disabled));

  panel.disabled = true;
  assert.equal(panel.nameInput.disabled, true, "busy state still locks the controls");
});

test("household defaults stay hidden and locked for non-admins", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: false, adminRecorded: true, value: null });
  panel.disabled = false;
  assert.equal(panel.hidden, true);
  assert.equal(panel.nameInput.disabled, true);
});

test("withdrawn admin authority removes shared actions and locks the household name", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: true, adminRecorded: true, value: null });
  assert.ok(panel.querySelectorAll("button").some((control) => control.textContent === "Save household settings"));

  for (const admin of [false, undefined, null, "true"]) {
    panel.initialize({ admin, adminRecorded: true, value: null });
    assert.equal(panel.hidden, true, `${admin}: panel hidden`);
    assert.equal(panel.nameInput.disabled, true, `${admin}: name locked`);
    assert.equal(panel.querySelectorAll("button").some((control) => control.textContent === "Save household settings"), false,
      `${admin}: no stale save action`);
    panel.disabled = false;
    assert.equal(panel.nameInput.disabled, true, `${admin}: a later idle pass keeps it locked`);
    panel.initialize({ admin: true, adminRecorded: true, value: null });
    assert.equal(panel.nameInput.disabled, false, "re-granted authority restores editing");
  }
});

test("a settings refresh preserves an unsaved household name", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: true, adminRecorded: true, value: null });
  panel.nameInput.value = "The Draft House";
  panel.nameInput.listeners.input();

  const draftPreserved = panel.initialize({ admin: true, adminRecorded: true, value: null });

  assert.equal(draftPreserved, true);
  assert.equal(panel.nameInput.value, "The Draft House");
  assert.equal(panel.saved.name, "Our Home");
});

test("a newer shared revision preserves the draft until cancel loads the latest value", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: true, adminRecorded: true, value: null });
  panel.nameInput.value = "The Draft House";
  panel.nameInput.listeners.input();
  const newer = { ...structuredClone(panel.saved), revision: 1, name: "The Remote House" };

  assert.equal(panel.initialize({ admin: true, adminRecorded: true, value: newer }), true);
  assert.equal(panel.nameInput.value, "The Draft House");
  assert.match(panel.note.textContent, /Newer household settings arrived/);
  panel.save();
  assert.equal(panel.events.filter((event) => event.type === "kin:save-household-defaults").length, 0);
  assert.match(panel.feedback.textContent, /Cancel your draft/);

  panel.restore();
  assert.equal(panel.nameInput.value, "The Remote House");
  assert.equal(panel.saved.revision, 1);
  assert.equal(panel.dirty, false);
  assert.equal(panel.pending, null);
});

test("a delayed save completion cannot replace a newer revision received while saving", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: true, adminRecorded: true, value: null });
  panel.nameInput.value = "The Saved House";
  panel.nameInput.listeners.input();
  panel.save();
  const completion = panel.events.find((event) => event.type === "kin:save-household-defaults").detail.complete;
  const newer = { ...structuredClone(panel.saved), revision: 2, name: "The Newer House" };
  panel.initialize({ admin: true, adminRecorded: true, value: newer });

  completion({ ...structuredClone(panel.saved), revision: 1, name: "The Saved House" }, null);

  assert.equal(panel.nameInput.value, "The Newer House");
  assert.equal(panel.saved.revision, 2);
  assert.equal(panel.pending, null);
  assert.equal(panel.dirty, false);
  assert.match(panel.feedback.textContent, /newer household settings arrived/i);
});

test("the Home screen section exists only for admins and follows the saved household (#78)", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: false, adminRecorded: true, value: null });
  panel.initializeInstall({ published: null });
  assert.equal(panel.install, null, "a non-admin never gets the section");
  panel.initialize({ admin: true, adminRecorded: true, value: { version: 1, revision: 3, name: "Willow", appearance: { version: 1, mode: "system", colorSource: "preset", seed: "#397052", manual: null, image: null, owner: "household" } } });
  const published = { rev: 2, shortName: "Willow" };
  panel.initializeInstall({ published });
  assert.equal(panel.install.tagName, "kin-install-identity");
  assert.deepEqual(panel.install.state, { published, householdName: "Willow", seed: "#397052",
    brand: { version: 1, iconSource: "letter", icon: null } });
  panel.initialize({ admin: false, adminRecorded: true, value: null });
  assert.equal(panel.install, null, "withdrawn authority removes the section");
});
