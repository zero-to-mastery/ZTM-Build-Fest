import "./stack-results.js";
import {
  stackClient,
  scanStacks,
  NESTED_LIMIT_MESSAGE,
} from "../stack-intelligence/client.js";
import { DISCOVERY_LIMITS } from "../stack-intelligence/discovery.js";
import "./readme-attention-queue.js";
import "./improvement-plan.js";
import "./audit-snapshot-history.js";
import { reviewReadme } from "../repository-audit/review.js";
import { html as h } from "../markdown/serialize.js";
import { githubUsername } from "../state/github-profile.js";
import {
  auditClient,
  auditSession,
  filterRepositories,
  auditRepositories,
} from "../repository-audit/github.js";
import {
  projectTypes,
  assessProjectType,
  suggestProjectType,
} from "../repository-audit/project-types.js";
import { auditAnalyzer } from "../repository-audit/analyzer.js";
import {
  activityStatus,
  readmeUrl,
  repositoryUrl,
} from "../repository-audit/presentation.js";
import {
  improvementPlanForRecord,
  planDecision,
} from "../repository-audit/improvement-plan.js";
import { readmeRevision } from "../repository-audit/attention.js";
import { rememberAttentionPreference } from "../repository-audit/attention-storage.js";
import {
  AuditDecisions,
  applyAuditDecisions,
} from "../repository-audit/audit-decisions-storage.js";

