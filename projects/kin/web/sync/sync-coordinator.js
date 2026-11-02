import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "./envelope-wire.js";
import { recordDiagnostic } from "../diagnostics/ring-buffer.js";
import {
  createHouseholdEpochKey,
  createProvisionedHouseholdEpoch,
  decryptWithDeviceHistory,
  verifiedDeviceKeyHistory,
  decryptIdentityBinding,
  deviceKeyFingerprint,
  encryptEvent,
  encryptIdentityBinding,
  importDevicePublicKeys,
  provisionSealedEpochKey,
  restoreHouseholdEpochKey,
  unwrapEpochKey,
  verifyDeviceAuthorizationCertificate,
} from "./crypto.js";
import { verifyMemberCertificate } from "../security/device-certification.js";
import { SyncKeyStore } from "./key-store.js";
import { submitRotation } from "./rotation-vault.js";
import { LIVE_TYPE, LiveChannel, liveUrl } from "./live-channel.js";
import { QUARANTINE_MESSAGE, quarantineMessage } from "../storage/quarantine.js";
import { idToHex } from "../wasm/kin-engine.js";
import { reconcileAttachments } from "../attachments/attachment-lifecycle.js";
import { reconcileAlbum } from "../album/album-blobs.js";
import { openAlbumStore } from "../album/album-session.js";
import { decryptHouseholdSettings, encryptHouseholdSettings } from "../appearance/household.js";
import { openBrowserChatRoom } from "../chat/chat-room.js";
import { openBrowserBoardRoom } from "../board/board-room.js";
import { openBrowserPrivateLog } from "../private/private-log.js";

export function activeResponsibilityMemberIds(devices, now = Date.now()) {
  return [...new Set(devices
    .filter((device) => !device.revokedAt && device.memberActive !== false &&
      (device.memberExpiresAt === undefined || device.memberExpiresAt > now))
    .map((device) => device.memberId))];
}

/** memberId -> member kind ("adult", "limited", "temporary") for the members
 * activeResponsibilityMemberIds lists, from their devices' directory rows. */
export function activeMemberKinds(devices, now = Date.now()) {
  const active = new Set(activeResponsibilityMemberIds(devices, now));
  const kinds = new Map();
  for (const device of devices)
    if (active.has(device.memberId) && !kinds.has(device.memberId)) kinds.set(device.memberId, device.memberKind ?? "adult");
  return kinds;
}

