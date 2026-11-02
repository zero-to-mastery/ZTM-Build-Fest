import { widgetRegistry } from "../widgets/registry.js";
import { embedMarkdown, typingURL } from "../widgets/embed.js";
import { html } from "../markdown/serialize.js";
import { render } from "../markdown/render.js";
import {
  validateComponents,
  favoriteComponent,
} from "../components-library/storage.js";
export class WidgetHub extends HTMLElement {
  connectedCallback() {
    this.library = validateComponents(this.library);
    this.value = {
      image: "",
      light: "",
      dark: "",
      link: "",
      alt: "Widget preview",
      align: "left",
      width: "",
      height: "",
    };
    this.draw();
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  isDirty() {
    return !!this.dirty;
  }
  status(message) {
    this.querySelector(".widget-status").textContent = message;
  }
  accept(library, message) {
    this.library = validateComponents(library);
    this.favoriteState();
    this.list();
    this.status(message);
  }
  configure(library) {
    this.library = validateComponents(library);
    this.favoriteState();
  }
  draw() {
    this.innerHTML = `<h1>Dynamic Widget Hub</h1><p>Configure embeds locally. No provider API calls, proxy, account or token required by README Studio.</p><label>Find widgets<input data-widget-search type="search"></label><label><input data-widget-favorites type="checkbox">Favorites only</label><div class="widget-results"></div><div class="widget-detail"></div><p class="widget-status" role="status"></p>`;
    this.querySelector("[data-widget-search]").oninput = () => this.list();
    this.querySelector("[data-widget-favorites]").onchange = () => this.list();
    this.list();
    this.open("generic");
  }
  list() {
    const q = this.querySelector("[data-widget-search]").value.toLowerCase(),
      fav = this.querySelector("[data-widget-favorites]").checked;
    const items = [
      {
        id: "generic",
        name: "Generic image embed",
        description: "Paste your image URLs.",
      },
      ...widgetRegistry,
    ].filter(
      (w) =>
        `${w.name} ${w.description}`.toLowerCase().includes(q) &&
        (!fav || this.library.favorites.includes(`builtin:widget-${w.id}`)),
    );
    this.querySelector(".widget-results").innerHTML =
      items
        .map(
          (w) =>
            `<button data-widget-open="${w.id}">Configure ${html(w.name)}</button>`,
        )
        .join("") || "<p>No matching widgets.</p>";
    for (const b of this.querySelectorAll("[data-widget-open]"))
      b.onclick = () => {
        if (
          this.dirty &&
          !confirm("Discard unsaved widget settings and choose another widget?")
        )
          return;
        this.dirty = false;
        this.open(b.dataset.widgetOpen);
      };
  }
  open(id) {
    this.provider = id;
    this.typing = undefined;
    const w = widgetRegistry.find((w) => w.id === id);
    this.value = {
      image: "",
      light: "",
      dark: "",
      link: "",
      alt: w?.name || "Image description",
      align: "left",
      width: "",
      height: "",
    };
    const detail = this.querySelector(".widget-detail");
    detail.innerHTML = `<h2 tabindex="-1">${html(w?.name || "Generic image embed")}</h2>${w ? `<p>${html(w.description)}</p><dl><dt>Setup</dt><dd>${html(w.setupType)}</dd><dt>GitHub Actions</dt><dd>${html(w.actions)}</dd><dt>Hosting</dt><dd>${html(w.externalHosting)}</dd></dl><p>${html(w.instructions)}</p><p>${html(w.notes)}</p><p>Configured at <a href="${html(w.projectUrl)}" target="_blank" rel="noopener noreferrer">${html(w.name)}</a> · <a href="${html(w.docsUrl)}" target="_blank" rel="noopener noreferrer">Upstream documentation</a></p><button data-widget-favorite aria-pressed="false">Favorite widget</button>` : ""}${
      id === "typing"
        ? `<fieldset><legend>Typing SVG helper</legend><label>Typing lines<textarea data-typing="lines" aria-label="Typing lines">Hello, world!\nI build useful things.</textarea></label>${[
            ["font", "Font", "monospace"],
            ["size", "Font size", "20"],
            ["duration", "Duration (ms)", "5000"],
            ["color", "Text color hex", "36BCF7"],
          ]
            .map(
              ([k, l, v]) =>
                `<label>${l}<input data-typing="${k}" value="${v}"></label>`,
            )
            .join(
              "",
            )}<label><input type="checkbox" data-typing="center">Center typing text</label><button data-generate-typing>Generate typing URL</button></fieldset>`
        : ""
    }${[
      ["image", "Image URL"],
      ["light", "Light image URL"],
      ["dark", "Dark image URL"],
      ["link", "Click-through URL"],
      ["alt", "Alt text"],
      ["width", "Width (pixels)"],
      ["height", "Height (pixels)"],
    ]
      .map(
        ([k, l]) =>
          `<label>${l}<input data-embed="${k}" value="${html(this.value[k])}"></label>`,
      )
      .join(
        "",
      )}<label>Alignment<select data-embed="align" aria-label="Alignment"><option value="left">Left</option><option value="center">Center</option></select></label>${w ? '<label><input type="checkbox" data-widget-credit>Include attribution in README</label>' : ""}<p>Remote preview contacts the image host directly. No draft content is sent; typing text is part of the image URL. Requests are never proxied. Animated SVGs may move even when the app uses reduced motion.</p><button data-widget-preview>Load remote preview</button><div class="widget-preview markdown-body"></div><label>Widget Markdown<textarea data-widget-source readonly rows="6"></textarea></label><button data-widget-copy>Copy widget Markdown</button><label>Widget insert position<select data-widget-position aria-label="Widget insert position"><option value="append">Append to README</option><option value="cursor">At cursor</option></select></label><button data-widget-insert class="primary">Insert widget</button>`;
    for (const el of detail.querySelectorAll("[data-embed]"))
      el.oninput = () => {
        this.value[el.dataset.embed] = el.value;
        if (el.dataset.embed === "image") this.typing = undefined;
        this.dirty = true;
        this.update();
        detail.querySelector(".widget-preview").replaceChildren();
      };
    for (const el of detail.querySelectorAll("[data-typing]"))
      el.oninput = () => (this.dirty = true);
    detail
      .querySelector("[data-generate-typing]")
      ?.addEventListener("click", () => {
        try {
          this.typing = Object.fromEntries(
            [...detail.querySelectorAll("[data-typing]")].map((el) => [
              el.dataset.typing,
              el.type === "checkbox" ? el.checked : el.value,
            ]),
          );
          this.value.image = typingURL(this.typing);
          detail.querySelector('[data-embed="image"]').value = this.value.image;
          this.dirty = true;
          this.update();
        } catch (e) {
          this.status(e.message);
        }
      });
    detail
      .querySelector("[data-widget-favorite]")
      ?.addEventListener("click", () =>
        this.emit("component-library-save", {
          library: favoriteComponent(this.library, `builtin:widget-${id}`),
          message: "Widget favorites updated.",
        }),
      );
    this.favoriteState();
    detail
      .querySelector("[data-widget-credit]")
      ?.addEventListener("change", () => {
        this.dirty = true;
        this.update();
      });
    detail.querySelector("[data-widget-preview]").onclick = () => {
      if (!this.update()) return;
      if (!navigator.onLine) {
        this.status(
          "Offline: remote preview unavailable. Generated Markdown can still be inserted.",
        );
        return;
      }
      const area = detail.querySelector(".widget-preview");
      area.innerHTML = render(this.markdown);
      for (const img of area.querySelectorAll("img")) {
        img.addEventListener(
          "load",
          () =>
            this.status(
              "Remote image loaded. Verify its content before publishing.",
            ),
          { once: true },
        );
        img.addEventListener(
          "error",
          () => {
            const note = document.createElement("span");
            note.className = "media-placeholder";
            note.textContent = "Image preview unavailable";
            img.replaceWith(note);
            this.status(
              "Remote image failed. Check its URL or upstream service. Insertion is still available.",
            );
          },
          { once: true },
        );
      }
      this.status(
        "Loading remote image preview; availability is controlled by its provider.",
      );
    };
    detail.querySelector("[data-widget-copy]").onclick = async () => {
      if (!this.update()) return;
      try {
        await navigator.clipboard.writeText(this.markdown);
        this.status("Widget Markdown copied.");
      } catch {
        const area = detail.querySelector("[data-widget-source]");
        area.focus();
        area.select();
        this.status(
          "Clipboard unavailable. Copy the selected Markdown manually.",
        );
      }
    };
    detail.querySelector("[data-widget-insert]").onclick = () => {
      if (this.update())
        this.emit("component-insert", {
          component: {
            id: `builtin:widget-${id}`,
            name: w?.name || "Image embed",
          },
          markdown: this.markdown,
          position: detail.querySelector("[data-widget-position]").value,
          widget: {
            version: 1,
            provider: id,
            embed: this.value,
            typing: id === "typing" ? this.typing : undefined,
            credit:
              detail.querySelector("[data-widget-credit]")?.checked === true,
          },
        });
    };
    this.update();
    detail.querySelector("h2").focus();
  }
  loadPreset(preset, library) {
    this.library = validateComponents(library);
    this.open(preset.provider);
    this.value = structuredClone(preset.embed);
    this.typing = preset.typing ? structuredClone(preset.typing) : undefined;
    for (const el of this.querySelectorAll("[data-embed]"))
      el.value = this.value[el.dataset.embed] ?? "";
    for (const el of this.querySelectorAll("[data-typing]")) {
      const v = this.typing?.[el.dataset.typing];
      if (v !== undefined) {
        if (el.type === "checkbox") el.checked = v;
        else el.value = v;
      }
    }
    const credit = this.querySelector("[data-widget-credit]");
    if (credit) credit.checked = preset.credit === true;
    this.dirty = false;
    this.update();
  }
  currentPreset() {
    if (!this.update()) throw Error("Correct the widget fields before saving.");
    return {
      version: 1,
      type: "widget",
      provider: this.provider,
      embed: structuredClone(this.value),
      typing: this.typing,
      credit: this.querySelector("[data-widget-credit]")?.checked === true,
    };
  }
  favoriteState() {
    this.querySelector("[data-widget-favorite]")?.setAttribute(
      "aria-pressed",
      String(
        this.library.favorites.includes(`builtin:widget-${this.provider}`),
      ),
    );
  }
  update() {
    try {
      this.markdown = embedMarkdown(this.value);
      const w = widgetRegistry.find((w) => w.id === this.provider);
      if (w && this.querySelector("[data-widget-credit]")?.checked)
        this.markdown += `\n\n[Built with ${w.name}](${w.projectUrl})`;
      this.querySelector("[data-widget-source]").value = this.markdown;
      this.querySelector("[data-widget-insert]").disabled = false;
      this.status(
        this.value.alt.trim()
          ? "Ready to insert; preview does not verify upstream configuration."
          : "Add meaningful alt text so readers understand this image.",
      );
      return true;
    } catch (e) {
      this.querySelector("[data-widget-source]").value = "";
      this.querySelector("[data-widget-insert]").disabled = true;
      this.status(e.message);
      return false;
    }
  }
}
customElements.define("widget-hub", WidgetHub);
