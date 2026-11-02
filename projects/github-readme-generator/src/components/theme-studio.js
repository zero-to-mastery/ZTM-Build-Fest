import {
  baseTheme,
  normalizeTheme,
  paletteKeys,
  headingStyles,
  dividerStyles,
} from "../themes/theme-model.js";
import { builtInThemes } from "../themes/built-ins.js";
import { themeWarnings } from "../themes/contrast.js";
import { badgeDefaults } from "../themes/theme-resolver.js";
import { html } from "../markdown/serialize.js";
import { buildLinkedBadge, styles } from "../badges/shields.js";
import { heading, divider } from "../styling/presentation.js";
import { render } from "../markdown/render.js";
const select = (path, label, choices, value) =>
  `<label>${label}<select data-theme-field="${path}" aria-label="${label}">${choices.map((v) => `<option ${v === value ? "selected" : ""}>${html(v)}</option>`).join("")}</select></label>`;
export class ThemeStudio extends HTMLElement {
  connectedCallback() {
    this.value ||= structuredClone(baseTheme);
    this.initial = JSON.stringify(this.value);
    this.draw();
  }
  set theme(v) {
    this.value = normalizeTheme(v);
    this.initial = JSON.stringify(this.value);
    this.draw();
  }
  isDirty() {
    return JSON.stringify(this.value) !== this.initial;
  }
  draw() {
    this.innerHTML = `<h1>Visual Theme Studio</h1><p>Themes guide generated badges and section accents. They cannot recolor GitHub or change Custom Markdown.</p><label>Built-in theme<select data-theme-choice aria-label="Built-in theme">${builtInThemes.map((t) => `<option value="${t.id}" ${this.value.id === t.id ? "selected" : ""}>${t.name}</option>`).join("")}</select></label><label>Theme name<input data-theme-field="name" value="${html(this.value.name)}"></label><div class="visual-workbench"><fieldset><legend>Palette and defaults</legend><div class="visual-fields">${[...paletteKeys.map((k) => [`palette.${k}`, k, this.value.palette[k]]), ["badges.lightBackground", "Light badge background", this.value.badges.lightBackground], ["badges.darkBackground", "Dark badge background", this.value.badges.darkBackground]].map(([key, label, v]) => `<label>${label}<input data-theme-field="${key}" value="${v}" aria-label="${label} hex"><input type="color" data-theme-color="${key}" value="#${v}" aria-label="${label} color picker"></label>`).join("")}${select("badges.style", "Default badge style", styles, this.value.badges.style)}${select("badges.logoTreatment", "Logo treatment", ["white", "black", "accent"], this.value.badges.logoTreatment)}${select("headings.style", "Default heading style", headingStyles, this.value.headings.style)}<label>Heading decoration<input data-theme-field="headings.decoration" value="${html(this.value.headings.decoration)}"></label>${select("dividers.style", "Default divider style", dividerStyles, this.value.dividers.style)}</div><label class="check"><input type="checkbox" data-theme-pair ${this.value.pictures.preferThemeAware ? "checked" : ""}> Prefer light/dark variants</label></fieldset><aside><h2>Theme sample</h2><label>Sample mode<select data-theme-mode aria-label="Theme sample mode"><option>light</option><option>dark</option></select></label><div class="theme-sample markdown-body"></div><ul class="theme-advice"></ul></aside></div><label>Apply mode<select data-theme-apply-mode aria-label="Apply mode"><option value="derived">Theme-derived settings only</option><option value="reset">Reset to theme defaults</option></select></label><p class="hint">Existing explicit badge colors and manually customized visuals remain unchanged unless you reset. Content is always preserved.</p><button data-save-reusable-theme>Save current theme to library</button><button data-apply-theme class="primary">Apply visual theme</button><p class="theme-status" role="status"></p>`;
    this.querySelector("[data-theme-choice]").onchange = (e) => {
      this.value = structuredClone(
        builtInThemes.find((t) => t.id === e.target.value),
      );
      this.draw();
      this.querySelector("[data-theme-choice]").focus();
    };
    for (const input of this.querySelectorAll(
      "[data-theme-field],[data-theme-color]",
    ))
      input.oninput = () => {
        const path = (
          input.dataset.themeField || input.dataset.themeColor
        ).split(".");
        let target = this.value;
        const key = path.pop();
        for (const k of path) target = target[k];
        target[key] = input.value.replace(/^#/, "");
        if (input.dataset.themeColor)
          this.querySelector(
            `[data-theme-field="${input.dataset.themeColor}"]`,
          ).value = target[key];
        this.preview();
      };
    this.querySelector("[data-theme-pair]").onchange = (e) => {
      this.value.pictures.preferThemeAware = e.target.checked;
      this.preview();
    };
    this.querySelector("[data-theme-mode]").onchange = () => this.preview();
    this.querySelector("[data-save-reusable-theme]").onclick = () => {
      if (this.preview())
        this.dispatchEvent(
          new CustomEvent("save-reusable-visual", {
            bubbles: true,
            detail: {
              kind: "themes",
              name: this.value.name,
              theme: normalizeTheme(this.value),
            },
          }),
        );
    };
    this.querySelector("[data-apply-theme]").onclick = () => {
      if (!this.preview()) return;
      const reset =
        this.querySelector("[data-theme-apply-mode]").value === "reset";
      if (
        reset &&
        !confirm(
          "Reset builder-owned visual overrides to this theme? Project text and Custom Markdown are preserved.",
        )
      )
        return;
      this.dispatchEvent(
        new CustomEvent("theme-apply", {
          bubbles: true,
          detail: { theme: normalizeTheme(this.value), reset },
        }),
      );
    };
    this.preview();
  }
  preview() {
    try {
      const t = normalizeTheme(this.value),
        dark = this.querySelector("[data-theme-mode]").value === "dark",
        defaults = badgeDefaults(t);
      const sample = this.querySelector(".theme-sample");
      sample.style.backgroundColor =
        "#" + t.palette[dark ? "backgroundDark" : "backgroundLight"];
      sample.style.color = "#" + (dark ? "ffffff" : t.palette.foreground);
      sample.innerHTML = render(
        [
          heading("Selected work", {
            heading: t.headings.style,
            decoration: t.headings.decoration,
          }),
          buildLinkedBadge({
            ...defaults,
            color: dark ? defaults.darkColor : defaults.color,
            darkColor: "",
            label: "JavaScript",
            logo: "javascript",
            alt: "JavaScript",
          }),
          buildLinkedBadge({
            ...defaults,
            darkColor: "",
            label: "Portfolio",
            alt: "Visit portfolio",
            link: "https://example.com",
          }),
          divider(t.dividers.style, t.headings.decoration),
        ].join("\n\n"),
      );
      for (const input of this.querySelectorAll("[data-theme-color]")) {
        const [group, key] = input.dataset.themeColor.split(".");
        input.value = "#" + t[group][key];
      }
      this.querySelector(".theme-advice").innerHTML = themeWarnings(t)
        .map((v) => `<li>${html(v)}</li>`)
        .join("");
      this.querySelector(".theme-status").textContent = "";
      this.querySelector("[data-apply-theme]").disabled = false;
      return true;
    } catch (e) {
      this.querySelector(".theme-status").textContent = e.message;
      this.querySelector("[data-apply-theme]").disabled = true;
      return false;
    }
  }
}
customElements.define("theme-studio", ThemeStudio);
