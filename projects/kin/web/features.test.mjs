// Household features (ADR 0021 §2, #624, #625): the pure list of features,
// their bits and routes, and what each surface leaves out while one is off.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ALWAYS_ON, availableCommands, blockingFeature, featureById, FEATURES, featuresAttribute, filterWeekDays, hiddenChatActions,
  isFeatureOn, joinLabels, KNOWN_FEATURE_MASK, newlyOff, offFeatures, parseFeatureSet, routeAvailable, routeOwners,
  searchableHousehold, shareDestinations, turnedOffNote, unavailableLine, withFeature,
} from "./features.js";
import { resolveRoute, SEGMENTS } from "./routes.js";
import { COMMANDS } from "./keyboard-commands.js";

const off = (...ids) => ids.reduce((value, id) => withFeature(value, id, false), 0);

test("the switchable features, in the ADR's order, with stable small bits", () => {
  assert.deepEqual(FEATURES.map((entry) => [entry.label, entry.bit]), [
    ["Chat", 0], ["Fridge", 1], ["Meals", 2], ["Routines", 3], ["Taking turns", 4], ["This week", 5], ["Talk later", 6],
    ["Store sections", 7], ["Shopping mode", 8], ["Maintenance", 9], ["Notes & reference", 10], ["Sitter page", 11],
    ["Journal", 12], ["Just for me", 13], ["Calendar", 14], ["Chore chart", 15], ["Family photos", 16], ["Kitchen display", 17],
  ]);
  assert.equal(new Set(FEATURES.map((entry) => entry.id)).size, FEATURES.length);
  // Each bit is used once, and the mask is exactly the listed bits.
  assert.equal(new Set(FEATURES.map((entry) => entry.bit)).size, FEATURES.length);
  assert.equal(KNOWN_FEATURE_MASK, FEATURES.reduce((mask, entry) => mask | (2 ** entry.bit), 0));
  for (const entry of FEATURES) {
    assert.match(entry.description, /^[A-Z].*\.$/, `${entry.label} has a plain sentence`);
    assert.ok(entry.description.length <= 120, `${entry.label}'s description stays short`);
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.routes));
  }
  assert.deepEqual([...ALWAYS_ON], ["Today", "Lists (To do and Shopping)", "Updates (handoffs)", "Household"]);
});

test("every owned route is a real route", () => {
  for (const entry of FEATURES) for (const route of entry.routes) {
    const resolved = resolveRoute({ hash: `#${route}` });
    assert.ok(resolved.canonical === route || resolved.page === route, `${entry.id} owns ${route}, which resolves to ${resolved.canonical}`);
  }
});

test("bits switch features on and off; unknown ids are always on", () => {
  let value = 0;
  value = withFeature(value, "meals", false);
  value = withFeature(value, "fridge", false);
  assert.equal(value, 0b110);
  assert.equal(isFeatureOn(value, "meals"), false);
  assert.equal(isFeatureOn(value, "chat"), true);
  assert.equal(isFeatureOn(value, "nonsense"), true);
  assert.equal(withFeature(value, "nonsense", false), value);
  assert.equal(withFeature(value, "meals", true), 0b010);
  assert.deepEqual(offFeatures(value).map((entry) => entry.id), ["fridge", "meals"]);
  assert.equal(featuresAttribute(value), "fridge meals");
  assert.equal(featuresAttribute(0), "");
  assert.equal(featureById("journal").bit, 12);
  assert.equal(featureById("today"), null);
});

test("a set from the service or the device is checked and keeps only known bits", () => {
  assert.deepEqual(parseFeatureSet({ off: 6, revision: 2 }), { off: 6, revision: 2 });
  assert.deepEqual(parseFeatureSet({ off: 2 ** 20 + 4, revision: 1, admin: true }), { off: 4, revision: 1 }, "a newer service's bits are ignored");
  for (const value of [null, 3, {}, { off: -1, revision: 0 }, { off: 1.5, revision: 0 }, { off: 1, revision: -1 }, { off: "1", revision: 0 }])
    assert.equal(parseFeatureSet(value), null, JSON.stringify(value));
});

