import assert from "node:assert/strict";
import test from "node:test";
import { listSegmentForClassification, PRIMARY_DESTINATIONS, resolveRoute, resolveSimpleRoute, routeHash, SEGMENTS } from "./routes.js";

test("five primary destinations in a fixed order", () => {
  assert.deepEqual(PRIMARY_DESTINATIONS.map((entry) => entry.id), ["today", "lists", "routines", "updates", "household"]);
  assert.deepEqual(PRIMARY_DESTINATIONS.map((entry) => entry.label), ["Today", "Lists", "Routines", "Updates", "Household"]);
});

test("an empty or unknown hash resolves to Today", () => {
  assert.deepEqual(resolveRoute({ hash: "" }).canonical, "today");
  assert.deepEqual(resolveRoute({ hash: "#" }).canonical, "today");
  assert.equal(resolveRoute({ hash: "#nowhere" }).canonical, "today");
  assert.equal(resolveRoute({ hash: "#invite" }).canonical, "today");
  assert.equal(resolveRoute({ hash: "#recover" }).canonical, "today");
  assert.equal(resolveRoute({ hash: "#today" }).destination, "today");
});

test("lists default to To do and accept each list segment", () => {
  assert.equal(resolveRoute({ hash: "#lists" }).canonical, "lists/todo");
  assert.equal(resolveRoute({ hash: "#lists/shopping" }).canonical, "lists/shopping");
  assert.equal(resolveRoute({ hash: "#lists/staples" }).segment, "staples");
  assert.equal(resolveRoute({ hash: "#lists/unknown" }).segment, "todo");
  assert.equal(resolveRoute({ hash: "#LISTS/Shopping/" }).canonical, "lists/shopping");
});

test("legacy Handoff, More, Needs and tab hashes alias onto Updates, Household and Lists", () => {
  assert.equal(resolveRoute({ hash: "#handoff" }).canonical, "updates/handoffs");
  // The Talk tab moved into Chat's To talk about list (#312).
  for (const hash of ["#handoff/talk", "#talk", "#updates/talk"]) {
    const route = resolveRoute({ hash });
    assert.equal(route.canonical, "updates/chat", hash);
    assert.equal(route.hash, "#updates/chat", hash);
    assert.equal(route.topics, true, hash);
  }
  assert.equal("topics" in resolveRoute({ hash: "#updates/chat" }), false);
  assert.equal(resolveRoute({ hash: "#more" }).canonical, "household/hub");
  assert.equal(resolveRoute({ hash: "#more/security" }).canonical, "household/privacy");
  assert.equal(resolveRoute({ hash: "#needs" }).canonical, "lists/todo");
  assert.equal(resolveRoute({ hash: "#routines/playbooks" }).canonical, "routines/checklists");
});

test("search keeps its route and marks no primary destination", () => {
  const route = resolveRoute({ hash: "#search" });
  assert.equal(route.page, "search");
  assert.equal(route.destination, null);
  assert.equal(route.segment, null);
  assert.equal(route.title, "Search");
  assert.equal(route.hash, "#search");
});

test("the invitation path opens People & devices when no hash is present", () => {
  assert.equal(resolveRoute({ hash: "", pathname: "/pair" }).canonical, "household/people");
  assert.equal(resolveRoute({ hash: "#today", pathname: "/pair" }).canonical, "today");
});

test("routeHash produces the short form for page defaults and the segment form otherwise", () => {
  assert.equal(routeHash("household"), "#household");
  assert.equal(routeHash("household", "privacy"), "#household/privacy");
  assert.equal(routeHash("lists"), "#lists/todo");
  assert.equal(routeHash("updates", "talk"), "#updates/handoffs", "no Talk tab: the page default");
  assert.equal(routeHash("updates", "chat"), "#updates/chat");
  assert.equal(resolveRoute({ hash: "#updates/chat" }).canonical, "updates/chat");
  assert.equal(routeHash("routines"), "#routines");
  assert.equal(routeHash("routines", "checklists"), "#routines/checklists");
  assert.equal(routeHash("search"), "#search");
  assert.equal(resolveRoute({ hash: routeHash("household", "notes") }).canonical, "household/notes");
});

