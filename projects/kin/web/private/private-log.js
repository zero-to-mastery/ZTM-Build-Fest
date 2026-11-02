// One member's private log on this device (#492, ADR 0019): the member key,
// the private relay stream and the decrypted log the engine replays.
//
// - The private log store (private-log-store.js) keeps every private event
//   as the signed envelope it travels in, sealed under a member-key epoch.
//   Opening the log decrypts it into memory; locking drops that copy and
//   every member key.
// - The member key comes from the member's account vault (member-key.js).
//   Without it (no account yet, or no vault key on this device) the log is
//   inactive: nothing is read, written or sent.
// - A private change is a canonical private event (kinds from 100) the
//   engine made; it is sealed under the newest member-key epoch, signed by
//   this device and stored with an outbox entry. It counts at once; sending
//   happens on the next pass.
// - sync() runs after the board pass (sync-coordinator.js): it starts a new
//   member-key epoch if one of the member's devices was revoked since the
//   newest epoch was made, pushes pending events (resealing any sealed under
//   an older epoch), then pulls new ones and authenticates each against its
//   author's device key: it must come from one of the member's own devices.
import { verifiedDeviceKeyHistory, importDevicePublicKeys } from "../sync/crypto.js";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../sync/envelope-wire.js";
import { idToHex } from "../wasm/kin-engine.js";
import { isPrivateKind } from "../wasm/kin-private.js";
import { projectionContext } from "../browser-time.js";
import { ChatRecords } from "../chat/chat-records.js";
import { vaultApi } from "../security/account-vault-sync.js";
import { MemberKeyError, MemberKeyRing, memberRevocationMark } from "./member-key.js";
import { decryptPrivateEvent, decryptStoredPrivateEvent, encryptPrivateEvent } from "./private-envelope.js";
import { PrivateLogError, PrivateLogStore } from "./private-log-store.js";

export const MAX_PRIVATE_PUSH = 20;
export const MAX_PRIVATE_PULL = 200;
const MAX_PRIVATE_PULL_PAGES = 5;
const MAX_PRIVATE_PUSH_BATCHES = 3;
const LOAD_BATCH = 500;
// Refusals no retry can fix: the event is skipped and remembered.
const FINAL_REFUSALS = new Set(["private_event_refused"]);
// A signature that fails once gets a second look on a later pass (the device
// may have changed its key after this pass read the directory).
const SECOND_LOOK_REFUSALS = new Set(["event_signature_invalid"]);
// Statuses after which the member key won't appear without the member doing
// something (setting up an account, signing in again).
const SETTLED = new Set(["no_vault", "no_vault_key"]);

export class PrivateLogRoomError extends Error {
  constructor(message, code = "private_unavailable") {
    super(message);
    this.name = "PrivateLogRoomError";
    this.code = code;
  }
}

