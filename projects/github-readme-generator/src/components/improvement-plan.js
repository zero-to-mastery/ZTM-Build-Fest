import { html as h } from "../markdown/serialize.js";
import { planBands } from "../repository-audit/improvement-plan.js";

const labels = {
  improve: "Improve README",
  open: "Open in Studio",
  skip: "Skip",
  dismiss: "Dismiss for this README revision",
  minimal: "Mark intentionally minimal",
};
let instances = 0;

// Renders one Improvement plan. Data arrives by property; decisions bubble as
// `plan-action` events ({action, id, repository, focus}) and the parent owns
// state, status messages and calls focusAfter(focus) once it has redrawn.
export class ImprovementPlan extends HTMLElement {
  constructor() {
    super();
    this.uid = `plan-${++instances}`;
    this._plan = null;
    this._busy = false;
    this.readmeUrl = "";
    this.minimalUnavailable = false;
  }
  connectedCallback() {
    if (this.details) return;
    this.innerHTML = `<details><summary></summary><div data-plan-body></div></details>`;
    this.details = this.querySelector("details");
    this.body = this.querySelector("[data-plan-body]");
    // The body is rendered only when opened, so long result pages stay light.
    this.details.addEventListener("toggle", () => {
      if (this.details.open && !this.rendered) this.render();
    });
    this.body.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-plan-action]");
      if (!button || button.disabled) return;
      const { planAction: action, id, index } = button.dataset;
      this.dispatchEvent(
        new CustomEvent("plan-action", {
          bubbles: true,
          detail: {
            action,
            id,
            repository: this._plan?.repository || "",
            revision: this._plan?.revision || "",
            focus: action === "restore" ? { id } : { index: Number(index) },
          },
        }),
      );
    });
    this.summary();
  }
  get plan() {
    return this._plan;
  }
  set plan(value) {
    this._plan = value;
    this.rendered = false;
    if (!this.details) return;
    this.summary();
    if (this.details.open) this.render();
  }
  get open() {
    return !!this.details?.open;
  }
  set open(value) {
    if (!this.details) return;
    this.details.open = !!value;
    if (value && !this.rendered) this.render();
  }
  set busy(value) {
    this._busy = !!value;
    this.applyDisabled();
  }
  summary() {
    const plan = this._plan,
      count = plan?.recommendations.length;
    this.querySelector("summary").textContent = plan
      ? `Improvement plan · ${count} ${count === 1 ? "recommendation" : "recommendations"}`
      : "Improvement plan · not assessed";
  }
  button(action, rec, index) {
    const titled = `aria-describedby="${this.uid}-${index}"`;
    if (action === "github")
      return this.readmeUrl
        ? `<a href="${h(this.readmeUrl)}" target="_blank" rel="noopener noreferrer" ${titled}>Open README on GitHub</a>`
        : "";
    if (action === "minimal" && rec.minimal) return "";
    return `<button type="button" data-plan-action="${action}" data-id="${h(rec.id)}" data-index="${index}" ${titled}>${h(rec.stale && action === "dismiss" ? "Dismiss again" : labels[action])}</button>`;
  }
  render() {
    this.rendered = true;
    const plan = this._plan;
    if (!plan) {
      this.body.innerHTML =
        "<p>Not assessed - audit this repository to build a plan.</p>";
      return;
    }
    const at = Number.isFinite(plan.observedAt)
      ? new Date(plan.observedAt)
      : null;
    const revision =
      plan.revision === "missing-root"
        ? "the confirmed absence of a root README"
        : plan.revision
          ? `README revision ${plan.revision.slice(4, 11)}`
          : "an unknown README revision";
    const recs = plan.recommendations,
      hidden = plan.hidden;
    let index = -1;
    const items = planBands
      .map(([band, label]) => {
        const inBand = recs.filter((rec) => rec.band === band);
        if (!inBand.length) return "";
        return `<h4>${label}</h4><ol class="plan-items">${inBand
          .map((rec) => {
            index++;
            const needsRevision =
              !plan.revision &&
              rec.actions.some((a) => a === "dismiss" || a === "minimal");
            return `<li data-rec="${index}" data-id="${h(rec.id)}"><p class="plan-title" id="${this.uid}-${index}"><strong>${h(rec.title)}</strong></p>${rec.stale ? "<p>Dismissed for an earlier README revision; the README has changed, so the dismissal is not applied.</p>" : ""}${rec.unverified ? "<p>Dismissed earlier, but this audit has no README revision to compare, so the dismissal is not applied.</p>" : ""}${rec.minimal ? "<p>Marked intentionally minimal for this README revision.</p>" : ""}<p>Evidence</p><ul>${rec.evidence.map((line) => `<li>${h(line)}</li>`).join("")}</ul>${rec.consider?.length ? `<p>Sections to consider when writing it: ${h(rec.consider.join(", "))}.</p>` : ""}<p>Applicability: ${h(rec.applicability)}</p><div class="plan-actions">${rec.actions.map((action) => this.button(action, rec, index)).join("")}${rec.stale || rec.unverified ? `<button type="button" data-plan-action="restore" data-id="${h(rec.id)}" aria-describedby="${this.uid}-${index}">Forget earlier dismissal</button>` : ""}</div>${needsRevision ? "<p>Refresh the audit to obtain a README revision.</p>" : ""}</li>`;
          })
          .join("")}</ol>`;
      })
      .join("");
    const restorable = (title, list) =>
      list.length
        ? `<h4>${title} (${list.length})</h4><ul class="plan-hidden">${list.map((rec) => `<li data-id="${h(rec.id)}">${h(rec.title)} <button type="button" data-plan-action="restore" data-id="${h(rec.id)}" aria-label="Restore ${h(rec.title)}">Restore</button></li>`).join("")}</ul>`
        : "";
    const anyHidden = hidden.skipped.length + hidden.dismissed.length;
    this.body.innerHTML = `<p class="hint">Based on ${h(revision)} read ${at ? `<time datetime="${at.toISOString()}">${h(at.toLocaleString())}</time>` : "at an unknown time"}. Recommendations are advisory; nothing is changed until you open a reviewed flow.</p>${plan.caveats.length ? `<ul class="plan-caveats">${plan.caveats.map((c) => `<li>${h(c)}</li>`).join("")}</ul>` : ""}${
      recs.length
        ? items
        : anyHidden
          ? "<p>All recommendations are skipped or dismissed.</p>"
          : "<p>No recommendations from the current evidence. This is not a quality verdict.</p>"
    }${plan.omitted ? `<p>${plan.omitted} more not shown; plans list at most 30 recommendations.</p>` : ""}${restorable("Skipped", hidden.skipped)}${restorable("Dismissed for this README revision", hidden.dismissed)}`;
    this.applyDisabled();
  }
  applyDisabled() {
    if (!this.body) return;
    for (const button of this.body.querySelectorAll("button")) {
      const action = button.dataset.planAction;
      button.disabled =
        this._busy ||
        ((action === "dismiss" || action === "minimal") &&
          !this._plan?.revision) ||
        (action === "minimal" && this.minimalUnavailable);
    }
  }
  // Moves focus to the recommendation now at `index` (the next one after a
  // Skip or Dismiss), the restored recommendation, or else the summary.
  focusAfter(focus = {}) {
    this.open = true;
    const target =
      focus.id !== undefined
        ? this.body.querySelector(
            `li[data-rec][data-id="${CSS.escape(focus.id)}"]`,
          )
        : this.body.querySelector(`li[data-rec="${focus.index}"]`);
    (
      target?.querySelector("button:not(:disabled), a") ||
      this.querySelector("summary")
    ).focus();
  }
}
customElements.define("improvement-plan", ImprovementPlan);
