// Meals (#333) through the real engine: JavaScript's canonical payloads are
// what Rust accepts, the meals view and Shopping plan read back, and a retry
// adds nothing twice. Needs the built kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const asOf = 1_791_475_200_000;
const civilDate = 20261003;

function household() {
  const records = [];
  let sequence = 0;
  const run = (command) => {
    sequence += 1;
    const result = engine.executeCommand(command, {
      eventId: id(sequence), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
      timestamp: asOf + sequence, logicalTime: BigInt(sequence),
    }, records, asOf, null, civilDate);
    records.push(result.encodedEvent);
    return result;
  };
  return { records, run };
}

test("recipes, dinners and cooks round-trip through Rust", () => {
  const home = household();
  home.run({ type: "add", id: id(0x31), text: "Milk", classification: "staple" });
  home.run({ type: "save-recipe", recipeId: id(0x71), name: "  Rice  pudding ", notes: "Serves 4\r\nStir often  ",
    ingredients: [{ text: "Milk", stapleId: id(0x31) }, { text: "Short-grain   rice" }] });
  home.run({ type: "set-dinner", date: "2026-10-05", recipeId: id(0x71), name: "Rice pudding" });
  home.run({ type: "set-dinner-cook", date: "2026-10-05", memberId: id(0x22) });
  home.run({ type: "set-dinner", date: "2026-10-06", name: "Leftovers" });
  const meals = engine.meals(home.records, asOf, civilDate);
  assert.deepEqual(meals, {
    recipes: [{ recipeId: id(0x71), name: "Rice pudding", notes: "Serves 4\nStir often", favourite: false, ingredients: [
      { text: "Milk", stapleId: id(0x31), staple: "active" },
      { text: "Short-grain rice", stapleId: null, staple: "none" },
    ] }],
    dinners: [
      { date: "2026-10-05", recipeId: id(0x71), cookId: id(0x22), name: "Rice pudding" },
      { date: "2026-10-06", recipeId: null, cookId: null, name: "Leftovers" },
    ],
    meals: [
      { date: "2026-10-05", slot: "dinner", recipeId: id(0x71), cookId: id(0x22), name: "Rice pudding" },
      { date: "2026-10-06", slot: "dinner", recipeId: null, cookId: null, name: "Leftovers" },
    ],
  });
  // Rust refuses what its rules forbid, as engine errors the host can show.
  assert.throws(() => home.run({ type: "set-dinner", date: "2026-10-05", recipeId: id(0x71), name: "Rice pudding" }), (error) => error.code !== undefined);
  assert.throws(() => home.run({ type: "set-dinner-cook", date: "2026-10-09", memberId: id(0x22) }), (error) => error.code !== undefined);
  assert.throws(() => home.run({ type: "save-recipe", recipeId: id(0x72), name: "x".repeat(81) }), /at most 80/);
});

test("the Shopping plan re-adds staples, skips what is listed, and a retry adds nothing twice", () => {
  const home = household();
  home.run({ type: "add", id: id(0x31), text: "Milk", classification: "staple" });
  home.run({ type: "add", id: id(0x32), text: "bread", classification: "shopping" });
  home.run({ type: "save-recipe", recipeId: id(0x71), name: "Breakfast", ingredients: [
    { text: "Milk", stapleId: id(0x31) }, { text: "Bread" }, { text: "Jam" }, { text: "jam" },
  ] });
  home.run({ type: "set-dinner", date: "2026-10-05", recipeId: id(0x71), name: "Breakfast" });
  const plan = engine.mealShoppingPlan({ date: "2026-10-05" }, home.records, asOf, civilDate);
  assert.deepEqual(plan, [
    { outcome: "readd-staple", text: "Milk", stapleId: id(0x31) },
    { outcome: "already", text: "Bread", stapleId: null },
    { outcome: "add", text: "Jam", stapleId: null },
  ]);
  // The first addition lands, then "a failure"; the retry plans only Jam.
  home.run({ type: "add", id: id(0x41), text: "Milk", classification: "shopping" });
  const retry = engine.mealShoppingPlan({ recipeId: id(0x71) }, home.records, asOf, civilDate);
  assert.deepEqual(retry.filter((line) => line.outcome !== "already").map((line) => line.text), ["Jam"]);
  assert.throws(() => engine.mealShoppingPlan({ date: "2026-10-09" }, home.records, asOf, civilDate));
});

