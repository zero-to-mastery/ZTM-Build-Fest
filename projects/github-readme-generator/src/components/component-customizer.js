import { html } from "../markdown/serialize.js";
import { render } from "../markdown/render.js";
import {
  normalizeInstance,
  instanceSource,
  configuredPreset,
  synchronized,
} from "../component-instances/ownership.js";
import {
  normalizePreset,
  renderPreset,
} from "../component-instances/preset.js";
import { validateComponents } from "../components-library/storage.js";
import "./widget-hub.js";
import "./badge-collection-editor.js";
export class ComponentCustomizer extends HTMLElement {
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  status(text) {
    this.querySelector(".customizer-status").textContent = text;
  }
  configure(block, library) {
    this.original = structuredClone(block);
    this.instance = normalizeInstance(block.settings.instance);
    this.library = validateComponents(library);
    this.initial = JSON.stringify(this.instance);
    this.mustConfirm = !synchronized(block);
    this.draw();
  }
  isDirty() {
    if (this.saved) return false;
    try {
      return (
        JSON.stringify(this.working()) !== this.initial ||
        !!this.querySelector("widget-hub")?.isDirty() ||
        !!this.querySelector(".collection-composer badge-studio")
      );
    } catch {
      return true;
    }
  }
  markSaved() {
    this.saved = true;
    const w = this.querySelector("widget-hub");
    if (w) w.dirty = false;
    const b = this.querySelector("badge-collection-editor");
    if (b) b.initial = JSON.stringify(b.items);
  }
  working() {
    const next = structuredClone(this.instance),
      c = next.component;
    if (c.preset?.type === "widget")
      c.preset = normalizePreset(
        this.querySelector("widget-hub").currentPreset(),
      );
    else if (c.preset?.type === "badges") {
      const editor = this.querySelector("badge-collection-editor");
      if (editor.querySelector(".collection-composer badge-studio"))
        throw Error("Finish editing the badge before saving this component.");
      c.preset = normalizePreset({
        version: 1,
        type: "badges",
        collection: editor.items.find((i) => i.id === editor.selected),
      });
    } else
      next.values = Object.fromEntries(
        [...this.querySelectorAll("[data-custom-field]")].map((e) => [
          e.dataset.customField,
          e.value,
        ]),
      );
    if (c.preset && c.preset.type !== "fields")
      c.template = renderPreset(c.preset);
    return normalizeInstance(next);
  }
  draw() {
    const c = this.instance.component;
    this.innerHTML = `<h1>Edit visually: ${html(c.name)}</h1><p>Changes apply only to this component. Your exported README contains ordinary Markdown/HTML. Badge row editors load remote badge images; widget previews load only when requested.</p><div class="customizer-fields">${c.preset?.type === "widget" ? "<widget-hub></widget-hub>" : c.preset?.type === "badges" ? "<badge-collection-editor></badge-collection-editor>" : c.fields.map((f) => `<label>${html(f.label)}${f.type === "textarea" ? `<textarea aria-label="${html(f.label)}" data-custom-field="${f.key}">${html(this.instance.values[f.key] ?? c.preset?.values?.[f.key] ?? f.default)}</textarea>` : `<input data-custom-field="${f.key}" value="${html(this.instance.values[f.key] ?? c.preset?.values?.[f.key] ?? f.default)}">`}</label>`).join("") || "<p>This starter has no editable fields. Detach it to edit its Markdown.</p>"}</div><div class="component-diff" ${this.mustConfirm ? "" : "hidden"}><h2>Source changed outside its visual settings</h2><p>Inspect both versions before replacing current source.</p><label>Current Markdown<textarea data-current-source aria-label="Current Markdown" readonly rows="5"></textarea></label><label><input type="checkbox" data-confirm-component>Replace current source with generated Markdown</label></div><label>Generated Markdown<textarea data-generated-source aria-label="Generated Markdown" readonly rows="6"></textarea></label><button data-custom-preview>Render component preview (contacts image hosts)</button><div class="customizer-preview markdown-body"></div><div class="row-actions"><button data-save-component class="primary">Save component changes</button><button data-duplicate-component>Duplicate configured component</button><button data-detach-component>Keep current source as Custom Markdown</button></div><label>Component preset name<input data-component-preset-name value="${html(c.name)}"></label><button data-save-component-preset>Save configured component preset</button><p class="customizer-status" role="status"></p>`;
    const widget = this.querySelector("widget-hub");
    if (widget) {
      widget.loadPreset(c.preset, this.library);
      widget.querySelector("h1").textContent = "Widget settings";
      for (const el of widget.querySelectorAll(
        "[data-widget-search],[data-widget-favorites]",
      ))
        el.closest("label").hidden = true;
      widget.querySelector(".widget-results").hidden = true;
      widget.querySelector("[data-widget-insert]").hidden = true;
      widget.querySelector("[data-widget-position]").closest("label").hidden =
        true;
    }
    const badges = this.querySelector("badge-collection-editor");
    if (badges) {
      badges.componentMode = true;
      badges.items = [structuredClone(c.preset.collection)];
      badges.selected = badges.items[0].id;
      badges.initial = JSON.stringify(badges.items);
      badges.draw();
      for (const event of ["collections-save", "collection-insert"])
        badges.addEventListener(event, (e) => e.stopPropagation());
    }
    this.querySelector("[data-current-source]").value =
      this.original.settings.markdown;
    this.querySelector(".customizer-fields").addEventListener("input", () => {
      this.querySelector(".customizer-preview").replaceChildren();
      this.refresh();
    });
    this.querySelector(".customizer-fields").addEventListener("click", () =>
      this.refresh(),
    );
    this.querySelector("[data-custom-preview]").onclick = () => {
      if (this.refresh())
        this.querySelector(".customizer-preview").innerHTML = render(
          this.generated,
        );
    };
    this.querySelector("[data-save-component]").onclick = () =>
      this.apply("save");
    this.querySelector("[data-duplicate-component]").onclick = () =>
      this.apply("duplicate");
    this.querySelector("[data-detach-component]").onclick = () => {
      if (
        !confirm(
          "Keep the current stored Markdown and detach visual ownership? Unsaved visual changes will be discarded.",
        )
      )
        return;
      this.emit("component-edit-apply", {
        mode: "detach",
        id: this.original.id,
      });
    };
    this.querySelector("[data-save-component-preset]").onclick = () => {
      try {
        const preset = configuredPreset(
          this.working(),
          this.querySelector("[data-component-preset-name]").value,
        );
        this.emit("component-library-save", {
          library: validateComponents({
            ...this.library,
            snippets: [...this.library.snippets, preset],
          }),
          message: "Configured component preset saved locally.",
        });
      } catch (e) {
        this.status(e.message);
      }
    };
    this.refresh();
  }
  refresh() {
    try {
      this.generated = instanceSource(this.working());
      this.querySelector("[data-generated-source]").value = this.generated;
      this.status("");
      return true;
    } catch (e) {
      this.status(e.message);
      return false;
    }
  }
  apply(mode) {
    if (!this.refresh()) return;
    if (
      this.mustConfirm &&
      !this.querySelector("[data-confirm-component]").checked
    ) {
      this.status(
        "Review Current Markdown and Generated Markdown, then confirm replacement.",
      );
      this.querySelector("[data-confirm-component]").focus();
      return;
    }
    this.emit("component-edit-apply", {
      id: this.original.id,
      mode,
      instance: this.working(),
    });
  }
  reviewConflict(block) {
    this.original = structuredClone(block);
    this.mustConfirm = true;
    this.querySelector(".component-diff").hidden = false;
    this.querySelector("[data-current-source]").value = block.settings.markdown;
    this.querySelector("[data-confirm-component]").checked = false;
    this.status(
      "Component source changed. Review both versions and confirm before saving.",
    );
    this.querySelector("[data-current-source]").focus();
  }
}
customElements.define("component-customizer", ComponentCustomizer);
