// DurableStore "delete for me" records (#119): one opaque record per member,
// listing the chat messages that member hid on all their devices. The record
// is sealed to the member's own devices (web/chat/chat-hidden.js); the
// service only keeps it and its revision, and changes it compare-and-set.
import { DurableConflictError, DurableStoreError } from "./shared.mjs";

export const chatHiddenMethods = {
  chatHiddenRecord(householdId, memberId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT revision, record FROM chat_hidden WHERE household_id = ? AND member_id = ?").get(householdId, memberId);
    if (!row) return null;
    let record;
    try { record = JSON.parse(row.record); } catch { throw new DurableStoreError("Kin's stored chat preferences are invalid."); }
    return { revision: row.revision, record };
  },

  putChatHiddenRecord(householdId, memberId, { expectedRevision, record }) {
    this.assertAvailable();
    return this.transaction(() => {
      const current = this.db.prepare("SELECT revision FROM chat_hidden WHERE household_id = ? AND member_id = ?").get(householdId, memberId)?.revision ?? 0;
      if (current !== expectedRevision)
        throw new DurableConflictError("chat_hidden_stale", "Changed on another device meanwhile.");
      this.db.prepare(`INSERT INTO chat_hidden (household_id, member_id, revision, record) VALUES (?, ?, ?, ?)
        ON CONFLICT (household_id, member_id) DO UPDATE SET revision = excluded.revision, record = excluded.record`)
        .run(householdId, memberId, expectedRevision + 1, JSON.stringify(record));
      return expectedRevision + 1;
    });
  },
};
