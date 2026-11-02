// The household fridge on this device (#317, ADR 0011): drawing, the board
// relay stream, and the decrypted board log the engine replays.
//
// - The board log (board-log-store.js) keeps every board event as the
//   signed, encrypted envelope it travels in. Opening the room decrypts it
//   into memory; locking drops that copy.
// - A change (a stroke on pen-up, a magnet, a clear) has the engine make and
//   check the board event against the board log, then is encrypted and signed
//   under the household's current key epoch and stored with an outbox entry.
//   It shows at once; sending happens on the next pass.
// - sync() runs after each full household pass (sync-coordinator.js): it
//   pushes this device's pending events to the board relay, then pulls new
//   ones, authenticates each against its author's device key, checks its
//   canonical identity and kind, and stores it.
//
// Board events are sealed under the household key epoch (there is no board
// key). There is no presence and nothing here notifies anyone.
import { decryptStoredEvent, decryptWithDeviceHistory, encryptEvent } from "../sync/crypto.js";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../sync/envelope-wire.js";
import { idToHex } from "../wasm/kin-engine.js";
import { BOARD_EVENT_KINDS } from "../wasm/kin-board.js";
import { projectionContext } from "../browser-time.js";
import { ChatRecords } from "../chat/chat-records.js";
import { BoardLogError, BoardLogStore } from "./board-log-store.js";

export const MAX_BOARD_PUSH = 20;
export const MAX_BOARD_PULL = 200;
const MAX_BOARD_PULL_PAGES = 5;
const MAX_BOARD_PUSH_BATCHES = 3;
const LOAD_BATCH = 500;
const BOARD_KINDS = new Set(BOARD_EVENT_KINDS);
// Refusals no retry can fix: the event is skipped and remembered.
const FINAL_REFUSALS = new Set(["board_event_refused"]);
// A signature that fails once gets a second look on a later pass (the device
// may have changed its key after this pass read the directory).
const SECOND_LOOK_REFUSALS = new Set(["event_signature_invalid"]);

export class BoardRoomError extends Error {
  constructor(message, code = "board_unavailable") {
    super(message);
    this.name = "BoardRoomError";
    this.code = code;
  }
}

