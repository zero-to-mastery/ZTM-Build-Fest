// Household → Features (#626, ADR 0021 §2): the parts of Kin a household
// can switch off, each with a plain description. A household admin turns
// them on or off and saves with a fresh passkey (or password, for an admin
// without a passkey); everyone else sees the list read-only. A household
// that doesn't sync keeps its choice on this device.
//
// `controller` is app/features.js: it holds the set, applies it, and is
// told about a saved change. The service enforces who may change it.
import { ALWAYS_ON, FEATURES, isFeatureOn, joinLabels, newlyOff, withFeature } from "../features.js";
import { freshConfirmation } from "./household/fresh-confirmation.js";

const json = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.message || "Kin couldn't reach the household service."), { code: value.error, status: response.status });
  return value;
};

class KinHouseholdFeatures extends HTMLElement {
  constructor() {
    super();
    this.controller = null;
    this.draft = null;
    this.busy = false;
    this.generation = 0;
  }

  connectedCallback() {
    if (!this.list) this.build();
    this.render();
  }

  build() {
    this.className = "household-features";
    const heading = document.createElement("h2");
    heading.id = "household-features-title";
    heading.textContent = "Features";
    heading.tabIndex = -1;
    const lead = document.createElement("p");
    lead.className = "section-hint";
    lead.textContent = "Turn off the parts of Kin your household doesn't use. They disappear for everyone in the household. Nothing is deleted: turn one back on and everything in it comes back.";
    const always = document.createElement("p");
    always.className = "section-hint features-always";
    always.textContent = `Always on: ${joinLabels([...ALWAYS_ON])}.`;
    this.who = document.createElement("p");
    this.who.className = "features-who";
    const group = document.createElement("fieldset");
    group.className = "features-group";
    const legend = document.createElement("legend");
    legend.className = "visually-hidden";
    legend.textContent = "Household features";
    this.list = document.createElement("ul");
    this.list.className = "features-list";
    group.append(legend, this.list);
    this.group = group;
    this.save = document.createElement("button");
    this.save.type = "button";
    this.save.className = "primary-action features-save";
    this.save.textContent = "Save features";
    this.save.addEventListener("click", () => void this.submit());
    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback features-feedback";
    this.feedback.setAttribute("role", "status");
    this.feedback.setAttribute("aria-live", "polite");
    this.setAttribute("aria-labelledby", heading.id);
    this.append(heading, lead, always, this.who, group, this.save, this.feedback);
  }

  /** What the controller knows, or everything on before it knows. */
  get value() {
    return this.controller?.value ?? { off: 0, revision: 0, admin: false, local: false, heard: false };
  }

  get editable() {
    const value = this.value;
    return value.admin && (value.local || value.heard);
  }

  /** Redraws from the controller; a draft the admin is making is kept
   * unless the household's set changed underneath it. */
  render() {
    if (!this.list) return;
    const value = this.value;
    if (this.draft && this.draft.revision !== value.revision) this.draft = null;
    const off = this.draft?.off ?? value.off;
    const editable = this.editable;
    this.who.textContent = editable
      ? (value.local ? "Changes apply on this device." : "Saving asks you to confirm it's you.")
      : value.admin
        ? "Connect to the internet to change these."
        : "Only a household admin can change these. Ask a household admin if you'd like something turned on or off.";
    const focused = this.contains(document.activeElement) ? document.activeElement.id : null;
    this.list.replaceChildren(...FEATURES.map((feature) => this.row(feature, off, editable)));
    this.group.disabled = this.busy;
    this.save.hidden = !editable;
    this.save.disabled = this.busy || off === value.off;
    if (focused) document.getElementById(focused)?.focus();
  }

  row(feature, off, editable) {
    const on = isFeatureOn(off, feature.id);
    const item = document.createElement("li");
    item.className = "features-item";
    item.dataset.featureId = feature.id;
    const id = `household-feature-${feature.id}`;
    const description = document.createElement("p");
    description.id = `${id}-description`;
    description.className = "features-description";
    description.textContent = feature.description;
    if (editable) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.className = "features-switch";
      input.setAttribute("role", "switch");
      input.checked = on;
      input.setAttribute("aria-describedby", description.id);
      input.addEventListener("change", () => {
        const value = this.value;
        const base = this.draft?.off ?? value.off;
        this.draft = { revision: value.revision, off: withFeature(base, feature.id, input.checked) };
        this.feedback.textContent = "";
        this.render();
      });
      const label = document.createElement("label");
      label.htmlFor = id;
      label.className = "features-name";
      label.textContent = feature.label;
      item.append(input, label, description);
    } else {
      const name = document.createElement("p");
      name.className = "features-name";
      name.id = id;
      const label = document.createElement("strong");
      label.textContent = feature.label;
      const state = document.createElement("span");
      state.className = "features-state";
      state.textContent = on ? "On" : "Off";
      name.append(label, " — ", state);
      item.append(name, description);
    }
    return item;
  }

  /** Saves the draft: through the service with a fresh confirmation, or on
   * this device for a household that doesn't sync. */
  async submit() {
    const value = this.value;
    if (this.busy || !this.draft || !this.editable) return;
    const change = { off: this.draft.off, expectedRevision: value.revision };
    const generation = ++this.generation;
    this.busy = true;
    this.render();
    try {
      if (value.local) {
        this.controller.changed({ off: change.off, revision: value.revision + 1 });
      } else {
        this.feedback.textContent = "Confirm the change when Kin asks.";
        const started = await json("/api/household/features/options", { method: "POST", body: JSON.stringify(change) });
        const proof = await freshConfirmation(started);
        const result = await json("/api/household/features/finish", { method: "POST", body: JSON.stringify({ flow: started.flow, ...proof }) });
        if (generation !== this.generation) return;
        this.controller.changed({ off: result.off, revision: result.revision });
      }
      this.draft = null;
      const gone = newlyOff(value.off, change.off);
      this.feedback.textContent = value.local
        ? "Features saved."
        : `Features saved. ${gone.length ? "Everyone's devices hide them the next time they connect." : "Everyone's devices show them the next time they connect."}`;
    } catch (error) {
      if (generation !== this.generation) return;
      if (error?.name === "NotAllowedError") this.feedback.textContent = "Canceled. Nothing changed.";
      else if (error?.code === "features_stale") {
        this.draft = null;
        this.feedback.textContent = "Someone changed these on another device. Kin shows the latest; check and save again.";
        await this.reload();
      } else this.feedback.textContent = error?.message || "Kin couldn't save that.";
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
        if (this.save.disabled && !this.contains(document.activeElement)) this.list.querySelector("input")?.focus();
      }
    }
  }

  /** Reads the household's current set from the service. */
  async reload() {
    try {
      const status = await json("/api/sync/status");
      if (status.features) this.controller?.receive(status.features);
    } catch { /* keeps what it shows */ }
  }

  /** On lock: drop any draft. */
  reset() {
    this.generation += 1;
    this.draft = null;
    this.busy = false;
    this.render();
  }
}

if (!customElements.get("kin-household-features")) customElements.define("kin-household-features", KinHouseholdFeatures);
