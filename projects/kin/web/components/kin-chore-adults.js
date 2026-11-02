// Household › Features: "Adults can join the chore chart" (#676, ADR 0022
// §6). Off by default. A household admin turns it on or off with a fresh
// passkey (or password, for an admin without one), like household features;
// everyone else sees it read-only. Even when it's on, each adult chooses to
// join on the chore chart page, and can leave at any time.
//
// `controller` is app/chores.js: it holds the service's value (`setting`),
// and is told about a saved change.
import { freshConfirmation } from "./household/fresh-confirmation.js";

const json = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.message || "Kin couldn't reach the household service."), { code: value.error, status: response.status });
  return value;
};

class KinChoreAdults extends HTMLElement {
  constructor() {
    super();
    this.controller = null;
    this.busy = false;
    this.generation = 0;
  }

  connectedCallback() {
    if (!this.input) this.build();
    this.render();
  }

  build() {
    this.className = "chore-adults today-section";
    this.dataset.feature = "chores";
    const heading = document.createElement("h2");
    heading.id = "chore-adults-title";
    heading.textContent = "Chore chart";
    this.setAttribute("aria-labelledby", heading.id);
    const lead = document.createElement("p");
    lead.className = "section-hint";
    lead.textContent = "Children are on the chore chart. You can let adults join too, so the family can play together. Each adult decides for themselves, and can leave at any time.";
    const row = document.createElement("div");
    row.className = "chore-adults-row";
    this.input = document.createElement("input");
    this.input.type = "checkbox";
    this.input.id = "chore-adults-switch";
    this.input.setAttribute("role", "switch");
    this.input.addEventListener("change", () => void this.submit());
    this.label = document.createElement("label");
    this.label.htmlFor = this.input.id;
    this.label.textContent = "Adults can join the chore chart";
    row.append(this.input, this.label);
    this.state = document.createElement("p");
    this.state.className = "chore-adults-state";
    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback";
    this.feedback.setAttribute("role", "status");
    this.feedback.setAttribute("aria-live", "polite");
    this.append(heading, lead, row, this.state, this.feedback);
  }

  get value() {
    return this.controller?.setting ?? { adults: false, revision: 0, admin: false, heard: false, local: false };
  }

  render() {
    if (!this.input) return;
    const value = this.value;
    // A household that doesn't sync has one person, who is on the chart if
    // they join: nothing to allow.
    this.hidden = value.local;
    const editable = value.admin && value.heard;
    this.input.checked = value.adults;
    this.input.disabled = this.busy || !editable;
    this.input.hidden = !editable;
    this.label.hidden = !editable;
    this.state.hidden = editable;
    this.state.textContent = value.admin
      ? "Connect to the internet to change this."
      : `Adults ${value.adults ? "can" : "can't"} join the chore chart. Only a household admin can change this.`;
  }

  async submit() {
    const value = this.value;
    if (this.busy || !value.admin) return;
    const change = { adults: this.input.checked, expectedRevision: value.revision };
    const generation = ++this.generation;
    this.busy = true;
    this.render();
    this.input.checked = change.adults;
    try {
      this.feedback.textContent = "Confirm the change when Kin asks.";
      const started = await json("/api/household/chore-chart/options", { method: "POST", body: JSON.stringify(change) });
      const proof = await freshConfirmation(started);
      const result = await json("/api/household/chore-chart/finish", { method: "POST", body: JSON.stringify({ flow: started.flow, ...proof }) });
      if (generation !== this.generation) return;
      this.controller?.receiveSetting({ ...value, adults: result.adults, revision: result.revision });
      this.feedback.textContent = result.adults
        ? "Saved. Adults can now choose to join the chore chart."
        : "Saved. Adults are no longer on the chore chart.";
    } catch (error) {
      if (generation !== this.generation) return;
      if (error?.name === "NotAllowedError") this.feedback.textContent = "Canceled. Nothing changed.";
      else if (error?.code === "chore_chart_stale") this.feedback.textContent = "Someone changed this on another device. Kin shows the latest; check and try again.";
      else this.feedback.textContent = error?.message || "Kin couldn't save that.";
      if (error?.code === "chore_chart_stale") await this.controller?.reloadSetting?.();
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }

  reset() {
    this.generation += 1;
    this.busy = false;
    if (this.feedback) this.feedback.textContent = "";
    this.render();
  }
}

if (!customElements.get("kin-chore-adults")) customElements.define("kin-chore-adults", KinChoreAdults);
