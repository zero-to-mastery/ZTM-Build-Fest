import "./kin-appearance.js";
import "./kin-install-identity.js";
import { DEFAULT_APPEARANCE } from "../appearance/store.js";
import { DEFAULT_HOUSEHOLD_BRAND, DEFAULT_HOUSEHOLD_NAME, normalizeHouseholdName } from "../appearance/household.js";

export class KinHouseholdDefaults extends HTMLElement {
  connectedCallback() { if (!this.firstElementChild) this.build(); }
  build() {
    const heading = document.createElement("h2"); heading.textContent = "Identity & defaults";
    this.note = document.createElement("p"); this.note.className = "section-hint";
    this.identity = document.createElement("fieldset"); const legend = document.createElement("legend"); legend.textContent = "Household identity";
    const label = document.createElement("label"); label.textContent = "Household name";
    this.nameInput = document.createElement("input"); this.nameInput.maxLength = 80; this.nameInput.autocomplete = "off";
    const help = document.createElement("small"); help.textContent = "This name appears for everyone in your household.";
    this.nameError = document.createElement("p"); this.nameError.className = "field-error"; this.nameError.setAttribute("role", "alert");
    label.append(this.nameInput); this.identity.append(legend, label, help, this.nameError);
    this.editor = document.createElement("kin-appearance");
    this.warning = document.createElement("p"); this.warning.className = "section-hint";
    this.warning.textContent = "Saving updates the defaults for members who follow the household appearance. Personal choices stay unchanged.";
    this.feedback = document.createElement("p"); this.feedback.className = "appearance-feedback"; this.feedback.setAttribute("role", "status"); this.feedback.setAttribute("aria-live", "polite");
    this.nameInput.addEventListener("input", () => this.preview());
    this.editor.addEventListener("kin:appearance-preview", (event) => { event.stopPropagation(); this.draftAppearance = event.detail.value; if (!this.initializing) this.preview(); });
    this.editor.addEventListener("kin:save-appearance", (event) => { event.stopPropagation(); event.detail.complete(null, new Error("Use Save household settings below.")); });
    this.append(heading, this.note, this.identity, this.editor, this.warning, this.feedback);
  }
  initialize({ admin, adminRecorded, value }) {
    this.admin = admin === true; this.adminRecorded = adminRecorded;
    // Shared mutation controls must not enter the rendered or accessibility
    // tree without authority established by the authenticated server response.
    this.hidden = !this.admin;
    if (!this.admin) {
      // Authority can be withdrawn after it was granted; drop the privileged
      // actions and lock the remaining controls rather than only hiding them.
      this.actions?.remove(); this.actions = null;
      this.install?.remove(); this.install = null;
      this.dirty = false; this.pending = null;
      this.disabled = this.busy;
      return false;
    }
    const incoming = value ?? { version: 1, revision: 0, name: DEFAULT_HOUSEHOLD_NAME, appearance: { ...DEFAULT_APPEARANCE, owner: "household" }, brand: { ...DEFAULT_HOUSEHOLD_BRAND } };
    if (this.dirty && this.saved) {
      if (incoming.revision > this.saved.revision) {
        this.pending = structuredClone(incoming);
        this.note.textContent = "Newer household settings arrived while you were editing. Your draft is preserved; cancel it to load the latest settings.";
      }
      this.identity.disabled = false; this.editor.disabled = false;
      this.disabled = this.busy;
      return true;
    }
    this.saved = incoming; this.pending = null; this.dirty = false;
    this.nameInput.value = this.saved.name; this.draftAppearance = structuredClone(this.saved.appearance);
    this.initializing = true; this.editor.initialize(this.draftAppearance); this.initializing = false;
    this.note.textContent = "Set the name and default appearance shared by your household.";
    this.identity.disabled = false; this.editor.disabled = false;
    this.installActions();
    if (this.install) this.initializeInstall({ published: this.install.state?.published ?? null });
    // Busy state may have been applied before admin authority arrived and
    // left the name input disabled; recompute control state now.
    this.disabled = this.busy;
    return false;
  }
  // The admin-only "Home screen" section (#78). It exists in the DOM only
  // while the server says this member is an admin.
  initializeInstall(state) {
    if (!this.admin) { this.install?.remove(); this.install = null; return; }
    if (!this.install) {
      this.install = document.createElement("kin-install-identity");
      this.append(this.install);
    }
    this.install.initialize({ ...state, householdName: this.saved?.name, seed: this.saved?.appearance?.seed, brand: this.saved?.brand ?? DEFAULT_HOUSEHOLD_BRAND });
    this.install.disabled = this.busy;
  }
  installActions() {
    this.actions?.remove(); this.actions = document.createElement("div"); this.actions.className = "appearance-actions";
    if (this.admin) {
      const save = button("Save household settings", () => this.save(), "primary-action");
      const cancel = button("Cancel changes", () => this.restore());
      const reset = button("Restore Kin defaults", () => { if (confirm("Restore Kin's shared defaults? Personal appearance choices will not change.")) { this.nameInput.value = DEFAULT_HOUSEHOLD_NAME; this.draftAppearance = { ...DEFAULT_APPEARANCE, owner: "household" }; this.editor.initialize(this.draftAppearance); this.preview("Kin defaults are previewed. Save to share them."); } });
      this.actions.append(save, cancel, reset);
    }
    this.insertBefore(this.actions, this.feedback);
  }
  preview(message = "Unsaved shared preview.") {
    if (!this.admin || !this.draftAppearance) return;
    this.dirty = true;
    this.feedback.textContent = message;
    this.dispatchEvent(new CustomEvent("kin:household-defaults-preview", { bubbles: true, detail: { name: this.nameInput.value.trim() || DEFAULT_HOUSEHOLD_NAME, appearance: structuredClone(this.draftAppearance) } }));
  }
  restore() {
    const latest = this.pending ?? this.saved;
    this.saved = structuredClone(latest); this.pending = null; this.dirty = false;
    this.nameInput.value = this.saved.name; this.draftAppearance = structuredClone(this.saved.appearance);
    this.initializing = true; this.editor.initialize(this.draftAppearance); this.initializing = false;
    this.note.textContent = "Set the name and default appearance shared by your household.";
    this.feedback.textContent = "Changes canceled.";
    this.dispatchEvent(new CustomEvent("kin:household-defaults-cancel", { bubbles: true }));
  }
  save() {
    if (this.pending) { this.feedback.textContent = "Newer household settings arrived. Cancel your draft to load them before making another change."; return; }
    let name; try { name = normalizeHouseholdName(this.nameInput.value); this.nameError.textContent = ""; } catch (error) { this.nameError.textContent = error.message; this.nameInput.focus(); return; }
    this.dispatchEvent(new CustomEvent("kin:save-household-defaults", { bubbles: true, detail: { value: { version: 1, revision: this.saved.revision, name, appearance: { ...structuredClone(this.draftAppearance), owner: "household" }, brand: structuredClone(this.saved.brand ?? DEFAULT_HOUSEHOLD_BRAND) }, complete: (saved, error) => {
      this.feedback.textContent = error?.message ?? "Household settings saved. Other online members receive them when they sync.";
      if (saved) {
        const newerPending = this.pending?.revision > saved.revision;
        this.saved = structuredClone(newerPending ? this.pending : saved); this.pending = null; this.dirty = false;
        this.nameInput.value = this.saved.name; this.draftAppearance = structuredClone(this.saved.appearance);
        this.initializing = true; this.editor.initialize(this.draftAppearance); this.initializing = false;
        this.note.textContent = "Set the name and default appearance shared by your household.";
        if (newerPending) this.feedback.textContent = "Your change was saved, then newer household settings arrived. The latest settings are shown.";
        if (this.install) this.initializeInstall({ published: this.install.state?.published ?? null });
      }
    } } }));
  }
  set disabled(value) {
    this.busy = Boolean(value);
    for (const control of this.querySelectorAll("button,input")) {
      if (this.install?.contains(control)) continue;
      control.disabled = this.busy || (!this.admin && this.contains(control));
    }
    if (this.install) this.install.disabled = this.busy;
  }
}
function button(label, action, className = "") { const value = document.createElement("button"); value.type = "button"; value.textContent = label; value.className = className; value.addEventListener("click", action); return value; }
customElements.define("kin-household-defaults", KinHouseholdDefaults);
