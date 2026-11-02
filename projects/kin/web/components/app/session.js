// Unlock, open, lock and auto-lock of the household session.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { clearAttachmentProgress } from "../../attachments/attachment-progress.js";
import { recordDiagnostic } from "../../diagnostics/ring-buffer.js";
import { errorName } from "../../diagnostics/global.js";
import { AttachmentPreviewCache } from "../../attachments/attachment-preview.js";
import { loadKinEngine } from "../../wasm/kin-engine.js";
import { releaseQrCodec } from "../../wasm/kin-qr.js";
import { EventStore } from "../../storage/event-store.js";
import { clearLegacyDrafts } from "../kin-security.js";
import { loadAppearance } from "../../appearance/store.js";
import { resolveAppearance } from "../../appearance/household.js";
import { getActiveVault, setActiveVault } from "../../security/local-vault.js";
import { wipeSignIn } from "../../security/new-device.js";
import { AUTO_LOCK_KEY, START_ERROR } from "./constants.js";
import { assertCurrentSession, captureSession, isCurrentSession } from "../shared/session-guard.js";

export class SessionController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  // The shared capture / check / assert pattern (shared/session-guard.js).
  captureSession() { return captureSession(this.app); }
  isCurrentSession(session) { return isCurrentSession(this.app, session); }
  assertCurrentSession(session) { assertCurrentSession(this.app, session); }
  async initialize() {
    if (this.app.starting && this.app.startingGeneration === this.app.securityGeneration)
      return this.app.starting;
    const starting = this.loadApplication();
    this.app.starting = starting;
    this.app.startingGeneration = this.app.securityGeneration;
    try {
      await starting;
    } finally {
      if (this.app.starting === starting) this.app.starting = null;
    }
  }
  async loadApplication() {
    const session = { generation: this.app.securityGeneration, vault: this.app.vault };
    if (!session.vault || session.vault.locked) {
      await this.app.security.initialize();
      if (session.generation !== this.app.securityGeneration || this.app.vault) return;
      this.ctx.status.setBusy(false);
      this.ctx.status.setStatus("Household locked.");
      return;
    }
    const retrying = !this.app.retryButton.hidden;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Starting Kin…");
    try {
      this.app.syncCoordinator?.stop();
      this.app.syncCoordinator = null;
      this.app.store?.close();
      this.app.store = null;
      this.app.engine?.dispose?.();
      this.app.engine = null;
      const engine = await loadKinEngine();
      if (!this.isCurrentSession(session)) {
        engine.dispose();
        this.assertCurrentSession(session);
      }
      this.app.engine = engine;
      session.engine = engine;
      const store = await EventStore.open({ vault: session.vault, engine });
      if (!this.isCurrentSession(session)) {
        store.close();
        this.assertCurrentSession(session);
      }
      this.app.store = store;
      session.store = store;
      this.ctx.peers.openPeerChannel();
      const snapshot = await store.getCatchUpState();
      this.assertCurrentSession(session);
      this.app.hasLocalSyncBinding = Boolean(snapshot.syncIdentity);
      this.ctx.refresh.applyCatchUpSnapshot(snapshot);
      await this.ctx.appearance.restoreCachedHouseholdDefaults(snapshot.syncIdentity, session);
      // The household and security panels go in place first, then Simple
      // view (#345, ADR 0013) applies the cached layout before anything shows.
      this.app.peoplePage.append(this.app.household, this.app.notifications, this.app.appBadge, this.app.chatSettings);
      this.app.privacyPage.append(this.app.security);
      await this.ctx.simple.restore(snapshot.syncIdentity, session);
      this.assertCurrentSession(session);
      // Household features (#625): what this device last knew was off.
      this.ctx.features.restore(snapshot.syncIdentity);
      // Kitchen display mode (#670): a display for this vault opens as one.
      this.ctx.display.restore(session.vault);
      // Outside calendars (#668): what this device kept shows, then they
      // refresh. Only a household that syncs has any.
      void this.ctx.calendarSync.start(snapshot.syncIdentity, session);
      this.ctx.render.renderState();
      void this.ctx.attachments.refreshAttachmentRows();
      this.app.main.hidden = false;
      this.app.nav.hidden = false;
      this.app.siteTools.hidden = false;
      this.ctx.navigation.showPageFromLocation();
      this.ctx.status.setStatus("Ready.");
      // Reminders suspended by a lock of this same vault come back with
      // titles from the fresh state; another vault's are discarded.
      if (this.isCurrentSession(session)) {
        this.app.localReminders.resumeAll(session.vault.vaultId ?? null, (id) => this.ctx.records.reminderTarget(id, session));
        this.ctx.records.renderReminders();
      }
      this.ctx.sync.updateSyncChip();
      if (navigator.onLine === false) this.app.onOffline();
      this.app.retryButton.hidden = true;
      void this.ctx.sync.configureSyncCoordinator();
    } catch (error) {
      if (this.isCurrentSession(session)) {
        // The person sees START_ERROR; the error's name stays in the ring
        // (#770), next to the engine's or storage's own entry if they made one.
        recordDiagnostic("unlock_failed", { name: errorName(error) });
        this.ctx.session.lockHousehold();
        this.app.security.error(error.userMessage ? error : new Error(START_ERROR));
      }
    } finally {
      if (this.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (retrying && this.app.store) this.app.compose.focusInput();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async openUnlockedHousehold(vault) {
    const unlockStarted = performance.now();
    // Re-opening without a lock still ends the previous session's timers;
    // initialize() resumes them only if this is the same vault.
    this.app.localReminders.suspendAll(this.app.vault?.vaultId ?? null);
    this.ctx.appearance.clearAppliedAppearance();
    this.app.hasLocalSyncBinding = false;
    vault.assertUnlocked();
    this.app.vault = vault;
    this.app.securityGeneration++;
    setActiveVault(vault);
    this.app.removeLockListener?.();
    this.app.removeLockListener = vault.onLock(() => this.ctx.session.lockHousehold(false));
    const generation = this.app.securityGeneration;
    this.app.attachmentPreviews?.clear();
    this.app.attachmentPreviews = new AttachmentPreviewCache((record) => this.ctx.attachments.loadPreviewBlob(record));
    await this.ctx.session.initialize();
    this.assertCurrentSession({ vault, generation });
    vault.assertUnlocked();
    if (!this.app.store)
      throw new Error("Kin could not verify the household store.");
    const session = this.captureSession();
    try {
      const appearance = await loadAppearance(this.app.store, vault);
      this.assertCurrentSession(session);
      this.app.personalAppearance = appearance;
      const editorValue = resolveAppearance(appearance, this.app.householdSettings);
      this.app.appearance.initialize(editorValue);
      this.ctx.appearance.applyEffectiveAppearance();
      // A synced theme (#525) that arrived before the saved one loaded.
      void this.ctx.privatePrefs.refresh();
    } catch (error) {
      this.assertCurrentSession(session);
      this.app.appearance.initialize({ version: 1, owner: null, mode: "system", colorSource: "default", seed: "#984D38", manual: null, image: null });
      this.ctx.status.setStatus("Kin couldn't load your saved appearance, so the default is in use.");
    }
    this.scheduleAutoLock();
    this.ctx.status.renderOnboarding();
    this.app.main.focus();
    // A share or shortcut waiting for this unlock (#389).
    void this.ctx.share.afterUnlock().catch(() => {});
    // Seal this unlock for a refresh of this tab; a lock meanwhile undoes it.
    void this.app.reloadResume?.arm(vault).then(() => this.app.reloadResume.sweep()).catch(() => {});
    recordDiagnostic("unlocked", { ms: performance.now() - unlockStarted });
  }
  lockHousehold(broadcast = true, { preserveSecurityOperation = false, endSession = false, keepReloadResume = false, keepBadge = false } = {}) {
    // Every lock but the one on page unload ends refresh-resume (#351).
    if (!keepReloadResume) void this.app.reloadResume?.disarm();
    // Every lock but closing Kin clears the app icon count (#476); sign-out
    // is a lock that ends the session. The unread count goes with the room.
    if (!keepBadge) this.ctx.badge?.clear();
    this.app.chatUnread = null;
    if (broadcast) {
      // A protected read holds a native transaction while crypto runs. Notify
      // peers before the epoch write queues behind that read, so they abort it
      // promptly. The later committed epoch remains authoritative if delivery
      // is missed. Numbered intent also cannot revoke a newer unlock epoch.
      this.ctx.session.notifyPeerLock((this.app.vault?.securityEpoch ?? this.app.security?.manifest?.lockEpoch ?? -1) + 1);
      this.app.lockBarrier = Promise.resolve(this.app.lockBarrier)
        .then(() => EventStore.lockAll())
        .then((lockEpoch) => {
          try {
            this.app.channel?.postMessage({ type: "household-locked", lockEpoch });
          } catch {
            // Durable epoch guards still reject stale capabilities.
          }
          return lockEpoch;
        })
        .catch((error) => {
          this.app.security?.error(error);
        });
    }
    this.app.securityGeneration++;
    this.app.hasLocalSyncBinding = false;
    this.ctx.appearance.clearAppliedAppearance();
    this.app.removeLockListener?.();
    this.app.removeLockListener = null;
    const vault = this.app.vault ?? getActiveVault();
    // Reminder timers hold decrypted titles; none may fire once locked. A lock
    // suspends them as { id, at, vaultId } only; ending the session clears them.
    if (endSession) {
      this.app.localReminders.clearAll();
      this.ctx.privatePrefs?.forget();
    } else this.app.localReminders.suspendAll(vault?.vaultId ?? null);
    this.ctx.privatePrefs?.detach({ render: false });
    this.app.vault = null;
    vault?.lock();
    clearTimeout(this.app.autoLockTimer);
    this.app.autoLockTimer = null;
    this.ctx.attachments.closeViewer();
    this.ctx.attachments.revokeOpenedAttachments();
    this.ctx.detail.closeItemDetail({ restoreFocus: false });
    this.app.commandPalette?.dismiss();
    // A report's draft and screenshot go with the lock (ADR 0021 §3).
    this.ctx.report?.dismiss();
    if (this.app.reportButton) this.app.reportButton.hidden = true;
    this.app.householdAdmin = false;
    this.app.lastSyncAt = null;
    this.app.commandGeneration = null;
    this.ctx.bulk.clearBulkOutcome();
    this.ctx.undo.clear();
    this.ctx.help?.reset();
    this.app.shoppingMode?.close();
    this.app.importer?.close();
    this.app.pendingImport = null;
    this.app.shoppingSections = null;
    this.app.sitterPage = null;
    this.app.sitterLanded = false;
    // Family photos (#673): open images, thumbnails and the album store.
    this.ctx.album?.clear();
    this.app.rotations = null;
    if (this.ctx.rotations) this.ctx.rotations.raw = null;
    this.app.pendingCapture = null;
    this.app.pendingShares?.clear();
    // pendingScheduleChange holds only random ids and a cadence. It survives
    // a lock so that unlocking the same vault can finish a half-saved change
    // instead of starting a second replacement; other vaults never see it.
    this.app.attachmentPreviews?.clear();
    this.app.attachmentPreviews = null;
    this.app.attachmentTarget = null;
    this.app.syncState = null;
    this.app.pageScroll.clear();
    if (this.app.siteTools) this.app.siteTools.hidden = true;
    if (this.app.syncChip) this.app.syncChip.state = null;
    for (const timer of this.app.attachmentProgressTimers.values()) clearTimeout(timer);
    this.app.attachmentProgressTimers.clear();
    clearAttachmentProgress();
    this.app.householdStatus = null;
    this.app.passkeyPromptDismissed = false;
    // A first run still signing up ends with the session; its keys go too.
    if (this.app.firstRun?.pending?.signUp) for (const key of ["authKey", "passwordKey", "localKek"]) this.app.firstRun.pending.signUp[key]?.fill?.(0);
    // A new-device sign-in (#568) still finishing: its vault key goes too.
    if (this.app.firstRun?.pending?.signIn) wipeSignIn(this.app.firstRun.pending.signIn.opened);
    this.app.firstRun = null;
    this.app.pendingProfile = null;
    if (this.app.onboarding) { this.app.onboarding.hidden = true; this.app.onboarding.replaceChildren(); }
    this.app.syncCoordinator?.stop();
    this.app.syncCoordinator = null;
    this.app.store?.close();
    this.app.store = null;
    this.app.engine?.dispose?.();
    this.app.engine = null;
    // The QR codec may hold a pairing link it just read; drop it with the rest.
    void releaseQrCodec();
    this.app.state = null;
    this.ctx.detail.clearResponsibilityContext();
    this.app.attachmentRows = [];
    this.app.snapshotBoundary = null;
    this.app.catchUpCursor = null;
    this.app.pendingRefresh = false;
    this.app.refreshing = false;
    this.app.checkingAuthorization = false;
    this.app.starting = null;
    this.app.startingGeneration = null;
    clearTimeout(this.app.pulseTimer);
    this.app.cancelFocusWake();
    this.ctx.status.clearAlert();
    clearLegacyDrafts();
    this.ctx.simple?.reset();
    this.ctx.display?.reset();
    this.ctx.features?.reset();
    this.ctx.chores?.reset();
    // Synced calendars' decrypted occurrences leave memory (#668).
    this.ctx.calendarSync?.stop();
    this.ctx.journal?.reset();
    this.app.quickAdd?.reset();
    this.app.chatShare?.reset();
    // The calendar (#660): drafts, an import's file and what was read.
    this.app.eventEditor?.reset();
    this.app.calendarImport?.reset();
    this.ctx.calendar?.reset();
    if (this.app.main) {
      this.app.nav.hidden = true;
      this.app.shell.before(this.app.security);
      this.app.main.hidden = true;
      this.app.main.replaceChildren();
      // Replacing every component drops private arrays, drafts and DOM nodes.
      const components = [
        ["catchUp", "kin-catch-up"],
        ["today", "kin-today"],
        ["needs", "kin-today"],
        ["shopping", "kin-today"],
        ["staples", "kin-today"],
        ["compose", "kin-compose"],
        ["handoffs", "kin-handoff-list"],
        ["talks", "kin-talk-list"],
        ["chat", "kin-chat"],
        ["search", "kin-search"],
        ["pulse", "kin-pulse"],
        ["routines", "kin-routines"],
        ["areas", "kin-areas"],
        ["detail", "kin-item-detail"],
        // Meals (#333): recipes, notes and dinners leave with the lock.
        ["meals", "kin-meals"],
        ["tonight", "kin-tonight"],
      ];
      this.ctx.meals?.reset();
      // Just for me (#510): the decrypted private list leaves with the lock.
      this.ctx.privateItems?.reset();
      for (const [field, name] of components)
        this.app[field] = document.createElement(name);
      this.app.detailMode = null;
      this.app.household.syncKeyStore?.close();
      this.app.household.remove();
      const controls = document.createElement("fieldset");
      controls.className = "workspace-controls";
      controls.setAttribute("role", "none");
      controls.disabled = true;
      this.app.controlFieldset = controls;
      this.ctx.views.buildViews(controls);
      this.app.main.append(controls);
      if (!this.app.stateNotice.isConnected) this.app.main.prepend(this.app.stateNotice);
      this.ctx.status.setBusy(false);
      this.ctx.status.setStatus("Household locked.");
      if (!preserveSecurityOperation) this.app.security.locked();
    }
  }
  notifyPeerLock(lockEpoch) {
    if (!Number.isSafeInteger(lockEpoch) || lockEpoch < 1) return;
    try { this.app.channel?.postMessage({ type: "household-locked", lockEpoch }); }
    catch { /* The durable epoch still fences subsequent operations. */ }
  }
  setAutoLockMinutes(minutes) {
    this.app.autoLockMinutes = [0, 5, 15, 60].includes(minutes) ? minutes : 0;
    try { localStorage.setItem(AUTO_LOCK_KEY, String(this.app.autoLockMinutes)); } catch { /* Preference only; lock-on-close still applies. */ }
    this.scheduleAutoLock();
  }
  scheduleAutoLock() {
    clearTimeout(this.app.autoLockTimer);
    this.app.autoLockTimer = null;
    // After a refresh the inactivity deadline carries over (#351), once.
    const resumedDeadline = this.app.resumeAutoLockAt;
    this.app.resumeAutoLockAt = null;
    // A kitchen display (#670) doesn't lock by itself (ADR 0022 §4;
    // THREAT-MODEL): leaving it needs the adult's password or passkey.
    if (!this.app.vault || this.app.vault.locked || !this.app.autoLockMinutes || this.app.displayMode) {
      this.app.lastActivityAt = null;
      return;
    }
    const period = this.app.autoLockMinutes * 60_000;
    const delay = Number.isFinite(resumedDeadline) ? Math.max(0, Math.min(period, resumedDeadline - Date.now())) : period;
    this.app.lastActivityAt = Date.now() - (period - delay);
    const vault = this.app.vault;
    const generation = this.app.securityGeneration;
    this.app.autoLockTimer = setTimeout(() => {
      this.app.autoLockTimer = null;
      if (vault !== this.app.vault || generation !== this.app.securityGeneration || vault.locked) return;
      this.ctx.session.lockHousehold();
      this.ctx.status.setStatus("Kin locked after inactivity. Unlock to continue.");
    }, delay);
  }
}