test("routes: a route is gone when every feature that owns it is off", () => {
  assert.equal(routeAvailable("today", KNOWN_FEATURE_MASK), true, "Today is always on");
  assert.equal(routeAvailable("lists/todo", KNOWN_FEATURE_MASK), true);
  assert.equal(routeAvailable("lists/shopping", KNOWN_FEATURE_MASK), true);
  assert.equal(routeAvailable("updates/handoffs", KNOWN_FEATURE_MASK), true);
  assert.equal(routeAvailable("household", KNOWN_FEATURE_MASK), true);
  assert.equal(routeAvailable("household/features", KNOWN_FEATURE_MASK), true, "the Features page itself");
  assert.equal(routeAvailable("lists/meals", off("meals")), false);
  assert.equal(routeAvailable("lists/meals", off("fridge")), true);
  assert.equal(routeAvailable(resolveRoute({ hash: "#household/fridge" }), off("fridge")), false);
  assert.equal(routeAvailable(resolveRoute({ hash: "#routines/checklists" }), off("routines")), false, "the whole Routines page");
  assert.equal(routeAvailable("routines", off("routines")), false, "the primary destination");
  assert.equal(routeAvailable(resolveRoute({ hash: "#week" }), off("week")), false);
  assert.equal(routeAvailable(resolveRoute({ hash: "#journal" }), off("journal")), false);
  assert.equal(routeAvailable(resolveRoute({ hash: "#foryou" }), off("sitter")), false);
  assert.equal(routeAvailable(resolveRoute({ hash: "#updates/chat" }), off("chat")), false);
  assert.equal(routeAvailable(resolveRoute({ hash: "#talk" }), off("chat")), false, "an old Talk link is Chat's");
  assert.deepEqual(routeOwners("household/notes").map((entry) => entry.id), ["notes"]);
  assert.equal(blockingFeature("lists/meals", off("meals")).label, "Meals");
  assert.equal(blockingFeature("lists/meals", 0), null);
  // Every segment of every page is either always on or owned.
  for (const [page, segments] of Object.entries(SEGMENTS))
    for (const segment of segments) assert.equal(typeof routeAvailable({ page, segment: segment.id }, KNOWN_FEATURE_MASK), "boolean");
});

test("This week leaves out dinners, routines, maintenance and private items of switched-off features", () => {
  const days = [{ date: 20261021, items: [{ itemId: "a" }], meals: [{ name: "Soup" }], routines: [{ routineId: "r" }], maintenance: [{ maintenanceId: "m" }], privateItems: [{ itemId: "p" }] }];
  assert.equal(filterWeekDays(days, 0), days, "nothing off: the same array");
  const filtered = filterWeekDays(days, off("meals", "routines"));
  assert.deepEqual(filtered[0].meals, []);
  assert.deepEqual(filtered[0].routines, []);
  assert.deepEqual(filtered[0].items, [{ itemId: "a" }], "items always stay");
  assert.deepEqual(filtered[0].maintenance, [{ maintenanceId: "m" }]);
  assert.deepEqual(filterWeekDays(days, off("maintenance"))[0].maintenance, []);
  assert.deepEqual(filterWeekDays(days, off("notes"))[0].maintenance, [], "maintenance lives with reference details");
  assert.deepEqual(filterWeekDays(days, off("mine"))[0].privateItems, []);
  assert.deepEqual(filterWeekDays(null, 0), []);
  assert.equal(days[0].meals.length, 1, "the input is not changed");
});

