import { html } from "../markdown/serialize.js";
import { findDocument } from "../workspace/documents.js";
import { reviewBatchRecovery } from "../workspace/batch-review.js";

const recoveryLabel = {
  current: "Matches last opened source",
  changed: "Changed since last opened",
  missing: "Opened document is missing",
  "target-changed": "Document target changed",
  "not-opened": "Not yet opened",
};

export class BatchReview extends HTMLElement {
  disconnectedCallback() {
    this.controller?.abort();
  }
  configure(data) {
    const batch = data.reviewBatch;
    const recovery = batch ? reviewBatchRecovery(batch, data.drafts) : null;
    this.innerHTML = `<h1>Batch review</h1><p>Review locally, one README at a time. Marking reviewed does not claim the remote README is resolved or published. Existing local edits are preserved.</p>${batch ? `<h2>Recovery review</h2><p>This local freshness check does not fetch or publish anything. Reopen changed or missing items before marking them reviewed.</p><p>${batch.journal.length} bounded progress event(s) retained.</p><p>${batch.items.map((item, index) => `${html(item.repository)}: ${recoveryLabel[recovery.items[index].status]}`).join(" · ")}</p><p>${batch.items.filter((item) => item.state === "pending").length} READMEs pending · ${batch.items.filter((item) => item.state === "reviewed").length} reviewed locally · ${batch.items.filter((item) => item.state === "skipped").length} skipped</p><button data-next>Improve next</button><button data-resolve>Mark reviewed &amp; improve next</button><button data-skip>Skip current &amp; improve next</button><ol>${batch.items.map((item, index) => `<li><label class="check"><input type="checkbox" data-include value="${index}"> Include ${html(item.repository)}</label><p>${html(item.branch)} · ${html(item.path)} · ${item.state}${index === batch.current ? " · Current" : ""}${findDocument(data.drafts, item) ? " · Open in workspace" : ""}</p><button data-open="${index}">Open ${html(item.repository)}</button>${item.state !== "pending" ? `<button data-return="${index}">Return ${html(item.repository)} to pending</button>` : ""}</li>`).join("")}</ol><p>Optional common section: selected READMEs are opened locally, one request at a time if needed. Then edit a shared Contributing section and review every resulting diff. This does not publish anything.</p><button data-common>Prepare common section for selected repositories</button><button data-end>End review batch</button>` : "<p>No active batch. Open README Attention Queue, audit repositories and choose Improve next to start.</p>"}<p data-status role="status"></p><button data-cancel hidden>Cancel opening repositories</button>`;
    if (!batch) return;
    for (const [selector, action] of [
      ["next", "next"],
      ["resolve", "reviewed"],
      ["skip", "skipped"],
      ["end", "end"],
    ])
      this.querySelector(`[data-${selector}]`).onclick = () =>
        this.send(action);
    this.querySelectorAll("[data-open]").forEach(
      (button) =>
        (button.onclick = () => this.send("open", Number(button.dataset.open))),
    );
    this.querySelectorAll("[data-return]").forEach(
      (button) =>
        (button.onclick = () =>
          this.send("pending", Number(button.dataset.return))),
    );
    this.querySelector("[data-common]").onclick = () =>
      this.send(
        "common",
        [...this.querySelectorAll("[data-include]:checked")].map((input) =>
          Number(input.value),
        ),
      );
    this.querySelector("[data-cancel]").onclick = () =>
      this.controller?.abort();
  }
  send(action, value) {
    this.dispatchEvent(
      new CustomEvent("batch-action", {
        bubbles: true,
        detail: { action, value },
      }),
    );
  }
  status(message) {
    this.querySelector("[data-status]").textContent = message;
  }
  busy(value) {
    this.querySelectorAll("button,input").forEach(
      (el) => (el.disabled = value),
    );
    const cancel = this.querySelector("[data-cancel]");
    cancel.hidden = !value;
    cancel.disabled = false;
  }
}
customElements.define("batch-review", BatchReview);
