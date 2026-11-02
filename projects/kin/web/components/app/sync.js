// Encrypted sync coordinator setup, authorization checks and the sync status chip.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { SyncCoordinator } from "../../sync/sync-coordinator.js";
import { currentPlatform, householdDeviceName } from "../../platform.js";
import { SYNC_PAUSE_MESSAGES } from "./constants.js";

export class SyncController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async configureSyncCoordinator() {
    if (!this.app.vault || this.app.vault.locked || !this.app.store) return;
    const session = this.ctx.session.captureSession();
    try {
      const identityResponse = await fetch("/api/status");
      this.ctx.session.assertCurrentSession(session);
      if (!identityResponse.ok) return;
      const { identity } = await identityResponse.json();
      this.ctx.session.assertCurrentSession(session);
      if (!identity) return;
      const syncResponse = await fetch("/api/sync/status");
      this.ctx.session.assertCurrentSession(session);
      if (!syncResponse.ok) return;
      const syncStatus = await syncResponse.json();
      this.ctx.session.assertCurrentSession(session);
      if (syncStatus.enabled) await this.startSyncCoordinator(identity);
    } catch {
      // Local household use remains available while the service is unreachable.
    }
  }
  async checkHouseholdAuthorization() {
    if (!this.app.vault || this.app.vault.locked) return;
    const session = this.ctx.session.captureSession();
    const household = this.app.household;
    const identity = household?.identity;
    if (
      !identity ||
      this.app.checkingAuthorization ||
      document.visibilityState === "hidden"
    )
      return;
    this.app.checkingAuthorization = true;
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      this.ctx.session.assertCurrentSession(session);
      if (!response.ok) return;
      const status = await response.json();
      this.ctx.session.assertCurrentSession(session);
      if (
        this.app.household !== household ||
        household.identity !== identity ||
        status.identity
      )
        return;
      // The device no longer belongs to a household (removed, left, deleted).
      this.ctx.session.lockHousehold(true, { endSession: true });
    } catch {
      // Keep local household use available while the service is unreachable.
    } finally {
      if (this.ctx.session.isCurrentSession(session)) this.app.checkingAuthorization = false;
    }
  }
  /** Names the fridge's artists with members' preferred names (#224). */
  async labelFridge(myId) {
    let names = new Map();
    try { names = new Map((await this.memberNames()).map(({ memberId, name }) => [memberId, name])); } catch { /* fall back */ }
    if (!this.app.fridge) return;
    this.app.fridge.labelOf = (id) => (id === myId ? "you" : names.get(id) ?? "a household member");
    this.app.fridge.render();
  }
  async startSyncCoordinator(identity) {
    if (!this.app.vault || this.app.vault.locked || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    if (this.app.syncCoordinator?.identity.deviceId === identity.deviceId)
      return this.app.syncCoordinator.syncNow();
    this.app.syncCoordinator?.stop();
    let coordinator;
    coordinator = new SyncCoordinator({
      store: session.store,
      engine: session.engine,
      identity,
      onState: (value) => {
        if (
          this.ctx.session.isCurrentSession(session) &&
          this.app.syncCoordinator === coordinator
        )
          this.ctx.sync.handleSyncState(value);
      },
      // The household chat room (#111, #112), for Updates → Chat.
      onChatRoom: (room) => {
        if (!this.app.chat) return;
        if (room && !(this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator)) return;
        if (!room && this.app.chat.room !== coordinator.chat && this.app.chat.room) return;
        this.app.chat.room = room;
        if (this.app.chatSettings) this.app.chatSettings.room = room;
        // Search finds chat messages only while Chat is on (#625).
        if (this.app.search) this.app.search.chatRoom = this.ctx.features.isOn("chat") ? room : null;
        this.ctx.simple?.updateAccess();
      },
      // The member's account vault key (#557), unsealed from this device's
      // key store while unlocked; null when locked or when this device keeps
      // none. Private storage (ADR 0019) reads its member key through it.
      vaultKey: async () => {
        if (!this.ctx.session.isCurrentSession(session)) return null;
        try { return await this.app.household?.syncKeyStore?.accountVaultKey(identity.householdId) ?? null; }
        catch { return null; }
      },
      // Household features (#625, ADR 0021): what the household switched off.
      onFeatures: (features) => {
        if (!(this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator)) return;
        this.ctx.features.receive(features, { householdId: identity.householdId });
      },
      // Whether adults may join the chore chart (#676).
      onChoreChart: (value) => {
        if (!(this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator)) return;
        this.ctx.chores.receiveSetting(value);
      },
      // Simple view (#343, ADR 0013): the layout this member's admin chose.
      onSimpleView: (on, options) => {
        if (!(this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator)) return;
        this.ctx.simple?.setSimpleView(on, options);
      },
      // The family fridge (#317), for Household → Fridge.
      onBoardRoom: (room) => {
        if (!this.app.fridge) return;
        if (room && !(this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator)) return;
        if (!room && this.app.fridge.room !== coordinator.board && this.app.fridge.room) return;
        this.app.fridge.memberId = identity.memberId;
        this.app.fridge.room = room;
        if (room) void this.labelFridge(identity.memberId);
        this.ctx.simple?.updateAccess();
      },
      // The member's private log (#492), for Lists › Just for me (#510), the
      // journal (#496) and the reminders and settings that follow the member
      // (#520, app/private-prefs.js); null when it closes. It opens once this device
      // holds a vault key (#557).
      onPrivateLog: (log) => {
        if (log && !(this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator)) return;
        if (!log) {
          if (this.ctx.privatePrefs.log && this.app.syncCoordinator === coordinator) this.ctx.privatePrefs.detach();
        } else this.ctx.privatePrefs.attach(log, session);
        if (log || !this.ctx.journal?.log || this.ctx.journal.log === coordinator.privateLog) void this.ctx.journal?.setLog(log);
        if (!log && this.ctx.privateItems.log !== coordinator.privateLog && this.ctx.privateItems.log) return;
        this.ctx.privateItems.attach(log);
      },
    });
    this.app.syncCoordinator = coordinator;
    this.updateSyncChip();
    try {
      await coordinator.start();
      if (this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator) await this.ctx.appearance.refreshHouseholdDefaults();
    } catch (error) {
      if (
        this.ctx.session.isCurrentSession(session) &&
        this.app.syncCoordinator === coordinator
      ) {
        this.ctx.sync.handleSyncState({
          state: "paused",
          code: error.code,
          message: error.message || "Device sync is paused.",
        });
      }
    } finally {
      if (
        !this.ctx.session.isCurrentSession(session) ||
        this.app.syncCoordinator !== coordinator
      )
        coordinator.stop();
    }
  }
  handleSyncState(value) {
    if (!this.app.vault || this.app.vault.locked) return;
    const wasReady = this.app.syncState?.state === "ready";
    if (value.state) { this.app.syncState = value; this.updateSyncChip(); }
    // The household moved to a home server (#737): the household's status
    // says where, and the household panel and Today show it.
    if (value.state === "deleted" && value.lifecycleState === "moved") void this.app.household?.load?.();
    if (value.state === "ready") {
      // For a report's diagnostics; and reports waiting to be sent go out
      // once sync is back (ADR 0021 §3).
      this.app.lastSyncAt = Date.now();
      if (!wasReady) void this.ctx.report?.flush();
    }
    if (value.state === "ready") void this.settlePendingShares();
    // Outside calendars (#668): listed again when the list is 5 minutes old.
    if (value.state === "ready") this.ctx.calendarSync?.onSync();
    // Names typed at first run are recorded once sync is ready (#557).
    if (value.state === "ready" && this.app.pendingProfile) void this.ctx.firstRun?.applyProfile();
    if (value.state === "paused") {
      const attention = SYNC_PAUSE_MESSAGES[value.code] ?? value.message;
      if (attention) {
        this.app.stateNotice.textContent = attention;
        this.app.stateNotice.hidden = false;
      }
    } else if (value.state === "ready" && value.quarantineNotice) {
      // Changes this device couldn't apply yet stay listed until they apply.
      // Unchanged text isn't rewritten, so the live region doesn't
      // re-announce on every poll.
      if (this.app.stateNotice.textContent !== value.quarantineNotice)
        this.app.stateNotice.textContent = value.quarantineNotice;
      this.app.stateNotice.hidden = false;
      void this.ctx.appearance.refreshHouseholdDefaults();
    } else if (["ready", "disabled"].includes(value.state)) {
      this.app.stateNotice.hidden = true;
      if (value.state === "ready") void this.ctx.appearance.refreshHouseholdDefaults();
    }
    // Kept as a promise so a caller (the browser regressions) can wait for
    // the description and sync it right away.
    if (value.state === "ready" && !this.app.describingDevice)
      this.app.deviceDescription = this.describeThisDevice();
    if (value.projection && value.added > 0) {
      if (this.app.busy) {
        this.app.pendingRefresh = true;
      } else {
        this.app.state = value.projection;
        this.app.snapshotBoundary = value.snapshotBoundary;
        this.ctx.render.renderState();
        if (value.snapshotBoundary) this.ctx.peers.broadcastEventChange();
      }
    }
    if (Array.isArray(value.attachmentRows)) {
      const rows = this.ctx.attachments.mergeAttachmentRows(value.attachmentRows);
      const sameRows = rows.length === this.app.attachmentRows.length && rows.every((row, index) => {
        const current = this.app.attachmentRows[index];
        return current && ["attachmentId", "parentKind", "parentId", "name", "size", "type", "state"]
          .every((key) => row[key] === current[key]);
      });
      if (!sameRows) {
        this.app.attachmentRows = rows;
        this.ctx.render.renderState();
      }
    }
    if (Array.isArray(value.memberIds)) {
      const memberIds = [...new Set(value.memberIds)];
      const previousMembers = new Set(this.app.activeMemberIds ?? []);
      const membershipChanged = memberIds.length !== previousMembers.size || memberIds.some((id) => !previousMembers.has(id));
      // Keep the old array when nothing changed: responsibilityContext() and
      // the views it feeds skip work by identity, and this runs on every poll.
      if (membershipChanged) {
        this.app.activeMemberIds = memberIds;
        this.ctx.render.renderState();
      }
      void this.reconcileResponsibilityMembers();
    }
    // Who are children and Adults, for the chore chart (#676).
    if (value.memberKinds instanceof Map) {
      const previous = this.app.activeMemberKinds;
      const same = previous && previous.size === value.memberKinds.size && [...value.memberKinds].every(([id, kind]) => previous.get(id) === kind);
      if (!same) {
        this.app.activeMemberKinds = value.memberKinds;
        void this.ctx.chores?.refresh();
      }
    }
    // The sync chip already shows routine progress. Toast only meaningful
    // incoming changes or an unusual state, not every five-second idle poll.
    if (value.message && value.state !== "paused" &&
        (value.quarantined > 0 || !["syncing", "ready", "disabled"].includes(value.state)))
      this.ctx.status.setStatus(value.message);
  }
  // Captures that said "Saved here. Waiting to sync." become "sent" only once
  // a ready cycle leaves nothing unaccepted in this device's outbox, so the
  // message never claims more than the relay confirmed (#267). Nothing is
  // said about other devices receiving or reading it.
  async settlePendingShares() {
    const waiting = this.app.pendingShares;
    if (!waiting?.size || this.settlingShares) return false;
    const session = this.ctx.session.captureSession();
    if (!session.store) return false;
    this.settlingShares = true;
    try {
      const unsent = await session.store.getPendingOutbox(1);
      if (!this.ctx.session.isCurrentSession(session) || unsent.length) return false;
      const composers = [...waiting];
      waiting.clear();
      const changed = composers.filter((composer) => composer.isConnected !== false && composer.markShared?.());
      if (changed.length) this.ctx.status.setStatus("Sent to your household.");
      return changed.length > 0;
    } catch {
      return false; // The next ready cycle checks again.
    } finally {
      this.settlingShares = false;
    }
  }
  updateSyncChip() {
    if (!this.app.syncChip) return;
    if (!this.app.vault || this.app.vault.locked || !this.app.store) { this.app.syncChip.state = null; return; }
    if (this.app.offline || navigator.onLine === false) { this.app.syncChip.state = this.app.syncCoordinator || this.app.householdStatus?.identity ? "offline-sync" : "offline"; return; }
    if (!this.app.syncCoordinator) { this.app.syncChip.state = "local"; return; }
    const state = this.app.syncState?.state;
    this.app.syncChip.state = state === "syncing" ? "syncing" : state === "paused" || state === "deleted" ? "paused" : state === "ready" ? "ready" : "syncing";
  }
  // Only promise a later sync when this device actually syncs; otherwise a
  // change is simply saved here.
  offlineSyncSuffix() {
    return navigator.onLine === false && this.app.syncCoordinator ? " It will sync when you're connected." : "";
  }
  async reconcileResponsibilityMembers() {
    if (this.app.reconcilingResponsibility || this.app.busy || !this.app.store || !this.app.engine ||
        !this.app.activeMemberIds || !this.app.state?.responsibilities?.length) return;
    const active = new Set(this.app.activeMemberIds);
    const rotating = this.app.rotations ?? new Map();
    const stale = this.app.state.responsibilities.filter((entry) => {
      if (!entry.memberId || active.has(entry.memberId)) return false;
      // A rotating routine's turn moves on instead (app/rotations.js, #437).
      if (entry.targetKind === "routine" && rotating.has(entry.targetId)) return false;
      return entry.targetKind === "item"
        ? this.app.state.items?.some((item) => item.itemId === entry.targetId && item.status !== "archived")
        : this.app.state.routines?.some((routine) => routine.routineId === entry.targetId && !routine.archived);
    });
    if (!stale.length) return;
    this.app.reconcilingResponsibility = true;
    const session = this.ctx.session.captureSession();
    let committed = false;
    try {
      for (const entry of stale) {
        if (!this.app.activeMemberIds.includes(this.app.syncCoordinator?.identity?.memberId)) break;
        await this.ctx.append.appendCommand({ type: "change-responsibility", targetKind: entry.targetKind, id: entry.targetId, memberId: null });
        this.ctx.session.assertCurrentSession(session);
        committed = true;
      }
      this.ctx.session.assertCurrentSession(session);
      if (committed) {
        const focus = this.ctx.refresh.captureRefreshFocus();
        this.ctx.render.renderState();
        this.ctx.refresh.restoreRefreshFocus(focus);
        this.ctx.peers.broadcastEventChange();
      }
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      // Another device may have cleared the same removed member concurrently.
      this.app.pendingRefresh = true;
    } finally {
      this.app.reconcilingResponsibility = false;
      if (committed && this.ctx.session.isCurrentSession(session)) this.ctx.peers.flushPeerRefresh();
    }
  }
  // Device names (#71) are encrypted household events, so they are shared
  // only once this device syncs. Its automatic name ("Chrome on iPhone") is
  // recorded after its first successful sync, when its events carry its sync
  // identity, and again only when the name changes (a browser update, an
  // installed app). Rust rejects a description that changes nothing, so a
  // second tab describing at the same moment fails harmlessly. Resolves true
  // when it recorded a description.
  async describeThisDevice() {
    const identity = this.app.syncCoordinator?.identity;
    const autoName = householdDeviceName(currentPlatform());
    if (!identity || this.app.describingDevice || this.app.busy || !this.app.store || !this.app.engine ||
        this.app.describedDevice === `${identity.deviceId}:${autoName}`) return false;
    this.app.describingDevice = true;
    const session = this.ctx.session.captureSession();
    let described = false;
    try {
      const names = await session.store.deviceNames();
      this.ctx.session.assertCurrentSession(session);
      const current = names.find((device) => device.deviceId === identity.deviceId);
      if (current?.autoName !== autoName) {
        await this.ctx.append.appendCommand({ type: "describe-device", autoName });
        this.ctx.session.assertCurrentSession(session);
        this.ctx.peers.broadcastEventChange();
        described = true;
      }
      this.app.describedDevice = `${identity.deviceId}:${autoName}`;
    } catch {
      // Retried on the next successful sync; the name is a convenience.
    } finally {
      // Always released: a lock or reset mid-way must not stop later
      // sessions on this page from describing the device.
      this.app.describingDevice = false;
    }
    return described;
  }
  // The household's device names for People & devices, or [] while this
  // device does not sync (it has no shared names to show).
  async deviceNames() {
    const session = this.ctx.session.captureSession();
    if (!session.store || !this.app.syncCoordinator) return [];
    const names = await session.store.deviceNames();
    this.ctx.session.assertCurrentSession(session);
    return names;
  }
  // Members' preferred names (#224) for People & devices, or [] while this
  // device does not sync. Presentation only: never keys or permissions.
  async memberNames() {
    const session = this.ctx.session.captureSession();
    if (!session.store || !this.app.syncCoordinator) return [];
    const names = await session.store.memberNames();
    this.ctx.session.assertCurrentSession(session);
    return names;
  }
  // Sets or clears (empty) this member's own preferred name. The event
  // always names its author, so there is no target to choose (#224).
  async setMyName(name) {
    const session = this.ctx.session.captureSession();
    await this.ctx.append.appendCommand({ type: "name-member", name: name || "" });
    this.ctx.session.assertCurrentSession(session);
    this.ctx.peers.broadcastEventChange();
  }
  // Sets or clears (empty) the nickname of one of this member's devices.
  async renameDevice(deviceId, nickname) {
    const session = this.ctx.session.captureSession();
    await this.ctx.append.appendCommand({ type: "nickname-device", targetDeviceId: deviceId, nickname: nickname || null });
    this.ctx.session.assertCurrentSession(session);
    this.ctx.peers.broadcastEventChange();
  }
}
