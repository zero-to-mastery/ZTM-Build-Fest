import { html } from "../markdown/serialize.js";

const names = {
  "missing-document": "Missing document",
  "ambiguous-document": "Ambiguous document path",
  "missing-anchor": "Missing anchor",
  "outside-workspace": "Path leaves the workspace",
  "invalid-link": "Invalid relative link",
  "unchecked-anchor": "Anchor target was too large to check",
};

export class DocumentLinkCheck extends HTMLElement {
  configure({ report, exportSnapshot = null }) {
    this.report = report;
    this.exportSnapshot = exportSnapshot;
    const bounds = [
      report.skippedDocuments
        ? `${report.skippedDocuments} document(s) have no workspace path and were not checked.`
        : "",
      report.truncatedDocuments
        ? `${report.truncatedDocuments} document(s) were beyond the check limit.`
        : "",
      report.truncatedLinks
        ? `${report.truncatedLinks} link(s) were beyond the per-document check limit.`
        : "",
      report.truncatedIssues
        ? `${report.truncatedIssues} additional issue(s) were not displayed.`
        : "",
      report.truncatedSources
        ? `${report.truncatedSources} document source(s) exceeded the safe parsing budget and were not fully checked.`
        : "",
    ].filter(Boolean);
    this.innerHTML = `<h1 tabindex="-1">Document link check</h1>
      <p>This local, read-only check compares relative document links and anchors with the current workspace. It makes no request and changes no source.</p>
      <p><strong>${report.issues.length} unresolved</strong> of ${report.checked} checked link${report.checked === 1 ? "" : "s"} across ${report.indexedDocuments} path-aware document${report.indexedDocuments === 1 ? "" : "s"}.</p>
      ${bounds.map((message) => `<p class="hint">${html(message)}</p>`).join("")}
      ${report.issues.length ? `<ol data-issues>${report.issues.map((issue) => `<li><strong>${html(names[issue.kind] || "Unresolved link")}</strong><br><code>${html(issue.sourcePath)}</code> links to <code>${html(issue.value)}</code>${issue.targetPath ? `, resolved as <code>${html(issue.targetPath)}${issue.anchor ? `#${html(issue.anchor)}` : ""}</code>` : ""}.</li>`).join("")}</ol>` : "<p>No unresolved workspace document links or anchors were found in the checked set.</p>"}
      ${exportSnapshot !== null ? "<p>Export can continue without changing these links. Review the unresolved navigation first, or export the current source unchanged.</p><button data-export>Export current source anyway</button>" : ""}
      <p data-status role="status"></p>`;
    const button = this.querySelector("[data-export]");
    if (button)
      button.onclick = () =>
        this.dispatchEvent(
          new CustomEvent("document-link-export", {
            bubbles: true,
            detail: { snapshot: this.exportSnapshot },
          }),
        );
  }
}

customElements.define("document-link-check", DocumentLinkCheck);
