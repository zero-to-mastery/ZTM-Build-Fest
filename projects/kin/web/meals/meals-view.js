// Meals without the DOM (#333): the week a day belongs to, the people who
// can cook, a staple that matches an ingredient, recent recipes and tonight's
// line. Dates are "YYYY-MM-DD" civil dates throughout; arithmetic is done in
// UTC so a daylight-saving change never moves a day.
import { collapseText } from "../wasm/kin-meals.js";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const toUtc = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  return value;
};
const fromUtc = (value) => `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;

/** The date `days` after `date` (negative goes back). */
export const addDays = (date, days) => fromUtc(new Date(toUtc(date).getTime() + days * DAY_MS));

/** Monday of the week `date` falls in (weeks start on Monday, like weekly
 * routines). */
export function mondayOf(date) {
  const weekday = (toUtc(date).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

/** The seven days of the week starting `monday`, each with its labels. */
export function weekDays(monday) {
  return WEEKDAYS.map((name, index) => {
    const date = addDays(monday, index);
    const value = toUtc(date);
    return {
      date,
      weekday: name,
      label: `${SHORT_WEEKDAYS[index]} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`,
      longLabel: `${name} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`,
    };
  });
}

/** "5–11 Oct" or "29 Sep – 5 Oct" for a week. */
export function weekLabel(monday) {
  const start = toUtc(monday), end = toUtc(addDays(monday, 6));
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}`
    : `${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}`;
}

/**
 * Who can be the cook: "You" first, then the household's other current
 * members by preferred name (v1.3), else "Household member N" in a stable
 * order. Anyone may cook, Limited and Temporary members included; nothing is
 * counted or ranked.
 */
export function cookOptions({ myId = null, memberIds = [], names = new Map() } = {}) {
  const others = [...new Set(memberIds)].filter((id) => id && id !== myId).sort();
  const options = myId ? [{ id: myId, label: "You" }] : [];
  others.forEach((id, index) => options.push({ id, label: names.get(id) ?? `Household member ${index + 1}` }));
  return options;
}

/** The cook's label for a day, "You", a name, or "No one yet". */
export function cookLabel(cookId, people) {
  if (!cookId) return "No one yet";
  return cookOptions(people).find((option) => option.id === cookId)?.label ?? "A former household member";
}

/** "Tacos · You're cooking", "Tacos · Sam's cooking" or "Tacos". */
export function tonightLine(dinner, people) {
  if (!dinner) return null;
  if (!dinner.cookId) return dinner.name;
  const label = cookLabel(dinner.cookId, people);
  return label === "You" ? `${dinner.name} · You're cooking` : `${dinner.name} · ${label} is cooking`;
}

/** The active staple whose text matches an ingredient exactly (collapsed and
 * lowercased), so Kin can suggest it and say so; otherwise null. */
export function matchingStaple(text, staples) {
  const key = collapseText(text).toLowerCase();
  return staples.find((item) => item.status !== "archived" && collapseText(item.text).toLowerCase() === key) ?? null;
}

/** Every planned meal, any slot: `meals.meals` (KMLS v2), else the dinners. */
const plannedMeals = (meals) => meals?.meals ?? (meals?.dinners ?? []).map((dinner) => ({ ...dinner, slot: "dinner" }));

/** Recipes most recently planned first (by the latest date they were planned
 * for, in any slot), favourites before the rest (#679), then by name, for
 * the plan dialog. */
export function recentRecipes(meals, limit = 5) {
  const lastPlanned = new Map();
  for (const meal of plannedMeals(meals)) {
    if (meal.recipeId && (lastPlanned.get(meal.recipeId) ?? "") < meal.date) lastPlanned.set(meal.recipeId, meal.date);
  }
  return [...meals.recipes]
    .sort((left, right) => Number(Boolean(right.favourite)) - Number(Boolean(left.favourite)) ||
      (lastPlanned.get(right.recipeId) ?? "").localeCompare(lastPlanned.get(left.recipeId) ?? "") || left.name.localeCompare(right.name))
    .slice(0, limit);
}

