import "./kin-routines.js";
import "./kin-areas.js";
import "./kin-notes.js";
import "./kin-compose.js";
import "./kin-quick-add.js";
import "./kin-chat-share.js";
import "./kin-share-sheet.js";
import "./kin-shopping-mode.js";
import "./kin-week.js";
import "./calendar/kin-calendar.js";
import "./calendar/kin-calendar-today.js";
import "./calendar/kin-event-editor.js";
import "./calendar/kin-member-colour.js";
import "./calendar/kin-calendar-import.js";
import "./kin-chore-chart.js";
import "./kin-chore-adults.js";
import "./kin-just-for-me.js";
import "./kin-sitter-editor.js";
import "./kin-album.js";
import "./kin-journal.js";
import "./kin-import.js";
import "./kin-command-palette.js";
import "./kin-item.js";
import "./kin-item-detail.js";
import "./kin-today.js";
import "./kin-handoff-list.js";
import "./kin-talk-list.js";
import "./kin-chat.js";
import "./kin-fridge.js";
import "./kin-meals.js";
import "./kin-tonight.js";
import "./kin-simple.js";
import "./kin-chat-settings.js";
import "./kin-chat-policy.js";
import "./kin-search.js";
import "./kin-segment-nav.js";
import "./kin-sync-status.js";
import "./kin-pulse.js";
import "./kin-catch-up.js";
import "./kin-household.js";
import "./kin-notifications.js";
import "./kin-app-badge.js";
import "./kin-security.js";
import "./kin-appearance.js";
import "./kin-personal-settings.js";
import "./kin-calendar-subscriptions.js";
import "./kin-help.js";
import "./kin-household-defaults.js";
import "./kin-report.js";
import "./kin-household-features.js";
import "./kin-kitchen-display.js";
import "./display/kin-display-setup.js";
import "./display/kin-display-shopping.js";
import "./display/kin-display-chat.js";
import { createAppContext, initializeAppState } from "./app/context.js";
import { captureInvitationCode } from "../pairing-link.js";
import { takeSignInLink } from "../device-link.js";
import { captureLaunchAction, captureShare } from "../share-target.js";
import { applyStoredDisplayPrefs } from "../appearance/display-prefs.js";
import { installGlobalDiagnostics } from "../diagnostics/global.js";

// An invitation link (/pair#code=…) hands over its code before any route is
// resolved, and the address bar drops it at once (#97). A computer's sign-in
// link (/link#…) is meant for Kin's own scanner; opened here, it is dropped
// the same way (#100).
captureInvitationCode();
takeSignInLink();
// Something shared from another app, or a home-screen shortcut (#389): taken
// out of the address the same way, and offered once Kin is unlocked.
captureShare();
captureLaunchAction();
// Text size and motion (#524) apply before anything shows, the lock screen
// included: they are this device's, kept unencrypted (display-prefs.js).
applyStoredDisplayPrefs();
// The local diagnostic ring buffer (#631) notes errors nothing handled, as
// codes only; after one, Kin offers "Report a problem" (#632).
installGlobalDiagnostics(window, { onUnexpected: () => document.querySelector("kin-app")?.ctx.report.offer() });

// The application root. It owns lifecycle, event wiring and the state the
// controllers in ./app/ share; each behavior lives in one of those controllers.