// Fuller meal plans (#679, kinds 80–82): every slot and favourites read back
// through KMLS v2, and one week's plan covers every slot.
test("breakfast, lunch, snacks and favourites round-trip, and the week's plan covers every slot", () => {
  const home = household();
  home.run({ type: "save-recipe", recipeId: id(0x71), name: "Porridge", ingredients: [{ text: "Oats" }, { text: "Milk" }] });
  home.run({ type: "save-recipe", recipeId: id(0x72), name: "Sandwiches", ingredients: [{ text: "Bread" }, { text: "milk" }] });
  const set = home.run({ type: "set-meal", date: "2026-10-05", slot: "breakfast", recipeId: id(0x71), name: "Porridge" });
  assert.equal(set.metadata.kind, "MEAL_SET");
  home.run({ type: "set-meal", date: "2026-10-06", slot: "lunch", recipeId: id(0x72), name: "Sandwiches" });
  home.run({ type: "set-meal", date: "2026-10-06", slot: "snack", name: "  Apple   slices " });
  home.run({ type: "set-dinner", date: "2026-10-06", name: "Soup" });
  assert.equal(home.run({ type: "set-recipe-favourite", recipeId: id(0x72), favourite: true }).metadata.kind, "RECIPE_FAVOURITE_SET");
  const meals = engine.meals(home.records, asOf, civilDate);
  assert.deepEqual(meals.recipes.map((recipe) => [recipe.name, recipe.favourite]), [["Porridge", false], ["Sandwiches", true]]);
  assert.deepEqual(meals.meals.map((meal) => [meal.date, meal.slot, meal.name]), [
    ["2026-10-05", "breakfast", "Porridge"],
    ["2026-10-06", "lunch", "Sandwiches"],
    ["2026-10-06", "dinner", "Soup"],
    ["2026-10-06", "snack", "Apple slices"],
  ]);
  assert.deepEqual(meals.dinners.map((dinner) => dinner.name), ["Soup"]);
  // The week from Monday 5 October: Oats, Milk, Bread ("milk" counts once).
  const week = engine.mealShoppingPlan({ week: "2026-10-05" }, home.records, asOf, civilDate);
  assert.deepEqual(week.map((line) => [line.outcome, line.text]), [["add", "Oats"], ["add", "Milk"], ["add", "Bread"]]);
  const lunch = engine.mealShoppingPlan({ date: "2026-10-06", slot: "lunch" }, home.records, asOf, civilDate);
  assert.deepEqual(lunch.map((line) => line.text), ["Bread", "milk"]);
  assert.deepEqual(engine.mealShoppingPlan({ week: "2026-10-12" }, home.records, asOf, civilDate), []);
  // Rust's rules: no change, dinner on kind 80, an unfavourite twice.
  assert.throws(() => home.run({ type: "set-meal", date: "2026-10-05", slot: "breakfast", recipeId: id(0x71), name: "Porridge" }), (error) => error.code !== undefined);
  assert.throws(() => home.run({ type: "set-meal", date: "2026-10-05", slot: "dinner", name: "Soup" }), (error) => error.code === 2);
  home.run({ type: "clear-meal", date: "2026-10-06", slot: "snack" });
  home.run({ type: "set-recipe-favourite", recipeId: id(0x72), favourite: false });
  assert.throws(() => home.run({ type: "set-recipe-favourite", recipeId: id(0x72), favourite: false }), (error) => error.code !== undefined);
  const after = engine.meals(home.records, asOf, civilDate);
  assert.equal(after.meals.some((meal) => meal.slot === "snack"), false);
  assert.equal(after.recipes.some((recipe) => recipe.favourite), false);
});
