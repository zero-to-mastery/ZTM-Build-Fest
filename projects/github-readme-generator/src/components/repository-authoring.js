import {
  contextRepositories,
  filterContexts,
  repositoryContext,
  technologySuggestions,
  authorRepositories,
} from "../github/repository-context.js";
import { fetchProjects } from "../projects/github-project.js";
import { html as h, serializeBlock } from "../markdown/serialize.js";
import { render as renderMarkdown } from "../markdown/render.js";
export class RepositoryAuthoring extends HTMLElement {
  configure(draft) {
    this.draft = structuredClone(draft);
    this.repos = contextRepositories(draft);
    this.selected = new Set();
    this.draw();
  }
  disconnectedCallback() {
    this.controller?.abort();
  }
  status(message) {
    this.querySelector("[role=status]").textContent = message;
  }
  draw() {
    this.innerHTML = `<h1>Repository-aware authoring</h1><p>Use cached public data or explicitly look up a repository. Homepages are repository data, not verified live demos. No proficiency or project roles are inferred.</p>
 <label>Repository owner/name<input data-lookup placeholder="owner/repository"></label><button data-fetch>Look up public repository</button><p role="status"></p>
 <label>Search repositories<input data-filter="search"></label>
 <label>Repository language<select aria-label="Repository language" data-filter="language"><option value="">All languages</option>${[...new Set(this.repos.map((r) => r.language).filter(Boolean))].map((l) => `<option>${h(l)}</option>`).join("")}</select></label>
 <label>Repository sort<select aria-label="Repository sort" data-filter="sort"><option value="updated">Recently updated</option><option value="stars">Stars</option><option value="name">Name</option><option value="created">Created date</option></select></label>
 ${["archived", "fork"].map((k) => `<label>${k === "fork" ? "Fork" : "Archived"} filter<select aria-label="${k} filter" data-filter="${k}"><option value="any">Any</option><option value="exclude">Exclude</option><option value="only">Only</option></select></label>`).join("")}
 <div data-repos></div><p data-count></p>
 <label>Authoring action<select aria-label="Authoring action" data-action-kind><option value="list">Selected Repositories section</option><option value="projects">Add to Projects</option><option value="badges">Create repo badge group</option><option value="tech">Add tech suggestions</option><option value="link">Insert repo links</option><option value="homepage">Insert live demo links</option><option value="component">Create custom component from repo</option></select></label>
 <label>Repository list layout<select aria-label="Repository list layout" data-layout><option value="compact">Compact list</option><option value="detailed">Detailed list</option><option value="table">Table</option><option value="badges">Badges/links</option></select></label>
 <label>Section title<input data-title value="Selected Repositories"></label>
 <fieldset><legend>Repository badges</legend>${["stars", "forks", "issues", "license", "release", "workflow"].map((k) => `<label class="check"><input type="checkbox" data-badge="${k}" ${k !== "workflow" ? "checked" : ""}>${k}</label>`).join("")}<label>Workflow file (when selected)<input data-workflow placeholder="ci.yml"></label></fieldset>
 <fieldset data-tech><legend>Confirm technology suggestions</legend><div></div></fieldset>
 <button data-review>Preview selected output</button><div data-review-area hidden><label>Repository generated Markdown<textarea aria-label="Repository generated Markdown" readonly></textarea></label><div data-preview class="markdown-body"></div><button data-apply>Apply reviewed output</button></div>`;
    this.querySelectorAll("[data-filter]").forEach(
      (i) => (i.oninput = () => this.list()),
    );
    this.querySelector("[data-fetch]").onclick = () => this.lookup();
    this.querySelector("[data-lookup]").oninput = () => {
      this.controller?.abort();
      this.status(
        "Repository input changed. Look up the new value when ready.",
      );
    };
    this.querySelector("[data-review]").onclick = () => this.review();
    this.querySelector("[data-apply]").onclick = () => {
      if (this.pending)
        this.dispatchEvent(
          new CustomEvent("repository-apply", {
            bubbles: true,
            detail: {
              block: this.pending,
              saveComponent:
                this.querySelector("[data-action-kind]").value === "component",
              repos: this.repos,
              snapshot: JSON.stringify(this.draft),
            },
          }),
        );
    };
    this.addEventListener("input", () => {
      this.pending = null;
      this.querySelector("[data-review-area]").hidden = true;
    });
    this.list();
  }
  list() {
    const language = this.querySelector('[data-filter="language"]'),
      selectedLanguage = language.value;
    language.innerHTML =
      '<option value="">All languages</option>' +
      [...new Set(this.repos.map((r) => r.language).filter(Boolean))]
        .map((l) => `<option>${h(l)}</option>`)
        .join("");
    language.value = selectedLanguage;
    const filters = Object.fromEntries(
      [...this.querySelectorAll("[data-filter]")].map((i) => [
        i.dataset.filter,
        i.value,
      ]),
    );
    const all = filterContexts(this.repos, filters),
      visible = all.slice(0, 200);
    this.querySelector("[data-repos]").innerHTML =
      visible
        .map(
          (r) =>
            `<label class="check"><input type="checkbox" data-repo="${h(r.fullName)}" ${this.selected.has(r.fullName) ? "checked" : ""}>${h(r.fullName)} · ${h(r.language)}${r.archived ? " · Archived" : ""}${r.fork ? " · Fork" : ""}${r.owner.toLowerCase() === r.name.toLowerCase() ? " · Profile repository (not selected automatically)" : ""}</label>`,
        )
        .join("") ||
      "<p>No cached repositories match. Use GitHub Autofill or look up owner/repository.</p>";
    this.querySelector("[data-count]").textContent =
      `${this.selected.size} selected. ${all.length} matches${all.length > 200 ? "; showing first 200, narrow search for others" : ""}.`;
    this.querySelectorAll("[data-repo]").forEach(
      (i) =>
        (i.onchange = () => {
          i.checked
            ? this.selected.add(i.dataset.repo)
            : this.selected.delete(i.dataset.repo);
          const name = i.dataset.repo;
          this.list();
          [...this.querySelectorAll("[data-repo]")]
            .find((el) => el.dataset.repo === name)
            ?.focus();
        }),
    );
    this.querySelector("[data-tech] div").innerHTML = technologySuggestions(
      this.repos.filter((r) => this.selected.has(r.fullName)),
    )
      .map(
        (t) =>
          `<label class="check"><input type="checkbox" data-technology="${h(t.name)}" checked>${h(t.name)} — ${h(t.reason)}</label>`,
      )
      .join("");
  }
  async lookup() {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.status("Loading public repository…");
    try {
      const results = await fetchProjects(
        [this.querySelector("[data-lookup]").value],
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !this.isConnected) return;
      const result = results[0];
      if (result.error) throw Error(result.error);
      const r = repositoryContext(result.data);
      this.repos = [
        ...this.repos.filter(
          (x) => x.fullName.toLowerCase() !== r.fullName.toLowerCase(),
        ),
        r,
      ];
      this.selected.add(r.fullName);
      this.list();
      this.status("Repository loaded. Review output before applying.");
    } catch (e) {
      if (!controller.signal.aborted) this.status(e.message);
    }
  }
  review() {
    try {
      this.pending = authorRepositories(
        this.repos.filter((r) => this.selected.has(r.fullName)),
        {
          action: this.querySelector("[data-action-kind]").value,
          layout: this.querySelector("[data-layout]").value,
          title: this.querySelector("[data-title]").value,
          workflow: this.querySelector("[data-workflow]").value,
          badges: [...this.querySelectorAll("[data-badge]:checked")].map(
            (i) => i.dataset.badge,
          ),
          technologies: [
            ...this.querySelectorAll("[data-technology]:checked"),
          ].map((i) => i.dataset.technology),
        },
      );
      const source = serializeBlock(this.pending);
      this.querySelector("textarea").value = source;
      this.querySelector("[data-preview]").innerHTML = renderMarkdown(source);
      this.querySelector("[data-review-area]").hidden = false;
      this.querySelector("textarea").focus();
      this.status(
        "Review generated source. Preview images may contact badge providers.",
      );
    } catch (e) {
      this.status(e.message);
    }
  }
}
customElements.define("repository-authoring", RepositoryAuthoring);
