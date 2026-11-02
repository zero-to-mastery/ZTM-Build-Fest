import {
  fetchProjects,
  repositoryChanges,
  filterRepositories,
  applyRepository,
  importedFields,
  repositoryIdentity,
  suggestedTechnologies,
} from "../projects/github-project.js";
import { escapeHtml as h } from "../projects/serialize-project.js";
export class GithubProjectPicker extends HTMLElement {
  connectedCallback() {
    this.selected = new Set();
    this.filters = {};
    this.generation = 0;
    this.draw();
  }
  disconnectedCallback() {
    this.controller?.abort();
    this.generation++;
  }
  draw() {
    this.innerHTML = `<h2 tabindex="-1">Import public GitHub projects</h2><p>No roles or engineering claims are inferred. Review fields before applying them to the working showcase.</p><label>Repository (owner/repository)<input data-repository placeholder="owner/repository"></label><button data-fetch-one>Look up repository</button><details ${(this.available || []).length ? "open" : ""}><summary>Repositories from GitHub Autofill</summary><label>Search repositories<input data-repo-filter="search"></label><label>Repository language<select data-repo-filter="language" aria-label="Repository language"><option value="">All languages</option>${[...new Set((this.available || []).map((r) => r.language).filter(Boolean))].map((l) => `<option>${h(l)}</option>`).join("")}</select></label><label>Archived repositories<select data-repo-filter="archived" aria-label="Archived repositories"><option value="any">Any</option><option value="exclude">Exclude archived</option><option value="only">Only archived</option></select></label><label>Fork repositories<select data-repo-filter="fork" aria-label="Fork repositories"><option value="any">Any</option><option value="exclude">Exclude forks</option><option value="only">Only forks</option></select></label><label>Repository sort<select data-repo-filter="sort" aria-label="Repository sort"><option value="name">Name</option><option value="stars">Stars</option><option value="updated">Recently updated</option></select></label><div class="project-repo-list"></div><button data-fetch-selected>Review selected repositories</button></details><button data-cancel-project-import>Close repository review</button><p class="project-fetch-status" role="status"></p><div class="project-import-review"></div>`;
    this.querySelector("[data-fetch-one]").onclick = () =>
      this.lookup([this.querySelector("[data-repository]").value]);
    this.querySelector("[data-repository]").oninput = () => {
      this.controller?.abort();
      this.generation++;
      this.querySelector(".project-import-review").replaceChildren();
      this.querySelector(".project-fetch-status").textContent = "";
    };
    this.querySelectorAll("[data-repo-filter]").forEach(
      (el) =>
        (el.oninput = () => {
          this.filters[el.dataset.repoFilter] = el.value;
          this.list();
        }),
    );
    this.querySelector("[data-fetch-selected]").onclick = () =>
      this.lookup([...this.selected]);
    this.querySelector("[data-cancel-project-import]").onclick = () => {
      this.dispatchEvent(
        new CustomEvent("project-review-close", { bubbles: true }),
      );
      this.remove();
    };
    this.list();
  }
  list() {
    this.querySelector(".project-repo-list").innerHTML =
      filterRepositories(this.available || [], this.filters)
        .map(
          (r) =>
            `<label class="check"><input type="checkbox" data-repo-choice="${h(r.full_name)}" ${this.selected.has(r.full_name) ? "checked" : ""}> ${h(r.full_name)} · ${h(r.language)}${r.archived ? " · Archived" : ""}${r.fork ? " · Fork" : ""}</label>`,
        )
        .join("") ||
      "No cached repositories match. Run GitHub Autofill or enter owner/repository above.";
    this.querySelectorAll("[data-repo-choice]").forEach(
      (i) =>
        (i.onchange = () =>
          i.checked
            ? this.selected.add(i.dataset.repoChoice)
            : this.selected.delete(i.dataset.repoChoice)),
    );
  }
  async lookup(names) {
    if (!names.length) {
      this.querySelector(".project-fetch-status").textContent =
        "Select at least one repository.";
      return;
    }
    this.controller?.abort();
    this.controller = new AbortController();
    const ticket = ++this.generation;
    this.querySelector(".project-import-review").replaceChildren();
    this.querySelector(".project-fetch-status").textContent =
      `Loading ${names.length} repositories…`;
    try {
      const results = await fetchProjects(names, {
        signal: this.controller.signal,
      });
      if (!this.isConnected || ticket !== this.generation) return;
      this.results = results;
      this.review();
    } catch (e) {
      if (this.isConnected && ticket === this.generation)
        this.querySelector(".project-fetch-status").textContent = e.message;
    }
  }
  review() {
    const results = this.results;
    this.querySelector(".project-fetch-status").textContent =
      `${results.length} repositories requested · ${results.filter((r) => r.data).length} ready for review · ${results.filter((r) => r.error).length} unavailable`;
    this.querySelector(".project-import-review").innerHTML =
      results
        .map((r, i) => {
          if (r.error) return `<p>${h(r.repository)}: ${h(r.error)}</p>`;
          const repo = r.data,
            existing = (this.refresh || []).find(
              (p) =>
                `${p.metadata.github.owner}/${p.metadata.github.repo}`.toLowerCase() ===
                repo.full_name.toLowerCase(),
            );
          const duplicate =
            !existing &&
            (this.projects || []).some(
              (p) =>
                repositoryIdentity(p.repositoryUrl) ===
                repositoryIdentity(repo.html_url),
            );
          return `<fieldset data-repo-review="${i}"><legend>${h(repo.full_name)}</legend><label class="check"><input data-include-repo type="checkbox" checked> ${existing ? "Refresh" : "Import"} ${h(repo.full_name)}</label><p>${h(repo.description || "No description")}</p><p>Primary language: ${h(repo.language || "Unknown")} · Topics: ${h(repo.topics.join(", "))}</p><p>Homepage: ${h(repo.homepage || "Not provided")}</p><p>Stars: ${repo.stargazers_count ?? "Unknown"} · Forks: ${repo.forks_count ?? "Unknown"} · ${repo.archived ? "Archived" : "Not archived"} · License: ${h(repo.license || "Unknown")}</p><p>Technology suggestions: ${h(
            suggestedTechnologies(repo)
              .map((t) => t.name)
              .join(", ") || "None",
          )}</p>${importedFields.map((key) => `<label class="check"><input type="checkbox" data-import-field="${key}" ${existing ? (Object.hasOwn(existing.metadata.github.generatedFields || {}, key) ? "checked" : "") : ["name", "description", "repositoryUrl", "liveUrl"].includes(key) ? "checked" : ""}> Apply ${key}</label>`).join("")}${existing ? `<p>Source changes since last import: ${h(repositoryChanges(repo, existing).join(", ") || "none")}. Apply selected refresh fields below; manual edits are preserved. Fields currently owned by you: ${h(applyRepository(repo, importedFields, existing).preserved.join(", ") || "none")}</p>` : ""}${duplicate ? '<p>This repository is already included.</p><label class="check"><input type="checkbox" data-allow-duplicate> I confirm adding a duplicate repository</label>' : ""}</fieldset>`;
        })
        .join("") +
      (results.some((r) => r.data)
        ? "<button data-apply-project-import>Apply reviewed projects</button>"
        : "");
    this.querySelector("[data-apply-project-import]")?.addEventListener(
      "click",
      () => this.apply(),
    );
    this.querySelector("[data-include-repo]")?.focus();
  }
  apply() {
    const projects = [],
      preserved = [];
    for (const el of this.querySelectorAll("[data-repo-review]")) {
      if (!el.querySelector("[data-include-repo]").checked) continue;
      if (
        el.querySelector("[data-allow-duplicate]") &&
        !el.querySelector("[data-allow-duplicate]").checked
      ) {
        this.querySelector(".project-fetch-status").textContent =
          "Confirm the duplicate repository before applying.";
        return;
      }
      const repo = this.results[Number(el.dataset.repoReview)].data;
      const targets = (this.refresh || []).filter(
        (p) =>
          `${p.metadata.github.owner}/${p.metadata.github.repo}`.toLowerCase() ===
          repo.full_name.toLowerCase(),
      );
      for (const existing of targets.length ? targets : [null]) {
        const result = applyRepository(
          repo,
          [...el.querySelectorAll("[data-import-field]:checked")].map(
            (i) => i.dataset.importField,
          ),
          existing,
        );
        projects.push(result.project);
        preserved.push(...result.preserved);
      }
    }
    if (!projects.length) {
      this.querySelector(".project-fetch-status").textContent =
        "Choose at least one repository to apply.";
      return;
    }
    this.dispatchEvent(
      new CustomEvent("projects-reviewed", {
        bubbles: true,
        detail: {
          projects,
          refreshIds: (this.refresh || []).map((p) => p.id),
          preserved,
          requested: this.results.length,
          unavailable: this.results.filter((r) => r.error).length,
        },
      }),
    );
  }
}
customElements.define("github-project-picker", GithubProjectPicker);
