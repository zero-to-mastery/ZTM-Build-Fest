import "./improvement-plan.js";
import { html as h } from "../markdown/serialize.js";
import { projectTypes } from "../repository-audit/project-types.js";
import {
  attentionQueue,
  filterAttention,
  readmeRevision,
} from "../repository-audit/attention.js";
import {
  improvementPlanForRecord,
  planDecision,
} from "../repository-audit/improvement-plan.js";
import { readmeUrl } from "../repository-audit/presentation.js";
import {
  ATTENTION_KEY,
  rememberAttentionPreference,
} from "../repository-audit/attention-storage.js";
import {
  AUDIT_DECISIONS_KEY,
  AuditDecisions,
  applyAuditDecisions,
} from "../repository-audit/audit-decisions-storage.js";

export class ReadmeAttentionQueue extends HTMLElement {
  connectedCallback() {
    this.preferences ||= new AuditDecisions();
    this.page = 0;
    this.innerHTML = `<h2 tabindex="-1">README Attention Queue</h2><p>Choose the next README to improve using descriptive signals, not a quality score. Load repositories and audit selected READMEs above first. Only successful assessments enter this queue.</p><p class="hint">High: recently active with missing or thin documentation. Medium: documentation needs attention or commonly useful project-type topics were not detected. Low: archived or no push in over 180 days. Within a tier: active first, README state, public-interest signals, then recent push and repository name. Pinned status and releases are not fetched.</p><div class="attention-filters"><label>Attention priority<select name="priority" aria-label="Attention priority"><option value="all">All priorities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><label><input type="checkbox" name="missing"> Missing only</label><label><input type="checkbox" name="active"> Active only (pushed within 30 days)</label><label>Archived repositories<select name="archived" aria-label="Archived repositories"><option value="exclude">Exclude archived</option><option value="include">Include archived</option><option value="only">Archived only</option></select></label><label>Queue language<select name="language" aria-label="Queue language"><option value="all">All languages</option></select></label><label>Queue project type<select name="type" aria-label="Queue project type"><option value="all">All project types</option>${projectTypes.map((t) => `<option value="${t.id}">${h(t.name)}</option>`).join("")}</select></label><label>Minimum stars<input name="stars" aria-label="Minimum stars" type="number" min="0" max="1000000000" step="1" value="0"></label><label>Pushed recently<select name="pushed" aria-label="Pushed recently"><option value="">Any push date</option><option value="30">Within 30 days</option><option value="90">Within 90 days</option><option value="180">Within 180 days</option><option value="365">Within 365 days</option></select></label><label>Queue visibility<select name="deferred" aria-label="Queue visibility"><option value="">Active queue</option><option value="only">Deferred items</option><option value="all">All attention items</option></select></label><button data-reset-filters>Reset queue filters</button></div><p class="hint">Filters combine. Archived/forked repositories must have been included in an audit to have evidence. “Ignore for now” lasts seven days. “Intentionally minimal” lasts until a newly fetched README revision differs. Improve next starts a local review batch from the current filtered, non-deferred queue (up to 200). Opening or reviewing a draft does not mark its remote README complete.</p><div data-storage></div><p data-queue-status role="status" aria-live="polite"></p><p data-queue-count></p><button data-improve-next>Improve next</button><ol class="attention-items" data-items></ol><div class="audit-pagination"><button data-previous>Previous queue page</button><span data-queue-page></span><button data-next>Next queue page</button></div>`;
    this.querySelectorAll(
      ".attention-filters input, .attention-filters select",
    ).forEach((input) =>
      input.addEventListener("change", () => {
        if (!input.checkValidity()) {
          this.status("Enter a whole, nonnegative minimum star count.");
          return;
        }
        this.page = 0;
        this.draw();
        this.status(`${this.filtered.length} matching attention items.`);
      }),
    );
    this.querySelector("[data-reset-filters]").onclick = () => {
      for (const input of this.querySelectorAll(
        ".attention-filters input, .attention-filters select",
      )) {
        if (input.type === "checkbox") input.checked = false;
        else if (input.tagName === "SELECT") input.selectedIndex = 0;
        else input.value = "0";
      }
      this.page = 0;
      this.draw();
      this.status("Queue filters reset.");
    };
    this.querySelector("[data-improve-next]").onclick = () => {
      if (this.busy) return;
      const repositories = this.filtered
        .filter((item) => !item.suppressed)
        .map((item) => item.repo);
      if (repositories.length > 200) {
        this.status(
          "Narrow queue filters to at most 200 repositories for one review batch.",
        );
        return;
      }
      this.dispatchEvent(
        new CustomEvent("batch-review-start", {
          bubbles: true,
          detail: repositories,
        }),
      );
    };
    this.querySelector("[data-previous]").onclick = () => {
      this.page--;
      this.draw();
      this.querySelector("[data-items]").firstElementChild?.focus();
    };
    this.querySelector("[data-next]").onclick = () => {
      this.page++;
      this.draw();
      this.querySelector("[data-items]").firstElementChild?.focus();
    };
    this.onStorage = (event) => {
      if (
        event.key === ATTENTION_KEY ||
        event.key === AUDIT_DECISIONS_KEY ||
        event.key === null
      ) {
        this.preferences.read();
        this.draw();
        this.changed();
      }
    };
    window.addEventListener("storage", this.onStorage);
    this.addEventListener("plan-action", (event) => {
      event.stopPropagation(); // The queue owns decisions made in its plans.
      this.planAction(event.detail);
    });
    this.draw();
  }
  disconnectedCallback() {
    window.removeEventListener("storage", this.onStorage);
  }
  status(message) {
    this.querySelector("[data-queue-status]").textContent = message;
  }
  setData(state, busy, preferences) {
    this.state = state;
    this.busy = busy;
    if (preferences) this.preferences = preferences;
    if (!this.preferences) return;
    const language = this.querySelector("[name=language]");
    const selected = language.value;
    const languages = [
      ...new Set(
        state.repositories.map((repo) => repo.language || "Unspecified"),
      ),
    ].sort();
    language.innerHTML = `<option value="all">All languages</option>${languages.map((name) => `<option value="${h(name)}">${h(name)}</option>`).join("")}`;
    language.value = languages.includes(selected) ? selected : "all";
    this.draw();
  }
  filters() {
    return Object.fromEntries(
      [...this.querySelectorAll(".attention-filters [name]")].map((el) => [
        el.name,
        el.type === "checkbox" ? el.checked : el.value,
      ]),
    );
  }
  draw() {
    if (!this.preferences) return;
    const records = (this.state?.repositories || [])
      .filter((repo) => this.state.includeForks || !repo.fork)
      .map((repo) => {
        const record = this.state.results.get(repo.full_name);
        return record ? { ...record, repo } : { repo };
      });
    for (const record of records)
      if (record.result)
        applyAuditDecisions(
          this.state,
          this.preferences,
          record.repo.full_name,
        );
    const items = attentionQueue(records, {
      overrides: this.state?.typeOverrides,
      preferences: this.preferences.entries,
      dismissals: this.state?.dismissed,
    });
    const dismissed = records.reduce(
      (sum, record) =>
        record.result &&
        this.state.dismissed?.get(record.repo.full_name.toLowerCase())?.size
          ? sum + this.plan(record).hidden.dismissed.length
          : sum,
      0,
    );
    const open = new Set(
      [...this.querySelectorAll("[data-items] improvement-plan")]
        .filter((plan) => plan.open)
        .map((plan) => plan.plan?.repository),
    );
    this.filtered = filterAttention(items, this.filters());
    const pages = Math.max(1, Math.ceil(this.filtered.length / 25));
    this.page = Math.max(0, Math.min(pages - 1, this.page));
    this.visible = this.filtered.slice(this.page * 25, (this.page + 1) * 25);
    this.querySelector("[data-queue-count]").textContent =
      `${this.filtered.length} matching · ${items.filter((item) => item.suppressed).length} deferred · ${records.filter((record) => !record.result).length} not assessed · ${records.filter((record) => record.result).length - items.length} without current attention signals${dismissed ? ` · ${dismissed} ${dismissed === 1 ? "recommendation" : "recommendations"} dismissed` : ""}`;
    this.querySelector("[data-items]").innerHTML =
      this.visible
        .map(
          (item, index) =>
            `<li tabindex="-1" data-item="${index}"><h3>${h(item.repo.full_name)}</h3><strong>${h(item.priority[0].toUpperCase() + item.priority.slice(1))} attention</strong><ul>${item.reasons.map((reason) => `<li>${h(reason)}</li>`).join("")}</ul><p>${h(item.repo.language || "Language unspecified")} · ${h(item.assessment.type.name)}</p>${item.suppressed ? `<p>${h(item.suppressed)}</p>` : ""}<div class="attention-actions"><button data-improve="${index}">Improve README</button><button data-open="${index}">Open in Studio</button>${item.suppressed ? `<button data-return="${index}">Return to queue</button>` : `<button data-ignore="${index}">Ignore for now</button><button data-minimal="${index}" ${!item.revision ? "disabled" : ""}>Mark intentionally minimal</button>`}</div>${!item.revision ? "<p>README revision unavailable. Refresh the audit before marking it intentionally minimal.</p>" : ""}<improvement-plan data-plan="${index}"></improvement-plan></li>`,
        )
        .join("") ||
      "<li>No matching attention items. Audit repositories above, adjust filters, or review deferred items.</li>";
    this.querySelectorAll("[data-improve]").forEach((button) => {
      button.onclick = () =>
        this.open(this.visible[Number(button.dataset.improve)], true);
    });
    this.querySelectorAll("[data-open]").forEach(
      (button) =>
        (button.onclick = () =>
          this.open(this.visible[Number(button.dataset.open)])),
    );
    for (const [action, kind] of [
      ["ignore", "ignore"],
      ["minimal", "minimal"],
      ["return", null],
    ])
      this.querySelectorAll(`[data-${action}]`).forEach(
        (button) =>
          (button.onclick = () =>
            this.decide(this.visible[Number(button.dataset[action])], kind)),
      );
    this.querySelectorAll("[data-plan]").forEach((element) => {
      const item = this.visible[Number(element.dataset.plan)];
      element.plan = this.plan(item.record);
      element.readmeUrl = readmeUrl(item.repo, item.record.readme);
      if (open.has(item.repo.full_name)) element.open = true;
    });
    this.storageNotice();
    this.querySelectorAll("button,input,select").forEach((el) => {
      el.disabled = !!this.busy;
    });
    this.querySelectorAll("[data-plan]").forEach((element) => {
      element.minimalUnavailable = !!this.preferences.error;
      element.busy = this.busy;
    });
    if (!this.busy) {
      this.querySelectorAll("[data-minimal]").forEach((button) => {
        button.disabled =
          !this.visible[Number(button.dataset.minimal)].revision ||
          !!this.preferences.error;
      });
      this.querySelectorAll("[data-ignore],[data-return]").forEach((button) => {
        button.disabled = !!this.preferences.error;
      });
    }
    this.querySelector("[data-improve-next]").disabled =
      !!this.busy || !this.filtered.some((item) => !item.suppressed);
    this.querySelector("[data-previous]").disabled =
      !!this.busy || this.page === 0;
    this.querySelector("[data-next]").disabled =
      !!this.busy || this.page + 1 >= pages;
    this.querySelector("[data-queue-page]").textContent =
      `Page ${this.page + 1} of ${pages} · 25 items per page`;
  }
  storageNotice() {
    const target = this.querySelector("[data-storage]");
    if (!this.preferences.error) {
      target.innerHTML = "";
      return;
    }
    if (target.childElementCount) return;
    const label =
      this.preferences.source === "legacy"
        ? "legacy attention"
        : "audit decision";
    const confirmation =
      this.preferences.source === "legacy"
        ? "I want to start fresh without changing the damaged legacy attention data"
        : "I want to discard only the damaged audit decisions";
    target.innerHTML = `<p role="alert">${h(this.preferences.error)}</p>${this.preferences.raw !== null ? `<button data-recovery>Download ${label} recovery data</button>` : ""}<label><input type="checkbox" data-confirm-reset> ${confirmation}</label><button data-reset-storage>Start fresh with audit decisions</button>`;
    const download = target.querySelector("[data-recovery]");
    if (download)
      download.onclick = () =>
        this.dispatchEvent(
          new CustomEvent("attention-download", {
            bubbles: true,
            detail: {
              content: this.preferences.raw,
              name:
                this.preferences.source === "legacy"
                  ? "readme-attention-recovery.json"
                  : "readme-audit-decisions-recovery.json",
              type: "application/json",
            },
          }),
        );
    target.querySelector("[data-reset-storage]").onclick = () => {
      if (!target.querySelector("[data-confirm-reset]").checked) {
        this.status("Confirm starting fresh with audit decisions first.");
        return;
      }
      try {
        const legacy = this.preferences.source === "legacy";
        this.preferences.reset();
        this.draw();
        this.changed();
        this.status(
          legacy
            ? "Audit decisions reset. Damaged legacy attention data and drafts are unchanged."
            : "Damaged audit decisions reset. Drafts are unchanged.",
        );
      } catch (error) {
        this.status(error.message);
      }
    };
  }
  // The plan for one queue record, with this session's decisions applied.
  plan(record) {
    return improvementPlanForRecord(record, {
      session: this.state,
      preferences: this.preferences.entries,
      override:
        this.state.typeOverrides?.get(record.repo.full_name.toLowerCase()) ||
        "auto",
    });
  }
  planAction({ action, id, repository, focus }) {
    const item = this.filtered?.find(
      (candidate) => candidate.repo.full_name === repository,
    );
    if (this.busy || !item) return;
    if (action === "improve" || action === "open") {
      this.open(item, action === "improve");
      return;
    }
    if (action === "minimal") {
      this.decide(item, "minimal");
      return;
    }
    let message;
    try {
      const detail = {
        repository,
        id,
        action,
        revision: item.revision,
      };
      if (action === "dismiss")
        this.preferences.setDismissal(repository, id, item.revision);
      else if (
        action === "restore" &&
        this.preferences.dismissals(repository).has(id)
      )
        this.preferences.removeDismissal(repository, id);
      message = planDecision(this.state, detail);
    } catch (error) {
      this.status(error.message);
      return;
    }
    this.draw();
    this.status(message);
    this.changed(repository);
    const plan = [...this.querySelectorAll("[data-plan]")].find(
      (element) => element.plan?.repository === repository,
    );
    // A dismissal can remove the item's last attention reason.
    if (plan) plan.focusAfter(focus);
    else this.querySelector("h2").focus();
  }
  // Tells the audit rows that plans changed: one repository, or every row
  // when attention settings were reread or reset.
  changed(repository = "") {
    this.dispatchEvent(
      new CustomEvent("plan-decision", {
        bubbles: true,
        detail: { repository },
      }),
    );
  }
  decide(item, kind) {
    if (this.busy || !item) return;
    try {
      const message = rememberAttentionPreference(
        this.preferences,
        item.repo.full_name,
        kind,
        item.revision,
      );
      this.draw();
      this.changed(item.repo.full_name);
      this.status(message);
      const next =
        this.querySelector("[data-items] button:not(:disabled)") ||
        this.querySelector("h2");
      next.focus();
    } catch (error) {
      if (this.preferences.error) {
        this.draw();
        this.changed();
      }
      this.status(error.message);
    }
  }
  open(item, builder = false) {
    if (this.busy || !item) return;
    this.dispatchEvent(
      new CustomEvent("attention-open", {
        bubbles: true,
        detail: { repo: item.repo, builder },
      }),
    );
  }
}
customElements.define("readme-attention-queue", ReadmeAttentionQueue);
