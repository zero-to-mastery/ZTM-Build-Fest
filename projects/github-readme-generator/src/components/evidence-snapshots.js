import { html } from "../markdown/serialize.js";
import {
  documentSnapshots,
  differentTarget,
  snapshotSummary,
  DOCUMENT_RETENTION,
  WORKSPACE_RETENTION,
} from "../workspace/evidence-snapshots.js";
import { driftStatuses, ANCHOR_FILE_LIMIT } from "../workspace/drift-check.js";
import {
  driftProposals,
  previewDriftChanges,
  convertsBuilder,
} from "../workspace/drift-remediation.js";
import { sourceDiffMarkup, fillSourceDiff } from "./source-diff.js";

const short = (sha) => (sha ? sha.slice(0, 7) : "");
const kinds = {
  readme: "README",
  manifest: "Manifest",
  lockfile: "Lockfile",
  linked: "Linked file",
};
const statuses = {
  captured: "Captured",
  missing: "Missing on GitHub",
  failed: "Unknown (not read)",
  unchanged: "Unchanged",
  changed: "Changed",
  added: "Added",
  removed: "Removed",
  unknown: "Unknown",
};
const driftGroups = {
  mismatch: "Observed mismatches",
  uncertain: "Uncertain findings",
  unknown: "Unknown — not checked",
  matches: "Matches",
};
const categories = {
  command: "Command",
  path: "Path",
  link: "Link",
  config: "Config",
};
const since = {
  changed: "Changed since Baseline.",
  unchanged: "Unchanged since Baseline.",
  added: "Added since Baseline.",
  removed: "Removed since Baseline.",
  unknown: "Baseline comparison unknown.",
};
const when = (iso) => new Date(iso).toLocaleString();
const targetText = (t) =>
  `${html(t.repository)} · branch ${html(t.branch)} · ${html(t.path)}`;