const randomIdHex = () => [...crypto.getRandomValues(new Uint8Array(16))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A fresh random ID for a private record or event. */
export const newPrivateId = randomIdHex;

export class PrivateLog {
  /**
   * Opens the member's private log on this device. `request(path, options)`
   * is the coordinator's authenticated request; `vaultKey()` is the member
   * key ring's vault-key provider (member-key.js, the #557 integration
   * point); `keyRing` replaces the ring (tests). `locks` serializes writes
   * across tabs.
   */
  static async open({ identity, deviceKeys, engine, request, vaultKey = async () => null, keyRing = null, indexedDB, keyRange, locks = globalThis.navigator?.locks, now = () => Date.now(), onLocalChange = () => {} }) {
    const store = await PrivateLogStore.open(identity.householdId, identity.memberId, { indexedDB, keyRange });
    const ring = keyRing ?? new MemberKeyRing({
      api: vaultApi(request), householdId: identity.householdId, memberId: identity.memberId, vaultKey, cache: store.vaultCache(),
    });
    const log = new PrivateLog({ identity, deviceKeys, engine, request, store, ring, locks, now, onLocalChange });
    try {
      await ring.load();
    } catch (error) {
      // Offline with nothing cached, say: the next pass tries again.
      log.keyError = error;
    }
    try {
      if (ring.available) await log.refresh();
    } catch (error) {
      if (error?.code === "locked") { log.close(); throw error; }
      log.syncError = error;
    }
    return log;
  }

  constructor({ identity, deviceKeys, engine, request, store, ring, locks, now, onLocalChange }) {
    Object.assign(this, { identity, deviceKeys, engine, request, store, ring, locks, now, onLocalChange });
    this.records = new ChatRecords();
    this.indexById = new Map();
    this.orderById = new Map();
    this.loadedOrder = 0;
    this.maxLogicalTime = 0n;
    this.pending = new Set();
    this.refused = [];
    this.suspects = new Map();
    this.pass = 0;
    this.refreshQueue = Promise.resolve();
    this.listeners = new Set();
    // Work a private surface runs on each pass once the member key is here,
    // before events are pushed (the journal's photo uploads, #502).
    this.passHooks = new Set();
    this.syncError = null;
    this.keyError = null;
    this.streamChecked = false;
    this.streamEventsSeen = 0;
    this.revocationMark = 0;
    // Whether the service lets this member have private storage: "write"
    // or "none" (Temporary, or Limited while the household turned it off).
    this.access = "write";
    this.closed = false;
  }

  /** Whether private storage works on this device now: the member key is
   * here and the household allows it. */
  get active() {
    return !this.closed && this.access === "write" && this.ring.available;
  }

  /** Why it doesn't, for the private surfaces: "locked", "no_vault" (set up
   * an account first, ADR 0018), "no_vault_key", "no_member_key" (nothing
   * private yet), "off" or "ready". */
  get reason() {
    if (this.closed) return "locked";
    if (this.access !== "write") return "off";
    return this.ring.status;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs `hook()` on each pass, after the keys and before the push; its
   * failure fails the pass like a push would. Returns an unsubscribe. */
  onPass(hook) {
    this.passHooks.add(hook);
    return () => this.passHooks.delete(hook);
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
    if (this.closed) throw new PrivateLogRoomError("Unlock Kin to use your private things.", "private_locked");
  }

  assertActive() {
    this.assertOpen();
    if (this.access !== "write")
      throw new PrivateLogRoomError("Your household has turned off private storage for you.", "private_off");
    if (!this.ring.available)
      throw new PrivateLogRoomError("Open your account on this device to use your private things.", "private_key_unavailable");
  }

  syncIdentity() {
    return { householdId: this.identity.householdId, bindings: [] };
  }

  signingKey() {
    const key = this.deviceKeys?.keys?.signingPrivateKey;
    if (!key) throw new PrivateLogRoomError("Private storage is unavailable until this device's keys are ready.", "private_keys_unavailable");
    return key;
  }

  /**
   * Creates the member key on the member's first use of something private
   * (ADR 0019). Resolves to the ring's status; "no_vault" means the member
   * must set up an account first.
   */
  async enable() {
    this.assertOpen();
    const status = await this.ring.create({ revokedThrough: this.revocationMark });
    if (this.ring.available) await this.refresh();
    this.notify();
    return status;
  }

  /** Reads events stored since the last read (by this tab or another) into
   * memory. Calls run one after another. */
  refresh() {
    const run = this.refreshQueue.then(() => this.refreshOnce());
    this.refreshQueue = run.catch(() => {});
    return run;
  }

  async refreshOnce() {
    this.assertActive();
    let changed = false;
    while (true) {
      const rows = await this.store.eventsFrom(this.loadedOrder + 1, LOAD_BATCH);
      if (!rows.length) break;
      rows.forEach((row, index) => {
        if (row.order !== this.loadedOrder + 1 + index)
          throw new PrivateLogError("This device's private log is out of order.", "private_log_damaged");
      });
      const decrypted = [];
      try {
        for (const row of rows) {
          decrypted.push(await decryptStoredPrivateEvent({
            envelope: row.envelope, memberId: this.identity.memberId, memberKey: await this.ring.key(row.envelope.keyEpoch),
          }));
        }
        this.assertActive();
        const metadata = this.engine.eventMetadataBatch(decrypted);
        rows.forEach((row, index) => {
          this.orderById.set(row.eventId, row.order);
          this.indexById.set(row.eventId, this.records.length);
          this.records.append(decrypted[index]);
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

  /** The member's private projection (KPRV, kin-private.js). */
  projection() {
    this.assertActive();
    const { asOf, civilDate } = projectionContext(this.now());
    return this.engine.privateState(this.records.view(), asOf, civilDate, this.syncIdentity());
  }

  /** The logical time a new private event should carry. */
  nextLogicalTime() {
    return this.maxLogicalTime + 1n;
  }

  /** Whether any of this device's changes are still waiting to send. */
  get waiting() {
    return this.pending.size > 0;
  }

  /**
   * Stores one private change: `encodedEvent` is a canonical private event
   * (kinds from 100) the engine made for this member on this device. It is
   * sealed under the newest member-key epoch. Resolves with its event ID.
   */
  async append(encodedEvent) {
    this.assertActive();
    let metadata;
    try {
      metadata = this.engine.eventMetadata(encodedEvent);
    } catch {
      throw new PrivateLogRoomError("Kin couldn't save that private change.", "private_event_invalid");
    }
    const eventId = this.checkOwnEvent(metadata);
    await this.exclusive(async () => {
      await this.refresh();
      await this.seal(eventId, metadata, encodedEvent);
    });
    try { this.onLocalChange(); } catch { /* sync starts on its own schedule */ }
    return eventId;
  }

  /**
   * Makes and stores one private change (#511): `command` is a private
   * command (kin-private.js PRIVATE_ITEM_COMMANDS, or kin-prefs.js
   * PREFS_COMMANDS for reminders and settings, #520). Under the write lock,
   * after reading what other tabs stored, the engine validates it against
   * the log as it is now and names it with this member, this device and the
   * next logical time; the event is then sealed like `append`. A refusal
   * (code 4: it changed meanwhile, maybe on another device) stores nothing.
   * Resolves with the event ID.
   */
  async execute(command) {
    this.assertActive();
    let eventId = null;
    await this.exclusive(async () => {
      await this.refresh();
      const { asOf, civilDate } = projectionContext(this.now());
      const identity = {
        eventId: newPrivateId(), householdId: this.identity.householdId, actorId: this.identity.memberId,
        deviceId: this.identity.deviceId, timestamp: asOf, logicalTime: this.nextLogicalTime(),
      };
      const { encodedEvent, metadata } = this.engine.executePrivateCommand(
        command, identity, this.records.view(), asOf, civilDate, this.syncIdentity());
      try {
        eventId = this.checkOwnEvent(metadata);
        await this.seal(eventId, metadata, encodedEvent);
      } finally {
        encodedEvent.fill(0);
      }
    });
    try { this.onLocalChange(); } catch { /* sync starts on its own schedule */ }
    return eventId;
  }

  /** A private event this member's device made here: its ID (hex). */
  checkOwnEvent(metadata) {
    if (!isPrivateKind(metadata.kind) ||
        idToHex(metadata.householdId) !== this.identity.householdId ||
        idToHex(metadata.actorId) !== this.identity.memberId ||
        idToHex(metadata.deviceId) !== this.identity.deviceId ||
        metadata.logicalTime < 1n)
      throw new PrivateLogRoomError("Kin couldn't save that private change.", "private_event_invalid");
    return idToHex(metadata.eventId);
  }

  /** Seals one event under the newest member-key epoch and stores it with
   * an outbox entry. Runs inside `exclusive`. */
  async seal(eventId, metadata, encodedEvent) {
    const state = await this.store.state();
    const { epoch, key } = this.ring.current();
    const envelope = await encryptPrivateEvent({
      eventId, householdId: this.identity.householdId, memberId: this.identity.memberId, deviceId: this.identity.deviceId,
      deviceSequence: state.deviceSequence + 1, logicalTime: metadata.logicalTime.toString(), keyEpoch: epoch,
      plaintext: encodedEvent, memberKey: key, signingKey: this.signingKey(),
    });
    this.assertActive();
    await this.store.addLocal(envelope);
    await this.refresh();
  }

  /** Runs `work` while no tab of this member is writing privately. */
  exclusive(work) {
    return this.locks?.request ? this.locks.request(`kin-private-send:${this.identity.householdId}:${this.identity.memberId}`, work) : work();
  }

  /** Makes sure this device holds the member key if the member has one:
   * after a failed read, and when the stream holds events this device can't
   * read yet (another device created the key): checked once per unlock, and
   * again on each pass while the member has no key here, reading the vault
   * only when the stream has grown since the last look (#520: a reminder
   * set on another device after this one opened). */
  async ensureKeys() {
    if (this.ring.available) return true;
    if (SETTLED.has(this.ring.status)) return false;
    if (this.keyError) {
      this.keyError = null;
      try { await this.ring.load(); } catch (error) { this.keyError = error; throw error; }
    } else if (!this.streamChecked || this.ring.status === "no_member_key") {
      this.streamChecked = true;
      const { events } = await this.request("/api/private/status");
      if (Number.isSafeInteger(events) && events > this.streamEventsSeen) {
        // Remembered only once read, so a refused read (a busy vault) is
        // tried again on the next pass.
        await this.ring.load();
        this.streamEventsSeen = events;
      }
    }
    if (this.ring.available) await this.refresh();
    return this.ring.available;
  }

  /** One private pass after the board pass: rotate if needed, push, then
   * pull. Resolves with { hasMore } when more is left than one pass takes. */
  async sync({ status, devices, deviceKeys }) {
    this.assertOpen();
    this.pass += 1;
    if (deviceKeys) this.deviceKeys = deviceKeys;
    const access = status.private?.access === "write" ? "write" : "none";
    if (access !== this.access) {
      this.access = access;
      this.notify();
    }
    // Not allowed (Temporary, or Limited while it's off): nothing is fetched
    // or sent; what is on this device stays.
    if (access !== "write") return { hasMore: false };
    this.revocationMark = memberRevocationMark(devices, this.identity.memberId);
    if (!(await this.ensureKeys())) return { hasMore: false };
    // One of this member's devices was revoked after the newest member-key
    // epoch was made: start the next one before sealing anything new.
    if (this.revocationMark > this.ring.current().revokedThrough) {
      await this.ring.rotate({ revokedThrough: this.revocationMark });
      this.notify();
    }
    await this.refresh();
    // Photos go before the events that name them, so another device rarely
    // finds a photo still on its way.
    for (const hook of [...this.passHooks]) await hook();
    let pushMore = false, pushError = null;
    try {
      pushMore = await this.push();
    } catch (error) {
      // A full private store or a busy device still reads what arrived.
      if (["private_rate_limited", "private_limit"].includes(error?.code)) pushError = error;
      else throw error;
    }
    const pullMore = await this.pull(devices);
    if (pushError) throw pushError;
    return { hasMore: pushMore || pullMore };
  }

  async push() {
    const before = await this.store.state();
    if (!(await this.store.outbox()).length && !before.provisional) return false;
    const accepted = await this.exclusive(async () => {
      const { deviceSequence: relaySequence } = await this.request("/api/private/status");
      if (!Number.isSafeInteger(relaySequence) || relaySequence < 0)
        throw new PrivateLogRoomError("Private storage received an invalid relay position.", "private_relay_invalid");
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
        throw new PrivateLogRoomError("Private storage on this device is out of step with the relay.", "private_sequence_mismatch");
      // Anything sealed under an older member-key epoch (before a rotation)
      // is sealed again under the newest first.
      const newest = this.ring.current().epoch;
      const stale = [];
      for (const row of waiting) if ((await this.pendingEnvelope(row)).keyEpoch < newest) stale.push(row);
      if (stale.length) await this.reseal(stale, null, { expectedDeviceSequence: state.deviceSequence, deviceSequence: state.deviceSequence });
      return done;
    });
    if (accepted.length) await this.store.markSent(accepted.map((row) => row.deviceSequence));
    for (let batches = 0; batches < MAX_PRIVATE_PUSH_BATCHES; batches += 1) {
      const batch = (await this.store.outbox()).slice(0, MAX_PRIVATE_PUSH);
      if (!batch.length) break;
      const envelopes = [];
      for (const row of batch) envelopes.push(await this.pendingEnvelope(row));
      await this.request("/api/private/events", {
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
      throw new PrivateLogError("This device's private log is missing a pending change.", "private_log_damaged");
    return stored.envelope;
  }

  /** Re-encrypts pending events, renumbered from `firstSequence` (or kept
   * when null), under the newest member-key epoch. */
  async reseal(rows, firstSequence, { expectedDeviceSequence, deviceSequence }) {
    await this.refresh();
    const { epoch, key } = this.ring.current();
    const view = this.records.view();
    const entries = [];
    for (const [position, row] of rows.entries()) {
      const index = this.indexById.get(row.eventId);
      const order = this.orderById.get(row.eventId);
      if (index === undefined || order === undefined)
        throw new PrivateLogError("This device's private log is missing a pending change.", "private_log_damaged");
      const plaintext = view.record(index).slice();
      try {
        const metadata = this.engine.eventMetadata(plaintext);
        const envelope = await encryptPrivateEvent({
          eventId: row.eventId, householdId: this.identity.householdId, memberId: this.identity.memberId, deviceId: this.identity.deviceId,
          deviceSequence: firstSequence === null ? row.deviceSequence : firstSequence + position,
          logicalTime: metadata.logicalTime.toString(), keyEpoch: epoch, plaintext, memberKey: key, signingKey: this.signingKey(),
        });
        entries.push({ order, previousSequence: row.deviceSequence, envelope });
      } finally {
        plaintext.fill(0);
      }
    }
    await this.store.replacePending(entries, { expectedDeviceSequence, deviceSequence });
  }

  async pull(devices) {
    for (let pages = 0; pages < MAX_PRIVATE_PULL_PAGES; pages += 1) {
      const { cursor } = await this.store.state();
      const page = decodeEventPage(await this.request(
        `/api/private/events?cursor=${encodeURIComponent(cursor)}&limit=${MAX_PRIVATE_PULL}`,
        { binary: true },
      ));
      const verified = [], refused = [];
      let pause = null;
      for (const { cursor: at, envelope } of page.events) {
        // Already stored: checked when it first arrived.
        if (this.orderById.has(envelope.eventId)) {
          verified.push(envelope);
          continue;
        }
        try {
          await this.authenticate(envelope, devices);
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
          refused.push({ eventId: envelope.eventId, deviceId: envelope.deviceId, cursor: at, code: error.code ?? "private_event_refused" });
        }
      }
      if (pause) throw pause;
      this.assertActive();
      await this.store.addReceived(verified, page.nextCursor, { refused });
      if (refused.length) this.refused = [...this.refused, ...refused].slice(-100);
      await this.refresh();
      if (!page.hasMore || page.nextCursor === cursor) return false;
    }
    return true;
  }

  /** Checks a relayed private event: from one of this member's own devices
   * of this household, signed by it, under a member-key epoch it could have
   * held, a private kind, and carrying the same identity inside as out. */
  async authenticate(envelope, devices) {
    const refuse = (message) => { throw new PrivateLogRoomError(message, "private_event_refused"); };
    if (envelope.householdId !== this.identity.householdId) refuse("A private change came from another household.");
    const signer = devices.find((device) => device.deviceId === envelope.deviceId);
    if (!signer?.publicKeys)
      throw new PrivateLogRoomError("A private change came from a device this one doesn't know yet.", "private_device_unknown");
    if (signer.memberId !== this.identity.memberId) refuse("A private change came from someone else's device.");
    const memberKey = await this.ring.key(envelope.keyEpoch);
    // An epoch made after the device's revocation is one it never held.
    if (signer.revokedAt && (this.ring.revokedThrough(envelope.keyEpoch) ?? 0) >= signer.revokedAt)
      refuse("A revoked device can't write under a key made after its revocation.");
    const history = signer.verifiedKeyHistory ?? await verifiedDeviceKeyHistory(signer);
    const verifyKeys = [];
    for (const entry of [...history].reverse()) verifyKeys.push((await importDevicePublicKeys(entry.publicKeys)).signing);
    const encodedEvent = await decryptPrivateEvent({ envelope, memberId: this.identity.memberId, memberKey, verifyKeys });
    try {
      let metadata;
      try {
        metadata = this.engine.eventMetadata(encodedEvent);
      } catch {
        refuse("A private change isn't a valid event.");
      }
      if (!isPrivateKind(metadata.kind) ||
          idToHex(metadata.eventId) !== envelope.eventId ||
          idToHex(metadata.householdId) !== this.identity.householdId ||
          idToHex(metadata.actorId) !== this.identity.memberId ||
          idToHex(metadata.deviceId) !== envelope.deviceId ||
          metadata.logicalTime.toString() !== envelope.logicalTime)
        refuse("A private change did not match its encrypted envelope.");
    } finally {
      encodedEvent.fill(0);
    }
  }

  /** Drops the decrypted log and every member key (on lock or stop). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
    this.indexById.clear();
    this.orderById.clear();
    this.pending.clear();
    this.listeners.clear();
    this.passHooks.clear();
    this.ring.lock();
    this.deviceKeys = null;
    this.store.close();
  }
}

/** The private log for a browser page, or null where IndexedDB is missing. */
export async function openBrowserPrivateLog(options) {
  if (typeof globalThis.indexedDB === "undefined" || typeof globalThis.IDBKeyRange === "undefined") return null;
  return PrivateLog.open(options);
}

export { MemberKeyError };
