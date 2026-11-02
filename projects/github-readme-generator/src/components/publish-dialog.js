import { documentTarget } from "../workspace/documents.js";
import { sourceDiffMarkup, fillSourceDiff } from "./source-diff.js";
import {
  generatedAssets,
  rewriteOwnedBanner,
  prepareAssetPlan,
} from "../publishing/assets.js";
import {
  buildChangeSet,
  changeSetContents,
  changeSetsSupported,
  executeChangeSet,
  fileWrites,
  shortChangeSetId,
  verifyChangeSet,
  CHANGE_SET_UNSUPPORTED,
} from "../publishing/change-set.js";
import { mergeThreeWay, resolveMerge } from "../publishing/conflicts.js";
import {
  readPublishingHistory,
  savePublishCheckpoint,
  recordPublish,
} from "../publishing/history.js";
import {
  clearPublishJournal,
  rawPublishJournal,
  readPublishJournal,
  reconcilePublishJournal,
  savePublishJournal,
  startPublishJournal,
  updatePublishJournal,
} from "../publishing/journal.js";
import {
  clearPullRequestJournal,
  completePullRequestJournal,
  rawPullRequestJournal,
  readPullRequestJournal,
  startPullRequestJournal,
} from "../publishing/pull-request.js";
import { PublishingClient } from "../github/publishing-client.js";
import { html } from "../markdown/serialize.js";
import { target } from "../publishing/validation.js";
import { publishDiff } from "../publishing/diff.js";
import {
  evaluatePreflight,
  blockingFailure,
  passes,
  branchChecks,
  CHECK_LABELS,
  READ_CHECKS,
} from "../publishing/preflight.js";
const ENTRY_KIND = {
  readme: "README",
  asset: "Generated asset",
  workflow: "Workflow",
};
const ENTRY_ACTION = {
  create: "create (new file)",
  update: "update",
  unchanged: "unchanged: no write",
};
// A BOM is invisible in the diff panes, so the row names the change.
const BOM_CHANGE = {
  removed:
    "Removed: the remote file starts with a UTF-8 byte order mark (BOM) and the prepared content does not. Publishing removes it.",
  added:
    "Added: the prepared content starts with a UTF-8 byte order mark (BOM) that the remote file does not have.",
};
const CHECK_STATUS = {
  pass: "Pass",
  warn: "Warning",
  fail: "Fail",
  unknown: "Unknown",
};
export class PublishDialog extends HTMLElement {
  connectedCallback() {
    this.client = new PublishingClient();
    this.innerHTML = `<h1>Publish to GitHub</h1><p>Optional publishing. Your README source stays unchanged. Every write requires a source review and confirmation.</p><p role="status" data-status>Checking connection…</p><section data-auth></section><section data-target></section><section data-preflight aria-labelledby="publish-preflight-heading"></section><section data-review></section><section data-journal></section><section data-pr-journal></section><section data-history></section><button data-download>Download README fallback</button>`;
    this.querySelector("[data-download]").onclick = () =>
      this.emit("publish-download", {
        content: this.source,
        name:
          this.kind === "workflow"
            ? this.workflowPath.split("/").at(-1)
            : "README.md",
        type: this.kind === "workflow" ? "text/yaml" : "text/markdown",
      });
    this.run(() => this.session());
  }
  configure(draft) {
    this.draftSnapshot = structuredClone(draft);
    this.source = draft.markdown;
    this.draftId = draft.id;
    this.originalSource = draft.markdown;
    this.historyView();
  }
  configureWorkflow(draft, result) {
    this.configure(draft);
    this.kind = "workflow";
    this.workflow = result.config;
    this.workflowPath = result.path;
    this.source = result.yaml;
    this.initialSource = result.yaml;
    this.querySelector("h1").textContent = "Publish workflow to GitHub";
    this.querySelector("[data-download]").textContent =
      "Download YAML fallback";
    const notice = document.createElement("p");
    notice.textContent = `${result.permissionReason} Publishing requires server opt-in and GitHub App Workflows: write. A committed workflow can execute scheduled commands on GitHub. Review the complete YAML.`;
    this.querySelector("h1").after(notice);
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  status(text) {
    this.querySelector("[data-status]").textContent = text;
  }
  async run(fn) {
    if (this.busy) return;
    this.busy = true;
    this.setAttribute("aria-busy", "true");
    try {
      await fn();
    } catch (e) {
      if (e.remote && this.baseline) this.stale(e.remote);
      this.status(e.message);
    } finally {
      this.busy = false;
      this.removeAttribute("aria-busy");
    }
  }
  async session() {
    this.auth = await this.client.request("session");
    this.authView();
    // Read-only mode is the default; a local report explains why until a
    // Preflight for a chosen target runs on the server.
    this.preflight = this.auth.connected
      ? null
      : evaluatePreflight(
          this.auth.configured
            ? { configured: true, connected: false }
            : { configured: false },
          { kind: this.kind },
        );
    this.preflightView();
    if (this.auth.connected) await this.loadRepositories();
    else
      this.status(
        this.auth.configured
          ? "Connect GitHub to select a repository."
          : "Publishing is not configured on this deployment. All local tools and downloads remain available.",
      );
  }
  authView() {
    const area = this.querySelector("[data-auth]");
    area.innerHTML = this.auth.connected
      ? `<p><img src="${html(this.auth.identity.avatar)}" width="32" height="32" alt=""> Connected as <strong>${html(this.auth.identity.name)}</strong> (${html(this.auth.identity.login)}).</p><p>Access is limited to repositories shared with this GitHub App and your own repository permissions. README publishing requires Contents: read/write and Metadata: read.</p><button data-disconnect>Disconnect GitHub</button>`
      : `<button data-connect ${!this.auth.configured ? "disabled" : ""}>Connect GitHub</button><div data-device></div>`;
    area.querySelector("[data-connect]")?.addEventListener("click", () =>
      this.run(async () => {
        const result = await this.client.request("connect", {});
        area.querySelector("[data-device]").innerHTML =
          `<p>Open <a href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">GitHub device authorization</a> and enter <strong>${html(result.code)}</strong>. Only authorize the code you requested here. Never share it.</p><button data-poll>Check authorization</button>`;
        area.querySelector("[data-poll]").onclick = () =>
          this.run(async () => {
            const state = await this.client.request("poll", {});
            if (state.pending) {
              this.status(
                "Waiting for GitHub authorization. Complete the GitHub prompt, then check again.",
              );
              return;
            }
            await this.session();
          });
        this.status("Authorize access on GitHub, then check authorization.");
        area.querySelector("[data-poll]").focus();
      }),
    );
    area.querySelector("[data-disconnect]")?.addEventListener("click", () =>
      this.run(async () => {
        await this.client.request("disconnect", {});
        this.baseline = null;
        this.clearChangeSet();
        this.preflight = null;
        this.querySelector("[data-target]").replaceChildren();
        this.querySelector("[data-review]").replaceChildren();
        await this.session();
        this.querySelector("[data-connect]")?.focus();
      }),
    );
  }
  async loadRepositories() {
    const { repositories } = await this.client.request("repositories", {});
    this.repositories = repositories;
    const area = this.querySelector("[data-target]");
    area.innerHTML = `<h2>Choose target</h2><p>Suggested profile repository: ${html(this.auth.identity.login)}/${html(this.auth.identity.login)}. Confirm your own selection. If missing, <a href="https://github.com/new" target="_blank" rel="noopener noreferrer">create it on GitHub</a> and install the app for it.</p><label>Target repository<select data-repo><option value="">Select repository</option>${repositories.map((r) => `<option value="${html(r.repository)}">${html(r.repository)} · ${html(r.visibility)} · ${(this.kind === "workflow" ? r.workflowsWritable : r.writable) ? "write access" : "read only"} · default ${html(r.branch)}</option>`).join("")}</select></label><label>Target branch<input data-branch autocomplete="off"></label><label>${this.kind === "workflow" ? "Workflow path" : "README path"}<input data-path value="${html(this.workflowPath || "README.md")}" ${this.kind === "workflow" ? "readonly" : ""} autocomplete="off"></label><details data-existing-pr><summary>Update an existing documentation pull request</summary><p>Only open pull requests whose head and base are in this same repository are offered. Selection never writes; the exact PR head is checked again before publishing.</p><button data-find-prs>Find compatible pull requests</button><div data-pr-picker></div></details><fieldset data-assets-options ${this.kind !== "workflow" && this.draftSnapshot?.metadata?.bannerSettings ? "" : "hidden"}><legend>Generated banner assets</legend><label class="check"><input type="checkbox" data-include-assets> Include generated banner SVG files in this publishing plan</label><label>Asset directory<input data-asset-directory value="assets/readme"></label><label class="check"><input type="checkbox" data-rewrite-banner> Update only Studio-owned banner references in the prepared README</label></fieldset><button data-load>Load remote ${this.kind === "workflow" ? "workflow" : "README"}</button>`;
    const destination =
      this.kind === "workflow"
        ? null
        : documentTarget(this.draftSnapshot || {});
    if (
      destination &&
      repositories.some((repo) => repo.repository === destination.repository)
    ) {
      area.querySelector("[data-repo]").value = destination.repository;
      area.querySelector("[data-branch]").value = destination.branch;
      area.querySelector("[data-path]").value = destination.path;
    }
    area.querySelector("[data-repo]").onchange = () => {
      area.querySelector("[data-branch]").value =
        repositories.find(
          (r) => r.repository === area.querySelector("[data-repo]").value,
        )?.branch || "";
      this.invalidate();
    };
    area
      .querySelectorAll("input")
      .forEach((el) => (el.oninput = () => this.invalidate()));
    // One explicit action: Preflight first, then the read-only load.
    area.querySelector("[data-load]").onclick = () =>
      this.run(async () => {
        const report = await this.checkAccess();
        if (!passes(report, READ_CHECKS)) {
          this.status(
            `Remote file not loaded. ${blockingFailure(report, READ_CHECKS).message} Your local draft is safe and download remains available.`,
          );
          return;
        }
        this.baseline = await this.client.request("read", this.target());
        this.source = this.initialSource || this.originalSource;
        this.assetRows = [];
        if (this.querySelector("[data-include-assets]").checked) {
          const directory = this.querySelector("[data-asset-directory]").value;
          const files = generatedAssets(
            this.draftSnapshot.metadata.bannerSettings,
            directory,
          );
          this.assetRows = await prepareAssetPlan(files, this.target(), (t) =>
            this.client.request("read", t),
          );
          if (this.querySelector("[data-rewrite-banner]").checked) {
            const rewrite = rewriteOwnedBanner(
              this.draftSnapshot,
              directory,
              this.baseline.path,
            );
            this.source = rewrite.source;
            this.rewriteApplied = rewrite.rewritten;
          }
        }
        await this.review();
        this.status(
          report.verdict === "writable"
            ? "Remote baseline loaded separately from your local draft. Review all source changes."
            : `Remote baseline loaded in Read-only mode. ${blockingFailure(report).message} Download remains available.`,
        );
        this.querySelector("[data-message]")?.focus();
      });
    area.querySelector("[data-find-prs]").onclick = () =>
      this.run(() => this.findPullRequests());
    this.status(
      repositories.length
        ? "Select a repository and branch."
        : "No repositories available. Install the GitHub App for your repository, then reconnect.",
    );
  }
  target() {
    return target({
      repository: this.querySelector("[data-repo]").value,
      branch: this.querySelector("[data-branch]").value,
      path: this.querySelector("[data-path]").value,
      ...(this.kind ? { kind: this.kind } : {}),
    });
  }
  async findPullRequests() {
    const raw = this.rawTarget(),
      repository = raw.repository,
      branch =
        raw.branch ||
        this.repositories.find((row) => row.repository === repository)?.branch,
      generation = this.changeSetGeneration || 0,
      requestedTarget = JSON.stringify({ repository, branch });
    target({ repository, branch, path: "README.md" });
    const { pullRequests } = await this.client.request("pull-requests", {
        repository,
        branch,
      }),
      picker = this.querySelector("[data-pr-picker]");
    const current = this.rawTarget(),
      currentBranch =
        current.branch ||
        this.repositories.find((row) => row.repository === current.repository)
          ?.branch;
    if (
      !picker?.isConnected ||
      generation !== (this.changeSetGeneration || 0) ||
      requestedTarget !==
        JSON.stringify({
          repository: current.repository,
          branch: currentBranch,
        })
    )
      throw new Error(
        "Target changed while finding pull requests. Search the current target again.",
      );
    if (!pullRequests.length) {
      picker.innerHTML =
        "<p>No compatible open same-repository pull requests were found. Nothing changed.</p>";
      return;
    }
    picker.innerHTML = `<label>Compatible pull request<select data-pr-select><option value="">Choose a pull request</option>${pullRequests.map((pull) => `<option value="${pull.number}">#${pull.number} · ${html(pull.title)} · ${html(pull.head)} into ${html(pull.base)}${pull.draft ? " · draft" : ""}</option>`).join("")}</select></label><button data-use-pr>Use selected pull request head</button>`;
    picker.querySelector("[data-use-pr]").onclick = () => {
      const number = Number(picker.querySelector("[data-pr-select]").value),
        selected = pullRequests.find((pull) => pull.number === number);
      if (!selected) {
        this.status("Choose a compatible pull request first.");
        return;
      }
      this.querySelector("[data-branch]").value = selected.head;
      this.invalidate();
      this.selectedPullRequest = selected;
      this.status(
        `Selected PR #${selected.number}. Load and review its exact head before publishing.`,
      );
    };
  }
  rawTarget() {
    return {
      repository: this.querySelector("[data-repo]").value,
      branch: this.querySelector("[data-branch]").value,
      path: this.querySelector("[data-path]").value,
      ...(this.kind ? { kind: this.kind } : {}),
    };
  }
  // Runs a Preflight for the current target. Never retries; a failure leaves
  // every check unknown, which keeps the review in Read-only mode.
  async checkAccess() {
    const raw = this.rawTarget();
    target({
      repository: raw.repository,
      branch: raw.branch,
      path: "README.md",
    });
    this.preflight = null;
    this.preflightView("Checking access…");
    let report;
    try {
      report = await this.client.request("preflight", raw);
    } catch (e) {
      report = evaluatePreflight(
        {
          target: raw,
          unavailable: `Access could not be checked: ${e.message} Your local draft is safe. No automatic retry was made.`,
        },
        { kind: this.kind },
      );
    }
    if (JSON.stringify(raw) !== JSON.stringify(this.rawTarget())) {
      this.preflightView();
      throw new Error("Target changed while checking access. Re-check access.");
    }
    this.preflight = report;
    this.preflightView();
    return report;
  }
  // Write controls exist only for a writable Preflight of this exact target.
  writableTarget() {
    try {
      return (
        this.preflight?.verdict === "writable" &&
        JSON.stringify(this.preflight.target) === JSON.stringify(this.target())
      );
    } catch {
      return false;
    }
  }
  preflightView(pending) {
    const area = this.querySelector("[data-preflight]"),
      p = this.preflight;
    if (!area) return;
    const heading = `<h2 id="publish-preflight-heading">Preflight</h2>`;
    if (!p) {
      area.innerHTML = `${heading}<p role="status" data-verdict>${pending || "Read-only mode. Load the remote file to run a Preflight for that exact target. No write can be approved until every blocking check passes."}</p>`;
      return;
    }
    const failure = blockingFailure(p),
      where = p.target.repository
        ? `${p.target.repository} · branch ${p.target.branch} · ${p.target.path}`
        : "";
    area.innerHTML = `${heading}<p role="status" data-verdict>${p.verdict === "writable" ? `Writable: every blocking check passed for ${html(where)}.` : `Read-only mode${where ? ` for ${html(where)}` : ""}. ${html(failure.message)}`}</p><ul class="preflight-checks">${p.checks.map((c) => `<li data-check="${html(c.id)}" data-check-status="${html(c.status)}"><strong>${CHECK_STATUS[c.status]}</strong> · ${html(CHECK_LABELS[c.id] || c.id)}${c.blocking ? "" : " (advisory)"}: ${html(c.message)}</li>`).join("")}</ul><p class="preflight-time">Checked ${html(new Date(p.checkedAt).toLocaleString())}. Permissions can change on GitHub at any time, and GitHub still decides at write time.</p>${this.auth?.connected && where ? "<button data-recheck>Re-check access</button>" : ""}`;
    area.querySelector("[data-recheck]")?.addEventListener("click", () =>
      this.run(async () => {
        const report = await this.checkAccess();
        if (this.baseline) await this.review({ keepMessage: true });
        this.status(
          report.verdict === "writable"
            ? "Access re-checked: every blocking check passed. Confirm the review again."
            : `Access re-checked: Read-only mode. ${blockingFailure(report).message}`,
        );
        this.querySelector("[data-recheck]")?.focus();
      }),
    );
  }
  invalidate() {
    this.baseline = null;
    this.assetRows = [];
    this.clearChangeSet();
    this.staleRemote = false;
    this.preflight = null;
    this.selectedPullRequest = null;
    this.querySelector("[data-pr-picker]")?.replaceChildren();
    this.preflightView();
    this.querySelector("[data-review]").replaceChildren();
    this.status("Target changed. Load the remote README again.");
  }
  // Drops the Change set and its Publish approval; an in-flight build that
  // finishes later is discarded.
  clearChangeSet() {
    this.changeSet = null;
    this.changeFiles = [];
    this.changeSetError = "";
    this.approvedChangeSetId = null;
    this.changeSetGeneration = (this.changeSetGeneration || 0) + 1;
  }
  // The prepared files of this review. Content stays here in memory; the
  // Change set manifest holds only paths, actions and SHAs.
  prepareFiles() {
    const b = this.baseline;
    return [
      ...(this.assetRows || []).map((r) => ({
        path: r.path,
        kind: "asset",
        baseSha: r.baseline.sha,
        baseContent: r.baseline.content,
        content: r.content,
        fields: { banner: r.banner },
        warning: r.warning,
      })),
      {
        path: b.path,
        kind: this.kind || "readme",
        baseSha: b.sha,
        baseContent: b.content,
        content: this.source,
        fields: this.kind === "workflow" ? { workflow: this.workflow } : {},
      },
    ];
  }
  defaultMessage() {
    return this.kind === "workflow"
      ? "Update README workflow"
      : "Update README with README Studio";
  }
  // Builds the Change set for the current review. Every rebuild withdraws
  // Publish approval. Returns false when a newer build or target change
  // superseded this one.
  async rebuildChangeSet(message) {
    this.clearChangeSet();
    if (!this.baseline) return false;
    const generation = this.changeSetGeneration,
      files = this.prepareFiles();
    let built = null,
      error = "";
    try {
      built = await buildChangeSet({
        target: this.baseline,
        baseCommitSha: this.baseline.commitSha ?? null,
        message,
        files,
      });
    } catch (e) {
      error = e.message;
    }
    if (generation !== this.changeSetGeneration) return false;
    this.changeFiles = files;
    this.changeSet = built;
    this.changeSetError = error;
    return true;
  }
  async review({ keepMessage = false } = {}) {
    const message = keepMessage
      ? (this.querySelector("[data-message]")?.value ?? this.defaultMessage())
      : this.defaultMessage();
    if (!(await this.rebuildChangeSet(message))) return;
    this.staleRemote = false;
    const b = this.baseline,
      diff = publishDiff(b.content, this.source),
      supported = changeSetsSupported(),
      writable = this.writableTarget() && supported,
      // Enforcement equals display: offer the route only when the server's
      // branch operation would accept it.
      branchable = passes(this.preflight, branchChecks(this.kind)),
      noun = this.kind === "workflow" ? "workflow" : "README",
      language = this.kind === "workflow" ? "YAML" : "Markdown";
    this.querySelector("[data-review]").innerHTML =
      `<h2>Review ${b.sha ? "updated file" : "New file"}</h2>${this.selectedPullRequest ? `<p data-selected-pr>Updating selected PR #${this.selectedPullRequest.number}: ${html(this.selectedPullRequest.head)} into ${html(this.selectedPullRequest.base)}. Its exact head and mergeability will be checked again before any file write.</p>` : ""}<section data-change-set aria-labelledby="publish-change-set-heading"><h3 id="publish-change-set-heading">Change set</h3><p data-change-set-target>${html(b.repository)} · branch ${html(b.branch)} · base commit <code>${html(b.commitSha || "unknown")}</code></p><p>Not atomic: each file is a separate commit, generated assets first and the ${noun} last. Nothing is deleted, and every update names its Base SHA, so a file that changed on GitHub is never overwritten.${this.assetRows?.length ? ` ${this.rewriteApplied ? "Owned banner paths updated in prepared source." : "No banner source rewrite applied."}` : ""}</p><ol class="change-set-entries">${this.changeFiles
        .map(
          (f, i) =>
            `<li data-entry="${html(f.path)}"><dl class="change-set-facts" data-entry-facts></dl><details data-entry-diff="${i}" ${f.kind === "asset" ? "" : "open data-primary-diff"}><summary>Diff for ${html(f.path)}</summary>${f.kind === "asset" ? `<p>${html(f.warning || "")} ${this.source.includes(f.path.split("/").at(-1)) ? "" : "Warning: asset appears unreferenced by this README."}</p>` : `<p>${diff.added} added / ${diff.removed} removed lines in changed region. Sections: ${html(diff.sections.join(", ") || "body content")}.</p>`}${sourceDiffMarkup(
              f.kind === "asset"
                ? {
                    beforeLabel: `Current ${f.path}`,
                    afterLabel: `Generated ${f.path}`,
                    label: `Asset diff ${f.path}`,
                  }
                : {
                    beforeLabel: `Remote ${language}`,
                    afterLabel: `Prepared ${language}`,
                    label: "Publishing diff",
                  },
            )}</details></li>`,
        )
        .join(
          "",
        )}</ol><p data-change-set-id></p></section><label>Commit message<input data-message maxlength="500"></label>${writable ? `<label class="check"><input type="checkbox" data-confirm> <span data-approval-label></span></label><button data-commit disabled>Confirm and publish ${noun}</button>` : `<p data-read-only>${supported ? "Read-only mode: no publish control is available until a Preflight for this exact target passes. Re-check access after fixing the failing check. Download remains available." : html(CHANGE_SET_UNSUPPORTED)}</p>`}<div data-result></div><div data-change-set-results role="status"></div><section data-stale></section>${branchable ? `<details data-new-branch-route><summary>Publish on a new branch instead</summary><p>Create a branch from ${html(b.branch)} at commit ${html(b.commitSha || "unknown")}. This creates only a branch; committing still needs a fresh review.</p><label>New branch name<input data-new-branch value="readme-studio/update-${new Date().toISOString().slice(0, 10)}"></label><label class="check"><input type="checkbox" data-confirm-branch> I confirm creating this branch in ${html(b.repository)}.</label><button data-create-branch>Create branch for review</button></details>` : ""}`;
    this.changeFiles.forEach((f, i) =>
      fillSourceDiff(
        this.querySelector(`[data-entry-diff="${i}"] .source-diff`),
        f.baseContent,
        f.content,
        f.kind === "asset" ? undefined : diff.text,
      ),
    );
    const input = this.querySelector("[data-message]");
    input.value = message;
    input.addEventListener("input", () => this.messageChanged(input.value));
    this.querySelector("[data-confirm]")?.addEventListener("change", (e) => {
      this.approvedChangeSetId =
        e.target.checked && this.changeSet ? this.changeSet.id : null;
      this.changeSetView();
    });
    this.querySelector("[data-commit]")?.addEventListener("click", () =>
      this.run(() => this.commit()),
    );
    this.querySelector("[data-create-branch]")?.addEventListener("click", () =>
      this.run(() => this.createBranch()),
    );
    this.changeSetView();
  }
  // Renders the File change rows, the Change set id and the Publish approval
  // for the current Change set. Publish is enabled only for an approval of
  // exactly this Change set.
  changeSetView() {
    const area = this.querySelector("[data-change-set]");
    if (!area) return;
    const cs = this.changeSet,
      entries = new Map((cs?.entries || []).map((e) => [e.path, e])),
      files = new Map(this.changeFiles.map((f) => [f.path, f])),
      pending = this.changeSetError
        ? "not computed"
        : "computing the change set…";
    for (const item of area.querySelectorAll("[data-entry]")) {
      const f = files.get(item.dataset.entry),
        e = entries.get(item.dataset.entry);
      if (!f) continue;
      item.dataset.action = e?.action || "pending";
      item.querySelector("[data-entry-facts]").innerHTML =
        `<dt>Path</dt><dd><strong>${html(f.path)}</strong></dd><dt>Kind</dt><dd>${ENTRY_KIND[f.kind]}</dd><dt>Action</dt><dd data-entry-action>${html(ENTRY_ACTION[e?.action] || pending)}</dd><dt>Base SHA</dt><dd><code data-base-sha>${html(f.baseSha || "none: new file")}</code></dd><dt>Result SHA</dt><dd><code data-result-sha>${html(e?.resultSha || pending)}</code></dd><dt>Size</dt><dd>${new TextEncoder().encode(f.content).length} bytes</dd><dt>Lines</dt><dd>${e && e.added !== null ? `+${e.added} / −${e.removed}` : "not counted"}</dd>${e?.bom ? `<dt>Byte order mark</dt><dd data-entry-bom>${BOM_CHANGE[e.bom]}</dd>` : ""}`;
    }
    const writes = cs ? fileWrites(cs).length : 0,
      where = cs ? `${cs.target.repository} on ${cs.target.branch}` : "";
    area.querySelector("[data-change-set-id]").innerHTML = cs
      ? `Change set <code>${html(shortChangeSetId(cs.id))}</code>: ${writes} file ${writes === 1 ? "write" : "writes"}, ${cs.entries.length - writes} unchanged. Full id <code>${html(cs.id)}</code>.`
      : html(
          this.changeSetError
            ? `No change set: ${this.changeSetError}`
            : "Building the change set…",
        );
    const confirm = this.querySelector("[data-confirm]");
    if (!confirm) return;
    // A Stale change set cannot be approved until a merge or reload builds a
    // new one from the latest remote file. Neither can one built on a
    // baseline a Publish attempt already used: Studio's own writes would read
    // back as remote changes.
    const spent = this.spentBaseline(),
      approvable = !!cs && writes > 0 && !this.staleRemote && !spent,
      approved = approvable && this.approvedChangeSetId === cs.id;
    confirm.checked = approved;
    confirm.disabled = !approvable;
    this.querySelector("[data-approval-label]").textContent = this.staleRemote
      ? "Stale change set: GitHub has a newer version. Merge, reload or cancel below before approving."
      : spent
        ? `A publish attempt already ran on this remote baseline. Load the remote ${this.kind === "workflow" ? "workflow" : "README"} again to review a new change set.`
        : !cs
          ? this.changeSetError
            ? "Nothing to approve: fix the problem shown under the change set first."
            : "Building the change set…"
          : writes
            ? `I reviewed ${writes} file ${writes === 1 ? "write" : "writes"} to ${where} (change set ${shortChangeSetId(cs.id)}).`
            : `Nothing to approve: every file already matches ${where} (change set ${shortChangeSetId(cs.id)}).`;
    this.querySelector("[data-commit]").disabled = !approved;
  }
  // True once a Publish attempt ran on the loaded baseline. Only loading,
  // reloading or merging a remote file (a new baseline) allows another one.
  spentBaseline() {
    return !!this.baseline && this.baseline === this.executedBaseline;
  }
  // The commit message is part of the Change set: editing it builds a new
  // one and withdraws approval.
  async messageChanged(value) {
    const wasApproved =
      !!this.changeSet && this.approvedChangeSetId === this.changeSet.id;
    this.changeSet = null;
    this.approvedChangeSetId = null;
    this.changeSetView();
    if (wasApproved)
      this.status(
        "Commit message changed, so the change set changed. Approve the new change set before publishing.",
      );
    if (await this.rebuildChangeSet(value)) this.changeSetView();
  }
  async commit() {
    if (!this.writableTarget())
      throw new Error(
        "Read-only mode. Re-check access for this exact target before publishing.",
      );
    const cs = this.changeSet;
    if (this.spentBaseline())
      throw new Error(
        "A publish attempt already ran on this remote baseline. Load the remote file again before publishing. Nothing was written.",
      );
    if (
      !cs ||
      this.approvedChangeSetId !== cs.id ||
      !this.querySelector("[data-confirm]")?.checked
    )
      throw new Error(
        "Review and approve this exact change set first. Nothing was written.",
      );
    if (JSON.stringify(this.target()) !== JSON.stringify(target(this.baseline)))
      throw new Error("Target changed. Reload and review.");
    // Every file must still have its Base SHA before the first write.
    const { stale, remotes } = await verifyChangeSet(cs, (t) =>
      this.client.request("read", t),
    );
    if (stale.length) {
      await this.staleChangeSet(stale, remotes);
      return;
    }
    if (this.changeSet !== cs || this.approvedChangeSetId !== cs.id)
      throw new Error(
        "The change set changed while it was being verified. Nothing was written; approve it again.",
      );
    if (this.selectedPullRequest) {
      if (this.baseline.commitSha !== this.selectedPullRequest.headSha)
        throw new Error(
          "The selected pull request head does not match this loaded review. Select and load it again.",
        );
      await this.client.request("pull-request-check", {
        repository: this.baseline.repository,
        number: this.selectedPullRequest.number,
        head: this.selectedPullRequest.head,
        base: this.selectedPullRequest.base,
        headSha: this.selectedPullRequest.headSha,
      });
    }
    savePublishCheckpoint(this.draftId, this.originalSource);
    startPublishJournal(cs);
    this.retrySessionChangeSetId = cs.id;
    this.historyView();
    this.status("Publishing the reviewed change set…");
    const outcome = await executeChangeSet(
      cs,
      changeSetContents(this.changeFiles),
      (op, data) => this.client.request(op, data),
      {
        expectedBranchSha: this.selectedPullRequest?.headSha,
        beforeWrite: (entry) =>
          updatePublishJournal(cs.id, entry.path, "pending"),
        afterWrite: (entry, status, result) =>
          updatePublishJournal(
            cs.id,
            entry.path,
            status,
            result?.commitSha ? { commitSha: result.commitSha } : {},
          ),
      },
    );
    // Approval covers one attempt; a retry needs a fresh baseline and review.
    this.executedBaseline = this.baseline;
    this.approvedChangeSetId = null;
    this.changeSetView();
    this.querySelector("[data-commit]").disabled = true;
    this.querySelector("[data-change-set-results]").textContent =
      outcome.results
        .map(
          (r) =>
            `${r.path}: ${r.status}${r.commitSha ? " (" + r.commitSha + ")" : ""}${r.error ? " — " + r.error : ""}`,
        )
        .join(" · ");
    const assetWrites = fileWrites(cs).some((e) => e.kind === "asset");
    if (!outcome.complete) {
      const { entry, error } = outcome.failure;
      this.journalView();
      if (error.ambiguous) {
        this.status(
          error.recoveryReason === "journal"
            ? `The outcome of ${entry.path} is not durably recorded because the local Publish journal could not be updated after GitHub answered. Do not retry. Reconcile with GitHub first.`
            : `The outcome of ${entry.path} is unknown because its response was lost. Do not retry. Reconcile the Publish journal with GitHub first.`,
        );
        return;
      }
      if (entry.kind === "asset") {
        this.status(
          `Partial asset publish: ${entry.path} was not written (${error.message}). The ${this.kind === "workflow" ? "workflow" : "README"} was not attempted. Review the reported files and reload before retrying.`,
        );
        return;
      }
      // GitHub's own refusal is definitive; route to the new-branch review.
      // A refusal by the server's own Preflight would refuse the branch too.
      const route =
        [403, 422].includes(error.status) && !error.preflight
          ? this.querySelector("[data-new-branch-route]")
          : null;
      if (route) {
        route.open = true;
        error.message +=
          " You can use “Publish on a new branch instead” below.";
      }
      if (assetWrites)
        throw Object.assign(
          new Error(
            `Assets completed, but README failed: ${error.message} Reload and review before retrying.`,
          ),
          { remote: error.remote },
        );
      throw error;
    }
    const primary = outcome.results.at(-1);
    if (primary.status !== "written") {
      clearPublishJournal();
      this.retrySessionChangeSetId = null;
      this.journalView();
      this.status(
        "All reviewed assets published or unchanged. README needed no write. Local draft is unchanged.",
      );
      return;
    }
    this.published(primary.result);
  }
  // A Stale change set writes nothing. A stale README or workflow goes to the
  // existing remote-change review; stale assets take their latest remote
  // baseline into a new Change set that needs a fresh approval.
  async staleChangeSet(stale, remotes) {
    for (const row of this.assetRows || [])
      if (stale.includes(row.path)) row.baseline = remotes[row.path];
    const others = stale.filter((path) => path !== this.baseline.path);
    if (stale.includes(this.baseline.path)) {
      this.stale(remotes[this.baseline.path]);
      if (others.length)
        this.querySelector("[data-stale] h2").insertAdjacentHTML(
          "afterend",
          `<p>Also changed since review: ${html(others.join(", "))}.</p>`,
        );
      return;
    }
    await this.review({ keepMessage: true });
    const area = this.querySelector("[data-stale]");
    area.innerHTML = `<h2 tabindex="-1">Stale change set</h2><p>${html(others.join(", "))} changed on GitHub since you reviewed ${others.length === 1 ? "it" : "them"}. Nothing was written. The change set above now uses the latest remote ${others.length === 1 ? "file" : "files"}; review it and approve it again.</p>`;
    area.querySelector("h2").focus();
    this.status(
      `Stale change set: ${others.join(", ")} changed on GitHub. Nothing was written. Review the new change set and approve it again.`,
    );
  }
  published(result) {
    const repo = `https://github.com/${result.repository}`,
      file = `${repo}/blob/${encodeURIComponent(result.branch)}/${result.path.split("/").map(encodeURIComponent).join("/")}`;
    this.querySelector("[data-result]").innerHTML =
      `<p>Published commit <a href="${repo}/commit/${html(result.commitSha)}" target="_blank" rel="noopener noreferrer">${html(result.commitSha)}</a>. <a href="${repo}" target="_blank" rel="noopener noreferrer">Repository</a> · <a href="${html(file)}" target="_blank" rel="noopener noreferrer">README</a></p>`;
    const previous = result.previousCommitSha || this.baseline.commitSha;
    if (previous) {
      const link = document.createElement("a");
      link.href = `${repo}/blob/${previous}/${result.path.split("/").map(encodeURIComponent).join("/")}`;
      link.textContent = "View previous version on GitHub";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      this.querySelector("[data-result]").append(link);
    }
    if (this.selectedPullRequest) {
      const link = document.createElement("a");
      link.href = this.selectedPullRequest.url;
      link.textContent = `View updated pull request #${this.selectedPullRequest.number}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      this.querySelector("[data-result]").append(link);
    } else if (this.branchBase) {
      const allowed = this.repositories?.find(
        (row) => row.repository === result.repository,
      )?.pullRequestsWritable;
      this.querySelector("[data-result]").insertAdjacentHTML(
        "beforeend",
        allowed
          ? `<details data-create-pr><summary>Create a reviewed draft pull request</summary><p>Target: ${html(result.branch)} at <code>${html(result.commitSha)}</code> into ${html(this.branchBase)} at <code>${html(this.branchBaseSha)}</code>. GitHub will reject this if either exact branch head changed or a matching open PR already exists.</p><label>Pull request title<input data-pr-title maxlength="256" value="Update README"></label><label>Pull request notes<textarea data-pr-body rows="5">Prepared and reviewed with README Studio.</textarea></label><label class="check"><input type="checkbox" data-confirm-pr> I reviewed this exact title, notes, head, base, and both SHAs. Create a draft PR.</label><button data-submit-pr disabled>Create draft pull request</button><div data-pr-result></div></details>`
          : "<p>Creating a draft PR here requires Pull requests: read and write permission for the GitHub App. The reviewed branch commit is safe; use GitHub to open the PR or reconnect after changing app permissions.</p>",
      );
      const confirm = this.querySelector("[data-confirm-pr]"),
        submit = this.querySelector("[data-submit-pr]");
      if (confirm && submit) {
        confirm.onchange = () => (submit.disabled = !confirm.checked);
        const withdraw = () => {
          confirm.checked = false;
          submit.disabled = true;
        };
        this.querySelector("[data-pr-title]").oninput = withdraw;
        this.querySelector("[data-pr-body]").oninput = withdraw;
        submit.onclick = () => this.run(() => this.createPullRequest(result));
      }
    }
    try {
      recordPublish(result, previous);
      clearPublishJournal();
      this.retrySessionChangeSetId = null;
      this.emit("publish-complete", {
        draftId: this.draftId,
        kind: this.kind || "readme",
        result,
      });
      this.historyView();
      this.status(
        `${this.kind === "workflow" ? "Workflow" : "README"} published. Your README source is unchanged.`,
      );
    } catch (e) {
      this.status(
        `README published (${result.commitSha}), but local history could not be saved. ${e.message}`,
      );
    }
  }
  historyView() {
    const area = this.querySelector("[data-history]");
    if (!area) return;
    try {
      const history = readPublishingHistory();
      area.innerHTML = `<details><summary>Local publishing history and recovery</summary>${history.checkpoint ? "<button data-recovery>Download pre-publish checkpoint</button><button data-restore>Restore checkpoint as a new draft</button>" : ""}<ol>${history.entries.map((e) => `<li>${html(e.repository)} · ${html(e.branch)} · ${html(e.path)} · ${e.reconciled ? "reconciled at observed branch head " : "published commit "}${html(e.commitSha)} · ${html(new Date(e.timestamp).toISOString())}</li>`).join("")}</ol></details>`;
      area.querySelector("[data-recovery]")?.addEventListener("click", () =>
        this.emit("publish-download", {
          content: history.checkpoint.source,
          name: "README-pre-publish.md",
        }),
      );
      area
        .querySelector("[data-restore]")
        ?.addEventListener("click", () =>
          this.emit("publish-restore", { source: history.checkpoint.source }),
        );
    } catch (e) {
      area.textContent = e.message;
    }
    this.journalView();
    this.pullRequestJournalView();
  }
  pullRequestJournalView() {
    const area = this.querySelector("[data-pr-journal]");
    if (!area) return;
    let journal;
    try {
      journal = readPullRequestJournal();
    } catch (error) {
      area.innerHTML = `<h2>Pull request recovery needs attention</h2><p role="alert">${html(error.message)}</p><button data-pr-journal-download>Download original recovery journal</button><button data-pr-journal-clear disabled>Clear downloaded recovery journal</button>`;
      const download = area.querySelector("[data-pr-journal-download]"),
        clear = area.querySelector("[data-pr-journal-clear]");
      download.onclick = () => {
        this.emit("publish-download", {
          content: rawPullRequestJournal() || "",
          name: "readme-studio-pull-request-recovery.json",
          type: "application/json",
        });
        clear.disabled = false;
      };
      clear.onclick = () => {
        clearPullRequestJournal();
        this.pullRequestJournalView();
        this.status("Downloaded pull request recovery journal cleared.");
      };
      return;
    }
    if (!journal) {
      area.replaceChildren();
      return;
    }
    const raw = rawPullRequestJournal(),
      unmatched =
        typeof this.prReconciledNoMatch === "string" &&
        raw === this.prReconciledNoMatch;
    area.innerHTML = `<h2>Pull request recovery</h2><p>${html(journal.repository)} · ${html(journal.head)} into ${html(journal.base)} · ${html(journal.status)}. Do not create another PR until this exact operation is reconciled.</p>${journal.status === "created" ? `<p><a href="${html(journal.url)}" target="_blank" rel="noopener noreferrer">View pull request #${journal.number}</a></p><button data-clear-pr-journal>Clear settled recovery</button>` : `<button data-reconcile-pr>Reconcile with GitHub</button>${unmatched ? '<p>No exact match was observed. Before clearing, inspect GitHub for this head and base and download the recovery record.</p><button data-download-unmatched-pr>Download unmatched recovery</button><label class="check"><input type="checkbox" data-confirm-unmatched-pr disabled> I checked GitHub and understand that clearing permits a fresh reviewed attempt.</label><button data-clear-unmatched-pr disabled>Clear unmatched recovery</button>' : ""}`}`;
    area
      .querySelector("[data-reconcile-pr]")
      ?.addEventListener("click", () =>
        this.run(() => this.reconcilePullRequest()),
      );
    area
      .querySelector("[data-clear-pr-journal]")
      ?.addEventListener("click", () => {
        clearPullRequestJournal();
        this.pullRequestJournalView();
        this.status("Settled pull request recovery cleared.");
      });
    const download = area.querySelector("[data-download-unmatched-pr]"),
      confirm = area.querySelector("[data-confirm-unmatched-pr]"),
      clear = area.querySelector("[data-clear-unmatched-pr]");
    if (download && confirm && clear) {
      download.onclick = () => {
        if (rawPullRequestJournal() !== this.prReconciledNoMatch) {
          this.prReconciledNoMatch = false;
          this.pullRequestJournalView();
          this.status(
            "Pull request recovery changed in another tab. Reconcile this exact recovery before clearing it.",
          );
          return;
        }
        this.emit("publish-download", {
          content: this.prReconciledNoMatch,
          name: "readme-studio-unmatched-pull-request-recovery.json",
          type: "application/json",
        });
        confirm.disabled = false;
      };
      confirm.onchange = () => (clear.disabled = !confirm.checked);
      clear.onclick = () => {
        if (rawPullRequestJournal() !== this.prReconciledNoMatch) {
          this.prReconciledNoMatch = false;
          this.pullRequestJournalView();
          this.status(
            "Pull request recovery changed in another tab. It was not cleared; reconcile it first.",
          );
          return;
        }
        clearPullRequestJournal();
        this.prReconciledNoMatch = false;
        this.pullRequestJournalView();
        this.status(
          "Downloaded unmatched recovery cleared. No remote request was retried; review fresh before another attempt.",
        );
      };
    }
  }
  async createPullRequest(result) {
    const details = this.querySelector("[data-create-pr]"),
      input = {
        repository: result.repository,
        head: result.branch,
        base: this.branchBase,
        headSha: result.commitSha,
        baseSha: this.branchBaseSha,
        title: details.querySelector("[data-pr-title]").value,
        body: details.querySelector("[data-pr-body]").value,
        confirmed: details.querySelector("[data-confirm-pr]").checked,
      },
      journal = startPullRequestJournal(input);
    this.prReconciledNoMatch = false;
    this.pullRequestJournalView();
    let created;
    let alreadyExists = false;
    try {
      created = await this.client.request("pull-request", input);
    } catch (error) {
      if (error.pullRequest) {
        created = error.pullRequest;
        alreadyExists = true;
      } else {
        if (!error.ambiguous) clearPullRequestJournal();
        this.pullRequestJournalView();
        throw error;
      }
    }
    if (alreadyExists) {
      clearPullRequestJournal();
      this.pullRequestJournalView();
      details.querySelector("[data-pr-result]").innerHTML =
        `<p>An existing ${created.draft ? "draft " : ""}pull request <a href="${html(created.url)}" target="_blank" rel="noopener noreferrer">#${created.number}</a> already covers this head and base. No duplicate was created.</p>`;
      this.status(
        `Existing pull request #${created.number} found. No duplicate was created; local source is unchanged.`,
      );
      return;
    }
    completePullRequestJournal(journal, created);
    details.querySelector("[data-pr-result]").innerHTML =
      `<p>Draft pull request <a href="${html(created.url)}" target="_blank" rel="noopener noreferrer">#${created.number}</a> is ready for GitHub review and CI.</p>`;
    clearPullRequestJournal();
    this.pullRequestJournalView();
    this.status(
      `Draft pull request #${created.number} created. Local source is unchanged.`,
    );
  }
  async reconcilePullRequest() {
    const raw = rawPullRequestJournal(),
      journal = readPullRequestJournal();
    if (!journal)
      throw new Error("There is no pull request operation to reconcile.");
    const { found } = await this.client.request("pull-request-status", journal);
    if (rawPullRequestJournal() !== raw) {
      this.prReconciledNoMatch = false;
      this.pullRequestJournalView();
      this.status(
        "Pull request recovery changed in another tab while reconciling. No result was applied; reconcile the current recovery.",
      );
      return;
    }
    if (found) {
      this.prReconciledNoMatch = false;
      completePullRequestJournal(journal, found);
      this.pullRequestJournalView();
      this.status(
        `Reconciliation found pull request #${found.number}. No duplicate was created.`,
      );
      return;
    }
    this.prReconciledNoMatch = raw;
    this.pullRequestJournalView();
    this.status(
      "Reconciliation found no pull request with the exact reviewed title, repository, head, base, SHAs, and creation time. Nothing was retried; check GitHub and reconcile again before clearing recovery.",
    );
  }
  journalView() {
    const area = this.querySelector("[data-journal]");
    if (!area) return;
    let journal;
    try {
      journal = readPublishJournal();
    } catch (error) {
      area.innerHTML = `<h2>Publish journal needs attention</h2><p role="alert">${html(error.message)}</p><button data-journal-download>Download original Publish journal</button><button data-journal-clear disabled>Clear downloaded Publish journal</button>`;
      const download = area.querySelector("[data-journal-download]"),
        clear = area.querySelector("[data-journal-clear]");
      download.onclick = () => {
        this.emit("publish-download", {
          content: rawPublishJournal() || "",
          name: "readme-studio-publish-journal-recovery.json",
          type: "application/json",
        });
        clear.disabled = false;
      };
      clear.onclick = () => {
        clearPublishJournal();
        this.retrySessionChangeSetId = null;
        this.journalView();
        this.status(
          "Downloaded Publish journal cleared. Publishing can continue after a fresh review.",
        );
      };
      return;
    }
    if (!journal) {
      area.replaceChildren();
      return;
    }
    const rows = journal.entries
      .map((entry) => `<li>${html(entry.path)}: ${html(entry.status)}</li>`)
      .join("");
    const retryable =
      this.retrySessionChangeSetId === journal.changeSetId &&
      this.changeSet?.id === journal.changeSetId &&
      journal.entries.some((entry) => entry.status === "not-written") &&
      journal.entries.every((entry) =>
        ["written", "not-written", "no-write"].includes(entry.status),
      );
    const settled = journal.entries.every((entry) =>
      ["written", "not-written", "diverged", "no-write"].includes(entry.status),
    );
    area.innerHTML = `<h2>Publish journal</h2><p>${html(journal.target.repository)} · ${html(journal.target.branch)} · change set ${html(shortChangeSetId(journal.changeSetId))}. Remote writes are never retried until this journal is reconciled.</p><ol>${rows}</ol><button data-reconcile>Reconcile with GitHub</button>${retryable ? `<label class="check"><input type="checkbox" data-retry-confirm> I reviewed the reconciled files and approve retrying only files marked not-written.</label><button data-retry disabled>Retry reconciled files</button>` : ""}${settled ? "<button data-journal-dismiss>Clear reconciled journal and review fresh</button>" : ""}`;
    area.querySelector("[data-reconcile]").onclick = () =>
      this.run(() => this.reconcileJournal());
    const confirm = area.querySelector("[data-retry-confirm]"),
      retry = area.querySelector("[data-retry]");
    if (confirm && retry) {
      confirm.onchange = () => (retry.disabled = !confirm.checked);
      retry.onclick = () => this.run(() => this.retryReconciled());
    }
    area
      .querySelector("[data-journal-dismiss]")
      ?.addEventListener("click", () => {
        clearPublishJournal();
        this.retrySessionChangeSetId = null;
        this.journalView();
        this.status(
          "Reconciled Publish journal cleared. Load GitHub again and review a fresh change set before writing.",
        );
      });
  }
  async reconcileJournal() {
    const journal = readPublishJournal();
    if (!journal) throw new Error("There is no Publish journal to reconcile.");
    const remotes = {};
    for (const entry of journal.entries) {
      if (entry.action === "unchanged") continue;
      remotes[entry.path] = await this.client.request("read", {
        ...journal.target,
        path: entry.path,
        ...(entry.kind === "readme" ? {} : { kind: entry.kind }),
      });
    }
    const reconciled = reconcilePublishJournal(journal, remotes);
    savePublishJournal(reconciled);
    this.journalView();
    if (reconciled.entries.some((entry) => entry.status === "diverged"))
      this.status(
        "Reconciliation found remote content different from both the Base and Result SHA. Nothing was retried; load and review a fresh change set.",
      );
    else if (reconciled.entries.some((entry) => entry.status === "not-written"))
      this.status(
        this.retrySessionChangeSetId === reconciled.changeSetId
          ? "Reconciliation is complete. Only files marked not-written can be retried, after a new explicit approval."
          : "Reconciliation is complete. This page no longer has the reviewed content, so retry is unavailable; clear the reconciled journal, load GitHub and review a fresh change set.",
      );
    else {
      const primary = reconciled.entries.at(-1),
        remote = remotes[primary.path];
      if (primary.status === "written" && remote?.commitSha)
        this.reconciledPublished({
          ...reconciled.target,
          path: primary.path,
          commitSha: remote.commitSha,
          previousCommitSha: reconciled.baseCommitSha,
        });
      else {
        clearPublishJournal();
        this.retrySessionChangeSetId = null;
        this.journalView();
        this.status(
          "Reconciliation is complete. No remote write remains unknown.",
        );
      }
    }
  }
  async retryReconciled() {
    const journal = readPublishJournal(),
      confirm = this.querySelector("[data-retry-confirm]");
    if (
      !journal ||
      this.retrySessionChangeSetId !== journal.changeSetId ||
      journal.changeSetId !== this.changeSet?.id ||
      !confirm?.checked
    )
      throw new Error(
        "Reconcile and explicitly approve this exact change set before retrying.",
      );
    const onlyPaths = new Set(
      journal.entries
        .filter((entry) => entry.status === "not-written")
        .map((entry) => entry.path),
    );
    if (!onlyPaths.size)
      throw new Error("No reconciled file is eligible for retry.");
    const outcome = await executeChangeSet(
      this.changeSet,
      changeSetContents(this.changeFiles),
      (op, data) => this.client.request(op, data),
      {
        onlyPaths,
        beforeWrite: (entry) =>
          updatePublishJournal(this.changeSet.id, entry.path, "pending"),
        afterWrite: (entry, status, result) =>
          updatePublishJournal(
            this.changeSet.id,
            entry.path,
            status,
            result?.commitSha ? { commitSha: result.commitSha } : {},
          ),
      },
    );
    this.querySelector("[data-change-set-results]").textContent =
      outcome.results
        .map((result) => `${result.path}: ${result.status}`)
        .join(" · ");
    if (!outcome.complete) {
      this.journalView();
      this.status(
        outcome.failure.error.ambiguous
          ? "The retry response was lost. Do not retry again; reconcile the Publish journal."
          : "The retry was refused. Reconcile the Publish journal before any further attempt.",
      );
      return;
    }
    const saved = readPublishJournal(),
      primaryEntry = saved.entries.at(-1),
      primaryResult = outcome.results.find(
        (result) => result.path === primaryEntry.path && result.result,
      );
    if (primaryResult) this.published(primaryResult.result);
    else if (primaryEntry.status === "written" && primaryEntry.commitSha)
      this.reconciledPublished({
        ...saved.target,
        path: primaryEntry.path,
        commitSha: primaryEntry.commitSha,
        previousCommitSha: saved.baseCommitSha,
      });
    else {
      clearPublishJournal();
      this.retrySessionChangeSetId = null;
      this.journalView();
      this.status(
        "Reconciled files were published. Local source is unchanged.",
      );
    }
  }
  reconciledPublished(result) {
    const repo = `https://github.com/${result.repository}`,
      file = `${repo}/blob/${result.commitSha}/${result.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    this.querySelector("[data-result]").innerHTML =
      `<p>Reconciliation observed the reviewed Result SHA at branch head <code>${html(result.commitSha)}</code>. This is evidence of the remote file state, not attribution to the commit that performed the write. <a href="${html(file)}" target="_blank" rel="noopener noreferrer">View the observed file</a></p>`;
    try {
      recordPublish({ ...result, reconciled: true }, result.previousCommitSha);
      clearPublishJournal();
      this.retrySessionChangeSetId = null;
      this.historyView();
      this.status(
        "Reconciliation confirmed the reviewed Result SHA on GitHub. No duplicate write was made; local source is unchanged.",
      );
    } catch (error) {
      this.status(
        `Reconciliation confirmed the remote Result SHA, but local history could not be saved. ${error.message}`,
      );
    }
  }
  stale(remote) {
    this.latest = remote;
    // A Stale change set loses its approval; reload or merge builds a new one.
    this.approvedChangeSetId = null;
    this.staleRemote = true;
    this.changeSetView();
    const commit = this.querySelector("[data-commit]");
    if (commit) commit.disabled = true;
    const area = this.querySelector("[data-stale]");
    area.innerHTML = `<h2 tabindex="-1">Remote README changed since you loaded it</h2><details open><summary>View remote changes</summary><pre data-remote-diff></pre><label>Latest remote Markdown<textarea data-latest readonly rows="6"></textarea></label></details><button data-merge>Merge local and remote</button><button data-reload>Reload remote baseline and review local replacement</button><button data-cancel>Cancel publishing review</button><section data-conflicts></section>`;
    area.querySelector("[data-latest]").value = remote.content;
    area.querySelector("[data-remote-diff]").textContent = publishDiff(
      this.baseline.content,
      remote.content,
    ).text;
    area.querySelector("[data-merge]").onclick = () => this.mergeView();
    if (this.kind === "workflow") {
      area.querySelector("[data-merge]").hidden = true;
      area.querySelector("[data-reload]").textContent =
        "Reload workflow baseline and review generated replacement";
    }
    area.querySelector("[data-reload]").onclick = () =>
      this.run(async () => {
        this.baseline = remote;
        await this.review();
        this.status(
          "Remote baseline reloaded. Review the replacement and confirm again.",
        );
      });
    area.querySelector("[data-cancel]").onclick = () => this.invalidate();
    area.querySelector("h2").focus();
    this.status(
      "Remote README changed. No write was made. Resolve or reload and review.",
    );
  }
  mergeView() {
    const parts = mergeThreeWay(
      this.baseline.content,
      this.source,
      this.latest.content,
    );
    const area = this.querySelector("[data-conflicts]");
    area.innerHTML = `<h3>Three-way merge</h3><p>Unchanged sections and non-overlapping section edits are combined. Resolve every conflicting section, then review the final source before any write.</p>${parts.map((p, i) => (p.conflict ? `<fieldset><legend>${html(p.title)}</legend><label>Local section ${i + 1}<textarea data-local="${i}" readonly></textarea></label><label>Remote section ${i + 1}<textarea data-remote="${i}" readonly></textarea></label><label>Resolution for ${html(p.title)}<select data-resolution="${i}"><option value="">Choose resolution</option><option value="local">Use local</option><option value="remote">Use remote</option><option value="combine">Combine local then remote</option><option value="manual">Edit manually</option></select></label><label>Manual resolution ${i + 1}<textarea data-manual="${i}" rows="5"></textarea></label></fieldset>` : "")).join("")}<button data-review-merge>Review merged README</button>`;
    for (const [i, p] of parts.entries())
      if (p.conflict) {
        area.querySelector(`[data-local="${i}"]`).value = p.local;
        area.querySelector(`[data-remote="${i}"]`).value = p.remote;
        area.querySelector(`[data-manual="${i}"]`).value = p.local;
      }
    area.querySelector("[data-review-merge]").onclick = () =>
      this.run(async () => {
        const decisions = {};
        for (const el of area.querySelectorAll("[data-resolution]"))
          decisions[el.dataset.resolution] = {
            choice: el.value,
            content: area.querySelector(
              `[data-manual="${el.dataset.resolution}"]`,
            ).value,
          };
        this.source = resolveMerge(parts, decisions);
        this.baseline = this.latest;
        await this.review();
        this.status(
          "Merged source prepared. Review and confirm again. Local draft is unchanged.",
        );
        this.querySelector("[data-primary-diff] [data-after]")?.focus();
      });
  }
  async createBranch() {
    if (!this.querySelector("[data-confirm-branch]").checked)
      throw new Error("Confirm branch creation first.");
    const newBranch = this.querySelector("[data-new-branch]").value;
    target({ ...this.baseline, branch: newBranch });
    savePublishCheckpoint(this.draftId, this.originalSource);
    const result = await this.client.request("branch", {
      ...this.baseline,
      newBranch,
      confirmed: true,
    });
    this.branchBase = this.baseline.branch;
    this.branchBaseSha = this.baseline.commitSha;
    this.querySelector("[data-branch]").value = result.branch;
    this.invalidate();
    this.status(
      `Branch ${result.branch} created. Load remote README on that branch and review before committing.`,
    );
  }
}
customElements.define("publish-dialog", PublishDialog);
