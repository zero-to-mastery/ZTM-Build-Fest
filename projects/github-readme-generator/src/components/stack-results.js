import { provenanceHTML } from "./stack-dna.js";
import { html as h } from "../markdown/serialize.js";
import {
  CONFIDENCE_BASES,
  basisExplanation,
  staleness,
  uncertainResults,
} from "../stack-intelligence/dependencies.js";
const STALE_TEXT = {
  "pushed-since": "Stale: repository pushed after this scan",
  age: "Stale: observed more than 24 hours ago",
};
const plural = (count, one, many = one + "s") =>
  `${count} ${count === 1 ? one : many}`;
// Project boundaries in display order: root, Workspace members, Nested
// projects. Records without `projects` group dependencies by their project.
function boundaries(record) {
  const projects = [...(record.projects || [])];
  for (const path of new Set(
    (record.dependencies || []).map((d) => d.project || ""),
  ))
    if (!projects.some((p) => p.path === path))
      projects.push({
        path,
        role: path ? "nested" : "root",
        declaredBy: [],
        manifests: [],
      });
  const rank = { root: 0, member: 1, nested: 2 };
  return projects.sort(
    (a, b) =>
      rank[a.role] - rank[b.role] ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
const label = (project) => (project.path ? project.path : "Repository root");
function projectList(record) {
  const projects = boundaries(record);
  const discovery = record.discovery;
  const count = (path) =>
    (record.dependencies || []).filter((d) => (d.project || "") === path)
      .length;
  const read = new Set((record.manifests || []).map((m) => m.path));
  const item = (project) =>
    `<li><strong>${h(label(project))}</strong>${project.declaredBy?.length ? ` — declared by ${h(project.declaredBy.join(", "))}` : ""} — ${plural(count(project.path), "dependency record")}<ul>${project.manifests.map((path) => `<li>${h(path)} — ${read.has(path) ? "read" : "found, not read"}</li>`).join("")}</ul></li>`;
  const group = (role, heading) => {
    const list = projects.filter((p) => p.role === role);
    return list.length
      ? `<h4>${h(heading(list))}</h4><ul data-project-group="${role}">${list.map(item).join("")}</ul>`
      : "";
  };
  const notRead = discovery ? discovery.found - discovery.read : 0;
  return `<section data-stack-projects aria-label="Project boundaries"><h3>Project boundaries</h3>${
    discovery
      ? `<p data-discovery-summary>${plural(discovery.found, "manifest")} found, ${discovery.read} read, ${notRead} not read.${discovery.nested ? ` Nested manifests included; repository tree: ${h(discovery.tree)}.` : " Root manifests only; nested manifests were not included."}</p>`
      : ""
  }${
    projects.length
      ? group("root", () => "Repository root") +
        group(
          "member",
          (list) =>
            `Workspace members (declared by ${[...new Set(list.flatMap((p) => p.declaredBy || []))].join(", ")})`,
        ) +
        group("nested", () => "Nested projects (not declared by a workspace)")
      : "<p>No project boundaries: no supported manifests were read.</p>"
  }${
    discovery?.skipped?.length
      ? `<h4>Not read — unknown</h4><ul data-not-read>${discovery.skipped.map((entry) => `<li>${h(entry.path)} — ${h(entry.reason)}</li>`).join("")}</ul>${notRead > discovery.skipped.length ? `<p>${notRead - discovery.skipped.length} more not listed.</p>` : ""}`
      : ""
  }</section>`;
}
function dependencyGroups(record) {
  const dependencies = record.dependencies || [];
  const entry = (entry) =>
    `<li><strong>${h(entry.name)}</strong> — ${h(entry.ecosystem)} · ${h(entry.kind)} · ${h(entry.repository)}<ul>${entry.evidence.map((item) => `<li>${provenanceHTML(item)}</li>`).join("")}</ul></li>`;
  const projects = boundaries(record).filter((project) =>
    dependencies.some((d) => (d.project || "") === project.path),
  );
  if (projects.length <= 1)
    return `<ul data-dependencies>${dependencies.map(entry).join("")}</ul>`;
  return projects
    .map(
      (project) =>
        `<h4>${h(label(project))}</h4><ul data-dependencies data-project="${h(project.path)}">${dependencies
          .filter((d) => (d.project || "") === project.path)
          .map(entry)
          .join("")}</ul>`,
    )
    .join("");
}
// The Confidence basis legend: each basis with its one fixed explanation.
const basisLegend = () =>
  `<section data-basis-legend aria-label="Confidence basis"><h3>Confidence basis</h3><dl>${Object.entries(
    CONFIDENCE_BASES,
  )
    .map(([basis, text]) => `<dt>${h(basis)}</dt><dd>${h(text)}</dd>`)
    .join(
      "",
    )}</dl><p class="hint">A basis names why a declaration is believed. It is not a score, and it says nothing about anyone's skill.</p></section>`;
// Uncertain stack results: conditional and ambiguous declarations with their
// explanation, and manifests found but not read. They also stay in place in
// the dependency list; this list never hides or promotes anything.
function uncertainList(record) {
  const { declarations, unread, unlisted } = uncertainResults(record);
  const count = declarations.length + unread.length + unlisted;
  return `<section data-uncertain aria-label="Uncertain stack results"><h3>Uncertain stack results (${count})</h3>${
    count
      ? `<ul data-uncertain-list>${declarations
          .map(
            (item) =>
              `<li><strong>${h(item.name)}</strong> — ${h(item.ecosystem)} · ${h(item.kind)}${item.project ? ` · ${h(item.project)}` : ""} — ${provenanceHTML(item.evidence)}<br><span class="hint">${h(basisExplanation(item.evidence.basis))}</span></li>`,
          )
          .join("")}${unread
          .map(
            (entry) =>
              `<li><strong>${h(entry.path)}</strong> — Not read — unknown: ${h(entry.reason)}</li>`,
          )
          .join(
            "",
          )}</ul>${unlisted ? `<p data-uncertain-unlisted>${plural(unlisted, "more manifest")} not read and not listed — unknown.</p>` : ""}`
      : "<p>None: every declaration read is explicit or inherited, and every manifest found was read.</p>"
  }</section>`;
}
export class StackResults extends HTMLElement {
  // `repositories` is the currently loaded repository list; its pushed_at
  // marks a result Stale. Nothing here starts a request or a timer.
  setData(records, repositories = []) {
    this.records = records;
    this.current = new Map(
      repositories.map((repo) => [String(repo.full_name).toLowerCase(), repo]),
    );
    this.page = Math.min(
      this.page || 0,
      Math.max(0, Math.ceil(records.length / 25) - 1),
    );
    this.render();
  }
  stale(record) {
    if (record.status === "failed") return [];
    return staleness(
      record,
      this.current?.get(String(record.repository).toLowerCase()),
      Date.now(),
    );
  }
  render() {
    const records = this.records || [],
      pages = Math.max(1, Math.ceil(records.length / 25));
    this.innerHTML = `<h2 tabindex="-1">Detected in selected repositories</h2><p>Direct dependency declarations are repository evidence, not developer skill or proof that a dependency runs in production. Root manifests only unless nested manifests were included for the scan. Indirect Go requirements and unused or unresolved Cargo workspace declarations are excluded. No transitive dependency resolution or executable configuration.</p><p class="hint">Each declaration shows its manifest, section, line, confidence basis and when and on which branch it was observed. Conditional and ambiguous declarations, and manifests not read, are listed as uncertain stack results. A result is Stale when the repository list shows a newer push or it was observed more than 24 hours ago.</p><p>${records.length} selected repositories with results. Results stay in this tab; no README or profile is changed.</p><stack-dna></stack-dna><div>${records
      .slice(this.page * 25, (this.page + 1) * 25)
      .map(
        (record) =>
          `<details data-stack-record="${records.indexOf(record)}"><summary>${h(record.repository)} — ${h({ read: "Manifests read", none: "No supported root manifests found", partial: "Partial results", failed: "Not assessed" }[record.status])}${this.stale(record).length ? " — Stale" : ""}</summary><div data-stack-body></div></details>`,
      )
      .join(
        "",
      )}</div><div class="audit-pagination"><button data-stack-prev ${this.page === 0 ? "disabled" : ""}>Previous stack results</button><span>Page ${this.page + 1} of ${pages}</span><button data-stack-next ${this.page + 1 >= pages ? "disabled" : ""}>Next stack results</button></div>`;
    this.querySelector("stack-dna").records = records;
    this.querySelectorAll("[data-stack-record]").forEach((details) => {
      details.ontoggle = () => {
        const body = details.querySelector("[data-stack-body]");
        if (!details.open || body.childElementCount) return;
        const record = records[Number(details.dataset.stackRecord)];
        const stale = this.stale(record);
        const failed = record.status === "failed";
        body.innerHTML = `<button data-readme-suggestions ${failed ? "disabled" : ""}>Review README suggestions</button><p>Observed: ${h(new Date(record.observedAt ?? record.checkedAt).toLocaleString())}; branch: ${h(record.ref || "unknown")}</p>${
          stale.length
            ? `<div class="stack-stale" data-stale>${stale.map((reason) => `<p><strong>${h(STALE_TEXT[reason])}</strong></p>`).join("")}<p class="hint">Stale is a reason to refresh, not a claim that anything changed. Check Fetch fresh manifests, then choose Analyze selected manifests to read the current files.</p></div>`
            : ""
        }${failed ? "" : projectList(record)}${record.issues.map((issue) => `<p class="hint">Notice: ${h(issue)}</p>`).join("")}${failed ? "" : uncertainList(record) + basisLegend()}<h3>Direct dependencies</h3><p>${record.dependencies?.length || 0} normalized dependency records. The same name in different kinds or project boundaries remains separate.</p>${dependencyGroups(record)}${record.manifests.map((manifest) => `<section><h3>${h(manifest.ecosystem)} — ${h(manifest.path)}</h3><p>Manifest present.</p>${manifest.notes.map((note) => `<p class="hint">${h(note)}</p>`).join("")}</section>`).join("")}`;
        body.querySelector("[data-readme-suggestions]").onclick = () =>
          this.dispatchEvent(
            new CustomEvent("stack-readme-review", {
              bubbles: true,
              detail: record,
            }),
          );
      };
    });
    for (const [selector, step] of [
      ["[data-stack-prev]", -1],
      ["[data-stack-next]", 1],
    ])
      this.querySelector(selector).onclick = () => {
        this.page += step;
        this.render();
        this.querySelector("h2").focus();
      };
  }
}
customElements.define("stack-results", StackResults);
