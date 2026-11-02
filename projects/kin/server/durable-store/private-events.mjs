// DurableStore private relay (#491, ADR 0019): each member's encrypted
// private events, in a relay stream keyed by member rather than household
// (private-relay-service.mjs has the rules). The relay never reads them; it
// orders them and keeps each device's sequence in the member's stream free
// of gaps. Three tables: `private_relay_state`, `private_events` and
// `private_device_sequences`, each with the member's household so a
// household's deletion purges them with everything else. Like account
// vaults, no foreign key to members: rows outlive an authority restore that
// rewrites the members table, and member removal purges them explicitly.
import { canonicalEventEnvelope, isEventEnvelopeValid } from "../sync-contract.mjs";
import { DurableConflictError, DurableStoreError, isId } from "./shared.mjs";
import { purgePrivateBlobs } from "./private-blobs.mjs";

/** The relay cursor format (sync-service.mjs encodeCursor). */
function encodeCursor(sequence) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

/** Deletes one member's private stream, and their private blobs (#502),
 * inside the caller's transaction. */
export function purgePrivateStream(database, memberId) {
  purgePrivateBlobs(database, memberId);
  database.prepare("DELETE FROM private_events WHERE member_id = ?").run(memberId);
  database.prepare("DELETE FROM private_device_sequences WHERE member_id = ?").run(memberId);
  database.prepare("DELETE FROM private_relay_state WHERE member_id = ?").run(memberId);
}

export const privateEventMethods = {
  privateRelayState(memberId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT next_sequence, max_logical_time FROM private_relay_state WHERE member_id = ?").get(memberId);
    const next = row?.next_sequence ?? 1;
    return { nextSequence: next, eventCount: next - 1, maxLogicalTime: row?.max_logical_time ?? "0" };
  },

  privateDeviceSequence(memberId, deviceId) {
    this.assertAvailable();
    return this.db.prepare("SELECT last_sequence FROM private_device_sequences WHERE member_id = ? AND device_id = ?")
      .get(memberId, deviceId)?.last_sequence ?? 0;
  },

  findPrivateEvent(memberId, eventId) {
    this.assertAvailable();
    return this.db.prepare("SELECT canonical_envelope AS canonical FROM private_events WHERE member_id = ? AND event_id = ?")
      .get(memberId, eventId) ?? null;
  },

  /** Appends a device's batch at the expected stream and device positions,
   * or fails with a conflict (another request moved them meanwhile). */
  commitPrivateEvents(memberId, { householdId, expectedNextSequence, deviceId, expectedDeviceSequence, entries, maxLogicalTime }) {
    if (!isId(memberId) || !isId(householdId)) throw new DurableStoreError("Kin encrypted private data is invalid.");
    this.transaction(() => {
      if (this.privateRelayState(memberId).nextSequence !== expectedNextSequence ||
          this.privateDeviceSequence(memberId, deviceId) !== expectedDeviceSequence)
        throw new DurableConflictError("private_relay_conflict", "Your private things changed meanwhile; retry.");
      const owner = this.db.prepare("SELECT household_id FROM private_relay_state WHERE member_id = ?").get(memberId);
      if (owner && owner.household_id !== householdId) throw new DurableStoreError("Kin encrypted private data is invalid.");
      const insert = this.db.prepare(`INSERT INTO private_events
        (member_id, household_id, relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      let sequence = expectedNextSequence;
      for (const { canonical, envelope } of entries) {
        if (!isEventEnvelopeValid(envelope) || envelope.householdId !== householdId || envelope.deviceId !== deviceId ||
            canonicalEventEnvelope(envelope) !== canonical)
          throw new DurableStoreError("Kin encrypted private data is invalid.");
        insert.run(memberId, householdId, sequence++, envelope.eventId, deviceId, envelope.deviceSequence, envelope.keyEpoch, canonical);
      }
      this.db.prepare(`INSERT INTO private_device_sequences (member_id, household_id, device_id, last_sequence) VALUES (?, ?, ?, ?)
        ON CONFLICT(member_id, device_id) DO UPDATE SET last_sequence = excluded.last_sequence`)
        .run(memberId, householdId, deviceId, entries.at(-1).envelope.deviceSequence);
      this.db.prepare(`INSERT INTO private_relay_state (member_id, household_id, next_sequence, max_logical_time) VALUES (?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET next_sequence = excluded.next_sequence, max_logical_time = excluded.max_logical_time`)
        .run(memberId, householdId, sequence, maxLogicalTime);
    });
  },

  readPrivateEvents(memberId, cursor, limit, minimumEpoch) {
    this.assertAvailable();
    const rows = this.db.prepare(`SELECT relay_sequence, household_id, event_id, device_id, device_sequence, key_epoch, canonical_envelope
      FROM private_events WHERE member_id = ? AND relay_sequence > ? ORDER BY relay_sequence LIMIT ?`).all(memberId, cursor, limit);
    const lastScanned = rows.at(-1)?.relay_sequence ?? cursor;
    const events = [];
    for (const row of rows) {
      let envelope;
      try { envelope = Object.fromEntries(JSON.parse(row.canonical_envelope)); } catch { envelope = null; }
      if (!isEventEnvelopeValid(envelope) || envelope.householdId !== row.household_id || envelope.eventId !== row.event_id ||
          envelope.deviceId !== row.device_id || envelope.deviceSequence !== row.device_sequence ||
          envelope.keyEpoch !== row.key_epoch || canonicalEventEnvelope(envelope) !== row.canonical_envelope) {
        const error = new DurableStoreError("Kin's stored private history is invalid.");
        error.code = "sync_store_invalid";
        error.eventId = row.event_id;
        throw error;
      }
      if (envelope.keyEpoch >= minimumEpoch) events.push({ cursor: encodeCursor(row.relay_sequence), envelope });
    }
    return { events, nextCursor: encodeCursor(lastScanned), hasMore: lastScanned < this.privateRelayState(memberId).nextSequence - 1 };
  },

  /** Purges one member's private stream (member removal, ADR 0019). */
  purgePrivateMember(memberId) {
    if (!isId(memberId)) throw new DurableStoreError("Kin member data is invalid.");
    this.transaction(() => purgePrivateStream(this.db, memberId));
  },
};
