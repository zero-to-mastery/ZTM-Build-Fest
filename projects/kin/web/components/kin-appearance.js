import { APPEARANCE_PRESETS, KIN_DEFAULT_SEED, normalizeHex } from "../appearance/palette.js";
import { DEFAULT_APPEARANCE } from "../appearance/store.js";
import { processBackground } from "../appearance/image.js";
import { useHouseholdAppearance } from "../appearance/household.js";

let appearanceInstance = 0;

export class KinAppearance extends HTMLElement {
  constructor() {
    super();
    this.saved = null;
    this.draft = null;
    this.dirty = false;
    this.forceExplicit = false;
    this.generation = 0;
    this.instanceId = ++appearanceInstance;
  }

  connectedCallback() { if (!this.firstElementChild) this.build(); }

  build() {
    const heading = document.createElement("h2");
    heading.textContent = "Your appearance";
    const scope = document.createElement("p");
    scope.className = "section-hint";
    scope.textContent = "Only changes how Kin looks for you on this device.";
    this.form = document.createElement("form");
    this.form.className = "appearance-form";
    this.form.addEventListener("submit", (event) => { event.preventDefault(); this.requestSave(); });

    const mode = this.group("Appearance mode");
    this.modeControls = new Map();
    for (const [value, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]]) {
      const wrapper = document.createElement("label"); wrapper.className = "appearance-option";
      const input = document.createElement("input"); input.type = "radio"; input.name = `appearance-mode-${this.instanceId}`; input.value = value;
      input.addEventListener("change", () => { if (input.checked) this.change({ mode: value }); });
      wrapper.append(input, label); mode.body.append(wrapper); this.modeControls.set(value, input);
    }
    mode.body.append(this.followButton("mode", "Follow household mode"));

    const colors = this.group("Theme color");
    this.swatches = document.createElement("div"); this.swatches.className = "appearance-swatches";
    this.presetControls = new Map();
    for (const preset of APPEARANCE_PRESETS) {
      const label = document.createElement("label"); label.className = "appearance-swatch";
      const input = document.createElement("input"); input.type = "radio"; input.name = `appearance-preset-${this.instanceId}`; input.value = preset.id;
      const chip = document.createElement("span"); chip.className = `swatch-chip swatch-${preset.id}`; chip.setAttribute("aria-hidden", "true");
      const text = document.createElement("span"); text.textContent = preset.name;
      input.addEventListener("change", () => { if (input.checked) this.choosePreset(preset); });
      label.append(input, chip, text); this.swatches.append(label); this.presetControls.set(preset.id, input);
    }
    const customRow = document.createElement("div"); customRow.className = "appearance-custom-row";
    const pickerLabel = document.createElement("label"); pickerLabel.textContent = "Custom color";
    this.picker = document.createElement("input"); this.picker.type = "color"; this.picker.value = KIN_DEFAULT_SEED; this.picker.setAttribute("aria-label", "Choose a custom theme color");
    this.picker.addEventListener("input", () => { this.syncHex(this.picker.value); this.chooseCustom(this.picker.value); });
    pickerLabel.append(this.picker);
    const hexLabel = document.createElement("label"); hexLabel.textContent = "Hex color";
    this.hex = document.createElement("input"); this.hex.type = "text"; this.hex.inputMode = "text"; this.hex.maxLength = 7; this.hex.autocomplete = "off"; this.hex.spellcheck = false;
    this.hex.addEventListener("input", () => {
      this.dirty = true;
      const value = normalizeHex(this.hex.value);
      this.setHexValidity(Boolean(value));
      if (value) { this.picker.value = value; this.chooseCustom(value); }
    });
    hexLabel.append(this.hex);
    this.hexError = document.createElement("p"); this.hexError.className = "field-error"; this.hexError.textContent = "Enter a color as #RRGGBB."; this.hexError.hidden = true;
    this.hexError.id = `appearance-hex-error-${this.instanceId}`; this.hex.setAttribute("aria-describedby", this.hexError.id);
    customRow.append(pickerLabel, hexLabel);
    this.useBackground = document.createElement("button"); this.useBackground.type = "button"; this.useBackground.textContent = "Use background colors"; this.useBackground.addEventListener("click", () => { if (this.draft.image) { this.syncHex(this.draft.image.seed); this.change({ colorSource: "background", seed: this.draft.image.seed }); } });
    this.source = document.createElement("p"); this.source.className = "appearance-source";
    colors.body.append(this.swatches, customRow, this.hexError, this.useBackground, this.source, this.followButton("color", "Follow household color"));

