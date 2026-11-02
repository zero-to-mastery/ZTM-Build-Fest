// DurableStore validation of every stored row when the store opens.
import { validateEventRow } from "./envelopes.mjs";
import { DurableStoreError, parseJson, validAuditDetails } from "./shared.mjs";

export const validationMethods = {
  validate() {
    this.assertAvailable();
    try {
      // One read transaction gives all cross-table checks the same snapshot,
      // even during an online backup while another connection is committing.
      return this.transaction(() => this.validateSnapshot());
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin durable service data is invalid.", {
        cause: error,
      });
    }
  },

  validateSnapshot() {
    this.verify();
    const identity = this.loadIdentity();
    const currentEpochs = new Map();
    for (const householdId of identity.households.keys()) {
      if (identity.households.get(householdId).lifecycleState === "deleted") {
        const retainedRows = this.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM sync_households WHERE household_id = ?) +
               (SELECT COUNT(*) FROM sync_events WHERE household_id = ?) +
               (SELECT COUNT(*) FROM sync_bindings WHERE household_id = ?) +
               (SELECT COUNT(*) FROM security_audit WHERE household_id = ?) +
               (SELECT COUNT(*) FROM household_install_identity WHERE household_id = ?) +
               (SELECT COUNT(*) FROM household_install_identity_revisions WHERE household_id = ?) +
               (SELECT COUNT(*) FROM push_subscriptions WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_blobs WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_blob_claims WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_blob_usage WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_events WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_device_sequences WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_relay_state WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_hidden WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_receipts WHERE household_id = ?) +
               (SELECT COUNT(*) FROM chat_key_packages WHERE household_id = ?) +
               (SELECT COUNT(*) FROM board_events WHERE household_id = ?) +
               (SELECT COUNT(*) FROM board_device_sequences WHERE household_id = ?) +
               (SELECT COUNT(*) FROM board_relay_state WHERE household_id = ?) +
               (SELECT COUNT(*) FROM account_vaults WHERE household_id = ?) +
               (SELECT COUNT(*) FROM account_vault_wrappers WHERE household_id = ?) +
               (SELECT COUNT(*) FROM account_passwords WHERE household_id = ?) +
               (SELECT COUNT(*) FROM private_events WHERE household_id = ?) +
               (SELECT COUNT(*) FROM private_device_sequences WHERE household_id = ?) +
               (SELECT COUNT(*) FROM private_relay_state WHERE household_id = ?) +
               (SELECT COUNT(*) FROM private_blobs WHERE household_id = ?) +
               (SELECT COUNT(*) FROM feedback WHERE household_id = ?) +
               (SELECT COUNT(*) FROM prepared_invitations WHERE household_id = ?) +
               (SELECT COUNT(*) FROM calendar_subscriptions WHERE household_id = ?) AS count`,
          )
          .get(...new Array(29).fill(householdId)).count;
        if (retainedRows !== 0)
          throw new DurableStoreError("Kin deleted-household data is invalid.");
        continue;
      }
      const state = this.loadSyncState(householdId, identity);
      currentEpochs.set(householdId, state.currentEpoch);
      let cursor = 0;
      let scanned = 0;
      // Schema v1 has no relay pruning: retained history must be gap-free,
      // including events from devices that have since been revoked.
      let nextRelaySequence = 1;
      const deviceSequences = new Map();
      while (true) {
        const rows = this.statements.eventsAfter.all(householdId, cursor, 20);
        if (!rows.length) break;
        for (const row of rows) {
          const { envelope, sequence } = validateEventRow(row, householdId);
          const device = identity.devices.get(envelope.deviceId);
          if (
            sequence !== nextRelaySequence++ ||
            device?.householdId !== householdId ||
            envelope.keyEpoch > state.currentEpoch ||
            envelope.keyEpoch < (device.syncHistoryFromEpoch ?? 1)
          ) {
            throw new DurableStoreError("Kin encrypted relay data is invalid.");
          }
          const expectedDeviceSequence =
            (deviceSequences.get(envelope.deviceId) ?? 0) + 1;
          if (envelope.deviceSequence !== expectedDeviceSequence) {
            throw new DurableStoreError("Kin encrypted relay data is invalid.");
          }
          deviceSequences.set(envelope.deviceId, envelope.deviceSequence);
        }
        cursor = rows.at(-1).relay_sequence;
        scanned += rows.length;
      }
      if (
        scanned !== state.eventCount ||
        state.nextSequence !== nextRelaySequence ||
        [...state.deviceSequence].some(
          ([deviceId, sequence]) => (deviceSequences.get(deviceId) ?? 0) !== sequence,
        ) ||
        [...deviceSequences].some(
          ([deviceId, sequence]) =>
            state.deviceSequence.get(deviceId) !== sequence,
        )
      ) {
        throw new DurableStoreError("Kin encrypted relay data is invalid.");
      }
    }
    for (const device of identity.devices.values()) {
      const currentEpoch = currentEpochs.get(device.householdId);
      if (
        (device.syncHistoryFromEpoch ?? 1) > currentEpoch + 1 ||
        device.syncProvisionedEpochs?.some((epoch) => epoch > currentEpoch)
      )
        throw new DurableStoreError("Kin synchronization data is invalid.");
    }
    for (const row of this.db
      .prepare("SELECT * FROM security_audit ORDER BY sequence")
      .all()) {
      const details = parseJson(row.details_json);
      if (
        !identity.households.has(row.household_id) ||
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 1 ||
        !Number.isSafeInteger(row.created_at) ||
        row.created_at < 0 ||
        typeof row.event_type !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(row.event_type) ||
        !validAuditDetails(details)
      )
        throw new DurableStoreError("Kin security audit data is invalid.");
    }
    if (!this.chatBlobUsageMatches())
      throw new DurableStoreError("Kin chat storage counts are invalid.");
    // ADR 0018: every vault has a way to open it, and a wrapper never names
    // a household other than its vault's.
    if (this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM account_vaults v WHERE NOT EXISTS
          (SELECT 1 FROM account_vault_wrappers w WHERE w.member_id = v.member_id)) +
        (SELECT COUNT(*) FROM account_vault_wrappers w JOIN account_vaults v ON v.member_id = w.member_id
          WHERE v.household_id <> w.household_id) AS count`).get().count !== 0)
      throw new DurableStoreError("Kin account vault data is invalid.");
    return true;
  },
};
