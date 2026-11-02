import { html } from "../markdown/serialize.js";
import { fillSourceDiff, sourceDiffMarkup } from "../components/source-diff.js";
import {
  audienceReview,
  firstVisitChecklist,
  planSectionOrder,
} from "./review.js";

const statusLabel = (status) =>
  ({
    observed: "Observed",
    "not-detected": "Not detected",
    unknown: "Unknown",
  })[status];

const findings = (items) =>
  `<ul class="audience-findings">${items
    .map(
      (item) =>
        `<li data-audience-result="${item.status}"><strong>${html(item.label)} — ${statusLabel(item.status)}</strong><p>${html(item.evidence)}</p></li>`,
    )
    .join("")}</ul>`;

export function openAudienceReview(app) {
  const draft = app.store.draft;
  const source = draft.markdown;
  const snapshot = JSON.stringify(draft);
  app.modal(`<h1>Audience review</h1>
    <p>Review the current README from one reader's perspective. Results use populated heading evidence only: they are advisory, not scores or proof of completeness.</p>
    <div class="audience-controls"><label>Reader perspective<select data-audience-persona><option value="user">End user</option><option value="recruiter">Recruiter</option><option value="contributor">Contributor</option><option value="maintainer">Maintainer</option></select></label><label>Project type<select data-audience-type><option value="game">Game</option><option value="cli">CLI</option><option value="library">Library</option><option value="api">API</option></select></label></div>
    <section aria-labelledby="audience-perspective-title"><h2 id="audience-perspective-title">Reader perspective</h2><div data-audience-perspective></div></section>
    <section aria-labelledby="audience-first-title"><h2 id="audience-first-title">First-visit checklist</h2><div data-audience-first></div></section>
    <section aria-labelledby="audience-order-title"><h2 id="audience-order-title">Information hierarchy</h2><div data-audience-order></div><div data-audience-diff hidden>${sourceDiffMarkup({ beforeLabel: "Current README", afterLabel: "Proposed section order", label: "Section order diff" })}<label class="check"><input type="checkbox" data-audience-approve> I reviewed and approve this exact section order</label><button class="primary" data-audience-apply disabled>Apply reviewed section order</button></div></section>
    <p data-audience-status role="status">Analysis is local and read-only. Nothing has changed or been published.</p>`);

  const persona = app.querySelector("[data-audience-persona]");
  const type = app.querySelector("[data-audience-type]");
  const perspective = app.querySelector("[data-audience-perspective]");
  const first = app.querySelector("[data-audience-first]");
  const order = app.querySelector("[data-audience-order]");
  const diff = app.querySelector("[data-audience-diff]");
  const approve = app.querySelector("[data-audience-approve]");
  const apply = app.querySelector("[data-audience-apply]");
  const status = app.querySelector("[data-audience-status]");
  let plan;

  const render = () => {
    try {
      const review = audienceReview(source, persona.value);
      const visit = firstVisitChecklist(source, type.value);
      plan = planSectionOrder(source, persona.value);
      perspective.innerHTML = `${findings(review.checks)}<p class="hint">${html(review.caveat)}</p>`;
      first.innerHTML = `${findings(visit.items)}<p class="hint">${html(visit.caveat)}</p>`;
      order.innerHTML = `<p>${html(plan.reason)}</p>${plan.safe ? `<p><strong>Proposed H2 order:</strong> ${plan.headings.map(html).join(" → ")}</p>` : ""}`;
      approve.checked = false;
      apply.disabled = true;
      diff.hidden = !(plan.safe && plan.changed);
      if (!diff.hidden) fillSourceDiff(diff, source, plan.markdown);
      status.textContent =
        plan.safe && plan.changed
          ? "Review the exact diff before approval. Your source is still unchanged."
          : "Analysis complete. Your source is unchanged.";
    } catch {
      plan = null;
      diff.hidden = true;
      perspective.textContent = "This perspective could not be analyzed.";
      first.textContent = "This checklist could not be analyzed.";
      order.textContent = "No section order is available.";
      status.textContent = "Analysis failed. Your source is unchanged.";
    }
  };
  persona.addEventListener("change", render);
  type.addEventListener("change", render);
  approve.addEventListener("change", () => {
    apply.disabled = !approve.checked;
  });
  apply.addEventListener("click", () => {
    if (!approve.checked || !plan?.safe || !plan.changed) return;
    app.dispatchEvent(
      new CustomEvent("audience-order-apply", {
        detail: { snapshot, source, markdown: plan.markdown },
      }),
    );
  });
  render();
  persona.focus();
}
