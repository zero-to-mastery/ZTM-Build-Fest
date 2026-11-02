import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor() {
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.hidden = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

globalThis.HTMLElement = class extends ElementStub {};
globalThis.customElements = {
  define: (_name, component) => { globalThis.KinSyncStatusUnderTest = component; },
};
globalThis.document = { createElement: () => new ElementStub() };

await import("./kin-sync-status.js");
const KinSyncStatus = globalThis.KinSyncStatusUnderTest;

test("sync states keep full accessible text and explicit compact labels", () => {
  const expected = {
    local: ["On this device", "Local"],
    ready: ["Up to date", "Current"],
    syncing: ["Syncing…", "Syncing"],
    paused: ["Sync paused", "Paused"],
    offline: ["Offline — saved here", "Offline"],
    "offline-sync": ["Offline — saved here", "Offline"],
  };

  for (const [state, [fullLabel, compactLabel]] of Object.entries(expected)) {
    const status = new KinSyncStatus();
    status.state = state;
    const chip = status.children[0];
    assert.equal(status.hidden, false);
    assert.equal(chip.dataset.state, state);
    assert.equal(chip.dataset.compactLabel, compactLabel);
    assert.equal(chip.children[0].textContent, fullLabel);
    assert.equal(chip.children[1].className, "visually-hidden");
    assert.match(chip.children[1].textContent, /^\. \S/);
    assert.equal(chip.attributes["aria-label"], undefined);
    assert.equal(chip.title, chip.children[1].textContent.slice(2));
  }
});

test("unknown sync state hides and clears the status", () => {
  const status = new KinSyncStatus();
  status.state = "ready";
  status.state = "unknown";
  assert.equal(status.state, null);
  assert.equal(status.hidden, true);
  assert.deepEqual(status.children, []);
});
