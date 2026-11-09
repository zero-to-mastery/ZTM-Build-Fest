import { analyze } from "../markdown/compatibility.js";
import { html } from "../markdown/serialize.js";
import { analyzeDocument } from "../analysis/analyze.js";
export class ReadmeHealth extends HTMLElement {
  disconnectedCallback() {
    clearTimeout(this.fallbackTimer);
    this.fallbackId = (this.fallbackId || 0) + 1;
    this.worker?.terminate();
    this.worker = null;
  }
  set draft(draft) {
    const identity = JSON.stringify([
      draft.markdown,
      draft.blocks,
      draft.metadata,
    ]);
    if (identity === this.draftIdentity && this.worker) return;
    this.draftIdentity = identity;
    this.pending = structuredClone(draft);
    if (this.workerFailed) {
      this.fallback();
      return;
    }
    if (!this.querySelector("h2"))
      this.innerHTML =
        '<h2 tabindex="-1">README Health</h2><p role="status">Analyzing README…</p>';
    if (!this.worker) {
      try {
        this.worker = new Worker(
          new URL("../markdown/health.worker.js", import.meta.url),
          { type: "module" },
        );
        this.worker.onmessage = ({ data }) => {
          this.busy = false;
          if (this.pending) {
            this.run();
            return;
          }
          if (data.error) {
            this.failure();
            return;
          }
          this.dataset.engine = data.engine?.engine || "JavaScript";
          this.engineStatus = data.engine;
          this.display(data.result.analysis);
          this.completedSource = this.analyzedSource;
          const warnings = data.result.warnings;
          if (navigator.onLine === false)
            warnings.push(
              "Remote preview media may be unavailable offline. Local editing and export still work.",
            );
          if (warnings.length)
            this.insertAdjacentHTML(
              "beforeend",
              `<section class="health-group"><h3>Import suggestions</h3>${warnings.map((w) => `<p class="issue">${html(w)}</p>`).join("")}</section>`,
            );
        };
        this.worker.onerror = (event) => {
          event.preventDefault();
          this.busy = false;
          this.worker?.terminate();
          this.worker = null;
          this.fallback();
        };
      } catch {
        this.fallback();
        return;
      }
    }
    if (!this.busy) this.run();
  }
  run() {
    this.busy = true;
    this.analyzedSource = this.pending.markdown;
    this.lastDraft = this.pending;
    try {
      this.worker.postMessage(this.pending);
    } catch {
      this.fallback();
    }
    this.pending = null;
  }
  fallback() {
    const id = (this.fallbackId = (this.fallbackId || 0) + 1);
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    const draft = this.pending || this.lastDraft;
    this.pending = null;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(async () => {
      if (!this.isConnected || !draft) return;
      try {
        const { analyzeDraft } = await import("../markdown/health-analysis.js");
        if (!this.isConnected || id !== this.fallbackId) return;
        this.analyzedSource = draft.markdown;
        this.dataset.engine = "JavaScript";
        this.display(analyzeDraft(draft).analysis);
        this.completedSource = this.analyzedSource;
        this.insertAdjacentHTML(
          "beforeend",
          '<p role="status">Worker unavailable. Analysis completed locally with JavaScript; large documents may pause briefly.</p>',
        );
      } catch {
        this.failure();
      }
    }, 50);
  }
  failure() {
    this.innerHTML =
      '<h2>README Health</h2><p role="status">Health analysis is unavailable. Your Markdown is preserved and export still works.</p>';
  }
  set value(markdown) {
    try {
      this.analyzedSource = markdown;
      this.display({ ...analyze(markdown), detail: analyzeDocument(markdown) });
      this.completedSource = this.analyzedSource;
    } catch {
      this.failure();
    }
  }
  display(a) {
    const focused = this.contains(document.activeElement);
    const focusedIssue = focused ? document.activeElement.dataset.jumpId : null;
    if (a.detail) {
      this.analysis = a;
      const views = [
        "Overview",
        "Accessibility",
        "Compatibility",
        "Structure",
        "Layout",
        "Clutter",
        "Security",
      ];
      const view = this.view || "Overview";
      const allIssues = a.detail.issues.filter(
        (i) => view === "Overview" || i.category === view,
      );
      const issues = allIssues.slice(0, this.issueLimit || 100);
      this.innerHTML = `<h2 tabindex="-1">README Health</h2><p class="hint">Suggestions, not a score. Analysis stays local and makes no network requests.</p>${a.languageAwareness ? `<p class="issue"><strong>Language-sensitive guidance — Unknown (${html(a.languageAwareness.locale)})</strong>. ${html(a.languageAwareness.detail)}</p>` : ""}<button data-action="compatibility">GitHub Compatibility</button><button data-action="refactors">Safe refactors</button><label>Analysis view<select data-view>${views.map((v) => `<option ${v === view ? "selected" : ""}>${v}</option>`).join("")}</select></label><div class="stats">${Object.entries(
        a.detail.stats,
      )
        .map(([key, value]) => `<span><b>${value}</b> ${html(key)}</span>`)
        .join(
          "",
        )}</div><p class="hint">Heuristics are advisory. Source locations marked approximate may include surrounding content.</p>${issues.map((i, index) => `<section class="health-group"><h3>${html(i.category)} · ${html(i.severity)}</h3><p>${html(i.message)}</p><p class="hint">${html(i.reason)}</p>${i.sourceRange ? `<button data-jump="${index}">Go to ${i.sourceRange.approximate ? "approximate " : ""}line ${i.sourceRange.line}, column ${i.sourceRange.column}</button>` : ""}</section>`).join("") || "<p>No suggestions in this view.</p>"}${allIssues.length > issues.length ? `<button data-more>Show more findings (${issues.length} of ${allIssues.length})</button>` : ""}<details><summary>Section inventory (first 100 of ${a.detail.sections.length})</summary>${a.detail.sections
        .slice(0, 100)
        .map(
          (s) =>
            `<p>${html(s.title)}: ${s.words} words, ${s.imageCount} images, ${s.badgeCount} badges, ${s.linkCount} links, ${s.codeCount} code blocks</p>`,
        )
        .join(
          "",
        )}</details><details><summary>Additional builder and import guidance</summary>${a.issues
        .slice(0, 100)
        .map(
          (i) =>
            `<p class="issue">${html(i.message.replace("Clutter suggestions: ", ""))}</p>`,
        )
        .join("")}</details>`;
      this.querySelector("[data-view]").onchange = (e) => {
        this.view = e.target.value;
        this.issueLimit = 100;
        this.display(a);
        this.querySelector("[data-view]").focus();
      };
      const more = this.querySelector("[data-more]");
      if (more)
        more.onclick = () => {
          this.issueLimit = (this.issueLimit || 100) + 100;
          this.display(a);
          this.querySelector("[data-more]")?.focus();
        };
      this.querySelectorAll("[data-jump]").forEach(
        (b) =>
          (b.onclick = () =>
            this.dispatchEvent(
              new CustomEvent("analysis-jump", {
                bubbles: true,
                detail: {
                  source: this.analyzedSource,
                  sourceRange: issues[Number(b.dataset.jump)].sourceRange,
                },
              }),
            )),
      );
      this.querySelectorAll("[data-jump]").forEach((button) => {
        button.dataset.jumpId = issues[Number(button.dataset.jump)].id;
      });
      if (focused) {
        const target =
          focusedIssue &&
          [...this.querySelectorAll("[data-jump]")].find(
            (button) => button.dataset.jumpId === focusedIssue,
          );
        (target || this.querySelector("[data-view]")).focus({
          preventScroll: true,
        });
      }
      return;
    }
    this.innerHTML = `<h2 tabindex="-1">README Health</h2><p class="hint">Suggestions, not a score. Your content stays yours.</p><div class="stats"><span><b>${a.words}</b> words</span><span><b>${a.images.length}</b> images</span><span><b>${a.codeBlocks}</b> code blocks</span><span><b>${(a.bytes / 1024).toFixed(1)}</b> KB</span></div>${[
      "Accessibility",
      "Compatibility",
      "Layout",
      "Structure",
      "Content density",
      "Projects",
    ]
      .map(
        (c) =>
          `<section class="health-group"><h3>${c === "Content density" ? "Clutter suggestions" : c}</h3>${
            a.issues
              .filter((i) => i.category === c)
              .map(
                (i) =>
                  `<p class="issue">${html(i.message.replace("Clutter suggestions: ", ""))}</p>`,
              )
              .join("") || '<p class="healthy">✓ No suggestions</p>'
          }</section>`,
      )
      .join("")}`;
    if (focused) this.querySelector("h2").focus({ preventScroll: true });
  }
}
customElements.define("readme-health", ReadmeHealth);
