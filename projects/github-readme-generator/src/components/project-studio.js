import { present } from "../styling/presentation.js";
import { projectHealth, projectMatches } from "../projects/project-health.js";
import {
  readProjectPack,
  exportProjectPack,
  mergeProjectPack,
} from "../projects/project-pack.js";
import {
  checkProjectLinks,
  projectLinkTargets,
} from "../projects/project-links.js";
import "./github-project-picker.js";
import {
  normalizeProject,
  normalizeShowcase,
  projectTypes,
  roles,
  statuses,
} from "../projects/project-model.js";
import {
  serializeShowcase,
  serializeProject,
  layouts,
  layoutPresets,
  escapeHtml as h,
} from "../projects/serialize-project.js";
import { render } from "../markdown/render.js";
import { searchLogos } from "../badges/badge-model.js";
import "./badge-studio.js";
const fields = [
  ["name", "Project name"],
  ["emoji", "Emoji / icon text"],
  ["subtitle", "Subtitle"],
  ["description", "Description — What does the project do?", "textarea"],
  ["projectType", "Project type"],
  ["role", "Role — What did you personally contribute?"],
  ["repositoryUrl", "Repository URL"],
  ["liveUrl", "Live demo URL"],
  ["caseStudyUrl", "Case study URL"],
  ["status", "Project status"],
  ["imageUrl", "Image URL"],
  ["imageAlt", "Image alt text"],
  ["darkImageUrl", "Dark image URL"],
  ...["problem", "architecture", "challenges", "testing", "outcome"].map(
    (k) => [k, `Case study: ${k}`, "textarea"],
  ),
  ["imageLink", "Image click target"],
  ["imageWidth", "Image width (optional)"],
];
const field = (p, key, label, type = "text") =>
  `<label>${h(label)}${type === "textarea" ? `<textarea data-project-field="${key}" rows="3">${h(p[key])}</textarea>` : `<input data-project-field="${key}" value="${h(p[key])}" ${["role", "projectType", "status"].includes(key) ? `list="project-${key}-options"` : ""}>`}</label>`;
const select = (key, label, options, value) =>
  `<label>${label}<select data-project-field="${key}" aria-label="${label}">${options.map((s) => `<option ${s === value ? "selected" : ""}>${s}</option>`).join("")}</select></label>`;
