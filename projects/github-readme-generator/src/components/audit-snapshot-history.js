import { html as h } from "../markdown/serialize.js";
import {
  AUDIT_SNAPSHOTS_KEY,
  AuditSnapshots,
  compareAuditSnapshots,
  createAuditSnapshot,
} from "../repository-audit/audit-snapshots.js";
import { findingTitle } from "../repository-audit/improvement-plan.js";

const date = (value) => new Date(value).toISOString();

export class AuditSnapshotHistory extends HTMLElement {
  connectedCallback() {
    this.snapshots = new AuditSnapshots();
    this.innerHTML = `<section><h2 tabindex="-1">Audit snapshot history</h2><p>Optionally copy the audit results already on screen into bounded local history. Capturing does not fetch, re-audit, monitor, or schedule anything. README source, evidence prose, and your audit decisions are not saved.</p><button type="button" data-capture>Capture current audit results</button><p data-snapshot-status role="status" aria-live="polite"></p><div data-storage></div><div data-history></div><div data-compare></div><div data-diff></div></section>`;
    this.querySelector("[data-capture]").onclick = () => this.capture();
    this.onStorage = (event) => {
      if (event.key === null || event.key === AUDIT_SNAPSHOTS_KEY) {
        this.clearComparison();
        this.snapshots.read();
        this.draw();
      }
    };
    window.addEventListener("storage", this.onStorage);
    this.draw();
  }

  disconnectedCallback() {
    window.removeEventListener("storage", this.onStorage);
  }

  setData(state, busy) {
    this.state = state;
    this.busy = busy;
    if (this.isConnected) this.draw();
  }

  status(message) {
    this.querySelector("[data-snapshot-status]").textContent = message;
  }

  accountItems() {
    const account = this.state?.username?.toLowerCase();
    return this.snapshots.items
      .filter((item) => item.account === account)
      .sort((a, b) => a.capturedAt - b.capturedAt);
  }

  fingerprint(items) {
    return items.map((item) => item.id).join("|");
  }

  clearComparison() {
    this.renderedFingerprint = "";
    const target = this.querySelector("[data-diff]");
    if (target) target.innerHTML = "";
  }

  capture() {
    const records = [...(this.state?.results?.values() || [])].filter(
      (record) => record.result,
    );
    if (!this.state?.username || !records.length) {
      this.status("Audit at least one repository before capturing a snapshot.");
      return;
    }
    try {
      const result = this.snapshots.save(
        createAuditSnapshot({
          account: this.state.username,
          records,
          typeOverrides: this.state.typeOverrides,
          capturedAt: Math.max(
            Date.now(),
            ...(this.accountItems().map((item) => item.capturedAt + 1) || []),
          ),
        }),
      );
      this.draw();
      this.status(
        `Captured ${result.snapshot.repositories.length} audit results locally.${result.evicted ? " Replaced this account’s oldest snapshot to keep the five-snapshot limit." : ""}`,
      );
    } catch (error) {
      this.status(error.message);
      this.draw();
    }
  }

  draw() {
    if (!this.querySelector("[data-capture]")) return;
    const records = [...(this.state?.results?.values() || [])].filter(
      (record) => record.result,
    );
    this.querySelector("[data-capture]").disabled =
      !!this.busy ||
      !this.state?.username ||
      !records.length ||
      !!this.snapshots.error;
    this.storageNotice();
    const items = this.accountItems();
    const history = this.querySelector("[data-history]");
    history.innerHTML = items.length
      ? `<h3>Saved captures for ${h(this.state.username)}</h3><ol>${items
          .map(
            (item) =>
              `<li>${h(date(item.capturedAt))} · ${item.repositories.length} repositories <button type="button" data-delete="${h(item.id)}" aria-label="Delete audit snapshot from ${h(date(item.capturedAt))}">Delete</button></li>`,
          )
          .join("")}</ol>`
      : `<p>No audit snapshots are saved for this account.</p>`;
    const deleteButtons = [...history.querySelectorAll("[data-delete]")];
    deleteButtons.forEach((button, index) => {
      button.disabled = !!this.busy;
      button.onclick = () => {
        try {
          this.snapshots.remove(button.dataset.delete);
          this.draw();
          const remaining = [
            ...this.querySelectorAll("[data-history] [data-delete]"),
          ];
          (
            remaining[Math.min(index, remaining.length - 1)] ||
            this.querySelector("h2")
          )?.focus();
          this.status(
            "Audit snapshot deleted. Current audit results are unchanged.",
          );
        } catch (error) {
          this.status(error.message);
        }
      };
    });
    this.drawComparison(items);
  }