// Mirrors the server's requireTrustAuthority: only active Adults may rotate
// epochs or provision keys. The sync status reports the session's member kind.
export function memberHasTrustAuthority(status) {
  return status?.memberKind === "adult";
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Whether a pending rotation's key was wrapped for a device that is no longer
 * among `recipients` (matched by device ID and key fingerprint). Reusing that
 * key is only safe when the recipient set is unchanged or grows (#176).
 */
export function rotationRecipientDeparted(packages = [], recipients = []) {
  return packages.some((keyPackage) => !recipients.some((recipient) =>
    recipient.deviceId === keyPackage.recipientDeviceId &&
    recipient.fingerprint === keyPackage.recipientFingerprint));
}

// A normal empty poll still returns a projection and cursor boundary from the
// store. Publishing those as a change makes every open tab replay and repaint
// the same workspace. Only an accepted new event needs a projection broadcast.
export function committedBatchUpdate(committed) {
  const update = { added: committed.added ?? 0, quarantined: committed.quarantined ?? 0 };
  if (update.added > 0) {
    update.projection = committed.state;
    update.snapshotBoundary = committed.snapshotBoundary;
  }
  return update;
}

export async function loadCachedHouseholdSettings(identity, { keyStore = null } = {}) {
  if (![identity?.householdId, identity?.memberId, identity?.deviceId].every((value) => /^[a-f0-9]{32}$/.test(value ?? "")))
    throw new Error("Kin could not identify the local household settings cache.");
  const ownedStore = !keyStore;
  const store = keyStore ?? await SyncKeyStore.open();
  try {
    const device = await store.getDevice(identity.deviceId);
    if (!device || device.householdId !== identity.householdId || device.memberId !== identity.memberId)
      throw new Error("Kin could not match the local household settings cache to this device.");
    const cached = await store.getCachedHouseholdSettings(identity.householdId);
    if (!cached) return null;
    const epoch = await store.getEpoch(identity.householdId, cached.keyEpoch);
    if (!epoch) throw new Error("This device does not have the key needed to read the shared appearance.");
    return decryptHouseholdSettings(cached, { householdId: identity.householdId, householdKey: epoch.householdKey });
  } finally {
    if (ownedStore) store.close();
  }
}

/** This device member's cached layout (#343, ADR 0013): true when Simple
 * view was on at the last status poll, false otherwise or when unknown. */
export async function loadCachedSimpleView(identity, { keyStore = null } = {}) {
  if (![identity?.householdId, identity?.memberId, identity?.deviceId].every((value) => /^[a-f0-9]{32}$/.test(value ?? ""))) return false;
  const ownedStore = !keyStore;
  const store = keyStore ?? await SyncKeyStore.open();
  try {
    const device = await store.getDevice(identity.deviceId);
    if (!device || device.householdId !== identity.householdId || device.memberId !== identity.memberId) return false;
    return (await store.getCachedMemberView(identity.householdId, identity.memberId))?.simpleView === true;
  } finally {
    if (ownedStore) store.close();
  }
}

export function portableMembershipFromDirectory(entries) {
  if (!Array.isArray(entries) || entries.length > 12)
    throw new Error("Kin could not validate current household membership for export.");
  const members = new Map();
  for (const member of entries) {
    const kind = member.memberKind;
    if (!/^[a-f0-9]{32}$/.test(member.memberId ?? "") ||
        !["adult", "limited", "temporary"].includes(kind) ||
        typeof member.memberActive !== "boolean" ||
        !["active", "removed", "expired"].includes(member.memberStatus))
      throw new Error("Kin could not validate current household membership for export.");
    const expiresAt = member.memberExpiresAt;
    if ((kind === "temporary" && !Number.isSafeInteger(expiresAt)) ||
        (kind !== "temporary" && expiresAt !== undefined))
      throw new Error("Kin could not validate current household membership for export.");
    const status = member.memberStatus;
    const record = {
      memberId: member.memberId,
      memberKind: kind,
      status,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    const prior = members.get(record.memberId);
    if (prior && !sameMembershipRecord(prior, record))
      throw new Error("Kin found conflicting membership records during export.");
    members.set(record.memberId, record);
  }
  return [...members.values()].sort((left, right) =>
    left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0);
}

// Two portable membership records agree when every field does. Compared
// field by field: a JSON string comparison also depends on key order.
function sameMembershipRecord(left, right) {
  return left.memberId === right.memberId && left.memberKind === right.memberKind &&
    left.status === right.status && left.expiresAt === right.expiresAt;
}

const MAX_PUSH_BATCH = 20;
const MAX_PULL_PASSES = 5;
const CONTINUATION_DELAY_MS = 0;
const HIDDEN_CONTINUATION_DELAY_MS = 250;
const REQUEST_BUDGET = 200;
const REQUEST_WINDOW_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 5_000;
const CATCH_UP_CONTEXT_MAX_AGE_MS = 30_000;
const KEY_GRANT_TTL_MS = 10 * 60_000;
// How often to poll: while the live channel is up, hints bring new events at
// once and polling is only a safety net; otherwise every five seconds.
export const POLL_MS = 5_000;
export const LIVE_POLL_MS = 30_000;
// Hint-driven syncs run at most this often: a hint during a sync runs one
// more after it, no sooner than this after the last one started.
export const MIN_HINT_GAP_MS = 1_000;
// Requests a chat pass may make at most: status, 2 push batches of 20 blob
// uploads and a post each (42), blob retires (2), 5 pulls, the member list,
// and up to 6 for the hidden-messages record (two rounds of read, read and
// write). A pass waits when fewer remain: it schedules nothing itself, and
// the next hint or poll runs chat again.
const CHAT_PASS_REQUESTS = 60;
// And what a household pass needs, kept free for the next one.
const HOUSEHOLD_PASS_RESERVE = 30;
// Requests a fridge pass may make at most (#317): status, 3 push batches and
// 5 pulls.
const BOARD_PASS_REQUESTS = 10;
// Requests a private pass may make at most (#492): two vault reads and a
// write (a member-key rotation), status, 3 push batches and 5 pulls.
const PRIVATE_PASS_REQUESTS = 13;
// Sync errors that mean this session can't hold a live channel.
const ACCESS_ERRORS = new Set(["authentication_required", "device_not_trusted", "membership_removed"]);
// Errors a chat pass leaves to the household sync's own handling: the
// session or household is gone, so the whole pass must stop.
const CHAT_PASS_STOPS = new Set([...ACCESS_ERRORS, "household_deleted", "household_deletion_pending", "household_moved", "household_moving"]);

/** The live channel for a browser page, or null elsewhere (tests, workers). */
function browserLiveChannel(options) {
  if (typeof WebSocket === "undefined" || typeof location === "undefined" || !location.href) return null;
  return new LiveChannel({ url: liveUrl(location), ...options });
}

export class SyncCoordinator {
  constructor({ store, engine, identity, onState = () => {}, now = () => Date.now(), liveChannel = browserLiveChannel, chatRoom = openBrowserChatRoom, onChatRoom = () => {}, boardRoom = openBrowserBoardRoom, onBoardRoom = () => {}, onSimpleView = () => {}, onFeatures = () => {}, onChoreChart = () => {}, privateLog = openBrowserPrivateLog, onPrivateLog = () => {}, vaultKey = async () => null }) {
    this.store = store;
    this.engine = engine;
    this.identity = identity;
    this.onState = value => {
      if (this.stopped) return;
      try { this.keyStore?.vault.assertUnlocked(); } catch { return; }
      onState(value);
    };
    this.keyStore = null;
    this.deviceKeys = null;
    this.timer = null;
    this.continuationTimer = null;
    this.running = null;
    this.catchUp = null;
    this.requestTimes = [];
    this.now = now;
    this.stopped = false;
    this.terminal = false;
    this.abortController = new AbortController();
    this.createLiveChannel = liveChannel;
    this.live = null;
    this.pollMs = POLL_MS;
    this.liveUp = false;
    this.lastSyncOk = false;
    this.lastSyncStartedAt = -Infinity;
    this.lastSyncEndedAt = -Infinity;
    this.syncAgain = false;
    this.hintTimer = null;
    // The household chat room (#111), opened once this device's keys are
    // ready; chat syncs after each full household pass.
    this.openChatRoom = chatRoom;
    this.chat = null;
    this.chatOpening = null;
    this.chatOpenError = null;
    // Told the chat room once it opens, and null when it closes (the view).
    this.onChatRoom = onChatRoom;
    // The fridge (#317), opened like chat and synced after it.
    this.openBoardRoom = boardRoom;
    this.board = null;
    this.boardOpening = null;
    this.onBoardRoom = onBoardRoom;
    // The member's private log (#492, ADR 0019), opened like the fridge and
    // synced after it, active only once the member key is on this device.
    // `vaultKey()` gives the member key ring this device's vault key: the
    // integration point with #557 (web/private/member-key.js); until that is
    // wired it resolves null and the private pass does nothing.
    this.openPrivateLog = privateLog;
    this.privateLog = null;
    this.privateOpening = null;
    this.onPrivateLog = onPrivateLog;
    this.vaultKey = vaultKey;
    // Simple view (#343, ADR 0013): this member's layout as last reported.
    this.onSimpleView = onSimpleView;
    // Household features (ADR 0021): the switched-off set, from each status.
    this.onFeatures = onFeatures;
    this.onChoreChart = onChoreChart;
    this.simpleView = null;
  }

  async start() {
    if (!this.identity) return;
    if (this.stopped) return;
    const keyStore = this.keyStore ?? await SyncKeyStore.open();
    if (this.stopped) { keyStore.close(); return; }
    this.keyStore = keyStore;
    const deviceKeys = await keyStore.getDevice(this.identity.deviceId);
    if (this.stopped) return;
    this.deviceKeys = deviceKeys;
    if (!this.deviceKeys) {
      const pending = await this.keyStore.getOrCreatePendingDevice();
      await this.request("/api/sync/device-keys", {
        method: "POST",
        body: JSON.stringify({ publicKeys: pending.publicKeys }),
      });
      this.deviceKeys = await this.keyStore.bindPendingDevice({
        deviceId: this.identity.deviceId,
        householdId: this.identity.householdId,
        memberId: this.identity.memberId,
      });
    }
    if (this.stopped) return;
    // Chat opens alongside the first sync (not before it: decrypting a long
    // chat log mustn't hold up household sync), so messages kept on this
    // device show, and can be written, while offline.
    void this.openChat().catch(() => {});
    void this.openBoard().catch(() => {});
    void this.openPrivate().catch(() => {});
    await this.syncNow();
    if (this.stopped) return;
    if (!this.terminal) {
      this.timer = setInterval(() => void this.syncNow(), this.pollMs);
      this.startLive();
    }
  }

  /** Opens the live channel (#108): hints and reconnects sync at once, and
   * polling slows while it is up. HTTP sync stays the source of truth. */
  startLive() {
    if (this.live || this.stopped || this.terminal) return;
    this.live = this.createLiveChannel?.({
      lockName: `kin-live:${this.identity.deviceId}`,
      onHint: () => this.hinted(),
      // Typing frames and receipt changes go to the chat room (#120).
      onTyping: (bytes) => void this.chat?.receiveTyping(bytes),
      onPresence: (bytes) => void this.chat?.receivePresence(bytes),
      onReceipts: () => this.chat?.receiptsChanged(),
      onUp: () => {
        this.liveUp = true;
        this.chat?.liveUp();
        this.updatePollInterval();
        // Catch up on anything missed while disconnected (including events
        // accepted before the service registered this socket), and send
        // what the outbox kept meanwhile. hinted() keeps it cheap.
        this.hinted();
      },
      onDown: () => {
        this.liveUp = false;
        this.updatePollInterval();
      },
      // Access was lost: the next HTTP sync meets the same refusal and
      // reports the signed-out or deleted state. A later successful sync
      // starts a new channel.
      onEnd: () => {
        // Stop it properly, so its Web Lock and listeners are released and
        // a later channel (in this tab or another) can take the lock.
        this.stopLive();
        this.updatePollInterval();
        void this.syncNow();
      },
    }) ?? null;
    this.live?.start();
  }

  stopLive() {
    this.live?.stop();
    this.live = null;
    this.liveUp = false;
    clearTimeout(this.hintTimer);
    this.hintTimer = null;
  }

  /** A hint (or HELLO): sync now, or once more after the running sync,
   * never sooner than MIN_HINT_GAP_MS after the last one started. */
  hinted() {
    if (this.stopped || this.terminal) return;
    if (this.running) {
      this.syncAgain = true;
      return;
    }
    if (this.hintTimer !== null) return;
    const wait = this.lastSyncStartedAt + MIN_HINT_GAP_MS - this.now();
    if (wait <= 0) {
      void this.syncNow();
      return;
    }
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      void this.syncNow();
    }, wait);
  }

  /** Polling slows only while the channel is up and sync is healthy: a
   * paused sync, or one waiting on keys, keeps polling every 5 s. */
  updatePollInterval() {
    this.setPollInterval(this.liveUp && this.lastSyncOk ? LIVE_POLL_MS : POLL_MS);
  }

  setPollInterval(ms) {
    if (this.stopped || this.terminal || this.pollMs === ms) return;
    this.pollMs = ms;
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.syncNow(), ms);
  }

  async syncNow() {
    if (this.stopped || this.terminal || !this.identity) return;
    if (this.running) return this.running;
    this.lastSyncStartedAt = this.now();
    this.syncAgain = false;
    this.running = this.runOnce()
      .then((result) => {
        const hasMore = typeof result === "object" ? result.hasMore : result;
        const advanced = typeof result === "object" ? result.advanced : hasMore;
        // Healthy only if the pass finished without pausing: a pass that
        // made no progress, found sync off, or was cut short isn't.
        this.lastSyncOk = result !== undefined && result !== null && !result.disabled && !(hasMore && !advanced);
        // A channel that ended on lost access comes back once this session
        // syncs again (a new session after signing in elsewhere, say).
        if (this.lastSyncOk && !this.live && !this.terminal) this.startLive();
        if (hasMore && advanced) this.scheduleContinuation();
        else if (!hasMore && result?.chatMore) this.scheduleContinuation();
        else if (hasMore) {
          this.catchUp = null;
          this.onState({
            state: "paused",
            code: "sync_no_progress",
            message: "Household sync paused because the relay made no progress. Kin will try again on the next normal sync check.",
          });
        }
      })
      .catch(async (error) => {
        if (this.stopped) return;
        this.lastSyncOk = false;
        // Codes and an HTTP status only (#631).
        recordDiagnostic("sync_failed", { reason: error.code ?? (error.name === "TimeoutError" ? "timeout" : undefined), status: error.status, epoch: error.keyEpoch });
        // Chat syncs after a full household pass, so a failed pass pauses
        // chat too: tell the chat room why (offline, say).
        if (!["sync_rate_limited", "sync_client_rate_budget"].includes(error.code)) this.chat?.reportSync(error);
        let message = error.message || "Device sync is paused.";
        let code = error.code;
        // This session can't hold a socket either: stop reconnecting (an
        // upgrade refused with 401/403 reaches the browser only as 1006).
        if (ACCESS_ERRORS.has(code)) this.stopLive();
        if (["sync_rate_limited", "sync_client_rate_budget"].includes(code)) {
          clearTimeout(this.continuationTimer);
          this.continuationTimer = null;
          this.onState({ state: "syncing", code, message: "Catching up…" });
          this.scheduleContinuation(error.retryAfterMs ?? RATE_LIMIT_RETRY_MS);
          return;
        }
        clearTimeout(this.continuationTimer);
        this.continuationTimer = null;
        this.catchUp = null;
        if (code === "connection_unavailable") {
          message = navigator.onLine === false
            ? "Offline — saved changes stay on this device. Kin will try to sync when a connection is available."
            : "Kin cannot reach household sync right now. Saved information remains on this device.";
        }
        let lifecycle = null;
        // Moved to a home server (ADR 0026, #737): for good, like a
        // deletion; the household panel says where. While it is moving,
        // sync just waits (it pauses below and tries again).
        if (error.code === "household_moved") {
          lifecycle = { state: "moved", message };
        } else if (error.code === "household_moving") {
          message = "Your household is moving to its home server. Changes are saved here and wait until it's done.";
        } else if (
          ["household_deleted", "household_deletion_pending"].includes(
            error.code,
          )
        ) {
          lifecycle = {
            state:
              error.code === "household_deleted"
                ? "deleted"
                : "deletion_pending",
            message,
          };
        } else if (
          [
            "authentication_required",
            "device_not_trusted",
            "membership_removed",
          ].includes(error.code)
        ) {
          try {
            lifecycle = await api(
              `/api/household/lifecycle?householdId=${encodeURIComponent(this.identity.householdId)}`,
              { signal: this.abortController.signal },
            );
          } catch (lifecycleError) {
            message = `${message} Kin could not confirm the household lifecycle: ${lifecycleError.message}`;
          }
        }
        if (
          lifecycle?.state === "deleted" ||
          lifecycle?.state === "deletion_pending" ||
          lifecycle?.state === "moved"
        ) {
          this.terminal = true;
          this.catchUp = null;
          clearTimeout(this.continuationTimer);
          this.continuationTimer = null;
          clearInterval(this.timer);
          this.timer = null;
          this.stopLive();
          this.onState({
            state: "deleted",
            lifecycleState: lifecycle.state,
            message: lifecycle.message,
          });
          return;
        }
        this.onState({
          state: "paused",
          code,
          message,
        });
      })
      .finally(() => {
        this.running = null;
        this.lastSyncEndedAt = this.now();
        if (this.lastSyncEndedAt - this.lastSyncStartedAt > 10_000) recordDiagnostic("sync_slow", { ms: this.lastSyncEndedAt - this.lastSyncStartedAt });
        this.updatePollInterval();
        if (this.syncAgain) {
          this.syncAgain = false;
          this.hinted();
        }
      });
    return this.running;
  }

  scheduleContinuation(minimumDelay = CONTINUATION_DELAY_MS) {
    if (this.stopped || this.terminal || this.continuationTimer !== null) return;
    const budgetDelay = this.requestBudgetDelay(MAX_PULL_PASSES);
    const hiddenDelay = typeof document !== "undefined" && document.hidden
      ? HIDDEN_CONTINUATION_DELAY_MS
      : CONTINUATION_DELAY_MS;
    const delay = Math.max(minimumDelay, budgetDelay, hiddenDelay);
    // Yield between bounded pull groups so rendering, input and stop requests
    // are serviced while a newly paired device catches up on relay history.
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = null;
      void this.syncNow();
    }, delay);
  }

  async runOnce() {
    this.keyStore.vault.assertUnlocked();
    if (this.catchUp && this.now() - this.catchUp.startedAt > CATCH_UP_CONTEXT_MAX_AGE_MS)
      this.catchUp = null;
    if (this.catchUp) return this.pullCatchUpPages(this.catchUp);
    if (this.deviceKeys.pendingTransition) {
      const device = await this.keyStore.completePendingTransition(this.identity.deviceId, { signal: this.abortController.signal });
      if (this.stopped) return;
      this.deviceKeys = device;
    }
    if (this.stopped) return;
    let status = await this.request("/api/sync/status");
    await this.noteSimpleView(status);
    this.noteFeatures(status);
    if (!status.enabled) {
      this.onState({ state: "disabled", message: "Device sync is off." });
      return { disabled: true, hasMore: false };
    }
    await this.store.requeueAfterRelayReset(status.latestCursor);
    await this.store.updateSyncServerState(status);
    this.onState({ state: "syncing", message: "Syncing this device…" });
    let devices = await this.loadDeviceDirectory();
    await this.receiveProvisioning(devices, status);
    status = await this.request("/api/sync/status");
    await this.store.updateSyncServerState(status);

    const storedSyncState = await this.store.getSyncState();
    const localRotation = storedSyncState?.pendingRotation;
    if (localRotation && status.currentEpoch >= localRotation.epoch)
      await this.reconcilePendingRotation(localRotation, status);

    let currentKey = await this.keyStore.getEpoch(
      this.identity.householdId,
      status.currentEpoch,
    );
    const ownDevice = devices.find(
      (device) => device.deviceId === this.identity.deviceId,
    );
    if (
      !currentKey &&
      status.currentEpoch === 1 &&
      status.eventCount === 0 &&
      (ownDevice?.historyFromEpoch ?? 1) <= status.currentEpoch
    ) {
      const initial = await createHouseholdEpochKey({
        householdId: this.identity.householdId,
        keyEpoch: 1,
        deviceKeys: this.deviceKeys.keys,
      });
      currentKey = await this.keyStore.saveEpoch({
        householdId: this.identity.householdId,
        keyEpoch: 1,
        ...initial,
      });
    }
    if (
      !currentKey &&
      ownDevice?.historyFromEpoch > status.currentEpoch &&
      status.rotationPending
    ) {
      throw new Error(
        "An existing trusted device needs to finish setting up household sync first.",
      );
    }
    if (!currentKey) throw householdKeyMissing("household_key_missing", status.currentEpoch);
    // Set up this device's sync state before any key rotation: a pending
    // rotation is saved inside that state, and a device whose first sync
    // finds one (someone was removed or a device revoked before it finished
    // joining) would otherwise fail with "Kin has not initialized encrypted
    // sync." and stay stuck, since the relay pauses pushes until the rotation
    // commits. History queued now waits for the new epoch (initializeSync),
    // and pushIdentityBindings re-seals a binding made under an older one.
    const remoteBindings = await this.prepareSyncState(status, devices, currentKey);
    // Only Adults may rotate epochs or provision keys (server 403 otherwise).
    // A Limited or Temporary device must still pull and push with the keys it
    // was granted instead of pausing on an authority it never had.
    const trustAuthority = memberHasTrustAuthority(status);
    if (status.rotationPending && trustAuthority) {
      await this.commitRotation();
      status = await this.request("/api/sync/status");
      await this.store.updateSyncServerState(status);
      devices = await this.loadDeviceDirectory();
      // Another device may have committed a newer epoch meanwhile.
      if (!(await this.keyStore.getEpoch(this.identity.householdId, status.currentEpoch)))
        throw householdKeyMissing("household_key_missing_after_rotation", status.currentEpoch);
    }

    if (trustAuthority) await this.provisionMemberHistory(status.currentEpoch, devices);
    await this.pushIdentityBindings(status);
    this.catchUp = { status, devices, remoteBindings, startedAt: this.now() };
    return this.pullCatchUpPages(this.catchUp);
  }

  async pullCatchUpPages(context) {
    const { status, devices, remoteBindings } = context;
    let passes = 0;
    let quarantinedEvents = 0;
    let hasMore = true;
    let lastPageAdvanced = false;
    let added = 0;
    let latestCommitted = null;
    while (hasMore && passes < MAX_PULL_PASSES) {
      const syncStateBefore = await this.store.getSyncState();
      const page = decodeEventPage(await this.request(
        `/api/sync/events?cursor=${encodeURIComponent(syncStateBefore.syncCursor)}&limit=${MAX_PUSH_BATCH}`,
        { binary: true },
      ));
      const verified = [];
      for (const item of page.events) {
        const envelope = item.envelope;
        const signer = devices.find(
          (device) => device.deviceId === envelope.deviceId,
        );
        if (!signer?.publicKeys)
          throw new Error(
            "A synchronized event came from an unknown trusted device.",
          );
        if (signer.revokedAt && envelope.keyEpoch >= status.currentEpoch)
          throw new Error(
            "A revoked device cannot author events in the current key epoch.",
          );
        if (envelope.keyEpoch < signer.historyFromEpoch)
          throw new Error(
            "This device is not authorized to receive that event history.",
          );
        const epoch = await this.keyStore.getEpoch(
          this.identity.householdId,
          envelope.keyEpoch,
        );
        if (!epoch)
          throw new Error(
            `This device is missing key epoch ${envelope.keyEpoch}; sync is paused.`,
          );
        const encodedEvent = await decryptWithDeviceHistory({
          device: signer,
          envelope,
          householdKey: epoch.householdKey,
        });
        validateCanonicalIdentity({
          encodedEvent,
          envelope,
          signer,
          householdId: this.identity.householdId,
          bindings: remoteBindings.map((record) => record.binding),
          engine: this.engine,
        });
        verified.push({
          encodedEvent,
          sourceDeviceId: envelope.deviceId,
          sourceDeviceSequence: envelope.deviceSequence,
        });
      }
      const committed = await this.store.commitRemoteBatch({
        received: verified,
        nextCursor: page.nextCursor,
        engine: this.engine,
      });
      const syncStateAfter = await this.store.getSyncState();
      lastPageAdvanced = syncStateAfter.syncCursor !== syncStateBefore.syncCursor;
      added += committed.added ?? 0;
      quarantinedEvents += committed.quarantined ?? 0;
      if ((committed.added ?? 0) > 0) latestCommitted = committed;
      hasMore = page.hasMore;
      passes += 1;
      if (hasMore && !lastPageAdvanced) break;
    }

    const update = { added, quarantined: quarantinedEvents };
    if (latestCommitted) {
      update.projection = latestCommitted.state;
      update.snapshotBoundary = latestCommitted.snapshotBoundary;
    }
    let attachmentRows;
    let chatMore = false;
    if (!hasMore) {
      await this.acknowledgeRemoteDuplicateEvents(status.currentEpoch);
      if (!(await this.store.getSyncState())?.initialized)
        await this.store.compactArchiveOutboxSequences();
      await this.pushPendingEvents();
      const pendingOutbox = await this.store.getPendingOutbox(1);
      const pendingBindings = await this.store.getPendingBindings();
      try {
        const attachmentResult = await reconcileAttachments({ identity: this.identity, store: this.store, keyStore: this.keyStore, state: await this.store.projectCurrent(), signal: this.abortController.signal, suspectedOrphans: (this.suspectedOrphans ??= new Set()) });
        attachmentRows = attachmentResult.rows;
      } catch { /* Attachment transport retries independently; household event sync remains available. */ }
      // The family album's photos (#673): uploaded, re-encrypted, and
      // deleted once no photo needs them (album-blobs.js).
      try { await this.syncAlbum(); } catch { /* retried on the next pass */ }
      if (pendingOutbox.length === 0 && pendingBindings.length === 0)
        await this.store.markSyncInitialized();
      this.catchUp = null;
      chatMore = (await this.syncChat(context)).hasMore;
      chatMore = (await this.syncBoard(context)).hasMore || chatMore;
      chatMore = (await this.syncPrivate(context)).hasMore || chatMore;
    } else if (!lastPageAdvanced) {
      this.catchUp = null;
    }
    // Kept events stay listed in the persistent notice until they apply, so
    // an Adult reviewing this device can see which changes and why.
    const kept = (await this.store.getSyncState().catch(() => null))?.quarantine ?? [];
    this.onState({
      state: hasMore ? "syncing" : "ready",
      quarantineNotice: kept.length ? quarantineMessage(kept) : null,
      memberIds: activeResponsibilityMemberIds(devices),
      // The chore chart (#676) needs to know who are children and Adults.
      memberKinds: activeMemberKinds(devices),
      ...(attachmentRows === undefined ? {} : { attachmentRows }),
      ...update,
      message: quarantinedEvents
        ? (kept.length ? quarantineMessage(kept) : QUARANTINE_MESSAGE)
        : hasMore
        ? lastPageAdvanced
          ? "Catching up…"
          : "Household sync paused because the relay made no progress. Kin will try again on the next normal sync check."
        : "Device sync is up to date.",
    });
    return { hasMore, advanced: !hasMore || lastPageAdvanced, chatMore };
  }

  /** Opens the chat room once (#111); null where chat storage isn't
   * available. A failure leaves it closed for the next pass to retry. */
  async openChat() {
    if (this.chat || !this.openChatRoom || this.stopped) return this.chat;
    this.chatOpening ??= Promise.resolve().then(() => this.openChatRoom({
      identity: this.identity,
      keyStore: this.keyStore,
      deviceKeys: this.deviceKeys,
      engine: this.engine,
      request: (path, options) => this.request(path, options),
      blobFetch: (path, init) => this.blobFetch(path, init),
      // A message sent here goes out at once, like a hint.
      onLocalChange: () => this.hinted(),
    })).then((room) => {
      if (this.stopped) { room?.close(); return null; }
      if (!room) this.openChatRoom = null;
      this.chat = room;
      this.chatOpenError = null;
      // Typing frames go out on the live channel when this tab holds it.
      room?.setLiveSender((bytes, kind) => this.live?.send(kind === "presence" ? LIVE_TYPE.PRESENCE : LIVE_TYPE.TYPING, bytes) ?? false);
      if (room) {
        try { this.onChatRoom(room); } catch { /* the view's trouble isn't sync's */ }
      }
      return room;
    }, (error) => {
      // Kept for the chat view to explain (a missing key epoch, say); the
      // next pass tries again.
      this.chatOpenError = error;
      throw error;
    }).finally(() => { this.chatOpening = null; });
    return this.chatOpening;
  }

  /** Chat blob requests (#110), held to the same rules as request(): only
   * while unlocked and running, within the request budget, and aborted when
   * sync stops. */
  async blobFetch(path, init = {}) {
    if (this.stopped) throw new Error("Device sync was stopped.");
    const budgetDelay = this.requestBudgetDelay();
    if (budgetDelay > 0) {
      const error = new Error("Catching up after a short wait.");
      error.code = "sync_client_rate_budget";
      error.retryAfterMs = budgetDelay;
      throw error;
    }
    this.keyStore?.vault.assertUnlocked();
    await this.keyStore?.vault.checkSecurityEpoch?.();
    this.recordRequest();
    const response = await fetch(path, { ...init, signal: this.abortController.signal });
    if (this.stopped) throw new Error("Device sync was stopped.");
    await this.keyStore?.vault.checkSecurityEpoch?.();
    if (this.stopped) throw new Error("Device sync was stopped.");
    this.keyStore?.vault.assertUnlocked();
    return response;
  }

  /** One chat pass after a full household pass. Chat trouble pauses chat,
   * not household sync: it is reported to the chat room instead, unless
   * the session or household itself is gone. */
  async syncChat({ status, devices }) {
    let room = null;
    try {
      room = await this.openChat();
      if (!room || this.stopped) return { hasMore: false };
      // Household sync comes first: when the request budget runs low, chat
      // waits for a later pass rather than leave the next household pass
      // short of requests.
      if (this.requestBudgetDelay(CHAT_PASS_REQUESTS + HOUSEHOLD_PASS_RESERVE) > 0) return { hasMore: false };
      const result = await room.sync({ status, devices, deviceKeys: this.deviceKeys });
      room.reportSync(null);
      return result;
    } catch (error) {
      if (CHAT_PASS_STOPS.has(error.code)) throw error;
      recordDiagnostic("sync_room_failed", { room: "chat", reason: error.code, status: error.status });
      room?.reportSync(error);
      return { hasMore: false };
    }
  }

  /** Keeps this member's layout (ADR 0013): cached for an offline unlock,
   * and handed to the app when it changes. The cache is best effort: a
   * failure leaves the last cached layout for the next unlock. */
  async noteSimpleView(status) {
    const on = status?.simpleView === true;
    if (this.simpleView === on) return;
    this.simpleView = on;
    let cached = true;
    try {
      await this.keyStore.cacheMemberView({ householdId: this.identity.householdId, memberId: this.identity.memberId, simpleView: on });
    } catch { /* the next pass tries again */ this.simpleView = null; cached = false; }
    if (this.stopped) return;
    try { this.onSimpleView(on, { cached }); } catch { /* the view's trouble isn't sync's */ }
  }

  /** Hands the household's switched-off features (ADR 0021) to the app,
   * which keeps them on the device and ignores a repeat. */
  noteFeatures(status) {
    if (!status?.features || this.stopped) return;
    try { this.onFeatures?.(status.features); } catch { /* the view's trouble isn't sync's */ }
    // Whether adults may join the chore chart (#676) comes with them.
    if (status.choreChart) try { this.onChoreChart?.(status.choreChart); } catch { /* likewise */ }
  }

  /** Opens the fridge once (#317); null where its storage isn't available.
   * A failure leaves it closed for the next pass to retry. */
  async openBoard() {
    if (this.board || !this.openBoardRoom || this.stopped) return this.board;
    this.boardOpening ??= Promise.resolve().then(() => this.openBoardRoom({
      identity: this.identity,
      keyStore: this.keyStore,
      deviceKeys: this.deviceKeys,
      engine: this.engine,
      request: (path, options) => this.request(path, options),
      // A change made here goes out at once, like a hint.
      onLocalChange: () => this.hinted(),
    })).then((room) => {
      if (this.stopped) { room?.close(); return null; }
      if (!room) this.openBoardRoom = null;
      this.board = room;
      if (room) {
        try { this.onBoardRoom(room); } catch { /* the view's trouble isn't sync's */ }
      }
      return room;
    }).finally(() => { this.boardOpening = null; });
    return this.boardOpening;
  }

  /** One fridge pass after the chat pass. Its trouble pauses the fridge,
   * not household sync, unless the session or household itself is gone. */
  async syncBoard({ status, devices }) {
    let room = null;
    try {
      room = await this.openBoard();
      if (!room || this.stopped) return { hasMore: false };
      if (this.requestBudgetDelay(BOARD_PASS_REQUESTS + HOUSEHOLD_PASS_RESERVE) > 0) return { hasMore: false };
      const result = await room.sync({ status, devices, deviceKeys: this.deviceKeys });
      room.reportSync(null);
      return result;
    } catch (error) {
      if (CHAT_PASS_STOPS.has(error.code)) throw error;
      recordDiagnostic("sync_room_failed", { room: "board", reason: error.code, status: error.status });
      room?.reportSync(error);
      return { hasMore: false };
    }
  }

  /** Opens the member's private log once (#492); null where its storage
   * isn't available. A failure leaves it closed for the next pass to retry. */
  async openPrivate() {
    if (this.privateLog || !this.openPrivateLog || this.stopped) return this.privateLog;
    // Without a vault key on this device there is no member key to get:
    // nothing is opened or created (a later pass looks again).
    if (!this.privateOpening) {
      const probe = await this.vaultKey();
      if (!probe) return null;
      probe.fill(0);
      if (this.privateLog || this.stopped) return this.privateLog;
    }
    this.privateOpening ??= Promise.resolve().then(() => this.openPrivateLog({
      identity: this.identity,
      deviceKeys: this.deviceKeys,
      engine: this.engine,
      request: (path, options) => this.request(path, options),
      vaultKey: () => this.vaultKey(),
      onLocalChange: () => this.hinted(),
    })).then((log) => {
      if (this.stopped) { log?.close(); return null; }
      if (!log) this.openPrivateLog = null;
      this.privateLog = log;
      if (log) {
        try { this.onPrivateLog(log); } catch { /* the view's trouble isn't sync's */ }
      }
      return log;
    }).finally(() => { this.privateOpening = null; });
    return this.privateOpening;
  }

  /** One private pass after the fridge pass. It does nothing until the
   * member key is on this device. Its trouble pauses private storage, not
   * household sync, unless the session or household itself is gone. */
  async syncPrivate({ status, devices }) {
    let log = null;
    try {
      log = await this.openPrivate();
      if (!log || this.stopped) return { hasMore: false };
      if (this.requestBudgetDelay(PRIVATE_PASS_REQUESTS + HOUSEHOLD_PASS_RESERVE) > 0) return { hasMore: false };
      const result = await log.sync({ status, devices, deviceKeys: this.deviceKeys });
      log.reportSync(null);
      return result;
    } catch (error) {
      if (CHAT_PASS_STOPS.has(error.code)) throw error;
      recordDiagnostic("sync_room_failed", { room: "private", reason: error.code, status: error.status });
      log?.reportSync(error);
      return { hasMore: false };
    }
  }

  async loadDeviceDirectory() {
    const { devices } = await this.request("/api/sync/devices");
    const byId = new Map(devices.map((device) => [device.deviceId, device]));
    const verified = new Set();
    const checking = new Set();
    const verify = async (deviceId) => {
      if (verified.has(deviceId)) return;
      if (checking.has(deviceId))
        throw new Error(
          "Kin found a cycle in the trusted-device approval chain.",
        );
      const device = byId.get(deviceId);
      if (!device?.publicKeys || !device.fingerprint)
        throw new Error(
          "A trusted device must register its sync key before synchronization.",
        );
      if (device.householdId !== this.identity.householdId)
        throw new Error(
          "A trusted-device directory entry belongs to another household.",
        );
      if (
        (await deviceKeyFingerprint(device.publicKeys)) !== device.fingerprint
      )
        throw new Error(
          "A trusted device key does not match its approved fingerprint.",
        );
      const keyHistory = await verifiedDeviceKeyHistory(device);
      device.verifiedKeyHistory = keyHistory;
      if (deviceId === this.identity.deviceId) {
        if (
          device.memberId !== this.identity.memberId ||
          device.fingerprint !== this.deviceKeys.fingerprint
        )
          throw new Error(
            "This browser's local sync key does not match its trusted-device record.",
          );
        verified.add(deviceId);
        return;
      }
      const pin = await this.keyStore.getPinnedDevice(
        this.identity.householdId,
        deviceId,
      );
      if (pin) {
        if (
          pin.memberId !== device.memberId ||
          !keyHistory.some(entry => entry.fingerprint === pin.fingerprint)
        )
          throw new Error(
            "A trusted device key changed after it was approved.",
          );
        if (pin.fingerprint !== device.fingerprint)
          await this.keyStore.advanceTrustedDevice({ ...pin, publicKeys: device.publicKeys, fingerprint: device.fingerprint }, pin.fingerprint);
        verified.add(deviceId);
        return;
      }
      const certificate = device.certificate;
      if (certificate?.version === 2) {
        // Signed by the member's certification key (ADR 0018, #568): valid
        // when the device that endorsed that key is the same member's and
        // verifies here, and the key matches the one pinned for the member.
        const endorser = byId.get(certificate.endorsement?.issuerDeviceId);
        if (!endorser || endorser.memberId !== device.memberId)
          throw new Error("A device certified by its member's account has no verifiable endorsement.");
        checking.add(deviceId);
        await verify(endorser.deviceId);
        const endorserKey = endorser.verifiedKeyHistory.find(entry => entry.fingerprint === certificate.endorsement.issuerFingerprint);
        if (!endorserKey) throw new Error("The certification key's endorsing device key is not in its verified history.");
        const certificationFingerprint = await verifyMemberCertificate({
          certificate,
          device: { ...device, ...keyHistory[0] },
          issuerPublicKeys: endorserKey.publicKeys,
          issuerMemberId: endorser.memberId,
        });
        const pinned = await this.keyStore.getPinnedCertificationKey(this.identity.householdId, device.memberId);
        if (pinned && pinned.fingerprint !== certificationFingerprint)
          throw new Error("A member's certification key changed after it was trusted.");
        if (!pinned) await this.keyStore.pinCertificationKey({ householdId: this.identity.householdId, memberId: device.memberId, fingerprint: certificationFingerprint });
        checking.delete(deviceId);
        verified.add(deviceId);
        return;
      }
      const issuer = byId.get(certificate?.issuerDeviceId);
      if (!certificate || !issuer)
        throw new Error(
          "A trusted device has no verifiable approval certificate.",
        );
      checking.add(deviceId);
      await verify(issuer.deviceId);
      const issuerKey = issuer.verifiedKeyHistory.find(entry => entry.fingerprint === certificate.issuerFingerprint);
      if (!issuerKey) throw new Error("The device approval issuer key is not in its verified history.");
      await verifyDeviceAuthorizationCertificate({
        certificate,
        issuerPublicKeys: issuerKey.publicKeys,
        issuerDeviceId: issuer.deviceId,
        device: { ...device, ...keyHistory[0] },
      });
      checking.delete(deviceId);
      verified.add(deviceId);
    };
    for (const device of devices)
      if (device.publicKeys || device.deviceId === this.identity.deviceId)
        await verify(device.deviceId);
    return devices;
  }

  async portableMembershipSnapshot() {
    const { members } = await this.request("/api/sync/devices");
    return portableMembershipFromDirectory(members);
  }

  async receiveProvisioning(devices, status) {
    while (true) {
      const { grants } = await this.request("/api/sync/provisioning");
      if (grants.length === 0) return;
      for (const grant of grants) {
        // The relay's outer fields (keyEpoch, senderDeviceId, grantId,
        // committedRotation) are not signed. Only the package is, so every
        // outer field must agree with it, and the epoch Kin saves under is
        // always the signed one. A mismatch is refused, never acknowledged.
        const keyPackage = grant.package;
        if (
          keyPackage?.keyEpoch !== grant.keyEpoch ||
          keyPackage?.householdId !== this.identity.householdId ||
          keyPackage?.senderDeviceId !== grant.senderDeviceId ||
          keyPackage?.recipientDeviceId !== this.identity.deviceId ||
          keyPackage?.grantId !== grant.grantId
        )
          throw provisioningRefused();
        const sender = devices.find(
          (device) => device.deviceId === grant.senderDeviceId,
        );
        if (!sender?.publicKeys)
          throw new Error(
            "A key transfer came from an unknown trusted device.",
          );
        // An expired package is accepted only for an epoch the household has
        // already committed: at or below the current epoch. A newer epoch
        // must arrive unexpired. Adult-signed rotation records (S5) are the
        // long-term evidence; see docs/THREAT-MODEL.md.
        const allowExpired =
          grant.committedRotation === true &&
          Number.isSafeInteger(status?.currentEpoch) &&
          Number.isSafeInteger(keyPackage.keyEpoch) &&
          keyPackage.keyEpoch <= status.currentEpoch;
        let received;
        for (const entry of [...sender.verifiedKeyHistory].reverse()) {
          const signer = await importDevicePublicKeys(entry.publicKeys);
          try {
            received = await unwrapEpochKey({ package: keyPackage, deviceKeys: this.deviceKeys.keys,
              householdId: this.identity.householdId, deviceId: this.identity.deviceId,
              allowExpiredCommittedRotation: allowExpired,
              deviceFingerprint: this.deviceKeys.fingerprint, senderSigningKey: signer.signing });
            break;
          } catch (error) { if (error.code !== "provisioning_signature_invalid") throw error; }
        }
        if (!received) throw new Error("A household key transfer has no valid historical signer.");
        await this.keyStore.saveEpoch({
          householdId: this.identity.householdId,
          keyEpoch: keyPackage.keyEpoch,
          ...received,
        });
        await this.request(`/api/sync/provisioning/${grant.grantId}/ack`, {
          method: "POST",
          body: "{}",
        });
      }
    }
  }

  // Every tab runs its own coordinator. Rotation acts on a relay status
  // snapshot, so it runs in one tab at a time (#176): otherwise one tab could
  // discard a proposal another tab's submission has just committed.
  async commitRotation() {
    const locks = globalThis.navigator?.locks;
    // A tab that finds the lock held skips this pass: the holder finishes the
    // rotation, and this tab keeps syncing instead of waiting on it.
    if (typeof locks?.request === "function")
      return locks.request("kin-key-rotation", { ifAvailable: true },
        (lock) => lock ? this.commitRotationExclusive() : undefined);
    return this.commitRotationExclusive();
  }

  async commitRotationExclusive() {
    // A previous submission may have committed even when its response was lost.
    // Reconcile before changing its packages, keeping the proposal's exact key.
    const status = await this.request("/api/sync/status");
    let pending = (await this.store.getSyncState())?.pendingRotation;
    if (pending && await this.reconcilePendingRotation(pending, status)) return;
    if (!status.rotationPending) return;
    const expectedEpoch = status.currentEpoch;
    const epoch = expectedEpoch + 1;
    const devices = await this.loadDeviceDirectory();
    const recipients = devices.filter((device) =>
      device.deviceId !== this.identity.deviceId && !device.revokedAt && device.publicKeys);
    // #176: the pending key has been wrapped for every earlier recipient. If
    // one of them is no longer a recipient (revoked, or re-keyed), a relay that
    // kept that package could hand it the new epoch's key, so the key is
    // discarded for a fresh one, but only once fresh relay status confirms
    // the pending proposal did not commit (the relay is still at its expected
    // epoch), so no device can already depend on the discarded key.
    if (pending && rotationRecipientDeparted(pending.packages, recipients)) {
      const latest = await this.request("/api/sync/status");
      if (await this.reconcilePendingRotation(pending, latest)) return;
      if (!latest.rotationPending || latest.currentEpoch !== expectedEpoch) return;
      await this.store.clearPendingRotation(pending.proposalId);
      pending = null;
    }
    if (!pending) {
      const currentKey = await this.keyStore.getEpoch(
        this.identity.householdId,
        expectedEpoch,
      );
      if (!currentKey)
        throw new Error(
          "The current household key is unavailable for rotation.",
        );
      const rotation = await createProvisionedHouseholdEpoch({
        householdId: this.identity.householdId,
        keyEpoch: epoch,
        deviceKeys: this.deviceKeys.keys,
        senderDeviceId: this.identity.deviceId,
        recipients,
        expiresAt: Date.now() + KEY_GRANT_TTL_MS,
      });
      pending = await this.store.savePendingRotation({
        expectedEpoch,
        epoch,
        proposalId: randomIdHex(),
        sealed: rotation.sealed,
        fingerprint: rotation.fingerprint,
        packages: rotation.packages,
        issuerFingerprint: this.deviceKeys.fingerprint,
      });
    } else if (pending.issuerFingerprint !== this.deviceKeys.fingerprint ||
        pending.packages.length !== recipients.length ||
        recipients.some((recipient) => !pending.packages.some((keyPackage) =>
          keyPackage.recipientDeviceId === recipient.deviceId &&
          keyPackage.recipientFingerprint === recipient.fingerprint &&
          keyPackage.expiresAt > Date.now()))) {
      const expiresAt = Date.now() + KEY_GRANT_TTL_MS;
      const packages = await Promise.all(recipients.map((recipient) =>
        provisionSealedEpochKey({
          sealed: pending.sealed, deviceKeys: this.deviceKeys.keys,
          grant: {
            householdId: this.identity.householdId, keyEpoch: pending.epoch,
            senderDeviceId: this.identity.deviceId,
            recipientDeviceId: recipient.deviceId,
            recipientPublicKeys: recipient.publicKeys,
            recipientFingerprint: recipient.fingerprint,
            grantId: randomIdHex(), expiresAt,
            signingKey: this.deviceKeys.keys.signingPrivateKey,
          },
        })));
      pending = await this.store.replacePendingRotationPackages({
        expected: pending, packages, issuerFingerprint: this.deviceKeys.fingerprint,
      });
    }
    const result = await this.submitRotation(pending);
    if (result.currentEpoch !== pending.epoch || result.proposalId !== pending.proposalId)
      throw new Error("Kin could not match the accepted key rotation.");
    await this.acceptPendingRotation(pending);
    await this.provisionMemberHistory(
      result.currentEpoch,
      await this.loadDeviceDirectory(),
    );
  }

  async reconcilePendingRotation(pending, status) {
    if (status.currentEpoch === pending.expectedEpoch) return false;
    if (status.currentEpoch === pending.epoch && status.lastRotationProposalId === pending.proposalId) {
      await this.acceptPendingRotation(pending);
      return true;
    }
    if (status.currentEpoch < pending.epoch ||
        !await this.keyStore.getEpoch(this.identity.householdId, status.currentEpoch))
      throw new Error("Another trusted device completed key rotation. This device needs its approved key transfer.");
    await this.store.clearPendingRotation(pending.proposalId);
    return true;
  }

  async acceptPendingRotation(pending) {
    const householdKey = await restoreHouseholdEpochKey({
      sealed: pending.sealed,
      deviceKeys: this.deviceKeys.keys,
    });
    await this.keyStore.saveEpoch({
      householdId: this.identity.householdId,
      keyEpoch: pending.epoch,
      householdKey,
      sealed: pending.sealed,
      fingerprint: pending.fingerprint,
    });
    await this.store.commitPendingRotation({
      expectedEpoch: pending.expectedEpoch,
      currentEpoch: pending.epoch,
      proposalId: pending.proposalId,
    });
  }

  // Commits the pending proposal with this member's vault change in the
  // same request when this device holds the vault key (#791), so the new
  // key is never only on this device; rotation-vault.js has the fallbacks.
  submitRotation(pending) {
    return submitRotation({
      request: (path, options) => this.request(path, options),
      // A coordinator built without the option holds no vault key.
      vaultKey: async () => (await this.vaultKey?.()) ?? null,
      identity: this.identity,
      pending,
      deviceKeys: this.deviceKeys.keys,
    });
  }

  // Creates this device's sync state on its first sync, binding any local
  // history made before it joined; on later syncs installs new bindings.
  // Returns the household's identity bindings.
  async prepareSyncState(status, devices, currentKey) {
    const bootstrap = await this.store.getSyncBootstrap();
    const remoteBindings = await this.fetchBindings(devices);
    const needsLegacyBinding = bootstrap.events.some(
      (row) =>
        idToHex(row.household_id) !== this.identity.householdId ||
        idToHex(row.actor_id) !== this.identity.memberId ||
        idToHex(row.device_id) !== this.identity.deviceId,
    );
    let legacyBindingEnvelope = null;
    if (
      needsLegacyBinding &&
      !remoteBindings.some((record) =>
        sameLegacyTuple(record.binding, bootstrap.legacyIdentity),
      )
    ) {
      const binding = {
        legacyHouseholdId: bootstrap.legacyIdentity.householdId,
        legacyActorId: bootstrap.legacyIdentity.actorId,
        legacyDeviceId: bootstrap.legacyIdentity.deviceId,
        householdId: this.identity.householdId,
        actorId: this.identity.memberId,
        deviceId: this.identity.deviceId,
      };
      legacyBindingEnvelope = await encryptIdentityBinding({
        binding,
        householdId: this.identity.householdId,
        deviceId: this.identity.deviceId,
        deviceSequence: 1,
        logicalTime: (bootstrap.maxLogicalTime + 1n).toString(),
        keyEpoch: status.currentEpoch,
        householdKey: currentKey.householdKey,
        signingKey: this.deviceKeys.keys.signingPrivateKey,
      });
      remoteBindings.push({ binding, envelope: legacyBindingEnvelope });
    }

    let syncState = await this.store.getSyncState();
    if (!syncState) {
      await this.store.initializeSync({
        identity: this.identity,
        serverStatus: status,
        identityBindings: remoteBindings,
        legacyBindingEnvelope,
      });
    } else if (remoteBindings.length) {
      await this.store.installIdentityBindings(remoteBindings, this.identity);
    }

    return remoteBindings;
  }

  async provisionMemberHistory(currentEpoch, devices) {
    let prepared = 0;
    for (const recipient of devices) {
      if (
        recipient.deviceId === this.identity.deviceId ||
        recipient.revokedAt ||
        (recipient.historyFromEpoch ?? 1) > currentEpoch ||
        !recipient.publicKeys
      )
        continue;
      for (
        let keyEpoch = recipient.historyFromEpoch ?? 1;
        keyEpoch <= currentEpoch;
        keyEpoch += 1
      ) {
        if (recipient.provisionedEpochs?.includes(keyEpoch)) continue;
        const request = await this.store.getProvisioningRequest(
          recipient.deviceId,
          keyEpoch,
        );
        if (request.accepted && request.package?.expiresAt > Date.now() &&
            request.package.recipientFingerprint === recipient.fingerprint &&
            request.issuerFingerprint === this.deviceKeys.fingerprint) continue;
        if (prepared >= MAX_PUSH_BATCH) return;
        const key = await this.keyStore.getEpoch(
          this.identity.householdId,
          keyEpoch,
        );
        // Another authorized device may hold this entitled epoch. A local
        // absence must not prevent this device from syncing the keys it has.
        if (!key) continue;
        const grant = await this.request("/api/sync/provisioning/grants", {
          method: "POST",
          body: JSON.stringify({
            recipientDeviceId: recipient.deviceId,
            keyEpoch,
            requestId: request.requestId,
          }),
        });
        let keyPackage = request.package;
        if (
          !keyPackage ||
          keyPackage.grantId !== grant.grantId ||
          keyPackage.expiresAt <= Date.now() ||
          keyPackage.recipientFingerprint !== recipient.fingerprint ||
          request.issuerFingerprint !== this.deviceKeys.fingerprint
        ) {
          keyPackage = await provisionSealedEpochKey({
            sealed: key.sealed,
            deviceKeys: this.deviceKeys.keys,
            grant: {
              ...grant,
              recipientPublicKeys: grant.recipientPublicKeys,
              signingKey: this.deviceKeys.keys.signingPrivateKey,
            },
          });
          await this.store.updateProvisioningRequest(request.requestId, {
            package: keyPackage,
            issuerFingerprint: this.deviceKeys.fingerprint,
            accepted: false,
          });
        }
        await this.request(`/api/sync/provisioning/grants/${grant.grantId}`, {
          method: "POST",
          body: JSON.stringify({ package: keyPackage }),
        });
        await this.store.updateProvisioningRequest(request.requestId, {
          accepted: true,
        });
        prepared++;
      }
    }
  }

  async fetchBindings(devices) {
    const result = [];
    let cursor = "";
    while (true) {
      const page = await this.request(
        `/api/sync/bindings?cursor=${encodeURIComponent(cursor)}`,
      );
      for (const envelope of page.bindings) {
        const sender = devices.find(
          (device) => device.deviceId === envelope.deviceId,
        );
        if (!sender?.publicKeys)
          throw new Error(
            "A household identity record came from an unknown device.",
          );
        const epoch = await this.keyStore.getEpoch(
          this.identity.householdId,
          envelope.keyEpoch,
        );
        if (!epoch)
          throw new Error(
            `A historical identity key for epoch ${envelope.keyEpoch} is missing.`,
          );
        let binding;
        for (const entry of [...sender.verifiedKeyHistory].reverse()) {
          const signer = await importDevicePublicKeys(entry.publicKeys);
          try {
            binding = await decryptIdentityBinding({ envelope, householdKey: epoch.householdKey,
              signingKey: signer.signing, expectedHouseholdId: this.identity.householdId });
            break;
          } catch (error) { if (error.code !== "event_signature_invalid") throw error; }
        }
        if (!binding) throw new Error("A household identity record has no valid historical signer.");
        if (
          binding.actorId !== sender.memberId ||
          binding.deviceId !== sender.deviceId
        )
          throw new Error(
            "A household identity record does not match its trusted signer.",
          );
        result.push({ binding, envelope });
      }
      if (!page.hasMore) break;
      if (page.nextCursor === cursor)
        throw new Error("Kin could not advance the household identity cursor.");
      cursor = page.nextCursor;
    }
    return result;
  }

  // Uploads this device's identity bindings. Like events, they wait while a
  // key rotation is pending, and one sealed under an epoch older than the
  // relay's current one is re-sealed first: the retired epoch's key may be
  // held by a removed device, and a member who joined at the new epoch
  // could not read it.
  async pushIdentityBindings(status) {
    if (status?.rotationPending) return;
    const pending = await this.store.getPendingBindings();
    for (const record of pending) {
      const envelope = record.controlEnvelope;
      if (status && envelope.deviceId === this.identity.deviceId &&
          envelope.keyEpoch < status.currentEpoch) {
        const currentKey = await this.keyStore.getEpoch(this.identity.householdId, status.currentEpoch);
        if (!currentKey) throw householdKeyMissing("household_key_missing_for_binding", status.currentEpoch);
        const resealed = await encryptIdentityBinding({
          binding: {
            legacyHouseholdId: record.legacyHouseholdId,
            legacyActorId: record.legacyActorId,
            legacyDeviceId: record.legacyDeviceId,
            householdId: record.householdId,
            actorId: record.actorId,
            deviceId: record.deviceId,
          },
          householdId: this.identity.householdId,
          deviceId: this.identity.deviceId,
          deviceSequence: envelope.deviceSequence,
          logicalTime: envelope.logicalTime,
          keyEpoch: status.currentEpoch,
          householdKey: currentKey.householdKey,
          signingKey: this.deviceKeys.keys.signingPrivateKey,
        });
        // Only one tab's re-sealed copy is stored and sent; a tab that lost
        // the race leaves it for the next pass.
        if (!(await this.store.replacePendingBindingEnvelope(record.legacy_key, envelope.eventId, resealed))) continue;
        record.controlEnvelope = resealed;
      }
      await this.request("/api/sync/bindings", {
        method: "POST",
        body: JSON.stringify({ bindings: [record.controlEnvelope] }),
      });
      await this.store.markBindingUploaded(record.legacy_key);
    }
  }

  async pushPendingEvents() {
    // Events made under this device's earlier local identity need its binding
    // on the relay first, or other devices can't attribute them. A binding
    // still pending (it waits out a key rotation) holds events back too.
    if ((await this.store.getPendingBindings()).some((record) =>
      record.controlEnvelope?.deviceId === this.identity.deviceId))
      return;
    while (true) {
      const pending = await this.store.getPendingOutbox(MAX_PUSH_BATCH);
      if (!pending.length) return;
      const envelopes = [];
      for (const row of pending) {
        if (row.envelope) {
          envelopes.push(row.envelope);
          continue;
        }
        if (row.keyEpoch == null)
          throw new Error(
            "Device sync is paused until household key rotation completes.",
          );
        const keyEpoch = row.keyEpoch;
        const epoch = await this.keyStore.getEpoch(
          this.identity.householdId,
          keyEpoch,
        );
        if (!epoch)
          throw new Error(
            `The current household key epoch ${keyEpoch} is missing.`,
          );
        const metadata = this.engine.eventMetadata(row.canonical_event);
        const envelope = await encryptEvent({
          eventId: row.event_id,
          householdId: row.householdId,
          deviceId: row.deviceId,
          deviceSequence: row.deviceSequence,
          logicalTime: metadata.logicalTime.toString(),
          keyEpoch,
          plaintext: row.canonical_event,
          householdKey: epoch.householdKey,
          signingKey: this.deviceKeys.keys.signingPrivateKey,
        });
        await this.store.storeOutboxEnvelope(row.event_id, envelope, keyEpoch);
        envelopes.push(envelope);
      }
      const acknowledgement = await this.request("/api/sync/events", {
        method: "POST",
        body: encodeEnvelopeBatch(envelopes),
        headers: { "Content-Type": ENVELOPE_CONTENT_TYPE },
      });
      for (const envelope of envelopes)
        await this.store.markOutboxAccepted(
          envelope.eventId,
          acknowledgement.latestCursor,
        );
    }
  }

  async acknowledgeRemoteDuplicateEvents(keyEpoch) {
    const duplicates = await this.store.getRemoteDuplicateOutbox();
    if (!duplicates.length) return;
    const epoch = await this.keyStore.getEpoch(this.identity.householdId, keyEpoch);
    if (!epoch) throw new Error(`The current household key epoch ${keyEpoch} is missing.`);
    const state = await this.store.getSyncState();
    for (const row of duplicates) {
      const eventMetadata = this.engine.eventMetadata(row.canonical_event);
      const envelope = row.envelope ?? await encryptEvent({
        eventId: row.event_id,
        householdId: this.identity.householdId,
        deviceId: this.identity.deviceId,
        deviceSequence: row.deviceSequence,
        logicalTime: eventMetadata.logicalTime.toString(),
        keyEpoch: row.keyEpoch ?? keyEpoch,
        plaintext: row.canonical_event,
        householdKey: epoch.householdKey,
        signingKey: this.deviceKeys.keys.signingPrivateKey,
      });
      await this.store.storeOutboxEnvelope(row.event_id, envelope, row.keyEpoch ?? keyEpoch);
      await this.store.markOutboxAccepted(row.event_id, state.syncCursor);
    }
  }

  async request(path, options = {}) {
    if (this.stopped) throw new Error("Device sync was stopped.");
    const budgetDelay = this.requestBudgetDelay();
    if (budgetDelay > 0) {
      const error = new Error("Catching up after a short wait.");
      error.code = "sync_client_rate_budget";
      error.retryAfterMs = budgetDelay;
      throw error;
    }
    this.keyStore?.vault.assertUnlocked();
    await this.keyStore?.vault.checkSecurityEpoch?.();
    this.recordRequest();
    const result = await api(path, { ...options, signal: this.abortController.signal });
    if (this.stopped) throw new Error("Device sync was stopped.");
    // A peer may advance the durable lock/root epoch while this response is in
    // flight even when its broadcast is missed. Reject before using private keys
    // to process provisioning or exposing the response to the sync continuation.
    await this.keyStore?.vault.checkSecurityEpoch?.();
    if (this.stopped) throw new Error("Device sync was stopped.");
    this.keyStore?.vault.assertUnlocked();
    return result;
  }

  pruneRequestTimes(now = this.now()) {
    const cutoff = now - REQUEST_WINDOW_MS;
    while (this.requestTimes.length && this.requestTimes[0] <= cutoff)
      this.requestTimes.shift();
    return now;
  }

  requestBudgetDelay(requests = 1) {
    const now = this.pruneRequestTimes();
    const excess = this.requestTimes.length + requests - REQUEST_BUDGET;
    if (excess <= 0) return 0;
    return Math.max(1, this.requestTimes[excess - 1] + REQUEST_WINDOW_MS - now + 1);
  }

  recordRequest() {
    const now = this.pruneRequestTimes();
    this.requestTimes.push(now);
  }

  async loadHouseholdSettings() {
    let response;
    try {
      response = await this.request("/api/household/settings");
    } catch (error) {
      if (error.code !== "connection_unavailable" && navigator.onLine !== false) throw error;
      const value = await this.loadCachedHouseholdSettings();
      return { admin: false, adminRecorded: false, value, offline: true };
    }
    const chatPolicy = response.chatPolicy ?? null, boardPolicy = response.boardPolicy ?? null;
    if (!response.settings) return { admin: response.admin, adminRecorded: response.adminRecorded, chatPolicy, boardPolicy, value: null };
    const candidate = { householdId: this.identity.householdId, ...response.settings };
    const value = await this.decryptCachedHouseholdSettings(candidate);
    const cached = await this.keyStore.cacheHouseholdSettings(candidate);
    return { admin: response.admin, adminRecorded: response.adminRecorded, chatPolicy, boardPolicy,
      value: cached.revision === candidate.revision ? value : await this.decryptCachedHouseholdSettings(cached) };
  }

  loadCachedHouseholdSettings() {
    return loadCachedHouseholdSettings(this.identity, { keyStore: this.keyStore });
  }

  async decryptCachedHouseholdSettings(settings) {
    const epoch = await this.keyStore.getEpoch(this.identity.householdId, settings.keyEpoch);
    if (!epoch) throw new Error("This device does not have the key needed to read the shared appearance.");
    return decryptHouseholdSettings(settings, { householdId: this.identity.householdId, householdKey: epoch.householdKey });
  }

  async saveHouseholdSettings(value) {
    if (navigator.onLine === false) throw new Error("Connect to the household before changing shared settings.");
    const status = await this.request("/api/sync/status");
    const epoch = await this.keyStore.getEpoch(this.identity.householdId, status.currentEpoch);
    if (!epoch) throw new Error("This device is not ready to protect shared settings.");
    const encrypted = await encryptHouseholdSettings(value, { householdId: this.identity.householdId, keyEpoch: status.currentEpoch, householdKey: epoch.householdKey });
    const result = await this.request("/api/household/settings", { method: "PUT", body: encrypted.ciphertext,
      headers: { "Content-Type": "application/octet-stream", "X-Household-Settings-Revision": String(value.revision),
        "X-Household-Settings-Key-Epoch": String(status.currentEpoch), "X-Household-Settings-SHA256": encrypted.digest } });
    const accepted = { householdId: this.identity.householdId, revision: result.revision, keyEpoch: status.currentEpoch,
      ciphertext: bytesToBase64Url(encrypted.ciphertext), digest: encrypted.digest };
    let cached;
    try {
      cached = await this.keyStore.cacheHouseholdSettings(accepted);
    } catch (cause) {
      const error = new Error("Household settings were saved, but Kin couldn't update this device's offline copy. Stay online and refresh before editing again.", { cause });
      error.code = "household_settings_cache_partial";
      error.savedValue = { ...value, revision: result.revision };
      throw error;
    }
    return cached.revision === accepted.revision
      ? { ...value, revision: result.revision }
      : this.decryptCachedHouseholdSettings(cached);
  }

  // The published install identity (#78) is plaintext by design: the admin
  // chose to show it on home screens, so nothing here is encrypted.
  loadInstallIdentity() {
    return this.request("/api/household/install-identity");
  }

  publishInstallIdentity(value) {
    if (navigator.onLine === false) throw new Error("Connect to the household before changing what home screens show.");
    return this.request("/api/household/install-identity", { method: "PUT", body: JSON.stringify(value) });
  }

  withdrawInstallIdentity(expectedRev) {
    if (navigator.onLine === false) throw new Error("Connect to the household before changing what home screens show.");
    return this.request("/api/household/install-identity", { method: "DELETE", body: JSON.stringify({ expectedRev }) });
  }

  /** One album pass (#673): reads the album from the history, then lets
   * album-blobs.js upload and tidy its photos. */
  async syncAlbum() {
    if (this.stopped || typeof this.store?.album !== "function") return;
    const album = await this.store.album();
    this.albumStore ??= await openAlbumStore(this.store);
    if (this.stopped || !this.albumStore) return;
    await reconcileAlbum({ album, identity: this.identity, store: this.store, keyStore: this.keyStore, albumStore: this.albumStore, suspected: (this.albumSuspects ??= new Set()), signal: this.abortController.signal });
  }

  stop() {
    this.stopped = true;
    this.albumStore?.close();
    this.albumStore = null;
    this.stopLive();
    this.abortController.abort();
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.continuationTimer);
    this.continuationTimer = null;
    if (this.chat) {
      this.chat.close();
      try { this.onChatRoom(null); } catch { /* the view's trouble isn't sync's */ }
    }
    this.chat = null;
    if (this.board) {
      this.board.close();
      try { this.onBoardRoom(null); } catch { /* the view's trouble isn't sync's */ }
    }
    this.board = null;
    if (this.privateLog) {
      this.privateLog.close();
      try { this.onPrivateLog(null); } catch { /* the view's trouble isn't sync's */ }
    }
    this.privateLog = null;
    this.keyStore?.close();
    this.keyStore = null;
    this.deviceKeys = null;
    this.catchUp = null;
    this.requestTimes = [];
    this.engine = null;
    this.store = null;
  }
}

