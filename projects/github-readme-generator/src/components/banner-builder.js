import {
  newBanner,
  normalizeBanner,
  bannerStyles,
  bannerSizes,
  themePalette,
} from "../banners/banner-model.js";
import { bannerMarkup } from "../banners/export.js";
import { bannerAssetPackage } from "../assets/manifest.js";
import { baseTheme } from "../themes/theme-model.js";
import { derive, explicitOverride } from "../themes/theme-resolver.js";
import { html } from "../markdown/serialize.js";
import { bannerAccessibility } from "../banners/accessibility.js";
export class BannerBuilder extends HTMLElement {
  connectedCallback() {
    this.value ||= newBanner();
    this.initial = JSON.stringify(this.value);
    this.draw();
  }
  set settings(value) {
    this.value = normalizeBanner(value);
    this.initial = JSON.stringify(this.value);
    this.draw();
  }
  isDirty() {
    return this.initial !== JSON.stringify(this.value);
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  draw() {
    this.releaseUrls();
    this.innerHTML = `<h1>Banner Builder</h1><p>Local, self-contained SVG assets. Download the files and commit them to your profile repository. Save settings, then use Publish to GitHub to review and publish generated SVG assets.</p><div class="visual-workbench"><fieldset><legend>Banner settings</legend><div class="visual-fields">${[
      ["name", "Name"],
      ["title", "Primary title"],
      ["subtitle", "Subtitle / tagline"],
      ["website", "Website / handle"],
      ["metadataLine", "Small metadata line"],
      ["alt", "Banner alt text"],
      ["seed", "Decoration seed"],
      ["filename", "Filename base"],
      ["assetDirectory", "Asset folder"],
    ]
      .map(
        ([k, n]) =>
          `<label>${n}<input data-banner="${k}" value="${html(this.value[k])}"></label>`,
      )
      .join(
        "",
      )}<label>Banner dimensions<select data-banner-size aria-label="Banner dimensions"><option value="">Custom</option>${Object.keys(
      bannerSizes,
    )
      .map((k) => `<option>${k}</option>`)
      .join(
        "",
      )}</select></label>${["width", "height"].map((k) => `<label>${k}<input type="number" data-banner="${k}" value="${this.value[k]}" aria-label="Banner ${k}"></label>`).join("")}${[
      ["pattern", "Banner style", bannerStyles],
      ["alignment", "Banner alignment", ["left", "center", "right"]],
      ["themeMode", "Generate variants", ["both", "light", "dark"]],
    ]
      .map(
        ([k, n, values]) =>
          `<label>${n}<select data-banner="${k}" aria-label="${n}">${values.map((v) => `<option ${v === this.value[k] ? "selected" : ""}>${v}</option>`).join("")}</select></label>`,
      )
      .join("")}${Object.entries(this.value.palette)
      .filter(([k]) => k !== "_theme")
      .map(
        ([k, v]) =>
          `<label>Banner ${k}<input data-banner-color="${k}" value="${html(v)}" aria-label="Banner ${k} hex"></label>`,
      )
      .join(
        "",
      )}</div><button data-banner-theme>Use active theme palette</button><button data-banner-alt>Suggest alt from name and title</button>${[
      ["showBorder", "Show border"],
      ["showAccent", "Show accent"],
    ]
      .map(
        ([k, n]) =>
          `<label class="check"><input data-banner="${k}" type="checkbox" ${this.value[k] ? "checked" : ""}> ${n}</label>`,
      )
      .join(
        "",
      )}</fieldset><aside><h2>Local banner preview</h2><section class="banner-accessibility" aria-label="Banner accessibility review"></section><p class="banner-accessibility-status sr-only" role="status" aria-live="polite" aria-atomic="true"></p><label>Preview mode<select data-banner-preview-mode aria-label="Banner preview mode"><option>light</option><option>dark</option></select></label><label>Preview width<select data-banner-preview-width aria-label="Banner preview width"><option value="100%">desktop</option><option value="320px">mobile</option></select></label><div class="banner-preview"></div><label>README picture markup<textarea data-banner-markup readonly rows="6"></textarea></label><label>SVG source<textarea data-banner-svg readonly rows="6"></textarea></label><label>Asset manifest<textarea data-banner-manifest readonly rows="8"></textarea></label><div class="row-actions"><button data-banner-copy="markup">Copy README picture markup</button><button data-banner-copy="svg">Copy SVG source</button><button data-banner-download>Download SVG assets</button><button data-banner-manifest-download>Download asset manifest</button></div><div class="banner-files"></div><label>Banner preset name<input data-banner-preset-name value="My banner preset"></label><button data-save-banner-preset>Save reusable banner preset</button><button data-banner-save>Save banner settings</button><button data-banner-insert class="primary">Insert banner markup</button><p class="banner-status" role="status"></p></aside></div>`;
    for (const input of this.querySelectorAll("[data-banner]"))
      input.oninput = () => {
        this.value[input.dataset.banner] =
          input.type === "checkbox"
            ? input.checked
            : input.type === "number"
              ? Number(input.value)
              : input.value;
        if (
          [
            "width",
            "height",
            "alignment",
            "pattern",
            "themeMode",
            "showBorder",
            "showAccent",
            "seed",
          ].includes(input.dataset.banner)
        )
          explicitOverride(this.value, input.dataset.banner);
        this.schedule();
      };
    for (const input of this.querySelectorAll("[data-banner-color]"))
      input.oninput = () => {
        this.value.palette[input.dataset.bannerColor] = input.value;
        explicitOverride(this.value.palette, input.dataset.bannerColor);
        this.schedule();
      };
    this.querySelector("[data-banner-size]").onchange = (e) => {
      const size = bannerSizes[e.target.value];
      if (size) {
        [this.value.width, this.value.height] = size;
        explicitOverride(this.value, "width");
        explicitOverride(this.value, "height");
        this.draw();
        this.querySelector("[data-banner-size]").value = e.target.value;
        this.querySelector("[data-banner-size]").focus();
      }
    };
    this.querySelector("[data-banner-theme]").onclick = () => {
      derive(this.value.palette, themePalette(this.activeTheme || baseTheme), {
        reset: true,
      });
      this.draw();
      this.querySelector("[data-banner-theme]").focus();
    };
    this.querySelector("[data-banner-alt]").onclick = () => {
      this.value.alt = [this.value.name, this.value.title]
        .filter(Boolean)
        .join(" — ");
      this.querySelector('[data-banner="alt"]').value = this.value.alt;
      this.update();
    };
    for (const key of ["mode", "width"])
      this.querySelector(`[data-banner-preview-${key}]`).onchange = () =>
        this.update();
    for (const button of this.querySelectorAll("[data-banner-copy]"))
      button.onclick = async () => {
        if (!this.update()) return;
        const area = this.querySelector(
          `[data-banner-${button.dataset.bannerCopy}]`,
        );
        try {
          await navigator.clipboard.writeText(area.value);
          this.status("Copied.");
        } catch {
          area.focus();
          area.select();
          this.status("Clipboard unavailable. Copy the selected text.");
        }
      };
    this.querySelector("[data-banner-download]").onclick = () => {
      if (this.update())
        for (const file of this.files)
          this.emit("visual-download", {
            content: file.source,
            name: file.name,
            type: "image/svg+xml",
          });
    };
    this.querySelector("[data-banner-manifest-download]").onclick = () => {
      if (this.update())
        this.emit("visual-download", {
          content: this.package.manifestSource,
          name: "readme-studio-assets.json",
          type: "application/json",
        });
    };
    this.querySelector("[data-save-banner-preset]").onclick = () => {
      if (this.update())
        this.emit("save-reusable-visual", {
          kind: "banners",
          name: this.querySelector("[data-banner-preset-name]").value,
          banner: normalizeBanner(this.value),
        });
    };
    this.querySelector("[data-banner-save]").onclick = () => {
      if (this.update())
        this.emit("banner-save", { banner: normalizeBanner(this.value) });
    };
    this.querySelector("[data-banner-insert]").onclick = () => {
      if (this.update())
        this.emit("banner-save", {
          banner: normalizeBanner(this.value),
          markdown: bannerMarkup(this.value),
        });
    };
    this.update();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), 120);
  }
  status(message) {
    this.querySelector(".banner-status").textContent = message;
  }
  update() {
    this.updateAccessibility();
    try {
      const value = normalizeBanner(this.value),
        key = JSON.stringify(value);
      if (key !== this.cacheKey) {
        this.package = bannerAssetPackage(value);
        this.files = this.package.files;
        this.cacheKey = key;
      }
      const mode = this.querySelector("[data-banner-preview-mode]").value,
        file = this.files.find((f) => f.mode === mode) || this.files[0];
      this.releaseUrls();
      const url = URL.createObjectURL(
        new Blob([file.source], { type: "image/svg+xml" }),
      );
      this.urls = [url];
      const image = new Image();
      image.src = url;
      image.alt = value.alt;
      this.querySelector(".banner-preview").replaceChildren(image);
      this.querySelector(".banner-preview").style.maxWidth = this.querySelector(
        "[data-banner-preview-width]",
      ).value;
      this.querySelector("[data-banner-markup]").value = bannerMarkup(value);
      this.querySelector("[data-banner-svg]").value = file.source;
      this.querySelector("[data-banner-manifest]").value =
        this.package.manifestSource;
      this.querySelector(".banner-files").innerHTML = this.files
        .map(
          (f, i) =>
            `<button data-one-file="${i}">Download ${html(f.name)}</button>`,
        )
        .join("");
      for (const button of this.querySelectorAll("[data-one-file]"))
        button.onclick = () => {
          const f = this.files[Number(button.dataset.oneFile)];
          this.emit("visual-download", {
            content: f.source,
            name: f.name,
            type: "image/svg+xml",
          });
        };
      this.controls(false);
      this.status(
        "Preview generated locally. Asset URLs work after you commit the downloaded files.",
      );
      return true;
    } catch (e) {
      this.controls(true);
      this.status(e.message);
      return false;
    }
  }
  updateAccessibility() {
    const result = bannerAccessibility(this.value),
      previous = this.accessibilityResult,
      area = this.querySelector(".banner-accessibility"),
      status = this.querySelector(".banner-accessibility-status");
    area.innerHTML = `<h3>Accessibility review</h3><p><strong>Alt text:</strong> ${html(result.alt.message)}</p><ul>${result.contrast
      .map(
        (item) =>
          `<li><strong>${html(`${item.mode[0].toUpperCase()}${item.mode.slice(1)} ${item.role}`)}</strong>: ${item.ratio === null ? "Not available" : `${item.ratio.toFixed(1)}:1`} · ${item.level === "pass" ? "Pass" : item.level === "warning" ? "Review" : "Check colors"}. ${html(item.message)}</li>`,
      )
      .join(
        "",
      )}</ul><p>${html(result.motion)}</p><p>Contrast is an estimate for generated text, not a WCAG certification. Inspect both variants.</p>`;
    if (!previous) status.textContent = "Accessibility review ready.";
    else {
      const changes = [];
      if (
        previous.alt.level !== result.alt.level ||
        previous.alt.message !== result.alt.message
      )
        changes.push(`Alt text: ${result.alt.message}`);
      const before = new Map(
          previous.contrast.map((item) => [`${item.mode}:${item.role}`, item]),
        ),
        after = new Set(
          result.contrast.map((item) => `${item.mode}:${item.role}`),
        );
      for (const item of result.contrast) {
        const prior = before.get(`${item.mode}:${item.role}`);
        if (
          prior &&
          prior.level === item.level &&
          prior.ratio === item.ratio &&
          prior.message === item.message
        )
          continue;
        changes.push(
          `${item.mode[0].toUpperCase()}${item.mode.slice(1)} ${item.role}: ${item.ratio === null ? "contrast unavailable" : `${item.ratio.toFixed(1)} to 1, ${item.level === "pass" ? "pass" : "review"}`}.`,
        );
      }
      for (const item of previous.contrast) {
        if (after.has(`${item.mode}:${item.role}`)) continue;
        changes.push(
          `${item.mode[0].toUpperCase()}${item.mode.slice(1)} ${item.role}: no longer applies to the current banner settings.`,
        );
      }
      if (changes.length) status.textContent = changes.join(" ");
    }
    this.accessibilityResult = result;
  }
  controls(disabled) {
    this.querySelectorAll(
      "[data-banner-save],[data-banner-insert],[data-banner-copy],[data-banner-download],[data-banner-manifest-download],[data-one-file]",
    ).forEach((b) => (b.disabled = disabled));
  }
  releaseUrls() {
    for (const url of this.urls || []) URL.revokeObjectURL(url);
    this.urls = [];
  }
  disconnectedCallback() {
    clearTimeout(this.timer);
    this.releaseUrls();
  }
}
customElements.define("banner-builder", BannerBuilder);
