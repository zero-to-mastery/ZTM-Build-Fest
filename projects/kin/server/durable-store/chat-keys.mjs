// DurableStore chat key packages (#123): the wrapped copies of the household's
// dedicated chat key, one per device and key epoch, and the household's
// current chat key epoch. A package is addressed to one device, wrapped
// (web/sync/crypto.js) so only that device's private key opens it, and signed
// by the device that made it; the service keeps and serves them, never a key.
import { DurableConflictError, DurableStoreError } from "./shared.mjs";

export const chatKeyMethods = {
  /** The current chat key epoch; 0 until a policy first needs a chat key. */
  chatKeyEpoch(householdId) {
    this.assertAvailable();
    return this.db.prepare("SELECT chat_key_epoch AS epoch FROM households WHERE id = ?").get(householdId)?.epoch ?? 0;
  },

  /** The relay position where the first chat key took effect: events from
   * there on must be sealed under a chat key. 0 while there is none. */
  chatKeySince(householdId) {
    this.assertAvailable();
    return this.db.prepare("SELECT chat_key_since AS since FROM households WHERE id = ?").get(householdId)?.since ?? 0;
  },

  /** Who holds which package: every (key epoch, device) pair, one query. */
  chatKeyHolderPairs(householdId) {
    this.assertAvailable();
    return this.db.prepare("SELECT key_epoch AS keyEpoch, device_id AS deviceId FROM chat_key_packages WHERE household_id = ?").all(householdId);
  },

  /** A device drops its own package that it could not open, so a holder can
   * share the key with it again. */
  deleteChatKeyPackage(householdId, deviceId, keyEpoch) {
    this.assertAvailable();
    this.db.prepare("DELETE FROM chat_key_packages WHERE household_id = ? AND device_id = ? AND key_epoch = ?").run(householdId, deviceId, keyEpoch);
  },

  /** The epochs a device has a package for. */
  chatKeyPackageEpochs(householdId, deviceId) {
    this.assertAvailable();
    return this.db.prepare("SELECT key_epoch AS keyEpoch FROM chat_key_packages WHERE household_id = ? AND device_id = ? ORDER BY key_epoch")
      .all(householdId, deviceId).map((row) => row.keyEpoch);
  },

  /** Every package addressed to one device, oldest epoch first. */
  chatKeyPackagesFor(householdId, deviceId) {
    this.assertAvailable();
    return this.db.prepare("SELECT key_epoch AS keyEpoch, sender_device_id AS senderDeviceId, package FROM chat_key_packages WHERE household_id = ? AND device_id = ? ORDER BY key_epoch")
      .all(householdId, deviceId)
      .map((row) => {
        try { return { keyEpoch: row.keyEpoch, senderDeviceId: row.senderDeviceId, package: JSON.parse(row.package) }; }
        catch { throw new DurableStoreError("Kin's stored chat key packages are invalid."); }
      });
  },

  /**
   * Adds packages, and moves the household to `epoch` when it is the next one.
   * `expectedEpoch` must still be the stored one, so two devices rotating at
   * once cannot both win. A package already stored for a device and epoch
   * stays (the first one wins).
   */
  commitChatKeys(householdId, { expectedEpoch, epoch, packages, since = 0 }) {
    this.assertAvailable();
    return this.transaction(() => {
      const current = this.chatKeyEpoch(householdId);
      if (current !== expectedEpoch)
        throw new DurableConflictError("chat_keys_stale", "The chat key changed meanwhile.");
      if (epoch !== current) this.db.prepare("UPDATE households SET chat_key_epoch = ? WHERE id = ?").run(epoch, householdId);
      if (current === 0 && epoch === 1) this.db.prepare("UPDATE households SET chat_key_since = ? WHERE id = ?").run(since, householdId);
      const insert = this.db.prepare("INSERT OR IGNORE INTO chat_key_packages (household_id, key_epoch, device_id, sender_device_id, package) VALUES (?, ?, ?, ?, ?)");
      for (const entry of packages)
        insert.run(householdId, entry.keyEpoch, entry.deviceId, entry.senderDeviceId, JSON.stringify(entry.package));
    });
  },
};
