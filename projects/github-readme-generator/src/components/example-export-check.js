import { html } from "../markdown/serialize.js";

export class ExampleExportCheck extends HTMLElement {
  configure({ report, action, snapshot }) {
    const issueCount = (kind) =>
      report.issues.filter((issue) => issue.kind === kind).length;
    const unclassified = issueCount("unclassified");
    const orphaned = issueCount("orphan-marker");
    const duplicated = issueCount("duplicate-marker");
    const unbound = issueCount("unbound-marker");
    const stale = issueCount("stale-provenance");
    this.innerHTML = `<h1 tabindex="-1">Review example provenance</h1>
      <p>This local check reads provenance markers only. It never runs commands, code, tests or imported source.</p>
      <p><strong>${report.counts.placeholder} placeholder${report.counts.placeholder === 1 ? "" : "s"}</strong> · ${report.counts["user-confirmed"]} user-confirmed · ${report.counts.verified} verified</p>
      ${report.issues.some((issue) => issue.kind === "invalid-marker") ? '<p class="hint">One or more provenance markers are not recognized.</p>' : ""}
      ${unclassified ? `<p class="hint"><strong>${html(unclassified)} unclassified example${unclassified === 1 ? "" : "s"}</strong> need a provenance marker.</p>` : ""}
      ${orphaned ? `<p class="hint">${html(orphaned)} provenance marker${orphaned === 1 ? " is" : "s are"} not attached to an example.</p>` : ""}
      ${duplicated ? `<p class="hint">${html(duplicated)} example${duplicated === 1 ? " has" : "s have"} duplicate provenance markers.</p>` : ""}
      ${unbound ? `<p class="hint">${html(unbound)} verified or user-confirmed marker${unbound === 1 ? " is" : "s are"} not bound to its example content.</p>` : ""}
      ${stale ? `<p class="hint"><strong>${html(stale)} stale provenance claim${stale === 1 ? "" : "s"}</strong> no longer match the example content.</p>` : ""}
      ${report.truncatedSource ? '<p class="hint">This source exceeds the 750,000-byte review limit.</p>' : ""}
      ${report.truncatedMarkers ? `<p class="hint">${html(report.truncatedMarkers)} marker(s) were beyond the review limit.</p>` : ""}
      <p>Continue only if the reported placeholder or unclassified examples are intentional. The Markdown stays byte-for-byte unchanged.</p>
      <button data-continue>${action === "copy" ? "Copy" : "Export"} current source anyway</button>
      <p data-status role="status"></p>`;
    this.querySelector("[data-continue]").onclick = () =>
      this.dispatchEvent(
        new CustomEvent("example-export-continue", {
          bubbles: true,
          detail: { snapshot },
        }),
      );
  }
}

customElements.define("example-export-check", ExampleExportCheck);