export class EvidenceSnapshots extends HTMLElement {
  disconnectedCallback() {
    this.controller?.abort();
  }
  configure({ draft, target, snapshots, storageBlocked = false }) {
    this.state = { draft, target, snapshots, storageBlocked };
    // Re-rendering drops any Drift check result, so its proposals go too.
    this.drift = null;
    this.changes = null;
    const items = documentSnapshots(snapshots, draft.id);
    // The status live region is created once and never re-rendered, so an
    // outcome written right after a refresh is still announced.
    if (!this.querySelector(":scope > [data-status]"))
      this.innerHTML =
        '<div data-head></div><p data-status role="status"></p><div data-body></div>';
    this.querySelector("[data-head]").innerHTML =
      `<h1>Evidence snapshots</h1><p>An evidence snapshot records what GitHub reports for this document's repository at one moment: the branch head commit, the README revision, recognised manifests and lockfiles, and files your Markdown links to by relative path, plus a fingerprint of your local Markdown. Capture and change checks only read public GitHub data. They never change your Markdown or write to GitHub.</p>
      ${
        target
          ? `<p data-target-line>Target: ${targetText(target)}</p><p>A drift check compares commands, paths, links and config keys in your Markdown with the repository now. It reads the tree plus at most package.json, one .env example and ${ANCHOR_FILE_LIMIT} linked Markdown files (256 KB each). Nothing is run, saved or written.</p><button class="primary" data-capture>Capture evidence snapshot</button><button data-drift-run>Run drift check</button>`
          : `<p data-target-line>This document has no repository, branch and README path target, so it cannot be captured. Saved snapshots remain readable.</p><button data-set-target>Set document target</button>`
      }<button data-cancel hidden>Cancel</button>
      ${storageBlocked ? '<p role="alert">Storage recovery is active. Snapshots can be viewed and checked, but capture, Baseline and delete need restored workspace storage.</p>' : ""}`;
    this.querySelector("[data-body]").innerHTML =
      `<section data-drift hidden aria-label="Drift check result"></section><section data-fixes hidden aria-label="Review drift fixes"></section><h2>Saved snapshots (${items.length})</h2>
      <p class="hint">Kept in this browser and in all-drafts backups, not in Studio projects or README exports. Retention keeps each document's newest ${DOCUMENT_RETENTION} snapshots plus its Baseline, up to ${WORKSPACE_RETENTION} in this workspace; a Baseline is never removed automatically.</p>
      ${
        items.length
          ? `<ol data-snapshots>${items.map((item, index) => this.item(item, index)).join("")}</ol>`
          : "<p data-empty>No evidence snapshots for this document yet. Capture one to record the repository's current evidence.</p>"
      }
      <section data-check hidden aria-label="Change check result"></section>`;
    this.querySelector("[data-capture]")?.addEventListener("click", () =>
      this.send("capture"),
    );
    this.querySelector("[data-drift-run]")?.addEventListener("click", () =>
      this.send("drift"),
    );
    this.querySelector("[data-set-target]")?.addEventListener("click", () =>
      this.send("target"),
    );
    this.querySelector("[data-cancel]").onclick = () =>
      this.controller?.abort();
    this.querySelectorAll("[data-snapshot-action]").forEach(
      (button) =>
        (button.onclick = () =>
          this.send(button.dataset.snapshotAction, button.dataset.id)),
    );
  }
  item(item, index) {
    const summary = snapshotSummary(item, this.state.draft.markdown);
    const different = differentTarget(item, this.state.target);
    const id = html(item.id),
      heading = `evidence-${index}`;
    const labels = [
      item.baseline && "Baseline",
      summary.partial && "Partial snapshot",
      different && "Different target",
      summary.sourceEdited
        ? "Markdown edited since capture"
        : "Markdown unchanged since capture",
    ].filter(Boolean);
    const readme =
      summary.readme.status === "captured"
        ? `README revision ${short(summary.readme.sha)}`
        : summary.readme.status === "missing"
          ? "README missing on GitHub"
          : "README revision unknown";
    const described = `aria-describedby="${heading}"`,
      blocked = different ? "data-blocked disabled" : "";
    return `<li data-snapshot="${id}"><h3 id="${heading}">Snapshot captured ${html(when(item.capturedAt))}</h3>
      <p data-labels>${labels.map((label) => `<span class="evidence-label">${label}</span>`).join(" ")}</p>
      <p>Branch head ${short(item.head)} · ${readme} · ${summary.captured} captured · ${summary.missing} missing · ${summary.failed} unknown</p>
      ${different ? `<p>Captured for ${targetText(item.target)}. It cannot be the Baseline or be used for a change check.</p>` : ""}
      ${item.notes.length ? `<ul>${item.notes.map((note) => `<li>${html(note)}</li>`).join("")}</ul>` : ""}
      ${summary.failed ? "<p>Unknown entries could not be read. They are not treated as drift.</p>" : ""}
      <details><summary>Evidence files (${item.entries.length})</summary><div class="evidence-table"><table><thead><tr><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Revision</th></tr></thead><tbody>${item.entries
        .map(
          (entry) =>
            `<tr><td>${html(entry.path)}</td><td>${kinds[entry.kind]}</td><td>${statuses[entry.status]}${entry.note ? ` — ${html(entry.note)}` : ""}</td><td>${short(entry.sha)}</td></tr>`,
        )
        .join("")}</tbody></table></div></details>
      <div class="evidence-actions">${
        item.baseline
          ? `<button data-snapshot-action="unpin" data-id="${id}" ${described}>Unpin Baseline</button>`
          : `<button data-snapshot-action="pin" data-id="${id}" ${described} ${blocked}>Pin as Baseline</button>`
      }<button data-snapshot-action="check" data-id="${id}" ${described} ${blocked}>Run change check</button><button data-snapshot-action="delete" data-id="${id}" ${described}>Delete snapshot</button></div></li>`;
  }
  showCheck(snapshot, result) {
    const section = this.querySelector("[data-check]");
    const { counts } = result;
    section.hidden = false;
    section.innerHTML = `<h2 tabindex="-1">Change check</h2><p>Compared the snapshot captured ${html(when(snapshot.capturedAt))} with GitHub now. Nothing was saved.</p>
      <p>${result.headChanged ? `Branch head changed: ${short(result.head.before)} → ${short(result.head.after)}.` : `Branch head unchanged: ${short(result.head.after)}.`}</p>
      <p data-counts>${counts.changed} changed · ${counts.added} added · ${counts.removed} removed · ${counts.unknown} unknown · ${counts.unchanged} unchanged</p>
      ${result.notes.length ? `<ul>${result.notes.map((note) => `<li>${html(note)}</li>`).join("")}</ul>` : ""}
      ${counts.unknown ? "<p>Unknown means the file could not be read in the snapshot or now. It is not reported as a change.</p>" : ""}
      <div class="evidence-table"><table><thead><tr><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Result</th><th scope="col">Snapshot</th><th scope="col">Now</th></tr></thead><tbody>${result.entries
        .map(
          (entry) =>
            `<tr data-result="${entry.status}"><td>${html(entry.path)}</td><td>${kinds[entry.kind]}</td><td>${statuses[entry.status]}${entry.status === "unknown" && entry.note ? ` — ${html(entry.note)}` : ""}</td><td>${short(entry.before)}</td><td>${short(entry.after)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
    section.querySelector("h2").focus();
  }
  // Renders a Drift check result. Every value from the repository or the
  // Markdown is escaped; findings are grouped by status so observed
  // mismatches are never mixed with heuristics or unknowns. `source` is the
  // exact Markdown that was checked; with it, findings can be turned into
  // reviewed Fix proposals for that Markdown only.
  showDrift(result, baseline = null, source = null) {
    const section = this.querySelector("[data-drift]");
    const { counts } = result;
    this.hideFixes();
    this.drift =
      typeof source === "string"
        ? { source, ...driftProposals(source, result) }
        : null;
    const fixable = this.drift?.proposals.length || 0;
    const table = (items) =>
      `<div class="evidence-table"><table><thead><tr><th scope="col">Claim</th><th scope="col">Line</th><th scope="col">Type</th><th scope="col">Evidence</th></tr></thead><tbody>${items
        .map(
          (item) =>
            `<tr data-drift-result="${item.status}"><td><code>${html(item.text)}</code></td><td>${item.line}</td><td>${categories[item.category]}</td><td>${html(item.message)}${item.baseline ? ` ${since[item.baseline]}` : ""}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
    const group = (status) => {
      const items = result.results.filter((item) => item.status === status);
      if (!items.length) return "";
      const heading = `${driftGroups[status]} (${items.length})`;
      return status === "matches"
        ? `<details data-drift-group="matches"><summary>${heading}</summary>${table(items)}</details>`
        : `<div data-drift-group="${status}"><h3>${heading}</h3>${table(items)}</div>`;
    };
    section.hidden = false;
    section.innerHTML = `<h2 tabindex="-1">Drift check</h2>
      <p>${
        result.head
          ? `Compared your Markdown with GitHub at commit ${short(result.head)}.`
          : "Checked anchors within your Markdown only; GitHub was not read."
      } Nothing was run, saved or written, and your Markdown is unchanged.</p>
      <p data-drift-counts>${counts.mismatch} observed mismatch${counts.mismatch === 1 ? "" : "es"} · ${counts.uncertain} uncertain · ${counts.unknown} unknown · ${counts.matches} match${counts.matches === 1 ? "" : "es"}</p>
      <p class="hint">Observed mismatches are contradicted by repository evidence. Uncertain findings come from heuristics and may be fine. Unknown means the evidence could not be read; it is never treated as drift.</p>
      ${result.tree && result.tree !== "complete" ? `<p data-drift-partial>The repository tree was ${result.tree === "truncated" ? "truncated by GitHub" : "not read"}, so paths it does not list are unknown.</p>` : ""}
      ${baseline ? `<p>Evidence files are also compared with the Baseline captured ${html(when(baseline.capturedAt))}.</p>` : ""}
      ${result.notes.length ? `<ul data-drift-notes>${result.notes.map((note) => `<li>${html(note)}</li>`).join("")}</ul>` : ""}
      ${fixable ? `<p>Fixing is opt-in: review a proposed edit for each line with an observed mismatch or uncertain finding, with its evidence and exact diff, and approve only the changes you want.</p><button data-fix-review>Review fixes (${fixable} line${fixable === 1 ? "" : "s"})</button>` : ""}
      ${
        result.results.length
          ? driftStatuses.map(group).join("")
          : "<p data-drift-empty>No checkable commands, paths, links or config keys were found in your Markdown.</p>"
      }`;
    section
      .querySelector("[data-fix-review]")
      ?.addEventListener("click", () => this.reviewFixes());
    section.querySelector("h2").focus();
  }
  // Hides the last Drift check result and any Fix review. A new run starts
  // from nothing, so a run that fails, is cancelled or is discarded leaves no
  // earlier result (possibly for Markdown that has since changed) on screen.
  clearDrift() {
    const section = this.querySelector("[data-drift]");
    this.drift = null;
    this.hideFixes();
    if (!section) return;
    section.hidden = true;
    section.innerHTML = "";
  }
  hideFixes() {
    this.changes = null;
    const fixes = this.querySelector("[data-fixes]");
    if (!fixes) return;
    fixes.hidden = true;
    fixes.innerHTML = "";
  }
  // Reviewed drift remediation. Each proposal edits one line and starts
  // unapproved, uncertain ones included; editing a proposed line withdraws
  // its approval. Source panes and diffs are filled as text, never parsed.
  // Applying only sends the approved changes; app-shell checks them against
  // the checked Markdown before changing anything.
  reviewFixes() {
    const section = this.querySelector("[data-fixes]");
    if (!section || !this.drift?.proposals.length) return;
    const { proposals, notes, excluded } = this.drift;
    const changes = proposals.map((proposal) => ({
      line: proposal.line,
      before: proposal.before,
      after: proposal.suggested,
      approved: false,
    }));
    const finding = (item) => {
      const suggestion = item.suggestion
        ? item.suggestion.placed
          ? ` Suggested from the evidence: <code>${html(item.suggestion.find)}</code> → <code>${html(item.suggestion.replace)}</code>.`
          : " A suggestion from the evidence could not be placed on this line unambiguously; edit the proposed line yourself."
        : " No suggestion from the evidence; edit the proposed line yourself if it needs a change.";
      return `<li data-finding="${item.status}"><span class="evidence-label">${item.status === "mismatch" ? "Observed mismatch" : "Uncertain — may be correct as written"}</span> <code>${html(item.text)}</code>: ${html(item.message)}${item.evidencePath ? ` Evidence file: ${html(item.evidencePath)}.` : ""}${item.baseline ? ` ${since[item.baseline]}` : ""}${suggestion}</li>`;
    };
    section.hidden = false;
    section.innerHTML = `<h2 tabindex="-1">Review drift fixes</h2>
      <p>Each proposal edits one line of the Markdown that was checked. Read the evidence, edit the proposed line if needed and approve each change you want. Unapproved lines stay exactly as they are. Nothing is applied until you choose Apply, and nothing is published: Publish to GitHub stays a separate step with its own review. Undo restores the previous Markdown.</p>
      ${convertsBuilder(this.state?.draft) ? '<p class="issue" data-fix-builder>Applying detaches any builder section, component or generated content whose lines change: it becomes Custom Markdown, so stale settings can no longer overwrite the fixes. Untouched sections keep their ownership. Undo restores the previous Markdown and builder ownership.</p>' : ""}
      <p class="hint">Uncertain findings may be correct as written. Unknown results and matches have no proposals${excluded ? ` (${excluded} not proposed)` : ""}. If your Markdown changes before you apply, nothing is applied.</p>
      ${notes.length ? `<ul>${notes.map((note) => `<li>${html(note)}</li>`).join("")}</ul>` : ""}
      <ol data-proposals>${proposals
        .map(
          (proposal, index) =>
            `<li data-proposal="${proposal.line}"><fieldset><legend>Line ${proposal.line}${proposal.status === "uncertain" ? " · uncertain" : ""}</legend>
            <ul>${proposal.findings.map(finding).join("")}</ul>
            <label>Current line ${proposal.line}<textarea data-fix-before rows="2" readonly></textarea></label>
            <label>Proposed line ${proposal.line}<textarea data-fix-after data-index="${index}" rows="2"></textarea></label>
            <pre data-fix-diff tabindex="0" aria-label="Change to line ${proposal.line}"></pre>
            <label class="check"><input type="checkbox" data-fix-approve data-index="${index}"> Approve this change to line ${proposal.line}</label></fieldset></li>`,
        )
        .join("")}</ol>
      <h3>All approved changes</h3>
      ${sourceDiffMarkup({ beforeLabel: "Markdown that was checked", afterLabel: "Markdown with approved changes", label: "Approved changes diff" })}
      <p data-fix-summary></p>
      <div class="evidence-actions"><button class="primary" data-fix-apply disabled>Apply approved changes</button><button data-fix-download>Download current Markdown</button><button data-fix-discard>Discard proposals</button></div>`;
    this.changes = changes;
    section.querySelectorAll("[data-proposal]").forEach((item, index) => {
      item.querySelector("[data-fix-before]").value = changes[index].before;
      item.querySelector("[data-fix-after]").value = changes[index].after;
    });
    section.querySelectorAll("[data-fix-after]").forEach(
      (field) =>
        (field.oninput = () => {
          const change = changes[Number(field.dataset.index)];
          change.after = field.value;
          change.approved = false;
          this.updateFixes();
        }),
    );
    section.querySelectorAll("[data-fix-approve]").forEach(
      (box) =>
        (box.onchange = () => {
          changes[Number(box.dataset.index)].approved = box.checked;
          this.updateFixes();
        }),
    );
    section.querySelector("[data-fix-apply]").onclick = () =>
      this.send("remediate", null, { changes: this.approvedChanges() });
    section.querySelector("[data-fix-download]").onclick = () =>
      this.send("download-markdown");
    section.querySelector("[data-fix-discard]").onclick = () => {
      this.hideFixes();
      this.status("Fix proposals discarded. Your Markdown is unchanged.");
      this.querySelector("[data-fix-review]")?.focus();
    };
    this.updateFixes();
    section.querySelector("h2").focus();
  }
  approvedChanges() {
    return (this.changes || [])
      .filter((change) => change.approved && change.after !== change.before)
      .map(({ line, before, after }) => ({ line, before, after }));
  }
  // Refreshes per-line diffs, approval boxes, the combined diff and the
  // Apply button from the current proposals.
  updateFixes() {
    const section = this.querySelector("[data-fixes]");
    if (!section || !this.changes) return;
    section.querySelectorAll("[data-proposal]").forEach((item, index) => {
      const change = this.changes[index];
      const same = change.after === change.before;
      if (same) change.approved = false;
      const box = item.querySelector("[data-fix-approve]");
      box.checked = change.approved;
      box.disabled = same;
      const lines = (text, mark) =>
        text
          .split("\n")
          .map((line) => mark + line)
          .join("\n");
      item.querySelector("[data-fix-diff]").textContent = same
        ? "No change proposed. Edit the proposed line to make one."
        : `@@ line ${change.line} @@\n${lines(change.before, "-")}\n${lines(change.after, "+")}`;
    });
    const approved = this.approvedChanges();
    let preview = this.drift.source;
    try {
      preview = previewDriftChanges(this.drift.source, approved).markdown;
    } catch {
      /* A stale change is rejected again, with a message, when applying. */
    }
    fillSourceDiff(section, this.drift.source, preview);
    const total = this.changes.length;
    section.querySelector("[data-fix-summary]").textContent =
      `${approved.length} of ${total} proposed change${total === 1 ? "" : "s"} approved.`;
    const apply = section.querySelector("[data-fix-apply]");
    apply.disabled = !approved.length || Boolean(this.working);
    apply.textContent = approved.length
      ? `Apply ${approved.length} approved change${approved.length === 1 ? "" : "s"}`
      : "Apply approved changes";
  }
  send(action, id, extra = {}) {
    this.dispatchEvent(
      new CustomEvent("evidence-action", {
        bubbles: true,
        detail: { ...extra, action, id },
      }),
    );
  }
  status(message) {
    this.querySelector("[data-status]").textContent = message;
  }
  busy(value) {
    // Pin/check stay disabled for a Different target snapshot when idle.
    this.querySelectorAll("button").forEach(
      (el) => (el.disabled = value || el.hasAttribute("data-blocked")),
    );
    // Apply stays disabled until a change is approved.
    if (!value) this.updateFixes();
    const cancel = this.querySelector("[data-cancel]");
    cancel.hidden = !value;
    cancel.disabled = false;
    if (value) cancel.focus();
  }
}
customElements.define("evidence-snapshots", EvidenceSnapshots);
