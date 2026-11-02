// Personal and household appearance and household identity.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { loadCachedHouseholdSettings } from "../../sync/sync-coordinator.js";
import { paletteCss, paletteForSeed } from "../../appearance/palette.js";
import { DEFAULT_APPEARANCE, saveAppearance } from "../../appearance/store.js";
import { DEFAULT_HOUSEHOLD_BRAND, DEFAULT_HOUSEHOLD_NAME, personalAppearanceFromDraft, resolveAppearance } from "../../appearance/household.js";
import { firstGrapheme, letterColors } from "../../appearance/install-icons.js";

export class AppearanceController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.householdDefaultsRefreshGeneration = 0;
  }

  resolvedAppearanceMode(mode) {
    return mode === "system" ? (this.app.systemAppearance?.matches ? "dark" : "light") : mode;
  }
  applyAppearance(value) {
    if (!value || !this.app.vault || this.app.vault.locked) return;
    this.app.currentAppearance = structuredClone(value);
    const resolvedMode = this.resolvedAppearanceMode(value.mode);
    const tokens = paletteForSeed(value.seed, resolvedMode);
    if (!this.app.appearanceSheet && typeof CSSStyleSheet === "function") {
      this.app.appearanceSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.app.appearanceSheet];
    }
    const rules = value.mode === "system"
      ? `${paletteCss(paletteForSeed(value.seed, "light"))}@media (prefers-color-scheme:dark){${paletteCss(paletteForSeed(value.seed, "dark"))}}`
      : paletteCss(tokens);
    this.app.appearanceSheet?.replaceSync(rules);
    document.documentElement.dataset.kinAppearance = value.mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tokens["header-bg"]);
    const imageUnchanged = value.image && this.app.appearanceImageBytes && value.image.type === this.app.appearanceImageType &&
      value.image.bytes.length === this.app.appearanceImageBytes.length && value.image.bytes.every((byte, index) => byte === this.app.appearanceImageBytes[index]);
    if (!imageUnchanged && (value.image || this.app.appearanceImageBytes)) {
      if (this.app.appearanceObjectUrl) URL.revokeObjectURL(this.app.appearanceObjectUrl);
      this.app.appearanceObjectUrl = value.image ? URL.createObjectURL(new Blob([value.image.bytes], { type: value.image.type })) : null;
      this.app.appearanceImageBytes = value.image ? value.image.bytes.slice() : null;
      this.app.appearanceImageType = value.image?.type ?? null;
      this.app.appearanceBackground.src = this.app.appearanceObjectUrl ?? "";
      this.app.appearanceBackground.hidden = !this.app.appearanceObjectUrl;
      this.app.toggleAttribute("data-personal-background", Boolean(this.app.appearanceObjectUrl));
    }
  }
  async handleSaveAppearance(event) {
    const { value, baseline, forceExplicit, complete } = event.detail;
    const session = this.ctx.session.captureSession();
    try {
      const next = personalAppearanceFromDraft(this.app.personalAppearance, value, baseline, { forceExplicit });
      const saved = await saveAppearance(session.store, session.vault, next);
      this.ctx.session.assertCurrentSession(session);
      this.app.personalAppearance = structuredClone(saved);
      const effective = resolveAppearance(saved, this.app.householdSettings);
      this.ctx.appearance.applyAppearance(effective);
      complete(effective, null);
      // Theme follows the member to their other devices (#525).
      void this.ctx.privatePrefs.settingsChanged(["theme-mode", "theme-color"]);
    } catch (error) {
      if (this.ctx.session.isCurrentSession(session)) complete(null, new Error("Kin couldn't save your appearance. Your previous saved appearance is unchanged."));
    }
  }
  async handleUseHouseholdAppearance(event) {
    const session = this.ctx.session.captureSession();
    try {
      this.app.personalAppearance = await saveAppearance(session.store, session.vault, event.detail.value);
      this.ctx.session.assertCurrentSession(session);
      const effective = resolveAppearance(this.app.personalAppearance, this.app.householdSettings);
      this.app.appearance.initialize(effective);
      this.ctx.appearance.applyAppearance(effective);
      this.ctx.status.setStatus("Now following the household appearance on this device.");
      void this.ctx.privatePrefs.settingsChanged(["theme-mode", "theme-color"]);
    } catch { if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
  }
  async handleInheritAppearanceProperty(event) {
    const session = this.ctx.session.captureSession();
    const next = { ...this.app.personalAppearance, version: 2 };
    if (event.detail.property === "mode") delete next.mode;
    if (event.detail.property === "color") { delete next.colorSource; delete next.seed; delete next.manual; }
    if (event.detail.property === "background") {
      delete next.image;
      if (next.colorSource === "background") { delete next.colorSource; delete next.seed; delete next.manual; }
    }
    try {
      this.app.personalAppearance = await saveAppearance(session.store, session.vault, next);
      this.ctx.session.assertCurrentSession(session);
      const effective = resolveAppearance(this.app.personalAppearance, this.app.householdSettings);
      this.app.appearance.initialize(effective);
      this.ctx.appearance.applyAppearance(effective);
      this.ctx.status.setStatus(`Now following the household ${event.detail.property} on this device.`);
      void this.ctx.privatePrefs.settingsChanged(["theme-mode", "theme-color"]);
    } catch { if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
  }
  applyEffectiveAppearance() {
    const effective = resolveAppearance(this.app.personalAppearance, this.app.householdSettings);
    this.ctx.appearance.applyAppearance(effective);
    this.setHouseholdIdentity(this.app.householdSettings?.name ?? DEFAULT_HOUSEHOLD_NAME, this.app.householdSettings);
  }
  setHouseholdIdentity(name, settings = this.app.householdSettings) {
    this.app.householdName = name;
    if (this.app.brandTitle) { this.app.brandTitle.textContent = name; this.app.brandTitle.title = name; }
    this.app.brandLink?.setAttribute("aria-label", `${name} — Today`);
    this.setHouseholdBrand(settings, name);
    if (this.app.vault && !this.app.vault.locked) document.title = `${name} — Kin`;
  }
  setHouseholdBrand(settings, name) {
    if (!this.app.brandGenericMark) return;
    const brand = settings?.brand;
    if (!settings || !brand) { this.showGenericBrand(); return; }
    const { background, foreground } = letterColors(settings.appearance?.seed);
    this.app.brandLetterMark.textContent = firstGrapheme(name);
    this.app.brandLetterMark.style.background = background;
    this.app.brandLetterMark.style.color = foreground;
    this.app.brandGenericMark.hidden = true;
    this.app.brandLetterMark.hidden = false;
    if (brand.iconSource !== "upload" || !brand.icon) {
      this.clearUploadedBrand();
      this.app.brandRevision = `${settings.revision}:letter`;
      return;
    }
    const revision = `${settings.revision}:upload`;
    if (this.app.brandRevision === revision && this.app.brandObjectUrl) {
      this.app.brandLetterMark.hidden = !this.app.brandUploadedMark.hidden;
      return;
    }
    this.clearUploadedBrand();
    const generation = (this.app.brandGeneration = (this.app.brandGeneration ?? 0) + 1);
    const objectUrl = URL.createObjectURL(new Blob([brand.icon.bytes], { type: brand.icon.type }));
    this.app.brandObjectUrl = objectUrl;
    this.app.brandRevision = revision;
    const image = this.app.brandUploadedMark;
    image.onload = () => {
      if (generation !== this.app.brandGeneration || objectUrl !== this.app.brandObjectUrl || !this.app.vault || this.app.vault.locked) return;
      image.hidden = false;
      this.app.brandLetterMark.hidden = true;
    };
    image.onerror = () => {
      if (generation !== this.app.brandGeneration || objectUrl !== this.app.brandObjectUrl) return;
      this.clearUploadedBrand();
      this.app.brandRevision = null;
      this.app.brandGenericMark.hidden = false;
      this.app.brandLetterMark.hidden = true;
    };
    image.src = objectUrl;
  }
  clearUploadedBrand() {
    this.app.brandGeneration = (this.app.brandGeneration ?? 0) + 1;
    if (this.app.brandObjectUrl) URL.revokeObjectURL(this.app.brandObjectUrl);
    this.app.brandObjectUrl = null;
    if (this.app.brandUploadedMark) {
      this.app.brandUploadedMark.onload = null;
      this.app.brandUploadedMark.onerror = null;
      this.app.brandUploadedMark.removeAttribute("src");
      this.app.brandUploadedMark.hidden = true;
    }
  }
  showGenericBrand() {
    this.clearUploadedBrand();
    this.app.brandRevision = null;
    this.app.brandGenericMark.hidden = false;
    this.app.brandLetterMark.hidden = true;
    this.app.brandLetterMark.textContent = "";
    this.app.brandLetterMark.removeAttribute("style");
  }
  async refreshHouseholdDefaults() {
    if (!this.app.syncCoordinator || !this.app.vault || this.app.vault.locked) return;
    const refreshGeneration = ++this.householdDefaultsRefreshGeneration;
    // The load spans the network and IndexedDB; a lock or re-open meanwhile
    // must not write the household name or a status into the next session.
    const session = this.ctx.session.captureSession();
    try {
      const result = await this.app.syncCoordinator.loadHouseholdSettings();
      this.ctx.session.assertCurrentSession(session);
      if (refreshGeneration !== this.householdDefaultsRefreshGeneration) return;
      if (result.value && (this.app.householdSettings?.revision ?? -1) <= result.value.revision) this.app.householdSettings = result.value;
      const draftPreserved = this.app.householdDefaults.initialize({ ...result, value: this.app.householdSettings });
      // Suggest something (ADR 0021 §3) is for household admins.
      if (!result.offline) this.ctx.views.showSuggest(result.admin === true);
      // A demotion removes the section; a later promotion loads it again.
      if (result.admin) void this.refreshInstallIdentity({ onlyFirst: true });
      else this.installIdentitySession = null;
      // Only admins can see or change the chat policy; others don't ask.
      if (!result.offline) this.app.chatPolicy?.show(result.admin ? result.chatPolicy ?? null : null);
      // The fridge policy (#323) arrives the same way.
      if (!result.offline) this.app.boardPolicy?.show(result.admin ? result.boardPolicy ?? null : null);
      if (draftPreserved) return;
      if (this.app.appearance?.dirty) this.ctx.appearance.setHouseholdIdentity(this.app.householdSettings?.name ?? DEFAULT_HOUSEHOLD_NAME, this.app.householdSettings);
      else {
        const effective = resolveAppearance(this.app.personalAppearance, this.app.householdSettings);
        this.app.appearance.initialize(effective);
        this.ctx.appearance.applyAppearance(effective);
        this.ctx.appearance.setHouseholdIdentity(this.app.householdSettings?.name ?? DEFAULT_HOUSEHOLD_NAME, this.app.householdSettings);
      }
    } catch {
      if (this.ctx.session.isCurrentSession(session) && refreshGeneration === this.householdDefaultsRefreshGeneration) {
        this.showGenericBrand();
        this.ctx.status.setStatus("Kin kept the last verified household appearance because the latest shared settings could not be loaded.");
      }
    }
  }
  async restoreCachedHouseholdDefaults(identity, session = this.ctx.session.captureSession()) {
    if (!identity) return;
    try {
      const value = await loadCachedHouseholdSettings(identity);
      this.ctx.session.assertCurrentSession(session);
      if (value && (this.app.householdSettings?.revision ?? -1) <= value.revision) this.app.householdSettings = value;
      this.app.householdDefaults.initialize({ admin: false, adminRecorded: false, value: this.app.householdSettings });
      this.ctx.appearance.applyEffectiveAppearance();
    } catch {
      if (this.ctx.session.isCurrentSession(session)) {
        this.showGenericBrand();
        this.ctx.status.setStatus("Kin couldn't restore the last shared appearance. Local household information is still available.");
      }
    }
  }
  // The published install identity (#78) for admins. Loaded once per
  // session (refreshHouseholdDefaults runs on every sync poll) and again
  // after each publish, withdrawal or conflict.
  async refreshInstallIdentity({ onlyFirst = false } = {}) {
    if (!this.app.syncCoordinator || !this.app.vault || this.app.vault.locked) return;
    if (onlyFirst && this.installIdentitySession === this.app.securityGeneration) return;
    this.installIdentitySession = this.app.securityGeneration;
    const session = this.ctx.session.captureSession();
    try {
      const result = await this.app.syncCoordinator.loadInstallIdentity();
      this.ctx.session.assertCurrentSession(session);
      if (!result.admin) return;
      this.app.householdDefaults.initializeInstall({ published: result.published });
    } catch {
      if (this.ctx.session.isCurrentSession(session)) this.installIdentitySession = null;
    }
  }
  async handleInstallIdentity(event, withdraw) {
    const { complete } = event.detail;
    if (!this.app.syncCoordinator) { complete(null, new Error("Connect household sync before changing what home screens show.")); return; }
    const session = this.ctx.session.captureSession();
    let privateBrandSaved = false;
    let cacheWarning = null;
    try {
      if (!withdraw) {
        const current = this.app.householdSettings ?? { version: 1, revision: 0, name: DEFAULT_HOUSEHOLD_NAME,
          appearance: { ...DEFAULT_APPEARANCE, owner: "household" }, brand: { ...DEFAULT_HOUSEHOLD_BRAND } };
        let saved;
        try {
          saved = await this.app.syncCoordinator.saveHouseholdSettings({ ...current, brand: event.detail.brand });
        } catch (error) {
          if (error.code !== "household_settings_cache_partial" || !error.savedValue) throw error;
          saved = error.savedValue;
          cacheWarning = error;
        }
        privateBrandSaved = true;
        this.ctx.session.assertCurrentSession(session);
        if ((this.app.householdSettings?.revision ?? -1) <= saved.revision) this.app.householdSettings = saved;
        this.app.householdDefaults.initialize({ admin: true, adminRecorded: true, value: saved });
        this.ctx.appearance.applyEffectiveAppearance();
      }
      const result = withdraw
        ? await this.app.syncCoordinator.withdrawInstallIdentity(event.detail.expectedRev)
        : event.detail.publish === false ? { private: true }
        : await this.app.syncCoordinator.publishInstallIdentity(event.detail.value);
      this.ctx.session.assertCurrentSession(session);
      if (withdraw || event.detail.publish !== false) await this.refreshInstallIdentity();
      complete(result, cacheWarning);
    } catch (error) {
      // A lock or re-open mid-write still releases the panel's writing state.
      if (!this.ctx.session.isCurrentSession(session)) {
        const message = privateBrandSaved
          ? "Your household icon was saved inside Kin, but Kin locked before the remaining home-screen details finished. Unlock Kin to review the latest settings."
          : "Kin locked before the home screen details finished saving.";
        const interrupted = new Error(message);
        if (privateBrandSaved) interrupted.code = "install_identity_partial";
        complete(null, interrupted);
        return;
      }
      if (error.code === "install_identity_stale") await this.refreshInstallIdentity();
      if (privateBrandSaved && event.detail.publish !== false) {
        const partial = new Error("Your household icon was saved inside Kin, but the home-screen copy was not published. Check the latest home-screen details and try publishing again.");
        partial.code = "install_identity_partial";
        complete(null, partial);
      } else complete(null, error);
    }
  }
  async handleSaveHouseholdDefaults(event) {
    const { value, complete } = event.detail;
    if (!this.app.syncCoordinator) { complete(null, new Error("Connect household sync before changing shared settings.")); return; }
    const session = this.ctx.session.captureSession();
    try {
      let saved;
      let cacheWarning = null;
      try {
        saved = await this.app.syncCoordinator.saveHouseholdSettings(value);
      } catch (error) {
        if (error.code !== "household_settings_cache_partial" || !error.savedValue) throw error;
        saved = error.savedValue;
        cacheWarning = error;
      }
      this.ctx.session.assertCurrentSession(session);
      if ((this.app.householdSettings?.revision ?? -1) <= saved.revision) this.app.householdSettings = saved;
      this.ctx.appearance.applyEffectiveAppearance();
      complete(saved, cacheWarning);
    } catch (error) {
      // A save settling after lock or a household re-open (including the
      // stale-session assert above) reports nothing: a re-open keeps the same
      // editor for the new session. A committed server write is unaffected.
      if (this.ctx.session.isCurrentSession(session)) complete(null, error);
    }
  }
  clearAppliedAppearance() {
    this.app.currentAppearance = null;
    this.app.personalAppearance = null;
    this.app.householdSettings = null;
    this.app.householdName = null;
    if (this.app.brandTitle) { this.app.brandTitle.textContent = "Kin"; this.app.brandTitle.title = "Kin"; }
    this.app.brandLink?.setAttribute("aria-label", "Kin — Today");
    this.showGenericBrand();
    document.title = "Kin";
    delete document.documentElement.dataset.kinAppearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#684033");
    if (this.app.appearanceSheet) this.app.appearanceSheet.replaceSync("");
    if (this.app.appearanceObjectUrl) URL.revokeObjectURL(this.app.appearanceObjectUrl);
    this.app.appearanceObjectUrl = null;
    this.app.appearanceImageBytes = null;
    this.app.appearanceImageType = null;
    if (this.app.appearanceBackground) { this.app.appearanceBackground.removeAttribute("src"); this.app.appearanceBackground.hidden = true; }
    this.app.removeAttribute("data-personal-background");
    this.app.appearance?.clear();
  }
}
