import {
  headingStyles,
  dividerStyles,
  baseTheme,
  safeName,
} from "../themes/theme-model.js";
import { derive, explicitOverride } from "../themes/theme-resolver.js";
import { glyphs } from "../styling/presentation.js";
import { html, serializeBlock } from "../markdown/serialize.js";
import { render } from "../markdown/render.js";
export class SectionStyleEditor extends HTMLElement {
  connectedCallback() {
    this.blocks ||= [];
    this.draw();
  }
  configure(blocks, theme = baseTheme) {
    this.blocks = structuredClone(blocks.filter((b) => b.type !== "custom"));
    this.activeTheme = theme;
    this.select(this.blocks[0]?.id);
  }
  select(id) {
    this.value = structuredClone(this.blocks.find((b) => b.id === id));
    if (this.value) {
      this.value.settings.presentation ||= derive(
        {},
        {
          heading: this.activeTheme.headings.style,
          decoration: this.activeTheme.headings.decoration,
          divider: this.activeTheme.dividers.style,
        },
      );
      this.initial = JSON.stringify(this.value);
    }
    this.draw();
  }
  isDirty() {
    return this.value && JSON.stringify(this.value) !== this.initial;
  }
  draw() {
    if (!this.value) {
      this.innerHTML =
        "<h1>Section Styling</h1><p>Add a builder-owned section first. Custom Markdown is intentionally excluded.</p>";
      return;
    }
    const p = this.value.settings.presentation;
    this.innerHTML = `<h1>Section Styling</h1><p>Style builder-owned presentation. Content and Custom Markdown stay yours.</p><label>Section to style<select data-style-section aria-label="Section to style">${this.blocks.map((b, i) => `<option value="${html(b.id)}" ${b.id === this.value.id ? "selected" : ""}>${i + 1}. ${html(b.settings.title || b.settings.name || b.type)}</option>`).join("")}</select></label><fieldset><legend>Presentation for this section</legend>${[
      ["heading", "Heading style", headingStyles],
      ["divider", "Divider style", dividerStyles],
    ]
      .map(
        ([k, n, values]) =>
          `<label>${n}<select data-style-field="${k}" aria-label="${n}">${values.map((v) => `<option ${v === p[k] ? "selected" : ""}>${v}</option>`).join("")}</select></label>`,
      )
      .join(
        "",
      )}<label>Accent glyph or text<input data-style-field="decoration" value="${html(p.decoration)}" list="section-glyphs"></label><datalist id="section-glyphs">${glyphs.map((g) => `<option value="${html(g)}">`).join("")}</datalist><label class="check" ${["badge", "badges", "picture", "widget"].includes(this.value.type) ? "" : "hidden"}><input data-style-center type="checkbox" ${p.center ? "checked" : ""}> Center compact image/badge content</label><button data-inherit-section>Reset this section to theme defaults</button></fieldset><label>Preview width<select data-style-width aria-label="Section preview width"><option value="100%">desktop</option><option value="320px">mobile</option></select></label><div class="section-style-preview markdown-body"></div><label>Styled Markdown<textarea data-style-output readonly rows="6"></textarea></label><button data-save-style class="primary">Save section style</button><p class="style-status" role="status"></p>`;
    this.querySelector("[data-style-section]").onchange = (e) => {
      if (
        this.isDirty() &&
        !confirm("Discard unapplied styling for this section?")
      ) {
        e.target.value = this.value.id;
        return;
      }
      this.select(e.target.value);
      this.querySelector("[data-style-section]").focus();
    };
    for (const input of this.querySelectorAll("[data-style-field]"))
      input.oninput = () => {
        p[input.dataset.styleField] = input.value;
        explicitOverride(p, input.dataset.styleField);
        this.preview();
      };
    this.querySelector("[data-style-center]").onchange = (e) => {
      p.center = e.target.checked;
      explicitOverride(p, "center");
      this.preview();
    };
    this.querySelector("[data-inherit-section]").onclick = () => {
      if (
        !confirm("Reset this section’s visual overrides to the active theme?")
      )
        return;
      derive(
        p,
        {
          heading: this.activeTheme.headings.style,
          decoration: this.activeTheme.headings.decoration,
          divider: this.activeTheme.dividers.style,
          center: false,
        },
        { reset: true },
      );
      this.draw();
      this.querySelector("[data-inherit-section]").focus();
    };
    this.querySelector("[data-style-width]").onchange = (e) => {
      this.querySelector(".section-style-preview").style.maxWidth =
        e.target.value;
    };
    this.querySelector("[data-save-style]").onclick = () => {
      if (this.preview())
        this.dispatchEvent(
          new CustomEvent("section-style-save", {
            bubbles: true,
            detail: structuredClone(this.value),
          }),
        );
    };
    this.preview();
  }
  preview() {
    try {
      safeName(this.value.settings.presentation.decoration, 16);
      if (this.value.type === "divider")
        this.value.settings.dividerStyle =
          this.value.settings.presentation.divider;
      const md = serializeBlock(this.value);
      this.querySelector("[data-style-output]").value = md;
      this.querySelector(".section-style-preview").innerHTML = render(md);
      this.querySelector("[data-save-style]").disabled = false;
      this.querySelector(".style-status").textContent =
        "Only headings that exist in this block can be styled. Table-based layouts may scroll on mobile.";
      return true;
    } catch (e) {
      this.querySelector(".style-status").textContent = e.message;
      this.querySelector("[data-save-style]").disabled = true;
      return false;
    }
  }
}
customElements.define("section-style-editor", SectionStyleEditor);