export class ProjectStudio extends HTMLElement {
  connectedCallback() {
    this.value ||= {
      version: 1,
      title: "Selected Projects",
      layout: "detailed",
      items: [],
    };
    this.open ||= new Set();
    this.draw();
  }
  set settings(value) {
    this.value = normalizeShowcase(value);
    this.initial = JSON.stringify(this.value);
    this.open = new Set(this.value.items.slice(0, 1).map((p) => p.id));
    this.draw();
  }
  isDirty() {
    return this.initial !== JSON.stringify(this.value);
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  draw() {
    this.linkController?.abort();
    this.innerHTML = `<h1>Project Studio</h1><p>Explain your work with editable project entries. Changes apply only when you save the showcase.</p>${[
      ["role", roles],
      ["projectType", projectTypes],
      ["status", statuses],
    ]
      .map(
        ([k, values]) =>
          `<datalist id="project-${k}-options">${values.map((v) => `<option value="${h(v)}">`).join("")}</datalist>`,
      )
      .join(
        "",
      )}<label>Showcase heading<input data-showcase-title value="${h(this.value.title)}"></label><label>Showcase layout<select data-showcase-layout aria-label="Showcase layout">${layouts.map((l) => `<option ${this.value.layout === l ? "selected" : ""}>${l}</option>`).join("")}</select></label><label>Layout preset<select data-layout-preset aria-label="Layout preset"><option value="">Choose preset</option>${Object.keys(
      layoutPresets,
    )
      .map((k) => `<option>${k}</option>`)
      .join(
        "",
      )}</select></label><p class="hint">One layout applies to all projects. Layouts change presentation only. Compact omits details and screenshots. Tables may scroll on narrow screens; choose compact or detailed for a linear layout.</p><div class="project-tools"><button data-project-import>Import GitHub projects</button><button data-project-add>Add project</button><button data-project-save class="primary">Save showcase</button></div><div class="project-tools"><button data-collapse-projects>Collapse all</button><button data-expand-projects>Expand all</button><button data-refresh-projects>Refresh GitHub-backed projects</button><button data-copy-projects>Copy all project Markdown</button><button data-export-projects>Export project pack</button></div><label>Search projects (name, technology, status, repository)<input data-project-search value="${h(this.search || "")}"></label><p class="project-count" role="status"></p><details class="project-pack-tools"><summary>Import project pack</summary><label>Project pack file<input data-project-pack-file type="file" accept="application/json,.json"></label><label>Project pack JSON<textarea data-project-pack-json rows="4"></textarea></label><button data-review-project-pack>Review project pack</button><div class="project-pack-review" role="status"></div></details><details><summary>Check project links</summary><p>On request, the browser contacts up to 300 unique HTTP(S) destinations using HEAD requests, three at a time. Cookies and referrers are omitted. No draft prose is sent. CORS restrictions can leave reachable links unverified.</p><button data-check-project-links>Check links now</button><div class="project-link-results" role="status"></div></details><p class="project-status" role="status"></p><div class="project-import-panel"></div><div class="project-workbench"><div class="project-entries">${this.value.items.map((p, i) => this.entry(p, i)).join("")}</div><aside class="project-preview-area" aria-label="Project section preview"><h2>Live project section</h2><label>Preview width<select data-project-width aria-label="Project preview width">${[
      ["100%", "desktop"],
      ["600px", "narrow"],
      ["320px", "mobile"],
    ]
      .map(
        ([v, n]) =>
          `<option value="${v}" ${(this.previewWidth || "100%") === v ? "selected" : ""}>${n}</option>`,
      )
      .join(
        "",
      )}</select></label><div class="project-copy-fallback" role="status"></div><details><summary>Project guidance</summary><ul class="project-guidance"></ul></details><p class="hint">Screenshots for collapsed entries are paused. Open an entry to load its screenshot. Remote previews contact their providers.</p><div class="project-preview markdown-body"></div><details><summary>Generated project Markdown</summary><textarea data-project-output readonly rows="8" aria-label="Generated project Markdown"></textarea></details></aside></div><div class="project-badge-composer"></div>`;
    this.querySelector("[data-project-search]").oninput = (e) => {
      this.search = e.target.value;
      this.filterEntries();
    };
    for (const [key, expand] of [
      ["collapse", false],
      ["expand", true],
    ])
      this.querySelector(`[data-${key}-projects]`).onclick = () => {
        this.open = new Set(expand ? this.value.items.map((p) => p.id) : []);
        this.draw();
        this.querySelector(`[data-${key}-projects]`).focus();
      };
    this.querySelector("[data-copy-projects]").onclick = () =>
      this.copyProject(serializeShowcase(this.value));
    this.querySelector("[data-refresh-projects]").onclick = () => {
      const projects = this.value.items.filter((p) => p.metadata.github);
      if (projects.length) this.openImport(projects);
      else
        this.querySelector(".project-status").textContent =
          "No GitHub-backed projects to refresh.";
    };
    this.querySelector("[data-export-projects]").onclick = () => {
      try {
        this.emit("project-pack-export", exportProjectPack(this.value.items));
      } catch (e) {
        this.querySelector(".project-status").textContent = e.message;
      }
    };
    this.querySelector("[data-project-pack-file]").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        if (file.size > 5_000_000)
          throw Error("Project pack exceeds the 5 MB limit.");
        const text = await file.text();
        if (!this.isConnected) return;
        this.querySelector("[data-project-pack-json]").value = text;
        this.reviewPack();
      } catch (error) {
        this.querySelector(".project-pack-review").textContent = error.message;
      }
    };
    this.querySelector("[data-project-pack-json]").oninput = () =>
      this.querySelector(".project-pack-review").replaceChildren();
    this.querySelector("[data-review-project-pack]").onclick = () =>
      this.reviewPack();
    this.querySelector("[data-check-project-links]").onclick = () =>
      this.checkLinks();
    this.querySelector("[data-showcase-layout]").onchange = (e) => {
      this.value.layout = e.target.value;
      this.preview();
    };
    this.querySelector("[data-layout-preset]").onchange = (e) => {
      if (!e.target.value) return;
      this.value.layout = layoutPresets[e.target.value];
      this.querySelector("[data-showcase-layout]").value = this.value.layout;
      this.preview();
    };
    this.querySelector("[data-project-width]").onchange = (e) => {
      this.previewWidth = e.target.value;
      this.querySelector(".project-preview").style.maxWidth = e.target.value;
    };
    this.querySelector("[data-showcase-title]").oninput = (e) => {
      this.value.title = e.target.value;
      this.preview();
    };
    this.querySelector("[data-project-import]").onclick = () =>
      this.openImport();
    this.querySelector("[data-project-add]").onclick = () => {
      const p = normalizeProject({});
      this.value.items.push(p);
      this.open.add(p.id);
      this.draw();
      this.querySelector(".project-entry:last-child input")?.focus();
    };
    this.querySelector("[data-project-save]").onclick = () => {
      if (this.preview())
        this.emit("project-save", structuredClone(this.value));
    };
    this.querySelectorAll(".project-entry").forEach((el) => {
      const index = Number(el.dataset.projectIndex),
        p = this.value.items[index];
      el.ontoggle = () => {
        if (el.open === this.open.has(p.id)) return;
        el.open ? this.open.add(p.id) : this.open.delete(p.id);
        this.draw();
        this.entryElement(index)
          ?.querySelector("summary")
          .focus({ preventScroll: true });
      };
      if (!el.querySelector("fieldset")) return;
      el.querySelectorAll("[data-project-field]").forEach(
        (input) =>
          (input.oninput = () => {
            p[input.dataset.projectField] = input.value;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.preview(), 150);
          }),
      );
      el.querySelectorAll("[data-highlight]").forEach(
        (input) =>
          (input.oninput = () => {
            p.highlights[Number(input.dataset.highlight)][input.dataset.part] =
              input.value;
            this.preview();
          }),
      );
      el.querySelector("[data-refresh-project]")?.addEventListener(
        "click",
        () => this.openImport([p]),
      );
      el.querySelector("[data-add-highlight]").onclick = () => {
        p.highlights.push({ title: "", description: "" });
        this.draw();
        this.entryElement(index)
          .querySelector(".project-highlights fieldset:last-child input")
          ?.focus();
      };
      el.querySelectorAll("[data-remove-highlight]").forEach(
        (b) =>
          (b.onclick = () => {
            p.highlights.splice(Number(b.dataset.removeHighlight), 1);
            this.draw();
            this.entryElement(index)
              .querySelector("[data-add-highlight]")
              .focus();
          }),
      );
      el.querySelector("[data-project-links]").oninput = (e) => {
        p.links = e.target.value
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [name, ...url] = line.split("|");
            return { name: name.trim(), url: url.join("|").trim() };
          });
        this.preview();
      };
      el.querySelector("[data-project-tech-search]").oninput = (e) =>
        this.technologies(el, p, e.target.value, index);
      el.querySelector("[data-project-custom-tech]").onclick = () => {
        const input = el.querySelector("[data-project-tech-search]");
        if (input.value.trim()) {
          p.technologies.push({ name: input.value.trim() });
          this.redrawEntry(index, "[data-project-tech-search]");
        }
      };
      el.querySelectorAll("[data-remove-tech]").forEach(
        (b) =>
          (b.onclick = () => {
            p.technologies.splice(Number(b.dataset.removeTech), 1);
            this.redrawEntry(index, "[data-project-tech-search]");
          }),
      );
      el.querySelectorAll("[data-project-action]").forEach(
        (b) => (b.onclick = () => this.row(b.dataset.projectAction, index)),
      );
      el.querySelector("[data-attach-collection]").onclick = () => {
        const c = (this.collections || []).find(
          (c) => c.id === el.querySelector("[data-project-collection]").value,
        );
        if (c) {
          p.badges.push(...structuredClone(c.badges));
          this.redrawEntry(index, "[data-attach-collection]");
        }
      };
      el.querySelector("[data-compose-project-badge]").onclick = () =>
        this.composeBadge(index);
      el.querySelectorAll("[data-remove-project-badge]").forEach(
        (b) =>
          (b.onclick = () => {
            p.badges.splice(Number(b.dataset.removeProjectBadge), 1);
            this.redrawEntry(index, "[data-compose-project-badge]");
          }),
      );
    });
    this.filterEntries();
    this.preview();
  }
  entry(p, i) {
    if (!this.open.has(p.id))
      return `<details class="project-entry" data-project-index="${i}"><summary>${i + 1}. ${h(p.name || "Untitled project")}</summary></details>`;
    return `<details class="project-entry" data-project-index="${i}" ${this.open.has(p.id) ? "open" : ""}><summary>${i + 1}. ${h(p.name || "Untitled project")}</summary><fieldset><legend>Project ${i + 1}: ${h(p.name || "new entry")}</legend><div class="row-actions">${[
      ["up", "Move project up"],
      ["down", "Move project down"],
      ["duplicate", "Duplicate project"],
      ["copy", "Copy project Markdown"],
      ["remove", "Delete project"],
    ]
      .map(
        ([key, label]) =>
          `<button data-project-action="${key}" aria-label="${label} ${i + 1}" ${(key === "up" && i === 0) || (key === "down" && i === this.value.items.length - 1) ? "disabled" : ""}>${label}</button>`,
      )
      .join(
        "",
      )}</div><div class="project-fields">${fields.map(([key, label, type]) => field(p, key, label, type)).join("")}${select("statusStyle", "Status display", ["text", "badge", "hidden"], p.statusStyle)}${select("technologyStyle", "Technology display", ["chips", "badges", "text"], p.technologyStyle)}${select("imagePlacement", "Screenshot placement", ["top", "below-title", "side-by-side", "hidden"], p.imagePlacement)}${select("imageAlign", "Image alignment", ["left", "center"], p.imageAlign)}</div>${p.metadata.github ? `<p>Imported from ${h(p.metadata.github.owner)}/${h(p.metadata.github.repo)} · Last refreshed: ${h(p.metadata.github.lastFetched || "Unknown")}</p><button data-refresh-project>Refresh from GitHub</button>` : ""}<h3>Engineering highlights</h3><p class="hint">Call out engineering decisions, architecture, testing, performance, accessibility, or other meaningful work.</p><div class="project-highlights">${p.highlights.map((v, n) => `<fieldset><legend>Highlight ${n + 1}</legend><label>Highlight title<input data-highlight="${n}" data-part="title" value="${h(v.title)}"></label><label>Highlight description<textarea data-highlight="${n}" data-part="description">${h(v.description)}</textarea></label><button data-remove-highlight="${n}" aria-label="Remove highlight ${n + 1}">Remove highlight</button></fieldset>`).join("")}</div><button data-add-highlight>Add engineering highlight</button><h3>Technologies</h3><label>Search or enter technology<input data-project-tech-search></label><div class="project-tech-results"></div><button data-project-custom-tech>Add custom technology</button><ul>${p.technologies.map((t, n) => `<li>${h(t.name)} <button data-remove-tech="${n}" aria-label="Remove technology ${n + 1}">Remove</button></li>`).join("")}</ul><label>Additional links (Label | URL, one per line)<textarea data-project-links>${h(p.links.map((l) => `${l.name} | ${l.url}`).join("\n"))}</textarea></label><h3>Project badges</h3><label>Saved badge collection<select data-project-collection aria-label="Saved badge collection"><option value="">Choose a collection</option>${(this.collections || []).map((c) => `<option value="${h(c.id)}">${h(c.name)}</option>`).join("")}</select></label><button data-attach-collection>Attach collection copy</button><button data-compose-project-badge>Create individual badge</button><ul>${p.badges.map((b, n) => `<li>${h(b.alt || b.label)} <button data-remove-project-badge="${n}" aria-label="Remove project badge ${n + 1}">Remove</button></li>`).join("")}</ul>${p.legacyStatusMarkdown ? `<p class="hint">Original status Markdown is preserved.</p>` : ""}</fieldset></details>`;
  }
  openImport(refresh = []) {
    const area = this.querySelector(".project-import-panel");
    area.innerHTML = "<github-project-picker></github-project-picker>";
    const picker = area.firstElementChild;
    picker.available = this.availableRepositories || [];
    picker.projects = structuredClone(this.value.items);
    picker.refresh = structuredClone(refresh);
    picker.draw();
    picker.addEventListener("project-review-close", () =>
      this.querySelector("[data-project-import]").focus(),
    );
    const snapshot = JSON.stringify(this.value);
    picker.addEventListener("projects-reviewed", (e) => {
      e.stopPropagation();
      if (snapshot !== JSON.stringify(this.value)) {
        picker.querySelector(".project-fetch-status").textContent =
          "Projects changed. Reopen repository review before applying.";
        return;
      }
      for (const p of e.detail.projects) {
        const index = this.value.items.findIndex((i) => i.id === p.id);
        if (e.detail.refreshIds.includes(p.id) && index >= 0)
          this.value.items[index] = p;
        else this.value.items.push(p);
        this.open.add(p.id);
      }
      this.draw();
      this.querySelector(".project-status").textContent =
        `${e.detail.requested} requested · ${e.detail.projects.length} applied · ${e.detail.unavailable} unavailable. ${e.detail.preserved.length} manually edited fields preserved. Save showcase to update the draft.`;
      this.querySelector("[data-project-save]").focus();
    });
    if (refresh.length)
      picker.lookup(
        refresh.map(
          (p) => `${p.metadata.github.owner}/${p.metadata.github.repo}`,
        ),
      );
    else picker.querySelector("input").focus();
  }
  entryElement(i) {
    return this.querySelector(`[data-project-index="${i}"]`);
  }
  redrawEntry(i, selector) {
    this.draw();
    this.entryElement(i)?.querySelector(selector)?.focus();
  }
  row(action, i) {
    const items = this.value.items;
    if (action === "copy") {
      this.copyProject(
        serializeProject(
          items[i],
          this.value.layout === "featured-first"
            ? i === 0
              ? "featured"
              : "compact"
            : this.value.layout,
        ),
      );
      return;
    }
    let next = i;
    if (action === "remove") {
      if (
        !confirm(
          `Delete project “${items[i].name || "Untitled"}” from this working showcase? Save to apply.`,
        )
      )
        return;
      items.splice(i, 1);
      next = Math.min(i, items.length - 1);
    }
    if (action === "duplicate") {
      const copy = structuredClone(items[i]);
      copy.id = crypto.randomUUID();
      items.splice(i + 1, 0, copy);
      this.open.add(copy.id);
      next = i + 1;
    }
    if (action === "up" || action === "down") {
      next = i + (action === "up" ? -1 : 1);
      if (next < 0 || next >= items.length) return;
      [items[next], items[i]] = [items[i], items[next]];
    }
    this.draw();
    (
      this.entryElement(next)?.querySelector("summary") ||
      this.querySelector("[data-project-add]")
    ).focus();
  }
  technologies(el, p, q, index) {
    const matches = q.trim() ? searchLogos(q).slice(0, 8) : [];
    el.querySelector(".project-tech-results").innerHTML = matches
      .map((t, n) => `<button data-project-tech="${n}">${h(t.name)}</button>`)
      .join("");
    el.querySelectorAll("[data-project-tech]").forEach(
      (b) =>
        (b.onclick = () => {
          const t = matches[Number(b.dataset.projectTech)];
          p.technologies.push({
            name: t.name,
            id: t.id,
            logo: t.shieldsLogo,
            brandColor: t.brandColor,
          });
          this.redrawEntry(index, "[data-project-tech-search]");
        }),
    );
  }
  composeBadge(index) {
    const target = this.querySelector(".project-badge-composer");
    target.innerHTML = "<badge-studio></badge-studio>";
    const studio = target.firstElementChild;
    studio.activeTheme = this.activeTheme;
    studio.collectionMode = true;
    studio.insertLabel = "Attach badge to project";
    studio.draw();
    studio.querySelector("[data-insert-badge]").textContent =
      "Attach badge to project";
    studio.addEventListener("badge-insert", (e) => {
      e.stopPropagation();
      this.value.items[index].badges.push(e.detail.badge);
      this.redrawEntry(index, "[data-compose-project-badge]");
    });
    studio.querySelector("input").focus();
  }
  async copyProject(md) {
    try {
      await navigator.clipboard.writeText(md);
      this.querySelector(".project-status").textContent =
        "Project Markdown copied.";
    } catch {
      const area = this.querySelector(".project-copy-fallback");
      area.innerHTML =
        '<p>Clipboard unavailable. Select and copy this Markdown.</p><textarea readonly aria-label="Copy project Markdown fallback" rows="6"></textarea>';
      const input = area.querySelector("textarea");
      input.value = md;
      input.focus();
      input.select();
    }
  }
  preview() {
    try {
      const md = present(serializeShowcase(this.value), {
        type: "projects",
        settings: this.value,
      });
      this.querySelector("[data-project-output]").value = md;
      const paused = new Set(
        this.value.items
          .filter((p) => !this.open.has(p.id))
          .flatMap((p) => [p.imageUrl, p.darkImageUrl])
          .filter(Boolean),
      );
      for (const p of this.value.items.filter((p) => this.open.has(p.id))) {
        paused.delete(p.imageUrl);
        paused.delete(p.darkImageUrl);
      }
      const template = document.createElement("template");
      template.innerHTML = render(md);
      for (const el of template.content.querySelectorAll("img,source")) {
        if (el.tagName === "IMG") el.loading = "lazy";
        if (
          paused.has(el.getAttribute("src")) ||
          paused.has(el.getAttribute("srcset"))
        ) {
          el.removeAttribute("src");
          el.removeAttribute("srcset");
          el.setAttribute(
            "title",
            "Open the project editor to load this screenshot.",
          );
        }
      }
      this.querySelector(".project-preview").replaceChildren(template.content);
      this.querySelector(".project-preview").style.maxWidth =
        this.previewWidth || "100%";
      this.querySelector(".project-guidance").innerHTML =
        projectHealth(this.value.items)
          .map((i) => `<li>${h(i.message)}</li>`)
          .join("") || "<li>No project suggestions.</li>";
      this.querySelector("[data-project-save]").disabled = false;
      return true;
    } catch (e) {
      this.querySelector(".project-status").textContent = e.message;
      this.querySelector("[data-project-save]").disabled = true;
      return false;
    }
  }
  filterEntries() {
    let count = 0;
    for (const entry of this.querySelectorAll(".project-entry")) {
      entry.hidden = !projectMatches(
        this.value.items[Number(entry.dataset.projectIndex)],
        this.search || "",
      );
      if (!entry.hidden) count++;
    }
    this.querySelector(".project-count").textContent =
      `${count} of ${this.value.items.length} projects shown`;
  }
  reviewPack() {
    const area = this.querySelector(".project-pack-review");
    try {
      const pack = readProjectPack(
        this.querySelector("[data-project-pack-json]").value,
      );
      area.innerHTML = `<p>Version ${pack.version} · ${pack.projects.length} projects. Append copies to this working showcase; conflicting IDs and names receive new values.</p><button data-append-project-pack>Append reviewed projects</button>`;
      area.querySelector("button").onclick = () => {
        const added = mergeProjectPack(this.value.items, pack);
        this.value.items.push(...added);
        this.draw();
        this.querySelector(".project-status").textContent =
          `${added.length} projects appended. Save showcase to update the draft.`;
        this.querySelector("[data-project-save]").focus();
      };
      area.querySelector("button").focus();
    } catch (e) {
      area.textContent = e.message;
    }
  }
  async checkLinks() {
    this.linkController?.abort();
    const controller = (this.linkController = new AbortController()),
      snapshot = JSON.stringify(this.value);
    const button = this.querySelector("[data-check-project-links]"),
      area = this.querySelector(".project-link-results");
    button.disabled = true;
    area.textContent = "Checking links… Editing and export remain available.";
    const results = await checkProjectLinks(
      projectLinkTargets(this.value.items),
      { signal: controller.signal },
    );
    if (!this.isConnected || controller.signal.aborted) return;
    button.disabled = false;
    if (snapshot !== JSON.stringify(this.value)) {
      area.textContent =
        "Projects changed during the check. Check again for current results.";
      return;
    }
    area.innerHTML =
      results
        .map((r) => `<p>${h(r.state)} · ${h(r.url)}: ${h(r.message)}</p>`)
        .join("") || "No project URLs to check.";
  }
  disconnectedCallback() {
    this.linkController?.abort();
    clearTimeout(this.timer);
  }
}
customElements.define("project-studio", ProjectStudio);
