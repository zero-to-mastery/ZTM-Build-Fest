// Each member's private relay (#491, ADR 0019): encrypted private events in
// a stream keyed by member, apart from the household, chat and the fridge.
//
// Private envelopes are sealed under the member key (MK), which only that
// member's devices hold (the member's account vault), so they are opaque
// ciphertext to the service like every envelope; their key epoch is an MK
// epoch, not a household one. The rules are the chat relay's (event-stream.mjs):
// the authenticated device's own envelopes, a gapless per-device sequence,
// identical-bytes idempotency, the logical-time bound and a per-device rate
// window, with a quota per member.
//
// Who may: the stream a request reaches is always the session's own
// member's; no route names a member, so another member's device, an
// admin's included, can only ever reach its own. The member must be able to
// take part (a removed member or a revoked device has no session), may not
// be Temporary, and a Limited member only while the household's "private
// storage for children and teens" is on. Removing a member purges their
// stream; deleting the household purges every stream with it.
import { DurableConflictError, MAX_MEMBER_PRIVATE_EVENTS } from "./durable-store.mjs";
import { DeviceWindow } from "./chat-limits.mjs";
import { EventStream, streamStorage } from "./event-stream.mjs";
import { isHouseholdAdmin, PairingError, privateAccess, privatePolicyOf } from "./pairing-service.mjs";
import { isEventEnvelopeValid } from "./sync-contract.mjs";
import { encodeCursor } from "./sync-service.mjs";

export { MAX_MEMBER_PRIVATE_EVENTS };
/** Most private events one pull returns. */
export const MAX_PRIVATE_PULL = 200;
/** Most private events one device may send in a minute. */
export const PRIVATE_EVENTS_PER_MINUTE = 120;

const WORDS = Object.freeze({
  batchInvalid: "That private batch is invalid.",
  batchTooLarge: "That private batch is too large.",
  duplicate: "A private change conflicts with one already received.",
  logicalTime: "That private change is outside Kin's supported event-order range.",
  sequenceGap: "This device must send its earlier private changes first.",
  fullCode: "private_limit", full: "Your private storage is full.",
  conflictCode: "private_relay_conflict", conflict: "Your private things changed meanwhile; retry.",
  cursor: "Kin could not continue from that private position.",
});

/** The private stream's storage in memory (tests, in-memory mode), with the
 * same decisions as durable-store/private-events.mjs. */
