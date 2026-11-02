// <kin-chore-chart> (#676, ADR 0022 §6): one card per person on the chore
// chart, in their colour, with their name, points this week and reward
// progress ("12 of 20 for Movie night"), today's jobs with big tick boxes
// and pictures, and the rest of the week below.
//
// Self-contained so the kitchen display can reuse it: it only renders and
// reports. Give it `cards` (chores/chore-chart-view.js buildChoreChart);
// optionally `editable` (Adults: "Set reward" on each child's card) and the
// `size="display"` attribute for the kitchen screen's larger targets (#699:
// there the goal is chosen with big − and + buttons and one-tap goals, never
// typed, and the editor has Cancel). It
// dispatches, bubbling and composed:
// - `kin:chore-toggle` { memberId, kind, id, occurrenceKey, done, text } when
//   a tick box changes (the host records it; the next `cards` shows it);
// - `kin:chore-reward` { memberId, goal, text } to set a reward (goal 0 and
//   no text removes it). On the kitchen display the host asks the adult to
//   confirm before it writes anything (#705); the chart doesn't know.
// Household text is only ever set as textContent.

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });
// A reward's goal: 1–1000 points (kin-chores.js MAX_REWARD_GOAL), and the
// display's one-tap choices.
const MAX_GOAL = 1000;
const GOAL_PRESETS = Object.freeze([5, 10, 20, 30, 50]);
const clampGoal = (value) => Math.min(MAX_GOAL, Math.max(1, Math.round(Number(value) || 1)));

function dayName(date) {
  const value = new Date(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100);
  return dayFormat.format(value);
}

class KinChoreChart extends HTMLElement {
  constructor() {
    super();
    this.cardsValue = [];
    this.loaded = false;
    this.isDisabled = false;
    this.isEditable = false;
    this.editing = null;
    this.draft = null;
    this.previewProvider = null;
    this.openWeeks = new Set();
  }

  connectedCallback() {
    if (!this.list) this.build();
    this.render();
  }

  /** The cards to draw (buildChoreChart). */
  set cards(value) {
    this.cardsValue = Array.isArray(value) ? value : [];
    this.loaded = true;
    if (this.editing && !this.cardsValue.some((card) => card.memberId === this.editing)) { this.editing = null; this.draft = null; }
    this.render();
  }
  get cards() { return this.cardsValue; }

  /** Adults may set each child's reward here. */
  set editable(value) {
    this.isEditable = Boolean(value);
    if (!this.isEditable) { this.editing = null; this.draft = null; }
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, button")) control.disabled = this.isDisabled || control.dataset.locked === "true";
  }

  /** (attachment row) -> object URL or null, for photo pictures. */
  set previews(provider) {
    this.previewProvider = typeof provider === "function" ? provider : null;
    this.render();
  }

  build() {
    this.classList.add("chore-chart");
    this.list = document.createElement("ul");
    this.list.className = "chore-cards";
    this.list.setAttribute("aria-label", "Chore chart");
    this.empty = document.createElement("p");
    this.empty.className = "chore-empty";
    this.empty.hidden = true;
    this.append(this.empty, this.list);
  }

  focusedKey() {
    const active = document.activeElement;
    return active && this.contains(active) ? active.dataset.focusKey ?? null : null;
  }

