// Fuller meal plans (#679, ADR 0022 §7) in the real app: plan breakfast from
// a recipe and lunch as a one-off, see them on Today and This week, star a
// favourite and filter by it, add the whole week's ingredients to Shopping
// twice without duplicates, and copy the week with "Same as last week".
// Runs in the page (serialized with toString), after the Meals suites.
export async function mealPlanRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const waitFor = async (condition, message, attempts = 900) => {
    for (let i = 0; i < attempts; i++) {
      if (!app.busy && condition()) return;
      await frame();
    }
    const shown = [...document.querySelectorAll('[role="alert"]:not([hidden]), [role="status"]')]
      .map((node) => node.textContent.trim()).filter(Boolean).join(" | ");
    throw new Error(`Timed out: ${message} (showing: ${shown || "nothing"}; meals: ${JSON.stringify(app.mealsState?.meals ?? null).slice(0, 600)})`);
  };
  const idle = () => waitFor(() => !app.busy && !app.ctx.meals.loading, "meals work returns idle");
  const pad = (value) => String(value).padStart(2, "0");
  const text = (civil) => `${Math.floor(civil / 10_000)}-${pad(Math.floor(civil / 100) % 100)}-${pad(civil % 100)}`;
  const addDays = (date, days) => {
    const [year, month, day] = date.split("-").map(Number);
    const value = new Date(0);
    value.setUTCFullYear(year, month - 1, day + days);
    return `${String(value.getUTCFullYear()).padStart(4, "0")}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  };
  const civil = app.ctx.navigation.currentCivilDate();
  const today = text(civil);
  const nextWeek = addDays(today, 7);
  const tag = crypto.randomUUID().slice(0, 6);
  const porridge = `Meal plan porridge ${tag}`;
  const oats = `Meal plan oats ${tag}`;
  const sandwiches = `Meal plan sandwiches ${tag}`;
  const meals = app.meals;
  const mealIn = (date, slot) => app.mealsState?.meals?.find((meal) => meal.date === date && meal.slot === slot) ?? null;
  const slotRow = (date, slot) => meals.querySelector(`.meal-day[data-date="${date}"] .meal-slot[data-slot="${slot}"]`);
  const shoppingCount = (value) => app.state.items.filter((item) => item.text === value && item.classification === "shopping" && item.status === "active").length;

  app.ctx.navigation.navigate("#lists/meals");
  await idle();
  await frame();
  check(meals.checkVisibility(), "Lists › Meals shows the meals view");
  // Every meal shows (a phone folds away empty ones until asked).
  for (const box of meals.querySelectorAll(".meal-slot-filter input")) {
    if (!box.checked && !box.disabled) box.click();
  }
  await frame();
  const today_ = meals.querySelector(`.meal-day[data-date="${today}"]`);
  check([...today_.querySelectorAll(".meal-slot")].map((row) => row.dataset.slot).join() === "breakfast,lunch,dinner,snack",
    "a day lists breakfast, lunch, dinner and snack in order");
  check(meals.querySelector('.meal-slot-filter input[value="dinner"]').disabled, "dinner always shows");

  // A recipe, planned for breakfast through the dialog.
  check(await app.ctx.meals.saveRecipe({ name: porridge, ingredients: [{ text: oats }, { text: "Meal plan milk" }], notes: "" }), "the recipe is saved");
  await idle();
  const recipe = app.mealsState.recipes.find((entry) => entry.name === porridge);
  const plan = meals.querySelector(".meal-plan-dialog");
  const breakfastButton = () => slotRow(today, "breakfast").querySelector(".meal-slot-plan");
  check(/^Plan breakfast for /.test(breakfastButton().getAttribute("aria-label")), "the button names the meal and day", breakfastButton().getAttribute("aria-label"));
  breakfastButton().click();
  check(plan.open && /^Breakfast for /.test(plan.querySelector("h2").textContent), "the dialog plans breakfast");
  check(plan.querySelector("select").hidden, "only dinner asks who's cooking");
  plan.querySelector(`.meal-plan-recipes button[data-recipe-id="${recipe.recipeId}"]`).click();
  await waitFor(() => !plan.open && mealIn(today, "breakfast")?.recipeId === recipe.recipeId, "breakfast is planned from the recipe");
  check(document.activeElement === breakfastButton(), "focus returns to the breakfast button");
  check(slotRow(today, "breakfast").querySelector(".meal-slot-name").textContent === porridge, "the card shows breakfast");

  // Lunch as a one-off.
  slotRow(today, "lunch").querySelector(".meal-slot-plan").click();
  plan.querySelector(".meal-plan-other input").value = `  ${sandwiches}  `;
  plan.querySelector(".meal-plan-other button").click();
  await waitFor(() => !plan.open && mealIn(today, "lunch")?.name === sandwiches, "lunch is planned as a one-off");
  check(!app.mealsState.dinners.some((dinner) => dinner.name === sandwiches), "lunch isn't a dinner");

  // A favourite, and the Favourites filter.
  const star = () => meals.querySelector(`.recipe[data-recipe-id="${recipe.recipeId}"] .recipe-favourite`);
  check(star().getAttribute("aria-pressed") === "false" && star().querySelector(".control-word"), "the star is a toggle with a word for easy mode");
  star().click();
  await waitFor(() => app.mealsState.recipes.find((entry) => entry.recipeId === recipe.recipeId)?.favourite && star()?.getAttribute("aria-pressed") === "true", "the recipe is a favourite");
  const filter = meals.querySelector(".recipe-favourites-filter");
  check(!filter.hidden, "Favourites shows once there is one");
  filter.click();
  await frame();
  const listed = [...meals.querySelectorAll(".recipe")].map((item) => item.dataset.recipeId);
  check(filter.getAttribute("aria-pressed") === "true" && listed.length >= 1 && listed.every((id) => app.mealsState.recipes.find((entry) => entry.recipeId === id)?.favourite),
    "the filter lists favourites only", listed.length);
  filter.click();
  await frame();

  // This week's ingredients, every meal, twice without duplicates.
  meals.querySelector(".meals-week-ingredients").click();
  await idle();
  await waitFor(() => shoppingCount(oats) === 1, "the week's ingredients reach Shopping");
  check(/Added/.test(meals.querySelector(".meals-result").textContent), "the result says what was added", meals.querySelector(".meals-result").textContent);
  meals.querySelector(".meals-week-ingredients").click();
  await idle();
  await waitFor(() => /Already on Shopping/.test(meals.querySelector(".meals-result").textContent), "a second add reports what is already there");
  check(shoppingCount(oats) === 1, "adding the week twice never duplicates");

  // Today and This week show the meals.
  app.ctx.navigation.navigate("#today");
  await idle();
  await waitFor(() => [...app.tonight.querySelectorAll(".today-meals li")].map((item) => item.textContent).join("|") === `Breakfast: ${porridge}|Lunch: ${sandwiches}`,
    "Today lists today's other meals");
  app.ctx.navigation.navigate("#week");
  await waitFor(() => [...(app.week.querySelector(`.week-day[data-date="${civil}"]`)?.querySelectorAll(".week-meal") ?? [])].some((row) => row.textContent === `Breakfast: ${porridge}`),
    "This week lists breakfast on today");

  // Same as last week, from next week: copies only empty slots, once.
  app.ctx.navigation.navigate("#lists/meals");
  await idle();
  [...meals.querySelectorAll(".meals-week-nav button")].find((button) => button.textContent === "Next week").click();
  await frame();
  check(meals.querySelector(`.meal-day[data-date="${nextWeek}"]`), "next week shows");
  meals.querySelector(".meals-same-as-last").click();
  await idle();
  await waitFor(() => mealIn(nextWeek, "breakfast")?.recipeId === recipe.recipeId && mealIn(nextWeek, "lunch")?.name === sandwiches, "next week copies breakfast and lunch");
  check(/^Copied \d+ meals? from last week/.test(app.status.textContent), "the status says what was copied", app.status.textContent);
  const count = app.mealsState.meals.length;
  meals.querySelector(".meals-same-as-last").click();
  await idle();
  check(app.mealsState.meals.length === count && /Nothing to copy/.test(app.status.textContent), "copying again adds nothing", app.status.textContent);

  // Every control is a comfortable target, and nothing scrolls sideways.
  const small = [...meals.querySelectorAll(".meals-layout button, .meals-layout select")]
    .filter((node) => node.getClientRects().length && node.getBoundingClientRect().height < 44).map((node) => node.getAttribute("aria-label") || node.textContent);
  check(!small.length, "controls are at least 44px tall", small);
  check(meals.scrollWidth <= meals.clientWidth + 1, "the meals view never scrolls sideways");

  // Leave things as found: clear what was planned, unfavourite.
  for (const [date, slot] of [[today, "breakfast"], [today, "lunch"], [nextWeek, "breakfast"], [nextWeek, "lunch"]]) {
    if (mealIn(date, slot)) check(await app.ctx.meals.clearMeal(date, slot), `${slot} on ${date} clears`);
  }
  for (const meal of app.mealsState.meals.filter((entry) => entry.date >= nextWeek && entry.date <= addDays(nextWeek, 6))) {
    if (meal.slot === "dinner") await app.ctx.meals.clearDinner(meal.date);
    else await app.ctx.meals.clearMeal(meal.date, meal.slot);
  }
  check(await app.ctx.meals.setFavourite(recipe.recipeId, false), "the favourite clears");
  await idle();
  check(!mealIn(today, "breakfast") && !app.tonight.querySelector(".today-meals li"), "nothing else is planned today");
  try { localStorage.removeItem("kin.meal-slots"); } catch { /* not kept */ }
  meals.shownSlots = null;
  [...meals.querySelectorAll(".meals-week-nav button")].find((button) => button.textContent === "This week" && !button.hidden)?.click();
  app.ctx.navigation.navigate("#today");
  return "PASS meal plans: breakfast, lunch, favourites, the week's ingredients and same as last week (#679)";
}