export class RepositoryAudit extends HTMLElement {
  connectedCallback() {
    this.state = auditSession;
    this.state.stackResults ||= new Map();
    this.preferences = new AuditDecisions();
    this.pendingTypeOverrides = new Set();
    this.decisionError = "";
    this.innerHTML = `<h1>Repository README audit</h1><p>Find documentation that needs attention using evidence, not scores. Only public owned repositories are listed. README content is analyzed locally; nothing is published.</p><form data-load><label>GitHub username<input name="username" autocomplete="off" required maxlength="200" value="${h(this.state.username)}"></label><button type="submit">Load repositories</button></form><p class="hint">100 repositories per page, up to 1,000. Three concurrent README requests. GitHub's unauthenticated rate limit may stop larger scans. Use Check history and links on a result for optional extra requests to GitHub and linked hosts (up to 20 URLs). Results and a bounded source cache stay in this tab; cached requests expire after five minutes.</p><div class="audit-controls"><label><input type="checkbox" data-forks ${this.state.includeForks ? "checked" : ""}> Include forks</label><label><input type="checkbox" data-archived ${this.state.includeArchived ? "checked" : ""}> Include archived repositories</label><label><input type="checkbox" data-fresh> Fetch fresh README content</label><button data-more>Load next 100 repositories</button><button data-select>Select all filtered repositories</button><button data-clear>Clear selection</button><button data-scan>Audit selected</button><button data-cancel disabled>Cancel audit</button></div><section class="audit-controls"><h2>Stack Intelligence</h2><p>Opt in to read root package.json, Cargo.toml, pyproject.toml, requirements.txt and go.mod files from selected public repositories. This contacts GitHub only. No dependency installation, package scripts, repository code or build tools are run. Root manifests only: up to six requests per repository; rate limits may pause scans.</p><label><input type="checkbox" data-stack-consent> Allow read-only manifest analysis for this session</label><label><input type="checkbox" data-stack-nested disabled aria-describedby="stack-nested-hint"> Include nested manifests (monorepo)</label><p class="hint" id="stack-nested-hint">Reads the default branch head and one repository tree listing, the root pnpm-workspace.yaml and go.work workspace files when present, then manifests up to four directories deep, mapped to workspace members and nested projects. Dependency folders such as node_modules and vendor are skipped. Up to 24 requests per repository; at most 25 repositories per nested run.</p><label><input type="checkbox" data-stack-fresh> Fetch fresh manifests</label><button data-stack-scan disabled>Analyze selected manifests</button></section><p data-status role="status" aria-live="polite"></p><stack-results></stack-results><p data-count></p><div class="audit-pagination"><button data-audit-view="audit" aria-pressed="true">Audit results</button><button data-audit-view="queue" aria-pressed="false">README Attention Queue</button></div><section data-audit-results><h2 tabindex="-1">Repository audit results</h2><div class="audit-table-wrap"><table class="audit-table"><caption>Public repository documentation evidence</caption><thead><tr><th scope="col">Select / Repository</th><th scope="col">README state and evidence</th><th scope="col">Activity / Language</th><th scope="col">Actions</th></tr></thead><tbody></tbody></table></div><div class="audit-pagination"><button data-prev>Previous results</button><span data-page></span><button data-next>Next results</button></div></section><readme-attention-queue hidden></readme-attention-queue><p>Improve README opens a project-specific template with reviewed repository suggestions. Existing README source is preserved by default; missing READMEs can start from the template. Project types and English documentation signals are suggestions. Missing topics are commonly useful, never universally required; evidence is not a judgment of the project or its developer.</p>`;
    this.querySelector("readme-attention-queue").insertAdjacentHTML(
      "afterend",
      "<audit-snapshot-history></audit-snapshot-history>",
    );
    this.querySelectorAll("[data-audit-view]").forEach(
      (button) =>
        (button.onclick = () => this.showView(button.dataset.auditView, true)),
    );
    this.addEventListener("attention-open", (event) =>
      this.improve(event.detail.repo, event.detail.builder),
    );
    // Plans in audit rows; the queue handles plans inside it.
    this.addEventListener("plan-action", (event) =>
      this.planAction(event.detail),
    );
    // Queue decisions and attention-setting changes redraw the affected rows.
    this.addEventListener("plan-decision", (event) => {
      const name = event.detail?.repository;
      for (const repo of this.visible || [])
        if (!name || repo.full_name === name) this.result(repo);
    });
    this.showView(this.getAttribute("data-start-view") || "audit");
    this.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      this.load(false);
    };
    this.querySelector("[data-more]").onclick = () => this.load(true);
    for (const [selector, key] of [
      ["[data-forks]", "includeForks"],
      ["[data-archived]", "includeArchived"],
    ])
      this.querySelector(selector).onchange = (e) => {
        this.state[key] = e.target.checked;
        this.state.viewPage = 0;
        this.list();
      };
    this.querySelector("[data-select]").onclick = () => {
      for (const repo of this.filtered())
        this.state.selected.add(repo.full_name);
      this.list();
    };
    this.querySelector("[data-clear]").onclick = () => {
      this.state.selected.clear();
      this.list();
    };
    this.querySelector("[data-scan]").onclick = () => this.scan();
    this.querySelector("[data-stack-consent]").onchange = () => this.controls();
    this.querySelector("[data-stack-nested]").onchange = () => this.controls();
    this.querySelector("[data-stack-scan]").onclick = () =>
      this.scanManifests();
    this.querySelector("[data-cancel]").onclick = () => this.cancel();
    this.querySelector("[data-prev]").onclick = () => {
      this.state.viewPage--;
      this.list();
    };
    this.querySelector("[data-next]").onclick = () => {
      this.state.viewPage++;
      this.list();
    };
    this.status(
      this.state.notice ||
        "Enter a username, select repositories, then audit their READMEs.",
    );
    this.list();
  }
  showView(view, focus = false) {
    const queue = view === "queue";
    this.querySelector("[data-audit-results]").hidden = queue;
    this.querySelector("readme-attention-queue").hidden = !queue;
    this.querySelectorAll("[data-audit-view]").forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.auditView === view),
      ),
    );
    this.querySelector("readme-attention-queue").setData(
      this.state,
      this.busy,
      this.preferences,
    );
    this.querySelector("audit-snapshot-history").setData(this.state, this.busy);
    if (focus)
      this.querySelector(
        queue ? "readme-attention-queue h2" : "[data-audit-results] h2",
      ).focus();
  }
  disconnectedCallback() {
    this.cancel();
  }
  cancel() {
    this.controller?.abort();
    this.analyzer?.close();
  }
  status(message) {
    this.state.notice = message;
    this.querySelector("[data-status]").textContent = message;
  }
  filtered() {
    return filterRepositories(this.state.repositories, this.state);
  }
  selected() {
    return this.filtered().filter((repo) =>
      this.state.selected.has(repo.full_name),
    );
  }
  controls() {
    this.querySelectorAll(
      "form input, form button, .audit-controls input, .audit-controls button, tbody input, tbody button, tbody select",
    ).forEach((el) => {
      el.disabled = !!this.busy;
    });
    this.querySelector("[data-cancel]").disabled = !this.busy;
    const consent = this.querySelector("[data-stack-consent]").checked;
    const nested = this.querySelector("[data-stack-nested]");
    // Nested discovery is a second consent that only exists inside the first.
    if (!consent) nested.checked = false;
    nested.disabled = !!this.busy || !consent;
    this.querySelector("[data-stack-scan]").disabled =
      !!this.busy || !this.selected().length || !consent;
    this.querySelector("stack-results").setData(
      this.selected().flatMap((repo) =>
        this.state.stackResults.has(repo.full_name)
          ? [this.state.stackResults.get(repo.full_name)]
          : [],
      ),
      // The loaded repository list marks results Stale; no request is made.
      this.state.repositories,
    );
    this.querySelector("[data-more]").disabled =
      !!this.busy || !this.state.next;
    this.querySelector("[data-scan]").disabled =
      !!this.busy || !this.selected().length;
    this.querySelector("readme-attention-queue").setData(
      this.state,
      this.busy,
      this.preferences,
    );
    this.querySelector("audit-snapshot-history").setData(this.state, this.busy);
    // The blanket toggle above ignores per-action rules inside plans.
    this.querySelectorAll("tbody improvement-plan").forEach((plan) => {
      plan.busy = this.busy;
    });
    this.querySelector("[data-count]").textContent =
      `${this.filtered().length} included of ${this.state.repositories.length} loaded · ${this.selected().length} selected`;
  }
  list() {
    const repos = this.filtered(),
      pages = Math.max(1, Math.ceil(repos.length / 25));
    this.state.viewPage = Math.max(0, Math.min(pages - 1, this.state.viewPage));
    this.visible = repos.slice(
      this.state.viewPage * 25,
      (this.state.viewPage + 1) * 25,
    );
    this.querySelector("tbody").innerHTML = this.visible
      .map(
        (repo, i) =>
          `<tr data-row="${i}"><th scope="row"><label><input type="checkbox" aria-label="Select ${h(repo.full_name)}" data-repo="${i}" ${this.state.selected.has(repo.full_name) ? "checked" : ""}>${h(repo.name)}</label>${repo.fork ? "<small>Fork</small>" : ""}</th><td data-result></td><td>${h(activityStatus(repo))}<br>${h(repo.language || "Language not specified")}<br><small>Last push: ${h(repo.pushed_at || "Unknown")}<br>Updated: ${h(repo.updated_at || "Unknown")}</small></td><td data-actions></td></tr>`,
      )
      .join("");
    this.querySelectorAll("[data-repo]").forEach((box) => {
      box.onchange = () => {
        const name = this.visible[Number(box.dataset.repo)].full_name;
        box.checked
          ? this.state.selected.add(name)
          : this.state.selected.delete(name);
        this.controls();
      };
    });
    this.visible.forEach((repo) => this.result(repo));
    this.querySelector("[data-page]").textContent =
      `Page ${this.state.viewPage + 1} of ${pages} · 25 rows per page`;
    this.querySelector("[data-prev]").disabled = this.state.viewPage === 0;
    this.querySelector("[data-next]").disabled =
      this.state.viewPage + 1 >= pages;
    this.controls();
  }
  result(repo) {
    const index = this.visible.findIndex((r) => r.full_name === repo.full_name);
    if (index < 0) return;
    const row = this.querySelector(`[data-row="${index}"]`),
      record = this.state.results.get(repo.full_name);
    const cell = row.querySelector("[data-result]"),
      key = repo.full_name.toLowerCase();
    if (record?.result && this.pendingTypeOverrides.has(key)) {
      try {
        this.preferences.setProjectType(
          repo.full_name,
          this.state.typeOverrides.get(key),
          readmeRevision(record),
        );
        this.pendingTypeOverrides.delete(key);
      } catch (error) {
        this.pendingTypeOverrides.delete(key);
        this.state.typeOverrides.delete(key);
        this.decisionError = error.message;
        this.status(error.message);
      }
    }
    const savedType = this.pendingTypeOverrides.has(key)
      ? this.preferences.projectType(repo.full_name)
      : applyAuditDecisions(this.state, this.preferences, repo.full_name);
    if (!cell.querySelector("[data-type]")) {
      cell.innerHTML = `<div data-assessment></div><p data-suggestion></p><label for="audit-type-${index}">Project type for ${h(repo.full_name)}</label><select id="audit-type-${index}" data-type><option value="auto">Automatic suggestion</option>${projectTypes.map((type) => `<option value="${type.id}">${h(type.name)}</option>`).join("")}</select><p class="hint" data-type-mode></p><button type="button" data-reset-audit aria-label="Reset saved audit decisions for ${h(repo.full_name)}" hidden>Reset saved audit decisions</button><improvement-plan data-plan hidden></improvement-plan>`;
      cell.querySelector("[data-type]").onchange = (event) => {
        const choice = event.target.value;
        try {
          if (choice === "auto") {
            this.pendingTypeOverrides.delete(key);
            this.preferences.resetProjectType(repo.full_name);
            this.state.typeOverrides.delete(key);
          } else if (record?.result) {
            this.pendingTypeOverrides.delete(key);
            this.preferences.setProjectType(
              repo.full_name,
              choice,
              readmeRevision(record),
            );
            this.decisionError = "";
            this.state.typeOverrides.set(key, choice);
          } else {
            this.pendingTypeOverrides.add(key);
            this.state.typeOverrides.set(key, choice);
          }
        } catch (error) {
          this.status(error.message);
          this.result(repo);
          return;
        }
        this.result(repo);
        this.querySelector("readme-attention-queue").setData(
          this.state,
          this.busy,
          this.preferences,
        );
        this.status(
          `Project type updated for ${repo.name}. ${record?.result ? "Assessment updated from cached evidence." : "Audit the README to assess documentation."}`,
        );
      };
      cell.querySelector("[data-reset-audit]").onclick = () => {
        try {
          this.preferences.resetAudit(repo.full_name);
          this.pendingTypeOverrides.delete(key);
          this.state.typeOverrides.delete(key);
          this.state.dismissed.delete(key);
          this.result(repo);
          this.querySelector("readme-attention-queue").setData(
            this.state,
            this.busy,
            this.preferences,
          );
          this.status(
            `Saved audit decisions reset for ${repo.name}. README source and attention settings are unchanged.`,
          );
          cell.querySelector("[data-type]").focus();
        } catch (error) {
          this.status(error.message);
        }
      };
    }
    const choice = this.state.typeOverrides.get(key) || "auto";
    const assessment = record?.result
      ? assessProjectType(record.result, choice)
      : null;
    const suggestion = record?.result?.suggestion || suggestProjectType(repo);
    const suggestedName = projectTypes.find(
      (type) => type.id === suggestion.id,
    ).name;
    cell.querySelector("[data-assessment]").innerHTML = assessment
      ? `<strong>${h(assessment.label)}</strong><ul>${[...assessment.evidence, ...[...(record.result.findings || []), ...(record.review?.findings || [])].map((finding) => finding.message), ...(record.review?.notes || [])].map((v) => `<li>${h(v)}</li>`).join("")}</ul><small>Checked ${h(new Date(record.checkedAt).toLocaleString())}</small>`
      : `<strong>Not assessed</strong><p>${h(record?.error || "Select this repository to fetch and analyze its README.")}</p>`;
    cell.querySelector("[data-suggestion]").textContent =
      `Suggested type: ${suggestedName}. ${suggestion.reason} This is an inference, not a certainty.${suggestion.alternatives.length ? ` Other signals: ${suggestion.alternatives.map((id) => projectTypes.find((t) => t.id === id).name).join(", ")}.` : ""}`;
    cell.querySelector("[data-type]").value = choice;
    cell.querySelector("[data-type]").disabled = !!this.busy;
    cell.querySelector("[data-type-mode]").textContent =
      choice !== "auto"
        ? record?.result
          ? `Manual override saved on this device for this repository${savedType?.observedRevision?.startsWith("sha:") ? ` (chosen at README revision ${savedType.observedRevision.slice(4, 11)})` : ""}. Choose Automatic suggestion to reset the type.`
          : "Manual override retained in this tab. Audit the README to save it for its observed revision."
        : "Using the automatic suggestion. You can choose another type.";
    cell.querySelector("[data-reset-audit]").hidden = !(
      savedType || this.preferences.dismissals(repo.full_name).size
    );
    const plan = cell.querySelector("[data-plan]");
    plan.hidden = !record;
    if (record) {
      plan.plan = improvementPlanForRecord(
        { ...record, repo },
        {
          session: this.state,
          preferences: this.preferences.entries,
          override: this.state.typeOverrides?.get(key) || "auto",
        },
      );
      plan.readmeUrl = readmeUrl(repo, record.readme);
      plan.minimalUnavailable = !!this.preferences.error;
      plan.busy = this.busy;
    }
    const url = repositoryUrl(repo);
    const readme = record?.readme;
    row.querySelector("[data-actions]").innerHTML =
      `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">Open repository</a>${readme?.path ? `<a href="${h(readmeUrl(repo, readme))}" target="_blank" rel="noopener noreferrer">Open README</a>` : ""}${record?.result ? `<button data-improve ${this.busy ? "disabled" : ""}>Improve README</button>${readme?.path ? `<button data-review ${this.busy ? "disabled" : ""}>Check history and links</button>` : ""}` : ""}`;
    const review = row.querySelector("[data-review]");
    if (review) review.onclick = () => this.review(repo);
    const improve = row.querySelector("[data-improve]");
    if (improve) improve.onclick = () => this.improve(repo);
  }
  planAction({ action, id, repository, focus }) {
    const repo = this.visible?.find((r) => r.full_name === repository);
    const record = repo && this.state.results.get(repository);
    if (this.busy || !record?.result) return;
    if (action === "improve" || action === "open") {
      this.improve(repo, action === "improve");
      return;
    }
    const queue = this.querySelector("readme-attention-queue");
    const plan = () =>
      this.querySelector(
        `[data-row="${this.visible.indexOf(repo)}"] improvement-plan`,
      );
    try {
      const revision = readmeRevision(record);
      const message =
        action === "minimal"
          ? rememberAttentionPreference(
              this.preferences,
              repo.full_name,
              "minimal",
              revision,
            )
          : this.planDecision({ repository, id, action, revision });
      this.result(repo);
      queue.setData(this.state, this.busy, this.preferences);
      this.status(message);
      plan().focusAfter(focus);
    } catch (error) {
      if (action === "minimal") {
        queue.setData(this.state, this.busy, this.preferences);
        // Storage failures disable intentionally-minimal in every visible row.
        for (const visible of this.visible) this.result(visible);
      }
      this.status(error.message);
    }
  }
  planDecision(detail) {
    if (detail.action === "dismiss")
      this.preferences.setDismissal(
        detail.repository,
        detail.id,
        detail.revision,
      );
    else if (
      detail.action === "restore" &&
      this.preferences.dismissals(detail.repository).has(detail.id)
    )
      this.preferences.removeDismissal(detail.repository, detail.id);
    return planDecision(this.state, detail);
  }
  async load(more) {
    if (this.busy) return;
    let username;
    try {
      username = githubUsername(this.querySelector("[name=username]").value);
    } catch (error) {
      this.status(error.message);
      return;
    }
    if (more && username.toLowerCase() !== this.state.username.toLowerCase()) {
      this.status("Load this username first before requesting another page.");
      return;
    }
    if (!more && username.toLowerCase() !== this.state.username.toLowerCase()) {
      this.pendingTypeOverrides.clear();
      Object.assign(this.state, {
        username,
        repositories: [],
        page: 0,
        next: false,
        viewPage: 0,
        selected: new Set(),
        results: new Map(),
        typeOverrides: new Map(),
        skipped: new Map(),
        dismissed: new Map(),
        stackResults: new Map(),
      });
      this.list();
    }
    this.busy = true;
    this.controller = new AbortController();
    this.controls();
    this.status("Loading public owned repositories…");
    try {
      const result = await auditClient.repositories(
        username,
        more ? this.state.page + 1 : 1,
        { signal: this.controller.signal },
      );
      if (!this.isConnected || this.controller.signal.aborted) return;
      this.state.repositories = [
        ...new Map(
          [
            ...(more ? this.state.repositories : []),
            ...result.repositories,
          ].map((r) => [r.full_name, r]),
        ).values(),
      ];
      this.state.username = result.username;
      this.state.page = more ? this.state.page + 1 : 1;
      this.state.next = result.next;
      if (!more) this.state.viewPage = 0;
      this.status(
        `${this.state.repositories.length} repositories loaded.${result.capped ? " Reached the 1,000 repository limit." : ""}${result.skipped ? ` ${result.skipped} unreadable/non-public entries omitted.` : ""} Select repositories to audit.`,
      );
    } catch (error) {
      if (this.isConnected)
        this.status(
          this.controller.signal.aborted
            ? "Loading cancelled; loaded repositories retained."
            : `Repository list incomplete. ${error.message}`,
        );
    } finally {
      this.busy = false;
      if (this.isConnected) this.list();
    }
  }
  async scan() {
    if (this.busy || !this.selected().length) return;
    this.decisionError = "";
    const selected = this.selected(),
      total = selected.length,
      fresh = this.querySelector("[data-fresh]").checked,
      repos = selected.filter(
        (repo) => fresh || !this.state.results.get(repo.full_name)?.result,
      ),
      retained = total - repos.length;
    if (!repos.length) {
      this.status(
        `Audit complete: ${total} of ${total} checked; 0 not assessed. Retained completed assessments; choose Fetch fresh to recheck.`,
      );
      return;
    }
    this.busy = true;
    this.controller = new AbortController();
    this.analyzer = auditAnalyzer();
    this.controls();
    this.status(
      `Auditing ${repos.length} READMEs; retaining ${retained} completed assessments…`,
    );
    let count = retained,
      failures = 0;
    try {
      const summary = await auditRepositories(repos, {
        client: auditClient,
        signal: this.controller.signal,
        force: fresh,
        analyze: (source, repo) => this.analyzer.analyze(source, repo),
        onResult: (record) => {
          if (!this.isConnected || this.controller.signal.aborted) return;
          this.state.results.set(record.repo.full_name, record);
          count++;
          if (record.error) failures++;
          this.result(record.repo);
          if (count % 10 === 0)
            this.status(
              `Assessed ${count} of ${total} repositories; ${failures} fetch/analysis failures.`,
            );
        },
      });
      if (this.isConnected)
        this.status(
          `${summary.cancelled ? "Audit cancelled" : summary.stopped ? "Audit paused" : "Audit complete"}: ${count} of ${total} checked; ${failures} not assessed; ${summary.remaining} not checked. ${retained} completed assessments retained. ${summary.stopped || "Results retained in this tab."}${this.decisionError ? ` ${this.decisionError}` : ""}`,
        );
    } catch (error) {
      if (this.isConnected) this.status(`Audit stopped. ${error.message}`);
    } finally {
      this.analyzer.close();
      this.busy = false;
      if (this.isConnected) {
        this.list();
        if (this.closest("dialog")?.open)
          this.querySelector("[data-scan]").focus();
      }
    }
  }
  async scanManifests() {
    if (
      this.busy ||
      !this.selected().length ||
      !this.querySelector("[data-stack-consent]").checked
    )
      return;
    const selected = this.selected();
    const nested = this.querySelector("[data-stack-nested]").checked;
    if (nested && selected.length > DISCOVERY_LIMITS.repositories) {
      this.status(NESTED_LIMIT_MESSAGE(selected.length));
      return;
    }
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    for (const repo of selected) this.state.stackResults.delete(repo.full_name);
    this.controls();
    this.status(
      nested
        ? "Reading selected root and nested manifests. Repository code is never executed."
        : "Reading selected root manifests. Repository code is never executed.",
    );
    try {
      const summary = await scanStacks(selected, {
        client: stackClient,
        signal,
        force: this.querySelector("[data-stack-fresh]").checked,
        nested,
        onResult: (record) => {
          if (!this.isConnected || signal.aborted) return;
          this.state.stackResults.set(record.repository, record);
          if (this.state.stackResults.size % 10 === 0)
            this.status(
              this.state.stackResults.size + " manifest results retained.",
            );
        },
      });
      if (this.isConnected)
        this.status(
          (summary.cancelled
            ? "Manifest analysis cancelled"
            : summary.stopped
              ? "Manifest analysis paused"
              : "Manifest analysis complete") +
            ": " +
            summary.completed +
            " checked; " +
            summary.remaining +
            " not checked. " +
            (summary.stopped ||
              "Expand results for evidence and any partial failures."),
        );
    } catch (error) {
      if (this.isConnected)
        this.status("Manifest analysis incomplete. " + error.message);
    } finally {
      this.busy = false;
      if (this.isConnected) {
        this.controls();
        this.querySelector("[data-stack-scan]").focus();
      }
    }
  }
  async review(repo) {
    if (this.busy) return;
    this.busy = true;
    this.controller = new AbortController();
    this.controls();
    this.status(
      "Checking README history and up to 20 links/images. Remote hosts receive URL requests, never the README source.",
    );
    try {
      const readme = await auditClient.readme(repo, {
        signal: this.controller.signal,
      });
      const review = await reviewReadme(repo, readme, {
        client: auditClient,
        signal: this.controller.signal,
      });
      this.controller.signal.throwIfAborted();
      const record = this.state.results.get(repo.full_name);
      // Do not attach observations about a different revision to an old assessment.
      if (record?.readme?.sha !== readme.sha) {
        this.status(
          "README changed. Fetch fresh README content before checking history and links again.",
        );
      } else {
        record.review = review;
        this.status(
          "History and link checks complete. Unverifiable URLs are not treated as broken.",
        );
      }
    } catch (error) {
      this.status(
        this.controller.signal.aborted
          ? "Checks cancelled; audit results retained."
          : `Checks incomplete. ${error.message}`,
      );
    } finally {
      this.busy = false;
      if (this.isConnected) {
        this.list();
        this.querySelector(
          `[data-row="${this.visible.findIndex((r) => r.full_name === repo.full_name)}"] [data-review]`,
        )?.focus();
      }
    }
  }
  async improve(repo, builder = true) {
    if (this.busy) return;
    this.busy = true;
    this.controller = new AbortController();
    this.controls();
    this.status(
      builder
        ? "Opening a repository template with README source and metadata suggestions…"
        : "Opening the repository document; existing local edits will be preserved…",
    );
    try {
      const readme = await auditClient.readme(repo, {
        signal: this.controller.signal,
      });
      if (!this.isConnected || this.controller.signal.aborted) return;
      this.dispatchEvent(
        new CustomEvent("audit-improve", {
          bubbles: true,
          detail: {
            repo,
            readme,
            builder,
            projectType:
              this.state.typeOverrides.get(repo.full_name.toLowerCase()) ||
              this.state.results.get(repo.full_name)?.result?.suggestion?.id ||
              "generic",
          },
        }),
      );
    } catch (error) {
      if (this.isConnected)
        this.status(`Could not open README. ${error.message}`);
    } finally {
      this.busy = false;
      if (this.isConnected) this.controls();
    }
  }
}
customElements.define("repository-audit", RepositoryAudit);
