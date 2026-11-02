// "Home screen" in Identity & defaults (#78): a household admin chooses
// whether the installed app shows the household's name and icon, and
// publishes them. Publishing stores a copy with the Kin service WITHOUT
// encryption (that is the point: the service builds the manifest from it),
// so the panel says so before the first publish and asks the admin to
// confirm. Only <kin-household-defaults> creates this element, and only for
// an admin, so non-admins never have it in the DOM.
import { bytesToBase64Url, letterIcons, uploadIcons } from "../appearance/install-icons.js";
import { DEFAULT_HOUSEHOLD_BRAND, DEFAULT_HOUSEHOLD_NAME } from "../appearance/household.js";

const PRIVACY_TEXT = "Your household name and icon will be stored by the Kin service without encryption so devices can show them on the home screen. Everything else stays encrypted.";
const PLATFORM_TEXT = "Computers and Android phones pick up changes on their own, usually within a day. On iPhone and iPad, remove Kin from the Home Screen and add it again to see a change.";
const MAX_SHORT_NAME = 12;
const segmenter = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = (text) => segmenter ? [...segmenter.segment(text)].map((part) => part.segment) : [...text];

let sequence = 0;

export class KinInstallIdentity extends HTMLElement {
  connectedCallback() { if (!this.firstElementChild) this.build(); }

  build() {
    const id = `install-identity-${++sequence}`;
    this.className = "install-identity";
    this.setAttribute("role", "group");
    this.setAttribute("aria-labelledby", `${id}-heading`);
    const heading = document.createElement("h3");
    heading.id = `${id}-heading`;
    heading.textContent = "Household icon & home screen";
    const lead = document.createElement("p");
    lead.className = "section-hint";
    lead.textContent = "Choose the household icon shown inside unlocked Kin. You can also publish a copy for installed home screens.";

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "install-toggle";
    this.toggle = document.createElement("input");
    this.toggle.type = "checkbox";
    toggleLabel.append(this.toggle, " Show our name and icon on home screens");

    this.form = document.createElement("div");
    this.form.className = "install-form";
    const shortLabel = document.createElement("label");
    shortLabel.textContent = "Short name";
    this.shortName = document.createElement("input");
    this.shortName.autocomplete = "off";
    this.shortName.maxLength = 48;
    this.shortName.setAttribute("aria-describedby", `${id}-short-help`);
    const shortHelp = document.createElement("small");
    shortHelp.id = `${id}-short-help`;
    shortHelp.textContent = "Shown under the icon. Up to 12 characters.";
    shortLabel.append(this.shortName, shortHelp);

    const descriptionLabel = document.createElement("label");
    descriptionLabel.textContent = "Description (optional)";
    this.description = document.createElement("textarea");
    this.description.rows = 2;
    this.description.maxLength = 200;
    descriptionLabel.append(this.description);

    const iconSet = document.createElement("fieldset");
    const iconLegend = document.createElement("legend");
    iconLegend.textContent = "Icon";
    this.letterChoice = this.radio(`${id}-icon`, "letter", "First letter of the household name");
    this.uploadChoice = this.radio(`${id}-icon`, "upload", "Upload an image");
    this.file = document.createElement("input");
    this.file.type = "file";
    this.file.accept = "image/png,image/jpeg,image/webp";
    this.file.setAttribute("aria-label", "Icon image");
    this.file.hidden = true;
    iconSet.append(iconLegend, this.letterChoice.label, this.uploadChoice.label, this.file);

    this.preview = document.createElement("div");
    this.preview.className = "install-preview";
    this.preview.setAttribute("aria-live", "polite");
    this.anyPreview = this.previewImage("Icon preview");
    this.maskPreview = this.previewImage("Icon preview as cropped by some Android launchers");
    this.maskPreview.wrapper.classList.add("install-preview-maskable");
    this.previewName = document.createElement("span");
    this.previewName.className = "install-preview-name";
    this.preview.append(this.anyPreview.wrapper, this.maskPreview.wrapper, this.previewName);

    this.privacy = document.createElement("p");
    this.privacy.className = "install-privacy";
    this.privacy.id = `${id}-privacy`;
    this.privacy.textContent = PRIVACY_TEXT;
    const confirmLabel = document.createElement("label");
    this.confirm = document.createElement("input");
    this.confirm.type = "checkbox";
    this.confirm.setAttribute("aria-describedby", this.privacy.id);
    confirmLabel.append(this.confirm, " I understand the name and icon are not encrypted");
    this.confirmLabel = confirmLabel;

    const platform = document.createElement("p");
    platform.className = "section-hint";
    platform.textContent = PLATFORM_TEXT;

    this.save = button("Save icon", () => this.publish(), "primary-action");
    this.withdraw = button("Stop showing", () => this.stopShowing());
    const actions = document.createElement("div");
    actions.className = "appearance-actions";
    actions.append(this.save, this.withdraw);
    this.form.append(shortLabel, descriptionLabel, iconSet, this.preview, this.privacy, confirmLabel, platform, actions);

    this.error = document.createElement("p");
    this.error.className = "field-error";
    this.error.setAttribute("role", "alert");
    this.status = document.createElement("p");
    this.status.className = "appearance-feedback";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.append(heading, lead, toggleLabel, this.form, this.error, this.status);

    this.toggle.addEventListener("change", () => this.onToggle());
    this.shortName.addEventListener("input", () => { this.dirty = true; this.renderPreview(); });
    this.description.addEventListener("input", () => { this.dirty = true; });
    for (const choice of [this.letterChoice.input, this.uploadChoice.input])
      choice.addEventListener("change", () => { this.dirty = true; this.file.hidden = !this.uploadChoice.input.checked; void this.regenerate(); });
    this.file.addEventListener("change", () => { this.dirty = true; void this.regenerate(); });
    this.confirm.addEventListener("change", () => this.updateControls());
    this.state = { published: null, householdName: DEFAULT_HOUSEHOLD_NAME, seed: undefined, brand: DEFAULT_HOUSEHOLD_BRAND };
    this.render();
  }

