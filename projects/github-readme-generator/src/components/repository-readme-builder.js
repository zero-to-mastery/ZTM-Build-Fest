import {
  repositoryTemplates,
  repositorySuggestions,
  buildRepositoryTemplate,
} from "../data/repository-templates.js";
import {
  html as h,
  serializeBlocks,
  createBlock,
} from "../markdown/serialize.js";
import { sourceDiffMarkup, fillSourceDiff } from "./source-diff.js";
import {
  matchTemplateSections,
  readRepositoryFile,
  reviewSignature,
} from "../documentation/template-merge.js";
import { IMPORT_LIMIT } from "../state/import.js";
import "./github-preview.js";

export class RepositoryReadmeBuilder extends HTMLElement {
  configure({
    repo = {},
    readme = null,
    projectType = "generic",
    currentMarkdown = "",
    previewTheme = "light",
  } = {}) {
    this.repo = repo;
    this.source = readme?.source ?? null;
    this.currentMarkdown = currentMarkdown;
    this.importSequence = 0;
    this.sourceContext = repo.full_name
      ? {
          type: "github",
          owner: repo.full_name.split("/")[0],
          repository: repo.full_name.split("/")[1],
          ref: repo.default_branch || "HEAD",
          readmePath: readme?.path || "README.md",
          sha: readme?.sha || "",
          fetchedAt: new Date().toISOString(),
        }
      : null;
    const suggestions = repositorySuggestions(repo, projectType);
    this.innerHTML = `<h1>Repository README builder</h1><p>Review repository suggestions and choose useful sections. No commands, credentials, compatibility or license terms are invented. Existing source is kept by default. Creating a changed README requires a fresh diff review.</p><form><details><summary>Import existing README</summary><label>README file (UTF-8, up to 2 MB)<input type="file" data-file accept=".md,.markdown,.txt,text/plain,text/markdown"></label><label>Paste existing Markdown<textarea data-paste rows="6" maxlength="2000000"></textarea></label><button type="button" data-use-paste>Use pasted README</button>${currentMarkdown ? '<button type="button" data-use-current>Use current draft as existing README</button>' : ""}<p>Imports do not change your current draft. File imports preserve BOM and line endings. Pasted text uses the browser's textarea line endings.</p></details><label>Repository template<select name="template" aria-label="Repository template">${repositoryTemplates.map((t) => `<option value="${t.id}">${h(t.name)}</option>`).join("")}</select></label><p>Suggested project type: ${h(projectType)}. Choose another template if needed. PWA uses Web App; Experiment uses Generic.</p><fieldset><legend>Review repository suggestions</legend>${[
      ["name", "Repository name"],
      ["description", "Repository description"],
      ["homepage", "Repository homepage"],
      ["language", "Primary language"],
      ["topics", "Repository topics"],
    ]
      .map(
        ([key, label]) =>
          `<label>${label}<input name="${key}" value="${h(suggestions[key])}" maxlength="${key === "description" ? 2000 : 1000}" ${key === "name" ? "required" : ""}></label>`,
      )
      .join(
        "",
      )}<p>Clear optional values you do not want. Homepage is a supplied URL, not a verified live demo.</p></fieldset><div data-existing ${this.source === null ? "hidden" : ""}><label><input type="checkbox" name="preserve" checked> Keep existing README verbatim and append selected template sections</label><label><input type="checkbox" name="includeContext"> Include reviewed repository context in the README</label><p>Matched sections are not added again by default. Existing sections are never automatically rewritten. Unchecking preservation starts a replacement in a new local draft and requires diff review.</p></div><fieldset data-sections></fieldset><details open><summary>Project-type completeness guidance</summary><p>These topics are commonly useful for this project type, not universal requirements. Headings and content are clues, not proof of completeness. Unknown or non-English structures may need manual matching.</p><ul data-guidance></ul></details><details><summary>Review generated Markdown</summary><textarea data-source readonly aria-label="Generated repository README" rows="10"></textarea></details><details data-rendered><summary>Responsive rendered preview</summary><p>Approximate GitHub rendering. Remote images contact their hosts when this preview is opened.</p><label>Builder preview width<select data-preview-width><option value="full">Available desktop width</option><option value="768">768px maximum</option><option value="320">320px maximum</option></select></label><label>Builder preview theme<select data-preview-theme><option value="light">Light</option><option value="dark">Dark</option></select></label><div class="builder-preview-scroll"><div class="preview-paper" data-builder-paper><github-preview></github-preview></div></div></details><button type="button" data-review>Review changes</button><section data-review-panel hidden><h2 tabindex="-1">Review README changes</h2><p data-review-warning></p>${sourceDiffMarkup({ beforeLabel: "Existing README source", afterLabel: "Proposed README source", label: "Proposed README changes" })}<label><input type="checkbox" data-confirm> I reviewed the diff and approve this exact result</label></section><p role="status"></p><button type="submit" data-create>Create repository README</button><button type="button" data-original ${!readme && this.source === null ? "hidden" : ""}>Open existing README unchanged</button></form>`;
    this.querySelector('[name="template"]').value = suggestions.templateId;
    this.querySelector("[data-preview-theme]").value =
      previewTheme === "dark" ? "dark" : "light";
    this.drawSections();
    this.querySelector('[name="template"]').onchange = () => {
      this.invalidate();
      this.drawSections();
      this.preview();
    };
    this.querySelector('[name="preserve"]').onchange = () => {
      this.invalidate();
      this.drawSections();
      this.preview();
    };
    this.querySelector("form").oninput = (event) => {
      if (
        event.target.matches(
          "[data-confirm],[data-preview-width],[data-preview-theme],[data-paste],[data-file]",
        )
      )
        return;
      this.invalidate();
      clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => this.preview(), 200);
    };
    this.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      try {
        const plan = this.plan();
        if (!this.canCreate(plan)) {
          this.status(
            "Review and approve the current diff before creating this README.",
          );
          return;
        }
        this.dispatchEvent(
          new CustomEvent("repository-readme-create", {
            bubbles: true,
            detail: plan,
          }),
        );
      } catch (error) {
        this.status(error.message);
      }
    };
    this.querySelector("[data-review]").onclick = () => this.reviewChanges();
    this.querySelector("[data-confirm]").onchange = () => this.preview();
    this.querySelector("[data-original]").onclick = () =>
      this.dispatchEvent(
        new CustomEvent("repository-readme-original", {
          bubbles: true,
          detail: this.originalPlan(),
        }),
      );
    this.querySelector("[data-use-paste]").onclick = () =>
      this.importSource(this.querySelector("[data-paste]").value);
    this.querySelector("[data-use-current]")?.addEventListener("click", () =>
      this.importSource(this.currentMarkdown),
    );
    this.querySelector("[data-file]").onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const sequence = ++this.importSequence;
      this.importing = true;
      this.querySelector("[data-create]").disabled = true;
      try {
        const source = await readRepositoryFile(file);
        if (this.isConnected && sequence === this.importSequence)
          this.importSource(source);
      } catch (error) {
        if (sequence === this.importSequence) this.status(error.message);
      } finally {
        if (sequence === this.importSequence) {
          this.importing = false;
          this.preview();
        }
      }
    };
    this.querySelector("[data-rendered]").ontoggle = () => this.renderPreview();
    this.querySelector("[data-preview-width]").onchange = () =>
      this.renderPreview();
    this.querySelector("[data-preview-theme]").onchange = () =>
      this.renderPreview();
    this.preview();
    this.status(
      this.source === null
        ? "Review suggestions before creating a new draft."
        : "Original source retained. Select missing sections, then review and approve the diff.",
    );
  }
  disconnectedCallback() {
    clearTimeout(this.previewTimer);
    this.importSequence++;
  }
  importSource(source) {
    if (new TextEncoder().encode(source).length > IMPORT_LIMIT) {
      this.status("README exceeds the 2 MB limit. Existing source retained.");
      return;
    }
    this.importSequence++;
    this.importing = false;
    this.source = source;
    this.sourceContext = null; // A local import is not evidence of the previously selected GitHub path.
    this.querySelector("[data-existing]").hidden = false;
    this.querySelector("[data-original]").hidden = false;
    this.querySelector('[name="preserve"]').checked = true;
    this.querySelector('[name="includeContext"]').checked = false;
    this.invalidate();
    this.drawSections();
    this.preview();
    this.status(
      "README imported for review. Original source retained; matched headings are not added again by default.",
    );
  }
  drawSections() {
    const template = repositoryTemplates.find(
      (t) => t.id === this.querySelector('[name="template"]').value,
    );
    const preserve =
      this.source !== null && this.querySelector('[name="preserve"]').checked;
    const matches = matchTemplateSections(this.source, template.sections);
    this.querySelector("[data-sections]").innerHTML =
      `<legend>Sections to include — editable after creation</legend>${matches.map((match, index) => `<label><input type="checkbox" data-section aria-label="${h(match.title)}" aria-describedby="section-match-${index}" value="${h(match.title)}" ${!preserve || match.suggested ? "checked" : ""}> ${h(match.title)}</label><p class="hint" id="section-match-${index}">${h(this.explain(match))}</p>`).join("")}`;
    this.querySelector("[data-guidance]").innerHTML = matches
      .map(
        (match) =>
          `<li><strong>${h(match.title)}:</strong> ${h(this.explain(match))}</li>`,
      )
      .join("");
  }
  explain(match) {
    const places = match.matches
      .map((item) => `${item.title} (line ${item.line})`)
      .join(", ");
    return match.status === "missing"
      ? "No matching heading detected. Consider adding this topic if relevant."
      : match.status === "needs-content"
        ? `Heading found, but little or no substantive content detected: ${places}. Improve the existing section; it is retained unchanged.`
        : match.status === "related"
          ? `Related headings may cover part of this topic: ${places}. Review before adding a duplicate.`
          : `Heading and content detected: ${places}. Confirm the details are sufficient; existing content is retained unchanged.`;
  }
  status(message) {
    this.querySelector("[role=status]").textContent = message;
  }
  invalidate() {
    if (this.reviewed)
      this.status(
        "Settings changed. Review changes again before creating this README.",
      );
    this.reviewed = null;
    this.querySelector("[data-confirm]").checked = false;
    this.querySelector("[data-review-panel]").hidden = true;
    if (this.source !== null)
      this.querySelector("[data-create]").disabled = true;
  }
  plan() {
    const values = Object.fromEntries(new FormData(this.querySelector("form")));
    const sections = [...this.querySelectorAll("[data-section]:checked")].map(
      (el) => el.value,
    );
    const blocks = buildRepositoryTemplate({
      templateId: values.template,
      values,
      sections,
      existing: this.source !== null && values.preserve ? this.source : null,
      includeContext: !!values.includeContext,
      sourceContext: this.sourceContext,
    });
    return {
      name: `${values.name.trim()} README`,
      blocks,
      metadata: {
        ...(this.sourceContext
          ? {
              repository: this.repo.full_name,
              importSource: this.sourceContext,
            }
          : {}),
        repositoryReadme: {
          version: 1,
          templateId: values.template,
          reviewed: {
            name: values.name,
            description: values.description,
            homepage: values.homepage,
            language: values.language,
            topics: values.topics,
            projectType: values.template,
          },
        },
      },
    };
  }
  originalPlan() {
    const block = createBlock("custom", { markdown: this.source ?? "" });
    if (this.sourceContext) block.sourceContext = this.sourceContext;
    return {
      name: `${this.querySelector('[name="name"]').value.trim() || "Imported"} README`,
      blocks: [block],
      metadata: this.sourceContext
        ? { repository: this.repo.full_name, importSource: this.sourceContext }
        : {},
    };
  }
  canCreate(plan) {
    return (
      !this.importing &&
      (this.source === null ||
        (this.querySelector("[data-confirm]").checked &&
          this.reviewed === reviewSignature(this.source, plan)))
    );
  }
  reviewChanges() {
    if (this.importing || !this.querySelector("form").reportValidity()) return;
    try {
      const plan = this.plan();
      this.reviewed = reviewSignature(this.source, plan);
      const panel = this.querySelector("[data-review-panel]");
      panel.hidden = false;
      panel.querySelector("[data-confirm]").checked = false;
      this.querySelector("[data-review-warning]").textContent =
        this.source !== null && !this.querySelector('[name="preserve"]').checked
          ? "Replacement: existing content will be omitted from this new local draft. Inspect all removed and added source before approving. The remote repository is not changed."
          : "Merge: the original source stays intact; selected suggestions are appended. Review the full source panes, including any duplicate headings.";
      fillSourceDiff(panel, this.source ?? "", serializeBlocks(plan.blocks));
      panel.querySelector("h2").focus();
      this.preview();
      this.status(
        "Review the source diff, then approve this exact result to create the draft.",
      );
    } catch (error) {
      this.status(error.message);
    }
  }
  preview() {
    try {
      const plan = this.plan();
      this.querySelector("[data-source]").value = serializeBlocks(plan.blocks);
      this.querySelector("[data-create]").disabled = !this.canCreate(plan);
      this.renderPreview(plan);
    } catch (error) {
      this.querySelector("[data-source]").value = "";
      this.querySelector("[data-create]").disabled = true;
      this.status(error.message);
    }
  }
  renderPreview(plan) {
    if (!this.querySelector("[data-rendered]").open) return;
    try {
      plan ||= this.plan();
      const paper = this.querySelector("[data-builder-paper]");
      const width = this.querySelector("[data-preview-width]").value;
      paper.style.width = width === "full" ? "100%" : `${width}px`;
      paper.dataset.theme = this.querySelector("[data-preview-theme]").value;
      paper.querySelector("github-preview").draft = {
        blocks: plan.blocks,
        markdown: serializeBlocks(plan.blocks),
        metadata: plan.metadata,
      };
    } catch {
      this.status(
        "Preview unavailable. Your existing source is retained; correct the fields before creating a draft.",
      );
    }
  }
}
customElements.define("repository-readme-builder", RepositoryReadmeBuilder);
