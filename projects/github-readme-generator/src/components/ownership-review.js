import { html } from "../markdown/serialize.js";
import { fillSourceDiff, sourceDiffMarkup } from "./source-diff.js";

export class OwnershipReview extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<h1>Ownership review</h1><p>The Markdown changed after this visual version was opened. Nothing changes unless you choose the visual version.</p><h2 data-title></h2>${sourceDiffMarkup({ beforeLabel: "Original — current Markdown", afterLabel: "Proposed — visual version", label: "Ownership source diff" })}<p data-status role="status"></p><div class="row-actions"><button data-keep>Keep my Markdown</button><button data-use class="primary">Use visual version</button></div>`;
    this.querySelector("[data-keep]").onclick = () =>
      this.emit("ownership-keep");
    this.querySelector("[data-use]").onclick = () => this.emit("ownership-use");
  }
  emit(name) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true }));
  }
  configure(review) {
    this.querySelector("[data-title]").textContent = review.label;
    fillSourceDiff(this, review.original, review.proposed);
    this.querySelector("[data-status]").textContent = "";
    this.querySelector("[data-use]").disabled = false;
    this.querySelector("[data-keep]").focus();
  }
  refresh(review, message) {
    this.configure(review);
    this.querySelector("[data-status]").textContent = message;
  }
  fail(message) {
    this.querySelector("[data-status]").innerHTML = html(message);
    this.querySelector("[data-use]").disabled = true;
    this.querySelector("[data-keep]").focus();
  }
}

customElements.define("ownership-review", OwnershipReview);