test("Search leaves out Talk later's topics, notes, reference records and maintenance", () => {
  const household = { items: [1], handoffs: [2], talks: [3], notes: [4], referenceRecords: [5], maintenanceEvents: [6], areas: [7] };
  const all = searchableHousehold(household, 0);
  for (const key of Object.keys(household)) assert.equal(all[key], household[key], `${key} passes through as the same array`);
  const none = searchableHousehold(household, off("talk", "notes"));
  assert.deepEqual({ ...none }, { items: [1], handoffs: [2], talks: [], notes: [], referenceRecords: [], maintenanceEvents: [], areas: [7] });
  assert.equal(searchableHousehold(household, off("talk")).talks, searchableHousehold(household, off("talk", "meals")).talks, "an emptied list is one shared array");
  assert.deepEqual(searchableHousehold(household, off("maintenance")).maintenanceEvents, []);
  assert.deepEqual(searchableHousehold(household, off("maintenance")).notes, [4]);
});

test("the share sheet, chat actions and palette leave out switched-off destinations", () => {
  const kinds = ["todo", "shopping", "note", "handoff", "chat", "journal"];
  assert.deepEqual([...shareDestinations(kinds, 0)], kinds);
  assert.deepEqual([...shareDestinations(kinds, off("chat", "notes", "journal"))], ["todo", "shopping", "handoff"]);
  assert.deepEqual(hiddenChatActions(0), []);
  assert.deepEqual(hiddenChatActions(off("talk", "notes")), ["talk-later", "talk-resolve", "talk-reopen", "to-note"]);
  assert.deepEqual(availableCommands(COMMANDS, KNOWN_FEATURE_MASK), [...COMMANDS], "every command today belongs to an always-on part");
  assert.deepEqual(availableCommands([{ id: "a" }, { id: "b", feature: "week" }], off("week")), [{ id: "a" }]);
});

test("the members' note and the line after a closed route are calm and plain", () => {
  assert.deepEqual(newlyOff(off("chat"), off("chat", "meals", "fridge")).map((entry) => entry.label), ["Fridge", "Meals"]);
  assert.deepEqual(newlyOff(off("meals"), 0), []);
  assert.equal(joinLabels(["Meals"]), "Meals");
  assert.equal(joinLabels(["Meals", "Fridge"]), "Meals and Fridge");
  assert.equal(joinLabels(["Meals", "Fridge", "Journal"]), "Meals, Fridge and Journal");
  assert.equal(turnedOffNote([]), "");
  assert.equal(turnedOffNote([featureById("meals")]),
    "Your household turned off Meals. Nothing was deleted; a household admin can turn it back on under Household › Features.");
  assert.match(turnedOffNote([featureById("meals"), featureById("fridge")]), /^Your household turned off Meals and Fridge\. .*turn them back on/);
  assert.equal(unavailableLine(featureById("week")), "This week is turned off in your household, so Kin opened Today.");
  assert.equal(unavailableLine(null), "");
  for (const text of [turnedOffNote(FEATURES), unavailableLine(featureById("chat"))])
    assert.doesNotMatch(text, /error|fail|denied|forbidden|!/i, "nothing alarming");
});

test("Family photos (#673) leave the Household page, the share sheet and chat while off", () => {
  const photos = off("photos");
  assert.equal(featureById("photos").bit, 16);
  assert.equal(routeAvailable(resolveRoute({ hash: "#household/photos" }), photos), false);
  assert.equal(routeAvailable(resolveRoute({ hash: "#household/photos" }), 0), true);
  assert.equal(blockingFeature("household/photos", photos)?.id, "photos");
  assert.deepEqual([...shareDestinations(["todo", "photos"], photos)], ["todo"]);
  assert.deepEqual([...shareDestinations(["todo", "photos"], 0)], ["todo", "photos"]);
  assert.ok(hiddenChatActions(photos).includes("to-photos"));
  assert.ok(!hiddenChatActions(0).includes("to-photos"));
  // A bit this Kin doesn't know is left alone.
  assert.deepEqual(parseFeatureSet({ off: 2 ** 30 + 2 ** 16, revision: 3 }), { off: 2 ** 16, revision: 3 });
});
