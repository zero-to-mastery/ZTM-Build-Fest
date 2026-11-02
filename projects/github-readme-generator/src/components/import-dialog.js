import { sourceDiffMarkup, fillSourceDiff } from "./source-diff.js";
import { html } from "../markdown/serialize.js";
import { importSummary } from "../markdown/import-summary.js";
import { compareSections, duplicateWarnings } from "../markdown/merge.js";
import { importGithub, IMPORT_LIMIT, sourceChange } from "../state/import.js";
import { validateDraft } from "../state/drafts.js";
import {
  draftSnapshot,
  importPlan,
  contextResolver,
  importedDraft,
} from "../state/import-plan.js";

export class ImportDialog extends HTMLElement {
  set draft(value) {
    this.current = structuredClone(value);
    this.snapshot = draftSnapshot(value);
    this.mode = "new";
    this.source = "github";
    this.draw();
  }
  disconnectedCallback() {
    this.cancel();
  }
  cancel() {
    this.requestId = (this.requestId || 0) + 1;
    this.controller?.abort();
  }
  draw() {
    this.innerHTML = `<h1>Import README</h1><p>Review first. Your original Markdown stays intact.</p><nav aria-label="Import source">${["github", "local", "backup"].map((s) => `<button type="button" data-source="${s}" aria-pressed="${s === this.source}">${{ github: "GitHub", local: "Local file", backup: "Studio backup" }[s]}</button>`).join("")}</nav><label>Import mode<select name="mode" aria-label="Import mode"><option value="new">New draft</option><option value="replace">Replace current draft</option><option value="append">Append to current draft</option><option value="merge">Merge into current draft</option></select></label>${this.source === "github" ? '<form id="github-import"><label>GitHub username or owner/repository<input name="repository" placeholder="octocat or owner/repository" required></label><button class="primary">Preview import</button><p class="hint">Public repositories only. Remote preview images contact their hosts.</p></form>' : `<label>${this.source === "backup" ? "Studio draft (.json)" : "README.md or text file"}<input id="file-import" type="file" accept="${this.source === "backup" ? ".json" : ".md,.markdown,.txt"}"></label>`}<p class="import-result" role="status"></p><div class="import-review"></div>`;
    this.querySelector("[name=mode]").value = this.mode;
    this.querySelector("[name=mode]").onchange = (e) => {
      this.mode = e.target.value;
      if (this.payload) this.summary();
    };
    this.querySelectorAll("[data-source]").forEach(
      (b) =>
        (b.onclick = () => {
          this.cancel();
          this.payload = null;
          this.source = b.dataset.source;
          this.draw();
          this.querySelector(`[data-source="${this.source}"]`).focus();
        }),
    );
    const form = this.querySelector("form");
    if (form)
      form.onsubmit = (e) => {
        e.preventDefault();
        this.fetch(form.elements.repository.value);
      };
    if (form)
      form.elements.repository.oninput = () => {
        this.cancel();
        this.payload = null;
        this.querySelector(".import-review").replaceChildren();
        this.status("");
      };
    const input = this.querySelector("[type=file]");
    if (input)
      input.onchange = async () => {
        this.cancel();
        const id = this.requestId;
        const file = input.files[0];
        if (!file) return;
        this.payload = null;
        this.querySelector(".import-review").replaceChildren();
        this.status("Reading file…");
        try {
          if (file.size > IMPORT_LIMIT)
            throw new Error("Choose a file smaller than 2 MB.");
          const markdown = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(await file.arrayBuffer());
          if (id !== this.requestId) return;
          this.payload =
            this.source === "backup"
              ? validateDraft(JSON.parse(markdown))
              : { name: file.name, markdown, metadata: {} };
          this.status("");
          this.summary();
        } catch (e) {
          if (id === this.requestId) this.status(e.message);
        }
      };
  }
  status(message) {
    this.querySelector(".import-result").textContent = message;
  }
  async fetch(input) {
    this.cancel();
    const id = this.requestId;
    this.controller = new AbortController();
    this.payload = null;
    this.querySelector(".import-review").replaceChildren();
    this.status("Fetching README…");
    try {
      const payload = await importGithub(input, fetch, this.controller.signal);
      if (id !== this.requestId) return;
      this.payload = payload;
      this.status(
        sourceChange(
          this.current.metadata?.importSource,
          payload.metadata.importSource,
        ) || "README found",
      );
      this.summary();
    } catch (e) {
      if (id === this.requestId) this.status(e.message);
    }
  }
  reimport() {
    const s = this.current.metadata.importSource;
    this.mode = "merge";
    this.querySelector("[name=mode]").value = "merge";
    this.querySelector("[name=repository]").value =
      `${s.owner}/${s.repository}`;
    this.fetch(`${s.owner}/${s.repository}`);
  }
  summary() {
    const p = this.payload,
      a = importSummary(p.markdown),
      sections = a.sections;
    const review = this.querySelector(".import-review");
    review.innerHTML = `<h2 tabindex="-1">README found</h2><p>${html(p.name)} · ${p.metadata?.importSource ? "GitHub" : this.source === "backup" ? "Studio backup" : "Local file"} · ${(a.bytes / 1024).toFixed(1)} KB</p><p>${a.headings.length} headings · ${a.images.length} images · ${a.linkCount} links · ${a.images.filter((i) => /shields\.io|badge/i.test(i.url)).length} badge-like images · ${a.codeBlocks} code blocks · ${a.details} details sections</p><p>Suggested sections: ${sections.map((s) => `${html(s.title)} (${s.kind})`).join(", ")}</p>${duplicateWarnings(
      p.markdown,
      p.metadata?.importSource,
    )
      .map((w) => `<p class="hint">${html(w)}</p>`)
      .join(
        "",
      )}<p class="hint">Classification is advisory. Imported sections remain Custom Markdown. Splitting and merging retain source text; new joins may add blank lines. Merging a backup produces raw sections.</p><div class="merge-body"></div>`;
    if (this.mode === "merge") this.merge();
    else {
      const body = this.querySelector(".merge-body");
      body.innerHTML = `${this.mode === "replace" ? '<label class="check"><input type="checkbox" id="confirm-replace"> I confirm replacing the current draft</label>' : ""}<details><summary>Original Markdown</summary><pre class="source-review">${html(p.markdown)}</pre></details><button class="primary" id="apply-import">${{ new: "Import as new draft", replace: "Replace current draft", append: "Append to current draft" }[this.mode]}</button>`;
      const planned = importPlan(this.current, p, this.mode);
      const difference = document.createElement("details");
      difference.innerHTML =
        "<summary>Review source changes</summary>" + sourceDiffMarkup();
      body.prepend(difference);
      fillSourceDiff(
        difference,
        this.mode === "new" ? "" : this.current.markdown,
        planned.markdown,
      );
      body.querySelector("button").onclick = () => {
        if (
          this.mode === "replace" &&
          !this.querySelector("#confirm-replace").checked
        ) {
          this.status("Confirm replacing the current draft before applying.");
          this.querySelector("#confirm-replace").focus();
          return;
        }
        this.apply(importPlan(this.current, p, this.mode));
      };
    }
    review.querySelector("h2").focus();
  }
  merge() {
    this.comparison = compareSections(
      this.current.markdown,
      this.payload.markdown,
      {
        currentContext: contextResolver(this.current),
        importedContext: contextResolver(importedDraft(this.payload)),
      },
    );
    this.decisions = this.comparison.imported.map(() => ({
      action: "",
      target: "end",
    }));
    this.choices();
  }
  choices() {
    const c = this.comparison,
      body = this.querySelector(".merge-body");
    body.innerHTML = `<div class="merge-columns"><section><h3>CURRENT README</h3>${c.current.map((s, i) => `<details open><summary>${i + 1}. ${html(s.title)}</summary><pre class="source-review">${html(s.source)}</pre></details>`).join("")}</section><section><h3>IMPORTED README</h3>${c.matches.map((m, i) => `<article class="merge-section"><h4>${i + 1}. ${html(m.section.title)}</h4><pre class="source-review">${html(m.section.source)}</pre><p>${m.ambiguous ? "Ambiguous: multiple possible matches. " : ""}${m.candidates.map((x) => `${x.index + 1}. ${html(c.current[x.index].title)}: ${x.reasons.join("; ")}`).join("<br>") || "No suggested match. Choose where to insert, or keep current."}</p><label>Action for imported section ${i + 1}<select data-choice="${i}" aria-label="Action for imported section ${i + 1}"><option value="">Choose an action</option><option value="keep">Keep current (skip this import section)</option><option value="use">Use imported</option><option value="after">Append imported after current</option><option value="before">Insert imported before current</option></select></label><label>Target for imported section ${i + 1}<select data-target="${i}" aria-label="Target for imported section ${i + 1}"><option value="end">End of document</option>${c.current.map((s, j) => `<option value="${j}">${j + 1}. ${html(s.title)}</option>`).join("")}</select></label></article>`).join("")}</section></div><button id="review-merge" class="primary">Review merge</button>`;
    body.querySelectorAll("[data-choice]").forEach((el) => {
      const i = Number(el.dataset.choice);
      el.value = this.decisions[i].action;
      el.onchange = () => (this.decisions[i].action = el.value);
    });
    body.querySelectorAll("[data-target]").forEach((el) => {
      const i = Number(el.dataset.target);
      el.value = this.decisions[i].target;
      el.onchange = () =>
        (this.decisions[i].target =
          el.value === "end" ? "end" : Number(el.value));
    });
    body.querySelector("#review-merge").onclick = () => {
      try {
        const plan = importPlan(this.current, this.payload, "merge", {
          comparison: c,
          decisions: this.decisions,
        });
        this.status(
          sourceChange(
            this.current.metadata?.importSource,
            this.payload.metadata?.importSource,
          ) || "Merge ready for review",
        );
        body.innerHTML = `<h3 tabindex="-1">Resulting Markdown</h3><pre class="source-review">${html(plan.markdown)}</pre>${sourceDiffMarkup()}<button id="merge-back">Back</button><button id="merge-apply" class="primary">Apply merge</button>`;
        fillSourceDiff(body, this.current.markdown, plan.markdown);
        body.querySelector("h3").focus();
        body.querySelector("#merge-back").onclick = () => {
          this.choices();
          this.querySelector("[data-choice]")?.focus();
        };
        body.querySelector("#merge-apply").onclick = () => this.apply(plan);
      } catch (e) {
        this.status(e.message);
        body.querySelector("[data-choice]")?.focus();
      }
    };
  }
  apply(plan) {
    this.dispatchEvent(
      new CustomEvent("import-apply", {
        bubbles: true,
        detail: {
          plan,
          mode: this.mode,
          // Where the import came from, for the Next steps context only.
          origin: this.source === "github" ? "github" : "file",
          name: this.payload.name,
          snapshot: this.snapshot,
        },
      }),
    );
  }
}
customElements.define("import-dialog", ImportDialog);
