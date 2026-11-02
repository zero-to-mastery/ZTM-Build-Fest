// Meals acceptance (#340) in a real browser, after mealsRegressions: the
// week and recipes from a 320×568 phone to a desktop with the detail panel
// open, at 200% zoom, in dark mode and forced colours, by keyboard alone,
// offline, and through a failure part-way through adding ingredients and
// its Retry. Runs from Node over CDP; page checks are serialized.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";
import { setMedia } from "./cdp-media.mjs";

const LONG_DINNER = "Grandma's slow-cooked Sunday roast with all the trimmings and gravy for everyone";
const LONG_RECIPE = "Extra-long recipe name to check that wrapping never pushes the page sideways ok";

export async function mealsAcceptanceRegressions(client, until) {
  const page = (expression) => client.evaluate(expression);
  const settle = () => page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  const idle = () => until(() => page(`(() => { const app = document.querySelector("kin-app"); return !app.busy && !app.ctx.meals.loading; })()`));

  // ---- Setup: a long dinner tonight and a long recipe name -----------------
  const today = await page(`(async () => {
    const app = document.querySelector("kin-app");
    location.hash = "#lists/meals";
    app.ctx.navigation.showPageFromLocation();
    const civil = app.ctx.navigation.currentCivilDate();
    const pad = (value) => String(value).padStart(2, "0");
    const today = Math.floor(civil / 10_000) + "-" + pad(Math.floor(civil / 100) % 100) + "-" + pad(civil % 100);
    if (!await app.ctx.meals.setDinner({ date: today, name: ${JSON.stringify(LONG_DINNER)} })) throw new Error("the long dinner is saved");
    if (!await app.ctx.meals.saveRecipe({ name: ${JSON.stringify(LONG_RECIPE)}, ingredients: [{ text: "Meals acceptance flour" }], notes: "" })) throw new Error("the long recipe is saved");
    return today;
  })()`);
  await idle();

  // ---- Screens -------------------------------------------------------------
  const measure = () => page(`(() => {
    const meals = document.querySelector("kin-meals");
    const visible = (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
    const days = [...meals.querySelectorAll(".meal-day")];
    const week = meals.querySelector(".meals-week").getBoundingClientRect();
    const recipes = meals.querySelector(".meals-recipes").getBoundingClientRect();
    return {
      innerWidth, scrollWidth: document.documentElement.scrollWidth, mealsWidth: meals.clientWidth,
      overflowing: [...meals.querySelectorAll(".meal-day, .recipe, .meals-result")].filter((node) => node.scrollWidth > node.clientWidth + 1).length,
      small: [...meals.querySelectorAll(".meals-layout button, .meals-layout select")].filter((node) => visible(node) && node.getBoundingClientRect().height < 44)
        .map((node) => node.getAttribute("aria-label") || node.textContent),
      columns: new Set(days.map((day) => Math.round(day.getBoundingClientRect().left))).size,
      sideBySide: recipes.left > week.left + 10 && Math.abs(recipes.top - week.top) < 40,
      putOn: [...meals.querySelectorAll(".recipe-put-on")].some(visible),
      side: document.querySelector("main")?.classList.contains("has-detail-side") ?? false,
    };
  })()`);
  const screens = [
    ["phone", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }],
    ["phone landscape", { width: 568, height: 320, deviceScaleFactor: 2, mobile: true }],
    ["tablet", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }],
    ["tablet landscape", { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true }],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
    // 200% browser zoom on a 1280×800 desktop: half the CSS pixels.
    ["desktop at 200%", { width: 640, height: 400, deviceScaleFactor: 2, mobile: false }],
  ];
  for (const [label, metrics] of screens) {
    await setViewport(client, metrics);
    await settle();
    const view = await measure();
    assert.ok(view.scrollWidth <= view.innerWidth, `${label}: no horizontal scroll (${view.scrollWidth} > ${view.innerWidth})`);
    assert.equal(view.overflowing, 0, `${label}: long names wrap inside their rows`);
    assert.deepEqual(view.small, [], `${label}: every visible control is at least 44px tall`);
    const wide = view.innerWidth >= 1180;
    // Two columns of days when the view has room (container query), but a
    // single list beside the recipes on wide screens.
    assert.equal(view.columns, !wide && view.mealsWidth >= 560 ? 2 : 1, `${label}: ${view.columns} column(s) of days at ${view.mealsWidth}px`);
    assert.equal(view.sideBySide, wide, `${label}: recipes ${wide ? "beside" : "below"} the week`);
    assert.equal(view.putOn, wide, `${label}: "Put on…" ${wide ? "shown" : "hidden"}`);
  }

  // The detail panel beside the list leaves room for one column only.
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page(`(() => {
    const app = document.querySelector("kin-app");
    const item = app.state.items.find((record) => record.status !== "archived");
    app.ctx.detail.openItemDetail(item.itemId);
    return true;
  })()`);
  await settle();
  const withDetail = await measure();
  assert.ok(withDetail.side, "the detail panel opens beside the list");
  assert.ok(withDetail.scrollWidth <= withDetail.innerWidth && withDetail.overflowing === 0, "with the detail panel: nothing overflows");
  assert.ok(!withDetail.sideBySide && !withDetail.putOn && withDetail.columns === 1, "with the detail panel: one list, no Put on…");
  await page(`(() => { document.querySelector("kin-app").ctx.detail.closeItemDetail({ restoreFocus: false }); return true; })()`);
  await settle();

  // ---- Keyboard only -------------------------------------------------------
  const key = async (keyName, code, keyCode) => {
    // Enter needs its text ("\r") to activate a focused button.
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, ...(keyName === "Enter" ? { text: "\r" } : {}) });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
  };
  await page(`(() => { document.querySelector('kin-meals .meal-day[data-date="${today}"] .meal-plan').focus(); return true; })()`);
  await key("Enter", "Enter", 13);
  await until(() => page(`(() => { const dialog = document.querySelector("kin-meals .meal-plan-dialog"); return dialog.open && document.activeElement === dialog.querySelector('input[type="search"]'); })()`));
  await key("Escape", "Escape", 27);
  await until(() => page(`(() => !document.querySelector("kin-meals .meal-plan-dialog").open &&
    document.activeElement === document.querySelector('kin-meals .meal-day[data-date="${today}"] .meal-plan'))()`));
  const named = await page(`document.activeElement.getAttribute("aria-label")`);
  assert.match(named, /^Change dinner for \w+day \d+ \w+$/, "the day's button names the day for screen readers");

  // ---- Light, dark and forced colours ---------------------------------------
  // Read from the palette the rows use (--surface behind --ink and
  // --ink-muted): Edge can report a stale computed background right after
  // the appearance changes, while the custom properties are current.
  const contrast = () => page(`(() => {
    const rgb = (value) => {
      const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
      if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16));
      return value.match(/[\\d.]+/g).slice(0, 3).map(Number);
    };
    const luminance = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((total, v, i) => total + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const style = getComputedStyle(document.querySelector("kin-meals .meal-day"));
    const token = (name) => style.getPropertyValue(name).trim();
    const background = token("--surface");
    return { background, ratios: ["--ink", "--ink-muted", "--accent"].map((name) => Math.round(ratio(token(name), background) * 10) / 10) };
  })()`);
  // Light and dark through the app's own appearance setting (its palette is
  // an adopted style sheet; the attribute alone doesn't change tokens).
  const appearance = (mode) => page(`(() => {
    const app = document.querySelector("kin-app");
    if (!app.currentAppearance) app.ctx.appearance.applyEffectiveAppearance();
    window.__mealsAppearance ??= structuredClone(app.currentAppearance);
    app.ctx.appearance.applyAppearance(${mode ? `{ ...window.__mealsAppearance, mode: "${mode}" }` : "window.__mealsAppearance"});
    ${mode ? "" : "delete window.__mealsAppearance;"}
    return document.documentElement.dataset.kinAppearance ?? null;
  })()`);
  await appearance("light");
  await settle();
  const light = await contrast();
  await appearance("dark");
  await settle();
  const dark = await contrast();
  assert.notEqual(dark.background, light.background, "dark mode changes the day rows");
  for (const [mode, result] of [["light", light], ["dark", dark]])
    assert.ok(result.ratios.every((value) => value >= 4.5), `${mode}: day rows' ink, muted ink and accent have at least 4.5:1 contrast (${result.ratios.join(", ")})`);
  await appearance(null);
  await setMedia(client, [{ name: "forced-colors", value: "active" }]);
  await settle();
  const forced = await page(`(() => {
    const today = document.querySelector("kin-meals .meal-day.is-today");
    return { border: parseFloat(getComputedStyle(today).borderTopWidth), style: getComputedStyle(today).borderTopStyle };
  })()`);
  assert.ok(forced.border >= 2 && forced.style !== "none", "forced colours: tonight's row keeps a visible border");
  await setMedia(client);

  // ---- Offline: planning still saves on this device ---------------------
  // Meals never need the network to save; the browser is told it's offline
  // (real network emulation would make sync log failures, which fail the
  // run), and the status says when it will sync.
  const offline = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      const [y, m, d] = "${today}".split("-").map(Number);
      const next = new Date(0); next.setUTCFullYear(y, m - 1, d + 1);
      const tomorrow = next.toISOString().slice(0, 10);
      const ok = await app.ctx.meals.setDinner({ date: tomorrow, name: "Offline soup" });
      return { saved: ok && app.mealsState.dinners.some((dinner) => dinner.date === tomorrow && dinner.name === "Offline soup"),
        syncing: Boolean(app.syncCoordinator), status: app.status.textContent };
    } finally {
      delete navigator.onLine;
      if (!descriptor) delete navigator.onLine;
    }
  })()`);
  assert.ok(offline.saved, "offline: a dinner is planned on this device");
  if (offline.syncing) assert.match(offline.status, /It will sync when you're connected\.$/, "offline: the status says it will sync later");
  else assert.doesNotMatch(offline.status, /sync/i, "a device without sync never mentions syncing");

  // ---- A failure part-way through adding ingredients, then Retry -----------
  const retried = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const waitFor = async (condition, message) => {
      for (let i = 0; i < 900; i++) { if (!app.busy && condition()) return; await frame(); }
      throw new Error("Timed out: " + message + " (" + app.alert.textContent + ")");
    };
    const names = ["Meals acceptance apples", "Meals acceptance oats", "Meals acceptance cream"];
    const recipeId = await app.ctx.meals.saveRecipe({ name: "Meals acceptance crumble", ingredients: names.map((text) => ({ text })), notes: "" });
    if (!recipeId) throw new Error("the crumble is saved");
    const count = (text) => app.state.items.filter((item) => item.classification === "shopping" && item.status === "active" && item.text === text).length;
    // The second ingredient's save fails as if storage were full.
    const originalAdd = IDBObjectStore.prototype.add;
    let adds = 0;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === "events" && ++adds === 2) throw new DOMException("Synthetic quota", "QuotaExceededError");
      return originalAdd.apply(this, args);
    };
    let alert;
    try {
      await app.ctx.meals.addIngredients({ recipeId }, "Meals acceptance crumble");
      alert = app.alert.textContent;
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }
    const partial = names.map(count);
    const retryShown = !app.retryButton.hidden;
    app.retryButton.click();
    await waitFor(() => names.every((text) => count(text) === 1), "Retry adds what's missing");
    return { alert, partial, retryShown, after: names.map(count) };
  })()`);
  assert.match(retried.alert, /^Added 1 ingredient to Shopping, then Kin couldn't save the rest\. Retry adds only what's missing\.$/, "a part-way failure says what was saved: " + retried.alert);
  assert.deepEqual(retried.partial, [1, 0, 0], "only the first ingredient landed before the failure");
  assert.ok(retried.retryShown, "Retry is offered");
  assert.deepEqual(retried.after, [1, 1, 1], "Retry adds only what's missing, nothing twice");

  // ---- From the independent review ----------------------------------------
  const review = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const meals = app.meals;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const waitFor = async (condition, message) => {
      for (let i = 0; i < 900; i++) { if (!app.busy && condition()) return; await frame(); }
      throw new Error("Timed out: " + message + " (" + app.alert.textContent + ")");
    };
    const pudding = () => app.mealsState.recipes.find((recipe) => recipe.name === "Meals regression pudding");
    // A Staple link the person removed stays removed when the recipe is saved again.
    const before = pudding();
    await app.ctx.meals.saveRecipe({ recipeId: before.recipeId, name: before.name, notes: before.notes,
      ingredients: before.ingredients.map((line) => ({ text: line.text, stapleId: null })) }, { quiet: true });
    // Edit is the first action (the favourite star sits beside the name, #679).
    meals.querySelector('.recipe[data-recipe-id="' + before.recipeId + '"] .recipe-actions button').click();
    const editor = meals.querySelector(".recipe-dialog");
    editor.querySelectorAll("textarea")[1].value = "Stir often";
    editor.querySelector("form").requestSubmit();
    await waitFor(() => pudding().notes === "Stir often", "the notes are saved");
    const relinked = pudding().ingredients.some((line) => line.stapleId);
    editor.querySelector(".meal-dialog-actions button:last-child").click();
    // Picking the recipe already planned is not an error.
    const day = [...meals.querySelectorAll(".meal-day")].find((row) => !row.classList.contains("is-today") && row.querySelector(".meal-dinner.is-empty"));
    const date = day.dataset.date;
    await app.ctx.meals.setDinner({ date, recipeId: before.recipeId, name: before.name });
    app.ctx.status.clearAlert();
    meals.querySelector('.meal-day[data-date="' + date + '"] .meal-plan').click();
    const plan = meals.querySelector(".meal-plan-dialog");
    plan.querySelector('.meal-plan-recipes button[data-recipe-id="' + before.recipeId + '"]').click();
    await frame(); await frame();
    const alertShown = !app.alert.hidden;
    const cookFocused = document.activeElement === plan.querySelector("select");
    plan.querySelector(".meal-dialog-actions button:first-child").click();
    await waitFor(() => !app.mealsState.dinners.some((dinner) => dinner.date === date), "the test dinner is cleared");
    return { relinked, alertShown, cookFocused };
  })()`);
  assert.equal(review.relinked, false, "a removed Staple link stays removed after saving the recipe again");
  assert.ok(!review.alertShown && review.cookFocused, "picking the recipe already planned moves on to the cook without an error");

  // Clean up.
  await page(`(async () => {
    const app = document.querySelector("kin-app");
    await app.ctx.meals.clearDinner("${today}");
    location.hash = "#today";
    app.ctx.navigation.showPageFromLocation();
    return true;
  })()`);
  await client.send("Emulation.clearDeviceMetricsOverride");
  return "PASS meals acceptance: 320×568 to desktop, phone and tablet landscape, 200% zoom and the detail panel; keyboard-only planning; light, dark and forced-colour contrast; offline planning and its wording; a part-way failure and Retry without duplicates; kept Staple unlinks and re-picking a planned recipe (#340)";
}
