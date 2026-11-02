// Meals (#333): loads the meals view after each render and carries out what
// <kin-meals> and Tonight on Today ask for, through the one command path.
// State stays on the element (`this.app`); app/context.js explains the
// controllers.
//
// - refresh() replays meals from the same history as the projection (Rust's
//   replay checkpoint makes the second read cheap) and hands them, with
//   tonight's line, to the views. Calls coalesce: one runs at a time and the
//   last request wins.
// - Each action is one household command (or, for ingredients, a short
//   batch) with the app's busy guard, Retry and truthful wording: saved on
//   this device, waiting to sync, never "the household has it".
import { idToHex, randomId } from "../../wasm/kin-engine.js";
import { MealFormatError, collapseText, planSummary } from "../../wasm/kin-meals.js";
import { syncProgress } from "./feedback.js";
import { SLOT_LABELS, cookLabel, sameAsLastWeek, todayMealLines, tonightLine } from "../../meals/meals-view.js";
import { routeHash } from "../../routes.js";
import { SAVE_ERROR } from "./constants.js";

/** A civil date number (YYYYMMDD) or Date as "YYYY-MM-DD". */
const dateText = (value) => {
  if (typeof value === "number") return `${String(Math.floor(value / 10_000)).padStart(4, "0")}-${String(Math.floor(value / 100) % 100).padStart(2, "0")}-${String(value % 100).padStart(2, "0")}`;
  return value;
};