const randomIdHex = () => [...crypto.getRandomValues(new Uint8Array(16))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A fresh random ID for a stroke, magnet or clear. */
export const newBoardId = randomIdHex;

export class BoardRoom {
  /** Opens the household's fridge on this device and decrypts its log.
   * `request(path, options)` is the coordinator's authenticated request;
   * `locks` serializes drawing across tabs. */
  static async open({ identity, keyStore, deviceKeys, engine, request, indexedDB, keyRange, locks = globalThis.navigator?.locks, now = () => Date.now(), onLocalChange = () => {} }) {
    const store = await BoardLogStore.open(identity.householdId, { indexedDB, keyRange });
    const room = new BoardRoom({ identity, keyStore, deviceKeys, engine, request, store, locks, now, onLocalChange });
    try {
      const { access } = await store.state();
      if (["write", "read", "none"].includes(access)) room.access = access;
      await room.refresh();
    } catch (error) {
      room.close();
      throw error;
    }
    return room;
  }

  constructor({ identity, keyStore, deviceKeys, engine, request, store, locks, now, onLocalChange }) {
    Object.assign(this, { identity, keyStore, deviceKeys, engine, request, store, locks, now, onLocalChange });
    this.records = new ChatRecords();
    this.indexById = new Map();
    // Storage order of every stored event, readable or not, and the events
    // still held as read from an export (#363).
    this.orderById = new Map();
    this.importedIds = new Set();
    this.loadedOrder = 0;
    this.maxLogicalTime = 0n;
    this.epochKeys = new Map();
    this.currentEpoch = null;
    this.pending = new Set();
    this.refused = [];
    this.suspects = new Map();
    this.pass = 0;
    this.refreshQueue = Promise.resolve();
    this.listeners = new Set();
    this.syncError = null;
    // What the household's fridge policy lets this member do (#323): "write"
    // (draw), "read" (look only) or "none". The service says so each pass.
    this.access = "write";
    this.closed = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try { listener(this); } catch { /* one view's trouble isn't the others' */ }
    }
  }

  /** How the last pass went (null when it succeeded), for the view. */
  reportSync(error) {
    const changed = (this.syncError?.code ?? null) !== (error?.code ?? null);
    this.syncError = error;
    if (changed) this.notify();
  }

  assertOpen() {
    if (this.closed) throw new BoardRoomError("Unlock Kin to use the fridge.", "board_locked");
    this.keyStore.vault?.assertUnlocked?.();
  }

  async epochKey(keyEpoch) {
    if (this.epochKeys.has(keyEpoch)) return this.epochKeys.get(keyEpoch);
    const epoch = await this.keyStore.getEpoch(this.identity.householdId, keyEpoch);
    if (!epoch) throw new BoardRoomError(`This device is missing key epoch ${keyEpoch}; the fridge is paused.`, "board_key_missing");
    this.epochKeys.set(keyEpoch, epoch.householdKey);
    return epoch.householdKey;
  }

  /** The current key epoch: the last pass's, else the newest held (a
   * stroke drawn offline before the first sync). */
  async sendingEpoch() {
    if (this.currentEpoch !== null) return this.currentEpoch;
    const epochs = await this.keyStore.listEpochs(this.identity.householdId);
    if (!epochs.length) throw new BoardRoomError("The fridge is unavailable until household sync is set up.", "board_sync_unavailable");
    return Math.max(...epochs.map((epoch) => epoch.keyEpoch));
  }

  syncIdentity() {
    return { householdId: this.identity.householdId, bindings: [] };
  }

  signingKey() {
    const key = this.deviceKeys?.keys?.signingPrivateKey;
    if (!key) throw new BoardRoomError("The fridge is unavailable until this device's keys are ready.", "board_keys_unavailable");
    return key;
  }

  /** Reads events stored since the last read (by this tab or another) into
   * memory. Calls run one after another. */
  refresh() {
    const run = this.refreshQueue.then(() => this.refreshOnce());
    this.refreshQueue = run.catch(() => {});
    return run;
  }

  async refreshOnce() {
    this.assertOpen();
    let changed = false;
    while (true) {
      const rows = await this.store.eventsFrom(this.loadedOrder + 1, LOAD_BATCH);
      if (!rows.length) break;
      rows.forEach((row, index) => {
        if (row.order !== this.loadedOrder + 1 + index)
          throw new BoardLogError("This device's fridge log is out of order.", "board_log_damaged");
      });
      const decrypted = [];
      for (const row of rows) {
        this.orderById.set(row.eventId, row.order);
        if (row.imported) this.importedIds.add(row.eventId);
      }
      try {
        for (const row of rows) {
          // Read from an export (#363): sealed by this device's vault.
          if (row.imported) {
            let opened = null;
            try {
              opened = await this.keyStore.vault.open(row.imported, { store: "board-import", id: row.eventId });
            } catch (error) {
              // Sealed under a root this device no longer has: skipped, not a
              // wall. Restoring the same export again seals it afresh.
              if (error?.code === "locked") throw error;
            }
            decrypted.push(opened);
            continue;
          }
          decrypted.push(await decryptStoredEvent({ envelope: row.envelope, householdKey: await this.epochKey(row.envelope.keyEpoch) }));
        }
        this.assertOpen();
        const readable = rows.filter((_, index) => decrypted[index]);
        const kept = decrypted.filter(Boolean);
        const metadata = this.engine.eventMetadataBatch(kept);
        readable.forEach((row, index) => {
          this.indexById.set(row.eventId, this.records.length);
          this.records.append(kept[index]);
          const logicalTime = BigInt(metadata[index].logicalTime);
          if (logicalTime > this.maxLogicalTime) this.maxLogicalTime = logicalTime;
        });
      } finally {
        for (const bytes of decrypted) bytes?.fill(0);
      }
      this.loadedOrder += rows.length;
      changed = true;
      if (rows.length < LOAD_BATCH) break;
    }
    const pending = new Set((await this.store.outbox()).map((row) => row.eventId));
    if (pending.size !== this.pending.size || [...pending].some((id) => !this.pending.has(id))) changed = true;
    this.pending = pending;
    if (changed) this.notify();
    return changed;
  }

  /** The fridge as drawn: { strokes, magnets, openClear } (kin-board.js). */
  board() {
    this.assertOpen();
    const { asOf, civilDate } = projectionContext(this.now());
    return this.engine.boardState(this.records.view(), asOf, civilDate, this.syncIdentity());
  }

  /** What an export of the fridge holds (#363): the canonical board events
   * this device has, as a snapshot view (nothing is copied). Null when the
   * fridge is empty or this member has no access. */
  async exportPlan() {
    this.assertOpen();
    if (this.access === "none") return null;
    await this.refresh();
    const view = this.records.view();
    return view.length ? { view } : null;
  }

  /** Whether any of this device's changes are still waiting to send. */
  get waiting() {
    return this.pending.size > 0;
  }

  /**
   * Makes one board change (kin-board.js BOARD_COMMANDS) and stores it.
   * Resolves with the new event's ID. The engine refuses a change the board
   * doesn't allow (a full fridge, a stroke already erased).
   */
  async change(command) {
    this.assertOpen();
    if (this.access !== "write")
      throw new BoardRoomError("Your household has set the fridge to look only for you.", "board_read_only");
    const write = async () => {
      await this.refresh();
      const state = await this.store.state();
      const { asOf, civilDate } = projectionContext(this.now());
      const eventId = randomIdHex();
      const logicalTime = this.maxLogicalTime + 1n;
      const result = this.engine.executeBoardCommand(command, {
        eventId,
        householdId: this.identity.householdId,
        actorId: this.identity.memberId,
        deviceId: this.identity.deviceId,
        timestamp: asOf,
        logicalTime,
      }, this.records.view(), asOf, civilDate, this.syncIdentity());
      let envelope;
      try {
        const keyEpoch = await this.sendingEpoch();
        envelope = await encryptEvent({
          eventId,
          householdId: this.identity.householdId,
          deviceId: this.identity.deviceId,
          deviceSequence: state.deviceSequence + 1,
          logicalTime: logicalTime.toString(),
          keyEpoch,
          plaintext: result.encodedEvent,
          householdKey: await this.epochKey(keyEpoch),
          signingKey: this.signingKey(),
        });
      } finally {
        result.encodedEvent.fill(0);
      }
      this.assertOpen();
      await this.store.addLocal(envelope);
      await this.refresh();
      return eventId;
    };
    const eventId = await this.exclusive(write);
    try { this.onLocalChange(); } catch { /* sync starts on its own schedule */ }
    return eventId;
  }

  /** Runs `work` while no tab of this household is changing the fridge. */
  exclusive(work) {
    return this.locks?.request ? this.locks.request(`kin-board-send:${this.identity.householdId}`, work) : work();
  }

  /** One fridge pass after a full household pass: push, then pull.
   * Resolves with { hasMore } when more is left than one pass takes. */
  async sync({ status, devices, deviceKeys }) {
    this.assertOpen();
    this.pass += 1;
    if (deviceKeys) this.deviceKeys = deviceKeys;
    this.currentEpoch = status.currentEpoch;
    const access = ["write", "read", "none"].includes(status.board?.access) ? status.board.access : "write";
    if (access !== this.access) {
      this.access = access;
      await this.store.setAccess(access);
      this.notify();
    }
    // No access: nothing is fetched or sent until the admin changes it back.
    if (access === "none") return { hasMore: false };
    await this.refresh();
    let pushMore = false, pushError = null;
    if (!status.rotationPending && access === "write") {
      try {
        pushMore = await this.push();
      } catch (error) {
        // A full fridge or a busy device still reads what others drew.
        if (["board_rate_limited", "board_limit", "board_key_missing"].includes(error?.code)) pushError = error;
        else throw error;
      }
    }
    const pullMore = await this.pull(status, devices);
    if (pushError) throw pushError;
    return { hasMore: pushMore || pullMore };
  }

  async push() {
    const before = await this.store.state();
    if (!(await this.store.outbox()).length && !before.provisional) return false;
    // Renumbering and resealing run under the drawing lock, after asking the
    // relay where it stands for this device: that count settles a
    // provisional sequence and tells events accepted before a lost
    // acknowledgement apart from events still to send.
    const accepted = await this.exclusive(async () => {
      const { deviceSequence: relaySequence } = await this.request("/api/board/status");
      if (!Number.isSafeInteger(relaySequence) || relaySequence < 0)
        throw new BoardRoomError("The fridge received an invalid relay position.", "board_relay_invalid");
      const outbox = await this.store.outbox();
      const state = await this.store.state();
      if (state.provisional) {
        if (!outbox.length) await this.store.settleSequence(relaySequence);
        else await this.reseal(outbox, relaySequence + 1, { expectedDeviceSequence: state.deviceSequence, deviceSequence: relaySequence + outbox.length });
        return [];
      }
      const done = outbox.filter((row) => row.deviceSequence <= relaySequence);
      const waiting = outbox.slice(done.length);
      if (waiting.length && waiting[0].deviceSequence !== relaySequence + 1)
        throw new BoardRoomError("The fridge on this device is out of step with the relay.", "board_sequence_mismatch");
      // Anything sealed under an older key epoch is sealed again first.
      const stale = [];
      for (const row of waiting) if ((await this.pendingEnvelope(row)).keyEpoch < this.currentEpoch) stale.push(row);
      if (stale.length) await this.reseal(stale, null, { expectedDeviceSequence: state.deviceSequence, deviceSequence: state.deviceSequence });
      return done;
    });
    if (accepted.length) await this.store.markSent(accepted.map((row) => row.deviceSequence));
    for (let batches = 0; batches < MAX_BOARD_PUSH_BATCHES; batches += 1) {
      const batch = (await this.store.outbox()).slice(0, MAX_BOARD_PUSH);
      if (!batch.length) break;
      const envelopes = [];
      for (const row of batch) envelopes.push(await this.pendingEnvelope(row));
      await this.request("/api/board/events", {
        method: "POST",
        body: encodeEnvelopeBatch(envelopes),
        headers: { "Content-Type": ENVELOPE_CONTENT_TYPE },
      });
      await this.store.markSent(batch.map((row) => row.deviceSequence));
    }
    await this.refresh();
    return (await this.store.outbox()).length > 0;
  }

  async pendingEnvelope(row) {
    const stored = await this.store.eventById(row.eventId);
    if (stored?.eventId !== row.eventId || stored.envelope.deviceSequence !== row.deviceSequence)
      throw new BoardLogError("This device's fridge log is missing a pending change.", "board_log_damaged");
    return stored.envelope;
  }

  /** Re-encrypts pending events, renumbered from `firstSequence` (or kept
   * when null), under the current key epoch. */
  async reseal(rows, firstSequence, { expectedDeviceSequence, deviceSequence }) {
    await this.refresh();
    const keyEpoch = await this.sendingEpoch();
    const householdKey = await this.epochKey(keyEpoch);
    const view = this.records.view();
    const entries = [];
    for (const [position, row] of rows.entries()) {
      const index = this.indexById.get(row.eventId);
      if (index === undefined) throw new BoardLogError("This device's fridge log is missing a pending change.", "board_log_damaged");
      const plaintext = view.record(index).slice();
      try {
        const metadata = this.engine.eventMetadata(plaintext);
        const envelope = await encryptEvent({
          eventId: row.eventId,
          householdId: this.identity.householdId,
          deviceId: this.identity.deviceId,
          deviceSequence: firstSequence === null ? row.deviceSequence : firstSequence + position,
          logicalTime: metadata.logicalTime.toString(),
          keyEpoch,
          plaintext,
          householdKey,
          signingKey: this.signingKey(),
        });
        const order = this.orderById.get(row.eventId);
        if (order === undefined) throw new BoardLogError("This device's fridge log is missing a pending change.", "board_log_damaged");
        entries.push({ order, previousSequence: row.deviceSequence, envelope });
      } finally {
        plaintext.fill(0);
      }
    }
    await this.store.replacePending(entries, { expectedDeviceSequence, deviceSequence });
  }

  async pull(status, devices) {
    for (let pages = 0; pages < MAX_BOARD_PULL_PAGES; pages += 1) {
      const { cursor } = await this.store.state();
      const page = decodeEventPage(await this.request(
        `/api/board/events?cursor=${encodeURIComponent(cursor)}&limit=${MAX_BOARD_PULL}`,
        { binary: true },
      ));
      const verified = [], refused = [];
      let pause = null;
      for (const { cursor: at, envelope } of page.events) {
        // Already stored from the relay: checked when it first arrived. One
        // read from an export is checked like any other, and must be the
        // same event, before the relay's copy takes its place.
        const imported = this.importedIds.has(envelope.eventId);
        if (this.orderById.has(envelope.eventId) && !imported) {
          verified.push(envelope);
          continue;
        }
        try {
          const index = this.indexById.get(envelope.eventId);
          await this.authenticate(envelope, status, devices, imported && index !== undefined ? this.records.view().record(index) : null);
          verified.push(envelope);
        } catch (error) {
          if (this.closed) throw error;
          const secondLook = SECOND_LOOK_REFUSALS.has(error.code);
          const final = FINAL_REFUSALS.has(error.code) ||
            (secondLook && (this.suspects.get(envelope.eventId) ?? this.pass) < this.pass);
          if (!final && !secondLook) throw error;
          if (!final) {
            if (!this.suspects.has(envelope.eventId)) this.suspects.set(envelope.eventId, this.pass);
            pause ??= error;
            continue;
          }
          this.suspects.delete(envelope.eventId);
          refused.push({ eventId: envelope.eventId, deviceId: envelope.deviceId, cursor: at, code: error.code ?? "board_event_refused" });
        }
      }
      if (pause) throw pause;
      this.assertOpen();
      await this.store.addReceived(verified, page.nextCursor, { refused });
      for (const envelope of verified) this.importedIds.delete(envelope.eventId);
      if (refused.length) this.refused = [...this.refused, ...refused].slice(-100);
      await this.refresh();
      if (!page.hasMore || page.nextCursor === cursor) return false;
    }
    return true;
  }

  /** Checks a relayed board event as household sync checks its events: from
   * a trusted device of this household, signed by it, under a key epoch it
   * may use, a board kind, and carrying the same identity inside as out. */
  async authenticate(envelope, status, devices, expected = null) {
    const refuse = (message) => { throw new BoardRoomError(message, "board_event_refused"); };
    if (envelope.householdId !== this.identity.householdId) refuse("A fridge change came from another household.");
    const signer = devices.find((device) => device.deviceId === envelope.deviceId);
    if (!signer?.publicKeys)
      throw new BoardRoomError("A fridge change came from a device this one doesn't know yet.", "board_device_unknown");
    if (signer.revokedAt && envelope.keyEpoch >= status.currentEpoch) refuse("A revoked device cannot change the fridge in the current key epoch.");
    if (envelope.keyEpoch < (signer.historyFromEpoch ?? 1)) refuse("A fridge change came from before its device's history.");
    const encodedEvent = await decryptWithDeviceHistory({ device: signer, envelope, householdKey: await this.epochKey(envelope.keyEpoch) });
    try {
      let metadata;
      try {
        metadata = this.engine.eventMetadata(encodedEvent);
      } catch {
        refuse("A fridge change isn't a valid event.");
      }
      if (!BOARD_KINDS.has(metadata.kind) ||
          idToHex(metadata.eventId) !== envelope.eventId ||
          idToHex(metadata.householdId) !== this.identity.householdId ||
          idToHex(metadata.actorId) !== signer.memberId ||
          idToHex(metadata.deviceId) !== envelope.deviceId ||
          metadata.logicalTime.toString() !== envelope.logicalTime)
        refuse("A fridge change did not match its encrypted envelope.");
      if (expected && (expected.length !== encodedEvent.length || expected.some((byte, index) => byte !== encodedEvent[index])))
        refuse("A fridge change did not match the one restored from an export.");
    } finally {
      encodedEvent.fill(0);
    }
  }

  /** Drops the decrypted log (on lock or stop). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
    this.indexById.clear();
    this.orderById.clear();
    this.importedIds.clear();
    this.epochKeys.clear();
    this.pending.clear();
    this.listeners.clear();
    this.deviceKeys = null;
    this.store.close();
  }
}

/** The fridge room for a browser page, or null where IndexedDB is missing. */
export async function openBrowserBoardRoom(options) {
  if (typeof globalThis.indexedDB === "undefined" || typeof globalThis.IDBKeyRange === "undefined") return null;
  return BoardRoom.open(options);
}
