// A relay stream of encrypted events kept apart from the household relay
// (#111 chat, #317 fridge). Events are canonical events in the ordinary
// signed, encrypted envelopes (web/sync/crypto.js), but each stream has its
// own relay sequence and cursor, its own per-device sequence, its own logical
// clock bound and its own quota, so it never counts against household
// limits. Like every envelope, they are opaque ciphertext to the service.
//
// Rules match the household relay: an envelope must come from the
// authenticated device of this household under a key epoch it holds; each
// device's sequence in the stream has no gaps; a repeated event ID is
// accepted only with identical bytes; a page only shows events from epochs
// the reading device may read.
import { PairingError } from "./pairing-service.mjs";
import { canonicalEventEnvelope, MAX_LOGICAL_TIME_ADVANCE } from "./sync-contract.mjs";
import { decodeCursor, encodeCursor, MAX_EVENTS_PER_BATCH, validateEventEnvelope } from "./sync-service.mjs";
import { DurableConflictError } from "./durable-store.mjs";

const MAX_REQUEST_BYTES = 200_000;

/**
 * A stream's store methods under neutral names. `storage` is a DurableStore
 * (or a memory twin) with `<stream>RelayState`, `<stream>DeviceSequence`,
 * `find<Stream>Event`, `commit<Stream>Events` and `read<Stream>Events`.
 */
export function streamStorage(storage, stream) {
  const Stream = stream[0].toUpperCase() + stream.slice(1);
  return {
    relayState: (householdId) => storage[`${stream}RelayState`](householdId),
    deviceSequence: (householdId, deviceId) => storage[`${stream}DeviceSequence`](householdId, deviceId),
    find: (householdId, eventId) => storage[`find${Stream}Event`](householdId, eventId),
    commit: (householdId, batch) => storage[`commit${Stream}Events`](householdId, batch),
    read: (householdId, cursor, limit, minimumEpoch) => storage[`read${Stream}Events`](householdId, cursor, limit, minimumEpoch),
  };
}

/** Stream storage in memory (tests, in-memory mode), with the same
 * decisions as durable-store/stream-events.mjs. */
export function memoryStreamMethods(stream, { conflictCode, conflictMessage }) {
  const Stream = stream[0].toUpperCase() + stream.slice(1);
  const households = new Map();
  const state = (householdId) => {
    if (!households.has(householdId))
      households.set(householdId, { records: [], byEventId: new Map(), deviceSequence: new Map(), maxLogicalTime: "0" });
    return households.get(householdId);
  };
  return {
    [`${stream}RelayState`](householdId) {
      const current = state(householdId);
      return { nextSequence: current.records.length + 1, eventCount: current.records.length, maxLogicalTime: current.maxLogicalTime };
    },
    [`${stream}DeviceSequence`](householdId, deviceId) { return state(householdId).deviceSequence.get(deviceId) ?? 0; },
    [`find${Stream}Event`](householdId, eventId) { return state(householdId).byEventId.get(eventId) ?? null; },
    [`commit${Stream}Events`](householdId, { expectedNextSequence, deviceId, expectedDeviceSequence, entries, maxLogicalTime }) {
      const current = state(householdId);
      if (current.records.length + 1 !== expectedNextSequence || (current.deviceSequence.get(deviceId) ?? 0) !== expectedDeviceSequence)
        throw new DurableConflictError(conflictCode, conflictMessage);
      for (const entry of entries) {
        const record = { sequence: current.records.length + 1, canonical: entry.canonical, envelope: structuredClone(entry.envelope) };
        current.records.push(record);
        current.byEventId.set(entry.envelope.eventId, record);
      }
      if (entries.length) current.deviceSequence.set(deviceId, entries.at(-1).envelope.deviceSequence);
      current.maxLogicalTime = maxLogicalTime;
    },
    [`read${Stream}Events`](householdId, cursor, limit, minimumEpoch) {
      const current = state(householdId);
      const scanned = current.records.slice(cursor, cursor + limit);
      const lastScanned = scanned.at(-1)?.sequence ?? cursor;
      return {
        events: scanned
          .filter((record) => record.envelope.keyEpoch >= minimumEpoch)
          .map((record) => ({ cursor: encodeCursor(record.sequence), envelope: structuredClone(record.envelope) })),
        nextCursor: encodeCursor(lastScanned),
        hasMore: lastScanned < current.records.length,
      };
    },
    forgetHousehold(householdId) { households.delete(householdId); },
  };
}

/**
 * The push, status and pull every stream shares. `words` holds the stream's
 * own error codes and messages, so each stream reports in its own terms;
 * `rateLimited()` makes the error for a device over its per-minute window.
 *
 * A stream is keyed by household unless it says otherwise: `keyOf(auth)`
 * names the stream a request reads and writes (the private stream, #491, is
 * keyed by member), `validate(envelope, auth, sync)` checks one envelope's
 * routing (household streams hold household key epochs), and
 * `minimumEpoch(auth)` is the oldest key epoch a page shows the device.
 */
