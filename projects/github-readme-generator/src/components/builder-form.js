import {
  documentationSections,
  documentationDefaults,
  environmentFields,
  emptyEnvironmentRow,
} from "../documentation/sections.js";
import { calloutStyles } from "../styling/blocks.js";
import { explicitOverride } from "../themes/theme-resolver.js";
import {
  EXAMPLE_STATUSES,
  readableExampleProvenance,
} from "../documentation/example-provenance.js";
import { html, serializeBlock } from "../markdown/serialize.js";
import { blockTypes as sharedBlockTypes } from "../markdown/block-types.js";
import { render } from "../markdown/render.js";
import technologies from "../data/technologies.json";
import { snippets } from "../data/snippets.js";
import {
  sectionMarkdown,
  unsavedSection,
} from "../workspace/unsaved-section.js";
const field = (key, label, type = "text", options = null) => ({
  key,
  label,
  type,
  options,
});
const badgeFields = [
  field("label", "Label"),
  field("message", "Message"),
  field("logo", "Shields logo"),
  field("style", "Badge style", "select", [
    "flat",
    "flat-square",
    "for-the-badge",
    "plastic",
    "social",
  ]),
  field("color", "Background color"),
  field("labelColor", "Label color"),
  field("logoColor", "Logo color"),
  field("link", "Link URL"),
  field("alt", "Alt text"),
  field("darkColor", "Dark mode background color"),
  field("darkLogoColor", "Dark mode logo color"),
  field("lightUrl", "Custom light badge URL"),
  field("darkUrl", "Custom dark badge URL"),
];
const projectFields = [
  field("name", "Project name"),
  field("icon", "Emoji / icon"),
  field("subtitle", "Short subtitle"),
  field("url", "Project URL"),
  field("github", "GitHub URL"),
  field("demo", "Live demo URL"),
  field("description", "Description", "textarea"),
  field("highlights", "Engineering highlights (one per line)", "textarea"),
  field("stack", "Tech stack"),
  field("image", "Screenshot URL"),
  field("status", "Status badge Markdown", "textarea"),
  field("layout", "Layout", "select", ["detailed", "compact", "card"]),
];
const socialNames = [
  "Website",
  "Portfolio",
  "Blog",
  "LinkedIn",
  "GitHub",
  "CodePen",
  "Dev.to",
  "Hashnode",
  "Mastodon",
  "Bluesky",
  "Resume",
  "Email",
  "Custom",
];
export const blockTypes = sharedBlockTypes;
export function defaults(type) {
  if (documentationSections[type]) return documentationDefaults(type);
  if (type === "callout") return { style: "note", title: "", body: "" };
  if (type === "details")
    return { summary: "More details", body: "", open: false };
  if (type === "code")
    return {
      title: "",
      language: "js",
      code: "",
      collapsed: false,
      open: false,
      exampleProvenance: { status: "placeholder", basis: "" },
    };
  if (type === "columns")
    return { leftTitle: "", leftBody: "", rightTitle: "", rightBody: "" };
  if (type === "hero") return { name: "Your Name", subtitle: "" };
  if (type === "stack") return { items: [], style: "badges", headings: true };
  if (type === "projects") return { items: [], title: "Selected Projects" };
  if (type === "social" || type === "contact")
    return { items: [], style: "badges" };
  if (type === "badges") return { items: [], title: "" };
  if (type === "badge")
    return {
      label: "Built with",
      message: "care",
      color: "6558d3",
      style: "flat",
    };
  if (type === "picture")
    return { light: "", dark: "", alt: "", align: "left" };
  if (type === "widget")
    return {
      snippet: "constellation",
      image: "",
      alt: "GitHub Constellation",
      align: "center",
    };
  if (type === "custom") return { markdown: "" };
  return { title: blockTypes[type], body: "" };
}
export class BuilderForm extends HTMLElement {
  set block(value) {
    this.value = structuredClone(value);
    this.opened = sectionMarkdown(this.value);
    this.draw();
  }
  // Edits that would change the README but are not saved to it yet.
  isDirty() {
    return !!this.value && unsavedSection(this.opened, this.value);
  }
  // Whether the fields can produce Markdown, so Save section can succeed.
  canSave() {
    return !!this.value && sectionMarkdown(this.value) !== null;
  }
  // Saves the section as the submit button does; false when its fields are
  // invalid, so nothing was saved.
  save() {
    if (!this.output()) return false;
    this.dispatchEvent(
      new CustomEvent("commit", {
        detail: structuredClone(this.value),
        bubbles: true,
      }),
    );
    return true;
  }
  fields(fields, object, prefix = "") {
    return fields
      .map((f) => {
        const path = prefix + f.key;
        const value = object[f.key] ?? "";
        const attrs = `data-path="${path}" aria-label="${html(f.label)}"`;
        return `<label>${html(f.label)}${f.type === "textarea" ? `<textarea ${attrs} rows="4">${html(value)}</textarea>` : f.type === "checkbox" ? `<input type="checkbox" ${attrs} ${value ? "checked" : ""}>` : f.type === "select" ? `<select ${attrs}>${f.options.map((o) => `<option ${o === value ? "selected" : ""}>${html(o)}</option>`).join("")}</select>` : `<input ${attrs} value="${html(value)}">`}</label>`;
      })
      .join("");
  }
  rows(fields) {
    return this.value.settings.items
      .map(
        (item, i) =>
          `<fieldset><legend>Entry ${i + 1}</legend>${this.fields(fields, item, `items.${i}.`)}${this.value.type === "projects" ? `<label>Custom links (Label | URL, one per line)<textarea data-links="${i}">${html((item.links || []).map((l) => `${l.name} | ${l.url}`).join("\n"))}</textarea></label>` : ""}<div class="row-actions"><button type="button" data-row="up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move entry ${i + 1} up">↑</button><button type="button" data-row="down" data-index="${i}" ${i === this.value.settings.items.length - 1 ? "disabled" : ""} aria-label="Move entry ${i + 1} down">↓</button><button type="button" data-row="duplicate" data-index="${i}" ${(this.value.type === "doc-environment" || documentationSections[this.value.type]?.rowFields) && this.value.settings.items.length >= 200 ? "disabled" : ""}>Duplicate entry</button><button type="button" data-row="remove" data-index="${i}">Remove entry</button></div></fieldset>`,
      )
      .join("");
  }
  draw() {
    const { type, settings: s } = this.value;
    let form = "";
    if (documentationSections[type]) {
      const definition = documentationSections[type];
      if (
        s.version !== 1 ||
        ((definition.rows || definition.rowFields) &&
          (!Array.isArray(s.items) || s.items.length > 200))
      )
        throw Error("Unsupported documentation settings.");
      const codeFields = definition.fields.filter(
        (field) => field.kind === "code",
      );
      form =
        '<p class="hint">Document project facts. Code and command examples need an explicit provenance status; Studio records the label but never runs them. Leave unknown details blank.</p>' +
        this.fields(
          [
            field("title", "Section heading"),
            ...definition.fields.map((f) =>
              field(
                f.key,
                f.label,
                ["text", "link"].includes(f.kind) ? "text" : "textarea",
              ),
            ),
          ],
          s,
        );
      form += codeFields
        .map((field) => {
          const provenance = readableExampleProvenance(
            s.exampleProvenance?.[field.key],
          ) || { status: "", basis: "" };
          return `<fieldset class="example-provenance"><legend>${html(field.label)} provenance</legend><label>Status<select data-path="exampleProvenance.${field.key}.status" aria-label="${html(field.label)} status">${[
            ["", "Unclassified"],
            ["placeholder", "Placeholder"],
            ["user-confirmed", "User-confirmed"],
            ["verified", "Verified"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${provenance.status === value ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></label><label>Verification note or evidence<textarea data-path="exampleProvenance.${field.key}.basis" aria-label="${html(field.label)} verification note or evidence" rows="2">${html(provenance.basis)}</textarea></label></fieldset>`;
        })
        .join("");
      if (definition.guidance)
        form += `<p class="hint">${html(definition.guidance)}</p>`;
      if (definition.rowFields)
        form +=
          this.rows(definition.rowFields) +
          `<button type="button" data-add="documentation" ${s.items.length >= 200 ? "disabled" : ""}>${html(definition.addLabel)}</button>`;
      if (definition.rows)
        form +=
          '<p class="hint">Never paste real secrets here. Use placeholders such as YOUR_API_TOKEN in .env.example; keep real .env credentials outside version control.</p>' +
          this.rows(environmentFields) +
          `<button type="button" data-add="environment" ${s.items.length >= 200 ? "disabled" : ""}>Add environment variable</button>`;
    } else if (type === "callout")
      form = this.fields(
        [
          field("style", "Callout style", "select", calloutStyles),
          field("title", "Callout title"),
          field("body", "Callout text", "textarea"),
        ],
        s,
      );
    else if (type === "details")
      form =
        this.fields(
          [
            field("summary", "Details summary"),
            field("body", "Details Markdown", "textarea"),
          ],
          s,
        ) +
        '<label class="check"><input type="checkbox" data-path="open" ' +
        (s.open ? "checked" : "") +
        "> Initially open</label>";
    else if (type === "code")
      form =
        this.fields(
          [
            field("title", "Code title"),
            field("language", "Code language"),
            field("code", "Code source", "textarea"),
          ],
          s,
        ) +
        (() => {
          const provenance = readableExampleProvenance(s.exampleProvenance) || {
            status: "",
            basis: "",
          };
          return `<fieldset class="example-provenance"><legend>Code source provenance</legend><label>Status<select data-path="exampleProvenance.status" aria-label="Code source status">${[
            ["", "Unclassified"],
            ["placeholder", "Placeholder"],
            ["user-confirmed", "User-confirmed"],
            ["verified", "Verified"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${provenance.status === value ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></label><label>Verification note or evidence<textarea data-path="exampleProvenance.basis" aria-label="Code source verification note or evidence" rows="2">${html(provenance.basis)}</textarea></label></fieldset><label class="check"><input type="checkbox" data-path="collapsed" ${s.collapsed ? "checked" : ""}> Wrap in collapsible details</label><label class="check"><input type="checkbox" data-path="open" ${s.open ? "checked" : ""}> Initially open</label>`;
        })();
    else if (type === "columns")
      form =
        '<p class="hint">Tables may scroll on mobile. Keep both columns short. Text is escaped; Markdown inside cells is not interpreted.</p>' +
        this.fields(
          [
            field("leftTitle", "Left title"),
            field("leftBody", "Left text", "textarea"),
            field("rightTitle", "Right title"),
            field("rightBody", "Right text", "textarea"),
          ],
          s,
        );
    else if (type === "hero")
      form = this.fields(
        [field("name", "Name"), field("subtitle", "Introduction", "textarea")],
        s,
      );
    else if (type === "badge") form = this.fields(badgeFields, s);
    else if (type === "badges")
      form =
        this.fields([field("title", "Group heading")], s) +
        this.rows(badgeFields) +
        '<button type="button" data-add="badge">+ Add badge to row</button>';
    else if (type === "picture")
      form = this.fields(
        [
          field("light", "Light image URL"),
          field("dark", "Dark image URL"),
          field("alt", "Alt text"),
          field("link", "Link URL"),
          field("width", "Width"),
          field("height", "Height"),
          field("align", "Alignment", "select", ["left", "center"]),
        ],
        s,
      );
    else if (type === "projects")
      form =
        '<p class="hint">Describe engineering decisions and outcomes, not only features.</p>' +
        this.fields([field("title", "Section heading")], s) +
        this.rows(projectFields) +
        '<button type="button" data-add="project">+ Add project entry</button>';
    else if (type === "social" || type === "contact")
      form =
        this.fields(
          [
            field("style", "Output style", "select", [
              "badges",
              "links",
              "footer",
            ]),
          ],
          s,
        ) +
        this.rows([
          field("destination", "Destination", "select", socialNames),
          field("name", "Link label"),
          field("url", "URL (https:// or mailto:)"),
          field("logo", "Logo"),
        ]) +
        '<button type="button" data-add="social">+ Add social link</button>';
    else if (type === "stack")
      form = `<p class="hint">Choose tools you could comfortably discuss.</p>${this.fields([field("style", "Output style", "select", ["badges", "chips", "text"])], s)}<label class="check"><input type="checkbox" data-path="headings" ${s.headings ? "checked" : ""}> Category headings</label><label>Search technologies<input data-search placeholder="React, Rust, testing…"></label><div class="catalog"></div><div class="selected-tech">${s.items.map((i, n) => `<span class="chip">${html(i.name)}<button type="button" data-tech-remove="${n}" aria-label="Remove ${html(i.name)}">×</button></span>`).join("")}</div><details><summary>Custom technology</summary><label>Name<input data-custom="name"></label><label>Logo<input data-custom="logo"></label><label>Color<input data-custom="brandColor" value="6558d3"></label><label>Category<select data-custom="category">${["Frontend", "Backend", "Languages", "Databases", "Testing", "Tooling", "DevOps", "Cloud", "Other"].map((c) => `<option>${c}</option>`).join("")}</select></label><button type="button" data-add="technology">Add custom technology</button></details>`;
    else if (type === "widget") {
      const snippet = snippets.find((i) => i.id === s.snippet) || snippets[0];
      form =
        `<label>Widget project<select data-path="snippet">${snippets.map((i) => `<option value="${i.id}" ${i.id === snippet.id ? "selected" : ""}>${i.name}</option>`).join("")}</select></label><div class="callout"><strong>${snippet.name}</strong><p>${snippet.description}</p><p>${snippet.instructions}</p><a href="${snippet.projectUrl}" target="_blank" rel="noopener noreferrer">Project & setup instructions ↗</a></div>` +
        this.fields(
          [
            field("image", "Image URL"),
            field("link", "Link URL"),
            field("alt", "Alt text"),
            field("align", "Alignment", "select", ["left", "center"]),
          ],
          s,
        );
    } else if (type === "custom")
      form =
        '<p class="hint">Your Markdown, exactly as you write it.</p>' +
        this.fields([field("markdown", "Custom Markdown", "textarea")], s);
    else if (type !== "divider")
      form =
        '<p class="hint">Focus on what you build, what you care about, and what you’re exploring.</p>' +
        this.fields(
          [field("title", "Heading"), field("body", "Content", "textarea")],
          s,
        );
    this.innerHTML = `<form><button type="button" data-studio>Open Badge Studio for this section</button>${form}<details class="markup"><summary>Generated Markdown & preview</summary><pre data-output></pre><div class="mini-preview markdown-body"></div></details><div class="form-actions"><button type="submit" class="primary">${this.value.id ? "Save section" : "Add to README"}</button><button type="button" data-copy>Copy Markdown</button><button type="button" data-cancel>Cancel</button></div></form>`;
    if (type === "stack") {
      this.querySelector("form").insertAdjacentHTML(
        "afterbegin",
        `<label>Category to save<select data-save-category>${[...new Set(s.items.map((i) => i.category || "Other"))].map((c) => `<option>${html(c)}</option>`).join("")}</select></label><button type="button" data-save-stack>Save category as collection</button><button type="button" data-insert-stack>Insert saved collection into stack</button>`,
      );
      this.querySelector("[data-save-stack]").onclick = () => {
        const category = this.querySelector("[data-save-category]").value;
        if (category)
          this.dispatchEvent(
            new CustomEvent("stack-collection-save", {
              bubbles: true,
              detail: {
                name: category,
                badges: s.items
                  .filter((i) => (i.category || "Other") === category)
                  .map((i) => ({
                    ...i,
                    label: i.name,
                    color: i.color || i.brandColor,
                    alt: i.alt || i.name,
                  })),
              },
            }),
          );
      };
      this.querySelector("[data-insert-stack]").onclick = () =>
        this.dispatchEvent(
          new CustomEvent("open-collections", { bubbles: true }),
        );
    }
    if (type === "projects") {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Open Project Studio";
      b.onclick = () =>
        this.dispatchEvent(
          new CustomEvent("open-project-studio", { bubbles: true }),
        );
      this.querySelector("form").prepend(b);
    }
    this.querySelector("[data-studio]").onclick = () =>
      this.dispatchEvent(
        new CustomEvent("open-badge-studio", { bubbles: true }),
      );
    this.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      this.save();
    };
    this.oninput = (e) => {
      const p = e.target.dataset.path;
      if (p) {
        const keys = p.split(".");
        let obj = s;
        keys.slice(0, -1).forEach((k, index) => {
          const arrayPath = /^\d+$/.test(keys[index + 1]);
          if (
            !obj[k] ||
            typeof obj[k] !== "object" ||
            (Array.isArray(obj[k]) && !arrayPath)
          )
            obj[k] = {};
          obj = obj[k];
        });
        obj[keys.at(-1)] =
          e.target.type === "checkbox" ? e.target.checked : e.target.value;
        const documentationCode = documentationSections[type]?.fields.find(
          (item) => item.kind === "code" && item.key === p,
        );
        if (documentationCode || (type === "code" && p === "code")) {
          if (documentationCode) {
            if (
              !s.exampleProvenance ||
              typeof s.exampleProvenance !== "object" ||
              Array.isArray(s.exampleProvenance)
            )
              s.exampleProvenance = {};
            s.exampleProvenance[p] = { status: "placeholder", basis: "" };
            this.querySelector(
              `[data-path="exampleProvenance.${p}.status"]`,
            ).value = "placeholder";
            this.querySelector(
              `[data-path="exampleProvenance.${p}.basis"]`,
            ).value = "";
          } else {
            s.exampleProvenance = { status: "placeholder", basis: "" };
            this.querySelector('[data-path="exampleProvenance.status"]').value =
              "placeholder";
            this.querySelector('[data-path="exampleProvenance.basis"]').value =
              "";
          }
        } else if (p.endsWith(".basis")) {
          const provenance =
            keys.length === 2
              ? s.exampleProvenance
              : s.exampleProvenance?.[keys[1]];
          if (provenance && !EXAMPLE_STATUSES.includes(provenance.status)) {
            provenance.status = "placeholder";
            const statusPath = p.replace(/\.basis$/, ".status");
            this.querySelector(`[data-path="${statusPath}"]`).value =
              "placeholder";
          }
        }
        if (
          obj._theme?.derived &&
          Object.hasOwn(obj._theme.derived, keys.at(-1))
        )
          explicitOverride(obj, keys.at(-1));
        if (p === "snippet") {
          s.alt = snippets.find((i) => i.id === s.snippet).name;
          this.draw();
          return;
        }
      }
      if (e.target.dataset.links !== undefined)
        s.items[Number(e.target.dataset.links)].links = e.target.value
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [name, ...url] = l.split("|");
            return { name: name.trim(), url: url.join("|").trim() };
          });
      if (e.target.hasAttribute("data-search")) this.catalog(e.target.value);
      if (p?.endsWith(".destination")) {
        const i = Number(p.split(".")[1]);
        s.items[i].name = e.target.value === "Custom" ? "" : e.target.value;
        this.draw();
        return;
      }
      this.output();
    };
    this.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-cancel"))
        this.dispatchEvent(new CustomEvent("cancel", { bubbles: true }));
      if (b.hasAttribute("data-copy"))
        this.dispatchEvent(
          new CustomEvent("copy-markup", {
            detail: serializeBlock(this.value),
            bubbles: true,
          }),
        );
      if (b.dataset.row) {
        const i = Number(b.dataset.index);
        if (b.dataset.row === "remove") s.items.splice(i, 1);
        if (b.dataset.row === "duplicate")
          s.items.splice(i + 1, 0, structuredClone(s.items[i]));
        if (b.dataset.row === "up" || b.dataset.row === "down") {
          const j = i + (b.dataset.row === "up" ? -1 : 1);
          [s.items[i], s.items[j]] = [s.items[j], s.items[i]];
        }
        const next =
          b.dataset.row === "up"
            ? i - 1
            : b.dataset.row === "down"
              ? i + 1
              : Math.min(i, s.items.length - 1);
        this.draw();
        (
          this.querySelector(
            `[data-index="${next}"][data-row="${b.dataset.row}"]:not(:disabled)`,
          ) ||
          this.querySelectorAll("fieldset")[Math.max(next, 0)]?.querySelector(
            "input,textarea,select",
          ) ||
          this.querySelector("[data-add]")
        )?.focus();
      }
      if (b.dataset.add) {
        const kind = b.dataset.add;
        if (kind === "documentation") {
          if (s.items.length >= 200) return;
          s.items.push(
            Object.fromEntries(
              documentationSections[type].rowFields.map((field) => [
                field.key,
                field.type === "checkbox" ? false : "",
              ]),
            ),
          );
        } else if (kind === "environment") {
          if (s.items.length >= 200) return;
          s.items.push(emptyEnvironmentRow());
        } else if (kind === "technology") {
          const item = {};
          this.querySelectorAll("[data-custom]").forEach(
            (i) => (item[i.dataset.custom] = i.value),
          );
          if (!item.name.trim()) return;
          s.items.push(item);
        } else
          s.items.push(
            kind === "project"
              ? { name: "New project", layout: "detailed" }
              : kind === "social"
                ? { destination: "Website", name: "Website", url: "" }
                : { label: "Badge", color: "6558d3", style: "flat" },
          );
        this.draw();
        (
          this.querySelectorAll("fieldset")[s.items.length - 1]?.querySelector(
            "input,textarea,select",
          ) || this.querySelector("[data-search]")
        )?.focus();
      }
      if (b.dataset.tech) {
        s.items.push(
          structuredClone(technologies.find((t) => t.id === b.dataset.tech)),
        );
        this.draw();
        this.querySelector("[data-search]")?.focus();
      }
      if (b.dataset.techRemove !== undefined) {
        s.items.splice(Number(b.dataset.techRemove), 1);
        this.draw();
        this.querySelector("[data-search]")?.focus();
      }
    };
    this.catalog("");
    this.output();
  }
  catalog(query) {
    const el = this.querySelector(".catalog");
    if (!el) return;
    el.innerHTML =
      technologies
        .filter(
          (t) =>
            [t.name, t.category, ...t.aliases]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase()) &&
            !this.value.settings.items.some((i) => i.id === t.id),
        )
        .map(
          (t) =>
            `<button type="button" data-tech="${t.id}">${html(t.name)} <small>${html(t.category)}</small></button>`,
        )
        .join("") ||
      '<p class="hint">No matches. Add a custom technology below.</p>';
  }
  output() {
    try {
      const md = serializeBlock(this.value);
      this.querySelector("[data-output]").textContent = md;
      this.querySelector(".mini-preview").innerHTML = render(md);
      this.querySelectorAll('[type="submit"],[data-copy]').forEach(
        (b) => (b.disabled = false),
      );
      this.querySelector(".builder-validation")?.remove();
      return true;
    } catch (error) {
      let status = this.querySelector(".builder-validation");
      if (!status) {
        status = document.createElement("p");
        status.className = "builder-validation";
        status.setAttribute("role", "status");
        this.querySelector(".form-actions").before(status);
      }
      status.textContent = error.message;
      this.querySelectorAll('[type="submit"],[data-copy]').forEach(
        (b) => (b.disabled = true),
      );
      return false;
    }
  }
}
customElements.define("builder-form", BuilderForm);
