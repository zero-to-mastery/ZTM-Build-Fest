// The explicit dependency container shared by <kin-app>'s controllers.
// `app` is the element: it owns the state and DOM references the controllers
// read and write.
//
// How controllers call each other: always through `this.ctx.<key>` (for
// example `this.ctx.status.setBusy(true)`), never through the element.
//
// The test hook: regression scripts use this same context, as
// `document.querySelector("kin-app").ctx.<key>.<method>`. Replacing a method
// on a controller instance intercepts every call to it, because every caller
// goes through ctx. <kin-security> does not use ctx; shell.js hands it the
// few operations it needs as `security.services`.
//
// Where element fields come from:
// - Plain state and bound handlers: initializeAppState() below.
// - The persistent shell (nav, main, alert, status, catch-up, ...):
//   ShellBuilder.initializeElements() in shell.js.
// - The page views (app.today, app.needs, app.routines, app.notes, ...):
//   ViewBuilder.buildViews() in views.js, rebuilt on every lock.
//
// Several unrelated counters are called "generation" or "epoch":
// - `app.securityGeneration`: bumped on every unlock and lock; an async step
//   compares it to drop results from a closed session (shared/session-guard.js).
// - `app.commandGeneration`: the securityGeneration when the command palette
//   opened; a command chosen after a lock or unlock in between is ignored.
// - The vault's security epoch: persisted lock counter shared by all tabs
//   (EventStore.checkSecurityEpoch); a newer epoch means another tab locked.
// - The event arena's `generation` and `epoch`: see storage/event-arena.js.
import { captureInvitationCode } from "../../pairing-link.js";
import { AppearanceController } from "./appearance.js";
import { MealsController } from "./meals.js";
import { SimpleController } from "./simple.js";
import { ShareController } from "./share.js";
import { BadgeController } from "./badge.js";
import { PrivatePrefsController } from "./private-prefs.js";
import { WeekController } from "./week.js";
import { CalendarController } from "./calendar.js";
import { ChoresController } from "./chores.js";
import { EasyController } from "./easy.js";
import { HelpController } from "./help.js";
import { SitterController } from "./sitter.js";
import { AlbumController } from "./album.js";
import { JournalController } from "./journal.js";
import { RotationsController } from "./rotations.js";
import { ImportController } from "./import.js";
import { SectionsController } from "./sections.js";
import { PrivateItemsController } from "./private-items.js";
import { AppendCommands } from "./commands/append.js";
import { AttachmentController } from "./attachments.js";
import { ChatShareController } from "./chat-share.js";
import { BulkCommands } from "./commands/bulk.js";
import { ConversationCommands } from "./commands/conversations.js";
import { DetailController } from "./detail.js";
import { FirstRunController } from "./first-run.js";
import { ItemCommands } from "./commands/items.js";
import { NavigationController } from "./navigation.js";
import { FeaturesController } from "./features.js";
import { PeerChannel } from "./peer-channel.js";
import { RecordCommands } from "./commands/records.js";
import { RefreshController } from "./refresh.js";
import { installWakeHandlers } from "./wake.js";
import { RenderController } from "./render.js";
import { RoutineCommands } from "./commands/routines.js";
import { SessionController } from "./session.js";
import { ShellBuilder } from "./shell.js";
import { StatusController } from "./status.js";
import { SyncController } from "./sync.js";
import { UndoController } from "./undo.js";
import { ViewBuilder } from "./views.js";
import { ReportController } from "./report.js";
import { CalendarSyncController } from "./calendar-sync.js";
import { DisplayController } from "./display.js";
import { LocalReminders } from "../../reminders.js";
import { EventStore } from "../../storage/event-store.js";
import { readAutoLockPreference } from "./constants.js";
import { ReloadResume } from "../../security/reload-resume.js";
import { reconnectLostAuthorization } from "../shared/session-guard.js";

