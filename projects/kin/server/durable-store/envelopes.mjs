// DurableStore sync relay: per-household sync state, encrypted event
// envelopes and attachment ciphertext.
import {
  CANONICAL_ENVELOPE_FIELDS,
  canonicalEventEnvelope,
  isDurableGrantValid,
  isDurableRotationValid,
  isEventEnvelopeValid,
  MAX_BINDINGS,
  MAX_HOUSEHOLD_EVENTS,
  MAX_KEY_EPOCHS,
  MAX_LOGICAL_TIME,
  MAX_LOGICAL_TIME_ADVANCE,
} from "../sync-contract.mjs";
import {
  DurableConflictError,
  DurableStoreError,
  isId,
  isTimestamp,
  MAX_ATTACHMENT_BYTES,
  MAX_HOUSEHOLD_ATTACHMENT_BYTES,
  MAX_HOUSEHOLD_ATTACHMENTS,
  MAX_HOUSEHOLD_ALBUM_ATTACHMENTS,
  MAX_HOUSEHOLD_ALBUM_BYTES,
  ALBUM_ATTACHMENT_PREFIX,
  isAlbumAttachmentId,
  parseJson,
  parseStoredJson,
  stringifyStored,
} from "./shared.mjs";

export function decodeCanonicalEnvelope(value) {
  const pairs = parseJson(value);
  if (
    !Array.isArray(pairs) ||
    pairs.length !== CANONICAL_ENVELOPE_FIELDS.length ||
    pairs.some(
      (pair, index) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair[0] !== CANONICAL_ENVELOPE_FIELDS[index],
    )
  )
    throw new DurableStoreError("Kin encrypted relay data is invalid.");
  const envelope = Object.fromEntries(pairs);
  if (!isEventEnvelopeValid(envelope))
    throw new DurableStoreError("Kin encrypted relay data is invalid.");
  return envelope;
}

export function validateEventRow(row, householdId) {
  const envelope = decodeCanonicalEnvelope(row.canonical_envelope);
  if (
    envelope.eventId !== row.event_id ||
    envelope.householdId !== householdId ||
    row.household_id !== householdId ||
    envelope.deviceId !== row.device_id ||
    envelope.deviceSequence !== row.device_sequence ||
    envelope.keyEpoch !== row.key_epoch ||
    !Number.isSafeInteger(row.relay_sequence) ||
    row.relay_sequence < 1
  )
    throw new DurableStoreError("Kin encrypted relay data is invalid.");
  return {
    sequence: row.relay_sequence,
    keyEpoch: row.key_epoch,
    envelope,
  };
}

export function encodeCursor(sequence) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

