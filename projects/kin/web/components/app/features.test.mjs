// The household features controller (#625): what the device keeps, when the
// members' note shows, and what it hands to the workspace.
import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
});
const root = { dataset: {} };
globalThis.document = { documentElement: root };

const { FeaturesController } = await import("./features.js");
const { withFeature } = await import("../../features.js");

const HOUSEHOLD = "a".repeat(32);
const off = (...ids) => ids.reduce((value, id) => withFeature(value, id, false), 0);

/** A workspace with just the parts the controller hands things to. */
function workspace() {
  const calls = [];
  const link = () => {
    const attributes = new Set();
    return { attributes, toggleAttribute: (name, on) => (on ? attributes.add(name) : attributes.delete(name)) };
  };
  const note = { hidden: true, text: { textContent: "" }, querySelector() { return this.text; } };
  const app = {
    main: {},
    navLinks: new Map([["today", link()], ["routines", link()], ["lists", link()]]),
    segmentNavs: new Map([["lists", { segments: null }], ["household", { segments: null }]]),
    chat: { room: { id: "room" } },
    search: {},
    quickAdd: {},
    commandPalette: {},
    featuresNote: note,
    querySelectorAll: () => [],
  };
  const ctx = {
    app,
    render: { renderState: () => calls.push("render") },
    navigation: { showPageFromLocation: () => calls.push("navigate") },
    sections: { publish: () => calls.push("sections") },
    rotations: { publish: (options) => calls.push(`turns:${options.force}`) },
  };
  const features = new FeaturesController(ctx);
  return { app, ctx, features, calls, note };
}

test("a device with nothing kept starts with everything on, and its first answer shows no note", () => {
  stored.clear();
  const { features, note } = workspace();
  features.restore({ householdId: HOUSEHOLD });
  assert.equal(features.off, 0);
  assert.equal(features.admin, false);
  features.receive({ off: off("meals"), revision: 3, admin: false }, { householdId: HOUSEHOLD });
  assert.equal(features.isOn("meals"), false);
  assert.equal(note.hidden, true, "this device never showed Meals switched on, so nothing disappeared");
  assert.equal(root.dataset.kinFeaturesOff, "meals");
  assert.deepEqual(JSON.parse(stored.get("kin.household-features")), { scope: HOUSEHOLD, off: off("meals"), revision: 3, noticed: off("meals") });
});

test("members see the note once when something they had disappears", () => {
  stored.clear();
  const { features, note } = workspace();
  features.restore({ householdId: HOUSEHOLD });
  features.receive({ off: 0, revision: 1, admin: false }, { householdId: HOUSEHOLD });
  features.receive({ off: off("meals", "fridge"), revision: 2, admin: false }, { householdId: HOUSEHOLD });
  assert.equal(note.hidden, false);
  assert.match(note.text.textContent, /^Your household turned off Fridge and Meals\./);
  // A lock and unlock keeps it until it is read.
  const again = workspace();
  again.features.restore({ householdId: HOUSEHOLD });
  assert.equal(again.note.hidden, false, "still there after an unlock");
  again.features.dismissNote();
  assert.equal(again.note.hidden, true);
  const later = workspace();
  later.features.restore({ householdId: HOUSEHOLD });
  assert.equal(later.note.hidden, true, "told once");
  // On again, then off again: told again.
  later.features.receive({ off: 0, revision: 3, admin: false }, { householdId: HOUSEHOLD });
  later.features.receive({ off: off("meals"), revision: 4, admin: false }, { householdId: HOUSEHOLD });
  assert.match(later.note.text.textContent, /turned off Meals\./);
});

test("an older revision than the one kept is a stale answer", () => {
  stored.clear();
  const { features } = workspace();
  features.restore({ householdId: HOUSEHOLD });
  assert.equal(features.receive({ off: off("week"), revision: 5, admin: true }, { householdId: HOUSEHOLD }), true);
  assert.equal(features.receive({ off: 0, revision: 4, admin: true }, { householdId: HOUSEHOLD }), false);
  assert.equal(features.isOn("week"), false);
  assert.equal(features.receive({ off: "x", revision: 6 }), false, "malformed: ignored");
});

test("the person who saved a change gets no note; a household without sync keeps its own set", () => {
  stored.clear();
  const { features, note } = workspace();
  features.restore(null);
  assert.deepEqual(features.value, { off: 0, revision: 0, admin: true, local: true, heard: false });
  features.changed({ off: off("journal"), revision: 1 });
  assert.equal(note.hidden, true);
  assert.deepEqual(JSON.parse(stored.get("kin.household-features")).scope, "local");
  const next = workspace();
  next.features.restore(null);
  assert.equal(next.features.isOn("journal"), false, "kept on the device");
  next.features.restore({ householdId: HOUSEHOLD });
  assert.equal(next.features.isOn("journal"), true, "another household's set isn't this one's");
});

test("applying hands the set to navigation, segments, chat, search, quick add and the palette", () => {
  stored.clear();
  const { app, features, calls } = workspace();
  features.restore({ householdId: HOUSEHOLD });
  app.route = { page: "lists", segment: "meals", canonical: "lists/meals" };
  calls.length = 0;
  features.receive({ off: off("routines", "meals", "chat", "talk"), revision: 1, admin: false }, { householdId: HOUSEHOLD });
  assert.ok(app.navLinks.get("routines").attributes.has("data-feature-hidden"), "Routines leaves the navigation");
  assert.ok(!app.navLinks.get("lists").attributes.has("data-feature-hidden"));
  assert.ok(!app.segmentNavs.get("lists").segments.some((entry) => entry.id === "meals"), "Meals leaves Lists");
  assert.ok(app.segmentNavs.get("lists").segments.some((entry) => entry.id === "shopping"));
  assert.equal(app.segmentNavs.get("household").segments[0].label, "Overview");
  assert.deepEqual([...app.chat.hiddenActions], ["talk-later", "talk-resolve", "talk-reopen"]);
  assert.equal(app.search.chatRoom, null, "Search finds no chat messages");
  assert.equal(app.quickAdd.repeatAllowed, false, "no repeating tasks without Routines");
  assert.ok(Array.isArray(app.commandPalette.commands));
  assert.ok(calls.includes("navigate"), "the page that went away is left");
  assert.ok(calls.includes("sections") && calls.includes("turns:true"));
  assert.equal(features.routeAvailable("lists/meals"), false);
  assert.equal(features.blocking("lists/meals").label, "Meals");
});