function validateCanonicalIdentity({ encodedEvent, envelope, signer, householdId, bindings, engine }) {
  const metadata = engine.eventMetadata(encodedEvent);
  const eventId = idToHex(metadata.eventId);
  const embeddedHousehold = idToHex(metadata.householdId);
  const embeddedActor = idToHex(metadata.actorId);
  const embeddedDevice = idToHex(metadata.deviceId);
  if (eventId !== envelope.eventId || envelope.householdId !== householdId ||
      metadata.logicalTime.toString() !== envelope.logicalTime)
    throw new Error("The encrypted envelope does not match its canonical event bytes.");
  const directIdentity =
    embeddedHousehold === householdId &&
    embeddedActor === signer.memberId &&
    embeddedDevice === envelope.deviceId;
  if (directIdentity) return;
  const binding = bindings.find(
    (candidate) =>
      candidate.legacyHouseholdId === embeddedHousehold &&
      candidate.legacyActorId === embeddedActor &&
      candidate.legacyDeviceId === embeddedDevice,
  );
  if (
    !binding ||
    binding.householdId !== householdId ||
    binding.actorId !== signer.memberId ||
    binding.deviceId !== envelope.deviceId
  )
    throw new Error(
      "A synchronized event's embedded identity could not be verified.",
    );
}

