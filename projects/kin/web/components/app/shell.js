// Building the persistent application shell once per element.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { PRIMARY_DESTINATIONS, routeHash } from "../../routes.js";
import { clearLegacyDrafts } from "../kin-security.js";
import { currentNavigationType, readReloadResumePreference, writeReloadResumePreference } from "../../security/reload-resume.js";
import { LOCK_ICON, NAV_ICONS, SEARCH_ICON } from "../shared/icons.js";

export class ShellBuilder {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  initializeElements() {
    clearLegacyDrafts();
    const header = document.createElement("header");
    header.className = "site-header";
    const brand = document.createElement("a");
    brand.className = "brand";
    brand.href = "#today";
    brand.setAttribute("aria-label", "Kin — Today");
    this.app.brandLink = brand;
    const mark = document.createElement("span");
    mark.className = "brand-mark";
    mark.setAttribute("aria-hidden", "true");
    const genericMark = document.createElement("img");
    genericMark.src = "/icon.svg";
    genericMark.alt = "";
    const letterMark = document.createElement("span");
    letterMark.className = "brand-mark-letter";
    letterMark.hidden = true;
    const uploadedMark = document.createElement("img");
    uploadedMark.className = "brand-mark-upload";
    uploadedMark.alt = "";
    uploadedMark.hidden = true;
    mark.append(genericMark, letterMark, uploadedMark);
    this.app.brandMark = mark;
    this.app.brandGenericMark = genericMark;
    this.app.brandLetterMark = letterMark;
    this.app.brandUploadedMark = uploadedMark;
    const title = document.createElement("span");
    title.textContent = "Kin";
    title.title = "Kin";
    title.className = "brand-name";
    this.app.brandTitle = title;
    brand.append(mark, title);
    brand.addEventListener("click", this.app.onNavigationClick);
    // Header tools exist only while unlocked: search entry, truthful sync
    // state, and a lock action that is always one tap away.
    const tools = document.createElement("div");
    tools.className = "site-tools";
    tools.hidden = true;
    this.app.searchLink = document.createElement("a");
    this.app.searchLink.className = "header-search";
    this.app.searchLink.href = "#search";
    this.app.searchLink.innerHTML = `${SEARCH_ICON}<span>Search</span>`;
    this.app.searchLink.setAttribute("aria-label", "Search household");
    this.app.searchLink.setAttribute("aria-keyshortcuts", "/");
    this.app.searchLink.addEventListener("click", this.app.onNavigationClick);
    this.app.syncChip = document.createElement("kin-sync-status");
    this.app.quickAdd = document.createElement("kin-quick-add");
    this.app.lockButton = document.createElement("button");
    this.app.lockButton.type = "button";
    this.app.lockButton.className = "header-lock";
    this.app.lockButton.innerHTML = `${LOCK_ICON}<span>Lock</span>`;
    this.app.lockButton.setAttribute("aria-label", "Lock Kin");
    this.app.lockButton.addEventListener("click", () => this.ctx.session.lockHousehold());
    tools.append(this.app.quickAdd, this.app.searchLink, this.app.syncChip, this.app.lockButton);
    this.app.siteTools = tools;
    header.append(brand, tools);
    this.app.header = header;

    this.app.appearanceBackground = document.createElement("img");
    this.app.appearanceBackground.className = "personal-background";
    this.app.appearanceBackground.alt = "";
    this.app.appearanceBackground.setAttribute("aria-hidden", "true");

    const shell = document.createElement("div");
    shell.className = "application-shell";
    this.app.shell = shell;

