// Meals (#333) in the real app: plan the week, save a recipe whose ingredient
// matches a Staple, put its ingredients on Shopping twice without
// duplicates, choose who's cooking, and see Tonight on Today. Runs in the page
// (serialized with toString), after the Shopping suite.
export async function mealsRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const waitFor = async (condition, message, attempts = 900) => {
    for (let i = 0; i < attempts; i++) {
      if (!app.busy && condition()) return;
      await frame();
    }
    // Say what the person would see, so a CI failure explains itself.
    const shown = [...document.querySelectorAll('[role="alert"]:not([hidden]), [role="status"]')]
      .map((node) => node.textContent.trim()).filter(Boolean).join(" | ");
    throw new Error(`Timed out: ${message} (showing: ${shown || "nothing"}; recipes: ${app.mealsState?.recipes.map((recipe) => recipe.name).join(", ") ?? "none"}; refused: ${refused || "nothing"})`);
  };
  // Remember why the engine last refused a change, for the timeout message.
  let refused = "";
  const append = app.ctx.append.appendCommand.bind(app.ctx.append);
  app.ctx.append.appendCommand = async (command) => {
    try { return await append(command); }
    catch (error) {
      refused = `${command.type}: ${error.message} <- ${error.cause?.name ?? ""} ${error.cause?.code ?? ""} ${error.cause?.message ?? ""} ${JSON.stringify(command).slice(0, 400)}`;
      throw error;
    }
  };
  const idle = () => waitFor(() => !app.busy && !app.ctx.meals.loading, "meals work returns idle");
  const pad = (value) => String(value).padStart(2, "0");
  const civil = app.ctx.navigation.currentCivilDate();
  const today = `${Math.floor(civil / 10_000)}-${pad(Math.floor(civil / 100) % 100)}-${pad(civil % 100)}`;
  const meals = app.meals;

  // A Staple the recipe will match exactly.
  const stapleId = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await app.ctx.append.appendCommand({ type: "add", id: stapleId, text: "Meals regression rice", classification: "staple" });
  app.ctx.render.renderState();
  await waitFor(() => app.state.items.some((item) => item.text === "Meals regression rice"), "the staple is saved");
  const staple = app.state.items.find((item) => item.text === "Meals regression rice");

  app.ctx.navigation.navigate("#lists/meals");
  await idle();
  await frame();
  check(!meals.hidden && meals.checkVisibility(), "Lists › Meals shows the meals view");
  check(app.querySelector('kin-segment-nav a[href="#lists/meals"]'), "Lists has a Meals segment");
  const rows = [...meals.querySelectorAll(".meal-day")];
  check(rows.length === 7, "the week has seven days");
  check(meals.querySelector(".meal-day.is-today")?.dataset.date === today, "today's row is marked Tonight");
  check(/^This week · /.test(meals.querySelector(".meals-week-head h2").textContent), "the current week is named");

  // Something else, from the day's Plan button, then who's cooking.
  const planButton = () => meals.querySelector(`.meal-day[data-date="${today}"] .meal-plan`);
  planButton().click();
  const plan = meals.querySelector(".meal-plan-dialog");
  check(plan.open && document.activeElement === plan.querySelector('input[type="search"]'), "planning opens with Find focused");
  const other = plan.querySelector(".meal-plan-other input");
  other.value = "   ";
  plan.querySelector(".meal-plan-other button").click();
  await waitFor(() => plan.querySelector('[role="alert"]:not([hidden])'), "an empty dinner name is refused inline");
  check(document.activeElement === other, "focus stays on the dinner name");
  other.value = "Meals regression leftovers";
  plan.querySelector(".meal-plan-other button").click();
  await waitFor(() => app.mealsState?.dinners.some((dinner) => dinner.date === today && dinner.name === "Meals regression leftovers"), "the dinner is planned");
  const cook = plan.querySelector("select");
  check(!cook.disabled && cook.options[1]?.textContent === "You", "anyone can cook, You first");
  cook.value = cook.options[1].value;
  cook.dispatchEvent(new Event("change"));
  await waitFor(() => app.mealsState.dinners.find((dinner) => dinner.date === today)?.cookId === cook.options[1].value, "the cook is saved");
  await waitFor(() => app.tonight.querySelector(".tonight-line")?.textContent === "Meals regression leftovers · You're cooking", "Tonight on Today names the dinner and cook");
  plan.querySelector(".meal-dialog-actions button:last-child").click();
  // The dialog's close event is queued, so focus moves a moment later.
  await waitFor(() => !plan.open && document.activeElement === planButton(), "closing returns focus to the day");

  // A recipe linked to the Staple, then its ingredients on Shopping twice.
  meals.querySelector(".meals-recipes-head .add-button").click();
  const editor = meals.querySelector(".recipe-dialog");
  check(editor.open, "Add a recipe opens the editor");
  editor.querySelector("input").value = "Meals regression pudding";
  editor.querySelectorAll("textarea")[0].value = "meals regression RICE\nMeals regression milk\nmeals regression milk";
  editor.querySelector("form").requestSubmit();
  await waitFor(() => app.mealsState.recipes.some((recipe) => recipe.name === "Meals regression pudding"), "the recipe is saved");
  const recipe = app.mealsState.recipes.find((entry) => entry.name === "Meals regression pudding");
  check(recipe.ingredients.length === 2, "duplicate ingredient lines collapse");
  check(recipe.ingredients[0].stapleId === staple.itemId && recipe.ingredients[0].staple === "active", "an exact match links the Staple");
  await frame();
  check(editor.open && /Matched to Staple/.test(editor.querySelector(".recipe-staple-note")?.textContent ?? ""), "the editor says the Staple is matched");
  editor.querySelector(".meal-dialog-actions button:last-child").click();

  const shoppingCount = (text) => app.state.items.filter((item) => item.classification === "shopping" && item.status === "active" && item.text.toLowerCase() === text.toLowerCase()).length;
  const addButton = () => meals.querySelector(`.recipe[data-recipe-id="${recipe.recipeId}"] .recipe-actions button:nth-child(2)`);
  addButton().click();
  await waitFor(() => meals.querySelector(".meals-result:not([hidden])"), "the result is shown");
  check(shoppingCount("Meals regression milk") === 1, "a new ingredient lands on Shopping");
  check(shoppingCount("Meals regression rice") === 1, "the Staple is re-added");
  check(meals.querySelector(".meals-result a")?.getAttribute("href") === "#lists/shopping", "the result links to Shopping");
  addButton().click();
  await idle();
  await waitFor(() => /Already on Shopping 2/.test(meals.querySelector(".meals-result").textContent), "a second add reports what is already there");
  check(shoppingCount("Meals regression milk") === 1 && shoppingCount("Meals regression rice") === 1, "adding twice never duplicates");

  // Clearing tonight's dinner leaves the quiet empty line.
  planButton().click();
  plan.querySelector(".meal-dialog-actions button:first-child").click();
  await waitFor(() => !plan.open && !app.mealsState.dinners.some((dinner) => dinner.date === today), "the dinner is cleared");
  check(app.tonight.querySelector(".tonight-line").textContent === "Nothing planned for tonight.", "Tonight says nothing is planned");
  check(app.tonight.querySelector(".tonight-link").textContent === "Plan dinner", "Tonight offers Plan dinner");

  // Phone width: one column, nothing wider than the screen.
  check(meals.scrollWidth <= meals.clientWidth + 1, "the meals view never scrolls sideways");
  delete app.ctx.append.appendCommand;
  app.ctx.navigation.navigate("#today");
  return "PASS meals plan, cook, recipe staple link and Shopping without duplicates (#333)";
}
