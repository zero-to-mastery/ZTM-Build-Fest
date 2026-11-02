// "Count on the app icon" (#476, #478), under Notifications on People &
// devices. A choice for this device only, Off until the member picks one.
// Hidden where the browser can't badge the app icon. The app applies the
// choice (app/badge.js) through the kin:app-badge-choice event.
import { APP_BADGE_CHOICES, appBadgeSupported, readAppBadgeChoice } from "../app-badge.js";

let instances = 0;

class KinAppBadge extends HTMLElement {
  connectedCallback() {
    if (!this.firstElementChild) this.build();
    this.hidden = !appBadgeSupported();
    this.value = readAppBadgeChoice();
  }

  build() {
    const id = `app-badge-${++instances}`;
    this.setAttribute("role", "group");
    this.setAttribute("aria-labelledby", `${id}-heading`);
    const heading = document.createElement("h2");
    heading.id = `${id}-heading`;
    heading.textContent = "Count on the app icon";
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.id = `${id}-hint`;
    hint.textContent = "Shows a number on Kin's icon on this device, never what the messages or things are. Anyone who can see this screen can see the number, even after Kin is closed. Locking Kin or signing out clears it.";
    const fieldset = document.createElement("fieldset");
    fieldset.setAttribute("aria-describedby", hint.id);
    const legend = document.createElement("legend");
    legend.textContent = "Show on the icon";
    fieldset.append(legend);
    this.inputs = new Map();
    for (const { value, label } of APP_BADGE_CHOICES) {
      const wrapper = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${id}-choice`;
      input.value = value;
      input.addEventListener("change", () => { if (input.checked) this.choose(value); });
      wrapper.append(input, label);
      fieldset.append(wrapper);
      this.inputs.set(value, input);
    }
    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback";
    this.feedback.setAttribute("role", "status");
    this.append(heading, hint, fieldset, this.feedback);
  }

  set value(choice) {
    for (const [value, input] of this.inputs ?? []) input.checked = value === choice;
  }

  choose(value) {
    const detail = { value, kept: true };
    this.dispatchEvent(new CustomEvent("kin:app-badge-choice", { bubbles: true, composed: true, detail }));
    const label = APP_BADGE_CHOICES.find((choice) => choice.value === value)?.label ?? "Off";
    this.feedback.textContent = detail.kept
      ? (value === "off" ? "No count on the app icon." : `The app icon shows: ${label.toLowerCase()}.`)
      : "Kin couldn't save this choice on this device; it applies until Kin closes.";
  }
}

customElements.define("kin-app-badge", KinAppBadge);