    const nav = document.createElement("nav");
    nav.className = "primary-nav";
    nav.setAttribute("aria-label", "Main");
    nav.hidden = true;
    this.app.navLinks = new Map();
    for (const { id, label } of PRIMARY_DESTINATIONS) {
      const link = document.createElement("a");
      link.className = "nav-link";
      link.href = routeHash(id);
      link.dataset.page = id;
      link.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[id]}</svg><span>${label}</span>`;
      nav.append(link);
      this.app.navLinks.set(id, link);
    }
    this.app.nav = nav;
    nav.addEventListener("click", this.app.onNavigationClick);

    const main = document.createElement("main");
    main.id = "main";
    main.tabIndex = -1;
    main.setAttribute("aria-busy", "true");
    main.hidden = true;
    main.addEventListener("click", this.app.onNavigationClick);
    this.app.main = main;
    const controls = document.createElement("fieldset");
    controls.className = "workspace-controls";
    controls.setAttribute("role", "none");
    controls.disabled = true;
    this.app.controlFieldset = controls;
    this.app.catchUp = document.createElement("kin-catch-up");
    this.app.today = document.createElement("kin-today");
    this.app.needs = document.createElement("kin-today");
    this.app.shopping = document.createElement("kin-today");
    this.app.staples = document.createElement("kin-today");
    this.app.meals = document.createElement("kin-meals");
    this.app.tonight = document.createElement("kin-tonight");
    this.app.compose = document.createElement("kin-compose");
    this.app.handoffs = document.createElement("kin-handoff-list");
    this.app.talks = document.createElement("kin-talk-list");
    this.app.chat = document.createElement("kin-chat");
    this.app.search = document.createElement("kin-search");
    this.app.pulse = document.createElement("kin-pulse");
    this.app.routines = document.createElement("kin-routines");
    this.app.areas = document.createElement("kin-areas");
    this.app.detail = document.createElement("kin-item-detail");
    this.ctx.views.buildViews(controls);
    main.append(controls);
    shell.append(nav, main);

    const feedback = document.createElement("div");
    feedback.className = "app-feedback";
    this.app.status = document.createElement("p");
    this.app.status.className = "status-message";
    this.app.status.setAttribute("role", "status");
    this.app.status.setAttribute("aria-live", "polite");
    this.app.alert = document.createElement("p");
    this.app.alert.className = "error-message";
    this.app.alert.setAttribute("role", "alert");
    this.app.alert.hidden = true;
    this.app.stateNotice = document.createElement("p");
    this.app.stateNotice.className = "state-notice";
    this.app.stateNotice.setAttribute("role", "status");
    this.app.stateNotice.setAttribute("aria-live", "polite");
    this.app.stateNotice.hidden = true;
    main.prepend(this.app.stateNotice);
    this.app.routeAnnouncement = document.createElement("p");
    this.app.routeAnnouncement.className = "visually-hidden";
    this.app.routeAnnouncement.setAttribute("role", "status");
    this.app.routeAnnouncement.setAttribute("aria-live", "polite");
    this.app.routeAnnouncement.setAttribute("aria-atomic", "true");
    this.app.retryButton = document.createElement("button");
    this.app.retryButton.type = "button";
    this.app.retryButton.className = "retry-button";
    this.app.retryButton.textContent = "Try again";
    this.app.retryButton.hidden = true;
    // "Report a problem" beside every error message, and after an
    // unexpected error (ADR 0021 §3).
    this.app.reportButton = document.createElement("button");
    this.app.reportButton.type = "button";
    this.app.reportButton.className = "report-button secondary";
    this.app.reportButton.textContent = "Report a problem";
    this.app.reportButton.hidden = true;
    this.app.reportButton.addEventListener("click", () => this.ctx.report.open("problem", { opener: this.app.reportButton }));
    feedback.append(this.app.status, this.app.alert, this.app.retryButton, this.app.reportButton);
    this.ctx.undo.buildToast(feedback);
    this.app.feedback = feedback;

    this.app.security = document.createElement("kin-security");
    this.app.security.onUnlocked = (vault) => this.ctx.session.openUnlockedHousehold(vault);
    this.app.security.onLockRequested = () => this.ctx.session.lockHousehold();
    // What <kin-security> may ask of the application, and nothing more.
    this.app.security.services = {
      refreshFromEvents: () => this.ctx.refresh.refreshFromEvents(),
      clearReminders: () => this.ctx.records.clearReminders(),
      broadcastEventChange: () => this.ctx.peers.broadcastEventChange(),
      notifyPeerLock: (lockEpoch) => this.ctx.session.notifyPeerLock(lockEpoch),
      lockHousehold: (broadcast, options) => this.ctx.session.lockHousehold(broadcast, options),
      setAutoLockMinutes: (minutes) => this.ctx.session.setAutoLockMinutes(minutes),
      // The first run's sign-up, finished once the household panel is up (#557).
      completeFirstRun: (pending) => void this.ctx.firstRun.complete(pending),
      takeReloadResume: async (readManifest) => {
        const resumed = await this.app.reloadResume.take({ navigationType: currentNavigationType(), readManifest });
        void this.app.reloadResume.sweep();
        if (resumed) this.app.resumeAutoLockAt = resumed.autoLockAt;
        return resumed;
      },
      reloadResumeEnabled: () => readReloadResumePreference(),
      setReloadResume: (enabled) => {
        writeReloadResumePreference(enabled);
        if (!enabled) void this.app.reloadResume.disarm();
        else if (this.app.vault && !this.app.vault.locked) void this.app.reloadResume.arm(this.app.vault).catch(() => {});
      },
    };
    this.app.replaceChildren(this.app.appearanceBackground, header, this.app.security, shell, feedback, this.app.routeAnnouncement);
    this.app.updateNotice = document.createElement("section");
    this.app.updateNotice.className = "update-notice";
    this.app.updateNotice.setAttribute("aria-label", "Application update");
    this.app.updateNotice.setAttribute("role", "status");
    const updateMessage = document.createElement("span");
    updateMessage.textContent = "A new Kin version is ready.";
    const updateNow = document.createElement("button");
    updateNow.type = "button";
    updateNow.textContent = "Update now";
    updateNow.addEventListener("click", () => {
      const focusedEditor = document.activeElement?.matches?.("input, textarea, select, [contenteditable='true']");
      const hasDraft = this.app.compose?.input?.value.trim() || this.app.journal?.draft || this.app.routines?.hasDraft || this.app.detail?.hasDraft || this.app.notes?.editor?.title.trim() || this.app.notes?.editor?.body.trim() ||
        [this.app.needs, this.app.shopping, this.app.staples].some((list) => list.composer?.input?.value.trim());
      if (this.app.busy || focusedEditor || hasDraft) {
        this.ctx.status.setStatus("Finish or save your current edit before updating Kin.");
        return;
      }
      this.app.updateRequested = true;
      this.app.updateRegistration?.waiting?.postMessage({ type: "KIN_SKIP_WAITING" });
    });
    const updateLater = document.createElement("button");
    updateLater.type = "button";
    updateLater.textContent = "Later";
    updateLater.addEventListener("click", () => { this.app.updateNotice.hidden = true; });
    this.app.updateNotice.append(updateMessage, updateNow, updateLater);
    this.app.updateNotice.hidden = true;
    this.app.prepend(this.app.updateNotice);
    this.app.retryButton.addEventListener("click", () => this.app.retryAction?.());
    this.app.viewer = this.ctx.attachments.buildAttachmentViewer();
    this.app.append(this.app.viewer);
    this.app.detailSheet = this.ctx.detail.buildDetailSheet();
    this.app.append(this.app.detailSheet);
    this.app.commandPalette = document.createElement("kin-command-palette");
    this.app.commandPalette.onCommand = (id, { opener }) => {
      if (this.app.commandGeneration === this.app.securityGeneration) this.ctx.append.runWorkspaceCommand(id, { opener });
    };
    this.app.commandPalette.onDismiss = ({ opener }) => this.ctx.append.restoreCommandFocus(opener);
    this.app.append(this.app.commandPalette);
    this.app.chatShare = document.createElement("kin-chat-share");
    this.app.append(this.app.chatShare);
    // "Add to Kin" for things shared from other apps (#389).
    this.app.shareSheet = document.createElement("kin-share-sheet");
    this.app.append(this.app.shareSheet);
    // Shopping mode (#403): the Shopping list for use in the shop.
    this.app.shoppingMode = document.createElement("kin-shopping-mode");
    this.app.append(this.app.shoppingMode);
    // Bring a list into Kin (#452).
    this.app.importer = document.createElement("kin-import");
    this.app.append(this.app.importer);
    // The family calendar's dialogs (#662, #660): adding or changing an
    // event, and importing a calendar file.
    this.app.eventEditor = document.createElement("kin-event-editor");
    this.app.append(this.app.eventEditor);
    this.app.calendarImport = document.createElement("kin-calendar-import");
    this.app.append(this.app.calendarImport);
    this.ctx.report.element();
    this.app.attachmentInput = this.ctx.attachments.buildAttachmentInput();
    this.app.append(this.app.attachmentInput);
    // Help on every screen (#621): one panel for every page and dialog.
    this.app.append(this.ctx.help.buildPanel());
    this.ctx.navigation.showPageFromLocation();
    this.ctx.easy.apply();
  }
}