  render() {
    if (!this.list) return;
    const focusKey = this.focusedKey();
    this.empty.hidden = this.cardsValue.length > 0;
    this.empty.textContent = this.loaded
      ? "Nobody is on the chore chart yet. Children appear here once they've joined the household."
      : "Loading the chore chart…";
    this.list.replaceChildren(...this.cardsValue.map((card) => this.card(card)));
    if (focusKey) [...this.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }

  card(card) {
    const item = document.createElement("li");
    item.className = "chore-card";
    item.dataset.memberId = card.memberId;
    item.style.setProperty("--chore-colour", card.colour);
    const headingId = `chore-card-${card.memberId}`;
    const section = document.createElement("section");
    section.setAttribute("aria-labelledby", headingId);
    const header = document.createElement("header");
    header.className = "chore-card-header";
    const heading = document.createElement("h2");
    heading.id = headingId;
    heading.className = "chore-card-name";
    heading.textContent = card.name;
    const points = document.createElement("p");
    points.className = "chore-points";
    points.textContent = card.line;
    header.append(heading, points);
    if (card.reward) {
      const progress = document.createElement("progress");
      progress.className = "chore-progress";
      progress.max = card.reward.goal;
      progress.value = Math.min(card.points, card.reward.goal);
      progress.setAttribute("aria-label", `${card.name}: ${card.line}`);
      header.append(progress);
    }
    section.append(header);

    const todayHeading = document.createElement("h3");
    todayHeading.className = "chore-day-heading";
    todayHeading.id = `${headingId}-today`;
    todayHeading.textContent = "Today";
    section.append(todayHeading);
    if (card.today.length) {
      const list = document.createElement("ul");
      list.className = "chore-list";
      list.setAttribute("aria-labelledby", todayHeading.id);
      for (const chore of card.today) list.append(this.todayRow(card, chore));
      section.append(list);
    } else {
      const none = document.createElement("p");
      none.className = "chore-none";
      none.textContent = "No jobs today.";
      section.append(none);
    }
    const left = card.today.filter((chore) => !chore.done).length;
    if (card.today.length && !left) {
      const all = document.createElement("p");
      all.className = "chore-all-done";
      all.textContent = "All done for today!";
      section.append(all);
    }

    if (card.week.length) {
      const week = document.createElement("details");
      week.className = "chore-week";
      // Stays open across redraws.
      week.open = this.openWeeks.has(card.memberId);
      week.addEventListener("toggle", () => {
        if (week.open) this.openWeeks.add(card.memberId);
        else this.openWeeks.delete(card.memberId);
      });
      const summary = document.createElement("summary");
      summary.textContent = "The rest of the week";
      week.append(summary);
      for (const day of card.week) {
        const name = document.createElement("h4");
        name.className = "chore-week-day";
        name.textContent = dayName(day.date);
        const list = document.createElement("ul");
        list.className = "chore-week-list";
        for (const chore of day.chores) {
          const row = document.createElement("li");
          row.className = `chore-week-row${chore.done ? " is-done" : ""}`;
          row.dataset.key = chore.key;
          const state = document.createElement("span");
          state.className = "chore-week-state";
          state.textContent = chore.done ? "✓ Done" : "Not done";
          const text = document.createElement("span");
          text.textContent = `${chore.picture?.emoji ? `${chore.picture.emoji} ` : ""}${chore.text}`;
          row.append(text, " · ", state);
          list.append(row);
        }
        week.append(name, list);
      }
      section.append(week);
    }
    if (this.isEditable && !card.adult) section.append(this.rewardEditor(card));
    item.append(section);
    return item;
  }

  todayRow(card, chore) {
    const row = document.createElement("li");
    row.className = `chore-row${chore.done ? " is-done" : ""}`;
    row.dataset.key = chore.key;
    const label = document.createElement("label");
    label.className = "chore-tick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "chore-box";
    box.checked = chore.done;
    box.dataset.focusKey = `${card.memberId}:${chore.key}`;
    // Only today's jobs tick; a day already gone shows as it was.
    box.dataset.locked = chore.today ? "false" : "true";
    box.disabled = this.isDisabled || !chore.today;
    box.addEventListener("change", () => this.emit("kin:chore-toggle", {
      memberId: card.memberId, kind: chore.kind, id: chore.id, occurrenceKey: chore.occurrenceKey, done: box.checked, text: chore.text,
    }));
    const picture = document.createElement("span");
    picture.className = "chore-picture";
    picture.setAttribute("aria-hidden", "true");
    const url = chore.picture?.attachment ? this.previewProvider?.(chore.picture.attachment) : null;
    if (chore.picture?.emoji) picture.textContent = chore.picture.emoji;
    else if (url) {
      const image = document.createElement("img");
      image.alt = "";
      image.src = url;
      picture.append(image);
    } else picture.classList.add("is-empty");
    const text = document.createElement("span");
    text.className = "chore-text";
    text.textContent = chore.text;
    const worth = document.createElement("span");
    worth.className = "chore-worth";
    worth.textContent = chore.points === 1 ? "1 point" : `${chore.points} points`;
    label.append(box, picture, text, worth);
    row.append(label);
    return row;
  }

  /** The kitchen display's larger, touch-first variant (#699). */
  get forDisplay() {
    return this.getAttribute("size") === "display";
  }

  /** Opens or closes a child's reward editor. What is typed or chosen is
   * kept in `draft`, so a redraw (a sync, a tick elsewhere) doesn't lose it. */
  openEditor(card, open) {
    this.editing = open ? card.memberId : null;
    this.draft = open ? { memberId: card.memberId, goal: card.reward?.goal ?? 20, text: card.reward?.text ?? "" } : null;
    this.render();
    // On the display the focus goes to a button, not the text box: a wall
    // tablet's keyboard would cover the chart before anyone asked to type.
    if (open) this.querySelector(`[data-focus-key="${card.memberId}:${this.forDisplay ? "goal-more" : "goal"}"]`)?.focus();
    else this.querySelector(`[data-focus-key="${card.memberId}:reward"]`)?.focus();
  }

  /** Puts the focus back on a child's "Set a reward" button (after the
   * kitchen display's confirmation closed without saving, #705). */
  focusReward(memberId) {
    this.querySelector(`[data-focus-key="${memberId}:reward"]`)?.focus();
  }

  rewardEditor(card) {
    const wrap = document.createElement("div");
    wrap.className = "chore-reward";
    const open = this.editing === card.memberId;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary chore-reward-toggle";
    toggle.textContent = card.reward ? "Change reward" : "Set a reward";
    toggle.setAttribute("aria-label", `${toggle.textContent} for ${card.name}`);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.dataset.focusKey = `${card.memberId}:reward`;
    toggle.disabled = this.isDisabled;
    toggle.addEventListener("click", () => this.openEditor(card, !open));
    wrap.append(toggle);
    if (!open) return wrap;
    if (this.draft?.memberId !== card.memberId) this.draft = { memberId: card.memberId, goal: card.reward?.goal ?? 20, text: card.reward?.text ?? "" };
    const draft = this.draft;
    const form = document.createElement("form");
    form.className = "chore-reward-form";
    const textId = `chore-reward-text-${card.memberId}`;
    const textLabel = document.createElement("label");
    textLabel.htmlFor = textId;
    textLabel.textContent = "Reward";
    const text = document.createElement("input");
    text.id = textId;
    text.type = "text";
    text.required = true;
    text.maxLength = 120;
    text.placeholder = "Movie night";
    text.enterKeyHint = "done";
    text.value = draft.text;
    text.dataset.focusKey = `${card.memberId}:reward-text`;
    text.addEventListener("input", () => { draft.text = text.value; });
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "chore-reward-save";
    save.textContent = "Save reward";
    save.disabled = this.isDisabled;
    let goalValue;
    if (this.forDisplay) {
      // Touch-first: the goal is chosen with big buttons, never typed.
      form.append(this.goalStepper(card, draft), textLabel, text);
      goalValue = () => draft.goal;
    } else {
      const goalId = `chore-goal-${card.memberId}`;
      const goalLabel = document.createElement("label");
      goalLabel.htmlFor = goalId;
      goalLabel.textContent = "Points to reach this week";
      const goal = document.createElement("input");
      goal.id = goalId;
      goal.type = "number";
      goal.min = "1";
      goal.max = "1000";
      goal.required = true;
      goal.inputMode = "numeric";
      goal.value = String(draft.goal);
      goal.dataset.focusKey = `${card.memberId}:goal`;
      goal.addEventListener("input", () => { draft.goal = Number(goal.value); });
      form.append(goalLabel, goal, textLabel, text);
      goalValue = () => Number(goal.value);
    }
    const actions = document.createElement("div");
    actions.className = "chore-reward-actions";
    actions.append(save);
    if (card.reward) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary chore-reward-remove";
      remove.textContent = "Remove reward";
      remove.disabled = this.isDisabled;
      remove.addEventListener("click", () => {
        this.editing = null;
        this.draft = null;
        this.emit("kin:chore-reward", { memberId: card.memberId, goal: 0, text: "" });
        this.render();
        this.querySelector(`[data-focus-key="${card.memberId}:reward"]`)?.focus();
      });
      actions.append(remove);
    }
    if (this.forDisplay) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary chore-reward-cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => this.openEditor(card, false));
      actions.append(cancel);
    }
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = goalValue();
      if (!form.reportValidity() || !Number.isInteger(value) || value < 1 || value > MAX_GOAL) return;
      this.editing = null;
      this.draft = null;
      this.emit("kin:chore-reward", { memberId: card.memberId, goal: value, text: text.value });
      // Closed at once; the next `cards` shows the reward once it's saved.
      this.render();
      this.querySelector(`[data-focus-key="${card.memberId}:reward"]`)?.focus();
    });
    wrap.append(form);
    return wrap;
  }

  /** The display's goal: one point fewer or more, or a common goal, each a
   * 64 px button; the number itself is read out as it changes. */
  goalStepper(card, draft) {
    const group = document.createElement("fieldset");
    group.className = "chore-goal-stepper";
    const legend = document.createElement("legend");
    legend.textContent = "Points to reach this week";
    const row = document.createElement("div");
    row.className = "chore-goal-row";
    const value = document.createElement("output");
    value.className = "chore-goal-value";
    value.setAttribute("aria-live", "polite");
    const step = (label, delta, key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary chore-goal-step";
      button.dataset.step = String(delta);
      button.dataset.focusKey = `${card.memberId}:${key}`;
      button.textContent = delta < 0 ? "−" : "+";
      button.setAttribute("aria-label", label);
      button.addEventListener("click", () => { draft.goal = clampGoal(draft.goal + delta); this.render(); });
      return button;
    };
    const fewer = step("One point fewer", -1, "goal-fewer");
    const more = step("One point more", 1, "goal-more");
    fewer.disabled = this.isDisabled || draft.goal <= 1;
    more.disabled = this.isDisabled || draft.goal >= MAX_GOAL;
    value.textContent = draft.goal === 1 ? "1 point" : `${draft.goal} points`;
    row.append(fewer, value, more);
    const presets = document.createElement("div");
    presets.className = "chore-goal-presets";
    for (const goal of GOAL_PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary chore-goal-preset";
      button.dataset.goal = String(goal);
      button.dataset.focusKey = `${card.memberId}:goal-${goal}`;
      button.textContent = String(goal);
      button.setAttribute("aria-label", `${goal} points`);
      button.setAttribute("aria-pressed", String(draft.goal === goal));
      button.disabled = this.isDisabled;
      button.addEventListener("click", () => { draft.goal = goal; this.render(); });
      presets.append(button);
    }
    group.append(legend, row, presets);
    return group;
  }

  emit(type, detail) {
    if (this.isDisabled) return;
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  }
}

if (!customElements.get("kin-chore-chart")) customElements.define("kin-chore-chart", KinChoreChart);