export function memoryPrivateMethods() {
  const members = new Map();
  const state = (memberId) => {
    if (!members.has(memberId))
      members.set(memberId, { householdId: null, records: [], byEventId: new Map(), deviceSequence: new Map(), maxLogicalTime: "0" });
    return members.get(memberId);
  };
  return {
    privateRelayState(memberId) {
      const current = state(memberId);
      return { nextSequence: current.records.length + 1, eventCount: current.records.length, maxLogicalTime: current.maxLogicalTime };
    },
    privateDeviceSequence(memberId, deviceId) { return state(memberId).deviceSequence.get(deviceId) ?? 0; },
    findPrivateEvent(memberId, eventId) { return state(memberId).byEventId.get(eventId) ?? null; },
    commitPrivateEvents(memberId, { householdId, expectedNextSequence, deviceId, expectedDeviceSequence, entries, maxLogicalTime }) {
      const current = state(memberId);
      if (current.records.length + 1 !== expectedNextSequence || (current.deviceSequence.get(deviceId) ?? 0) !== expectedDeviceSequence ||
          (current.householdId !== null && current.householdId !== householdId))
        throw new DurableConflictError(WORDS.conflictCode, WORDS.conflict);
      current.householdId = householdId;
      for (const entry of entries) {
        const record = { sequence: current.records.length + 1, canonical: entry.canonical, envelope: structuredClone(entry.envelope) };
        current.records.push(record);
        current.byEventId.set(entry.envelope.eventId, record);
      }
      if (entries.length) current.deviceSequence.set(deviceId, entries.at(-1).envelope.deviceSequence);
      current.maxLogicalTime = maxLogicalTime;
    },
    readPrivateEvents(memberId, cursor, limit, minimumEpoch) {
      const current = state(memberId);
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
    purgePrivateMember(memberId) { members.delete(memberId); },
    forgetHousehold(householdId) {
      for (const [memberId, current] of members) if (current.householdId === householdId) members.delete(memberId);
    },
  };
}

export class PrivateRelayService {
  constructor({ syncService, store = null }) {
    this.syncService = syncService;
    this.storage = store ?? memoryPrivateMethods();
    this.stream = new EventStream({
      syncService, storage: streamStorage(this.storage, "private"), maxEvents: MAX_MEMBER_PRIVATE_EVENTS, maxPull: MAX_PRIVATE_PULL,
      window: new DeviceWindow({ limit: PRIVATE_EVENTS_PER_MINUTE, windowMs: 60_000, now: () => syncService.now() }),
      rateLimited: () => new PairingError("private_rate_limited", "Too many private changes too fast. Kin will try again in a moment.", 429),
      // Only the member's own other devices hear about it.
      hint: (_memberId, auth) => syncService.liveService?.memberEventsAccepted(auth.household.id, auth.member.id, auth.device.id),
      words: WORDS,
      keyOf: (auth) => auth.member.id,
      // An MK epoch, which the service can't check beyond its range (the
      // member's vault holds the epochs); the household and device must be
      // the authenticated ones.
      validate: (envelope, auth) => {
        if (!isEventEnvelopeValid(envelope) || envelope.householdId !== auth.household.id || envelope.deviceId !== auth.device.id)
          throw new PairingError("event_envelope_invalid", "That encrypted event is invalid.", 400);
      },
      // Every MK epoch is the member's own: a new device of theirs reads
      // their whole private history once it opens the vault.
      minimumEpoch: () => 1,
    });
  }

  /** Refuses anyone who may not have a private stream (ADR 0019). */
  assertCanUse(auth) {
    // A revoked device has no session (authorize refuses it first); this
    // keeps it out even with an authorization taken before the revocation.
    if (!auth?.device || auth.device.revokedAt)
      throw new PairingError("private_unavailable", "Private storage isn't available to you in this household.", 403);
    if (privateAccess(auth.member, auth.household, this.syncService.now()) === "write") return;
    const kind = auth.member?.kind ?? "adult";
    if (kind === "limited")
      throw new PairingError("private_off", "Your household has turned off private storage for children and teens.", 403);
    throw new PairingError("private_unavailable", "Private storage isn't available to you in this household.", 403);
  }

  /** This member's access, for the sync status: "write" or "none", and the
   * Limited setting for an admin. */
  summary(auth) {
    const access = privateAccess(auth.member, auth.household, this.syncService.now());
    return {
      access,
      ...(isHouseholdAdmin(auth.member, this.syncService.now()) ? { policy: { limited: privatePolicyOf(auth.household).limited } } : {}),
    };
  }

  push(auth, envelopes) {
    this.assertCanUse(auth);
    const sync = this.syncService.state(auth.household.id);
    if (!sync.enabled)
      throw new PairingError("private_sync_unavailable", "Private storage is unavailable until household sync is set up.", 409);
    return this.stream.push(auth, envelopes, sync);
  }

  status(auth) {
    this.assertCanUse(auth);
    return { ...this.stream.status(auth), events: this.storage.privateRelayState(auth.member.id).eventCount, eventLimit: MAX_MEMBER_PRIVATE_EVENTS };
  }

  pull(auth, cursorValue = "", limitValue = String(MAX_PRIVATE_PULL)) {
    this.assertCanUse(auth);
    return this.stream.pull(auth, cursorValue, limitValue);
  }

  /** Member removal: their stream goes (their devices keep their copies). */
  forgetMember(memberId) {
    this.storage.purgePrivateMember(memberId);
  }

  /** In-memory mode only: the durable store purges with the household. */
  forgetHousehold(householdId) {
    this.storage.forgetHousehold?.(householdId);
  }
}
