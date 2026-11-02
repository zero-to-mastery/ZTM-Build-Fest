import assert from "node:assert/strict";
import test from "node:test";
import { addDays, cookLabel, cookOptions, filterRecipes, matchingStaple, mealOn, mealsOn, mergeMealsIntoWeek, mondayOf, recentRecipes, sameAsLastWeek, todayMealLines, tonightLine, weekDays, weekLabel } from "./meals-view.js";

test("weeks start on Monday and survive month, year and leap-day edges", () => {
  assert.equal(mondayOf("2026-10-19"), "2026-10-19");
  assert.equal(mondayOf("2026-10-25"), "2026-10-19", "Sunday belongs to the week before");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30", "no DST drift");
  const days = weekDays("2026-09-28");
  assert.deepEqual(days.map((day) => day.date), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.equal(days[0].label, "Mon 28 Sep");
  assert.equal(days[6].longLabel, "Sunday 4 Oct");
  assert.equal(weekLabel("2026-10-19"), "19–25 Oct");
  assert.equal(weekLabel("2026-09-28"), "28 Sep – 4 Oct");
});

test("anyone can cook, by preferred name, with nothing ranked", () => {
  const people = { myId: "a".repeat(32), memberIds: ["c".repeat(32), "a".repeat(32), "b".repeat(32), "c".repeat(32)], names: new Map([["c".repeat(32), "Sam"]]) };
  assert.deepEqual(cookOptions(people), [
    { id: "a".repeat(32), label: "You" },
    { id: "b".repeat(32), label: "Household member 1" },
    { id: "c".repeat(32), label: "Sam" },
  ]);
  assert.equal(cookLabel(null, people), "No one yet");
  assert.equal(cookLabel("d".repeat(32), people), "A former household member");
  assert.equal(tonightLine({ name: "Tacos", cookId: "a".repeat(32) }, people), "Tacos · You're cooking");
  assert.equal(tonightLine({ name: "Tacos", cookId: "c".repeat(32) }, people), "Tacos · Sam is cooking");
  assert.equal(tonightLine({ name: "Tacos", cookId: null }, people), "Tacos");
  assert.equal(tonightLine(null, people), null);
  // A device that doesn't sync knows only itself.
  assert.deepEqual(cookOptions({ myId: "a".repeat(32) }), [{ id: "a".repeat(32), label: "You" }]);
});

test("a staple is suggested only on an exact match", () => {
  const staples = [{ itemId: "1", text: "Milk", status: "active" }, { itemId: "2", text: "Free range eggs", status: "active" }, { itemId: "3", text: "Rice", status: "archived" }];
  assert.equal(matchingStaple("  milk ", staples)?.itemId, "1");
  assert.equal(matchingStaple("Eggs", staples), null, "partial matches are the person's call");
  assert.equal(matchingStaple("Rice", staples), null, "archived staples aren't suggested");
});

test("recent recipes come first, and the filter needs every word", () => {
  const meals = {
    recipes: [{ recipeId: "r1", name: "Tacos" }, { recipeId: "r2", name: "Fish pie" }, { recipeId: "r3", name: "Apple pie" }],
    dinners: [{ date: "2026-10-05", recipeId: "r2" }, { date: "2026-10-07", recipeId: "r1" }, { date: "2026-10-06", name: "Takeaway", recipeId: null }],
  };
  assert.deepEqual(recentRecipes(meals).map((recipe) => recipe.name), ["Tacos", "Fish pie", "Apple pie"]);
  assert.deepEqual(recentRecipes(meals, 1).map((recipe) => recipe.name), ["Tacos"]);
  assert.deepEqual(filterRecipes(meals.recipes, "pie").map((recipe) => recipe.name), ["Apple pie", "Fish pie"]);
  assert.deepEqual(filterRecipes(meals.recipes, "PIE fish").map((recipe) => recipe.name), ["Fish pie"]);
  assert.deepEqual(filterRecipes(meals.recipes, " ").map((recipe) => recipe.name), ["Apple pie", "Fish pie", "Tacos"]);
});

// Fuller meal plans (#679).
const plan = {
  recipes: [
    { recipeId: "a1", name: "Porridge", favourite: false, ingredients: [] },
    { recipeId: "b2", name: "Soup", favourite: true, ingredients: [] },
  ],
  meals: [
    { date: "2026-10-12", slot: "breakfast", recipeId: "a1", cookId: null, name: "Porridge" },
    { date: "2026-10-12", slot: "dinner", recipeId: null, cookId: "c3", name: "Curry" },
    { date: "2026-10-13", slot: "lunch", recipeId: "gone", cookId: null, name: "Old pasta" },
    { date: "2026-10-18", slot: "snack", recipeId: null, cookId: null, name: "Apples" },
    { date: "2026-10-19", slot: "dinner", recipeId: null, cookId: null, name: "Pizza" },
    { date: "2026-10-20", slot: "snack", recipeId: null, cookId: null, name: "Grapes" },
  ],
};

test("a day's meals come in planner order, and favourites lead the recent list", () => {
  assert.equal(mealOn(plan, "2026-10-12", "lunch"), null);
  assert.deepEqual(mealsOn(plan, "2026-10-12").map((meal) => `${meal.label}: ${meal.name}`), ["Breakfast: Porridge", "Dinner: Curry"]);
  assert.deepEqual(todayMealLines(plan, "2026-10-12"), ["Breakfast: Porridge"]);
  assert.deepEqual(recentRecipes(plan, 2).map((recipe) => recipe.name), ["Soup", "Porridge"]);
  assert.deepEqual(filterRecipes(plan.recipes, "", { favouritesOnly: true }).map((recipe) => recipe.name), ["Soup"]);
  // A KMLS v1 view (dinners only) still answers for dinner.
  assert.equal(mealOn({ recipes: [], dinners: [{ date: "2026-10-12", name: "Tacos" }] }, "2026-10-12", "dinner").name, "Tacos");
});

test("same as last week fills only empty slots, by recipe while it is listed", () => {
  assert.deepEqual(sameAsLastWeek(plan, "2026-10-19"), [
    { date: "2026-10-19", slot: "breakfast", recipeId: "a1", name: "Porridge" },
    // Monday's dinner is planned already (Pizza), so Curry isn't copied.
    { date: "2026-10-20", slot: "lunch", recipeId: null, name: "Old pasta" },
    // Tuesday's snack is planned (Grapes); Sunday's Apples are copied.
    { date: "2026-10-25", slot: "snack", recipeId: null, name: "Apples" },
  ]);
  assert.deepEqual(sameAsLastWeek(plan, "2026-10-05"), []);
});

test("This week gains every slot beside Rust's dinner", () => {
  const days = [{ date: 20261012, meals: [{ recipeId: null, cookId: "c3", name: "Curry" }], items: [] }, { date: 20261013, meals: [], items: [] }];
  const merged = mergeMealsIntoWeek(days, plan);
  assert.deepEqual(merged[0].meals.map((meal) => [meal.slot, meal.name]), [["breakfast", "Porridge"], ["dinner", "Curry"]]);
  assert.deepEqual(merged[1].meals.map((meal) => [meal.slot, meal.name]), [["lunch", "Old pasta"]]);
  assert.deepEqual(mergeMealsIntoWeek(days, null)[0].meals.map((meal) => meal.slot), ["dinner"]);
});