export const envelopeMethods = {
  loadSyncState(householdId, identity) {
    this.assertAvailable();
    try {
      if (
        !isId(householdId) ||
        !(identity?.households.has(householdId) ??
          Boolean(this.statements.getHousehold.get(householdId)))
      )
        throw new DurableStoreError("Kin synchronization data is invalid.");
      const devices = new Map();
      const getDevice = (deviceId) => {
        if (devices.has(deviceId)) return devices.get(deviceId);
        const stored = identity ? null : this.statements.getDevice.get(deviceId);
        const device = identity
          ? identity.devices.get(deviceId)
          : stored && parseStoredJson(stored.device_json);
        const member = device && (identity
          ? identity.members.get(device.memberId)
          : this.statements.getMember.get(device.memberId));
        if (
          !device ||
          !member ||
          device.id !== deviceId ||
          device.householdId !== householdId ||
          (identity ? member.householdId : member.household_id) !== householdId ||
          (!identity &&
            (stored.household_id !== householdId ||
              stored.member_id !== device.memberId))
        )
          throw new DurableStoreError("Kin synchronization data is invalid.");
        devices.set(deviceId, device);
        return device;
      };
      const row = this.statements.getSyncHousehold.get(householdId);
      if (
        row &&
        (row.household_id !== householdId ||
          !Number.isSafeInteger(row.current_epoch) ||
          row.current_epoch < 1 ||
          row.current_epoch > MAX_KEY_EPOCHS ||
          ![0, 1].includes(row.enabled) ||
          ![0, 1].includes(row.rotation_pending) ||
          !Number.isSafeInteger(row.next_sequence) ||
          row.next_sequence < 1 ||
          row.next_sequence > MAX_HOUSEHOLD_EVENTS + 1)
      )
        throw new DurableStoreError("Kin synchronization state is invalid.");
      const state = {
        currentEpoch: row?.current_epoch ?? 1,
        enabled: Boolean(row?.enabled ?? false),
        rotationPending: Boolean(row?.rotation_pending ?? false),
        nextSequence: row?.next_sequence ?? 1,
        records: [],
        eventCount: this.statements.countEvents.get(householdId).count,
        byEventId: new Map(),
        deviceSequence: new Map(),
        grants: new Map(),
        bindings: new Map(),
        lastRotation: row && row.last_rotation_json !== null
          ? parseJson(row.last_rotation_json)
          : null,
        grantRequests: new Map(),
      };
      for (const value of this.db
        .prepare(
          "SELECT household_id, device_id, last_sequence FROM sync_device_sequences WHERE household_id = ?",
        )
        .all(householdId)) {
        if (
          value.household_id !== householdId ||
          !isId(value.device_id) ||
          !Number.isSafeInteger(value.last_sequence) ||
          value.last_sequence < 0 ||
          value.last_sequence > MAX_HOUSEHOLD_EVENTS ||
          !getDevice(value.device_id)
        )
          throw new DurableStoreError("Kin synchronization data is invalid.");
        state.deviceSequence.set(value.device_id, value.last_sequence);
      }
      for (const value of this.db
        .prepare(
          "SELECT * FROM provisioning_grants WHERE household_id = ?",
        )
        .all(householdId)) {
        const grant = parseJson(value.grant_json);
        if (!isDurableGrantValid(grant, value, state.currentEpoch, getDevice))
          throw new DurableStoreError("Kin provisioning data is invalid.");
        state.grants.set(value.grant_id, grant);
        if (grant.requestId != null) {
          if (state.grantRequests.has(`${grant.senderDeviceId}:${grant.requestId}`))
            throw new DurableStoreError("Kin provisioning data is invalid.");
          state.grantRequests.set(
            `${grant.senderDeviceId}:${grant.requestId}`,
            grant.grantId,
          );
        }
      }
      for (const value of this.db
        .prepare(
          "SELECT household_id, event_id, canonical_envelope FROM sync_bindings WHERE household_id = ?",
        )
        .all(householdId)) {
        const binding = decodeCanonicalEnvelope(value.canonical_envelope);
        if (
          binding.eventId !== value.event_id ||
          binding.householdId !== value.household_id ||
          binding.householdId !== householdId ||
          binding.keyEpoch > state.currentEpoch ||
          binding.keyEpoch < (getDevice(binding.deviceId).syncHistoryFromEpoch ?? 1) ||
          state.bindings.size >= MAX_BINDINGS
        )
          throw new DurableStoreError("Kin identity-binding data is invalid.");
        state.bindings.set(value.event_id, {
          canonical: value.canonical_envelope,
          envelope: binding,
        });
      }
      if (
        !Number.isSafeInteger(state.eventCount) ||
        state.eventCount < 0 ||
        state.eventCount > MAX_HOUSEHOLD_EVENTS ||
        state.nextSequence !== state.eventCount + 1 ||
        !isDurableRotationValid(
          state.lastRotation,
          householdId,
          state.currentEpoch,
          getDevice,
        )
      )
        throw new DurableStoreError("Kin synchronization state is invalid.");
      return state;
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin synchronization data is invalid.", {
        cause: error,
      });
    }
  },

  saveSyncState(householdId, state, pairingService) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO sync_households(household_id, current_epoch, enabled, rotation_pending, next_sequence, last_rotation_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(household_id) DO UPDATE SET current_epoch = excluded.current_epoch, enabled = excluded.enabled, rotation_pending = excluded.rotation_pending, next_sequence = excluded.next_sequence, last_rotation_json = excluded.last_rotation_json",
        )
        .run(
          householdId,
          state.currentEpoch,
          Number(state.enabled),
          Number(state.rotationPending),
          state.nextSequence,
          state.lastRotation ? JSON.stringify(state.lastRotation) : null,
        );

      this.db
        .prepare("DELETE FROM sync_device_sequences WHERE household_id = ?")
        .run(householdId);
      const insertSequence = this.db.prepare(
        "INSERT INTO sync_device_sequences(household_id, device_id, last_sequence) VALUES (?, ?, ?)",
      );
      for (const [deviceId, sequence] of state.deviceSequence)
        insertSequence.run(householdId, deviceId, sequence);

      this.db
        .prepare("DELETE FROM provisioning_grants WHERE household_id = ?")
        .run(householdId);
      const insertGrant = this.db.prepare(
        "INSERT INTO provisioning_grants(household_id, grant_id, sender_device_id, recipient_device_id, request_id, expires_at, grant_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const grant of state.grants.values()) {
        insertGrant.run(
          householdId,
          grant.grantId,
          grant.senderDeviceId,
          grant.recipientDeviceId,
          grant.requestId ?? null,
          grant.expiresAt,
          JSON.stringify(grant),
        );
      }

      this.db
        .prepare("DELETE FROM sync_bindings WHERE household_id = ?")
        .run(householdId);
      const insertBinding = this.db.prepare(
        "INSERT INTO sync_bindings(household_id, event_id, canonical_envelope) VALUES (?, ?, ?)",
      );
      for (const [eventId, binding] of state.bindings) {
        const envelope = decodeCanonicalEnvelope(binding.canonical);
        if (envelope.eventId !== eventId || envelope.householdId !== householdId)
          throw new DurableStoreError("Kin identity-binding data is invalid.");
        insertBinding.run(householdId, eventId, binding.canonical);
      }

      const updateDevice = this.db.prepare(
        "UPDATE devices SET device_json = ?, token_hash = ?, revoked_at = ? WHERE id = ?",
      );
      for (const row of this.db
        .prepare("SELECT id FROM devices WHERE household_id = ?")
        .all(householdId)) {
        const device = pairingService.devices.get(row.id);
        if (!device)
          throw new DurableStoreError("Kin server device data is invalid.");
        updateDevice.run(
          stringifyStored(device),
          device.tokenHash,
          device.revokedAt,
          device.id,
        );
      }
    });
  },

  findEvent(householdId, eventId) {
    this.assertAvailable();
    return this.statements.getEvent.get(householdId, eventId);
  },

  eventCount(householdId) {
    this.assertAvailable();
    return this.statements.countEvents.get(householdId).count;
  },

  maxLogicalTime(householdId) {
    this.assertAvailable();
    if (!isId(householdId)) throw new DurableStoreError("Kin synchronization data is invalid.");
    let maximum = 0n;
    const rows = this.db.prepare(
      "SELECT canonical_envelope FROM sync_events WHERE household_id = ? ORDER BY relay_sequence",
    ).all(householdId);
    for (const row of rows) {
      const envelope = parseStoredJson(row.canonical_envelope);
      if (typeof envelope?.logicalTime !== "string" || envelope.logicalTime.length > 16 || !/^(0|[1-9][0-9]*)$/.test(envelope.logicalTime)) continue;
      const value = BigInt(envelope.logicalTime);
      // Old relay rows that predate the bound remain readable, but never
      // influence the clock used for new accepted events.
      if (value === 0n || value > MAX_LOGICAL_TIME || value - maximum > MAX_LOGICAL_TIME_ADVANCE) continue;
      if (value > maximum) maximum = value;
    }
    return maximum.toString();
  },

  commitEvents(
    householdId,
    expectedNextSequence,
    deviceId,
    expectedDeviceSequence,
    entries,
  ) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO sync_households(household_id, current_epoch, enabled, rotation_pending, next_sequence) VALUES (?, 1, 0, 0, 1) ON CONFLICT(household_id) DO NOTHING",
        )
        .run(householdId);
      const current = this.statements.getSyncHousehold.get(householdId);
      if (current.next_sequence !== expectedNextSequence)
        throw new DurableConflictError(
          "sync_cursor_conflict",
          "Kin synchronization state changed; retry from the current cursor.",
        );
      const deviceState = this.db
        .prepare(
          "SELECT last_sequence FROM sync_device_sequences WHERE household_id = ? AND device_id = ?",
        )
        .get(householdId, deviceId);
      if ((deviceState?.last_sequence ?? 0) !== expectedDeviceSequence)
        throw new DurableConflictError(
          "sync_device_sequence_conflict",
          "Kin device sequence changed; retry after reauthentication.",
        );

      const insert = this.db.prepare(
        "INSERT INTO sync_events(household_id, relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      let sequence = expectedNextSequence;
      for (const entry of entries) {
        if (!isEventEnvelopeValid(entry.envelope) ||
            entry.envelope.householdId !== householdId || entry.envelope.deviceId !== deviceId ||
            canonicalEventEnvelope(entry.envelope) !== entry.canonical)
          throw new DurableStoreError("Kin encrypted relay data is invalid.");
        insert.run(
          householdId,
          sequence++,
          entry.envelope.eventId,
          deviceId,
          entry.envelope.deviceSequence,
          entry.envelope.keyEpoch,
          entry.canonical,
        );
      }
      if (entries.length) {
        this.db
          .prepare(
            "INSERT INTO sync_device_sequences(household_id, device_id, last_sequence) VALUES (?, ?, ?) ON CONFLICT(household_id, device_id) DO UPDATE SET last_sequence = excluded.last_sequence",
          )
          .run(
            householdId,
            deviceId,
            entries.at(-1).envelope.deviceSequence,
          );
        this.db
          .prepare(
            "UPDATE sync_households SET next_sequence = ? WHERE household_id = ?",
          )
          .run(sequence, householdId);
      }
    });
  },

  readEvents(householdId, cursor, limit, minimumEpoch) {
    this.assertAvailable();
    try {
      const scanned = this.statements.eventsAfter.all(
        householdId,
        cursor,
        limit,
      );
      const records = scanned.map((row) => {
        try { return validateEventRow(row, householdId); }
        catch (error) {
          if (error instanceof DurableStoreError) {
            error.code = "sync_store_invalid";
            error.eventId = row.event_id;
          }
          throw error;
        }
      });
      const lastScanned = records.at(-1)?.sequence ?? cursor;
      return {
        events: records
          .filter((record) => record.keyEpoch >= minimumEpoch)
          .map((record) => ({
            cursor: encodeCursor(record.sequence),
            envelope: record.envelope,
          })),
        nextCursor: encodeCursor(lastScanned),
        hasMore: Boolean(
          this.statements.eventAfterExists.get(householdId, lastScanned),
        ),
      };
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin encrypted relay data is invalid.", {
        cause: error,
      });
    }
  },

  putAttachment(householdId, attachmentId, keyEpoch, ciphertext, digest, createdAt, uploaderMemberId = null) {
    this.assertAvailable();
    if (!isId(householdId) || !isId(attachmentId) || !Number.isSafeInteger(keyEpoch) || keyEpoch < 1 || keyEpoch > MAX_KEY_EPOCHS ||
        !Buffer.isBuffer(ciphertext) || ciphertext.length < 1 || ciphertext.length > MAX_ATTACHMENT_BYTES ||
        !/^[a-f0-9]{64}$/.test(digest) || !isTimestamp(createdAt))
      throw new DurableStoreError("Kin encrypted attachment metadata is invalid.");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT key_epoch, ciphertext, digest FROM sync_attachments WHERE household_id = ? AND attachment_id = ?").get(householdId, attachmentId);
      if (existing) {
        if (existing.key_epoch === keyEpoch && existing.digest === digest && Buffer.from(existing.ciphertext).equals(ciphertext)) return { accepted: false };
        throw new DurableConflictError("attachment_conflict", "That attachment ID already has different encrypted content.");
      }
      // Album photos (#673) and other attachments each have their own quota.
      const album = isAlbumAttachmentId(attachmentId);
      const quota = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM sync_attachments WHERE household_id = ? AND ${album ? "" : "NOT "}substr(attachment_id, 1, 4) = ?`).get(householdId, ALBUM_ATTACHMENT_PREFIX);
      if (album ? quota.count >= MAX_HOUSEHOLD_ALBUM_ATTACHMENTS || quota.bytes + ciphertext.length > MAX_HOUSEHOLD_ALBUM_BYTES
        : quota.count >= MAX_HOUSEHOLD_ATTACHMENTS || quota.bytes + ciphertext.length > MAX_HOUSEHOLD_ATTACHMENT_BYTES)
        throw new DurableConflictError("attachment_limit", album ? "This household's family photos are full." : "This household reached its encrypted attachment limit.");
      this.db.prepare("INSERT INTO sync_attachments(household_id, attachment_id, key_epoch, ciphertext, size_bytes, digest, created_at, uploader_member_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(householdId, attachmentId, keyEpoch, ciphertext, ciphertext.length, digest, createdAt, isId(uploaderMemberId) ? uploaderMemberId : null);
      return { accepted: true };
    });
  },

  getAttachment(householdId, attachmentId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT attachment_id AS attachmentId, key_epoch AS keyEpoch, ciphertext, size_bytes AS size, digest FROM sync_attachments WHERE household_id = ? AND attachment_id = ?").get(householdId, attachmentId);
    if (!row) return null;
    const ciphertext = Buffer.from(row.ciphertext);
    if (ciphertext.length !== row.size) throw new DurableStoreError("Kin encrypted attachment storage is invalid.");
    return { ...row, ciphertext };
  },

  /** The household's attachments; album photos (#673) only when `album`
   * is true, so devices that don't know the album never see them. */
  listAttachments(householdId, { album = false } = {}) {
    this.assertAvailable();
    const rows = this.db.prepare("SELECT attachment_id AS attachmentId, key_epoch AS keyEpoch, size_bytes AS size, digest FROM sync_attachments WHERE household_id = ? AND NOT substr(attachment_id, 1, 4) = ? ORDER BY attachment_id LIMIT ?").all(householdId, ALBUM_ATTACHMENT_PREFIX, MAX_HOUSEHOLD_ATTACHMENTS);
    if (!album) return rows;
    return rows.concat(this.db.prepare("SELECT attachment_id AS attachmentId, key_epoch AS keyEpoch, size_bytes AS size, digest FROM sync_attachments WHERE household_id = ? AND substr(attachment_id, 1, 4) = ? ORDER BY attachment_id LIMIT ?").all(householdId, ALBUM_ATTACHMENT_PREFIX, MAX_HOUSEHOLD_ALBUM_ATTACHMENTS));
  },

  /** Whether the attachment exists and who uploaded it (null for rows stored before uploaders were recorded). */
  attachmentUploader(householdId, attachmentId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT uploader_member_id AS uploaderMemberId FROM sync_attachments WHERE household_id = ? AND attachment_id = ?").get(householdId, attachmentId);
    return row ? { uploaderMemberId: row.uploaderMemberId ?? null } : null;
  },

  removeAttachment(householdId, attachmentId) {
    this.assertAvailable();
    return this.db.prepare("DELETE FROM sync_attachments WHERE household_id = ? AND attachment_id = ?").run(householdId, attachmentId).changes > 0;
  },
};