export class EventStream {
  constructor({ syncService, storage, maxEvents, maxPull, window, words, rateLimited, hint,
    keyOf = (auth) => auth.household.id,
    validate = (envelope, auth, sync) => validateEventEnvelope(envelope, auth, sync.currentEpoch),
    minimumEpoch = (auth) => auth.device.syncHistoryFromEpoch ?? 1 }) {
    Object.assign(this, { syncService, storage, maxEvents, maxPull, window, words, rateLimited, hint, keyOf, validate, minimumEpoch });
  }

  /** Validates and stores a device's batch. The caller has already checked
   * access and that household sync is ready. */
  push(auth, envelopes, sync) {
    const { words } = this;
    if (!Array.isArray(envelopes) || envelopes.length < 1 || envelopes.length > MAX_EVENTS_PER_BATCH)
      throw new PairingError("sync_batch_invalid", words.batchInvalid, 400);
    const householdId = this.keyOf(auth);
    // New events only count: a retry of events the service already holds is
    // free. Checked here, charged only once they are stored, so a batch that
    // fails (full, conflict, invalid) never uses up the allowance.
    const fresh = envelopes.filter((envelope) => !this.storage.find(householdId, envelope.eventId)).length;
    if (fresh && !this.window.allows(auth.device.id, fresh)) throw this.rateLimited();
    const relay = this.storage.relayState(householdId);
    const expectedDeviceSequence = this.storage.deviceSequence(householdId, auth.device.id);
    let deviceSequence = expectedDeviceSequence;
    let maxLogicalTime = BigInt(relay.maxLogicalTime);
    let requestBytes = 0;
    const staged = [], seen = new Map();
    for (const envelope of envelopes) {
      this.validate(envelope, auth, sync);
      const canonical = canonicalEventEnvelope(envelope);
      requestBytes += Buffer.byteLength(canonical);
      if (requestBytes > MAX_REQUEST_BYTES)
        throw new PairingError("sync_batch_too_large", words.batchTooLarge, 413);
      const existing = this.storage.find(householdId, envelope.eventId) ?? seen.get(envelope.eventId);
      if (existing) {
        if (existing.canonical !== canonical)
          throw new PairingError("event_duplicate_conflict", words.duplicate, 409);
        continue;
      }
      const logicalTime = BigInt(envelope.logicalTime);
      if (logicalTime - maxLogicalTime > MAX_LOGICAL_TIME_ADVANCE)
        throw new PairingError("logical_time_invalid", words.logicalTime, 400);
      if (logicalTime > maxLogicalTime) maxLogicalTime = logicalTime;
      if (envelope.deviceSequence !== deviceSequence + 1)
        throw new PairingError("sync_sequence_gap", words.sequenceGap, 409);
      if (relay.eventCount + staged.length >= this.maxEvents)
        throw new PairingError(words.fullCode, words.full, 413);
      deviceSequence = envelope.deviceSequence;
      const entry = { canonical, envelope };
      staged.push(entry);
      seen.set(envelope.eventId, entry);
    }
    if (staged.length) {
      try {
        this.storage.commit(householdId, {
          householdId: auth.household.id, expectedNextSequence: relay.nextSequence, deviceId: auth.device.id, expectedDeviceSequence,
          entries: staged, maxLogicalTime: maxLogicalTime.toString(),
        });
      } catch (error) {
        if (error instanceof DurableConflictError)
          throw new PairingError(words.conflictCode, words.conflict, 409);
        throw error;
      }
      this.window.spend(auth.device.id, staged.length);
      // After the commit, in the background: the household's other devices
      // hear about it at once.
      try { this.hint(householdId, auth); } catch { /* best effort */ }
    }
    const after = this.storage.relayState(householdId);
    return { accepted: envelopes.length, latestCursor: encodeCursor(after.nextSequence - 1) };
  }

  /** This device's last sequence in the stream (so a device whose local log
   * was lost can continue without a gap) and the relay's latest cursor. */
  status(auth) {
    const householdId = this.keyOf(auth);
    return {
      deviceSequence: this.storage.deviceSequence(householdId, auth.device.id),
      latestCursor: encodeCursor(this.storage.relayState(householdId).nextSequence - 1),
    };
  }

  pull(auth, cursorValue = "", limitValue = String(this.maxPull)) {
    const householdId = this.keyOf(auth);
    const cursor = decodeCursor(cursorValue);
    const limit = Number(limitValue);
    const relay = this.storage.relayState(householdId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxPull || cursor > relay.nextSequence - 1)
      throw new PairingError("sync_cursor_invalid", this.words.cursor, 400);
    return this.storage.read(householdId, cursor, limit, this.minimumEpoch(auth));
  }
}