  drawComparison(items) {
    const target = this.querySelector("[data-compare]");
    const fingerprint = this.fingerprint(items);
    if (this.renderedFingerprint && this.renderedFingerprint !== fingerprint)
      this.clearComparison();
    if (items.length < 2) {
      target.innerHTML =
        "<p>Capture this account at least twice to compare explicit observations over time.</p>";
      this.clearComparison();
      return;
    }
    const options = items
      .map(
        (item) =>
          `<option value="${h(item.id)}">${h(date(item.capturedAt))} · ${item.repositories.length} repositories</option>`,
      )
      .join("");
    target.innerHTML = `<h3>Compare captures</h3><label>Earlier capture<select data-before>${options}</select></label><label>Later capture<select data-after>${options}</select></label><button type="button" data-run>Compare snapshots</button>`;
    target.querySelector("[data-after]").selectedIndex = items.length - 1;
    target.querySelector("[data-run]").onclick = () => this.compare();
  }

  compare() {
    const before = this.snapshots.items.find(
      (item) => item.id === this.querySelector("[data-before]").value,
    );
    const after = this.snapshots.items.find(
      (item) => item.id === this.querySelector("[data-after]").value,
    );
    if (!before || !after || before.capturedAt >= after.capturedAt) {
      this.status("Choose an earlier capture and a later capture.");
      return;
    }
    const result = compareAuditSnapshots(before, after);
    const list = (heading, items, detail) =>
      `<section><h3>${heading} (${items.length})</h3>${
        items.length
          ? `<ul>${items.map((item) => `<li><strong>${h(item.repository)}</strong> · ${h(detail(item))}</li>`).join("")}</ul>`
          : "<p>None.</p>"
      }</section>`;
    this.querySelector("[data-diff]").innerHTML =
      `<p>Compared two saved observations. This is not live monitoring; Unknown means the evidence was not safely comparable.</p>${list("Added", result.added, (item) => findingTitle(item.id))}${list("Resolved", result.resolved, (item) => findingTitle(item.id))}${list("Unknown", result.unknown, (item) => `${item.id ? `${findingTitle(item.id)} · ` : ""}${item.reason}`)}`;
    this.renderedFingerprint = this.fingerprint(this.accountItems());
    this.status("Audit snapshot comparison complete.");
  }

  storageNotice() {
    const target = this.querySelector("[data-storage]");
    if (!this.snapshots.error) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = `<p role="alert">${h(this.snapshots.error)}</p>${this.snapshots.raw !== null ? '<button type="button" data-recovery>Download audit snapshot recovery data</button>' : ""}<label><input type="checkbox" data-confirm-reset> I want to discard only the damaged audit snapshots</label><button type="button" data-reset>Start fresh with audit snapshots</button>`;
    target.querySelector("[data-recovery]")?.addEventListener("click", () =>
      this.dispatchEvent(
        new CustomEvent("attention-download", {
          bubbles: true,
          detail: {
            content: this.snapshots.raw,
            name: "readme-audit-snapshots-recovery.json",
            type: "application/json",
          },
        }),
      ),
    );
    target.querySelector("[data-reset]").onclick = () => {
      if (!target.querySelector("[data-confirm-reset]").checked) {
        this.status("Confirm starting fresh with audit snapshots first.");
        return;
      }
      try {
        this.snapshots.reset();
        this.draw();
        this.querySelector("h2").focus();
        this.status(
          "Damaged audit snapshots reset. Current results and drafts are unchanged.",
        );
      } catch (error) {
        this.status(error.message);
      }
    };
  }
}

customElements.define("audit-snapshot-history", AuditSnapshotHistory);
