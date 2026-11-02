// <kin-display-setup> (#670): Household › Overview's "Use this device as a
// kitchen display", for Adults. It says what the display shows and what it
// hides, lets the adult choose the night and the photo frame's wait, and
// asks to start. It only draws and reports:
// - `settings` = { night: { from, to }, idleMinutes } (display/schedule.js);
// - `available`: whether this member may (an Adult, the feature on).
// It dispatches `kin:display-enter` { night, idleMinutes } (bubbling).
import { IDLE_CHOICES, clockText, parseClock } from "../../display/schedule.js";

const SHOWS = [
  "Today's events and countdowns, and the week",
  "Each child's chore chart, in their colour, to tick off",
  "Today's meals and the shopping list",
  "The fridge, and recent chat messages to read",
  "Family photos when nobody has touched it for a while",
];
const HIDES = "It never shows your journal, Just for me, your reminders, Search, Household settings or anything only an admin can do, and nobody can write in Chat from it.";

class KinDisplaySetup extends HTMLElement {
  constructor() {
    super();
    this.value = { night: { from: 21 * 60, to: 6 * 60 + 30 }, idleMinutes: 5 };
    this.isAvailable = false;
  }

  connectedCallback() {
    if (!this.form) this.build();
    this.render();
  }

  set settings(value) {
    if (value?.night) this.value = { night: { ...value.night }, idleMinutes: value.idleMinutes ?? 5 };
    this.render();
  }

  set available(value) {
    this.isAvailable = Boolean(value);
    this.render();
  }

  build() {
    this.classList.add("today-section", "display-setup");
    this.setAttribute("role", "region");
    this.setAttribute("aria-labelledby", "display-setup-title");
    const heading = document.createElement("h2");
    heading.id = "display-setup-title";
    heading.textContent = "Kitchen display";
    const lead = document.createElement("p");
    lead.className = "section-hint";
    lead.textContent = "Turn this tablet into a screen on the kitchen wall that everyone can see and tap. It stays signed in as you and stays awake.";
    const shows = document.createElement("ul");
    shows.className = "display-setup-shows";
    shows.setAttribute("aria-label", "What the kitchen display shows");
    shows.append(...SHOWS.map((text) => { const item = document.createElement("li"); item.textContent = text; return item; }));
    const hides = document.createElement("p");
    hides.className = "section-hint";
    hides.textContent = HIDES;
    const lock = document.createElement("p");
    lock.className = "section-hint display-setup-lock";
    lock.textContent = "Kin doesn't lock by itself while it is a kitchen display, so anyone in the kitchen can see and tick household things. To leave display mode you need your password or passkey.";
    this.form = document.createElement("form");
    this.form.className = "display-setup-form";
    const night = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Dim the screen at night";
    this.fromInput = this.time("display-night-from", "From");
    this.toInput = this.time("display-night-to", "Until");
    night.append(legend, this.fromInput.parentElement, this.toInput.parentElement);
    const idleLabel = document.createElement("label");
    idleLabel.htmlFor = "display-idle-minutes";
    idleLabel.textContent = "Show family photos after this many quiet minutes";
    this.idleSelect = document.createElement("select");
    this.idleSelect.id = idleLabel.htmlFor;
    this.idleSelect.append(...IDLE_CHOICES.map((minutes) => {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = minutes === 1 ? "1 minute" : `${minutes} minutes`;
      return option;
    }));
    const idle = document.createElement("p");
    idle.className = "display-setup-field";
    idle.append(idleLabel, this.idleSelect);
    this.button = document.createElement("button");
    this.button.type = "submit";
    this.button.className = "primary-action display-setup-start";
    this.button.textContent = "Use this device as a kitchen display";
    this.form.append(night, idle, this.button);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.isAvailable) return;
      const from = parseClock(this.fromInput.value) ?? this.value.night.from;
      const to = parseClock(this.toInput.value) ?? this.value.night.to;
      const idleMinutes = Number(this.idleSelect.value);
      this.dispatchEvent(new CustomEvent("kin:display-enter", { bubbles: true, composed: true, detail: { night: { from, to }, idleMinutes } }));
    });
    this.unavailable = document.createElement("p");
    this.unavailable.className = "section-hint display-setup-unavailable";
    this.unavailable.textContent = "Only an adult's device can be a kitchen display.";
    this.append(heading, lead, shows, hides, lock, this.form, this.unavailable);
  }

  time(id, text) {
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = text;
    const input = document.createElement("input");
    input.type = "time";
    input.id = id;
    input.step = 60;
    input.required = true;
    const wrap = document.createElement("span");
    wrap.className = "display-setup-time";
    wrap.append(label, input);
    return input;
  }

  render() {
    if (!this.form) return;
    if (document.activeElement !== this.fromInput) this.fromInput.value = clockText(this.value.night.from);
    if (document.activeElement !== this.toInput) this.toInput.value = clockText(this.value.night.to);
    if (document.activeElement !== this.idleSelect) this.idleSelect.value = String(this.value.idleMinutes);
    this.form.hidden = !this.isAvailable;
    this.unavailable.hidden = this.isAvailable;
  }
}

customElements.define("kin-display-setup", KinDisplaySetup);