  radio(name, value, text) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    label.append(input, ` ${text}`);
    return { label, input };
  }

  previewImage(alt) {
    const wrapper = document.createElement("span");
    wrapper.className = "install-preview-icon";
    const image = document.createElement("img");
    image.alt = alt;
    image.width = 72;
    image.height = 72;
    wrapper.append(image);
    return { wrapper, image };
  }

  /** { published, householdName, seed, brand } from the app; published is the
   * service's copy (without icon bytes) or null. A draft in progress is kept. */
  initialize({ published, householdName, seed, brand = DEFAULT_HOUSEHOLD_BRAND }) {
    if (!this.firstElementChild) this.build();
    const previous = this.state;
    const changed = (published?.rev ?? 0) !== (previous.published?.rev ?? 0);
    this.state = { published: published ?? null, householdName: householdName || DEFAULT_HOUSEHOLD_NAME, seed, brand };
    if (this.dirty && !changed && !this.writing) { this.renderPreview(); return; }
    // A background sync re-initializes the panel with the same details. A
    // full render would wipe the "Saved." status or an error the admin has
    // not read yet, so only redraw when something the panel shows changed.
    const same = !changed && previous.householdName === this.state.householdName &&
      previous.seed === seed && sameBrand(previous.brand, brand);
    if (same && !this.dirty && !this.writing) { this.renderPreview(); return; }
    const otherAdmin = this.dirty && changed && !this.writing;
    this.dirty = false;
    this.render();
    if (otherAdmin) this.status.textContent = "Another admin changed the home screen details. The latest are shown.";
  }

  render() {
    const { published, householdName } = this.state;
    this.toggle.checked = Boolean(published);
    this.form.hidden = false;
    this.shortName.value = published?.shortName ?? graphemes(householdName).slice(0, MAX_SHORT_NAME).join("").trim();
    this.description.value = published?.description ?? "";
    const upload = this.state.brand?.iconSource === "upload" || (!this.state.brand && published?.iconSource === "upload");
    this.letterChoice.input.checked = !upload;
    this.uploadChoice.input.checked = upload;
    this.file.hidden = !upload;
    this.file.value = "";
    this.confirm.checked = false;
    this.error.textContent = "";
    this.icons = null;
    const privateIcon = upload ? this.state.brand?.icon?.bytes : null;
    this.showIcons(privateIcon ? { any: privateIcon, maskable: privateIcon }
      : published ? { any: published.icons.icon512, maskable: published.icons.maskable512 } : null);
    void this.regenerate();
    this.status.textContent = published && published.name !== householdName
      ? `Home screens still show “${published.name}”. Save to show the new household name.`
      : "";
    this.updateControls();
  }

  onToggle() {
    this.error.textContent = "";
    if (this.toggle.checked) {
      this.dirty = true;
      void this.regenerate();
      this.shortName.focus();
    } else if (this.state.published) {
      this.toggle.checked = true;
      this.stopShowing();
    } else {
      this.dirty = false;
    }
    this.updateControls();
  }

  /** Redraws the icons from the chosen source. An uploaded image keeps the
   * published icons until a new file is chosen. */
  async regenerate() {
    const generation = (this.generation = (this.generation ?? 0) + 1);
    this.error.textContent = "";
    this.iconProblem = false;
    try {
      let icons;
      if (this.uploadChoice.input.checked) {
        const file = this.file.files?.[0] ?? (this.state.brand?.icon
          ? new Blob([this.state.brand.icon.bytes], { type: this.state.brand.icon.type }) : null);
        if (!file) { this.icons = null; this.updateControls(); return; }
        icons = await uploadIcons(file, { seed: this.state.seed });
      } else {
        icons = await letterIcons({ name: this.state.householdName, seed: this.state.seed });
      }
      if (generation !== this.generation) return;
      this.icons = icons;
      this.showIcons({ any: icons.icon512, maskable: icons.maskable512 });
    } catch (error) {
      if (generation !== this.generation) return;
      this.icons = null;
      // Block Save: it must not quietly republish the earlier icons.
      this.iconProblem = true;
      this.error.textContent = error.message || "Kin couldn't make an icon from that image.";
    }
    this.updateControls();
  }

  showIcons(source) {
    for (const url of this.objectUrls ?? []) URL.revokeObjectURL(url);
    this.objectUrls = [];
    const url = (value) => {
      if (typeof value === "string") return value;
      const objectUrl = URL.createObjectURL(new Blob([value], { type: "image/png" }));
      this.objectUrls.push(objectUrl);
      return objectUrl;
    };
    this.anyPreview.image.hidden = this.maskPreview.image.hidden = !source;
    if (source) {
      this.anyPreview.image.src = url(source.any);
      this.maskPreview.image.src = url(source.maskable);
    }
    this.renderPreview();
  }

  renderPreview() {
    this.previewName.textContent = this.shortName.value.trim() || "Kin";
  }

  updateControls() {
    const firstPublish = !this.state.published;
    const publishing = this.toggle.checked;
    this.privacy.hidden = this.confirmLabel.hidden = !firstPublish || !publishing;
    this.withdraw.hidden = firstPublish;
    // Saving an uploaded source with no new file republishes the stored icons
    // only when nothing about the icon changed; otherwise a file is needed.
    const reusing = !this.icons && !this.iconProblem && this.uploadChoice.input.checked && this.state.published?.iconSource === "upload";
    this.save.textContent = publishing ? "Save icon and home screen" : "Save household icon";
    this.save.disabled = this.busy || this.writing || (publishing && firstPublish && !this.confirm.checked) || (!this.icons && !reusing);
    for (const control of this.querySelectorAll("input, textarea")) control.disabled = this.busy || this.writing;
    this.withdraw.disabled = this.busy || this.writing;
  }

  set disabled(value) { this.busy = Boolean(value); if (this.firstElementChild) this.updateControls(); }

  // A publish or withdrawal in flight: one at a time, so a double click
  // can't send a second write that conflicts with the first.
  setWriting(value) { this.writing = value; this.updateControls(); }

  async publish() {
    if (this.writing) return;
    this.error.textContent = "";
    const publishing = this.toggle.checked;
    const shortName = this.shortName.value.trim();
    if (publishing && (!shortName || graphemes(shortName).length > MAX_SHORT_NAME)) {
      this.error.textContent = "Use 1 to 12 characters for the short name.";
      this.shortName.focus();
      return;
    }
    let icons = this.icons;
    this.setWriting(true);
    if (!icons && this.uploadChoice.input.checked && this.state.published?.iconSource === "upload" &&
        Object.keys(this.state.published.icons ?? {}).length === 4) {
      // Keep the published uploaded icons: this device may read them back.
      try {
        icons = Object.fromEntries(await Promise.all(Object.entries(this.state.published.icons).map(async ([key, url]) => {
          const response = await fetch(url, { credentials: "same-origin" });
          if (!response.ok || response.headers.get("content-type") !== "image/png") throw new Error("unavailable");
          return [key, new Uint8Array(await response.arrayBuffer())];
        })));
      } catch {
        icons = null;
      }
    }
    this.setWriting(false);
    if (!icons) {
      this.error.textContent = "Choose an image for the icon first.";
      (this.file.hidden ? this.letterChoice.input : this.file).focus();
      return;
    }
    const value = publishing ? {
      expectedRev: this.state.published?.rev ?? 0,
      name: this.state.householdName,
      shortName,
      description: this.description.value.trim(),
      iconSource: this.uploadChoice.input.checked ? "upload" : "letter",
      icons: Object.fromEntries(Object.entries(icons).map(([key, bytes]) => [key, bytesToBase64Url(bytes)])),
    } : null;
    const brand = this.uploadChoice.input.checked
      ? { version: 1, iconSource: "upload", icon: { type: "image/png", width: 512, height: 512, bytes: icons.icon512.slice() } }
      : { ...DEFAULT_HOUSEHOLD_BRAND };
    this.status.textContent = "Saving…";
    this.setWriting(true);
    this.dispatchEvent(new CustomEvent("kin:publish-install-identity", { bubbles: true, detail: { value, brand, publish: publishing, complete: (result, error) => {
      this.setWriting(false);
      if (error) {
        this.status.textContent = "";
        this.error.textContent = error.code === "install_identity_stale"
          ? "Another admin changed the home screen details. The latest are shown; check them and save again."
          : error.message || "Kin couldn't save the home screen details.";
        return;
      }
      this.dirty = false;
      // The app reloads the published copy; if that failed, at least the
      // next save must not conflict with this one.
      if (publishing && result?.rev && (this.state.published?.rev ?? 0) < result.rev)
        this.state.published = { ...(this.state.published ?? {}), ...value, icons: this.state.published?.icons ?? {}, rev: result.rev };
      this.state.brand = brand;
      this.updateControls();
      this.status.textContent = publishing
        ? "Saved. Unlocked Kin uses this icon now; installed apps show it the next time they check for changes."
        : "Saved. Unlocked household members use this icon; nothing was published for home screens.";
    } } }));
  }

  stopShowing() {
    const published = this.state.published;
    if (!published || this.writing) return;
    if (!confirm("Stop showing your household's name and icon on home screens? The Kin service deletes its copy, and installed apps go back to Kin.")) {
      this.toggle.checked = true;
      return;
    }
    this.error.textContent = "";
    this.setWriting(true);
    this.dispatchEvent(new CustomEvent("kin:withdraw-install-identity", { bubbles: true, detail: { expectedRev: published.rev, complete: (_result, error) => {
      this.setWriting(false);
      if (error) {
        this.error.textContent = error.code === "install_identity_stale"
          ? "Another admin changed the home screen details. The latest are shown."
          : error.message || "Kin couldn't stop showing the home screen details.";
        return;
      }
      this.dirty = false;
      if (this.state.published?.rev === published.rev) { this.state.published = null; this.render(); }
      this.status.textContent = "Home screens go back to Kin the next time they check for changes.";
      this.toggle.focus();
    } } }));
  }

  disconnectedCallback() {
    for (const url of this.objectUrls ?? []) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }
}

function sameBrand(a, b) {
  if ((a?.iconSource ?? null) !== (b?.iconSource ?? null)) return false;
  const x = a?.icon?.bytes, y = b?.icon?.bytes;
  if (!x || !y) return !x && !y;
  return x.length === y.length && x.every((byte, index) => byte === y[index]);
}

function button(label, action, className = "") {
  const value = document.createElement("button");
  value.type = "button";
  value.textContent = label;
  value.className = className;
  value.addEventListener("click", action);
  return value;
}

customElements.define("kin-install-identity", KinInstallIdentity);