export class MealsController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.loading = null;
    this.again = false;
    this.names = new Map();
  }

  /** Reloads meals for the views; safe to call after every render. */
  refresh() {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = this.load().finally(() => {
      this.loading = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.loading;
  }

  async load() {
    const session = this.ctx.session.captureSession();
    if (!session.store || !session.engine || !this.app.vault || this.app.vault.locked) return;
    let meals;
    try {
      meals = await session.store.meals();
      // Preferred names (#224) only where the device syncs; labels fall back.
      if (this.app.syncCoordinator) {
        try {
          const names = new Map((await this.ctx.sync.memberNames()).map(({ memberId, name }) => [memberId, name]));
          // One shared map (#344): assignee labels use it too. A new object
          // only when a name changed, so views keyed on it skip re-rendering.
          const same = names.size === this.names.size && [...names].every(([id, name]) => this.names.get(id) === name);
          if (!same) {
            this.names = names;
            this.app.memberNameMap = names;
            this.ctx.render.renderState();
          }
        } catch { /* keep the last names */ }
      }
    } catch {
      return;
    }
    if (!this.ctx.session.isCurrentSession(session)) return;
    this.app.mealsState = meals;
    this.show();
  }

  people() {
    const { memberId = null, memberIds = [] } = this.ctx.detail.responsibilityContext?.() ?? {};
    return { myId: memberId, memberIds, names: this.names };
  }

  today() {
    const civilDate = this.ctx.navigation.currentCivilDate?.();
    return civilDate ? dateText(civilDate) : null;
  }

  /** Hands the latest meals to <kin-meals>, Tonight on Today (with today's
   * other meals, #679) and This week. */
  show() {
    const meals = this.app.mealsState ?? { recipes: [], dinners: [], meals: [] };
    const today = this.today();
    const people = this.people();
    const view = this.app.meals;
    if (view) {
      view.actions ??= this;
      view.people = people;
      view.staples = (this.app.state?.items ?? []).filter((item) => item.classification === "staple");
      view.meals = meals;
      if (today) view.date = today;
    }
    // Simple view shows tonight's dinner on its Today (#348).
    if (this.ctx.simple?.on) void this.ctx.simple.refresh();
    const line = this.app.tonight;
    if (line && today) {
      const dinner = meals.dinners.find((entry) => entry.date === today) ?? null;
      line.update({ text: tonightLine(dinner, people), href: routeHash("lists", "meals"), meals: todayMealLines(meals, today) });
    }
    // This week lists every meal beside Rust's dinners (app/week.js).
    void this.ctx.week?.refresh?.();
  }

  /** One meals command with the busy guard, status and Retry. */
  async run(command, { done, retry, quiet = false }) {
    if (!this.app.store || !this.app.engine) return false;
    // Never drop a change silently: say so, and re-render so a control that
    // changed (the cook select) shows what is actually saved.
    if (this.app.busy) { this.busyNotice(); return false; }
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    if (!quiet) this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(command);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      await this.refresh();
      this.ctx.status.setStatus(`${done}${syncProgress({ syncing: Boolean(this.app.syncCoordinator), offline: navigator.onLine === false })}`);
      this.ctx.peers.broadcastEventChange();
      return true;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return false;
      this.ctx.status.setStatus("");
      // The view shows a format problem beside the field it came from; the
      // store wraps it, so look through to the cause.
      const format = error instanceof MealFormatError ? error : error.cause instanceof MealFormatError ? error.cause : null;
      if (format) throw format;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, retry);
      return false;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  busyNotice() {
    this.ctx.status.setStatus("Kin is still saving. Try again in a moment.");
    this.show();
  }

  /** Forgets this session's meals and names (on lock). */
  reset() {
    this.app.mealsState = null;
    this.app.memberNameMap = null;
    this.names = new Map();
    this.again = false;
  }

  /** Saves a recipe whole; resolves with its ID, or null. */
  async saveRecipe({ recipeId = null, name, ingredients, notes }, { quiet = false } = {}) {
    // Recipe IDs are hex throughout the meals view, like the decoded ones.
    const id = recipeId ?? idToHex(randomId());
    const saved = await this.run(
      { type: "save-recipe", recipeId: id, name, ingredients, notes },
      { done: quiet ? "Staple link saved." : `Saved recipe “${name}”.`, retry: () => this.saveRecipe({ recipeId: id, name, ingredients, notes }, { quiet }), quiet },
    );
    return saved ? id : null;
  }

  archiveRecipe(recipeId) {
    const name = this.app.mealsState?.recipes.find((recipe) => recipe.recipeId === recipeId)?.name ?? "the recipe";
    return this.run({ type: "archive-recipe", recipeId }, { done: `Archived “${name}”.`, retry: () => this.archiveRecipe(recipeId) });
  }

  setDinner({ date, recipeId = null, name }) {
    return this.run({ type: "set-dinner", date, recipeId, name }, {
      done: `Planned “${collapseText(name)}” for ${this.dayName(date)}.`,
      // A recipe renamed meanwhile is planned under its current name.
      retry: () => {
        const recipe = recipeId ? this.app.mealsState?.recipes.find((entry) => entry.recipeId === recipeId) : null;
        return this.setDinner({ date, recipeId, name: recipe?.name ?? name });
      },
    });
  }

  clearDinner(date) {
    return this.run({ type: "clear-dinner", date }, { done: `Cleared dinner for ${this.dayName(date)}.`, retry: () => this.clearDinner(date) });
  }

  setCook(date, memberId) {
    const label = memberId ? (memberId === this.people().myId ? "You're" : `${cookLabel(memberId, this.people())} is`) : null;
    return this.run({ type: "set-dinner-cook", date, memberId }, {
      done: label ? `${label} cooking on ${this.dayName(date)}.` : `No one is cooking on ${this.dayName(date)} yet.`,
      retry: () => this.setCook(date, memberId),
    });
  }

  /** A breakfast, lunch or snack (#679, kind 80); dinner uses setDinner. */
  setMeal({ date, slot, recipeId = null, name }) {
    const label = SLOT_LABELS[slot]?.toLowerCase() ?? "meal";
    return this.run({ type: "set-meal", date, slot, recipeId, name }, {
      done: `Planned “${collapseText(name)}” for ${label} ${this.onDay(date)}.`,
      retry: () => {
        const recipe = recipeId ? this.app.mealsState?.recipes.find((entry) => entry.recipeId === recipeId) : null;
        return this.setMeal({ date, slot, recipeId, name: recipe?.name ?? name });
      },
    });
  }

  clearMeal(date, slot) {
    const label = SLOT_LABELS[slot]?.toLowerCase() ?? "meal";
    return this.run({ type: "clear-meal", date, slot }, { done: `Cleared ${label} ${this.onDay(date)}.`, retry: () => this.clearMeal(date, slot) });
  }

  /** Marks a recipe a favourite or not (#679, kind 82). */
  setFavourite(recipeId, favourite) {
    const name = this.app.mealsState?.recipes.find((recipe) => recipe.recipeId === recipeId)?.name ?? "the recipe";
    return this.run({ type: "set-recipe-favourite", recipeId, favourite }, {
      done: favourite ? `Added “${name}” to favourites.` : `Removed “${name}” from favourites.`,
      retry: () => this.setFavourite(recipeId, favourite),
    });
  }

  /**
   * "Same as last week" (#679): fills each empty meal of the week from
   * `monday` with the one planned seven days earlier (meals-view.js). Each
   * copy is one ordinary command; a failure part-way offers Retry, which
   * works out the copies again, so nothing is planned twice.
   */
  async sameAsLastWeek(monday) {
    if (!this.app.store || !this.app.engine) return false;
    if (this.app.busy) { this.busyNotice(); return false; }
    const copies = sameAsLastWeek(this.app.mealsState, monday);
    if (!copies.length) {
      this.ctx.status.setStatus("Nothing to copy: last week's meals are already planned, or last week had none.");
      return false;
    }
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Copying last week…");
    let saved = 0;
    try {
      for (const copy of copies) {
        await this.ctx.append.appendCommand(copy.slot === "dinner"
          ? { type: "set-dinner", date: copy.date, recipeId: copy.recipeId, name: copy.name }
          : { type: "set-meal", ...copy });
        this.ctx.session.assertCurrentSession(session);
        saved += 1;
      }
      this.ctx.render.renderState();
      await this.refresh();
      this.ctx.status.setStatus(`Copied ${saved} ${saved === 1 ? "meal" : "meals"} from last week.${syncProgress({ syncing: Boolean(this.app.syncCoordinator), offline: navigator.onLine === false })}`);
      this.ctx.peers.broadcastEventChange();
      return true;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return false;
      if (saved) {
        this.ctx.render.renderState();
        this.ctx.peers.broadcastEventChange();
      }
      this.ctx.status.setStatus("");
      this.ctx.status.showAlert(
        saved
          ? `Copied ${saved} ${saved === 1 ? "meal" : "meals"}, then Kin couldn't save the rest. Retry copies only what's missing.`
          : (error.userMessage ?? "Kin couldn't copy last week's meals."),
        () => this.sameAsLastWeek(monday),
      );
      return false;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  /** "on Monday 5 Oct", or "today". */
  onDay(date) {
    const day = this.dayName(date);
    return day === "tonight" ? "today" : `on ${day}`;
  }

  dayName(date) {
    const today = this.today();
    if (date === today) return "tonight";
    const [year, month, day] = date.split("-").map(Number);
    const value = new Date(0);
    value.setUTCFullYear(year, month - 1, day);
    return value.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  }

  /**
   * Puts a recipe's ({ recipeId }), a day's dinner's ({ date }), a day's
   * other meal's ({ date, slot }) or a whole week's ({ week }, every meal,
   * #679) ingredients on Shopping. Rust plans each line (re-add a staple,
   * add, or already on Shopping); each addition is an ordinary Shopping
   * item. A failure part-way says how many were saved and offers Retry,
   * which plans again: what was added is now already on Shopping, so nothing
   * is added twice.
   */
  async addIngredients(source, label = "") {
    if (!this.app.store || !this.app.engine) return false;
    if (this.app.busy) { this.busyNotice(); return false; }
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Adding ingredients…");
    let saved = 0;
    try {
      const plan = await session.store.mealShoppingPlan(source);
      this.ctx.session.assertCurrentSession(session);
      for (const line of plan.filter((entry) => entry.outcome !== "already")) {
        await this.ctx.append.appendCommand({ type: "add", id: randomId(), text: line.text, classification: "shopping" });
        this.ctx.session.assertCurrentSession(session);
        saved += 1;
      }
      this.ctx.render.renderState();
      const summary = source.week && !plan.length ? "No recipes are planned this week, so there's nothing to add." : planSummary(plan);
      const message = `${summary.endsWith(".") ? summary : `${summary}.`}${saved ? syncProgress({ syncing: Boolean(this.app.syncCoordinator), offline: navigator.onLine === false }) : ""}`;
      this.ctx.status.setStatus(message);
      this.app.meals?.showResult?.(message, routeHash("lists", "shopping"));
      if (saved) this.ctx.peers.broadcastEventChange();
      return true;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return false;
      if (saved) {
        this.ctx.render.renderState();
        this.ctx.peers.broadcastEventChange();
      }
      this.ctx.status.setStatus("");
      this.ctx.status.showAlert(
        saved
          ? `Added ${saved} ${saved === 1 ? "ingredient" : "ingredients"} to Shopping, then Kin couldn't save the rest. Retry adds only what's missing.`
          : (error.userMessage ?? `Kin couldn't add ${source.week ? `the ingredients for ${label || "this week"}` : label ? `the ingredients for “${label}”` : "the ingredients"} to Shopping.`),
        () => this.addIngredients(source, label),
      );
      return false;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