export function createAppContext(app) {
  const ctx = { app };
  ctx.session = new SessionController(ctx);
  ctx.sync = new SyncController(ctx);
  ctx.peers = new PeerChannel(ctx);
  ctx.refresh = new RefreshController(ctx);
  ctx.append = new AppendCommands(ctx);
  ctx.items = new ItemCommands(ctx);
  ctx.bulk = new BulkCommands(ctx);
  ctx.conversations = new ConversationCommands(ctx);
  ctx.routines = new RoutineCommands(ctx);
  ctx.records = new RecordCommands(ctx);
  ctx.meals = new MealsController(ctx);
  ctx.simple = new SimpleController(ctx);
  ctx.attachments = new AttachmentController(ctx);
  ctx.chatShare = new ChatShareController(ctx);
  ctx.share = new ShareController(ctx);
  ctx.badge = new BadgeController(ctx);
  ctx.privatePrefs = new PrivatePrefsController(ctx);
  // Easy mode and Help on every screen (#616, #620, ADR 0021).
  ctx.easy = new EasyController(ctx);
  ctx.help = new HelpController(ctx);
  ctx.week = new WeekController(ctx);
  // The family calendar (#660, ADR 0022): views, Today, colours, import.
  // Outside calendars (#668) reach the views through calendar/external.js.
  ctx.calendar = new CalendarController(ctx);
  // The chore chart (#676, ADR 0022 §6).
  ctx.chores = new ChoresController(ctx);
  ctx.sitter = new SitterController(ctx);
  ctx.album = new AlbumController(ctx);
  // The member's journal (#496): private, never household state.
  ctx.journal = new JournalController(ctx);
  ctx.rotations = new RotationsController(ctx);
  ctx.importList = new ImportController(ctx);
  ctx.sections = new SectionsController(ctx);
  // Just for me (#510): the member's private list.
  ctx.privateItems = new PrivateItemsController(ctx);
  // Household features (#625, ADR 0021): what this household switched off.
  ctx.features = new FeaturesController(ctx);
  ctx.navigation = new NavigationController(ctx);
  ctx.detail = new DetailController(ctx);
  ctx.appearance = new AppearanceController(ctx);
  ctx.status = new StatusController(ctx);
  ctx.firstRun = new FirstRunController(ctx);
  ctx.undo = new UndoController(ctx);
  ctx.render = new RenderController(ctx);
  ctx.shell = new ShellBuilder(ctx);
  ctx.views = new ViewBuilder(ctx);
  // Reports and suggestions to the Kin team (ADR 0021 §3).
  ctx.report = new ReportController(ctx);
  // Outside calendars synced through the service (ADR 0022 §3, #668).
  ctx.calendarSync = new CalendarSyncController(ctx);
  // Kitchen display mode (#669, ADR 0022 §4).
  ctx.display = new DisplayController(ctx);
  return ctx;
}

