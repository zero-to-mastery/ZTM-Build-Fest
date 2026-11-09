import { html as h } from "../markdown/serialize.js";
import { duplicateAlternatives } from "../writing/alternatives.js";
export class WritingComparison extends HTMLElement {
  show(items = [], busy = false) {
    this.items = structuredClone(items);
    this.hidden = !items.length;
    this.innerHTML = items.length
      ? `<h2 tabindex="-1">Compare alternatives</h2><p>Each version uses the same Original, notes and selected context. Choose one to copy into Proposed, then edit and review the diff. Choosing does not change the README.</p>${duplicateAlternatives(items) ? '<p role="status">The provider returned identical alternatives. You can edit Proposed or explicitly generate again.</p>' : ""}<div class="writing-comparison-grid">${items.map((item, i) => `<section><h3>${h(item.label)}</h3><p>${h(item.status)}${item.error ? `: ${h(item.error)}` : ""}</p><label>${h(item.label)} alternative<textarea data-alternative="${i}" rows="12" readonly></textarea></label><button data-use="${i}" ${busy || item.status !== "ready" ? "disabled" : ""}>Use ${h(item.label)}</button></section>`).join("")}</div>`
      : "";
    this.querySelectorAll("[data-alternative]").forEach((el) => {
      el.value = items[Number(el.dataset.alternative)].text || "";
    });
    this.querySelectorAll("[data-use]").forEach((el) => {
      el.onclick = () => {
        const item = this.items[Number(el.dataset.use)];
        if (busy || item.status !== "ready") return;
        this.dispatchEvent(
          new CustomEvent("writing-alternative", {
            bubbles: true,
            detail: item.text,
          }),
        );
      };
    });
  }
}
customElements.define("writing-comparison", WritingComparison);