// Household intents bubbling from components: [type, handler property].
const ELEMENT_EVENTS = [
  ["kin:create-note", "onNoteIntent"], ["kin:update-note", "onNoteIntent"],
  ["kin:archive-note", "onNoteIntent"], ["kin:save-reference-record", "onReferenceIntent"],
  ["kin:archive-reference-record", "onReferenceIntent"], ["kin:save-maintenance-event", "onMaintenanceIntent"],
  ["kin:archive-maintenance-event", "onMaintenanceIntent"], ["kin:create-routine", "onRoutineIntent"],
  ["kin:complete-routine-occurrence", "onRoutineIntent"], ["kin:reopen-routine-occurrence", "onRoutineIntent"],
  ["kin:archive-routine", "onRoutineIntent"], ["kin:save-playbook", "onPlaybookIntent"],
  ["kin:archive-playbook", "onPlaybookIntent"], ["kin:instantiate-playbook", "onPlaybookIntent"],
  ["kin:add-item", "onAddItem"], ["kin:add-attachment", "onAddAttachment"],
  ["kin:pick-attachment", "onPickAttachment"], ["kin:open-attachment", "onOpenAttachment"],
  ["kin:view-attachment", "onViewAttachment"], ["kin:remove-attachment", "onRemoveAttachment"],
  ["kin:household-status", "onHouseholdStatus"], ["kin:security-changed", "onSecurityChanged"],
  ["kin:retry-attachments", "onRetryAttachments"], ["kin:change-responsibility", "onChangeResponsibility"], ["kin:simple-done", "onSimpleDone"], ["kin:display-enter", "onDisplayEnter"], ["kin:set-item-emoji", "onSetItemEmoji"],
  ["kin:replenish-staple", "onReplenishStaple"], ["kin:complete-item", "onCompleteItem"], ["kin:start-shopping", "onStartShopping"], ["kin:save-sitter-page", "onSaveSitterPage"], ["kin:set-routine-rotation", "onSetRoutineRotation"], ["kin:set-routine-turn", "onSetRoutineTurn"], ["kin:set-chore-points", "onSetChorePoints"], ["kin:set-item-section", "onSetItemSection"], ["kin:save-shopping-sections", "onSaveShoppingSections"], ["kin:import-list", "onImportList"],
  ["kin:reopen-item", "onReopenItem"], ["kin:archive-item", "onArchiveItem"],
  ["kin:toggle-private-item", "onTogglePrivateItem"], ["kin:make-item-private", "onMakeItemPrivate"],
  ["kin:add-item-step", "onAddItemStep"], ["kin:complete-item-step", "onCompleteItemStep"],
  ["kin:reopen-item-step", "onReopenItemStep"], ["kin:archive-item-step", "onArchiveItemStep"],
  ["kin:change-item-area", "onItemAreaChange"], ["kin:set-item-planning-date", "onItemPlanningDateChange"],
  ["kin:set-local-reminder", "onLocalReminder"], ["kin:cancel-local-reminder", "onCancelLocalReminder"],
  ["kin:pin-intent", "onPinIntent"], ["kin:open-pin", "onOpenPin"],
  ["kin:open-quick-add", "onOpenQuickAdd"], ["kin:bulk-item-action", "onBulkItemAction"],
  ["kin:bulk-undo", "onBulkUndo"], ["kin:bulk-retry", "onBulkRetry"],
  ["kin:bulk-dismiss", "onBulkDismiss"], ["kin:open-item", "onOpenItem"],
  ["kin:close-item-detail", "onCloseItemDetail"], ["kin:open-search-result", "onOpenSearchResult"], ["kin:open-chat-message", "onOpenChatMessage"], ["kin:chat-to-record", "onChatToRecord"],
  ["kin:area-intent", "onAreaIntent"], ["kin:add-handoff", "onAddHandoff"],
  ["kin:acknowledge-handoff", "onAcknowledgeHandoff"], ["kin:archive-handoff", "onArchiveHandoff"],
  ["kin:add-talk", "onAddTalk"], ["kin:resolve-talk", "onResolveTalk"],
  ["kin:reopen-talk", "onReopenTalk"], ["kin:archive-talk", "onArchiveTalk"],
  ["kin:set-pulse", "onSetPulse"], ["kin:clear-pulse", "onClearPulse"],
  ["kin:caught-up", "onCaughtUp"], ["kin:sync-enabled", "onSyncEnabled"],
  ["kin:sync-now", "onSyncNow"], ["kin:sync-stop", "onSyncStop"],
  ["kin:lock", "onLockRequest"], ["kin:app-badge-choice", "onAppBadgeChoice"],
  ["kin:personal-setting", "onPersonalSetting"], ["kin:settings-this-device", "onSettingsThisDevice"], ["kin:open-help", "onOpenHelp"], ["kin:appearance-preview", "onAppearancePreview"],
  ["kin:save-appearance", "onSaveAppearance"], ["kin:use-household-appearance", "onUseHouseholdAppearance"],
  ["kin:inherit-appearance-property", "onInheritAppearanceProperty"], ["kin:household-defaults-preview", "onHouseholdDefaultsPreview"],
  ["kin:household-defaults-cancel", "onHouseholdDefaultsCancel"], ["kin:save-household-defaults", "onSaveHouseholdDefaults"],
  ["kin:publish-install-identity", "onPublishInstallIdentity"], ["kin:withdraw-install-identity", "onWithdrawInstallIdentity"],
  ["keydown", "onDetailKeydown"], ["kin:change-routine-schedule", "onChangeRoutineSchedule"],
  ["kin:open-routine-schedule", "onOpenRoutineSchedule"],
  // The family calendar (#660).
  ["kin:calendar-focus", "onCalendarFocus"], ["kin:calendar-open-event", "onCalendarOpenEvent"],
  ["kin:calendar-new-event", "onCalendarNewEvent"], ["kin:calendar-import", "onCalendarImport"],
  ["kin:calendar-save", "onCalendarSave"], ["kin:calendar-cancel", "onCalendarCancel"],
  ["kin:set-member-colour", "onSetMemberColour"], ["kin:calendar-import-file", "onCalendarImportFile"],
  ["kin:calendar-import-confirm", "onCalendarImportConfirm"],
];
// Document listeners: activity resets auto-lock; shortcuts; visibility wake.
const DOCUMENT_EVENTS = [
  ["pointerdown", "onActivity", { passive: true }],
  ["keydown", "onActivity", { passive: true }],
  ["scroll", "onActivity", { passive: true, capture: true }],
  ["wheel", "onActivity", { passive: true }],
  ["keydown", "onShortcutKeydown"],
  ["visibilitychange", "onTimeWake"],
];
// Window listeners: install prompts, routes, connectivity, layout and focus.
const WINDOW_EVENTS = [
  ["beforeinstallprompt", "onBeforeInstallPrompt"], ["appinstalled", "onAppInstalled"],
  ["hashchange", "onHashChange"], ["popstate", "onHashChange"],
  ["offline", "onOffline"], ["online", "onOnline"],
  ["pagehide", "onPageHide"], ["pageshow", "onPageShow"], ["resize", "onLayoutChange"],
  ["focus", "onWindowFocus"],
  ["kin:report-problem", "onReportProblem"], ["kin:suggest-feature", "onSuggestFeature"], ["kin:feedback-sent", "onFeedbackSent"],
];

