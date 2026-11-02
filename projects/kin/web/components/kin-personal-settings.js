// "Text, motion and reminders" (#524), under Personal appearance: easy mode
// (#617, ADR 0021), text size, a reduced-motion override, whether reminders
// alert, and — where the
// member's private storage is on — "Use different settings on this device"
// for a shared screen such as a kitchen tablet. One line says where these
// live: on all the member's devices, on this one only, or (no account yet)
// on this one with an offer to set up an account. The app applies each
// choice (app/private-prefs.js) through kin:personal-setting and
// kin:settings-this-device; update(view) shows the current values.
import { TEXT_SIZES } from "../appearance/display-prefs.js";
import { EASY_MODE_COPY } from "../easy/easy-mode.js";

let instances = 0;

const SCOPE_LINES = Object.freeze({
  synced: "Your theme, the app icon count and these choices follow you to your other devices, and so do your reminders.",
  "device-only": "This device keeps its own settings. Your reminders still follow you.",
  off: "Your household has turned off private storage for you, so your reminders and these choices stay on this device.",
  device: "Your reminders and these choices stay on this device. Set up an account to have them on all your devices.",
});

class KinPersonalSettings extends HTMLElement {
  connectedCallback() {
    if (!this.firstElementChild) this.build();
    if (this.view) this.update(this.view);
  }

  build() {
    const id = `personal-settings-${++instances}`;
    this.setAttribute("role", "group");
    this.setAttribute("aria-labelledby", `${id}-heading`);
    const heading = document.createElement("h2");
    heading.id = `${id}-heading`;
    heading.textContent = "Text, motion and reminders";
    this.scopeLine = document.createElement("p");
    this.scopeLine.className = "section-hint personal-settings-scope";

    const sizes = document.createElement("fieldset");
    const sizeLegend = document.createElement("legend");
    sizeLegend.textContent = "Text size";
    sizes.append(sizeLegend);
    this.sizeInputs = new Map();
    for (const { value, label } of TEXT_SIZES) {
      const wrapper = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${id}-text-size`;
      input.value = value;
      input.addEventListener("change", () => { if (input.checked) this.choose("text-size", value, `Text size: ${label.toLowerCase()}.`); });
      wrapper.append(input, label);
      sizes.append(wrapper);
      this.sizeInputs.set(value, input);
    }

    // Easy mode (#617): first, so someone who finds the page hard sees it first.
    this.easy = this.checkbox(`${id}-easy`, EASY_MODE_COPY.label, EASY_MODE_COPY.hint,
      (on) => this.choose("easy-mode", on ? "on" : "off", on ? EASY_MODE_COPY.on : EASY_MODE_COPY.off));
    this.easy.wrapper.classList.add("easy-mode-setting");

    this.motion = this.checkbox(`${id}-motion`, "Reduce motion in Kin",
      "Kin also follows your device's own reduced-motion setting.",
      (on) => this.choose("motion", on ? "reduce" : "system", on ? "Kin keeps motion to a minimum." : "Kin follows your device's motion setting."));
    this.alerts = this.checkbox(`${id}-alerts`, "Show my reminders as notifications",
      "On devices where you allow Kin's notifications, while Kin is open.",
      (on) => this.choose("reminder-alerts", on ? "on" : "off", on ? "Your reminders show as notifications." : "Your reminders stay quiet."));
    this.deviceOnly = this.checkbox(`${id}-device-only`, "Use different settings on this device",
      "For a shared screen such as a kitchen tablet: changes here stay here, and changes on your other devices don't arrive.",
      (on) => {
        const detail = { on, kept: true };
        this.dispatchEvent(new CustomEvent("kin:settings-this-device", { bubbles: true, composed: true, detail }));
        this.feedback.textContent = !detail.kept ? "Kin couldn't keep this choice on this device; it applies until Kin closes."
          : on ? "This device now keeps its own settings." : "This device follows your settings again.";
      });

    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback";
    this.feedback.setAttribute("role", "status");
    this.append(heading, this.scopeLine, this.easy.wrapper, sizes, this.motion.wrapper, this.alerts.wrapper, this.deviceOnly.wrapper, this.feedback);
  }

  checkbox(id, label, hint, onChange) {
    const wrapper = document.createElement("div");
    wrapper.className = "personal-setting";
    const text = document.createElement("label");
    text.htmlFor = id;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    const hintText = document.createElement("p");
    hintText.className = "section-hint";
    hintText.id = `${id}-hint`;
    hintText.textContent = hint;
    input.setAttribute("aria-describedby", hintText.id);
    input.addEventListener("change", () => onChange(input.checked));
    text.append(input, label);
    wrapper.append(text, hintText);
    return { wrapper, input };
  }

  choose(name, value, said) {
    this.dispatchEvent(new CustomEvent("kin:personal-setting", { bubbles: true, composed: true, detail: { name, value } }));
    this.feedback.textContent = said;
  }

  /** Shows `view` (app/private-prefs.js settingsView). */
  update(view) {
    this.view = view;
    if (!this.firstElementChild) return;
    this.scopeLine.textContent = SCOPE_LINES[view.scope] ?? SCOPE_LINES.device;
    for (const [value, input] of this.sizeInputs) input.checked = value === view.textSize;
    this.easy.input.checked = view.easyMode === "on";
    this.motion.input.checked = view.motion === "reduce";
    this.alerts.input.checked = view.reminderAlerts !== "off";
    // Only where there is something to keep apart from.
    this.deviceOnly.wrapper.hidden = !["synced", "device-only"].includes(view.scope);
    this.deviceOnly.input.checked = Boolean(view.deviceOnly);
  }
}

customElements.define("kin-personal-settings", KinPersonalSettings);