// The element's initial state and its bound event handlers. Handlers are
// element properties so the lifecycle wiring can add and remove them.
export function initializeAppState(app) {
    app.engine = null;
    app.store = null;
    // Attachment file records (names, sizes, upload state) from IndexedDB,
    // which the views show. Not `state.attachments`: those are the projection's
    // bindings of attachment IDs to records, which Rust derives from events.
    app.attachmentRows = [];
    app.syncCoordinator = null;
    app.hasLocalSyncBinding = false;
    app.state = null;
    app.localReminders = new LocalReminders();
    app.deferredInstallPrompt = null;
    app.vault = null;
    app.securityGeneration = 0;
    app.busy = false;
    app.starting = null;
    app.initialized = false;
    app.authorizationTimer = null;
    app.checkingAuthorization = false;
    app.channel = null;
    app.refreshing = false;
    app.pendingRefresh = false;
    app.retryAction = null;
    app.retryIntent = null;
    app.suspendedRetry = null;
    app.retryRefresh = () => app.ctx.refresh.refreshFromEvents();
    app.onAddItem = (event) => app.ctx.items.handleAddItem(event);
    app.onAddAttachment = (event) => app.ctx.attachments.handleAddAttachment(event);
    app.onPickAttachment = (event) => app.ctx.attachments.handlePickAttachment(event);
    // One file input for the whole app: it is never re-rendered, so a list
    // refresh while the native picker is open cannot lose the chosen file.
    app.attachmentInput = null;
    app.attachmentTarget = null;
    app.attachmentProgressTimers = new Map();
    app.onOpenAttachment = (event) => app.ctx.attachments.handleOpenAttachment(event);
    app.onViewAttachment = (event) => app.ctx.attachments.handleViewAttachment(event);
    app.onRemoveAttachment = (event) => app.ctx.attachments.handleRemoveAttachment(event);
    // Thumbnails are session-scoped object URLs; the cache is created on unlock
    // and emptied on lock so no decrypted preview outlives the vault.
    app.attachmentPreviews = null;
    app.previewProvider = (record, options) => app.ctx.attachments.provideAttachmentPreview(record, options);
    app.viewerUrl = null;
    app.viewerOpener = null;
    app.pendingCapture = null;
    app.pendingScheduleChange = null;
    app.householdStatus = null;
    app.passkeyPromptDismissed = false;
    app.onHouseholdStatus = (event) => { app.householdStatus = event.detail;
      // Household features (#625) ride along with the household's status.
      if (event.detail?.features) app.ctx.features.receive(event.detail.features, { householdId: event.detail.householdId ?? null });
      // Whether adults may join the chore chart (#676) rides along too.
      if (event.detail?.choreChart) app.ctx.chores.receiveSetting(event.detail.choreChart);
      app.ctx.sitter.landTemporaryMember(); app.ctx.display.statusChanged(); app.ctx.status.renderOnboarding(); app.ctx.sync.updateSyncChip(); void app.notifications?.refresh?.({ identity: event.detail?.identity === true }); };
    app.onSecurityChanged = () => app.ctx.status.renderOnboarding();
    app.autoLockMinutes = readAutoLockPreference();
    app.autoLockTimer = null;
    app.lastActivityAt = null;
    // A refresh keeps Kin unlocked in this tab (#351, ADR 0010).
    app.reloadResume = new ReloadResume();
    app.resumeAutoLockAt = null;
    app.onActivity = () => { if (app.autoLockTimer) app.ctx.session.scheduleAutoLock(); };
    app.onRetryAttachments = () => { if (app.syncCoordinator) void app.syncCoordinator.syncNow(); else void app.ctx.sync.configureSyncCoordinator(); };
    app.onChangeResponsibility = (event) => app.ctx.items.handleChangeResponsibility(event);
    // Simple view (#346): Done and Undo on a card.
    app.onSimpleDone = (event) => void app.ctx.simple.markDone(event.detail);
    // Kitchen display mode (#670): Household › Overview's setup.
    app.onDisplayEnter = (event) => app.ctx.display.start(event.detail ?? {});
    // Item picture (#347), from the item details.
    app.onSetItemEmoji = (event) => void app.ctx.simple.setItemEmoji(event.detail);
    app.onReplenishStaple = (event) => app.ctx.items.handleReplenishStaple(event);
    // Just for me (#510, #517): a private item done or reopened from Today
    // or This week, and "Make private" from a household item's details.
    app.onTogglePrivateItem = (event) => void app.ctx.privateItems.toggle(event.detail ?? {});
    app.onMakeItemPrivate = (event) => void app.ctx.privateItems.makePrivate(event.detail?.itemId);
    app.syncState = null;
    // When this device last finished a sync pass, for a report's diagnostics.
    app.lastSyncAt = null;
    // Whether the member is a household admin, from the household settings.
    app.householdAdmin = false;
    // Report a problem, Suggest something, What I've sent (ADR 0021 §3):
    // asked for by any element or the window (Help fires kin:report-problem).
    const opener = (event) => (event.target instanceof HTMLElement ? event.target : null);
    app.onReportProblem = (event) => void app.ctx.report.open("problem", { opener: opener(event) });
    app.onSuggestFeature = (event) => void app.ctx.report.open("suggestion", { opener: opener(event) });
    app.onFeedbackSent = (event) => void app.ctx.report.open("sent", { opener: opener(event) });
    // Follows the browser's own offline/online events, like the state notice.
    app.offline = typeof navigator !== "undefined" && navigator.onLine === false;
    app.onOffline = () => {
      app.offline = true;
      app.stateNotice.textContent = app.syncCoordinator || app.householdStatus?.identity
        ? "You're offline. Your changes are saved on this device and will sync when you're connected."
        : "You're offline. Your changes are saved on this device.";
      app.stateNotice.hidden = false;
      app.ctx.sync.updateSyncChip();
    };
    app.onOnline = async () => {
      app.offline = false;
      app.stateNotice.hidden = true;
      app.ctx.sync.updateSyncChip();
      // Reports waiting in the outbox go out (#632), locked or not.
      void app.ctx.report.flush();
      if (!app.vault || app.vault.locked || !app.store) return;
      const session = app.ctx.session.captureSession();
      const wasBound = Boolean(app.syncCoordinator || app.hasLocalSyncBinding);
      app.ctx.status.setStatus(app.syncCoordinator ? "Back online. Syncing…" : "Back online.");
      const authorization = await app.household?.load?.();
      if (!app.ctx.session.isCurrentSession(session)) return;
      if (reconnectLostAuthorization(authorization, wasBound)) {
        app.ctx.session.lockHousehold(true, { endSession: true });
        return;
      }
      if (app.syncCoordinator) void app.syncCoordinator.syncNow();
      else void app.ctx.sync.configureSyncCoordinator();
    };
    app.onCompleteItem = (event) => app.ctx.items.handleCompleteItem(event);
    app.onReopenItem = (event) => app.ctx.items.handleReopenItem(event);
    app.onArchiveItem = (event) => app.ctx.items.handleArchiveItem(event);
    app.onAddItemStep = (event) => app.ctx.items.handleItemStep("add-item-step", event.detail);
    app.onCompleteItemStep = (event) => app.ctx.items.handleItemStep("complete-item-step", event.detail);
    app.onReopenItemStep = (event) => app.ctx.items.handleItemStep("reopen-item-step", event.detail);
    app.onArchiveItemStep = (event) => app.ctx.items.handleItemStep("archive-item-step", event.detail);
    app.onAddHandoff = (event) => app.ctx.conversations.handleAddHandoff(event);
    app.onAcknowledgeHandoff = (event) =>
      app.ctx.conversations.handleHandoffAction("acknowledge-handoff", event.detail.handoffId);
    app.onArchiveHandoff = (event) =>
      app.ctx.conversations.handleHandoffAction("archive-handoff", event.detail.handoffId);
    app.onAddTalk = (event) =>
      app.ctx.conversations.saveTalk({ type: "add-talk", text: event.detail.text });
    app.onResolveTalk = (event) =>
      app.ctx.conversations.saveTalk({ type: "resolve-talk", talkId: event.detail.talkId });
    app.onReopenTalk = (event) =>
      app.ctx.conversations.saveTalk({ type: "reopen-talk", talkId: event.detail.talkId });
    app.onArchiveTalk = (event) =>
      app.ctx.conversations.saveTalk({ type: "archive-talk", talkId: event.detail.talkId });
    // Several handlers derive the command type from the event name: every
    // component event is "kin:<command>", so `event.type.slice(4)` drops "kin:".
    app.onImportList = (event) => app.ctx.importList.open(event.detail ?? {});
    app.onSetItemSection = (event) => void app.ctx.sections.setItemSection(event.detail.itemId, event.detail.sectionId);
    app.onSaveShoppingSections = async (event) => {
      const outcome = await app.ctx.sections.saveSections(event.detail.sections ?? []);
      event.detail.done?.(outcome);
    };
    app.onSetRoutineRotation = async (event) => {
      const outcome = await app.ctx.rotations.setRotation(event.detail.routineId, event.detail.memberIds ?? []);
      event.detail.done?.(outcome);
    };
    app.onSetRoutineTurn = async (event) => {
      const outcome = await app.ctx.rotations.setTurn(event.detail.routineId, event.detail.memberId);
      event.detail.done?.(outcome);
    };
    // Chore chart points per routine (#676), from Routines.
    app.onSetChorePoints = async (event) => {
      const outcome = await app.ctx.chores.setPoints(event.detail.routineId, event.detail.points);
      event.detail.done?.(outcome);
    };
    app.onSaveSitterPage = async (event) => {
      const outcome = await app.ctx.sitter.save(event.detail ?? {});
      event.detail?.done?.(outcome);
    };
    app.onStartShopping = (event) => {
      if (!app.simpleView && !app.displayMode && app.state && app.ctx.features.isOn("shopping-mode")) app.shoppingMode?.open({ opener: event.detail?.opener ?? null });
    };
    app.onRoutineIntent = (event) => app.ctx.routines.saveRoutine({ ...event.detail, type: event.type.slice(4) });
    app.onChangeRoutineSchedule = (event) => app.ctx.routines.changeRoutineSchedule(event.detail);
    app.onOpenRoutineSchedule = (event) => app.ctx.routines.openRoutineSchedule(event.detail.routineId);
    app.onAreaIntent = (event) => app.ctx.records.saveArea(event.detail);
    app.onNoteIntent = (event) => app.ctx.records.saveNote(event.type.slice(4), event.detail);
    app.onReferenceIntent = (event) => app.ctx.records.saveReferenceRecord(event.type.slice(4), event.detail);
    app.onMaintenanceIntent = (event) => app.ctx.records.saveMaintenanceEvent(event.type.slice(4), event.detail);
    app.onItemAreaChange = (event) => app.ctx.records.saveArea({ ...event.detail, action: "assign-item-area" });
    app.onItemPlanningDateChange = (event) =>
      app.ctx.items.saveItemPlanningDate(event.detail, event.target.closest("kin-today, kin-item-detail"));
    app.onPinIntent = (event) => app.ctx.items.savePin(event.detail);
    app.onOpenPin = (event) => app.ctx.items.openPinnedItem(event.detail.itemId, event.detail.opener);
    // Today's empty states reuse the universal Quick add; focus returns to the
    // button that opened it, or to the Today heading once that button is gone.
    app.onOpenQuickAdd = (event) => app.quickAdd.open({ opener: event.detail?.opener, fallback: () => app.today.querySelector('[data-section="today"] h2') });
    app.onOpenItem = (event) => app.ctx.detail.openItemDetail(event.detail.itemId, { opener: event.detail.opener ?? event.target });
    app.onCloseItemDetail = () => app.ctx.detail.closeItemDetail({ restoreFocus: true });
    app.onOpenSearchResult = (event) => app.ctx.navigation.handleOpenSearchResult(event.detail);
    app.onChatToRecord = (event) => {
      // "Add to the family photos" (#673): the photo goes to Family photos.
      if (event.detail?.kind === "photos") { void app.ctx.album.offer(event.detail.files ?? [], { opener: event.detail.opener ?? null }); return; }
      app.ctx.chatShare.open({ ...event.detail, opener: event.detail?.opener ?? null });
    };
    app.onOpenChatMessage = (event) => app.ctx.navigation.handleOpenChatMessage(event.detail);
    app.onPlaybookIntent = (event) => app.ctx.routines.handlePlaybookIntent(event);
    app.onLocalReminder = (event) => app.ctx.records.handleLocalReminder(event.detail);
    app.onCancelLocalReminder = (event) => {
      const synced = app.ctx.privatePrefs.available;
      void app.ctx.privatePrefs.endReminder(event.detail.id, "canceled").catch(() => {}).then(() => app.ctx.records.renderReminders());
      app.ctx.records.renderReminders();
      app.ctx.status.setStatus(synced ? "Reminder canceled on all your devices." : "Reminder canceled on this device.");
    };
    // Text size, motion and reminder alerts (#524), and "Use different
    // settings on this device".
    app.onPersonalSetting = (event) => { void app.ctx.privatePrefs.setDisplaySetting(event.detail.name, event.detail.value); };
    app.onSettingsThisDevice = (event) => { event.detail.kept = app.ctx.privatePrefs.setDeviceOnly(event.detail.on); };
    // Help on every screen (#621): a page's or a dialog's Help button.
    app.onOpenHelp = (event) => app.ctx.help.open(event.detail ?? {});
    app.onModeChange = () => app.ctx.records.saveMode(app.modeSelect.value);
    // The family calendar (#660): <kin-calendar>, the event editor, the
    // colour setting and importing a calendar file.
    app.onCalendarFocus = (event) => app.ctx.calendar.handleFocus(event.detail ?? {});
    app.onCalendarOpenEvent = (event) => app.ctx.calendar.openEvent(event.detail ?? {});
    app.onCalendarNewEvent = (event) => app.ctx.calendar.openNew(event.detail ?? {});
    app.onCalendarImport = (event) => app.ctx.calendar.openImport(event.detail ?? {});
    app.onCalendarSave = async (event) => event.detail?.done?.(await app.ctx.calendar.save(event.detail));
    app.onCalendarCancel = async (event) => event.detail?.done?.(await app.ctx.calendar.cancel(event.detail));
    app.onSetMemberColour = async (event) => event.detail?.done?.(await app.ctx.calendar.setColour(event.detail?.colour ?? null));
    app.onCalendarImportFile = async (event) => event.detail?.done?.(await app.ctx.calendar.previewImport(event.detail?.file));
    app.onCalendarImportConfirm = async (event) => event.detail?.done?.(await app.ctx.calendar.confirmImport());
    app.pulseTimer = null;
    app.catchUpCursor = null;
    app.snapshotBoundary = null;
    app.onCaughtUp = () => app.ctx.refresh.handleCaughtUp();
    app.onSyncEnabled = (event) => app.ctx.sync.startSyncCoordinator(event.detail);
    app.onSyncNow = () => void app.syncCoordinator?.syncNow();
    app.onSyncStop = (event) => {
      app.syncCoordinator?.stop();
      app.syncCoordinator = null;
      app.syncState = null;
      app.ctx.sync.updateSyncChip();
      app.ctx.status.setStatus(event.detail?.message ?? "Household sync has stopped.");
    };
    app.onSyncState = (value) => app.ctx.sync.handleSyncState(value);
    app.onHashChange = () => {
      // A same-page jump to an invitation link (/pair#code=…) takes its code
      // first, so it never lingers in the address bar or history (#97).
      if (captureInvitationCode()) app.household?.offerInvitationCode?.();
      // A home-screen shortcut opened into a running Kin (#472) lands
      // itself (or waits for unlock); its address is already cleared.
      if (app.ctx.share.handleLaunchAddress()) return;
      app.ctx.navigation.showPageFromLocation();
    };
    app.onNavigationClick = (event) => {
      const link = event.target.closest?.("a[href^='#']");
      if (
        !link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      ) return;
      event.preventDefault();
      app.ctx.navigation.navigate(link.getAttribute("href"));
    };
    // Selection: one canonical item id plus where it was opened from. The
    // same <kin-item-detail> element is re-homed between the mobile sheet,
    // the inline column and the side column as the viewport changes.
    app.selection = null;
    app.detailMode = null;
    app.rehomingDetail = false;
    app.pageScroll = new Map();
    app.phoneQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 719px)") : null;
    app.wideQuery = typeof matchMedia === "function" ? matchMedia("(min-width: 1180px)") : null;
    app.onLayoutChange = () => app.ctx.detail.mountDetail();
    app.onDetailKeydown = (event) => {
      // Escape inside an open dialog (Quick add, the palette) closes that
      // dialog first; the side or inline details stay open beneath it.
      if (event.defaultPrevented || event.key !== "Escape" || app.viewer?.open || event.target.closest?.("dialog[open]")) return;
      if (app.selection && app.detailMode !== "sheet") {
        event.preventDefault();
        app.ctx.detail.closeItemDetail({ restoreFocus: true });
      }
    };
    app.onShortcutKeydown = (event) => app.ctx.navigation.handleShortcutKeydown(event);
    // Bulk actions: the last outcome's undo and retry sets, in memory only.
    app.bulkRunning = false;
    app.bulkUndo = null;
    app.bulkRetry = null;
    app.bulkUndoTimer = null;
    app.onBulkItemAction = (event) => app.ctx.bulk.handleBulkItemAction(event);
    app.onBulkUndo = (event) => app.ctx.bulk.handleBulkUndo(event);
    app.onBulkRetry = (event) => app.ctx.bulk.handleBulkRetry(event);
    app.onBulkDismiss = () => app.ctx.bulk.clearBulkOutcome();
    const platform = typeof navigator === "undefined" ? "" : navigator.userAgentData?.platform ?? navigator.platform ?? "";
    app.macShortcuts = /mac|iphone|ipad|ipod/i.test(platform);
    app.commandGeneration = null;
    app.onSetPulse = (event) => {
      const timestamp = Date.now();
      const hours = event.detail.hours;
      if (![1, 4, 8].includes(hours)) return;
      app.ctx.conversations.savePulse({
        type: "set-pulse",
        value: event.detail.value,
        timestamp,
        expiresAt: timestamp + hours * 3_600_000,
      });
    };
    app.onClearPulse = () => app.ctx.conversations.savePulse({ type: "clear-pulse" });
    // Window focus, visibility and the Pulse timer (wake.js): onWindowFocus,
    // onTimeWake and `wakePending`, which counts a wake as busy (#793).
    installWakeHandlers(app, (vault) => EventStore.checkSecurityEpoch(vault));
    app.onPeerMessage = (event) => app.ctx.peers.handlePeerMessage(event);
    // Count on the app icon (#476): <kin-app-badge> asks; the answer says
    // whether the choice could be kept on this device.
    app.onAppBadgeChoice = (event) => {
      event.detail.kept = app.ctx.badge.setChoice(event.detail.value);
      void app.ctx.privatePrefs.settingsChanged(["app-badge"]);
    };
    // Logout and leaving the household end the session for good; a plain
    // lock request only suspends it.
    app.onLockRequest = (event) => app.ctx.session.lockHousehold(true, { endSession: event?.detail?.endSession === true });
    app.onAppearancePreview = (event) => app.ctx.appearance.applyAppearance(event.detail.value);
    app.onSaveAppearance = (event) => app.ctx.appearance.handleSaveAppearance(event);
    app.onUseHouseholdAppearance = (event) => app.ctx.appearance.handleUseHouseholdAppearance(event);
    app.onInheritAppearanceProperty = (event) => app.ctx.appearance.handleInheritAppearanceProperty(event);
    app.onHouseholdDefaultsPreview = (event) => { app.ctx.appearance.setHouseholdIdentity(event.detail.name); app.ctx.appearance.applyAppearance(event.detail.appearance); };
    app.onHouseholdDefaultsCancel = () => app.ctx.appearance.applyEffectiveAppearance();
    app.onSaveHouseholdDefaults = (event) => app.ctx.appearance.handleSaveHouseholdDefaults(event);
    app.onPublishInstallIdentity = (event) => app.ctx.appearance.handleInstallIdentity(event, false);
    app.onWithdrawInstallIdentity = (event) => app.ctx.appearance.handleInstallIdentity(event, true);
    app.systemAppearance = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    app.onSystemAppearance = () => { if (app.currentAppearance?.mode === "system") app.ctx.appearance.applyAppearance(app.currentAppearance); };
    // The unloading page can't tell a refresh from a close: it leaves a
    // one-use ticket (reload-resume.js) and locks as before. Only a refresh
    // of this tab can use the ticket; a real lock deletes it.
    app.onPageHide = () => {
      const autoLockAt = app.autoLockMinutes && app.lastActivityAt !== null
        ? app.lastActivityAt + app.autoLockMinutes * 60_000 : null;
      app.reloadResume.write({ vault: app.vault, autoLockAt });
      // Closing Kin leaves the app icon count as it was (#476): that is what
      // the member chose it for. Lock and sign-out clear it.
      app.ctx.session.lockHousehold(false, { keepReloadResume: true, keepBadge: true });
    };
    // Coming back from the back/forward cache is navigating, not a refresh.
    app.onPageShow = (event) => { if (event?.persisted) void app.reloadResume.disarm(); };
    app.updateRegistration = null;
    app.updateRequested = false;
    app.onServiceWorkerMessage = (event) => {
      if (event.data?.type === "KIN_UPDATE_READY") app.ctx.status.showUpdateNotice();
    };
    app.onControllerChange = () => {
      if (app.updateRequested) window.location.reload();
    };
    app.onBeforeInstallPrompt = (event) => { event.preventDefault(); app.deferredInstallPrompt = event; if (app.installButton) app.installButton.hidden = false; };
    app.onAppInstalled = () => { app.deferredInstallPrompt = null; if (app.installButton) app.installButton.hidden = true; };
}
