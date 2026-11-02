// DurableStore read-receipt slots (#121): one sealed record per member,
// replaced compare-and-set, never appended to the chat event log. The slot is
// a signed envelope under the household key (web/chat/chat-presence.js); the
// service only keeps it and its revision, so storage stays constant however
// long the chat grows.
import { DurableConflictError, DurableStoreError } from "./shared.mjs";

export const chatReceiptMethods = {
  chatReceiptSlots(householdId) {
    this.assertAvailable();
    return this.db.prepare("SELECT member_id AS memberId, revision, record FROM chat_receipts WHERE household_id = ? ORDER BY member_id").all(householdId)
      .map((row) => {
        try { return { memberId: row.memberId, revision: row.revision, record: JSON.parse(row.record) }; }
        catch { throw new DurableStoreError("Kin's stored read receipts are invalid."); }
      });
  },

  putChatReceiptSlot(householdId, memberId, { expectedRevision, record }) {
    this.assertAvailable();
    return this.transaction(() => {
      const current = this.db.prepare("SELECT revision FROM chat_receipts WHERE household_id = ? AND member_id = ?").get(householdId, memberId)?.revision ?? 0;
      if (current !== expectedRevision)
        throw new DurableConflictError("chat_receipts_stale", "Changed on another device meanwhile.");
      this.db.prepare(`INSERT INTO chat_receipts (household_id, member_id, revision, record) VALUES (?, ?, ?, ?)
        ON CONFLICT (household_id, member_id) DO UPDATE SET revision = excluded.revision, record = excluded.record`)
        .run(householdId, memberId, expectedRevision + 1, JSON.stringify(record));
      return expectedRevision + 1;
    });
  },
};