test("classification maps to its list segment, legacy Today items live under To do", () => {
  assert.equal(listSegmentForClassification("need"), "todo");
  assert.equal(listSegmentForClassification("today"), "todo");
  assert.equal(listSegmentForClassification("shopping"), "shopping");
  assert.equal(listSegmentForClassification("staple"), "staples");
  assert.equal(listSegmentForClassification(undefined), "todo");
  assert.equal(SEGMENTS.lists[0].classification, "need");
});

test("an invitation link's fragment on /pair is not taken for a route (#97)", () => {
  assert.equal(resolveRoute({ hash: "#code=F7KM-Q2DX", pathname: "/pair" }).canonical, "household/people");
  assert.equal(resolveRoute({ hash: "", pathname: "/pair" }).canonical, "household/people");
  assert.equal(resolveRoute({ hash: "#code=F7KM-Q2DX", pathname: "/" }).canonical, "today", "only on /pair");
});

test("Simple view allows only Today, Chat and the Fridge, and sends everything else to Today (#345)", () => {
  const both = { chat: true, fridge: true };
  assert.equal(resolveSimpleRoute({ hash: "#updates/chat" }, both).canonical, "updates/chat");
  assert.equal(resolveSimpleRoute({ hash: "#household/fridge" }, both).canonical, "household/fridge");
  for (const hash of ["", "#lists", "#lists/shopping", "#lists/meals", "#routines", "#search", "#updates", "#updates/handoffs",
    "#updates/talk", "#household", "#household/people", "#household/privacy", "#household/appearance", "#more/security",
    "#needs", "#talk", "#handoff", "#nonsense"])
    assert.equal(resolveSimpleRoute({ hash }, both).canonical, "today", hash);
  assert.equal(resolveSimpleRoute({ hash: "", pathname: "/pair" }, both).canonical, "today", "/pair goes to Today");
  assert.equal(resolveSimpleRoute({ hash: "#code=ABCD", pathname: "/pair" }, both).canonical, "today");
  assert.equal(resolveSimpleRoute({ hash: "#updates/chat" }, { chat: false, fridge: true }).canonical, "today", "no chat access");
  assert.equal(resolveSimpleRoute({ hash: "#household/fridge" }, { chat: true, fridge: false }).canonical, "today", "no fridge access");
});

test("This week grew into the Calendar, reached from Today, which stays marked (#416, #661)", () => {
  const route = resolveRoute({ hash: "#week" });
  assert.equal(route.canonical, "week/week", "the Week view is the default");
  assert.equal(route.hash, "#week", "and keeps its short address");
  assert.equal(route.title, "Calendar");
  assert.equal(route.destination, "today");
  for (const view of ["day", "month"]) {
    const other = resolveRoute({ hash: `#week/${view}` });
    assert.deepEqual([other.canonical, other.hash, other.destination], [`week/${view}`, `#week/${view}`, "today"]);
  }
  assert.equal(resolveRoute({ hash: "#week/year" }).canonical, "week/week");
  assert.equal(resolveSimpleRoute({ hash: "#week" }, { chat: true, fridge: true }).canonical, "today", "Simple view has no week page");
});

test("For you and For the sitter (#441)", () => {
  const foryou = resolveRoute({ hash: "#foryou" });
  assert.equal(foryou.canonical, "foryou");
  assert.equal(foryou.title, "For you");
  assert.equal(foryou.destination, "today");
  assert.equal(resolveRoute({ hash: "#household/sitter" }).canonical, "household/sitter");
  assert.equal(resolveSimpleRoute({ hash: "#foryou" }, { chat: true, fridge: true }).canonical, "today");
});

test("the journal is a page reached from Household, not a sixth destination (#497)", () => {
  const journal = resolveRoute({ hash: "#journal" });
  assert.equal(journal.canonical, "journal");
  assert.equal(journal.title, "Journal");
  assert.equal(journal.destination, "household");
  assert.equal(PRIMARY_DESTINATIONS.length, 5);
  assert.ok(!PRIMARY_DESTINATIONS.some((entry) => entry.id === "journal"));
  assert.equal(resolveSimpleRoute({ hash: "#journal" }, { chat: true, fridge: true }).canonical, "today", "Simple view has no journal");
});