    const background = this.group("Background");
    this.choose = document.createElement("button"); this.choose.type = "button"; this.choose.textContent = "Choose image"; this.choose.addEventListener("click", () => this.openImagePicker());
    this.remove = document.createElement("button"); this.remove.type = "button"; this.remove.textContent = "Remove background"; this.remove.addEventListener("click", () => this.removeImage());
    this.imageStatus = document.createElement("p"); this.imageStatus.className = "section-hint"; this.imageStatus.setAttribute("role", "status");
    background.body.append(this.choose, this.remove, this.imageStatus, this.followButton("background", "Follow household background"));

    const actions = document.createElement("div"); actions.className = "appearance-actions";
    this.save = document.createElement("button"); this.save.type = "submit"; this.save.className = "primary-action"; this.save.textContent = "Save changes";
    this.cancel = document.createElement("button"); this.cancel.type = "button"; this.cancel.textContent = "Cancel"; this.cancel.addEventListener("click", () => this.restoreSaved("Changes canceled."));
    this.reset = document.createElement("button"); this.reset.type = "button"; this.reset.textContent = "Reset to Kin default"; this.reset.addEventListener("click", () => { this.generation++; this.dirty = true; this.forceExplicit = true; this.draft = { ...DEFAULT_APPEARANCE, owner: this.saved?.owner ?? null }; this.update("Kin defaults are previewed. Save changes to keep them."); });
    this.inherit = document.createElement("button"); this.inherit.type = "button"; this.inherit.textContent = "Use household appearance"; this.inherit.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:use-household-appearance", { bubbles: true, detail: { value: useHouseholdAppearance(this.saved?.owner ?? null) } })));
    this.feedback = document.createElement("p"); this.feedback.className = "appearance-feedback"; this.feedback.setAttribute("role", "status"); this.feedback.setAttribute("aria-live", "polite");
    actions.append(this.save, this.cancel, this.reset, this.inherit);
    this.form.append(mode.fieldset, colors.fieldset, background.fieldset, actions, this.feedback);
    this.append(heading, scope, this.form);
  }

  group(legendText) { const fieldset = document.createElement("fieldset"), legend = document.createElement("legend"), body = document.createElement("div"); body.className = "appearance-group"; legend.textContent = legendText; fieldset.append(legend, body); return { fieldset, body }; }

  followButton(property, label) { const button = document.createElement("button"); button.type = "button"; button.className = "appearance-follow"; button.textContent = label; button.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:inherit-appearance-property", { bubbles: true, detail: { property } }))); return button; }

  initialize(value) { this.generation++; this.saved = structuredClone(value); this.draft = structuredClone(value); this.dirty = false; this.forceExplicit = false; this.disabled = false; this.update(""); }
  clear() { this.generation++; this.saved = null; this.draft = null; this.dirty = false; this.forceExplicit = false; this.feedback.textContent = ""; this.replaceChildren(); this.build(); }
  set disabled(value) { for (const control of this.querySelectorAll("button,input")) control.disabled = Boolean(value); }

  choosePreset(preset) {
    const manual = preset.id === "default" ? null : { source: "preset", name: preset.name, seed: preset.seed };
    this.syncHex(preset.seed);
    this.change({ colorSource: preset.id === "default" ? "default" : "preset", seed: preset.seed, manual });
  }
  chooseCustom(seed) { this.change({ colorSource: "custom", seed: normalizeHex(seed), manual: { source: "custom", name: "Custom color", seed: normalizeHex(seed) } }); }
  setHexValidity(valid) { this.hexError.hidden = valid; this.hex.setAttribute("aria-invalid", String(!valid)); }
  syncHex(seed) { this.hex.value = normalizeHex(seed) ?? ""; this.setHexValidity(true); }
  change(patch) {
    if (!this.draft) return;
    // A manual choice invalidates late automatic extraction without freezing
    // the rest of the editor while native decoding continues.
    if (["preset", "custom"].includes(patch.colorSource)) this.generation++;
    this.dirty = true;
    this.draft = { ...this.draft, ...patch };
    this.update("Unsaved changes.");
  }

  openImagePicker() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.hidden = true;
    const release = () => input.remove();
    input.addEventListener("change", () => { const file = input.files?.[0]; release(); if (file) void this.chooseImage(file); }, { once: true });
    input.addEventListener("cancel", release, { once: true });
    this.append(input);
    input.click();
  }

  async chooseImage(file) {
    const generation = ++this.generation;
    this.imageStatus.textContent = "Processing image on this device…";
    try {
      const image = await processBackground(file);
      if (generation !== this.generation || !this.draft) return;
      const automatic = ["default", "background"].includes(this.draft.colorSource);
      this.dirty = true;
      this.draft = { ...this.draft, image, ...(automatic ? { colorSource: "background", seed: image.seed } : {}) };
      if (automatic) this.syncHex(image.seed);
      this.update("Image ready. Save changes to keep it.");
    } catch (error) { if (generation === this.generation) { this.imageStatus.textContent = error.message; this.feedback.textContent = "The previous saved background is unchanged."; } }
    finally { /* Temporary bitmap and canvas resources are released by the processor. */ }
  }

  removeImage() {
    this.generation++;
    this.dirty = true;
    const sourceWasImage = this.draft.colorSource === "background";
    const manual = this.draft.manual;
    this.draft = { ...this.draft, image: null, ...(sourceWasImage ? { colorSource: manual?.source ?? "default", seed: manual?.seed ?? KIN_DEFAULT_SEED } : {}) };
    this.update("Background removed from the preview. Save changes to keep it removed.");
  }

  restoreSaved(message) { this.generation++; this.dirty = false; this.forceExplicit = false; this.draft = structuredClone(this.saved); this.update(message); }
  async requestSave() {
    if (!this.draft) return;
    if (this.hex.getAttribute("aria-invalid") === "true") { this.feedback.textContent = "Finish the hex color before saving."; this.hex.focus(); return; }
    if (this.draft.colorSource === "custom") {
      const custom = normalizeHex(this.hex.value);
      if (!custom) { this.setHexValidity(false); return; }
      this.draft = { ...this.draft, seed: custom, manual: { source: "custom", name: "Custom color", seed: custom } };
    }
    this.generation++;
    this.disabled = true; this.feedback.textContent = "Saving…";
    this.dispatchEvent(new CustomEvent("kin:save-appearance", { bubbles: true, detail: { value: structuredClone(this.draft), baseline: structuredClone(this.saved), forceExplicit: this.forceExplicit, complete: (result, error) => {
      if (!error) { this.saved = structuredClone(result); this.draft = structuredClone(result); this.dirty = false; this.forceExplicit = false; }
      this.disabled = false; this.update(error ? error.message : "Appearance saved on this device.", !error);
    } } }));
  }

  update(message, saved = false) {
    if (!this.draft) return;
    for (const [value, input] of this.modeControls) input.checked = value === this.draft.mode;
    for (const [presetId, input] of this.presetControls) input.checked = (this.draft.colorSource === "default" && presetId === "default") || (this.draft.colorSource === "preset" && APPEARANCE_PRESETS.find((item) => item.id === presetId)?.seed === this.draft.seed);
    this.picker.value = this.draft.seed; if (this.draft.colorSource !== "custom") this.syncHex(this.draft.seed); else if (document.activeElement !== this.hex) { this.hex.value = this.draft.seed; this.setHexValidity(true); }
    this.useBackground.hidden = !this.draft.image; this.remove.hidden = !this.draft.image; this.choose.textContent = this.draft.image ? "Replace image" : "Choose image";
    this.imageStatus.textContent = this.draft.image ? `Processed locally (${this.draft.image.width} × ${this.draft.image.height}).` : "No personal background selected.";
    const preset = APPEARANCE_PRESETS.find((item) => item.seed === this.draft.seed);
    this.source.textContent = `Color source: ${this.draft.colorSource === "background" ? "From background" : this.draft.colorSource === "custom" ? "Custom color" : this.draft.colorSource === "preset" ? `Preset: ${preset?.name ?? this.draft.manual?.name}` : "Kin default"}.`;
    this.feedback.textContent = message; this.feedback.dataset.saved = String(saved);
    this.dispatchEvent(new CustomEvent("kin:appearance-preview", { bubbles: true, detail: { value: structuredClone(this.draft) } }));
  }
}

customElements.define("kin-appearance", KinAppearance);
