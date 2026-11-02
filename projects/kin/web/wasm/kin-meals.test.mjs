// Meals (#333) as JavaScript encodes and reads them; no WASM needed. The
// engine-backed tests (meals-engine.test.mjs) check the same bytes against
// Rust.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MEAL_COMMANDS, MEAL_PLAN_COMMANDS, MEAL_SLOTS, MealFormatError, collapseText, decodeMeals, decodePlan, encodeDate, encodeMealIntent, encodeMealPayload,
  encodePlanQuery, ingredientsFromText, mealCommandKind, normalizeNotes, normalizeRecipe, planSummary,
} from "./kin-meals.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const bytesOf = (...parts) => {
  const flat = parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : Array.isArray(part) ? part : [...part]));
  return Uint8Array.from(flat);
};
const u16 = (value) => [value & 0xff, value >> 8];
const u32 = (value) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return [...out]; };
const raw = (hex) => [...Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16))];

test("text is normalized exactly as Rust does it", () => {
  assert.equal(collapseText("  red \t onions  "), "red onions");
  // U+FEFF is not white space in Rust; U+0085 and U+2028 are.
  assert.equal(collapseText("a﻿b"), "a﻿b");
  assert.equal(collapseText("x\u0085y z"), "x y z");
  assert.equal(normalizeNotes("  one  \r\ntwo\n\n"), "one\ntwo");
  assert.throws(() => normalizeNotes("bell\u0007"), MealFormatError);
  assert.throws(() => normalizeRecipe({ name: "   " }), /can't be empty/);
  assert.throws(() => normalizeRecipe({ name: "x".repeat(81) }), /at most 80/);
});

test("the ingredients box keeps every pasted line, drops blank ones and names a bad line", () => {
  const lines = ingredientsFromText("Milk\n\n  2 eggs  \r\nFlour\n   \n");
  assert.deepEqual(lines, [{ text: "Milk", stapleId: null }, { text: "2 eggs", stapleId: null }, { text: "Flour", stapleId: null }]);
  // Unchanged lines keep their staple link.
  assert.deepEqual(ingredientsFromText("Milk\nButter", [{ text: "Milk", stapleId: id(3) }]), [{ text: "Milk", stapleId: id(3) }, { text: "Butter", stapleId: null }]);
  assert.deepEqual(ingredientsFromText("Milk\nmilk\n MILK "), [{ text: "Milk", stapleId: null }], "a line typed twice is kept once");
  assert.throws(() => ingredientsFromText(`ok\n${"y".repeat(121)}`), (error) => error instanceof MealFormatError && error.detail.line === 2 && /^Line 2:/.test(error.message));
  assert.throws(() => ingredientsFromText(Array.from({ length: 41 }, (_, n) => `Thing ${n}`).join("\n")), /at most 40 ingredients/);
  // A recipe too large for one sync envelope says so.
  const wide = Array.from({ length: 40 }, (_, n) => ({ text: `${String(n).padStart(3, "0")} ${"é".repeat(60)}` }));
  assert.throws(() => normalizeRecipe({ name: "Big", ingredients: wide, notes: "n".repeat(2000) }), /too long to save/);
});

test("payloads are laid out as rust/src/meals.rs reads them", () => {
  assert.deepEqual(MEAL_COMMANDS, ["save-recipe", "archive-recipe", "set-dinner", "clear-dinner", "set-dinner-cook"]);
  assert.deepEqual(encodeMealPayload({
    type: "save-recipe", recipeId: id(7), name: " Tacos ", notes: "Serves 4 ",
    ingredients: [{ text: "Tortillas", stapleId: id(3) }, { text: "Salsa  verde" }],
  }), bytesOf(raw(id(7)), u16(5), "Tacos", [2, 0], [1, 0, 0, 0], raw(id(3)), u16(9), "Tortillas", [0, 0, 0, 0], u16(11), "Salsa verde", u16(8), "Serves 4"));
  assert.deepEqual(encodeMealPayload({ type: "archive-recipe", recipeId: id(7) }), bytesOf(raw(id(7))));
  assert.deepEqual(encodeMealPayload({ type: "set-dinner", date: "2026-10-05", recipeId: id(7), name: "Tacos" }),
    bytesOf(u32(20261005), [1, 0, 0, 0], raw(id(7)), u16(5), "Tacos"));
  assert.deepEqual(encodeMealPayload({ type: "set-dinner", date: 20261006, name: "Leftovers" }), bytesOf(u32(20261006), [0, 0, 0, 0], u16(9), "Leftovers"));
  assert.deepEqual(encodeMealPayload({ type: "clear-dinner", date: "2026-10-06" }), bytesOf(u32(20261006)));
  assert.deepEqual(encodeMealPayload({ type: "set-dinner-cook", date: "2026-10-05", memberId: id(2) }), bytesOf(u32(20261005), [1, 0, 0, 0], raw(id(2))));
  assert.deepEqual(encodeMealPayload({ type: "set-dinner-cook", date: "2026-10-05", memberId: null }), bytesOf(u32(20261005), [0, 0, 0, 0]));
  assert.throws(() => encodeMealPayload({ type: "set-dinner", date: "2026-02-30", name: "x" }), /invalid date/);
  assert.throws(() => encodeMealPayload({ type: "archive-recipe", recipeId: "0".repeat(32) }), /invalid recipe/);
  assert.equal(encodeDate("0001-01-01"), 10101);
});

test("the KCMD header names the action 59–63 and carries the identity", () => {
  const identity = { eventId: id(1), householdId: id(0xaa), actorId: id(2), deviceId: id(3), timestamp: 1_791_475_200_000, logicalTime: 4n };
  const packet = encodeMealIntent({ type: "clear-dinner", date: "2026-10-06" }, identity);
  const view = new DataView(packet.buffer);
  assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
  assert.equal(view.getUint16(8, true), 62);
  assert.deepEqual([...packet.subarray(92, 128)].every((byte, index) => index >= 32 || byte === 0), true, "own ID, date, option and expiry stay zero");
  assert.equal(view.getUint32(124, true), 4);
  assert.deepEqual([...packet.subarray(128)], u32(20261006));
  // Byte-array IDs work as hex ones do.
  const bytes = encodeMealIntent({ type: "clear-dinner", date: "2026-10-06" }, { ...identity, eventId: Uint8Array.from(raw(id(1))) });
  assert.deepEqual(bytes, packet);
  const query = encodePlanQuery({ date: "2026-10-05" });
  assert.deepEqual([...query.subarray(0, 12)], [75, 77, 80, 81, 1, 0, 0, 0, 2, 0, 0, 0]);
  assert.equal(new DataView(query.buffer).getUint32(28, true), 20261005);
  assert.equal(encodePlanQuery({ recipeId: id(7) })[8], 1);
});

test("KMLS and KMSP decode into what the screens show", () => {
  const meals = bytesOf("KMLS", u16(1), [0, 0], u32(1), u32(1),
    raw(id(7)), u16(5), "Tacos", [2, 0, 0, 0],
    [1, 0, 0, 0], raw(id(3)), u16(9), "Tortillas",
    [2, 0, 0, 0], raw(id(4)), u16(4), "Lime",
    u16(0),
    u32(20261005), [3, 0, 0, 0], raw(id(7)), raw(id(2)), u16(5), "Tacos");
  assert.deepEqual(decodeMeals(meals), {
    recipes: [{ recipeId: id(7), name: "Tacos", notes: "", favourite: false, ingredients: [
      { text: "Tortillas", stapleId: id(3), staple: "active" },
      { text: "Lime", stapleId: id(4), staple: "archived" },
    ] }],
    dinners: [{ date: "2026-10-05", recipeId: id(7), cookId: id(2), name: "Tacos" }],
    meals: [{ date: "2026-10-05", slot: "dinner", recipeId: id(7), cookId: id(2), name: "Tacos" }],
  });
  assert.throws(() => decodeMeals(bytesOf(meals, [0])), MealFormatError);
  // v1 has no favourite flag; KMLS v3 is unknown.
  const flagged = bytesOf(meals);
  flagged[16 + 16 + 7 + 1] = 1;
  assert.throws(() => decodeMeals(flagged), MealFormatError);
  const later = bytesOf(meals);
  later[4] = 3;
  assert.throws(() => decodeMeals(later), MealFormatError);
  const plan = bytesOf("KMSP", u16(1), [0, 0], u32(2), [2, 0, 0, 0], raw(id(3)), u16(4), "Milk", [3, 0, 0, 0], new Array(16).fill(0), u16(5), "Bread");
  assert.deepEqual(decodePlan(plan), [{ outcome: "readd-staple", text: "Milk", stapleId: id(3) }, { outcome: "already", text: "Bread", stapleId: null }]);
});

// Fuller meal plans (#679): TEST-VECTORS 180–182, 184 and 185.
test("meal plan payloads, KCMD actions 80–82, KMLS v2 and KMPQ v2", () => {
  assert.deepEqual(MEAL_PLAN_COMMANDS, ["set-meal", "clear-meal", "set-recipe-favourite"]);
  assert.deepEqual(MEAL_SLOTS, ["breakfast", "lunch", "dinner", "snack"]);
  // 180
  assert.deepEqual(encodeMealPayload({ type: "set-meal", date: "2026-10-05", slot: "lunch", name: " Soup " }),
    bytesOf(raw("8d283501"), [2, 0, 0, 0], [0, 0, 0, 0], u16(4), "Soup"));
  assert.deepEqual(encodeMealPayload({ type: "set-meal", date: "2026-10-05", slot: "breakfast", recipeId: id(7), name: "Porridge" }),
    bytesOf(raw("8d283501"), [1, 0, 0, 0], [1, 0, 0, 0], raw(id(7)), u16(8), "Porridge"));
  assert.throws(() => encodeMealPayload({ type: "set-meal", date: "2026-10-05", slot: "dinner", name: "Soup" }), MealFormatError);
  assert.throws(() => encodeMealPayload({ type: "set-meal", date: "2026-10-05", slot: "brunch", name: "Soup" }), MealFormatError);
  // 181
  assert.deepEqual(encodeMealPayload({ type: "clear-meal", date: "2026-10-05", slot: "snack" }), bytesOf(raw("8d283501"), [4, 0, 0, 0]));
  // 182
  assert.deepEqual(encodeMealPayload({ type: "set-recipe-favourite", recipeId: id(7), favourite: true }), bytesOf(raw(id(7)), [1, 0, 0, 0]));
  assert.deepEqual(encodeMealPayload({ type: "set-recipe-favourite", recipeId: id(7), favourite: false }), bytesOf(raw(id(7)), [0, 0, 0, 0]));
  assert.throws(() => encodeMealPayload({ type: "set-recipe-favourite", recipeId: id(7), favourite: 1 }), MealFormatError);
  const identity = { eventId: id(1), householdId: id(0xaa), actorId: id(2), deviceId: id(3), timestamp: 1_791_475_200_000, logicalTime: 4n };
  for (const [type, kind] of [["set-meal", 80], ["clear-meal", 81], ["set-recipe-favourite", 82], ["set-dinner", 61]]) {
    assert.equal(mealCommandKind(type), kind);
  }
  const packet = encodeMealIntent({ type: "clear-meal", date: "2026-10-05", slot: "snack" }, identity);
  assert.equal(new DataView(packet.buffer).getUint16(8, true), 81);
  // 184
  const plans = bytesOf("KMLS", u16(2), [0, 0], u32(1), u32(1),
    raw(id(7)), u16(4), "Oats", [0, 1, 0, 0], u16(0),
    u32(20261005), [1, 1, 0, 0], raw(id(7)), new Array(16).fill(0), u16(4), "Oats");
  assert.deepEqual(decodeMeals(plans), {
    recipes: [{ recipeId: id(7), name: "Oats", notes: "", favourite: true, ingredients: [] }],
    dinners: [],
    meals: [{ date: "2026-10-05", slot: "breakfast", recipeId: id(7), cookId: null, name: "Oats" }],
  });
  const badSlot = bytesOf(plans);
  badSlot[plans.length - 6 - 32 - 4] = 5;
  assert.throws(() => decodeMeals(badSlot), MealFormatError);
  // 185: v1 for a recipe or a dinner; v2 for another slot or a week.
  assert.deepEqual([...encodePlanQuery({ date: "2026-10-05", slot: "dinner" }).subarray(0, 12)], [75, 77, 80, 81, 1, 0, 0, 0, 2, 0, 0, 0]);
  const lunch = encodePlanQuery({ date: "2026-10-05", slot: "lunch" });
  assert.deepEqual([...lunch.subarray(0, 12)], [75, 77, 80, 81, 2, 0, 0, 0, 3, 2, 0, 0]);
  assert.equal(new DataView(lunch.buffer).getUint32(28, true), 20261005);
  const week = encodePlanQuery({ week: "2026-10-05" });
  assert.deepEqual([...week.subarray(0, 12)], [75, 77, 80, 81, 2, 0, 0, 0, 4, 0, 0, 0]);
  assert.deepEqual([...week.subarray(12, 32)], [...new Array(16).fill(0), ...raw("8d283501")]);
});

test("feedback counts what was added, re-added and already listed", () => {
  const line = (outcome, text) => ({ outcome, text, stapleId: null });
  assert.equal(
    planSummary([line("add", "Flour"), line("add", "Sugar"), line("add", "Jam"), line("add", "Salt"), line("readd-staple", "Milk"), line("readd-staple", "Eggs"), line("already", "Bread")]),
    "Added 4 · Re-added 2 Staples (Milk, Eggs) · Already on Shopping 1 (Bread)",
  );
  assert.equal(planSummary([line("readd-staple", "Milk")]), "Re-added 1 Staple (Milk)");
  assert.equal(planSummary([]), "This recipe has no ingredients to add.");
});
