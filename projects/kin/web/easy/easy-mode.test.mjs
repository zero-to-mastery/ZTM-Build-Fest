// Easy mode's navigation (#617).
import test from "node:test";
import assert from "node:assert/strict";
import { EASY_RECENT_KEY, EASY_RECENT_LIMIT, EASY_RECENT_MS, easyNavigation, noteVisit, readRecent, writeRecent } from "./easy-mode.js";
import { PRIMARY_DESTINATIONS, SEGMENTS } from "../routes.js";

const NOW = 1_800_000_000_000;

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
}

test("easy mode keeps Today, Lists (To do, Shopping), Updates and Household", () => {
  const { pages, segments } = easyNavigation([], NOW);
  assert.deepEqual([...pages], ["today", "lists", "updates", "household"]);
  assert.deepEqual([...segments.lists], ["todo", "shopping"]);
  assert.deepEqual([...segments.updates], ["handoffs", "chat"]);
  // Family photos (#673) stay on hand too.
  assert.deepEqual([...segments.household], ["hub", "photos"]);
  // Every place it names exists.
  const ids = new Set(PRIMARY_DESTINATIONS.map((entry) => entry.id));
  for (const page of pages) assert.ok(ids.has(page), page);
  for (const [page, kept] of Object.entries(segments))
    for (const id of kept) assert.ok(SEGMENTS[page].some((entry) => entry.id === id), `${page}/${id}`);
});

test("places used in the last two weeks stay, and so does the page on screen", () => {
  let recent = [];
  recent = noteVisit(recent, "routines/all", NOW - 3 * 86_400_000);
  recent = noteVisit(recent, "household/fridge", NOW - 1000);
  recent = noteVisit(recent, "lists/meals", NOW - EASY_RECENT_MS - 1);
  const { pages, segments } = easyNavigation(recent, NOW, { page: "household", segment: "privacy" });
  assert.ok(pages.has("routines"));
  assert.ok(segments.household.has("fridge"));
  assert.ok(segments.household.has("privacy"), "the page on screen");
  assert.ok(!segments.lists.has("meals"), "a visit older than two weeks is forgotten");
});

test("visits are newest first, one per route, bounded, and only route names", () => {
  let recent = [];
  for (let index = 0; index < EASY_RECENT_LIMIT + 5; index++) recent = noteVisit(recent, `household/${"abcdefghijklmnopqrstuvwxyz"[index]}`, NOW + index);
  assert.equal(recent.length, EASY_RECENT_LIMIT);
  recent = noteVisit(recent, "household/c", NOW + 100);
  assert.equal(recent[0].route, "household/c");
  assert.equal(recent.filter((entry) => entry.route === "household/c").length, 1);
  assert.equal(noteVisit([], "Lists/<b>", NOW).length, 0, "only canonical route names");
});

test("visits survive a reload; odd or unreadable storage reads as none", () => {
  const storage = memoryStorage();
  assert.deepEqual(readRecent(storage), []);
  assert.equal(writeRecent([{ route: "routines/all", at: NOW }], storage), true);
  assert.deepEqual(readRecent(storage), [{ route: "routines/all", at: NOW }]);
  storage.setItem(EASY_RECENT_KEY, '[{"route":"x/<y>","at":1},{"route":"today","at":"soon"},{"route":"today","at":5}]');
  assert.deepEqual(readRecent(storage), [{ route: "today", at: 5 }]);
  storage.setItem(EASY_RECENT_KEY, "{");
  assert.deepEqual(readRecent(storage), []);
  assert.deepEqual(readRecent({ getItem() { throw new Error("blocked"); } }), []);
  assert.equal(writeRecent([], { setItem() { throw new Error("full"); } }), false);
});
