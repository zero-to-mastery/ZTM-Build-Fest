// DurableStore event streams (#111 chat, #317 board): encrypted events in a
// relay stream of their own. The relay never reads them; it orders them and
// keeps each device's sequence in the stream free of gaps (event-stream.mjs
// has the rules). Each stream has three tables named after it:
// `<stream>_relay_state`, `<stream>_events` and `<stream>_device_sequences`.
import { canonicalEventEnvelope, isEventEnvelopeValid } from "../sync-contract.mjs";
import { DurableConflictError, DurableStoreError } from "./shared.mjs";

/** The relay cursor format (sync-service.mjs encodeCursor): an 8-byte
 * big-endian sequence, base64url. Kept here so the store doesn't import the
 * service. */
function encodeCursor(sequence) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

/**
 * The store methods for one stream: `<stream>RelayState`,
 * `<stream>DeviceSequence`, `find<Stream>Event`, `commit<Stream>Events` and
 * `read<Stream>Events`. `label` names the stream in errors ("chat",
 * "fridge"); `conflictCode` is the code a moved position fails with.
 */
export function streamEventMethods(stream, { label, conflictCode, conflictMessage }) {
  if (!/^[a-z]+$/.test(stream)) throw new Error("Invalid stream name.");
  const Stream = stream[0].toUpperCase() + stream.slice(1);
  const relayState = `${stream}RelayState`, deviceSequence = `${stream}DeviceSequence`;
  const parseEnvelope = (row, householdId) => {
    let envelope;
    try { envelope = Object.fromEntries(JSON.parse(row.canonical_envelope)); } catch { envelope = null; }
    if (!isEventEnvelopeValid(envelope) || envelope.householdId !== householdId || envelope.eventId !== row.event_id ||
      envelope.deviceId !== row.device_id || envelope.deviceSequence !== row.device_sequence ||
      envelope.keyEpoch !== row.key_epoch || canonicalEventEnvelope(envelope) !== row.canonical_envelope) {
      const error = new DurableStoreError(`Kin's stored ${label} history is invalid.`);
      error.code = "sync_store_invalid";
      error.eventId = row.event_id;
      throw error;
    }
    return envelope;
  };
  return {
    [relayState](householdId) {
      this.assertAvailable();
      const row = this.db.prepare(`SELECT next_sequence, max_logical_time FROM ${stream}_relay_state WHERE household_id = ?`).get(householdId);
      const next = row?.next_sequence ?? 1;
      return { nextSequence: next, eventCount: next - 1, maxLogicalTime: row?.max_logical_time ?? "0" };
    },

    [deviceSequence](householdId, deviceId) {
      this.assertAvailable();
      return this.db.prepare(`SELECT last_sequence FROM ${stream}_device_sequences WHERE household_id = ? AND device_id = ?`).get(householdId, deviceId)?.last_sequence ?? 0;
    },

    [`find${Stream}Event`](householdId, eventId) {
      this.assertAvailable();
      const row = this.db.prepare(`SELECT canonical_envelope AS canonical FROM ${stream}_events WHERE household_id = ? AND event_id = ?`).get(householdId, eventId);
      return row ?? null;
    },

    /** Appends a device's batch at the expected relay and device positions,
     * or fails with a conflict (another request moved them meanwhile). */
    [`commit${Stream}Events`](householdId, { expectedNextSequence, deviceId, expectedDeviceSequence, entries, maxLogicalTime }) {
      this.transaction(() => {
        if (this[relayState](householdId).nextSequence !== expectedNextSequence ||
          this[deviceSequence](householdId, deviceId) !== expectedDeviceSequence)
          throw new DurableConflictError(conflictCode, conflictMessage);
        const insert = this.db.prepare(`INSERT INTO ${stream}_events
          (household_id, relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        let sequence = expectedNextSequence;
        for (const { canonical, envelope } of entries) {
          if (!isEventEnvelopeValid(envelope) || envelope.householdId !== householdId || envelope.deviceId !== deviceId ||
            canonicalEventEnvelope(envelope) !== canonical)
            throw new DurableStoreError(`Kin encrypted ${label} data is invalid.`);
          insert.run(householdId, sequence++, envelope.eventId, deviceId, envelope.deviceSequence, envelope.keyEpoch, canonical);
        }
        this.db.prepare(`INSERT INTO ${stream}_device_sequences (household_id, device_id, last_sequence) VALUES (?, ?, ?)
          ON CONFLICT(household_id, device_id) DO UPDATE SET last_sequence = excluded.last_sequence`)
          .run(householdId, deviceId, entries.at(-1).envelope.deviceSequence);
        this.db.prepare(`INSERT INTO ${stream}_relay_state (household_id, next_sequence, max_logical_time) VALUES (?, ?, ?)
          ON CONFLICT(household_id) DO UPDATE SET next_sequence = excluded.next_sequence, max_logical_time = excluded.max_logical_time`)
          .run(householdId, sequence, maxLogicalTime);
      });
    },

    [`read${Stream}Events`](householdId, cursor, limit, minimumEpoch) {
      this.assertAvailable();
      const rows = this.db.prepare(`SELECT relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope
        FROM ${stream}_events WHERE household_id = ? AND relay_sequence > ? ORDER BY relay_sequence LIMIT ?`).all(householdId, cursor, limit);
      const lastScanned = rows.at(-1)?.relay_sequence ?? cursor;
      const events = [];
      for (const row of rows) {
        const envelope = parseEnvelope(row, householdId);
        if (envelope.keyEpoch >= minimumEpoch) events.push({ cursor: encodeCursor(row.relay_sequence), envelope });
      }
      return {
        events,
        nextCursor: encodeCursor(lastScanned),
        hasMore: lastScanned < this[relayState](householdId).nextSequence - 1,
      };
    },
  };
}