/** Recipes whose name contains every word of `query` (case-insensitive);
 * with `favouritesOnly`, only favourites (#679). */
export function filterRecipes(recipes, query, { favouritesOnly = false } = {}) {
  const words = collapseText(query).toLowerCase().split(" ").filter(Boolean);
  return recipes
    .filter((recipe) => !favouritesOnly || recipe.favourite)
    .filter((recipe) => words.every((word) => recipe.name.toLowerCase().includes(word)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// ---- Fuller meal plans (#679, ADR 0022 §7) --------------------------------

/** The meals of a day in the planner's order (kin-meals.js MEAL_SLOTS). */
export const SLOTS = Object.freeze(["breakfast", "lunch", "dinner", "snack"]);
export const SLOT_LABELS = Object.freeze({ breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" });

/** The meal planned for `date` ("YYYY-MM-DD") in `slot`, or null. */
export function mealOn(meals, date, slot) {
  return plannedMeals(meals).find((meal) => meal.date === date && meal.slot === slot) ?? null;
}

/** A day's planned meals in slot order, as [{ slot, label, ...meal }]. */
export function mealsOn(meals, date) {
  return SLOTS.flatMap((slot) => {
    const meal = mealOn(meals, date, slot);
    return meal ? [{ ...meal, slot, label: SLOT_LABELS[slot] }] : [];
  });
}

/**
 * "Same as last week": what to plan in the week from `monday` so that each
 * empty slot gets the meal planned seven days earlier. Slots already planned
 * are left alone. A recipe still listed is planned as itself, under its
 * current name; one archived since is planned by name only. Cooks aren't
 * copied. Returns [{ date, slot, recipeId, name }] in date and slot order.
 */
export function sameAsLastWeek(meals, monday) {
  const recipes = new Map((meals?.recipes ?? []).map((recipe) => [recipe.recipeId, recipe]));
  const copies = [];
  for (const { date } of weekDays(monday)) {
    const before = addDays(date, -7);
    for (const slot of SLOTS) {
      const source = mealOn(meals, before, slot);
      if (!source || mealOn(meals, date, slot)) continue;
      const recipe = source.recipeId ? recipes.get(source.recipeId) : null;
      copies.push({ date, slot, recipeId: recipe?.recipeId ?? null, name: recipe?.name ?? source.name });
    }
  }
  return copies;
}

/** YYYYMMDD as "YYYY-MM-DD". */
const civilText = (value) => (typeof value === "number"
  ? `${String(Math.floor(value / 10_000)).padStart(4, "0")}-${String(Math.floor(value / 100) % 100).padStart(2, "0")}-${String(value % 100).padStart(2, "0")}`
  : value);

/**
 * This week (KWKD days from `kin_week`, whose meals are the dinner only)
 * with every slot (#679): each day's `meals` becomes [{ slot, recipeId,
 * cookId, name }] in slot order, the dinner from Rust's week and the other
 * slots from the meals view. Without a meals view only dinners show.
 */
export function mergeMealsIntoWeek(days, meals) {
  return (days ?? []).map((day) => {
    const date = civilText(day.date);
    const others = SLOTS.filter((slot) => slot !== "dinner").flatMap((slot) => {
      const meal = mealOn(meals, date, slot);
      return meal ? [{ slot, recipeId: meal.recipeId, cookId: null, name: meal.name }] : [];
    });
    const dinners = (day.meals ?? []).map((meal) => ({ ...meal, slot: "dinner" }));
    const merged = [...others, ...dinners].sort((left, right) => SLOTS.indexOf(left.slot) - SLOTS.indexOf(right.slot));
    return { ...day, meals: merged };
  });
}

/** Today's meals other than dinner ("Breakfast: Porridge"), for Today. */
export function todayMealLines(meals, date) {
  return mealsOn(meals, date).filter((meal) => meal.slot !== "dinner").map((meal) => `${meal.label}: ${meal.name}`);
}