function sameLegacyTuple(binding, identity) {
  return (
    binding.legacyHouseholdId === identity.householdId &&
    binding.legacyActorId === identity.actorId &&
    binding.legacyDeviceId === identity.deviceId
  );
}

// `binary: true` returns a successful response's body as bytes (the event
// pages of envelope-wire.js); errors are JSON either way.
async function api(path, { binary = false, ...options } = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  } catch (cause) {
    const error = new Error("Household sync could not be reached.", { cause });
    error.code = "connection_unavailable";
    throw error;
  }
  if (binary && response.ok) return new Uint8Array(await response.arrayBuffer());
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      value.message || "Kin could not synchronize this device.",
    );
    error.code = value.error;
    const retryAfter = response.headers?.get?.("Retry-After") ?? null;
    const retrySeconds = retryAfter === null ? NaN : Number(retryAfter);
    const retryAt = retryAfter && !Number.isFinite(retrySeconds) ? Date.parse(retryAfter) : NaN;
    const hintedMs = Number.isFinite(value.retryAfterMs) ? value.retryAfterMs
      : Number.isFinite(retrySeconds) ? retrySeconds * 1_000
      : Number.isFinite(retryAt) ? retryAt - Date.now()
      : null;
    if (hintedMs !== null) error.retryAfterMs = Math.max(0, hintedMs);
    throw error;
  }
  return value;
}

function provisioningRefused() {
  const error = new Error(
    "Kin refused a household key transfer because it did not match its signed contents. Sync is paused on this device. Ask a household Adult to check this device's key transfer.",
  );
  error.code = "provisioning_grant_refused";
  return error;
}

// The same words for each place a pass finds no key for the relay's current
// epoch; the code says which place and keyEpoch which epoch (#791).
function householdKeyMissing(code, keyEpoch) {
  const error = new Error("This device needs an authorized household key before sync can continue.");
  error.code = code;
  error.keyEpoch = keyEpoch;
  return error;
}

function randomIdHex() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