class KinApp extends HTMLElement {
  constructor() {
    super();
    this.ctx = createAppContext(this);
    initializeAppState(this);
  }

  connectedCallback() {
    for (const [type, handler] of WINDOW_EVENTS) window.addEventListener(type, this[handler]);
    this.ctx.status.registerServiceWorker();
    if (!this.initialized) {
      this.ctx.shell.initializeElements();
      this.initialized = true;
    }
    for (const [type, handler] of ELEMENT_EVENTS) this.addEventListener(type, this[handler]);
    for (const [type, handler, options] of DOCUMENT_EVENTS) document.addEventListener(type, this[handler], options);
    this.phoneQuery?.addEventListener("change", this.onLayoutChange);
    this.wideQuery?.addEventListener("change", this.onLayoutChange);
    this.systemAppearance?.addEventListener("change", this.onSystemAppearance);
    this.authorizationTimer = setInterval(() => void this.ctx.sync.checkHouseholdAuthorization(), 30_000);
    this.ctx.peers.openPeerChannel();
    if (this.store) {
      // Reconnecting must not restart the engine or unlock an in-flight save.
      this.pendingRefresh = true;
      this.ctx.peers.flushPeerRefresh();
      void this.ctx.sync.configureSyncCoordinator();
    } else {
      this.ctx.session.initialize();
    }
  }

  disconnectedCallback() {
    this.ctx.session.lockHousehold(false, { endSession: true });
    for (const [type, handler] of WINDOW_EVENTS) window.removeEventListener(type, this[handler]);
    navigator.serviceWorker?.removeEventListener("message", this.onServiceWorkerMessage);
    navigator.serviceWorker?.removeEventListener("controllerchange", this.onControllerChange);
    for (const [type, handler] of ELEMENT_EVENTS) this.removeEventListener(type, this[handler]);
    for (const [type, handler, options] of DOCUMENT_EVENTS) document.removeEventListener(type, this[handler], options);
    this.phoneQuery?.removeEventListener("change", this.onLayoutChange);
    this.wideQuery?.removeEventListener("change", this.onLayoutChange);
    this.systemAppearance?.removeEventListener("change", this.onSystemAppearance);
    clearInterval(this.authorizationTimer);
    this.authorizationTimer = null;
    clearTimeout(this.pulseTimer);
    this.cancelFocusWake();
    this.ctx.peers.closePeerChannel();
    this.syncCoordinator?.stop();
    this.syncCoordinator = null;
  }

}

customElements.define("kin-app", KinApp);
